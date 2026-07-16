import { Request, Response, NextFunction } from 'express';
import { pool } from '../models/database';
import { apiResponse } from '../utils/helpers';

/**
 * Data Center API Key Authentication Middleware
 * 
 * Verifies x-dc-api-key header against tenants.dc_api_key.
 * Attaches tenant context to req for downstream use.
 */

export async function requireDcApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = (req.headers['x-dc-api-key'] as string) || '';

  if (!apiKey) {
    res.status(401).json(apiResponse(null, 'Missing x-dc-api-key header', 1003));
    return;
  }

  try {
    const result = await pool.query(
      `SELECT t.id, t.data_plan_id, t.status FROM tenants t
       WHERE t.dc_api_key = $1 AND t.status = 'active'
       LIMIT 1`,
      [apiKey]
    );

    if (result.rows.length === 0) {
      res.status(401).json(apiResponse(null, 'Invalid or inactive API key', 1004));
      return;
    }

    // Attach tenant context
    (req as any).dcTenant = result.rows[0];

    next();
  } catch (err: any) {
    res.status(500).json(apiResponse(null, 'Auth error: ' + err.message, -1));
  }
}
