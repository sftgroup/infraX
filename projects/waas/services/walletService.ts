import crypto from 'crypto';
import axios from 'axios';
import { ethers } from 'ethers';
import { config } from '../config';
import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { Errors } from '../utils/errors';
import { generateId } from '../utils/helpers';
import { deriveAddressForChain, getHDMnemonic, getPrivateKey } from './hdWalletService';
import { encryptPrivateKey } from './encryptionService';


interface CWalletBalanceResponse {
  chain: string;
  address: string;
  balances: Array<{
    token: string;
    token_address: string;
    balance: string;
    usd_value?: string;
  }>;
}

/**
 * Create a new custodial wallet for a user
 * Communicates with CWallet HSM service to generate HD wallet address
 */
export async function createCustodialWallet(
  userId: string,
  chain: string
): Promise<{ id: string; address: string; chain: string }> {
  if (!config.supportedChains.includes(chain)) {
    throw Errors.paramError(`Unsupported chain: ${chain}`);
  }

  const existing = await pool.query(
    'SELECT id, address, chain FROM custodial_wallets WHERE user_id = $1 AND chain = $2',
    [userId, chain]
  );
  if (existing.rows.length > 0) {
    const w = existing.rows[0];
    return { id: w.id, address: w.address, chain: w.chain };
  }

  const namespace = crypto.createHash('sha256').update(`${userId}:${chain}:pocketx`).digest();
  const userIndex = namespace.readUInt32BE(0) & 0x7FFFFFFF;
  const mnemonic = getHDMnemonic();
  const { address, derivationPath } = deriveAddressForChain(userIndex, chain);
  const privateKey = getPrivateKey(mnemonic, derivationPath);
  const encryptedKey = encryptPrivateKey(privateKey);

  const walletId = generateId();
  await pool.query(
    `INSERT INTO custodial_wallets (id, user_id, chain, address, encrypted_key)
     VALUES ($1, $2, $3, $4, $5)`,
    [walletId, userId, chain, address, encryptedKey]
  );

  await pool.query(
    'UPDATE users SET hd_wallet_id = COALESCE(hd_wallet_id, $1) WHERE id = $2',
    [walletId, userId]
  );

  logger.info('Custodial wallet created', { userId, chain, address, walletId });
  return { id: walletId, address, chain };
}

/**
 * Import existing HD wallet (user provides HD path)
 */
export async function importCustodialWallet(
  userId: string,
  chain: string,
  hdPath: string
): Promise<{ id: string; address: string; chain: string }> {
  if (!config.supportedChains.includes(chain)) {
    throw Errors.paramError(`Unsupported chain: ${chain}`);
  }

  const existing = await pool.query(
    'SELECT id, address FROM custodial_wallets WHERE user_id = $1 AND chain = $2',
    [userId, chain]
  );
  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, address: existing.rows[0].address, chain };
  }

  const walletId = generateId();
  await pool.query(
    `INSERT INTO custodial_wallets (id, user_id, chain, address)
     VALUES ($1, $2, $3, $4)`,
    [walletId, userId, chain, hdPath]
  );

  logger.info('Custodial wallet imported', { userId, chain, hdPath, walletId });
  return { id: walletId, address: hdPath, chain };
}

/**
 * Get deposit/payment address for a user on a specific chain
 */
export async function getWalletAddress(userId: string, chain: string): Promise<string> {
  const result = await pool.query(
    'SELECT address FROM custodial_wallets WHERE user_id = $1 AND chain = $2',
    [userId, chain]
  );

  if (result.rows.length > 0) {
    return result.rows[0].address;
  }

  const derived = deriveAddressForChain(0, chain);
  return derived.address;
}

/**
 * Get aggregated balance across all chains
 */
export async function getAggregatedBalance(userId: string): Promise<{
  chainBalances: Array<{ chain: string; address: string; balances: any[]; usdTotal: string; error?: string }>;
  totalUsd: string;
}> {
  const wallets = await pool.query(
    'SELECT id, chain, address FROM custodial_wallets WHERE user_id = $1',
    [userId]
  );

  if (wallets.rows.length === 0) {
    return { chainBalances: [], totalUsd: '0' };
  }

  const chainBalances: Array<{ chain: string; address: string; balances: any[]; usdTotal: string; error?: string }> = [];
  let totalUsd = 0;

  for (const wallet of wallets.rows) {
    try {
      const resp = await axios.get(
        `${config.cwallet.baseUrl}/balance?chain=${wallet.chain}&address=${wallet.address}`,
        {
          headers: { 'x-api-key': config.cwallet.apiKey },
          timeout: 10000,
        }
      );
      const data: CWalletBalanceResponse = resp.data;
      const chainTotal = data.balances.reduce(
        (sum, b) => sum + parseFloat(b.usd_value || '0'),
        0
      );
      totalUsd += chainTotal;
      const localTotal = data.balances.reduce(
        (sum: number, b: any) => sum + parseFloat(b.balance || '0'),
        0
      );
      await pool.query(
        'UPDATE custodial_wallets SET balance = $1 WHERE id = $2',
        [localTotal.toFixed(18), wallet.id]
      ).catch(() => {});

      chainBalances.push({
        chain: wallet.chain,
        address: wallet.address,
        balances: data.balances,
        usdTotal: chainTotal.toFixed(2),
      });
    } catch (err: any) {
      logger.warn('Failed to fetch balance', { chain: wallet.chain, error: err.message });
      chainBalances.push({
        chain: wallet.chain, address: wallet.address,
        balances: [], usdTotal: '0', error: 'CWallet API unavailable',
      });
    }
  }

  return { chainBalances, totalUsd: totalUsd.toFixed(2) };
}

/**
 * Get transaction history for user's wallets
 */
export async function getTransactionHistory(
  userId: string,
  offset: number,
  limit: number
): Promise<{ items: any[]; total: number }> {
  const countResult = await pool.query(
    `SELECT COUNT(*)::int as total FROM transactions t
     JOIN custodial_wallets w ON t.wallet_id = w.id
     WHERE w.user_id = $1`,
    [userId]
  );
  const total = countResult.rows[0].total;

  const result = await pool.query(
    `SELECT t.*, w.chain, w.address as wallet_address
     FROM transactions t
     JOIN custodial_wallets w ON t.wallet_id = w.id
     WHERE w.user_id = $1
     ORDER BY t.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  return { items: result.rows, total };
}

/**
 * Get HD wallet detail + tokens for a specific chain
 */
export async function getWalletDetail(userId: string, chainId: string): Promise<{
  walletId: string;
  chainId: number;
  address: string;
  tokens: Array<{
    assetId: string;
    symbol: string;
    name: string;
    chainId: number;
    balance: string;
    balanceFormatted: string;
    usdValue?: number;
  }>;
} | null> {
  // Accept both numeric chain ID and string chain name
  const chainIdNum = parseInt(chainId, 10);
  const chainName = isNaN(chainIdNum) ? chainId.toLowerCase() : String(chainIdNum);

  const addr = await pool.query(
    'SELECT id, address FROM custodial_wallets WHERE user_id = $1 AND chain = $2 LIMIT 1',
    [userId, chainName]
  );

  let walletId: string;
  let address: string;
  if (addr.rows.length > 0) {
    walletId = addr.rows[0].id;
    address = addr.rows[0].address;
  } else {
    try {
      const derived = deriveAddressForChain(0, chainName);
      walletId = '';
      address = derived.address;
    } catch {
      return null;
    }
  }

  return {
    walletId,
    chainId: isNaN(chainIdNum) ? 11155111 : chainIdNum, // default Sepolia
    address,
    tokens: [],
  };
}

// ══════════════════════════════════════════════════════════════
// Non-Custodial (NC) Wallet — Direct RPC chain queries
// Reads on-chain data via RPC instead of cwallet HSM service
// ══════════════════════════════════════════════════════════════

/** Chain name → RPC URL lookup */
function getRpcUrl(chain: string): string {
  const rpcs: Record<string, string | undefined> = {
    sepolia: config.chainRpc?.sepolia || config.sepoliaRpcUrl,
    eth: config.chainRpc?.eth || config.ethRpcUrl || config.sepoliaRpcUrl,
    ethereum: config.chainRpc?.eth || config.ethRpcUrl || config.sepoliaRpcUrl,
    base: config.chainRpc?.base || config.baseRpcUrl,
    bsc: config.chainRpc?.bsc || config.bscRpcUrl,
  };
  const url = rpcs[chain.toLowerCase()];
  if (!url) throw Errors.paramError(`Unsupported NC chain: ${chain}`);
  return url;
}

// Minimal ERC20 ABI for balanceOf + decimals + symbol
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

/**
 * Get ETH balance for an address on a chain via RPC
 */
async function getEthBalance(
  provider: ethers.JsonRpcProvider,
  address: string
): Promise<{ balance: string; balanceFormatted: string }> {
  const raw = await provider.getBalance(address);
  const formatted = ethers.formatEther(raw);
  return { balance: raw.toString(), balanceFormatted: formatted };
}

/**
 * Get NC wallet native + ERC20 balance across configured chains
 */
export async function getNCBalance(
  walletAddress: string,
  targetChains?: string[]
): Promise<{
  chainBalances: Array<{
    chain: string;
    address: string;
    balances: Array<{
      token: string;
      token_address: string;
      balance: string;
      usd_value: string;
    }>;
    usdTotal: string;
    error?: string;
  }>;
  totalUsd: string;
}> {
  const chains = targetChains || config.supportedChains.filter(c =>
    ['sepolia', 'eth', 'ethereum', 'base', 'bsc'].includes(c)
  );

  const chainBalances: any[] = [];
  let totalUsd = 0;

  for (const chain of chains) {
    try {
      const rpcUrl = getRpcUrl(chain);
      const provider = new ethers.JsonRpcProvider(rpcUrl);

      // ETH balance
      const ethBal = await getEthBalance(provider, walletAddress);
      const balances: any[] = [{
        token: chain === 'sepolia' ? 'sETH' : 'ETH',
        token_address: 'native',
        balance: ethBal.balanceFormatted,
        usd_value: '0.00', // Placeholder — coin prices from oracle later
      }];

      chainBalances.push({
        chain,
        address: walletAddress,
        balances,
        usdTotal: '0.00',
      });
    } catch (err: any) {
      logger.warn('NC balance fetch failed', { chain, address: walletAddress, error: err.message });
      chainBalances.push({
        chain,
        address: walletAddress,
        balances: [],
        usdTotal: '0',
        error: `RPC unavailable: ${chain}`,
      });
    }
  }

  return { chainBalances, totalUsd: totalUsd.toFixed(2) };
}

/**
 * Get transaction history for NC wallet by scanning chain
 * Uses ethers to query recent blocks and filter by address
 */
export async function getNCTransactions(
  walletAddress: string,
  chain: string = 'sepolia',
  options?: { page?: number; limit?: number; type?: string }
): Promise<{
  items: any[];
  pagination: { total: number; page: number; limit: number; totalPages: number };
}> {
  const page = options?.page || 1;
  const limit = options?.limit || 10;

  try {
    const rpcUrl = getRpcUrl(chain);
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // Fetch recent blocks and scan for transactions involving walletAddress
    const currentBlock = await provider.getBlockNumber();
    const scanDepth = 500; // Scan last 500 blocks
    const fromBlock = Math.max(0, currentBlock - scanDepth);

    const txs: any[] = [];
    const addrLower = walletAddress.toLowerCase();

    for (let b = currentBlock; b >= fromBlock && txs.length < page * limit + 10; b--) {
      try {
        const block = await provider.getBlock(b, true);
        if (!block || !block.transactions) continue;
        for (const rawTx of block.transactions) {
          if (typeof rawTx === 'string') continue; // skip hash-only
          const tx = rawTx as ethers.TransactionResponse;
          if (
            (tx.from && tx.from.toLowerCase() === addrLower) ||
            (tx.to && tx.to.toLowerCase() === addrLower)
          ) {
            const dir = tx.from.toLowerCase() === addrLower ? 'send' : 'receive';
            txs.push({
              txHash: tx.hash,
              type: dir,
              from: tx.from,
              to: tx.to,
              amount: ethers.formatEther(tx.value),
              token_symbol: chain === 'sepolia' ? 'sETH' : 'ETH',
              token: chain === 'sepolia' ? 'sETH' : 'ETH',
              timestamp: null,
              status: 'confirmed',
              blockNumber: tx.blockNumber,
            });
          }
        }
      } catch {
        // Skip blocks that fail to fetch
        continue;
      }
    }

    // Sort by block number descending
    txs.sort((a, b) => (b.blockNumber || 0) - (a.blockNumber || 0));

    const total = txs.length;
    const start = (page - 1) * limit;
    const paged = txs.slice(start, start + limit);

    return {
      items: paged,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  } catch (err: any) {
    logger.warn('NC tx history failed', { address: walletAddress, chain, error: err.message });
    return { items: [], pagination: { total: 0, page: 1, limit, totalPages: 1 } };
  }
}

/**
 * Get ERC20 token metadata (symbol, decimals, name) from contract
 */
export async function getTokenInfo(
  chain: string,
  tokenAddress: string
): Promise<{ symbol: string; decimals: number; name: string }> {
  const rpcUrl = getRpcUrl(chain);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  const [symbol, decimals] = await Promise.all([
    contract.symbol().catch(() => '???'),
    contract.decimals().catch(() => 18),
  ]);

  // decimals may be BigInt in some cases, normalize
  const dec = typeof decimals === 'bigint' ? Number(decimals) : decimals;
  return { symbol, decimals: dec, name: '' };
}

/**
 * Get ERC20 token balance for a wallet
 */
export async function getTokenBalance(
  chain: string,
  tokenAddress: string,
  walletAddress: string
): Promise<{ balance: string; balanceFormatted: string; symbol: string; decimals: number }> {
  const rpcUrl = getRpcUrl(chain);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  const [balance, decimals, symbol] = await Promise.all([
    contract.balanceOf(walletAddress).catch(() => 0n),
    contract.decimals().catch(() => 18),
    contract.symbol().catch(() => '???'),
  ]);

  const dec = typeof decimals === 'bigint' ? Number(decimals) : decimals;
  const formatted = ethers.formatUnits(balance, dec);
  return { balance: balance.toString(), balanceFormatted: formatted, symbol, decimals: dec };
}

/**
 * Get NFTs owned by a wallet address on a given chain
 * Scans ERC-721 Transfer events where the wallet is the recipient
 */
export async function getNFTs(
  address: string,
  chain: string
): Promise<Array<{ token_id: string; contract_address: string; token_name?: string; symbol?: string }>> {
  const rpcUrl = getRpcUrl(chain);
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // ERC-721 Transfer event: Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const toTopic = ethers.zeroPadValue(address.toLowerCase(), 32);

  // Look back 10000 blocks (~1 day on Sepolia)
  const block = await provider.getBlockNumber();
  const fromBlock = Math.max(0, block - 10000);

  const logs = await provider.getLogs({
    fromBlock,
    toBlock: block,
    topics: [transferTopic, null, toTopic],
  });

  // Deduplicate by contract+tokenId (keep latest transfer)
  const seen = new Set<string>();
  const nfts: Array<{ token_id: string; contract_address: string; token_name?: string; symbol?: string }> = [];

  for (const log of logs) {
    const tokenId = BigInt(log.topics[3]).toString();
    const contractAddr = log.address;
    const key = `${contractAddr.toLowerCase()}_${tokenId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Try to get token metadata (optional, skip on failure)
    try {
      const contract = new ethers.Contract(contractAddr, ['function name() view returns (string)', 'function symbol() view returns (string)'], provider);
      const [name, symbol] = await Promise.all([
        contract.name().catch(() => ''),
        contract.symbol().catch(() => ''),
      ]);
      nfts.push({ token_id: tokenId, contract_address: contractAddr, token_name: name || undefined, symbol: symbol || undefined });
    } catch {
      nfts.push({ token_id: tokenId, contract_address: contractAddr });
    }
  }

  return nfts;
}
