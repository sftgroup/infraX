/* eslint-disable no-console */
// 临时验证脚本：DEX 数据层端到端（DexScreener 免 key + OKX v6）
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
import * as dex from '../src/services/dexScreener';
import { getMarketClient } from '../src/services/okxMarketV6';

async function main() {
  // 1) DexScreener profiles/boosts（真实请求）
  console.log('=== DexScreener getHotTokens(ETH) ===');
  const t0 = Date.now();
  const profiles = await dex.getHotTokens('ETH', 3);
  console.log(`count=${profiles.length} ms=${Date.now() - t0}`, profiles.slice(0, 2));

  console.log('\n=== DexScreener getTokensDetail(base) ===');
  const t1 = Date.now();
  const d = await dex.getTokensDetail('base', ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']); // USDC on Base
  console.log(`ms=${Date.now() - t1}`, JSON.stringify(d[0] ? {
    chain: d[0].chain, symbol: d[0].symbol, price: d[0].priceUsd,
    volume24h: d[0].volume24h, liquidity: d[0].liquidity, poolCount: d[0].poolCount,
    poolCreatedAt: d[0].poolCreatedAt ? new Date(d[0].poolCreatedAt).toISOString() : null,
  } : null, null, 2));

  console.log('\n=== DexScreener search(pepe) ===');
  const t2 = Date.now();
  const s = await dex.searchTokens('pepe');
  console.log(`count=${s.length} ms=${Date.now() - t2}`, s.slice(0, 2).map((p) => ({ chain: p.chain, sym: p.symbol, vol: p.volume24h, liq: p.liquidity })));

  // 2) OKX v6（需 .env 的 OKX_* key）
  console.log('\n=== OKX getHotTokensRanked(8453, x_mentions) ===');
  const m = getMarketClient();
  const t3 = Date.now();
  try {
    const items = await m.getHotTokensRanked('8453', 'x_mentions', 3);
    console.log(`count=${items.length} ms=${Date.now() - t3}`, items.map((i) => ({ sym: i.symbol, addr: i.tokenAddress, price: i.price, xMentions: i.xMentions, trendingScore: i.trendingScore, rankType: i.rankType })));
  } catch (e: any) {
    console.log('OKX hot-tokens FAILED:', e.message);
  }

  console.log('\n=== OKX getPriceInfo(8453, USDC) ===');
  try {
    const pi = await m.getPriceInfo('8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    console.log(JSON.stringify(pi, null, 2).slice(0, 600));
  } catch (e: any) {
    console.log('OKX price-info FAILED:', e.message);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
