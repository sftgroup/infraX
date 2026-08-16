import type { Address, Hex } from 'viem';

// ============================================================================
// aa-sdk 全包共享类型（对齐 docs/AA_SDK_TECH_DESIGN.md §4）
// ============================================================================

/** 网络类型（多网络 session 授权）：EVM 链 / Solana。每网络独立授权（见 AA_SDK_TECH_DESIGN §7.4） */
export type NetworkId = 'evm' | 'solana';

/** 链配置：从环境变量加载，零硬编码 */
export interface ChainAAConfig {
  network: NetworkId; // 缺省 'evm'（Solana 阶段为独立配置形态，见 AA_SDK_TECH_DESIGN §12）
  chainId: number;
  entryPointVersion: '0.7';
  entryPoint: Address; // 0x00000000...da032
  /** 链 RPC URL（链上读取/发送必需，env AA_{CHAIN}_RPC_URL） */
  rpcUrl: string;
  /** Kernel 版本（缺省 '0.3.1'，env AA_{CHAIN}_KERNEL_VERSION） */
  kernelVersion?: string;
  /** KernelFactory（缺省用 permissionless 内置 v3 默认地址，env AA_{CHAIN}_FACTORY 可覆盖） */
  kernelFactory?: Address;
  /** Kernel 实现合约（同上，env AA_{CHAIN}_IMPLEMENTATION） */
  kernelImplementation?: Address;
  /** Kernel v3 session validator 模块（env AA_{CHAIN}_SESSION_MODULE，enable/disable session 用） */
  sessionModule?: Address;
  /** Kernel v3 ECDSA root validator（env AA_{CHAIN}_ECDSA_VALIDATOR；缺省用 permissionless 内置 v3 默认地址） */
  validatorAddress?: Address;
  bundlers: BundlerConfig[]; // 多端点（主 + 备）
  paymaster?: PaymasterConfig; // 可空
}

export interface BundlerConfig {
  url: string; // 完整 URL（含 apikey 由服务端代理注入）
  priority: number; // 0 = 主，1 = 备
  timeoutMs: number;
  /** 附加请求头（relay 模式注入 X-API-Key 等；缺省继承 BundlerClient 构造 headers） */
  headers?: Record<string, string>;
}

export interface PaymasterConfig {
  type: 'verifying' | 'erc20' | 'none';
  url: string; // Pimlico paymaster RPC
  /** erc20 模式下扣费的 token（如 USDC） */
  token?: Address;
  /** 附加请求头（relay 模式注入 X-API-Key 等；缺省继承 PaymasterClient 构造 headers） */
  headers?: Record<string, string>;
}

/** 统一签名器抽象（D6；P0.13 扩展：外部钱包） */
export interface Signer {
  readonly type: 'private-key' | 'mpc' | 'session-key' | 'external-wallet';
  readonly address: Address;
  /** 对 EIP-712 打包后的 userOpHash 签名 */
  signUserOp(userOpHash: Hex): Promise<Hex>;
  /** 对任意消息签名（EIP-191，供验证/登录用） */
  signMessage(message: Hex): Promise<Hex>;
}

/** Session Key 权限策略（每网络独立授权，network 维度由创建方指定） */
export interface SessionPolicy {
  /** 所属网络（EVM 链统一 'evm'；Solana 为 'solana'） */
  network: NetworkId;
  sessionId: string;
  signer: Address; // session key 公钥地址
  validUntil: bigint; // 到期时间（秒）
  validAfter: bigint; // 生效时间（秒）
  permissions: SessionPermission[];
}

/** ERC-20 金额级限额（P0.12，§7.5）：per-token 单笔/日限额（0 = 不限） */
export interface TokenLimit {
  token: Address;
  maxPerTx: bigint;
  maxDaily: bigint;
}

export interface SessionPermission {
  /** 允许调用的目标合约白名单（空 = 全部禁止） */
  targets: Address[];
  /** 允许的 selector 白名单（空 = 全部允许） */
  selectors?: Hex[];
  /** 单笔 ETH 限额（0 = 不限） */
  valueLimit?: bigint;
  /** 调用次数上限（0 = 不限） */
  countLimit?: number;
  /** 日消耗限额 */
  dailyLimit?: bigint;
  /** ERC-20 金额级限额（P0.12，§7.5）：命中 token 的标准 transfer/approve 受单笔/日累计约束 */
  tokenLimits?: TokenLimit[];
  /** 原生币任意地址转账授权（P0.12，§7.6）：哨兵 target 模式，data 必须为空且目标非合约（链上强制） */
  allowAnyTransfer?: { maxPerTx: bigint; maxDaily: bigint };
}

// ============================================================================
// UserOperation v0.7（对齐 §5.1，permissionless 已封装，SDK 层仅引用）
// ============================================================================

export interface UserOperationV7 {
  sender: Address; // Smart Account 地址（= Kernel 合约地址）
  nonce: bigint; // EntryPoint 管理的 nonce
  factory?: Address; // 首次部署时：KernelFactory
  factoryData?: Hex; // 部署参数（owner、index 等）
  callData: Hex; // execute(target, value, data) 编码
  callGasLimit: bigint; // 执行阶段 gas
  verificationGasLimit: bigint; // 验证阶段 gas
  preVerificationGas: bigint; // 补偿 bundler 的 gas
  maxFeePerGas: bigint; // EIP-1559
  maxPriorityFeePerGas: bigint; // EIP-1559 tip
  paymaster?: Address; // v0.7：paymaster 地址（与 initCode 拆分）
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterData?: Hex;
  signature: Hex;
}

/** 构建 UserOp 所需的链上上下文（provider 由调用方传入） */
export interface UserOpBuildContext {
  chainId: number;
  sender: Address;
  nonce: bigint;
  factory?: Address;
  factoryData?: Hex;
}

/** UserOp 发送结果 */
export interface UserOpResult {
  userOpHash: Hex;
  bundlerUrl: string;
  /** 轮询到的收据（可能为 null = 未确认） */
  receipt?: UserOpReceipt;
}

export interface UserOpReceipt {
  /** 收据事务哈希（ERC-4337 规范嵌套于 receipt.transactionHash；个别 bundler 可能缺失） */
  txHash?: Hex;
  success: boolean;
  actualGasCost: bigint;
  actualGasUsed: bigint;
  logs: unknown[];
}

// ============================================================================
// 部署 / 恢复
// ============================================================================

/** 社交恢复模块（MVP 后置，接口预留） */
export interface RecoveryConfig {
  moduleAddress: Address;
  guardians: Address[];
  threshold: number;
}

export type ChainId = number;
