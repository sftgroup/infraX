import { v4 as uuidv4 } from 'uuid';
import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { Errors } from '../utils/errors';

/**
 * BE-09: Batch Transfer Service
 * (F-023, L-009) Individual execution, partial failure non-blocking, progress tracking
 */

interface BatchTransferResult {
  batchId: string;
  total: number;
  succeeded: number;
  failed: number;
  progress: number;
  status: string;
  results: Array<{
    index: number;
    to: string;
    amount: string;
    status: 'success' | 'failed';
    txHash: string | null;
    error?: string;
  }>;
}

/**
 * Process a batch of transfers with persisted progress tracking
 * Each transfer is executed individually; failures don't block the batch (L-009)
 * Progress persisted to batch_transfers table for polling
 */
export async function processBatchTransfer(
  userId: string,
  walletId: string,
  transfers: Array<{ to: string; amount: string; token?: string }>,
  paymentPassword: string
): Promise<BatchTransferResult> {
  // Validate wallet ownership
  const walletResult = await pool.query(
    'SELECT address, chain FROM custodial_wallets WHERE id = $1 AND user_id = $2',
    [walletId, userId]
  );
  if (walletResult.rows.length === 0) {
    throw Errors.notFound('Wallet');
  }
  const wallet = walletResult.rows[0];

  // Verify payment password
  const { verifyPaymentPassword } = await import('./authService');
  await verifyPaymentPassword(userId, paymentPassword);

  // Validate transfer count (L-009: max 1000)
  if (transfers.length > 1000) {
    throw Errors.paramError('Batch transfer supports max 1000 transactions per batch');
  }

  const batchId = uuidv4();

  // Create batch records for each transfer
  const insertValues: string[] = [];
  const insertParams: any[] = [];
  transfers.forEach((t, i) => {
    insertParams.push(batchId, i, t.to, t.amount, t.token || 'native', 'pending');
    insertValues.push(`($${insertParams.length - 5}, $${insertParams.length - 4}, $${insertParams.length - 3}, $${insertParams.length - 2}, $${insertParams.length - 1}, $${insertParams.length})`);
  });
  await pool.query(
    `INSERT INTO batch_transfers (batch_id, idx, to_address, amount, token, status) VALUES ${insertValues.join(', ')}`,
    insertParams
  );

  const { sendTransaction } = await import('./txService');
  const results: BatchTransferResult['results'] = [];
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < transfers.length; i++) {
    const transfer = transfers[i];
    try {
      const txResult = await sendTransaction({
        userId,
        walletId,
        toAddress: transfer.to,
        amount: transfer.amount,
        chain: wallet.chain,
        paymentPassword,
      });

      if (txResult.status === 'confirmed' || txResult.status === 'pending') {
        succeeded++;
        results.push({
          index: i,
          to: transfer.to,
          amount: transfer.amount,
          status: 'success',
          txHash: txResult.txHash,
        });
      } else {
        failed++;
        results.push({
          index: i,
          to: transfer.to,
          amount: transfer.amount,
          status: 'failed',
          txHash: null,
          error: 'Transaction broadcast failed',
        });
      }
    } catch (err: any) {
      failed++;
      results.push({
        index: i,
        to: transfer.to,
        amount: transfer.amount,
        status: 'failed',
        txHash: null,
        error: err.message || 'Unknown error',
      });
    }

    // Update progress in DB
    await pool.query(
      `UPDATE batch_transfers SET status = $1, tx_hash = $2 WHERE batch_id = $3 AND idx = $4`,
      [results[i].status === 'success' ? 'success' : 'failed', results[i].txHash || null, batchId, i]
    );

    // Log progress periodically
    if ((i + 1) % 50 === 0 || i === transfers.length - 1) {
      logger.info(`Batch transfer progress: ${i + 1}/${transfers.length} (OK: ${succeeded}, FAIL: ${failed})`);
    }
  }

  const finalStatus = failed === 0 ? 'completed' : 'completed_with_errors';

  logger.info('Batch transfer completed', {
    batchId,
    total: transfers.length,
    succeeded,
    failed,
  });

  return {
    batchId,
    total: transfers.length,
    succeeded,
    failed,
    progress: 100,
    status: finalStatus,
    results,
  };
}

/**
 * Get batch transfer progress by batchId
 */
export async function getBatchProgress(batchId: string): Promise<any> {
  const result = await pool.query(
    `SELECT batch_id, idx, to_address, amount, token, status, tx_hash, created_at
     FROM batch_transfers WHERE batch_id = $1
     ORDER BY idx ASC`,
    [batchId]
  );
  if (result.rows.length === 0) {
    throw Errors.notFound('Batch');
  }
  const rows = result.rows;
  const total = rows.length;
  const succeeded = rows.filter((r: any) => r.status === 'success').length;
  const failed = rows.filter((r: any) => r.status === 'failed').length;
  const progress = Math.round(((succeeded + failed) / total) * 100);
  return {
    batchId,
    total,
    succeeded,
    failed,
    progress,
    status: failed === 0 && progress === 100 ? 'completed' : 'processing',
    transfers: rows,
  };
}
