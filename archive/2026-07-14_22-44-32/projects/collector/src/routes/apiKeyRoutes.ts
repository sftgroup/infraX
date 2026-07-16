import { Router } from 'express';
import { asyncHandler, apiResponse } from '../helpers';
import { pool } from '../database';
import { logger } from '../logger';
import { generateApiKey } from '../middleware/apiKeyAuth';

const router = Router();

// ── CRUD routes ──

// List API keys — mask full key, show only first 8 + last 4
router.get('/api-keys', asyncHandler(async (_req, res) => {
  const result = await pool.query(
    `SELECT id, label,
            LEFT(api_key, 8) || '...' || RIGHT(api_key, 4) as api_key_masked,
            rate_limit, enabled, created_by, last_used_at, request_count, created_at
     FROM api_keys ORDER BY created_at DESC`
  );
  res.json(apiResponse(result.rows));
}));

// Create API key
router.post('/api-keys', asyncHandler(async (req, res) => {
  const { label, rate_limit } = req.body;
  if (!label) {
    res.status(400).json(apiResponse(null, 'label required'));
    return;
  }
  const apiKey = generateApiKey();
  const result = await pool.query(
    `INSERT INTO api_keys (label, api_key, rate_limit, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id, label, api_key, rate_limit, created_at`,
    [label, apiKey, rate_limit || 100, 'admin']
  );
  logger.info('[api-key] Created', { label, id: result.rows[0].id });
  res.status(201).json(apiResponse(result.rows[0]));
}));

// Update API key (toggle enabled, rate limit)
router.patch('/api-keys/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { label, enabled, rate_limit } = req.body;
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (label !== undefined) { sets.push(`label = $${i++}`); vals.push(label); }
  if (enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(Boolean(enabled)); }
  if (rate_limit !== undefined) { sets.push(`rate_limit = $${i++}`); vals.push(Math.max(1, rate_limit)); }
  if (!sets.length) { res.json(apiResponse(null, 'nothing to update')); return; }
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  await pool.query(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  res.json(apiResponse({ updated: true }));
}));

// Delete API key
router.delete('/api-keys/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM api_keys WHERE id = $1', [req.params.id]);
  logger.info('[api-key] Deleted', { id: req.params.id });
  res.json(apiResponse({ deleted: true }));
}));

export default router;
