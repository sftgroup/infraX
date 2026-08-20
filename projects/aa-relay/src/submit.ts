// ============================================================================
// aa-relay UserOp 统一提交流程（helpers.ts 拆分：计费编排单一职责）
// runOpWithBilling —— "预扣 + 广播 + 结算退差"共享编排（POST /v1/userops 与
//   submitSignedOp 共用，2026-08-21 审查 #3 去重）；
// submitSignedOp —— 带 owner 签名 UserOp 的提交（/v1/session/revoke 与
//   /v1/session/replace/submit 共用）：owner 派生一致性 → 签名校验 → hash 校验
//   → 注入签名 → runOpWithBilling。
// ============================================================================
import { randomUUID } from 'node:crypto';
import type { Address, Hex } from 'viem';
import type { ChainAAConfig, UserOperationV7 } from '../../aa-sdk/src/index.js';
import { BundlerClient, ExternalWalletSigner, createKernelAccount, getUserOpHash, verifyDisableSignature } from '../../aa-sdk/src/index.js';
import { aaFees, billingConfigured, chargeUserOp, estimateUserOpGasWei, retrySettle, settleUserOp } from './billing.js';
import { broadcast, isBundlerBusinessError, rpcErrorMessage, waitForUserOpReceipt } from './rpc.js';
import { normalizeOp } from './helpers.js';

/** P1-2: 异步收据后结算退差（后台 fire-and-forget；仅告警不阻塞响应）。 */
export function asyncSettle(
  cfg: ChainAAConfig,
  subscriber: string,
  chargeRef: string,
  chargeTotal: bigint,
  hash: Hex,
  label: string,
): void {
  waitForUserOpReceipt(cfg, hash)
    .then((receipt) => {
      if (!receipt) { console.warn(`[aa-relay] ${label} async settle timeout, keep charge ${chargeTotal}`); return; }
      const fixed = BigInt(aaFees().userop.feeWei);
      return retrySettle(
        () => settleUserOp(subscriber, chargeRef, chargeTotal, fixed + BigInt(receipt.actualGasCost)),
        `${label} settle`,
      );
    })
    .catch((bErr: any) => console.warn(`[aa-relay] ${label} async settle failed:`, bErr.message));
}

// ============================================================================
// runOpWithBilling —— UserOp 统一"计费预扣 + 广播 + 结算退差"编排
// 步骤：① billingConfigured()（ledger 或 escrow，双判定）预扣固定费 + 预估 gas
//       → ② wait=false 仅广播 + asyncSettle 异步结算；否则等收据按 actualGasCost 结算
//       → 广播失败 / bundler 业务拒绝 → 全额退还预扣（P2-1 失败重试）
// onResult 在广播成功后、响应前执行（如移除旧 session 记录）。
// ============================================================================
export interface RunOpWithBillingParams {
  cfg: ChainAAConfig;
  /** 日志用链名（如 oxachain） */
  chain: string;
  userOp: UserOperationV7;
  wait?: boolean;
  /** 计费参考前缀（userop/revoke/replace 等），账本追溯 ref = aa:{label}:{uuid} */
  chargeLabel: string;
  onResult?: (res: { userOpHash: Hex; bundlerUrl: string; receipt: any }) => Promise<void> | void;
}

export async function runOpWithBilling(params: RunOpWithBillingParams): Promise<{ userOpHash: Hex; bundlerUrl: string; receipt: any }> {
  const { cfg, chain, userOp, wait, chargeLabel, onResult } = params;
  // ① A-10 计费预扣（subscriber = 智能账户）；未配置（ledger+escrow 均无）→ 免费放行
  const subscriber = userOp.sender.toLowerCase();
  let chargeTotal = 0n;
  let chargeRef = '';
  if (billingConfigured()) {
    const fixed = BigInt(aaFees().userop.feeWei);
    const gasEst = estimateUserOpGasWei(userOp);
    chargeTotal = fixed + gasEst;
    if (chargeTotal > 0n) {
      chargeRef = `aa:${chargeLabel}:${randomUUID()}`;
      await chargeUserOp(subscriber, chargeRef, chargeTotal); // 402/503 直接抛（asyncHandler → 错误处理器）
    }
  }

  // ② wait=false：广播后 202，后台异步结算
  if (wait === false) {
    try {
      const res = await broadcast(cfg, userOp);
      if (chargeTotal > 0n) asyncSettle(cfg, subscriber, chargeRef, chargeTotal, res.userOpHash, chargeLabel);
      const out = { ...res, receipt: null };
      await onResult?.(out);
      return out;
    } catch (e) {
      // 广播失败 → 全额退还预扣（P2-1 失败重试）
      if (chargeTotal > 0n) {
        try { await retrySettle(() => settleUserOp(subscriber, chargeRef, chargeTotal, 0n), `${chargeLabel} refund`); }
        catch (bErr: any) { console.warn(`[aa-relay] ${chargeLabel} refund failed:`, bErr.message); }
      }
      throw e;
    }
  }

  // ③ wait：等收据后按 actualGasCost 结算退差（多退少补，P2-1 失败重试）；结算失败仅告警
  const client = new BundlerClient(cfg);
  try {
    const result = await client.sendUserOperation(userOp, {
      waitTimeoutMs: 120_000,
      onBroadcast: (h: any) => console.log(`[aa-relay] ${chargeLabel} ${chain} userOpHash=${h} accepted`),
    });
    if (chargeTotal > 0n && result.receipt) {
      const actualGasCost = result.receipt.actualGasCost;
      try {
        await retrySettle(
          () => settleUserOp(subscriber, chargeRef, chargeTotal, BigInt(aaFees().userop.feeWei) + actualGasCost),
          `${chargeLabel} settle`,
        );
      } catch (bErr: any) {
        console.warn(`[aa-relay] ${chargeLabel} gas settle failed:`, bErr.message);
      }
    }
    const res = { userOpHash: result.userOpHash, bundlerUrl: result.bundlerUrl, receipt: result.receipt ?? null };
    await onResult?.(res);
    return res;
  } catch (e: any) {
    if (isBundlerBusinessError(e)) {
      // bundler 业务拒绝（交易未执行）→ 全额退还预扣（P2-1 失败重试）
      if (chargeTotal > 0n) {
        try { await retrySettle(() => settleUserOp(subscriber, chargeRef, chargeTotal, 0n), `${chargeLabel} refund`); }
        catch (bErr: any) { console.warn(`[aa-relay] ${chargeLabel} refund failed:`, bErr.message); }
      }
      throw Object.assign(new Error(`bundler: ${rpcErrorMessage(e)}`), { statusCode: 400 });
    }
    throw e;
  }
}

// ============================================================================
// submitSignedOp —— 带 owner 签名 UserOp 的统一提交流程（AA-1/AA-7 重构去重）
// 前置步骤：① owner 派生账户一致性（防篡改）→ ② 签名校验（ECDSA recoverAddress）
//       → ③ op 实际 userOpHash === 已签名 userOpHash（防篡改/错配）
//       → ④ 注入 owner 签名 → runOpWithBilling（计费 + 广播 + 结算）
// ============================================================================
export interface SubmitSignedOpParams {
  chain: string;
  cfg: ChainAAConfig;
  account: Address;
  owner: Address;
  sessionId?: string; // 仅用于派生校验错误提示
  userOpHash: Hex;
  signature: Hex;
  op: Record<string, any>;
  wait?: boolean;
  /** 计费参考前缀（aa:revoke / aa:replace 等），用于账本追溯 */
  chargeLabel: string;
  onSuccess?: (res: { userOpHash: Hex; bundlerUrl: string; receipt: any }) => Promise<void> | void;
}

export async function submitSignedOp(params: SubmitSignedOpParams): Promise<{ userOpHash: Hex; bundlerUrl: string; receipt: any }> {
  const { cfg, account, owner, userOpHash, signature, op, wait, chargeLabel, onSuccess } = params;
  // ① owner 派生账户一致性（ExternalWalletSigner 只用于地址派生，无 provider 调用）
  const ownerSigner = new ExternalWalletSigner(
    { request: () => { throw new Error('no provider on server'); } } as any,
    owner,
  );
  const derived = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  if (derived.address.toLowerCase() !== String(account).toLowerCase()) {
    throw Object.assign(new Error('owner does not derive the given account'), { statusCode: 400 });
  }
  // ② 签名校验（owner 对 userOpHash 的 ECDSA；eth_sign 原始签名，viem recoverAddress）
  const valid = await verifyDisableSignature({ userOpHash, signature, owner });
  if (!valid) {
    throw Object.assign(new Error('signature verification failed'), { statusCode: 400 });
  }
  // ③ 组装待广播 UserOp（draft op 无签名）：校验 op 实际 hash 一致（防篡改）+ 注入 owner 签名
  const userOp = normalizeOp(op);
  const opHash = getUserOpHash(userOp, cfg.entryPoint, cfg.chainId);
  if (opHash.toLowerCase() !== String(userOpHash).toLowerCase()) {
    throw Object.assign(new Error('op does not match signed userOpHash'), { statusCode: 400 });
  }
  userOp.signature = signature;
  // ④ 计费 + 广播 + 结算（统一编排）
  return runOpWithBilling({ cfg, chain: params.chain, userOp, wait, chargeLabel, onResult: onSuccess });
}
