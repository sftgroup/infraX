import type { Hex } from 'viem';
import type { PaymasterConfig, UserOperationV7 } from './types.js';

// ============================================================================
// Verifying Paymaster 对接（对齐 §5.5，Pimlico 默认 + 服务端代理隐藏 apikey）
// TODO(实现/M2): pimlico_getPaymasterData + pimlico_getPaymasterStubData
// ============================================================================

export interface PaymasterResult {
  /** 填充 UserOp 的 paymaster* 三字段（v0.7） */
  op: Pick<UserOperationV7, 'paymaster' | 'paymasterVerificationGasLimit' | 'paymasterPostOpGasLimit' | 'paymasterData'>;
}

export class PaymasterClient {
  constructor(
    private readonly config: PaymasterConfig,
    /** 服务端代理 baseURL（AA_RELAY 隐藏 apikey），缺省直连 Pimlico */
    private readonly relayBaseUrl?: string,
  ) {}

  /** 获取 stub 数据（用于 gas 估算阶段，不计费） */
  async getPaymasterStubData(op: UserOperationV7): Promise<PaymasterResult> {
    // TODO(实现/M2): pimlico_getPaymasterStubData（估算用，paymasterData 留空）
    void op;
    throw new Error('getPaymasterStubData not implemented yet (M2)');
  }

  /** 获取正式 paymasterData（真实计费） */
  async getPaymasterData(op: UserOperationV7): Promise<PaymasterResult> {
    // TODO(实现/M2): pimlico_getPaymasterData（服务端用 relayBaseUrl 代理）
    void op;
    throw new Error('getPaymasterData not implemented yet (M2)');
  }

  get endpoint(): string {
    return this.relayBaseUrl ?? this.config.url;
  }

  get type(): PaymasterConfig['type'] {
    return this.config.type;
  }
}
