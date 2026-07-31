import pg from 'pg';
import type { SessionKey, PermissionConfig, SessionStatus } from '@stevenwang000x/session-key-core';

export class SessionRepo {
  constructor(private pool: pg.Pool) {}

  async findById(id: string): Promise<SessionKey | null> {
    const result = await this.pool.query('SELECT * FROM session_keys WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;
    return rowToSession(result.rows[0]);
  }

  async findByUser(userId: string, chain?: string, status?: SessionStatus): Promise<SessionKey[]> {
    let sql = 'SELECT * FROM session_keys WHERE user_id = $1';
    const params: string[] = [userId.toLowerCase()];
    let idx = 1;
    if (chain) { idx++; sql += ` AND chain = $${idx}`; params.push(chain); }
    if (status) { idx++; sql += ` AND status = $${idx}`; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const result = await this.pool.query(sql, params);
    return result.rows.map(rowToSession);
  }

  async findActiveByUserAndContracts(userId: string, chain: string, contracts: string[]): Promise<SessionKey | null> {
    const result = await this.pool.query(
      `SELECT * FROM session_keys WHERE user_id = $1 AND chain = $2 AND status = 'active'
       AND permissions @> $3::jsonb`,
      [userId.toLowerCase(), chain, JSON.stringify({ contracts })]
    );
    if (result.rows.length === 0) return null;
    return rowToSession(result.rows[0]);
  }

  async create(params: {
    userId: string; chain: string; sessionAddress: string; sessionKeyEnc: string;
    validUntil: Date; permissions: PermissionConfig; maxPerTx: string; maxTotal: string;
  }): Promise<SessionKey> {
    const result = await this.pool.query(
      `INSERT INTO session_keys (user_id, chain, session_address, session_key_enc, valid_until, permissions, max_per_tx, max_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [params.userId.toLowerCase(), params.chain, params.sessionAddress, params.sessionKeyEnc,
       params.validUntil, JSON.stringify(params.permissions), params.maxPerTx, params.maxTotal]
    );
    return rowToSession(result.rows[0]);
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE session_keys SET status = 'revoked', revoked_at = NOW() WHERE id = $1 AND status = 'active'`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateStatus(id: string, status: SessionStatus): Promise<void> {
    await this.pool.query('UPDATE session_keys SET status = $1 WHERE id = $2', [status, id]);
  }

  async addSpent(id: string, amount: string): Promise<void> {
    await this.pool.query('UPDATE session_keys SET total_spent = total_spent + $1::decimal WHERE id = $2', [amount, id]);
  }

  async expireStale(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE session_keys SET status = 'expired' WHERE status = 'active' AND valid_until < NOW()`
    );
    return result.rowCount ?? 0;
  }
}

function rowToSession(row: any): SessionKey {
  return {
    id: row.id, userId: row.user_id, chain: row.chain,
    sessionAddress: row.session_address, sessionKeyEnc: row.session_key_enc,
    validFrom: row.valid_from, validUntil: row.valid_until,
    permissions: row.permissions, maxPerTx: row.max_per_tx,
    maxTotal: row.max_total, totalSpent: row.total_spent,
    status: row.status, createdAt: row.created_at, revokedAt: row.revoked_at,
  };
}
