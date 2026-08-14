// InfraX MCP Server — Factor Factory（需求5 R5-3）
// Standalone MCP process bridging AI ↔ ml-service 因子工厂（:9120 /factor-factory/*）
// Tools: factor_factory_start / factor_factory_status / factor_factory_result /
//        factor_factory_list / factor_factory_cancel
// 出站：X-Service-Key（ML_API_KEY 平台 bridge key，统一契约三选一）
// 入站：inboundAuth（MCP_API_KEY 白名单或 data 服务签发 key，见 mcp-auth.ts）
// 内核不吃自然语言（R5-3 架构定位）：结构化参数直传 ml-service；自然语言
// intent 由 ml-service 侧 LLM 解析（/factor-factory/mine，R5-4）。

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { inboundAuth } from "./mcp-auth.js";

const ML_URL = process.env.ML_SERVICE_URL || "http://localhost:9120";
const ML_API_KEY = process.env.ML_API_KEY || process.env.RAGSERVICER_API_KEY || "";
const PORT = parseInt(process.env.PORT || "3014", 10);

/** 出站请求（统一信封 {code,message,data}；带平台 bridge key） */
async function ml(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ML_API_KEY) headers["X-Service-Key"] = ML_API_KEY;
  const r = await fetch(`${ML_URL}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok && body && body.detail) {
    return { status: r.status, body: { error: `ml-service ${r.status}: ${body.detail}` } };
  }
  return { status: r.status, body };
}

const server = new McpServer({
  name: "infrax-factor-mcp",
  version: "1.0.0", // R5-3: factor_factory 工具集
});

// preferences/constraints 结构化字段（对齐 JobSpec schema，见 app/factorengine/job.py）
const prefsSchema = {
  market_types: z.array(z.enum(["crypto", "us_stock", "hk_stock", "any"])).optional().describe("市场类型，如 crypto / us_stock / hk_stock / any"),
  factor_styles: z.array(z.enum(["momentum", "volatility", "trend", "mean_reversion", "any"])).optional().describe("因子风格，如 momentum / volatility / trend / mean_reversion"),
  investment_style: z.enum(["value", "growth", "momentum", "balanced", "any"]).optional().describe("投资风格"),
  asset_pool: z.array(z.string()).optional().describe("资产池（标的白名单，空=动态拉取）"),
  timeframe: z.enum(["1d", "1h"]).optional().describe("周期"),
  horizon: z.number().int().min(1).max(90).optional().describe("预测周期（日）"),
};
const constraintsSchema = {
  max_factors: z.number().int().min(1).max(500).optional().describe("输出因子数量上限"),
  max_runtime_min: z.number().int().min(1).max(720).optional().describe("任务耗时上限（分钟）"),
  max_targets: z.number().int().min(1).max(500).optional().describe("标的数上限"),
  min_ic: z.number().min(-1).max(1).optional().describe("最小 IC 阈值（如 0.03）"),
  min_icir: z.number().min(0).max(10).optional().describe("最小 ICIR 阈值（如 0.3）"),
  max_independence: z.number().min(0).max(1).optional().describe("与已选因子最大 |corr|"),
  require_monotonicity: z.boolean().optional().describe("是否要求单调性"),
  blacklist_keys: z.array(z.string()).optional().describe("因子黑名单"),
  whitelist_keys: z.array(z.string()).optional().describe("因子白名单（非空=仅允许这些）"),
};

server.tool(
  "factor_factory_start",
  "创建因子挖掘任务（结构化 preferences/constraints/formulas；偏好与硬限制冲突时返回 400 + conflicts，不静默）。返回 job_id 与初始状态。",
  {
    preferences: z.object(prefsSchema).optional().describe("偏好（可被硬限制覆盖）"),
    constraints: z.object(constraintsSchema).optional().describe("硬限制（不可被偏好覆盖）"),
    formulas: z.array(z.string()).max(20).optional().describe("DSL 公式候选（FF-5，最多 20 个；语法见 ml-service dsl.py 白名单：列+向量化方法，如 close.pct_change().rolling(60).std()）"),
    intent: z.string().optional().describe("自然语言挖掘意图（走 LLM 解析，需 ml-service 配置 FACTOR_LLM_*；LLM 可生成 formulas）"),
  },
  async ({ preferences, constraints, formulas, intent }) => {
    const payload: any = { preferences: preferences || {}, constraints: constraints || {} };
    if (formulas && formulas.length) payload.formulas = formulas;
    const path = intent ? "/factor-factory/mine" : "/factor-factory/start";
    if (intent) payload.intent = intent;
    const r = await ml(path, { method: "POST", body: JSON.stringify(payload) });
    return { content: [{ type: "text" as const, text: JSON.stringify(r.body || r, null, 2) }] };
  }
);

server.tool(
  "factor_factory_status",
  "查询挖掘任务状态（含 stage 细分：pool/eval/select/persist）。",
  { job_id: z.string().describe("任务 id") },
  async ({ job_id }) => {
    const r = await ml(`/factor-factory/status?job_id=${encodeURIComponent(job_id)}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(r.body || r, null, 2) }] };
  }
);

server.tool(
  "factor_factory_result",
  "查询挖掘任务结果：合格因子列表（IC/ICIR/独立度）+ 统计。",
  { job_id: z.string().describe("任务 id") },
  async ({ job_id }) => {
    const r = await ml(`/factor-factory/result?job_id=${encodeURIComponent(job_id)}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(r.body || r, null, 2) }] };
  }
);

server.tool(
  "factor_factory_list",
  "最近挖掘任务列表。",
  { limit: z.number().int().min(1).max(200).optional().describe("返回条数（默认 50）") },
  async ({ limit }) => {
    const q = limit ? `?limit=${limit}` : "";
    const r = await ml(`/factor-factory/list${q}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(r.body || r, null, 2) }] };
  }
);

server.tool(
  "factor_factory_cancel",
  "取消挖掘任务（排队/运行中可取消）。",
  { job_id: z.string().describe("任务 id") },
  async ({ job_id }) => {
    // ml-service 侧为 POST /factor-factory/cancel?job_id=（main.py 484，GET 会 405）
    const r = await ml(`/factor-factory/cancel?job_id=${encodeURIComponent(job_id)}`, { method: "POST" });
    return { content: [{ type: "text" as const, text: JSON.stringify(r.body || r, null, 2) }] };
  }
);

const app = express();
app.use(express.json());
app.use(inboundAuth);

app.get("/health", (_req, res) => res.json({ status: "ok", service: "infrax-factor-mcp", uptime: process.uptime() }));

app.post("/mcp/message", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => console.log(`Factor Factory MCP Server running on port ${PORT}`));
