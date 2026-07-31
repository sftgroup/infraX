import { Router } from 'express';
import { asyncHandler, apiResponse } from '../helpers';
import { pool } from '../database';

const router = Router();

/**
 * Custom Event Signatures — tenant-defined event topic→type mappings.
 *
 * When the reclassifier processes raw_events, it first checks built-in
 * event signatures (Transfer, Approval, Swap...), then falls back to
 * these user-registered signatures for custom event classification.
 *
 * Optional ABI field (JSON) enables full parameter decoding via ethers.
 */

/** GET /api/v2/admin/custom-sigs — list all custom event signatures */
router.get('/custom-sigs', asyncHandler(async (req, res) => {
  const { chain, enabled } = req.query as any;
  let query = 'SELECT * FROM custom_event_sigs WHERE 1=1';
  const params: any[] = [];
  let i = 1;

  if (chain) { query += ` AND chain = $${i++}`; params.push(chain); }
  if (enabled !== undefined) { query += ` AND enabled = $${i++}`; params.push(enabled === 'true'); }

  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, params);
  res.json(apiResponse(result.rows));
}));

/** POST /api/v2/admin/custom-sigs — register a custom event signature */
router.post('/custom-sigs', asyncHandler(async (req, res) => {
  const { chain, topicHash, eventType, eventName, abi, createdBy } = req.body || {};
  if (!chain || !topicHash || !eventType) {
    res.status(400).json(apiResponse(null, 'chain, topicHash, eventType required'));
    return;
  }

  // Validate topic hash format (0x + 64 hex chars)
  if (!/^0x[a-fA-F0-9]{64}$/.test(topicHash)) {
    res.status(400).json(apiResponse(null, 'topicHash must be 0x + 64 hex chars (keccak256)'));
    return;
  }

  const result = await pool.query(
    `INSERT INTO custom_event_sigs (chain, topic_hash, event_type, event_name, abi, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (chain, topic_hash) DO UPDATE
     SET event_type = EXCLUDED.event_type,
         event_name = COALESCE(EXCLUDED.event_name, custom_event_sigs.event_name),
         abi = COALESCE(EXCLUDED.abi, custom_event_sigs.abi),
         enabled = true,
         updated_at = NOW()
     RETURNING *`,
    [chain, topicHash.toLowerCase(), eventType, eventName || null, abi ? JSON.stringify(abi) : null, createdBy || null]
  );
  res.json(apiResponse(result.rows[0], 'Custom event signature registered'));
}));

/** PUT /api/v2/admin/custom-sigs/:id — update a custom signature */
router.put('/custom-sigs/:id', asyncHandler(async (req, res) => {
  const { id } = req.params as any;
  const { enabled, eventType, eventName, abi } = req.body || {};
  const fields: string[] = [];
  const params: any[] = [];
  let i = 1;

  if (enabled !== undefined) { fields.push(`enabled = $${i++}`); params.push(enabled); }
  if (eventType !== undefined) { fields.push(`event_type = $${i++}`); params.push(eventType); }
  if (eventName !== undefined) { fields.push(`event_name = $${i++}`); params.push(eventName); }
  if (abi !== undefined) { fields.push(`abi = $${i++}`); params.push(abi ? JSON.stringify(abi) : null); }

  if (fields.length === 0) {
    res.status(400).json(apiResponse(null, 'no fields to update'));
    return;
  }

  fields.push(`updated_at = NOW()`);
  params.push(parseInt(id, 10));

  const result = await pool.query(
    `UPDATE custom_event_sigs SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );
  if (result.rows.length === 0) {
    res.status(404).json(apiResponse(null, 'Signature not found'));
    return;
  }
  res.json(apiResponse(result.rows[0], 'Updated'));
}));

/** DELETE /api/v2/admin/custom-sigs/:id — remove a custom signature */
router.delete('/custom-sigs/:id', asyncHandler(async (req, res) => {
  const { id } = req.params as any;
  const result = await pool.query('DELETE FROM custom_event_sigs WHERE id = $1 RETURNING *', [parseInt(id, 10)]);
  if (result.rows.length === 0) {
    res.status(404).json(apiResponse(null, 'Signature not found'));
    return;
  }
  res.json(apiResponse(null, 'Removed'));
}));

export default router;
