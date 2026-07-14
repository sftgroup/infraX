import { pool } from '../database';
import { logger } from '../logger';
import { v4 as uuidv4 } from 'uuid';

/**
 * Database migration: Event Collector tables
 *
 * events              — full-chain block data (72h retention, TimescaleDB hypertable)
 * event_checkpoints   — per-collector scanning progress (permanent)
 * payment_events      — payment-linked events for reconciliation (permanent)
 * binance_futures_prices — Binance futures OHLCV (TimescaleDB hypertable, 5min)
 * okx_token_snapshots — OKX ChainOS DEX token snapshots (permanent)
 * admin_okx_accounts  — OKX multi-account management
 */

export async function migrateEventCollectorTables(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ============================================================
    // events table — all on-chain events from all chains
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id UUID NOT NULL,
        event_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(100) NOT NULL DEFAULT 'unknown',
        source VARCHAR(50) NOT NULL DEFAULT 'blockchain',
        chain VARCHAR(50) NOT NULL DEFAULT 'unknown',
        block_number BIGINT NOT NULL DEFAULT 0,
        tx_hash VARCHAR(100) NOT NULL DEFAULT '',
        log_index INTEGER NOT NULL DEFAULT 0,
        contract_address VARCHAR(100) NOT NULL DEFAULT '',
        from_address VARCHAR(100) NOT NULL DEFAULT '',
        to_address VARCHAR(100) NOT NULL DEFAULT '',
        token_address VARCHAR(100) NOT NULL DEFAULT '',
        token_symbol VARCHAR(50) NOT NULL DEFAULT '',
        token_id VARCHAR(100) DEFAULT NULL,
        amount NUMERIC(78, 18) NOT NULL DEFAULT 0,
        amount_raw VARCHAR(100) NOT NULL DEFAULT '0',
        event_data JSONB NOT NULL DEFAULT '{}',
        topic_hash VARCHAR(100) NOT NULL DEFAULT '',
        status VARCHAR(50) NOT NULL DEFAULT 'confirmed',
        confirmations INTEGER NOT NULL DEFAULT 0,
        collected_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);

    // ============================================================
    // Core indexes (high-frequency query paths)
    // ============================================================
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_chain_block ON events (chain, block_number DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_from_address ON events (from_address);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_to_address ON events (to_address);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_contract ON events (contract_address);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_tx_hash ON events (tx_hash);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_collected_at ON events (collected_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_event_id ON events (event_id);`);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_chain_type_block ON events (chain, event_type, block_number DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_to_chain_block ON events (to_address, chain, block_number DESC);`);

    // ============================================================
    // event_checkpoints
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS event_checkpoints (
        id UUID PRIMARY KEY,
        chain VARCHAR(20) NOT NULL,
        collector_name VARCHAR(50) NOT NULL,
        last_block BIGINT NOT NULL DEFAULT 0,
        last_tx_hash VARCHAR(66),
        last_fetch_at TIMESTAMP,
        status VARCHAR(20) DEFAULT 'running',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(chain, collector_name)
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_checkpoints_chain_collector ON event_checkpoints (chain, collector_name);`);

    // Add event_count column for O(1) event count (migration: ALTER TABLE IF NOT EXISTS… won't error on re-run)
    await client.query(`ALTER TABLE event_checkpoints ADD COLUMN IF NOT EXISTS event_count BIGINT NOT NULL DEFAULT 0;`);

    // ============================================================
    // payment_events
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_events (
        id UUID PRIMARY KEY,
        event_id UUID NOT NULL,
        order_id VARCHAR(64) NOT NULL,
        matched_by VARCHAR(20) DEFAULT 'address_match',
        confidence DECIMAL(3, 2) DEFAULT 1.00,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events (order_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_events_event ON payment_events (event_id);`);

    // ============================================================
    // admin_rpc_config
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_rpc_config (
        id SERIAL PRIMARY KEY,
        chain VARCHAR(20) NOT NULL,
        endpoint_key VARCHAR(50) NOT NULL,
        url TEXT NOT NULL,
        provider VARCHAR(30) DEFAULT 'custom',
        tier VARCHAR(20) DEFAULT 'free',
        rpm INTEGER DEFAULT 60,
        rpd INTEGER DEFAULT 10000,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(chain, endpoint_key)
      );
    `);

    // ============================================================
    // admin_users
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id UUID PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(255),
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
        enabled BOOLEAN DEFAULT true,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ============================================================
    // audit_logs
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY,
        user_id VARCHAR(50),
        username VARCHAR(50),
        action VARCHAR(50) NOT NULL,
        resource VARCHAR(100) NOT NULL,
        detail JSONB DEFAULT '{}',
        ip_address VARCHAR(45),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs (user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action, resource);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC);`);

    // ============================================================
    // binance_futures_prices — TimescaleDB hypertable
    // 5-minute OHLCV aggregates for ~200 symbols
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS binance_futures_prices (
        id BIGSERIAL,
        symbol VARCHAR(30) NOT NULL,
        bucket TIMESTAMPTZ NOT NULL,
        open_price NUMERIC(30,10),
        high_price NUMERIC(30,10),
        low_price NUMERIC(30,10),
        close_price NUMERIC(30,10),
        mark_price NUMERIC(30,10),
        index_price NUMERIC(30,10),
        funding_rate NUMERIC(20,16),
        next_funding_time BIGINT,
        tick_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (id, bucket)
      );
      CREATE INDEX IF NOT EXISTS idx_binance_symbol_bucket ON binance_futures_prices (symbol, bucket DESC);
    `);
    // Unique constraint for ON CONFLICT (symbol, bucket) upsert
    // PG aborts transactions on any error; use SAVEPOINT to contain it
    const hasConstraint = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'uq_binance_symbol_bucket' LIMIT 1`
    );
    if (hasConstraint.rowCount === 0) {
      await client.query('SAVEPOINT add_uq_constraint');
      try {
        await client.query('ALTER TABLE binance_futures_prices ADD CONSTRAINT uq_binance_symbol_bucket UNIQUE (symbol, bucket)');
        await client.query('RELEASE SAVEPOINT add_uq_constraint');
      } catch (e: any) {
        await client.query('ROLLBACK TO SAVEPOINT add_uq_constraint');
        if (e.code !== '42P07') throw e;
      }
    }
    try {
      await client.query('SAVEPOINT hypertable_setup');
      await client.query(`SELECT create_hypertable('binance_futures_prices', 'bucket', chunk_time_interval => INTERVAL '1 day', if_not_exists => true);`);
      await client.query('RELEASE SAVEPOINT hypertable_setup');
    } catch (e: any) {
      await client.query('ROLLBACK TO SAVEPOINT hypertable_setup').catch(() => {});
      logger.warn('[migration] binance hypertable skipped (requires TimescaleDB)', { error: e.message });
    }

    // ============================================================
    // okx_token_snapshots — permanent DEX token data
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS okx_token_snapshots (
        id BIGSERIAL PRIMARY KEY,
        chain VARCHAR(50) NOT NULL,
        token_address VARCHAR(200) NOT NULL,
        token_symbol VARCHAR(100),
        token_name VARCHAR(300),
        price_usd NUMERIC(30,10),
        volume_24h NUMERIC(40,10),
        market_cap NUMERIC(40,10),
        liquidity_usd NUMERIC(40,10),
        fdv NUMERIC(40,10),
        supply NUMERIC(40,10),
        holder_count INTEGER,
        dex_name VARCHAR(100),
        pool_address VARCHAR(200),
        price_change_24h NUMERIC(10,4),
        collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_oktx_snap_chain_token ON okx_token_snapshots (chain, token_address, collected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_oktx_snap_time ON okx_token_snapshots (collected_at DESC);
    `);

    // ============================================================
    // admin_okx_accounts — multi-account management
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_okx_accounts (
        id SERIAL PRIMARY KEY,
        label VARCHAR(100) NOT NULL,
        api_key VARCHAR(255) NOT NULL,
        api_secret VARCHAR(255) NOT NULL,
        api_passphrase VARCHAR(255) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        is_default BOOLEAN NOT NULL DEFAULT false,
        last_used_at TIMESTAMP WITHOUT TIME ZONE,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        error_message TEXT,
        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);

    // Seed default admin user
    const adminPwHash = require('crypto').createHash('sha256').update(infrax123').digest('hex');
    await client.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role)
       VALUES ($1, 'admin', 'admin@pocketx.io', $2, 'admin')
       ON CONFLICT (username) DO NOTHING`,
      [uuidv4(), adminPwHash]
    );

    // Seed checkpoints for all supported chains
    const chains = ['sepolia', 'ethereum', 'bsc', 'base', 'solana'];
    for (const chain of chains) {
      await client.query(
        `INSERT INTO event_checkpoints (id, chain, collector_name, last_block, status)
         VALUES ($1, $2, 'block_scanner', 0, 'running')
         ON CONFLICT (chain, collector_name) DO NOTHING`,
        [uuidv4(), chain]
      );
    }

    // ============================================================
    // api_keys — API Key management for downstream consumers
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        label VARCHAR(100) NOT NULL,
        api_key VARCHAR(64) NOT NULL UNIQUE,
        rate_limit INT NOT NULL DEFAULT 100,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_by VARCHAR(64),
        last_used_at TIMESTAMP WITHOUT TIME ZONE,
        request_count BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys (api_key);`).catch((e: any) => {
      logger.warn('[migration] index api_keys skipped', { error: e.message });
    });

    await client.query('COMMIT');
    logger.info('[migration] All tables created', {
      tables: ['events', 'event_checkpoints', 'payment_events', 'binance_futures_prices', 'okx_token_snapshots', 'admin_okx_accounts'],
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    logger.error('[migration] Failed', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}
