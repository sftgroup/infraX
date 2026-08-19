import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { Errors } from '../utils/errors';

/**
 * W-14: 运行时 SystemConfig（DB 化配置，仅白名单 key 可写，敏感值回显脱敏）。
 * 与 env 配置并存：运行时优先读 DB（`getRuntime`），env 作为兜底默认值。
 * 参考 arb §3：SystemConfig 管理后台 + 白名单 + maskSecret。
 */

/** 白名单：admin 可写 key → 默认值（读取时 env 优先，未写 DB 时用默认） */
export const SYSTEM_CONFIG_WHITELIST: Record<string, any> = {
  risk_single_limit: 10000,
  risk_daily_limit: 50000,
  risk_new_user_limit: 1000,
  risk_new_user_hours: 24,
  sig_auto_sign_max: 100,
  sig_confirm_min: 100,
  sig_confirm_max: 10000,
  sig_approval_min: 10000,
  gas_pool_alert_threshold: 0.05,
  sweep_dust_threshold: 0.001,
  sweep_gas_reserve: 0.0005,
  hot_wallet_cold_sweep_threshold: 5.0,
  webhook_retry_max: 3,
  webhook_timeout_ms: 10000,
};

/** 敏感 key 后缀/关键字 → 回显脱敏 */
const SECRET_HINTS = ['key', 'secret', 'private', 'password', 'token', 'seed', 'mnemonic'];

function isSecret(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_HINTS.some(h => k.includes(h));
}

function mask(key: string, value: any): any {
  if (isSecret(key)) {
    if (typeof value === 'string') {
      return value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : '****';
    }
  }
  return value;
}

/** 运行时读取（env 优先 → DB → 白名单默认） */
export async function getRuntime(key: string): Promise<any> {
  const envMap: Record<string, string | undefined> = {
    risk_single_limit: process.env.RISK_SINGLE_LIMIT_DEFAULT,
    risk_daily_limit: process.env.RISK_DAILY_LIMIT_DEFAULT,
    risk_new_user_limit: process.env.RISK_NEW_USER_LIMIT_DEFAULT,
    risk_new_user_hours: process.env.RISK_NEW_USER_HOURS,
    gas_pool_alert_threshold: process.env.GAS_POOL_ALERT_THRESHOLD,
    sweep_dust_threshold: process.env.SWEEP_DUST_THRESHOLD,
    sweep_gas_reserve: process.env.SWEEP_GAS_RESERVE,
    hot_wallet_cold_sweep_threshold: process.env.HOT_WALLET_COLD_SWEEP_THRESHOLD,
    webhook_retry_max: process.env.WEBHOOK_RETRY_MAX,
    webhook_timeout_ms: process.env.WEBHOOK_TIMEOUT_MS,
  };
  if (envMap[key] !== undefined && envMap[key] !== '') return envMap[key];

  const res = await pool.query('SELECT value FROM system_config WHERE key = $1', [key]);
  if (res.rows.length > 0) return res.rows[0].value;

  return SYSTEM_CONFIG_WHITELIST[key] ?? null;
}

/** 写配置（仅白名单 key；value 支持标量或 JSON 数组/对象） */
export async function setConfig(key: string, value: any): Promise<void> {
  if (!(key in SYSTEM_CONFIG_WHITELIST)) {
    throw Errors.forbidden(`Config key "${key}" not in whitelist`);
  }
  await pool.query(
    `INSERT INTO system_config (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
  logger.info('SystemConfig updated', { key });
}

/** 列表（敏感值脱敏） */
export async function listConfigs(): Promise<Array<{ key: string; value: any; from: 'db' | 'default' }>> {
  const dbRows = await pool.query('SELECT key, value FROM system_config ORDER BY key');
  const dbMap: Record<string, any> = {};
  for (const r of dbRows.rows) dbMap[r.key] = r.value;

  const out: Array<{ key: string; value: any; from: 'db' | 'default' }> = [];
  for (const [key, def] of Object.entries(SYSTEM_CONFIG_WHITELIST)) {
    const val = dbMap[key] ?? def;
    out.push({ key, value: mask(key, val), from: dbMap[key] !== undefined ? 'db' : 'default' });
  }
  return out;
}
