import { ethers } from 'ethers';
import { pool } from '../database';
import { logger } from '../logger';
import { config } from '../config';
import { classifyLog, type LogData } from './normalizer';
import { classifyEvent } from './classify';

interface CustomSig {
  topic_hash: string;
  event_type: string;
  event_name?: string;
  abi?: any;
}

/**
 * Batch-reclassify raw_event rows that haven't been classified yet.
 *
 * Strategy (avoids per-row UPDATE round-trips):
 *   1. SELECT a batch of unclassified rows
 *   2. Classify each row in memory, collecting params into two lists:
 *        classifiedRows — rows matched by built-in or custom sigs
 *        markedRows     — rows with no match (mark _classified:false)
 *   3. Apply updates with a single multi-row UPDATE (VALUES) per list.
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
              topic_hash, event_data, collected_at::text AS collected_at
       FROM events
       WHERE event_type = 'raw_event'
         AND event_data ? '_raw'
         AND (event_data->>'_classified') IS NULL
       LIMIT $1`,
      [batchSize]
    );

    if (result.rows.length === 0) return { processed: 0, classified: 0, custom: 0 };

    // [event_id, collected_at, event_type, from, to, token, symbol, tokenId, amount, amountRaw, eventDataJson, topicHash, categoryId, labelId]
    const classifiedRows: any[][] = [];
    // [eventDataJson, event_id, collected_at]
    const markedRows: any[][] = [];

    for (const row of result.rows) {
      processed++;
      const raw = row.event_data?._raw;
      if (!raw || !raw.topics || raw.topics.length === 0) {
        markedRows.push([JSON.stringify({ ...row.event_data, _classified: false }), row.event_id, row.collected_at]);
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
        // 9.6 Phase 1.3: 内置签名命中同样落分类（与 insertEvents classifyEvent 同源映射；
        // contract_address 取日志发射合约 = raw.address，与 normalizer 语义一致）
        const cls = classifyEvent({
          event_type: builtinResult.event_type,
          standard: (builtinResult.event_data as any)?.standard,
          contract_address: raw.address,
        });
        classifiedRows.push([
          row.event_id,
          row.collected_at,
          builtinResult.event_type,
          builtinResult.from_address,
          builtinResult.to_address,
          builtinResult.token_address,
          builtinResult.token_symbol || '',
          builtinResult.token_id || '',
          clampAmount(builtinResult.amount),
          builtinResult.amount_raw || '0',
          JSON.stringify({ ...builtinResult.event_data, _classified: true }),
          builtinResult.topic_hash,
          cls.category_id,
          cls.label_id,
        ]);
        classified++;
        continue;
      }

      // 2. Tenant-registered custom sigs (lazy-load first time)
      const customSig = await loadCustomSig(row.chain, topic0);
      if (customSig) {
        const customEvent = buildCustomEvent(logData, row.chain, row.block_number, blockTimestamp, customSig);
        if (customEvent) {
          const cls = classifyEvent({
            event_type: customEvent.event_type,
            standard: (customEvent.event_data as any)?.standard,
            contract_address: customEvent.contract_address,
          });
          classifiedRows.push([
            row.event_id,
            row.collected_at,
            customEvent.event_type,
            customEvent.from_address,
            customEvent.to_address,
            customEvent.token_address,
            customEvent.token_symbol || '',
            customEvent.token_id || '',
            clampAmount(customEvent.amount),
            customEvent.amount_raw || '0',
            JSON.stringify({ ...customEvent.event_data, _classified: true, _custom_sig: customSig.event_name || customSig.event_type }),
            customEvent.topic_hash,
            cls.category_id,
            cls.label_id,
          ]);
          custom++;
          continue;
        }
      }

      // 3. No match — mark as attempted
      markedRows.push([JSON.stringify({ ...row.event_data, _classified: false }), row.event_id, row.collected_at]);
    }

    // Batch UPDATEs: one multi-row statement per list (dedup index (event_id, collected_at))
    await batchUpdateClassified(client, classifiedRows);
    await batchMarkUnclassified(client, markedRows);
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

// ── Multi-row UPDATE helpers (VALUES-based) ───────────────────────

const UPDATE_SUBBATCH = 4000; // 12 params/row → 48k params, safe under PG's 65535 limit

// varchar column max lengths in events table — truncate to avoid
// "value too long for type character varying(100)" aborting the whole batch
// (non-standard tokens can emit huge `data`, producing 100k+ digit decimals)
const VARCHAR_MAX: Record<number, number> = {
  2: 100,  // event_type
  3: 100,  // from_address
  4: 100,  // to_address
  5: 100,  // token_address
  6: 50,   // token_symbol
  7: 100,  // token_id
  9: 100,  // amount_raw
  11: 100, // topic_hash
  13: 50,  // category_id
  14: 50,  // label_id
};

function fitParam(v: any, idx: number): any {
  const max = VARCHAR_MAX[idx];
  if (max === undefined) return v;
  if (v == null) return ''; // varchar columns are NOT NULL — coerce undefined/null to ''
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

async function batchUpdateClassified(client: any, rows: any[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPDATE_SUBBATCH) {
    const chunk = rows.slice(i, i + UPDATE_SUBBATCH);
    if (chunk.length === 0) continue;

    const values = chunk
      .map((_, r) => {
        const b = r * 14;
        return `($${b + 1}::varchar, $${b + 2}::timestamp, $${b + 3}::varchar, $${b + 4}::varchar, $${b + 5}::varchar, $${b + 6}::varchar, $${b + 7}::varchar, $${b + 8}::varchar, $${b + 9}::numeric, $${b + 10}::varchar, $${b + 11}::jsonb, $${b + 12}::varchar, $${b + 13}::varchar, $${b + 14}::varchar)`;
      })
      .join(', ');

    await client.query(
      `UPDATE events AS e SET
         event_type = v.event_type,
         from_address = v.from_address,
         to_address = v.to_address,
         token_address = v.token_address,
         token_symbol = v.token_symbol,
         token_id = v.token_id,
         amount = v.amount,
         amount_raw = v.amount_raw,
         event_data = v.event_data,
         topic_hash = v.topic_hash,
         category_id = v.category_id,
         label_id = v.label_id
       FROM (VALUES ${values})
         AS v(event_id, collected_at, event_type, from_address, to_address,
              token_address, token_symbol, token_id, amount, amount_raw, event_data, topic_hash, category_id, label_id)
       WHERE e.event_id = v.event_id AND e.collected_at = v.collected_at`,
      chunk.flat().map((v, i) => fitParam(v, i % 14))
    );
  }
}

async function batchMarkUnclassified(client: any, rows: any[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPDATE_SUBBATCH) {
    const chunk = rows.slice(i, i + UPDATE_SUBBATCH);
    if (chunk.length === 0) continue;

    const values = chunk
      .map((_, r) => {
        const b = r * 3;
        return `($${b + 1}::jsonb, $${b + 2}::varchar, $${b + 3}::timestamp)`;
      })
      .join(', ');

    await client.query(
      `UPDATE events AS e SET event_data = v.event_data
       FROM (VALUES ${values}) AS v(event_data, event_id, collected_at)
       WHERE e.event_id = v.event_id AND e.collected_at = v.collected_at`,
      chunk.flat()
    );
  }
}

// ── Custom sig cache ──────────────────────────────────────────────

let customSigCache: Map<string, CustomSig> | null = null;
let customSigCacheTime = 0;

/**
 * Clamp an amount string to fit NUMERIC(78,18) (60 integer digits).
 * ERC-20 transfer amounts can be 78-digit uint256 values which overflow
 * the numeric column and abort the whole UPDATE batch.
 */
function clampAmount(v: string | null | undefined): string {
  if (!v) return '0';
  const s = String(v).trim();
  if (!s || s === '0') return '0';
  const negative = s.startsWith('-');
  const intPart = (negative ? s.slice(1) : s).split('.')[0].replace(/^0+/, '') || '0';
  if (intPart.length <= 60) return s;
  // Clamp to max value representable in NUMERIC(78,18)
  return (negative ? '-' : '') + '9'.repeat(60);
}

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
let reclassifyRunning = false; // 互斥锁：上一批未完成时跳过新批次，避免锁风暴

export function startReclassifyScheduler(): void {
  if (reclassifyTimer) return;

  const run = async () => {
    if (reclassifyRunning) return;
    reclassifyRunning = true;
    try {
      await reclassifyRawEvents();
    } catch { /* logged internally */ }
    finally {
      reclassifyRunning = false;
    }
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
