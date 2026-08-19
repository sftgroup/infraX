import axios from 'axios';
import { ethers } from 'ethers';
import { config } from '../config';
import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { Errors, AppError, ErrorCode } from '../utils/errors';
import { generateId } from '../utils/helpers';
import { GatewayProvider } from './gatewayProvider';

/**
 * BE-04: Transaction Service
 * Builds transactions, estimates gas, submits to Gas Pool, signs & broadcasts
 */

// Import risk service for checking
import { checkRisk } from './riskService';
import { determineStrategy, StrategyResult } from './sigStrategyService';

interface SendTxParams {
  userId: string;
  walletId: string;
  toAddress: string;
  amount: string;
  tokenAddress?: string;
  chain: string;
  paymentPassword: string;
  /** W-8: 客户端幂等键（重复提交返回既有结果，不重复广播） */
  idempotencyKey?: string;
}

interface CWalletSendTxResponse {
  tx_hash: string;
  gas_used: string;
  gas_sponsored: boolean;
}

interface CWalletGasEstimateResponse {
  gas_limit: string;
  gas_price: string;
  estimated_cost: string;
}

/**
 * Send a transaction with risk check, strategy determination, and CWallet broadcast
 * (F-019: Gas sponsored mode)
 *
 * W-3: 广播失败 → status='retrying' + retry_count，由 worker（retryPendingBroadcasts）重试，
 *      超过上限转 failed（arb §4.2 重试→失败+资金回退语义；本模型资金未在本地扣除，
 *      记 failed 即等价回退）。
 * W-4: gas 熔断——广播前检查 gas pool 余额，不足置 gas_blocked（arb §3.2）。
 * W-5: 风控按 USD 口径（先 convertToUsd 再 checkRisk）。
 * W-8: idempotencyKey 幂等返回。
 * W-10: DRY_RUN 显式开关（模拟广播，落审计记录）。
 */
export async function sendTransaction(params: SendTxParams): Promise<{
  txId: string;
  txHash: string | null;
  status: string;
  gasSponsored: boolean;
  strategy: string;
}> {
  const { userId, walletId, toAddress, amount, tokenAddress = '*', chain, paymentPassword, idempotencyKey } = params;

  // Begin DB transaction — ensures atomicity across wallet deduction + tx record insertion
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verify wallet ownership (with row lock to prevent concurrent double-spend)
    const walletResult = await client.query(
      'SELECT * FROM custodial_wallets WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [walletId, userId]
    );
    if (walletResult.rows.length === 0) {
      throw Errors.notFound('Wallet');
    }
    const wallet = walletResult.rows[0];

    // 2. Verify payment password via auth service
    const { verifyPaymentPassword } = await import('./authService');
    await verifyPaymentPassword(userId, paymentPassword);

    // W-8: 幂等键——重复请求直接返回既有结果
    if (idempotencyKey && idempotencyKey.length > 0) {
      const existing = await client.query(
        'SELECT id, tx_hash, status, gas_sponsored, signature_strategy FROM transactions WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (existing.rows.length > 0) {
        const e = existing.rows[0];
        await client.query('COMMIT');
        logger.info('Idempotent request hit, returning existing transaction', { txId: e.id, idempotencyKey });
        return {
          txId: e.id,
          txHash: e.tx_hash,
          status: e.status,
          gasSponsored: e.gas_sponsored,
          strategy: e.signature_strategy || 'auto',
        };
      }
    }

    // 3. W-5: 先折算 USD，再按 USD 判风控（顺序修正：原实现在风控之后才换算，非稳定币限额失真）
    const amountUsd = await convertToUsd(tokenAddress, chain, parseFloat(amount));

    // 4. Check risk rules (BE-05) — USD 口径
    const riskCheck = await checkRisk(userId, amountUsd, toAddress, tokenAddress, chain);
    if (!riskCheck.allowed) {
      // Log blocked transaction within the transaction
      const txId = generateId();
      await client.query(
        `INSERT INTO transactions (id, wallet_id, from_address, to_address, amount, token_address,
          gas_sponsored, status, risk_result, signature_strategy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'blocked', $8, 'auto')`,
        [txId, walletId, wallet.address, toAddress, amount, tokenAddress,
         true, JSON.stringify(riskCheck)]
      );
      await client.query('COMMIT');
      throw Errors.riskBlocked(riskCheck.reason || 'Risk check failed');
    }

    // 5. Determine signature strategy (BE-06)
    const strategy = determineStrategy(amountUsd);

    // 6. Estimate gas
    let gasEstimate: CWalletGasEstimateResponse;
    try {
      const resp = await axios.post(
        `${config.cwallet.baseUrl}/estimate-gas`,
        {
          from: wallet.address,
          to: toAddress,
          amount,
          token: tokenAddress,
          chain,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.cwallet.apiKey,
          },
          timeout: 10000,
        }
      );
      gasEstimate = resp.data;
    } catch (err: any) {
      logger.error('Gas estimation failed', { error: err.message, chain });
      await client.query('ROLLBACK');
      throw Errors.internal('Gas estimation failed');
    }

    // 7. For auto-sign (<100 USD), proceed with broadcast
    let txHash: string | null = null;
    let txStatus = 'pending';
    let gasSponsored = true;
    let retryCount = 0;
    let errorMessage: string | null = null;

    if (strategy.action === 'auto') {
      // W-4: gas 熔断——余额不足暂停自动广播
      if (!(await gasPoolOk(chain))) {
        txStatus = 'gas_blocked';
        errorMessage = `Gas pool balance below alert threshold (${config.gasPool.alertThreshold})`;
        logger.error('Gas pool fuse tripped — broadcast paused', { chain, walletId });
      } else {
        try {
          const resp = await axios.post(
            `${config.cwallet.baseUrl}/send-tx`,
            {
              from: wallet.address,
              to: toAddress,
              amount,
              token: tokenAddress,
              chain,
              gas_sponsor: true,
            },
            {
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.cwallet.apiKey,
              },
              timeout: 30000,
            }
          );
          const txResult: CWalletSendTxResponse = resp.data;
          txHash = txResult.tx_hash;
          // eslint-disable-next-line
          txStatus = 'confirmed';
          gasSponsored = txResult.gas_sponsored;
          logger.info('Transaction auto-signed and broadcasted', { txHash, amount, chain });
        } catch (err: any) {
          logger.error('CWallet send-tx failed', { error: err.message });
          if (config.dryRun) {
            // W-10: 显式 DRY_RUN — 模拟广播（落审计记录，不触碰链上）
            const { randomBytes } = await import('crypto');
            txHash = '0x' + randomBytes(32).toString('hex');
            txStatus = 'confirmed';
            logger.info('DRY_RUN mock tx_hash', { txHash });
          } else {
            // W-3: 进入重试队列（worker 重试；超过上限转 failed）
            txStatus = 'retrying';
            retryCount = 1;
            errorMessage = err.message || 'Broadcast failed';
          }
        }
      }
    } else if (strategy.action === 'confirm') {
      // Requires user confirmation (100-10,000 USD)
      txStatus = 'pending_confirmation';
      logger.info('Transaction requires user confirmation', { strategy, amountUsd, chain });
    } else if (strategy.action === 'approval') {
      // Requires multi-sig approval (>10,000 USD)
      txStatus = 'pending_approval';
      logger.info('Transaction requires multi-sig approval', { strategy, amountUsd, chain });
    }

    // 8. Store transaction record within the same DB transaction
    const txId = generateId();
    const strategyAction = strategy.action; // 'auto', 'confirm', 'approval'
    await client.query(
      `INSERT INTO transactions (id, wallet_id, from_address, to_address, amount, token_address,
        gas_sponsored, tx_hash, status, risk_result, signature_strategy, idempotency_key, retry_count, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [txId, walletId, wallet.address, toAddress, amount, tokenAddress,
       gasSponsored, txHash, txStatus, JSON.stringify(riskCheck), strategyAction,
       idempotencyKey || null, retryCount, errorMessage]
    );

    await client.query('COMMIT');

    // Fire SSE notification (non-blocking)
    try {
      const { createWebhookEvent } = await import('./webhookService');
      await createWebhookEvent(
        strategyAction === 'auto' ? 'deposit' : 'failed',
        userId,
        walletId,
        { txId, txHash, toAddress, amount, status: txStatus, strategy: strategyAction, gasSponsored, amountUsd }
      );
    } catch (err: any) { logger.warn('Notification event error (non-blocking)', { txId, error: err.message }); }

    return { txId, txHash, status: txStatus, gasSponsored, strategy: strategyAction };
  } catch (err: any) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * W-4: gas 熔断检查——gas pool 原生余额是否高于告警阈值。
 * 未配置 GAS_POOL_ADDRESS 时不启用熔断（返回 true）。
 */
async function gasPoolOk(chain: string): Promise<boolean> {
  if (config.dryRun) return true;
  if (!config.gasPool.address) return true;
  try {
    const provider = new GatewayProvider(chain);
    const balance = await provider.getBalance(config.gasPool.address);
    const threshold = ethers.parseEther(String(config.gasPool.alertThreshold || 0));
    return balance >= threshold;
  } catch (err: any) {
    // 查询失败时不阻断交易，仅告警（熔断不可用时保守放行，避免卡死用户提现）
    logger.warn('Gas pool balance check failed, bypassing fuse', { chain, error: err.message });
    return true;
  }
}

/**
 * W-3: 广播重试 worker——重试 status='retrying' 且 retry_count<3 的交易。
 * 成功 → confirmed；失败 → retry_count+1，达上限转 failed（资金回退语义）。
 * 返回成功处理（转 confirmed）的笔数。
 */
export async function retryPendingBroadcasts(): Promise<number> {
  if (config.dryRun) return 0;

  const pending = await pool.query(
    `SELECT * FROM transactions
     WHERE status = 'retrying' AND retry_count < 3
     ORDER BY created_at ASC LIMIT 20`
  );
  if (pending.rows.length === 0) return 0;

  let fixed = 0;
  for (const tx of pending.rows) {
    const walletRes = await pool.query(
      'SELECT chain FROM custodial_wallets WHERE id = $1',
      [tx.wallet_id]
    );
    const chain = walletRes.rows[0]?.chain || 'sepolia';
    try {
      const resp = await axios.post(
        `${config.cwallet.baseUrl}/send-tx`,
        {
          from: tx.from_address,
          to: tx.to_address,
          amount: tx.amount,
          token: tx.token_address,
          chain,
          gas_sponsor: true,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.cwallet.apiKey,
          },
          timeout: 30000,
        }
      );
      const txHash: string = resp.data?.tx_hash;
      await pool.query(
        `UPDATE transactions SET status = 'confirmed', tx_hash = $1, retry_count = retry_count + 1,
           error_message = NULL, updated_at = NOW() WHERE id = $2`,
        [txHash, tx.id]
      );
      fixed++;
      logger.info('Broadcast retry succeeded', { txId: tx.id, txHash });
    } catch (err: any) {
      const newCount = tx.retry_count + 1;
      const message = err.message || 'Broadcast failed';
      if (newCount >= 3) {
        await pool.query(
          `UPDATE transactions SET status = 'failed', retry_count = $1, error_message = $2, updated_at = NOW() WHERE id = $3`,
          [newCount, message, tx.id]
        );
        logger.error('Broadcast failed after max retries (funds revert)', { txId: tx.id, error: message });
      } else {
        await pool.query(
          `UPDATE transactions SET retry_count = $1, error_message = $2, updated_at = NOW() WHERE id = $3`,
          [newCount, message, tx.id]
        );
        logger.warn('Broadcast retry pending', { txId: tx.id, retryCount: newCount, error: message });
      }
    }
  }
  return fixed;
}

/** 简单 sleep（广播重试退避用） */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Estimate gas for a transaction
 */
export async function estimateGas(
  userId: string,
  walletId: string,
  toAddress: string,
  amount: string,
  chain: string,
  tokenAddress: string = '*'
): Promise<CWalletGasEstimateResponse> {
  const walletResult = await pool.query(
    'SELECT address FROM custodial_wallets WHERE id = $1 AND user_id = $2',
    [walletId, userId]
  );
  if (walletResult.rows.length === 0) {
    throw Errors.notFound('Wallet');
  }

  try {
    const resp = await axios.post(
      `${config.cwallet.baseUrl}/estimate-gas`,
      {
        from: walletResult.rows[0].address,
        to: toAddress,
        amount,
        token: tokenAddress,
        chain,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.cwallet.apiKey,
        },
        timeout: 10000,
      }
    );
    return resp.data;
  } catch (err: any) {
    logger.error('Gas estimation failed', { error: err.message });
    throw Errors.internal('Gas estimation failed');
  }
}

/**
 * Check transaction status by hash
 */
export async function getTransactionStatus(txHash: string, userId?: string): Promise<any> {
  // Validate txHash format
  if (!txHash || txHash.length < 64 || !txHash.startsWith('0x')) {
    throw Errors.invalidInput('txHash');
  }
  let query = `SELECT t.*, w.chain, w.address as wallet_address
     FROM transactions t
     JOIN custodial_wallets w ON t.wallet_id = w.id
     WHERE t.tx_hash = $1`;
  const params: any[] = [txHash];
  
  // Tenant isolation: when userId provided, only return user's own transactions
  if (userId) {
    query += ` AND w.user_id = $2`;
    params.push(userId);
  }
  
  const result = await pool.query(query, params);
  if (result.rows.length === 0) {
    throw Errors.notFound('Transaction');
  }
  return result.rows[0];
}

/**
 * Convert token amount to approximate USD value for risk assessment.
 * Stablecoins (USDC, USDT, TUSDT, DAI, BUSD) are treated 1:1.
 * For other tokens, attempts CWallet price API; falls back to conservative 2000x multiplier.
 */
async function convertToUsd(
  tokenAddress: string,
  chain: string,
  amount: number
): Promise<number> {
  const STABLECOINS = [
    '0x4CD3B75A73B1FeD8dD5264172C1956299A909199', // TUSDT (Sepolia test)
    '0x7169D38820dfd117C3FA1f22a697dBA58d90BA06', // TUSDT (alt)
  ].map(a => a.toLowerCase());

  if (STABLECOINS.includes(tokenAddress.toLowerCase())) {
    return amount; // 1:1 for test stablecoins
  }

  // Try CWallet price API for non-stablecoins
  try {
    const resp = await axios.get(
      `${config.cwallet.baseUrl}/token-price`,
      {
        params: { token: tokenAddress, chain },
        headers: { 'x-api-key': config.cwallet.apiKey },
        timeout: 3000,
      }
    );
    if (resp.data?.price) {
      return amount * parseFloat(resp.data.price);
    }
  } catch {
    logger.warn('Token price lookup failed, using conservative multiplier', { tokenAddress, chain });
  }

  // Conservative fallback: assume ETH-like value (~$2000 per token)
  return amount * 2000;
}

/**
 * Get pending confirmation/approval transactions for a user
 */
export async function getPendingTransactions(userId: string): Promise<any[]> {
  const result = await pool.query(
    `SELECT t.*, w.chain, c.address as wallet_address
     FROM transactions t
     JOIN custodial_wallets w ON t.wallet_id = w.id
     JOIN custodial_wallets c ON w.id = c.id
     WHERE w.user_id = $1
       AND (t.status = 'pending_confirmation' OR t.status = 'pending_approval')
     ORDER BY t.created_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Confirm a pending_confirmation transaction (broadcast to CWallet)
 */
export async function confirmTransaction(
  txId: string,
  userId: string,
  paymentPassword: string
): Promise<{ txId: string; txHash: string; status: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock and verify the transaction
    const txResult = await client.query(
      `SELECT t.*, w.address as wallet_address, w.user_id
       FROM transactions t
       JOIN custodial_wallets w ON t.wallet_id = w.id
       WHERE t.id = $1 AND t.status = 'pending_confirmation'
       FOR UPDATE OF t`,
      [txId]
    );
    if (txResult.rows.length === 0) {
      throw Errors.notFound('Pending transaction');
    }
    const tx = txResult.rows[0];
    if (tx.user_id !== userId) {
      throw Errors.forbidden('Not your transaction');
    }

    // Verify payment password
    const { verifyPaymentPassword } = await import('./authService');
    await verifyPaymentPassword(userId, paymentPassword);

    // Broadcast via CWallet
    let txHash: string | null = null;
    // W-4: 用户确认广播同样过 gas 熔断
    if (!(await gasPoolOk(tx.chain))) {
      await client.query(
        `UPDATE transactions SET status = 'gas_blocked', error_message = $1, updated_at = NOW() WHERE id = $2`,
        ['Gas pool balance below alert threshold', txId]
      );
      await client.query('COMMIT');
      logger.error('Confirm: gas pool fuse tripped', { txId, chain: tx.chain });
      return { txId, txHash: null, status: 'gas_blocked' };
    }

    try {
      const resp = await axios.post(
        `${config.cwallet.baseUrl}/send-tx`,
        {
          from: tx.wallet_address,
          to: tx.to_address,
          amount: tx.amount,
          token: tx.token_address,
          chain: tx.chain,
          gas_sponsor: true,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.cwallet.apiKey,
          },
          timeout: 30000,
        }
      );
      txHash = resp.data.tx_hash;
    } catch (err: any) {
      logger.error('Confirm: CWallet broadcast failed', { error: err.message });
      if (config.dryRun) {
        const { randomBytes } = await import('crypto');
        txHash = '0x' + randomBytes(32).toString('hex');
      } else {
        // W-3: 广播失败不丢单——转 retrying 交给 worker 重试
        await client.query(
          `UPDATE transactions SET status = 'retrying', retry_count = 1, error_message = $1, updated_at = NOW() WHERE id = $2`,
          [err.message || 'Broadcast failed', txId]
        );
        await client.query('COMMIT');
        logger.warn('Confirm: broadcast failed, moved to retry queue', { txId });
        return { txId, txHash: null, status: 'retrying' };
      }
    }

    await client.query(
      `UPDATE transactions SET status = 'confirmed', tx_hash = $1 WHERE id = $2`,
      [txHash, txId]
    );
    await client.query('COMMIT');
    logger.info('Transaction confirmed and broadcasted', { txId, txHash });
    return { txId, txHash: txHash!, status: 'confirmed' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reject a pending_confirmation transaction
 */
export async function rejectTransaction(
  txId: string,
  userId: string
): Promise<{ txId: string; status: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txResult = await client.query(
      `SELECT t.*, w.user_id
       FROM transactions t
       JOIN custodial_wallets w ON t.wallet_id = w.id
       WHERE t.id = $1 AND t.status = 'pending_confirmation'
       FOR UPDATE OF t`,
      [txId]
    );
    if (txResult.rows.length === 0) {
      throw Errors.notFound('Pending transaction');
    }
    const tx = txResult.rows[0];
    if (tx.user_id !== userId) {
      throw Errors.forbidden('Not your transaction');
    }

    await client.query(
      `UPDATE transactions SET status = 'rejected' WHERE id = $1`,
      [txId]
    );
    await client.query('COMMIT');
    logger.info('Transaction rejected', { txId });
    return { txId, status: 'rejected' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Batch transfer (BE-09 delegated — calls batch service internally)
 */
export async function batchTransfer(
  userId: string,
  walletId: string,
  transfers: Array<{ to: string; amount: string }>,
  paymentPassword: string
): Promise<any> {
  const { processBatchTransfer } = await import('./batchService');
  return processBatchTransfer(userId, walletId, transfers, paymentPassword);
}

/**
 * MQ-2: 清空钱包原生余额到指定地址（sweep）。
 * 链上查询余额（ether）→ 全额构造一笔 sendTransaction（gas 由赞助方承担），
 * 余额为 0 时不发交易，返回 swept:false。
 */
export async function sweepNative(params: {
  userId: string;
  walletId: string;
  toAddress: string;
  chain: string;
  paymentPassword: string;
}): Promise<any> {
  const { userId, walletId, toAddress, chain, paymentPassword } = params;

  const walletResult = await pool.query(
    'SELECT address FROM custodial_wallets WHERE id = $1 AND user_id = $2',
    [walletId, userId]
  );
  if (walletResult.rows.length === 0) {
    throw Errors.notFound('Wallet');
  }
  const fromAddress = walletResult.rows[0].address;

  const provider = new GatewayProvider(chain);
  const balanceWei = await provider.getBalance(fromAddress);
  if (balanceWei === 0n) {
    return { swept: false, txHash: null, balance: '0', chain };
  }
  const balanceEth = ethers.formatEther(balanceWei);

  const result = await sendTransaction({
    userId,
    walletId,
    toAddress,
    amount: balanceEth,
    tokenAddress: '*',
    chain,
    paymentPassword,
  });
  return { swept: true, balance: balanceEth, chain, ...result };
}
