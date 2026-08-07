import type { Address, Hex } from 'viem';
import type { Signer } from '../types.js';

// ============================================================================
// Session Key 签名器（P3.1）：对接 InfraX Session Key Engine execute 接口
// 场景：session key 私钥由 Engine 托管（sessionKeyEnc 加密存储，PocketX 不落私钥），
// 签名委托 Engine 完成 —— POST /api/v1/execute 代签 + 广播 EOA 交易并返回 txHash。
// 映射（对齐 docs/INFRAX_HANDOVER.md §6.1）：
//   signUserOp(userOpHash) → execute({ to, data: userOpHash })  # 引擎侧签 hash 并上链
//   signMessage(message)   → execute({ to, data: message })     # 引擎侧签消息并上链
// 返回的 txHash 即签名结果（交易广播成功 = 签名完成），权限/限额校验在 Engine 侧强制。
// 零硬编码：engineUrl/token 缺省从 SESSION_KEY_ENGINE_URL / SESSION_KEY_ENGINE_TOKEN
// env 读取（AA_SDK_TECH_DESIGN §8.1 / POCKETX_EXPANSION §5.5）。
// ============================================================================

/** Engine execute 请求体（对齐 @0xinfrax/session-key-core ExecuteRequest） */
interface ExecuteRequest {
  sessionId: string;
  chain: string;
  to: string;
  data: string;
  value?: string;
  gasLimit?: string;
}

/** Engine execute 结果（对齐 @0xinfrax/session-key-core ExecuteResult） */
interface ExecuteResult {
  executionId: string;
  txHash: string;
  status: 'success' | 'failed';
  gasUsed?: string;
  errorReason?: string;
}

/** Engine 统一响应包装（ApiResponse<T>） */
interface ApiResponse<T> {
  code: number;
  data: T;
  message: string;
}

/** SessionKeySigner 构造选项（engineUrl/token 缺省读 env，sessionId 必填） */
export interface SessionKeySignerOptions {
  /** Engine 会话 id（POST /api/v1/execute 必填；缺失时调用明确抛错） */
  sessionId?: string;
  /** 目标链（缺省 'eth'，对齐 Engine Chain 枚举：eth/bsc/base/polygon/arbitrum/optimism/xlayer/sol） */
  chain?: string;
  /** 缺省执行目标（需在会话合约白名单内；缺省用 session key 地址） */
  to?: Address;
  /** HTTP 超时（缺省 15s） */
  timeoutMs?: number;
}

export class SessionKeySigner implements Signer {
  readonly type = 'session-key' as const;
  readonly address: `0x${string}`;

  private readonly engineUrl: string | undefined;
  private readonly token: string | undefined;
  private readonly chain: string;
  private readonly to: Address | undefined;
  private readonly timeoutMs: number;
  private sessionId: string | undefined;

  constructor(
    address: `0x${string}`,
    engineUrl?: string,
    token?: string,
    options: SessionKeySignerOptions = {},
  ) {
    this.address = address;
    this.engineUrl = engineUrl ?? process.env.SESSION_KEY_ENGINE_URL;
    this.token = token ?? process.env.SESSION_KEY_ENGINE_TOKEN;
    this.sessionId = options.sessionId;
    this.chain = options.chain ?? 'eth';
    this.to = options.to;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** 后置注入 sessionId（创建会话后再装配签名器的场景） */
  setSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** 委托 Engine 执行：代签 + 广播交易，返回 txHash */
  private async execute(params: { to?: Address; data: Hex }): Promise<Hex> {
    if (!this.engineUrl) {
      throw new Error(
        '[aa-sdk] SessionKeySigner: missing engine URL (pass engineUrl or set SESSION_KEY_ENGINE_URL env)',
      );
    }
    if (!this.sessionId) {
      throw new Error(
        '[aa-sdk] SessionKeySigner: missing sessionId (pass sessionKeyEngine.sessionId or call setSession)',
      );
    }

    const body: ExecuteRequest = {
      sessionId: this.sessionId,
      chain: this.chain,
      to: params.to ?? this.to ?? this.address,
      data: params.data,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.engineUrl.replace(/\/+$/, '')}/api/v1/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`[aa-sdk] SessionKeySigner.execute: timeout after ${this.timeoutMs}ms`);
      }
      throw new Error(
        `[aa-sdk] SessionKeySigner.execute: network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    let payload: ApiResponse<ExecuteResult>;
    try {
      payload = (await res.json()) as ApiResponse<ExecuteResult>;
    } catch {
      throw new Error(`[aa-sdk] SessionKeySigner.execute: invalid response (HTTP ${res.status})`);
    }

    if (!res.ok || payload.code !== 200 || payload.data?.status !== 'success') {
      const reason = payload.data?.errorReason ?? payload.message ?? `HTTP ${res.status}`;
      throw new Error(`[aa-sdk] SessionKeySigner.execute failed: ${reason}`);
    }
    if (!payload.data?.txHash) {
      throw new Error('[aa-sdk] SessionKeySigner.execute: empty txHash in response');
    }
    return payload.data.txHash as Hex;
  }

  /** userOpHash（EIP-712 digest，v0.7）→ Engine 代签 + 上链，返回 txHash */
  async signUserOp(userOpHash: Hex): Promise<Hex> {
    return this.execute({ data: userOpHash });
  }

  /** 任意消息（EIP-191）→ Engine 代签 + 上链，返回 txHash */
  async signMessage(message: Hex): Promise<Hex> {
    return this.execute({ data: message });
  }
}
