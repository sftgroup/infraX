// InfraX MCP Server — Vault (Phase 3)
// Standalone MCP process bridging AI ↔ Vault API
// 12 tools: full Safe multi-sig lifecycle + risk check

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));

const VAULT = process.env.VAULT_URL || 'http://localhost:6002';
const PORT = parseInt(process.env.PORT || '3006', 10);

async function vt(path: string, opts?: { method?: string; body?: any }) {
  const headers: any = { 'Content-Type': 'application/json' };
  const r = await fetch(VAULT + path, { method: opts?.method || 'GET', headers, body: opts?.body ? JSON.stringify(opts.body) : undefined });
  return r.json();
}

const tools: Record<string, any> = {};
function reg(def: any, fn: Function) { tools[def.name] = { def, handler: fn }; }

// ─── Dashboard ───

reg({
  name: 'vault_dashboard',
  description: 'Get Vault overview: total safes, pending transactions, active signers.',
  inputSchema: { type: 'object', properties: {}, required: [] },
}, async () => vt('/api/vault/dashboard'));

// ─── Safe CRUD ───

reg({
  name: 'vault_safes',
  description: 'List all multisig safes: addresses, signers, threshold, balances.',
  inputSchema: { type: 'object', properties: {
    chain: { type: 'string', description: 'Filter by chain (optional)' },
    status: { type: 'string', description: 'Filter: active, pending, closed' },
  }, required: [] },
}, async (args: any) => {
  const params = new URLSearchParams();
  if (args.chain) params.set('chain', args.chain);
  if (args.status) params.set('status', args.status);
  return vt('/api/vault/safe/list?' + params.toString());
});

reg({
  name: 'vault_safe_info',
  description: 'Get detailed info on a single safe: signers, threshold, transaction history.',
  inputSchema: { type: 'object', properties: {
    safeId: { type: 'string', description: 'Safe contract address (0x...)' },
  }, required: ['safeId'] },
}, async (args: any) => vt(`/api/vault/safe/${encodeURIComponent(args.safeId)}`));

reg({
  name: 'vault_create_safe',
  description: 'Create and deploy a new multisig Safe on-chain. Requires signer addresses, threshold, and chain.',
  inputSchema: { type: 'object', properties: {
    name: { type: 'string', description: 'Safe name' },
    signers: { type: 'array', description: 'Array of signer addresses (0x...)' },
    threshold: { type: 'number', description: 'Required signatures (e.g. 2 of 3 = 2)' },
    chain: { type: 'string', description: 'Chain: ethereum, sepolia, bsc, base, polygon, arbitrum' },
  }, required: ['signers', 'threshold', 'chain'] },
}, async (args: any) => vt('/api/vault/safe/create', { method: 'POST', body: args }));

reg({
  name: 'vault_update_owners',
  description: 'Update Safe signer set and threshold. Requires on-chain confirmation.',
  inputSchema: { type: 'object', properties: {
    address: { type: 'string', description: 'Safe contract address' },
    owners: { type: 'array', description: 'New signer addresses (0x...)' },
    threshold: { type: 'number', description: 'New threshold' },
  }, required: ['address', 'owners', 'threshold'] },
}, async (args: any) => vt(`/api/vault/safe/${encodeURIComponent(args.address)}/owners`, { method: 'PUT', body: { owners: args.owners, threshold: args.threshold } }));

// ─── Safe Transactions ───

reg({
  name: 'vault_create_tx',
  description: 'Propose a new multisig transaction. Needs safe address, destination, amount, and calldata.',
  inputSchema: { type: 'object', properties: {
    safeId: { type: 'string', description: 'Safe contract address' },
    to: { type: 'string', description: 'Recipient address' },
    amount: { type: 'string', description: 'Amount (e.g. "1.0" for 1 ETH)' },
    tokenAddress: { type: 'string', description: 'Token address (omit for native)' },
    data: { type: 'string', description: 'Calldata (hex) for contract calls' },
  }, required: ['safeId', 'to', 'amount'] },
}, async (args: any) => vt('/api/vault/safe/propose', { method: 'POST', body: args }));

reg({
  name: 'vault_confirm_tx',
  description: 'Sign/confirm a pending multisig transaction with an ECDSA signature.',
  inputSchema: { type: 'object', properties: {
    safeAddress: { type: 'string', description: 'Safe contract address' },
    safeTxHash: { type: 'string', description: 'Safe transaction hash to confirm' },
    signature: { type: 'string', description: 'ECDSA signature (r+s+v hex)' },
  }, required: ['safeAddress', 'safeTxHash', 'signature'] },
}, async (args: any) => vt('/api/vault/safe/confirm', { method: 'POST', body: args }));

reg({
  name: 'vault_execute_tx',
  description: 'Execute a multisig transaction once threshold is met. Broadcasts on-chain.',
  inputSchema: { type: 'object', properties: {
    safeTxHash: { type: 'string', description: 'Safe transaction hash to execute' },
  }, required: ['safeTxHash'] },
}, async (args: any) => vt('/api/vault/safe/execute', { method: 'POST', body: args }));

// ─── Safe Maintenance ───

reg({
  name: 'vault_retry',
  description: 'Retry pending Safe deployments on a specific chain.',
  inputSchema: { type: 'object', properties: {
    chainId: { type: 'string', description: 'Chain ID to retry on (e.g. 11155111 for Sepolia)' },
  }, required: [] },
}, async (args: any) => vt('/api/vault/safe/retry', { method: 'POST', body: { chainId: args.chainId } }));

reg({
  name: 'vault_execute_ready',
  description: 'Execute all transactions that have met their signature threshold.',
  inputSchema: { type: 'object', properties: {
    safeAddress: { type: 'string', description: 'Safe contract address (optional, omit for all)' },
  }, required: [] },
}, async (args: any) => vt('/api/vault/safe/execute-ready', { method: 'POST', body: { safeAddress: args.safeAddress } }));

reg({
  name: 'vault_sync',
  description: 'Sync Safe on-chain state to the database. Re-reads signers, nonce, balance.',
  inputSchema: { type: 'object', properties: {
    safeAddress: { type: 'string', description: 'Safe contract address' },
  }, required: ['safeAddress'] },
}, async (args: any) => vt('/api/vault/safe/sync', { method: 'POST', body: { safeAddress: args.safeAddress } }));

reg({
  name: 'vault_status',
  description: 'Check overall Safe status: enabled, total count, deployed count.',
  inputSchema: { type: 'object', properties: {
    walletAddress: { type: 'string', description: 'Wallet address to check Safe status for (optional)' },
  }, required: [] },
}, async (args: any) => vt('/api/vault/safe/status' + (args.walletAddress ? '?walletAddress=' + encodeURIComponent(args.walletAddress) : '')));

// ─── Risk Control ───

reg({
  name: 'vault_risk_check',
  description: 'Check if a transaction is risky: blacklisted addresses, unusual patterns, AML flags.',
  inputSchema: { type: 'object', properties: {
    to: { type: 'string', description: 'Recipient address to check' },
    amount: { type: 'string', description: 'Amount to send' },
    chain: { type: 'string', description: 'Chain name' },
  }, required: ['to'] },
}, async (args: any) => vt('/api/vault/risk/check', { method: 'POST', body: args }));

// ═══ MCP JSON-RPC handler ═══

async function handle(req: any) {
  const { id, method, params } = req;
  try {
    if (method === 'initialize')
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'infrax-ault-mcp', version: '1.0.0' } } };
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

app.get('/mcp/sse', (_q, res) => {
  const sid = randomUUID();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`event: endpoint\ndata: /mcp/message?sessionId=${sid}\n\n`);
});

app.post('/mcp/message', async (req, res) => { res.json(await handle(req.body)); });
app.get('/health', (_q, res) => res.json({ status: 'ok', service: 'infrax-ault-mcp', tools: Object.keys(tools).length }));

app.listen(PORT, () => console.log(`InfraX Vault MCP :${PORT}`));
