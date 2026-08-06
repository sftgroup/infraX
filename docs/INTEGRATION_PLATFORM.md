# InfraX 平台整体集成文档

> 最后更新：2026-08-06 | 适用版本：SDK `@0xinfrax/infrax-dk@0.3.0` · data v1.0.0 · ragservicer 2.0.0 · hub-index MCP 1.0.1
> 本文是**平台总览**文档，面向接入 InfraX 能力的各项目方（金融量化平台、服务平台等）。
> 各微服务单独文档：**[数据服务使用文档](INTEGRATION_DATA_SERVICE.md)** · **[LightRAG 知识库使用文档](INTEGRATION_LIGHTRAG.md)**

---

## 1. 平台能力全景

InfraX 目前对外提供两大能力集群，均可通过 **REST API / MCP / SDK** 三种方式接入：

```
                 ┌─────────────────────────────────────────────────────────┐
                 │                     InfraX 平台（172）                    │
                 │                                                         │
  金融量化平台 ──▶ │  data :9112        行情/因子/快照/符号/ML 预测           │
  (行情·因子·回测) │  hub-index :3008   MCP Hub（13 工具，AI Agent 入口）      │
                 │                                                         │
  服务平台 ──────▶ │  ragservicer :9721  LightRAG 知识库（向量+图谱+关键词）    │
  (资料存储·检索)  │  knowledge-injector :9113  21 类数据源自动注入             │
                 └─────────────────────────────────────────────────────────┘
                 ┌─────────────────────────────────────────────────────────┐
                 │  ml-service :9120（独立服务器 43.156.25.197，可选）         │
                 │  LightGBM / FinBERT / Kronos 推理                         │
                 └─────────────────────────────────────────────────────────┘
```

| 能力 | 服务（端口） | 适合谁 |
|---|---|---|
| 统一市场数据（K线/实时行情/因子/快照/符号/ML预测） | data（:9112） | 金融量化平台、行情系统 |
| 知识库（资料存储 + 语义检索 + 知识图谱） | ragservicer（:9721） | 服务平台、文档系统、投研助手 |
| 数据自动注入知识库 | knowledge-injector（:9113） | 使用 ragservicer 且需要自动更新的场景 |
| AI Agent 直接调用（MCP） | hub-index（:3008） | 让 Claude/Agent 直接查行情、查知识库 |

---

## 2. 接入方式总览

| 方式 | 协议 | 适用场景 | 说明 |
|---|---|---|---|
| **REST API** | HTTP JSON | 后端服务集成 | 最通用，本文 + 微服务文档含全端点 |
| **MCP** | JSON-RPC (Streamable HTTP) | AI Agent / 客户端直连 | 统一入口 `/mcp/message`，13 个工具 |
| **JS SDK** | TypeScript | Node.js / 前端 | npm 包 `@0xinfrax/infrax-dk`（含 data 能力） |
| **Python SDK** | Python | 数据科学 / 知识库脚本 | `lightrag-client`（ragservicer 专用） |

### 2.1 发布物清单

| 发布物 | 版本 | 获取方式 | 状态 |
|---|---|---|---|
| `@0xinfrax/infrax-dk`（JS SDK，含 `data` API） | 0.3.0 | `npm i @0xinfrax/infrax-dk` | ✅ 已发布 npm |
| `lightrag-client`（Python SDK） | 2.0.0 | 本地 wheel 安装（PyPI 待发布） | ⚠️ 见 LightRAG 文档 §4 |
| hub-index MCP server | 1.0.0 | 远程端点 `https://infrax.0xainet.top/mcp/message` | ✅ 运行中 |
| 服务 OpenAPI | — | 各服务 `/openapi.json` | ✅ 在线 |

---

## 3. 统一入口与鉴权

### 3.1 外部访问地址（nginx 统一前缀）

| 服务 | 内网地址 | 外网地址（HTTPS） | 前缀剥离规则 |
|---|---|---|---|
| data | `http://127.0.0.1:9112` | `https://infrax.0xainet.top/api/data` | `/api/data/bars` → `/bars` |
| ragservicer | `http://127.0.0.1:9721` | `https://infrax.0xainet.top/api/rag` | `/api/rag/api/v1/health` → `/api/v1/health` |
| knowledge-injector | `http://127.0.0.1:9113` | —（内部服务，不对外暴露） | 仅内网访问 |
| hub-index MCP | `http://127.0.0.1:3008` | `https://infrax.0xainet.top/mcp/message` | 不变 |

> ⚠️ **域名状态（2026-08-06）**：`infrax.0xainet.top` DNS 已切至 Cloudflare（A 104.21.21.11），但 `/api/*` 经公网返回 502（Cloudflare 回源配置待修正，见 [DEPLOYMENT_DATA_STACK §2.1](./infrax_tasklist.md)）；origin `43.163.105.172` 直连全端点正常。
> 域名恢复前使用 `https://43.163.105.172/api/data/...`，curl 加 `-k` + `-H 'Host: infrax.0xainet.top'`（或配置正确 SNI）。
> 健康检查免鉴权：`GET /api/data/health`、`GET /api/rag/api/v1/health`、`GET /mcp/health`。
> knowledge-injector（:9113）与 ml-service（:9120）为内部服务，不对外暴露。

### 3.2 统一鉴权契约（所有服务一致）

携带方式**三选一**，任一匹配即通过：

```
Authorization: Bearer <key>
X-API-Key: <key>
X-Service-Key: <key>      # 服务间调用约定
```

失败响应统一为 `401 {"detail":"unauthorized"}`（禁用 `403`、超限 `429`）。

### 3.3 key 类型一览

| key 类型 | 前缀 | 作用域 | 获取方式 |
|---|---|---|---|
| 平台 bridge key | 自定义 | 全平台内部服务联动（injector/ml 等） | InfraX 内部配置，不对外签发 |
| 只读监控 key | 自定义 | 仅 GET/HEAD/OPTIONS | InfraX 内部配置 |
| **数据服务租户 key** | `dx_` | data 全部业务端点 | 管理员在 admin 面板 **API Keys** 页签发（见 §3.5） |
| **LightRAG 租户 key** | `lr_` | 绑定的 ragservicer 租户 | 管理员在 admin 面板 **API Keys** 页创建租户后签发（见 §3.5） |
| **MCP 专用 key** | `mx_` | 调用 `/mcp/message`（AI Agent / MCP 客户端） | 管理员在 admin 面板 **API Keys** 页签发（见 §3.5）；不可访问 data/rag 业务端点 |

### 3.4 开通流程（项目方）

```
联系 InfraX 管理员 ──▶ 声明用途（量化平台 / 服务平台）
        │
        ├─ 量化平台：签发 dx_ key（可设 label + 限流 RPM）→ 即刻调用 data 全部业务端点
        │
        └─ 服务平台：创建独立租户（如 servicehub）+ 签发 lr_ key
                      → 写入资料到命名空间 → 语义检索 / 自动注入
```

### 3.5 管理端：统一 API Key 管理（admin 面板）

管理员可在 admin 面板一处管理 **data（`dx_`）**、**MCP（`mx_`）** 与 **LightRAG（`lr_`）** 三类 key，无需分别调用各服务管理端点。

**入口**：`http://127.0.0.1:3002`（内网，登录 admin 账号）→ 侧边栏 **API Keys**。

| 能力 | data（`dx_` key） | MCP（`mx_` key） | LightRAG（`lr_` key） |
|---|---|---|---|
| 签发 | label + RPM 限流 | label + RPM 限流 | 创建租户（不存在则自动建）→ 签发 name + 有效期（天） |
| 查看 | 列表（掩码展示） | 列表（掩码展示） | 租户列表 + 各租户 key（掩码 / 有效期） |
| 变更 | 启用 / 禁用、轮换（返回新 key）、删除 | 启用 / 禁用、轮换、删除 | 吊销 key、删除租户（连带全部 key） |
| 状态列 | enabled / RPM / 请求数 / 最后使用时间 | enabled / RPM / 请求数 / 最后使用时间 | active / 过期时间 |

> ⚠️ **key 只完整展示一次**（签发与轮换时），请立即保存。
> 页面 10s 自动刷新；签发新 key 后无需等待即可复制。

**后端聚合说明**：admin 服务将请求转发到 data（`/admin/api-keys`，Bearer data 的 `ADMIN_API_KEY`）与 ragservicer（`/api/v1/tenants...`，Bearer ragservicer 的 `ADMIN_API_KEY`）。两个上游的 `ADMIN_API_KEY` 在 admin 服务启动时从各自 `.env` 读取；未配置时对应区块显示 `adminKeySet=false`，需在 admin 服务重启前补齐。MCP key 由 data 服务签发（scope=mcp，`mx_` 前缀），hub-index 入站时经 data 业务端点 `POST /api-keys/verify` 实时校验（Bearer bridge key）。

**当前已签发**：`aitrader / aiservicer / aihunter-saas / aiops-saas` 各一把 `dx_` key（600 RPM）、一个 `lr_` 租户 key（365 天）与一把 `mx_` MCP key（600 RPM）。

---

## 4. 通用接入步骤

### 4.1 申请 key

管理员会提供一把或多把 key（`dx_` / `mx_` / `lr_`）。**key 只显示一次，请立即保存**。

### 4.2 配置环境变量（以 Node.js / 量化平台为例）

```bash
# 数据服务（金融量化平台）
export INFRAX_DATA_URL="https://infrax.0xainet.top/api/data"   # DNS 切换前用 https://43.163.105.172/api/data
export INFRAX_DATA_KEY="dx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# LightRAG（服务平台）
export INFRAX_RAG_URL="https://infrax.0xainet.top/api/rag/api/v1"
export INFRAX_RAG_KEY="lr_xxxxxxxxxxxxxxxxxxxxxxxx"
export INFRAX_TENANT_ID="servicehub"
```

### 4.3 数据面调用（三种方式等价）

```bash
# REST 示例（data 服务拉 BTC 日线）
curl -H "X-Service-Key: dx_xxx" \
  "https://infrax.0xainet.top/api/data/bars?symbol=BTC/USDT&timeframe=1d&limit=10"

# REST 示例（LightRAG 检索）
curl -H "X-API-Key: lr_xxx" -X POST \
  "https://infrax.0xainet.top/api/rag/api/v1/namespaces/market/query" \
  -H "Content-Type: application/json" \
  -d '{"query":"比特币走势","mode":"hybrid"}'
```

---

## 5. 场景一：金融量化平台接入（data 服务）

> 详细端点与样例见 [数据服务使用文档](INTEGRATION_DATA_SERVICE.md)。

量化平台典型用法：拉 K 线做回测、取实时行情盯盘、取因子（宏观/情绪/链上）作为模型输入、用 MCP 让 AI 助理查行情。

### 5.1 JS SDK 样例（npm 已发布）

```bash
npm i @0xinfrax/infrax-dk
```

```ts
import { InfraX } from "@0xinfrax/infrax-dk";

const ix = new InfraX({
  dataUrl: "https://infrax.0xainet.top/api/data",   // data 服务独立地址
  dataApiKey: "dx_xxx",                             // 租户 key（X-API-Key 携带）
});

// ① 拉 K 线（回测）
const bars = await ix.data.bars({ symbol: "BTC/USDT", timeframe: "1h", limit: 500 });
console.log(bars.bars.length, bars.bars[0]);

// ② 实时行情
const ticker = await ix.data.ticker({ symbol: "BTC/USDT", market: "crypto" });

// ③ 宏观/情绪因子（模型输入）
const factors = await ix.data.factorsCurrent({ symbols: "BTC/USDT", category: "macro" });

// ④ 链上快照（巨鲸转账、难度、OKX 热门）
const onchain = await ix.data.snapshots({ type: "onchain", limit: 10 });

// ⑤ 符号解析（用户输入 → 标准交易对）
const resolved = await ix.data.resolveSymbol({ symbol: "BTC" });

// ⑥ 数据覆盖统计
const stats = await ix.data.stats();
```

### 5.2 MCP 接入（AI Agent）

```json
{
  "mcpServers": {
    "infrax-hub": {
      "url": "https://infrax.0xainet.top/mcp/message",
      "headers": { "X-API-Key": "mx_xxx" }
    }
  }
}
```

> MCP 端点自 v1.0.1 起**入站强制鉴权**：需携带 `mx_` MCP 专用 key（或平台 bridge key），携带方式同 §3.2 三选一；`/mcp/health` 免鉴权。无 key / 无效 key 返回 `401`。

13 个工具：`data_bars` / `data_ticker` / `data_factors` / `data_factors_history` / `data_snapshots` / `data_symbols` / `data_symbol_search` / `data_symbol_resolve` / `data_broker_policy` / `data_stats` / `ml_predictions` / `injector_trigger` / `rag_query`。

示例对话：「查一下 BTC 最近 24 小时 1h K 线」→ `data_bars(symbol="BTC/USDT", timeframe="1h", limit=24)`。

### 5.3 端到端最小流程

```bash
# 1) 确认健康
curl -s https://infrax.0xainet.top/api/data/health

# 2) 拉数据（任一携带方式）
curl -H "X-API-Key: dx_xxx" \
  "https://infrax.0xainet.top/api/data/bars?symbol=BTC/USDT&timeframe=1d&limit=5"

# 3) 用量监控：管理员可查看 request_count / last_used_at，随时限流/吊销
```

---

## 6. 场景二：服务平台接入（LightRAG 知识库）

> 详细开通流程与全部端点见 [LightRAG 知识库使用文档](INTEGRATION_LIGHTRAG.md)。

服务平台需求：**把资料（产品文档、策略说明、研究报告等）存放起来，支持自然语言语义检索**。LightRAG 会自动抽取实体构建知识图谱，支持 local（局部）/ global（全局）/ hybrid / mix 检索。

### 6.1 开通（管理员操作，一次性）

```bash
# 管理员：创建租户 + 签发 lr_ key（Bearer ADMIN_API_KEY）
curl -X POST https://infrax.0xainet.top/api/rag/api/v1/tenants \
  -H "Authorization: Bearer <ADMIN_KEY>" -H "Content-Type: application/json" \
  -d '{"tenant_id":"servicehub","name":"服务平台"}'
curl -X POST https://infrax.0xainet.top/api/rag/api/v1/tenants/servicehub/api-keys \
  -H "Authorization: Bearer <ADMIN_KEY>" -H "Content-Type: application/json" \
  -d '{"label":"prod","expires_days":180}'
# → 返回 lr_xxx（仅显示一次）
```

### 6.2 Python SDK 写入与检索

```bash
pip install lightrag-client   # 或本地 wheel：pip install lightrag_client-2.0.0-py3-none-any.whl
```

```python
from lightrag_client import LightRAGClient

rs = LightRAGClient(
    base_url="https://infrax.0xainet.top/api/rag",
    api_key="lr_xxx",
    tenant_id="servicehub",
)

# ① 写入资料（可批量，doc_id 幂等，重复写入自动覆盖）
rs.insert("docs", "2026-08-06 平台服务条款 v3 更新……", "doc-001")
rs.insert_batch("docs", [
    {"text": "手续费说明：挂单 0.02%，吃单 0.05%", "doc_id": "doc-002"},
    {"text": "API 限流：默认 100 次/分钟", "doc_id": "doc-003"},
])

# ② 语义检索（hybrid 混合检索最常用）
result = rs.query("docs", "手续费是多少")
print(result)          # 返回相关片段 + 引用

# ③ 纯上下文检索（Top-K，不生成答案）
ctx = rs.retrieve("docs", "API 限流", top_k=5)

# ④ 文档管理
rs.list_documents("docs", page=1, limit=20)
rs.delete("docs", "doc-001")
```

### 6.3 自动注入（可选）

knowledge-injector 每 6 小时自动把 21 类数据源（宏观、情绪、链上、OKX 行情等）注入知识库的 `market` 命名空间，也可手动触发：

```bash
# 内网触发（injector 不对外暴露）
curl -X POST http://127.0.0.1:9113/inject \
  -H "X-API-Key: <bridge key>" -H "Content-Type: application/json" \
  -d '{"namespace":"market","sources":["macro","sentiment","onchain"]}'
```

> 注意：自动注入使用平台内部 bridge key；项目方 `lr_` key 仅绑定自己的租户，不触发注入器。

---

## 7. 常见问题

| 问题 | 处理 |
|---|---|
| 外网地址 502 / 连不上 | DNS 是否已切到 `43.163.105.172`？切换前用 IP + `-k` |
| 返回 `401 {"detail":"unauthorized"}` | key 缺失/非法/已吊销；检查 header 名与值 |
| 返回 `403 API key disabled` | key 被管理员禁用（数据服务） |
| 返回 `429 Rate limit exceeded` | 超出该 key 的 RPM 限流，联系管理员调高或稍后重试 |
| 需要更多命名空间/租户 | 联系管理员创建（ragservicer 命名空间按首次访问隐式创建） |

---

## 8. 相关文档

| 文档 | 内容 |
|---|---|
| [INTEGRATION_DATA_SERVICE.md](INTEGRATION_DATA_SERVICE.md) | data 服务 REST 端点全表 + SDK 样例 + MCP 配置 |
| [INTEGRATION_LIGHTRAG.md](INTEGRATION_LIGHTRAG.md) | ragservicer/injector 开通、写入、检索、注入 |
| [infrax_tasklist.md](infrax_tasklist.md) | 数据栈部署与运维（内部） |
| [API_ACCESS.md](API_ACCESS.md) | 区块链服务栈（WAAS/Vault/MPC/DC/Payment/Session Key）接入 |
