// ============================================================================
// OpenAPI 3.1 自动生成（Phase 3.2）
// 从 hub-index.ts 源码解析 server.tool(...) 注册的工具，生成 OpenAPI 3.1 spec。
// 单一来源：改工具定义 → 重新生成即同步（gen:openapi / GET /openapi.json）。
// ============================================================================

export interface ToolParam {
  key: string;
  type: "string" | "number" | "boolean";
  optional: boolean;
  description?: string;
  enumValues?: string[];
}

export interface HubTool {
  name: string;
  description: string;
  params: ToolParam[];
}

const TOOL_BLOCK_RE =
  /^\s*server\.tool\(\s*\n\s*"(?<name>[a-z_0-9]+)",\s*\n\s*"(?<desc>(?:[^"\\]|\\.)*)",\s*\n\s*\{(?<params>[\s\S]*?)\},\s*\n\s*(?:async\s*)?\(/gm;

const PARAM_LINE_RE = /(?<key>[a-zA-Z_][a-zA-Z0-9_]*):\s*z\.(?<rest>[^\n]+)/g;

const DESCRIBE_RE = /describe\("(?<d>(?:[^"\\]|\\.)*)"\)/;
const ENUM_RE = /enum\(\[(?<items>[^\]]*)\]\)/;

export function parseToolsFromSource(src: string): HubTool[] {
  const tools: HubTool[] = [];
  for (const m of src.matchAll(TOOL_BLOCK_RE)) {
    const name = m.groups!.name;
    const desc = m.groups!.desc.replace(/\\(["\\])/g, "$1");
    const paramsBlock = m.groups!.params || "";
    const params: ToolParam[] = [];
    for (const p of paramsBlock.matchAll(PARAM_LINE_RE)) {
      const key = p.groups!.key;
      const rest = p.groups!.rest;
      const optional = /\.optional\(\)/.test(rest);
      let type: ToolParam["type"] = "string";
      let enumValues: string[] | undefined;
      if (/^coerce\.number|^number/.test(rest)) type = "number";
      else if (/^boolean|^z\.boolean/.test(rest)) type = "boolean";
      const em = rest.match(ENUM_RE);
      if (em && em.groups!.items) {
        type = "string";
        enumValues = em.groups!.items
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean);
      }
      const dm = rest.match(DESCRIBE_RE);
      const description = dm ? dm.groups!.d.replace(/\\(["\\])/g, "$1") : undefined;
      params.push({ key, type, optional, description, enumValues });
    }
    tools.push({ name, description: desc, params });
  }
  return tools;
}

function paramSchema(p: ToolParam): Record<string, unknown> {
  const s: Record<string, unknown> = { type: p.type };
  if (p.description) s.description = p.description;
  if (p.enumValues && p.enumValues.length) s.enum = p.enumValues;
  return s;
}

export function buildOpenApiSpec(tools: HubTool[], baseUrl: string): Record<string, unknown> {
  const toolSchemas = tools.map((t) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of t.params) {
      properties[p.key] = paramSchema(p);
      if (!p.optional) required.push(p.key);
    }
    return {
      name: t.name,
      description: t.description,
      inputSchema: {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
      },
    };
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "InfraX Hub MCP API",
      version: "1.1.0",
      description:
        "InfraX Hub MCP — unified market-data / ML / RAG knowledge-graph API (" +
        `${tools.length} tools aggregated from data :9112, injector :9113, ragservicer :9721). ` +
        "Call tools via MCP Streamable HTTP (POST /mcp/message, JSON-RPC: methods/tools-call).",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/health": {
        get: {
          operationId: "health",
          summary: "Service health check",
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
          },
          security: [],
        },
      },
      "/mcp/message": {
        post: {
          operationId: "mcpMessage",
          summary: "MCP Streamable HTTP message (JSON-RPC 2.0): tools/list, tools/call, resources/read, prompts/get",
          description: `Body: {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}. ` +
            `Supported tools (${tools.length}) are listed under x-mcp-tools with their input schemas.`,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jsonrpc: { type: "string", enum: ["2.0"] },
                    id: {},
                    method: { type: "string" },
                    params: { type: "object" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "MCP result", content: { "application/json": { schema: { type: "object" } } } },
          },
          security: [{ apiKey: [] }],
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "X-API-Key", description: "InfraX API key (Authorization: Bearer also accepted)" },
      },
    },
    "x-mcp-tools": toolSchemas,
  };
}
