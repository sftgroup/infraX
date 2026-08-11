// InfraX Admin — Data stack routes
// 数据服务栈管理：data :9112 / knowledge-injector :9113 / ragservicer :9721
// 全部路由都通过 requireAdmin 鉴权（在 index.ts 挂载时校验）。
import express from 'express';
import fs from 'fs';

const router = express.Router();

// ── 数据栈服务地址（admin 与数据栈同机时默认 127.0.0.1） ──
const DATA_BASE = process.env.DATA_BASE || 'http://127.0.0.1:9112';
const INJECTOR_BASE = process.env.INJECTOR_BASE || 'http://127.0.0.1:9113';
const RAGSERVICER_BASE = process.env.RAGSERVICER_BASE || 'http://127.0.0.1:9721';
const RAGSERVICER_API_BASE = `${RAGSERVICER_BASE}/api/v1`;

// ragservicer .env 路径（LLM key 落点；admin 与 ragservicer 同机时可直接读写）
const RAGSERVICER_ENV_PATH =
  process.env.RAGSERVICER_ENV_PATH || '/home/ubuntu/infraX-1/projects/ragservicer/.env';

// ragservicer 管理 key（调用 /admin/config 与实例列表；优先取 .env 中当前
// ADMIN_API_KEY，env 可覆盖。改 key 后无需重启 admin，动态读取）
function readRagAdminKey(): string {
  if (process.env.RAGSERVICER_ADMIN_KEY) return process.env.RAGSERVICER_ADMIN_KEY;
  try {
    const env = fs.existsSync(RAGSERVICER_ENV_PATH) ? fs.readFileSync(RAGSERVICER_ENV_PATH, 'utf8') : '';
    const line = env.split('\n').find(l => l.startsWith('ADMIN_API_KEY='));
    return line ? line.split('=').slice(1).join('=').trim() : '';
  } catch {
    return '';
  }
}
const RAGSERVICER_ADMIN_KEY = readRagAdminKey();

// data-service / knowledge-injector .env 路径（各自数据源 key 管理配置落点）
const DATA_ENV_PATH = process.env.DATA_ENV_PATH || '/home/ubuntu/infraX-1/projects/data/.env';
const INJECTOR_ENV_PATH = process.env.INJECTOR_ENV_PATH || '/home/ubuntu/infraX-1/projects/knowledge-injector/.env';

// 从指定 .env 读取 ADMIN_API_KEY（用于调用各服务 /admin/config；env 可覆盖，改 key 后无需重启 admin）
function readAdminKeyFromEnv(envPath: string): string {
  try {
    const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const line = env.split('\n').find(l => l.startsWith('ADMIN_API_KEY='));
    return line ? line.split('=').slice(1).join('=').trim() : '';
  } catch {
    return '';
  }
}
const DATA_ADMIN_KEY = readAdminKeyFromEnv(DATA_ENV_PATH);
const INJECTOR_ADMIN_KEY = readAdminKeyFromEnv(INJECTOR_ENV_PATH);

const TIMEOUT_MS = 8000;

async function getJson<T = any>(url: string, headers: Record<string, string> = {}, timeout = TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// 业务端点调用头：key 为空时不出头（对应服务兼容模式仍开放）
function apiKeyHeader(key: string): Record<string, string> {
  return key ? { 'X-API-Key': key } : {};
}

// ── RAGservicer 配置 API 转发（替代原 .env 直接读写 + systemctl 重启） ──
// ragservicer 自身管理 LLM/embedding 配置：GET/PUT /api/v1/admin/config（热生效）。
async function ragConfigReq<T = any>(method: 'GET' | 'PUT', path: string, body?: any): Promise<{ status: number; data?: T; message?: string }> {
  if (!RAGSERVICER_ADMIN_KEY) {
    return { status: 503, message: 'ragservicer admin key 未配置（RAGSERVICER_ADMIN_KEY 或 ragservicer .env 的 ADMIN_API_KEY）' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${RAGSERVICER_API_BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RAGSERVICER_ADMIN_KEY}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { status: r.status, message: j?.message || `HTTP ${r.status}` };
    return { status: r.status, data: (j?.data ?? j) as T };
  } catch (e: any) {
    return { status: 0, message: `连接 ragservicer 失败: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── 概览：三个服务健康 + 关键指标（任一失败不影响其他） ──
router.get('/overview', async (_req: any, res: any, next: any) => {
  try {
    const [data, injector, rag] = await Promise.all([
      (async () => {
        try {
          const [health, stats] = await Promise.all([
            getJson(`${DATA_BASE}/health`),
            getJson(`${DATA_BASE}/stats`),
          ]);
          return { ok: true, health, stats };
        } catch (e: any) {
          return { ok: false, error: e.message };
        }
      })(),
      (async () => {
        try {
          const [health, stats, recent] = await Promise.all([
            getJson(`${INJECTOR_BASE}/health`),
            getJson(`${INJECTOR_BASE}/stats`),
            getJson(`${INJECTOR_BASE}/stats/recent?limit=10`),
          ]);
          return { ok: true, health, stats, recent };
        } catch (e: any) {
          return { ok: false, error: e.message };
        }
      })(),
      (async () => {
        try {
          const health = await getJson(`${RAGSERVICER_API_BASE}/health`);
          let instances: any[] | null = null;
          if (RAGSERVICER_ADMIN_KEY) {
            try {
              const r = await getJson<any>(`${RAGSERVICER_API_BASE}/instances`, { 'X-API-Key': RAGSERVICER_ADMIN_KEY });
              instances = r?.instances ?? null;
            } catch {
              instances = null;
            }
          }
          return { ok: true, health, instances, adminKeySet: !!RAGSERVICER_ADMIN_KEY };
        } catch (e: any) {
          return { ok: false, error: e.message };
        }
      })(),
    ]);
    res.json({ code: 0, message: 'success', data: { data, injector, rag, fetched_at: Date.now() } });
  } catch (e: any) {
    next(e);
  }
});

// ── 因子：目录 + 最新外部因子值 ──
router.get('/factors', async (_req: any, res: any, next: any) => {
  try {
    const [catalog, current] = await Promise.all([
      getJson(`${DATA_BASE}/factors/catalog`, apiKeyHeader(DATA_API_KEY)),
      getJson(`${DATA_BASE}/factors/current?category=external`, apiKeyHeader(DATA_API_KEY)),
    ]);
    res.json({ code: 0, message: 'success', data: { catalog, current } });
  } catch (e: any) {
    next(e);
  }
});

// ── LLM/Embedding 配置：读取（转发 RAGservicer /admin/config，脱敏） ──
router.get('/llm-keys', async (_req: any, res: any) => {
  const r = await ragConfigReq<any>('GET', '/admin/config');
  if (r.status !== 200 || !r.data) {
    return res.status(r.status === 0 ? 502 : r.status).json({ code: -1, message: r.message, data: null });
  }
  res.json({ code: 0, message: 'success', data: { config: r.data, hot_reload: true } });
});

// ── LLM/Embedding 配置：更新（转发 RAGservicer /admin/config，热生效，无需重启） ──
router.post('/llm-keys', async (req: any, res: any) => {
  const { llm, embedding } = req.body || {};

  const pick = (src: any, numFields: string[] = []): Record<string, any> | undefined => {
    if (!src || typeof src !== 'object') return undefined;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined || v === null || String(v).trim() === '') continue;
      out[k] = numFields.includes(k) ? Number(v) : String(v).trim();
    }
    return Object.keys(out).length ? out : undefined;
  };

  const payload: Record<string, any> = {};
  const pLlm = pick(llm);
  if (pLlm) payload.llm = pLlm;
  const pEmb = pick(embedding, ['dims', 'max_token_size']);
  if (pEmb) payload.embedding = pEmb;
  if (!Object.keys(payload).length) {
    return res.status(400).json({ code: -1, message: 'nothing to update', data: null });
  }

  const r = await ragConfigReq<any>('PUT', '/admin/config', payload);
  if (r.status !== 200 || !r.data) {
    return res.status(r.status === 0 ? 502 : r.status).json({ code: -1, message: r.message, data: null });
  }
  res.json({ code: 0, message: 'success', data: { config: r.data, hot_reload: true } });
});

// ── 数据源 API Key 转发（data-service / knowledge-injector 的 /admin/config，Bearer 鉴权） ──
// 两个服务各自管理数据源 key（多 key 逗号分隔，采集时轮询取用），admin 仅做透传转发。
async function dataStackConfigReq(base: string, adminKey: string, method: 'GET' | 'PUT', body?: any): Promise<{ status: number; data?: any; message?: string }> {
  if (!adminKey) {
    return { status: 503, message: '服务 admin key 未配置（对应服务 .env 的 ADMIN_API_KEY）' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/admin/config`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { status: r.status, message: j?.message || `HTTP ${r.status}` };
    return { status: r.status, data: (j?.data ?? j) as any };
  } catch (e: any) {
    return { status: 0, message: `连接服务失败: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── 数据源 API Key：读取（并行拉两个服务配置，任一失败不影响其他） ──
router.get('/data-source-keys', async (_req: any, res: any) => {
  const [dataR, injR] = await Promise.all([
    dataStackConfigReq(DATA_BASE, DATA_ADMIN_KEY, 'GET'),
    dataStackConfigReq(INJECTOR_BASE, INJECTOR_ADMIN_KEY, 'GET'),
  ]);
  const dataOk = dataR.status === 200 && !!dataR.data;
  const injOk = injR.status === 200 && !!injR.data;
  res.json({
    code: 0,
    message: 'success',
    data: {
      data: { ok: dataOk, config: dataR.data ?? null, adminKeySet: !!DATA_ADMIN_KEY, error: dataOk ? undefined : dataR.message },
      injector: { ok: injOk, config: injR.data ?? null, adminKeySet: !!INJECTOR_ADMIN_KEY, error: injOk ? undefined : injR.message },
    },
  });
});

// ── 数据源 API Key：更新（分别转发 PUT，支持逗号分隔多 key / 数组，热生效） ──
router.post('/data-source-keys', async (req: any, res: any) => {
  const { data, injector } = req.body || {};

  const pick = (src: any): Record<string, any> | undefined => {
    if (!src || typeof src !== 'object') return undefined;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined || v === null || v === '') continue;
      out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };

  const payload: Record<string, any> = {};
  const pData = pick(data);
  if (pData) payload.data = pData;
  const pInj = pick(injector);
  if (pInj) payload.injector = pInj;
  if (!Object.keys(payload).length) {
    return res.status(400).json({ code: -1, message: 'nothing to update', data: null });
  }

  const results: Record<string, any> = {};
  if (pData) {
    const r = await dataStackConfigReq(DATA_BASE, DATA_ADMIN_KEY, 'PUT', { keys: pData });
    results.data = r.status === 200 && r.data ? { ok: true, config: r.data } : { ok: false, message: r.message };
  }
  if (pInj) {
    const r = await dataStackConfigReq(INJECTOR_BASE, INJECTOR_ADMIN_KEY, 'PUT', { keys: pInj });
    results.injector = r.status === 200 && r.data ? { ok: true, config: r.data } : { ok: false, message: r.message };
  }
  res.json({ code: 0, message: 'success', data: results });
});

// ═══════════════════════════════════════════════════════════════════
//  统一 API Key 管理（聚合 data dx_ key + ragservicer lr_ key）
//  前端一个页面管理两套服务签发的租户 key。
// ═══════════════════════════════════════════════════════════════════

// data 服务 admin/api-keys 调用（Bearer DATA_ADMIN_KEY，envelope {code,message,data}）
async function dataKeyReq<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: any): Promise<{ status: number; data?: T; message?: string }> {
  if (!DATA_ADMIN_KEY) {
    return { status: 503, message: 'data admin key 未配置（data .env 的 ADMIN_API_KEY）' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${DATA_BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DATA_ADMIN_KEY}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { status: r.status, message: j?.detail || j?.message || `HTTP ${r.status}` };
    return { status: r.status, data: (j?.data ?? j) as T };
  } catch (e: any) {
    return { status: 0, message: `连接 data 服务失败: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ragservicer tenant/keys 调用（Bearer RAGSERVICER_ADMIN_KEY；list 接口返回裸对象）
async function ragKeyReq<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: any): Promise<{ status: number; data?: T; message?: string }> {
  if (!RAGSERVICER_ADMIN_KEY) {
    return { status: 503, message: 'ragservicer admin key 未配置（RAGSERVICER_ADMIN_KEY 或 ragservicer .env 的 ADMIN_API_KEY）' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${RAGSERVICER_API_BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RAGSERVICER_ADMIN_KEY}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { status: r.status, message: j?.detail || j?.message || `HTTP ${r.status}` };
    return { status: r.status, data: (j?.data ?? j) as T };
  } catch (e: any) {
    return { status: 0, message: `连接 ragservicer 失败: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── 统一列表：data dx_/mx_ keys + 区块链栈 keys（px_/vx_/mp_/cr_/wa_）+ ragservicer tenants ──
// B-12-1：区块链栈（payment/vault/mpc/chain-rpc/waas）key 与 data/mcp 同表签发（前缀互斥），
// 此处按 scope 拆分展示；service-keys 管理即统一签发管理面。
const CHAIN_SCOPES = ['payment', 'vault', 'mpc', 'chain-rpc', 'waas'];

router.get('/keys', async (_req: any, res: any) => {
  const dataR = await dataKeyReq<any>('GET', '/admin/api-keys');
  const dataOk = dataR.status === 200 && Array.isArray(dataR.data);
  const allKeys = dataOk ? (dataR.data as any[]) : [];
  const dataKeys = allKeys.filter((k: any) => !CHAIN_SCOPES.includes(k.scope)).map((k: any) => ({ ...k, service: 'data' }));
  const chainKeys = allKeys.filter((k: any) => CHAIN_SCOPES.includes(k.scope)).map((k: any) => ({ ...k, service: k.scope }));

  const ragR = await ragKeyReq<{ tenants: any[] }>('GET', '/tenants');
  const ragOk = ragR.status === 200 && !!ragR.data;
  let tenants: any[] = [];
  if (ragOk) {
    const list = (ragR.data as any).tenants || [];
    tenants = await Promise.all(list.map(async (t: any) => {
      const keysR = await ragKeyReq<any>('GET', `/tenants/${encodeURIComponent(t.id)}/keys`);
      // ragservicer list 接口返回裸对象 {keys:[...]}（非信封），此处兼容两种形态
      const raw = keysR.status === 200 && keysR.data ? (keysR.data as any) : null;
      const keys = raw ? (Array.isArray(raw) ? raw : raw.keys || []) : [];
      return {
        ...t,
        keys,
        keys_ok: keysR.status === 200,
        keys_error: keysR.status === 200 ? undefined : keysR.message,
      };
    }));
  }

  res.json({
    code: 0, message: 'success',
    data: {
      data: { ok: dataOk, keys: dataKeys, adminKeySet: !!DATA_ADMIN_KEY, error: dataOk ? undefined : dataR.message },
      chain: { ok: dataOk, keys: chainKeys, adminKeySet: !!DATA_ADMIN_KEY, error: dataOk ? undefined : dataR.message },
      rag: { ok: ragOk, tenants, adminKeySet: !!RAGSERVICER_ADMIN_KEY, error: ragOk ? undefined : ragR.message },
      fetched_at: Date.now(),
    },
  });
});

// ── 统一签发：{service:'data'|'mcp'|'chain-rpc'|'waas', label, rate_limit} | {service:'rag', tenant_id, name, expires_days} ──
// B-12-1：区块链栈服务（payment/vault/mpc/chain-rpc/waas）与 data/mcp 同走 data 服务 api_keys 签发（前缀互斥）
router.post('/keys', async (req: any, res: any) => {
  const { service } = req.body || {};
  if (service === 'data' || service === 'mcp' || service === 'chain-rpc' || service === 'waas' ||
      service === 'payment' || service === 'vault' || service === 'mpc') {
    const label = String(req.body.label || '').trim();
    if (!label) return res.status(400).json({ code: -1, message: 'label required', data: null });
    const r = await dataKeyReq<any>('POST', '/admin/api-keys', { label, rate_limit: req.body.rate_limit, scope: service });
    if (r.status !== 201 && r.status !== 200) {
      return res.status(r.status === 0 ? 502 : r.status).json({ code: -1, message: r.message, data: null });
    }
    return res.json({ code: 0, message: 'success', data: { ...r.data, service } });
  }
  if (service === 'rag') {
    const tenant_id = String(req.body.tenant_id || '').trim();
    if (!tenant_id) return res.status(400).json({ code: -1, message: 'tenant_id required', data: null });
    // 1) 租户不存在则创建
    const listR = await ragKeyReq<{ tenants: any[] }>('GET', '/tenants');
    const exists = listR.status === 200 && (listR.data as any)?.tenants?.some((t: any) => t.id === tenant_id);
    if (!exists) {
      const cR = await ragKeyReq<any>('POST', '/tenants', {
        tenant_id,
        name: req.body.name || tenant_id,
        description: req.body.description || '',
      });
      if (cR.status !== 200 && cR.status !== 201) {
        return res.status(cR.status === 0 ? 502 : cR.status).json({ code: -1, message: cR.message, data: null });
      }
    }
    // 2) 签发 key
    const kR = await ragKeyReq<any>('POST', `/tenants/${encodeURIComponent(tenant_id)}/keys`, {
      name: req.body.name || 'prod',
      expires_days: Number(req.body.expires_days) || 0,
    });
    if (kR.status !== 201 && kR.status !== 200) {
      return res.status(kR.status === 0 ? 502 : kR.status).json({ code: -1, message: kR.message, data: null });
    }
    return res.json({ code: 0, message: 'success', data: { ...kR.data, service: 'rag' } });
  }
  res.status(400).json({ code: -1, message: "service must be 'data', 'mcp' or 'rag'", data: null });
});

// ── data key：更新（label/enabled/rate_limit） ──
router.patch('/keys/data/:id', async (req: any, res: any) => {
  const r = await dataKeyReq<any>('PATCH', `/admin/api-keys/${req.params.id}`, {
    label: req.body.label,
    enabled: req.body.enabled,
    rate_limit: req.body.rate_limit,
  });
  if (r.status !== 200) return res.status(r.status === 0 ? 502 : r.status).json({ code: -1, message: r.message, data: null });
  res.json({ code: 0, message: 'success', data: r.data });
});

// ── data key：轮换（返回新完整 key，仅一次） ──
router.post('/keys/data/:id/rotate', async (req: any, res: any) => {
  const r = await dataKeyReq<any>('POST', `/admin/api-keys/${req.params.id}/rotate`);
  if (r.status !== 200) return res.status(r.status === 0 ? 502 : r.status).json({ code: -1, message: r.message, data: null });
  res.json({ code: 0, message: 'success', data: { ...r.data, service: 'data' } });
});

// ── data key：删除 ──
router.delete('/keys/data/:id', async (req: any, res: any) => {
  const r = await dataKeyReq<any>('DELETE', `/admin/api-keys/${req.params.id}`);
  if (r.status !== 200) return res.status(r.status === 0 ? 502 : r.status).json({ code: -1, message: r.message, data: null });
  res.json({ code: 0, message: 'success', data: r.data });
});

// ── rag key：吊销 ──
router.post('/keys/rag/:keyId/revoke', async (req: any, res: any) => {
  const r = await ragKeyReq<any>('POST', `/keys/${encodeURIComponent(req.params.keyId)}/revoke`);
  if (r.status !== 200) return res.status(r.status === 0 ? 502 : r.status).json({ code: -1, message: r.message, data: null });
  res.json({ code: 0, message: 'success', data: r.data });
});

// ── rag 租户：删除（连带其 keys） ──
router.delete('/keys/rag/:tenantId', async (req: any, res: any) => {
  const r = await ragKeyReq<any>('DELETE', `/tenants/${encodeURIComponent(req.params.tenantId)}`);
  if (r.status !== 200) return res.status(r.status === 0 ? 502 : r.status).json({ code: -1, message: r.message, data: null });
  res.json({ code: 0, message: 'success', data: r.data });
});

export default router;
