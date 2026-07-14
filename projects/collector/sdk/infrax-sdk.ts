/**
 * InfraX Collector — TypeScript SDK
 *
 * 零依赖，单文件 SDK。复制即用，或通过 npm 安装。
 *
 * @example
 * ```ts
 * import { InfraX } from 'infrax-ollector-sdk';
 * const px = new InfraX('http://43.156.78.59:3000', 'pkx_xxx');
 *
 * // 查代币价格
 * const price = await px.price('ethereum', '0xdac17f958d2ee523a2206206994597c13d831ec7');
 *
 * // 查链上事件
 * const events = await px.events.query({ chain: 'ethereum', page_size: 50 });
 *
 * // 广播交易
 * const { tx_hash } = await px.relay('ethereum', '0x02f8...');
 *
 * // 实时事件流
 * px.ws(['ethereum'], (event) => console.log(event));
 * ```
 */

export interface InfraXConfig {
  baseUrl: string;  // e.g. 'http://collector.pocketx.io:3000'
  apiKey: string;   // pkx_xxx, generated in Admin Panel
}

/* ──────────────── Data Types ──────────────── */

export interface PriceResponse {
  chain: string;
  token: string;
  address: string | null;
  token_name: string;
  price_usd: number;
  volume_24h?: number;
  market_cap?: number;
  liquidity_usd?: number;
  holder_count?: number;
  price_change_24h?: number;
  dex_name?: string;
  funding_rate?: number;
  next_funding_time?: string;
  updated_at: string;
  source: 'okx_dex' | 'binance_futures' | 'okx_on_demand' | 'none';
  message?: string;
}

export interface EventQuery {
  chain?: string;
  address?: string;
  contract?: string;
  event_type?: string;
  from_block?: number;
  to_block?: number;
  page_size?: number;
  page_token?: string;
}

export interface BatchQuery {
  addresses: string[];   // max 20
  chains: string[];       // max 7
  event_type?: string;
  per_address?: number;   // max 100
}

export interface EventData {
  event_id: string;
  event_type: string;
  chain: string;
  block_number: number;
  tx_hash: string;
  from_address: string;
  to_address: string;
  contract_address: string;
  token_address: string;
  token_symbol: string;
  amount: string;
  amount_raw: string;
  confirmations: number;
  collected_at: string;
  created_at: string;
}

export interface EventsResponse {
  data: EventData[];
  next_page_token: string | null;
}

export interface BatchResponse {
  total: number;
  results: Record<string, EventData[]>;     // key: "chain:address"
  address_summary: Record<string, {
    chain: string;
    address: string;
    count: number;
    latest_block: number;
    latest_tx_time: string | null;
  }>;
}

export interface TokenData {
  chain: string;
  token_address: string;
  token_symbol: string;
  token_name: string;
  price_usd: number;
  volume_24h: number;
  market_cap: number;
  liquidity_usd: number;
  holder_count: number;
  price_change_24h: number;
  dex_name: string;
  collected_at: string;
}

export interface RelayerResponse {
  tx_hash: string;
}

export interface ChainStats {
  chains: Array<{
    chain: string;
    event_count: number;
    latest_block: number;
    oldest_block: number;
    unique_tx: number;
  }>;
  storage: any;
}

export interface HealthResponse {
  status: string;
  scanners: Array<{ chain: string; status: string; error: string | null }>;
  endpoints: number;
  storage: any;
  checkpoints: any[];
}

interface ApiResponse<T> {
  code: number;
  message: string;
  data?: T;
}

/* ──────────────── Error ──────────────── */

export class InfraXError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'InfraXError';
  }
}

/* ──────────────── Client ──────────────── */

export class InfraX {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  // ─────────────── private ───────────────

  private async request<T>(
    method: string,
    path: string,
    body?: any,
    params?: Record<string, string>
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (params) {
      url += `?${new URLSearchParams(params)}`;
    }

    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };

    let retries = 3;
    while (retries > 0) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });

        const json: ApiResponse<T> = await res.json();

        if (json.code !== 0) {
          throw new InfraXError(json.code, json.message || `HTTP ${res.status}`);
        }

        return json.data as T;
      } catch (err: any) {
        retries--;
        if (retries === 0 || err instanceof InfraXError) throw err;
        await new Promise(r => setTimeout(r, 300 * (4 - retries)));
      }
    }
    throw new InfraXError(-1, 'Max retries exceeded');
  }

  // ─────────────── Price (预言机) ───────────────

  /**
   * 查询代币价格 — 支持符号或合约地址
   *
   * 查询链路: 本地DB缓存 → Binance合约 → OKX DEX实时查询
   *
   * @param chain  - 链名 (ethereum, bsc, polygon, arbitrum, optimism, base, futures)
   * @param token  - 代币符号 (USDT) 或合约地址 (0x...)
   * @returns 价格信息，含 source 字段标识数据来源
   *
   * @example
   * ```ts
   * // 用符号查
   * const btc = await px.price('futures', 'BTC');
   * // 用地址查
   * const usdt = await px.price('ethereum', '0xdac17f958d2ee523a2206206994597c13d831ec7');
   * ```
   */
  price = (chain: string, token: string): Promise<PriceResponse> =>
    this.request<PriceResponse>('GET', '/api/v2/data/price', undefined, { chain, token });

  // ─────────────── Events (链上事件) ───────────────

  events = {
    /**
     * 查询链上事件 — 支持多维度过滤 + 游标分页
     */
    query: (params: EventQuery = {}): Promise<EventsResponse> =>
      this.request<EventsResponse>('GET', '/api/v2/data/events', undefined, params as Record<string, string>),

    /**
     * 批量查询 — 多地址 x 多链一次请求
     */
    batch: (params: BatchQuery): Promise<BatchResponse> =>
      this.request<BatchResponse>('POST', '/api/v2/data/events/batch', params),

    /**
     * 全量拉取 — 自动遍历所有分页
     * ⚠️ 可能拉取数百万条事件，请谨慎使用
     */
    fetchAll: async (params: EventQuery = {}): Promise<EventData[]> => {
      const all: EventData[] = [];
      let token: string | null = null;
      do {
        const result = await this.events.query({ ...params, page_size: 500, page_token: token || undefined });
        all.push(...result.data);
        token = result.next_page_token;
      } while (token);
      return all;
    },
  };

  // ─────────────── Market (市场数据) ───────────────

  market = {
    /**
     * 搜索 DEX Token 快照 (OKX ChainOS 数据)
     */
    tokens: (params: {
      chain?: string;
      address?: string;
      symbol?: string;
      limit?: number;
    } = {}): Promise<TokenData[]> =>
      this.request<TokenData[]>('GET', '/api/v2/data/market/tokens', undefined, params as Record<string, string>),

    /**
     * 获取 Token 历史价格 (OKX ChainOS 数据)
     */
    tokenHistory: (params: {
      chain: string;
      address: string;
      hours?: number;
      limit?: number;
    }): Promise<TokenData[]> =>
      this.request<TokenData[]>('GET', '/api/v2/data/market/token-history', undefined, params as Record<string, string>),
  };

  // ─────────────── Relayer (交易广播) ───────────────

  /**
   * 广播已签名交易到目标链
   * 支持 7 条 EVM 链，自动多 RPC 容错
   *
   * @param chain — 链名
   * @param tx    — 0x 前缀的已签名原始交易
   * @returns 交易哈希
   */
  relay = (chain: string, tx: string): Promise<RelayerResponse> =>
    this.request<RelayerResponse>('POST', '/api/v1/relay', { chain, tx });

  // ─────────────── Stats (统计) ───────────────

  /**
   * 获取链级统计信息
   */
  stats = (): Promise<ChainStats> =>
    this.request<ChainStats>('GET', '/api/v2/data/stats');

  /**
   * 获取采集器健康状态
   */
  health = (): Promise<HealthResponse> =>
    this.request<HealthResponse>('GET', '/api/v2/data/health');

  // ─────────────── WebSocket (实时推送) ───────────────

  /**
   * 打开 WebSocket 实时事件流
   *
   * @param chains  — 可选链过滤 (e.g. ['ethereum', 'bsc'])
   * @param onEvent — 新事件回调
   * @returns WebSocket 实例 (调用 .close() 断开)
   *
   * @example
   * ```ts
   * const ws = px.ws(['ethereum'], (event) => {
   *   console.log('New event:', event.event_type, event.chain);
   * });
   * // 断开连接: ws.close()
   * ```
   */
  ws(chains?: string[], onEvent?: (event: EventData) => void): WebSocket {
    const wsUrl = this.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    const qs = chains?.length ? `?chains=${chains.join(',')}` : '';
    const ws = new WebSocket(`${wsUrl}/api/v2/data/ws${qs}`);
    ws.onopen = () => console.log('[InfraX] WS connected');
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === 'event' && onEvent) onEvent(data.data);
      } catch {}
    };
    ws.onerror = (e) => console.error('[InfraX] WS error', e);
    ws.onclose = () => console.log('[InfraX] WS closed');
    return ws;
  }
}

/**
 * 便捷函数：拉取某地址的全部事件
 */
export async function fetchAddressEvents(
  config: InfraXConfig,
  address: string,
  chain?: string
): Promise<EventData[]> {
  const px = new InfraX(config.baseUrl, config.apiKey);
  return px.events.fetchAll({ address, chain });
}
