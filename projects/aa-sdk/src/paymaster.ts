import { toHex, type Address, type Hex } from 'viem';
import type { PaymasterConfig, UserOperationV7 } from './types.js';
import { userOpToRpc } from './userop.js';
import { isHttpOk, postJson } from './utils/rpc.js';

// ============================================================================
// Verifying Paymaster 对接（对齐 §5.5，Pimlico 默认 + 服务端代理隐藏 apikey）
// 实现（E-1a）：
//   pimlico_getPaymasterStubData —— 估算阶段（data 为 stub，不计费）
//   pimlico_getPaymasterData   —— 发送阶段（data 为正式签名，真实计费）
// 两种模式：
//   - 直连：POST config.url（Pimlico URL，apikey 由服务端注入 URL）
//   - relay 代理：POST {relayBaseUrl}/v1/paymaster { chain, method, params }
//     （服务端 aa-relay 持有 paymaster apikey，SDK/前端不暴露）
// ============================================================================

export interface PaymasterResult {
  /** 填充 UserOp 的 paymaster* 字段（v0.7）+ preVerificationGas（stub 场景） */
  op: Partial<
    Pick<
      UserOperationV7,
      'paymaster' | 'paymasterVerificationGasLimit' | 'paymasterPostOpGasLimit' | 'paymasterData' | 'preVerificationGas'
    >
  >;
}

/** Paymaster RPC 请求上下文（entryPoint/chainId 参与 EIP-712 域；relay 路由需 chain 别名） */
export interface PaymasterRequestContext {
  /** 链别名（仅 relay 代理模式用于路由到对应链的 paymaster URL） */
  chain: string;
  entryPoint: Address;
  chainId: number;
  /** Pimlico sponsorship policy ID（可选；不传走默认策略） */
  policyId?: string;
}

/** 直连模式下可能的响应形态（Pimlico v0.7 拆分字段） */
interface PaymasterRpcData {
  paymaster?: Address;
  data?: Hex;
  verificationGasLimit?: Hex;
  preVerificationGas?: Hex;
}

export class PaymasterClient {
  constructor(
    private readonly config: PaymasterConfig,
    /** 服务端代理 baseURL（aa-relay，隐藏 apikey），缺省直连 Pimlico */
    private readonly relayBaseUrl?: string,
    /** 附加请求头（relay 模式注入 X-API-Key 等；config.headers 优先） */
    private readonly headers?: Record<string, string>,
  ) {}

  /** 获取 stub 数据（gas 估算阶段，不计费；Pimlico 返回 paymaster+data+gas 字段） */
  async getPaymasterStubData(op: UserOperationV7, ctx: PaymasterRequestContext): Promise<PaymasterResult> {
    const r = await this.rpc('pimlico_getPaymasterStubData', op, ctx);
    return {
      op: {
        paymaster: r.paymaster as Address,
        paymasterData: r.data as Hex,
        paymasterVerificationGasLimit: r.verificationGasLimit ? BigInt(r.verificationGasLimit) : undefined,
        paymasterPostOpGasLimit: 0n,
        preVerificationGas: r.preVerificationGas ? BigInt(r.preVerificationGas) : undefined,
      },
    };
  }

  /** 获取正式 paymasterData（真实计费，返回 paymaster+data） */
  async getPaymasterData(op: UserOperationV7, ctx: PaymasterRequestContext): Promise<PaymasterResult> {
    const r = await this.rpc('pimlico_getPaymasterData', op, ctx);
    return {
      op: {
        paymaster: r.paymaster as Address,
        paymasterData: r.data as Hex,
      },
    };
  }

  get endpoint(): string {
    return this.relayBaseUrl ?? this.config.url;
  }

  get type(): PaymasterConfig['type'] {
    return this.config.type;
  }

  /** JSON-RPC 调用：relay 代理（body 带 chain 路由）或直连 Pimlico */
  private async rpc(method: string, op: UserOperationV7, ctx: PaymasterRequestContext): Promise<PaymasterRpcData> {
    const params: unknown[] = [userOpToRpc(op), ctx.entryPoint, toHex(ctx.chainId)];
    if (ctx.policyId) params.push(ctx.policyId);

    const body = this.relayBaseUrl
      ? { chain: ctx.chain, method, params }
      : { method, params };

    const { status, json } = await postJson<Record<string, unknown>>(this.endpoint, body, {
      headers: { ...(this.headers ?? {}), ...(this.config.headers ?? {}) },
      label: `paymaster ${method}`,
    });
    if (!isHttpOk(status) || !json) {
      const errBody = json as { message?: string; error?: { message?: string } } | null;
      throw new Error(
        `[aa-sdk] paymaster ${method} failed (${status}): ${errBody?.message || errBody?.error?.message || 'non-json response'}`,
      );
    }
    const result = (json.result ?? json.data) as PaymasterRpcData | undefined;
    if (!result) {
      throw new Error(`[aa-sdk] paymaster ${method} returned no result: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return result;
  }
}
