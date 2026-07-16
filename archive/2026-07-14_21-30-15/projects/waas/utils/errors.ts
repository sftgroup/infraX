/** AppError — standard operational error with HTTP status code and API error code */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, code: number, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/** Error codes matching the API spec */
export const ErrorCode = {
  SUCCESS: 0,
  PARAM_ERROR: 1001,
  UNAUTHORIZED: 1002,
  PAYMENT_PASSWORD_ERROR: 1003,
  INSUFFICIENT_BALANCE: 2001,
  RISK_BLOCKED: 2002,
  GAS_INSUFFICIENT: 2003,
  MULTISIG_NOT_REACHED: 3001,
  INTERNAL_ERROR: 5000,
} as const;

/** Pre-built error factories */
export const Errors = {
  paramError: (msg: string) => new AppError(msg, 400, ErrorCode.PARAM_ERROR),
  unauthorized: (msg = 'Not authenticated') => new AppError(msg, 401, ErrorCode.UNAUTHORIZED),
  forbidden: (msg = 'Forbidden') => new AppError(msg, 403, ErrorCode.UNAUTHORIZED),
  paymentPasswordError: () => new AppError('Payment password is incorrect', 403, ErrorCode.PAYMENT_PASSWORD_ERROR),
  insufficientBalance: () => new AppError('Insufficient balance', 400, ErrorCode.INSUFFICIENT_BALANCE),
  riskBlocked: (reason: string) => new AppError(`Transaction blocked by risk control: ${reason}`, 403, ErrorCode.RISK_BLOCKED),
  gasInsufficient: () => new AppError('Gas pool insufficient', 400, ErrorCode.GAS_INSUFFICIENT),
  internal: (msg = 'Internal server error') => new AppError(msg, 500, ErrorCode.INTERNAL_ERROR, false),
  notFound: (resource: string) => new AppError(`${resource} not found`, 404, ErrorCode.PARAM_ERROR),
  invalidInput: (field: string) => new AppError(`Invalid input: ${field}`, 400, ErrorCode.PARAM_ERROR),
};
