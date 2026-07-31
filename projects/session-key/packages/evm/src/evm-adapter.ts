import type { IBlockchainAdapter } from '@sftgroup/session-key-core';
import { encrypt, decrypt, loadEncryptionKey } from '@sftgroup/session-key-core';
import { generateSessionKey, verifySessionAuthSignature } from './eip712.js';
import { signAndBroadcast } from './tx-executor.js';
import { buildRpcRegistry } from './rpc-registry.js';
import type { Chain } from '@sftgroup/session-key-core';

/**
 * EVM chain adapter — implements IBlockchainAdapter for all EVM-compatible chains.
 * Wraps eip712 + tx-executor + rpc-registry modules under a single interface.
 */
export class EvmAdapter implements IBlockchainAdapter {
  constructor(private rpcUrls: Record<string, string> = buildRpcRegistry()) {}

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

  decryptKey(encryptedKey: string): string {
    return decrypt(encryptedKey, loadEncryptionKey());
  }

  encryptKey(privateKey: string): string {
    return encrypt(privateKey, loadEncryptionKey());
  }
}
