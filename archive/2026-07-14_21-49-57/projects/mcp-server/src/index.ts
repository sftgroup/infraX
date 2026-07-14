// InfraX MCP Server — Wallet (Phase 1)
// Standalone MCP process bridging AI ↔ WAAS internal API
// Wallet: balance / send / simulate / rpc / sweep / tx status / health
// Safe → MCP Vault (:3006) only

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));

const WAAS = process.env.WAAS_URL || 'http://localhost:6001';
const API_KEY = process.env.WAAS_KEY || process.env.WAAS_API_KEY || 'dev-cwallet-key';
const PORT = parseInt(process.env.PORT || '3004', 10);

async function waas(path: string, opts?: { method?: string; body?: any }) {
  const headers: any = { 'Content-Type': 'application/json', 'x-api-key': API_KEY };
  const r = await fetch(WAAS + path, { method: opts?.method || 'GET', headers, body: opts?.body ? JSON.stringify(opts.body) : undefined });
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

// ─── Payment (x402) ───

reg({
  name: 'payment_create',
  description: 'Create a payment order for subscription plans.',
  inputSchema: { type: 'object', properties: {
    planId: { type: 'string', description: 'Subscription plan ID' },
    amount: { type: 'string', description: 'Payment amount' },
    method: { type: 'string', description: 'Payment method: crypto, stripe' },
    currency: { type: 'string', description: 'Currency: USDT, ETH, etc.' },
  }, required: ['planId', 'amount'] },
}, async (args: any) => pay('/api/v2/payment/create', { method: 'POST', body: args }));

reg({
  name: 'payment_status',
  description: 'Check payment order status: pending, confirmed, expired, or refunded.',
  inputSchema: { type: 'object', properties: {
    paymentId: { type: 'string', description: 'Payment order ID' },
  }, required: ['paymentId'] },
}, async (args: any) => pay('/api/v2/payment/status?paymentId=' + encodeURIComponent(args.paymentId)));

reg({
  name: 'x402_pay',
  description: 'Handle HTTP 402 Payment flow. Auto-approve ERC20 transfer for paid API access.',
  inputSchema: { type: 'object', properties: {
    recipient: { type: 'string', description: 'Recipient from 402 Payment header' },
    amount: { type: 'string', description: 'Amount due (e.g. "10" for 10 USDC)' },
    token: { type: 'string', description: 'Token address (default: USDC on Base)' },
    chain: { type: 'string', description: 'Chain (default: base)' },
    description: { type: 'string', description: 'What this payment is for' },
  }, required: ['recipient', 'amount'] },
}, async (args: any) => pay('/api/v2/payment/x402/pay', { method: 'POST', body: args }));

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
