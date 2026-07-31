import type { Chain, PermissionConfig } from '../types/index.js';
import type { SessionKey } from '../types/session.js';

/** Unified interface for blockchain operations — implemented by evm, sol, etc. */
export interface IBlockchainAdapter {
  /** Generate a new Session Key keypair */
  generateSessionKey(): { address: string; privateKey: string };

  /** Verify user's EIP-712 signature authorising a Session Key */
  verifySessionAuth(params: {
    userAddress: string;
    signature: string;
    nonce: string;
    chain: Chain;
    sessionAddress: string;
    permissions: PermissionConfig;
    validUntil: number;
    maxPerTx: string;
    maxTotal: string;
  }): Promise<boolean>;

  /** Sign a transaction with the Session Key and broadcast it */
  signAndBroadcast(params: {
    privateKey: string;
    chain: Chain;
    to: string;
    data: string;
    value?: string;
    gasLimit?: string;
  }): Promise<{ txHash: string; success: boolean; reason?: string; gasUsed?: string }>;

  /** Decrypt encrypted Session Key private key */
  decryptKey(encryptedKey: string): string;

  /** Encrypt Session Key private key */
  encryptKey(privateKey: string): string;
}
