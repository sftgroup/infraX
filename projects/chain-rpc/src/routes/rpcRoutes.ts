/**
 * chain-rpc 路由：
 *   POST /v1/rpc/:chain          通用 JSON-RPC 读调用（读 key）
 *   GET  /v1/status              池状态（脱敏）
 *   POST /v1/broadcast/:chain    交易广播（广播 key）：EVM eth_sendRawTransaction / Solana sendTransaction + 可选确认轮询
 *
 * 读与广播使用**独立 router**：index.ts 将 /v1/rpc 挂读鉴权、/v1/broadcast 挂
 * 广播鉴权，保证读 key 永远无法触达广播端点。
 *
 * 响应格式（默认）：统一信封 {code, message, data:{chain, method, result}}，供
 * 手写客户端（waas/dc/mcp-server/sdk）解包。请求头 `X-Json-Rpc: raw` 时切换为
 * **标准 JSON-RPC 透传**（{jsonrpc, id, result|error}，batch 同理），使 viem /
 * ethers 等标准客户端可直连网关消费（P3-7 payments 独立服务即走此模式）。
 */
import { Router } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { RpcPoolManager, ChainRpcError } from '../services/rpcPool';
import { normalizeChain } from '../services/rpcPoolConfig';
import { isReadMethod, isBroadcastMethod } from '../services/whitelist';

/** 读 router：POST /rpc/:chain + GET /status */
export function createRpcRouter(pool: RpcPoolManager): Router {
  const router = Router();

  router.post('/:chain', async (req, res) => {
    const body = req.body;
    // 内容协商：显式 header `X-Json-Rpc: raw` **或** 标准 JSON-RPC body（含 jsonrpc:"2.0"）
    // → 标准 JSON-RPC 透传（viem/ethers/http transport 零改动直连）；
    // 信封 body（{method,params}，无 jsonrpc 字段）→ 兼容旧信封格式（waas/dc/mcp-server/sdk）。
    const isJsonRpcBody = (b: any): boolean =>
      (Array.isArray(b) && b.length > 0 && typeof b[0] === 'object' && b[0]?.jsonrpc === '2.0') ||
      (!!b && typeof b === 'object' && !Array.isArray(b) && (b as any).jsonrpc === '2.0');
    const raw = (req.headers['x-json-rpc'] || '').toString().toLowerCase() === 'raw' || isJsonRpcBody(body);
    try {
      const norm = normalizeChain(req.params.chain);
      if (!norm) {
        if (raw) {
          res.status(400).json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32602, message: `unsupported chain: ${req.params.chain}` } });
        } else {
          res.status(400).json({ detail: `unsupported chain: ${req.params.chain}` });
        }
        return;
      }

      // DC-6: JSON-RPC batch（数组请求）——单次 HTTP 完成多条读，降低高频读的请求数
      if (Array.isArray(body)) {
        if (body.length === 0) {
          res.status(400).json(raw ? { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'empty batch' } } : { detail: 'empty batch' });
          return;
        }
        if (body.length > MAX_BATCH_SIZE) {
          res.status(400).json(raw ? { jsonrpc: '2.0', id: null, error: { code: -32600, message: `batch size exceeds ${MAX_BATCH_SIZE}` } } : { detail: `batch size exceeds ${MAX_BATCH_SIZE}` });
          return;
        }
        const results = [];
        // 受限并发执行（避免顺序等待导致 batch 延迟 = 条数×单条延迟；同时控制瞬时上游压力）
        const BATCH_CONCURRENCY = 8;
        for (let i = 0; i < body.length; i += BATCH_CONCURRENCY) {
          const chunk = body.slice(i, i + BATCH_CONCURRENCY);
          results.push(...(await Promise.all(chunk.map((item) => handleBatchItem(pool, norm, item)))));
        }
        res.json(raw
          ? results.map((r) => ({ jsonrpc: '2.0', ...r }))
          : { code: 0, message: 'ok', data: { chain: norm, batch: true, count: results.length, results } });
        return;
      }

      const { method, params } = body || {};
      if (!method || typeof method !== 'string') {
        res.status(400).json(raw ? { jsonrpc: '2.0', id: (body && body.id) ?? null, error: { code: -32600, message: 'method is required' } } : { detail: 'method is required' });
        return;
      }
      if (!isReadMethod(norm, method)) {
        res.status(403).json(raw ? { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: `method ${method} is not allowed on read endpoint` } } : { detail: `method ${method} is not allowed on read endpoint` });
        return;
      }
      const result = await pool.call(norm, method, Array.isArray(params) ? params : []);
      res.json(raw ? { jsonrpc: '2.0', id: body.id ?? null, result } : { code: 0, message: 'ok', data: { chain: norm, method, result } });
    } catch (err: any) {
      handleError(res, err, 'rpc', raw, (req.body && req.body.id) ?? null);
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
    const body = req.body || {};
    // 内容协商同读端点：标准 JSON-RPC body（{jsonrpc,id,method:"eth_sendRawTransaction",params:["0x..."]}）
    // → 标准响应 {jsonrpc,id,result:"0xtxhash"}（viem/ethers 兼容；确认语义走后置 eth_getTransactionReceipt）；
    // 信封 body（{rawTransaction,wait,timeoutMs}）→ 兼容旧广播契约（wait 确认扩展语义保留）。
    const raw = (req.headers['x-json-rpc'] || '').toString().toLowerCase() === 'raw' || body.jsonrpc === '2.0';
    try {
      const norm = normalizeChain(req.params.chain);
      if (!norm) {
        res.status(400).json(raw ? { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32602, message: `unsupported chain: ${req.params.chain}` } } : { detail: `unsupported chain: ${req.params.chain}` });
        return;
      }

      if (raw) {
        if (!isBroadcastMethod(body.method)) {
          res.status(400).json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: `method ${body.method} is not allowed on broadcast endpoint` } });
          return;
        }
        const rawTx = Array.isArray(body.params) ? body.params[0] : undefined;
        if (!rawTx || typeof rawTx !== 'string') {
          res.status(400).json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32602, message: 'rawTransaction (params[0]) is required' } });
          return;
        }
        const txHash = await pool.broadcast(norm, rawTx);
        res.json({ jsonrpc: '2.0', id: body.id ?? null, result: txHash });
        return;
      }

      const { rawTransaction, wait, timeoutMs } = body;
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
      handleError(res, err, 'broadcast', raw, body.id ?? null);
    }
  });

  return router;
}

function handleError(res: any, err: any, tag: string, raw = false, id: unknown = null): void {
  if (err instanceof ChainRpcError) {
    if (raw) {
      res.status(err.status).json({ jsonrpc: '2.0', id, error: { code: err.code, message: err.message } });
    } else {
      res.status(err.status).json({ detail: err.message, code: err.code });
    }
    return;
  }
  // 方法级 JSON-RPC 错误：节点健康，原样透传错误信息。
  // raw（viem/ethers 直连）：HTTP 200 + JSON-RPC error（非 2xx 会被 viem 判为 HttpRequestError，
  //   丢失 revert/nonce 等语义）；信封模式：HTTP 400 + 节点错误消息。
  if (err?.rpcError) {
    if (raw) {
      res.status(200).json({ jsonrpc: '2.0', id, error: { code: err.rpcError.code ?? -32000, message: err.rpcError.message ?? 'rpc error' } });
    } else {
      res.status(400).json({ detail: err.rpcError.message ?? 'rpc error', code: 'rpc_error' });
    }
    return;
  }
  logger.warn(`[chain-rpc] ${tag} error: ${err?.message || err}`);
  if (raw) {
    res.status(502).json({ jsonrpc: '2.0', id, error: { code: 'upstream_error', message: 'upstream rpc error' } });
  } else {
    res.status(502).json({ detail: 'upstream rpc error', code: 'upstream_error' });
  }
}

// ── DC-6: JSON-RPC batch ────────────────────────────────────────────

const MAX_BATCH_SIZE = 100;

/** 单条 batch 项：校验白名单 → 网关调用 → 归一化为 {id, result|error} */
async function handleBatchItem(pool: RpcPoolManager, norm: string, item: any): Promise<any> {
  const method = item?.method;
  const id = item?.id ?? null;
  if (!method || typeof method !== 'string') {
    return { id, error: { code: -32600, message: 'method is required' } };
  }
  if (!isReadMethod(norm, method)) {
    return { id, error: { code: -32601, message: `method ${method} is not allowed on read endpoint` } };
  }
  try {
    const result = await pool.call(norm, method, Array.isArray(item.params) ? item.params : []);
    return { id, result };
  } catch (err: any) {
    return {
      id,
      error: {
        code: err instanceof ChainRpcError ? err.code : 'upstream_error',
        message: err?.message || 'upstream rpc error',
      },
    };
  }
}
