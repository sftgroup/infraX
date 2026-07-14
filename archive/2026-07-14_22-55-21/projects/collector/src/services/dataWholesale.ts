import { pool } from '../database';
import { logger } from '../logger';

/**
 * Data Wholesale Service
 *
 * Provides query API for downstream consumers to access
 * standardized on-chain event data.
 *
 * Filterable by: chain, address, contract, event_type, block range
 * Supports cursor-based pagination.
 */

export interface EventQuery {
  chain?: string;
  address?: string;       // to_address OR from_address
  contract?: string;      // contract_address
  event_type?: string;
  from_block?: number;
  to_block?: number;
  page_size?: number;
  page_token?: string;
}

export interface EventQueryResult {
  data: any[];
  next_page_token: string | null;
  total_count?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

/**
 * Query events with filters + pagination
 */
export async function queryEvents(params: EventQuery): Promise<EventQueryResult> {
  const pageSize = Math.min(params.page_size || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  // Chain filter
  if (params.chain) {
    conditions.push(`chain = $${paramIndex++}`);
    values.push(params.chain.toLowerCase());
  }

  // Address filter (search both from_address and to_address)
  if (params.address) {
    conditions.push(`(from_address = $${paramIndex} OR to_address = $${paramIndex})`);
    values.push(params.address.toLowerCase());
    paramIndex++;
  }

  // Contract filter
  if (params.contract) {
    conditions.push(`contract_address = $${paramIndex++}`);
    values.push(params.contract.toLowerCase());
  }

  // Event type filter
  if (params.event_type) {
    conditions.push(`event_type = $${paramIndex++}`);
    values.push(params.event_type);
  }

  // Block range filters
  if (params.from_block) {
    conditions.push(`block_number >= $${paramIndex++}`);
    values.push(params.from_block);
  }
  if (params.to_block) {
    conditions.push(`block_number <= $${paramIndex++}`);
    values.push(params.to_block);
  }

  // Pagination cursor
  if (params.page_token) {
    try {
      const cursor = decodePageToken(params.page_token);
      if (cursor && cursor.block_number && cursor.event_id) {
        conditions.push(
          `(block_number < $${paramIndex} OR (block_number = $${paramIndex} AND event_id > $${paramIndex + 1}))`
        );
        values.push(cursor.block_number, cursor.event_id);
        paramIndex += 2;
      }
    } catch {
      // Invalid token → ignore
    }
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  // Query events
  const query = `
    SELECT
      event_id,
      event_type,
      chain,
      block_number,
      tx_hash,
      from_address,
      to_address,
      contract_address,
      token_address,
      token_symbol,
      amount,
      amount_raw,
      confirmations,
      collected_at,
      created_at
    FROM events
    ${whereClause}
    ORDER BY block_number DESC, event_id ASC
    LIMIT $${paramIndex}
  `;
  values.push(pageSize + 1); // Fetch one extra to detect has_more

  const result = await pool.query(query, values);
  const rows = result.rows;

  // Check for next page
  let nextPageToken: string | null = null;
  if (rows.length > pageSize) {
    rows.pop(); // Remove the extra row
    const lastRow = rows[rows.length - 1];
    nextPageToken = encodePageToken({
      block_number: parseInt(lastRow.block_number, 10),
      event_id: lastRow.event_id,
    });
  }

  return {
    data: rows.map(formatEventRow),
    next_page_token: nextPageToken,
  };
}

/**
 * Get event count for a query (for dashboard display)
 */
export async function getEventCount(params: EventQuery): Promise<number> {
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (params.chain) {
    conditions.push(`chain = $${paramIndex++}`);
    values.push(params.chain.toLowerCase());
  }
  if (params.event_type) {
    conditions.push(`event_type = $${paramIndex++}`);
    values.push(params.event_type);
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const result = await pool.query(
    `SELECT COUNT(*)::int as cnt FROM events ${whereClause}`,
    values
  );
  return result.rows[0].cnt;
}

/**
 * Get chain-level stats
 */
export async function getChainStats(): Promise<any[]> {
  // event_count is now maintained by the scanner (atomic increment per cycle), O(1) lookup
  const cps = await pool.query(
    `SELECT chain, last_block, event_count, last_fetch_at, status FROM event_checkpoints ORDER BY chain`
  );

  const chains = ['ethereum', 'bsc', 'base', 'sepolia', 'solana'];
  return chains.map(chain => {
    const cp = cps.rows.find((r: any) => r.chain === chain);
    return {
      chain,
      event_count: cp?.event_count || 0,
      latest_block: cp?.last_block || 0,
      oldest_block: 0,
      unique_tx: null,
      last_fetch: cp?.last_fetch_at || null,
      status: cp?.status || 'unknown',
    };
  });
}

// ================================================================
// Helpers
// ================================================================

interface PageCursor {
  block_number: number;
  event_id: string;
}

function encodePageToken(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64');
}

function decodePageToken(token: string): PageCursor | null {
  try {
    return JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function formatEventRow(row: any): any {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    chain: row.chain,
    block_number: parseInt(row.block_number, 10),
    tx_hash: row.tx_hash,
    from_address: row.from_address,
    to_address: row.to_address,
    contract_address: row.contract_address,
    token_address: row.token_address,
    token_symbol: row.token_symbol,
    amount: row.amount,
    amount_raw: row.amount_raw,
    confirmations: row.confirmations,
    collected_at: row.collected_at,
    created_at: row.created_at,
  };
}

// ================================================================
// Batch query — multiple addresses across multiple chains
// ================================================================

export interface BatchQuery {
  addresses?: string[];      // up to 20 addresses
  chains?: string[];          // up to 7 chains
  event_type?: string;       // optional event type filter
  per_address?: number;      // max results per address (default 50, max 100)
}

export interface BatchQueryResult {
  total: number;
  results: Record<string, any[]>;     // key: "chain:address"
  address_summary: Record<string, {  // per-address meta
    chain: string;
    address: string;
    count: number;
    latest_block: number;
    latest_tx_time: string | null;
  }>;
}

export async function queryEventsBatch(params: BatchQuery): Promise<BatchQueryResult> {
  const addresses = (params.addresses || []).slice(0, 20).map(a => a.toLowerCase());
  const chains = (params.chains || []).slice(0, 7).map(c => c.toLowerCase());
  const perAddress = Math.min(params.per_address || 50, 100);

  const results: Record<string, any[]> = {};
  const addressSummary: Record<string, any> = {};

  if (addresses.length === 0 || chains.length === 0) {
    return { total: 0, results: {}, address_summary: {} };
  }

  let totalCount = 0;

  for (const chain of chains) {
    // Build WHERE with OR chains for efficiency
    const addrPlaceholders = addresses.map((_, i) => `$${i + 2}`).join(', ');
    const query = `
      SELECT DISTINCT ON (event_id)
        event_id, event_type, chain, block_number, tx_hash,
        from_address, to_address, contract_address,
        token_address, token_symbol, amount, amount_raw,
        confirmations, collected_at, created_at
      FROM events
      WHERE chain = $1
        AND (from_address IN (${addrPlaceholders}) OR to_address IN (${addrPlaceholders}))
        ${params.event_type ? `AND event_type = $${addresses.length + 2}` : ''}
      ORDER BY block_number DESC, event_id ASC
      LIMIT $${addresses.length + (params.event_type ? 3 : 2)}
    `;
    const vals: any[] = [chain, ...addresses];
    if (params.event_type) vals.push(params.event_type);
    const totalLimit = addresses.length * perAddress;
    vals.push(totalLimit);

    try {
      const { rows } = await pool.query(query, vals);
      // Group by address
      for (const row of rows) {
        const addrKey = `${chain}:${row.from_address}`;
        const addrKey2 = `${chain}:${row.to_address}`;
        const event = formatEventRow(row);
        for (const k of [addrKey, addrKey2]) {
          if (!results[k]) results[k] = [];
          if (results[k].length < perAddress && !results[k].some((e: any) => e.event_id === event.event_id)) {
            results[k].push(event);
            totalCount++;
            if (!addressSummary[k]) {
              addressSummary[k] = {
                chain: event.chain,
                address: k.split(':')[1],
                count: 0,
                latest_block: 0,
                latest_tx_time: null,
              };
            }
            const summary = addressSummary[k];
            summary.count++;
            if (event.block_number > summary.latest_block) summary.latest_block = event.block_number;
            if (!summary.latest_tx_time || event.collected_at > summary.latest_tx_time) summary.latest_tx_time = event.collected_at;
          }
        }
      }
    } catch (err: any) {
      logger.error('[dataWholesale] Batch query failed', { chain, error: err.message });
    }
  }

  return { total: totalCount, results, address_summary: addressSummary };
}
