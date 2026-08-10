// MQ-16 T-3: Chain RPC 读配额扣减中间件（挂在 /v1/rpc 读路由前）
// 仅对 rx_ 订阅 key 计费（req.rpcKey，由 auth.ts readAuth 校验后注入）；
// 本地 bridge key / 外部 data 服务 key（dx_/mx_）→ 豁免配额。
// 请求级明细（rpc_usage）+ 日聚合 upsert（rpc_usage_daily），
// 当月用量达到套餐配额上限 → 503 + 升级提示（对齐需求：配额用尽 → 503）。
// 记账故障不阻断业务（fire-and-forget，失败仅 warn）。
import { Request, Response, NextFunction } from 'express';
import { rpcPool, RPC_PLANS, monthStart } from '../services/rpcSubscription';

export function rpcQuotaEnforce() {
  return async function enforce(req: Request, res: Response, next: NextFunction): Promise<void> {
    const rpcKey = (req as any).rpcKey as { id: number; rpc_plan_id: string } | undefined;
    if (!rpcKey) return next(); // 本地/外部 data key：豁免
    const planId = rpcKey.rpc_plan_id || 'rpc_free';
    const plan = RPC_PLANS.find((p) => p.id === planId) || RPC_PLANS[0];
    const quota = plan.features.callsPerMonth;
    const endpoint = req.path;
    try {
      const r = await rpcPool.query(
        'SELECT COUNT(*)::int as cnt FROM rpc_usage WHERE key_id = $1 AND timestamp >= $2',
        [rpcKey.id, monthStart()]
      );
      const used = r.rows[0]?.cnt || 0;
      if (used >= quota) {
        res.status(503).json({
          code: 503,
          message: 'RPC quota exhausted — upgrade your plan at /v1/subscription/plans',
          data: { used, quota, plan: planId, upgradeUrl: '/v1/subscription/plans' },
        });
        return;
      }
      // 记账（异步 fire-and-forget，失败不阻断请求）
      rpcPool.query('INSERT INTO rpc_usage (key_id, endpoint) VALUES ($1, $2)', [rpcKey.id, endpoint])
        .then(() => rpcPool.query(
          `INSERT INTO rpc_usage_daily (key_id, date, endpoint, total_calls)
           VALUES ($1, CURRENT_DATE, $2, 1)
           ON CONFLICT (key_id, date, endpoint)
           DO UPDATE SET total_calls = rpc_usage_daily.total_calls + 1`,
          [rpcKey.id, endpoint]
        ))
        .catch((e: any) => console.warn('[chain-rpc] rpc usage record failed:', e.message));
    } catch (e: any) {
      console.warn('[chain-rpc] rpc quota check failed (proceed without enforcement):', e.message);
    }
    next();
  };
}
