import { Router } from 'express';
import { asyncHandler, apiResponse } from '../helpers';
import { pool } from '../database';

const router = Router();

/**
 * Tracked Tokens — user-configured token monitoring list.
 *
 * Tokens in this table are merged with OKX hot-tokens to determine
 * which tokens the scheduler pulls candles and snapshots for.
 */

/** GET /api/v2/admin/tracked-tokens — list all tracked tokens */
router.get('/tracked-tokens', asyncHandler(async (req, res) => {
  const { chain, enabled } = req.query as any;
  let query = 'SELECT * FROM tracked_tokens WHERE 1=1';
  const params: any[] = [];
  let i = 1;

  if (chain) { query += ` AND chain = $${i++}`; params.push(chain); }
  if (enabled !== undefined) { query += ` AND enabled = $${i++}`; params.push(enabled === 'true'); }

  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, params);
  res.json(apiResponse(result.rows));
}));

/** POST /api/v2/admin/tracked-tokens — add a token to track */
router.post('/tracked-tokens', asyncHandler(async (req, res) => {
  const { chain, tokenAddress, tokenSymbol, tokenName, label, createdBy } = req.body || {};
  if (!chain || !tokenAddress) {
    res.status(400).json(apiResponse(null, 'chain and tokenAddress required'));
    return;
  }

  const result = await pool.query(
    `INSERT INTO tracked_tokens (chain, token_address, token_symbol, token_name, label, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (chain, token_address) DO UPDATE
     SET token_symbol = EXCLUDED.token_symbol,
         token_name = EXCLUDED.token_name,
         label = COALESCE(EXCLUDED.label, tracked_tokens.label),
         enabled = true,
         updated_at = NOW()
     RETURNING *`,
    [chain, tokenAddress, tokenSymbol || null, tokenName || null, label || null, createdBy || null]
  );
  res.json(apiResponse(result.rows[0], 'Token added to tracking'));
}));

/** PUT /api/v2/admin/tracked-tokens/:id — update a tracked token */
router.put('/tracked-tokens/:id', asyncHandler(async (req, res) => {
  const { id } = req.params as any;
  const { enabled, label, tokenSymbol, tokenName } = req.body || {};
  const fields: string[] = [];
  const params: any[] = [];
  let i = 1;

  if (enabled !== undefined) { fields.push(`enabled = $${i++}`); params.push(enabled); }
  if (label !== undefined) { fields.push(`label = $${i++}`); params.push(label); }
  if (tokenSymbol !== undefined) { fields.push(`token_symbol = $${i++}`); params.push(tokenSymbol); }
  if (tokenName !== undefined) { fields.push(`token_name = $${i++}`); params.push(tokenName); }

  if (fields.length === 0) {
    res.status(400).json(apiResponse(null, 'no fields to update'));
    return;
  }

  fields.push(`updated_at = NOW()`);
  params.push(parseInt(id, 10));

  const result = await pool.query(
    `UPDATE tracked_tokens SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );
  if (result.rows.length === 0) {
    res.status(404).json(apiResponse(null, 'Token not found'));
    return;
  }
  res.json(apiResponse(result.rows[0], 'Updated'));
}));

/** DELETE /api/v2/admin/tracked-tokens/:id — remove a tracked token */
router.delete('/tracked-tokens/:id', asyncHandler(async (req, res) => {
  const { id } = req.params as any;
  const result = await pool.query('DELETE FROM tracked_tokens WHERE id = $1 RETURNING *', [parseInt(id, 10)]);
  if (result.rows.length === 0) {
    res.status(404).json(apiResponse(null, 'Token not found'));
    return;
  }
  res.json(apiResponse(null, 'Removed from tracking'));
}));

export default router;
