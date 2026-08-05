/**
 * 统一平台鉴权契约 — Express/Node 服务版（共享唯一来源，与 Python 版
 * projects/shared/app_auth.py 语义一致）。
 *
 * 契约（三选一，任一匹配即通过）：
 *   Authorization: Bearer <key>
 *   X-API-Key: <key>
 *   X-Service-Key: <key>          # 服务间调用约定（web 代理注入）
 *
 * 校验顺序：
 *   1. /health /metrics 豁免（可选配置更多豁免前缀）
 *   2. 本地 bridge key（opts.envKeys，逗号分隔环境变量，常量时间比较）
 *   3. 外部签发 key 实时校验：POST {verifyUrl}/api-keys/verify
 *      （Bearer {verifyKey}，body {api_key, scope}），由 data 服务按 scope
 *      匹配 key_hash，支持 admin 面板统一签发的 dx_/mx_/px_/vx_/mp_ 等
 * 失败统一响应：401 {"detail":"unauthorized"}（与数据栈契约一致）。
 *
 * 依赖：仅 node:crypto，无第三方包，可直接被任意 Express 服务以相对路径引用。
 */

import crypto from 'crypto';

export interface AuthExpressOptions {
  /** 逗号分隔的平台 bridge key（如 PAYMENT_API_KEY），任一匹配即放行 */
  envKeys?: string;
  /** 外部签发 key 的业务 scope（对应 data 服务 api_keys.scope） */
  scope?: string;
  /** data 服务地址（用于 /api-keys/verify 实时校验外部 key），如 http://127.0.0.1:9112 */
  verifyUrl?: string;
  /** 平台 bridge key（调用 data 服务时 Bearer 携带） */
  verifyKey?: string;
  /** 额外豁免路径前缀（/health /metrics 已默认豁免） */
  exempt?: string[];
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function extractApiKey(req: any): string {
  const auth = (req.headers['authorization'] || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (req.headers['x-api-key'] || req.headers['x-service-key'] || '').trim();
}

export function createAuthMiddleware(opts: AuthExpressOptions) {
  const envKeys = (opts.envKeys || '').split(',').map((s) => s.trim()).filter(Boolean);
  const exempt = ['/health', '/metrics', ...(opts.exempt || [])];

  return async function authExpress(req: any, res: any, next: any): Promise<void> {
    const p: string = req.path || '/';
    if (exempt.some((e) => p === e || p.startsWith(e))) return next();

    const key = extractApiKey(req);
    if (!key) {
      res.status(401).json({ detail: 'unauthorized' });
      return;
    }
    if (envKeys.some((k) => k && timingSafeEqualStr(k, key))) return next();

    // 外部签发 key：调 data 服务实时校验（Bearer bridge key，5s 超时）
    if (opts.verifyUrl && opts.verifyKey) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(`${opts.verifyUrl}/api-keys/verify`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.verifyKey}`,
          },
          body: JSON.stringify({ api_key: key, scope: opts.scope || 'data' }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (r.ok) return next();
      } catch {
        // 校验服务不可用时按未授权处理（fail-closed）
      }
    }
    res.status(401).json({ detail: 'unauthorized' });
  };
}
