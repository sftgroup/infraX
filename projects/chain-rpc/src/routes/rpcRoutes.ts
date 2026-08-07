/**
 * chain-rpc 路由：
 *   POST /v1/rpc/:chain          通用 JSON-RPC 读调用（读 key）
 *   GET  /v1/status              池状态（脱敏）
 *   POST /v1/broadcast/:chain    交易广播 eth_sendRawTransaction（广播 key）+ 可选确认轮询
 *
 * 读与广播使用**独立 router**：index.ts 将 /v1/rpc 挂读鉴权、/v1/broadcast 挂
 * 广播鉴权，保证读 key 永远无法触达广播端点。
 */
import { Router } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { RpcPoolManager, ChainRpcError } from '../services/rpcPool';
import { normalizeChain } from '../services/rpcPoolConfig';
import { isReadMethod } from '../services/whitelist';

/** 读 router：POST /rpc/:chain + GET /status */
export function createRpcRouter(pool: RpcPoolManager): Router {
  const router = Router();

  router.post('/:chain', async (req, res) => {
    try {
      const norm = normalizeChain(req.params.chain);
      if (!norm) {
        res.status(400).json({ detail: `unsupported chain: ${req.params.chain}` });
        return;
      }
      const { method, params } = req.body || {};
      if (!method || typeof method !== 'string') {
        res.status(400).json({ detail: 'method is required' });
        return;
      }
      if (!isReadMethod(norm, method)) {
        res.status(403).json({ detail: `method ${method} is not allowed on read endpoint` });
        return;
      }
      const result = await pool.call(norm, method, Array.isArray(params) ? params : []);
      res.json({ code: 0, message: 'ok', data: { chain: norm, method, result } });
    } catch (err: any) {
      handleError(res, err, 'rpc');
    }
  });

  router.get('/status', (_req, res) => {
    res.json({ code: 0, message: 'ok', data: { chains: pool.status() } });
  });

  return router;
}

/** 广播 router：POST /broadcast/:chain */
export function createBroadcastRouter(pool: RpcPoolManager): Router {
  const router = Router();

  router.post('/:chain', async (req, res) => {
    try {
      const norm = normalizeChain(req.params.chain);
      if (!norm) {
        res.status(400).json({ detail: `unsupported chain: ${req.params.chain}` });
        return;
      }
      const { rawTransaction, wait, timeoutMs } = req.body || {};
      const txHash = await pool.broadcast(norm, rawTransaction);

      if (wait) {
        const receipt = await pool.waitReceipt(
          norm,
          txHash,
          timeoutMs ?? config.broadcastWaitSec * 1000,
          config.broadcastIntervalMs
        );
        res.json({ code: 0, message: 'ok', data: { chain: norm, txHash, ...receipt } });
        return;
      }
      res.json({ code: 0, message: 'ok', data: { chain: norm, txHash, confirmed: false, receipt: null, reason: 'wait=false' } });
    } catch (err: any) {
      handleError(res, err, 'broadcast');
    }
  });

  return router;
}

function handleError(res: any, err: any, tag: string): void {
  if (err instanceof ChainRpcError) {
    res.status(err.status).json({ detail: err.message, code: err.code });
    return;
  }
  logger.warn(`[chain-rpc] ${tag} error: ${err?.message || err}`);
  res.status(502).json({ detail: 'upstream rpc error', code: 'upstream_error' });
}
