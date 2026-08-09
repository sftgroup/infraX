// ============================================================================
// aa-relay session 持久化存储（E-3a/b）
// 多租户三维键 (product, network, session_id) 落库；重启不失效。
// 复用 MPC 的 Postgres（DATABASE_URL，缺省 pocketx_mpc 库，独立表 aa_sessions）。
// ============================================================================
import { Pool } from 'pg';
import type { Address } from 'viem';
import type { NetworkId, SessionPolicy } from '../../aa-sdk/src/index.js';

export interface ProductSessionStore {
  save(product: string, policy: SessionPolicy, accountAddress: Address): Promise<void>;
  list(product: string, accountAddress: Address, network: NetworkId): Promise<SessionPolicy[]>;
  remove(product: string, sessionId: string, network: NetworkId): Promise<void>;
}

export class PostgresSessionStore implements ProductSessionStore {
  constructor(private readonly pool: Pool) {}

  /** 建表（幂等）：三维主键 (product, network, session_id) + account 索引 */
  async initTables(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS aa_sessions (
        product TEXT NOT NULL,
        network TEXT NOT NULL DEFAULT 'evm',
        session_id TEXT NOT NULL,
        account_address TEXT NOT NULL,
        signer TEXT NOT NULL,
        valid_after BIGINT NOT NULL,
        valid_until BIGINT NOT NULL,
        permissions JSONB NOT NULL,
        session_key_private_key TEXT,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (product, network, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_aa_sessions_account ON aa_sessions(account_address);
    `);
  }

  async save(product: string, policy: SessionPolicy, accountAddress: Address): Promise<void> {
    await this.pool.query(
      `INSERT INTO aa_sessions
         (product, network, session_id, account_address, signer, valid_after, valid_until, permissions, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (product, network, session_id) DO UPDATE SET
         account_address = EXCLUDED.account_address,
         signer = EXCLUDED.signer,
         valid_after = EXCLUDED.valid_after,
         valid_until = EXCLUDED.valid_until,
         permissions = EXCLUDED.permissions`,
      [
        product,
        policy.network,
        policy.sessionId,
        accountAddress.toLowerCase(),
        policy.signer.toLowerCase(),
        policy.validAfter.toString(),
        policy.validUntil.toString(),
        JSON.stringify(policy.permissions),
        Date.now(),
      ],
    );
  }

  async list(product: string, accountAddress: Address, network: NetworkId): Promise<SessionPolicy[]> {
    const r = await this.pool.query(
      `SELECT session_id, signer, valid_after, valid_until, permissions
       FROM aa_sessions
       WHERE product = $1 AND account_address = $2 AND network = $3
       ORDER BY created_at DESC`,
      [product, accountAddress.toLowerCase(), network],
    );
    return r.rows.map((row) => ({
      network,
      sessionId: row.session_id,
      signer: row.signer as Address,
      validAfter: BigInt(row.valid_after),
      validUntil: BigInt(row.valid_until),
      permissions: row.permissions,
    }));
  }

  async remove(product: string, sessionId: string, network: NetworkId): Promise<void> {
    await this.pool.query(
      `DELETE FROM aa_sessions WHERE product = $1 AND session_id = $2 AND network = $3`,
      [product, sessionId, network],
    );
  }
}
