import pg from 'pg';
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';

export interface Infra {
  pool: pg.Pool;
  redis: Redis;
}

let _infra: Infra | null = null;

/**
 * Create or return singleton database/redis connections.
 * In tests, pass a custom config to avoid module-level side effects.
 */
export function createInfra(configOverrides?: Partial<ReturnType<typeof loadConfig>>): Infra {
  if (_infra && !configOverrides) return _infra;

  const config = { ...loadConfig(), ...configOverrides };

  const infra: Infra = {
    pool: new pg.Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      max: 10,
      idleTimeoutMillis: 30000,
    }),
    redis: new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      maxRetriesPerRequest: 3,
    }),
  };

  if (!configOverrides) _infra = infra;
  return infra;
}

export async function initDb(pool: pg.Pool): Promise<void> {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_keys (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id         VARCHAR(64)     NOT NULL,
        chain           VARCHAR(16)     NOT NULL,
        session_address VARCHAR(44)     NOT NULL,
        session_key_enc TEXT            NOT NULL,
        valid_from      TIMESTAMP       NOT NULL DEFAULT NOW(),
        valid_until     TIMESTAMP       NOT NULL,
        permissions     JSONB           NOT NULL DEFAULT '{}',
        max_per_tx      DECIMAL(36,18)  NOT NULL,
        max_total       DECIMAL(36,18)  NOT NULL,
        total_spent     DECIMAL(36,18)  NOT NULL DEFAULT 0,
        status          VARCHAR(16)     NOT NULL DEFAULT 'active',
        created_at      TIMESTAMP       NOT NULL DEFAULT NOW(),
        revoked_at      TIMESTAMP,
        CONSTRAINT chk_status CHECK (status IN ('active','revoked','expired','quota_exhausted'))
    );
    CREATE INDEX IF NOT EXISTS idx_sk_user       ON session_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_sk_user_chain ON session_keys(user_id, chain);
    CREATE INDEX IF NOT EXISTS idx_sk_status     ON session_keys(status);

    CREATE TABLE IF NOT EXISTS session_executions (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        session_id      UUID            NOT NULL REFERENCES session_keys(id) ON DELETE CASCADE,
        tx_hash         VARCHAR(66),
        contract        VARCHAR(42)     NOT NULL,
        function_sig    VARCHAR(10)     NOT NULL,
        value           DECIMAL(36,18)  NOT NULL DEFAULT 0,
        status          VARCHAR(16)     NOT NULL DEFAULT 'pending',
        error_reason    TEXT,
        executed_at     TIMESTAMP       NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_exec_session ON session_executions(session_id);
    CREATE INDEX IF NOT EXISTS idx_exec_hash    ON session_executions(tx_hash);
  `);
}
