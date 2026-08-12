/**
 * A-14: /v1/market-ws — 行情订阅（price/candles 增量推送，对齐低延迟场景）。
 *
 * 鉴权：query `key` = rx_ 读 key（verifyRxKey，与 /v1/market-rpc 同一校验）。
 * 协议：
 *   {"op":"subscribe","type":"price","chainIndex":"1","tokens":["0x..",...]}
 *   {"op":"subscribe","type":"candles","chainIndex":"1","tokens":["0x.."],"period":"15m","limit":4}
 *   {"op":"unsubscribe","type":"price","tokens":[...]}   // 缺 tokens → 该 type 全部退订
 * 推送：
 *   {"type":"price","chainIndex","tokenAddress","data"}     // 仅价格变化时推送（增量）
 *   {"type":"candles","chainIndex","tokenAddress","data"}   // 仅最后一根 K 线 timestamp 变化时推送
 *
 * 同源同缓存（A-13）：轮询直接走 getMarketClient() 单例（REST MarketAPI 同一 client）。
 * 全局单实例轮询 Timer（价格 5s / K 线 30s），客户端数不影响上游调用频次。
 */
import WebSocket from 'ws';
import { Request } from 'express';
import { logger } from '../logger';
import { verifyRxKey } from '../routes/marketRpcRoutes';
import { getMarketClient } from './okxMarketV6';

const PRICE_INTERVAL_MS = 5000;
const CANDLE_INTERVAL_MS = 30000;

interface Sub { chainIndex: string; token: string; }
interface CandleSub extends Sub { period: string; limit: number; }

interface ClientState {
  price: Map<string, Sub>;
  candles: Map<string, CandleSub>;
}

// ── 全局订阅表（key = `${chainIndex}:${token.toLowerCase()}`） ──
const clients = new Set<{ ws: WebSocket; state: ClientState }>();
const priceSubs = new Map<string, Sub>();
const candleSubs = new Map<string, CandleSub>();

// 上次推送指纹（增量判定）
const lastPrice = new Map<string, string>();
const lastCandle = new Map<string, string>();

function subKey(chainIndex: string, token: string): string {
  return `${chainIndex}:${token.toLowerCase()}`;
}

function push(type: string, chainIndex: string, tokenAddress: string, data: any): void {
  const msg = JSON.stringify({ type, chainIndex, tokenAddress, data });
  const key = subKey(chainIndex, tokenAddress);
  for (const c of clients) {
    const subs = type === 'price' ? c.state.price : c.state.candles;
    if (subs.has(key)) {
      try {
        if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
      } catch {}
    }
  }
}

async function refreshPrices(): Promise<void> {
  if (priceSubs.size === 0) return;
  const entries = [...priceSubs.entries()];
  await Promise.all(entries.map(async ([key, s]) => {
    try {
      const data = await getMarketClient().getPrice(s.chainIndex, s.token);
      const fp = JSON.stringify(data);
      if (fp !== lastPrice.get(key)) {
        lastPrice.set(key, fp);
        push('price', s.chainIndex, s.token, data);
      }
    } catch {}
  }));
}

async function refreshCandles(): Promise<void> {
  if (candleSubs.size === 0) return;
  const entries = [...candleSubs.entries()];
  await Promise.all(entries.map(async ([key, s]) => {
    try {
      const data = await getMarketClient().getCandles(s.chainIndex, s.token, s.period, s.limit);
      const last = Array.isArray(data) && data.length > 0 ? data[data.length - 1] : null;
      const fp = last ? JSON.stringify(last) : JSON.stringify(data);
      if (fp !== lastCandle.get(key)) {
        lastCandle.set(key, fp);
        push('candles', s.chainIndex, s.token, data);
      }
    } catch {}
  }));
}

let timerStarted = false;
function ensureTimer(): void {
  if (timerStarted) return;
  timerStarted = true;
  setInterval(() => { refreshPrices().catch(() => {}); }, PRICE_INTERVAL_MS);
  setInterval(() => { refreshCandles().catch(() => {}); }, CANDLE_INTERVAL_MS);
  logger.info('[market-ws] push timer started', { priceMs: PRICE_INTERVAL_MS, candleMs: CANDLE_INTERVAL_MS });
}

function subscribe(state: ClientState, type: string, msg: any): void {
  const chainIndex = String(msg.chainIndex || '');
  const tokens: string[] = Array.isArray(msg.tokens) ? msg.tokens.map(String) : [];
  if (!chainIndex || tokens.length === 0) return;
  if (type === 'price') {
    for (const t of tokens) {
      const s = { chainIndex, token: t };
      state.price.set(subKey(chainIndex, t), s);
      priceSubs.set(subKey(chainIndex, t), s);
      // 订阅即推当前值
      getMarketClient().getPrice(chainIndex, t).then((d) => {
        lastPrice.set(subKey(chainIndex, t), JSON.stringify(d));
        push('price', chainIndex, t, d);
      }).catch(() => {});
    }
  } else if (type === 'candles') {
    const period = msg.period ? String(msg.period) : '15m';
    const limit = parseInt(msg.limit, 10) || 4;
    for (const t of tokens) {
      const s = { chainIndex, token: t, period, limit: Math.min(Math.max(limit, 1), 100) };
      state.candles.set(subKey(chainIndex, t), s);
      candleSubs.set(subKey(chainIndex, t), s);
      getMarketClient().getCandles(chainIndex, t, period, limit).then((d) => {
        const last = Array.isArray(d) && d.length > 0 ? d[d.length - 1] : null;
        lastCandle.set(subKey(chainIndex, t), last ? JSON.stringify(last) : JSON.stringify(d));
        push('candles', chainIndex, t, d);
      }).catch(() => {});
    }
  }
}

function unsubscribe(state: ClientState, type: string, msg: any): void {
  const chainIndex = String(msg.chainIndex || '');
  const tokens: string[] = Array.isArray(msg.tokens) ? msg.tokens.map(String) : [];
  if (type === 'price') {
    if (chainIndex && tokens.length > 0) {
      for (const t of tokens) { const k = subKey(chainIndex, t); state.price.delete(k); priceSubs.delete(k); }
    } else {
      for (const k of state.price.keys()) priceSubs.delete(k);
      state.price.clear();
    }
  } else if (type === 'candles') {
    if (chainIndex && tokens.length > 0) {
      for (const t of tokens) { const k = subKey(chainIndex, t); state.candles.delete(k); candleSubs.delete(k); }
    } else {
      for (const k of state.candles.keys()) candleSubs.delete(k);
      state.candles.clear();
    }
  }
}

/** Upgrade HTTP → WebSocket on /v1/market-ws?key=rx_...&chainIndex=1（index.ts server 'upgrade' 事件调用） */
export async function handleMarketWsUpgrade(req: Request, socket: any, head: any): Promise<void> {
  if (!req.url?.startsWith('/v1/market-ws')) return;
  const url = new URL(req.url, 'http://localhost');
  const key = url.searchParams.get('key') || '';
  if (!(await verifyRxKey(key))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const wss = new WebSocket.Server({ noServer: true });
  wss.handleUpgrade(req, socket, head, (ws) => {
    const state: ClientState = { price: new Map(), candles: new Map() };
    const entry = { ws, state };
    clients.add(entry);
    ensureTimer();
    ws.send(JSON.stringify({ type: 'connected', message: 'Subscribed to market stream (price/candles)', chainIndex: url.searchParams.get('chainIndex') || null }));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const op = msg.op;
        const type = msg.type;
        if (op === 'subscribe' && (type === 'price' || type === 'candles')) subscribe(state, type, msg);
        else if (op === 'unsubscribe' && (type === 'price' || type === 'candles')) unsubscribe(state, type, msg);
      } catch {}
    });
    ws.on('close', () => {
      clients.delete(entry);
      for (const k of state.price.keys()) priceSubs.delete(k);
      for (const k of state.candles.keys()) candleSubs.delete(k);
    });
    ws.on('error', () => { try { ws.close(); } catch {} });
  });
}
