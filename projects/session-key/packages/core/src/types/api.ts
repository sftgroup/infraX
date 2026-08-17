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
  /** A-16：session key 由客户端生成并提交——公钥地址（= 签名消息中的 sessionAddress） */
  sessionPublicKey: string;
  /** A-16：客户端生成的会话私钥（服务端校验与公钥派生一致后 AES 加密托管） */
  sessionPrivateKey: string;
  /** 客户端 EIP-712 签名时使用的 validUntil（unix 秒），需与签名消息一致；省略则服务端计算 */
  validUntil?: number;
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
