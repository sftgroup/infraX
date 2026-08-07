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
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { config } from './config';
import { logger } from './logger';
import { RpcPoolManager } from './services/rpcPool';
import { buildRpcPoolConfig } from './services/rpcPoolConfig';
import { createReadAuth, createBroadcastAuth } from './middleware/auth';
import { createRpcRouter, createBroadcastRouter } from './routes/rpcRoutes';

const app = express();

app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// ── 请求日志（访问可观测性；不记录 headers，避免泄露鉴权 key） ──
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const t0 = Date.now();
  res.on('finish', () => {
    logger.info(`[chain-rpc] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t0}ms`);
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
const pool = new RpcPoolManager(cfg);

// ── 健康检查（公开） ───────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'chain-rpc', chains: pool.chains() });
});

// ── 路由（鉴权分级：读 / 广播独立挂载，读 key 无法触达广播） ──
app.use('/v1/rpc', createReadAuth(), createRpcRouter(pool));
app.use('/v1/broadcast', createBroadcastAuth(), createBroadcastRouter(pool));
app.get('/v1/status', createReadAuth(), (_req, res) => {
  res.json({ code: 0, message: 'ok', data: { chains: pool.status() } });
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

app.listen(config.port, () => {
  logger.info(`[chain-rpc] listening on :${config.port} (env=${config.nodeEnv})`);
  logger.info(
    `[chain-rpc] auth: read=${config.readKey ? 'configured' : 'OPEN'} broadcast=${config.broadcastKey ? 'configured' : 'OPEN'} externalVerify=${config.enableExternalVerify}`
  );
});
