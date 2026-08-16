/**
 * RPC-7: WebSocket 订阅面（/v1/ws）。
 *
 * 相对 DC-5 纯透传代理的升级：
 *   1. 鉴权分级与 HTTP 读端点一致：本地 bridge key / rx_ 订阅 key（rpc_keys 表）/ 外部 data key（scope=rpc 实时校验）
 *   2. 每链共享一条上游 WS 连接（refcount），订阅经 WsSubHub 去重——高频事件 N 客户端只拉一份上游
 *   3. 背压：慢消费者（send 缓冲超阈值）驱逐 close(4004)，防高频事件内存放大
 *   4. 配额：rx_ key 连接数按套餐 concurrent 限制（超限 close 4005）+ 每次订阅计入 rpc_usage
 *   5. 每客户端订阅数上限（WS_MAX_SUBS_PER_CLIENT，防单连接刷海量订阅）
 *
 * 订阅 id 语义：客户端只见网关签发的本地 subId（单调递增）；上游 subId 仅内部路由用。
 */
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config';
import { logger } from '../logger';
import { RpcPoolManager } from '../services/rpcPool';
import { normalizeChain } from '../services/rpcPoolConfig';
import { findRpcKeyByRaw, RPC_PLANS, RPC_FREE_PLAN_ID, planById, recordRpcUsage } from '../services/rpcSubscription';
import { matchExternal } from '../middleware/auth';
import { timingSafeEqualStr } from '../utils/timingSafe';
import { WsSubHub, WsClient, WsConnQuota } from '../services/wsHub';
import { WsUpstreamManager } from '../services/wsUpstream';

const SUB_METHODS = new Set(['eth_subscribe', 'eth_unsubscribe']);
const ALLOWED_SUB_TYPES = new Set(['newHeads', 'newPendingTransactions', 'logs', 'syncing']);

type Auth =
  | { type: 'local' }
  | { type: 'rx'; keyId: number; planId: string }
  | { type: 'external' };

// ── 模块级状态（单进程） ────────────────────────────────
const hub = new WsSubHub({ maxBufferBytes: config.wsMaxBufferBytes });
const quota = new WsConnQuota(); // rx_ key 并发连接计数（配额）
const chainClients = new Map<string, Set<number>>(); // chain → 连接的 clientId
const clientChains = new Map<number, Set<string>>(); // clientId → 所在 chains
const clientSubCount = new Map<number, number>(); // clientId → 订阅数
const clientSessions = new Map<number, { ws: WebSocket; auth: Auth }>(); // clientId → 会话（上游断开时兜底关闭）
let clientSeq = 1;

// ── 鉴权（与 HTTP 读端点一致） ──────────────────────────
async function resolveAuth(key: string): Promise<Auth | null> {
  if (key && config.readKey && timingSafeEqualStr(key, config.readKey)) return { type: 'local' };
  if (key && config.broadcastKey && timingSafeEqualStr(key, config.broadcastKey)) return { type: 'local' };
  // rx_/bx_ 订阅 key（与 HTTP 读端点一致：仅要求 enabled，free→active 状态机由支付引擎推进）
  if (key.startsWith('rx_') || key.startsWith('bx_')) {
    const rk = await findRpcKeyByRaw(key);
    if (rk && rk.enabled !== false) {
      return { type: 'rx', keyId: rk.id, planId: rk.rpc_plan_id || RPC_FREE_PLAN_ID };
    }
    return null;
  }
  if (key && config.enableExternalVerify && (await matchExternal(key, 'rpc'))) return { type: 'external' };
  return null;
}

// ── 配额 ────────────────────────────────────────────────
// 导出供单元测试直接校验（纯计数逻辑，见 wsHub.WsConnQuota）
export function tryAcquireConn(auth: Auth): { ok: true } | { ok: false; limit: number } {
  if (!config.wsEnableQuota || auth.type !== 'rx') return { ok: true };
  const plan = planById(auth.planId) || RPC_PLANS[0];
  const limit = plan.features.concurrent;
  return quota.tryAcquire(auth.keyId, limit) ? { ok: true } : { ok: false, limit };
}

export function releaseConn(auth: Auth): void {
  if (auth.type !== 'rx') return;
  quota.release(auth.keyId);
}

// ── 上游断开兜底（WsUpstreamManager 已清理条目，此处仅关闭该链客户端） ──
function closeChainClients(chain: string): void {
  const ids = chainClients.get(chain);
  if (ids) {
    for (const cid of [...ids]) {
      const session = clientSessions.get(cid);
      if (session) {
        try {
          session.ws.close(4006, 'upstream closed');
        } catch {
          /* noop */
        }
      }
    }
  }
}

export function attachWs(server: http.Server, pool: RpcPoolManager): void {
  const wss = new WebSocketServer({ server, path: '/v1/ws' });
  // 每网关独立上游管理器（测试可挂多个网关，各持各自的池）
  const upstream = new WsUpstreamManager(
    pool,
    (chain, raw) => handleUpstreamMessage(upstream, chain, raw),
    (chain) => closeChainClients(chain),
  );

  wss.on('connection', async (ws, req) => {
    const q = new URL(req.url || '/', 'http://internal').searchParams;
    const key = (req.headers['x-service-key'] || req.headers['x-api-key'] || q.get('key') || '').toString();

    // ── 鉴权 ──
    let auth = await resolveAuth(key);
    if (!auth) {
      if (config.readKey) {
        ws.close(4001, 'unauthorized');
        return;
      }
      auth = { type: 'local' }; // OPEN（未配置读 key，与 HTTP 端点一致）
    }

    // ── 配额（rx_ key 连接数） ──
    const qr = tryAcquireConn(auth);
    if (!qr.ok) {
      ws.close(4005, `quota exceeded (limit ${qr.limit})`);
      return;
    }

    // ── 链校验 + 共享上游 ──
    const chain = q.get('chain') || config.defaultChain;
    const norm = normalizeChain(chain);
    if (!norm) {
      releaseConn(auth);
      ws.close(4002, `unsupported chain: ${chain}`);
      return;
    }
    const cu = upstream.acquire(norm);
    if (!cu) {
      releaseConn(auth);
      ws.close(4003, 'upstream unavailable');
      return;
    }

    // ── 客户端注册 ──
    const clientId = clientSeq++;
    const wsClient: WsClient = {
      id: clientId,
      send: (d) => ws.send(d),
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      close: (c, r) => ws.close(c, r),
    };
    if (!chainClients.has(norm)) chainClients.set(norm, new Set());
    chainClients.get(norm)!.add(clientId);
    if (!clientChains.has(clientId)) clientChains.set(clientId, new Set());
    clientChains.get(clientId)!.add(norm);
    clientSessions.set(clientId, { ws, auth });

    // ── 客户端消息 ──
    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
        return;
      }
      const method = msg?.method;
      if (!SUB_METHODS.has(method)) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg?.id ?? null,
          error: { code: -32601, message: 'method not allowed on ws (only eth_subscribe/eth_unsubscribe)' },
        }));
        return;
      }
      if (method === 'eth_subscribe') handleSubscribe(upstream, norm, clientId, ws, wsClient, auth, msg);
      else handleUnsubscribe(upstream, norm, clientId, ws, wsClient, msg);
    });

    // ── 客户端断开 ──
    ws.on('close', () => {
      clientSessions.delete(clientId);
      const cchains = clientChains.get(clientId) || new Set();
      for (const c of cchains) {
        const { release } = hub.removeClient(c, wsClient);
        for (const r of release) {
          // 该订阅最后一位客户端离开 → 向上游补发 eth_unsubscribe（带确认后的上游订阅 id）
          upstream.send(c, JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_unsubscribe', params: [r.upSubId] }));
        }
        upstream.release(c);
      }
      clientChains.delete(clientId);
      clientSubCount.delete(clientId);
      for (const ids of chainClients.values()) ids.delete(clientId);
      releaseConn(auth);
    });
    ws.on('error', () => ws.close());
  });

  logger.info('[chain-rpc] ws endpoint /v1/ws ready (RPC-7)');
}

// ── 订阅处理 ────────────────────────────────────────────
function handleSubscribe(
  upstream: WsUpstreamManager,
  chain: string,
  clientId: number,
  ws: WebSocket,
  wsClient: WsClient,
  auth: Auth,
  msg: any
): void {
  const id = msg?.id ?? null;
  const params = Array.isArray(msg?.params) ? msg.params : [];
  const subType = params[0];
  if (typeof subType !== 'string' || !ALLOWED_SUB_TYPES.has(subType)) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: `unsupported subscription: ${subType}` } }));
    return;
  }
  if ((clientSubCount.get(clientId) || 0) >= config.wsMaxSubsPerClient) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'too many subscriptions' } }));
    return;
  }
  if (auth.type === 'rx') recordRpcUsage(auth.keyId, '/v1/ws');

  const { localSubId, isNew } = hub.subscribe(chain, wsClient, subType, params.slice(1));
  clientSubCount.set(clientId, (clientSubCount.get(clientId) || 0) + 1);
  // 立即回本地 subId（客户端只见网关 id）
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: localSubId }));

  if (isNew) {
    const cu = upstream.get(chain);
    if (!cu) return;
    const upReqId = cu.upSeq++;
    cu.pendingUp.set(upReqId, { chain, subKey: WsSubHub.subKey(subType, params.slice(1)) });
    upstream.send(chain, JSON.stringify({ jsonrpc: '2.0', id: upReqId, method: 'eth_subscribe', params }));
  }
}

function handleUnsubscribe(upstream: WsUpstreamManager, chain: string, clientId: number, ws: WebSocket, wsClient: WsClient, msg: any): void {
  const id = msg?.id ?? null;
  const subId = Number(msg?.params?.[0]);
  const { ok, releaseUpstream: needRelease, upSubId } = hub.unsubscribe(chain, wsClient, subId);
  if (ok) clientSubCount.set(clientId, Math.max(0, (clientSubCount.get(clientId) || 0) - 1));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: ok }));
  if (needRelease && upSubId) {
    upstream.send(chain, JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_unsubscribe', params: [upSubId] }));
  }
}

// ── 上游消息 ────────────────────────────────────────────
function handleUpstreamMessage(upstream: WsUpstreamManager, chain: string, raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  // 订阅确认（响应 eth_subscribe）
  if (msg.id !== undefined && !msg.error) {
    const cu = upstream.get(chain);
    const upReq = cu?.pendingUp.get(msg.id);
    if (upReq) {
      cu!.pendingUp.delete(msg.id);
      if (typeof msg.result === 'string') {
        const exists = hub.confirmUpstream(chain, upReq.subKey, msg.result);
        if (!exists) {
          // 孤儿订阅（客户端在确认前全部离开）→ 补发取消，防上游泄漏
          upstream.send(chain, JSON.stringify({ jsonrpc: '2.0', id: cu!.upSeq++, method: 'eth_unsubscribe', params: [msg.result] }));
        }
      }
    }
    return;
  }
  // 上游拒绝订阅（error 响应）→ 仅清理 pendingUp 防堆积（客户端侧已按网关 subId 持有，由显式取消兜底）
  if (msg.id !== undefined && msg.error) {
    const cu = upstream.get(chain);
    if (cu?.pendingUp.delete(msg.id)) {
      logger.warn(`[chain-rpc] ws upstream subscribe rejected (${chain}): ${msg.error?.message || JSON.stringify(msg.error)}`);
    }
    return;
  }
  // 订阅事件（高频消息只拉一份，网关内广播）
  if (msg.method === 'eth_subscription' && msg.params?.subscription) {
    hub.broadcast(chain, String(msg.params.subscription), raw);
  }
}
