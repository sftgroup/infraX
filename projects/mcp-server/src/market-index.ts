import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// B-10-3 修复：同 dc-index，DC_API_KEY 缺失时 fail-fast，禁止静默发送占位 key（test-key）→ 必然 401。
const DC_URL = process.env.DC_URL || process.env.DC_API_URL || "http://localhost:9102";
const DC_API_KEY = process.env.DC_API_KEY || "";

async function market(path: string, options: RequestInit = {}) {
  if (!DC_API_KEY) {
    throw new Error(
      "DC_API_KEY is not configured for market-mcp. Set it in the systemd drop-in " +
      "(see deploy/overrides/templates/dc-mcp-key.conf.template) — value: tenants.dc_api_key of the target tenant."
    );
  }
  const r = await fetch(`${DC_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": DC_API_KEY,
      ...options.headers,
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Market API ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

const server = new McpServer({
  name: "infrax-market-mcp",
  version: "1.0.0",
});

// ── market_search ──────────────────────────────────────────────────
server.tool(
  "market_search",
  "Search for DEX tokens by name or symbol across 20+ chains",
  {
    keyword: z.string().describe("Token name or symbol to search for"),
    chainIndex: z.string().optional().describe("Chain ID (1=ETH, 56=BSC, 8453=Base, 501=Solana)"),
    limit: z.string().optional().describe("Max results (default 20)"),
  },
  async (params) => {
    const q = new URLSearchParams({ keyword: params.keyword });
    if (params.chainIndex) q.set("chainIndex", params.chainIndex);
    if (params.limit) q.set("limit", params.limit);
    const data = await market(`/api/v2/data/market/token-search?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── market_hot ─────────────────────────────────────────────────────
server.tool(
  "market_hot",
  "Get trending/hot tokens — customizable by ranking type, time frame, sort, and 30+ filters",
  {
    chainIndex: z.string().describe("Chain ID (1=ETH, 56=BSC, 8453=Base)"),
    limit: z.string().optional().describe("Max results (default 50, max 100)"),
    rankingType: z.string().optional().describe("4=Trending(token score), 5=Xmentioned(Twitter mentions)"),
    rankingTimeFrame: z.string().optional().describe("1=5min, 2=1h(default), 3=4h, 4=24h"),
    rankBy: z.string().optional().describe("2=priceChange, 5=volumeUSD, 10=holders, 12=socialScore, 14=netInflow, 15=tokenScore"),
    riskFilter: z.string().optional().describe("Hide risky tokens (default true)"),
    protocolId: z.string().optional().describe("Protocol filter, e.g. 120596 for Pump.fun"),
    marketCapMin: z.string().optional().describe("Min market cap in USD"),
    liquidityMin: z.string().optional().describe("Min liquidity in USD"),
    holdersMin: z.string().optional().describe("Min holder count"),
  },
  async (params) => {
    const { chainIndex, limit, ...rest } = params;
    const q = new URLSearchParams({ chainIndex });
    if (limit) q.set("limit", limit);
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined && v !== '') q.set(k, String(v));
    }
    const data = await market(`/api/v2/data/market/hot-tokens?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── market_candles ─────────────────────────────────────────────────
server.tool(
  "market_candles",
  "Get K-line (OHLCV) candle data for a token",
  {
    chainIndex: z.string().describe("Chain ID (1=ETH, 56=BSC, 8453=Base)"),
    tokenAddress: z.string().describe("Token contract address"),
    period: z.string().optional().describe("Candle period: 5m, 15m, 1H, 4H, 1D (default 15m)"),
    limit: z.string().optional().describe("Number of candles (default 100)"),
  },
  async ({ chainIndex, tokenAddress, period, limit }) => {
    const q = new URLSearchParams({ chainIndex, tokenAddress });
    if (period) q.set("period", period);
    if (limit) q.set("limit", limit);
    const data = await market(`/api/v2/data/market/candles?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── market_price ───────────────────────────────────────────────────
server.tool(
  "market_price",
  "Get real-time DEX price for a specific token on a specific chain",
  {
    chainIndex: z.string().describe("Chain ID"),
    tokenAddress: z.string().describe("Token contract address"),
  },
  async ({ chainIndex, tokenAddress }) => {
    const data = await market(`/api/v2/data/market/price?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── market_balances ────────────────────────────────────────────────
server.tool(
  "market_balances",
  "Get all token balances for a wallet address (free — no credit cost)",
  {
    address: z.string().describe("Wallet address (0x...) or Solana address"),
    chains: z.string().optional().describe("Comma-separated chain IDs (default: all)"),
  },
  async ({ address, chains }) => {
    let q = `address=${encodeURIComponent(address)}`;
    if (chains) q += `&chains=${chains}`;
    const data = await market(`/api/v2/data/market/balances?${q}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── market_transactions ────────────────────────────────────────────
server.tool(
  "market_transactions",
  "Get transaction history for a wallet address (free — no credit cost)",
  {
    address: z.string().describe("Wallet address"),
    chains: z.string().optional().describe("Comma-separated chain IDs"),
    limit: z.string().optional().describe("Max transactions (default 50)"),
  },
  async ({ address, chains, limit }) => {
    let q = `address=${encodeURIComponent(address)}`;
    if (chains) q += `&chains=${chains}`;
    if (limit) q += `&limit=${limit}`;
    const data = await market(`/api/v2/data/market/transactions?${q}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── market_mempump ─────────────────────────────────────────────────
server.tool(
  "market_mempump",
  "Get meme coin pump/trenches token list — includes honeypot detection, dev holding %, bundle detection",
  {
    chainIndex: z.string().describe("Chain ID"),
    protocol: z.string().optional().describe("Protocol filter (e.g. pump.fun)"),
    sortBy: z.string().optional().describe("Sort by: volume24h, liquidity, priceChange24h (default volume24h)"),
    limit: z.string().optional().describe("Max results (default 50)"),
  },
  async ({ chainIndex, protocol, sortBy, limit }) => {
    const q = new URLSearchParams({ chainIndex });
    if (protocol) q.set("protocol", protocol);
    if (sortBy) q.set("sortBy", sortBy);
    if (limit) q.set("limit", limit);
    const data = await market(`/api/v2/data/market/mempump/list?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── market_mempump_detail ──────────────────────────────────────────
server.tool(
  "market_mempump_detail",
  "Get detailed info for a specific meme coin — dev info, bundle detection, holder data",
  {
    chainIndex: z.string().describe("Chain ID"),
    tokenAddress: z.string().describe("Token contract address"),
  },
  async ({ chainIndex, tokenAddress }) => {
    const data = await market(`/api/v2/data/market/mempump/details?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── market_signals ─────────────────────────────────────────────────
server.tool(
  "market_signals",
  "Get smart money / whale / KOL trading signals for a chain",
  {
    chainIndex: z.string().describe("Chain ID"),
    signalType: z.string().optional().describe("Signal type: whale_buy, smart_money, kol_entry"),
    limit: z.string().optional().describe("Max results (default 50)"),
  },
  async ({ chainIndex, signalType, limit }) => {
    const q = new URLSearchParams({ chainIndex });
    if (signalType) q.set("signalType", signalType);
    if (limit) q.set("limit", limit);
    const data = await market(`/api/v2/data/market/signals?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── market_leaderboard ─────────────────────────────────────────────
server.tool(
  "market_leaderboard",
  "Get top trader leaderboard — ranked by PnL, win rate, or volume",
  {
    chainIndex: z.string().describe("Chain ID"),
    leaderboardType: z.string().optional().describe("Type: pnl, winRate, volume (default pnl)"),
    limit: z.string().optional().describe("Max entries (default 50)"),
  },
  async ({ chainIndex, leaderboardType, limit }) => {
    const q = new URLSearchParams({ chainIndex });
    if (leaderboardType) q.set("leaderboardType", leaderboardType);
    if (limit) q.set("limit", limit);
    const data = await market(`/api/v2/data/market/leaderboard?${q.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── track_token (add to monitoring) ────────────────────────────────
server.tool(
  "track_token",
  "Add a token to the user's monitoring list so candles and snapshots are automatically collected",
  {
    chain: z.string().describe("Chain ID (1=ETH, 56=BSC, 8453=Base)"),
    tokenAddress: z.string().describe("Token contract address"),
    label: z.string().optional().describe("Optional label for this token"),
  },
  async ({ chain, tokenAddress, label }) => {
    const data = await market("/api/v2/data/market/tracked-tokens", {
      method: "POST",
      body: JSON.stringify({ chain, tokenAddress, label }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── list_tracked ────────────────────────────────────────────────────
server.tool(
  "list_tracked",
  "List all tokens currently being monitored (user-configured tracking list)",
  {
    chain: z.string().optional().describe("Filter by chain ID"),
  },
  async ({ chain }) => {
    const q = chain ? `?chain=${chain}` : "";
    const data = await market(`/api/v2/data/market/tracked-tokens${q}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── register_event ──────────────────────────────────────────────────
server.tool(
  "register_event",
  "Register a custom event signature for on-chain event classification. Provide topic hash and event type. Optional ABI for full parameter decoding.",
  {
    chain: z.string().describe("Chain name (ethereum, bsc, base)"),
    topicHash: z.string().describe("Event topic hash (0x + 64 hex chars, keccak256 of event signature)"),
    eventType: z.string().describe("Custom event type name (e.g. pool_created, stake_deposited)"),
    eventName: z.string().optional().describe("Human-readable event name"),
    abi: z.string().optional().describe("Event ABI JSON string for parameter decoding"),
  },
  async ({ chain, topicHash, eventType, eventName, abi }) => {
    let parsedAbi = undefined;
    if (abi) { try { parsedAbi = JSON.parse(abi); } catch { return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid ABI JSON" }) }], isError: true }; } }
    const data = await market("/api/v2/data/market/custom-sigs", {
      method: "POST",
      body: JSON.stringify({ chain, topicHash, eventType, eventName, abi: parsedAbi }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Start server ───────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3007", 10);

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", service: "infrax-market-mcp", uptime: process.uptime() }));

app.post("/mcp/message", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => console.log(`Market MCP Server running on port ${PORT}`));
