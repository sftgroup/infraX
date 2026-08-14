/**
 * RPC-7: WsSubHub 单元测试（node:test + tsx 运行，无需真实 ws 连接）。
 *
 * 覆盖高频事件订阅的核心性能保障：
 *   - 订阅去重：相同 (chain, method, params) 只建一条订阅（isNew 语义）
 *   - 共享广播：一条上游事件扇出到多个客户端
 *   - 引用计数释放：最后一位客户端离开才 releaseUpstream
 *   - 孤儿订阅确认：confirmUpstream 返回 false 供调用方补发取消
 *   - 背压驱逐：慢消费者 close(4004) + 摘除
 *   - 连接配额：WsConnQuota 纯计数
 *
 * 运行：npx tsx --test src/services/wsHub.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WsSubHub, WsConnQuota, WsClient } from './wsHub';

class MockClient implements WsClient {
  id: number;
  bufferedAmount = 0;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  constructor(id: number) {
    this.id = id;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

const NEW_HEADS_EVENT = JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: '0x1', result: { number: '0x10' } } });
const LOGS_EVENT = JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: '0x2', result: { log: {} } } });

test('subKey 确定性：method 与 params 序列化稳定', () => {
  assert.equal(WsSubHub.subKey('newHeads', []), 'newHeads|[]');
  assert.equal(WsSubHub.subKey('logs', [{ address: '0xabc' }]), 'logs|[{"address":"0xabc"}]');
  // 不同 params → 不同 subKey（订阅去重键）
  assert.notEqual(WsSubHub.subKey('logs', [{ address: '0xabc' }]), WsSubHub.subKey('logs', [{ address: '0xdef' }]));
});

test('订阅去重：首客户端 isNew=true，同参数后续客户端 isNew=false', () => {
  const hub = new WsSubHub({ maxBufferBytes: 1024 });
  const a = new MockClient(1);
  const b = new MockClient(2);
  const r1 = hub.subscribe('bsc', a, 'newHeads', []);
  const r2 = hub.subscribe('bsc', b, 'newHeads', []);
  assert.equal(r1.isNew, true);
  assert.equal(r2.isNew, false);
  assert.notEqual(r1.localSubId, r2.localSubId);
  // 不同链 / 不同参数 → 独立订阅
  assert.equal(hub.subscribe('eth', a, 'newHeads', []).isNew, true);
  assert.equal(hub.subscribe('bsc', a, 'logs', [{ address: '0xabc' }]).isNew, true);
  // clients = 各订阅客户端计数总和：bsc-newHeads(a,b)=2 + eth-newHeads(a)=1 + bsc-logs(a)=1
  assert.deepEqual(hub.stats(), { chains: 2, subscriptions: 3, clients: 4 });
});

test('共享广播：同订阅两客户端各收到一次事件（上游只拉一份）', () => {
  const hub = new WsSubHub({ maxBufferBytes: 1024 });
  const a = new MockClient(1);
  const b = new MockClient(2);
  const ra = hub.subscribe('bsc', a, 'newHeads', []);
  hub.subscribe('bsc', b, 'newHeads', []);
  const subKey = WsSubHub.subKey('newHeads', []);
  assert.equal(hub.confirmUpstream('bsc', subKey, '0x1'), true);

  hub.broadcast('bsc', '0x1', NEW_HEADS_EVENT);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
  assert.equal(a.sent[0], NEW_HEADS_EVENT);
  assert.equal(b.sent[0], NEW_HEADS_EVENT);
  // 未匹配 upSubId 的事件不广播（不同订阅互不影响）
  const c = new MockClient(3);
  hub.subscribe('bsc', c, 'logs', [{ address: '0xabc' }]);
  hub.confirmUpstream('bsc', WsSubHub.subKey('logs', [{ address: '0xabc' }]), '0x2');
  hub.broadcast('bsc', '0x2', LOGS_EVENT);
  assert.equal(c.sent.length, 1);
  assert.equal(a.sent.length, 1, 'other subscription must not receive unrelated event');
});

test('非最后客户端取消：不释放上游，其余客户端仍收到事件', () => {
  const hub = new WsSubHub({ maxBufferBytes: 1024 });
  const a = new MockClient(1);
  const b = new MockClient(2);
  const ra = hub.subscribe('bsc', a, 'newHeads', []);
  hub.subscribe('bsc', b, 'newHeads', []);
  hub.confirmUpstream('bsc', WsSubHub.subKey('newHeads', []), '0x1');

  const r = hub.unsubscribe('bsc', a, ra.localSubId);
  assert.deepEqual(r, { ok: true, releaseUpstream: false });
  assert.equal(hub.has('bsc', WsSubHub.subKey('newHeads', [])), true);

  hub.broadcast('bsc', '0x1', NEW_HEADS_EVENT);
  assert.equal(b.sent.length, 1);
  assert.equal(a.sent.length, 0);
});

test('最后客户端取消且已确认：返回 upSubId 供调用方向上游 eth_unsubscribe', () => {
  const hub = new WsSubHub({ maxBufferBytes: 1024 });
  const a = new MockClient(1);
  const ra = hub.subscribe('bsc', a, 'newHeads', []);
  hub.confirmUpstream('bsc', WsSubHub.subKey('newHeads', []), '0x1');

  const r = hub.unsubscribe('bsc', a, ra.localSubId);
  assert.deepEqual(r, { ok: true, releaseUpstream: true, subKey: 'newHeads|[]', upSubId: '0x1' });
  assert.deepEqual(hub.stats(), { chains: 0, subscriptions: 0, clients: 0 });
});

test('取消未确认订阅：不释放上游（孤儿由 confirmUpstream=false 路径兜底）', () => {
  const hub = new WsSubHub({ maxBufferBytes: 1024 });
  const a = new MockClient(1);
  const ra = hub.subscribe('bsc', a, 'newHeads', []);
  const r = hub.unsubscribe('bsc', a, ra.localSubId);
  assert.equal(r.ok, true);
  assert.equal(r.releaseUpstream, false);
  assert.equal(r.upSubId, undefined);
});

test('取消未知 localSubId：ok=false', () => {
  const hub = new WsSubHub({ maxBufferBytes: 1024 });
  const a = new MockClient(1);
  assert.deepEqual(hub.unsubscribe('bsc', a, 999), { ok: false, releaseUpstream: false });
});

test('孤儿订阅：客户端在确认前离开 → confirmUpstream 返回 false（调用方补发取消）', () => {
  const hub = new WsSubHub({ maxBufferBytes: 1024 });
  const a = new MockClient(1);
  hub.subscribe('bsc', a, 'newHeads', []);
  // 上游确认到达前客户端已断开
  hub.removeClient('bsc', a);
  assert.equal(hub.confirmUpstream('bsc', WsSubHub.subKey('newHeads', []), '0x1'), false);
  assert.deepEqual(hub.stats(), { chains: 0, subscriptions: 0, clients: 0 });
});

test('removeClient：释放全部订阅，仅已确认项进入 release 列表（带 upSubId）', () => {
  const hub = new WsSubHub({ maxBufferBytes: 1024 });
  const a = new MockClient(1);
  hub.subscribe('bsc', a, 'newHeads', []);
  const logsKey = WsSubHub.subKey('logs', [{ address: '0xabc' }]);
  hub.subscribe('bsc', a, 'logs', [{ address: '0xabc' }]); // 未确认（upSubId null）
  hub.confirmUpstream('bsc', WsSubHub.subKey('newHeads', []), '0x1');

  const { release } = hub.removeClient('bsc', a);
  assert.deepEqual(release, [{ subKey: 'newHeads|[]', upSubId: '0x1' }]);
  assert.equal(hub.has('bsc', logsKey), false);
  assert.deepEqual(hub.stats(), { chains: 0, subscriptions: 0, clients: 0 });
});

test('removeClient 对无订阅链：空 release', () => {
  const hub = new WsSubHub({ maxBufferBytes: 1024 });
  const a = new MockClient(1);
  assert.deepEqual(hub.removeClient('bsc', a), { release: [] });
});

test('背压：慢消费者 bufferedAmount 超阈值 → close(4004) 并摘除，健康客户端不受影响', () => {
  const hub = new WsSubHub({ maxBufferBytes: 100 });
  const slow = new MockClient(1);
  slow.bufferedAmount = 1000; // 模拟发送缓冲积压
  const ok = new MockClient(2);
  hub.subscribe('bsc', slow, 'newHeads', []);
  hub.subscribe('bsc', ok, 'newHeads', []);
  hub.confirmUpstream('bsc', WsSubHub.subKey('newHeads', []), '0x1');

  hub.broadcast('bsc', '0x1', NEW_HEADS_EVENT);
  assert.deepEqual(slow.closed, { code: 4004, reason: 'slow consumer' });
  assert.equal(slow.sent.length, 0);
  assert.equal(ok.sent.length, 1);
  // 慢消费者被摘除后 hub 只剩健康客户端
  assert.deepEqual(hub.stats(), { chains: 1, subscriptions: 1, clients: 1 });
  // 再次广播：慢消费者不再收到
  hub.broadcast('bsc', '0x1', NEW_HEADS_EVENT);
  assert.equal(ok.sent.length, 2);
});

test('send 抛错：客户端摘除，广播继续', () => {
  const hub = new WsSubHub({ maxBufferBytes: 1024 });
  const bad = new MockClient(1);
  bad.send = () => {
    throw new Error('socket closed');
  };
  const ok = new MockClient(2);
  hub.subscribe('bsc', bad, 'newHeads', []);
  hub.subscribe('bsc', ok, 'newHeads', []);
  hub.confirmUpstream('bsc', WsSubHub.subKey('newHeads', []), '0x1');

  hub.broadcast('bsc', '0x1', NEW_HEADS_EVENT);
  assert.equal(ok.sent.length, 1);
  assert.deepEqual(hub.stats(), { chains: 1, subscriptions: 1, clients: 1 });
});

test('WsConnQuota：按套餐并发上限控制，超限拒绝且计数不变，release 释放', () => {
  const q = new WsConnQuota();
  assert.equal(q.tryAcquire(1, 10), true);
  for (let i = 0; i < 9; i++) assert.equal(q.tryAcquire(1, 10), true);
  assert.equal(q.current(1), 10);
  assert.equal(q.tryAcquire(1, 10), false, '第 11 个连接超限');
  assert.equal(q.current(1), 10, '超限不改变计数');

  q.release(1);
  assert.equal(q.current(1), 9);
  assert.equal(q.tryAcquire(1, 10), true);
  // 归零后条目移除
  for (let i = 0; i < 10; i++) q.release(1);
  assert.equal(q.current(1), 0);
  // 不同 key 独立计数
  assert.equal(q.tryAcquire(2, 3), true);
  assert.equal(q.tryAcquire(2, 3), true);
  assert.equal(q.tryAcquire(2, 3), true);
  assert.equal(q.tryAcquire(2, 3), false);
});
