import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const DC_URL = process.env.DC_URL || "http://localhost:3001";

async function dc(path: string, options: RequestInit = {}) {
  const r = await fetch(`${DC_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-dc-api-key": process.env.DC_API_KEY || "test-key",
      ...options.headers,
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`DC API ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

const server = new McpServer({
  name: "infrax-dc-mcp",
  version: "1.1.0",
});

// dc_events
server.tool(
  "dc_events",
  "Query on-chain events from Data Center",
  {
    chain: z.string().optional().describe("Chain name (ethereum, bsc, arbitrum, base, optimism, polygon)"),
    address: z.string().optional().describe("Contract address to filter events"),
    event_type: z.string().optional().describe("Event type (Transfer, Swap, Approval, etc.)"),
    from_block: z.string().optional().describe("Starting block number"),
    to_block: z.string().optional().describe("Ending block number"),
    limit: z.string().optional().describe("Max events to return (default 100, max 500)"),
  },
  async (params) => {
    const query = new URLSearchParams();
    if (params.chain) query.set("chain", params.chain);
    if (params.address) query.set("address", params.address);
    if (params.event_type) query.set("event_type", params.event_type);
    if (params.from_block) query.set("from_block", params.from_block);
    if (params.to_block) query.set("to_block", params.to_block);
    if (params.limit) query.set("limit", params.limit);
    const data = await dc(`/api/v2/data/events?${query.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// dc_stats
server.tool(
  "dc_stats",
  "Get Data Center statistics (event count, active chains)",
  {},
  async () => {
    const data = await dc("/api/v2/data/stats");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// dc_checkpoints
server.tool(
  "dc_checkpoints",
  "Get block indexing checkpoints per chain",
  { chain: z.string().optional().describe("Filter by chain name") },
  async ({ chain }) => {
    const q = chain ? `?chain=${chain}` : "";
    const data = await dc(`/api/v2/data/checkpoints${q}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// dc_plans
server.tool(
  "dc_plans",
  "List Data Center subscription plans",
  {},
  async () => {
    const data = await dc("/api/v2/data/plans");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// dc_tokens
server.tool(
  "dc_tokens",
  "List supported tokens with metadata",
  { chain: z.string().optional().describe("Filter by chain") },
  async ({ chain }) => {
    const q = chain ? `?chain=${chain}` : "";
    const data = await dc(`/api/v2/data/tokens${q}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// dc_chains
server.tool(
  "dc_chains",
  "List supported blockchain networks",
  {},
  async () => {
    const data = await dc("/api/v2/data/chains");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// dc_price — Real-time token price from Binance public API
server.tool(
  "dc_price",
  "Get real-time token price from Binance public API (USDT pairs)",
  { symbol: z.string().describe("Token symbol, e.g. ETH, BTC, SOL, BNB, ARB") },
  async ({ symbol }) => {
    const sym = symbol.toUpperCase();
    try {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT`);
      if (!r.ok) throw new Error(`Binance returned ${r.status}`);
      const data = await r.json() as any;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          symbol: sym,
          price_usd: data.price,
          source: "Binance",
        }, null, 2) }],
      };
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          error: `Failed to fetch price for ${sym}`,
          hint: "Try a major token (e.g. ETH, BTC, SOL, BNB, ARB, OP, MATIC)",
          detail: e.message,
        }, null, 2) }],
        isError: true,
      };
    }
  }
);

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", service: "infrax-dc-mcp", uptime: process.uptime() }));

app.post("/mcp/message", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = parseInt(process.env.PORT || "3005", 10);
app.listen(PORT, () => console.log(`DC MCP Server running on port ${PORT}`));
