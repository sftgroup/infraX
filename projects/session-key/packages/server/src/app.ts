import Fastify from 'fastify';
import cors from '@fastify/cors';
import { EvmAdapter } from '@sftgroup/session-key-evm';
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
  await app.register(authPlugin);
  registerRoutes(app, { nonceService, sessionService, executionService });

  app.listen({ port: config.port, host: '0.0.0.0' }, (err, address) => {
    if (err) { app.log.error(err); process.exit(1); }
    app.log.info(`Session Key Engine running on ${address}`);
  });
}
