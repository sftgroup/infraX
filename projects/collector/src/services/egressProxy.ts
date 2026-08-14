/**
 * Egress proxy pool (RI-4.2/4.5) — 出口 IP 轮换 + 健康探测 + 故障降级。
 *
 * 代理池来自 config.egressProxies（EGRESS_PROXIES JSON，默认空=直连）：
 *   [{ "host": "127.0.0.1", "port": 18848, "auth": "proxy-token" }, ...]
 *
 *  - getProxyConfig(): round-robin 返回一个健康代理的 axios proxy 配置；
 *    无健康代理 → null（调用方直连，fail-silent）；
 *  - 健康探测：每 30s 经代理探测 https://api.ipify.org，失败标记 unhealthy
 *    并冷却（探测通过后自动恢复）；
 *  - 回滚 = 清空 EGRESS_PROXIES 重启（config 默认 []，直连）。
 */
import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';

export interface EgressProxy {
  host: string;
  port: number;
  auth?: string; // "user:pass"，CONNECT 代理的 Proxy-Authorization
}

const PROBE_URL = 'https://api.ipify.org';
const PROBE_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

class EgressProxyManager {
  private proxies: EgressProxy[] = [];
  private healthy: boolean[] = [];
  private probeTimer: NodeJS.Timeout | null = null;
  private rrIndex = 0;

  init(): void {
    this.proxies = (config.egressProxies as EgressProxy[]) || [];
    this.healthy = this.proxies.map(() => true);
    if (this.proxies.length === 0) {
      return;
    }
    logger.info(`[egress] proxy pool loaded: ${this.proxies.map((p) => `${p.host}:${p.port}`).join(', ')}`);
    this.startProbe();
  }

  /** 构建 axios proxy 配置；无健康代理 → null（直连）。round-robin 轮换出口。 */
  getProxyConfig(): any | null {
    if (this.proxies.length === 0) {
      return null;
    }
    for (let i = 0; i < this.proxies.length; i++) {
      const idx = (this.rrIndex + i) % this.proxies.length;
      if (this.healthy[idx]) {
        this.rrIndex = (idx + 1) % this.proxies.length;
        const p = this.proxies[idx];
        const cfg: any = { protocol: 'http', host: p.host, port: p.port };
        if (p.auth) {
          const [u, pw] = p.auth.split(':');
          cfg.auth = { username: u, password: pw || '' };
        }
        return cfg;
      }
    }
    return null; // 全部不健康 → 直连（fail-silent）
  }

  private async probeOne(idx: number): Promise<void> {
    const p = this.proxies[idx];
    const proxy = this.proxyConfig(p);
    try {
      await axios.get(PROBE_URL, { timeout: REQUEST_TIMEOUT_MS, proxy });
      if (!this.healthy[idx]) {
        logger.info(`[egress] proxy ${p.host}:${p.port} healthy again`);
      }
      this.healthy[idx] = true;
    } catch (err: any) {
      if (this.healthy[idx]) {
        logger.warn(`[egress] proxy ${p.host}:${p.port} unhealthy: ${err.message} — fall back to direct`);
      }
      this.healthy[idx] = false;
    }
  }

  private proxyConfig(p: EgressProxy): any {
    const cfg: any = { protocol: 'http', host: p.host, port: p.port };
    if (p.auth) {
      const [u, pw] = p.auth.split(':');
      cfg.auth = { username: u, password: pw || '' };
    }
    return cfg;
  }

  private startProbe(): void {
    this.probeTimer = setInterval(() => {
      for (let i = 0; i < this.proxies.length; i++) {
        void this.probeOne(i);
      }
    }, PROBE_INTERVAL_MS);
    if (this.probeTimer.unref) {
      this.probeTimer.unref();
    }
    // 启动即探测一次（快速发现不可用代理）
    for (let i = 0; i < this.proxies.length; i++) {
      void this.probeOne(i);
    }
  }

  shutdown(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }
}

export const egressProxy = new EgressProxyManager();
