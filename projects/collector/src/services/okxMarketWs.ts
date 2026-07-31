import WebSocket from 'ws';
import { logger } from '../logger';
import { config } from '../config';

// ================================================================
// OKX Market v6 WebSocket Client
// ================================================================
// Connects to OKX public WebSocket for real-time ticker data.
// All URLs, instruments, and intervals are configurable via env vars.
// ================================================================

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

  async start(instIds?: string[]): Promise<void> {
    if (this.running) return;
    this.running = true;

    const ids = instIds?.length ? instIds : config.okxMarket.wsInstruments;
    this.connect(ids);
    logger.info('[okx-ws] WebSocket client started', { instruments: ids.length });
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

    this.ws = new WebSocket(config.okxMarket.wsUrl);

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
      }, config.okxMarket.wsPingIntervalMs);
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      const text = raw.toString();
      if (text === 'pong') return;

      try {
        const msg = JSON.parse(text);
        if (msg.event) return;

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
        this.reconnectTimer = setTimeout(() => this.connect(instIds), config.okxMarket.wsReconnectMs);
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
