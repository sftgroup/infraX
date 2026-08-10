/**
 * chain-rpc 鉴权 — 读写分离双 key（与全栈契约一致，仅 node:crypto）。
 *
 * 契约（三选一，任一匹配即通过）：
 *   Authorization: Bearer <key>
 *   X-API-Key: <key>
 *   X-Service-Key: <key>        # 服务间调用约定
 *
 * 分级：
 *   readMiddleware    读端点要求 CHAIN_RPC_READ_KEY 或 CHAIN_RPC_BROADCAST_KEY（广播 key 权限更高，可读）
 *   broadcastMiddleware 广播端点仅认 CHAIN_RPC_BROADCAST_KEY（读 key 不可广播）
 * 可选：CHAIN_RPC_ENABLE_EXTERNAL_VERIFY=true + DATA_SERVICE_URL/DATA_API_KEY
 *   时，支持 data 服务统一签发的 dx_/mx_ 等外部 key（scope=rpc 读 / rpc_broadcast 广播）。
 * /health 豁免。
 */
import crypto from 'crypto';
import { config } from '../config';
import { findRpcKeyByRaw } from '../services/rpcSubscription';

export function extractApiKey(req: any): string {
  const auth = (req.headers['authorization'] || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (req.headers['x-api-key'] || req.headers['x-service-key'] || '').trim();
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isExempt(p: string): boolean {
  return p === '/health' || p === '/metrics' || p.startsWith('/health/');
}

/** 本地 bridge key 校验（常量时间比较） */
function matchLocal(key: string, allowed: string[]): boolean {
  return allowed.some((k) => k && timingSafeEqualStr(k, key));
}

/** 外部签发 key 实时校验：POST {verifyUrl}/api-keys/verify（fail-closed） */
async function matchExternal(key: string, scope: string): Promise<boolean> {
  if (!config.verifyUrl || !config.verifyKey) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${config.verifyUrl}/api-keys/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.verifyKey}`,
      },
      body: JSON.stringify({ api_key: key, scope }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

function unauthorized(res: any): void {
  res.status(401).json({ detail: 'unauthorized' });
}

export function createReadAuth() {
  return async function readAuth(req: any, res: any, next: any): Promise<void> {
    const p: string = req.path || '/';
    if (isExempt(p)) return next();
    const key = extractApiKey(req);
    if (!key) return unauthorized(res);
    // 广播 key 可读；读 key 可读（本地 bridge key：平台内部调用，豁免配额）
    if (matchLocal(key, [config.readKey, config.broadcastKey])) {
      req.isLocal = true;
      return next();
    }
    // MQ-16 T-3: rx_ 订阅 key（rpc_keys 表 SHA-256 哈希校验），配额由 rpcQuotaEnforce 记账
    if (key.startsWith('rx_')) {
      const rpcKey = await findRpcKeyByRaw(key);
      if (rpcKey && rpcKey.enabled !== false) {
        req.rpcKey = rpcKey;
        return next();
      }
      return unauthorized(res);
    }
    // 外部 data 服务签发 key（dx_/mx_ 等，scope=rpc；已按 data 订阅计费，此处豁免配额）
    if (config.enableExternalVerify && (await matchExternal(key, 'rpc'))) return next();
    return unauthorized(res);
  };
}

export function createBroadcastAuth() {
  return async function broadcastAuth(req: any, res: any, next: any): Promise<void> {
    const key = extractApiKey(req);
    if (!key) return unauthorized(res);
    if (matchLocal(key, [config.broadcastKey])) return next();
    if (config.enableExternalVerify && (await matchExternal(key, 'rpc_broadcast'))) return next();
    return unauthorized(res);
  };
}
