// MQ-16 T-4: MPC Agent Wallet 按量套餐
// 模式与 T-1/T-2/T-3 同源：业务服务管"权益"，支付引擎管"钱"。
// 差异点：MPC 是 Agent 场景的**预付费按量**——钱包地址即引擎 ledger 账户，
// 用户经 x402（链上转入平台钱包 → 引擎 POST /payments/verify 入账）充值；
// 每次签名/转账调用从 ledger 余额按单价扣费（引擎 /payments/transfers 原子
// debit+credit），余额不足 → 402 + 充值提示；未配置引擎时向后兼容免费放行。
import { ethers } from 'ethers';

// ─── 按操作单价（wei，原生资产；env 可覆盖，默认 0.0001/0.001）───
export interface MpcFeeEntry {
  operation: string;
  label: string;
  feeWei: string;
}

export function mpcFees(): Record<string, MpcFeeEntry> {
  const sign = process.env.MPC_SIGN_FEE_WEI || ethers.parseEther('0.0001').toString();
  const tx = process.env.MPC_TX_FEE_WEI || ethers.parseEther('0.001').toString();
  return {
    sign_message: { operation: 'sign_message', label: 'Sign Message (EIP-191)', feeWei: sign },
    sign_typed_data: { operation: 'sign_typed_data', label: 'Sign Typed Data (EIP-712)', feeWei: sign },
    sign_digest: { operation: 'sign_digest', label: 'Sign Raw Digest (32B)', feeWei: sign },
    send_transaction: { operation: 'send_transaction', label: 'Send Transaction', feeWei: tx },
    contract_write: { operation: 'contract_write', label: 'Contract Write', feeWei: tx },
  };
}

export function feeWeiFor(operation: string): bigint {
  const entry = mpcFees()[operation];
  return entry ? BigInt(entry.feeWei) : 0n;
}

// ─── 支付引擎客户端（infrax-payments :9132，对齐 marketPlans/rpcSubscription）───
export class MpcChargeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const MPC_PAYMENTS = {
  baseUrl: (process.env.MPC_PAYMENTS_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.MPC_PAYMENTS_API_KEY || '',
  platformAddress: (process.env.MPC_PLATFORM_ADDRESS || '').toLowerCase(),
  chargeEnabled: false, // 由 ensureConfig() 初始化
};

export function mpcChargeConfigured(): boolean {
  return Boolean(MPC_PAYMENTS.baseUrl && MPC_PAYMENTS.apiKey && MPC_PAYMENTS.platformAddress);
}

function ensureConfig(): void {
  if (!MPC_PAYMENTS.baseUrl || !MPC_PAYMENTS.apiKey || !MPC_PAYMENTS.platformAddress) {
    throw new MpcChargeError('MPC metered billing is not configured (MPC_PAYMENTS_URL/MPC_PAYMENTS_API_KEY/MPC_PLATFORM_ADDRESS)', 503);
  }
}

async function paymentsCall<T = any>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (MPC_PAYMENTS.apiKey) headers['X-Service-Key'] = MPC_PAYMENTS.apiKey;
  const resp = await fetch(`${MPC_PAYMENTS.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) {
    let message = `payments ${path} failed (${resp.status})`;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* non-JSON */ }
    throw new MpcChargeError(message, resp.status === 422 ? 402 : resp.status);
  }
  return resp.json() as Promise<T>;
}

export const mpcPaymentsApi = {
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
  const payTo = MPC_PAYMENTS.platformAddress;
  const base = MPC_PAYMENTS.baseUrl || '(未配置)';
  return `余额不足。充值路径：向平台钱包 ${payTo} 转入原生资产，随后调用引擎 POST ${base}/payments/verify {txHash} 入账（按次扣费，详见 GET /api/v2/mpc/plans）`;
}

/**
 * 按次扣费：查询 ledger 余额 → 发起原子转账（幂等 reference）→ 确认扣款。
 * - 未配置引擎 → 返回 {skipped:true}（开发环境免费放行，向后兼容）
 * - 单价 ≤ 0 → 免费操作，放行
 * - 余额不足 / 确认失败 → 抛 402（充值提示）
 * - 引擎异常 → 抛 503（付费服务不可在无法记账时免费放行）
 */
export async function chargeMpcCall(address: string, operation: string, reference: string): Promise<{ skipped: boolean; charged: boolean; feeWei: string }> {
  const fee = feeWeiFor(operation);
  if (!mpcChargeConfigured()) return { skipped: true, charged: false, feeWei: '0' };
  if (fee <= 0n) return { skipped: true, charged: false, feeWei: '0' };

  let balanceWei: bigint;
  try {
    balanceWei = BigInt(await mpcPaymentsApi.balance(address));
  } catch (err: any) {
    if (err instanceof MpcChargeError) throw err;
    throw new MpcChargeError(`ledger balance query failed: ${err?.message}`, 503);
  }
  if (balanceWei < fee) {
    throw new MpcChargeError(`[402] ${topupHint()}（当前余额 ${ethers.formatEther(balanceWei)}，本次 ${operation} 需 ${ethers.formatEther(fee)}）`, 402);
  }

  try {
    const created = await mpcPaymentsApi.createTransfer({
      from: address.toLowerCase(),
      to: MPC_PAYMENTS.platformAddress,
      valueWei: fee.toString(),
      reference,
    });
    const exec = await mpcPaymentsApi.confirmTransfer(created.transferId);
    if (!exec.executed) {
      throw new MpcChargeError(`[402] ${topupHint()}（确认扣款失败：${exec.error || exec.status}）`, 402);
    }
    return { skipped: false, charged: true, feeWei: fee.toString() };
  } catch (err: any) {
    if (err instanceof MpcChargeError) throw err;
    throw new MpcChargeError(`charge failed: ${err?.message}`, 503);
  }
}

/** 查询钱包 ledger 余额（引擎统一账本）。未配置引擎 → 抛 503。 */
export async function mpcLedgerBalance(address: string): Promise<{ address: string; balanceWei: string; balance: string }> {
  const balanceWei = await mpcPaymentsApi.balance(address);
  return {
    address: address.toLowerCase(),
    balanceWei,
    balance: ethers.formatEther(BigInt(balanceWei || '0')),
  };
}
