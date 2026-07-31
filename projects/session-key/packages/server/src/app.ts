import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config.js';
import { authPlugin } from './plugins/auth.js';
import { registerRoutes } from './routes/index.js';
import { initDb } from './plugins/db.js';

export async function buildApp() {
  const config = loadConfig();

  const app = Fastify({ logger: true });

  // Plugins
  await app.register(cors, { origin: true, credentials: true });
  await app.register(authPlugin);

  // Routes
  await registerRoutes(app);

  return { app, config };
}

export async function start() {
  await initDb();

  const { app, config } = await buildApp();

  app.listen({ port: config.port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`Session Key Engine running on ${address}`);
  });
}
