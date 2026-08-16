import type { Address, Hex } from 'viem';
import type { SessionPolicy } from './types.js';

// ============================================================================
// 权限校验（纯函数，可单测）——对齐 §7.3 + §7.5 + §7.6 安全边界
// 白名单必须显式包含；空列表 = 全部禁止（安全默认）。
// ============================================================================

/** 一次待校验的调用（P0.12 扩展：amount/anyTransfer） */
export interface SessionCall {
  target: Address;
  selector: Hex;
  value: bigint;
  /** ERC-20 金额（§7.5）：标准 transfer/approve 的 amount（末位 uint256 参数） */
  amount?: bigint;
  /** 原生币任意转账（§7.6）：调用方声明 data 为空（纯转账）；目标非合约由链上强制 */
  anyTransfer?: boolean;
}

/**
 * 权限校验：校验一次调用是否被策略允许。
 * 规则（§7.3 + §7.5 + §7.6）：target 白名单 + selector 白名单 + 单笔限额 + 日限额
 * + 有效期 + ERC-20 金额级限额（tokenLimits）+ 任意地址转账（allowAnyTransfer）。
 */
export function validateSessionCall(
  policy: SessionPolicy,
  call: SessionCall,
  nowSec: bigint,
  todayUsed?: bigint,
  todayTokenUsed?: Record<string, bigint>,
): { ok: boolean; reason?: string } {
  if (nowSec < policy.validAfter || nowSec > policy.validUntil) {
    return { ok: false, reason: 'session expired' };
  }
  for (const p of policy.permissions) {
    // §7.6 任意地址转账：哨兵授权 + 调用方声明纯转账
    if (p.allowAnyTransfer && call.anyTransfer) {
      if (p.allowAnyTransfer.maxPerTx > 0n && call.value > p.allowAnyTransfer.maxPerTx) {
        return { ok: false, reason: 'transfer exceeds single-tx limit' };
      }
      if (p.allowAnyTransfer.maxDaily > 0n && todayUsed !== undefined && todayUsed + call.value > p.allowAnyTransfer.maxDaily) {
        return { ok: false, reason: 'transfer exceeds daily limit' };
      }
      return { ok: true };
    }
    if (p.targets.length === 0 || !p.targets.some((t) => t.toLowerCase() === call.target.toLowerCase())) {
      continue; // 不在本 permission 的目标白名单，尝试下一条
    }
    if (!p.selectors || p.selectors.length === 0 || !p.selectors.some((s) => s.toLowerCase() === call.selector.toLowerCase())) {
      continue;
    }
    if (p.valueLimit && p.valueLimit > 0n && call.value > p.valueLimit) {
      return { ok: false, reason: 'value exceeds single-tx limit' };
    }
    if (p.dailyLimit && p.dailyLimit > 0n && todayUsed !== undefined && todayUsed + call.value > p.dailyLimit) {
      return { ok: false, reason: 'exceeds daily limit' };
    }
    // §7.5 ERC-20 金额级限额：target 命中 tokenLimits 中某 token → 校验单笔/日累计
    const tl = (p.tokenLimits ?? []).find((t) => t.token.toLowerCase() === call.target.toLowerCase());
    if (tl) {
      if (call.amount === undefined) {
        return { ok: false, reason: 'token amount required for limited token' };
      }
      if (tl.maxPerTx > 0n && call.amount > tl.maxPerTx) {
        return { ok: false, reason: 'token amount exceeds single-tx limit' };
      }
      if (tl.maxDaily > 0n && todayTokenUsed !== undefined) {
        const used = todayTokenUsed[tl.token.toLowerCase()] ?? 0n;
        if (used + call.amount > tl.maxDaily) {
          return { ok: false, reason: 'token exceeds daily limit' };
        }
      }
    }
    return { ok: true };
  }
  return { ok: false, reason: 'no matching permission' };
}
