/**
 * chain-rpc 增强路由：DC 链上事件解析层（RPC 增值能力）。
 *
 *   GET /v1/enhanced/events            链上业务事件（转账/授权/DEX…，已解码）
 *   GET /v1/enhanced/event-categories  业务分类目录
 *   GET /v1/enhanced/event-stats       分类分布统计
 *
 * 设计：内部以 `x-dc-api-key` 代理 DC :9102 `/api/v2/data/*`，对 B 端表现为
 * RPC 网关统一入口（读 key 鉴权 + 读配额）。未配置 DC_ENHANCED_URL 时端点返回
 * 503（能力未启用）；配置了 URL 但缺 key → 启动 fail-closed（见 index.ts）。
 */
import { Router } from 'express';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';

const PASSTHROUGH_QUERY = ['chain', 'address', 'contract', 'event_type', 'category', 'label', 'from_block', 'to_block', 'page_size'];

export function createEnhancedRouter(): Router {
  const router = Router();

  if (!config.dcEnhanced.baseUrl) {
    router.use((_req, res) => {
      res.status(503).json({ detail: 'enhanced data not configured' });
    });
    return router;
  }

  const upstream = config.dcEnhanced.baseUrl.replace(/\/+$/, '');

  const proxyGet = async (req: any, res: any, path: string) => {
    try {
      const qs = new URLSearchParams();
      for (const k of PASSTHROUGH_QUERY) {
        const v = req.query[k];
        if (v !== undefined) qs.append(k, String(v));
      }
      const q = qs.toString();
      const url = `${upstream}${path}${q ? `?${q}` : ''}`;
      const r = await axios.get(url, {
        headers: { 'x-dc-api-key': config.dcEnhanced.apiKey },
        timeout: config.requestTimeoutMs,
        validateStatus: () => true,
      });
      res.status(r.status).type('application/json').send(JSON.stringify(r.data));
    } catch (e: any) {
      logger.error(`[chain-rpc] enhanced proxy ${path} failed: ${e?.message || e}`);
      res.status(502).json({ detail: 'upstream dc unavailable' });
    }
  };

  router.get('/events', (req, res) => proxyGet(req, res, '/api/v2/data/events'));
  router.get('/event-categories', (req, res) => proxyGet(req, res, '/api/v2/data/event-categories'));
  router.get('/event-stats', (req, res) => proxyGet(req, res, '/api/v2/data/event-stats'));

  return router;
}
