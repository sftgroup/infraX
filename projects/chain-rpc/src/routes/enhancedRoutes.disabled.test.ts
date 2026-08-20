/**
 * chain-rpc 增强路由（未启用态）单测：未配置 DC_ENHANCED_URL → 503。
 *
 * 运行：npx tsx --test src/routes/enhancedRoutes.disabled.test.ts
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

let server: http.Server;
let base: string;

before(async () => {
  const { default: express } = await import('express');
  const { createEnhancedRouter } = await import('./enhancedRoutes');

  const app = express();
  app.use('/v1/enhanced', createEnhancedRouter());
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

test('未配置 DC_ENHANCED_URL → 503 能力未启用', async () => {
  const r = await fetch(`${base}/v1/enhanced/events`);
  assert.equal(r.status, 503);
  const j: any = await r.json();
  assert.equal(j.detail, 'enhanced data not configured');
});
