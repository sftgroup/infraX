import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { config } from '../config';

/**
 * Fee Service — withdrawal fee calculation engine
 * Mirrors CWallet's FeeConfig model (fixed / percentage + min/max caps)
 */

export interface FeeConfig {
  tokenId: string;
  tokenSymbol: string;
  feeType: 'fixed' | 'percentage';
  feeValue: string;
  minFee: string;
  maxFee: string;
  enabled: boolean;
}

/**
 * Get fee configuration for a token
 * CWallet equivalent: FeeConfig filtered by token_id + enabled
 */
export async function getFeeConfig(tokenSymbol: string): Promise<FeeConfig | null> {
  const result = await pool.query(
    `SELECT f.*, t.symbol as token_symbol
     FROM fee_configs f
     JOIN tokens t ON f.token_id = t.id
     WHERE t.symbol = $1 AND f.enabled = true
     LIMIT 1`,
    [tokenSymbol]
  );
  return result.rows[0] || null;
}

/**
 * Calculate withdrawal fee
 *
 * CWallet logic:
 * - fixed: fee = feeValue
 * - percentage: fee = amount * feeValue / 100
 * - cap by minFee / maxFee
 *
 * Returns: { fee, actualAmount, feeToken }
 */
export async function calculateFee(
  tokenSymbol: string,
  amount: string
): Promise<{
  fee: string;
  actualAmount: string;
  feeType: string;
}> {
  const amountNum = parseFloat(amount);

  // Default: zero fee
  const result = await pool.query(
    `SELECT f.*, t.symbol as token_symbol
     FROM fee_configs f
     JOIN tokens t ON f.token_id = t.id
     WHERE t.symbol = $1 AND f.enabled = true
     LIMIT 1`,
    [tokenSymbol]
  );

  const feeCfg = result.rows[0];
  if (!feeCfg) {
    return { fee: '0', actualAmount: amount, feeType: 'none' };
  }

  let fee = '0';
  if (feeCfg.fee_type === 'fixed') {
    fee = String(feeCfg.fee_value);
  } else if (feeCfg.fee_type === 'percentage') {
    fee = String((amountNum * parseFloat(feeCfg.fee_value)) / 100);
  }

  let feeNum = parseFloat(fee);
  const minFee = parseFloat(feeCfg.min_fee || '0');
  const maxFee = parseFloat(feeCfg.max_fee || '0');

  if (minFee > 0 && feeNum < minFee) feeNum = minFee;
  if (maxFee > 0 && feeNum > maxFee) feeNum = maxFee;

  fee = feeNum.toFixed(8);
  let actual = amountNum - feeNum;
  if (actual < 0) actual = 0;

  return {
    fee,
    actualAmount: actual.toFixed(8),
    feeType: String(feeCfg.fee_type),
  };
}

/**
 * Seed default fee configs if none exist
 */
export async function seedDefaultFeeConfigs(): Promise<void> {
  const { rows } = await pool.query('SELECT COUNT(*)::int as cnt FROM fee_configs');
  if (rows[0].cnt > 0) return;

  logger.info('Seeding default fee configurations');

  // Create default tokens table if not exists (CWallet-compatible)
  await pool.query(`
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

  // Seed native tokens for supported chains
  const { v4: uuidv4 } = require('uuid');
  const chains = [
    { chain_id: '11155111', symbol: 'sETH', name: 'Sepolia ETH', token_type: 'native' },
    { chain_id: '1', symbol: 'ETH', name: 'Ethereum', token_type: 'native' },
    { chain_id: '56', symbol: 'BNB', name: 'BNB Chain', token_type: 'native' },
    { chain_id: '8453', symbol: 'ETH', name: 'Base ETH', token_type: 'native', contract: '0x...' },
  ];

  for (const chain of chains) {
    await pool.query(
      `INSERT INTO tokens (id, symbol, name, chain_id, token_type, min_withdraw, max_withdraw)
       VALUES ($1, $2, $3, $4, $5, '0.001', '1000')
       ON CONFLICT DO NOTHING`,
      [uuidv4(), chain.symbol, chain.name, chain.chain_id, chain.token_type]
    );
  }

  // Seed fee configs (free by default)
  const tokens = await pool.query('SELECT id FROM tokens');
  for (const t of tokens.rows) {
    await pool.query(
      `INSERT INTO fee_configs (id, token_id, fee_type, fee_value, min_fee, max_fee, enabled)
       VALUES ($1, $2, 'fixed', '0', '0', '0', true)`,
      [uuidv4(), t.id]
    );
  }
}
