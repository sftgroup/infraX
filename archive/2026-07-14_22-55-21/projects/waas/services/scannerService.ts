import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { Errors } from '../utils/errors';

/**
 * BE-07: Block Scanner & Deposit Service
 * (F-020, L-004) Scans blocks → matches addresses → writes balance → fires webhook
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

/**
 * Process a block scan result — match addresses, update balances, create webhook events
 */
export async function processDeposits(scanResult: BlockScanResult): Promise<number> {
  const { chain, blockNumber, deposits } = scanResult;
  let processedCount = 0;

  for (const deposit of deposits) {
    // Match the receiving address against our custodial wallets
    const walletResult = await pool.query(
      'SELECT id, user_id FROM custodial_wallets WHERE address = $1 AND chain = $2',
      [deposit.to.toLowerCase(), chain]
    );

    if (walletResult.rows.length === 0) {
      continue; // Not one of our addresses
    }

    const wallet = walletResult.rows[0];

    // For ERC20 deposits, check the token belongs to this wallet's tenant
    if (deposit.tokenAddress !== '0x0000000000000000000000000000000000000000') {
      const tenantCheck = await pool.query(
        `SELECT tt.id FROM tenant_tokens tt
         JOIN custodial_wallets cw ON cw.tenant_id = tt.tenant_id
         WHERE cw.id = $1 AND tt.chain_id = $2 AND tt.contract_address = $3 AND tt.enabled = true`,
        [wallet.id, chain === 'sepolia' ? 11155111 : 1, deposit.tokenAddress.toLowerCase()]
      );
      if (tenantCheck.rows.length === 0) {
        continue; // Token not configured by this tenant — skip
      }
    }

    // Dedup: skip deposits with tx_hash already processed
    const existingTx = await pool.query(
      'SELECT id FROM transactions WHERE tx_hash = $1 AND wallet_id = $2',
      [deposit.txHash, wallet.id]
    );
    if (existingTx.rows.length > 0) {
      logger.debug('Skipping duplicate deposit', { txHash: deposit.txHash, walletId: wallet.id });
      continue;
    }

    // Update custodial wallet balance
    await pool.query(
      `UPDATE custodial_wallets
       SET balance = balance + $1, updated_at = NOW()
       WHERE id = $2`,
      [deposit.amount, wallet.id]
    );

    // Update hot wallet balance for the tenant (for SaaS dashboard)
    if (deposit.tokenAddress !== '0x0000000000000000000000000000000000000000') {
      await pool.query(
        `UPDATE hot_wallet_balances hwb
         SET balance = balance + $1, last_scanned_block = $2, updated_at = NOW()
         FROM tenant_tokens tt, custodial_wallets cw
         WHERE hwb.token_id = tt.id AND cw.tenant_id = tt.tenant_id
           AND cw.id = $3 AND tt.contract_address = $4`,
        [deposit.amount, scanResult.blockNumber, wallet.id, deposit.tokenAddress.toLowerCase()]
      );
    } else {
      // Native token balance update
      await pool.query(
        `UPDATE hot_wallet_balances hwb
         SET balance = balance + $1, last_scanned_block = $2, updated_at = NOW()
         FROM custodial_wallets cw
         WHERE hwb.tenant_id = cw.tenant_id AND cw.id = $3
           AND hwb.contract_address = '0x0000000000000000000000000000000000000000'`,
        [deposit.amount, scanResult.blockNumber, wallet.id]
      );
    }

    // Create a transaction record
    const txId = uuidv4();
    await pool.query(
      `INSERT INTO transactions (id, wallet_id, from_address, to_address, amount, token_address,
        gas_sponsored, tx_hash, status, risk_result, signature_strategy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', '{}', 'auto')`,
      [txId, wallet.id, deposit.from, deposit.to, deposit.amount,
       deposit.tokenAddress, false, deposit.txHash]
    );

    // Create webhook event (deposit type)
    await pool.query(
      `INSERT INTO webhook_events (id, event_type, user_id, wallet_id, payload, status)
       VALUES ($1, 'deposit', $2, $3, $4, 'pending')`,
      [
        uuidv4(),
        wallet.user_id,
        wallet.id,
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

    processedCount++;
    logger.info('Deposit processed', {
      chain,
      txHash: deposit.txHash,
      address: deposit.to,
      amount: deposit.amount,
      userId: wallet.user_id,
    });
  }

  return processedCount;
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
      totalDeposits += processed;
      chainsScanned++;
    } catch (err: any) {
      logger.error(`Scan cycle failed for ${chain}`, { error: err.message });
    }
  }

  return { chains: chainsScanned, depositsProcessed: totalDeposits };
}
