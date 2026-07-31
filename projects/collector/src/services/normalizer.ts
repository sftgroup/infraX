import { ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';
import { RpcPoolManager } from './rpcPool';
import { pool } from '../database';
import { logger } from '../logger';
import { broadcastEvent } from './eventBus';

/**
 * Event Normalizer — full-chain log classifier
 *
 * Uses eth_getLogs (no topic filter) to fetch ALL logs for a block,
 * then classifies each log locally into one of:
 *   transfer      — ERC-20 / native coin / SPL token transfer
 *   nft_transfer  — ERC-721 / ERC-1155 NFT transfer
 *   approval      — ERC-20 Allowance change
 *   swap          — UniswapV2 / UniswapV3 token swap
 *   deposit       — WETH / wNative deposit
 *   withdrawal    — WETH / wNative withdrawal
 *   mint          — ERC-20 mint
 *   burn          — ERC-20 burn
 *   raw_event     — unrecognised topic (preserved for later analysis)
 *
 * Zero extra RPC calls — same eth_getLogs already fetches everything.
 */

const CONFIRMATIONS_REQUIRED = 3;

// ── Well-known event signatures (keccak256 first 4 bytes of topic[0]) ─
const SIGS = {
  ERC20_TRANSFER:    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  ERC20_APPROVAL:    '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  UNIV2_SWAP:        '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  UNIV3_SWAP:        '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  WETH_DEPOSIT:      '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',
  WETH_WITHDRAWAL:   '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65',
  ERC1155_SINGLE:    '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
  ERC1155_BATCH:     '0x4a39dc06b4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb',
  ERC20_MINT:        '0x0f6798a571793762a0c5d0c1e74c9c5c9b27a76c88beebce18607e95f3dfed9b',
  ERC20_BURN:        '0xcc16f5dbb4873280815c1ee09dbd06736cffcc18402cfaed63bb8c5f01e5052a',
  TRANSFER:          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
} as const;

export interface NormalizedEvent {
  event_id: string;
  event_type: string;
  source: string;
  chain: string;
  block_number: number;
  tx_hash: string;
  log_index: number;
  contract_address: string | null;
  from_address: string | null;
  to_address: string | null;
  token_address: string | null;
  token_symbol: string | null;
  token_id: string | null;
  amount: string | null;
  amount_raw: string | null;
  event_data: Record<string, any>;
  topic_hash: string | null;
  status: string;
  confirmations: number;
}

/** Safely convert hex string to BigInt — returns 0n for empty/invalid hex */
function safeBigInt(hex: string): bigint {
  try {
    if (!hex || hex === '0x' || hex === '0x0') return 0n;
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

/** Safely parse a hex string to a number — returns 0 for empty/invalid hex */
function safeParseInt(hex: string): number {
  try {
    if (!hex || hex === '0x' || hex === '0x0') return 0;
    return parseInt(hex, 16);
  } catch {
    return 0;
  }
}

/**
 * Extract and normalize all events from a raw block+logs
 */
export function normalizeBlock(rawBlock: any, chain: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const { block, logs } = rawBlock;

  if (!block || !block.transactions) return events;

  const blockNumber = safeParseInt(block.number);
  const blockTimestamp = safeParseInt(block.timestamp);

  // 1. Extract ETH transfers from transactions
  for (const tx of block.transactions) {
    if (!tx.hash) continue;
    const txHashStr = tx.hash;

    // ETH transfer (value > 0)
    const valueWei = safeBigInt(tx.value || '0x0');
    if (valueWei > 0n) {
      events.push({
        event_id: `${txHashStr}_0`,
        event_type: 'transfer',
        source: 'blockchain',
        chain: normalizeChainName(chain),
        block_number: blockNumber,
        tx_hash: txHashStr,
        log_index: 0,
        contract_address: '',
        from_address: safeChecksum(tx.from),
        to_address: safeChecksum(tx.to),
        token_address: '',
        token_symbol: nativeToken(chain),
        token_id: '',
        amount: ethers.formatEther(valueWei),
        amount_raw: valueWei.toString(),
        event_data: {
          gas: safeParseInt(tx.gas || '0x0'),
          gasPrice: safeParseInt(tx.gasPrice || '0x0'),
          nonce: safeParseInt(tx.nonce || '0x0'),
          input: tx.input?.length > 500 ? tx.input.slice(0, 500) + '...' : tx.input,
        },
        topic_hash: '',
        status: 'confirmed',
        confirmations: CONFIRMATIONS_REQUIRED,
      });
    }
  }

  // 2. Store ALL logs as raw_event (classification deferred to reclassifyRawEvents)
  if (logs && Array.isArray(logs)) {
    for (const log of logs) {
      const topics = log.topics || [];
      if (topics.length === 0) continue;

      const raw = rawLogEvent(log, blockNumber, blockTimestamp, chain);
      events.push(raw);
    }
  }

  return events;
}

/**
 * Store a raw log as an unclassified raw_event.
 * Preserves the full topics[] + data hex in event_data._raw
 * so reclassifyRawEvents() can reconstruct the log later.
 */
function rawLogEvent(
  log: { address: string; topics: string[]; data: string; transactionHash: string; logIndex: string },
  blockNumber: number,
  blockTimestamp: number,
  chain: string
): NormalizedEvent {
  const ch = normalizeChainName(chain);
  const logIndexNum = safeParseInt(log.logIndex || '0');
  const topics = log.topics || [];
  const topic0 = topics[0] || '';

  return makeEvent(ch, blockNumber, log, logIndexNum, 'raw_event', {
    contract_address: safeChecksum(log.address),
    from_address: '',
    to_address: '',
    token_address: safeChecksum(log.address),
    token_id: '',
    amount: '0',
    amount_raw: '0',
    topic_hash: topic0,
    event_data: {
      blockTimestamp,
      logIndex: logIndexNum,
      _raw: {
        address: log.address,
        topics: topics,
        data: log.data || '0x',
      },
    },
  });
}

// ── Log Classifier ────────────────────────────────────────────────────

interface LogData {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export function classifyLog(
  log: LogData,
  blockNumber: number,
  blockTimestamp: number,
  chain: string
): NormalizedEvent | null {
  const topics = log.topics || [];
  if (topics.length === 0) return null;

  const topic0 = topics[0];
  const logIndex = safeParseInt(log.logIndex || '0');
  const ch = normalizeChainName(chain);

  switch (topic0) {
    // ── ERC-20 / ERC-721 / ERC-1155 Transfer ──
    case SIGS.TRANSFER:
      if (topics.length >= 3 && log.data && log.data !== '0x' && log.data !== '0x0') {
        // ERC-20: value is in data (not indexed), topics[1]=from, topics[2]=to
        return makeEvent(ch, blockNumber, log, logIndex, 'transfer', {
          contract_address: safeChecksum(log.address),
          from_address: topicToAddress(topics[1]),
          to_address: topicToAddress(topics[2]),
          token_address: safeChecksum(log.address),
          token_symbol: '',
          token_id: '',
          amount: ethers.formatUnits(safeBigInt(log.data), 0),
          amount_raw: safeBigInt(log.data).toString(),
          topic_hash: topic0,
          event_data: { blockTimestamp, logIndex, removed: log.removed || false },
        });
      } else if (topics.length >= 4) {
        // ERC-721: all 3 params indexed (from+to+tokenId), data is empty
        const tokenId = safeBigInt(topics[3]).toString();
        return makeEvent(ch, blockNumber, log, logIndex, 'nft_transfer', {
          contract_address: safeChecksum(log.address),
          from_address: topicToAddress(topics[1]),
          to_address: topicToAddress(topics[2]),
          token_address: safeChecksum(log.address),
          token_symbol: '',
          token_id: tokenId,
          amount: '1',
          amount_raw: '1',
          topic_hash: topic0,
          event_data: { blockTimestamp, logIndex, tokenId, standard: 'ERC-721' },
        });
      } else {
        // Degraded ERC-20: topics < 3 (should never happen, but be safe)
        return makeEvent(ch, blockNumber, log, logIndex, 'transfer', {
          contract_address: safeChecksum(log.address),
          from_address: topics.length > 1 ? topicToAddress(topics[1]) : '',
          to_address: topics.length > 2 ? topicToAddress(topics[2]) : '',
          token_address: safeChecksum(log.address),
          amount: safeBigInt(log.data || '0x0') > 0n ? ethers.formatUnits(safeBigInt(log.data), 0) : '0',
          amount_raw: safeBigInt(log.data || '0x0').toString(),
          topic_hash: topic0,
          event_data: { blockTimestamp, logIndex, note: 'degraded_transfer' },
        });
      }

    // ── ERC-20 Approval ──
    case SIGS.ERC20_APPROVAL:
      return makeEvent(ch, blockNumber, log, logIndex, 'approval', {
        contract_address: safeChecksum(log.address),
        from_address: topicToAddress(topics[1]),   // owner
        to_address: topicToAddress(topics[2]),     // spender
        token_address: safeChecksum(log.address),
        amount: safeBigInt(log.data || '0x0').toString(),
        amount_raw: safeBigInt(log.data || '0x0').toString(),
        topic_hash: topic0,
        event_data: {
          blockTimestamp, logIndex,
          owner: topicToAddress(topics[1]),
          spender: topicToAddress(topics[2]),
          value: safeBigInt(log.data || '0x0').toString(),
        },
      });

    // ── WETH Deposit ──
    case SIGS.WETH_DEPOSIT:
      return makeEvent(ch, blockNumber, log, logIndex, 'deposit', {
        contract_address: safeChecksum(log.address),
        from_address: '',
        to_address: topicToAddress(topics[1]),
        token_address: safeChecksum(log.address),
        amount: ethers.formatEther(safeBigInt(log.data || '0x0')),
        amount_raw: safeBigInt(log.data || '0x0').toString(),
        topic_hash: topic0,
        event_data: { blockTimestamp, logIndex, dst: topicToAddress(topics[1]), wad: safeBigInt(log.data || '0x0').toString() },
      });

    // ── WETH Withdrawal ──
    case SIGS.WETH_WITHDRAWAL:
      return makeEvent(ch, blockNumber, log, logIndex, 'withdrawal', {
        contract_address: safeChecksum(log.address),
        from_address: topicToAddress(topics[1]),
        to_address: '',
        token_address: safeChecksum(log.address),
        amount: ethers.formatEther(safeBigInt(log.data || '0x0')),
        amount_raw: safeBigInt(log.data || '0x0').toString(),
        topic_hash: topic0,
        event_data: { blockTimestamp, logIndex, src: topicToAddress(topics[1]), wad: safeBigInt(log.data || '0x0').toString() },
      });

    // ── UniswapV2 Swap ──
    // topics[0]=Swap, topics[1]=sender, topics[2]=to
    // data = amount0In(256) + amount0Out(256) + amount1In(256) + amount1Out(256)
    case SIGS.UNIV2_SWAP:
      {
        const vals = decodeUint256Array(log.data || '0x', 4);
        return makeEvent(ch, blockNumber, log, logIndex, 'swap', {
          contract_address: safeChecksum(log.address),
          from_address: topicToAddress(topics[1]),
          to_address: topicToAddress(topics[2]),
          token_address: safeChecksum(log.address),
          amount: vals[2] > 0n ? ethers.formatUnits(vals[2], 0) : ethers.formatUnits(vals[3], 0),
          amount_raw: (vals[2] > 0n ? vals[2] : vals[3]).toString(),
          topic_hash: topic0,
          event_data: {
            blockTimestamp, logIndex,
            sender: topicToAddress(topics[1]),
            to: topicToAddress(topics[2]),
            amount0In: vals[0].toString(),
            amount0Out: vals[1].toString(),
            amount1In: vals[2].toString(),
            amount1Out: vals[3].toString(),
            dex: 'UniswapV2',
          },
        });
      }

    // ── UniswapV3 Swap ──
    // topics[0]=Swap, topics[1]=sender, topics[2]=recipient
    // data = amount0(int256) + amount1(int256) + sqrtPriceX96(160) + liquidity(128) + tick(int24)
    case SIGS.UNIV3_SWAP:
      {
        const vals = decodeUint256Array(log.data || '0x', 2);
        const amt0 = safeInt256(log.data || '0x', 0);
        const amt1 = safeInt256(log.data || '0x', 32);
        const amt0Abs = amt0 < 0n ? -amt0 : amt0;
        const amt1Abs = amt1 < 0n ? -amt1 : amt1;
        return makeEvent(ch, blockNumber, log, logIndex, 'swap', {
          contract_address: safeChecksum(log.address),
          from_address: topicToAddress(topics[1]),
          to_address: topicToAddress(topics[2]),
          token_address: safeChecksum(log.address),
          amount: ethers.formatUnits(amt0Abs > 0n ? amt0Abs : amt1Abs, 0),
          amount_raw: (amt0Abs > 0n ? amt0Abs : amt1Abs).toString(),
          topic_hash: topic0,
          event_data: {
            blockTimestamp, logIndex,
            sender: topicToAddress(topics[1]),
            recipient: topicToAddress(topics[2]),
            amount0: amt0.toString(),
            amount1: amt1.toString(),
            dex: 'UniswapV3',
          },
        });
      }

    // ── ERC-1155 TransferSingle ──
    case SIGS.ERC1155_SINGLE:
      {
        const id = topics.length > 3 ? safeBigInt(topics[3]).toString() : '0';
        const value = safeBigInt(log.data ? '0x' + log.data.slice(2, 66) : '0x0').toString();
        return makeEvent(ch, blockNumber, log, logIndex, 'nft_transfer', {
          contract_address: safeChecksum(log.address),
          from_address: topicToAddress(topics[2]),
          to_address: topicToAddress(topics[3]),
          token_address: safeChecksum(log.address),
          token_id: id,
          amount: value,
          amount_raw: value,
          topic_hash: topic0,
          event_data: {
            blockTimestamp, logIndex,
            operator: topicToAddress(topics[1]),
            id, value,
            standard: 'ERC-1155',
          },
        });
      }

    // ── ERC-1155 TransferBatch ──
    case SIGS.ERC1155_BATCH:
      return makeEvent(ch, blockNumber, log, logIndex, 'nft_transfer', {
        contract_address: safeChecksum(log.address),
        from_address: topicToAddress(topics[2]),
        to_address: topicToAddress(topics[3]),
        token_address: safeChecksum(log.address),
        amount: '0',
        amount_raw: '0',
        topic_hash: topic0,
        event_data: {
          blockTimestamp, logIndex,
          operator: topicToAddress(topics[1]),
          standard: 'ERC-1155-Batch',
        },
      });

    // ── ERC-20 Mint ──
    case SIGS.ERC20_MINT:
      return makeEvent(ch, blockNumber, log, logIndex, 'mint', {
        contract_address: safeChecksum(log.address),
        from_address: '',
        to_address: topicToAddress(topics[1]),
        token_address: safeChecksum(log.address),
        amount: ethers.formatUnits(safeBigInt(log.data || '0x0'), 0),
        amount_raw: safeBigInt(log.data || '0x0').toString(),
        topic_hash: topic0,
        event_data: { blockTimestamp, logIndex, to: topicToAddress(topics[1]), value: safeBigInt(log.data || '0x0').toString() },
      });

    // ── ERC-20 Burn ──
    case SIGS.ERC20_BURN:
      return makeEvent(ch, blockNumber, log, logIndex, 'burn', {
        contract_address: safeChecksum(log.address),
        from_address: topicToAddress(topics[1]),
        to_address: '',
        token_address: safeChecksum(log.address),
        amount: ethers.formatUnits(safeBigInt(log.data || '0x0'), 0),
        amount_raw: safeBigInt(log.data || '0x0').toString(),
        topic_hash: topic0,
        event_data: { blockTimestamp, logIndex, from: topicToAddress(topics[1]), value: safeBigInt(log.data || '0x0').toString() },
      });

    // ── Unknown — capture as raw_event for later analysis ──
    default:
      return makeEvent(ch, blockNumber, log, logIndex, 'raw_event', {
        contract_address: safeChecksum(log.address),
        from_address: topics.length > 1 ? topicToHex(topics[1]) : '',
        to_address: topics.length > 2 ? topicToHex(topics[2]) : '',
        token_address: safeChecksum(log.address),
        amount: '0',
        amount_raw: '0',
        topic_hash: topic0,
        event_data: {
          blockTimestamp, logIndex,
          topics: topics.slice(0, 5),
          dataPreview: (log.data || '').length > 128 ? (log.data || '').slice(0, 128) + '...' : (log.data || ''),
        },
      });
  }
}

/**
 * Build a NormalizedEvent from classified log data (caller provides all fields).
 */
function makeEvent(
  chain: string,
  blockNumber: number,
  log: Pick<LogData, 'transactionHash' | 'removed'>,
  logIndex: number,
  eventType: string,
  overrides: Partial<NormalizedEvent> & { event_data?: Record<string, any> }
): NormalizedEvent {
  const evt: NormalizedEvent = {
    event_id: `${log.transactionHash || '0xunknown'}_${logIndex}`,
    event_type: eventType,
    source: 'blockchain',
    chain,
    block_number: blockNumber,
    tx_hash: log.transactionHash || '',
    log_index: logIndex,
    contract_address: null,
    from_address: null,
    to_address: null,
    token_address: null,
    token_symbol: null,
    token_id: null,
    amount: null,
    amount_raw: null,
    event_data: {},
    topic_hash: null,
    status: 'confirmed',
    confirmations: CONFIRMATIONS_REQUIRED,
    ...overrides,
  };
  return evt;
}

/**
 * Normalize a Solana block — extract SPL token transfers from tokenBalances
 */
export function normalizeSolanaBlock(rawBlock: any): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  if (!rawBlock || !rawBlock.transactions) return events;

  const slot = rawBlock.blockHeight ?? rawBlock.slot ?? 0;
  const blockTime = rawBlock.blockTime ?? 0;

  for (const tx of rawBlock.transactions) {
    const txSig = tx.transaction?.signatures?.[0];
    if (!txSig) continue;

    const meta = tx.meta || {};
    if (meta.err) continue; // skip failed transactions

    const pre = meta.preTokenBalances || [];
    const post = meta.postTokenBalances || [];

    if (pre.length === 0 && post.length === 0) continue;

    // Build pre/post balance maps keyed by (mint, owner, accountIndex)
    const preMap = new Map<string, any>();
    for (const b of pre) {
      const key = `${b.mint}|${b.owner}|${b.accountIndex}`;
      preMap.set(key, b);
    }

    const postMap = new Map<string, any>();
    for (const b of post) {
      const key = `${b.mint}|${b.owner}|${b.accountIndex}`;
      postMap.set(key, b);
    }

    // Find transfers: same (mint, accountIndex) but different owner or amount
    for (const [key, postBal] of postMap) {
      const preBal = preMap.get(key);
      if (!preBal) continue;

      const preAmount = BigInt(preBal.uiTokenAmount?.amount || '0');
      const postAmount = BigInt(postBal.uiTokenAmount?.amount || '0');

      if (postAmount === preAmount) continue;

      const token = preBal.uiTokenAmount || {};
      const mint = preBal.mint;
      const decimals = token.decimals || 9;
      const diff = postAmount > preAmount ? postAmount - preAmount : preAmount - postAmount;
      const direction = postAmount > preAmount ? 'in' : 'out';

      const amountRaw = diff.toString();
      const amount = ethers.formatUnits(diff, decimals);

      // Find corresponding sender/receiver accounts
      const toAddress = direction === 'in' ? postBal.owner : null;
      const fromAddress = direction === 'out' ? preBal.owner : null;

      // Try to find counterpart in post balances
      let counterpart: string | null = null;
      if (direction === 'in') {
        // Find who sent to this owner
        for (const [k2, b2] of postMap) {
          if (k2 === key) continue;
          const b2Post = BigInt(b2.uiTokenAmount?.amount || '0');
          const b2Pre = preMap.get(k2);
          if (!b2Pre) continue;
          const b2PreAmt = BigInt(b2Pre.uiTokenAmount?.amount || '0');
          if (b2Post < b2PreAmt && parseInt(b2.mint, 16) === parseInt(mint, 16)) {
            counterpart = b2.owner;
            break;
          }
        }
      } else {
        for (const [, b2] of postMap) {
          if (b2.owner === postBal.owner) continue;
          const b2Post = BigInt(b2.uiTokenAmount?.amount || '0');
          const b2PreKey = `${b2.mint}|${b2.owner}|${b2.accountIndex}`;
          const b2Pre2 = preMap.get(b2PreKey);
          if (!b2Pre2) continue;
          const b2PreAmt = BigInt(b2Pre2.uiTokenAmount?.amount || '0');
          if (b2Post > b2PreAmt && b2.mint === mint) {
            counterpart = b2.owner;
            break;
          }
        }
      }

      const symbol = mint === 'So11111111111111111111111111111111111111112' ? 'SOL'
        : mint.length > 16 ? `${mint.slice(0, 4)}...${mint.slice(-4)}` : mint;

      events.push({
        event_id: `${txSig}_${mint.slice(0, 12)}_${preBal.accountIndex}`,
        event_type: 'transfer',
        source: 'blockchain',
        chain: 'solana',
        block_number: slot,
        tx_hash: txSig,
        log_index: preBal.accountIndex,
        contract_address: null,
        from_address: direction === 'out' ? postBal.owner : (counterpart || preBal.owner),
        to_address: direction === 'in' ? postBal.owner : (counterpart || postBal.owner),
        token_address: mint,
        token_symbol: symbol,
        token_id: null,
        amount,
        amount_raw: amountRaw,
        event_data: {
          slot,
          blockTime,
          decimals,
          programId: preBal.programId,
        },
        topic_hash: null,
        status: 'confirmed',
        confirmations: 1,
      });
    }
  }

  return events;
}

/**
 * Insert normalized events into the database (idempotent on event_id).
 * Uses SAVEPOINT per row so one bad record doesn't abort the entire batch.
 */
export async function insertEvents(events: NormalizedEvent[]): Promise<number> {
  if (events.length === 0) return 0;

  const client = await pool.connect();
  let insertedCount = 0;

  try {
    // Wrap entire batch in one transaction; use SAVEPOINTs so one bad row
    // doesn't abort the whole batch.
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
            evt.token_symbol,
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

// ================================================================
// Reclassification — post-processing batch job
// ================================================================

const RECLASSIFY_INTERVAL_MS = 30_000; // 30 seconds
const RECLASSIFY_BATCH_SIZE = 500;

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

  // First run after 10s
  setTimeout(run, 10_000).unref?.();

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

// ================================================================
// Helpers
// ================================================================

function safeChecksum(address: string | null | undefined): string | null {
  if (!address) return null;
  try {
    return ethers.getAddress(address);
  } catch {
    return null;
  }
}

function topicToAddress(topic: string): string {
  try {
    return ethers.getAddress('0x' + topic.slice(26));
  } catch {
    return topic;
  }
}

function normalizeChainName(chain: string): string {
  const map: Record<string, string> = {
    eth: 'ethereum',
    ethereum: 'ethereum',
    sepolia: 'sepolia',
    bsc: 'bsc',
    base: 'base',
    sol: 'solana',
    solana: 'solana',
  };
  return map[chain.toLowerCase()] || chain.toLowerCase();
}

function nativeToken(chain: string): string {
  const map: Record<string, string> = {
    sepolia: 'sETH',
    ethereum: 'ETH',
    bsc: 'BNB',
    base: 'ETH',
    solana: 'SOL',
  };
  return map[chain.toLowerCase()] || 'ETH';
}

/**
 * Decode a hex data string into an array of uint256 values.
 */
function decodeUint256Array(dataHex: string, count: number): bigint[] {
  const vals: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const offset = 2 + i * 64;
    const chunk = dataHex.length > offset ? '0x' + dataHex.slice(offset, offset + 64) : '0x0';
    vals.push(safeBigInt(chunk));
  }
  return vals;
}

/**
 * Safely parse a signed int256 from a hex string at a given byte offset.
 */
function safeInt256(dataHex: string, byteOffset: number): bigint {
  const start = 2 + byteOffset * 2;
  const chunk = dataHex.length > start ? '0x' + dataHex.slice(start, start + 64) : '0x0';
  try {
    const val = BigInt(chunk);
    // If top bit is set, it's negative in two's complement
    if (val >= (1n << 255n)) {
      return val - (1n << 256n);
    }
    return val;
  } catch {
    return 0n;
  }
}

/**
 * Convert a topic to hex string without address checksumming (for unknown events).
 */
function topicToHex(topic: string): string {
  return topic;
}
