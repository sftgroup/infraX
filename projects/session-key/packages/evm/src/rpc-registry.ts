import type { Chain } from '@0xinfrax/session-key-core';
import { CHAIN_IDS, env } from '@0xinfrax/session-key-core';
import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PublicClient, WalletClient, Account, Transport } from 'viem';

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

const publicClientCache = new Map<string, PublicClient>();
let rpcRegistry: Record<string, string> | null = null;

function getRpcRegistry(): Record<string, string> {
  // 懒加载：仅在首次实际使用 RPC 时读取环境变量，import 包本身不要求 env
  if (rpcRegistry === null) rpcRegistry = buildRpcRegistry();
  return rpcRegistry;
}

export function getPublicClient(chain: string): PublicClient {
  const cached = publicClientCache.get(chain);
  if (cached) return cached;
  const rpcUrl = getRpcRegistry()[chain];
  if (!rpcUrl) throw new Error(`No RPC URL for chain: ${chain}`);
  const client = createPublicClient({ transport: http(rpcUrl) });
  publicClientCache.set(chain, client);
  return client;
}

export function getWalletClient(chain: string, account: Account): WalletClient<Transport, any, any> {
  const rpcUrl = getRpcRegistry()[chain];
  if (!rpcUrl) throw new Error(`No RPC URL for chain: ${chain}`);
  return createWalletClient({ account, transport: http(rpcUrl) });
}

export function getChainId(chain: string): number {
  const id = CHAIN_IDS[chain as Chain];
  if (!id) throw new Error(`Unsupported chain: ${chain}`);
  return id;
}

export function buildViemChain(chain: Chain, rpcUrl: string) {
  const chainId = getChainId(chain);
  return defineChain({
    id: chainId,
    name: chain,
    nativeCurrency: { decimals: 18, name: 'ETH', symbol: 'ETH' },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
