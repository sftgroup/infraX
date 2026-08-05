/**
 * InfraX SDK v0.2
 *
 * Full coverage: Wallet / Safe / Payment / SaaS / DC / Vault / MPC
 */

// ═══════════════ Types ═══════════════

export interface InfraXConfig {
  baseUrl?: string;
  apiKey?: string;
  dcApiKey?: string;
  /** Data service (:9112) base URL, e.g. http://<host>:9112; falls back to baseUrl */
  dataUrl?: string;
  /** Data service API key (X-API-Key); falls back to apiKey */
  dataApiKey?: string;
  timeout?: number;
}

export interface InfraXResponse<T = any> {
  code: number;
  message: string;
  data: T;
}

export interface WalletBalanceParams { address: string; chain?: string; token?: string; }
export interface WalletBalanceResult { address: string; chain: string; balance: string; token?: string; decimals?: number; }
export interface WalletSendParams { from: string; to: string; amount: string; chain?: string; token?: string; }
export interface WalletSendResult { txHash: string; chain: string; from: string; to: string; amount: string; }
export interface WalletSimulateParams { from: string; to: string; amount?: string; data?: string; chain?: string; }
export interface WalletSimulateResult { gasEstimate: string; gasPrice?: string; totalCost?: string; }
export interface WalletRpcParams { chain?: string; method?: string; params?: any[]; }
export interface WalletRpcResult { chain: string; response: any; }

// Safe
export interface SafeProposeParams { safeAddress: string; to: string; value?: string; data?: string; }
export interface SafeProposeResult { safeTxHash: string; safeAddress: string; to: string; value: string; nonce: number; }
export interface SafeConfirmParams { safeAddress: string; safeTxHash: string; signature: string; }
export interface SafeConfirmResult { sigCount: number; threshold: number; ready: boolean; }
export interface SafeExecuteParams { safeTxHash: string; }
export interface SafeExecuteResult { txHash: string; executed: boolean; }

// Payment
export interface PaymentCreateParams { planId: string; amount: string; method?: string; currency?: string; }
export interface PaymentCreateResult { paymentId: string; amount: string; status: string; }
export interface PaymentStatusResult { paymentId: string; status: string; amount: string; }
export interface X402PayParams { recipient: string; amount: string; token?: string; chain?: string; description?: string; }
export interface X402PayResult { txHash: string; amount: string; token: string; }

// SaaS
export interface TenantCreateParams { name: string; planId?: string; metadata?: Record<string, any>; }
export interface TenantCreateResult { tenantId: string; name: string; apiKey: string; }
export interface ApiKeyRotateResult { apiKey: string; }
export interface SaaSStats { totalTenants: number; totalUsers: number; revenue: number; }

// DC
export interface DCEventsParams { chain?: string; address?: string; contract?: string; eventType?: string; fromBlock?: string; limit?: number; }
export interface DCEvent { chain: string; block: number; txHash: string; from: string; to: string; type: string; token?: string; amount?: string; }
export interface DCStatsResult { chains: Array<{ chain: string; events: number; latestBlock: string; uniqueTx: number; }>; }
export interface DCToken { symbol: string; name: string; address: string; chain: string; decimals: number; }
export interface DCChain { name: string; chainId: string; nativeSymbol: string; }

// Vault
export interface VaultSafeParams { chain?: string; status?: 'active' | 'pending' | 'closed'; }
export interface VaultSafe { id: string; name: string; address: string; chain: string; threshold: number; signers: string[]; status: string; }
export interface VaultCreateSafeParams { name?: string; signers: string[]; threshold: number; chain: string; }
export interface VaultTransactionParams { safeId?: string; status?: string; limit?: number; }
export interface VaultTransaction { id: string; safeId: string; to: string; amount: string; status: string; confirmations: number; threshold: number; }
export interface VaultCreateTxParams { safeId: string; to: string; amount: string; tokenAddress?: string; data?: string; }

// MPC
export interface MPCSendCodeParams { email: string; }
export interface MPCRegisterParams { email: string; code: string; }
export interface MPCWalletResult { email: string; address: string; walletId: string; }
export interface MPCStatusParams { email: string; }
export interface MPCStatusResult { exists: boolean; address?: string; walletId?: string; }

// Market — OKX ChainOS v6 Market API
export interface MarketTokenInfo { chain: string; tokenAddress: string; symbol: string; name: string; price: number; volume24h: number; marketCap: number; liquidity: number; holders: number; change24h: number; }
export interface MarketCandle { timestamp: string; open: number; high: number; low: number; close: number; volume: number; }
export interface MarketBalance { address: string; chain: string; tokenAddress: string; symbol: string; balance: string; valueUsd: number; }
export interface MarketTx { txHash: string; chain: string; blockHeight: number; fromAddress: string; toAddress: string; value: string; status: string; }
export interface MarketMemeToken { chain: string; tokenAddress: string; symbol: string; name: string; liquidity: number; volume24h: number; holderCount: number; devAddress: string; isHoneypot: boolean; bundledPercent: number; }
export interface MarketSignal { signalId: string; chain: string; tokenAddress: string; symbol: string; signalType: string; address: string; amount: number; valueUsd: number; }
export interface MarketLeaderboardEntry { rank: number; address: string; pnl: number; pnlPercent: number; winRate: number; tradeCount: number; }

// Data — InfraX data service (:9112) market data plane
export interface DataBarsParams {
  symbol: string;
  timeframe?: string;
  marketType?: 'spot' | 'swap';
  start?: number;
  end?: number;
  limit?: number;
}
export interface DataBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  [k: string]: any; // 附加技术指标/因子字段
}
export interface DataTickerParams { symbol: string; marketType?: 'spot' | 'swap'; exchangeId?: string; market?: string; }
export interface DataTickerResult { symbol: string; price: number; change: number; changePercent: number; high: number; low: number; open: number; previousClose: number; ts: number; }
export interface DataFactorCurrentParams { symbols?: string; category?: string; }
export interface DataFactorHistoryParams { symbol: string; timeframe?: string; ids?: string[]; start?: number; end?: number; limit?: number; }
export interface DataSnapshotParams { type?: string; date?: string; limit?: number; }
export interface DataSymbolSearchParams { keyword: string; market?: string; limit?: number; }
export interface DataSymbolResolveParams { symbol: string; market?: string; }
export interface DataMlPredictionsParams { model: 'bolt' | 'moirai' | 'timesfm'; symbol: string; start?: number; end?: number; limit?: number; }
export interface DataStats { kline_rows: number; snapshot_rows: number; symbols: number; time_start: number | null; time_end: number | null; }

// ═══════════════ HTTP ═══════════════

class HttpClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;

  constructor(config: InfraXConfig) {
    this.baseUrl = config.baseUrl || 'https://api.infrax.io';
    this.timeout = config.timeout || 30000;
    this.headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) this.headers['x-api-key'] = config.apiKey;
    if (config.dcApiKey) this.headers['x-dc-api-key'] = config.dcApiKey;
  }

  async get<T>(path: string): Promise<InfraXResponse<T>> {
    const r = await this.fetch(path, { method: 'GET' });
    return r.json();
  }

  async post<T>(path: string, body?: any): Promise<InfraXResponse<T>> {
    const r = await this.fetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }

  async patch<T>(path: string, body?: any): Promise<InfraXResponse<T>> {
    const r = await this.fetch(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }

  async put<T>(path: string, body?: any): Promise<InfraXResponse<T>> {
    const r = await this.fetch(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }

  async del<T>(path: string): Promise<InfraXResponse<T>> {
    const r = await this.fetch(path, { method: 'DELETE' });
    return r.json();
  }

  private async fetch(path: string, opts: { method: string; body?: string }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(this.baseUrl + path, { ...opts, headers: this.headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  setApiKey(key: string) { this.headers['x-api-key'] = key; }
  setDcApiKey(key: string) { this.headers['x-dc-api-key'] = key; }
}

// ═══════════════ Wallet — balances, send, simulate, RPC ═══════════════

class WalletAPI {
  constructor(private http: HttpClient) {}
  async balance(params: WalletBalanceParams) { const q = new URLSearchParams(); q.set('address', params.address); if (params.chain) q.set('chain', params.chain); if (params.token) q.set('token', params.token); return this.http.get<WalletBalanceResult>('/api/v2/wallet/balance?' + q.toString()); }
  async send(params: WalletSendParams) { return this.http.post<WalletSendResult>('/api/v2/wallet/send', params); }
  async simulate(params: WalletSimulateParams) { return this.http.post<WalletSimulateResult>('/api/v2/wallet/simulate', params); }
  async health() { return this.http.get<{ status: string }>('/health'); }
  async rpc(params: WalletRpcParams = {}) { return this.http.post<WalletRpcResult>('/api/v2/wallet/rpc', params); }
  async sweep(params: { chain?: string; toAddress?: string } = {}) { return this.http.post<any>('/api/v2/wallet/sweep', params); }
  async txStatus(params: { txHash: string; chain?: string }) { const q = new URLSearchParams(); q.set('tx_hash', params.txHash); if (params.chain) q.set('chain', params.chain); return this.http.get<any>('/api/v2/wallet/tx-status?' + q.toString()); }
}

// ═══════════════ Safe — multi-sig on-chain operations ═══════════════

class SafeAPI {
  constructor(private http: HttpClient) {}
  async propose(params: SafeProposeParams) { return this.http.post<SafeProposeResult>('/api/vault/safe/propose', params); }
  async confirm(params: SafeConfirmParams) { return this.http.post<SafeConfirmResult>('/api/vault/safe/confirm', params); }
  async execute(params: SafeExecuteParams) { return this.http.post<SafeExecuteResult>('/api/vault/safe/execute', params); }
  async list(chainId?: string) { return this.http.get<any>('/api/vault/safe/list' + (chainId ? '?chainId=' + chainId : '')); }
  async owned() { return this.http.get<any>('/api/vault/safe/owned'); }
  async participating() { return this.http.get<any>('/api/vault/safe/participating'); }
  async detail(address: string) { return this.http.get<any>('/api/vault/safe/' + address); }
  async create(params: { chainId: string; owners: string[]; threshold: number; name?: string }) { return this.http.post<any>('/api/vault/safe/create', params); }
  async updateOwners(address: string, params: { owners: string[]; threshold: number }) { return this.http.put<any>('/api/vault/safe/' + address + '/owners', params); }
  async retry(chainId?: string) { return this.http.post<any>('/api/vault/safe/retry', { chainId }); }
  async sync(safeAddress: string) { return this.http.post<any>('/api/vault/safe/sync', { safeAddress }); }
  async executeReady(safeAddress: string) { return this.http.post<any>('/api/vault/safe/execute-ready', { safeAddress }); }
  async status(walletAddress?: string) { return this.http.get<any>('/api/vault/safe/status' + (walletAddress ? '?walletAddress=' + walletAddress : '')); }
}

// ═══════════════ Payment — checkout, x402 auto-pay ═══════════════

class PaymentAPI {
  constructor(private http: HttpClient) {}
  async create(params: PaymentCreateParams) { return this.http.post<PaymentCreateResult>('/api/v2/payment/create', params); }
  async status(paymentId: string) { return this.http.get<PaymentStatusResult>('/api/v2/payment/status?paymentId=' + encodeURIComponent(paymentId)); }
  async confirm(paymentId: string) { return this.http.post<any>('/api/v2/payment/confirm', { paymentId }); }
  async history() { return this.http.get<any>('/api/v2/payment/history'); }
  /** x402: auto-approve ERC20 payment for API access */
  async x402Pay(params: X402PayParams) { return this.http.post<X402PayResult>('/api/v2/payment/x402/pay', params); }
  async x402Info() { return this.http.get<any>('/api/v2/payment/x402/info'); }
}

// ═══════════════ SaaS — tenant management, billing, apikeys ═══════════════

class SaaSAPI {
  constructor(private http: HttpClient) {}
  async createTenant(params: TenantCreateParams) { return this.http.post<TenantCreateResult>('/api/v2/saas/tenants', params); }
  async listTenants() { return this.http.get<any>('/api/v2/saas/tenants'); }
  async getTenant(tenantId: string) { return this.http.get<any>('/api/v2/saas/tenants/' + tenantId); }
  async updateTenant(tenantId: string, params: any) { return this.http.patch<any>('/api/v2/saas/tenants/' + tenantId, params); }
  async deleteTenant(tenantId: string) { return this.http.del<any>('/api/v2/saas/tenants/' + tenantId); }
  async createApiKey(tenantId: string) { return this.http.post<any>('/api/v2/saas/tenants/' + tenantId + '/apikey', {}); }
  async rotateApiKey(tenantId: string) { return this.http.post<ApiKeyRotateResult>('/api/v2/saas/tenants/' + tenantId + '/apikey/rotate', {}); }
  async deleteApiKey(tenantId: string) { return this.http.del<any>('/api/v2/saas/tenants/' + tenantId + '/apikey'); }
  async getUsage(tenantId: string) { return this.http.get<any>('/api/v2/saas/tenants/' + tenantId + '/usage'); }
  async stats() { return this.http.get<SaaSStats>('/api/v2/saas/stats'); }
  async audit() { return this.http.get<any>('/api/v2/saas/audit'); }
  async users() { return this.http.get<any>('/api/v2/saas/users'); }
  async hotWallets() { return this.http.get<any>('/api/v2/saas/hot-wallets'); }
}

// ═══════════════ Subscription — plans, subscribe, cancel ═══════════════

class SubAPI {
  constructor(private http: HttpClient) {}
  async plans() { return this.http.get<any>('/api/v2/subscription/plans'); }
  async current() { return this.http.get<any>('/api/v2/subscription/current'); }
  async subscribe(planId: string) { return this.http.post<any>('/api/v2/subscription/subscribe', { planId }); }
  async cancel() { return this.http.post<any>('/api/v2/subscription/cancel'); }
}

// ═══════════════ DC — events, tokens, chains, checkpoints ═══════════════

class DCAPI {
  constructor(private http: HttpClient) {}
  async events(params: DCEventsParams = {}) { const q = new URLSearchParams(); if (params.chain) q.set('chain', params.chain); if (params.address) q.set('address', params.address); if (params.contract) q.set('contract', params.contract); if (params.eventType) q.set('event_type', params.eventType); if (params.fromBlock) q.set('from_block', params.fromBlock); if (params.limit) q.set('page_size', String(params.limit)); return this.http.get<any>('/api/v2/data/events?' + q.toString()); }
  async stats() { return this.http.get<DCStatsResult>('/api/v2/data/stats'); }
  async checkpoints(chain?: string) { return this.http.get<any>('/api/v2/data/checkpoints' + (chain ? '?chain=' + chain : '')); }
  async plans() { return this.http.get<any>('/api/v2/data/plans'); }
  async tokens(params: { symbol?: string; chain?: string } = {}) { const q = new URLSearchParams(); if (params.symbol) q.set('symbol', params.symbol); if (params.chain) q.set('chain', params.chain); return this.http.get<DCToken[]>('/api/v2/data/tokens?' + q.toString()); }
  async chains() { return this.http.get<DCChain[]>('/api/v2/data/chains'); }
}

// ═══════════════ Vault — multisig safe creation + risk ═══════════════

class VaultAPI {
  constructor(private http: HttpClient) {}
  async dashboard() { return this.http.get<any>('/api/vault/dashboard'); }
  async safes(params: VaultSafeParams = {}) { const q = new URLSearchParams(); if (params.chain) q.set('chain', params.chain); if (params.status) q.set('status', params.status); return this.http.get<VaultSafe[]>('/api/vault/safe/list?' + q.toString()); }
  async safeInfo(safeId: string) { return this.http.get<VaultSafe>('/api/vault/safe/' + encodeURIComponent(safeId)); }
  async createSafe(params: VaultCreateSafeParams) { return this.http.post<VaultSafe>('/api/vault/safe/create', params); }
  async transactions(params: VaultTransactionParams = {}) { const q = new URLSearchParams(); if (params.safeId) q.set('safe_id', params.safeId); if (params.status) q.set('status', params.status); if (params.limit) q.set('limit', String(params.limit)); return this.http.get<VaultTransaction[]>('/api/vault/safe/list?' + q.toString()); }
  async createTransaction(params: VaultCreateTxParams) { return this.http.post<VaultTransaction>('/api/vault/safe/propose', params); }
  async riskCheck(params: { to: string; amount?: string; chain?: string }) { return this.http.post<any>('/api/vault/risk/check', params); }
}

// ═══════════════ MPC — key shard wallets ═══════════════

class MPCAPI {
  constructor(private http: HttpClient) {}
  async sendCode(params: MPCSendCodeParams) { return this.http.post<any>('/api/v2/mpc/send-code', params); }
  async register(params: MPCRegisterParams) { return this.http.post<MPCWalletResult>('/api/v2/mpc/register', params); }
  async recover(params: MPCRegisterParams) { return this.http.post<MPCWalletResult>('/api/v2/mpc/recover', params); }
  async status(params: MPCStatusParams) { return this.http.get<MPCStatusResult>('/api/v2/mpc/status?email=' + encodeURIComponent(params.email)); }
  async createWallet(params: MPCSendCodeParams) { const s1 = await this.sendCode(params); if (s1.code !== 0) return s1; return { code: 0, message: 'Verification code sent. Call mpc.register() to complete.', email: params.email }; }
}

// ═══════════════ Market — OKX ChainOS v6 DEX Market ═══════════════

class MarketAPI {
  constructor(private http: HttpClient) {}

  /** P1 Free — token search */
  async searchToken(keyword: string, chainIndex?: string, limit?: number) {
    const q = new URLSearchParams({ keyword });
    if (chainIndex) q.set('chainIndex', chainIndex);
    if (limit) q.set('limit', String(limit));
    return this.http.get<MarketTokenInfo[]>('/api/v2/data/market/token-search?' + q.toString());
  }

  /** P2 Basic — token basic info */
  async getTokenInfo(chainIndex: string, tokenAddress: string) {
    return this.http.get<any>('/api/v2/data/market/token-info?chainIndex=' + chainIndex + '&tokenAddress=' + tokenAddress);
  }

  /** P2 Basic — trending hot tokens (30+ filter params available) */
  async getHotTokens(chainIndex: string, limit?: number, opts?: Record<string, string>) {
    const q = new URLSearchParams({ chainIndex });
    if (limit) q.set('limit', String(limit));
    if (opts) { for (const [k, v] of Object.entries(opts)) { if (v !== undefined && v !== '') q.set(k, String(v)); } }
    return this.http.get<MarketTokenInfo[]>('/api/v2/data/market/hot-tokens?' + q.toString());
  }

  /** P2 Basic — K-line candles */
  async getCandles(chainIndex: string, tokenAddress: string, period = '15m', limit = 100) {
    return this.http.get<MarketCandle[]>('/api/v2/data/market/candles?chainIndex=' + chainIndex + '&tokenAddress=' + tokenAddress + '&period=' + period + '&limit=' + limit);
  }

  /** P2 Basic — real-time DEX price */
  async getPrice(chainIndex: string, tokenAddress: string) {
    return this.http.get<any>('/api/v2/data/market/price?chainIndex=' + chainIndex + '&tokenAddress=' + tokenAddress);
  }

  /** P1 Free — all token balances for address */
  async getBalances(address: string, chains?: string[]) {
    let q = 'address=' + encodeURIComponent(address);
    if (chains?.length) q += '&chains=' + chains.join(',');
    return this.http.get<MarketBalance[]>('/api/v2/data/market/balances?' + q);
  }

  /** P1 Free — transaction history */
  async getTransactions(address: string, chains?: string[], limit?: number) {
    let q = 'address=' + encodeURIComponent(address);
    if (chains?.length) q += '&chains=' + chains.join(',');
    if (limit) q += '&limit=' + limit;
    return this.http.get<MarketTx[]>('/api/v2/data/market/transactions?' + q);
  }

  /** P3 Premium — meme token list */
  async getMemePumpList(chainIndex: string, protocol?: string, sortBy?: string, limit?: number) {
    const q = new URLSearchParams({ chainIndex });
    if (protocol) q.set('protocol', protocol);
    if (sortBy) q.set('sortBy', sortBy);
    if (limit) q.set('limit', String(limit));
    return this.http.get<MarketMemeToken[]>('/api/v2/data/market/mempump/list?' + q.toString());
  }

  /** P3 Premium — smart money signals */
  async getSignalList(chainIndex: string, signalType?: string, limit?: number) {
    const q = new URLSearchParams({ chainIndex });
    if (signalType) q.set('signalType', signalType);
    if (limit) q.set('limit', String(limit));
    return this.http.get<MarketSignal[]>('/api/v2/data/market/signals?' + q.toString());
  }

  /** P3 Premium — trader leaderboard */
  async getLeaderboard(chainIndex: string, leaderboardType = 'pnl', limit?: number) {
    const q = new URLSearchParams({ chainIndex, leaderboardType });
    if (limit) q.set('limit', String(limit));
    return this.http.get<MarketLeaderboardEntry[]>('/api/v2/data/market/leaderboard?' + q.toString());
  }

  // ── Tracked Tokens ──────────────────────────────────────────

  /** List tracked tokens (user-configured monitoring list) */
  async getTrackedTokens(chain?: string) {
    const q = chain ? `?chain=${chain}` : '';
    return this.http.get<any>('/api/v2/data/market/tracked-tokens' + q);
  }

  /** Add a token to user monitoring list */
  async addTrackedToken(params: { chain: string; tokenAddress: string; tokenSymbol?: string; label?: string }) {
    return this.http.post<any>('/api/v2/data/market/tracked-tokens', params);
  }

  /** Remove a token from monitoring list */
  async removeTrackedToken(chain: string, tokenAddress: string) {
    return this.http.del<any>(`/api/v2/data/market/tracked-tokens?chain=${chain}&tokenAddress=${encodeURIComponent(tokenAddress)}`);
  }

  // ── Custom Event Signatures ─────────────────────────────────

  /** List custom event signatures */
  async getEventSigs(chain?: string) {
    const q = chain ? `?chain=${chain}` : '';
    return this.http.get<any>('/api/v2/data/market/custom-sigs' + q);
  }

  /** Register a custom event signature (topic hash → event type mapping) */
  async addEventSig(params: { chain: string; topicHash: string; eventType: string; eventName?: string; abi?: any }) {
    return this.http.post<any>('/api/v2/data/market/custom-sigs', params);
  }

  /** Remove a custom event signature */
  async removeEventSig(chain: string, topicHash: string) {
    return this.http.del<any>(`/api/v2/data/market/custom-sigs?chain=${chain}&topicHash=${encodeURIComponent(topicHash)}`);
  }
}

// ═══════════════ Data — InfraX data service (:9112) market data plane ═══════════════
// 覆盖 data 服务数据面端点：K线 / ticker / 因子 / 快照（含 onchain/okx 快照）/
// 符号搜索解析 / 统计。响应为 data 服务原始 JSON（成功时非 {code,message,data} 信封）。

class DataAPI {
  constructor(private http: HttpClient) {}

  /** OHLCV K-line bars（crypto/usstock/forex/futures/cnstock/hkstock） */
  async bars(params: DataBarsParams) {
    const q = new URLSearchParams({ symbol: params.symbol });
    if (params.timeframe) q.set('timeframe', params.timeframe);
    if (params.marketType) q.set('market_type', params.marketType);
    if (params.start) q.set('start', String(params.start));
    if (params.end) q.set('end', String(params.end));
    if (params.limit) q.set('limit', String(params.limit));
    return this.http.get<{ symbol: string; timeframe: string; market_type: string; count: number; bars: DataBar[] }>('/bars?' + q.toString());
  }

  /** 实时报价 */
  async ticker(params: DataTickerParams) {
    const q = new URLSearchParams({ symbol: params.symbol });
    if (params.marketType) q.set('market_type', params.marketType);
    if (params.exchangeId) q.set('exchange_id', params.exchangeId);
    if (params.market) q.set('market', params.market);
    return this.http.get<DataTickerResult>('/ticker?' + q.toString());
  }

  /** 因子目录 */
  async factorsCatalog() {
    return this.http.get<{ factors: any[] }>('/factors/catalog');
  }

  /** 最新因子值（symbols 逗号分隔；category 过滤） */
  async factorsCurrent(params: DataFactorCurrentParams = {}) {
    const q = new URLSearchParams();
    if (params.symbols) q.set('symbols', params.symbols);
    if (params.category) q.set('category', params.category);
    return this.http.get<{ ts: number; factors: Record<string, any> }>('/factors/current?' + q.toString());
  }

  /** 逐 bar 因子时间序列（回测/研究用） */
  async factorsHistory(params: DataFactorHistoryParams) {
    const q = new URLSearchParams({ symbol: params.symbol });
    if (params.timeframe) q.set('timeframe', params.timeframe);
    if (params.ids?.length) q.set('ids', params.ids.join(','));
    if (params.start) q.set('start', String(params.start));
    if (params.end) q.set('end', String(params.end));
    if (params.limit) q.set('limit', String(params.limit));
    return this.http.get<any>('/factors/history?' + q.toString());
  }

  /** 复杂快照：heatmap/calendar/crypto_prices/indices/tvl/volatility/
   *  us_indicators/earnings/onchain/onchain_checkpoints/okx_hot_tokens/okx_index_prices */
  async snapshots(params: DataSnapshotParams = {}) {
    const q = new URLSearchParams();
    if (params.type) q.set('type', params.type);
    if (params.date) q.set('date', params.date);
    if (params.limit) q.set('limit', String(params.limit));
    return this.http.get<{ ts: number; snapshots: Record<string, any> }>('/snapshots?' + q.toString());
  }

  /** 有足够 K 线数据的 symbol 列表（ml-service 训练标的发现用） */
  async symbols(timeframe = '1d', minBars = 1) {
    return this.http.get<{ timeframe: string; min_bars: number; symbols: string[] }>(
      `/symbols?timeframe=${encodeURIComponent(timeframe)}&min_bars=${minBars}`);
  }

  /** 符号模糊搜索（DS-9） */
  async searchSymbols(params: DataSymbolSearchParams) {
    const q = new URLSearchParams({ keyword: params.keyword });
    if (params.market) q.set('market', params.market);
    if (params.limit) q.set('limit', String(params.limit));
    return this.http.get<{ keyword: string; symbols: any[] }>('/symbols/search?' + q.toString());
  }

  /** 符号解析为标准交易对（DS-4） */
  async resolveSymbol(params: DataSymbolResolveParams) {
    const q = new URLSearchParams({ symbol: params.symbol });
    if (params.market) q.set('market', params.market);
    return this.http.get<{ query: string; resolved: string; market: string }>('/symbol/resolve?' + q.toString());
  }

  /** 券商市场策略（DS-5） */
  async brokerMarketPolicy() {
    return this.http.get<any>('/policy/broker-market');
  }

  /** P2 单模型预测历史（bolt/moirai/timesfm） */
  async mlPredictions(params: DataMlPredictionsParams) {
    const q = new URLSearchParams({ model: params.model, symbol: params.symbol });
    if (params.start) q.set('start', String(params.start));
    if (params.end) q.set('end', String(params.end));
    if (params.limit) q.set('limit', String(params.limit));
    return this.http.get<any>('/ml/predictions?' + q.toString());
  }

  /** 数据库统计（kline/snapshot 行数、symbol 数、覆盖范围） */
  async stats() {
    return this.http.get<DataStats>('/stats');
  }

  /** 服务健康 */
  async health() {
    return this.http.get<any>('/health');
  }
}

// ═══════════════ Main Client ═══════════════

export class InfraX {
  readonly wallet: WalletAPI;
  readonly safe: SafeAPI;
  readonly payment: PaymentAPI;
  readonly saas: SaaSAPI;
  readonly sub: SubAPI;
  readonly dc: DCAPI;
  readonly vault: VaultAPI;
  readonly mpc: MPCAPI;
  readonly market: MarketAPI;
  readonly data: DataAPI;

  private http: HttpClient;

  constructor(config: InfraXConfig = {}) {
    this.http = new HttpClient(config);
    this.wallet = new WalletAPI(this.http);
    this.safe = new SafeAPI(this.http);
    this.payment = new PaymentAPI(this.http);
    this.saas = new SaaSAPI(this.http);
    this.sub = new SubAPI(this.http);
    this.dc = new DCAPI(this.http);
    this.vault = new VaultAPI(this.http);
    this.mpc = new MPCAPI(this.http);
    this.market = new MarketAPI(this.http);
    // data 服务独立 baseUrl（dataUrl 优先，回退 baseUrl）+ 独立 key（dataApiKey 优先，回退 apiKey）
    this.data = new DataAPI(new HttpClient({
      ...config,
      baseUrl: config.dataUrl || config.baseUrl,
      apiKey: config.dataApiKey || config.apiKey,
    }));
  }

  setApiKey(key: string) { this.http.setApiKey(key); }
  setDcApiKey(key: string) { this.http.setDcApiKey(key); }
}

export default InfraX;
