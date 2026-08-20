// A-10: AA/session 线 session 订阅计费（2026-08-11）
// 模式：UserOp 次数费（固定单价 AA_USEROP_FEE_WEI）+ paymaster gas 代付（按收据 actualGasCost 结算）。
// 广播前预扣 = 固定费 + 预估 gas（op 自带 gas 字段 × maxFeePerGas，缺省 0）；
// wait 模式收据后按 actualGasCost 结算退差（多退少补）；广播失败全额退还。
// subscriber = 智能账户（op.sender）。未配置引擎 → 免费放行（开发环境向后兼容）。
// 余额不足 → 402 + 充值提示；引擎故障 → 503。
// 链上 escrow 双轨（OE-6）客户端见 ./escrow-client.ts（本文件仅保留计费编排与 ledger fallback）。
import { parseEther, formatEther } from 'viem';
import type { UserOperationV7 } from '../../aa-sdk/src/index.js';
import { AABillingError } from './errors.js';
import { AA_ESCROW, escrowConfigured, escrowBalance, escrowCharge, escrowClient, escrowRefund, entryPointAbi, entryPointAddress } from './escrow-client.js';

export { AABillingError } from './errors.js';
export { escrowConfigured, AA_ESCROW } from './escrow-client.js';

const AA_PAYMENTS = {
  baseUrl: (process.env.AA_PAYMENTS_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.AA_PAYMENTS_API_KEY || '',
  platformAddress: (process.env.AA_PLATFORM_ADDRESS || '').toLowerCase(),
};

export function aaChargeConfigured(): boolean {
  return Boolean(AA_PAYMENTS.baseUrl && AA_PAYMENTS.apiKey && AA_PAYMENTS.platformAddress);
}

/**
 * 计费是否启用（ledger 或 escrow 任一配置即可）。
 * ⚠️ 所有调用方（relay/helpers/submit）必须用本判定门控预扣，勿单独用 aaChargeConfigured()，
 * 否则 ESCROW_MODE=true 且未配 AA_PAYMENTS_URL 时计费会被静默跳过（2026-08-21 审查 #1 修复）。
 */
export function billingConfigured(): boolean {
  return aaChargeConfigured() || escrowConfigured();
}

function ensureConfig(): void {
  if (!aaChargeConfigured()) {
    throw new AABillingError('AA session billing is not configured (AA_PAYMENTS_URL/AA_PAYMENTS_API_KEY/AA_PLATFORM_ADDRESS)', 503);
  }
}

async function paymentsCall<T = any>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (AA_PAYMENTS.apiKey) headers['X-Service-Key'] = AA_PAYMENTS.apiKey;
  const resp = await fetch(`${AA_PAYMENTS.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) {
    let message = `payments ${path} failed (${resp.status})`;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* non-JSON */ }
    throw new AABillingError(message, resp.status === 422 ? 402 : resp.status);
  }
  return resp.json() as Promise<T>;
}

export const aaPaymentsApi = {
  async balance(address: string): Promise<string> {
    ensureConfig();
    const r = await paymentsCall<{ address: string; balanceWei: string }>(
      `/payments/balance?address=${encodeURIComponent(address.toLowerCase())}`
    );
    return r.balanceWei;
  },
  async createTransfer(input: { from: string; to: string; valueWei: string; reference: string }) {
    ensureConfig();
    return paymentsCall<{ transferId: string; status: string }>('/payments/transfers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async confirmTransfer(transferId: string): Promise<{ executed: boolean; status: string; error?: string }> {
    ensureConfig();
    const r = await paymentsCall<any>(`/payments/transfers/${encodeURIComponent(transferId)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return { executed: r.executed === true, status: r.status, error: r.error };
  },
};

/** 充值提示（x402 入账路径 / Escrow 存款路径）。subscriber 传入计费主体地址，用于区分 EOA 自付与智能账户代充。 */
export function topupHint(subscriber?: string): string {
  if (escrowConfigured()) {
    // REQ-2c：计费主体是智能账户（op.sender）时，deposit()（记 msg.sender）到不了子账户名下，
    // 应指引主钱包 EOA 调 depositFor(账户) 单笔 tx 代充值（REQ-1 落地后）。
    const target = subscriber ? ` 计费主体=${subscriber}` : '';
    return `余额不足。充值路径：托管合约 ${AA_ESCROW.address} —— 智能账户计费场景由主钱包 EOA 单笔 tx 调 depositFor(<智能账户地址>) 代充值；或账户自身用 session key 调 deposit() 自付（需会话白名单含 escrow.deposit）。链上 balanceOf 即时生效，随后调用引擎 POST ${AA_PAYMENTS.baseUrl || '(未配置)'}/payments/verify {txHash} 入账索引（UserOp 次数费 + paymaster gas 代付按实际结算，详见 GET /v1/plans）。${target}`;
  }
  const payTo = AA_PAYMENTS.platformAddress;
  const base = AA_PAYMENTS.baseUrl || '(未配置)';
  return `余额不足。充值路径：向平台钱包 ${payTo} 转入原生资产，随后调用引擎 POST ${base}/payments/verify {txHash} 入账（UserOp 次数费 + paymaster gas 代付按实际结算，详见 GET /v1/plans）`;
}

/** 固定 UserOp 次数费（wei，env 可覆盖，默认 0.0001）。 */
export function aaFees(): Record<string, { operation: string; label: string; feeWei: string }> {
  const fee = process.env.AA_USEROP_FEE_WEI || parseEther('0.0001').toString();
  return {
    userop: { operation: 'userop', label: 'UserOp (ERC-4337, per execution)', feeWei: fee },
  };
}

/** 预估 UserOp gas 成本（wei）：(callGasLimit + verificationGasLimit + preVerificationGas) × maxFeePerGas。 */
export function estimateUserOpGasWei(op: UserOperationV7): bigint {
  const gas = op.callGasLimit + op.verificationGasLimit + op.preVerificationGas;
  return gas * op.maxFeePerGas;
}

export interface ChargeResult { skipped: boolean; charged: boolean; amountWei: string; }

/** 预扣：固定费 + 预估 gas。未配置（ledger+escrow 均无）→ 免费放行；余额不足 → 402；故障 → 503。 */
export async function chargeUserOp(subscriber: string, reference: string, amountWei: bigint): Promise<ChargeResult> {
  if (!billingConfigured()) return { skipped: true, charged: false, amountWei: '0' };
  if (amountWei <= 0n) return { skipped: true, charged: false, amountWei: '0' };

  // OE-6: escrow 双轨——链上原子预扣（余额/限额不足 → 402，合约校验更严格）
  if (escrowConfigured()) {
    const bal = await escrowBalance(subscriber);
    if (bal === null) throw new AABillingError('escrow not configured', 503);
    if (bal < amountWei) {
      throw new AABillingError(
        `[402] ${topupHint(subscriber)}（当前链上余额 ${formatEther(bal)}，本次需 ${formatEther(amountWei)}）`, 402);
    }
    await escrowCharge(subscriber, amountWei, reference); // 余额不足/超限 revert → 402
    return { skipped: false, charged: true, amountWei: amountWei.toString() };
  }

  ensureConfig();

  let balanceWei: bigint;
  try {
    balanceWei = BigInt(await aaPaymentsApi.balance(subscriber));
  } catch (err: any) {
    if (err instanceof AABillingError) throw err;
    throw new AABillingError(`ledger balance query failed: ${err?.message}`, 503);
  }
  if (balanceWei < amountWei) {
    throw new AABillingError(
      `[402] ${topupHint()}（当前余额 ${formatEther(balanceWei)}，本次需 ${formatEther(amountWei)}）`, 402);
  }

  try {
    const created = await aaPaymentsApi.createTransfer({
      from: subscriber.toLowerCase(),
      to: AA_PAYMENTS.platformAddress,
      valueWei: amountWei.toString(),
      reference,
    });
    const exec = await aaPaymentsApi.confirmTransfer(created.transferId);
    if (!exec.executed) {
      throw new AABillingError(`[402] ${topupHint()}（确认扣款失败：${exec.error || exec.status}）`, 402);
    }
    return { skipped: false, charged: true, amountWei: amountWei.toString() };
  } catch (err: any) {
    if (err instanceof AABillingError) throw err;
    throw new AABillingError(`charge failed: ${err?.message}`, 503);
  }
}

/**
 * 结算退差（多退少补）：实际应扣 = 固定费 + actualGasCost；与预扣额差额退回/追扣。
 * 广播失败时传 actualWei=0 → 全额退还预扣。
 */
export async function settleUserOp(
  subscriber: string,
  reference: string,
  chargedWei: bigint,
  actualWei: bigint,
): Promise<{ skipped: boolean; refundWei: string; extraWei: string }> {
  if (!billingConfigured()) return { skipped: true, refundWei: '0', extraWei: '0' };
  if (chargedWei <= 0n || actualWei < 0n) return { skipped: true, refundWei: '0', extraWei: '0' };

  // OE-6: escrow 双轨——链上原子退差/追扣
  if (escrowConfigured()) {
    try {
      if (actualWei < chargedWei) {
        const refund = chargedWei - actualWei;
        if (refund > 0n) {
          await escrowRefund(subscriber, refund, `${reference}:refund`);
          return { skipped: false, refundWei: refund.toString(), extraWei: '0' };
        }
      } else if (actualWei > chargedWei) {
        const extra = actualWei - chargedWei;
        await escrowCharge(subscriber, extra, `${reference}:extra`);
        return { skipped: false, refundWei: '0', extraWei: extra.toString() };
      }
      return { skipped: false, refundWei: '0', extraWei: '0' };
    } catch (err: any) {
      if (err instanceof AABillingError) throw err;
      throw new AABillingError(`escrow settle failed: ${err?.message}`, 503);
    }
  }

  const transfer = async (from: string, to: string, valueWei: bigint, ref: string) => {
    const created = await aaPaymentsApi.createTransfer({ from, to, valueWei: valueWei.toString(), reference: ref });
    const exec = await aaPaymentsApi.confirmTransfer(created.transferId);
    if (!exec.executed) throw new AABillingError(`settle transfer failed: ${exec.error || exec.status}`, 503);
  };

  try {
    if (actualWei < chargedWei) {
      const refund = chargedWei - actualWei;
      if (refund > 0n) {
        await transfer(AA_PAYMENTS.platformAddress, subscriber.toLowerCase(), refund, `${reference}:refund`);
        return { skipped: false, refundWei: refund.toString(), extraWei: '0' };
      }
    } else if (actualWei > chargedWei) {
      const extra = actualWei - chargedWei;
      await transfer(subscriber.toLowerCase(), AA_PAYMENTS.platformAddress, extra, `${reference}:extra`);
      return { skipped: false, refundWei: '0', extraWei: extra.toString() };
    }
    return { skipped: false, refundWei: '0', extraWei: '0' };
  } catch (err: any) {
    if (err instanceof AABillingError) throw err;
    throw new AABillingError(`settle failed: ${err?.message}`, 503);
  }
}

/** P2-1: 结算/退款重试（402 业务性错误不重试；其余网络/服务错误重试 3 次指数退避，账本一致性）。 */
export async function retrySettle(
  fn: () => Promise<any>,
  label: string,
  attempts = 3,
  baseDelayMs = 800,
): Promise<any> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      // 余额不足等业务性错误重试无意义，直接抛（上层 402）
      if (e instanceof AABillingError && String(e.message).startsWith('[402]')) throw e;
      if (i < attempts - 1) {
        const delay = baseDelayMs * 2 ** i;
        console.warn(`[aa-relay] ${label} attempt ${i + 1}/${attempts} failed (retry in ${delay}ms):`, e?.message);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/** 资金总览（REQ-2b）：escrow 余额 / EP deposit / 账户 native，供续订前资金预检。 */
export interface AccountFunds {
  escrowWei: string;      // 托管余额（relay 计费预扣来源）
  epDepositWei: string | null; // EntryPoint deposit（UserOp gas 来源）
  nativeWei: string | null;    // 账户原生余额（execute value / 订阅费来源）
}

/** 查询账户余额。escrow 双轨读链上托管余额，否则读 ledger。未配置 → 抛 503。 */
export async function aaLedgerBalance(subscriber: string): Promise<{
  address: string; balanceWei: string; balance: string; funds: AccountFunds | null;
}> {
  if (escrowConfigured()) {
    const bal = await escrowBalance(subscriber);
    if (bal === null) throw new AABillingError('escrow not configured', 503);
    const funds: AccountFunds = { escrowWei: bal.toString(), epDepositWei: null, nativeWei: null };
    const ep = entryPointAddress();
    const account = subscriber.toLowerCase() as `0x${string}`;
    if (ep) {
      try {
        const { publicClient } = escrowClient();
        const [depositInfo, nativeBal] = await Promise.all([
          publicClient.readContract({
            address: ep,
            abi: entryPointAbi,
            functionName: 'getDepositInfo',
            args: [account],
          }) as Promise<[bigint, boolean, bigint, number, number]>,
          publicClient.getBalance({ address: account }),
        ]);
        funds.epDepositWei = depositInfo[0].toString();
        funds.nativeWei = nativeBal.toString();
      } catch (err: any) {
        // 资金总览为增强信息，EP/native 读取失败不阻断 escrow 余额返回
        console.error('[aa-relay] funds query failed (ep/native):', err?.shortMessage || err?.message);
      }
    }
    return { address: account, balanceWei: bal.toString(), balance: formatEther(bal), funds };
  }
  const balanceWei = await aaPaymentsApi.balance(subscriber);
  return {
    address: subscriber.toLowerCase(),
    balanceWei,
    balance: formatEther(BigInt(balanceWei || '0')),
    funds: null,
  };
}

/** 套餐/计费模式说明（价目公开）。 */
export function aaPlansInfo(): Record<string, unknown> {
  const fees = Object.values(aaFees()).map((f) => ({
    operation: f.operation,
    label: f.label,
    feeWei: f.feeWei,
    fee: formatEther(BigInt(f.feeWei)),
  }));
  const escrowMode = escrowConfigured();
  return {
    mode: escrowMode ? 'escrow-onchain' : 'session-subscription',
    billing: escrowMode
      ? 'Escrow 链上托管计费：广播前链上原子 charge（固定费 + 预估 gas），收据后按 actualGasCost 退差/追扣（合约 storage 记账，余额链上可查）'
      : 'UserOp 次数费 + paymaster gas 代付（广播前预扣固定费+预估 gas，收据后按 actualGasCost 多退少补）',
    configured: billingConfigured(),
    escrow: escrowMode ? { address: AA_ESCROW.address, chainId: AA_ESCROW.chainId } : undefined,
    limits: escrowMode
      ? {
          perTxOxa: AA_ESCROW.perTxLimitOxa,
          perDayOxa: AA_ESCROW.perDayLimitOxa,
          note: `链上默认限额（InfraXEscrow DEFAULT_PER_TX_LIMIT=${AA_ESCROW.perTxLimitOxa} / DEFAULT_PER_DAY_LIMIT=${AA_ESCROW.perDayLimitOxa} OXA，按计费账户维度；可 env ESCROW_PER_TX_LIMIT_OXA/ESCROW_PER_DAY_LIMIT_OXA 对齐链上）；用户级可用合约 setChargeLimit(account, perTx, perDay) 定制，owner 可 setChargeDefaultLimit 调全局默认。自动续订单次预扣约 0.0025 OXA，默认限额下单账户每日可支撑约 4000 次续订。`,
        }
      : undefined,
    platformAddress: AA_PAYMENTS.platformAddress || '(未配置)',
    fees,
    topup: billingConfigured()
      ? escrowMode
        ? { method: 'escrow depositFor', steps: [`主钱包 EOA 单笔 tx 调 depositFor(<智能账户地址>) 代充值（或账户自身 session key 调 deposit() 自付，需白名单含 escrow.deposit）`, `托管合约 ${AA_ESCROW.address}`, '链上 balanceOf 即时生效（REQ-2c：计费主体为智能账户，deposit() 记 msg.sender 到不了子账户名下）'] }
        : { method: 'x402 deposit', steps: [`向平台钱包 ${AA_PAYMENTS.platformAddress} 转入原生资产`, `调用引擎 POST ${AA_PAYMENTS.baseUrl}/payments/verify {txHash} 入账`, '余额自动计入智能账户对应的 ledger 账户'] }
      : { method: 'n/a', note: 'metered billing 未配置（开发环境免费）' },
  };
}
