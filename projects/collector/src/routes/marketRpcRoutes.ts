/**
 * A-12: /v1/market-rpc — 行情数据 RPC（与 chain-rpc /v1/rpc/:chain 并列的网关层入口）。
 *
 * 12 组方法 + 多 token 批量 + 信封 {code,message,data}；鉴权沿用 rx_ 读 key
 * （连接 chain-rpc 库 rpc_keys 表 SHA-256 校验），兼容 collector 既有 pkx_ api_keys。
 * A-13 同源同缓存：直接复用 getMarketClient() 单例（与 REST MarketAPI 同一 client，口径一致）。
 *
 * 方法（method 直发，params 驼峰）：
 *   tokenSearch / tokenInfo / hotTokens / leaderboard / signals / mempump
 *   candles / price / balances / transactions / trackedTokens / customSigs
 * token 维度方法（tokenInfo/price/candles）支持多 token 批量：params.tokens = [addr,...]
 * （单 token 用 tokenAddress；批量时返回 [{tokenAddress, data}, ...] 保序）。
 */
import { Router } from 'express';
import crypto from 'crypto';
import { Pool } from 'pg';
import { asyncHandler, apiResponse } from '../helpers';
import { config } from '../config';
import { pool } from '../database';
import { getMarketClient } from '../services/okxMarketV6';
import { apiKeyAuth } from '../middleware/apiKeyAuth';

const router = Router();
const m = () => getMarketClient();

// ── rx_ 读 key 校验（连接 chain-rpc 库 rpc_keys；SHA-256 哈希，与 chain-rpc 同算法） ──
const rpcPool = new Pool({
  connectionString: config.chainRpcDatabaseUrl,
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
rpcPool.on('error', () => {});

function extractApiKey(req: any): string {
  const auth = (req.headers['authorization'] || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (req.headers['x-api-key'] || req.headers['x-rpc-key'] || '').trim();
}

/** rx_ 读 key 校验（rpc_keys 表 SHA-256）；有效且启用 → true */
export async function verifyRxKey(key: string): Promise<boolean> {
  if (!key.startsWith('rx_')) return false;
  try {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const r = await rpcPool.query(
      'SELECT id, rpc_plan_id, rpc_sub_status, enabled FROM rpc_keys WHERE key_hash = $1 LIMIT 1',
      [hash]
    );
    const row = r.rows[0];
    return !!row && row.enabled !== false && row.rpc_sub_status !== 'pending';
  } catch {
    return false;
  }
}

/** 鉴权：rx_ → rpc_keys（chain-rpc 库）；其余回退 collector api_keys（pkx_）；
 *  匿名（无 key）→ 放行并标记 req.anon=true，由 handler 的 x402 门控决定
 *  收费方法 402 / 非收费方法 401（A-12 x402 门控） */
export async function marketRpcAuth(req: any, res: any, next: any): Promise<void> {
  const key = extractApiKey(req);
  if (!key) { req.anon = true; return next(); }
  if (key.startsWith('rx_')) {
    if (await verifyRxKey(key)) {
      req.apiKey = { id: 0, label: `rx_${key.slice(2, 10)}`, marketPlanId: null, source: 'rpc' };
      return next();
    }
    res.status(401).json({ code: -1, message: 'Invalid or inactive RPC key' }); return;
  }
  // 非 rx_：兼容 collector 自身 api_keys（pkx_）
  req.headers['x-api-key'] = key;
  return apiKeyAuth(req, res, next);
}

function bad(res: any, message: string): void {
  res.status(400).json(apiResponse(null, message, -1));
}

/** token 维度批量入参解析：tokens 数组优先，其次单 tokenAddress；均无 → null */
function tokenList(p: any): string[] | null {
  if (Array.isArray(p.tokens) && p.tokens.length > 0) return p.tokens.map(String);
  if (p.tokenAddress) return [String(p.tokenAddress)];
  return null;
}

/** token 维度统一执行：批量（tokens 数组，多元素）→ 保序 [{tokenAddress,data}]；单 → 直接结果 */
async function runTokenOp<T>(p: any, fn: (token: string) => Promise<T>): Promise<T | Array<{ tokenAddress: string; data: T }>> {
  const tokens = tokenList(p)!;
  if (Array.isArray(p.tokens) && p.tokens.length > 1) {
    const results = await Promise.all(tokens.map(async (tokenAddress) => ({ tokenAddress, data: await fn(tokenAddress) })));
    return results;
  }
  return fn(tokens[0]);
}

function parseLimit(v: any, def: number): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : def;
}

function parseChains(v: any): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return undefined;
}

// ================================================================
// A-12 x402 门控：4 个收费方法（tokenSearch/tokenInfo/price/candles）
// 匿名调用（无有效 rx_/pkx_ key）→ HTTP 402 + x402 清单；
// 已持有效 key → 配额内放行；已付凭据回放（X-Payment-Order-Id）→ 放行。
// 费率 USD/次；token 维度方法按批量 token 数倍增。
// ================================================================
const X402_PAID_METHODS: Record<string, number> = {
  tokenSearch: 0.002,
  tokenInfo: 0.001,
  price: 0.0005,
  candles: 0.001,
};
const X402_PAY_CHAIN = process.env.X402_PAY_CHAIN || 'sepolia';
const X402_PAY_TOKEN = process.env.X402_PAY_TOKEN || 'ETH';
const X402_REQUEST_URL = process.env.X402_REQUEST_URL || '/api/v2/payment/x402/request';
const X402_VERIFY_URL = process.env.X402_VERIFY_URL || '/api/v2/payment/x402/verify';

/** 返回 true = 已响应（调用方应 return），false = 放行继续处理 */
function x402Gate(req: any, res: any, method: string, params: any): boolean {
  if (!req.anon) return false; // 已持有效 key（rx_/pkx_）→ 配额内放行
  const unit = X402_PAID_METHODS[method];
  if (unit === undefined) {
    // 非收费方法匿名调用 → 保持原 401 语义
    res.status(401).json({ code: -1, message: 'Missing API key' });
    return true;
  }
  // 已付凭据回放（X-Payment-Order-Id，由 payment /x402/verify 响应返回；
  // 正式版应内联校验 payment_orders 订单状态，此处乐观放行）
  if (req.headers['x-payment-order-id']) return false;
  const count = tokenList(params)?.length || 1;
  const amount = unit * count;
  const resource = `market-rpc:${method}`;
  res.status(402).set({
    'X-PAYMENT-REQUIRED': 'true',
    'X-PAYMENT-PROTOCOL': 'x402',
    'X-PAYMENT-NETWORK': X402_PAY_CHAIN,
    'X-PAYMENT-TOKEN': X402_PAY_TOKEN,
    'X-PAYMENT-AMOUNT': amount.toFixed(6),
    'X-PAYMENT-RESOURCE': resource,
    'X-PAYMENT-REQUEST-URL': X402_REQUEST_URL,
    'X-PAYMENT-VERIFY-URL': X402_VERIFY_URL,
    'Access-Control-Expose-Headers': 'X-PAYMENT-REQUIRED, X-PAYMENT-PROTOCOL, X-PAYMENT-NETWORK, X-PAYMENT-TOKEN, X-PAYMENT-AMOUNT, X-PAYMENT-RESOURCE, X-PAYMENT-REQUEST-URL, X-PAYMENT-VERIFY-URL',
  }).json(apiResponse({
    protocol: 'x402',
    method,
    resource,
    amount,
    currency: 'USD',
    network: X402_PAY_CHAIN,
    token: X402_PAY_TOKEN,
    requestUrl: X402_REQUEST_URL,
    verifyUrl: X402_VERIFY_URL,
    retryHeader: 'X-Payment-Order-Id',
  }, 'x402 payment required', 402));
  return true;
}

// ================================================================
// POST /v1/market-rpc — method 分发
// ================================================================
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const method = body.method;
  const p = body.params || {};
  // A-12 x402 门控：收费方法匿名调用 → 402；非收费方法匿名 → 401
  if (x402Gate(req, res, method, p)) return;
  let data: any;
  try {
    switch (method) {
      case 'tokenSearch': {
        if (!p.keyword) return bad(res, 'keyword required');
        data = await m().searchToken(String(p.keyword), p.chainIndex ? String(p.chainIndex) : undefined, parseLimit(p.limit, 20));
        break;
      }
      case 'tokenInfo': {
        if (!p.chainIndex) return bad(res, 'chainIndex required');
        if (!tokenList(p)) return bad(res, 'tokenAddress or tokens required');
        const chainIndex = String(p.chainIndex);
        data = await runTokenOp(p, (t) => m().getTokenBasicInfo(chainIndex, t));
        break;
      }
      case 'hotTokens': {
        if (!p.chainIndex) return bad(res, 'chainIndex required');
        const { limit, chainIndex, ...rest } = p;
        const opts: Record<string, string> = {};
        for (const [k, v] of Object.entries(rest)) {
          if (v !== undefined && v !== '') opts[k] = String(v);
        }
        data = await m().getHotTokens(String(chainIndex), parseLimit(limit, 50), Object.keys(opts).length > 0 ? opts : undefined);
        break;
      }
      case 'leaderboard': {
        if (!p.chainIndex) return bad(res, 'chainIndex required');
        // 上游必填 sortBy（int）+ timeFrame（int）；默认 1=pnl / 4=24h
        const sortBy = parseInt(p.sortBy ?? '1', 10);
        const timeFrame = parseInt(p.timeFrame ?? '4', 10);
        if (!Number.isFinite(sortBy) || !Number.isFinite(timeFrame)) return bad(res, 'sortBy/timeFrame must be integers');
        data = await m().getLeaderboard(String(p.chainIndex), 'pnl', parseLimit(p.limit, 50), sortBy, timeFrame);
        break;
      }
      case 'signals': {
        if (!p.chainIndex) return bad(res, 'chainIndex required');
        const walletType = p.walletType ? String(p.walletType) : undefined;
        const minAmountUsd = p.minAmountUsd !== undefined ? parseFloat(p.minAmountUsd) : undefined;
        data = await m().getSignalList(String(p.chainIndex), p.signalType ? String(p.signalType) : undefined, parseLimit(p.limit, 50), walletType, minAmountUsd);
        break;
      }
      case 'mempump': {
        if (!p.chainIndex) return bad(res, 'chainIndex required');
        // 上游 stage 必填：NEW / MIGRATING / MIGRATED；链支持 Solana(501)/BNB(56)/Robinhood(4663) 等，ETH(1) 不支持
        const stage = p.stage ? String(p.stage).toUpperCase() : undefined;
        if (!stage || !['NEW', 'MIGRATING', 'MIGRATED'].includes(stage)) return bad(res, 'stage required: NEW | MIGRATING | MIGRATED');
        data = await m().getMemePumpTokenList(String(p.chainIndex), p.protocol ? String(p.protocol) : undefined, p.sortBy ? String(p.sortBy) : 'volume24h', parseLimit(p.limit, 50), stage);
        break;
      }
      case 'candles': {
        if (!p.chainIndex) return bad(res, 'chainIndex required');
        if (!tokenList(p)) return bad(res, 'tokenAddress or tokens required');
        const chainIndex = String(p.chainIndex);
        const period = p.period ? String(p.period) : '15m';
        const limit = parseLimit(p.limit, 100);
        data = await runTokenOp(p, (t) => m().getCandles(chainIndex, t, period, limit));
        break;
      }
      case 'price': {
        if (!p.chainIndex) return bad(res, 'chainIndex required');
        if (!tokenList(p)) return bad(res, 'tokenAddress or tokens required');
        const chainIndex = String(p.chainIndex);
        data = await runTokenOp(p, (t) => m().getPrice(chainIndex, t));
        break;
      }
      case 'balances': {
        if (!p.address) return bad(res, 'address required');
        // 上游 chains 必填（数组或逗号分隔，如 "1,56,8453"）
        const chains = parseChains(p.chains);
        if (!chains || chains.length === 0) return bad(res, 'chains required (array or comma-separated chainIndex)');
        data = await m().getAllBalances(String(p.address), chains);
        break;
      }
      case 'transactions': {
        if (!p.address) return bad(res, 'address required');
        const chains = parseChains(p.chains);
        if (!chains || chains.length === 0) return bad(res, 'chains required (array or comma-separated chainIndex)');
        data = await m().getTransactions(String(p.address), chains, parseLimit(p.limit, 50));
        break;
      }
      case 'trackedTokens': {
        const result = await pool.query(
          `SELECT id, chain, token_address, token_symbol, token_name, label, enabled, created_at
           FROM tracked_tokens WHERE 1=1${p.chain ? ' AND chain = $1' : ''}${p.enabled !== undefined ? `${p.chain ? ' AND' : ''} enabled = $2` : ''}
           ORDER BY created_at DESC`,
          (() => { const a: any[] = []; if (p.chain) a.push(p.chain); if (p.enabled !== undefined) a.push(p.enabled === true || p.enabled === 'true'); return a; })()
        );
        data = result.rows;
        break;
      }
      case 'customSigs': {
        const result = await pool.query(
          `SELECT id, chain, topic_hash, event_type, event_name, abi, enabled, created_at
           FROM custom_event_sigs WHERE 1=1${p.chain ? ' AND chain = $1' : ''}${p.enabled !== undefined ? `${p.chain ? ' AND' : ''} enabled = $2` : ''}
           ORDER BY created_at DESC`,
          (() => { const a: any[] = []; if (p.chain) a.push(p.chain); if (p.enabled !== undefined) a.push(p.enabled === true || p.enabled === 'true'); return a; })()
        );
        data = result.rows;
        break;
      }
      default:
        res.status(404).json(apiResponse(null, `unknown method: ${method || '(empty)'}`, -1));
        return;
    }
    res.json(apiResponse(data));
  } catch (e: any) {
    // x402 支付门控（HTTP 402）：显式返回 402 + 上游 x402 清单（含 network/amount/payTo），
    // 调用方决定是否接入 x402 支付；不吞成 502
    if (e?.x402 || e?.status === 402 || (typeof e?.message === 'string' && e.message.startsWith('OKX Market 402'))) {
      res.status(402).json(apiResponse(null, `x402 payment required: ${e?.message || ''}`, 402));
      return;
    }
    res.status(502).json(apiResponse(null, e?.message || 'upstream error', -1));
  }
}));

export default router;
