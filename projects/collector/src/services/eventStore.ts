import { v4 as uuidv4 } from 'uuid';
import { pool } from '../database';
import { logger } from '../logger';
import { broadcastEvent } from './eventBus';
import type { NormalizedEvent } from './normalizer';

/**
 * Insert normalized events into the database (idempotent on event_id).
 * Uses SAVEPOINT per row so one bad record doesn't abort the entire batch.
 */
export async function insertEvents(events: NormalizedEvent[]): Promise<number> {
  if (events.length === 0) return 0;

  const client = await pool.connect();
  let insertedCount = 0;

  try {
    await client.query('BEGIN');

    for (const evt of events) {
      try {
        await client.query('SAVEPOINT sp');
        await client.query(
          `INSERT INTO events (
            id, event_id, event_type, source, chain, block_number, tx_hash, log_index,
            contract_address, from_address, to_address, token_address, token_symbol,
            token_id, amount, amount_raw, event_data, topic_hash, status, confirmations,
            collected_at, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20,
            NOW(), NOW()
          )
          ON CONFLICT (event_id, collected_at) DO NOTHING`,
          [
            uuidv4(),
            evt.event_id,
            evt.event_type,
            evt.source,
            evt.chain,
            evt.block_number,
            evt.tx_hash,
            evt.log_index,
            evt.contract_address,
            evt.from_address,
            evt.to_address,
            evt.token_address,
            // 兜底：normalizer 某类事件未填 token_symbol（null）会违反 NOT NULL 约束，
            // 导致 postgres ERROR 日志每秒刷屏（曾堆满 30G 系统盘）。空串可入库。
            evt.token_symbol ?? '',
            evt.token_id,
            evt.amount,
            evt.amount_raw,
            JSON.stringify(evt.event_data),
            evt.topic_hash,
            evt.status,
            evt.confirmations,
          ]
        );
        await client.query('RELEASE SAVEPOINT sp');
        insertedCount++;

        // Broadcast to WebSocket clients (fire-and-forget)
        try { broadcastEvent(evt); } catch {}
      } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT sp').catch(() => {});
        if (err.code !== '23505') {
          logger.warn('[normalizer] Failed to insert event', { event_id: evt.event_id, error: err.message });
        }
      }
    }

    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('[normalizer] Insert batch failed', { error: err.message });
    throw err;
  } finally {
    client.release();
  }

  return insertedCount;
}

/**
 * Update checkpoint after a successful scan cycle
 */
export async function updateCheckpoint(chain: string, collectorName: string, lastBlock: number, lastTxHash?: string): Promise<void> {
  await pool.query(
    `INSERT INTO event_checkpoints (id, chain, collector_name, last_block, last_tx_hash, last_fetch_at, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), 'running')
     ON CONFLICT (chain, collector_name) DO UPDATE
     SET last_block = EXCLUDED.last_block,
         last_tx_hash = EXCLUDED.last_tx_hash,
         last_fetch_at = NOW(),
         status = 'running',
         error_message = NULL`,
    [chain.toLowerCase(), collectorName, lastBlock, lastTxHash || null]
  );
}

/**
 * Atomically increment event_count for a chain
 */
export async function incrementEventCount(chain: string, count: number): Promise<void> {
  await pool.query(
    `UPDATE event_checkpoints
     SET event_count = COALESCE(event_count, 0) + $1
     WHERE chain = $2 AND collector_name = 'block_scanner'`,
    [count, chain]
  );
}

/**
 * Get the last scanned block for a chain+collector
 */
export async function getCheckpoint(chain: string, collectorName: string): Promise<number> {
  const result = await pool.query(
    'SELECT last_block FROM event_checkpoints WHERE chain = $1 AND collector_name = $2',
    [chain.toLowerCase(), collectorName]
  );
  return result.rows.length > 0 ? parseInt(result.rows[0].last_block, 10) : 0;
}
