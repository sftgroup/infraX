// ============================================================================
// 错误分类（对齐 docs/AA_SDK_TECH_DESIGN.md §5.7）
// AAxx = EntryPoint 错误码，RPC 层错误包装为 BundlerError / PaymasterError。
// ============================================================================

/** EntryPoint AA 错误码（v0.7） */
export enum AAErrorCode {
  /** AA24: 签名错误 → 需要重签 */
  SignatureError = 'AA24',
  /** AA10: 已处理（同 nonce 幂等）→ 视为成功 */
  AlreadyReverted = 'AA10',
  /** AA31: paymaster 拒绝 */
  PaymasterDepositTooLow = 'AA31',
  /** AA32: paymaster 验证失败 */
  PaymasterValidation = 'AA32',
  /** AA33: paymaster 余额不足 */
  PaymasterPostOpFailed = 'AA33',
  /** AA20: 账户未部署或无效 */
  AccountDoesNotExist = 'AA20',
  /** AA21: 过期用户Op（时间戳） */
  Expired = 'AA21',
  /** AA23: 无效签名（revert 或无签名） */
  InvalidSignature = 'AA23',
  /** AA25: 无效账户（initCode 不满足规则） */
  InvalidAccount = 'AA25',
  /** AA40: 超过验证阶段时间上限 */
  VerificationTimedOut = 'AA40',
  /** AA91: 后续用户Op需相同 sender/initCode */
  SenderMismatch = 'AA91',
}

export interface AAError extends Error {
  code: AAErrorCode | string;
  /** 原始错误对象 */
  cause?: unknown;
  /** AA10（已处理）时为 true，可安全视为成功 */
  isIdempotent: boolean;
  /** 是否需要重试（网络类） */
  retriable: boolean;
}

export function isAAError(e: unknown): e is AAError {
  return typeof e === 'object' && e !== null && 'code' in e;
}

/** 从任意错误提取 AA 错误码 */
export function extractAAErrorCode(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/\b(AA\d{2})\b/);
  return m ? m[1] : null;
}

/**
 * 归一化错误：分类 AA 错误码 / Bundler RPC 错误。
 * AA10 → isIdempotent=true（视为成功）；AA24 → retriable=true（重签后重发）。
 */
export function toAAError(e: unknown): AAError {
  const code = extractAAErrorCode(e);
  const err = e instanceof Error ? e : new Error(String(e));
  const aaErr = Object.assign(err, { code: code ?? 'UNKNOWN', cause: e }) as AAError;
  aaErr.isIdempotent = code === AAErrorCode.AlreadyReverted;
  // 无 AA 码 = 网络/RPC 层错误 → 可重试切端点；AA24（重签）、AA21/AA40（过期/超时）→ 可重试
  aaErr.retriable =
    code === null ||
    code === AAErrorCode.SignatureError ||
    code === AAErrorCode.Expired ||
    code === AAErrorCode.VerificationTimedOut;
  return aaErr;
}

/** Bundler 层错误（RPC 失败 / 超时 / 余额不足等） */
export class BundlerError extends Error {
  constructor(
    message: string,
    public readonly bundlerUrl?: string,
    public readonly retriable = true,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BundlerError';
  }
}

/** Paymaster 层错误 */
export class PaymasterError extends Error {
  constructor(
    message: string,
    public readonly paymasterUrl?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PaymasterError';
  }
}

/** 配置缺失错误（开发期快速暴露） */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
