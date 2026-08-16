import { createClient, http, type Address, type Hex } from 'viem';
import type { BundlerConfig, ChainAAConfig, UserOpReceipt, UserOperationV7, UserOpResult } from './types.js';
import { BundlerError, toAAError } from './errors.js';
import { userOpToRpc } from './userop.js';

// ============================================================================
// Bundler 客户端：多端点 + 容灾（对齐 §5.6，v1.42 实现真实 RPC）
// 策略：主端点失败 → 依次切换备端点；业务错误（AA 码）直接抛出不重试。
// 协议：JSON-RPC over HTTP（eth_sendUserOperation / eth_getUserOperationReceipt /
//       eth_estimateUserOperationGas，ERC-4337 v0.7 非打包字段）。
// ⚠️ 环境警示：OxaChain 上 Pimlico bundler（43.159.60.46:4338）协议为 v0.6
//      （schema 要求 callGasLimit/maxFeePerGas 等 v0.6 字段，拒绝 v0.7 packed），
//      与链上 v0.7 EntryPoint 不匹配：eth_sendUserOperation 一律 FailedOp(-32500)。
//      该环境请改用 EntryPoint.handleOps 直接上链（见 packUserOpV7 +
//      scripts/aa-session-e2e.ts）。若更换为 v0.7 bundler，则 userOpToRpc 需
//      输出 PackedUserOperation（accountGasLimits/gasFees）。
// 零硬编码：端点/EntryPoint 均来自 ChainAAConfig（env 注入）。
// ============================================================================

export interface BundlerSendOptions {
  /** 等待收据的最长时间（ms），默认 120s */
  waitTimeoutMs?: number;
  /** 广播成功回调（userOpHash 已获 bundler 接受，进入收据轮询前；E1 UI broadcasting 子状态用） */
  onBroadcast?: (userOpHash: Hex) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 宽松 RPC client（bundler 自定义方法超出 viem 强类型集合，断言为最小接口） */
type RpcClient = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

function rpcClient(url: string, headers?: Record<string, string>): RpcClient {
  return createClient({ transport: http(url, { fetchOptions: { headers } }) }) as unknown as RpcClient;
}

export class BundlerClient {
  constructor(
    private readonly chainConfig: ChainAAConfig,
    /** 附加请求头（relay 模式注入 X-API-Key 等；端点级 bundler.headers 优先） */
    private readonly headers?: Record<string, string>,
  ) {}

  /** 合并请求头：端点级 bundler.headers > 客户端构造 headers */
  private headersFor(ep: BundlerConfig): Record<string, string> | undefined {
    return ep.headers ?? this.headers;
  }

  /** 发送 UserOp，内置端点容灾；返回 userOpHash + 收据 */
  async sendUserOperation(op: UserOperationV7, options?: BundlerSendOptions): Promise<UserOpResult> {
    const endpoints = [...this.chainConfig.bundlers].sort((a, b) => a.priority - b.priority);
    const lastError: unknown[] = [];

    for (const ep of endpoints) {
      try {
        const userOpHash = await this.sendSingle(ep, op);
        // 广播已接受（userOpHash 在手），进入收据轮询前回调（E1）
        options?.onBroadcast?.(userOpHash);
        const receipt = await this.waitForReceipt(ep, userOpHash, options?.waitTimeoutMs ?? 120_000);
        return { userOpHash, bundlerUrl: ep.url, receipt };
      } catch (e) {
        const aaErr = toAAError(e);
        if (aaErr.isIdempotent) {
          // AA10: 同 nonce 已处理 → 视为成功（幂等返回，不回滚业务）
          return { userOpHash: '0x' as Hex, bundlerUrl: ep.url };
        }
        if (!aaErr.retriable) {
          // 业务错误（AA24 需重签 / AA31-33 paymaster 拒绝）→ 直接抛出
          throw aaErr;
        }
        lastError.push(e);
        // 网络类错误 → 切换下一个端点
      }
    }
    throw new BundlerError(`all bundler endpoints failed (${endpoints.length})`, endpoints[0]?.url, true, {
      cause: lastError,
    });
  }

  /** 估算 UserOp gas（eth_estimateUserOperationGas；失败抛错不虚报，由上层决定兜底） */
  async estimateUserOperationGas(op: UserOperationV7): Promise<Partial<UserOperationV7>> {
    const ep = this.primaryEndpoint();
    const client = rpcClient(ep.url, this.headersFor(ep));
    const r = (await client.request({
      method: 'eth_estimateUserOperationGas',
      params: [userOpToRpc(op), this.chainConfig.entryPoint],
    })) as { callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex };
    return {
      callGasLimit: BigInt(r.callGasLimit),
      verificationGasLimit: BigInt(r.verificationGasLimit),
      preVerificationGas: BigInt(r.preVerificationGas),
    };
  }

  private primaryEndpoint(): BundlerConfig {
    const endpoints = [...this.chainConfig.bundlers].sort((a, b) => a.priority - b.priority);
    if (endpoints.length === 0) {
      throw new BundlerError(`no bundler endpoints configured (chain ${this.chainConfig.chainId})`);
    }
    return endpoints[0];
  }

  /** eth_sendUserOperation → userOpHash */
  private async sendSingle(ep: BundlerConfig, op: UserOperationV7): Promise<Hex> {
    const client = rpcClient(ep.url, this.headersFor(ep));
    const hash = (await client.request({
      method: 'eth_sendUserOperation',
      params: [userOpToRpc(op), this.chainConfig.entryPoint],
    })) as Hex;
    return hash;
  }

  /** eth_getUserOperationReceipt 轮询；网络类错误在超时内继续轮询 */
  private async waitForReceipt(
    ep: BundlerConfig,
    userOpHash: Hex,
    timeoutMs: number,
  ): Promise<UserOpReceipt> {
    const client = rpcClient(ep.url, this.headersFor(ep));
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const r = (await client.request({
          method: 'eth_getUserOperationReceipt',
          params: [userOpHash],
        })) as {
          // ERC-4337 规范：transactionHash 嵌套在 receipt 对象内（Alto/Stackup 等）
          transactionHash?: Hex;
          receipt?: { transactionHash?: Hex };
          success: boolean;
          actualGasCost: Hex;
          actualGasUsed: Hex;
          logs?: unknown[];
        } | null;
        if (r) {
          return {
            txHash: r.transactionHash ?? r.receipt?.transactionHash,
            success: r.success,
            actualGasCost: BigInt(r.actualGasCost),
            actualGasUsed: BigInt(r.actualGasUsed),
            logs: r.logs ?? [],
          };
        }
      } catch (e) {
        // 轮询期 RPC 抖动不致命，保留最后一次错误待超时抛出
        lastErr = e;
      }
      await sleep(1000);
    }
    throw new BundlerError(
      `userOp receipt timeout after ${timeoutMs}ms (hash ${userOpHash})`,
      ep.url,
      true,
      lastErr instanceof Error ? { cause: lastErr } : undefined,
    );
  }
}
