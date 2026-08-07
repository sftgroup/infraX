/**
 * DC-5: WebSocket 订阅代理（/v1/ws）。
 *
 * 每个客户端连接建立一个到上游节点的 WS 连接，仅透传 eth_subscribe /
 * eth_unsubscribe（读类订阅，与读 key 同权限）。消息双向转发，客户端断开
 * 即关闭上游连接。鉴权：X-Service-Key / X-API-Key header 或 ?key= query
 * （与 HTTP 读端点一致，CHAIN_RPC_READ_KEY）。
 */
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config';
import { logger } from '../logger';
import { RpcPoolManager } from '../services/rpcPool';
import { normalizeChain } from '../services/rpcPoolConfig';

const SUB_METHODS = new Set(['eth_subscribe', 'eth_unsubscribe']);

function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function authorized(wsUrl: string, headers: http.IncomingHttpHeaders): boolean {
  if (!config.readKey) return true; // OPEN（与 HTTP 端点一致）
  const q = new URL(wsUrl, 'http://internal').searchParams;
  const candidates = [
    (headers['x-service-key'] as string) || '',
    (headers['x-api-key'] as string) || '',
    q.get('key') || '',
  ];
  return candidates.some((c) => c && timingSafeEqualStr(c, config.readKey));
}

export function attachWs(server: http.Server, pool: RpcPoolManager): void {
  const wss = new WebSocketServer({ server, path: '/v1/ws' });

  wss.on('connection', (ws, req) => {
    const q = new URL(req.url || '/', 'http://internal').searchParams;
    if (!authorized(req.url || '/', req.headers)) {
      ws.close(4001, 'unauthorized');
      return;
    }
    const chain = q.get('chain') || 'sepolia';
    const norm = normalizeChain(chain);
    if (!norm) {
      ws.close(4002, `unsupported chain: ${chain}`);
      return;
    }
    const upUrl = pool.getWsEndpoint(norm);
    if (!upUrl) {
      ws.close(4003, `no active endpoint for ${norm}`);
      return;
    }

    let up: WebSocket;
    try {
      up = new WebSocket(upUrl);
    } catch (e: any) {
      logger.warn(`[chain-rpc] ws upstream create failed (${chain}): ${e?.message}`);
      ws.close(4003, 'upstream unavailable');
      return;
    }

    let closed = false;
    const closeAll = (code?: number, reason?: string) => {
      if (closed) return;
      closed = true;
      try { up.close(); } catch { /* noop */ }
      try { ws.close(code, reason); } catch { /* noop */ }
    };

    // 客户端消息立即挂接（上游未就绪时先缓冲，避免订阅请求丢失）
    const pending: string[] = [];
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
      if (up.readyState !== WebSocket.OPEN) {
        pending.push(data.toString());
        return;
      }
      up.send(data.toString());
    });

    up.on('open', () => {
      logger.info('[chain-rpc] ws connected', { chain: norm, upstream: upUrl.slice(0, 40) + '…' });
      while (pending.length) {
        const m = pending.shift();
        if (m) up.send(m);
      }
      up.on('message', (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data.toString());
      });
      up.on('error', () => closeAll());
      up.on('close', () => closeAll());
    });

    up.on('error', () => closeAll());
    ws.on('close', () => {
      logger.info('[chain-rpc] ws closed', { chain: norm });
      closeAll();
    });
    ws.on('error', () => closeAll());
  });

  logger.info('[chain-rpc] ws endpoint /v1/ws ready');
}
