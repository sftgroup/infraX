# InfraX MCP 化 — 需求文档 v1.0

> 2026-07-13 | stevenwang | team6

## 背景

将 Vault、WAAS、DC 三个后端服务做成 MCP Server，供 AI（OpenClaw、Claude Desktop、Cursor 等）直接调用。用户用自然语言操作 Web3 能力，AI 不必理解 REST 路由和参数格式。

## 架构

```
                         ┌─ vault-mcp (stdio/SSE) ── pocketx_vault DB
AI Agent ── MCP 协议 ──┼─ waas-mcp  (stdio/SSE) ── pocketx_waas DB
                         └─ dc-mcp    (stdio/SSE) ── pocketx_dc DB
```

每个 MCP Server 是现有 Express 服务的薄包装——挂 `/mcp/sse`（SSE 模式）或独立 stdio 可执行文件。复用现有 service 层和 DB 连接池，不加新依赖。

## 路线图

### Phase 1: Vault MCP（MVP）

**理由**: 多签流程天然适合 AI 编排（创建→提案→签名→执行），tool 边界最清晰。

**Tools (7 个)**:

| Tool | 对应 API | 描述 |
|------|---------|------|
| `vault_dashboard` | GET /api/vault/dashboard | 金库总览：safe 数、交易数、待签数、风控规则数 |
| `vault_list_safes` | GET /api/vault/safes | 列出所有多签钱包 |
| `vault_get_safe` | GET /api/vault/safes/:id | 查询单个 Safe 详情 |
| `vault_create_safe` | POST /api/vault/safes | 创建多签钱包（指定 owner 地址列表 + threshold） |
| `vault_list_transactions` | GET /api/vault/transactions | 查询交易列表（可按 safe_id/status 过滤） |
| `vault_create_transaction` | POST /api/vault/transactions | 创建多签交易提案 |
| `vault_check_risk` | POST /api/vault/risk/check | 风控检查：单笔金额是否超限 |

**用户场景示例**:
> "帮我在 Sepolia 上创建一个 2/3 多签钱包，owner 是 A、B、C 三个地址"

→ AI 调 `vault_create_safe(chain="sepolia", owners=[A,B,C], threshold=2)` → 返回 Safe 地址

### Phase 2: WAAS MCP

**Tools (10 个)**:

| Tool | 对应 API | 描述 |
|------|---------|------|
| `waas_get_balance` | GET /api/v2/wallet/balance | 查询托管钱包余额 |
| `waas_create_wallet` | POST /api/v2/wallet | 创建托管钱包 |
| `waas_list_wallets` | GET /api/v2/wallet | 列出用户所有钱包 |
| `waas_send_transaction` | POST /api/v2/tx | 发送交易 |
| `waas_get_transactions` | GET /api/v2/tx | 查询交易历史 |
| `waas_get_tenants` | GET /api/v2/saas/tenants | 查询租户列表 |
| `waas_activate_tenant` | POST /api/v2/saas/tenants | 激活新租户 |
| `waas_generate_hot_wallet` | POST /api/v2/saas/hotwallet | 生成热钱包 |
| `waas_get_withdrawals` | GET /api/v2/saas/withdrawals | 提现队列 |
| `waas_get_hot_wallet_balance` | GET /api/v2/saas/balance | 热钱包余额 |

**用户场景示例**:
> "给用户 0xABC 创建一个 ETH 托管钱包，转 0.01 ETH 进去"

→ AI 调 `waas_create_wallet` → `waas_send_transaction` → 返回 tx hash

### Phase 3: DC MCP

**Tools (5 个)**:

| Tool | 对应 API | 描述 |
|------|---------|------|
| `dc_get_plans` | GET /api/v2/data/plans | 查询数据套餐 |
| `dc_subscribe` | POST /api/v2/data/subscribe | 订阅数据服务 |
| `dc_query_events` | GET /api/v2/data/events | 查询链上事件 |
| `dc_get_stats` | GET /api/v2/data/stats | 链上统计 |
| `dc_get_health` | GET /api/v2/data/health | 扫描节点健康状态 |

**用户场景示例**:
> "给我看 Sepolia 上最近 100 个 USDT Transfer 事件"

→ AI 调 `dc_query_events(chain="sepolia", event="Transfer", limit=100)`

## 技术选型

| 项 | 选择 | 理由 |
|----|------|------|
| MCP SDK | `@modelcontextprotocol/sdk` | 官方，TypeScript 原生 |
| 传输模式 | **SSE**（Phase 1）+ stdio（Phase 2） | SSE 可复用现有 Express 端口，stdio 适配本地 IDE |
| 认证 | API Key（环境变量 `MCP_API_KEY`） | 简单，AI 配置一次 |
| 部署 | 嵌入现有 Express 进程，新 mount `/mcp/sse` | 不增加新进程 |

## MCP Tool 设计原则

1. **一个 Tool 做一件事** — 不和 REST endpoint 1:1，合并查询逻辑
2. **参数有默认值** — `limit` 默认 20，`chain` 默认 ethereum
3. **返回值是自然语言友好的 JSON** — 避免裸数据库字段名
4. **错误信息可读** — "Safe not found: 0xABC"，不是 "404"
5. **敏感操作确认** — `waas_send_transaction` 返回前要求 AI 二次确认

## 文件结构

```
infraX/projects/vault/
├── mcp/
│   ├── index.ts        # MCP Server 入口
│   ├── tools.ts        # Tool 定义 + handler
│   └── types.ts        # Zod schema
├── server.ts           # 现有 REST API（不变）
└── ...
```

`mcp/` 目录独立于 `server.ts`，现有 REST API 完全不受影响。MCP Server 注入同一个 `Pool` 实例，共享 DB 连接。

## 不做什么

- ❌ 不新建独立进程 — 挂载到现有 Express 进程的 `/mcp/sse`
- ❌ 不改现有 REST API — MCP 是增量，不是替代
- ❌ 不引入认证中间件（初期）— 先内网用，Phase 2 再加 API Key
- ❌ 不抽象通用 MCP 框架 — 先做具体实现，需要时再抽

## 验收标准

**Vault MCP MVP**:
- [ ] `vault_create_safe` → 返回 Safe 合约地址
- [ ] `vault_create_transaction` → 返回 tx ID
- [ ] `vault_list_transactions` → 可按 safe_id 过滤
- [ ] `vault_check_risk` → 风控规则生效
- [ ] OpenClaw 能通过 MCP 协议调通以上 4 个 tool

## 风险

| 风险 | 缓解 |
|------|------|
| MCP SDK 不稳定 | 用 HTTP SSE 模式，不依赖 stdio |
| DB 连接池竞争 | MCP 复用已有 Pool，不新建连接 |
| AI 误操作（发错交易） | `waas_send_transaction` 设为需要确认的 tool |
