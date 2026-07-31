import type { Chain, PermissionConfig } from '@sftgroup/session-key-core';
import { CHAIN_IDS } from '@sftgroup/session-key-core';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  createPublicClient,
  createWalletClient,
  http,
  verifyTypedData,
  defineChain,
  type Account,
  type PublicClient,
  type WalletClient,
  type Transport,
} from 'viem';
import { env } from '@sftgroup/session-key-core';

// ─── RPC Registry ──────────────────────────────────────────────────────────

export function buildRpcRegistry(): Record<string, string> {
  return {
    eth:       env('ETH_RPC_URL'),
    bsc:       env('BSC_RPC_URL'),
    base:      env('BASE_RPC_URL'),
    polygon:   env('POLYGON_RPC_URL'),
    arbitrum:  env('ARBITRUM_RPC_URL'),
    optimism:  env('OPTIMISM_RPC_URL'),
    xlayer:    env('XLAYER_RPC_URL'),
  };
}

// ─── Wallet Clients ────────────────────────────────────────────────────────

const publicClientCache = new Map<string, PublicClient>();
const rpcRegistry = buildRpcRegistry();

export function getPublicClient(chain: string): PublicClient {
  const cached = publicClientCache.get(chain);
  if (cached) return cached;
  const rpcUrl = rpcRegistry[chain];
  if (!rpcUrl) throw new Error(`No RPC URL for chain: ${chain}`);
  const client = createPublicClient({ transport: http(rpcUrl) });
  publicClientCache.set(chain, client);
  return client;
}

export function getWalletClient(chain: string, account: Account): WalletClient<Transport, any, any> {
  const rpcUrl = rpcRegistry[chain];
  if (!rpcUrl) throw new Error(`No RPC URL for chain: ${chain}`);
  return createWalletClient({ account, transport: http(rpcUrl) });
}

// ─── EIP-712 Session Auth Message ──────────────────────────────────────────

export function buildSessionAuthMessage(params: {
  nonce: string;
  chainId: number;
  sessionAddress: string;
  permissions: PermissionConfig;
  validUntil: number;       // unix timestamp (seconds)
  maxPerTx: string;         // wei string
  maxTotal: string;         // wei string
}) {
  const domain = {
    name: 'Session Key Engine',
    version: '1',
    chainId: params.chainId,
  } as const;

  const types = {
    SessionAuth: [
      { name: 'nonce', type: 'string' },
      { name: 'sessionAddress', type: 'address' },
      { name: 'contracts', type: 'string' },
      { name: 'validUntil', type: 'uint256' },
      { name: 'maxPerTx', type: 'uint256' },
      { name: 'maxTotal', type: 'uint256' },
    ],
  } as const;

  const value = {
    nonce: params.nonce,
    sessionAddress: params.sessionAddress as `0x${string}`,
    contracts: JSON.stringify(params.permissions.contracts),
    validUntil: BigInt(params.validUntil),
    maxPerTx: BigInt(params.maxPerTx),
    maxTotal: BigInt(params.maxTotal),
  };

  return { domain, types, primaryType: 'SessionAuth' as const, message: value };
}

/** Verify user's EIP-712 signature authorising a Session Key */
export async function verifySessionAuthSignature(params: {
  userAddress: string;
  signature: string;
  nonce: string;
  chain: Chain;
  sessionAddress: string;
  permissions: PermissionConfig;
  validUntil: number;
  maxPerTx: string;
  maxTotal: string;
}): Promise<boolean> {
  const chainId = CHAIN_IDS[params.chain];
  if (!chainId) return false;

  const message = buildSessionAuthMessage({
    nonce: params.nonce,
    chainId,
    sessionAddress: params.sessionAddress,
    permissions: params.permissions,
    validUntil: params.validUntil,
    maxPerTx: params.maxPerTx,
    maxTotal: params.maxTotal,
  });

  return verifyTypedData({
    address: params.userAddress as `0x${string}`,
    ...message,
    signature: params.signature as `0x${string}`,
  });
}

// ─── Session Key Generation ────────────────────────────────────────────────

/** Generate a new Session Key keypair (used by the engine, not the user) */
export function generateSessionKey(): { address: string; privateKey: string } {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  return { address: account.address, privateKey: pk };
}

// ─── Transaction Signing + Broadcasting ─────────────────────────────────────

export async function signAndBroadcast(params: {
  privateKey: string;
  chain: Chain;
  rpcUrl: string;
  to: string;
  data: string;
  value?: string;
  gasLimit?: string;
}): Promise<{ txHash: string; success: boolean; reason?: string; gasUsed?: string }> {
  const account = privateKeyToAccount(params.privateKey as `0x${string}`);

  // Build viem chain object from RPC URL and chain ID
  const chainId = CHAIN_IDS[params.chain];
  if (!chainId) throw new Error(`Unsupported chain: ${params.chain}`);
  const viemChain = defineChain({
    id: chainId,
    name: params.chain,
    nativeCurrency: { decimals: 18, name: 'ETH', symbol: 'ETH' },
    rpcUrls: { default: { http: [params.rpcUrl] } },
  });

  const publicClient = createPublicClient({ transport: http(params.rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(params.rpcUrl) });

  try {
    let gas: bigint;
    if (params.gasLimit) {
      gas = BigInt(params.gasLimit);
    } else {
      gas = await publicClient.estimateGas({
        account: account.address,
        to: params.to as `0x${string}`,
        data: params.data as `0x${string}`,
        value: params.value ? BigInt(params.value) : undefined,
      });
    }

    const hash = await walletClient.sendTransaction({
      account,
      chain: viemChain,
      to: params.to as `0x${string}`,
      data: params.data as `0x${string}`,
      value: params.value ? BigInt(params.value) : 0n,
      gas,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    return {
      txHash: hash,
      success: receipt.status === 'success',
      gasUsed: receipt.gasUsed.toString(),
    };
  } catch (err: any) {
    return {
      txHash: '',
      success: false,
      reason: err.message || 'Unknown error',
    };
  }
}
