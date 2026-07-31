import { Redis } from 'ioredis';
import type { Chain, PermissionConfig } from '@sftgroup/session-key-core';
import { generateNonce, normalizeAddress, AppError, Errors, encrypt, loadEncryptionKey, decrypt } from '@sftgroup/session-key-core';
import { SessionRepo } from '../repos/session-repo.js';
import { ExecutionRepo } from '../repos/execution-repo.js';
import {
  generateSessionKey,
  signAndBroadcast, verifySessionAuthSignature, buildRpcRegistry,
} from '@sftgroup/session-key-evm';

export class SessionService {
  private nonceStore = new Map<string, { nonce: string; expiresAt: number }>();

  constructor(
    private sessionRepo: SessionRepo,
    private executionRepo: ExecutionRepo,
    private redis: Redis,
  ) {}

  // ── Nonce ────────────────────────────────────────────────────────────

  getNonce(userId: string): { nonce: string; message: string } {
    const normalized = normalizeAddress(userId);
    const { nonce, expiresAt } = generateNonce();
    this.nonceStore.set(normalized, { nonce, expiresAt });

    const message = `Session Key Engine\n\nAuthorise a session key to execute transactions on your behalf.\n\nNonce: ${nonce}`;
    return { nonce, message };
  }

  consumeNonce(userId: string, nonce: string): void {
    const normalized = normalizeAddress(userId);
    const record = this.nonceStore.get(normalized);
    if (!record) throw new AppError(Errors.NONCE_INVALID.statusCode, Errors.NONCE_INVALID.code, Errors.NONCE_INVALID.msg);
    if (Date.now() > record.expiresAt) {
      this.nonceStore.delete(normalized);
      throw new AppError(Errors.NONCE_EXPIRED.statusCode, Errors.NONCE_EXPIRED.code, Errors.NONCE_EXPIRED.msg);
    }
    if (record.nonce !== nonce) {
      throw new AppError(Errors.NONCE_INVALID.statusCode, Errors.NONCE_INVALID.code, Errors.NONCE_INVALID.msg);
    }
    this.nonceStore.delete(normalized);
  }

  // ── Create Session ───────────────────────────────────────────────────

  async create(params: {
    signature: string;
    chain: Chain;
    permissions: PermissionConfig;
    validDays: number;
    maxPerTx: string;
    maxTotal: string;
    userAddress: string;
    nonce: string;
  }) {
    // 1. Consume nonce (prevents replay)
    this.consumeNonce(params.userAddress, params.nonce);

    // 2. Check for duplicate active session (same user + chain + contracts)
    const existing = await this.sessionRepo.findActiveByUserAndContracts(
      params.userAddress, params.chain, params.permissions.contracts
    );
    if (existing) {
      throw new AppError(Errors.DUPLICATE_SESSION.statusCode, Errors.DUPLICATE_SESSION.code, Errors.DUPLICATE_SESSION.msg);
    }

    // 3. Generate fresh Session Key keypair
    const keypair = generateSessionKey();
    const validUntil = Math.floor(Date.now() / 1000) + params.validDays * 86400;

    // 4. Verify EIP-712 signature
    const isValid = await verifySessionAuthSignature({
      userAddress: params.userAddress,
      signature: params.signature,
      nonce: params.nonce,
      chain: params.chain,
      sessionAddress: keypair.address,
      permissions: params.permissions,
      validUntil,
      maxPerTx: params.maxPerTx,
      maxTotal: params.maxTotal,
    });
    if (!isValid) {
      throw new AppError(Errors.INVALID_SIGNATURE.statusCode, Errors.INVALID_SIGNATURE.code, Errors.INVALID_SIGNATURE.msg);
    }

    // 5. Encrypt private key
    const encryptKey = loadEncryptionKey();
    const encKey = encrypt(keypair.privateKey, encryptKey);

    // 6. Persist
    const session = await this.sessionRepo.create({
      userId: params.userAddress,
      chain: params.chain,
      sessionAddress: keypair.address,
      sessionKeyEnc: encKey,
      validUntil: new Date(validUntil * 1000),
      permissions: params.permissions,
      maxPerTx: params.maxPerTx,
      maxTotal: params.maxTotal,
    });

    return { id: session.id, sessionAddress: keypair.address, status: session.status, validUntil: session.validUntil };
  }

  // ── List Sessions ────────────────────────────────────────────────────

  async list(userId: string, chain?: string, status?: string) {
    const validStatus = ['active','revoked','expired','quota_exhausted'].includes(status || '')
      ? status as any : undefined;
    return this.sessionRepo.findByUser(userId, chain, validStatus);
  }

  // ── Get Session ──────────────────────────────────────────────────────

  async get(id: string) {
    const session = await this.sessionRepo.findById(id);
    if (!session) throw new AppError(Errors.SESSION_NOT_FOUND.statusCode, Errors.SESSION_NOT_FOUND.code, Errors.SESSION_NOT_FOUND.msg);
    return session;
  }

  // ── Revoke ───────────────────────────────────────────────────────────

  async revoke(id: string) {
    const session = await this.sessionRepo.findById(id);
    if (!session) throw new AppError(Errors.SESSION_NOT_FOUND.statusCode, Errors.SESSION_NOT_FOUND.code, Errors.SESSION_NOT_FOUND.msg);
    const ok = await this.sessionRepo.revoke(id);
    return { revoked: ok };
  }

  // ── Execute ──────────────────────────────────────────────────────────

  async execute(params: {
    sessionId: string;
    chain: Chain;
    to: string;
    data: string;
    value?: string;
    gasLimit?: string;
  }) {
    // Distributed lock — prevents concurrent execution on same session
    const lockKey = `lock:session:${params.sessionId}`;
    const locked = await this.redis.set(lockKey, '1', 'EX', 30, 'NX');
    if (!locked) throw new AppError(429, 'SESSION_LOCKED', 'Session is currently executing another transaction');

    try {
      const session = await this.sessionRepo.findById(params.sessionId);
      if (!session) throw new AppError(Errors.SESSION_NOT_FOUND.statusCode, Errors.SESSION_NOT_FOUND.code, Errors.SESSION_NOT_FOUND.msg);
      if (session.status === 'expired') throw new AppError(Errors.SESSION_EXPIRED.statusCode, Errors.SESSION_EXPIRED.code, Errors.SESSION_EXPIRED.msg);
      if (session.status === 'revoked') throw new AppError(Errors.SESSION_REVOKED.statusCode, Errors.SESSION_REVOKED.code, Errors.SESSION_REVOKED.msg);
      if (session.status === 'quota_exhausted') throw new AppError(Errors.QUOTA_EXHAUSTED.statusCode, Errors.QUOTA_EXHAUSTED.code, Errors.QUOTA_EXHAUSTED.msg);

      // Contract whitelist check
      const normalizedTo = params.to.toLowerCase();
      if (!session.permissions.contracts.some(c => c.toLowerCase() === normalizedTo)) {
        throw new AppError(Errors.CONTRACT_FORBIDDEN.statusCode, Errors.CONTRACT_FORBIDDEN.code, Errors.CONTRACT_FORBIDDEN.msg);
      }

      // Function selector whitelist check
      const selector = params.data.slice(0, 10);
      if (session.permissions.functions?.length && !session.permissions.functions.includes(selector)) {
        throw new AppError(Errors.FUNCTION_FORBIDDEN.statusCode, Errors.FUNCTION_FORBIDDEN.code, Errors.FUNCTION_FORBIDDEN.msg);
      }

      // Decrypt private key → sign → broadcast
      const encryptKey = loadEncryptionKey();
      const privateKey = decrypt(session.sessionKeyEnc, encryptKey);
      const rpcRegistry = buildRpcRegistry();
      const rpcUrl = rpcRegistry[params.chain];

      const result = await signAndBroadcast({
        privateKey,
        chain: params.chain,
        rpcUrl,
        to: params.to,
        data: params.data,
        value: params.value,
        gasLimit: params.gasLimit,
      });

      // Record execution
      await this.executionRepo.insert({
        sessionId: params.sessionId,
        txHash: result.txHash,
        contract: params.to,
        functionSig: selector,
        value: params.value || '0',
        status: result.success ? 'success' : 'failed',
        errorReason: result.reason,
      });

      return {
        executionId: crypto.randomUUID(),
        txHash: result.txHash || '',
        status: result.success ? 'success' as const : 'failed' as const,
        gasUsed: result.gasUsed,
        errorReason: result.reason,
      };
    } finally {
      await this.redis.del(lockKey);
    }
  }
}
