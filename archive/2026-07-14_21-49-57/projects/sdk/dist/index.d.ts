/**
 * InfraX SDK v0.2
 *
 * Full coverage: Wallet / Safe / Payment / SaaS / DC / Vault / MPC
 */
export interface InfraXConfig {
    baseUrl?: string;
    apiKey?: string;
    dcApiKey?: string;
    timeout?: number;
}
export interface InfraXResponse<T = any> {
    code: number;
    message: string;
    data: T;
}
export interface WalletBalanceParams {
    address: string;
    chain?: string;
    token?: string;
}
export interface WalletBalanceResult {
    address: string;
    chain: string;
    balance: string;
    token?: string;
    decimals?: number;
}
export interface WalletSendParams {
    from: string;
    to: string;
    amount: string;
    chain?: string;
    token?: string;
}
export interface WalletSendResult {
    txHash: string;
    chain: string;
    from: string;
    to: string;
    amount: string;
}
export interface WalletSimulateParams {
    from: string;
    to: string;
    amount?: string;
    data?: string;
    chain?: string;
}
export interface WalletSimulateResult {
    gasEstimate: string;
    gasPrice?: string;
    totalCost?: string;
}
export interface WalletRpcParams {
    chain?: string;
    method?: string;
    params?: any[];
}
export interface WalletRpcResult {
    chain: string;
    response: any;
}
export interface SafeProposeParams {
    safeAddress: string;
    to: string;
    value?: string;
    data?: string;
}
export interface SafeProposeResult {
    safeTxHash: string;
    safeAddress: string;
    to: string;
    value: string;
    nonce: number;
}
export interface SafeConfirmParams {
    safeAddress: string;
    safeTxHash: string;
    signature: string;
}
export interface SafeConfirmResult {
    sigCount: number;
    threshold: number;
    ready: boolean;
}
export interface SafeExecuteParams {
    safeTxHash: string;
}
export interface SafeExecuteResult {
    txHash: string;
    executed: boolean;
}
export interface PaymentCreateParams {
    planId: string;
    amount: string;
    method?: string;
    currency?: string;
}
export interface PaymentCreateResult {
    paymentId: string;
    amount: string;
    status: string;
}
export interface PaymentStatusResult {
    paymentId: string;
    status: string;
    amount: string;
}
export interface X402PayParams {
    recipient: string;
    amount: string;
    token?: string;
    chain?: string;
    description?: string;
}
export interface X402PayResult {
    txHash: string;
    amount: string;
    token: string;
}
export interface TenantCreateParams {
    name: string;
    planId?: string;
    metadata?: Record<string, any>;
}
export interface TenantCreateResult {
    tenantId: string;
    name: string;
    apiKey: string;
}
export interface ApiKeyRotateResult {
    apiKey: string;
}
export interface SaaSStats {
    totalTenants: number;
    totalUsers: number;
    revenue: number;
}
export interface DCEventsParams {
    chain?: string;
    address?: string;
    contract?: string;
    eventType?: string;
    fromBlock?: string;
    limit?: number;
}
export interface DCEvent {
    chain: string;
    block: number;
    txHash: string;
    from: string;
    to: string;
    type: string;
    token?: string;
    amount?: string;
}
export interface DCStatsResult {
    chains: Array<{
        chain: string;
        events: number;
        latestBlock: string;
        uniqueTx: number;
    }>;
}
export interface DCToken {
    symbol: string;
    name: string;
    address: string;
    chain: string;
    decimals: number;
}
export interface DCChain {
    name: string;
    chainId: string;
    nativeSymbol: string;
}
export interface VaultSafeParams {
    chain?: string;
    status?: 'active' | 'pending' | 'closed';
}
export interface VaultSafe {
    id: string;
    name: string;
    address: string;
    chain: string;
    threshold: number;
    signers: string[];
    status: string;
}
export interface VaultCreateSafeParams {
    name?: string;
    signers: string[];
    threshold: number;
    chain: string;
}
export interface VaultTransactionParams {
    safeId?: string;
    status?: string;
    limit?: number;
}
export interface VaultTransaction {
    id: string;
    safeId: string;
    to: string;
    amount: string;
    status: string;
    confirmations: number;
    threshold: number;
}
export interface VaultCreateTxParams {
    safeId: string;
    to: string;
    amount: string;
    tokenAddress?: string;
    data?: string;
}
export interface MPCSendCodeParams {
    email: string;
}
export interface MPCRegisterParams {
    email: string;
    code: string;
}
export interface MPCWalletResult {
    email: string;
    address: string;
    walletId: string;
}
export interface MPCStatusParams {
    email: string;
}
export interface MPCStatusResult {
    exists: boolean;
    address?: string;
    walletId?: string;
}
declare class HttpClient {
    private baseUrl;
    private headers;
    private timeout;
    constructor(config: InfraXConfig);
    get<T>(path: string): Promise<InfraXResponse<T>>;
    post<T>(path: string, body?: any): Promise<InfraXResponse<T>>;
    patch<T>(path: string, body?: any): Promise<InfraXResponse<T>>;
    del<T>(path: string): Promise<InfraXResponse<T>>;
    private fetch;
    setApiKey(key: string): void;
    setDcApiKey(key: string): void;
}
declare class WalletAPI {
    private http;
    constructor(http: HttpClient);
    balance(params: WalletBalanceParams): Promise<InfraXResponse<WalletBalanceResult>>;
    send(params: WalletSendParams): Promise<InfraXResponse<WalletSendResult>>;
    simulate(params: WalletSimulateParams): Promise<InfraXResponse<WalletSimulateResult>>;
    health(): Promise<InfraXResponse<{
        status: string;
    }>>;
    rpc(params?: WalletRpcParams): Promise<InfraXResponse<WalletRpcResult>>;
    sweep(params?: {
        chain?: string;
        toAddress?: string;
    }): Promise<InfraXResponse<any>>;
    txStatus(params: {
        txHash: string;
        chain?: string;
    }): Promise<InfraXResponse<any>>;
}
declare class SafeAPI {
    private http;
    constructor(http: HttpClient);
    propose(params: SafeProposeParams): Promise<InfraXResponse<SafeProposeResult>>;
    confirm(params: SafeConfirmParams): Promise<InfraXResponse<SafeConfirmResult>>;
    execute(params: SafeExecuteParams): Promise<InfraXResponse<SafeExecuteResult>>;
    list(chainId?: string): Promise<InfraXResponse<any>>;
    detail(address: string): Promise<InfraXResponse<any>>;
    sync(safeAddress: string): Promise<InfraXResponse<any>>;
    executeReady(safeAddress: string): Promise<InfraXResponse<any>>;
    status(): Promise<InfraXResponse<any>>;
}
declare class PaymentAPI {
    private http;
    constructor(http: HttpClient);
    create(params: PaymentCreateParams): Promise<InfraXResponse<PaymentCreateResult>>;
    status(paymentId: string): Promise<InfraXResponse<PaymentStatusResult>>;
    confirm(paymentId: string): Promise<InfraXResponse<any>>;
    history(): Promise<InfraXResponse<any>>;
    /** x402: auto-approve ERC20 payment for API access */
    x402Pay(params: X402PayParams): Promise<InfraXResponse<X402PayResult>>;
    x402Info(): Promise<InfraXResponse<any>>;
}
declare class SaaSAPI {
    private http;
    constructor(http: HttpClient);
    createTenant(params: TenantCreateParams): Promise<InfraXResponse<TenantCreateResult>>;
    listTenants(): Promise<InfraXResponse<any>>;
    getTenant(tenantId: string): Promise<InfraXResponse<any>>;
    updateTenant(tenantId: string, params: any): Promise<InfraXResponse<any>>;
    deleteTenant(tenantId: string): Promise<InfraXResponse<any>>;
    createApiKey(tenantId: string): Promise<InfraXResponse<any>>;
    rotateApiKey(tenantId: string): Promise<InfraXResponse<ApiKeyRotateResult>>;
    deleteApiKey(tenantId: string): Promise<InfraXResponse<any>>;
    getUsage(tenantId: string): Promise<InfraXResponse<any>>;
    stats(): Promise<InfraXResponse<SaaSStats>>;
    audit(): Promise<InfraXResponse<any>>;
    users(): Promise<InfraXResponse<any>>;
    hotWallets(): Promise<InfraXResponse<any>>;
}
declare class SubAPI {
    private http;
    constructor(http: HttpClient);
    plans(): Promise<InfraXResponse<any>>;
    current(): Promise<InfraXResponse<any>>;
    subscribe(planId: string): Promise<InfraXResponse<any>>;
    cancel(): Promise<InfraXResponse<any>>;
}
declare class DCAPI {
    private http;
    constructor(http: HttpClient);
    events(params?: DCEventsParams): Promise<InfraXResponse<any>>;
    stats(): Promise<InfraXResponse<DCStatsResult>>;
    checkpoints(chain?: string): Promise<InfraXResponse<any>>;
    plans(): Promise<InfraXResponse<any>>;
    tokens(params?: {
        symbol?: string;
        chain?: string;
    }): Promise<InfraXResponse<DCToken[]>>;
    chains(): Promise<InfraXResponse<DCChain[]>>;
}
declare class VaultAPI {
    private http;
    constructor(http: HttpClient);
    dashboard(): Promise<InfraXResponse<any>>;
    safes(params?: VaultSafeParams): Promise<InfraXResponse<VaultSafe[]>>;
    safeInfo(safeId: string): Promise<InfraXResponse<VaultSafe>>;
    createSafe(params: VaultCreateSafeParams): Promise<InfraXResponse<VaultSafe>>;
    transactions(params?: VaultTransactionParams): Promise<InfraXResponse<VaultTransaction[]>>;
    createTransaction(params: VaultCreateTxParams): Promise<InfraXResponse<VaultTransaction>>;
    riskCheck(params: {
        to: string;
        amount?: string;
        chain?: string;
    }): Promise<InfraXResponse<any>>;
}
declare class MPCAPI {
    private http;
    constructor(http: HttpClient);
    sendCode(params: MPCSendCodeParams): Promise<InfraXResponse<any>>;
    register(params: MPCRegisterParams): Promise<InfraXResponse<MPCWalletResult>>;
    recover(params: MPCRegisterParams): Promise<InfraXResponse<MPCWalletResult>>;
    status(params: MPCStatusParams): Promise<InfraXResponse<MPCStatusResult>>;
    createWallet(params: MPCSendCodeParams): Promise<InfraXResponse<any> | {
        code: number;
        message: string;
        email: string;
    }>;
}
export declare class InfraX {
    readonly wallet: WalletAPI;
    readonly safe: SafeAPI;
    readonly payment: PaymentAPI;
    readonly saas: SaaSAPI;
    readonly sub: SubAPI;
    readonly dc: DCAPI;
    readonly vault: VaultAPI;
    readonly mpc: MPCAPI;
    private http;
    constructor(config?: InfraXConfig);
    setApiKey(key: string): void;
    setDcApiKey(key: string): void;
}
export default InfraX;
