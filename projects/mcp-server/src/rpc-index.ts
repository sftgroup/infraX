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

async function gateway(path: string, opts?: { method?: string; body?: any; key?: string; rpcKey?: string }) {
  const headers: any = { 'Content-Type': 'application/json' };
  if (opts?.key) headers['X-Service-Key'] = opts.key;
  if (opts?.rpcKey) headers['X-RPC-Key'] = opts.rpcKey;
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

// ── MQ-16 T-3: Chain RPC 套餐订阅面（/v1/subscription/*）──
// issue-key 用服务端 read key（X-Service-Key）；checkout/payment-check/verify/usage 用 rx_ 读 key（X-RPC-Key）。

reg({
  name: 'chain_rpc_subscription_plans',
  description: '列出 Chain RPC 套餐目录（公开）。',
  inputSchema: { type: 'object', properties: {}, required: [] },
}, async () => {
  const r = await gateway('/v1/subscription/plans');
  return { status: r.status, ...(r.body || {}) };
});

reg({
  name: 'chain_rpc_subscription_issue_key',
  description: '签发一个 rx_ 读 key（管理操作；用服务端 read/broadcast key）。rpcKey 仅显示一次，需安全保存。',
  inputSchema: { type: 'object', properties: {
    label: { type: 'string', description: '可选标签（默认 "rpc key"）' },
  }, required: [] },
}, async (args: any) => {
  const r = await gateway('/v1/subscription/issue-key', { method: 'POST', key: READ_KEY, body: { label: args.label } });
  return { status: r.status, ...(r.body || {}) };
});

reg({
  name: 'chain_rpc_subscription_checkout',
  description: '发起 Chain RPC 套餐订阅支付（rx_ key 鉴权）。免费套餐直接激活；付费套餐返回支付意图（chain/fiat/x402）。',
  inputSchema: { type: 'object', properties: {
    rpcKey: { type: 'string', description: 'rx_ 读 key（X-RPC-Key 鉴权）' },
    plan_id: { type: 'string', description: '套餐 id，如 rpc_pro / rpc_enterprise' },
    rail: { type: 'string', description: '支付 rail：chain | fiat | x402（默认 chain）' },
    subscriber: { type: 'string', description: '可选自定义 subscriber（默认 rpclin:<keyId>）' },
  }, required: ['rpcKey', 'plan_id'] },
}, async (args: any) => {
  const r = await gateway('/v1/subscription/checkout', {
    method: 'POST', rpcKey: args.rpcKey,
    body: { plan_id: args.plan_id, rail: args.rail, subscriber: args.subscriber },
  });
  return { status: r.status, ...(r.body || {}) };
});

reg({
  name: 'chain_rpc_subscription_payment_check',
  description: '轮询 Chain RPC 订阅支付状态（chain rail 链上确认）。',
  inputSchema: { type: 'object', properties: {
    rpcKey: { type: 'string', description: 'rx_ 读 key' },
    subscriber: { type: 'string', description: '可选 subscriber 引用' },
  }, required: ['rpcKey'] },
}, async (args: any) => {
  const r = await gateway('/v1/subscription/payment-check', {
    method: 'POST', rpcKey: args.rpcKey, body: { subscriber: args.subscriber },
  });
  return { status: r.status, ...(r.body || {}) };
});

reg({
  name: 'chain_rpc_subscription_verify',
  description: 'x402 rail 支付确认：提交 txHash 激活 pending x402 订阅。',
  inputSchema: { type: 'object', properties: {
    rpcKey: { type: 'string', description: 'rx_ 读 key' },
    txHash: { type: 'string', description: '链上交易哈希（0x...）' },
  }, required: ['rpcKey', 'txHash'] },
}, async (args: any) => {
  const r = await gateway('/v1/subscription/verify', {
    method: 'POST', rpcKey: args.rpcKey, body: { txHash: args.txHash },
  });
  return { status: r.status, ...(r.body || {}) };
});

reg({
  name: 'chain_rpc_subscription_usage',
  description: '查询 Chain RPC 订阅用量：套餐、月度配额、实际用量、日聚合。',
  inputSchema: { type: 'object', properties: {
    rpcKey: { type: 'string', description: 'rx_ 读 key' },
  }, required: ['rpcKey'] },
}, async (args: any) => {
  const r = await gateway('/v1/subscription/usage', { rpcKey: args.rpcKey });
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
