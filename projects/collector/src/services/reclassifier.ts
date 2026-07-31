import { ethers } from 'ethers';
import { pool } from '../database';
import { logger } from '../logger';
import { config } from '../config';
import { classifyLog, type LogData } from './normalizer';

interface CustomSig {
  topic_hash: string;
  event_type: string;
  event_name?: string;
  abi?: any;
}

/**
 * Batch-reclassify raw_event rows that haven't been classified yet.
 *
 * Classification order:
 *   1. Built-in SIGS (classifyLog) — Transfer, Approval, Swap, etc.
 *   2. Tenant-registered custom_event_sigs from DB
 *   3. If no match → mark _classified:false so we skip on next run
 */
export async function reclassifyRawEvents(batchSize: number = config.reclassifier.batchSize): Promise<{ processed: number; classified: number; custom: number }> {
  const client = await pool.connect();
  let processed = 0;
  let classified = 0;
  let custom = 0;

  try {
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

    if (result.rows.length === 0) return { processed: 0, classified: 0, custom: 0 };

    for (const row of result.rows) {
      processed++;
      const raw = row.event_data?._raw;
      if (!raw || !raw.topics || raw.topics.length === 0) {
        await client.query(
          `UPDATE events SET event_data = $1 WHERE id = $2`,
          [JSON.stringify({ ...row.event_data, _classified: false }), row.id]
        ).catch(() => {});
        continue;
      }

      const blockTimestamp = row.event_data?.blockTimestamp || 0;
      const topic0 = (raw.topics[0] || '').toLowerCase();

      const logData: LogData = {
        address: raw.address,
        topics: raw.topics,
        data: raw.data || '0x',
        transactionHash: row.tx_hash,
        logIndex: '0x' + (row.log_index || 0).toString(16),
      };

      // 1. Built-in SIGS
      const builtinResult = classifyLog(logData, row.block_number, blockTimestamp, row.chain);

      if (builtinResult && builtinResult.event_type !== 'raw_event') {
        await client.query(
          `UPDATE events SET
             event_type = $1,  from_address = $2,  to_address = $3,
             token_address = $4,  token_symbol = $5,  token_id = $6,
             amount = $7,  amount_raw = $8,
             event_data = $9,  topic_hash = $10
           WHERE id = $11`,
          [
            builtinResult.event_type,
            builtinResult.from_address,
            builtinResult.to_address,
            builtinResult.token_address,
            builtinResult.token_symbol || '',
            builtinResult.token_id || '',
            builtinResult.amount || '0',
            builtinResult.amount_raw || '0',
            JSON.stringify({ ...builtinResult.event_data, _classified: true }),
            builtinResult.topic_hash,
            row.id,
          ]
        );
        classified++;
        continue;
      }

      // 2. Tenant-registered custom sigs (lazy-load first time)
      const customSig = await loadCustomSig(row.chain, topic0);
      if (customSig) {
        const customEvent = buildCustomEvent(logData, row.chain, row.block_number, blockTimestamp, customSig);
        if (customEvent) {
          await client.query(
            `UPDATE events SET
               event_type = $1,  from_address = $2,  to_address = $3,
               token_address = $4,  token_symbol = $5,  token_id = $6,
               amount = $7,  amount_raw = $8,
               event_data = $9,  topic_hash = $10
             WHERE id = $11`,
            [
              customEvent.event_type,
              customEvent.from_address,
              customEvent.to_address,
              customEvent.token_address,
              customEvent.token_symbol || '',
              customEvent.token_id || '',
              customEvent.amount || '0',
              customEvent.amount_raw || '0',
              JSON.stringify({ ...customEvent.event_data, _classified: true, _custom_sig: customSig.event_name || customSig.event_type }),
              customEvent.topic_hash,
              row.id,
            ]
          );
          custom++;
          continue;
        }
      }

      // 3. No match — mark as attempted
      await client.query(
        `UPDATE events SET event_data = $1 WHERE id = $2`,
        [JSON.stringify({ ...row.event_data, _classified: false }), row.id]
      ).catch(() => {});
    }
  } catch (err: any) {
    logger.error('[reclassify] Batch failed', { error: err.message });
  } finally {
    client.release();
  }

  if (classified > 0 || custom > 0) {
    logger.info(`[reclassify] builtin=${classified} custom=${custom} / ${processed} raw events`);
  }
  return { processed, classified, custom };
}

// ── Custom sig cache ──────────────────────────────────────────────

let customSigCache: Map<string, CustomSig> | null = null;
let customSigCacheTime = 0;

async function loadAllCustomSigs(): Promise<Map<string, CustomSig>> {
  const now = Date.now();
  if (customSigCache && (now - customSigCacheTime) < config.reclassifier.customSigsRefreshMs) {
    return customSigCache;
  }

  const map = new Map<string, CustomSig>();
  try {
    const result = await pool.query(
      `SELECT chain, topic_hash, event_type, event_name, abi
       FROM custom_event_sigs WHERE enabled = true`
    );
    for (const row of result.rows) {
      const key = `${row.chain}:${row.topic_hash.toLowerCase()}`;
      map.set(key, {
        topic_hash: row.topic_hash,
        event_type: row.event_type,
        event_name: row.event_name,
        abi: row.abi,
      });
    }
  } catch (err: any) {
    logger.warn('[reclassify] Failed to load custom sigs', { error: err.message });
  }

  customSigCache = map;
  customSigCacheTime = now;
  return map;
}

async function loadCustomSig(chain: string, topicHash: string): Promise<CustomSig | null> {
  const all = await loadAllCustomSigs();
  return all.get(`${chain}:${topicHash}`) || null;
}

// ── Custom event builder ──────────────────────────────────────────

function topicToAddressHex(topic: string): string {
  if (!topic || topic.length < 26) return topic || '';
  return '0x' + topic.slice(26);
}

function safeBigIntStr(data: string): string {
  try { return BigInt(data || '0x0').toString(); } catch { return '0'; }
}

function buildCustomEvent(
  log: LogData,
  chain: string,
  blockNumber: number,
  blockTimestamp: number,
  sig: CustomSig
): any | null {
  const logIndex = parseInt(log.logIndex || '0', 16) || 0;
  const topics = log.topics || [];
  const eventData: Record<string, any> = {
    blockTimestamp,
    logIndex,
    customEventName: sig.event_name || sig.event_type,
    topics: topics.slice(0, 5),
    dataPreview: (log.data || '').length > 256 ? (log.data || '').slice(0, 256) + '...' : (log.data || ''),
  };

  let fromAddress = topics.length > 1 ? topicToAddressHex(topics[1]) : '';
  let toAddress = topics.length > 2 ? topicToAddressHex(topics[2]) : '';
  let tokenId = '';
  let amount = '0';
  let tokenAddress = '';

  // Try ABI decoding if abi is provided
  if (sig.abi) {
    try {
      const iface = new ethers.Interface([sig.abi]);
      const parsed = iface.parseLog({ topics: log.topics, data: log.data || '0x' });
      if (parsed) {
        for (const [name, value] of parsed.args as any) {
          const v = value?.toString?.() ?? String(value);
          eventData[`arg_${name}`] = typeof value === 'bigint' ? v : value;

          // Auto-detect common parameter names
          const n = name.toLowerCase();
          if (n === 'from' || n === 'sender' || n === 'owner' || n === 'src') fromAddress = v;
          if (n === 'to' || n === 'recipient' || n === 'dst' || n === 'spender') toAddress = v;
          if (n === 'tokenid' || n === 'id') tokenId = v;
          if (n === 'value' || n === 'amount' || n === 'wad') amount = v;
          if (n === 'token' || n === 'tokenaddress') tokenAddress = v;
        }
      }
    } catch {
      // ABI decode failed — just use topic extraction
      eventData._abiDecodeFailed = true;
    }
  }

  return {
    event_type: sig.event_type,
    from_address: fromAddress,
    to_address: toAddress,
    token_address: tokenAddress || log.address || '',
    token_symbol: '',
    token_id: tokenId,
    amount: amount,
    amount_raw: amount,
    topic_hash: sig.topic_hash,
    event_data: eventData,
  };
}

// ── Scheduler ────────────────────────────────────────────────────

let reclassifyTimer: NodeJS.Timeout | null = null;

export function startReclassifyScheduler(): void {
  if (reclassifyTimer) return;

  const run = async () => {
    try {
      await reclassifyRawEvents();
    } catch { /* logged internally */ }
  };

  reclassifyTimer = setInterval(run, config.reclassifier.intervalMs);
  if (reclassifyTimer && 'unref' in reclassifyTimer) reclassifyTimer.unref();

  setTimeout(run, config.reclassifier.firstRunDelayMs).unref?.();

  logger.info('[reclassify] Scheduler started', {
    intervalMs: config.reclassifier.intervalMs,
    batchSize: config.reclassifier.batchSize,
  });
}

export function stopReclassifyScheduler(): void {
  if (reclassifyTimer) {
    clearInterval(reclassifyTimer);
    reclassifyTimer = null;
  }
}
