import type { SessionPermission, SessionPolicy } from './types.js';

// ============================================================================
// AA-6：B2 session 复用 —— 策略兼容判定
// 复用前提：① 链上已绑定 session validator（isSessionModuleInstalled=true，AA-3）；
//           ② 既有 session 策略兼容（同 product 由调用方按 product 过滤，此处判白名单
//              覆盖 + 限额 ≥ + 有效期覆盖），复用后零额外链上交易。
// 兼容语义 = 既有 session 至少与请求同等权限（superset）：每个请求 permission 都被
// 既有某条 permission 完全覆盖；限额 0 = 不限（可覆盖任意请求限额）。
// ============================================================================

export interface IsPolicySupersetParams {
  /** 既有 session（来自 relay store，product 已过滤） */
  existing: SessionPolicy;
  /** 本次请求策略 */
  requested: SessionPolicy;
  /** 当前时间戳（秒）；缺省 = Date.now()/1000。用于"未过期 + 已生效"判定 */
  nowSec?: bigint;
}

const value = (n?: bigint): bigint => n ?? 0n;

/**
 * existing 单条 permission 是否覆盖 requested 单条 permission：
 * targets ⊇ / selectors ⊇（空 = 全允许）/ valueLimit、dailyLimit、countLimit、
 * tokenLimits、allowAnyTransfer 限额均 ≥（0 = 不限）。
 */
export function permissionCovers(existing: SessionPermission, requested: SessionPermission): boolean {
  // targets：requested 每个 target 必须在 existing 白名单（空 = 全禁止，无法覆盖）
  if ((requested.targets ?? []).length === 0) return false;
  for (const t of requested.targets) {
    if (!(existing.targets ?? []).some((e) => e.toLowerCase() === t.toLowerCase())) return false;
  }
  // selectors：requested 空 = 不限制；existing 空 = 全允许；否则 existing ⊇ requested
  const reqSelectors = requested.selectors ?? [];
  if (reqSelectors.length > 0) {
    const exSelectors = existing.selectors ?? [];
    if (exSelectors.length > 0) {
      for (const s of reqSelectors) {
        if (!exSelectors.some((e) => e.toLowerCase() === s.toLowerCase())) return false;
      }
    }
  }
  // 单笔 / 日限额 / 次数（0 = 不限）
  const ev = value(existing.valueLimit);
  if (ev !== 0n && value(requested.valueLimit) > ev) return false;
  const ed = value(existing.dailyLimit);
  if (ed !== 0n && value(requested.dailyLimit) > ed) return false;
  const ec = existing.countLimit ?? 0;
  if (ec !== 0 && (requested.countLimit ?? 0) > ec) return false;
  // per-token 金额限额
  for (const rt of requested.tokenLimits ?? []) {
    const et = (existing.tokenLimits ?? []).find((x) => x.token.toLowerCase() === rt.token.toLowerCase());
    if (!et) return false;
    if (et.maxPerTx !== 0n && rt.maxPerTx > et.maxPerTx) return false;
    if (et.maxDaily !== 0n && rt.maxDaily > et.maxDaily) return false;
  }
  // 任意地址原生转账授权
  if (requested.allowAnyTransfer) {
    const ea = existing.allowAnyTransfer;
    if (!ea) return false;
    if (ea.maxPerTx !== 0n && requested.allowAnyTransfer.maxPerTx > ea.maxPerTx) return false;
    if (ea.maxDaily !== 0n && requested.allowAnyTransfer.maxDaily > ea.maxDaily) return false;
  }
  return true;
}

/**
 * 既有 session 是否可复用（覆盖请求策略）：
 *   ① 既有未过期（validUntil > now）且已生效（validAfter <= now）；
 *   ② 既有有效期覆盖请求窗口（validUntil >= requested.validUntil）——复用零上链交易，
 *      无法延长有效期，请求更长窗口只能走重新 enable；
 *   ③ 每个请求 permission 被既有某条 permission 覆盖。
 */
export function isPolicySuperset(p: IsPolicySupersetParams): boolean {
  const now = p.nowSec ?? BigInt(Math.floor(Date.now() / 1000));
  if (p.existing.validUntil <= now) return false;
  if (p.existing.validAfter > now) return false;
  if (p.existing.validUntil < p.requested.validUntil) return false;
  for (const rp of p.requested.permissions) {
    if (!p.existing.permissions.some((ep) => permissionCovers(ep, rp))) return false;
  }
  return true;
}
