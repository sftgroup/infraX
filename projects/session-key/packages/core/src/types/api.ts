import type { PermissionConfig } from './session.js';

export interface CreateSessionRequest {
  signature: string;
  chain: string;
  permissions: PermissionConfig;
  validDays: number;
  maxPerTx: string;
  maxTotal: string;
  userAddress: string;
  nonce: string;
  sessionAddress: string;
}

export interface ExecuteRequest {
  sessionId: string;
  chain: string;
  to: string;
  data: string;
  value?: string;
  gasLimit?: string;
}

export interface ExecuteResult {
  executionId: string;
  txHash: string;
  status: 'success' | 'failed';
  gasUsed?: string;
  errorReason?: string;
}

export interface NonceData {
  nonce: string;
  message: string;
  expiresIn: number;
}
