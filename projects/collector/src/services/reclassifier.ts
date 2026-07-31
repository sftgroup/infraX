import { pool } from '../database';
import { logger } from '../logger';
import { classifyLog, type LogData } from './normalizer';

const RECLASSIFY_INTERVAL_MS = 30_000;
const RECLASSIFY_BATCH_SIZE = 500;
const RECLASSIFY_FIRST_RUN_DELAY_MS = 10_000;

/**
 * Batch-reclassify raw_event rows that haven't been classified yet.
 * Reconstructs the original LogData from event_data._raw and runs
 * classifyLog().  If a known topic is matched, the row is UPDATEd
 * with the proper event_type and normalised fields.
 *
 * Rows that fail classification (genuinely unknown topics) are marked
 * `_classified: false` so they are skipped on subsequent runs.
 */
export async function reclassifyRawEvents(batchSize: number = RECLASSIFY_BATCH_SIZE): Promise<{ processed: number; classified: number }> {
  const client = await pool.connect();
  let processed = 0;
  let classified = 0;

  try {
    // Only pick rows that have _raw data and haven't been attempted yet
    const result = await client.query(
      `SELECT id, event_id, chain, block_number, tx_hash, log_index,
              topic_hash, event_data, collected_at
       FROM events
       WHERE event_type = 'raw_event'
         AND event_data ? '_raw'
         AND (event_data->>'_classified') IS NULL
       LIMIT $1`,
      [batchSize]
    );

    if (result.rows.length === 0) return { processed: 0, classified: 0 };

    for (const row of result.rows) {
      processed++;
      const raw = row.event_data?._raw;
      if (!raw || !raw.topics || raw.topics.length === 0) {
        // Malformed — mark as attempted
        await client.query(
          `UPDATE events SET event_data = $1 WHERE id = $2`,
          [JSON.stringify({ ...row.event_data, _classified: false }), row.id]
        ).catch(() => {});
        continue;
      }

      const blockTimestamp = row.event_data?.blockTimestamp || 0;

      const logData: LogData = {
        address: raw.address,
        topics: raw.topics,
        data: raw.data || '0x',
        transactionHash: row.tx_hash,
        logIndex: '0x' + (row.log_index || 0).toString(16),
      };

      const classifiedEvent = classifyLog(logData, row.block_number, blockTimestamp, row.chain);

      if (classifiedEvent && classifiedEvent.event_type !== 'raw_event') {
        // Known topic — update the row in-place
        await client.query(
          `UPDATE events SET
             event_type = $1,  from_address = $2,  to_address = $3,
             token_address = $4,  token_symbol = $5,  token_id = $6,
             amount = $7,  amount_raw = $8,
             event_data = $9,  topic_hash = $10
           WHERE id = $11`,
          [
            classifiedEvent.event_type,
            classifiedEvent.from_address,
            classifiedEvent.to_address,
            classifiedEvent.token_address,
            classifiedEvent.token_symbol || '',
            classifiedEvent.token_id || '',
            classifiedEvent.amount || '0',
            classifiedEvent.amount_raw || '0',
            JSON.stringify({ ...classifiedEvent.event_data, _classified: true }),
            classifiedEvent.topic_hash,
            row.id,
          ]
        );
        classified++;
      } else {
        // Unknown topic — mark so we don't retry
        await client.query(
          `UPDATE events SET event_data = $1 WHERE id = $2`,
          [JSON.stringify({ ...row.event_data, _classified: false }), row.id]
        ).catch(() => {});
      }
    }
  } catch (err: any) {
    logger.error('[reclassify] Batch failed', { error: err.message });
  } finally {
    client.release();
  }

  if (classified > 0) {
    logger.info(`[reclassify] Classified ${classified} / ${processed} raw events`);
  }
  return { processed, classified };
}

/**
 * Start periodic reclassification scheduler.
 * Runs reclassifyRawEvents() every RECLASSIFY_INTERVAL_MS.
 */
let reclassifyTimer: NodeJS.Timeout | null = null;

export function startReclassifyScheduler(): void {
  if (reclassifyTimer) return;

  const run = async () => {
    try {
      await reclassifyRawEvents();
    } catch {
      // errors already logged inside reclassifyRawEvents
    }
  };

  reclassifyTimer = setInterval(run, RECLASSIFY_INTERVAL_MS);
  if (reclassifyTimer && 'unref' in reclassifyTimer) reclassifyTimer.unref();

  // First run after a short delay
  setTimeout(run, RECLASSIFY_FIRST_RUN_DELAY_MS).unref?.();

  logger.info('[reclassify] Scheduler started', {
    intervalMs: RECLASSIFY_INTERVAL_MS,
    batchSize: RECLASSIFY_BATCH_SIZE,
  });
}

export function stopReclassifyScheduler(): void {
  if (reclassifyTimer) {
    clearInterval(reclassifyTimer);
    reclassifyTimer = null;
  }
}
