// A-10: Vault 线 gas 自付计费（2026-08-11）
// 模式与 MQ-16 T-4（MPC 按量）同源：业务服务管"权益"，支付引擎管"钱"。
// 差异点：vault 按**实际 gas 成本**结算（非固定单价）——createSafe/executeTransaction
// 广播前用 provider 预估 gas 成本预扣（含缓冲，防浮动），收据后按 gasUsed×effectiveGasPrice
// 结算退差（多退少补）。GAS_POOL 仅负责广播，不垫付。
// 未配置引擎 → 免费放行（开发环境向后兼容）；余额不足 → 402 + 充值提示；
// 引擎故障 → 503（付费服务不可在无法记账时放行）。
import { ethers } from 'ethers';

export class VaultChargeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const VAULT_PAYMENTS = {
  baseUrl: (process.env.VAULT_PAYMENTS_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.VAULT_PAYMENTS_API_KEY || '',
  platformAddress: (process.env.VAULT_PLATFORM_ADDRESS || '').toLowerCase(),
};

export function vaultChargeConfigured(): boolean {
  return Boolean(VAULT_PAYMENTS.baseUrl && VAULT_PAYMENTS.apiKey && VAULT_PAYMENTS.platformAddress);
}

function ensureConfig(): void {
  if (!vaultChargeConfigured()) {
    throw new VaultChargeError('Vault gas billing is not configured (VAULT_PAYMENTS_URL/VAULT_PAYMENTS_API_KEY/VAULT_PLATFORM_ADDRESS)', 503);
  }
}

async function paymentsCall<T = any>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (VAULT_PAYMENTS.apiKey) headers['X-Service-Key'] = VAULT_PAYMENTS.apiKey;
  const resp = await fetch(`${VAULT_PAYMENTS.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) {
    let message = `payments ${path} failed (${resp.status})`;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* non-JSON */ }
    throw new VaultChargeError(message, resp.status === 422 ? 402 : resp.status);
  }
  return resp.json() as Promise<T>;
}

export const vaultPaymentsApi = {
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

/** 充值提示（x402 入账路径：链上转入平台钱包 → 引擎 verify 记账）。 */
export function topupHint(): string {
  const payTo = VAULT_PAYMENTS.platformAddress;
  const base = VAULT_PAYMENTS.baseUrl || '(未配置)';
  return `余额不足。充值路径：向平台钱包 ${payTo} 转入原生资产，随后调用引擎 POST ${base}/payments/verify {txHash} 入账（gas 按实际结算，详见 GET /api/vault/plans）`;
}

/** 预估交易 gas 成本（wei）：gasLimit × gasPrice；估算失败回退 200k gas 上限（Safe exec 固定 500k 内）。 */
export async function estimateGasCostWei(provider: ethers.JsonRpcProvider, txReq: ethers.TransactionRequest): Promise<bigint> {
  const [gasLimit, feeData] = await Promise.all([
    provider.estimateGas(txReq).catch(() => 500000n),
    provider.getFeeData(),
  ]);
  const gasPrice = feeData.gasPrice || 0n;
  return gasLimit * gasPrice;
}

export interface ChargeResult { skipped: boolean; charged: boolean; amountWei: string; }

/**
 * 预扣：查询 ledger 余额 → 发起原子转账（幂等 reference）→ 确认扣款。
 * - 未配置引擎 → {skipped:true}（开发环境免费放行，向后兼容）
 * - 金额 ≤ 0 → 免费操作，放行
 * - 余额不足 / 确认失败 → 抛 402（充值提示）
 * - 引擎异常 → 抛 503
 */
export async function chargeGas(subscriber: string, reference: string, amountWei: bigint): Promise<ChargeResult> {
  if (!vaultChargeConfigured()) return { skipped: true, charged: false, amountWei: '0' };
  if (amountWei <= 0n) return { skipped: true, charged: false, amountWei: '0' };
  ensureConfig();

  let balanceWei: bigint;
  try {
    balanceWei = BigInt(await vaultPaymentsApi.balance(subscriber));
  } catch (err: any) {
    if (err instanceof VaultChargeError) throw err;
    throw new VaultChargeError(`ledger balance query failed: ${err?.message}`, 503);
  }
  if (balanceWei < amountWei) {
    throw new VaultChargeError(
      `[402] ${topupHint()}（当前余额 ${ethers.formatEther(balanceWei)}，本次需 ${ethers.formatEther(amountWei)}）`, 402);
  }

  try {
    const created = await vaultPaymentsApi.createTransfer({
      from: subscriber.toLowerCase(),
      to: VAULT_PAYMENTS.platformAddress,
      valueWei: amountWei.toString(),
      reference,
    });
    const exec = await vaultPaymentsApi.confirmTransfer(created.transferId);
    if (!exec.executed) {
      throw new VaultChargeError(`[402] ${topupHint()}（确认扣款失败：${exec.error || exec.status}）`, 402);
    }
    return { skipped: false, charged: true, amountWei: amountWei.toString() };
  } catch (err: any) {
    if (err instanceof VaultChargeError) throw err;
    throw new VaultChargeError(`charge failed: ${err?.message}`, 503);
  }
}

/**
 * 结算退差（多退少补）：实际 gas 成本 ≠ 预扣额时，差额退回/追扣。
 * - 实际 < 预扣 → 平台退回差额（credit subscriber）
 * - 实际 > 预扣 → 追扣差额
 * 返回 { skipped, refundWei, extraWei }。
 */
export async function settleGas(
  subscriber: string,
  reference: string,
  chargedWei: bigint,
  actualWei: bigint,
): Promise<{ skipped: boolean; refundWei: string; extraWei: string }> {
  if (!vaultChargeConfigured()) return { skipped: true, refundWei: '0', extraWei: '0' };
  if (chargedWei <= 0n || actualWei < 0n) return { skipped: true, refundWei: '0', extraWei: '0' };

  const transfer = async (from: string, to: string, valueWei: bigint, ref: string) => {
    const created = await vaultPaymentsApi.createTransfer({ from, to, valueWei: valueWei.toString(), reference: ref });
    const exec = await vaultPaymentsApi.confirmTransfer(created.transferId);
    if (!exec.executed) throw new VaultChargeError(`settle transfer failed: ${exec.error || exec.status}`, 503);
  };

  try {
    if (actualWei < chargedWei) {
      const refund = chargedWei - actualWei;
      if (refund > 0n) {
        await transfer(VAULT_PAYMENTS.platformAddress, subscriber.toLowerCase(), refund, `${reference}:refund`);
        return { skipped: false, refundWei: refund.toString(), extraWei: '0' };
      }
    } else if (actualWei > chargedWei) {
      const extra = actualWei - chargedWei;
      await transfer(subscriber.toLowerCase(), VAULT_PAYMENTS.platformAddress, extra, `${reference}:extra`);
      return { skipped: false, refundWei: '0', extraWei: extra.toString() };
    }
    return { skipped: false, refundWei: '0', extraWei: '0' };
  } catch (err: any) {
    if (err instanceof VaultChargeError) throw err;
    throw new VaultChargeError(`settle failed: ${err?.message}`, 503);
  }
}

/** 查询用户 ledger 余额（引擎统一账本）。未配置引擎 → 抛 503。 */
export async function vaultLedgerBalance(subscriber: string): Promise<{ address: string; balanceWei: string; balance: string }> {
  const balanceWei = await vaultPaymentsApi.balance(subscriber);
  return {
    address: subscriber.toLowerCase(),
    balanceWei,
    balance: ethers.formatEther(BigInt(balanceWei || '0')),
  };
}

/** 套餐/计费模式说明（价目公开；vault 线为 gas 自付，无固定单价）。 */
export function vaultPlansInfo(): Record<string, unknown> {
  return {
    mode: 'gas-self-pay',
    billing: '按实际 gas 结算（createSafe/execute 广播前预扣预估成本，收据后多退少补）',
    configured: vaultChargeConfigured(),
    platformAddress: VAULT_PAYMENTS.platformAddress || '(未配置)',
    gasBufferPercent: 5,
    topup: vaultChargeConfigured()
      ? { method: 'x402 deposit', steps: [`向平台钱包 ${VAULT_PAYMENTS.platformAddress} 转入原生资产`, `调用引擎 POST ${VAULT_PAYMENTS.baseUrl}/payments/verify {txHash} 入账`, '余额自动计入钱包地址对应的 ledger 账户'] }
      : { method: 'n/a', note: 'metered billing 未配置（开发环境免费）' },
  };
}
