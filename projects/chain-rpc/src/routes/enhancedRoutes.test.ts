/**
 * chain-rpc 增强路由单测（node:test + tsx，无需 DB / 真实 DC）。
 *
 * 覆盖：
 *   - 无读 key → 401
 *   - 读 key + query 白名单透传 → 200（未知 query 被丢弃）
 *   - 上游 x-dc-api-key 注入正确
 *   - 上游 5xx → 状态码透传
 *   - 未匹配子路径 → 404
 *
 * 运行：npx tsx --test src/routes/enhancedRoutes.test.ts
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ── 必须在加载 config 之前设置 env（config 为模块级单例，动态 import 保证时序） ──
process.env.DC_ENHANCED_URL = 'http://127.0.0.1:19199';
process.env.DC_ENHANCED_API_KEY = 'test-dc-key';
process.env.CHAIN_RPC_READ_KEY = 'test-read-key';
process.env.CHAIN_RPC_BROADCAST_KEY = 'test-broadcast-key';

let server: http.Server;
let upstream: http.Server;
let base: string;
let seen: { apiKey: string | undefined; url: string | undefined } = { apiKey: undefined, url: undefined };

before(async () => {
  const { default: express } = await import('express');
  const { createReadAuth } = await import('../middleware/auth');
  const { createEnhancedRouter } = await import('./enhancedRoutes');

  // mock DC 上游：校验 x-dc-api-key，回显收到的 query，event-stats 返回 500
  upstream = http.createServer((req, res) => {
    seen = { apiKey: req.headers['x-dc-api-key'] as string, url: req.url };
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-dc-api-key'] !== 'test-dc-key') {
      res.writeHead(401);
      res.end(JSON.stringify({ code: 1003, message: 'bad key' }));
      return;
    }
    if (req.url?.startsWith('/api/v2/data/event-stats')) {
      res.writeHead(500);
      res.end(JSON.stringify({ code: 500, message: 'boom' }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ code: 0, message: 'ok', data: { events: [], next_page_token: null } }));
  });
  await new Promise<void>((r) => upstream.listen(19199, '127.0.0.1', r));

  const app = express();
  app.use('/v1/enhanced', createReadAuth(), createEnhancedRouter());
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (upstream) await new Promise<void>((r) => upstream.close(() => r()));
});

const get = (p: string, key?: string) =>
  fetch(base + p, key ? { headers: { 'x-api-key': key } } : undefined);

test('无读 key → 401', async () => {
  const r = await get('/v1/enhanced/events');
  assert.equal(r.status, 401);
});

test('读 key + events → 200，query 白名单透传且未知参数被丢弃', async () => {
  const r = await get('/v1/enhanced/events?chain=sepolia&event_type=Transfer&page_size=5&evil=1', 'test-read-key');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.code, 0);
  // 上游收到 x-dc-api-key
  assert.equal(seen.apiKey, 'test-dc-key');
  // 白名单 query 原样透传，evil 被丢弃
  assert.ok(seen.url?.includes('chain=sepolia'));
  assert.ok(seen.url?.includes('event_type=Transfer'));
  assert.ok(seen.url?.includes('page_size=5'));
  assert.ok(!seen.url?.includes('evil'));
});

test('读 key + event-categories → 200', async () => {
  const r = await get('/v1/enhanced/event-categories', 'test-read-key');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).code, 0);
});

test('上游 5xx → 状态码透传（不吞）', async () => {
  const r = await get('/v1/enhanced/event-stats', 'test-read-key');
  assert.equal(r.status, 500);
  assert.equal((await r.json()).code, 500);
});

test('未匹配子路径 → 404', async () => {
  const r = await get('/v1/enhanced/nope', 'test-read-key');
  assert.equal(r.status, 404);
});
