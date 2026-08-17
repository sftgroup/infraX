import type { IBlockchainAdapter, IKeyVault } from '@0xinfrax/session-key-core';
import { EnvKeyVault } from '@0xinfrax/session-key-core';
import { generateSessionKey, verifySessionAuthSignature } from './eip712.js';
import { signAndBroadcast } from './tx-executor.js';
import { buildRpcRegistry } from './rpc-registry.js';
import type { Chain } from '@0xinfrax/session-key-core';

/**
 * EVM chain adapter — implements IBlockchainAdapter for all EVM-compatible chains.
 * Wraps eip712 + tx-executor + rpc-registry modules under a single interface.
 *
 * AX-12/SK-4: 第二个参数是可选的密钥托管接缝（IKeyVault）。默认 EnvKeyVault
 * （ENCRYPTION_KEY + AES-256-GCM）；集成方可注入 KMS/外部密钥服务实现，让
 * 会话私钥不落明文 env。
 */
export class EvmAdapter implements IBlockchainAdapter {
  constructor(
    private rpcUrls: Record<string, string> = buildRpcRegistry(),
    private keyVault: IKeyVault = new EnvKeyVault(),
  ) {}

  generateSessionKey() {
    return generateSessionKey();
  }

  async verifySessionAuth(params: Parameters<IBlockchainAdapter['verifySessionAuth']>[0]) {
    return verifySessionAuthSignature(params);
  }

  async signAndBroadcast(params: { privateKey: string; chain: Chain; to: string; data: string; value?: string; gasLimit?: string }) {
    const rpcUrl = this.rpcUrls[params.chain];
    if (!rpcUrl) throw new Error(`No RPC URL for chain: ${params.chain}`);
    return signAndBroadcast({ ...params, rpcUrl });
  }

  decryptKey(encryptedKey: string): Promise<string> {
    return this.keyVault.decrypt(encryptedKey);
  }

  encryptKey(privateKey: string): Promise<string> {
    return this.keyVault.encrypt(privateKey);
  }
}
