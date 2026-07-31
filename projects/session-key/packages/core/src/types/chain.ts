export type Chain = 'eth' | 'bsc' | 'base' | 'polygon' | 'arbitrum' | 'optimism' | 'xlayer' | 'sol';

export const CHAIN_IDS: Record<Chain, number> = {
  eth: 1, bsc: 56, base: 8453, polygon: 137,
  arbitrum: 42161, optimism: 10, xlayer: 196, sol: 0,
};

export function isChain(value: string): value is Chain {
  return Object.keys(CHAIN_IDS).includes(value);
}
