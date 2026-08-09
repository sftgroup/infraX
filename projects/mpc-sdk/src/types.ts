/**
 * @0xinfrax/mpc-sdk — MPC 服务契约类型
 *
 * 对齐 `projects/mpc/server.ts` 的 15 个端点（本包首期覆盖钱包模块 5 方法 + 会话模块 3 方法）。
 * 响应信封统一为 `{ code, message, data }`（code=0 成功；业务错误码见 errors.ts 说明）。
 */

// ─── 通用信封 ───

export interface MpcApiResponse<T = any> {
  code: number;
  message: string;
  data: T;
}

// ─── 钱包模块（E-5b，5 tools）───

export interface MPCSendCodeParams {
  /** 注册/恢复接收验证码的邮箱 */
  email: string;
}

export interface MPCSendCodeResult {
  message: string;
}

export interface MPCRegisterParams {
  email: string;
  /** sendCode 下发到邮箱的 6 位验证码 */
  code: string;
  /** 可选：关联外部钱包地址（也可经 x-wallet-address 头传递） */
  walletAddress?: string;
}

export interface MPCWalletResult {
  /** 钱包 ID（E-4④：同邮箱 1:N，walletId 唯一定位子钱包；recover/unlock/status 按此定位） */
  walletId: string;
  email: string;
  walletAddress: string;
  createdAt: string;
}

export interface MPCRecoverParams {
  email: string;
  /** sendCode 下发到邮箱的 6 位验证码 */
  code: string;
  /** 可选：指定子钱包（E-4④）；缺省恢复同邮箱首个（向后兼容） */
  walletId?: string;
  /**
   * 可选：期望恢复出的钱包地址。提供时 SDK 在服务端恢复成功后做客户端地址校验，
   * 不一致则抛 MpcApiError（409, ERR_RECOVER_ADDRESS_MISMATCH）。
   */
  expectedAddress?: string;
}

export interface MPCRecoverResult {
  walletId: string;
  email: string;
  walletAddress: string;
  recoveredAt: string;
  recoveryCount: number;
}

export interface MPCStatusParams {
  /** 双查询键二选一：邮箱 */
  email?: string;
  /** 双查询键二选一：钱包地址（兼容 connected_wallet_address 与 wallet_address） */
  walletAddress?: string;
  /** 可选：指定子钱包（E-4④）；缺省 = 同邮箱首个（向后兼容） */
  walletId?: string;
}

export interface MPCStatusResult {
  registered: boolean;
  walletId?: string;
  email?: string;
  walletAddress?: string;
  emailVerified?: boolean;
  shardCount?: number;
  totalShards?: number;
  createdAt?: string;
  lastRecoveredAt?: string | null;
  recoveryCount?: number;
  status?: string;
}

// ─── 钱包列表（E-4④：单邮箱 1:N 子钱包） ───

export interface MPCWalletsListParams {
  email: string;
}

export interface MPCWalletsListItem {
  walletId: string;
  walletAddress: string;
  emailVerified: boolean;
  shardCount: number;
  totalShards: number;
  createdAt: string;
  lastRecoveredAt: string | null;
  recoveryCount: number;
  status: string;
}

export interface MPCWalletsListResult {
  email: string;
  count: number;
  wallets: MPCWalletsListItem[];
}

// ─── 会话模块（E-5c，3 tools）───

export interface MPCSessionUnlockParams {
  email: string;
  /** sendCode 下发的 6 位验证码（解锁即再次验证邮箱所有权） */
  code: string;
  /** 可选：指定子钱包（E-4④）；缺省解锁同邮箱首个（向后兼容） */
  walletId?: string;
}

export interface MPCSessionUnlockResult {
  /** 会话令牌，后续会话/链上操作的凭证（mpc_ 前缀） */
  token: string;
  /** 解锁的子钱包 ID（E-4④） */
  walletId: string;
  address: string;
  unlockedAt: string;
  expiresAt: string;
}

export interface MPCSessionLockResult {
  /** 是否存在并已锁定该会话 */
  locked: boolean;
}

export interface MPCSessionStatusParams {
  token: string;
}

export interface MPCSessionStatusResult {
  unlocked: boolean;
  address?: string;
  unlockedAt?: string;
  expiresAt?: string;
  remainingSeconds?: number;
}

// ─── 链上模块（E-5d，7 tools）───
// 对齐 `projects/mpc/server.ts` 的 7 个链上端点。所有交易类数量参数均为字符串
// （服务端契约 parseUnits/parseEther 自理，避免大整数 JSON 序列化问题）。

/** 链上操作公共参数 */
export interface MPCChainBaseParams {
  /** 会话令牌（session.unlock 返回，绑定到具体子钱包） */
  token: string;
  /** 链名：sepolia / eth / bsc / base / oxa，默认 sepolia */
  chain?: string;
}

/** GET /api/v2/mpc/balance */
export interface MPCBalanceParams extends MPCChainBaseParams {
  /** 可选：ERC20 合约地址；不传 = 仅查原生币余额 */
  tokenAddress?: string;
}

export interface MPCBalanceTokenResult {
  address: string;
  symbol: string;
  balance: string;
  decimals: number;
}

export interface MPCBalanceResult {
  address: string;
  chain: string;
  nativeBalance: string;
  nativeSymbol: string;
  /** 传入 tokenAddress 时存在；查询失败时为 { address, error } */
  token?: MPCBalanceTokenResult | { address: string; error: string };
}

/** POST /api/v2/mpc/sign-message（EIP-191 personal_sign 语义） */
export interface MPCSignMessageParams {
  token: string;
  /** 待签名原始消息文本 */
  message: string;
}

/** 签名端点统一返回（sign-message / sign-typed-data） */
export interface MPCSignResult {
  /** 65 字节序列化签名（0x + r||s||v，ethers Signature.serialized） */
  signature: string;
  /** 签名钱包地址 */
  address: string;
}

/** POST /api/v2/mpc/sign-typed-data（EIP-712） */
export interface MPCSignTypedDataParams {
  token: string;
  /** EIP-712 domain（如 { name, version, chainId, verifyingContract }） */
  domain: Record<string, any>;
  /** EIP-712 types（如 { Person: [...], Mail: [...] }） */
  types: Record<string, Array<{ name: string; type: string }>>;
  /** 待签名消息值 */
  value: Record<string, any>;
}

/** POST /api/v2/mpc/send-transaction */
export interface MPCSendTransactionParams extends MPCChainBaseParams {
  /** 收款地址 */
  to: string;
  /** 数量（字符串）：原生币 = 币种数量（如 '0.01'）；ERC20 = token 数量 */
  amount: string;
  /** 可选：ERC20 合约地址；不传 = 原生币转账 */
  tokenAddress?: string;
}

export interface MPCSendTransactionResult {
  txHash: string;
  from: string;
  to: string;
  amount: string;
  chain: string;
  /** 'native' 或 ERC20 合约地址 */
  token: string;
  blockNumber?: number;
  gasUsed?: string;
}

/** POST /api/v2/mpc/contract-read */
export interface MPCContractReadParams extends MPCChainBaseParams {
  contractAddress: string;
  /** 合约 ABI（至少含所调方法；可传全量 ABI） */
  abi: any[];
  method: string;
  /** 方法参数（bigint 需先转字符串，服务端契约透传） */
  args?: any[];
}

export interface MPCContractReadResult {
  contractAddress: string;
  method: string;
  /** 只读调用返回值（bigint 由服务端转字符串） */
  result: any;
}

/** POST /api/v2/mpc/contract-write */
export interface MPCContractWriteParams extends MPCChainBaseParams {
  contractAddress: string;
  abi: any[];
  method: string;
  args?: any[];
  /** 可选：随交易发送的原生币数量（ETH 单位字符串） */
  value?: string;
  /** 可选：自定义 gas limit（字符串） */
  gasLimit?: string;
}

export interface MPCContractWriteResult {
  txHash: string;
  from: string;
  contractAddress: string;
  method: string;
  chain: string;
  blockNumber?: number;
  gasUsed?: string;
}

/** POST /api/v2/mpc/gas-estimate */
export interface MPCGasEstimateParams extends MPCChainBaseParams {
  /** 可选：目标地址（缺省 = 部署/估算场景） */
  to?: string;
  /** 可选：随交易发送的原生币数量（字符串） */
  value?: string;
  /** 可选：calldata（0x 前缀 hex） */
  data?: string;
}

export interface MPCGasEstimateResult {
  chain: string;
  gasLimit: string;
  gasPrice: string;
  estimatedCost: string;
  estimatedCostWei: string;
}

// ─── 客户端配置 ───

export interface MpcClientConfig {
  /**
   * MPC 服务地址。生产默认 http://127.0.0.1:9104（infrax-mpc 服务端口），
   * 跨机/公网调用时改为可达地址（如经 nginx 反代或 SSH 隧道）。
   */
  baseUrl?: string;
  /** MPC 服务鉴权 key（出站统一 X-API-Key 头；服务端支持 Bearer/X-API-Key/X-Service-Key 三选一） */
  apiKey?: string;
  /** 请求超时（毫秒），默认 30000 */
  timeout?: number;
}
