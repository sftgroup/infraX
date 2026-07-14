"use strict";
/**
 * InfraX SDK v0.2
 *
 * Full coverage: Wallet / Safe / Payment / SaaS / DC / Vault / MPC
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InfraX = void 0;
// ═══════════════ HTTP ═══════════════
class HttpClient {
    constructor(config) {
        this.baseUrl = config.baseUrl || 'https://api.pocketx.ai';
        this.timeout = config.timeout || 30000;
        this.headers = { 'Content-Type': 'application/json' };
        if (config.apiKey)
            this.headers['x-api-key'] = config.apiKey;
        if (config.dcApiKey)
            this.headers['x-dc-api-key'] = config.dcApiKey;
    }
    async get(path) {
        const r = await this.fetch(path, { method: 'GET' });
        return r.json();
    }
    async post(path, body) {
        const r = await this.fetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
        return r.json();
    }
    async patch(path, body) {
        const r = await this.fetch(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined });
        return r.json();
    }
    async del(path) {
        const r = await this.fetch(path, { method: 'DELETE' });
        return r.json();
    }
    async fetch(path, opts) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
            return await fetch(this.baseUrl + path, { ...opts, headers: this.headers, signal: controller.signal });
        }
        finally {
            clearTimeout(timer);
        }
    }
    setApiKey(key) { this.headers['x-api-key'] = key; }
    setDcApiKey(key) { this.headers['x-dc-api-key'] = key; }
}
// ═══════════════ Wallet — balances, send, simulate, RPC ═══════════════
class WalletAPI {
    constructor(http) {
        this.http = http;
    }
    async balance(params) { const q = new URLSearchParams(); q.set('address', params.address); if (params.chain)
        q.set('chain', params.chain); if (params.token)
        q.set('token', params.token); return this.http.get('/api/v2/wallet/balance?' + q.toString()); }
    async send(params) { return this.http.post('/api/v2/wallet/send', params); }
    async simulate(params) { return this.http.post('/api/v2/wallet/simulate', params); }
    async health() { return this.http.get('/health'); }
    async rpc(params = {}) { return this.http.post('/api/v2/wallet/rpc', params); }
    async sweep(params = {}) { return this.http.post('/api/v2/wallet/sweep', params); }
    async txStatus(params) { const q = new URLSearchParams(); q.set('tx_hash', params.txHash); if (params.chain)
        q.set('chain', params.chain); return this.http.get('/api/v2/wallet/tx-status?' + q.toString()); }
}
// ═══════════════ Safe — multi-sig on-chain operations ═══════════════
class SafeAPI {
    constructor(http) {
        this.http = http;
    }
    async propose(params) { return this.http.post('/api/v2/safe/propose', params); }
    async confirm(params) { return this.http.post('/api/v2/safe/confirm', params); }
    async execute(params) { return this.http.post('/api/v2/safe/execute', params); }
    async list(chainId) { return this.http.get('/api/v2/safe/list' + (chainId ? '?chainId=' + chainId : '')); }
    async detail(address) { return this.http.get('/api/v2/safe/' + address); }
    async sync(safeAddress) { return this.http.post('/api/v2/safe/sync', { safeAddress }); }
    async executeReady(safeAddress) { return this.http.post('/api/v2/safe/execute-ready', { safeAddress }); }
    async status() { return this.http.get('/api/v2/safe/status'); }
}
// ═══════════════ Payment — checkout, x402 auto-pay ═══════════════
class PaymentAPI {
    constructor(http) {
        this.http = http;
    }
    async create(params) { return this.http.post('/api/v2/payment/create', params); }
    async status(paymentId) { return this.http.get('/api/v2/payment/status?paymentId=' + encodeURIComponent(paymentId)); }
    async confirm(paymentId) { return this.http.post('/api/v2/payment/confirm', { paymentId }); }
    async history() { return this.http.get('/api/v2/payment/history'); }
    /** x402: auto-approve ERC20 payment for API access */
    async x402Pay(params) { return this.http.post('/api/v2/payment/x402/pay', params); }
    async x402Info() { return this.http.get('/api/v2/payment/x402/info'); }
}
// ═══════════════ SaaS — tenant management, billing, apikeys ═══════════════
class SaaSAPI {
    constructor(http) {
        this.http = http;
    }
    async createTenant(params) { return this.http.post('/api/v2/saas/tenants', params); }
    async listTenants() { return this.http.get('/api/v2/saas/tenants'); }
    async getTenant(tenantId) { return this.http.get('/api/v2/saas/tenants/' + tenantId); }
    async updateTenant(tenantId, params) { return this.http.patch('/api/v2/saas/tenants/' + tenantId, params); }
    async deleteTenant(tenantId) { return this.http.del('/api/v2/saas/tenants/' + tenantId); }
    async createApiKey(tenantId) { return this.http.post('/api/v2/saas/tenants/' + tenantId + '/apikey', {}); }
    async rotateApiKey(tenantId) { return this.http.post('/api/v2/saas/tenants/' + tenantId + '/apikey/rotate', {}); }
    async deleteApiKey(tenantId) { return this.http.del('/api/v2/saas/tenants/' + tenantId + '/apikey'); }
    async getUsage(tenantId) { return this.http.get('/api/v2/saas/tenants/' + tenantId + '/usage'); }
    async stats() { return this.http.get('/api/v2/saas/stats'); }
    async audit() { return this.http.get('/api/v2/saas/audit'); }
    async users() { return this.http.get('/api/v2/saas/users'); }
    async hotWallets() { return this.http.get('/api/v2/saas/hot-wallets'); }
}
// ═══════════════ Subscription — plans, subscribe, cancel ═══════════════
class SubAPI {
    constructor(http) {
        this.http = http;
    }
    async plans() { return this.http.get('/api/v2/subscription/plans'); }
    async current() { return this.http.get('/api/v2/subscription/current'); }
    async subscribe(planId) { return this.http.post('/api/v2/subscription/subscribe', { planId }); }
    async cancel() { return this.http.post('/api/v2/subscription/cancel'); }
}
// ═══════════════ DC — events, tokens, chains, checkpoints ═══════════════
class DCAPI {
    constructor(http) {
        this.http = http;
    }
    async events(params = {}) { const q = new URLSearchParams(); if (params.chain)
        q.set('chain', params.chain); if (params.address)
        q.set('address', params.address); if (params.contract)
        q.set('contract', params.contract); if (params.eventType)
        q.set('event_type', params.eventType); if (params.fromBlock)
        q.set('from_block', params.fromBlock); if (params.limit)
        q.set('page_size', String(params.limit)); return this.http.get('/api/v2/data/events?' + q.toString()); }
    async stats() { return this.http.get('/api/v2/data/stats'); }
    async checkpoints(chain) { return this.http.get('/api/v2/data/checkpoints' + (chain ? '?chain=' + chain : '')); }
    async plans() { return this.http.get('/api/v2/data/plans'); }
    async tokens(params = {}) { const q = new URLSearchParams(); if (params.symbol)
        q.set('symbol', params.symbol); if (params.chain)
        q.set('chain', params.chain); return this.http.get('/api/v2/data/tokens?' + q.toString()); }
    async chains() { return this.http.get('/api/v2/data/chains'); }
}
// ═══════════════ Vault — multisig safe creation + risk ═══════════════
class VaultAPI {
    constructor(http) {
        this.http = http;
    }
    async dashboard() { return this.http.get('/api/vault/dashboard'); }
    async safes(params = {}) { const q = new URLSearchParams(); if (params.chain)
        q.set('chain', params.chain); if (params.status)
        q.set('status', params.status); return this.http.get('/api/vault/safes?' + q.toString()); }
    async safeInfo(safeId) { return this.http.get('/api/vault/safes/' + encodeURIComponent(safeId)); }
    async createSafe(params) { return this.http.post('/api/vault/safes', params); }
    async transactions(params = {}) { const q = new URLSearchParams(); if (params.safeId)
        q.set('safe_id', params.safeId); if (params.status)
        q.set('status', params.status); if (params.limit)
        q.set('limit', String(params.limit)); return this.http.get('/api/vault/transactions?' + q.toString()); }
    async createTransaction(params) { return this.http.post('/api/vault/transactions', params); }
    async riskCheck(params) { return this.http.post('/api/vault/risk/check', params); }
}
// ═══════════════ MPC — key shard wallets ═══════════════
class MPCAPI {
    constructor(http) {
        this.http = http;
    }
    async sendCode(params) { return this.http.post('/api/v2/mpc/send-code', params); }
    async register(params) { return this.http.post('/api/v2/mpc/register', params); }
    async recover(params) { return this.http.post('/api/v2/mpc/recover', params); }
    async status(params) { return this.http.get('/api/v2/mpc/status?email=' + encodeURIComponent(params.email)); }
    async createWallet(params) { const s1 = await this.sendCode(params); if (s1.code !== 0)
        return s1; return { code: 0, message: 'Verification code sent. Call mpc.register() to complete.', email: params.email }; }
}
// ═══════════════ Main Client ═══════════════
class InfraX {
    constructor(config = {}) {
        this.http = new HttpClient(config);
        this.wallet = new WalletAPI(this.http);
        this.safe = new SafeAPI(this.http);
        this.payment = new PaymentAPI(this.http);
        this.saas = new SaaSAPI(this.http);
        this.sub = new SubAPI(this.http);
        this.dc = new DCAPI(this.http);
        this.vault = new VaultAPI(this.http);
        this.mpc = new MPCAPI(this.http);
    }
    setApiKey(key) { this.http.setApiKey(key); }
    setDcApiKey(key) { this.http.setDcApiKey(key); }
}
exports.InfraX = InfraX;
exports.default = InfraX;
