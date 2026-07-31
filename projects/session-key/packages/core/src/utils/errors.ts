export class AppError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  INVALID_SIGNATURE:   { statusCode: 401, code: 'INVALID_SIGNATURE',   msg: 'Invalid signature' },
  SESSION_NOT_FOUND:   { statusCode: 404, code: 'SESSION_NOT_FOUND',   msg: 'Session not found' },
  SESSION_EXPIRED:     { statusCode: 403, code: 'SESSION_EXPIRED',     msg: 'Session expired' },
  SESSION_REVOKED:     { statusCode: 403, code: 'SESSION_REVOKED',     msg: 'Session revoked' },
  CONTRACT_FORBIDDEN:  { statusCode: 403, code: 'CONTRACT_FORBIDDEN',  msg: 'Contract not whitelisted' },
  FUNCTION_FORBIDDEN:  { statusCode: 403, code: 'FUNCTION_FORBIDDEN',  msg: 'Function not whitelisted' },
  QUOTA_EXHAUSTED:     { statusCode: 403, code: 'QUOTA_EXHAUSTED',     msg: 'Quota exhausted' },
  PER_TX_EXCEEDED:     { statusCode: 403, code: 'PER_TX_EXCEEDED',     msg: 'Exceeds per-transaction limit' },
  PER_TOTAL_EXCEEDED:  { statusCode: 403, code: 'PER_TOTAL_EXCEEDED',  msg: 'Cumulative limit exceeded' },
  CHAIN_UNSUPPORTED:   { statusCode: 400, code: 'CHAIN_UNSUPPORTED',   msg: 'Chain not supported' },
  TX_FAILED:           { statusCode: 502, code: 'TX_FAILED',           msg: 'Transaction failed on chain' },
  NONCE_EXPIRED:       { statusCode: 400, code: 'NONCE_EXPIRED',       msg: 'Nonce expired, request a new one' },
  NONCE_INVALID:       { statusCode: 400, code: 'NONCE_INVALID',       msg: 'Nonce already used or invalid' },
  DUPLICATE_SESSION:   { statusCode: 409, code: 'DUPLICATE_SESSION',   msg: 'Active session already exists for this contract set' },
} as const;

export function apiResponse(data: unknown = null, message = 'success') {
  return { code: 200, message, data };
}

export function apiError(error: { statusCode: number; code: string; msg: string }, detail?: string) {
  return { code: error.statusCode, message: detail || error.msg, errorCode: error.code };
}
