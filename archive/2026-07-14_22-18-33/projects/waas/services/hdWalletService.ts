import { ethers } from 'ethers';
import { config } from '../config';
import { logger } from '../utils/logger';
import { Errors } from '../utils/errors';

/**
 * HD Wallet Service — BIP44 deterministic address derivation
 * Mirrors CWallet's backend/app/utils/wallet.py
 *
 * CWallet uses: m/44'/{coin_type}'/0'/0/{user_index}
 * We use the same path structure per BIP44 standard
 */

// BIP44 coin type constants
const COIN_TYPE: Record<string, number> = {
  '1': 60,       // Ethereum mainnet
  '11155111': 60, // Sepolia
  '56': 60,      // BSC
  '8453': 60,    // Base
  '137': 60,     // Polygon
  '42161': 60,   // Arbitrum
  '10': 60,      // Optimism
  'solana': 501, // Solana (placeholder)
};

/**
 * Derive an EVM address from HD wallet mnemonic
 * Path: m/44'/{coin_type}'/0'/0/{user_index}
 */
export function deriveEVMAddress(
  mnemonic: string,
  userIndex: number,
  chainId: string = '11155111'
): { address: string; derivationPath: string } {
  const coinType = COIN_TYPE[chainId] || 60;
  const derivationPath = `m/44'/${coinType}'/0'/0/${userIndex}`;

  try {
    const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, derivationPath);
    return { address: hdNode.address, derivationPath };
  } catch (err: any) {
    logger.error('HD derivation failed', { chainId, userIndex, error: err.message });
    throw Errors.internal('HD wallet derivation failed');
  }
}

/**
 * Derive private key for a specific derivation path
 */
export function getPrivateKey(mnemonic: string, derivationPath: string): string {
  try {
    const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, derivationPath);
    return hdNode.privateKey;
  } catch (err: any) {
    logger.error('Failed to get private key', { derivationPath, error: err.message });
    throw Errors.internal('Private key derivation failed');
  }
}

/**
 * Get the HD wallet mnemonic from config.
 * In production: 12-word seed phrase configured via .env
 */
let cachedMnemonic: string | null = null;

export function getHDMnemonic(): string {
  if (cachedMnemonic) return cachedMnemonic;

  const seed = config.hdWalletSeed;
  if (!seed) {
    // Dev mode: generate a deterministic wallet from dev key
    const { createHash } = require('crypto');
    const hash = createHash('sha256').update(process.env.HD_WALLET_SEED || 'infrax-ev-hd-seed').digest();
    // Convert hash to BIP39 mnemonic (12 words)
    // For dev, use ethers to create a random wallet and derive from seed
    cachedMnemonic = ethers.Mnemonic.fromEntropy(hash.slice(0, 16)).phrase;
    logger.warn('⚠️  HD_WALLET_SEED not configured — using dev wallet');
    return cachedMnemonic;
  }

  // Validate seed phrase
  try {
    ethers.Mnemonic.fromPhrase(seed);
    cachedMnemonic = seed;
    return seed;
  } catch {
    logger.warn('Invalid HD wallet seed phrase, falling back to dev mode');
    const { createHash } = require('crypto');
    const hash = createHash('sha256').update(process.env.HD_WALLET_SEED || 'infrax-ev-hd-seed').digest();
    cachedMnemonic = ethers.Mnemonic.fromEntropy(hash.slice(0, 16)).phrase;
    return cachedMnemonic;
  }
}

/**
 * Derive address from a numeric user index (stable, repeatable)
 * Same user_index always returns same address per chain
 */
export function deriveAddressForChain(
  userIndex: number,
  chainId: string
): { address: string; derivationPath: string } {
  const mnemonic = getHDMnemonic();
  return deriveEVMAddress(mnemonic, userIndex, chainId);
}

/**
 * Sign and send a transaction from a derived key
 * Returns tx hash
 */
export async function signAndSendTransaction(
  mnemonic: string,
  derivationPath: string,
  chainId: string,
  to: string,
  valueWei: string,
  rpcUrl: string
): Promise<string> {
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, derivationPath);
    const wallet = hdNode.connect(provider);

    const tx = await wallet.sendTransaction({
      to,
      value: BigInt(valueWei),
      chainId: BigInt(chainId),
    });

    logger.info('Transaction sent', {
      from: wallet.address,
      to,
      txHash: tx.hash,
      chainId,
    });

    return tx.hash;
  } catch (err: any) {
    logger.error('Transaction signing failed', { to, chainId, error: err.message });
    throw Errors.internal(`Transaction failed: ${err.message}`);
  }
}

/**
 * Get master wallet address for a chain (from config)
 * CWallet equivalent: settings.master_wallet_addresses[chain_id]
 */
export function getMasterWalletAddress(chainId: string): string | null {
  try {
    const addrs = JSON.parse(config.masterWalletAddresses || '{}');
    return addrs[chainId] || null;
  } catch {
    return null;
  }
}

/**
 * Get hot wallet address for a chain (from config)
 */
export function getHotWalletAddress(chainId: string): string | null {
  try {
    const addrs = JSON.parse(config.hotWalletAddresses || '{}');
    return addrs[chainId] || null;
  } catch {
    return null;
  }
}

/**
 * Get confirmation count requirement for a chain
 */
export function getMinConfirmations(chainId: string): number {
  try {
    const mins = JSON.parse(config.minConfirmations || '{"1":12,"11155111":3,"56":12,"8453":12}');
    return mins[chainId] || 3;
  } catch {
    return 3;
  }
}
