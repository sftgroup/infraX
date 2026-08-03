// InfraX Admin — Data stack routes
// 数据服务栈管理：data :9112 / knowledge-injector :9113 / ragservicer :9721
// 全部路由都通过 requireAdmin 鉴权（在 index.ts 挂载时校验）。
import express from 'express';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);
const router = express.Router();

// ── 数据栈服务地址（admin 与数据栈同机时默认 127.0.0.1） ──
const DATA_BASE = process.env.DATA_BASE || 'http://127.0.0.1:9112';
const INJECTOR_BASE = process.env.INJECTOR_BASE || 'http://127.0.0.1:9113';
const RAGSERVICER_BASE = process.env.RAGSERVICER_BASE || 'http://127.0.0.1:9721';
const RAGSERVICER_API_BASE = `${RAGSERVICER_BASE}/api/v1`;

// ragservicer .env 路径（LLM key 落点；admin 与 ragservicer 同机时可直接读写）
const RAGSERVICER_ENV_PATH =
  process.env.RAGSERVICER_ENV_PATH || '/home/ubuntu/infraX-1/projects/ragservicer/.env';

// ragservicer 管理 key（用于拉取实例列表；优先取 .env 中当前 ADMIN_API_KEY，env 可覆盖）
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

// 重启命令前缀：非 root 时填 'sudo'（需免密 sudo），root 时留空
const RESTART_CMD = process.env.RESTART_CMD || 'sudo';

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

function maskKey(v: string | undefined): { set: boolean; masked: string } {
  if (!v) return { set: false, masked: '' };
  if (v.length <= 8) return { set: true, masked: '********' };
  return { set: true, masked: `${v.slice(0, 4)}********${v.slice(-4)}` };
}

async function restartUnit(unit: string): Promise<void> {
  const bin = RESTART_CMD || 'systemctl';
  const args = RESTART_CMD ? ['-n', 'systemctl', 'restart', unit] : ['restart', unit];
  await execFileP(bin, args, { timeout: 30000 });
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
      getJson(`${DATA_BASE}/factors/catalog`),
      getJson(`${DATA_BASE}/factors/current?category=external`),
    ]);
    res.json({ code: 0, message: 'success', data: { catalog, current } });
  } catch (e: any) {
    next(e);
  }
});

// ── LLM Keys：读取（脱敏）状态 ──
router.get('/llm-keys', (_req: any, res: any) => {
  try {
    const env = fs.existsSync(RAGSERVICER_ENV_PATH) ? fs.readFileSync(RAGSERVICER_ENV_PATH, 'utf8') : '';
    const get = (k: string) => {
      const line = env.split('\n').find(l => l.startsWith(`${k}=`));
      return line ? line.split('=').slice(1).join('=').trim() : '';
    };
    res.json({
      code: 0,
      message: 'success',
      data: {
        env_path: RAGSERVICER_ENV_PATH,
        env_exists: !!env,
        keys: {
          llm_api_key: maskKey(get('LLM_BINDING_API_KEY')),
          embedding_api_key: maskKey(get('EMBEDDING_API_KEY')),
          admin_api_key: maskKey(get('ADMIN_API_KEY')),
          ragservicer_api_key: maskKey(get('RAGSERVICER_API_KEY')),
        },
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: -1, message: e.message, data: null });
  }
});

// ── LLM Keys：写入 ragservicer .env 并重启服务 ──
router.post('/llm-keys', async (req: any, res: any) => {
  const { llm_api_key, embedding_api_key, admin_api_key, ragservicer_api_key } = req.body || {};
  const keyMap: Array<[string, string]> = (
    [
      ['LLM_BINDING_API_KEY', llm_api_key],
      ['EMBEDDING_API_KEY', embedding_api_key],
      ['ADMIN_API_KEY', admin_api_key],
      ['RAGSERVICER_API_KEY', ragservicer_api_key],
    ] as Array<[string, string | undefined]>
  )
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => [k, String(v).trim()] as [string, string]);

  if (!keyMap.length) return res.status(400).json({ code: -1, message: 'nothing to update', data: null });
  if (!fs.existsSync(RAGSERVICER_ENV_PATH)) {
    return res.status(400).json({ code: -1, message: `ragservicer .env not found: ${RAGSERVICER_ENV_PATH}`, data: null });
  }

  try {
    const lines = fs.readFileSync(RAGSERVICER_ENV_PATH, 'utf8').split('\n');
    for (const [k, v] of keyMap) {
      const line = `${k}=${v}`;
      const idx = lines.findIndex(l => l.startsWith(`${k}=`));
      if (idx >= 0) lines[idx] = line;
      else lines.push(line);
    }
    fs.writeFileSync(RAGSERVICER_ENV_PATH, lines.join('\n'));
  } catch (e: any) {
    return res.status(500).json({ code: -1, message: `write .env failed: ${e.message}`, data: null });
  }

  // 重启 ragservicer；若同步更新了注入器桥接 key 则一并重启注入器
  const restarted: string[] = [];
  try {
    await restartUnit('infrax-ragservicer');
    restarted.push('infrax-ragservicer');
  } catch (e: any) {
    console.error('restart infrax-ragservicer failed:', e.message);
  }
  if (keyMap.some(([k]) => k === 'RAGSERVICER_API_KEY')) {
    try {
      await restartUnit('infrax-knowledge-injector');
      restarted.push('infrax-knowledge-injector');
    } catch (e: any) {
      console.error('restart infrax-knowledge-injector failed:', e.message);
    }
  }
  res.json({ code: 0, message: 'keys saved', data: { updated: keyMap.map(([k]) => k), restarted } });
});

export default router;
