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

/** OKX V6 请求签名头（prehash = timestamp + METHOD + requestPath，HMAC-SHA256 → Base64） */
function okxSign(method: 'GET' | 'POST', requestPath: string, body?: string): Record<string, string> {
  const ts = new Date().toISOString();
  const prehash = ts + method + requestPath + (body || '');
  const sign = crypto.createHmac('sha256', config.okxDex.apiSecret).update(prehash).digest('base64');
  return {
    'OK-ACCESS-KEY': config.okxDex.apiKey,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': config.okxDex.apiPassphrase,
    'Content-Type': 'application/json',
  };
}

/** 凭证缺失 → fail-closed（避免裸 401 泄漏） */
function assertOkxCreds(): void {
  if (!config.okxDex.apiKey || !config.okxDex.apiSecret || !config.okxDex.apiPassphrase) {
    throw new ChainRpcError('OKX DEX credentials not configured (OKX_DEX_API_KEY/SECRET/PASSPHRASE or OKX_CHAINOS_*)', 'dex_config_missing', 503);
  }
}

async function okxQuote(params: DexQuoteParams): Promise<DexQuoteResult> {
  assertOkxCreds();
  const qs = new URLSearchParams({
    chainIndex: String(dexChainId(params.chain)),
    fromTokenAddress: t(params.tokenIn),
    toTokenAddress: t(params.tokenOut),
    amount: params.amountIn,
  });
  const requestPath = `/api/v6/dex/aggregator/quote?${qs.toString()}`;
  const resp = await axios.get(`${okxBase()}${requestPath}`, {
    timeout: REQUEST_TIMEOUT,
    headers: okxSign('GET', requestPath),
  });
  const data = resp.data?.data?.[0] as OkxQuoteData | undefined;
  if (!data?.toTokenAmount) {
    throw new ChainRpcError(`OKX DEX quote failed: ${resp.data?.msg || 'empty result'}`, 'dex_quote_failed', 502);
  }
  return {
    chain: params.chain,
    aggregator: 'okx',
    amountOut: data.toTokenAmount,
    minAmountOut: minOut(data.toTokenAmount, params.slippage ?? 0.005).toString(),
    priceImpact: data.priceImpactPercent,
    fee: data.estimateGasFee,
    route: data.dexRouterList,
  };
}

async function okxSwap(params: DexQuoteParams): Promise<DexSwapResult> {
  assertOkxCreds();
  const chainId = dexChainId(params.chain);
  // 先 quote 拿 quoteId（OKX swap 依赖 quoteId + slippagePercent + 钱包地址）
  const qs = new URLSearchParams({
    chainIndex: String(chainId),
    fromTokenAddress: t(params.tokenIn),
    toTokenAddress: t(params.tokenOut),
    amount: params.amountIn,
  });
  const qPath = `/api/v6/dex/aggregator/quote?${qs.toString()}`;
  const qResp = await axios.get(`${okxBase()}${qPath}`, {
    timeout: REQUEST_TIMEOUT,
    headers: okxSign('GET', qPath),
  });
  const quote = qResp.data?.data?.[0] as OkxQuoteData | undefined;
  const quoteId = quote?.quoteId;
  const amountOut = quote?.toTokenAmount;
  if (!quoteId || !amountOut) {
    throw new ChainRpcError('OKX DEX quote (for swap) failed', 'dex_quote_failed', 502);
  }
  const sQs = new URLSearchParams({
    chainIndex: String(chainId),
    amount: params.amountIn,
    quoteId,
    slippagePercent: String(Math.round((params.slippage ?? 0.005) * 10000) / 100),
    fromTokenAddress: t(params.tokenIn),
    toTokenAddress: t(params.tokenOut),
    userWalletAddress: params.from || '0x0000000000000000000000000000000000000001',
    receiver: params.recipient || params.from || '0x0000000000000000000000000000000000000001',
  });
  const sPath = `/api/v6/dex/aggregator/swap?${sQs.toString()}`;
  const sResp = await axios.get(`${okxBase()}${sPath}`, {
    timeout: REQUEST_TIMEOUT,
    headers: okxSign('GET', sPath),
  });
  const data = sResp.data?.data?.[0] as OkxQuoteData | undefined;
  const tx = data?.tx;
  if (!tx?.to || !tx.data) {
    throw new ChainRpcError(`OKX DEX swap build failed: ${sResp.data?.msg || 'empty tx'}`, 'dex_swap_failed', 502);
  }
  return {
    chain: params.chain,
    aggregator: 'okx',
    amountOutMin: tx.minReceiveAmount || minOut(amountOut, params.slippage ?? 0.005).toString(),
    quoteId,
    tx: { to: tx.to, data: tx.data, value: tx.value || '0', chainId, gasLimit: tx.gas },
  };
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
