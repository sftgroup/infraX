import { AppError, Errors } from '@0xinfrax/session-key-core';
import type { IBlockchainAdapter, Chain, PermissionConfig } from '@0xinfrax/session-key-core';
import { deriveAddressFromPrivateKey } from '@0xinfrax/session-key-evm';
import { SessionRepo } from '../repos/session-repo.js';
import type { SessionKey } from '@0xinfrax/session-key-core';

export class SessionService {
  constructor(
    private sessionRepo: SessionRepo,
    private adapter: IBlockchainAdapter,
  ) {}

  async create(params: {
    signature: string; chain: Chain; permissions: PermissionConfig;
    validDays: number; maxPerTx: string; maxTotal: string;
    userAddress: string; nonce: string;
    sessionPublicKey: string; sessionPrivateKey: string;
    validUntil?: number;
  }) {
    // A-16 修复：session key 由客户端生成并提交（EIP-712 签名消息含 sessionAddress，
    // 服务端无法在客户端签名前预知随机地址——原服务端生成 keypair 的流程存在签名死锁）。
    // 服务端做格式 + 派生一致性硬校验后加密存储，execute 时解密代签。
    if (!/^0x[0-9a-fA-F]{40}$/.test(params.sessionPublicKey)) {
      throw new AppError(400, 'SESSION_KEY_INVALID', 'sessionPublicKey must be a 0x-prefixed 40-hex address');
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(params.sessionPrivateKey)) {
      throw new AppError(400, 'SESSION_KEY_INVALID', 'sessionPrivateKey must be a 0x-prefixed 64-hex private key');
    }
    const derived = deriveAddressFromPrivateKey(params.sessionPrivateKey).toLowerCase();
    if (derived !== params.sessionPublicKey.toLowerCase()) {
      throw new AppError(400, 'SESSION_KEY_MISMATCH', 'sessionPrivateKey does not match sessionPublicKey');
    }

    // Check for duplicate
    const existing = await this.sessionRepo.findActiveByUserAndContracts(
      params.userAddress, params.chain, params.permissions.contracts
    );
    if (existing) {
      throw new AppError(Errors.DUPLICATE_SESSION.statusCode, Errors.DUPLICATE_SESSION.code, Errors.DUPLICATE_SESSION.msg);
    }

    // validUntil 默认服务端计算；客户端显式提交时（签名消息内一致值）做窗口校验，
    // 避免"客户端签名时的秒值 ≠ 服务端请求时的秒值"导致 EIP-712 校验偶发失败（时钟竞态）。
    const now = Math.floor(Date.now() / 1000);
    let validUntil = now + params.validDays * 86400;
    if (params.validUntil !== undefined) {
      if (!Number.isInteger(params.validUntil)) {
        throw new AppError(400, 'SESSION_KEY_INVALID', 'validUntil must be an integer unix timestamp');
      }
      if (params.validUntil <= now) {
        throw new AppError(400, 'SESSION_KEY_EXPIRED', 'validUntil must be in the future');
      }
      if (params.validUntil > now + params.validDays * 86400) {
        throw new AppError(400, 'SESSION_KEY_INVALID', 'validUntil exceeds the validDays window');
      }
      validUntil = params.validUntil;
    }

    // Verify signature（sessionAddress = 客户端提交的公钥地址）
    const isValid = await this.adapter.verifySessionAuth({
      userAddress: params.userAddress,
      signature: params.signature,
      nonce: params.nonce,
      chain: params.chain,
      sessionAddress: params.sessionPublicKey,
      permissions: params.permissions,
      validUntil,
      maxPerTx: params.maxPerTx,
      maxTotal: params.maxTotal,
    });
    if (!isValid) {
      throw new AppError(Errors.INVALID_SIGNATURE.statusCode, Errors.INVALID_SIGNATURE.code, Errors.INVALID_SIGNATURE.msg);
    }

    // Encrypt and persist（AX-12/SK-4: 走 IKeyVault 接缝，可替换为 KMS/外部托管）
    const encKey = await this.adapter.encryptKey(params.sessionPrivateKey);
    const session = await this.sessionRepo.create({
      userId: params.userAddress,
      chain: params.chain,
      sessionAddress: params.sessionPublicKey,
      sessionKeyEnc: encKey,
      validUntil: new Date(validUntil * 1000),
      permissions: params.permissions,
      maxPerTx: params.maxPerTx,
      maxTotal: params.maxTotal,
    });

    return { id: session.id, sessionAddress: params.sessionPublicKey, status: session.status, validUntil: session.validUntil };
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
