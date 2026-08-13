/**
 * A-11.3: /v1/dex-rpc 路由 — DEX 交易执行 RPC（quote/approve/swap）。
 *
 * 鉴权分级（与 /v1/rpc、/v1/broadcast 同一模式，index.ts 分 router 挂载）：
 *   - dex.quote     读 router（rx_ 读 key）
 *   - dex.approve  广播 router（cr_ 广播 key；构建权高于读权，读 key 无法构造任意链上交易）
 *   - dex.swap      广播 router
 * 安全约束：无 sign 端点；approve/swap 只构建待签名 rawTransaction，不持有私钥；
 * A-11.6：chain 白名单链集校验（dexSupportedChains）+ gasLimit 上限保护（dexBuilder）。
 *
 * 响应信封 {code, message, data}；请求头 X-Json-Rpc: raw 时标准 JSON-RPC 透传。
 */
import { Router } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { RpcPoolManager, ChainRpcError } from '../services/rpcPool';
import { normalizeChain } from '../services/rpcPoolConfig';
import { DexAggregator, DexQuoteParams } from '../services/dexAggregator';
import { buildApproveTx, buildSwapTx } from '../services/dexBuilder';

/** A-11.6: chain 白名单链集校验（approve/swap/quote 统一） */
function assertDexChain(chain: string): void {
  const norm = normalizeChain(chain);
  if (!norm || !config.dexSupportedChains.includes(norm)) {
    throw new ChainRpcError(`chain ${chain} not in dex supported chains (${config.dexSupportedChains.join(',')})`, 'dex_chain_unsupported', 400);
  }
}

/** 读 router：仅 dex.quote（不匹配则 next 交给广播 router / 404） */
export function createDexReadRouter(pool: RpcPoolManager): Router {
  const router = Router();
  router.post('/', async (req, res, next) => {
    const body = req.body || {};
    if (body.method !== 'dex.quote') return next();
    try {
      const p = (body.params || {}) as DexQuoteParams & { tokenIn?: string; tokenOut?: string };
      assertDexChain(p.chain);
      if (!p.tokenIn || !p.tokenOut) {
        throw new ChainRpcError('tokenIn/tokenOut required', 'missing_params', 400);
      }
      if (!p.amountIn || !/^\d+$/.test(String(p.amountIn))) {
        throw new ChainRpcError('amountIn required (wei, digits only)', 'missing_params', 400);
      }
      const aggregator = new DexAggregator();
      const result = await aggregator.quote({
        chain: normalizeChain(p.chain)!,
        tokenIn: p.tokenIn,
        tokenOut: p.tokenOut,
        amountIn: String(p.amountIn),
        slippage: p.slippage,
        from: p.from,
      });
      logger.info('[dex-rpc] quote ok', { chain: result.chain, aggregator: result.aggregator });
      res.json({ code: 0, message: 'ok', data: result });
    } catch (err: any) {
      handleDexError(res, err, 'quote');
    }
  });
  return router;
}

/** 广播 router：仅 dex.approve / dex.swap */
export function createDexBroadcastRouter(pool: RpcPoolManager): Router {
  const router = Router();
  router.post('/', async (req, res, next) => {
    const body = req.body || {};
    const method = body.method;
    if (method !== 'dex.approve' && method !== 'dex.swap') return next();
    try {
      const p = body.params || {};
      assertDexChain(p.chain);
      if (method === 'dex.approve') {
        const tx = await buildApproveTx(pool, normalizeChain(p.chain)!, {
          token: p.token,
          spender: p.spender,
          amount: p.amount,
          from: p.from,
        });
        logger.info('[dex-rpc] approve built', { chain: p.chain, token: p.token, spender: p.spender });
        res.json({ code: 0, message: 'ok', data: { chain: normalizeChain(p.chain), rawTransaction: tx, from: p.from || null } });
        return;
      }
      // dex.swap：聚合器构建 → 未签名 tx
      if (!p.tokenIn || !p.tokenOut) {
        throw new ChainRpcError('tokenIn/tokenOut required', 'missing_params', 400);
      }
      if (!p.amountIn || !/^\d+$/.test(String(p.amountIn))) {
        throw new ChainRpcError('amountIn required (wei, digits only)', 'missing_params', 400);
      }
      const aggregator = new DexAggregator();
      const swap = await aggregator.swap({
        chain: normalizeChain(p.chain)!,
        tokenIn: p.tokenIn,
        tokenOut: p.tokenOut,
        amountIn: String(p.amountIn),
        slippage: p.slippage,
        from: p.from,
        recipient: p.recipient,
        gasLimit: p.gasLimit,
      });
      const tx = await buildSwapTx(pool, normalizeChain(p.chain)!, swap.tx, { from: p.from });
      logger.info('[dex-rpc] swap built', { chain: swap.chain, aggregator: swap.aggregator });
      res.json({
        code: 0,
        message: 'ok',
        data: { chain: swap.chain, rawTransaction: tx, aggregator: swap.aggregator, amountOutMin: swap.amountOutMin },
      });
    } catch (err: any) {
      handleDexError(res, err, 'broadcast');
    }
  });
  return router;
}

function handleDexError(res: any, err: any, tag: string): void {
  if (err instanceof ChainRpcError) {
    res.status(err.status).json({ detail: err.message, code: err.code });
    return;
  }
  logger.warn(`[dex-rpc] ${tag} error: ${err?.message || err}`);
  res.status(502).json({ detail: 'upstream error', code: 'dex_upstream_error' });
}
