/**
 * RPC-7: WebSocket 订阅去重 Hub（高频事件性能优化的核心）。
 *
 * 原 DC-5 实现是"1 客户端 = 1 上游 WS 连接 + 1 上游订阅"的纯透传：
 *   - N 个客户端订阅同一事件 → N 份上游订阅 + N 倍消息量（上游负载、带宽、内存全放大）；
 *   - 无背压：慢客户端导致 ws.send 缓冲无上限（内存风险）；
 *   - 无订阅清理跟踪（泄漏靠上游连接关闭兜底）。
 *
 * WsSubHub 将订阅注册表收敛为共享结构：
 *   chain → subKey(method|params) → { upSubId, clients }
 * - 相同 (chain, method, params) 的客户端共享**一条上游订阅**，事件只拉一份、网关内广播；
 * - 最后一个客户端取消/断开时才向上游 eth_unsubscribe；
 * - 广播时执行慢消费者驱逐（bufferedAmount 超阈值 → close 4004 + 摘除）。
 *
 * 本模块不依赖 ws 库实例（客户端以 WsClient 接口注入），可纯逻辑单测。
 */
import { WebSocket } from 'ws';

export interface WsClient {
  readonly id: number;
  send(data: string): void;
  readonly bufferedAmount: number;
  close(code?: number, reason?: string): void;
}

interface SubEntry {
  upSubId: string | null; // 上游确认的订阅 id（未确认前 null）
  clients: Map<number, { ws: WsClient; localSubId: number }>; // clientId → client
}

export interface WsHubOptions {
  /** 慢消费者阈值（字节）：client.bufferedAmount 超过即驱逐 */
  maxBufferBytes: number;
}

/**
 * 每 key 并发连接计数（rx_ 订阅 key 配额，RPC-7）。
 * 纯计数逻辑、无 io，可独立单测；keyId 唯一标识一把 key，concurrent 为该 key 套餐并发上限。
 */
export class WsConnQuota {
  private conns = new Map<number, number>();

  /** 尝试占用 1 个连接；超限返回 false（不改变计数）。 */
  tryAcquire(keyId: number, concurrent: number): boolean {
    const cur = (this.conns.get(keyId) || 0) + 1;
    if (cur > concurrent) return false;
    this.conns.set(keyId, cur);
    return true;
  }

  /** 释放 1 个连接（计数减至 0 时移除条目）。 */
  release(keyId: number): void {
    const n = (this.conns.get(keyId) || 1) - 1;
    if (n <= 0) this.conns.delete(keyId);
    else this.conns.set(keyId, n);
  }

  /** 当前在途连接数。 */
  current(keyId: number): number {
    return this.conns.get(keyId) || 0;
  }
}

export class WsSubHub {
  private subs = new Map<string, Map<string, SubEntry>>(); // chain → subKey → entry
  private seq = 1;
  private readonly maxBufferBytes: number;

  constructor(opts?: Partial<WsHubOptions>) {
    this.maxBufferBytes = opts?.maxBufferBytes ?? 1024 * 1024;
  }

  static subKey(method: string, params: unknown[]): string {
    return `${method}|${JSON.stringify(params ?? [])}`;
  }

  /**
   * 客户端订阅。返回本地 subId（客户端只见此 id）与是否需向上游发起新订阅。
   * 相同 subKey 的后续客户端复用已有订阅（isNew=false，无需等上游确认）。
   */
  subscribe(chain: string, ws: WsClient, method: string, params: unknown[]): { localSubId: number; isNew: boolean } {
    const key = WsSubHub.subKey(method, params);
    let chainMap = this.subs.get(chain);
    if (!chainMap) {
      chainMap = new Map();
      this.subs.set(chain, chainMap);
    }
    const localSubId = this.seq++;
    let entry = chainMap.get(key);
    if (!entry) {
      entry = { upSubId: null, clients: new Map() };
      chainMap.set(key, entry);
      entry.clients.set(ws.id, { ws, localSubId });
      return { localSubId, isNew: true };
    }
    entry.clients.set(ws.id, { ws, localSubId });
    return { localSubId, isNew: false };
  }

  /** 上游确认订阅（回填 upSubId）。若该 subKey 已被取消（客户端在确认前全部断开）→ 返回 false，调用方应补发 eth_unsubscribe 清理孤儿订阅。 */
  confirmUpstream(chain: string, subKey: string, upSubId: string): boolean {
    const entry = this.subs.get(chain)?.get(subKey);
    if (!entry) return false;
    entry.upSubId = upSubId;
    return true;
  }

  /**
   * 客户端取消订阅。最后一个客户端离开且已确认 → releaseUpstream=true（调用方向上游 eth_unsubscribe）。
   * 未确认（upSubId=null）时不释放上游（调用方以 confirm 返回 false 的路径兜底清理）。
   */
  unsubscribe(
    chain: string,
    ws: WsClient,
    localSubId: number
  ): { ok: boolean; releaseUpstream: boolean; subKey?: string; upSubId?: string } {
    const chainMap = this.subs.get(chain);
    if (!chainMap) return { ok: false, releaseUpstream: false };
    for (const [subKey, entry] of [...chainMap]) {
      const c = entry.clients.get(ws.id);
      if (c && c.localSubId === localSubId) {
        entry.clients.delete(ws.id);
        if (entry.clients.size === 0) {
          chainMap.delete(subKey);
          if (chainMap.size === 0) this.subs.delete(chain);
          return { ok: true, releaseUpstream: entry.upSubId !== null, subKey, upSubId: entry.upSubId ?? undefined };
        }
        return { ok: true, releaseUpstream: false };
      }
    }
    return { ok: false, releaseUpstream: false };
  }

  /**
   * 客户端断开：释放其全部订阅；返回需要向上游 eth_unsubscribe 的条目（含上游订阅 id）。
   */
  removeClient(chain: string, ws: WsClient): { release: { subKey: string; upSubId: string }[] } {
    const chainMap = this.subs.get(chain);
    if (!chainMap) return { release: [] };
    const release: { subKey: string; upSubId: string }[] = [];
    for (const [subKey, entry] of [...chainMap]) {
      if (entry.clients.has(ws.id)) {
        entry.clients.delete(ws.id);
        if (entry.clients.size === 0) {
          chainMap.delete(subKey);
          if (entry.upSubId !== null) release.push({ subKey, upSubId: entry.upSubId });
        }
      }
    }
    if (chainMap.size === 0) this.subs.delete(chain);
    return { release };
  }

  /**
   * 上游订阅事件广播到该订阅的全部客户端。
   * 背压：客户端 bufferedAmount 超阈值 → close(4004,'slow consumer') 并摘除（其订阅随后由 close 清理）。
   */
  broadcast(chain: string, upSubId: string, data: string): void {
    const chainMap = this.subs.get(chain);
    if (!chainMap) return;
    for (const [subKey, entry] of [...chainMap]) {
      if (entry.upSubId !== upSubId) continue;
      for (const [clientId, c] of [...entry.clients]) {
        if (c.ws.bufferedAmount > this.maxBufferBytes) {
          try {
            c.ws.close(4004, 'slow consumer');
          } catch {
            /* noop */
          }
          entry.clients.delete(clientId);
          continue;
        }
        try {
          c.ws.send(data);
        } catch {
          entry.clients.delete(clientId);
        }
      }
      if (entry.clients.size === 0) {
        chainMap.delete(subKey);
        if (chainMap.size === 0) this.subs.delete(chain);
      }
      break;
    }
  }

  /** 是否存在指定订阅（供 confirm 时判断孤儿） */
  has(chain: string, subKey: string): boolean {
    return this.subs.get(chain)?.has(subKey) ?? false;
  }

  /** 订阅统计（供 /v1/status 或监控） */
  stats(): { chains: number; subscriptions: number; clients: number } {
    let subscriptions = 0;
    let clients = 0;
    for (const chainMap of this.subs.values()) {
      subscriptions += chainMap.size;
      for (const entry of chainMap.values()) clients += entry.clients.size;
    }
    return { chains: this.subs.size, subscriptions, clients };
  }
}
