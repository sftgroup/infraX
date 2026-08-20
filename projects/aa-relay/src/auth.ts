// ============================================================================
// aa-relay 入站鉴权（E-1c：静态 bridge key + 外部签发 key 实时校验）
// ① 静态本地 key（AA_RELAY_API_KEY）优先；② 配置了 AA_API_KEY_VERIFY_URL 时，
//    外部签发 key（ar_）经 data /api-keys/verify 实时校验（fail-closed，5s）；
// ③ 均未配置 → 开放（开发模式）。
// ============================================================================
const RELAY_KEY = process.env.AA_RELAY_API_KEY || '';

// E-1c: 外部 apikey 实时校验（data /api-keys/verify，chain-rpc 同款 fail-closed 模式）
//   AA_RELAY_API_KEY                 静态本地 bridge key（内部服务调用，保留）
//   AA_API_KEY_VERIFY_URL            data 服务 URL（如 https://infrax.0xainet.top/api/data 或 http://127.0.0.1:9112）
//   AA_API_KEY_VERIFY_KEY            调 data 的鉴权 key（DATA_API_KEY，Bearer）
//   AA_API_KEY_VERIFY_SCOPE          签发 scope（默认 aa-relay → ar_ 前缀 key）
const AA_API_KEY_VERIFY = {
  url: (process.env.AA_API_KEY_VERIFY_URL || '').replace(/\/+$/, ''),
  key: process.env.AA_API_KEY_VERIFY_KEY || '',
  scope: process.env.AA_API_KEY_VERIFY_SCOPE || 'aa-relay',
};

/** 外部签发 key 实时校验：POST {url}/api-keys/verify（fail-closed，5s 超时）。 */
async function matchExternalKey(key: string): Promise<boolean> {
  if (!AA_API_KEY_VERIFY.url || !AA_API_KEY_VERIFY.key) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${AA_API_KEY_VERIFY.url}/api-keys/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${AA_API_KEY_VERIFY.key}`,
      },
      body: JSON.stringify({ api_key: key, scope: AA_API_KEY_VERIFY.scope }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

// 入站鉴权：Bearer / X-API-Key / X-Service-Key 三选一。
export async function authMw(req: any, res: any, next: any) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const key = (bearer || req.headers['x-api-key'] || req.headers['x-service-key'] || '').trim();
  if (!key) {
    if (!RELAY_KEY && !AA_API_KEY_VERIFY.url) return next();
    res.status(401).json({ code: 401, message: 'unauthorized', data: null });
    return;
  }
  if (RELAY_KEY && key === RELAY_KEY) return next();
  if (AA_API_KEY_VERIFY.url && (await matchExternalKey(key))) return next();
  res.status(401).json({ code: 401, message: 'unauthorized', data: null });
}
