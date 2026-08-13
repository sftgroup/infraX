/**
 * A-11.1: DEX 聚合器客户端（dex.quote / dex.swap 上游）。
 *
 * 选型（AASDK4_A11_TECH_DESIGN §2.3）：
 *   - OKX OnchainOS DEX Aggregator V6 首选（web3.okx.com，500+ 源；需 OK-ACCESS 签名鉴权）
 *   - 1inch 回退（需 DEX_API_KEY）
 * 安全：fail-closed——聚合器不可用/超时/未配置凭证 → 5xx，不静默给错报价；
 * 本服务仅做服务端代理，OKX 凭证/1inch key 不下发调用方。
 */
import axios from 'axios';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../logger';
import { ChainRpcError } from './rpcPool';
import { CHAIN_IDS, normalizeChain } from './rpcPoolConfig';

/** 聚合器原生币地址约定（OKX/1inch 通用） */
export const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export interface DexQuoteParams {
  chain: string;        // 链别名（base/bsc/arbitrum/polygon/ethereum/xlayer…，normalize 后）
  tokenIn: string;      // 0x 地址；原生币可传 '' → NATIVE_TOKEN
  tokenOut: string;
  amountIn: string;     // wei 字符串
  slippage?: number;    // 0.005 = 0.5%
  from?: string;        // 调用方地址（可选，部分聚合器需要）
  recipient?: string;   // 收款地址（可选）
  gasLimit?: string;    // 覆盖聚合器返回的 gasLimit（EVM，可选；E2E 发现 OKX RFQ 路径估算偏低易 OOG）
}

export interface DexTx {
  to: string;
  data: string;
  value: string;        // wei 字符串
  chainId: number;
  gasLimit?: string;    // 预估（hex 或 dec 字符串，构建时可选）
}

export interface DexQuoteResult {
  chain: string;
  aggregator: 'okx' | '1inch';
  amountOut: string;      // wei
  minAmountOut: string;   // wei（含 slippage 折减）
  priceImpact?: string;
  fee?: string;
  route?: unknown;
}

export interface DexSwapResult {
  chain: string;
  aggregator: 'okx' | '1inch';
  amountOutMin: string;   // wei（含 slippage 折减）
  quoteId?: string;
  tx: DexTx;
}

const REQUEST_TIMEOUT = 8_000;

function okxBase(): string {
  return (config.dexAggregatorUrl || 'https://www.okx.com').replace(/\/+$/, '');
}

/** 链别名 → 聚合器 chainId；未知链抛错（A-11.6 白名单链集在路由层先校验） */
export function dexChainId(chain: string): number {
  const norm = normalizeChain(chain);
  const id = norm ? CHAIN_IDS[norm] : undefined;
  if (!id) throw new ChainRpcError(`Unsupported chain for dex: ${chain}`, 'unsupported_chain', 400);
  return id;
}

/** tokenIn 空 → 原生币地址 */
function t(address: string | undefined): string {
  return address && address !== '' ? address : NATIVE_TOKEN;
}

function minOut(amountOut: string, slippage: number): bigint {
  const out = BigInt(amountOut || '0');
  const slip = BigInt(Math.round((slippage || 0) * 10_000));
  return out - (out * slip) / 10_000n;
}

// ─── OKX OnchainOS DEX Aggregator V6 ─────────────────────────────────

interface OkxQuoteData {
  toTokenAmount?: string;
  quoteId?: string;
  priceImpactPercent?: string;
  estimateGasFee?: string;
  dexRouterList?: unknown;
  tx?: OkxSwapTx;
}

interface OkxSwapTx {
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
  minReceiveAmount?: string;
}

/** OKX 凭证（单组或池成员） */
interface OkxCred {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

/**
 * OKX 凭证池：优先 OKX_DEX_KEYS_JSON 多账号，未配置回退 okxDex 单组。
 * 轮询（round-robin）+ failover（凭证级错误 401/403 → 下一组）。
 */
function okxCreds(): OkxCred[] {
  if (config.okxDexKeys.length > 0) return config.okxDexKeys;
  const single = config.okxDex;
  return single.apiKey && single.apiSecret && single.apiPassphrase ? [single] : [];
}

let credCursor = 0;

/** OKX V6 请求签名头（prehash = timestamp + METHOD + requestPath，HMAC-SHA256 → Base64） */
function okxSign(method: 'GET' | 'POST', requestPath: string, cred: OkxCred, body?: string): Record<string, string> {
  const ts = new Date().toISOString();
  const prehash = ts + method + requestPath + (body || '');
  const sign = crypto.createHmac('sha256', cred.apiSecret).update(prehash).digest('base64');
  return {
    'OK-ACCESS-KEY': cred.apiKey,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': cred.apiPassphrase,
    'Content-Type': 'application/json',
  };
}

/** 凭证缺失 → fail-closed（避免裸 401 泄漏） */
function assertOkxCreds(): void {
  if (okxCreds().length === 0) {
    throw new ChainRpcError('OKX DEX credentials not configured (OKX_DEX_KEYS_JSON or OKX_DEX_API_KEY/SECRET/PASSPHRASE or OKX_CHAINOS_*)', 'dex_config_missing', 503);
  }
}

/** 凭证级错误（鉴权失败）→ 换下一组重试；其余错误（上游/网络）直接抛出，不走凭证轮询 */
function isCredError(err: any): boolean {
  const status = err?.response?.status as number | undefined;
  return status === 401 || status === 403;
}

/** 池内轮询：对每个凭证尝试一次（round-robin 起点），凭证级错误换下一组 */
async function withCredRolling<T>(fn: (cred: OkxCred) => Promise<T>): Promise<T> {
  const creds = okxCreds();
  if (creds.length === 0) {
    throw new ChainRpcError('OKX DEX credentials not configured', 'dex_config_missing', 503);
  }
  const start = credCursor % creds.length;
  let lastErr: any = null;
  for (let i = 0; i < creds.length; i++) {
    const idx = (start + i) % creds.length;
    try {
      credCursor = (idx + 1) % creds.length; // 成功后起点前进（round-robin）
      // 打码日志：验证凭证池轮询（key 前缀 only，不下发完整凭证）
      logger.info(`[dex-rpc] okx cred[${idx}] key=${creds[idx].apiKey.slice(0, 8)}… (pool=${creds.length})`);
      return await fn(creds[idx]);
    } catch (err: any) {
      if (!isCredError(err)) throw err; // 非凭证错误不轮询
      lastErr = err;
    }
  }
  throw new ChainRpcError(`OKX DEX auth failed for all credentials: ${lastErr?.message || lastErr}`, 'dex_auth_failed', 502);
}

async function okxQuote(params: DexQuoteParams): Promise<DexQuoteResult> {
  assertOkxCreds();
  const t0 = Date.now();
  const tokenIn = t(params.tokenIn);
  const tokenOut = t(params.tokenOut);
  logger.info('[dex-rpc] okx.quote start', { chain: params.chain, tokenIn, tokenOut, amountIn: params.amountIn });
  const qs = new URLSearchParams({
    chainIndex: String(dexChainId(params.chain)),
    fromTokenAddress: tokenIn,
    toTokenAddress: tokenOut,
    amount: params.amountIn,
  });
  const requestPath = `/api/v6/dex/aggregator/quote?${qs.toString()}`;
  return withCredRolling(async (cred) => {
    try {
      const resp = await axios.get(`${okxBase()}${requestPath}`, {
        timeout: REQUEST_TIMEOUT,
        headers: okxSign('GET', requestPath, cred),
      });
      const data = resp.data?.data?.[0] as OkxQuoteData | undefined;
      if (!data?.toTokenAmount) {
        throw new ChainRpcError(`OKX DEX quote failed: ${resp.data?.msg || 'empty result'}`, 'dex_quote_failed', 502);
      }
      logger.info('[dex-rpc] okx.quote ok', {
        chain: params.chain,
        amountOut: data.toTokenAmount,
        quoteId: data.quoteId,
        priceImpact: data.priceImpactPercent,
        ms: Date.now() - t0,
      });
      return {
        chain: params.chain,
        aggregator: 'okx',
        amountOut: data.toTokenAmount,
        minAmountOut: minOut(data.toTokenAmount, params.slippage ?? 0.005).toString(),
        priceImpact: data.priceImpactPercent,
        fee: data.estimateGasFee,
        route: data.dexRouterList,
      };
    } catch (err: any) {
      logger.warn(`[dex-rpc] okx.quote error: ${err?.message || err}`, { chain: params.chain, ms: Date.now() - t0 });
      throw err;
    }
  });
}

async function okxSwap(params: DexQuoteParams): Promise<DexSwapResult> {
  assertOkxCreds();
  const chainId = dexChainId(params.chain);
  const t0 = Date.now();
  const tokenIn = t(params.tokenIn);
  const tokenOut = t(params.tokenOut);
  logger.info('[dex-rpc] okx.swap start', {
    chain: params.chain,
    tokenIn,
    tokenOut,
    amountIn: params.amountIn,
    from: params.from,
    gasLimit: params.gasLimit,
  });
  return withCredRolling(async (cred) => {
    try {
      // 先 quote 拿 quoteId（OKX swap 依赖 quoteId + slippagePercent + 钱包地址）
      const qs = new URLSearchParams({
        chainIndex: String(chainId),
        fromTokenAddress: tokenIn,
        toTokenAddress: tokenOut,
        amount: params.amountIn,
      });
      const qPath = `/api/v6/dex/aggregator/quote?${qs.toString()}`;
      const qResp = await axios.get(`${okxBase()}${qPath}`, {
        timeout: REQUEST_TIMEOUT,
        headers: okxSign('GET', qPath, cred),
      });
      const quote = qResp.data?.data?.[0] as OkxQuoteData | undefined;
      const quoteId = quote?.quoteId;
      const amountOut = quote?.toTokenAmount;
      if (!quoteId || !amountOut) {
        throw new ChainRpcError('OKX DEX quote (for swap) failed', 'dex_quote_failed', 502);
      }
      logger.info('[dex-rpc] okx.swap quote stage ok', { quoteId, amountOut, ms: Date.now() - t0 });
      const sQs = new URLSearchParams({
        chainIndex: String(chainId),
        amount: params.amountIn,
        quoteId,
        slippagePercent: String(Math.round((params.slippage ?? 0.005) * 10000) / 100),
        fromTokenAddress: tokenIn,
        toTokenAddress: tokenOut,
        userWalletAddress: params.from || '0x0000000000000000000000000000000000000001',
        receiver: params.recipient || params.from || '0x0000000000000000000000000000000000000001',
      });
      // 调用方显式覆盖 gasLimit（防 OKX RFQ 路径估算偏低导致 OOG）
      if (params.gasLimit && /^\d+$/.test(String(params.gasLimit))) sQs.set('gasLimit', String(params.gasLimit));
      const sPath = `/api/v6/dex/aggregator/swap?${sQs.toString()}`;
      const sResp = await axios.get(`${okxBase()}${sPath}`, {
        timeout: REQUEST_TIMEOUT,
        headers: okxSign('GET', sPath, cred),
      });
      const data = sResp.data?.data?.[0] as OkxQuoteData | undefined;
      const tx = data?.tx;
      if (!tx?.to || !tx.data) {
        throw new ChainRpcError(`OKX DEX swap build failed: ${sResp.data?.msg || 'empty tx'}`, 'dex_swap_failed', 502);
      }
      logger.info('[dex-rpc] okx.swap ok', {
        quoteId,
        amountOutMin: tx.minReceiveAmount,
        txTo: tx.to,
        txGas: tx.gas,
        txValue: tx.value,
        dataLen: tx.data.length,
        ms: Date.now() - t0,
      });
      return {
        chain: params.chain,
        aggregator: 'okx',
        amountOutMin: tx.minReceiveAmount || minOut(amountOut, params.slippage ?? 0.005).toString(),
        quoteId,
        tx: { to: tx.to, data: tx.data, value: tx.value || '0', chainId, gasLimit: tx.gas },
      };
    } catch (err: any) {
      logger.warn(`[dex-rpc] okx.swap error: ${err?.message || err}`, { chain: params.chain, ms: Date.now() - t0 });
      throw err;
    }
  });
}

// ─── 1inch（回退）────────────────────────────────────────────────────

function inchBase(): string {
  return 'https://api.1inch.dev';
}

/** 1inch 可用性：其 API 强制 Bearer key，未配置 DEX_API_KEY 则不可回退 */
async function inchAvailable(): Promise<boolean> {
  return Boolean(config.dexApiKey);
}

async function inchQuote(params: DexQuoteParams): Promise<DexQuoteResult> {
  const chainId = dexChainId(params.chain);
  const t0 = Date.now();
  const qs = new URLSearchParams({
    src: t(params.tokenIn),
    dst: t(params.tokenOut),
    amount: params.amountIn,
  });
  const resp = await axios.get(`${inchBase()}/swap/v6.0/${chainId}/quote`, {
    params: qs,
    timeout: REQUEST_TIMEOUT,
    headers: { Authorization: `Bearer ${config.dexApiKey}` },
  });
  const dstAmount = resp.data?.dstAmount as string | undefined;
  if (!dstAmount) {
    throw new ChainRpcError('1inch quote failed: empty result', 'dex_quote_failed', 502);
  }
  logger.info('[dex-rpc] 1inch.quote ok', { chain: params.chain, amountOut: dstAmount, ms: Date.now() - t0 });
  return {
    chain: params.chain,
    aggregator: '1inch',
    amountOut: dstAmount,
    minAmountOut: minOut(dstAmount, params.slippage ?? 0.005).toString(),
    fee: resp.data?.estimatedGas ? String(resp.data.estimatedGas) : undefined,
  };
}

async function inchSwap(params: DexQuoteParams): Promise<DexSwapResult> {
  const chainId = dexChainId(params.chain);
  const t0 = Date.now();
  const qs = new URLSearchParams({
    src: t(params.tokenIn),
    dst: t(params.tokenOut),
    amount: params.amountIn,
    from: params.from || '0x0000000000000000000000000000000000000001',
    slippage: String(params.slippage ?? 0.005),
  });
  if (params.recipient) qs.set('receiver', params.recipient);
  const resp = await axios.get(`${inchBase()}/swap/v6.0/${chainId}/swap`, {
    params: qs,
    timeout: REQUEST_TIMEOUT,
    headers: { Authorization: `Bearer ${config.dexApiKey}` },
  });
  const tx = resp.data?.tx as { from?: string; to?: string; data?: string; value?: string; gas?: string } | undefined;
  if (!tx?.to || !tx.data) {
    throw new ChainRpcError('1inch swap build failed: empty tx', 'dex_swap_failed', 502);
  }
  logger.info('[dex-rpc] 1inch.swap ok', {
    chain: params.chain,
    txTo: tx.to,
    txGas: tx.gas,
    dataLen: tx.data.length,
    ms: Date.now() - t0,
  });
  return {
    chain: params.chain,
    aggregator: '1inch',
    amountOutMin: minOut(resp.data?.dstAmount || '0', params.slippage ?? 0.005).toString(),
    tx: { to: tx.to, data: tx.data, value: tx.value || '0', chainId, gasLimit: tx.gas },
  };
}

// ─── 统一入口（OKX 首选 → 1inch 回退 → fail-closed 503） ────────────

export class DexAggregator {
  async quote(params: DexQuoteParams): Promise<DexQuoteResult> {
    try {
      return await okxQuote(params);
    } catch (err: any) {
      if (err instanceof ChainRpcError && err.status === 400) throw err; // 链不支持，不回退
      if (!(await inchAvailable())) {
        throw new ChainRpcError(`DEX aggregator unavailable: ${err?.message || err}`, 'dex_aggregator_unavailable', 503);
      }
      try {
        return await inchQuote(params);
      } catch (fallbackErr: any) {
        throw new ChainRpcError(
          `DEX aggregator unavailable (okx: ${err?.message}, 1inch: ${fallbackErr?.message || fallbackErr})`,
          'dex_aggregator_unavailable',
          503,
        );
      }
    }
  }

  async swap(params: DexQuoteParams): Promise<DexSwapResult> {
    try {
      return await okxSwap(params);
    } catch (err: any) {
      if (err instanceof ChainRpcError && err.status === 400) throw err;
      if (!(await inchAvailable())) {
        throw new ChainRpcError(`DEX aggregator unavailable: ${err?.message || err}`, 'dex_aggregator_unavailable', 503);
      }
      try {
        return await inchSwap(params);
      } catch (fallbackErr: any) {
        throw new ChainRpcError(
          `DEX aggregator unavailable (okx: ${err?.message}, 1inch: ${fallbackErr?.message || fallbackErr})`,
          'dex_aggregator_unavailable',
          503,
        );
      }
    }
  }
}
