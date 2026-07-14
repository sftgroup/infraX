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

async function handle(req: any) {
  const { id, method, params } = req;
  try {
    if (method === 'initialize')
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'infrax-pc-mcp', version: '1.0.0' } } };
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
app.get('/health', (_q, res) => res.json({ status: 'ok', service: 'infrax-pc-mcp', tools: Object.keys(tools).length }));

app.listen(PORT, () => console.log(`InfraX MPC MCP :${PORT}`));
