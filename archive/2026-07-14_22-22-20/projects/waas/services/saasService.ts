import axios from "axios";
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { pool } from '../models/database';
import { logger } from '../utils/logger';
// ═══════════════════════════════════════════════
// Callback helpers
// ═══════════════════════════════════════════════

async function sendTenantCallback(tenantId: string, withdrawalId: string, data: Record<string, any>): Promise<boolean> {
  const cbResult = await pool.query(
    "SELECT callback_url, webhook_url, api_secret_hash FROM tenants WHERE id = $1",
    [tenantId]
  );
  if (cbResult.rows.length === 0) return false;
  const t = cbResult.rows[0];
  const url = t.callback_url || t.webhook_url || "";
  if (!url) return false;

  const payload = {
    event: "withdrawal.update",
    withdrawal_id: withdrawalId,
    tenant_id: tenantId,
    status: data.status,
    to_address: data.to_address,
    from_address: data.from_address,
    token: data.token,
    token_symbol: data.token_symbol,
    amount: data.amount,
    tx_hash: data.tx_hash || null,
    fail_reason: data.fail_reason || data.error || null,
    timestamp: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);

  // HMAC-SHA256 signature
  let signature = "";
  if (t.api_secret_hash) {
    const crypto = await import("crypto");
    signature = crypto.createHmac("sha256", t.api_secret_hash).update(body).digest("hex");
  }

  try {
    await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        "X-InfraX-Signature": signature,
        "X-InfraX-Event": "withdrawal.update",
      },
      timeout: 10000,
    });
    logger.info("Callback sent", { tenantId, withdrawalId, status: data.status, url });
    return true;
  } catch (err: any) {
    logger.warn("Callback failed (will retry)", { tenantId, withdrawalId, status: data.status, error: err.message });
    // Queue for retry
    try {
      await pool.query(
        `INSERT INTO webhook_events (id, event_type, user_id, wallet_id, payload, status)
         VALUES ($1, $2, $3, $4, $5, "pending")`,
        [
          uuidv4(),
          `withdrawal.${data.status}`,
          tenantId,
          withdrawalId,
          JSON.stringify({ callback_url: url, payload, retry_count: 0, last_error: err.message }),
        ]
      );
    } catch (_) {}
    return false;
  }
}

import { Errors } from '../utils/errors';
import { config } from '../config';
import { getTenant } from './tenantService';
import { scanBlock, processDeposits } from './scannerService';
import { deriveAddressForChain, getHDMnemonic, getPrivateKey } from './hdWalletService';
import { encryptPrivateKey } from './encryptionService';
import { calculateFee } from './feeService';

/**
 * SaaS WaaS Service (F-034~037, L-018~022)
 * Address pool allocation, auto-sweep, withdrawal review
 */

/**
 * Allocate a unique on-chain address for a tenant's external user (L-019)
 * Same external_user_id always returns the same address (idempotent)
 */
export async function allocateAddress(params: {
  tenantId: string;
  externalUserId: string;
  chain: string;
  label?: string;
}): Promise<{
  address: string;
  chain: string;
  externalUserId: string;
  isNew: boolean;
}> {
  const { tenantId, externalUserId, chain, label } = params;

  if (!tenantId || !externalUserId || !chain) {
    throw Errors.paramError('Missing required fields: tenantId, externalUserId, chain');
  }

  // Check if address already exists for this tenant + chain + externalUserId
  const existing = await pool.query(
    'SELECT * FROM address_pool WHERE tenant_id = $1 AND chain = $2 AND external_user_id = $3',
    [tenantId, chain, externalUserId]
  );

  if (existing.rows.length > 0) {
    const addr = existing.rows[0];
    return {
      address: addr.address,
      chain: addr.chain,
      externalUserId: addr.external_user_id,
      isNew: false,
    };
  }

  // Generate new address via CWallet HD wallet (BIP44 deterministic derivation)
  // Use hash of externalUserId as deterministic user_index (same as CWallet's uuid5)
  const namespace = crypto.createHash('sha256').update(`cwallet:${tenantId}:${externalUserId}`).digest();
  const userIndex = namespace.readUInt32BE(0) & 0x7FFFFFFF;
  const mnemonic = getHDMnemonic();
  const { address, derivationPath } = deriveAddressForChain(userIndex, chain);
  const privateKey = getPrivateKey(mnemonic, derivationPath);
  const encryptedKey = encryptPrivateKey(privateKey);

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO address_pool (id, tenant_id, external_user_id, label, chain, address, encrypted_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
      [uuidv4(), tenantId, externalUserId, label || null, chain, address, encryptedKey]
    );

    logger.info('Address allocated', { tenantId, externalUserId, chain, address });
    return { address, chain, externalUserId, isNew: true };
  } finally {
    client.release();
  }
}

/**
 * Get address details for a tenant's external user
 */
export async function getAddress(tenantId: string, externalUserId: string): Promise<any> {
  const result = await pool.query(
    `SELECT a.*, COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'confirmed' AND t.from_address != a.address), 0) AS total_deposits
     FROM address_pool a
     LEFT JOIN transactions t ON t.to_address = a.address
     WHERE a.tenant_id = $1 AND a.external_user_id = $2
     GROUP BY a.id`,
    [tenantId, externalUserId]
  );

  if (result.rows.length === 0) {
    throw Errors.notFound('Address');
  }

  return result.rows[0];
}

/**
 * List all addresses for a tenant
 */
export async function listAddresses(params: {
  tenantId: string;
  status?: string;
  chain?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: any[]; total: number; hotWallets?: any[]; hotWalletBalances?: Record<string, string> }> {
  const { tenantId, status, chain, limit = 50, offset = 0 } = params;

  const conditions = ['tenant_id = $1'];
  const values: any[] = [tenantId];
  let idx = 2;

  if (status) {
    conditions.push(`status = $${idx++}`);
    values.push(status);
  }
  if (chain) {
    conditions.push(`chain = $${idx++}`);
    values.push(chain);
  }

  const where = ' WHERE ' + conditions.join(' AND ');

  const result = await pool.query(
    `SELECT * FROM address_pool${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, limit, offset]
  );

  const count = await pool.query(
    `SELECT COUNT(*)::int as cnt FROM address_pool${where}`,
    values
  );

  // Query hot wallet native token symbols per configured chain
  let hotWalletBalances: Record<string, string> = {};
  try {
    const tenantInfo = await pool.query(
      'SELECT hot_wallet_address FROM tenants WHERE id = $1',
      [tenantId]
    );
    if (tenantInfo.rows.length > 0 && tenantInfo.rows[0].hot_wallet_address) {
      const tokenResult = await pool.query(
        'SELECT DISTINCT chain_id FROM tenant_tokens WHERE tenant_id = $1 AND enabled = true',
        [tenantId]
      );
      const nativeSymbol: Record<string, string> = {
        '1': 'ETH', '11155111': 'ETH', '56': 'BNB', '137': 'POL',
        '8453': 'ETH', '42161': 'ETH', '10': 'ETH'
      };
      for (const row of tokenResult.rows) {
        const sym = nativeSymbol[row.chain_id] || 'ETH';
        if (!hotWalletBalances[row.chain_id]) hotWalletBalances[row.chain_id] = sym;
      }
    }
  } catch (e) { /* non-critical */ }

  // Also query hot wallet info for display
  let hotWallets: any[] = [];
  try {
    const hw = await pool.query(
      'SELECT hot_wallet_address FROM tenants WHERE id = $1',
      [tenantId]
    );
    if (hw.rows.length > 0 && hw.rows[0].hot_wallet_address) {
      const chains = await pool.query(
        'SELECT DISTINCT chain_id, display_name FROM chains WHERE enabled = true'
      );
      const nativeSymbol: Record<string, string> = {
        '1': 'ETH', '11155111': 'ETH', '56': 'BNB', '137': 'POL',
        '8453': 'ETH', '42161': 'ETH', '10': 'ETH'
      };
      for (const c of chains.rows) {
        hotWallets.push({
          chain: c.display_name || ('Chain ' + c.chain_id),
          address: hw.rows[0].hot_wallet_address,
          nativeSymbol: nativeSymbol[c.chain_id] || 'ETH',
          nativeBalance: 0, // will be filled by on-chain query
        });
      }
    }
  } catch (e) { /* non-critical */ }

  return { items: result.rows, total: count.rows[0].cnt, hotWallets };
}

/**
 * Execute auto-sweep: move funds from user addresses to tenant's sweep address (L-020)
 */
export async function sweepTenantFunds(tenantId: string): Promise<{
  swept: number;
  totalAmount: string;
}> {
  const tenant = await getTenant(tenantId);

  if (!tenant.sweep_address || !tenant.sweep_threshold) {
    throw Errors.paramError('Tenant sweep not configured (missing sweep_address or sweep_threshold)');
  }

  // Find all addresses with balance above threshold
  const result = await pool.query(
    `SELECT a.id, a.address, a.chain,
            COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'confirmed' AND t.from_address != a.address), 0) -
            COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'confirmed' AND t.from_address = a.address), 0)
            AS net_balance
     FROM address_pool a
     LEFT JOIN transactions t ON t.to_address = a.address OR t.from_address = a.address
     WHERE a.tenant_id = $1 AND a.status = 'active'
     GROUP BY a.id
     HAVING COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'confirmed' AND t.from_address != a.address), 0) -
            COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'confirmed' AND t.from_address = a.address), 0) >= $2`,
    [tenantId, tenant.sweep_threshold]
  );

  if (result.rows.length === 0) {
    return { swept: 0, totalAmount: '0' };
  }

  let totalSwept = 0;
  let totalAmount = 0;

  for (const row of result.rows) {
    const sweepId = uuidv4();
    const netBalance = parseFloat(row.net_balance);

    await pool.query(
      `INSERT INTO sweep_records (id, tenant_id, from_address, to_address, token, amount, status)
       VALUES ($1, $2, $3, $4, '*', $5, 'pending')`,
      [sweepId, tenantId, row.address, tenant.sweep_address, netBalance]
    );

    logger.info('Sweep queued', {
      tenantId,
      from: row.address,
      to: tenant.sweep_address,
      amount: netBalance,
    });

    totalSwept++;
    totalAmount += netBalance;
  }

  return { swept: totalSwept, totalAmount: totalAmount.toFixed(6) };
}

/**
 * Create a SaaS withdrawal request (L-021/022)
 */
export async function createWithdrawal(params: {
  tenantId: string;
  externalUserId: string;
  toAddress: string;
  token: string;
  chain?: string;
  chainId?: string;
  chainName?: string;
  tokenAddress?: string | null;
  amount: string;
}): Promise<{ id: string; status: string; reviewRequired: boolean }> {
  const { tenantId, externalUserId, toAddress, token, amount, chain, chainId, chainName, tokenAddress } = params;

  if (!tenantId || !externalUserId || !toAddress || !amount) {
    throw Errors.paramError('Missing required fields: tenantId, externalUserId, toAddress, amount');
  }

  // Get source address
  const addrResult = await pool.query(
    'SELECT address FROM address_pool WHERE tenant_id = $1 AND external_user_id = $2 AND status = $3',
    [tenantId, externalUserId, 'active']
  );

  if (addrResult.rows.length === 0) {
    throw Errors.notFound('Address for this external_user_id');
  }

  const tenant = await getTenant(tenantId);
  const reviewRequired = tenant.review_mode === 'manual';
  const status = reviewRequired ? 'pending_review' : 'processing';

  // Calculate fee via feeService (CWallet-compatible)
  const { fee, actualAmount, feeType } = await calculateFee(token || '*', amount);

  // Check min/max withdrawal limits
  const tokenResult = await pool.query(
    'SELECT min_withdraw, max_withdraw FROM tokens WHERE symbol = $1 AND enabled = true LIMIT 1',
    [token || '*']
  );
  if (tokenResult.rows.length > 0) {
    const minW = parseFloat(tokenResult.rows[0].min_withdraw || '0');
    const maxW = parseFloat(tokenResult.rows[0].max_withdraw || '0');
    if (minW > 0 && parseFloat(amount) < minW) {
      throw Errors.paramError(`Minimum withdrawal is ${minW} ${token || '*'}`);
    }
    if (maxW > 0 && parseFloat(amount) > maxW) {
      throw Errors.paramError(`Maximum withdrawal is ${maxW} ${token || '*'}`);
    }
  }

  if (parseFloat(actualAmount) <= 0) {
    throw Errors.paramError('Amount too small — fee exceeds withdrawal amount');
  }

  const withdrawalId = uuidv4();
  await pool.query(
    `INSERT INTO saas_withdrawals (id, tenant_id, external_user_id, from_address, to_address, token, amount, fee, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [withdrawalId, tenantId, externalUserId, addrResult.rows[0].address, toAddress, token || '*', amount, fee, status]
  );

  logger.info('Withdrawal created', { id: withdrawalId, tenantId, externalUserId, amount, fee, reviewRequired });
  return { id: withdrawalId, status, reviewRequired, fee, actualAmount } as any;
}

/**
 * Approve a withdrawal (reviewed by tenant admin)
 * Now chains real on-chain transfer via Gas Pool → broadcast to RPC
 */
export async function approveWithdrawal(tenantId: string, withdrawalId: string, reviewer: string): Promise<any> {
  const result = await pool.query(
    `UPDATE saas_withdrawals SET status = 'approved', review_by = $3, review_note = NULL, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND status = 'pending_review' RETURNING *`,
    [withdrawalId, tenantId, reviewer]
  );

  if (result.rows.length === 0) {
    throw Errors.notFound('Withdrawal or already processed');
  }

  const withdrawal = result.rows[0];

  logger.info('Withdrawal approved, executing on-chain transfer', {
    id: withdrawalId,
    from: withdrawal.from_address,
    to: withdrawal.to_address,
    amount: withdrawal.amount,
    token: withdrawal.token,
  });

  // ── Real on-chain execution via Gas Pool ──
  let txHash: string | null = null;
  let finalStatus = 'confirmed';

  try {
    const pk = config.gasPool.privateKey || process.env.GAS_POOL_PRIVATE_KEY || '';
    if (!pk) {
      logger.warn('GAS_POOL_PRIVATE_KEY not configured — falling back to simulated confirm');
      await pool.query(
        `UPDATE saas_withdrawals SET status = 'confirmed', updated_at = NOW() WHERE id = $1`,
        [withdrawalId]
      );
      return { ...withdrawal, status: 'confirmed', txHash: null, note: 'simulated (no gas pool key)' };
    }

    // Use Sepolia RPC from config or env
    const rpcUrl = config.sepoliaRpcUrl || process.env.SEPOLIA_RPC_URL ||
      'https://ethereum-sepolia-rpc.publicnode.com';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const gasWallet = new ethers.Wallet(pk, provider);

    // Get from-address private key via HD wallet + encrypted key lookup
    const fromAddr = withdrawal.from_address;
    const addrResult = await pool.query(
      'SELECT encrypted_key, derivation_path FROM address_pool WHERE address = $1 AND tenant_id = $2',
      [fromAddr, tenantId]
    );

    let fromSigner: ethers.Wallet;

    if (addrResult.rows.length > 0 && addrResult.rows[0].encrypted_key) {
      // Address was created via our HD wallet — decrypt the private key
      const { decryptPrivateKey } = await import('./encryptionService');
      const decryptedPk = decryptPrivateKey(addrResult.rows[0].encrypted_key);
      fromSigner = new ethers.Wallet(decryptedPk, provider);
    } else {
      // Fallback: use Gas Pool as sender (for sweep/consolidated wallets)
      fromSigner = gasWallet;
      logger.info('Using Gas Pool as sender for withdrawal', { from: fromAddr, to: withdrawal.to_address });
    }

    const amountWei = ethers.parseEther(withdrawal.amount.toString());

    if (withdrawal.token === '*' || withdrawal.token === 'ETH' || !withdrawal.token) {
      // Native ETH transfer
      const tx = await fromSigner.sendTransaction({
        to: withdrawal.to_address,
        value: amountWei,
        gasLimit: 21000,
      });
      txHash = tx.hash;
      const receipt = await tx.wait();
      logger.info('Withdrawal ETH transfer confirmed', {
        withdrawalId,
        txHash,
        blockNumber: receipt?.blockNumber,
      });
    } else {
      // ERC-20 token transfer
      const erc20Abi = ['function transfer(address to, uint256 amount) returns (bool)'];
      const tokenContract = new ethers.Contract(withdrawal.token, erc20Abi, fromSigner);
      const tx = await tokenContract.transfer(withdrawal.to_address, amountWei);
      txHash = tx.hash;
      const receipt = await tx.wait();
      logger.info('Withdrawal ERC-20 transfer confirmed', {
        withdrawalId,
        token: withdrawal.token,
        txHash,
        blockNumber: receipt?.blockNumber,
      });
    }

    finalStatus = 'confirmed';
  } catch (err: any) {
    logger.error('Withdrawal on-chain transfer failed', {
      withdrawalId,
      error: err.message,
      from: withdrawal.from_address,
      to: withdrawal.to_address,
    });
    finalStatus = 'failed';
    // Store error message for retry/debugging
    await pool.query(
      `UPDATE saas_withdrawals SET review_note = $2 WHERE id = $1`,
      [withdrawalId, `Chain error: ${err.message}`]
    );
  }

  // Update DB with final status
  await pool.query(
    `UPDATE saas_withdrawals SET status = $1, tx_hash = $2, updated_at = NOW() WHERE id = $1$3`,
    [finalStatus, txHash, withdrawalId]
  );

  // Fire webhook notification
  try {
    const { createWebhookEvent } = await import('./webhookService');
    await createWebhookEvent(
      finalStatus === 'confirmed' ? 'withdrawal' : 'failed',
      tenantId,
      withdrawal.from_address,
      {
        withdrawalId,
        txHash,
        toAddress: withdrawal.to_address,
        amount: withdrawal.amount,
        token: withdrawal.token,
        status: finalStatus,
      }
    ).catch(() => {});
  } catch (_) {}

  return { ...withdrawal, status: finalStatus, txHash };
}

/**
 * Reject a withdrawal (reviewed by tenant admin)
 */
export async function rejectWithdrawal(tenantId: string, withdrawalId: string, reason: string, reviewer: string): Promise<any> {
  const result = await pool.query(
    `UPDATE saas_withdrawals SET status = 'rejected', review_by = $3, review_note = $4, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND status = 'pending_review' RETURNING *`,
    [withdrawalId, tenantId, reviewer, reason]
  );

  if (result.rows.length === 0) {
    throw Errors.notFound('Withdrawal or already processed');
  }

  const wdR = result.rows[0];
  logger.info('Withdrawal rejected', { id: withdrawalId, reason });
  sendTenantCallback(tenantId, withdrawalId, {
    status: 'rejected', to_address: wdR.to_address, from_address: wdR.from_address,
    token: wdR.token, amount: wdR.amount, fail_reason: reason,
  }).catch(() => {});
  return wdR;
}

/**
 * List withdrawals for a tenant
 */
export async function listWithdrawals(params: {
  tenantId: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: any[]; total: number; hotWallets?: any[]; hotWalletBalances?: Record<string, string> }> {
  const { tenantId, status, limit = 50, offset = 0 } = params;

  const conditions = ['tenant_id = $1'];
  const values: any[] = [tenantId];
  let idx = 2;

  if (status) {
    conditions.push(`status = $${idx++}`);
    values.push(status);
  }

  const where = ' WHERE ' + conditions.join(' AND ');

  const result = await pool.query(
    `SELECT * FROM saas_withdrawals${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, limit, offset]
  );

  const count = await pool.query(
    `SELECT COUNT(*)::int as cnt FROM saas_withdrawals${where}`,
    values
  );

  // Query hot wallet native token symbols per configured chain
  let hotWalletBalances: Record<string, string> = {};
  try {
    const tenantInfo = await pool.query(
      'SELECT hot_wallet_address FROM tenants WHERE id = $1',
      [tenantId]
    );
    if (tenantInfo.rows.length > 0 && tenantInfo.rows[0].hot_wallet_address) {
      const tokenResult = await pool.query(
        'SELECT DISTINCT chain_id FROM tenant_tokens WHERE tenant_id = $1 AND enabled = true',
        [tenantId]
      );
      const nativeSymbol: Record<string, string> = {
        '1': 'ETH', '11155111': 'ETH', '56': 'BNB', '137': 'POL',
        '8453': 'ETH', '42161': 'ETH', '10': 'ETH'
      };
      for (const row of tokenResult.rows) {
        const sym = nativeSymbol[row.chain_id] || 'ETH';
        if (!hotWalletBalances[row.chain_id]) hotWalletBalances[row.chain_id] = sym;
      }
    }
  } catch (e) { /* non-critical */ }

  // Also query hot wallet info for display
  let hotWallets: any[] = [];
  try {
    const hw = await pool.query(
      'SELECT hot_wallet_address FROM tenants WHERE id = $1',
      [tenantId]
    );
    if (hw.rows.length > 0 && hw.rows[0].hot_wallet_address) {
      const chains = await pool.query(
        'SELECT DISTINCT chain_id, display_name FROM chains WHERE enabled = true'
      );
      const nativeSymbol: Record<string, string> = {
        '1': 'ETH', '11155111': 'ETH', '56': 'BNB', '137': 'POL',
        '8453': 'ETH', '42161': 'ETH', '10': 'ETH'
      };
      for (const c of chains.rows) {
        hotWallets.push({
          chain: c.display_name || ('Chain ' + c.chain_id),
          address: hw.rows[0].hot_wallet_address,
          nativeSymbol: nativeSymbol[c.chain_id] || 'ETH',
          nativeBalance: 0, // will be filled by on-chain query
        });
      }
    }
  } catch (e) { /* non-critical */ }

  return { items: result.rows, total: count.rows[0].cnt, hotWallets };
}

/**
 * Get tenant balance summary (for SaaS dashboard F-037)
 */
export async function getTenantBalances(tenantId: string): Promise<any> {
  const addressCount = await pool.query(
    `SELECT COUNT(*)::int as cnt FROM address_pool WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId]
  );

  const withdrawalPending = await pool.query(
    `SELECT COUNT(*)::int as cnt FROM saas_withdrawals WHERE tenant_id = $1 AND status = 'pending_review'`,
    [tenantId]
  );

  const todayDeposits = await pool.query(
    `SELECT COALESCE(SUM(amount)::float, 0) as total
     FROM sweep_records WHERE tenant_id = $1 AND status = 'confirmed'
     AND created_at >= NOW() - INTERVAL '24 hours'`,
    [tenantId]
  );

  const todayWithdrawals = await pool.query(
    `SELECT COALESCE(SUM(amount)::float, 0) as total
     FROM saas_withdrawals WHERE tenant_id = $1 AND status = 'confirmed'
     AND created_at >= NOW() - INTERVAL '24 hours'`,
    [tenantId]
  );

  return {
    totalAddresses: addressCount.rows[0].cnt,
    pendingReviews: withdrawalPending.rows[0].cnt,
    todayDeposits: todayDeposits.rows[0].total,
    todayWithdrawals: todayWithdrawals.rows[0].total,
  };
}

/**
 * Get tenant transaction history (for SaaS dashboard F-037)
 */
export async function getTenantTransactions(params: {
  tenantId: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: any[]; total: number; hotWallets?: any[]; hotWalletBalances?: Record<string, string> }> {
  const { tenantId, limit = 50, offset = 0 } = params;

  const items = await pool.query(
    `SELECT * FROM sweep_records WHERE tenant_id = $1
     UNION ALL
     SELECT id, tenant_id, from_address, to_address, token, amount, NULL as tx_hash, status, created_at
     FROM saas_withdrawals WHERE tenant_id = $1
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );

  const count = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM sweep_records WHERE tenant_id = $1) +
       (SELECT COUNT(*)::int FROM saas_withdrawals WHERE tenant_id = $1) as cnt`,
    [tenantId]
  );

  return { items: items.rows, total: count.rows[0].cnt };
}

// ═══════════════════════════════════════════════
// Tenant API Keys CRUD (P0#1)
// ═══════════════════════════════════════════════

/**
 * Find tenant for a given user by email
 * Strategy:
 *   1. Check if the user is listed as a tenant member (via tenant_members join table)
 *   2. Fallback: match contact_email of the tenant
 *   3. Fallback: if user is admin, return first active tenant (for testing)
 */
export async function findTenantForUser(userEmail: string): Promise<{ tenantId: string; tenantName: string }> {
  // Step 1: Check tenant_members (if table exists)
  try {
    const memberResult = await pool.query(
      `SELECT t.id, t.name FROM tenants t
       INNER JOIN tenant_members tm ON tm.tenant_id = t.id
       WHERE tm.email = $1 AND t.status = 'active'
       LIMIT 1`,
      [userEmail]
    );
    if (memberResult.rows.length > 0) {
      return { tenantId: memberResult.rows[0].id, tenantName: memberResult.rows[0].name };
    }
  } catch {
    // tenant_members table may not exist yet — continue to fallback
  }

  // Step 2: Check contact_email
  const contactResult = await pool.query(
    `SELECT id, name FROM tenants WHERE contact_email = $1 AND status = 'active' LIMIT 1`,
    [userEmail]
  );
  if (contactResult.rows.length > 0) {
    return { tenantId: contactResult.rows[0].id, tenantName: contactResult.rows[0].name };
  }

  // Step 3: If user is admin, return any active tenant (dev/testing convenience)
  const userResult = await pool.query(
    'SELECT role FROM users WHERE email = $1',
    [userEmail]
  );
  if (userResult.rows.length > 0 && userResult.rows[0].role === 'admin') {
    const anyTenant = await pool.query(
      "SELECT id, name FROM tenants WHERE status = 'active' LIMIT 1"
    );
    if (anyTenant.rows.length > 0) {
      return { tenantId: anyTenant.rows[0].id, tenantName: anyTenant.rows[0].name };
    }
  }

  throw Errors.notFound('No tenant found for your account. Contact admin to create a tenant first.');
}

/**
 * Create a tenant-scoped API key
 */
export async function createApiKey(tenantId: string, keyName: string): Promise<{ id: string; keyName: string; apiKey: string; scope: string }> {
  const apiKeyValue = `pk_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(apiKeyValue).digest('hex');
  const keyId = uuidv4();

  // Verify tenant exists
  const tenant = await pool.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
  if (tenant.rows.length === 0) {
    throw Errors.notFound('Tenant');
  }

  await pool.query(
    `INSERT INTO api_keys (id, key_hash, name, scope, enabled)
     VALUES ($1, $2, $3, 'tenant', true)`,
    [keyId, keyHash, keyName]
  );

  logger.info('Tenant API key created', { tenantId, keyId, keyName });
  return { id: keyId, keyName, apiKey: apiKeyValue, scope: 'tenant' };
}

/**
 * List all API keys for a tenant
 */
export async function listApiKeys(tenantId: string): Promise<{ items: any[] }> {
  // Get all api_keys with scope='tenant'
  const result = await pool.query(
    `SELECT id, name, scope, enabled, created_at, expires_at, last_used_at
     FROM api_keys WHERE scope = 'tenant' ORDER BY created_at DESC`
  );
  return { items: result.rows };
}

/**
 * Rotate an API key (create new, revoke old)
 */
export async function rotateApiKey(keyId: string, tenantId: string): Promise<{ id: string; apiKey: string }> {
  const existing = await pool.query(
    'SELECT name FROM api_keys WHERE id = $1 AND scope = $2',
    [keyId, 'tenant']
  );
  if (existing.rows.length === 0) {
    throw Errors.notFound('API Key');
  }

  const newApiKeyValue = `pk_${crypto.randomBytes(24).toString('hex')}`;
  const newKeyHash = crypto.createHash('sha256').update(newApiKeyValue).digest('hex');
  const newKeyId = uuidv4();

  // Disable old key
  await pool.query(
    'UPDATE api_keys SET enabled = false WHERE id = $1',
    [keyId]
  );

  // Create new key
  await pool.query(
    `INSERT INTO api_keys (id, key_hash, name, scope, enabled)
     VALUES ($1, $2, $3, 'tenant', true)`,
    [newKeyId, newKeyHash, existing.rows[0].name + ' (rotated)']
  );

  logger.info('Tenant API key rotated', { tenantId, oldKeyId: keyId, newKeyId });
  return { id: newKeyId, apiKey: newApiKeyValue };
}

/**
 * Revoke (disable) an API key
 */
export async function revokeApiKey(keyId: string): Promise<void> {
  const result = await pool.query(
    'UPDATE api_keys SET enabled = false WHERE id = $1 AND scope = $2',
    [keyId, 'tenant']
  );
  if (result.rowCount === 0) {
    throw Errors.notFound('API Key');
  }
  logger.info('Tenant API key revoked', { keyId });
}
