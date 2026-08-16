/**
 * RPC-7: 每链共享上游 WS 连接管理器（自 routes/ws.ts 拆出）。
 *
 * 职责收敛为"上游连接生命周期"：
 *   - acquire/release：refcount 管理，最后一个客户端离开才断开上游；
 *   - send：上游未就绪期间缓冲（上限 WS_PENDING_CAP），就绪后直发；
 *   - 上游断开（error/close）→ teardown 清理条目并回调 onUpstreamClosed，
 *     由上层（routes/ws.ts）兜底关闭该链全部客户端。
 * 订阅去重/广播（WsSubHub）仍归 routes/ws.ts，本模块不感知业务语义。
 */
import { WebSocket } from 'ws';
import { logger } from '../logger';
import { RpcPoolManager } from './rpcPool';

export interface ChainUpstream {
  up: WebSocket;
  refs: number;
  open: boolean;
  pending: string[]; // 未就绪缓冲的订阅请求
  pendingUp: Map<number, { chain: string; subKey: string }>; // 上游请求 id → 订阅（confirm 路由）
  upSeq: number;
}

/** 上游连接未就绪期间的订阅请求缓冲上限（防无界堆积） */
const WS_PENDING_CAP = 200;

export class WsUpstreamManager {
  private chains = new Map<string, ChainUpstream>();

  constructor(
    private readonly pool: RpcPoolManager,
    private readonly onMessage: (chain: string, raw: string) => void,
    private readonly onUpstreamClosed: (chain: string) => void,
  ) {}

  get(chain: string): ChainUpstream | undefined {
    return this.chains.get(chain);
  }

  /**
   * 获取（必要时创建）该链共享上游，refs+1。
   * 创建失败（无活跃端点 / new WebSocket 异常）→ null，上层关闭客户端。
   */
  acquire(chain: string): ChainUpstream | null {
    let cu = this.chains.get(chain);
    if (!cu) {
      const upUrl = this.pool.getWsEndpoint(chain);
      if (!upUrl) return null;
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
          logger.info('[chain-rpc] ws upstream connected', { chain });
        });
        up.on('message', (data) => this.onMessage(chain, data.toString()));
        up.on('error', () => this.teardown(chain));
        up.on('close', () => this.teardown(chain));
        this.chains.set(chain, cu);
      } catch (e: any) {
        logger.warn(`[chain-rpc] ws upstream create failed (${chain}): ${e?.message}`);
        return null;
      }
    }
    cu.refs += 1;
    return cu;
  }

  /** refs-1；归零时关闭并摘除该链上游（最后一位客户端离开）。 */
  release(chain: string): void {
    const cu = this.chains.get(chain);
    if (!cu) return;
    cu.refs -= 1;
    if (cu.refs <= 0) {
      try {
        cu.up.close();
      } catch {
        /* noop */
      }
      this.chains.delete(chain);
    }
  }

  /** 发往上游：未就绪缓冲（防无界堆积），就绪直发。 */
  send(chain: string, data: string): boolean {
    const cu = this.chains.get(chain);
    if (!cu) return false;
    if (!cu.open) {
      if (cu.pending.length >= WS_PENDING_CAP) return false;
      cu.pending.push(data);
      return true;
    }
    cu.up.send(data);
    return true;
  }

  /** 上游断开/出错：清理失效条目，并通知上层兜底关闭该链客户端。 */
  private teardown(chain: string): void {
    const cu = this.chains.get(chain);
    if (cu) {
      try {
        cu.up.close();
      } catch {
        /* noop */
      }
      this.chains.delete(chain);
    }
    this.onUpstreamClosed(chain);
  }
}
