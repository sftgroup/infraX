# 模块 1: MCP Hub 统一入口

> 关联: PRD §2、架构图 2 `prd/assets/02-mcp-hub-architecture.png`

---

## 1. 目标

新增 `hub-index.ts`，将 4 个独立 MCP 聚合为**单一品牌入口** `InfraX Hub MCP :9120`，不改动现有 4 个 MCP。

---

## 2. 新增文件

### 2.1 `projects/mcp-server/src/hub-index.ts`

**职责**: MCP 品牌统一入口，聚合 48 tools。

**依赖**:

| 依赖 | 来源 | 用途 |
|------|------|------|
| `@modelcontextprotocol/sdk` | npm | **官方 MCP SDK**（与 dc-index.ts 统一） |
| `./lib/mcp-server.ts` | 🆕 自写 | 统一 MCP Server 工厂函数 |
| `./lib/tool-registry.ts` | 🆕 自写 | Tool 注册与聚合 |
| `./dc-index.ts` | 现有 | 导入 DC tools 定义 |
| `./mpc-index.ts` | 现有 → 重构 | 导入 TEE tools 定义 |
| `./vault-index.ts` | 现有 | 导入 Vault tools 定义 |
| `./index.ts` | 现有 | 导入 Wallet tools 定义 |

**关键设计**:

```typescript
// hub-index.ts 伪代码
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHubServer } from "./lib/mcp-server.js";
import { collectTools } from "./lib/tool-registry.js";
import { generateOpenAPI } from "./openapi/generator.js";

const PORT = getEnv("HUB_PORT", "9120");
const HUB_NAME = getEnv("HUB_NAME", "infrax");
const HUB_VERSION = getEnv("HUB_VERSION", "1.0.0");

// 聚合所有子模块 tools
const allTools = collectTools([
  { prefix: "wallet", modulePath: "./index.ts" },
  { prefix: "dc", modulePath: "./dc-index.ts" },
  { prefix: "tee", modulePath: "./mpc-index.ts" },   // 重构后改前缀
  { prefix: "vault", modulePath: "./vault-index.ts" },
]);

// 创建统一 MCP Server
const { app, server } = createHubServer({
  name: HUB_NAME,
  version: HUB_VERSION,
  tools: allTools,
  port: PORT,
});

// 附加端点
app.get("/openapi.json", (_, res) => res.json(generateOpenAPI(allTools)));
app.get("/.well-known", (_, res) => res.json({
  name: HUB_NAME,
  version: HUB_VERSION,
  endpoint: `/mcp/message`,
  transport: "streamable-http",
}));
```

### 2.2 `projects/mcp-server/src/lib/mcp-server.ts` 🆕

**职责**: 统一 MCP Server 工厂，避免重复手写 JSON-RPC handler。

```typescript
// mcp-server.ts 设计
export interface HubServerConfig {
  name: string;
  version: string;
  tools: ToolDefinition[];
  port: number;
}

export function createHubServer(config: HubServerConfig): {
  app: express.Application;
  server: McpServer;
} {
  const app = express();
  app.use(express.json());

  const server = new McpServer({
    name: config.name,
    version: config.version,
  });

  // 注册所有 tools
  for (const tool of config.tools) {
    server.tool(tool.name, tool.description, tool.schema, tool.handler);
  }

  // Streamable HTTP transport
  app.post("/mcp/message", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // SSE
  app.get("/mcp/sse", (_, res) => {
    // ... SSE endpoint 实现
  });

  // Health
  app.get("/health", (_, res) => res.json({
    status: "ok",
    service: `${config.name}-hub-mcp`,
    tools: config.tools.length,
  }));

  app.listen(config.port);
  return { app, server };
}
```

### 2.3 `projects/mcp-server/src/lib/tool-registry.ts` 🆕

**职责**: 从各子模块导入 tool 定义并统一前缀。

```typescript
// tool-registry.ts 设计
export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  handler: (args: any) => Promise<{ content: { type: "text"; text: string }[] }>;
}

export function collectTools(modules: {
  prefix: string;
  modulePath: string;
}[]): ToolDefinition[] {
  const allTools: ToolDefinition[] = [];
  for (const mod of modules) {
    // 动态 import 各模块的 tool 导出
    const { tools } = require(mod.modulePath);
    for (const tool of tools) {
      allTools.push({
        ...tool,
        name: `${mod.prefix}_${tool.name}`,  // 统一加前缀
      });
    }
  }
  return allTools;
}
```

### 2.4 `projects/mcp-server/src/openapi/generator.ts` 🆕

**职责**: 从 tool 定义自动生成 OpenAPI 3.1 规范。

```typescript
// generator.ts 设计
export function generateOpenAPI(tools: ToolDefinition[]): OpenAPISpec {
  return {
    openapi: "3.1.0",
    info: {
      title: "InfraX MCP API",
      version: "1.0.0",
      description: "InfraX Web3 Infrastructure — 48+ tools",
    },
    paths: buildPaths(tools),
  };
}
```

---

## 3. 修改文件

### 3.1 `projects/mcp-server/src/dc-index.ts` → 导出 tools 数组

当前 dc-index.ts 直接在模块顶层创建 McpServer 并注册 tool。改为：

```diff
- const server = new McpServer({ ... });
- server.tool("dc_events", ...);

+ export const tools: ToolDefinition[] = [
+   { name: "dc_events", description: "...", schema: ..., handler: ... },
+   ...
+ ];
+ 
+ // 独立运行时保留
+ if (require.main === module) {
+   startStandaloneServer(tools, PORT);
+ }
```

同样，`index.ts`、`mpc-index.ts`、`vault-index.ts` 也改为导出 tools 数组（重构为 `tee-index.ts` 时一并处理）。

---

## 4. 新增 systemd

### `deploy/systemd/infrax-hub-mcp.service`

```ini
[Unit]
Description=InfraX Hub MCP Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/infrax/projects/mcp-server
ExecStart=/usr/bin/node --loader ts-node/esm src/hub-index.ts
Environment=HUB_PORT=9120
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## 5. 统一端点规格

| 端点 | 方法 | 用途 | 认证 |
|------|:---:|------|:---:|
| `/mcp/message` | POST | MCP JSON-RPC 统一入口 | x-api-key |
| `/mcp/sse` | GET | MCP SSE 流式 | x-api-key |
| `/openapi.json` | GET | OpenAPI 3.1 规范 | — |
| `/.well-known` | GET | MCP 服务发现 | — |
| `/health` | GET | 健康检查 | — |

---

## 6. 测试要点

1. hub 启动后 `tools/list` 返回 48 个 tools（或扩展后的数量）
2. 各子 MCP 原有端口继续可用
3. tool 前缀正确（`wallet_`/`dc_`/`tee_`/`vault_`）
4. OpenAPI spec 和 tools/list 一致
5. 子 MCP 故障时 hub 不 crash，返回对应 tool unavailable 错误
