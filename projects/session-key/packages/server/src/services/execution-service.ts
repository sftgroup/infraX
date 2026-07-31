import { AppError, Errors } from '@stevenwang000x/session-key-core';
import type { IBlockchainAdapter, Chain } from '@stevenwang000x/session-key-core';
import { SessionRepo } from '../repos/session-repo.js';
import { ExecutionRepo } from '../repos/execution-repo.js';
import { Redis } from 'ioredis';

export class ExecutionService {
  constructor(
    private sessionRepo: SessionRepo,
    private executionRepo: ExecutionRepo,
    private adapter: IBlockchainAdapter,
    private redis: Redis,
  ) {}

  async execute(params: {
    sessionId: string; chain: Chain; to: string; data: string;
    value?: string; gasLimit?: string;
  }) {
    const lockKey = `lock:session:${params.sessionId}`;
    const locked = await this.redis.set(lockKey, '1', 'EX', 30, 'NX');
    if (!locked) throw new AppError(429, 'SESSION_LOCKED', 'Session is currently executing');

    try {
      const session = await this.sessionRepo.findById(params.sessionId);
      if (!session) throw new AppError(Errors.SESSION_NOT_FOUND.statusCode, Errors.SESSION_NOT_FOUND.code, Errors.SESSION_NOT_FOUND.msg);
      if (session.status === 'expired') throw new AppError(Errors.SESSION_EXPIRED.statusCode, Errors.SESSION_EXPIRED.code, Errors.SESSION_EXPIRED.msg);
      if (session.status === 'revoked') throw new AppError(Errors.SESSION_REVOKED.statusCode, Errors.SESSION_REVOKED.code, Errors.SESSION_REVOKED.msg);
      if (session.status === 'quota_exhausted') throw new AppError(Errors.QUOTA_EXHAUSTED.statusCode, Errors.QUOTA_EXHAUSTED.code, Errors.QUOTA_EXHAUSTED.msg);

      // Contract whitelist
      const normalizedTo = params.to.toLowerCase();
      if (!session.permissions.contracts.some(c => c.toLowerCase() === normalizedTo)) {
        throw new AppError(Errors.CONTRACT_FORBIDDEN.statusCode, Errors.CONTRACT_FORBIDDEN.code, Errors.CONTRACT_FORBIDDEN.msg);
      }

      // Function selector whitelist
      const selector = params.data.slice(0, 10);
      if (session.permissions.functions?.length && !session.permissions.functions.includes(selector)) {
        throw new AppError(Errors.FUNCTION_FORBIDDEN.statusCode, Errors.FUNCTION_FORBIDDEN.code, Errors.FUNCTION_FORBIDDEN.msg);
      }

      // Decrypt → sign → broadcast
      const privateKey = this.adapter.decryptKey(session.sessionKeyEnc);
      const result = await this.adapter.signAndBroadcast({
        privateKey,
        chain: params.chain,
        to: params.to,
        data: params.data,
        value: params.value,
        gasLimit: params.gasLimit,
      });

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
