import { AppError, Errors } from '@sftgroup/session-key-core';
import type { IBlockchainAdapter, Chain, PermissionConfig } from '@sftgroup/session-key-core';
import { SessionRepo } from '../repos/session-repo.js';
import type { SessionKey } from '@sftgroup/session-key-core';

export class SessionService {
  constructor(
    private sessionRepo: SessionRepo,
    private adapter: IBlockchainAdapter,
  ) {}

  async create(params: {
    signature: string; chain: Chain; permissions: PermissionConfig;
    validDays: number; maxPerTx: string; maxTotal: string;
    userAddress: string; nonce: string;
  }) {
    // Check for duplicate
    const existing = await this.sessionRepo.findActiveByUserAndContracts(
      params.userAddress, params.chain, params.permissions.contracts
    );
    if (existing) {
      throw new AppError(Errors.DUPLICATE_SESSION.statusCode, Errors.DUPLICATE_SESSION.code, Errors.DUPLICATE_SESSION.msg);
    }

    // Generate Session Key keypair
    const keypair = this.adapter.generateSessionKey();
    const validUntil = Math.floor(Date.now() / 1000) + params.validDays * 86400;

    // Verify signature
    const isValid = await this.adapter.verifySessionAuth({
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

    // Encrypt and persist
    const encKey = this.adapter.encryptKey(keypair.privateKey);
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

  async list(userId: string, chain?: string, status?: string) {
    const validStatus = ['active','revoked','expired','quota_exhausted'].includes(status || '')
      ? status as any : undefined;
    return this.sessionRepo.findByUser(userId, chain, validStatus);
  }

  async get(id: string) {
    const session = await this.sessionRepo.findById(id);
    if (!session) throw new AppError(Errors.SESSION_NOT_FOUND.statusCode, Errors.SESSION_NOT_FOUND.code, Errors.SESSION_NOT_FOUND.msg);
    return session;
  }

  async revoke(id: string) {
    const session = await this.sessionRepo.findById(id);
    if (!session) throw new AppError(Errors.SESSION_NOT_FOUND.statusCode, Errors.SESSION_NOT_FOUND.code, Errors.SESSION_NOT_FOUND.msg);
    const ok = await this.sessionRepo.revoke(id);
    return { revoked: ok };
  }
}
