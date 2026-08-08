// InfraX MCP Server — Chain-RPC Gateway (MQ-10 补充 B)
// Standalone MCP process bridging AI ↔ chain-rpc 网关 (:9130)
// Tools: chain_rpc_read / chain_rpc_broadcast / chain_rpc_status / chain_rpc_health
// 出站：X-Service-Key（读 key → /v1/rpc、广播 key → /v1/broadcast）
// 入站：inboundAuth（MCP_API_KEY 白名单或 data 服务签发 key，见 mcp-auth.ts）

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { inboundAuth } from './mcp-auth.js';

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));
app.use(inboundAuth);

const GATEWAY = process.env.CHAIN_RPC_URL || 'http://localhost:9130';
const READ_KEY = process.env.CHAIN_RPC_READ_KEY || '';
const BROADCAST_KEY = process.env.CHAIN_RPC_BROADCAST_KEY || '';
const PORT = parseInt(process.env.PORT || '3012', 10);

async function gateway(path: string, opts?: { method?: string; body?: any; key?: string }) {
  const headers: any = { 'Content-Type': 'application/json' };
  if (opts?.key) headers['X-Service-Key'] = opts.key;
  const r = await fetch(GATEWAY + path, {
    method: opts?.method || 'GET',
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

const tools: Record<string, any> = {};
function reg(def: any, fn: Function) { tools[def.name] = { def, handler: fn }; }

reg({
  name: 'chain_rpc_read',
  description: '通用链上读调用（JSON-RPC 读方法白名单，经 chain-rpc 网关）。示例方法：eth_blockNumber、eth_getBalance、eth_call、eth_getLogs、eth_estimateGas、eth_chainId、eth_feeHistory；Solana：getSlot、getBalance、getHealth。',
  inputSchema: { type: 'object', properties: {
    chain: { type: 'string', description: 'Chain: sepolia, eth, bsc, base, oxa, solana (default: sepolia)' },
    method: { type: 'string', description: 'JSON-RPC 读方法名（网关白名单内）' },
    params: { type: 'array', description: '方法参数数组（可选）' },
  }, required: ['method'] },
}, async (args: any) => {
  const r = await gateway(`/v1/rpc/${encodeURIComponent(args.chain || 'sepolia')}`, {
    method: 'POST', key: READ_KEY,
    body: { method: args.method, params: args.params || [] },
  });
  return { status: r.status, ...(r.body || {}) };
});

reg({
  name: 'chain_rpc_broadcast',
  description: '广播已签名交易（EVM eth_sendRawTransaction / Solana sendTransaction，经 chain-rpc 网关）。rawTransaction 为调用方已签名数据。返回 txHash；wait=true 时附回执。需服务端已配置广播 key。',
  inputSchema: { type: 'object', properties: {
    chain: { type: 'string', description: 'Chain: sepolia, eth, bsc, base, oxa, solana (default: sepolia)' },
    rawTransaction: { type: 'string', description: '已签名的原始交易（EVM 为 0x hex，Solana 为 base58）' },
    wait: { type: 'boolean', description: '是否等待回执（默认 false）' },
  }, required: ['rawTransaction'] },
}, async (args: any) => {
  if (!BROADCAST_KEY) {
    return { error: 'CHAIN_RPC_BROADCAST_KEY not configured on server: broadcast unavailable' };
  }
  const r = await gateway(`/v1/broadcast/${encodeURIComponent(args.chain || 'sepolia')}`, {
    method: 'POST', key: BROADCAST_KEY,
    body: { rawTransaction: args.rawTransaction, wait: args.wait ?? false },
  });
  return { status: r.status, ...(r.body || {}) };
});

reg({
  name: 'chain_rpc_status',
  description: '查询 chain-rpc 网关池状态：各链健康状态、活跃端点数（端点 URL 脱敏）。',
  inputSchema: { type: 'object', properties: {}, required: [] },
}, async () => {
  const r = await gateway('/v1/status', { key: READ_KEY });
  return { status: r.status, ...(r.body || {}) };
});

reg({
  name: 'chain_rpc_health',
  description: 'chain-rpc 网关健康检查（无需网关 key）。',
  inputSchema: { type: 'object', properties: {}, required: [] },
}, async () => {
  const r = await gateway('/health');
  return { status: r.status, ...(r.body || {}) };
});

async function handle(req: any) {
  const { id, method, params } = req;
  try {
    if (method === 'initialize')
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'infrax-rpc-mcp', version: '1.0.0' } } };
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
app.get('/health', (_q, res) => res.json({ status: 'ok', service: 'infrax-rpc-mcp', tools: Object.keys(tools).length }));

app.listen(PORT, () => console.log(`InfraX Chain-RPC MCP :${PORT}`));
