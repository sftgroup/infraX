import Fastify from 'fastify';
import cors from '@fastify/cors';
import { EvmAdapter } from '@0xinfrax/session-key-evm';
import { loadConfig } from './config.js';
import { authPlugin } from './plugins/auth.js';
import { createInfra, initDb } from './plugins/db.js';
import { SessionRepo } from './repos/session-repo.js';
import { ExecutionRepo } from './repos/execution-repo.js';
import { NonceService } from './services/nonce-service.js';
import { SessionService } from './services/session-service.js';
import { ExecutionService } from './services/execution-service.js';
import { registerRoutes } from './routes/index.js';

export async function start() {
  const config = loadConfig();
  const { pool, redis } = createInfra();

  await initDb(pool);

  // ── Wire dependencies ───────────────────────────────────────────
  const adapter = new EvmAdapter();
  const sessionRepo = new SessionRepo(pool);
  const executionRepo = new ExecutionRepo(pool);
  const nonceService = new NonceService();
  const sessionService = new SessionService(sessionRepo, adapter);
  const executionService = new ExecutionService(sessionRepo, executionRepo, adapter, redis);

  // ── Fastify ─────────────────────────────────────────────────────
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true, credentials: true });
  // 直接调用而非 register：addHook 必须注册在 root 实例才对所有路由生效
  // （register 会创建插件封装上下文，其内部 hook 不影响 root 上注册的路由）
  await authPlugin(app);
  registerRoutes(app, { nonceService, sessionService, executionService });

  // MQ-4: 过期 session 定时清理（每 5 分钟，unref 不阻塞进程退出）
  const expireTimer = setInterval(async () => {
    try {
      const n = await sessionRepo.expireStale();
      if (n > 0) app.log.info(`Expired ${n} stale session(s)`);
    } catch (err: any) {
      app.log.error('expireStale failed', err);
    }
  }, 5 * 60 * 1000);
  expireTimer.unref();

  app.listen({ port: config.port, host: '0.0.0.0' }, (err, address) => {
    if (err) { app.log.error(err); process.exit(1); }
    app.log.info(`Session Key Engine running on ${address}`);
  });
}
