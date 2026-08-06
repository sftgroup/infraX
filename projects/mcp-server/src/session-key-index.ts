import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { inboundAuth } from "./mcp-auth.js";

const SK_URL = process.env.SESSION_KEY_URL || "http://localhost:3500";
const SK_API_KEY = process.env.SESSION_KEY_API_KEY || "";

async function sk(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers as Record<string, string> || {},
  };
  if (SK_API_KEY) headers["Authorization"] = `Bearer ${SK_API_KEY}`;

  const r = await fetch(`${SK_URL}${path}`, { ...options, headers });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`SK API ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

const server = new McpServer({
  name: "infrax-session-key-mcp",
  version: "1.0.0",
});

// ── sk_nonce ───────────────────────────────────────────────────────────
server.tool(
  "sk_nonce",
  "Get a one-time nonce for EIP-712 session key authorisation signature",
  {
    user: z.string().describe("User wallet address (0x...)"),
  },
  async ({ user }) => {
    const data = await sk(`/api/v1/nonce?user=${encodeURIComponent(user)}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── sk_create_session ──────────────────────────────────────────────────
server.tool(
  "sk_create_session",
  "Create a new Session Key — user signs an EIP-712 message authorising a session key to execute transactions on their behalf",
  {
    signature: z.string().describe("EIP-712 signature from user wallet"),
    chain: z.enum(["eth","bsc","base","polygon","arbitrum","optimism","xlayer"]).describe("Blockchain chain"),
    contracts: z.string().describe("Comma-separated contract addresses whitelist"),
    functions: z.string().optional().describe("Comma-separated function selectors (empty = allow all)"),
    validDays: z.string().optional().describe("Validity period in days (default 30)"),
    maxPerTx: z.string().optional().describe("Max spend per transaction (USDC, default 1000)"),
    maxTotal: z.string().optional().describe("Max total spend (USDC, default 10000)"),
    userAddress: z.string().describe("User wallet address (0x...)"),
    nonce: z.string().describe("Nonce obtained from sk_nonce"),
  },
  async (params) => {
    const data = await sk("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        signature: params.signature,
        chain: params.chain,
        permissions: {
          contracts: params.contracts.split(",").map(c => c.trim()),
          functions: params.functions ? params.functions.split(",").map(f => f.trim()) : undefined,
        },
        validDays: params.validDays ? parseInt(params.validDays) : undefined,
        maxPerTx: params.maxPerTx,
        maxTotal: params.maxTotal,
        userAddress: params.userAddress,
        nonce: params.nonce,
      }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── sk_list_sessions ───────────────────────────────────────────────────
server.tool(
  "sk_list_sessions",
  "List all active session keys for a user",
  {
    user: z.string().describe("User wallet address (0x...)"),
    chain: z.string().optional().describe("Filter by chain"),
    status: z.enum(["active","revoked","expired","quota_exhausted"]).optional().describe("Filter by status"),
  },
  async ({ user, chain, status }) => {
    const params = new URLSearchParams({ user });
    if (chain) params.set("chain", chain);
    if (status) params.set("status", status);
    const data = await sk(`/api/v1/sessions?${params.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── sk_get_session ─────────────────────────────────────────────────────
server.tool(
  "sk_get_session",
  "Get session key details by ID",
  { sessionId: z.string().describe("Session key UUID") },
  async ({ sessionId }) => {
    const data = await sk(`/api/v1/sessions/${sessionId}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── sk_revoke_session ──────────────────────────────────────────────────
server.tool(
  "sk_revoke_session",
  "Revoke (deactivate) a session key immediately",
  { sessionId: z.string().describe("Session key UUID to revoke") },
  async ({ sessionId }) => {
    const data = await sk(`/api/v1/sessions/${sessionId}`, { method: "DELETE" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── sk_execute ─────────────────────────────────────────────────────────
server.tool(
  "sk_execute",
  "Execute a transaction using an authorised session key. Requires the session to be active and the target contract to be whitelisted.",
  {
    sessionId: z.string().describe("Session key UUID"),
    chain: z.enum(["eth","bsc","base","polygon","arbitrum","optimism","xlayer"]).describe("Target blockchain"),
    to: z.string().describe("Target contract address (0x...)"),
    data: z.string().describe("Encoded function call data (0x...)"),
    value: z.string().optional().describe("ETH/BNB value in wei (default 0)"),
    gasLimit: z.string().optional().describe("Gas limit override (auto-estimated if omitted)"),
  },
  async (params) => {
    const data = await sk("/api/v1/execute", {
      method: "POST",
      body: JSON.stringify({
        sessionId: params.sessionId,
        chain: params.chain,
        to: params.to,
        data: params.data,
        value: params.value || "0",
        gasLimit: params.gasLimit,
      }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── sk_status ──────────────────────────────────────────────────────────
server.tool(
  "sk_status",
  "Check Session Key Engine health and availability",
  {},
  async () => {
    const data = await sk("/api/v1/health");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Start server ───────────────────────────────────────────────────────
// 端口 3011（生产 web 占 9111，避免冲突；B-6）
const PORT = parseInt(process.env.PORT || "3011", 10);

const app = express();
app.use(express.json());
app.use(inboundAuth);

// stateless per-request transport：每次请求新建并 connect，
// res 'close' 时 close() 会重置 Protocol._transport，允许下次请求重新 connect
// （SDK Protocol.connect 只能连接一次，单例 transport 会导致
//   "Server already initialized"/"Mcp-Session-Id header is required"）
app.post("/mcp/message", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`SK MCP server running on :${PORT}`);
});
