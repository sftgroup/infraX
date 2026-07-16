// InfraX MCP Server — MPC Wallet (Phase 4)
// Standalone MCP process bridging AI ↔ MPC API

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));

const MPC = process.env.MPC_URL || 'http://localhost:6003';
const PORT = parseInt(process.env.PORT || '3007', 10);

async function mpc(path: string, opts?: { method?: string; body?: any }) {
  const headers: any = { 'Content-Type': 'application/json' };
  const r = await fetch(MPC + path, { method: opts?.method || 'GET', headers, body: opts?.body ? JSON.stringify(opts.body) : undefined });
  return r.json();
}

const tools: Record<string, any> = {};
function reg(def: any, fn: Function) { tools[def.name] = { def, handler: fn }; }

reg({
  name: 'mpc_send_code',
  description: 'Send verification code to email. First step in creating or recovering an MPC wallet.',
  inputSchema: { type: 'object', properties: {
    email: { type: 'string', description: 'Email address for the MPC wallet' },
  }, required: ['email'] },
}, async (args: any) => mpc('/api/v2/mpc/send-code', { method: 'POST', body: args }));

reg({
  name: 'mpc_register',
  description: 'Register a new MPC wallet. Requires email + verification code from mpc_send_code. Returns wallet address.',
  inputSchema: { type: 'object', properties: {
    email: { type: 'string', description: 'Email address' },
    code: { type: 'string', description: '6-digit verification code from email' },
  }, required: ['email', 'code'] },
}, async (args: any) => mpc('/api/v2/mpc/register', { method: 'POST', body: args }));

reg({
  name: 'mpc_recover',
  description: 'Recover an existing MPC wallet. Requires email + verification code. Returns the wallet address.',
  inputSchema: { type: 'object', properties: {
    email: { type: 'string', description: 'Email address used for wallet creation' },
    code: { type: 'string', description: '6-digit verification code sent to email' },
  }, required: ['email', 'code'] },
}, async (args: any) => mpc('/api/v2/mpc/recover', { method: 'POST', body: args }));

reg({
  name: 'mpc_status',
  description: 'Check MPC wallet registration status for an email. Returns whether wallet exists and its address.',
  inputSchema: { type: 'object', properties: {
    email: { type: 'string', description: 'Email to check' },
  }, required: ['email'] },
}, async (args: any) => mpc(`/api/v2/mpc/status?email=${encodeURIComponent(args.email)}`));

reg({
  name: 'mpc_create_wallet',
  description: 'Full MPC wallet creation flow: send code → register. Run this to create a new MPC wallet. Check your email for the verification code.',
  inputSchema: { type: 'object', properties: {
    email: { type: 'string', description: 'Email for wallet creation' },
  }, required: ['email'] },
}, async (args: any) => {
  const step1 = await mpc('/api/v2/mpc/send-code', { method: 'POST', body: { email: args.email } });
  if (step1.code !== 0) return { step: 'send_code', error: step1.message };
  return {
    message: 'Verification code sent. Use mpc_register to complete with the code from your email.',
    nextStep: 'mpc_register',
    email: args.email,
  };
});

reg({
  name: 'mpc_session_unlock',
  description: 'Unlock an MPC wallet for agent use. Requires email + verification code (ONE-TIME only). Returns a session token — save this token and use it for all subsequent operations. The session lasts 30 minutes.',
  inputSchema: { type: 'object', properties: {
    email: { type: 'string', description: 'Email of the registered MPC wallet' },
    code: { type: 'string', description: '6-digit verification code from email' },
  }, required: ['email', 'code'] },
}, async (args: any) => mpc('/api/v2/mpc/session/unlock', { method: 'POST', body: args }));

reg({
  name: 'mpc_session_lock',
  description: 'Lock the MPC wallet session. Clears the cached private key from memory. The session token becomes invalid.',
  inputSchema: { type: 'object', properties: {
    token: { type: 'string', description: 'Session token from mpc_session_unlock' },
  }, required: ['token'] },
}, async (args: any) => mpc('/api/v2/mpc/session/lock', { method: 'POST', body: args }));

reg({
  name: 'mpc_session_status',
  description: 'Check if a session token is still valid and how much time remains.',
  inputSchema: { type: 'object', properties: {
    token: { type: 'string', description: 'Session token from mpc_session_unlock' },
  }, required: ['token'] },
}, async (args: any) => mpc(`/api/v2/mpc/session/status?token=${encodeURIComponent(args.token)}`));

reg({
  name: 'mpc_balance',
  description: 'Query MPC wallet balance on any supported chain using session token. Supports native token and ERC20 token balances.',
  inputSchema: { type: 'object', properties: {
    token: { type: 'string', description: 'Session token from mpc_session_unlock' },
    chain: { type: 'string', description: 'Chain: sepolia, eth, bsc, base, oxa (default: sepolia)' },
    tokenAddress: { type: 'string', description: 'Optional ERC20 token contract address' },
  }, required: ['token'] },
}, async (args: any) => mpc('/api/v2/mpc/balance', { method: 'POST', body: args }));

reg({
  name: 'mpc_sign_message',
  description: 'Sign an arbitrary message using EIP-191 (personal_sign). Requires a valid session token from mpc_session_unlock.',
  inputSchema: { type: 'object', properties: {
    token: { type: 'string', description: 'Session token from mpc_session_unlock' },
    message: { type: 'string', description: 'Message to sign (plain text or hex)' },
  }, required: ['token', 'message'] },
}, async (args: any) => mpc('/api/v2/mpc/sign-message', { method: 'POST', body: args }));

reg({
  name: 'mpc_sign_typed_data',
  description: 'Sign EIP-712 typed structured data. Used for permit signatures, order signing, etc. Requires a valid session token.',
  inputSchema: { type: 'object', properties: {
    token: { type: 'string', description: 'Session token from mpc_session_unlock' },
    domain: { type: 'object', description: 'EIP-712 domain separator' },
    types: { type: 'object', description: 'EIP-712 type definitions' },
    value: { type: 'object', description: 'EIP-712 message value' },
  }, required: ['token', 'domain', 'types', 'value'] },
}, async (args: any) => mpc('/api/v2/mpc/sign-typed-data', { method: 'POST', body: args }));

reg({
  name: 'mpc_send_transaction',
  description: 'Send ETH or ERC20 tokens from the MPC wallet. Max 0.1 ETH per transaction for native transfers. Requires a valid session token.',
  inputSchema: { type: 'object', properties: {
    token: { type: 'string', description: 'Session token from mpc_session_unlock' },
    to: { type: 'string', description: 'Recipient address (0x...)' },
    amount: { type: 'string', description: 'Amount to send (ETH for native, token units for ERC20)' },
    chain: { type: 'string', description: 'Chain: sepolia, eth, bsc, base, oxa (default: sepolia)' },
    tokenAddress: { type: 'string', description: 'Optional ERC20 token contract address for token transfers' },
  }, required: ['token', 'to', 'amount'] },
}, async (args: any) => mpc('/api/v2/mpc/send-transaction', { method: 'POST', body: args }));

reg({
  name: 'mpc_contract_read',
  description: 'Call a smart contract read-only method (eth_call). No gas is spent. Does NOT require session unlock — just pass a token or email for context.',
  inputSchema: { type: 'object', properties: {
    contractAddress: { type: 'string', description: 'Contract address (0x...)' },
    abi: { type: 'array', description: 'Contract ABI for the method' },
    method: { type: 'string', description: 'Contract method name to call' },
    args: { type: 'array', description: 'Arguments to pass to the method' },
    chain: { type: 'string', description: 'Chain (default: sepolia)' },
  }, required: ['contractAddress', 'abi', 'method'] },
}, async (args: any) => mpc('/api/v2/mpc/contract-read', { method: 'POST', body: args }));

reg({
  name: 'mpc_contract_write',
  description: 'Write to a smart contract (send a state-changing transaction). Automatically simulates first — if simulation fails, the transaction is blocked. Supports approve, transferFrom, and any contract method. Requires a valid session token.',
  inputSchema: { type: 'object', properties: {
    token: { type: 'string', description: 'Session token from mpc_session_unlock' },
    contractAddress: { type: 'string', description: 'Contract address (0x...)' },
    abi: { type: 'array', description: 'Contract ABI' },
    method: { type: 'string', description: 'Method name to call (e.g. approve, transferFrom)' },
    args: { type: 'array', description: 'Arguments for the method' },
    chain: { type: 'string', description: 'Chain (default: sepolia)' },
    value: { type: 'string', description: 'Optional ETH value to send with the call' },
    gasLimit: { type: 'string', description: 'Optional gas limit override' },
  }, required: ['token', 'contractAddress', 'abi', 'method'] },
}, async (args: any) => mpc('/api/v2/mpc/contract-write', { method: 'POST', body: args }));

reg({
  name: 'mpc_gas_estimate',
  description: 'Estimate gas cost for a transaction before sending. No funds are spent. No session unlock required.',
  inputSchema: { type: 'object', properties: {
    to: { type: 'string', description: 'Recipient address' },
    value: { type: 'string', description: 'ETH value to send' },
    data: { type: 'string', description: 'Transaction calldata' },
    chain: { type: 'string', description: 'Chain (default: sepolia)' },
  }, required: [] },
}, async (args: any) => mpc('/api/v2/mpc/gas-estimate', { method: 'POST', body: args }));

async function handle(req: any) {
  const { id, method, params } = req;
  try {
    if (method === 'initialize')
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'infrax-mpc-mcp', version: '1.0.0' } } };
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
app.get('/health', (_q, res) => res.json({ status: 'ok', service: 'infrax-mpc-mcp', tools: Object.keys(tools).length }));

app.listen(PORT, () => console.log(`InfraX MPC MCP :${PORT}`));
