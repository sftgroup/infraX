// ============================================================================
// aa-relay —— ERC-4337 UserOp 转发网关（E-1c）—— 应用引导/挂载
// 职责：① 中间件（cors/json/入站鉴权）；② 挂载路由模块
//       （routes/relay.ts：UserOp 转发/收据/gas 估算/paymaster；
//        routes/session.ts：session 创建/查询/撤销/轮换/校验）；
//       ③ A-10 计费路由（plans/ledger）；④ 统一 JSON 错误处理器。
// 链配置复用 aa-sdk（env AA_{CHAIN}_* 零硬编码）；bundler URL 由服务端注入（apikey 代理）。
// ============================================================================
import express from 'express';
import { Pool } from 'pg';
import { getChainConfig, getEnabledChains } from '../../aa-sdk/src/index.js';
import { PostgresSessionStore } from './session-store.js';
import { aaChargeConfigured, escrowConfigured, aaLedgerBalance, aaPlansInfo, AABillingError } from './billing.js';
import { apiResponse, asyncHandler, authMw } from './helpers.js';
import { relayRoutes } from './routes/relay.js';
import { sessionRoutes } from './routes/session.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());

function cors() {
  return (_req: any, res: any, next: any) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Service-Key');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (_req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

// E-3a/b：session 持久化存储（Postgres，多租户 product 维度，重启不失效）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432',
});
const sessionStore = new PostgresSessionStore(pool);
sessionStore.initTables().catch((e) => console.error('[aa-relay] session table init error:', e.message));

// GET /health 免鉴权（供监控/负载均衡）
app.get('/health', (_req: any, res: any) => {
  const chains = getEnabledChains(process.env);
  const bundlers: Record<string, string[]> = {};
  for (const c of chains) {
    try {
      bundlers[c] = getChainConfig(c, process.env).bundlers.map((b) => b.url);
    } catch (e: any) {
      bundlers[c] = [`ERROR: ${e.message}`];
    }
  }
  res.json({ status: 'ok', service: 'aa-relay', chains, bundlers });
});

// 入站鉴权（Bearer / X-API-Key / X-Service-Key；静态 key 优先，外部 ar_ key 实时校验）
app.use(authMw);

// ═══ 路由模块（E-1c / E-3a/b / AA-1/AA-6/AA-7）═══
app.use(relayRoutes());
app.use(sessionRoutes(sessionStore));

// ═══ A-10: session 订阅计费（UserOp 次数费 + paymaster gas 代付）═══

// GET /v1/plans — 套餐价目（公开）
app.get('/v1/plans', (_req: any, res: any) => {
  res.json(apiResponse(aaPlansInfo(), 'AA session billing plans'));
});

// POST /v1/ledger-balance — 智能账户 ledger 余额（REQ-2a：escrow 模式读链上托管，不要求 ledger 配置）
app.post('/v1/ledger-balance', asyncHandler(async (req: any, res: any) => {
  const { account } = req.body || {};
  if (!account) return res.status(400).json(apiResponse(null, 'account required (smart account address)', 1001));
  if (!aaChargeConfigured() && !escrowConfigured()) {
    return res.status(503).json(apiResponse(null, 'AA session billing is not configured (AA_PAYMENTS_URL/AA_PAYMENTS_API_KEY/AA_PLATFORM_ADDRESS or ESCROW_*)', 1007));
  }
  try {
    const balance = await aaLedgerBalance(String(account));
    res.json(apiResponse(balance, 'Ledger balance'));
  } catch (e: any) {
    res.status(e instanceof AABillingError ? e.status : 503)
      .json(apiResponse(null, e?.message || 'ledger balance unavailable', 1007));
  }
}));

// 统一 JSON 错误处理器
app.use((err: any, _req: any, res: any, _next: any) => {
  const status = err instanceof AABillingError
    ? err.status
    : typeof err?.statusCode === 'number' ? err.statusCode
    : typeof err?.status === 'number' ? err.status
    : 500;
  const message = err?.message || 'Internal server error';
  if (status >= 500) console.error('[aa-relay] Error:', err);
  res.status(status).json(apiResponse(null, message.replace(/^\[402\]\s*/, ''), status === 402 ? 1001 : status >= 500 ? 1007 : 1001));
});

const PORT = parseInt(process.env.PORT || '9131', 10);
app.listen(PORT, () => console.log(`aa-relay running on port ${PORT}`));
