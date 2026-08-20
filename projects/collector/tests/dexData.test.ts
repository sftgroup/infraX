/**
 * DEX 数据层（DexScreener client + 链枚举契约）单测。
 * 真实上游（api.dexscreener.com）通过 mock fetch 覆盖；映射/聚合逻辑全测。
 */
import * as dex from '../src/services/dexScreener';

const originalFetch = global.fetch;
const originalEnv = process.env.DEXSCREENER_DISABLE_THROTTLE;

const mockPair = (over: any = {}) => ({
  chainId: 'base',
  dexId: 'aerodrome',
  pairAddress: '0x0000000000000000000000000000000000000001',
  baseToken: { symbol: 'USDC', name: 'USD Coin', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  priceUsd: '1.0001',
  priceChange: { h24: '-0.01' },
  volume: { h24: '1200000' },
  liquidity: { usd: '2400000' },
  txns: { h24: { buys: 300, sells: 150 } },
  pairCreatedAt: 1710000000000,
  ...over,
});

beforeEach(() => {
  process.env.DEXSCREENER_DISABLE_THROTTLE = '1';
  dex.__resetDexCacheForTest();
});

afterEach(() => {
  process.env.DEXSCREENER_DISABLE_THROTTLE = originalEnv;
  (global as any).fetch = originalFetch;
});

describe('mapPair', () => {
  it('映射链枚举 + 数字归一化', () => {
    const p = dex.mapPair(mockPair());
    expect(p).toEqual({
      chainId: 'base', chain: 'BASE', dexName: 'aerodrome',
      symbol: 'USDC', name: 'USD Coin',
      tokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      pairAddress: '0x0000000000000000000000000000000000000001',
      volume24h: 1200000, liquidity: 2400000, priceUsd: 1.0001,
      priceChange24h: -0.01, txns24h: { buys: 300, sells: 150 },
      createdAt: 1710000000000,
    });
  });

  it('solana 链映射 SOL，无效行返回 null', () => {
    expect(dex.mapPair(mockPair({ chainId: 'solana' }))?.chain).toBe('SOL');
    expect(dex.mapPair(null)).toBeNull();
    expect(dex.mapPair({})).toBeNull();
  });

  it('缺省数值字段 → 0（不 NaN）', () => {
    const p = dex.mapPair(mockPair({ volume: undefined, liquidity: undefined, priceUsd: undefined }));
    expect(p?.volume24h).toBe(0);
    expect(p?.liquidity).toBe(0);
    expect(p?.priceUsd).toBe(0);
  });
});

describe('getTokensDetail 聚合', () => {
  it('search-by-address 按链过滤聚合（流动性求和/最早池创建时间/前 5 池）', async () => {
    (global as any).fetch = jest.fn(async (url: string) => {
      expect(url).toContain('/latest/dex/search?q=0xabc');
      return {
        ok: true, status: 200,
        json: async () => ({
          pairs: [
            mockPair({ chainId: 'base', pairAddress: '0x...01', baseToken: { symbol: 'USDC', name: 'USD Coin', address: '0xABC' }, liquidity: { usd: '100' }, pairCreatedAt: 1710000000000 }),
            mockPair({ chainId: 'base', pairAddress: '0x...02', baseToken: { symbol: 'USDC', name: 'USD Coin', address: '0xABC' }, liquidity: { usd: '200' }, pairCreatedAt: 1700000000000 }),
            // 其他链的池应被过滤
            mockPair({ chainId: 'pulsechain', pairAddress: '0x...03', baseToken: { symbol: 'USDC', name: 'USD Coin', address: '0xABC' }, liquidity: { usd: '9999' } }),
          ],
        }),
      };
    });
    const out = await dex.getTokensDetail('base', ['0xABC']);
    expect(out).toHaveLength(1);
    expect(out[0].tokenAddress).toBe('0xabc');
    expect(out[0].liquidity).toBe(300);
    expect(out[0].poolCount).toBe(2);
    expect(out[0].poolCreatedAt).toBe(1700000000000);
  });
});

describe('getHotTokens（profiles + boosts 合并）', () => {
  it('同链去重：同地址 profiles 权重高，非同链按 chain 过滤', async () => {
    (global as any).fetch = jest.fn(async (url: string) => {
      if (url.includes('token-profiles')) {
        return {
          ok: true, status: 200,
          json: async () => [
            { chainId: 'base', tokenAddress: '0xAAA', url: 'u1', description: 'd1', links: [] },
            { chainId: 'ethereum', tokenAddress: '0xBBB', url: 'u2', description: 'd2', links: [] },
          ],
        };
      }
      // token-boosts
      return {
        ok: true, status: 200,
        json: async () => [
          { chainId: 'base', tokenAddress: '0xAAA', url: 'u1b', description: '', links: [] },
          { chainId: 'base', tokenAddress: '0xCCC', url: 'u3', description: 'd3', links: [] },
        ],
      };
    });

    const all = await dex.getHotTokens(undefined, 10);
    expect(all).toHaveLength(3); // AAA(base,profiles), BBB(eth), CCC(base,boosts)
    const aaa = all.find((i) => i.tokenAddress === '0xaaa');
    expect(aaa?.source).toBe('profiles');
    expect(aaa?.score).toBe(100);

    const onlyBase = await dex.getHotTokens('BASE', 10);
    expect(onlyBase.every((i) => i.chainId === 'base')).toBe(true);
    expect(onlyBase).toHaveLength(2);
  });

  it('429 → 抛错（调用方应回 503）', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 429 }));
    await expect(dex.getTokenProfiles()).rejects.toThrow(/429/);
  });

  it('404 → 视为空结果（token 无池时降级，不抛错）', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 404 }));
    const out = await dex.getTokensDetail('base', ['0xdead']);
    expect(out).toEqual([]);
  });
});

describe('searchTokens', () => {
  it('过滤无效 pair 行', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ pairs: [mockPair(), null, undefined, mockPair({ pairAddress: '' })] }),
    }));
    const out = await dex.searchTokens('usdc');
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe('USDC');
  });
});
