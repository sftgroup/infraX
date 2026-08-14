/**
 * RPC-7: /v1/ws 网关集成测试（node:test + tsx 运行）。
 *
 * 以真实 ws 客户端连网关、真实 ws 服务端做 mock 上游：
 *   - 鉴权：无 key 连接 → close 4001
 *   - 非法订阅类型 → -32602
 *   - 订阅去重：N 客户端只向上游发一条 eth_subscribe，事件扇出 N 份
 *   - 断开/取消：最后一位客户端离开 → 上游收到 eth_unsubscribe
 *   - 每客户端订阅数上限 → -32602 too many subscriptions
 *   - 不支持的链 → close 4002；上游不可用 → close 4003
 *   - 路由级配额 tryAcquireConn/releaseConn（free 套餐并发 10）
 *
 * 注意：环境变量须在动态 import ../routes/ws 之前设置（config 在模块加载时读取）。
 * 运行：npx tsx --test src/services/ws.e2e.test.ts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

// ── 环境（先于动态 import 生效；dotenv 不覆盖已存在变量） ──
process.env.CHAIN_RPC_READ_KEY = 'test-read-key';
process.env.CHAIN_RPC_BROADCAST_KEY = 'test-broadcast-key';
process.env.CHAIN_RPC_ENABLE_EXTERNAL_VERIFY = 'false';
process.env.DATA_SERVICE_URL = '';
process.env.WS_ENABLE_QUOTA = 'true';
process.env.WS_MAX_SUBS_PER_CLIENT = '2';

let attachWs: typeof import('../routes/ws').attachWs;
let tryAcquireConn: typeof import('../routes/ws').tryAcquireConn;
let releaseConn: typeof import('../routes/ws').releaseConn;

// ── mock 上游（真实 ws 服务端） ──────────────────────────
let upServer: WebSocketServer;
let upConn: WebSocket | null = null;
let subCount = 0;
let unsubCount = 0;
const upSubIds: string[] = [];

async function startUpstream(): Promise<number> {
  upServer = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => upServer.once('listening', () => r()));
  upServer.on('connection', (ws) => {
    upConn = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'eth_subscribe') {
        subCount += 1;
        const subId = `0xsub${subCount}`;
        upSubIds.push(subId);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: subId }));
      } else if (msg.method === 'eth_unsubscribe') {
        unsubCount += 1;
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: true }));
      }
    });
  });
  return (upServer.address() as any).port;
}

// ── 网关（真实 http + ws 服务端） ────────────────────────
let appServer: http.Server;
let appPort = 0;
let appServer2: http.Server;
let appPort2 = 0;
let wsBase = '';

before(async () => {
  const upPort = await startUpstream();
  const mod = await import('../routes/ws');
  attachWs = mod.attachWs;
  tryAcquireConn = mod.tryAcquireConn;
  releaseConn = mod.releaseConn;

  appServer = http.createServer();
  attachWs(appServer, { getWsEndpoint: () => `ws://127.0.0.1:${upPort}` } as any);
  await new Promise<void>((r) => appServer.listen(0, () => r()));
  appPort = (appServer.address() as any).port;
  wsBase = `ws://127.0.0.1:${appPort}/v1/ws`;

  // 上游不可用场景：独立网关 + 独立链（模块共享 chains 映射，用 sepolia 隔离）
  appServer2 = http.createServer();
  attachWs(appServer2, { getWsEndpoint: () => null } as any);
  await new Promise<void>((r) => appServer2.listen(0, () => r()));
  appPort2 = (appServer2.address() as any).port;
});

after(async () => {
  upServer?.close();
  appServer?.close();
  appServer2?.close();
});

// ── 工具 ─────────────────────────────────────────────────
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 3000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting: ${label}`);
    await delay(10);
  }
}

function connect(opts: { key?: string; chain?: string; port?: number } = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams();
    if (opts.chain) qs.set('chain', opts.chain);
    if (opts.key) qs.set('key', opts.key);
    const base = opts.port ? `ws://127.0.0.1:${opts.port}/v1/ws` : wsBase;
    const ws = new WebSocket(`${base}?${qs}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', (e) => reject(e));
  });
}

function connectExpectClose(opts: { key?: string; chain?: string; port?: number; code: number }): Promise<number> {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams();
    if (opts.chain) qs.set('chain', opts.chain);
    if (opts.key) qs.set('key', opts.key);
    const base = opts.port ? `ws://127.0.0.1:${opts.port}/v1/ws` : wsBase;
    const ws = new WebSocket(`${base}?${qs}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timeout waiting close (expected ${opts.code})`));
    }, 3000);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.on('error', () => {
      /* 服务端握手期关闭会触发 error，close 随后到达 */
    });
  });
}

function waitMsg(ws: WebSocket, pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', on);
      reject(new Error('timeout waiting msg'));
    }, timeoutMs);
    const on = (data: any) => {
      const m = JSON.parse(data.toString());
      if (pred(m)) {
        clearTimeout(timer);
        ws.off('message', on);
        resolve(m);
      }
    };
    ws.on('message', on);
  });
}

function sendReq(ws: WebSocket, id: number, method: string, params: unknown[]): void {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
}

const KEY = 'test-read-key';

test('无 key 连接被拒（close 4001）', async () => {
  const code = await connectExpectClose({ chain: 'bsc', code: 4001 });
  assert.equal(code, 4001);
});

test('非法订阅类型 → -32602', async () => {
  const ws = await connect({ key: KEY, chain: 'bsc' });
  sendReq(ws, 1, 'eth_subscribe', ['notAType']);
  const res = await waitMsg(ws, (m) => m.id === 1);
  assert.equal(res.error?.code, -32602);
  assert.match(String(res.error?.message), /unsupported subscription/);
  ws.close();
  await delay(30);
});

test('订阅去重 E2E：两客户端一条上游订阅，事件扇出两份', async () => {
  const a = await connect({ key: KEY, chain: 'base' });
  const b = await connect({ key: KEY, chain: 'base' });
  sendReq(a, 1, 'eth_subscribe', ['newHeads']);
  sendReq(b, 2, 'eth_subscribe', ['newHeads']);

  const ra = await waitMsg(a, (m) => m.id === 1);
  const rb = await waitMsg(b, (m) => m.id === 2);
  assert.equal(typeof ra.result, 'number', '网关签发本地 subId');
  assert.equal(typeof rb.result, 'number');
  assert.notEqual(ra.result, rb.result, '本地 subId 单调递增且互异');

  // 去重：两客户端只向上游发了一条 eth_subscribe
  await waitFor(() => subCount === 1, 3000, '上游收到 1 条 eth_subscribe');
  assert.equal(subCount, 1);
  await delay(50); // 等网关回填 upSubId（confirm）

  // 上游推一条新块事件 → 两个客户端各收一份
  upConn?.send(
    JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: upSubIds[0], result: { number: '0x1' } } })
  );
  const [ea, eb] = await Promise.all([
    waitMsg(a, (m) => m.method === 'eth_subscription'),
    waitMsg(b, (m) => m.method === 'eth_subscription'),
  ]);
  assert.equal(ea.params.result.number, '0x1');
  assert.equal(eb.params.result.number, '0x1');
  assert.equal(subCount, 1, '订阅后仍只有一条上游订阅');

  // B 取消（非最后客户端）→ 上游不释放；A 取消（最后）→ 上游收到 eth_unsubscribe
  sendReq(b, 3, 'eth_unsubscribe', [rb.result]);
  const ubr = await waitMsg(b, (m) => m.id === 3);
  assert.equal(ubr.result, true);
  await delay(30);
  assert.equal(unsubCount, 0, 'B 取消时 A 仍在订阅，不释放上游');

  sendReq(a, 4, 'eth_unsubscribe', [ra.result]);
  await waitMsg(a, (m) => m.id === 4);
  await waitFor(() => unsubCount === 1, 3000, '上游收到 eth_unsubscribe');
  assert.equal(unsubCount, 1);

  a.close();
  b.close();
  await delay(30);
});

test('客户端断开（非取消）→ 上游收到 eth_unsubscribe', async () => {
  const ws = await connect({ key: KEY, chain: 'eth' });
  sendReq(ws, 1, 'eth_subscribe', ['logs', { address: '0xabc' }]);
  await waitMsg(ws, (m) => m.id === 1);
  await waitFor(() => subCount === 2, 3000, '上游收到 logs 订阅'); // 上一条为 newHeads
  await delay(50); // 等 confirm 回填

  ws.terminate(); // 模拟客户端异常断开
  await waitFor(() => unsubCount === 2, 3000, '断开后上游收到 eth_unsubscribe');
  assert.equal(unsubCount, 2);
  await delay(30);
});

test('每客户端订阅数上限 → -32602 too many subscriptions', async () => {
  const ws = await connect({ key: KEY, chain: 'bsc' });
  sendReq(ws, 1, 'eth_subscribe', ['newHeads']);
  await waitMsg(ws, (m) => m.id === 1);
  sendReq(ws, 2, 'eth_subscribe', ['syncing']);
  await waitMsg(ws, (m) => m.id === 2);
  sendReq(ws, 3, 'eth_subscribe', ['newPendingTransactions']);
  const res = await waitMsg(ws, (m) => m.id === 3);
  assert.equal(res.error?.code, -32602);
  assert.match(String(res.error?.message), /too many subscriptions/);
  ws.close();
  await delay(30);
});

test('不支持的链 → close 4002', async () => {
  const code = await connectExpectClose({ key: KEY, chain: 'notachain', code: 4002 });
  assert.equal(code, 4002);
});

test('上游不可用 → close 4003', async () => {
  const code = await connectExpectClose({ key: KEY, chain: 'sepolia', port: appPort2, code: 4003 });
  assert.equal(code, 4003);
});

test('路由级配额：free 套餐并发 10，第 11 个连接被拒，release 释放后可再进', async () => {
  const free: any = { type: 'rx', keyId: 1001, planId: 'rpc_free' };
  const local: any = { type: 'local' };
  assert.deepEqual(tryAcquireConn(local), { ok: true }, '本地 bridge key 豁免配额');

  for (let i = 0; i < 10; i++) {
    assert.deepEqual(tryAcquireConn(free), { ok: true }, `第 ${i + 1} 个连接应成功`);
  }
  assert.deepEqual(tryAcquireConn(free), { ok: false, limit: 10 }, '第 11 个连接超限');

  releaseConn(free);
  assert.deepEqual(tryAcquireConn(free), { ok: true }, '释放后恢复');
  releaseConn(free);
  releaseConn(local); // 本地 key release 为 no-op，不应报错
  for (let i = 0; i < 10; i++) releaseConn(free); // 归零
});
