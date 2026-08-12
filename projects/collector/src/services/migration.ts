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
    // event_categories — business classification catalog (9.6 Phase 1.1)
    // category_id = 一级业务分类；label_id = 二级标签（event_type 粒度）
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS event_categories (
        category_id VARCHAR(50) NOT NULL,
        label_id VARCHAR(50) NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
        PRIMARY KEY (category_id, label_id)
      );
    `);

    // ============================================================
    // 9.6 Phase 1.2: events 加分类列（兼容既有表，IF NOT EXISTS 幂等）
    // ============================================================
    await client.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS category_id VARCHAR(50) NOT NULL DEFAULT 'unclassified';`);
    await client.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS label_id VARCHAR(50) NOT NULL DEFAULT 'raw_event';`);

    // ============================================================
    // Core indexes (high-frequency query paths)
    // ============================================================
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_chain_block ON events (chain, block_number DESC);`);
    // 无过滤 ORDER BY block_number DESC LIMIT n（dc /events 默认路径）：单列 block_number 索引，
    // 否则 150GB+/1 亿+ 行全表排序（曾卡死 dc 服务，见 B-10-3）
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_block_number ON events (block_number DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_from_address ON events (from_address);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_to_address ON events (to_address);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_contract ON events (contract_address);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_tx_hash ON events (tx_hash);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_collected_at ON events (collected_at);`);
    // 9.6 Phase 1.1: 分类列查询索引（按分类过滤 + 时间倒序）
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_category_block ON events (category_id, block_number DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_label_block ON events (label_id, block_number DESC);`);
    // 精简索引：idx_events_event_id（17G）与 idx_events_dedup(event_id, collected_at) 前缀重复，不再创建
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup ON events (event_id, collected_at);`);

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
        price_change_24h NUMERIC(20,4),
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
    const adminPwHash = require('crypto').createHash('sha256').update('infrax123').digest('hex');
    await client.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role)
       VALUES ($1, 'admin', 'admin@infrax.io', $2, 'admin')
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

    // ============================================================
    // MQ-16 T-2: Market 行情 API 按量套餐
    // api_keys 扩展订阅状态列（key 与套餐绑定，pending→active 状态机）
    // market_usage / market_usage_daily：请求级用量明细 + 日聚合（对齐 dc api_usage 模式）
    // ============================================================
    await client.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS market_plan_id TEXT DEFAULT 'market_free';`);
    await client.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS market_sub_status VARCHAR(20) DEFAULT 'active';`);
    await client.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS market_payment_method VARCHAR(20);`);
    await client.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS market_payment_ref VARCHAR(200);`);
    await client.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS market_sub_updated_at TIMESTAMPTZ;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS market_usage (
        id BIGSERIAL PRIMARY KEY,
        key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_market_usage_key_ts ON market_usage(key_id, timestamp);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS market_usage_daily (
        key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        endpoint TEXT NOT NULL DEFAULT 'total',
        total_calls INT NOT NULL DEFAULT 0,
        PRIMARY KEY (key_id, date, endpoint)
      );
    `);

    // ============================================================
    // okx_market_candles — K-line candle snapshots (time-series)
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS okx_market_candles (
        id BIGSERIAL,
        chain VARCHAR(50) NOT NULL,
        token_address VARCHAR(200) NOT NULL,
        period VARCHAR(10) NOT NULL DEFAULT '15m',
        bucket TIMESTAMPTZ NOT NULL,
        open_price NUMERIC(30,10),
        high_price NUMERIC(30,10),
        low_price NUMERIC(30,10),
        close_price NUMERIC(30,10),
        volume NUMERIC(40,10),
        collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id, bucket)
      );
      CREATE INDEX IF NOT EXISTS idx_okx_candles_chain_token_period
        ON okx_market_candles (chain, token_address, period, bucket DESC);
    `);

    // ============================================================
    // okx_market_index_prices — index price snapshots (time-series)
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS okx_market_index_prices (
        id BIGSERIAL,
        chain VARCHAR(50) NOT NULL,
        token_address VARCHAR(200),
        price NUMERIC(30,10),
        collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id, collected_at)
      );
      CREATE INDEX IF NOT EXISTS idx_okx_index_chain_time
        ON okx_market_index_prices (chain, collected_at DESC);
    `);

    // ============================================================
    // okx_market_hot_tokens — periodic trending token snapshots
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS okx_market_hot_tokens (
        id BIGSERIAL PRIMARY KEY,
        chain VARCHAR(50) NOT NULL,
        token_address VARCHAR(200) NOT NULL,
        token_symbol VARCHAR(100),
        token_name VARCHAR(300),
        price_usd NUMERIC(30,10),
        volume_24h NUMERIC(40,10),
        market_cap NUMERIC(40,10),
        price_change_24h NUMERIC(20,4),
        rank INTEGER NOT NULL DEFAULT 0,
        collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_okx_hot_chain_time
        ON okx_market_hot_tokens (chain, collected_at DESC);
    `);

    // ============================================================
    // okx_market_mempump — meme token pump/trench snapshots
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS okx_market_mempump (
        id BIGSERIAL PRIMARY KEY,
        chain VARCHAR(50) NOT NULL,
        protocol VARCHAR(50),
        token_address VARCHAR(200) NOT NULL,
        token_symbol VARCHAR(100),
        token_name VARCHAR(300),
        liquidity NUMERIC(40,10),
        volume_24h NUMERIC(40,10),
        price_change_24h NUMERIC(20,4),
        holder_count INTEGER,
        dev_address VARCHAR(200),
        dev_holding_pct NUMERIC(10,4),
        bundled_pct NUMERIC(10,4),
        is_honeypot BOOLEAN DEFAULT false,
        created_at_ts BIGINT,
        collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_okx_memp_chain_time
        ON okx_market_mempump (chain, collected_at DESC);
    `);

    // ============================================================
    // tracked_tokens — user-configured tokens to monitor
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS tracked_tokens (
        id SERIAL PRIMARY KEY,
        chain VARCHAR(50) NOT NULL,
        token_address VARCHAR(200) NOT NULL,
        token_symbol VARCHAR(100),
        token_name VARCHAR(300),
        label VARCHAR(200),
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_by VARCHAR(100),
        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
        UNIQUE(chain, token_address)
      );
      CREATE INDEX IF NOT EXISTS idx_tracked_tokens_chain ON tracked_tokens (chain, enabled);
    `);

    // ============================================================
    // custom_event_sigs — tenant-defined event signatures for reclassification
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS custom_event_sigs (
        id SERIAL PRIMARY KEY,
        chain VARCHAR(50) NOT NULL,
        topic_hash VARCHAR(100) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        event_name VARCHAR(200),
        abi JSONB,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_by VARCHAR(100),
        created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
        UNIQUE(chain, topic_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_custom_sigs_chain ON custom_event_sigs (chain, enabled);
    `);

    // ============================================================
    // 9.6 Phase 1.1: 分类目录种子数据（业务分类 + 标签）
    // ============================================================
    const CATEGORIES = [
      ['asset_transfer', 'native_transfer', '原生代币转账', 'ETH/BNB/SOL 等原生代币转移'],
      ['asset_transfer', 'erc20_transfer', 'ERC-20 转账', 'ERC-20 代币转账（含 ERC-721 退化情形）'],
      ['asset_transfer', 'nft_transfer', 'NFT 转账', 'ERC-721 / ERC-1155 NFT 转移'],
      ['authorization', 'approval', '代币授权', 'ERC-20 Allowance 授权变更'],
      ['dex_trading', 'swap', 'DEX 交易', 'UniswapV2 / UniswapV3 代币兑换'],
      ['wrapping', 'deposit', '封装入金', 'WETH / wNative deposit'],
      ['wrapping', 'withdrawal', '解封出金', 'WETH / wNative withdrawal'],
      ['supply', 'mint', '代币铸造', 'ERC-20 mint'],
      ['supply', 'burn', '代币销毁', 'ERC-20 burn'],
      ['unclassified', 'raw_event', '未分类事件', '未识别 topic 的原始日志'],
    ];
    for (const [categoryId, labelId, name, description] of CATEGORIES) {
      await client.query(
        `INSERT INTO event_categories (category_id, label_id, name, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (category_id, label_id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
        [categoryId, labelId, name, description]
      );
    }

    // ============================================================
    // 9.6 Phase 1.5: 分类计数（collector 采集时增量维护，event-stats 端点 O(1) 读取）
    // ⚠️ B-10-3 教训：events 161GB/1 亿+ 行禁止实时聚合（时间窗/块窗均会被规划器选成
    // Parallel Seq Scan，实测 24h/1h 都 >30s）。改为 collector 每批插入时按
    // (chain, category_id, label_id) 累计 event_count——采集时分类口径，reclassifier
    // 事后改分类不回写计数（概览用途可接受的漂移）。
    // ============================================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS event_category_stats (
        chain VARCHAR(50) NOT NULL,
        category_id VARCHAR(50) NOT NULL,
        label_id VARCHAR(50) NOT NULL,
        event_count BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain, category_id, label_id)
      );
    `);

    await client.query('COMMIT');
    logger.info('[migration] All tables created', {
      tables: ['events', 'event_checkpoints', 'payment_events', 'binance_futures_prices', 'okx_token_snapshots', 'admin_okx_accounts', 'okx_market_candles', 'okx_market_index_prices', 'okx_market_hot_tokens', 'okx_market_mempump', 'tracked_tokens', 'custom_event_sigs', 'event_categories', 'event_category_stats'],
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    logger.error('[migration] Failed', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}
