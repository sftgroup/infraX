import { pool } from '../models/database';
import { logger } from '../utils/logger';

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
  const result = await pool.query(`
    SELECT
      chain,
      COUNT(*)::int as event_count,
      MAX(block_number)::bigint as latest_block,
      MIN(block_number)::bigint as oldest_block,
      COUNT(DISTINCT tx_hash)::int as unique_tx
    FROM events
    GROUP BY chain
    ORDER BY event_count DESC
  `);
  return result.rows;
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
