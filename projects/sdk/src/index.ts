/**
 * InfraX SDK v0.4
 *
 * Full coverage: Wallet / Safe / Payment / SaaS / DC / Vault / MPC / Data / ML
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
  /** ml-service (:9120) base URL for real-time inference endpoints; falls back to baseUrl */
  mlUrl?: string;
  /** ml-service API key (ML_API_KEY); falls back to apiKey */
  mlApiKey?: string;
  /** chain-rpc gateway (:9130) base URL for chain RPC reads & broadcast; falls back to baseUrl */
  chainRpcUrl?: string;
  /** chain-rpc gateway API key（读；广播需服务端单独签发 CHAIN_RPC_BROADCAST_KEY）; falls back to apiKey */
  chainRpcApiKey?: string;
  /** chain-rpc gateway 广播 key（服务端签发的独立 key，仅 /v1/broadcast 端点可用；读端点拒绝）。
   *  未配置时 chainRpc.broadcast() 将明确报错（fail-closed），不会用读 key 打广播端点。 */
  chainRpcBroadcastKey?: string;
  /** 通用支付引擎 @0xinfrax/payments (:9132) base URL；回退 baseUrl */
  paymentsUrl?: string;
  /** 支付引擎 API key（PAYMENTS_API_KEY）；回退 apiKey */
  paymentsApiKey?: string;
  /** session-key-engine 托管实例 URL（A-15：SESSION_KEY_ENGINE_URL）；回退 baseUrl */
  sessionKeyUrl?: string;
  /** session-key-engine API key（sdk_ 前缀 Bearer，A-15：SESSION_KEY_API_KEY） */
  sessionKeyApiKey?: string;
  /** 通用 Bearer 鉴权（HttpClient 层）：部分服务用 Authorization: Bearer 而非 x-api-key */
  bearerToken?: string;
  /** WAAS wallet/tx 端点（/api/v2/wallet/*、/api/v2/tx/*）钱包签名鉴权头（EIP-191，消息 `InfraX auth: <ts>`）。
   *  配置后 WalletAPI 每次请求自动生成 x-wallet-address/x-wallet-signature/x-wallet-timestamp。 */
  walletAddress?: string;
  /** 签名回调：输入待签消息（`InfraX auth: <ts>`），返回 EIP-191 签名（hex）。未配置时 wallet.* 将明确报错。 */
  walletSign?: (message: string) => Promise<string>;
  timeout?: number;
}

export interface InfraXResponse<T = any> {
  code: number;
  message: string;
  data: T;
}

export interface WalletBalanceParams { address: string; chain?: string; token?: string; }
export interface WalletBalanceResult { address: string; chain: string; balance: string; token?: string; decimals?: number; }
// MQ-2: 契约对齐 waas /api/v2/tx/*（原 /wallet/send /wallet/simulate 不存在）
export interface WalletSendParams { walletId: string; toAddress: string; amount: string; chain: string; paymentPassword: string; tokenAddress?: string; }
export interface WalletSendResult { txId: string; txHash: string | null; status: string; gasSponsored: boolean; strategy: string; }
export interface WalletSimulateParams { walletId: string; toAddress: string; amount: string; chain: string; tokenAddress?: string; }
export interface WalletSimulateResult { gasLimit: string; gasPrice: string; estimatedCost: string; }
export interface WalletSweepParams { walletId: string; toAddress: string; chain: string; paymentPassword: string; }
export interface WalletRpcParams { chain: string; method: string; params?: any[]; }
export interface WalletRpcResult { chain: string; method: string; result: any; }

// Safe
export interface SafeProposeParams { safeAddress: string; to: string; value?: string; data?: string; }
export interface SafeProposeResult { safeTxHash: string; safeAddress: string; to: string; value: string; nonce: number; }
export interface SafeConfirmParams { safeAddress: string; safeTxHash: string; signature: string; }
export interface SafeConfirmResult { sigCount: number; threshold: number; ready: boolean; }
export interface SafeExecuteParams { safeTxHash: string; }
export interface SafeExecuteResult { txHash: string; executed: boolean; }

// Payment — @0xinfrax/payments 通用支付引擎（MQ-15 T-8 迁移；旧 :9106 /api/v2/payment/* 已下线）
export interface PaymentCheckoutParams {
  subscriber: string;
  amountCents?: number;
  planId?: string | number;
  period?: string;
  currency?: string;
  chain?: string;
  metadata?: Record<string, unknown>;
  clientReference?: string;
  successUrl?: string;
  cancelUrl?: string;
}
export interface PaymentCheckoutResult { method: 'fiat'; paymentId: string; sessionUrl: string; sessionId: string; }
export interface A2ACreateParams { subscriber: string; valueWei: string; payee?: string; asset?: string; chain?: string; metadata?: Record<string, unknown>; }
export interface A2ACreateResult { method: 'a2a'; paymentId: string; amountWei: string; payee: string | null; }
export interface A2ASettleParams { paymentId: string; txHash: string; chain?: string; }
export interface A2ASettleResult { settled: boolean; paymentId: string; reference: string; payer: string; creditedWei: string; asset: string; chain: string; }
export interface PaymentVerifyResult { verified: boolean; reference: string; payer: string; creditedWei: string; asset: string; chain: string; }
export interface PaymentBalanceResult { address: string; balanceWei: string; }
export interface PaymentPriceResult { planId: number; agentId: string; price: string; period: string; active: boolean; trialDays: number | null; payToken: string | null; }
export interface PaymentCapability { id: string; enabled: boolean; endpoints: string[]; config?: Record<string, unknown>; }
export interface PaymentCapabilitiesResult { capabilities: Record<string, PaymentCapability>; }
// 旧方法兼容壳（签名保留；按 method 路由到新端点）
export interface PaymentCreateParams {
  subscriber: string;
  planId?: string | number;
  /** USD 金额（fiat 时 *100 转美分；chain/a2a 忽略，用 valueWei） */
  amount?: string | number;
  method?: 'fiat' | 'chain' | 'a2a';
  currency?: string;
  chain?: string;
  /** chain/a2a 时必填：金额（wei） */
  valueWei?: string;
  payee?: string;
  asset?: string;
  metadata?: Record<string, unknown>;
}
export interface PaymentCreateResult { method: 'fiat' | 'a2a'; paymentId: string; amount: string; status: string; sessionUrl?: string; sessionId?: string; }
// Payment — MQ-16：invites / transfers / batch（引擎裸 JSON，非信封）
export interface BatchItem { payee: string; amountWei: string; asset?: string; metadata?: Record<string, unknown>; }
export interface BatchCreateParams { subscriber: string; items: BatchItem[]; chain?: string; metadata?: Record<string, unknown>; }
export interface BatchCreateResult { method: 'batch'; batchId: string; items: Array<{ itemId: string; payee: string; amountWei: string; status: string; }>; }
export interface BatchSettleParams { batchId: string; itemId: string; txHash: string; chain?: string; }
export interface BatchSettleResult { settled: boolean; batchId: string; itemId: string; reference: string; payer: string; creditedWei: string; }
export interface BatchGetResult { batchId: string; payer: string; chain: string; status: string; items: any[]; }
export interface BatchCancelResult { cancelled: boolean; batchId: string; }
export interface InviteCreateParams { payer: string; payee: string; valueWei: string; asset?: string; chain?: string; dueAt?: string; memo?: string; metadata?: Record<string, unknown>; }
export interface InviteCreateResult { inviteId: string; paymentId: string; amountWei: string; payee: string; dueAt?: string; }
export interface InviteListParams { address: string; role: 'payer' | 'payee'; status?: string; }
export interface InviteListResult { invites: any[]; }
export interface InviteGetResult { inviteId: string; paymentId: string; payer: string; payee: string; amountWei: string; memo?: string; dueAt?: string; status: string; settledMethod?: string; settledRef?: string; }
export interface InviteSettleParams { inviteId: string; txHash: string; chain?: string; }
export interface InviteActionResult { inviteId: string; cancelled?: boolean; settled?: boolean; reference?: string; transferId?: string; }
export interface TransferCreateParams { from: string; to: string; valueWei: string; asset?: string; reference?: string; metadata?: Record<string, unknown>; }
export interface TransferCreateResult { transferId: string; status: string; }
export interface TransferListParams { address: string; role: 'from' | 'to'; }
export interface TransferListResult { transfers: any[]; }
export interface TransferGetResult { transferId: string; from: string; to: string; asset?: string; amountWei: string; status: string; reference?: string; executedAt?: string; }
export interface TransferConfirmResult { transferId: string; executed: boolean; status?: string; error?: string; }
export interface TransferCancelResult { cancelled: boolean; transferId: string; }

// SaaS
export interface TenantCreateParams { name: string; planId?: string; metadata?: Record<string, any>; }
export interface TenantCreateResult { tenantId: string; name: string; apiKey: string; }
export interface ApiKeyRotateResult { apiKey: string; }

// DC
export interface DCEventsParams { chain?: string; address?: string; contract?: string; eventType?: string; fromBlock?: string; limit?: number; }
export interface DCEvent { chain: string; block: number; txHash: string; from: string; to: string; type: string; token?: string; amount?: string; }
export interface DCStatsResult { chains: Array<{ chain: string; events: number; latestBlock: string; uniqueTx?: number; }>; }
export interface DCToken { symbol: string; name: string; address: string; chain: string; decimals: number; }
export interface DCChain { name: string; chainId: string; nativeSymbol: string; }
// DC — MQ-16 套餐订阅面（/api/v2/data/*；均需 x-wallet-address header，信封响应）
export interface DCSubscribeParams { planId: string; rail?: string; }
export interface DCSubscribeResult { tenantId: string; plan: { id: string; name: string; price: number }; dcSubStatus: string; payment?: any; dcApiKey?: string; }
export interface DCPaymentCheckResult { status: string; }
export interface DCVerifyParams { txHash: string; }
export interface DCVerifyResult { verified: boolean; activated?: boolean; }
export interface DCUsageResult { planId: string; planName: string; dcApiKey?: string; dcApiKeyObscured?: string; monthlyQuota: number; currentUsage: number; dailyBreakdown: any[]; dcSubStatus: string; }

// Vault
export interface VaultSafeParams { chain?: string; status?: 'active' | 'pending' | 'closed'; }
export interface VaultSafe { id: string; name: string; address: string; chain: string; threshold: number; signers: string[]; status: string; }
export interface VaultCreateSafeParams { chainId: string; owners: string[]; threshold: number; name?: string; userId?: string; }
export interface VaultTransactionParams { safeId?: string; status?: string; limit?: number; }
export interface VaultTransaction { id: string; safeId: string; to: string; amount: string; status: string; confirmations: number; threshold: number; }
export interface VaultCreateTxParams { safeId: string; to: string; amount: string; tokenAddress?: string; data?: string; }

// MPC
export interface MPCSendCodeParams { email: string; }
export interface MPCRegisterParams { email: string; code: string; walletAddress?: string; }
export interface MPCWalletResult { email: string; address: string; walletId: string; }
export interface MPCStatusParams { email?: string; walletAddress?: string; }
export interface MPCStatusResult { exists: boolean; address?: string; walletId?: string; }
// MQ-7: 对齐 mpc server 15 端点（session/签名/交易/合约/余额/gas）
export interface MPCSessionUnlockParams { email: string; code: string; }
export interface MPCSessionUnlockResult { token: string; address: string; unlockedAt: string; expiresAt: string; }
export interface MPCSessionStatusParams { token: string; }
export interface MPCSessionStatusResult { unlocked: boolean; address?: string; unlockedAt?: string; expiresAt?: string; remainingSeconds?: number; }
export interface MPCBalanceParams { token: string; chain?: string; tokenAddress?: string; }
export interface MPCBalanceResult { address: string; chain: string; nativeBalance: string; nativeSymbol: string; token?: { address: string; symbol?: string; balance?: string; decimals?: number; error?: string; }; }
export interface MPCSignMessageParams { token: string; message: string; }
export interface MPCSignResult { signature: string; address: string; }
export interface MPCSignTypedDataParams { token: string; domain: Record<string, any>; types: Record<string, any>; value: Record<string, any>; }
/** raw 32-byte digest 签名（E-1d；digest 为 32 字节 hex，可带 0x 前缀） */
export interface MPCSignDigestParams { token: string; digest: string; }
export interface MPCSendTransactionParams { token: string; to: string; amount: string; chain?: string; tokenAddress?: string; }
export interface MPCSendTransactionResult { txHash: string; from: string; to: string; amount: string; chain: string; token: string; blockNumber?: number; gasUsed?: string; }
// MPC — MQ-16 计费面（/api/v2/mpc/*）
export interface MpcPlanFee { operation: string; label: string; feeWei: string; fee: string; }
export interface MpcPlansResult { mode: string; billing: string; configured: boolean; platformAddress: string; fees: MpcPlanFee[]; topup: { method: string; steps?: string[]; note?: string; }; }
export interface MpcLedgerBalanceParams { token: string; }
export interface MpcLedgerBalanceResult { address: string; balanceWei: string; balance: string; fees: MpcPlanFee[]; topupHint: any; }
export interface MPCContractReadParams { contractAddress: string; abi: any; method: string; args?: any[]; chain?: string; }
export interface MPCContractReadResult { contractAddress: string; method: string; result: any; }
export interface MPCContractWriteParams { token: string; contractAddress: string; abi: any; method: string; args?: any[]; chain?: string; value?: string; gasLimit?: string; }
export interface MPCContractWriteResult { txHash: string; from: string; contractAddress: string; method: string; chain: string; blockNumber?: number; gasUsed?: string; }
export interface MPCGasEstimateParams { to?: string; value?: string; data?: string; chain?: string; }
export interface MPCGasEstimateResult { chain: string; gasLimit: string; gasPrice: string; estimatedCost: string; estimatedCostWei: string; }

// Market — OKX ChainOS v6 Market API
export interface MarketTokenInfo { chain: string; tokenAddress: string; symbol: string; name: string; price: number; volume24h: number; marketCap: number; liquidity: number; holders: number; change24h: number; }
export interface MarketCandle { timestamp: string; open: number; high: number; low: number; close: number; volume: number; }
export interface MarketBalance { address: string; chain: string; tokenAddress: string; symbol: string; balance: string; valueUsd: number; }
export interface MarketTx { txHash: string; chain: string; blockHeight: number; fromAddress: string; toAddress: string; value: string; status: string; }
export interface MarketMemeToken { chain: string; tokenAddress: string; symbol: string; name: string; liquidity: number; volume24h: number; holderCount: number; devAddress: string; isHoneypot: boolean; bundledPercent: number; }
export interface MarketSignal { signalId: string; chain: string; tokenAddress: string; symbol: string; signalType: string; address: string; amount: number; valueUsd: number; }
export interface MarketLeaderboardEntry { rank: number; address: string; pnl: number; pnlPercent: number; winRate: number; tradeCount: number; }
// Market — MQ-16 订阅面（/api/v2/market/*；X-API-Key 鉴权，信封响应）
export interface MarketPlan { id: string; name: string; price: number; features?: Record<string, any>; }
export interface MarketCheckoutParams { plan_id: string; rail?: string; subscriber?: string; }
export interface MarketCheckoutResult { keyId: number; plan: { id: string; name: string; price: number }; marketSubStatus: string; payment?: any; free?: boolean; }
export interface MarketPaymentCheckResult { status: string; }
export interface MarketVerifyParams { txHash: string; }
export interface MarketVerifyResult { verified: boolean; activated?: boolean; }
export interface MarketUsageResult { planId: string; planName: string; monthlyQuota: number; currentUsage: number; dailyBreakdown: any[]; marketSubStatus: string; }

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
/** 因子工厂挖掘因子（ml_factory 顶层字段，FF-3.3/3.4）：激活列表 + 各 symbol 实时值 */
export interface DataMlFactoryResult {
  updated_at?: number;
  factors?: string[];
  values?: Record<string, Record<string, number>>;
}
export interface DataFactorHistoryParams { symbol: string; timeframe?: string; ids?: string[]; start?: number; end?: number; limit?: number; }
export interface DataSnapshotParams { type?: string; date?: string; limit?: number; }
export interface DataSymbolSearchParams { keyword: string; market?: string; limit?: number; }
export interface DataSymbolResolveParams { symbol: string; market?: string; }
export interface DataMlPredictionsParams { model: 'bolt' | 'moirai' | 'timesfm'; symbol: string; start?: number; end?: number; limit?: number; }
export interface DataStats { kline_rows: number; snapshot_rows: number; symbols: number; time_start: number | null; time_end: number | null; }

// ML — ml-service (:9120) 实时推理端点（统一 dict + 聚合指标；缓存 miss 时 data=null）
export interface MlSymbolPrediction {
  symbol: string;
  direction: 1 | 0 | -1;
  prob_up?: number;
  point_forecast?: number[];
  quantiles?: Record<string, number[]>;
  uncertainty?: string | number;
  [k: string]: any;
}
export interface MlUnifiedResult {
  generated_at?: number;
  n_symbols?: number;
  model?: string;
  avg_prob_up?: number;
  avg_volatility_score?: number;
  symbols?: MlSymbolPrediction[];
  [k: string]: any;
}
export interface MlSentimentParams { articles: Array<Record<string, any>>; }

// ═══════════════ HTTP ═══════════════

export class HttpClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;

  constructor(config: InfraXConfig) {
    this.baseUrl = config.baseUrl || 'https://infrax.0xainet.top';
    this.timeout = config.timeout || 30000;
    this.headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) this.headers['x-api-key'] = config.apiKey;
    if (config.dcApiKey) this.headers['x-dc-api-key'] = config.dcApiKey;
    // A-16: Bearer 鉴权（session-key-engine 等服务用 Authorization: Bearer）
    if (config.bearerToken) this.headers['authorization'] = `Bearer ${config.bearerToken}`;
  }

  async get<T>(path: string, headers?: Record<string, string>): Promise<InfraXResponse<T>> {
    const r = await this.fetch(path, { method: 'GET', headers });
    return r.json();
  }

  /** Raw GET — 返回裸 JSON（对接 @0xinfrax/payments 引擎：其响应非 InfraXResponse 包装） */
  async getRaw<T>(path: string, headers?: Record<string, string>): Promise<T> {
    const r = await this.fetch(path, { method: 'GET', headers });
    return r.json();
  }

  async post<T>(path: string, body?: any, headers?: Record<string, string>): Promise<InfraXResponse<T>> {
    const r = await this.fetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined, headers });
    return r.json();
  }

  /** Raw POST — 返回裸 JSON（对接 @0xinfrax/payments 引擎） */
  async postRaw<T>(path: string, body?: any, headers?: Record<string, string>): Promise<T> {
    const r = await this.fetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined, headers });
    return r.json();
  }

  /** POST + 状态/头元数据（market-rpc x402 门控等需要感知 HTTP 402 与 X-Payment-* 头的场景） */
  async postWithMeta<T = any>(path: string, body?: any, headers?: Record<string, string>) {
    const r = await this.fetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined, headers });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, headers: r.headers, body: json as T };
  }

  async patch<T>(path: string, body?: any, headers?: Record<string, string>): Promise<InfraXResponse<T>> {
    const r = await this.fetch(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined, headers });
    return r.json();
  }

  async put<T>(path: string, body?: any, headers?: Record<string, string>): Promise<InfraXResponse<T>> {
    const r = await this.fetch(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined, headers });
    return r.json();
  }

  async del<T>(path: string, headers?: Record<string, string>): Promise<InfraXResponse<T>> {
    const r = await this.fetch(path, { method: 'DELETE', headers });
    return r.json();
  }

  private async fetch(path: string, opts: { method: string; body?: string; headers?: Record<string, string> }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(this.baseUrl + path, { ...opts, headers: { ...this.headers, ...(opts.headers || {}) }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  setApiKey(key: string) { this.headers['x-api-key'] = key; }
  setDcApiKey(key: string) { this.headers['x-dc-api-key'] = key; }
}

// ═══════════════ Wallet — balances, send, simulate, RPC ═══════════════

export class WalletAPI {
  private readonly address: string;
  private readonly sign: ((message: string) => Promise<string>) | undefined;

  constructor(private http: HttpClient, config: InfraXConfig = {}) {
    this.address = config.walletAddress || '';
    this.sign = config.walletSign;
  }

  /** 生成 WAAS 钱包签名鉴权头；未配置 walletAddress/walletSign 时 fail-closed 抛错 */
  private async authHeaders(): Promise<Record<string, string>> {
    if (!this.address || !this.sign) {
      throw new Error('[infrax-sdk] walletAuth not configured: waas /api/v2/wallet|tx 端点要求钱包签名（x-wallet-address/x-wallet-signature/x-wallet-timestamp）。配置 InfraX({ walletAddress, walletSign }) 或改走 admin JWT。');
    }
    const ts = String(Date.now());
    const signature = await this.sign(`InfraX auth: ${ts}`);
    return { 'x-wallet-address': this.address, 'x-wallet-signature': signature, 'x-wallet-timestamp': ts };
  }

  async balance(params: WalletBalanceParams) { const q = new URLSearchParams(); q.set('address', params.address); if (params.chain) q.set('chain', params.chain); if (params.token) q.set('token', params.token); return this.http.get<WalletBalanceResult>('/api/v2/wallet/balance?' + q.toString(), await this.authHeaders()); }
  // MQ-2: 契约对齐 waas 真实端点（/api/v2/tx/*）
  async send(params: WalletSendParams) { return this.http.post<WalletSendResult>('/api/v2/tx/send', params, await this.authHeaders()); }
  async simulate(params: WalletSimulateParams) { return this.http.post<WalletSimulateResult>('/api/v2/tx/estimate-gas', params, await this.authHeaders()); }
  async health() { return this.http.get<{ status: string }>('/health'); }
  async rpc(params: WalletRpcParams) { return this.http.post<WalletRpcResult>('/api/v2/wallet/rpc', params, await this.authHeaders()); }
  async sweep(params: WalletSweepParams) { return this.http.post<any>('/api/v2/tx/sweep', params, await this.authHeaders()); }
  async txStatus(params: { txHash: string; chain?: string }) { return this.http.get<any>('/api/v2/tx/status/' + encodeURIComponent(params.txHash), await this.authHeaders()); }
}

// ═══════════════ Safe — multi-sig on-chain operations ═══════════════

export class SafeAPI {
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
  /** A-8: MPC 会话代签 confirm——以 MPC 邮箱会话 token 代替 EOA 签名确认多签交易 */
  async confirmMpc(params: { userId?: string; safeAddress: string; safeTxHash: string; mpcToken: string }) { return this.http.post<SafeConfirmResult & { signerAddress: string }>('/api/vault/safe/confirm-mpc', params); }
}

// ═══════════════ Payment — @0xinfrax/payments 通用支付引擎（MQ-15 T-8 迁移） ═══════════════
// 旧 :9106 /api/v2/payment/* 已下线；以下全部对接通用支付引擎 :9132 /payments/*。
// 鉴权：X-API-Key（= PAYMENTS_API_KEY）。引擎响应为裸 JSON，非 InfraXResponse 包装。

export class PaymentAPI {
  constructor(private http: HttpClient) {}

  /** fiat checkout（Stripe）——创建支付会话，返回跳转 URL */
  async checkout(params: PaymentCheckoutParams): Promise<PaymentCheckoutResult> {
    return this.http.postRaw<PaymentCheckoutResult>('/payments/checkout', params);
  }

  /** a2a 意图——创建一笔直接收款意图（后续链上支付 + a2aSettle 结算，或账本支付） */
  async a2a(params: A2ACreateParams): Promise<A2ACreateResult> {
    return this.http.postRaw<A2ACreateResult>('/payments/a2a', params);
  }

  /** a2a 结算——提交 payer 的链上 txHash，验证并记账（x402 rail 校验） */
  async a2aSettle(params: A2ASettleParams): Promise<A2ASettleResult> {
    return this.http.postRaw<A2ASettleResult>('/payments/a2a/settle', params);
  }

  /** 链上支付验证（x402 rail）——校验 tx 是否打到平台收款地址 */
  async verify(txHash: string, chain?: string): Promise<PaymentVerifyResult> {
    return this.http.postRaw<PaymentVerifyResult>('/payments/verify', { txHash, chain });
  }

  /** 账本余额查询（引擎 credit 账本） */
  async balance(address: string, asset?: string): Promise<PaymentBalanceResult> {
    return this.http.getRaw<PaymentBalanceResult>('/payments/balance?address=' + encodeURIComponent(address) + (asset ? '&asset=' + encodeURIComponent(asset) : ''));
  }

  /** 引擎能力探测——查看已启用 rail（chain/fiat/x402/period/batch/invite/transfer/...） */
  async capabilities(): Promise<PaymentCapabilitiesResult> {
    return this.http.getRaw<PaymentCapabilitiesResult>('/payments/capabilities');
  }

  /** 链上套餐定价（替代旧 x402/info） */
  async price(planId: number | string, chain?: string): Promise<PaymentPriceResult> {
    return this.http.getRaw<PaymentPriceResult>('/payments/price?planId=' + encodeURIComponent(String(planId)) + (chain ? '&chain=' + encodeURIComponent(chain) : ''));
  }

  // ── 旧方法兼容壳（签名保留；按 method 路由到新端点）──

  /** create：按 method 路由——fiat→checkout；chain/a2a→a2a（需 subscriber + valueWei） */
  async create(params: PaymentCreateParams): Promise<PaymentCreateResult> {
    const method = params.method || 'fiat';
    if (method === 'chain' || method === 'a2a') {
      if (!params.valueWei) throw new Error('[infrax-sdk] payment.create(method="chain"/"a2a") 需要 valueWei（wei）——或直接调用 payment.a2a()');
      const r = await this.a2a({ subscriber: params.subscriber, valueWei: params.valueWei, payee: params.payee, asset: params.asset, chain: params.chain, metadata: params.metadata });
      return { method: 'a2a', paymentId: r.paymentId, amount: r.amountWei, status: 'created' };
    }
    const amountCents = params.amount !== undefined ? Math.max(1, Math.round(Number(params.amount) * 100)) : undefined;
    const r = await this.checkout({ subscriber: params.subscriber, amountCents, planId: params.planId, currency: params.currency, chain: params.chain, metadata: params.metadata });
    return { method: 'fiat', paymentId: r.paymentId, amount: params.amount !== undefined ? String(params.amount) : '', status: 'created', sessionUrl: r.sessionUrl, sessionId: r.sessionId };
  }

  /** confirm：提交链上交易确认（→ a2a/settle；需 paymentId + txHash） */
  async confirm(paymentId: string, txHash: string, chain?: string): Promise<A2ASettleResult> {
    return this.a2aSettle({ paymentId, txHash, chain });
  }

  /** x402Info：旧 x402/info → 引擎链上套餐定价（需 planId） */
  async x402Info(planId: number | string, chain?: string): Promise<PaymentPriceResult> {
    return this.price(planId, chain);
  }

  // ── MQ-16：batch（一次性多 payee 批量收款）──

  /** 创建批量收款意图 */
  async batchCreate(params: BatchCreateParams): Promise<BatchCreateResult> {
    return this.http.postRaw<BatchCreateResult>('/payments/batch', params);
  }

  /** 结算 batch 中单个 item（提交该笔链上 txHash，x402 校验入账） */
  async batchSettle(params: BatchSettleParams): Promise<BatchSettleResult> {
    return this.http.postRaw<BatchSettleResult>('/payments/batch/settle', params);
  }

  /** 查询 batch 状态 */
  async batchGet(batchId: string): Promise<BatchGetResult> {
    return this.http.getRaw<BatchGetResult>('/payments/batch?batchId=' + encodeURIComponent(batchId));
  }

  /** 取消 batch（仅未支付 items） */
  async batchCancel(batchId: string): Promise<BatchCancelResult> {
    return this.http.postRaw<BatchCancelResult>('/payments/batch/cancel', { batchId });
  }

  // ── MQ-16：invites（账单邀请）──

  /** 创建账单邀请（payer → payee；payee 可链上结算或账本支付） */
  async inviteCreate(params: InviteCreateParams): Promise<InviteCreateResult> {
    return this.http.postRaw<InviteCreateResult>('/payments/invites', params);
  }

  /** 列出邀请（按 address + role=payer|payee，可选 status） */
  async inviteList(params: InviteListParams): Promise<InviteListResult> {
    return this.http.getRaw<InviteListResult>(
      '/payments/invites?address=' + encodeURIComponent(params.address) + '&role=' + params.role + (params.status ? '&status=' + encodeURIComponent(params.status) : '')
    );
  }

  /** 单个邀请详情 */
  async inviteGet(inviteId: string): Promise<InviteGetResult> {
    return this.http.getRaw<InviteGetResult>('/payments/invites/' + encodeURIComponent(inviteId));
  }

  /** 取消未结算邀请 */
  async inviteCancel(inviteId: string): Promise<InviteActionResult> {
    return this.http.postRaw<InviteActionResult>('/payments/invites/' + encodeURIComponent(inviteId) + '/cancel');
  }

  /** 链上结算邀请（提交 payer 的 txHash） */
  async inviteSettle(inviteId: string, txHash: string, chain?: string): Promise<InviteActionResult> {
    return this.http.postRaw<InviteActionResult>('/payments/invites/' + encodeURIComponent(inviteId) + '/settle', { txHash, chain });
  }

  /** 账本支付邀请（从 payer ledger 余额扣款结算） */
  async invitePay(inviteId: string): Promise<InviteActionResult> {
    return this.http.postRaw<InviteActionResult>('/payments/invites/' + encodeURIComponent(inviteId) + '/pay');
  }

  // ── MQ-16：transfers（账本内部转账）──

  /** 发起账本转账（需余额充足；confirm 后原子执行） */
  async transferCreate(params: TransferCreateParams): Promise<TransferCreateResult> {
    return this.http.postRaw<TransferCreateResult>('/payments/transfers', params);
  }

  /** 列出转账（按 address + role=from|to） */
  async transferList(params: TransferListParams): Promise<TransferListResult> {
    return this.http.getRaw<TransferListResult>(
      '/payments/transfers?address=' + encodeURIComponent(params.address) + '&role=' + params.role
    );
  }

  /** 单个转账详情 */
  async transferGet(transferId: string): Promise<TransferGetResult> {
    return this.http.getRaw<TransferGetResult>('/payments/transfers/' + encodeURIComponent(transferId));
  }

  /** 确认并执行转账（原子入账） */
  async transferConfirm(transferId: string): Promise<TransferConfirmResult> {
    return this.http.postRaw<TransferConfirmResult>('/payments/transfers/' + encodeURIComponent(transferId) + '/confirm');
  }

  /** 取消未执行转账 */
  async transferCancel(transferId: string): Promise<TransferCancelResult> {
    return this.http.postRaw<TransferCancelResult>('/payments/transfers/' + encodeURIComponent(transferId) + '/cancel');
  }
}

// ═══════════════ SaaS — tenant management, billing, apikeys ═══════════════

export class SaaSAPI {
  constructor(private http: HttpClient) {}
  async createTenant(params: TenantCreateParams) { return this.http.post<TenantCreateResult>('/api/v2/saas/tenants', params); }
  async listTenants() { return this.http.get<any>('/api/v2/saas/tenants'); }
  async getTenant(tenantId: string) { return this.http.get<any>('/api/v2/saas/tenants/' + tenantId); }
  async updateTenant(tenantId: string, params: any) { return this.http.patch<any>('/api/v2/saas/tenants/' + tenantId, params); }
  async deleteTenant(tenantId: string) { return this.http.del<any>('/api/v2/saas/tenants/' + tenantId); }
  async createApiKey(tenantId: string) { return this.http.post<any>('/api/v2/saas/tenants/' + tenantId + '/apikey', {}); }
  async rotateApiKey(tenantId: string) { return this.http.post<ApiKeyRotateResult>('/api/v2/saas/tenants/' + tenantId + '/apikey/rotate', {}); }
  async deleteApiKey(tenantId: string) { return this.http.del<any>('/api/v2/saas/tenants/' + tenantId + '/apikey'); }
}

// ═══════════════ Subscription — plans, subscribe, cancel ═══════════════

export class SubAPI {
  constructor(private http: HttpClient) {}
  async plans() { return this.http.get<any>('/api/v2/subscription/plans'); }
  async current() { return this.http.get<any>('/api/v2/subscription/me'); }
  async subscribe(planId: string) { return this.http.post<any>('/api/v2/subscription/subscribe', { planId }); }
  async cancel() { return this.http.post<any>('/api/v2/subscription/cancel'); }
}

// ═══════════════ DC — events, tokens, chains, checkpoints ═══════════════

export class DCAPI {
  constructor(private http: HttpClient) {}
  async events(params: DCEventsParams = {}) { const q = new URLSearchParams(); if (params.chain) q.set('chain', params.chain); if (params.address) q.set('address', params.address); if (params.contract) q.set('contract', params.contract); if (params.eventType) q.set('event_type', params.eventType); if (params.fromBlock) q.set('from_block', params.fromBlock); if (params.limit) q.set('page_size', String(params.limit)); return this.http.get<any>('/api/v2/data/events?' + q.toString()); }
  /** 跨链余额查询（address 必填，chain 可选过滤；返回 chainBalances + total，2026-08-12 补封装） */
  async balance(params: { address: string; chain?: string }) { const q = new URLSearchParams(); q.set('address', params.address); if (params.chain) q.set('chain', params.chain); return this.http.get<any>('/api/v2/data/balance?' + q.toString()); }
  async stats() { return this.http.get<DCStatsResult>('/api/v2/data/stats'); }
  async checkpoints(chain?: string) { return this.http.get<any>('/api/v2/data/checkpoints' + (chain ? '?chain=' + chain : '')); }
  async plans() { return this.http.get<any>('/api/v2/data/plans'); }
  async tokens(params: { symbol?: string; chain?: string } = {}) { const q = new URLSearchParams(); if (params.symbol) q.set('symbol', params.symbol); if (params.chain) q.set('chain', params.chain); return this.http.get<DCToken[]>('/api/v2/data/tokens?' + q.toString()); }
  async chains() { return this.http.get<DCChain[]>('/api/v2/data/chains'); }
  // ── MQ-16 套餐订阅面（/api/v2/data/*；均需 x-wallet-address header，信封响应）──
  /** 订阅数据套餐（付费套餐返回 pending + payment 意图；免费套餐直接激活并返回 dcApiKey） */
  async subscribe(params: DCSubscribeParams, walletAddress: string) { return this.http.post<DCSubscribeResult>('/api/v2/data/subscribe', { planId: params.planId, rail: params.rail }, { 'x-wallet-address': walletAddress }); }
  /** 轮询支付状态（chain rail 链上确认） */
  async paymentCheck(walletAddress: string) { return this.http.post<DCPaymentCheckResult>('/api/v2/data/payment-check', {}, { 'x-wallet-address': walletAddress }); }
  /** x402 支付确认——提交 txHash，payer 匹配当前钱包后激活订阅 */
  async verify(txHash: string, walletAddress: string) { return this.http.post<DCVerifyResult>('/api/v2/data/verify', { txHash }, { 'x-wallet-address': walletAddress }); }
  /** 订阅用量（含 dcApiKey / 月度配额 / 日聚合） */
  async usage(walletAddress: string) { return this.http.get<DCUsageResult>('/api/v2/data/usage', { 'x-wallet-address': walletAddress }); }
}

// ═══════════════ Vault — multisig safe creation + risk ═══════════════

export class VaultAPI {
  constructor(private http: HttpClient) {}
  async dashboard() { return this.http.get<any>('/api/vault/dashboard'); }
  async safes(params: VaultSafeParams = {}) { const q = new URLSearchParams(); if (params.chain) q.set('chain', params.chain); if (params.status) q.set('status', params.status); return this.http.get<VaultSafe[]>('/api/vault/safe/list?' + q.toString()); }
  async safeInfo(safeId: string) { return this.http.get<VaultSafe>('/api/vault/safe/' + encodeURIComponent(safeId)); }
  async createSafe(params: VaultCreateSafeParams) { return this.http.post<VaultSafe>('/api/vault/safe/create', params); }
  async createTransaction(params: VaultCreateTxParams) { return this.http.post<VaultTransaction>('/api/vault/safe/propose', params); }
  async riskCheck(params: { to: string; amount?: string; chain?: string }) { return this.http.post<any>('/api/vault/risk/check', params); }
}

// ═══════════════ MPC — key shard wallets ═══════════════

export class MPCAPI {
  constructor(private http: HttpClient) {}
  async sendCode(params: MPCSendCodeParams) { return this.http.post<any>('/api/v2/mpc/send-code', params); }
  async register(params: MPCRegisterParams) { return this.http.post<MPCWalletResult>('/api/v2/mpc/register', params); }
  async recover(params: MPCRegisterParams) { return this.http.post<MPCWalletResult>('/api/v2/mpc/recover', params); }
  // MQ-7: status 支持 email 或 walletAddress（mpc server 双查询键）
  async status(params: MPCStatusParams) {
    const q = new URLSearchParams();
    if (params.walletAddress) q.set('walletAddress', params.walletAddress);
    else if (params.email) q.set('email', params.email);
    return this.http.get<MPCStatusResult>('/api/v2/mpc/status?' + q.toString());
  }
  async createWallet(params: MPCSendCodeParams) { const s1 = await this.sendCode(params); if (s1.code !== 0) return s1; return { code: 0, message: 'Verification code sent. Call mpc.register() to complete.', email: params.email }; }
  // ── Session（MQ-7）──
  async unlockSession(params: MPCSessionUnlockParams) { return this.http.post<MPCSessionUnlockResult>('/api/v2/mpc/session/unlock', params); }
  async lockSession(token: string) { return this.http.post<{ locked: boolean }>('/api/v2/mpc/session/lock', { token }); }
  async sessionStatus(params: MPCSessionStatusParams) { return this.http.get<MPCSessionStatusResult>('/api/v2/mpc/session/status?token=' + encodeURIComponent(params.token)); }
  // ── 链上操作（MQ-7）──
  async balance(params: MPCBalanceParams) { return this.http.post<MPCBalanceResult>('/api/v2/mpc/balance', params); }
  async signMessage(params: MPCSignMessageParams) { return this.http.post<MPCSignResult>('/api/v2/mpc/sign-message', params); }
  async signTypedData(params: MPCSignTypedDataParams) { return this.http.post<MPCSignResult>('/api/v2/mpc/sign-typed-data', params); }
  async sendTransaction(params: MPCSendTransactionParams) { return this.http.post<MPCSendTransactionResult>('/api/v2/mpc/send-transaction', params); }
  async contractRead(params: MPCContractReadParams) { return this.http.post<MPCContractReadResult>('/api/v2/mpc/contract-read', params); }
  async contractWrite(params: MPCContractWriteParams) { return this.http.post<MPCContractWriteResult>('/api/v2/mpc/contract-write', params); }
  async gasEstimate(params: MPCGasEstimateParams = {}) { return this.http.post<MPCGasEstimateResult>('/api/v2/mpc/gas-estimate', params); }
  // ── MQ-16 计费面（T-4）──
  /** 套餐价目（公开；pay-per-use 模式 + 平台钱包 + 按次费率表） */
  async plans() { return this.http.get<MpcPlansResult>('/api/v2/mpc/plans'); }
  /** ledger 余额查询（引擎统一账本；区别于链上 /balance） */
  async ledgerBalance(token: string) { return this.http.post<MpcLedgerBalanceResult>('/api/v2/mpc/ledger-balance', { token }); }
  /** raw 32-byte digest 签名（E-1d；TSS 或单钥路径，2026-08-12 补封装） */
  async signDigest(params: MPCSignDigestParams) { return this.http.post<MPCSignResult>('/api/v2/mpc/sign-digest', params); }
}

// ═══════════════ Market — OKX ChainOS v6 DEX Market ═══════════════

export class MarketAPI {
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

  // ── MQ-16 订阅面（/api/v2/market/*；X-API-Key 鉴权，信封响应）──

  /** 套餐目录（公开） */
  async plans() { return this.http.get<MarketPlan[]>('/api/v2/market/plans'); }

  /** 发起订阅支付（plan_id + rail + 可选 subscriber；X-API-Key 识别 keyId） */
  async checkout(params: MarketCheckoutParams) { return this.http.post<MarketCheckoutResult>('/api/v2/market/checkout', params); }

  /** 轮询支付状态（chain rail 链上确认） */
  async paymentCheck(body?: { subscriber?: string }) { return this.http.post<MarketPaymentCheckResult>('/api/v2/market/payment-check', body ?? {}); }

  /** x402 支付确认——提交 txHash 激活 pending x402 订阅 */
  async verify(txHash: string) { return this.http.post<MarketVerifyResult>('/api/v2/market/verify', { txHash }); }

  /** 订阅用量（月度配额 / 实际用量 / 日聚合） */
  async usage() { return this.http.get<MarketUsageResult>('/api/v2/market/usage'); }

  // ── DEX 策略数据（/api/v2/data/market/dex/*，2026-08-21 上线；数据层 R1-R10）──

  /** 热门代币统一榜（R1+R1b）— OKX 热度榜（trending=volume / x_mentions=txs）+ DexScreener 新币榜 */
  async dexHotTokens(params: { source?: 'all' | 'okx' | 'dexscreener'; chain?: string; ranking?: 'trending' | 'x_mentions'; limit?: number } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) { if (v !== undefined && v !== '') q.set(k, String(v)); }
    return this.http.get<any>('/api/v2/data/market/dex/hot-tokens?' + q.toString());
  }

  /** 单币画像（R2+R3+R4）— 行情 + 社交热度 + 风险 + 池明细 + 持有者 */
  async dexToken(chain: string, tokenAddress: string) {
    return this.http.get<any>(`/api/v2/data/market/dex/token?chain=${chain}&address=${encodeURIComponent(tokenAddress)}`);
  }

  /** 单币历史序列（画像快照 5min 粒度：价格/多时间窗/市值/持有者/ATH/ATL，2026-08-21 新增） */
  async dexTokenHistory(chain: string, tokenAddress: string, hours = 24) {
    return this.http.get<any>(`/api/v2/data/market/dex/token/history?chain=${chain}&address=${encodeURIComponent(tokenAddress)}&hours=${hours}`);
  }

  /** 合并搜索（OKX + DexScreener；OKX 搜索为付费端点时自动降级为空） */
  async dexSearch(keyword: string, chain?: string, limit?: number) {
    const q = new URLSearchParams({ keyword });
    if (chain) q.set('chain', chain);
    if (limit) q.set('limit', String(limit));
    return this.http.get<any>('/api/v2/data/market/dex/search?' + q.toString());
  }

  /** 巨鲸/聪明钱信号（R5） */
  async dexSignals(chain?: string, limit?: number) {
    const q = new URLSearchParams();
    if (chain) q.set('chain', chain);
    if (limit) q.set('limit', String(limit));
    return this.http.get<any>('/api/v2/data/market/dex/signal?' + q.toString());
  }

  /** 持有者结构（R6） */
  async dexHolders(chain: string, tokenAddress: string, limit?: number) {
    let path = `/api/v2/data/market/dex/holders?chain=${chain}&address=${encodeURIComponent(tokenAddress)}`;
    if (limit) path += `&limit=${limit}`;
    return this.http.get<any>(path);
  }

  /** 流动性池/深度（R7）— OKX top-liquidity 付费时降级为 DexScreener 池 */
  async dexLiquidity(chain: string, tokenAddress: string) {
    return this.http.get<any>(`/api/v2/data/market/dex/liquidity?chain=${chain}&address=${encodeURIComponent(tokenAddress)}`);
  }

  /** 顶级交易者（R8） */
  async dexTopTraders(chain: string, tokenAddress: string) {
    return this.http.get<any>(`/api/v2/data/market/dex/top-traders?chain=${chain}&address=${encodeURIComponent(tokenAddress)}`);
  }

  /** 交易历史（R8）— OKX Premium 付费端点，免费 key 返回 {items:[], paymentRequired:true} */
  async dexTrades(chain: string, tokenAddress: string, limit?: number) {
    let path = `/api/v2/data/market/dex/trades?chain=${chain}&address=${encodeURIComponent(tokenAddress)}`;
    if (limit) path += `&limit=${limit}`;
    return this.http.get<any>(path);
  }
}

// ═══════════════ MarketRpc — 行情数据 RPC（A-12/13：/v1/market-rpc，与 REST MarketAPI 同源同缓存） ═══════════════
// 12 组方法 + 多 token 批量（tokens 数组）+ 信封 {code,message,data}；rx_ 读 key 鉴权。
// 同源同缓存：与 MarketAPI 走同一 HttpClient（同 collector 实例），口径一致。
// x402 门控（A-12，2026-08-16）：匿名调用 tokenSearch/tokenInfo/price/candles →
// HTTP 402 + X-Payment-* 头；SDK 抛 X402RequiredError（携带支付清单），调用方接入 x402 支付后
// 回放请求携带 X-Payment-Order-Id 放行。

export class X402RequiredError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly resource: string,
    public readonly amount: string,
    public readonly network: string,
    public readonly payTo: string,
    public readonly verifyUrl: string,
    message: string,
  ) {
    super(message);
    this.name = "X402RequiredError";
  }
}

export interface MarketRpcTokenParams {
  chainIndex?: string;
  /** 单 token */
  tokenAddress?: string;
  /** 多 token 批量（tokenInfo/price/candles 支持；返回 [{tokenAddress,data},...] 保序） */
  tokens?: string[];
  limit?: number;
  period?: string;
  keyword?: string;
  leaderboardType?: string;
  signalType?: string;
  protocol?: string;
  sortBy?: string;
  address?: string;
  chains?: string[] | string;
  chain?: string;
  enabled?: boolean;
  [key: string]: any;
}
export interface MarketRpcBatchItem<T = any> { tokenAddress: string; data: T; }

export class MarketRpcAPI {
  constructor(private http: HttpClient) {}

  /** 通用调用（method 见下方类型化方法）。遇 x402 门控（HTTP 402）抛 X402RequiredError */
  async call<T = any>(method: string, params: Record<string, any> = {}) {
    const res = await this.http.postWithMeta<InfraXResponse<T>>("/v1/market-rpc", { method, params });
    if (res.status === 402) {
      const h = (k: string) => (res.headers.get ? res.headers.get(k) || "" : "");
      const err = res.body as any;
      throw new X402RequiredError(
        h("x-payment-order-id"),
        h("x-payment-resource"),
        h("x-payment-amount"),
        h("x-payment-network"),
        h("x-payment-payto"),
        h("x-payment-verify-url"),
        err?.message || "x402 payment required",
      );
    }
    return res.body;
  }

  async tokenSearch(params: { keyword: string; chainIndex?: string; limit?: number }) {
    return this.call<any[]>('tokenSearch', params);
  }
  async tokenInfo(params: { chainIndex: string; tokenAddress?: string; tokens?: string[] }) {
    return this.call<any>('tokenInfo', params);
  }
  async hotTokens(params: MarketRpcTokenParams) {
    return this.call<any[]>('hotTokens', params);
  }
  async leaderboard(params: { chainIndex: string; leaderboardType?: string; limit?: number }) {
    return this.call<any[]>('leaderboard', params);
  }
  async signals(params: { chainIndex: string; signalType?: string; limit?: number }) {
    return this.call<any[]>('signals', params);
  }
  async mempump(params: { chainIndex: string; protocol?: string; sortBy?: string; limit?: number }) {
    return this.call<any[]>('mempump', params);
  }
  async candles(params: { chainIndex: string; tokenAddress?: string; tokens?: string[]; period?: string; limit?: number }) {
    return this.call<any>('candles', params);
  }
  async price(params: { chainIndex: string; tokenAddress?: string; tokens?: string[] }) {
    return this.call<any>('price', params);
  }
  async balances(params: { address: string; chains?: string[] | string }) {
    return this.call<any[]>('balances', params);
  }
  async transactions(params: { address: string; chains?: string[] | string; limit?: number }) {
    return this.call<any[]>('transactions', params);
  }
  async trackedTokens(params: { chain?: string; enabled?: boolean } = {}) {
    return this.call<any[]>('trackedTokens', params);
  }
  async customSigs(params: { chain?: string; enabled?: boolean } = {}) {
    return this.call<any[]>('customSigs', params);
  }
}

// ═══════════════ Data — InfraX data service (:9112) market data plane ═══════════════
// 覆盖 data 服务数据面端点：K线 / ticker / 因子 / 快照（含 onchain/okx 快照）/
// 符号搜索解析 / 统计。响应为 data 服务原始 JSON（成功时非 {code,message,data} 信封）。

export class DataAPI {
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

  /** 最新因子值（symbols 逗号分隔；category 过滤）。顶层含 ml_factory（挖掘因子，与 category 无关） */
  async factorsCurrent(params: DataFactorCurrentParams = {}) {
    const q = new URLSearchParams();
    if (params.symbols) q.set('symbols', params.symbols);
    if (params.category) q.set('category', params.category);
    return this.http.get<{
      ts: number;
      factors: Record<string, any>;
      ml_factory?: DataMlFactoryResult;
    }>('/factors/current?' + q.toString());
  }

  /** 因子工厂挖掘因子：激活因子列表 + 各 symbol 实时值（FF-3.3/3.4）
   *  返回 {updated_at, factors: [key...], values: {SYMBOL: {key: val}}} */
  async mlFactory(symbols = 'BTC') {
    return this.http.get<DataMlFactoryResult>('/factors/current?' + new URLSearchParams({ symbols }).toString());
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

// ═══════════════ ML — ml-service (:9120) 实时推理 ═══════════════
// 覆盖 ml-service 重计算端点（2026-08 起统一 dict + 聚合指标）。
// 语义：结果走 TTL 缓存（ML_CACHE_TTL_SEC 默认 1800s）+ 后台异步计算 + 周期预热；
// 缓存 miss / 模型不可用 / 数据不足时 **data=null 属预期行为**（非故障）。
// 推荐路径：优先读 data 侧快照 infrax.data.mlPredictions()；实时性优先才直连本命名空间。
// /ml/cache/stats 免鉴权；其余端点带 mlApiKey（x-api-key）。

export class MlAPI {
  constructor(private http: HttpClient) {}

  /** LightGBM 方向预测（训练+预测全 symbol，附 macro_context） */
  async treePredictions() {
    return this.http.get<MlUnifiedResult>('/ml/tree_predictions');
  }

  /** Kronos 波动率预测（统一结构，聚合键 avg_volatility_score） */
  async volatility() {
    return this.http.get<MlUnifiedResult>('/ml/volatility');
  }

  /** Chronos-Bolt 单变量概率预测（P2，聚合键 avg_prob_up） */
  async bolt() {
    return this.http.get<MlUnifiedResult>('/ml/bolt');
  }

  /** Moirai 2.0 多变量跨资产预测（P2） */
  async moirai() {
    return this.http.get<MlUnifiedResult>('/ml/moirai');
  }

  /** TimesFM 2.5 长上下文点预测（P2） */
  async timesfm() {
    return this.http.get<MlUnifiedResult>('/ml/timesfm');
  }

  /** 跨模型信号共识（tree+Kronos+FinBERT+P2） */
  async consensus() {
    return this.http.get<MlUnifiedResult>('/ml/consensus');
  }

  /** FRED 宏观特征 + DXY/VIX/US10Y 快照 */
  async macroFeatures() {
    return this.http.get<any>('/ml/macro_features');
  }

  /** FinBERT 新闻文本情绪（POST articles） */
  async sentiment(params: MlSentimentParams) {
    return this.http.post<any>('/ml/sentiment', params);
  }

  /** 端点缓存统计（免鉴权）：total hits/misses + 各端点 cached/expires_in/last_compute_ms */
  async cacheStats() {
    return this.http.get<any>('/ml/cache/stats');
  }
}

// ═══════════════ ChainRpc — chain-rpc 网关 (:9130) 链上读 + 广播 ═══════════════
// MQ-10：全仓唯一链上 RPC 网关（与 WAAS 解耦）。所有中心化服务统一走该网关
// 读取链上数据 / 广播已签名交易；网关不持有任何私钥。
// 读端点带 chainRpcApiKey（x-api-key）；广播端点独立携带 chainRpcBroadcastKey
// （服务端签发、读端点拒绝；未配置时 broadcast() fail-closed 明确报错）。

export interface ChainRpcReadParams { chain: string; method: string; params?: any[]; }
export interface ChainRpcReadResult { chain: string; method: string; result: any; }
export interface ChainRpcBroadcastParams { chain: string; rawTransaction: string; wait?: boolean; timeoutMs?: number; }
export interface ChainRpcBroadcastResult {
  chain: string;
  txHash: string;
  confirmed: boolean;
  receipt: any | null;
  reason?: string;
}
// ChainRpc — MQ-16 订阅面（/v1/subscription/*；rx_ key 经 x-api-key/x-rpc-key 鉴权，信封 {code,message,data}）
export interface RpcPlan { id: string; name: string; price: number; features?: Record<string, any>; }
export interface RpcIssueKeyResult { keyId: number; rpcKey: string; planId: string; status: string; note: string; }
export interface RpcCheckoutParams { plan_id: string; rail?: string; subscriber?: string; }
export interface RpcCheckoutResult { keyId: number; plan: { id: string; name: string; price: number }; rpcSubStatus: string; payment?: any; free?: boolean; }
export interface RpcPaymentCheckResult { status: string; }
export interface RpcVerifyParams { txHash: string; }
export interface RpcVerifyResult { verified: boolean; activated?: boolean; }
export interface RpcUsageResult { planId: string; planName: string; monthlyQuota: number; currentUsage: number; dailyBreakdown: any[]; rpcSubStatus: string; }

export class ChainRpcAPI {
  private readonly broadcastKey: string;
  constructor(private http: HttpClient, private broadcastHttp: HttpClient, broadcastKey: string) {
    this.broadcastKey = broadcastKey;
  }

  /** 通用链上读调用（方法走白名单：eth_* 读方法 / solana get*） */
  async call(params: ChainRpcReadParams) {
    return this.http.post<ChainRpcReadResult>(`/v1/rpc/${encodeURIComponent(params.chain)}`, {
      method: params.method,
      params: params.params || [],
    });
  }

  /** 交易广播（rawTransaction 为调用方已签名数据；wait=true 时轮询回执）。
   *  需配置 chainRpcBroadcastKey（广播 key）；未配置时明确报错，
   *  不会用读 key 打广播端点（读 key 无法触达 /v1/broadcast）。 */
  async broadcast(params: ChainRpcBroadcastParams) {
    if (!this.broadcastKey) {
      throw new Error(
        '[infrax-sdk] chainRpcBroadcastKey not configured: broadcast requires the server-issued broadcast key (read key cannot reach /v1/broadcast). Set chainRpcBroadcastKey or call POST /v1/broadcast/:chain directly with X-Service-Key.'
      );
    }
    return this.broadcastHttp.post<ChainRpcBroadcastResult>(
      `/v1/broadcast/${encodeURIComponent(params.chain)}`,
      { rawTransaction: params.rawTransaction, wait: params.wait, timeoutMs: params.timeoutMs }
    );
  }

  /** 池状态（脱敏：端点 key/status，不含 url） */
  async status() {
    return this.http.get<any>('/v1/status');
  }

  /** 服务健康 */
  async health() {
    return this.http.get<any>('/health');
  }

  // ── MQ-16 订阅面（/v1/subscription/*；rx_ key 经 x-api-key / x-rpc-key 鉴权，信封 {code,message,data}）──

  /** 套餐目录（公开） */
  async subscriptionPlans() {
    return this.http.get<RpcPlan[]>('/v1/subscription/plans');
  }

  /** 签发 rx_ 读 key（管理操作；x-api-key 需为服务端 X-Service-Key/bridge key） */
  async issueRpcKey(label?: string) {
    return this.http.post<RpcIssueKeyResult>('/v1/subscription/issue-key', { label });
  }

  /** 发起订阅支付（plan_id + rail + 可选 subscriber；rx_ key 鉴权） */
  async subscriptionCheckout(params: RpcCheckoutParams) {
    return this.http.post<RpcCheckoutResult>('/v1/subscription/checkout', params);
  }

  /** 轮询支付状态（chain rail 链上确认） */
  async subscriptionPaymentCheck(body?: { subscriber?: string }) {
    return this.http.post<RpcPaymentCheckResult>('/v1/subscription/payment-check', body ?? {});
  }

  /** x402 支付确认——提交 txHash 激活 pending x402 订阅 */
  async subscriptionVerify(txHash: string) {
    return this.http.post<RpcVerifyResult>('/v1/subscription/verify', { txHash });
  }

  /** 订阅用量（月度配额 / 实际用量 / 日聚合） */
  async subscriptionUsage() {
    return this.http.get<RpcUsageResult>('/v1/subscription/usage');
  }
}

// ═══════════════ Dex — chain-rpc /v1/dex-rpc DEX 交易执行（A-11） ═══════════════
// A-11：聚合报价 / approve / swap 构建（只构建待签名 rawTransaction，无 sign 端点）。
// 鉴权分级：quote=读 key（chainRpcApiKey）；approve/swap=广播 key（chainRpcBroadcastKey，
// 未配置时 fail-closed 明确报错）。rawTransaction 由调用方签名后交 ChainRpcAPI.broadcast 广播。

export interface DexQuoteParams {
  chain: string;
  tokenIn: string;
  tokenOut: string;
  /** 输入数量（wei，纯数字字符串） */
  amountIn: string;
  /** 滑点容忍度，如 0.005 = 0.5% */
  slippage?: number;
  /** 交易发起地址（聚合器路由参考，可不传） */
  from?: string;
}
export interface DexQuoteResult {
  chain: string;
  aggregator: 'okx' | '1inch';
  amountOut: string;
  minAmountOut: string;
  priceImpact?: number;
  fee?: string;
  route?: any;
}
export interface DexApproveParams {
  chain: string;
  token: string;
  spender: string;
  /** 授权额度；不传/0 → max uint256 */
  amount?: string;
  from?: string;
}
export interface DexRawTransaction {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit?: string;
  estimated?: boolean;
}
export interface DexApproveResult {
  chain: string;
  rawTransaction: DexRawTransaction;
  from: string | null;
}
export interface DexSwapParams {
  chain: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage?: number;
  from?: string;
  recipient?: string;
}
export interface DexSwapResult {
  chain: string;
  rawTransaction: DexRawTransaction;
  aggregator: 'okx' | '1inch';
  amountOutMin: string;
}

export class DexAPI {
  private readonly broadcastKey: string;
  constructor(private http: HttpClient, private broadcastHttp: HttpClient, broadcastKey: string) {
    this.broadcastKey = broadcastKey;
  }

  /** 聚合报价（读 key）：OKX DEX Aggregator 首选，1inch 回退；返回信封 {code,message,data} */
  async quote(params: DexQuoteParams) {
    return this.http.post<DexQuoteResult>('/v1/dex-rpc', { method: 'dex.quote', params });
  }

  /** 构建 ERC20 approve 待签名交易（广播 key；amount 空/0 → max uint256） */
  async approve(params: DexApproveParams) {
    this.requireBroadcastKey('dex.approve');
    return this.broadcastHttp.post<DexApproveResult>('/v1/dex-rpc', { method: 'dex.approve', params });
  }

  /** 构建 swap 待签名交易（广播 key；聚合器路由 + gasLimit 预估，超上限 400 拒绝） */
  async swap(params: DexSwapParams) {
    this.requireBroadcastKey('dex.swap');
    return this.broadcastHttp.post<DexSwapResult>('/v1/dex-rpc', { method: 'dex.swap', params });
  }

  private requireBroadcastKey(method: string): void {
    if (!this.broadcastKey) {
      throw new Error(
        `[infrax-sdk] chainRpcBroadcastKey not configured: ${method} requires the server-issued broadcast key (read key cannot build dex transactions). Set chainRpcBroadcastKey or call POST /v1/dex-rpc directly with X-Service-Key.`
      );
    }
  }
}

// ═══════════════ SessionKey — session-key-engine 托管实例（A-15/16/17/18） ═══════════════
// 消费端仅配 sessionKeyUrl（SESSION_KEY_ENGINE_URL）+ sessionKeyApiKey（sdk_ 前缀 Bearer，
// SESSION_KEY_API_KEY）。/health、/nonce 公开；/sessions、/execute 需 Bearer（A-18 端点隔离）。
// 响应复用信封 {code,message,data}（与 session-key-engine 一致）。

export interface SessionKeyNonceData { nonce: string; message: string; }
export interface SessionKeyPermissionConfig { contracts: string[]; functions?: string[]; }
export interface SessionKeyCreateParams {
  signature: string;
  chain: string;
  permissions: SessionKeyPermissionConfig;
  validDays?: number;
  maxPerTx?: string;
  maxTotal?: string;
  userAddress: string;
  nonce: string;
  /** A-16：session key 由客户端本地生成并提交。流程：generatePrivateKey() → privateKeyToAccount(pk)
   *  → 用 account.address（即 sessionAddress）对 sessionAuthTypedData 签名 → createSession 提交公/私钥。
   *  服务端校验私钥派生地址 === 公钥后加密存储（私钥永不出现在响应中）。 */
  sessionPublicKey: string;
  sessionPrivateKey: string;
  /** EIP-712 签名时使用的 validUntil（unix 秒），需与 sessionAuthTypedData 传入值一致。
   *  省略时服务端按 validDays 自行计算（时钟竞态偶发风险）；建议显式传入。 */
  validUntil?: number;
}
export interface SessionKeyInfo {
  id: string;
  sessionAddress: string;
  chain: string;
  status: string;
  validUntil: string;
  userAddress?: string;
  maxPerTx?: string;
  maxTotal?: string;
  totalSpent?: string;
  permissions?: SessionKeyPermissionConfig;
}
export interface SessionKeyExecuteParams {
  sessionId: string;
  chain: string;
  to: string;
  data: string;
  value?: string;
  gasLimit?: string;
}
export interface SessionKeyExecuteResult {
  executionId: string;
  userOpHash: string | null;
  txHash: string;
  status: 'success' | 'failed';
  blockNumber: number | null;
  gasUsed?: string;
  errorReason?: string;
}

// ── A-16: EIP-712 域参数内置（与服务端 verifySessionAuthSignature 同构） ──
export const SESSION_KEY_EIP712_DOMAIN_NAME = 'Session Key Engine';
export const SESSION_KEY_EIP712_VERSION = '1';
export const SESSION_KEY_CHAIN_IDS: Record<string, number> = {
  eth: 1, bsc: 56, base: 8453, polygon: 137,
  arbitrum: 42161, optimism: 10, xlayer: 196,
};
/** 链 → EIP-712 域（name/version/chainId；verifyingContract 由消费方按自有合约补填） */
export function sessionKeyDomain(chain: string, verifyingContract?: string): {
  name: string; version: string; chainId: number; verifyingContract?: string;
} {
  return {
    name: SESSION_KEY_EIP712_DOMAIN_NAME,
    version: SESSION_KEY_EIP712_VERSION,
    chainId: SESSION_KEY_CHAIN_IDS[chain] ?? 0,
    ...(verifyingContract ? { verifyingContract } : {}),
  };
}
/** 构建 SessionAuth EIP-712 待签名数据（零依赖，返回结构可直接交 ethers/viem signTypedData） */
export function sessionAuthTypedData(params: {
  chain: string;
  nonce: string;
  sessionAddress: string;
  permissions: SessionKeyPermissionConfig;
  validUntil: number;
  maxPerTx: string;
  maxTotal: string;
}) {
  return {
    domain: sessionKeyDomain(params.chain),
    types: {
      SessionAuth: [
        { name: 'nonce', type: 'string' },
        { name: 'sessionAddress', type: 'address' },
        { name: 'contracts', type: 'string' },
        { name: 'validUntil', type: 'uint256' },
        { name: 'maxPerTx', type: 'uint256' },
        { name: 'maxTotal', type: 'uint256' },
      ],
    },
    primaryType: 'SessionAuth' as const,
    message: {
      nonce: params.nonce,
      sessionAddress: params.sessionAddress as `0x${string}`,
      contracts: JSON.stringify(params.permissions.contracts),
      validUntil: BigInt(params.validUntil),
      maxPerTx: BigInt(params.maxPerTx),
      maxTotal: BigInt(params.maxTotal),
    },
  };
}

export class SessionKeyAPI {
  constructor(private http: HttpClient) {}

  /** 一次性 nonce（公开端点；EIP-712 防重放，消费即失效） */
  async getNonce(userAddress: string) {
    return this.http.get<SessionKeyNonceData>(`/api/v1/nonce?user=${encodeURIComponent(userAddress)}`);
  }
  /** 创建 session（Bearer；signature 由用户对 sessionAuthTypedData 签名） */
  async createSession(params: SessionKeyCreateParams) {
    return this.http.post<SessionKeyInfo>('/api/v1/sessions', params);
  }
  async listSessions(userAddress: string, chain?: string, status?: string) {
    const q = new URLSearchParams({ user: userAddress });
    if (chain) q.set('chain', chain);
    if (status) q.set('status', status);
    return this.http.get<{ sessions: SessionKeyInfo[] }>(`/api/v1/sessions?${q.toString()}`);
  }
  async getSession(id: string) {
    return this.http.get<SessionKeyInfo>(`/api/v1/sessions/${encodeURIComponent(id)}`);
  }
  /** 撤销（立即生效：服务端置 revoked，execute 拒绝） */
  async revokeSession(id: string) {
    return this.http.del<{ revoked: boolean }>(`/api/v1/sessions/${encodeURIComponent(id)}`);
  }
  /** 执行（Bearer；服务端限额硬校验 + 全程审计） */
  async execute(params: SessionKeyExecuteParams) {
    return this.http.post<SessionKeyExecuteResult>('/api/v1/execute', params);
  }
  /** A-17: execute 明细（含 blockNumber/调用方掩码/限额快照） */
  async getExecution(id: string) {
    return this.http.get<any>(`/api/v1/execute/${encodeURIComponent(id)}`);
  }
  async health() {
    return this.http.get<{ status: string }>('/api/v1/health');
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
  readonly marketRpc: MarketRpcAPI;
  readonly data: DataAPI;
  readonly ml: MlAPI;
  readonly chainRpc: ChainRpcAPI;
  readonly dex: DexAPI;
  readonly sessionKey: SessionKeyAPI;

  private http: HttpClient;

  constructor(config: InfraXConfig = {}) {
    this.http = new HttpClient(config);
    this.wallet = new WalletAPI(this.http, config);
    this.safe = new SafeAPI(this.http);
    // 通用支付引擎独立 baseUrl（paymentsUrl 优先，回退 baseUrl）+ 独立 key（paymentsApiKey 优先，回退 apiKey）
    this.payment = new PaymentAPI(new HttpClient({
      ...config,
      baseUrl: config.paymentsUrl || config.baseUrl,
      apiKey: config.paymentsApiKey || config.apiKey,
    }));
    this.saas = new SaaSAPI(this.http);
    this.sub = new SubAPI(this.http);
    this.dc = new DCAPI(this.http);
    this.vault = new VaultAPI(this.http);
    this.mpc = new MPCAPI(this.http);
    this.market = new MarketAPI(this.http);
    // A-12/13: 行情数据 RPC（与 MarketAPI 同 HttpClient 同源同缓存）
    this.marketRpc = new MarketRpcAPI(this.http);
    // data 服务独立 baseUrl（dataUrl 优先，回退 baseUrl）+ 独立 key（dataApiKey 优先，回退 apiKey）
    this.data = new DataAPI(new HttpClient({
      ...config,
      baseUrl: config.dataUrl || config.baseUrl,
      apiKey: config.dataApiKey || config.apiKey,
    }));
    // ml-service 独立 baseUrl（mlUrl 优先，回退 baseUrl）+ 独立 key（mlApiKey 优先，回退 apiKey）
    this.ml = new MlAPI(new HttpClient({
      ...config,
      baseUrl: config.mlUrl || config.baseUrl,
      apiKey: config.mlApiKey || config.apiKey,
    }));
    // chain-rpc 网关独立 baseUrl（chainRpcUrl 优先，回退 baseUrl）+ 独立 key（chainRpcApiKey 优先，回退 apiKey）
    // 广播独立 HttpClient（chainRpcBroadcastKey）——读/广播 key 分离，读 key 无法触达广播端点
    const chainRpcBroadcastKey = config.chainRpcBroadcastKey || '';
    const chainRpcReadHttp = new HttpClient({ ...config, baseUrl: config.chainRpcUrl || config.baseUrl, apiKey: config.chainRpcApiKey || config.apiKey });
    const chainRpcBroadcastHttp = new HttpClient({ ...config, baseUrl: config.chainRpcUrl || config.baseUrl, apiKey: chainRpcBroadcastKey });
    this.chainRpc = new ChainRpcAPI(chainRpcReadHttp, chainRpcBroadcastHttp, chainRpcBroadcastKey);
    // A-11：DexAPI 复用 chainRpc 读/广播双 HttpClient（quote=读 key；approve/swap=广播 key）
    this.dex = new DexAPI(chainRpcReadHttp, chainRpcBroadcastHttp, chainRpcBroadcastKey);
    // A-15/16: session-key-engine 独立 baseUrl（sessionKeyUrl 优先，回退 baseUrl）+ Bearer key
    this.sessionKey = new SessionKeyAPI(new HttpClient({
      ...config,
      baseUrl: config.sessionKeyUrl || config.baseUrl,
      bearerToken: config.sessionKeyApiKey,
    }));
  }

  setApiKey(key: string) { this.http.setApiKey(key); }
  setDcApiKey(key: string) { this.http.setDcApiKey(key); }
}

export default InfraX;
