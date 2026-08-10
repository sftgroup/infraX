/**
 * InfraX Chain RPC Gateway — 全仓唯一链上 RPC 读取 + 交易广播网关。
 *
 * 与 WAAS 解耦：所有中心化服务（wallet/tx/saas/collector…）统一走本服务的
 * RPC 读/广播能力；本服务不持有任何私钥，广播仅转发调用方已签名的 rawTx。
 *
 * 端点：
 *   GET  /health                     健康检查（公开）
 *   POST /v1/rpc/:chain              读（CHAIN_RPC_READ_KEY 或广播 key）
 *   POST /v1/broadcast/:chain        广播（仅 CHAIN_RPC_BROADCAST_KEY）
 *   GET  /v1/status                  池状态（脱敏，读 key）
 *   WS   /v1/ws                      订阅代理（读 key；仅 eth_subscribe/eth_unsubscribe）
 */
import http from 'http';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { config } from './config';
import { logger } from './logger';
import { RpcPoolManager } from './services/rpcPool';
import { buildRpcPoolConfig } from './services/rpcPoolConfig';
import { createReadAuth, createBroadcastAuth } from './middleware/auth';
import { rpcQuotaEnforce } from './middleware/rpcQuotaEnforce';
import { createRpcRouter, createBroadcastRouter } from './routes/rpcRoutes';
import { attachWs } from './routes/ws';
import subscriptionRouter from './routes/rpcSubscriptionRoutes';
import { initRpcTables } from './services/rpcSubscription';

const app = express();

app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// ── 请求日志（DC-9 端点细分；不记录 headers，避免泄露鉴权 key） ──
app.use((req, res, next) => {
  if (config.logSkipHealth && req.path === '/health') return next();
  const t0 = Date.now();
  res.on('finish', () => {
    // 注意：finish 时 req.path 已被路由改写（strip 前缀），须用 req.originalUrl
    const p = req.originalUrl;
    const meta: Record<string, unknown> = {
      route: p.startsWith('/v1/rpc') ? 'rpc'
        : p.startsWith('/v1/broadcast') ? 'broadcast'
          : p.startsWith('/v1/status') ? 'status' : 'other',
      status: res.statusCode,
      dur: `${Date.now() - t0}ms`,
    };
    const m = p.match(/^\/v1\/(?:rpc|broadcast)\/([^/]+)$/);
    if (m) meta.chain = m[1];
    if (config.logMethod || config.logParams) {
      const body = req.body as any;
      if (body && typeof body === 'object') {
        // DC-6: batch 请求记录条数
        if (Array.isArray(body)) {
          if (config.logMethod) meta.batch = body.length;
        } else {
          if (config.logMethod && body.method) meta.method = body.method;
          if (config.logParams && body.params !== undefined) meta.params = body.params;
        }
      }
    }
    logger.info('[chain-rpc]', meta);
  });
  next();
});

// ── RPC 池初始化（路由依赖，须先于路由挂载） ─────────────
const cfg = buildRpcPoolConfig(config.supportedChains);
const active = Object.values(cfg).reduce((s, eps) => s + eps.length, 0);
if (active === 0) {
  logger.warn('[chain-rpc] No RPC endpoints loaded — configure INFRAX_RPC_POOL or per-chain env URLs');
} else {
  logger.info(`[chain-rpc] RPC pool loaded: ${active} endpoints across ${Object.keys(cfg).join(', ')}`);
}
const pool = new RpcPoolManager(cfg, {
  healthIntervalMs: config.healthIntervalMs,
  maxRetries: config.maxRetries,
  requestTimeoutMs: config.requestTimeoutMs,
});
// DC-7: 池参数（env 可配，启动时打印便于核对）
logger.info(
  `[chain-rpc] pool params: healthInterval=${config.healthIntervalMs}ms retries=${config.maxRetries} timeout=${config.requestTimeoutMs}ms`
);

// ── 健康检查（公开） ───────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'chain-rpc', chains: pool.chains() });
});

// ── 路由（鉴权分级：读 / 广播独立挂载，读 key 无法触达广播） ──
app.use('/v1/rpc', createReadAuth(), rpcQuotaEnforce(), createRpcRouter(pool));
app.use('/v1/broadcast', createBroadcastAuth(), createBroadcastRouter(pool));
// MQ-16 T-3: RPC 读套餐订阅（plans/issue-key 内部鉴权，checkout/payment-check/verify/usage 用 rx_ key 鉴权）
app.use('/v1/subscription', subscriptionRouter);
app.get('/v1/status', createReadAuth(), (_req, res) => {
  res.json({ code: 0, message: 'ok', data: { chains: pool.status(config.statusUrlMode as 'none' | 'host' | 'full') } });
});

// ── 404 ────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ detail: 'not found' });
});

// ── 错误处理 ──────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(`[chain-rpc] unhandled error: ${err?.message || err}`);
  res.status(500).json({ detail: 'internal error' });
});

const server = http.createServer(app);
attachWs(server, pool);

// MQ-16 T-3: 订阅计费表自举（rpc_keys / rpc_usage / rpc_usage_daily），失败仅告警不阻断启动
initRpcTables().catch((e) => logger.error(`[chain-rpc] rpc tables init failed: ${e.message}`));

server.listen(config.port, () => {
  logger.info(`[chain-rpc] listening on :${config.port} (env=${config.nodeEnv})`);
  logger.info(
    `[chain-rpc] auth: read=${config.readKey ? 'configured' : 'OPEN'} broadcast=${config.broadcastKey ? 'configured' : 'OPEN'} externalVerify=${config.enableExternalVerify}`
  );
});
