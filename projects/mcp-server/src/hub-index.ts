// InfraX Hub MCP — Unified entry point (G-5 / 9.6 Phase 2.4)
// Aggregates the four data-stack services behind a single MCP endpoint:
//   data :9112 (bars / ticker / factors / snapshots / symbols / ml predictions)
//   injector :9113 (manual injection trigger)
//   ragservicer :9721 (knowledge base query)
// (ml-service :9120 standalone predictions are exposed via data /ml/predictions;
//  wire ML_URL directly if a dedicated ml_predict tool is needed)
//
// Run:  PORT=3008 DATA_URL=... DATA_API_KEY=... npx tsx src/hub-index.ts
//       or  npm run dev:hub
// MCP HTTP transport: POST /mcp/message (Streamable HTTP), GET /health
// Systemd unit: deploy/hub-index.service

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseToolsFromSource, buildOpenApiSpec } from "./openapi-spec.js";

// ── Upstream services (env-configurable, no hardcoded secrets) ──
const DATA_URL = process.env.DATA_URL || process.env.DATA_API_URL || "http://localhost:9112";
const DATA_API_KEY = process.env.DATA_API_KEY || "";
const INJECTOR_URL = process.env.INJECTOR_URL || "http://localhost:9113";
const INJECTOR_API_KEY = process.env.INJECTOR_API_KEY || "";
const RAG_URL = process.env.RAG_URL || process.env.RAGSERVICER_URL || "http://localhost:9721";
const RAG_API_KEY = process.env.RAG_API_KEY || "";

// ── MCP 入站鉴权 ──────────────────────────────────────────────
// /mcp/message 对外暴露，入站需携带有效 key（app_auth 契约三选一：
// Authorization: Bearer | X-API-Key | X-Service-Key）。受信 key：
//   1) MCP_API_KEY（逗号分隔白名单，默认回退 DATA_API_KEY bridge key）
//   2) 管理员签发的 MCP 专用 key（mx_ 前缀，scope=mcp，存 data 服务
//      api_keys 表）→ 调 data /api-keys/verify 实时校验
// /health 与 / 信息页豁免。
const MCP_API_KEYS = (process.env.MCP_API_KEY || process.env.DATA_API_KEY || "")
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractInboundKey(req: any): string {
  const auth = (req.headers["authorization"] || "").trim();
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return (req.headers["x-api-key"] || req.headers["x-service-key"] || "").trim();
}

async function verifyInboundKey(key: string): Promise<boolean> {
  if (!key) return false;
  // 1) 受信白名单（MCP_API_KEY / bridge key）
  if (MCP_API_KEYS.some(k => k && timingSafeEqualStr(k, key))) return true;
  // 2) 签发的 MCP 专用 key（mx_，scope=mcp）→ data 服务实时校验
  if (!DATA_API_KEY) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${DATA_URL}/api-keys/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DATA_API_KEY}` },
      body: JSON.stringify({ api_key: key }),
      signal: ctrl.signal,
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function api(base: string, key: string, path: string, opts?: { method?: string; body?: any }) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["X-API-Key"] = key;
  const r = await fetch(base + path, {
    method: opts?.method || "GET",
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`${base}${path} -> ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

const server = new McpServer({
  name: "infrax-hub-mcp",
  version: "1.0.0",
});

// ═══════════ data (:9112) ═══════════

server.tool(
  "data_bars",
  "Query OHLCV kline bars from the InfraX market data service. Supports stocks, forex, crypto (spot/swap) and A-share symbols.",
  {
    symbol: z.string().describe("Trading symbol, e.g. BTC/USDT, BTCUSDT, AAPL, EURUSD, 600519, GC=F"),
    timeframe: z.string().optional().describe("Bar timeframe, e.g. 1d, 4h, 1m (default: 1d)"),
    start: z.coerce.number().optional().describe("Start time in epoch milliseconds"),
    end: z.coerce.number().optional().describe("End time in epoch milliseconds"),
    limit: z.coerce.number().optional().describe("Max bars to return (default 500)"),
  },
  async (p) => {
    const q = new URLSearchParams({ symbol: p.symbol });
    if (p.timeframe) q.set("timeframe", p.timeframe);
    if (p.start) q.set("start", String(p.start));
    if (p.end) q.set("end", String(p.end));
    if (p.limit) q.set("limit", String(p.limit));
    const data = await api(DATA_URL, DATA_API_KEY, `/bars?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "data_ticker",
  "Get the latest market ticker (price) for a symbol from the InfraX market data service.",
  {
    symbol: z.string().describe("Trading symbol, e.g. BTC/USDT, AAPL, EURUSD"),
  },
  async ({ symbol }) => {
    const data = await api(DATA_URL, DATA_API_KEY, `/ticker?symbol=${encodeURIComponent(symbol)}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "data_factors",
  "Query technical / macro / on-chain factors for a symbol (current values).",
  {
    symbol: z.string().describe("Trading symbol, e.g. BTC/USDT, AAPL"),
    factor: z.string().optional().describe("Specific factor id (see /factors/catalog), e.g. us10y, rsi14; omit for all"),
  },
  async ({ symbol, factor }) => {
    const q = new URLSearchParams({ symbol });
    if (factor) q.set("factor", factor);
    const data = await api(DATA_URL, DATA_API_KEY, `/factors/current?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "data_factors_history",
  "Query historical factor series for a symbol over a time window.",
  {
    symbol: z.string().describe("Trading symbol, e.g. BTC/USDT, AAPL"),
    factor: z.string().describe("Factor id (see /factors/catalog), e.g. us10y"),
    start: z.coerce.number().optional().describe("Start time in epoch milliseconds"),
    end: z.coerce.number().optional().describe("End time in epoch milliseconds"),
    limit: z.coerce.number().optional().describe("Max points (default 500)"),
  },
  async ({ symbol, factor, start, end, limit }) => {
    const q = new URLSearchParams({ symbol, factor });
    if (start) q.set("start", String(start));
    if (end) q.set("end", String(end));
    if (limit) q.set("limit", String(limit));
    const data = await api(DATA_URL, DATA_API_KEY, `/factors/history?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "data_snapshots",
  "Query snapshot data (macro, crypto, onchain, defi, indices...) by type.",
  {
    type: z.string().optional().describe("Snapshot type, e.g. onchain (BTC sub-types), macro, indices, defi_tvl"),
    date: z.string().optional().describe("Date filter (YYYY-MM-DD)"),
    limit: z.coerce.number().optional().describe("Max records (default 100)"),
  },
  async ({ type, date, limit }) => {
    const q = new URLSearchParams();
    if (type) q.set("type", type);
    if (date) q.set("date", date);
    if (limit) q.set("limit", String(limit));
    const data = await api(DATA_URL, DATA_API_KEY, `/snapshots?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "data_symbols",
  "List or search supported trading symbols in the InfraX market data service.",
  {
    query: z.string().optional().describe("Search keyword, e.g. BTC or 600519; omit to list all"),
    market: z.string().optional().describe("Market: crypto (default), usstock, forex, futures, cnstock, hkstock"),
    limit: z.coerce.number().optional().describe("Max results (default 20, max 100)"),
  },
  async ({ query, market, limit }) => {
    if (query) {
      const q = new URLSearchParams({ keyword: query });
      if (market) q.set("market", market);
      if (limit) q.set("limit", String(limit));
      return { content: [{ type: "text" as const, text: JSON.stringify(
        await api(DATA_URL, DATA_API_KEY, `/symbols/search?${q.toString()}`), null, 2) }] };
    }
    const q = new URLSearchParams();
    if (market) q.set("market", market);
    if (limit) q.set("limit", String(limit));
    const data = await api(DATA_URL, DATA_API_KEY, `/symbols?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "ml_predictions",
  "Get model predictions for a symbol from the InfraX ML pipeline (tree / direction models).",
  {
    symbol: z.string().describe("Trading symbol, e.g. BTC/USDT, 000333"),
  },
  async ({ symbol }) => {
    const data = await api(DATA_URL, DATA_API_KEY, `/ml/predictions?symbol=${encodeURIComponent(symbol)}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "data_symbol_search",
  "Fuzzy-search supported symbols across markets (crypto / usstock / forex / futures / cnstock / hkstock).",
  {
    keyword: z.string().describe("Fuzzy keyword, e.g. btc, eth, apple, 600519"),
    market: z.string().optional().describe("Market: crypto (default), usstock, forex, futures, cnstock, hkstock"),
    limit: z.coerce.number().optional().describe("Max results (default 20, max 100)"),
  },
  async ({ keyword, market, limit }) => {
    const q = new URLSearchParams({ keyword });
    if (market) q.set("market", market);
    if (limit) q.set("limit", String(limit));
    const data = await api(DATA_URL, DATA_API_KEY, `/symbols/search?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "data_symbol_resolve",
  "Resolve a raw symbol keyword to the canonical trading symbol (e.g. BTC -> BTCUSDT).",
  {
    symbol: z.string().describe("Symbol keyword, e.g. BTC, BTC/USDT, EURUSD=X, apple"),
    market: z.string().optional().describe("Market: crypto (default), usstock, forex, futures, cnstock, hkstock"),
  },
  async ({ symbol, market }) => {
    const q = new URLSearchParams({ symbol });
    if (market) q.set("market", market);
    const data = await api(DATA_URL, DATA_API_KEY, `/symbol/resolve?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "data_broker_policy",
  "Get the broker market policy (which exchanges are the primary trading venue per market).",
  {},
  async () => {
    const data = await api(DATA_URL, DATA_API_KEY, `/policy/broker-market`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "data_stats",
  "Get InfraX data service database stats (kline rows, snapshot rows, symbol count, coverage range).",
  {},
  async () => {
    const data = await api(DATA_URL, DATA_API_KEY, `/stats`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ═══════════ injector (:9113) ═══════════

server.tool(
  "injector_trigger",
  "Trigger a manual data injection into the knowledge graph (fetches + embeds a data source). Write op: runs background ingestion.",
  {
    source: z.string().describe("Injector source, e.g. macro, sentiment, crypto_overview, onchain, defi_tvl, news_sentiment"),
  },
  async ({ source }) => {
    const data = await api(INJECTOR_URL, INJECTOR_API_KEY, `/inject/${encodeURIComponent(source)}`, { method: "POST" });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ═══════════ ragservicer (:9721) ═══════════

server.tool(
  "rag_query",
  "Query the InfraX RAG knowledge base (vector + graph + keyword hybrid search). Returns relevant context from indexed documents.",
  {
    namespace: z.string().describe("Namespace/collection to query, e.g. market, onchain"),
    query: z.string().describe("Natural language query"),
    mode: z.enum(["mix", "local", "global", "hybrid", "naive"]).optional().describe("Search mode (default mix)"),
  },
  async ({ namespace, query, mode }) => {
    const data = await api(RAG_URL, RAG_API_KEY, `/api/v1/namespaces/${encodeURIComponent(namespace)}/query`, {
      method: "POST",
      body: { query, mode: mode || "mix" },
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ═══════════ HTTP transport ═══════════

const app = express();
app.use(express.json());

// 入站鉴权中间件（豁免 /health、/ 信息页与 /openapi.json 公开文档）
app.use(async (req: any, res: any, next: any) => {
  const p = req.path || "/";
  if (p === "/health" || p === "/" || p === "/openapi.json") return next();
  try {
    if (!(await verifyInboundKey(extractInboundKey(req)))) {
      return res.status(401).json({ error: "unauthorized" });
    }
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ status: "ok", service: "infrax-hub-mcp", uptime: process.uptime() }));

// OpenAPI 3.1 spec：从本文件源码解析已注册工具动态生成（Phase 3.2，单源）
app.get("/openapi.json", (_req, res) => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "hub-index.ts"), "utf8");
  const spec = buildOpenApiSpec(parseToolsFromSource(src), process.env.HUB_BASE_URL || `http://localhost:${PORT}`);
  res.json(spec);
});

app.post("/mcp/message", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/", (_req, res) => res.json({ service: "InfraX Hub MCP", version: "1.0.0", endpoint: "/mcp/message" }));

const PORT = parseInt(process.env.PORT || "3008", 10);
app.listen(PORT, () => console.log(`InfraX Hub MCP running on port ${PORT}`));
