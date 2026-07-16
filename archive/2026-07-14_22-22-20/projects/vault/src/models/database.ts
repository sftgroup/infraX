import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected database pool error', { error: err.message });
});

/**
 * Initialize database schema — creates tables if they don't exist
 */
export async function initDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 4.1 Users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        payment_password_hash VARCHAR(255),
        hd_wallet_id UUID,
        role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4.2 Custodial wallets
    await client.query(`
      CREATE TABLE IF NOT EXISTS custodial_wallets (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chain VARCHAR(20) NOT NULL,
        address VARCHAR(42) UNIQUE NOT NULL,
        encrypted_key TEXT,
        balance DECIMAL(36, 18) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4.3 Transactions
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES custodial_wallets(id) ON DELETE CASCADE,
        from_address VARCHAR(42) NOT NULL,
        to_address VARCHAR(42) NOT NULL,
        amount DECIMAL(36, 18) NOT NULL,
        token_address VARCHAR(42) DEFAULT '*',
        gas_sponsored BOOLEAN DEFAULT true,
        tx_hash VARCHAR(66),
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed', 'blocked', 'pending_confirmation', 'pending_approval', 'rejected')),
        risk_result JSONB,
        signature_strategy VARCHAR(20) DEFAULT 'auto' CHECK (signature_strategy IN ('auto', 'confirm', 'approval')),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4.4 Risk rules
    await client.query(`
      CREATE TABLE IF NOT EXISTS risk_rules (
        id UUID PRIMARY KEY,
        rule_type VARCHAR(20) NOT NULL CHECK (rule_type IN ('single_limit', 'daily_limit', 'new_user', 'blacklist')),
        params JSONB NOT NULL,
        enabled BOOLEAN DEFAULT true,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4.5 Webhook events
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id UUID PRIMARY KEY,
        event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('deposit', 'withdrawal', 'failed', 'blocked', 'withdrawal_request')),
        user_id UUID,
        tenant_id UUID,
        wallet_id UUID,
        payload JSONB NOT NULL,
        retry_count INT DEFAULT 0,
        last_error TEXT,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4.2a Tenants (SaaS WaaS)
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        contact_email VARCHAR(255),
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended')),
        api_key VARCHAR(64) UNIQUE NOT NULL,
        api_secret_hash VARCHAR(255) NOT NULL,
        webhook_url VARCHAR(500),
        sweep_address VARCHAR(42),
        sweep_threshold DECIMAL(36, 18) DEFAULT 0,
        review_mode VARCHAR(20) DEFAULT 'manual' CHECK (review_mode IN ('manual', 'auto')),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4.3a Address pool (SaaS WaaS)
    await client.query(`
      CREATE TABLE IF NOT EXISTS address_pool (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        external_user_id VARCHAR(100) NOT NULL,
        label VARCHAR(255),
        chain VARCHAR(20) NOT NULL,
        address VARCHAR(42) UNIQUE NOT NULL,
        encrypted_key TEXT,
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'locked')),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tenant_id, chain, external_user_id)
      );
    `);

    // 4.4a Sweep records (SaaS WaaS)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sweep_records (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        from_address VARCHAR(42) NOT NULL,
        to_address VARCHAR(42) NOT NULL,
        token VARCHAR(20) NOT NULL DEFAULT '*',
        amount DECIMAL(36, 18) NOT NULL,
        tx_hash VARCHAR(66),
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4.5a SaaS withdrawal requests
    await client.query(`
      CREATE TABLE IF NOT EXISTS saas_withdrawals (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        external_user_id VARCHAR(100) NOT NULL,
        from_address VARCHAR(42) NOT NULL,
        to_address VARCHAR(42) NOT NULL,
        token VARCHAR(20) NOT NULL DEFAULT '*',
        chain_id VARCHAR(20) NOT NULL DEFAULT '11155111',
        chain_name VARCHAR(50) DEFAULT 'Sepolia',
        token_address VARCHAR(66) DEFAULT NULL,
        amount DECIMAL(36, 18) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'approved', 'rejected', 'processing', 'confirmed', 'failed')),
        review_by VARCHAR(255),
        review_note TEXT,
        tx_hash VARCHAR(66),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4.7 API Keys (for internal/CWallet auth — supports rotation)
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id UUID PRIMARY KEY,
        key_hash VARCHAR(64) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        scope VARCHAR(20) DEFAULT 'cwallet' CHECK (scope IN ('cwallet', 'admin', 'webhook')),
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP,
        last_used_at TIMESTAMP
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);`);

    // 4.8 Fee configs (CWallet-compatible)
    await client.query(`
      CREATE TABLE IF NOT EXISTS tokens (
        id UUID PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        name VARCHAR(100),
        decimals INT DEFAULT 18,
        contract_address VARCHAR(66),
        chain_id VARCHAR(20) NOT NULL,
        token_type VARCHAR(20) DEFAULT 'native',
        enabled BOOLEAN DEFAULT true,
        min_withdraw VARCHAR(32) DEFAULT '0',
        max_withdraw VARCHAR(32) DEFAULT '0',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fee_configs (
        id UUID PRIMARY KEY,
        token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
        fee_type VARCHAR(20) NOT NULL DEFAULT 'fixed' CHECK (fee_type IN ('fixed', 'percentage')),
        fee_value DECIMAL(36, 18) NOT NULL DEFAULT 0,
        min_fee DECIMAL(36, 18) NOT NULL DEFAULT 0,
        max_fee DECIMAL(36, 18) NOT NULL DEFAULT 0,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4.9 Chains (CWallet-compatible)
    await client.query(`
      CREATE TABLE IF NOT EXISTS chains (
        id UUID PRIMARY KEY,
        chain_id VARCHAR(20) UNIQUE NOT NULL,
        display_name VARCHAR(50) NOT NULL,
        chain_type VARCHAR(20) DEFAULT 'evm' CHECK (chain_type IN ('evm', 'solana')),
        rpc_url VARCHAR(500),
        explorer_url VARCHAR(500),
        native_currency VARCHAR(10) DEFAULT 'ETH',
        enabled BOOLEAN DEFAULT true,
        scan_start_block INT DEFAULT 0,
        block_time_seconds INT DEFAULT 12,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Seed default chains
    const { rows: chainRows } = await client.query('SELECT COUNT(*)::int as cnt FROM chains');
    if (chainRows[0].cnt === 0) {
      await client.query(`
        INSERT INTO chains (id, chain_id, display_name, chain_type, rpc_url, native_currency, block_time_seconds) VALUES
        ($1, '11155111', 'Sepolia', 'evm', 'https://1rpc.io/sepolia', 'sETH', 12),
        ($2, '1', 'Ethereum', 'evm', '', 'ETH', 12),
        ($3, '56', 'BSC', 'evm', '', 'BNB', 3),
        ($4, '8453', 'Base', 'evm', '', 'ETH', 2)
      `, [uuidv4(), uuidv4(), uuidv4(), uuidv4()]);
    }

    // Seed tokens if none exist
    const { rows: tokenRows } = await client.query('SELECT COUNT(*)::int as cnt FROM tokens');
    if (tokenRows[0].cnt === 0) {
      const sepoliaChain = await client.query('SELECT id FROM chains WHERE chain_id = $1', ['11155111']);
      if (sepoliaChain.rows.length > 0) {
        const tSepoliaId = uuidv4();
        await client.query(`
          INSERT INTO tokens (id, symbol, name, decimals, chain_id, token_type, min_withdraw, max_withdraw) VALUES
          ($1, 'sETH', 'Sepolia ETH', 18, '11155111', 'native', '0.001', '1000'),
          ($2, 'USDC', 'USDC (Sepolia)', 6, '11155111', 'erc20', '1', '100000')
        `, [tSepoliaId, uuidv4()]);
      }
    }

    // Seed fee_configs if none exist
    const { rows: feeRows } = await client.query('SELECT COUNT(*)::int as cnt FROM fee_configs');
    if (feeRows[0].cnt === 0) {
      const tokens = await client.query('SELECT id, symbol FROM tokens');
      for (const t of tokens.rows) {
        await client.query(`
          INSERT INTO fee_configs (id, token_id, fee_type, fee_value, min_fee, max_fee, enabled)
          VALUES ($1, $2, 'fixed', '0', '0', '0', true)
        `, [uuidv4(), t.id]);
      }
    }

    // Add missing columns to existing tables
    await client.query(`ALTER TABLE address_pool ADD COLUMN IF NOT EXISTS encrypted_key TEXT;`);
    await client.query(`ALTER TABLE address_pool ADD COLUMN IF NOT EXISTS derivation_path VARCHAR(100);`);
    await client.query(`ALTER TABLE saas_withdrawals ADD COLUMN IF NOT EXISTS fee DECIMAL(36,18) DEFAULT 0;`);
    await client.query(`ALTER TABLE saas_withdrawals ADD COLUMN IF NOT EXISTS actual_amount DECIMAL(36,18) DEFAULT 0;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hd_wallet_index INT;`);

    // 4.10 Safe multi-sig wallets (F-027~032)
    await client.query(`
      CREATE TABLE IF NOT EXISTS safe_wallets (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chain_id VARCHAR(20) NOT NULL,
        safe_address VARCHAR(42) UNIQUE NOT NULL,
        owners JSONB NOT NULL DEFAULT '[]',
        threshold INT NOT NULL DEFAULT 1,
        name VARCHAR(100),
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'deploying')),
        salt_nonce VARCHAR(64),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS safe_transactions (
        id UUID PRIMARY KEY,
        safe_address VARCHAR(42) NOT NULL,
        proposer_id UUID NOT NULL REFERENCES users(id),
        to_address VARCHAR(42) NOT NULL,
        value VARCHAR(32) NOT NULL DEFAULT '0',
        data TEXT DEFAULT '0x',
        nonce INT NOT NULL DEFAULT 0,
        safe_tx_hash VARCHAR(66) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'executed', 'failed', 'rejected')),
        executor_id UUID REFERENCES users(id),
        executed_at TIMESTAMP,
        tx_hash VARCHAR(66),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS safe_signatures (
        id UUID PRIMARY KEY,
        safe_tx_hash VARCHAR(66) NOT NULL,
        signer_id UUID NOT NULL REFERENCES users(id),
        signature TEXT NOT NULL,
        signature_type VARCHAR(20) DEFAULT 'eoa' CHECK (signature_type IN ('eoa', 'eip1271', 'approved_hash')),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(safe_tx_hash, signer_id)
      );
    `);

    // Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_safe_wallets_user_id ON safe_wallets(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_safe_transactions_safe_address ON safe_transactions(safe_address);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_safe_signatures_safe_tx_hash ON safe_signatures(safe_tx_hash);`);

    // Seed default CWallet API key if none exist
    const { rows: keyRows } = await client.query('SELECT COUNT(*)::int as cnt FROM api_keys');
    if (keyRows[0].cnt === 0) {
      const crypto = require('crypto');
      const defaultKeyHash = crypto.createHash('sha256').update(config.cwallet.apiKey).digest('hex');
      await client.query(
        `INSERT INTO api_keys (id, key_hash, name, scope)
         VALUES ($1, $2, $3, $4)`,
        [uuidv4(), defaultKeyHash, 'default-cwallet-key', 'cwallet']
      );
    }

    // Update risk_rules to support tenant-level scope
    await client.query(`ALTER TABLE risk_rules ADD COLUMN IF NOT EXISTS scope VARCHAR(20) DEFAULT 'platform' CHECK (scope IN ('platform', 'tenant'));`);
    await client.query(`ALTER TABLE risk_rules ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;`);

    // 4.6 Token blacklist (DEPRECATED: JWT removed, kept for schema compatibility)
    await client.query(`
      CREATE TABLE IF NOT EXISTS token_blacklist (
        id UUID PRIMARY KEY,
        token_hash VARCHAR(64) UNIQUE NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason VARCHAR(50) DEFAULT 'logout' CHECK (reason IN ('logout', 'rotation', 'compromise')),
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL
      );
    `);

    // Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_token_blacklist_user_id ON token_blacklist(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires_at ON token_blacklist(expires_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_custodial_wallets_user_id ON custodial_wallets(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_custodial_wallets_address ON custodial_wallets(address);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id ON transactions(wallet_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_webhook_events_user_id ON webhook_events(user_id);`);

    // Seed default risk rules if none exist
    const { rows } = await client.query('SELECT COUNT(*)::int as cnt FROM risk_rules');
    if (rows[0].cnt === 0) {
      await client.query(
        `INSERT INTO risk_rules (id, rule_type, params, enabled) VALUES
         ($1, 'single_limit', '{"limit": 10000, "currency": "USDC"}', true),
         ($2, 'daily_limit', '{"limit": 50000, "currency": "USDC"}', true),
         ($3, 'new_user', '{"limit": 1000, "hours": 24, "currency": "USDC"}', true)`,
        [uuidv4(), uuidv4(), uuidv4()]
      );
    }

    await client.query('COMMIT');
    logger.info('Database schema initialized successfully');
  } catch (err: any) {
    await client.query('ROLLBACK');
    logger.error('Failed to initialize database schema', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}
