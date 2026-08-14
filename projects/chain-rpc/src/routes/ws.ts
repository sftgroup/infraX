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
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config';
import { logger } from '../logger';
import { RpcPoolManager } from '../services/rpcPool';
import { normalizeChain } from '../services/rpcPoolConfig';
import { findRpcKeyByRaw, rpcPool, RPC_PLANS } from '../services/rpcSubscription';
import { matchExternal } from '../middleware/auth';
import { WsSubHub, WsClient, WsConnQuota } from '../services/wsHub';

const SUB_METHODS = new Set(['eth_subscribe', 'eth_unsubscribe']);
const ALLOWED_SUB_TYPES = new Set(['newHeads', 'newPendingTransactions', 'logs', 'syncing']);
// 上游连接未就绪期间的订阅请求缓冲上限（防无界堆积）
const WS_PENDING_CAP = 200;

function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

type Auth =
  | { type: 'local' }
  | { type: 'rx'; keyId: number; planId: string }
  | { type: 'external' };

interface ChainUpstream {
  up: WebSocket;
  refs: number;
  open: boolean;
  pending: string[]; // 未就绪缓冲的订阅请求
  pendingUp: Map<number, { chain: string; subKey: string }>; // 上游请求 id → 订阅（confirm 路由）
  upSeq: number;
}

// ── 模块级状态（单进程） ────────────────────────────────
const hub = new WsSubHub({ maxBufferBytes: config.wsMaxBufferBytes });
const quota = new WsConnQuota(); // rx_ key 并发连接计数（配额）
const chains = new Map<string, ChainUpstream>(); // chain → 共享上游
const chainClients = new Map<string, Set<number>>(); // chain → 连接的 clientId
const clientChains = new Map<number, Set<string>>(); // clientId → 所在 chains
const clientSubCount = new Map<number, number>(); // clientId → 订阅数
const clientSessions = new Map<number, { ws: WebSocket; auth: Auth }>(); // clientId → 会话（上游断开时兜底关闭）
let clientSeq = 1;

// ── 鉴权（与 HTTP 读端点一致） ──────────────────────────
async function resolveAuth(key: string): Promise<Auth | null> {
  if (key && config.readKey && timingSafeEqualStr(key, config.readKey)) return { type: 'local' };
  if (key && config.broadcastKey && timingSafeEqualStr(key, config.broadcastKey)) return { type: 'local' };
  if (key.startsWith('rx_')) {
    const rk = await findRpcKeyByRaw(key);
    // 与 HTTP 读端点一致：仅要求 enabled（free→active 状态机由支付引擎推进）
    if (rk && rk.enabled !== false) {
      return { type: 'rx', keyId: rk.id, planId: rk.rpc_plan_id || 'rpc_free' };
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
  const plan = RPC_PLANS.find((p) => p.id === auth.planId) || RPC_PLANS[0];
  const limit = plan.features.concurrent || 10;
  return quota.tryAcquire(auth.keyId, limit) ? { ok: true } : { ok: false, limit };
}

export function releaseConn(auth: Auth): void {
  if (auth.type !== 'rx') return;
  quota.release(auth.keyId);
}

// 订阅计费（fire-and-forget，失败仅 warn，与 HTTP 读配额一致）
function recordUsage(keyId: number): void {
  rpcPool
    .query('INSERT INTO rpc_usage (key_id, endpoint) VALUES ($1, $2)', [keyId, '/v1/ws'])
    .then(() =>
      rpcPool.query(
        `INSERT INTO rpc_usage_daily (key_id, date, endpoint, total_calls)
         VALUES ($1, CURRENT_DATE, $2, 1)
         ON CONFLICT (key_id, date, endpoint)
         DO UPDATE SET total_calls = rpc_usage_daily.total_calls + 1`,
        [keyId, '/v1/ws']
      )
    )
    .catch((e: any) => logger.warn(`[chain-rpc] ws usage record failed: ${e.message}`));
}

// ── 上游连接管理（每链共享） ────────────────────────────
function sendUpstream(chain: string, data: string): boolean {
  const cu = chains.get(chain);
  if (!cu) return false;
  if (!cu.open) {
    if (cu.pending.length >= WS_PENDING_CAP) return false;
    cu.pending.push(data);
    return true;
  }
  cu.up.send(data);
  return true;
}

function releaseUpstream(chain: string): void {
  const cu = chains.get(chain);
  if (!cu) return;
  cu.refs -= 1;
  if (cu.refs <= 0) {
    try {
      cu.up.close();
    } catch {
      /* noop */
    }
    chains.delete(chain);
  }
}

/**
 * 上游连接断开/出错：兜底关闭该链全部客户端（4006），并清除失效上游条目，
 * 保证下一个客户端连接时重建共享上游。客户端状态清理由其 close 事件处理器完成。
 */
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
  const cu = chains.get(chain);
  if (cu) {
    try {
      cu.up.close();
    } catch {
      /* noop */
    }
    chains.delete(chain);
  }
}

export function attachWs(server: http.Server, pool: RpcPoolManager): void {
  const wss = new WebSocketServer({ server, path: '/v1/ws' });

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
    const chain = q.get('chain') || 'sepolia';
    const norm = normalizeChain(chain);
    if (!norm) {
      releaseConn(auth);
      ws.close(4002, `unsupported chain: ${chain}`);
      return;
    }
    const upUrl = pool.getWsEndpoint(norm);
    if (!upUrl) {
      releaseConn(auth);
      ws.close(4003, `no active endpoint for ${norm}`);
      return;
    }

    let cu = chains.get(norm);
    if (!cu) {
      cu = { up: null as unknown as WebSocket, refs: 0, open: false, pending: [], pendingUp: new Map(), upSeq: 1 };
      try {
        const up = new WebSocket(upUrl);
        cu.up = up;
        up.on('open', () => {
          cu!.open = true;
          while (cu!.pending.length) {
            const m = cu!.pending.shift();
            if (m) cu!.up.send(m);
          }
          logger.info('[chain-rpc] ws upstream connected', { chain: norm });
        });
        up.on('message', (data) => handleUpstreamMessage(norm, data.toString()));
        up.on('error', () => closeChainClients(norm));
        up.on('close', () => closeChainClients(norm));
        chains.set(norm, cu);
      } catch (e: any) {
        logger.warn(`[chain-rpc] ws upstream create failed (${norm}): ${e?.message}`);
        releaseConn(auth);
        ws.close(4003, 'upstream unavailable');
        return;
      }
    }
    cu.refs += 1;

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
      if (method === 'eth_subscribe') handleSubscribe(norm, clientId, ws, wsClient, auth, msg);
      else handleUnsubscribe(norm, clientId, ws, wsClient, msg);
    });

    // ── 客户端断开 ──
    ws.on('close', () => {
      clientSessions.delete(clientId);
      const cchains = clientChains.get(clientId) || new Set();
      for (const c of cchains) {
        const { release } = hub.removeClient(c, wsClient);
        for (const r of release) {
          // 该订阅最后一位客户端离开 → 向上游补发 eth_unsubscribe（带确认后的上游订阅 id）
          sendUpstream(c, JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_unsubscribe', params: [r.upSubId] }));
        }
        releaseUpstream(c);
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
  if (auth.type === 'rx') recordUsage(auth.keyId);

  const { localSubId, isNew } = hub.subscribe(chain, wsClient, subType, params.slice(1));
  clientSubCount.set(clientId, (clientSubCount.get(clientId) || 0) + 1);
  // 立即回本地 subId（客户端只见网关 id）
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: localSubId }));

  if (isNew) {
    const cu = chains.get(chain);
    if (!cu) return;
    const upReqId = cu.upSeq++;
    cu.pendingUp.set(upReqId, { chain, subKey: WsSubHub.subKey(subType, params.slice(1)) });
    sendUpstream(chain, JSON.stringify({ jsonrpc: '2.0', id: upReqId, method: 'eth_subscribe', params }));
  }
}

function handleUnsubscribe(chain: string, clientId: number, ws: WebSocket, wsClient: WsClient, msg: any): void {
  const id = msg?.id ?? null;
  const subId = Number(msg?.params?.[0]);
  const { ok, releaseUpstream: needRelease, upSubId } = hub.unsubscribe(chain, wsClient, subId);
  if (ok) clientSubCount.set(clientId, Math.max(0, (clientSubCount.get(clientId) || 0) - 1));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: ok }));
  if (needRelease && upSubId) {
    sendUpstream(chain, JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_unsubscribe', params: [upSubId] }));
  }
}

// ── 上游消息 ────────────────────────────────────────────
function handleUpstreamMessage(chain: string, raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  // 订阅确认（响应 eth_subscribe）
  if (msg.id !== undefined && !msg.error) {
    const cu = chains.get(chain);
    const upReq = cu?.pendingUp.get(msg.id);
    if (upReq) {
      cu!.pendingUp.delete(msg.id);
      if (typeof msg.result === 'string') {
        const exists = hub.confirmUpstream(chain, upReq.subKey, msg.result);
        if (!exists) {
          // 孤儿订阅（客户端在确认前全部离开）→ 补发取消，防上游泄漏
          sendUpstream(chain, JSON.stringify({ jsonrpc: '2.0', id: cu!.upSeq++, method: 'eth_unsubscribe', params: [msg.result] }));
        }
      }
    }
    return;
  }
  // 上游拒绝订阅（error 响应）→ 仅清理 pendingUp 防堆积（客户端侧已按网关 subId 持有，由显式取消兜底）
  if (msg.id !== undefined && msg.error) {
    const cu = chains.get(chain);
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
