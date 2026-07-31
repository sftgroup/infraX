import { ethers } from 'ethers';

/**
 * Event Normalizer — full-chain log capture + classifier
 *
 * Capture:
 *   - ETH native transfers from block.transactions
 *   - ALL logs from eth_getLogs stored as raw_event (topics:[null] — one RPC call)
 *
 * Classification (post-processing via reclassifier.ts):
 *   transfer      — ERC-20 / native coin / SPL token transfer
 *   nft_transfer  — ERC-721 / ERC-1155 NFT transfer
 *   approval      — ERC-20 Allowance change
 *   swap          — UniswapV2 / UniswapV3 token swap
 *   deposit       — WETH / wNative deposit
 *   withdrawal    — WETH / wNative withdrawal
 *   mint          — ERC-20 mint
 *   burn          — ERC-20 burn
 *   raw_event     — unrecognised topic (preserved for later analysis)
 */

// ── Truncation limits ──────────────────────────────────────────────
const INPUT_TRUNCATE_BYTES = 500;
const TRUNCATE_SUFFIX = '...';
const TOPICS_PREVIEW_LIMIT = 5;
const DATA_PREVIEW_BYTES = 128;

// ── ERC1155 ABI layout ─────────────────────────────────────────────
const ERC1155_VALUE_DATA_OFFSET = 66; // bytes offset for value in TransferSingle data

// ── Misc ───────────────────────────────────────────────────────────
const CONFIRMATIONS_REQUIRED = 3;
const FALLBACK_EVENT_ID = '0xunknown';
const FALLBACK_HEX = '0x0';

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

// ── Helpers ────────────────────────────────────────────────────────

function isEmptyHex(hex: string): boolean {
  return !hex || hex === '0x' || hex === '0x0';
}

/** Safely convert hex string to BigInt — returns 0n for empty/invalid hex */
function safeBigInt(hex: string): bigint {
  try { return isEmptyHex(hex) ? 0n : BigInt(hex); } catch { return 0n; }
}

/** Safely parse a hex string to a number — returns 0 for empty/invalid hex */
function safeParseInt(hex: string): number {
  try { return isEmptyHex(hex) ? 0 : parseInt(hex, 16); } catch { return 0; }
}

function safeChecksum(address: string | null | undefined): string | null {
  if (!address) return null;
  try { return ethers.getAddress(address); } catch { return null; }
}

function topicToAddress(topic: string): string {
  try { return ethers.getAddress('0x' + topic.slice(26)); } catch { return topic; }
}

function topicToHex(topic: string): string {
  return topic;
}

function normalizeChainName(chain: string): string {
  const map: Record<string, string> = {
    eth: 'ethereum', ethereum: 'ethereum',
    sepolia: 'sepolia', bsc: 'bsc', base: 'base',
    sol: 'solana', solana: 'solana',
  };
  return map[chain.toLowerCase()] || chain.toLowerCase();
}

function nativeToken(chain: string): string {
  const map: Record<string, string> = {
    sepolia: 'sETH', ethereum: 'ETH', bsc: 'BNB', base: 'ETH', solana: 'SOL',
  };
  return map[chain.toLowerCase()] || 'ETH';
}

function decodeUint256Array(dataHex: string, count: number): bigint[] {
  const vals: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const offset = 2 + i * 64;
    const chunk = dataHex.length > offset ? '0x' + dataHex.slice(offset, offset + 64) : FALLBACK_HEX;
    vals.push(safeBigInt(chunk));
  }
  return vals;
}

function safeInt256(dataHex: string, byteOffset: number): bigint {
  const start = 2 + byteOffset * 2;
  const chunk = dataHex.length > start ? '0x' + dataHex.slice(start, start + 64) : FALLBACK_HEX;
  try {
    const val = BigInt(chunk);
    return val >= (1n << 255n) ? val - (1n << 256n) : val; // two's complement
  } catch { return 0n; }
}

// ── Block normalisation ────────────────────────────────────────────

/**
 * Extract and normalize all events from a raw block+logs.
 * ETH transfers classified immediately; logs stored as raw_event
 * for later batch classification via reclassifier.ts.
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

    const valueWei = safeBigInt(tx.value || FALLBACK_HEX);
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
          gas: safeParseInt(tx.gas || FALLBACK_HEX),
          gasPrice: safeParseInt(tx.gasPrice || FALLBACK_HEX),
          nonce: safeParseInt(tx.nonce || FALLBACK_HEX),
          input: tx.input?.length > INPUT_TRUNCATE_BYTES
            ? tx.input.slice(0, INPUT_TRUNCATE_BYTES) + TRUNCATE_SUFFIX
            : tx.input,
        },
        topic_hash: '',
        status: 'confirmed',
        confirmations: CONFIRMATIONS_REQUIRED,
      });
    }
  }

  // 2. Store ALL logs as raw_event (classification deferred to reclassifier.ts)
  if (logs && Array.isArray(logs)) {
    for (const log of logs) {
      const topics = log.topics || [];
      if (topics.length === 0) continue;
      events.push(rawLogEvent(log, blockNumber, blockTimestamp, chain));
    }
  }

  return events;
}

/**
 * Store a raw log as an unclassified raw_event.
 * Preserves the full topics[] + data hex in event_data._raw
 * so reclassifier.ts can reconstruct the log later.
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

// ── Log Classifier (exported for reclassifier.ts) ───────────────────

export interface LogData {
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
      if (topics.length >= 3 && log.data && !isEmptyHex(log.data)) {
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
          amount: safeBigInt(log.data || FALLBACK_HEX) > 0n ? ethers.formatUnits(safeBigInt(log.data), 0) : '0',
          amount_raw: safeBigInt(log.data || FALLBACK_HEX).toString(),
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
        amount: safeBigInt(log.data || FALLBACK_HEX).toString(),
        amount_raw: safeBigInt(log.data || FALLBACK_HEX).toString(),
        topic_hash: topic0,
        event_data: {
          blockTimestamp, logIndex,
          owner: topicToAddress(topics[1]),
          spender: topicToAddress(topics[2]),
          value: safeBigInt(log.data || FALLBACK_HEX).toString(),
        },
      });

    // ── WETH Deposit ──
    case SIGS.WETH_DEPOSIT:
      return makeEvent(ch, blockNumber, log, logIndex, 'deposit', {
        contract_address: safeChecksum(log.address),
        from_address: '',
        to_address: topicToAddress(topics[1]),
        token_address: safeChecksum(log.address),
        amount: ethers.formatEther(safeBigInt(log.data || FALLBACK_HEX)),
        amount_raw: safeBigInt(log.data || FALLBACK_HEX).toString(),
        topic_hash: topic0,
        event_data: { blockTimestamp, logIndex, dst: topicToAddress(topics[1]), wad: safeBigInt(log.data || FALLBACK_HEX).toString() },
      });

    // ── WETH Withdrawal ──
    case SIGS.WETH_WITHDRAWAL:
      return makeEvent(ch, blockNumber, log, logIndex, 'withdrawal', {
        contract_address: safeChecksum(log.address),
        from_address: topicToAddress(topics[1]),
        to_address: '',
        token_address: safeChecksum(log.address),
        amount: ethers.formatEther(safeBigInt(log.data || FALLBACK_HEX)),
        amount_raw: safeBigInt(log.data || FALLBACK_HEX).toString(),
        topic_hash: topic0,
        event_data: { blockTimestamp, logIndex, src: topicToAddress(topics[1]), wad: safeBigInt(log.data || FALLBACK_HEX).toString() },
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
        const value = safeBigInt(log.data ? '0x' + log.data.slice(2, ERC1155_VALUE_DATA_OFFSET) : FALLBACK_HEX).toString();
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
        amount: ethers.formatUnits(safeBigInt(log.data || FALLBACK_HEX), 0),
        amount_raw: safeBigInt(log.data || FALLBACK_HEX).toString(),
        topic_hash: topic0,
        event_data: { blockTimestamp, logIndex, to: topicToAddress(topics[1]), value: safeBigInt(log.data || FALLBACK_HEX).toString() },
      });

    // ── ERC-20 Burn ──
    case SIGS.ERC20_BURN:
      return makeEvent(ch, blockNumber, log, logIndex, 'burn', {
        contract_address: safeChecksum(log.address),
        from_address: topicToAddress(topics[1]),
        to_address: '',
        token_address: safeChecksum(log.address),
        amount: ethers.formatUnits(safeBigInt(log.data || FALLBACK_HEX), 0),
        amount_raw: safeBigInt(log.data || FALLBACK_HEX).toString(),
        topic_hash: topic0,
        event_data: { blockTimestamp, logIndex, from: topicToAddress(topics[1]), value: safeBigInt(log.data || FALLBACK_HEX).toString() },
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
          topics: topics.slice(0, TOPICS_PREVIEW_LIMIT),
          dataPreview: (log.data || '').length > DATA_PREVIEW_BYTES
            ? (log.data || '').slice(0, DATA_PREVIEW_BYTES) + TRUNCATE_SUFFIX
            : (log.data || ''),
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
  return {
    event_id: `${log.transactionHash || FALLBACK_EVENT_ID}_${logIndex}`,
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
}
