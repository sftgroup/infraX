import WebSocket from 'ws';
import { logger } from '../logger';

// ================================================================
// OKX Market v6 WebSocket Client
// ================================================================
// Connects to OKX public WebSocket for real-time ticker data
// and pushes through the local eventBus for frontend streaming.
//
// Subscribes to:
//   - tickers       real-time price updates for tracked tokens
//   - trades        recent trade data for tracked tokens
//
// Reconnects automatically on disconnect (5s backoff).
// ================================================================

const OKX_WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';
const RECONNECT_DELAY_MS = 5_000;
const PING_INTERVAL_MS = 20_000;

// Tracked token pairs (chain-native + top tokens across chains)
const DEFAULT_INST_IDS = [
  'ETH-USDT', 'BTC-USDT', 'BNB-USDT', 'SOL-USDT',
  'USDC-USDT', 'PEPE-USDT', 'SHIB-USDT', 'DOGE-USDT',
  'ARB-USDT', 'OP-USDT', 'MATIC-USDT', 'AVAX-USDT',
  'LINK-USDT', 'UNI-USDT', 'AAVE-USDT', 'WIF-USDT',
];

type MarketCallback = (data: any) => void;

export class OkxMarketWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private listeners: Set<MarketCallback> = new Set();
  private running = false;

  onData(cb: MarketCallback): void {
    this.listeners.add(cb);
  }

  async start(instIds: string[] = DEFAULT_INST_IDS): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.connect(instIds);
    logger.info('[okx-ws] WebSocket client started', { instruments: instIds.length });
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('[okx-ws] WebSocket client stopped');
  }

  private connect(instIds: string[]): void {
    if (!this.running) return;

    this.ws = new WebSocket(OKX_WS_URL);

    this.ws.on('open', () => {
      logger.info('[okx-ws] Connected to OKX');

      // Subscribe to tickers channel
      const subMsg = JSON.stringify({
        op: 'subscribe',
        args: instIds.map(id => ({ channel: 'tickers', instId: id })),
      });
      this.ws!.send(subMsg);

      // Start ping keep-alive
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send('ping');
        }
      }, PING_INTERVAL_MS);
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      const text = raw.toString();
      if (text === 'pong') return;

      try {
        const msg = JSON.parse(text);
        if (msg.event) return; // skip subscription confirmations

        // Broadcast to listeners
        for (const cb of this.listeners) {
          try { cb(msg); } catch {}
        }
      } catch {}
    });

    this.ws.on('close', () => {
      logger.warn('[okx-ws] Disconnected');
      this.clearTimers();
      this.ws = null;
      if (this.running) {
        this.reconnectTimer = setTimeout(() => this.connect(instIds), RECONNECT_DELAY_MS);
      }
    });

    this.ws.on('error', (err: any) => {
      logger.warn('[okx-ws] Error', { error: err.message });
      this.ws?.close();
    });
  }

  private clearTimers(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }
}

// Singleton
let wsInstance: OkxMarketWsClient | null = null;
export function getMarketWsClient(): OkxMarketWsClient {
  if (!wsInstance) wsInstance = new OkxMarketWsClient();
  return wsInstance;
}
