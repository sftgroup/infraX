import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { Errors } from '../utils/errors';
import { GatewayProvider, chainToChainId } from './gatewayProvider';
import { getMinConfirmations } from './hdWalletService';

/**
 * BE-07: Block Scanner & Deposit Service
 * (F-020, L-004) Scans blocks → matches addresses → writes balance → fires webhook
 *
 * W-1: 入账原子化——单事务内「去重插入 transactions → 余额 UPDATE → webhook INSERT」，
 *      唯一索引 uq_transactions_wallet_txhash + ON CONFLICT 兜底并发重复扫描。
 * W-2: 确认数门槛——扫描到先落 deposit_pending，块确认数满足后才入账（两段式）。
 */

interface BlockScanResult {
  chain: string;
  blockNumber: number;
  deposits: Array<{
    from: string;
    to: string;
    amount: string;
    token: string;
    tokenAddress: string;
    txHash: string;
  }>;
}

/**
 * Scan the latest block for a chain via CWallet
 */
export async function scanBlock(chain: string): Promise<BlockScanResult> {
  try {
    const resp = await axios.post(
      `${config.cwallet.baseUrl}/scan-block`,
      { chain },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.cwallet.apiKey,
        },
        timeout: 30000,
      }
    );
    return resp.data;
  } catch (err: any) {
    logger.warn(`Block scan failed for ${chain}`, { error: err.message });
    throw Errors.internal(`Block scan failed for ${chain}`);
  }
}

/** ERC20 原生占位地址判定（与现有代码口径一致） */
function isNativeToken(tokenAddress: string): boolean {
  return !tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000';
}

/**
 * 校验该钱包的租户是否启用了该 ERC20 token（原生币恒放行）
 */
async function checkTenantToken(
  walletId: string,
  chain: string,
  tokenAddress: string,
  client?: any
): Promise<boolean> {
  if (isNativeToken(tokenAddress)) return true;
  const q = client ?? pool;
  const result = await q.query(
    `SELECT tt.id FROM tenant_tokens tt
     JOIN custodial_wallets cw ON cw.tenant_id = tt.tenant_id
     WHERE cw.id = $1 AND tt.chain_id = $2 AND tt.contract_address = $3 AND tt.enabled = true`,
    [walletId, chain === 'sepolia' ? 11155111 : 1, tokenAddress.toLowerCase()]
  );
  return result.rows.length > 0;
}

/**
 * 入账核心（调用方持有事务连接）。
 * 去重插入 transactions；仅当真正插入（非重复）时才更新余额并建 webhook。
 * 返回 true=本笔新入账；false=重复/跳过。
 */
async function creditDeposit(
  client: any,
  args: {
    chain: string;
    blockNumber: number;
    deposit: { from: string; to: string; amount: string; token: string; tokenAddress: string; txHash: string };
    walletId: string;
    userId: string;
  }
): Promise<boolean> {
  const { chain, blockNumber, deposit, walletId, userId } = args;

  // 去重兜底：唯一索引 + ON CONFLICT（并发扫描窗口不再可能重复入账）
  const inserted = await client.query(
    `INSERT INTO transactions (id, wallet_id, from_address, to_address, amount, token_address,
      gas_sponsored, tx_hash, status, risk_result, signature_strategy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', '{}', 'auto')
     ON CONFLICT (wallet_id, tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash <> ''
     DO NOTHING
     RETURNING id`,
    [uuidv4(), walletId, deposit.from, deposit.to, deposit.amount,
     deposit.tokenAddress, false, deposit.txHash]
  );
  if (inserted.rows.length === 0) {
    logger.debug('Skipping duplicate deposit', { txHash: deposit.txHash, walletId });
    return false;
  }

  // Update custodial wallet balance
  await client.query(
    `UPDATE custodial_wallets
     SET balance = balance + $1, updated_at = NOW()
     WHERE id = $2`,
    [deposit.amount, walletId]
  );

  // Update hot wallet balance for the tenant (for SaaS dashboard)
  if (!isNativeToken(deposit.tokenAddress)) {
    await client.query(
      `UPDATE hot_wallet_balances hwb
       SET balance = balance + $1, last_scanned_block = $2, updated_at = NOW()
       FROM tenant_tokens tt, custodial_wallets cw
       WHERE hwb.token_id = tt.id AND cw.tenant_id = tt.tenant_id
         AND cw.id = $3 AND tt.contract_address = $4`,
      [deposit.amount, blockNumber, walletId, deposit.tokenAddress.toLowerCase()]
    );
  } else {
    await client.query(
      `UPDATE hot_wallet_balances hwb
       SET balance = balance + $1, last_scanned_block = $2, updated_at = NOW()
       FROM custodial_wallets cw
       WHERE hwb.tenant_id = cw.tenant_id AND cw.id = $3
         AND hwb.contract_address = '0x0000000000000000000000000000000000000000'`,
      [deposit.amount, blockNumber, walletId]
    );
  }

  // Create webhook event (deposit type)
  await client.query(
    `INSERT INTO webhook_events (id, event_type, user_id, wallet_id, payload, status)
     VALUES ($1, 'deposit', $2, $3, $4, 'pending')`,
    [
      uuidv4(),
      userId || null,
      walletId,
      JSON.stringify({
        type: 'deposit',
        chain,
        blockNumber,
        txHash: deposit.txHash,
        from: deposit.from,
        to: deposit.to,
        amount: deposit.amount,
        token: deposit.token,
        tokenAddress: deposit.tokenAddress,
      }),
    ]
  );

  logger.info('Deposit processed', {
    chain,
    txHash: deposit.txHash,
    address: deposit.to,
    amount: deposit.amount,
    userId,
  });
  return true;
}

/**
 * W-2: 判断某笔充值的确认数是否已满足（receipt 块号 + 当前块号）
 * 返回 null 表示无法取到 receipt/块高（本轮跳过，下轮重试）。
 */
async function confirmationsMet(
  chain: string,
  txHash: string,
  currentBlock: number | null,
  provider: GatewayProvider
): Promise<boolean | null> {
  let receipt: any;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err: any) {
    logger.warn('Receipt lookup failed, skipping for this cycle', { chain, txHash, error: err.message });
    return null;
  }
  const txBlock = receipt?.blockNumber ?? null;
  if (txBlock === null || currentBlock === null) {
    return false; // 未上链或无法确认 → 仍视为待确认
  }
  const needed = getMinConfirmations(String(chainToChainId(chain)));
  return currentBlock - txBlock >= needed;
}

/**
 * Process a block scan result — match addresses, update balances, create webhook events
 * W-1: 全程单事务；W-2: 未达确认数先落 deposit_pending。
 */
export async function processDeposits(scanResult: BlockScanResult): Promise<number> {
  const { chain, blockNumber, deposits } = scanResult;
  let processedCount = 0;

  // W-2: 确认数门槛需要的链上上下文
  let provider: GatewayProvider | null = null;
  let currentBlock: number | null = null;
  try {
    provider = new GatewayProvider(chain);
    currentBlock = await provider.getBlockNumber();
  } catch (err: any) {
    logger.warn('Chain height unavailable, treating all deposits as pending', { chain, error: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const deposit of deposits) {
      // Match the receiving address against our custodial wallets
      const walletResult = await client.query(
        'SELECT id, user_id FROM custodial_wallets WHERE address = $1 AND chain = $2',
        [deposit.to.toLowerCase(), chain]
      );

      if (walletResult.rows.length === 0) {
        continue; // Not one of our addresses
      }
      const wallet = walletResult.rows[0];

      // For ERC20 deposits, check the token belongs to this wallet's tenant
      if (!(await checkTenantToken(wallet.id, chain, deposit.tokenAddress, client))) {
        continue; // Token not configured by this tenant — skip
      }

      // W-2: 确认数门槛 —— 未达确认数的先入待确认表
      if (provider && currentBlock !== null) {
        const met = await confirmationsMet(chain, deposit.txHash, currentBlock, provider);
        if (met === null) continue; // 取不到 receipt，下轮重试
        if (!met) {
          await client.query(
            `INSERT INTO deposit_pending (id, chain, tx_hash, wallet_id, from_address, to_address, amount, token_address, block_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (chain, tx_hash) DO NOTHING`,
            [uuidv4(), chain, deposit.txHash, wallet.id, deposit.from, deposit.to,
             deposit.amount, deposit.tokenAddress, blockNumber]
          );
          logger.debug('Deposit awaiting confirmations', { chain, txHash: deposit.txHash, needed: 'pending' });
          continue;
        }
      }

      if (await creditDeposit(client, { chain, blockNumber, deposit, walletId: wallet.id, userId: wallet.user_id })) {
        processedCount++;
      }
    }

    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK');
    logger.error('processDeposits failed, rolled back', { chain, error: err.message });
    throw err;
  } finally {
    client.release();
  }

  return processedCount;
}

/**
 * W-2: 把确认数已满足的待确认充值入账（幂等）。
 */
export async function confirmPendingDeposits(chain: string): Promise<number> {
  let provider: GatewayProvider | null = null;
  let currentBlock: number | null = null;
  try {
    provider = new GatewayProvider(chain);
    currentBlock = await provider.getBlockNumber();
  } catch (err: any) {
    logger.warn('Chain height unavailable, skipping pending confirmation', { chain, error: err.message });
    return 0;
  }

  const pendingResult = await pool.query(
    'SELECT * FROM deposit_pending WHERE chain = $1 ORDER BY created_at ASC LIMIT 100',
    [chain]
  );
  if (pendingResult.rows.length === 0) return 0;

  let credited = 0;
  for (const row of pendingResult.rows) {
    const met = await confirmationsMet(chain, row.tx_hash, currentBlock, provider!);
    if (met !== true) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const walletRow = await client.query(
        'SELECT user_id FROM custodial_wallets WHERE id = $1',
        [row.wallet_id]
      );
      if (await checkTenantToken(row.wallet_id, chain, row.token_address, client)) {
        const deposit = {
          from: row.from_address,
          to: row.to_address,
          amount: row.amount,
          token: '*',
          tokenAddress: row.token_address,
          txHash: row.tx_hash,
        };
        const userId = walletRow.rows[0]?.user_id || null;
        if (await creditDeposit(client, { chain, blockNumber: Number(row.block_number), deposit, walletId: row.wallet_id, userId })) {
          credited++;
        }
      }
      await client.query('DELETE FROM deposit_pending WHERE id = $1', [row.id]);
      await client.query('COMMIT');
    } catch (err: any) {
      await client.query('ROLLBACK');
      logger.error('confirmPendingDeposits row failed', { chain, txHash: row.tx_hash, error: err.message });
    } finally {
      client.release();
    }
  }
  return credited;
}

/**
 * Run a full scan cycle across all supported chains
 */
export async function scanAllChains(): Promise<{
  chains: number;
  depositsProcessed: number;
}> {
  let totalDeposits = 0;
  let chainsScanned = 0;

  for (const chain of config.supportedChains) {
    try {
      const scanResult = await scanBlock(chain);
      const processed = await processDeposits(scanResult);
      // W-2: 顺带确认历史待确认充值
      const confirmed = await confirmPendingDeposits(chain);
      totalDeposits += processed + confirmed;
      chainsScanned++;
    } catch (err: any) {
      logger.error(`Scan cycle failed for ${chain}`, { error: err.message });
    }
  }

  return { chains: chainsScanned, depositsProcessed: totalDeposits };
}
