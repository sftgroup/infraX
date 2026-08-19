import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { config } from '../config';

/**
 * BE-05: Risk Control Engine
 * Single transaction limit, daily cumulative limit, new user limit, address blacklist
 * (L-005, L-006)
 *
 * W-5: 全部限额按 USD 口径判定（调用方传入 amountUsd；历史流水按 token 折算 USD）。
 * W-7: daily_limit 口径统一——仅计"出账"（from_address=钱包地址），
 *      含 confirmed/pending/pending_confirmation/pending_approval/retrying，
 *      排除 failed/rejected/blocked（arb §5）。
 */

// 稳定币地址（1:1 折算 USD）；与 txService.convertToUsd 保持一致
const STABLECOINS = [
  '0x4CD3B75A73B1FeD8dD5264172C1956299A909199', // TUSDT (Sepolia test)
  '0x7169D38820dfd117C3FA1f22a697dBA58d90BA06', // TUSDT (alt)
].map(a => a.toLowerCase());

/** token → USD 折算（稳定币 1:1；其余按保守倍数兜底，历史流水无法逐笔回查价格） */
function usdOf(tokenAddress: string | null | undefined, amount: number): number {
  const addr = (tokenAddress || '').toLowerCase();
  if (!addr || addr === '0x0000000000000000000000000000000000000000') {
    // 原生币（ETH/BNB 等）：同样走保守倍数
    return amount * config.risk.usdConservativeMultiplier;
  }
  if (STABLECOINS.includes(addr)) {
    return amount;
  }
  return amount * config.risk.usdConservativeMultiplier;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  triggeredRule?: string;
  details?: any;
}

/**
 * Check all risk rules for a transaction
 * Returns { allowed: true } or { allowed: false, reason: '...' }
 * @param amountUsd 已折算 USD 的金额（W-5：风控一律按 USD 判定）
 * @param tokenAddress 发起币种地址（历史流水折算用）
 */
export async function checkRisk(
  userId: string,
  amountUsd: number,
  toAddress: string,
  tokenAddress?: string,
  _chain?: string
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
        result = await checkSingleLimit(userId, amountUsd, params);
        break;
      case 'daily_limit':
        result = await checkDailyLimit(userId, amountUsd, tokenAddress, params);
        break;
      case 'new_user':
        result = await checkNewUserLimit(userId, amountUsd, params);
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
 * Single transaction limit (L-005) — 金额为 USD
 */
async function checkSingleLimit(
  _userId: string,
  amountUsd: number,
  params: any
): Promise<RiskCheckResult> {
  const limit = parseFloat(params.limit || config.risk.singleLimitDefault);
  if (amountUsd > limit) {
    return {
      allowed: false,
      reason: `Exceeds single transaction limit ($${limit.toLocaleString()} USD)`,
      details: { limit, amountUsd, currency: params.currency || 'USD' },
    };
  }
  return { allowed: true };
}

/**
 * Daily cumulative limit (L-005) — 按 USD 汇总出账
 */
async function checkDailyLimit(
  userId: string,
  amountUsd: number,
  tokenAddress: string | undefined,
  params: any
): Promise<RiskCheckResult> {
  const dailyLimit = parseFloat(params.limit || config.risk.dailyLimitDefault);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 仅出账（from_address = 钱包地址），排除充值；状态口径见文件头注释（W-7）
  const result = await pool.query(
    `SELECT t.token_address, t.amount
     FROM transactions t
     JOIN custodial_wallets w ON t.wallet_id = w.id
     WHERE w.user_id = $1
       AND t.from_address = w.address
       AND t.status IN ('confirmed', 'pending', 'pending_confirmation', 'pending_approval', 'retrying')
       AND t.created_at >= $2`,
    [userId, today]
  );

  let dailyTotalUsd = amountUsd;
  for (const row of result.rows) {
    dailyTotalUsd += usdOf(row.token_address, parseFloat(row.amount));
  }

  if (dailyTotalUsd > dailyLimit) {
    return {
      allowed: false,
      reason: `Exceeds daily cumulative limit ($${dailyLimit.toLocaleString()} USD). Used: ${(dailyTotalUsd - amountUsd).toFixed(2)}, Trying: ${amountUsd.toFixed(2)}`,
      details: { limit: dailyLimit, dailyTotalUsd, newAmountUsd: amountUsd, currency: params.currency || 'USD' },
    };
  }
  return { allowed: true };
}

/**
 * New user 24h limit (L-005) — 金额为 USD
 */
async function checkNewUserLimit(
  userId: string,
  amountUsd: number,
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
    if (amountUsd > newUserLimit) {
      return {
        allowed: false,
        reason: `New user limit ($${newUserLimit.toLocaleString()} USD) for first ${newUserHours}h`,
        details: { limit: newUserLimit, amountUsd, hoursSinceCreation, newUserHours },
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
 * Get user's risk limits (W-6: 真实应用 risk_rules DB 覆盖；W-7: daily_used USD 口径）
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
  let singleLimit = config.risk.singleLimitDefault;
  let dailyLimit = config.risk.dailyLimitDefault;
  let newUserLimit = config.risk.newUserLimitDefault;
  let newUserHours = config.risk.newUserHours;

  for (const rule of rules.rows) {
    if (rule.rule_type === 'single_limit' && rule.params?.limit != null) {
      singleLimit = parseFloat(rule.params.limit);
    }
    if (rule.rule_type === 'daily_limit' && rule.params?.limit != null) {
      dailyLimit = parseFloat(rule.params.limit);
    }
    if (rule.rule_type === 'new_user') {
      if (rule.params?.limit != null) newUserLimit = parseFloat(rule.params.limit);
      if (rule.params?.hours != null) newUserHours = parseInt(rule.params.hours, 10);
    }
  }

  // 今日出账 USD 汇总（口径与 checkDailyLimit 一致）
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const usageResult = await pool.query(
    `SELECT t.token_address, t.amount
     FROM transactions t
     JOIN custodial_wallets w ON t.wallet_id = w.id
     WHERE w.user_id = $1
       AND t.from_address = w.address
       AND t.status IN ('confirmed', 'pending', 'pending_confirmation', 'pending_approval', 'retrying')
       AND t.created_at >= $2`,
    [userId, today]
  );
  let dailyUsed = 0;
  for (const row of usageResult.rows) {
    dailyUsed += usdOf(row.token_address, parseFloat(row.amount));
  }

  // Check new user status
  const userResult = await pool.query('SELECT created_at FROM users WHERE id = $1', [userId]);
  const isNewUser = userResult.rows.length > 0 &&
    (Date.now() - new Date(userResult.rows[0].created_at).getTime()) / 3600000 < newUserHours;

  return {
    singleLimit,
    dailyLimit,
    dailyUsed,
    isNewUser,
    newUserLimit,
    newUserRemaining: isNewUser ? Math.max(0, newUserLimit - dailyUsed) : Infinity,
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
