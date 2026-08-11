// A-10: AA/session 线 session 订阅计费（2026-08-11）
// 模式：UserOp 次数费（固定单价 AA_USEROP_FEE_WEI）+ paymaster gas 代付（按收据 actualGasCost 结算）。
// 广播前预扣 = 固定费 + 预估 gas（op 自带 gas 字段 × maxFeePerGas，缺省 0）；
// wait 模式收据后按 actualGasCost 结算退差（多退少补）；广播失败全额退还。
// subscriber = 智能账户（op.sender）。未配置引擎 → 免费放行（开发环境向后兼容）。
// 余额不足 → 402 + 充值提示；引擎故障 → 503。
import { parseEther, formatEther } from 'viem';
import type { UserOperationV7 } from '../../aa-sdk/src/index.js';

export class AABillingError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const AA_PAYMENTS = {
  baseUrl: (process.env.AA_PAYMENTS_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.AA_PAYMENTS_API_KEY || '',
  platformAddress: (process.env.AA_PLATFORM_ADDRESS || '').toLowerCase(),
};

export function aaChargeConfigured(): boolean {
  return Boolean(AA_PAYMENTS.baseUrl && AA_PAYMENTS.apiKey && AA_PAYMENTS.platformAddress);
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

/** 充值提示（x402 入账路径）。 */
export function topupHint(): string {
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

/** 预扣：固定费 + 预估 gas。未配置/零金额 → 免费放行；余额不足 → 402；引擎故障 → 503。 */
export async function chargeUserOp(subscriber: string, reference: string, amountWei: bigint): Promise<ChargeResult> {
  if (!aaChargeConfigured()) return { skipped: true, charged: false, amountWei: '0' };
  if (amountWei <= 0n) return { skipped: true, charged: false, amountWei: '0' };
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
  if (!aaChargeConfigured()) return { skipped: true, refundWei: '0', extraWei: '0' };
  if (chargedWei <= 0n || actualWei < 0n) return { skipped: true, refundWei: '0', extraWei: '0' };

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

/** 查询账户 ledger 余额。未配置引擎 → 抛 503。 */
export async function aaLedgerBalance(subscriber: string): Promise<{ address: string; balanceWei: string; balance: string }> {
  const balanceWei = await aaPaymentsApi.balance(subscriber);
  return {
    address: subscriber.toLowerCase(),
    balanceWei,
    balance: formatEther(BigInt(balanceWei || '0')),
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
  return {
    mode: 'session-subscription',
    billing: 'UserOp 次数费 + paymaster gas 代付（广播前预扣固定费+预估 gas，收据后按 actualGasCost 多退少补）',
    configured: aaChargeConfigured(),
    platformAddress: AA_PAYMENTS.platformAddress || '(未配置)',
    fees,
    topup: aaChargeConfigured()
      ? { method: 'x402 deposit', steps: [`向平台钱包 ${AA_PAYMENTS.platformAddress} 转入原生资产`, `调用引擎 POST ${AA_PAYMENTS.baseUrl}/payments/verify {txHash} 入账`, '余额自动计入智能账户对应的 ledger 账户'] }
      : { method: 'n/a', note: 'metered billing 未配置（开发环境免费）' },
  };
}
