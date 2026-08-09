/**
 * @0xinfrax/mpc-sdk — 错误类型与语义错误码
 *
 * 对齐 MPC API 错误语义：
 *   HTTP 401 — 未授权（缺 key / 会话不存在 / 会话过期）
 *   HTTP 403 — 禁止（外部签发 key 被禁用等）
 *   HTTP 429 — 验证码尝试次数超限（server 返回 "Too many attempts"）
 *   HTTP 4xx/5xx 携带 JSON 信封时 — MpcApiError 保留业务 code（1001 参数错误 / 1004 未注册 /
 *       1006 邮箱已注册 / 1007 分片解密失败 / 1008 密钥重建不一致）
 *   SDK 侧客户端校验失败 — 语义错误码（40900 起，如恢复地址不一致）
 */

/** 业务错误码（与 MPC server apiResponse code 对齐） */
export const MPC_ERR_CODE = {
  BAD_REQUEST: 1001,      // 参数缺失/非法
  WALLET_NOT_FOUND: 1004, // 未注册，需先 register
  EMAIL_EXISTS: 1006,     // 邮箱已注册，需走 recover
  DECRYPT_FAILED: 1007,   // 分片解密失败
  KEY_MISMATCH: 1008,     // 密钥重建与钱包地址不一致
} as const;

/** SDK 侧语义错误码（服务端无此码，客户端校验产生） */
export const MPC_SDK_ERR_CODE = {
  RECOVER_ADDRESS_MISMATCH: 40900, // 恢复地址与 expectedAddress 不一致
} as const;

/** 语义错误类别（供调用方分支判断，含 HTTP 状态 + 业务码 + SDK 码） */
export type MpcErrorKind =
  | 'unauthorized'        // 401
  | 'forbidden'           // 403
  | 'rate_limited'        // 429
  | 'bad_request'         // 400
  | 'not_found'           // 404
  | 'conflict'            // 409（含 SDK 地址不一致）
  | 'server_error'        // 5xx
  | 'network';            // 网络/超时

export function classifyError(status: number): MpcErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'bad_request';
}

/** MPC API / SDK 统一错误 */
export class MpcApiError extends Error {
  /** HTTP 状态码（SDK 侧校验失败用 409 表示冲突） */
  readonly status: number;
  /** 业务 code（服务端 1001/1004/1006/1007/1008 或 SDK 40900 起） */
  readonly code: number;
  /** 语义类别 */
  readonly kind: MpcErrorKind;
  /** 原始响应 body（如可解析） */
  readonly body: any;

  constructor(status: number, code: number, message: string, body?: any) {
    super(message);
    this.name = 'MpcApiError';
    this.status = status;
    this.code = code;
    this.kind = classifyError(status);
    this.body = body;
  }
}

/** 网络层错误（请求未到达服务端 / 超时 / 响应非 JSON） */
export class MpcNetworkError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MpcNetworkError';
    this.cause = cause;
  }
}
