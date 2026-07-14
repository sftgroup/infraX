import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { config } from '../config';

/**
 * BE-05: Risk Control Engine
 * Single transaction limit, daily cumulative limit, new user limit, address blacklist
 * (L-005, L-006)
 */

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  triggeredRule?: string;
  details?: any;
}

/**
 * Check all risk rules for a transaction
 * Returns { allowed: true } or { allowed: false, reason: '...' }
 */
export async function checkRisk(
  userId: string,
  amount: number,
  toAddress: string
): Promise<RiskCheckResult> {
  // Fetch enabled rules
  // Check in priority order: blacklist → single_limit → daily_limit → new_user
  const rules = await pool.query(
    'SELECT * FROM risk_rules WHERE enabled = true'
  );

  // Define check priority: blacklist first (absolute block), then single, daily, new_user
  const priorityOrder = ['blacklist', 'single_limit', 'daily_limit', 'new_user'];
  const rulesByType: Record<string, any> = {};
  for (const rule of rules.rows) {
    rulesByType[rule.rule_type] = rule;
  }

  for (const ruleType of priorityOrder) {
    const rule = rulesByType[ruleType];
    if (!rule) continue;

    const params = rule.params;
    let result: RiskCheckResult = { allowed: true };

    switch (rule.rule_type) {
      case 'blacklist':
        result = await checkBlacklist(toAddress, params);
        break;
      case 'single_limit':
        result = await checkSingleLimit(userId, amount, params);
        break;
      case 'daily_limit':
        result = await checkDailyLimit(userId, amount, params);
        break;
      case 'new_user':
        result = await checkNewUserLimit(userId, amount, params);
        break;
    }

    if (!result.allowed) {
      result.triggeredRule = rule.rule_type;
      return result;
    }
  }

  return { allowed: true };
}

/**
 * Single transaction limit (L-005)
 */
async function checkSingleLimit(
  _userId: string,
  amount: number,
  params: any
): Promise<RiskCheckResult> {
  const limit = parseFloat(params.limit || config.risk.singleLimitDefault);
  if (amount > limit) {
    return {
      allowed: false,
      reason: `Exceeds single transaction limit (${limit} USDC)`,
      details: { limit, amount, currency: params.currency || 'USDC' },
    };
  }
  return { allowed: true };
}

/**
 * Daily cumulative limit (L-005)
 */
async function checkDailyLimit(
  userId: string,
  amount: number,
  params: any
): Promise<RiskCheckResult> {
  const dailyLimit = parseFloat(params.limit || config.risk.dailyLimitDefault);

  // Get today's confirmed + pending outgoing transactions total
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float as daily_total
     FROM transactions t
     JOIN custodial_wallets w ON t.wallet_id = w.id
     WHERE w.user_id = $1
       AND t.status IN ('confirmed', 'pending')
       AND t.created_at >= $2
       AND t.from_address IS NOT NULL`,
    [userId, today]
  );

  const dailyTotal = parseFloat(result.rows[0].daily_total) + amount;
  if (dailyTotal > dailyLimit) {
    return {
      allowed: false,
      reason: `Exceeds daily cumulative limit (${dailyLimit} USDC). Used: ${(dailyTotal - amount).toFixed(2)}, Trying: ${amount.toFixed(2)}`,
      details: { limit: dailyLimit, dailyTotal, newAmount: amount, currency: params.currency || 'USDC' },
    };
  }
  return { allowed: true };
}

/**
 * New user 24h limit (L-005)
 */
async function checkNewUserLimit(
  userId: string,
  amount: number,
  params: any
): Promise<RiskCheckResult> {
  const userResult = await pool.query(
    'SELECT created_at FROM users WHERE id = $1',
    [userId]
  );
  if (userResult.rows.length === 0) {
    return { allowed: false, reason: 'User not found' };
  }

  const userCreatedAt = new Date(userResult.rows[0].created_at);
  const hoursSinceCreation =
    (Date.now() - userCreatedAt.getTime()) / (1000 * 60 * 60);
  const newUserHours = params.hours || config.risk.newUserHours;

  if (hoursSinceCreation < newUserHours) {
    const newUserLimit = parseFloat(params.limit || config.risk.newUserLimitDefault);
    if (amount > newUserLimit) {
      return {
        allowed: false,
        reason: `New user limit (${newUserLimit} USDC) for first ${newUserHours}h`,
        details: { limit: newUserLimit, hoursSinceCreation, newUserHours },
      };
    }
  }
  return { allowed: true };
}

/**
 * Blacklist address check (L-006)
 */
async function checkBlacklist(
  toAddress: string,
  params: any
): Promise<RiskCheckResult> {
  const blacklist: string[] = params.addresses || [];
  const normalizedAddr = toAddress.toLowerCase();

  if (blacklist.some((addr) => addr.toLowerCase() === normalizedAddr)) {
    return {
      allowed: false,
      reason: 'Transaction blocked: recipient address is blacklisted',
      details: { address: toAddress },
    };
  }
  return { allowed: true };
}

/**
 * Get user's risk limits
 */
export async function getUserLimits(userId: string): Promise<{
  singleLimit: number;
  dailyLimit: number;
  dailyUsed: number;
  isNewUser: boolean;
  newUserLimit: number;
  newUserRemaining: number;
}> {
  const rules = await pool.query('SELECT * FROM risk_rules WHERE enabled = true');
  const singleLimit = config.risk.singleLimitDefault;
  const dailyLimit = config.risk.dailyLimitDefault;
  const newUserLimit = config.risk.newUserLimitDefault;

  for (const rule of rules.rows) {
    if (rule.rule_type === 'single_limit') {
      // Override with DB value
    }
    if (rule.rule_type === 'daily_limit') {
      // Override
    }
    if (rule.rule_type === 'new_user') {
      // Override
    }
  }

  // Get daily usage
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const usageResult = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float as daily_used
     FROM transactions t
     JOIN custodial_wallets w ON t.wallet_id = w.id
     WHERE w.user_id = $1 AND t.created_at >= $2 AND t.status IN ('confirmed', 'pending')`,
    [userId, today]
  );

  // Check new user status
  const userResult = await pool.query('SELECT created_at FROM users WHERE id = $1', [userId]);
  const isNewUser = userResult.rows.length > 0 &&
    (Date.now() - new Date(userResult.rows[0].created_at).getTime()) / 3600000 < config.risk.newUserHours;

  return {
    singleLimit,
    dailyLimit,
    dailyUsed: parseFloat(usageResult.rows[0]?.daily_used || '0'),
    isNewUser,
    newUserLimit,
    newUserRemaining: isNewUser ? Math.max(0, newUserLimit - parseFloat(usageResult.rows[0]?.daily_used || '0')) : Infinity,
  };
}

/**
 * Add an address to the blacklist
 */
export async function addBlacklistAddress(address: string): Promise<void> {
  const normalizedAddr = address.toLowerCase();
  const existing = await pool.query(
    `SELECT * FROM risk_rules WHERE rule_type = 'blacklist' AND enabled = true LIMIT 1`
  );

  if (existing.rows.length > 0) {
    const rule = existing.rows[0];
    const addresses: string[] = rule.params.addresses || [];
    if (!addresses.some((a: string) => a.toLowerCase() === normalizedAddr)) {
      addresses.push(normalizedAddr);
      await pool.query(
        'UPDATE risk_rules SET params = $1, updated_at = NOW() WHERE id = $2',
        [JSON.stringify({ addresses }), rule.id]
      );
    }
  } else {
    await pool.query(
      `INSERT INTO risk_rules (id, rule_type, params, enabled) VALUES ($1, 'blacklist', $2, true)`,
      [require('uuid').v4(), JSON.stringify({ addresses: [normalizedAddr] })]
    );
  }
}
