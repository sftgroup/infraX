// InfraX MCP Server — Wallet (Phase 1)
// Standalone MCP process bridging AI ↔ WAAS internal API + generic payment channel
// Wallet: balance / send / simulate / rpc / sweep / tx status / health
// Payments: generic channel tools → @0xinfrax/payments standalone (:9132)
// Safe → MCP Vault (:3006) only

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { inboundAuth } from './mcp-auth.js';

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));
app.use(inboundAuth);

const WAAS = process.env.WAAS_URL || process.env.WALLET_API_URL || 'http://localhost:9109';
const API_KEY = process.env.WAAS_KEY || process.env.WAAS_API_KEY || 'dev-cwallet-key';
// Generic payment channel (@0xinfrax/payments standalone :9132, prefix /payments).
// Auth: unified platform contract — X-API-Key (same PAYMENTS_API_KEY as the service).
const PAYMENTS_URL = process.env.PAYMENTS_URL || 'http://localhost:9132';
const PAYMENTS_KEY = process.env.PAYMENTS_API_KEY || API_KEY;
const PORT = parseInt(process.env.PORT || '3004', 10);

async function waas(path: string, opts?: { method?: string; body?: any }) {
  const headers: any = { 'Content-Type': 'application/json', 'x-api-key': API_KEY };
  const r = await fetch(WAAS + path, { method: opts?.method || 'GET', headers, body: opts?.body ? JSON.stringify(opts.body) : undefined });
  return r.json();
}

async function pay(path: string, opts?: { method?: string; body?: any }) {
  const headers: any = { 'Content-Type': 'application/json', 'X-API-Key': PAYMENTS_KEY };
  const r = await fetch(PAYMENTS_URL + path, { method: opts?.method || 'GET', headers, body: opts?.body ? JSON.stringify(opts.body) : undefined });
  return r.json();
}

const tools: Record<string, any> = {};
function reg(def: any, fn: Function) { tools[def.name] = { def, handler: fn }; }

// ═══════════════════════════════════════
// 7 Tools mapped to WAAS internal API
// ═══════════════════════════════════════

reg({
  name: 'wallet_balance',
  description: 'Check token balances for a wallet address on any supported chain.',
  inputSchema: {
    type: 'object',
    properties: {
      address: { type: 'string', description: 'Wallet address (0x...)' },
      chain: { type: 'string', description: 'Chain: ethereum, sepolia, bsc, base, polygon, arbitrum, optimism' },
    },
    required: ['address'],
  },
}, async (args: any) => {
  return waas(`/api/v2/internal/balance?address=${encodeURIComponent(args.address)}&chain=${args.chain || 'sepolia'}`);
});

reg({
  name: 'wallet_send',
  description: 'Send native tokens from the gas pool to any address. Max 0.05 ETH per call.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient address (0x...)' },
      amount: { type: 'string', description: 'Amount in ETH (e.g. "0.01"). Max 0.05.' },
      chain: { type: 'string', description: 'Chain name (default: sepolia)' },
    },
    required: ['to', 'amount'],
  },
}, async (args: any) => {
  const r = await waas('/api/v2/internal/send-tx', {
    method: 'POST',
    body: { to: args.to, amount: args.amount, chain: args.chain || 'sepolia' },
  });
  if (r.code !== 0) return { error: r.message };
  return r.data || r;
});

reg({
  name: 'wallet_simulate',
  description: 'Estimate gas cost for a transaction before sending. No funds are spent.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Sender address (0x...)' },
      to: { type: 'string', description: 'Recipient address (0x...)' },
      amount: { type: 'string', description: 'Amount in ETH (e.g. "0.01")' },
      chain: { type: 'string', description: 'Chain name' },
    },
    required: ['from', 'to', 'amount'],
  },
}, async (args: any) => {
  const r = await waas('/api/v2/internal/estimate-gas', {
    method: 'POST',
    body: { from: args.from, to: args.to, amount: args.amount, chain: args.chain || 'sepolia' },
  });
  if (r.code !== 0) return { error: r.message };
  return {
    estimatedGas: r.data?.gasLimit || '21000',
    gasPrice: r.data?.gasPrice || '50 Gwei',
    estimatedCost: r.data?.estimatedGasWei || '~0.001 ETH',
  };
});

reg({
  name: 'wallet_rpc',
  description: 'Get available RPC endpoints for each supported chain. Useful for connecting wallets or dApps.',
  inputSchema: { type: 'object', properties: {}, required: [] },
}, async () => {
  return waas('/api/v2/internal/rpc-config');
});

reg({
  name: 'wallet_health',
  description: 'Check if the WAAS backend and database are healthy.',
  inputSchema: { type: 'object', properties: {}, required: [] },
}, async () => {
  return waas('/api/v2/internal/health');
});

reg({
  name: 'wallet_sweep',
  description: 'Sweep all custodial wallet funds to the master wallet (admin only). Returns sweep summary.',
  inputSchema: {
    type: 'object',
    properties: {
      chain: { type: 'string', description: 'Chain to sweep (default: sepolia)' },
    },
    required: [],
  },
}, async (args: any) => {
  const r = await waas('/api/v2/internal/sweep', {
    method: 'POST',
    body: { chain: args.chain || 'sepolia' },
  });
  return r;
});

reg({
  name: 'wallet_status',
  description: 'Check transaction status on-chain by hash.',
  inputSchema: {
    type: 'object',
    properties: {
      txHash: { type: 'string', description: 'Transaction hash (0x...)' },
      chain: { type: 'string', description: 'Chain name' },
    },
    required: ['txHash'],
  },
}, async (args: any) => {
  return waas(`/api/v2/internal/transaction-status?txHash=${encodeURIComponent(args.txHash)}&chain=${args.chain || 'sepolia'}`);
});

// ─── Generic payment channel (→ @0xinfrax/payments standalone :9132 /payments) ───

reg({
  name: 'payment_info',
  description: 'Discover the generic payment channel: price, pay-to wallet, network, and which rails are enabled (x402 / stablecoin / MPP).',
  inputSchema: { type: 'object', properties: {}, required: [] },
}, async () => pay('/payments/info'));

reg({
  name: 'payment_create',
  description: 'Create a payment intent via the generic fiat channel: returns a Stripe Checkout session URL. Business context (order id, plan id) goes in metadata / clientReference and is passed through untouched.',
  inputSchema: { type: 'object', properties: {
    subscriber: { type: 'string', description: 'Payer identifier (wallet address or user id)' },
    amountCents: { type: 'number', description: 'Amount in USD cents (omit to auto-price from the on-chain plan)' },
    planId: { type: 'number', description: 'On-chain plan id — auto-prices when amountCents is omitted' },
    period: { type: 'string', description: 'Billing period: day | week | month | year' },
    currency: { type: 'string', description: 'ISO currency code (default USD)' },
    chain: { type: 'string', description: 'Chain slot used for plan pricing (default oxachain)' },
    metadata: { type: 'object', description: 'Business context stored verbatim, e.g. {"agentId":1,"orderId":"o1"}' },
    clientReference: { type: 'string', description: 'Opaque reference echoed back in webhook events' },
  }, required: ['subscriber'] },
}, async (args: any) => pay('/payments/checkout', { method: 'POST', body: args }));

reg({
  name: 'payment_verify',
  description: 'Verify an on-chain payment on the generic x402/stablecoin channel: checks the tx is a valid payment to the platform wallet and credits it idempotently.',
  inputSchema: { type: 'object', properties: {
    txHash: { type: 'string', description: 'On-chain transaction hash (0x...)' },
    chain: { type: 'string', description: 'Chain slot (default oxachain)' },
  }, required: ['txHash'] },
}, async (args: any) => pay('/payments/verify', { method: 'POST', body: args }));

reg({
  name: 'payment_price',
  description: 'Read on-chain plan pricing (price, billing period, active status).',
  inputSchema: { type: 'object', properties: {
    planId: { type: 'number', description: 'On-chain plan id' },
    chain: { type: 'string', description: 'Chain slot (default oxachain)' },
  }, required: ['planId'] },
}, async (args: any) => pay('/payments/price?chain=' + encodeURIComponent(args.chain || 'oxachain') + '&planId=' + encodeURIComponent(args.planId)));

reg({
  name: 'payment_balance',
  description: 'Read the module ledger balance of an address.',
  inputSchema: { type: 'object', properties: {
    address: { type: 'string', description: 'Wallet address (0x...)' },
    asset: { type: 'string', description: 'Asset identifier (optional)' },
  }, required: ['address'] },
}, async (args: any) => pay('/payments/balance?address=' + encodeURIComponent(args.address) + (args.asset ? '&asset=' + encodeURIComponent(args.asset) : '')));

reg({
  name: 'payment_access',
  description: 'Unified access check for a subscriber against a resource (delegates to the injected store).',
  inputSchema: { type: 'object', properties: {
    subscriber: { type: 'string', description: 'Subscriber identifier' },
    resource: { type: 'object', description: 'Resource descriptor, e.g. {"agentId":1}' },
    chain: { type: 'string', description: 'Chain slot (optional)' },
  }, required: ['subscriber', 'resource'] },
}, async (args: any) => pay('/payments/access', { method: 'POST', body: args }));

// ─── MPP payment channel ops ───

reg({
  name: 'mpp_open',
  description: 'Open an MPP payment channel: verifies the deposit tx and creates the channel session.',
  inputSchema: { type: 'object', properties: {
    payer: { type: 'string', description: 'Channel payer address (0x...)' },
    depositWei: { type: 'string', description: 'Deposit amount in wei' },
    salt: { type: 'string', description: 'Channel salt (contributes to the deterministic channelId)' },
    txHash: { type: 'string', description: 'Deposit transaction hash (0x...)' },
    chain: { type: 'string', description: 'Chain slot (default oxachain)' },
    metadata: { type: 'object', description: 'Business context' },
  }, required: ['payer', 'depositWei', 'salt', 'txHash'] },
}, async (args: any) => pay('/payments/mpp/open', { method: 'POST', body: args }));

reg({
  name: 'mpp_voucher',
  description: 'Submit a cumulative MPP voucher (EIP-712 signature) to consume channel balance.',
  inputSchema: { type: 'object', properties: {
    channelId: { type: 'string', description: 'Channel id (keccak256 of payer/payee/asset/salt/chainId)' },
    cumulativeAmount: { type: 'string', description: 'Cumulative amount in wei' },
    signature: { type: 'string', description: 'EIP-712 voucher signature (0x...)' },
  }, required: ['channelId', 'cumulativeAmount', 'signature'] },
}, async (args: any) => pay('/payments/mpp/voucher', { method: 'POST', body: args }));

reg({
  name: 'mpp_topup',
  description: 'Top up an MPP channel with an additional on-chain deposit.',
  inputSchema: { type: 'object', properties: {
    channelId: { type: 'string', description: 'Channel id' },
    txHash: { type: 'string', description: 'Top-up deposit transaction hash (0x...)' },
    additionalWei: { type: 'string', description: 'Additional deposit amount in wei' },
  }, required: ['channelId', 'txHash', 'additionalWei'] },
}, async (args: any) => pay('/payments/mpp/topup', { method: 'POST', body: args }));

reg({
  name: 'mpp_settle',
  description: 'Batch-deduct un-settled consumption of an MPP channel (auto-settle may also trigger this).',
  inputSchema: { type: 'object', properties: {
    channelId: { type: 'string', description: 'Channel id' },
  }, required: ['channelId'] },
}, async (args: any) => pay('/payments/mpp/settle', { method: 'POST', body: args }));

reg({
  name: 'mpp_close',
  description: 'Close an MPP channel (settles the tail first, freezes the session).',
  inputSchema: { type: 'object', properties: {
    channelId: { type: 'string', description: 'Channel id' },
  }, required: ['channelId'] },
}, async (args: any) => pay('/payments/mpp/close', { method: 'POST', body: args }));

reg({
  name: 'mpp_session',
  description: 'Current state of an MPP channel (status, cumulative, spent, deposit).',
  inputSchema: { type: 'object', properties: {
    channelId: { type: 'string', description: 'Channel id' },
  }, required: ['channelId'] },
}, async (args: any) => pay('/payments/mpp/session?channelId=' + encodeURIComponent(args.channelId)));

// ═══════════════════════════════════════
// MCP JSON-RPC handler
// ═══════════════════════════════════════

async function handle(req: any) {
  const { id, method, params } = req;
  try {
    if (method === 'initialize')
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'infrax-wallet-mcp', version: '1.0.0' } } };
    if (method === 'notifications/initialized')
      return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list')
      return { jsonrpc: '2.0', id, result: { tools: Object.values(tools).map((t: any) => t.def) } };
    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const tool = tools[name];
      if (!tool) return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
      const result = await tool.handler(args || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method' } };
  } catch (e: any) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
  }
}

// ═══════════════════════════════════════
// HTTP routes
// ═══════════════════════════════════════

app.get('/mcp/sse', (_q, res) => {
  const sid = randomUUID();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`event: endpoint\ndata: /mcp/message?sessionId=${sid}\n\n`);
});

app.post('/mcp/message', async (req, res) => { res.json(await handle(req.body)); });

app.get('/health', (_q, res) => res.json({ status: 'ok', service: 'infrax-wallet-mcp', tools: Object.keys(tools).length }));

app.get('/', (_q, res) => res.json({ service: 'InfraX Wallet MCP', version: '1.0.0', endpoint: '/mcp/sse', tools: Object.values(tools).map((t: any) => t.def.name) }));

app.listen(PORT, () => console.log(`InfraX Wallet MCP :${PORT}`));
