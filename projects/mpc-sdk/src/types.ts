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
  id: string;
  email: string;
  walletAddress: string;
  createdAt: string;
}

export interface MPCRecoverParams {
  email: string;
  /** sendCode 下发到邮箱的 6 位验证码 */
  code: string;
  /**
   * 可选：期望恢复出的钱包地址。提供时 SDK 在服务端恢复成功后做客户端地址校验，
   * 不一致则抛 MpcApiError（409, ERR_RECOVER_ADDRESS_MISMATCH）。
   */
  expectedAddress?: string;
}

export interface MPCRecoverResult {
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
}

export interface MPCStatusResult {
  registered: boolean;
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

// ─── 会话模块（E-5c，3 tools）───

export interface MPCSessionUnlockParams {
  email: string;
  /** sendCode 下发的 6 位验证码（解锁即再次验证邮箱所有权） */
  code: string;
}

export interface MPCSessionUnlockResult {
  /** 会话令牌，后续会话/链上操作的凭证（mpc_ 前缀） */
  token: string;
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
