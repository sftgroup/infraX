// MQ-16 T-2: Market 行情 API 按量扣减中间件（挂在 /api/v2/data market 路由前）
// 请求级明细（market_usage）+ 日聚合 upsert（market_usage_daily），
// 当月用量达到套餐配额上限 → 503 + 升级提示（对齐需求：配额用尽 → 503）。
// 记账故障不阻断业务（fire-and-forget，失败仅 warn）。
import { Request, Response, NextFunction } from 'express';
import { pool } from '../database';
import { MARKET_PLANS, monthStart } from '../marketPlans';

export async function marketQuotaEnforce(req: Request, res: Response, next: NextFunction): Promise<void> {
  const keyId = (req as any).apiKey?.id as number | undefined;
  if (!keyId) { res.status(401).json({ code: 401, message: 'Invalid API key' }); return; }
  const planId = (req as any).apiKey?.marketPlanId || 'market_free';
  const plan = MARKET_PLANS.find((p) => p.id === planId) || MARKET_PLANS[0];
  const quota = plan.features.apiCallsPerMonth;
  const endpoint = req.path;
  try {
    const r = await pool.query(
      'SELECT COUNT(*)::int as cnt FROM market_usage WHERE key_id = $1 AND timestamp >= $2',
      [keyId, monthStart()]
    );
    const used = r.rows[0]?.cnt || 0;
    if (used >= quota) {
      res.status(503).json({
        code: 503,
        message: 'Market quota exhausted — upgrade your plan at /api/v2/market/plans',
        data: { used, quota, plan: planId, upgradeUrl: '/api/v2/market/plans' },
      });
      return;
    }
    // 记账（异步 fire-and-forget，失败不阻断请求）
    pool.query('INSERT INTO market_usage (key_id, endpoint) VALUES ($1, $2)', [keyId, endpoint])
      .then(() => pool.query(
        `INSERT INTO market_usage_daily (key_id, date, endpoint, total_calls)
         VALUES ($1, CURRENT_DATE, $2, 1)
         ON CONFLICT (key_id, date, endpoint)
         DO UPDATE SET total_calls = market_usage_daily.total_calls + 1`,
        [keyId, endpoint]
      ))
      .catch((e: any) => console.warn('[market] usage record failed:', e.message));
  } catch (e: any) {
    console.warn('[market] quota check failed (proceed without enforcement):', e.message);
  }
  next();
}
