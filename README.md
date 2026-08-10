# InfraX — Web3 基础设施平台

> Monorepo | 16 模块 | Version `v0.7.0-20260811` | 生产（单机）`43.163.105.172`

## 项目介绍

InfraX 是一个 Web3 基础设施平台，提供钱包即服务（WaaS）、多签保险库（Vault）、链上数据中心（DC）、MPC 密钥分片等模块。面向 B 端 SaaS 租户，支持 REST API / MCP / JS SDK / Python SDK 四种接入方式。

### 核心能力

| 模块 | 说明 | 端口 |
|------|------|------|
| **WAAS** | 托管钱包、HD 地址生成、Gas Sponsor、热钱包、SaaS 租户管理 | 9109 |
| **Vault** | Safe 多签：部署/提案/确认/执行、Owner 管理、风控 | 9107 |
| **DC** | 链上事件查询（5 链）、订阅计划、API Key 管理 | 9102 |
| **MPC** | 邮件验证码、密钥分片注册/恢复、Agent Wallet（会话/签名/合约/转账） | 9104 |
| **Payment（旧）** | 旧支付服务（历史残留，订阅已迁移至 WAAS + Payments） | 9106 |
| **Payments** | 通用支付引擎 @0xinfrax/payments：chain/fiat/x402/MPP + period/invite/transfer/batch 能力（MQ-16 T-5） | 9132 |
| **Chain RPC** | 链 RPC 网关（统一路由 + 读/广播鉴权分级）+ **RPC 套餐订阅（MQ-16 T-3）** | 9130 |
| **AA Relay** | Account Abstraction 交易中继 | 9131 |
| **Session Key** | 会话密钥授权服务（Bundler + Paymaster） | 3500 |
| **Collector** | 全链事件扫描（全量日志→本地分类）+ OKX ChainOS v6 行情（40+端点/K线/Meme/信号）+ Binance 期货 | 9101 |
| **Market API** | 代币搜索/K线/热门排行/Meme扫链/聪明钱信号/持仓集群/地址分析/余额(免费)/交易历史(免费) | 9101 |
| **Admin** | 跨模块聚合管理后台（12 服务状态/租户/交易/收益） | 9100 |
| **Web Proxy** | 静态文件 + API 反向代理 + 安全头 + 健康检查 | 9111 |
| **Data** | 统一行情/K 线/因子/快照数据服务（AItrader data-service 迁入） | 9112 |
| **Knowledge Injector** | 知识图谱注入：拉取快照 → 解析 → 注入 RAGservicer 构建图谱 | 9113 |
| **RAGservicer** | LightRAG 知识库微服务（文档管理 + 图谱检索 + MCP） | 9721 |
| **MCP × 8** | AI Agent 接入：DC/MPC/Vault/Wallet/RPC/Session-Key/Market/Hub-Index 共 **123 tools**（MQ-16 新增 32 个套餐工具） | 9103/9105/9108/9110/3012/3011/3013/3008 |

### 四种接入方式

| | REST API | MCP | JS SDK | Python SDK |
|------|----------|-----|--------|------------|
| WAAS/Wallet | ✅ | ✅ | ✅ | — |
| Safe/Vault | ✅ | ✅ | ✅ | — |
| Payments（支付引擎） | ✅ | ✅（wallet-mcp payment_* 代理） | ✅（v0.6.0：基础 10 + batch/invite/transfer 15） | — |
| Data Center | ✅ | ✅ (11 tools，含 MQ-16 订阅 4) | ✅（v0.6.0：数据 6 + 订阅 4） | ✅（infra-data-client 0.2.0，PyPI） |
| Market (行情+分析) | ✅ (39 endpoints) | ✅ (18 tools，含 MQ-16 订阅 5) | ✅ (21 methods，含订阅 5) | — |
| MPC | ✅ | ✅ (17 tools，含计费 2) | ✅（v0.6.0：16 methods） | — |
| Chain RPC | ✅ | ✅ (10 tools，含订阅 6) | ✅（v0.6.0：10 methods，含订阅 6） | — |
| RAGservicer/LightRAG | ✅ | ✅ (MCP + LightRAG STDIO) | ✅（ragservicer-sdk TS 类型） | ✅（lightrag-client 2.0.0，PyPI） |
| Admin | ✅ | — | — | — |

> 四种接入方式通过相同后端 API 端点，API 合约完全一致，仅接入层不同。Python SDK 于 2026-08-11 发布 PyPI（`lightrag-client` 2.0.0 / `infra-data-client` 0.2.0）。每个微服务的**详细使用文档 + 样例代码**见 [docs/services/](./docs/services/)（13 篇，2026-08-11 生产逐一实测）。详见 [docs/API_ACCESS.md](./docs/API_ACCESS.md)

### 服务文档索引（docs/services/，13 篇均含 Quick Start）

| 服务 | 端口 | 公网访问 | 鉴权 | 文档 |
|---|---|---|---|---|
| Admin 管理后台 | 9100 | 经 web 代理 `/api/v2/admin` | 用户名密码登录 → token | [admin.md](./docs/services/admin.md) |
| Collector / Market 行情 | 9101 | 经 web 代理 `/api/v2/data/market`、`/api/v2/market` | X-API-Key（pkx_）+ 按量计费（超限 503） | [market.md](./docs/services/market.md) |
| DC 链上数据中心 | 9102 | 经 web 代理 `/api/v2/data` | 数据面 x-dc-api-key；订阅面 x-wallet-address（超限 429） | [dc.md](./docs/services/dc.md) |
| MPC 多方计算钱包 | 9104 | 经 web 代理 `/api/v2/mpc` | 统一 key（MPC_API_KEY / mp_ key）；plans 公开（欠费 402） | [mpc.md](./docs/services/mpc.md) |
| Vault Safe 多签 | 9107 | 经 web 代理 `/api/vault` | 统一 key（VAULT_API_KEY / vx_ key） | [vault.md](./docs/services/vault.md) |
| WAAS 钱包即服务 | 9109 | 经 web 代理 `/api/v2/wallet`、`/api/v2/saas`、`/api/v2/subscription` | 平台托管签名（类 CEX，外部零链上签名）；API 身份认证 EIP-191 24h / tenant key；plans 公开 | [waas.md](./docs/services/waas.md) |
| Web 代理层 | 9111 | **公网入口**（nginx 80/443 → 9111） | 代理自动注入 X-Service-Key | [web.md](./docs/services/web.md) |
| Data 数据中心 | 9112 | 经 nginx `/api/data/*` | 统一 key（DATA_API_KEY / dx_ key）；/health /docs 公开 | [data.md](./docs/services/data.md) |
| Knowledge Injector | 9113 | 仅内网 | INJECTOR_API_KEY | [knowledge-injector.md](./docs/services/knowledge-injector.md) |
| Chain RPC 网关 | 9130 | **仅内网**（外部经 SDK key 直连） | 读/广播 key / rx_ 订阅 key（超限 503） | [chain-rpc.md](./docs/services/chain-rpc.md) |
| Payments 通用支付引擎 | 9132 | **仅内网**（业务服务经 key 调用） | 统一 key（PAYMENTS_API_KEY / px_ key） | [payments.md](./docs/services/payments.md) |
| RAGservicer 知识库 | 9721 | 经 nginx `/api/rag/*` | 租户 key（RAGSERVICER_API_KEY / lightrag-client） | [ragservicer.md](./docs/services/ragservicer.md) |
| Session Key 会话授权 | 3500 | 经 web 代理（SDK 直连） | API_TOKENS 白名单；nonce/sessions 创建公开 | [session-key.md](./docs/services/session-key.md) |

> 索引与通用接入说明（鉴权契约 / 计费矩阵 / SDK 命名空间对照）见 [docs/services/README.md](./docs/services/README.md)。

---

## 系统架构

### 拓扑总览

```
                           ┌──────────────┐
                           │   浏览器/客户端  │
                           └──────┬───────┘
                                  │ HTTP
                           ┌──────▼───────┐
                           │  Web Proxy    │  :9111
                           │  (server.js)  │  静态文件 + API 代理
                           └──────┬───────┘
                    ┌─────────────┼──────────────┬───────────┐
                    ▼             ▼              ▼           ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
              │  Admin    │ │   DC     │ │   MPC    │ │  WAAS    │
              │  :9100    │ │  :9102   │ │  :9104   │ │  :9109   │
              └──────────┘ └──────────┘ └──────────┘ └──────────┘
                    │             │              │           │
                    └─────────────┼──────────────┘           │
                                  │                          │
              ┌───────────────────┼──────────────────────────┤
              ▼                   ▼              ▼           ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ Payment  │  │  Vault   │  │Collector │  │  MCP×4   │
        │  :9106   │  │  :9107   │  │  :9101   │  │9103/5/8/ │
        └──────────┘  └──────────┘  └──────────┘  │  10      │
                                                   └──────────┘
                           ┌──────────────┐
                           │  PostgreSQL   │  :5432
                           │  pocketx_*    │  7 数据库
                           └──────────────┘
```

### 请求链路

```
用户浏览器
  │
  ├── 静态页面: Web :9111 → index.html / landing.html / admin.html
  │
  ├── API 调用: Web :9111 → proxy → 后端服务
  │     /api/v2/data/plans    → DC :9102
  │     /api/v2/mpc/send-code → MPC :9104
  │     /api/vault/safe/list  → Vault :9107
  │     /api/v2/admin/login   → Admin :9100
  │
  └── MCP 调用: AI Agent → MCP :9103/9105/9108/9110 → 后端服务
        dc_plans       → DC MCP :9103   → DC API :9102
        mpc_status     → MPC MCP :9105  → MPC API :9104
        wallet_balance → Wallet MCP :9110 → WAAS API :9109
        vault_status   → Vault MCP :9108 → Vault API :9107
```

### 模块依赖关系

```
                    ┌─────────────┐
                    │  前端 SPA    │  web/ (纯静态 + proxy)
                    └──────┬──────┘
                           │ HTTP (通过 Web Proxy :9111)
              ┌────────────┼────────────┬───────────┐
              ▼            ▼            ▼           ▼
        ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐
        │  DC     │ │  MPC    │ │  WAAS   │ │  Admin   │  ← 核心业务层
        │ :9102   │ │ :9104   │ │ :9109   │ │  :9100   │     (直接对外)
        └────┬────┘ └─────────┘ └────┬────┘ └──────────┘
             │                       │
             ▼                       ▼
        ┌─────────┐           ┌──────────┐
        │Collector │          │ Payments │             ← 依赖层
        │ :9101   │          │  :9132   │                (内部调用)
        └─────────┘          └──────────┘
                                    │
              ┌─────────────────────┤
              ▼                     ▼
        ┌──────────┐          ┌──────────┐
        │  Vault   │          │  MCP×4   │              ← 扩展层
        │  :9107   │          │9103/5/8/│                 (独立入口)
        └──────────┘          │  10      │
                              └──────────┘
```

### 数据流

```
1. 页面加载
   index.html → 加载 modules/core.js
   → checkSession() 检查 localStorage 中的 walletAddress
   → 有 → getMe() 并行请求 MPC/WaaS/DC/Vault 状态
   → 无 → 显示 "Connect Wallet" 引导页

2. 钱包连接
   connect.html → 用户点击 MetaMask
   → ethers Mock Provider 注入 → 返回 walletAddress
   → 存入 localStorage → 跳转 index.html Dashboard

3. API 调用（afetch 包装）
   afetch('/api/v2/data/plans')
   → 自动带上 x-wallet-address header
   → 自动解包 { code: 0, data: [...] }
   → 调用方直接拿 data，无需 code === 0 检查

4. MCP 调用
   AI Agent → POST /mcp/message (JSON-RPC)
   → MCP Server 解析 tool name
   → 转发到对应后端 API（如 DC MCP → DC :9102）
   → 封装返回 JSON-RPC result
```

### 数据库分库策略

```
postgres://localhost:5432
├── pocketx_collector (10+ 表) — 链上事件、checkpoint、OKX、Binance
├── pocketx_waas       (17 表) — 钱包、用户、交易、租户、SaaS
├── pocketx_vault      (4 表)  — safe_wallets/transactions/signatures/risk_rules
├── pocketx_dc         (3 表)  — subscriptions/api_keys/usage_log
├── pocketx_mpc        (2 表)  — mpc_wallets/mpc_sessions
├── pocketx_payments   (11 表) — payment_intents/sessions/credits/transfers/invites 等（通用支付引擎）
└── pocketx_admin      (3 表)  — users/rpc_configs/settings
（旧 pocketx_payment 库已归档至 backups/pocketx_payment_20260811.sql，MQ-15 T-7）

每个模块拥有独立数据库，模块间不共享 schema。
跨模块调用通过 HTTP API，不跨库 JOIN。
```

---

## 代码结构

```
infraX/
├── projects/
│   ├── admin/         # Express 5 + React SPA, :9100
│   │   ├── server/index.ts  ← 管理 REST API（7 DB 跨库查询）
│   │   └── admin.html       ← 前端入口（通过 web/ 代理访问）
│   ├── collector/     # Express TS, :9101 — 5 链区块扫描 + OKX + Binance
│   │   └── models/          ← RPC 池管理（rpc-pool.json + env + DB 三层合并）
│   ├── dc/            # Express TS, :9102 — 数据中心（双 PG pool）
│   │   ├── index.ts         ← 9 个 REST 端点（events/stats/plans/balance/...）
│   │   └── services/        ← 事件查询引擎（5 链跨链聚合）
│   ├── mcp-server/    # 8 个 MCP Server 入口（独立进程）
│   │   └── src/
│   │       ├── index.ts        ← Wallet MCP :9110 (34 tools)
│   │       ├── dc-index.ts     ← DC MCP :9103 (11 tools)
│   │       ├── vault-index.ts  ← Vault MCP :9108 (13 tools)
│   │       ├── mpc-index.ts    ← MPC MCP :9105 (17 tools)
│   │       ├── market-index.ts ← Market MCP :3013 (18 tools)
│   │       ├── rpc-index.ts    ← Chain RPC MCP :3012 (10 tools)
│   │       ├── session-key-index.ts ← Session Key MCP :3011
│   │       └── hub-index.ts    ← Hub Index :3008 (13 tools)
│   ├── mpc/           # Express TS, :9104 — MPC 密钥分片 + Agent Wallet
│   │   ├── server.ts        ← 验证码、注册、恢复、Session Token
│   │   └── services/        ← EIP-191/712 签名、转账、合约调用
│   ├── payment/       # Express TS, :9106 — x402 支付引擎
│   ├── vault/         # Express TS, :9107 — Safe 多签
│   │   ├── server.ts        ← Safe 部署、提案、签名、执行
│   │   └── services/        ← multiSigService + riskService
│   ├── waas/          # Express TS, :9109 — 钱包即服务
│   │   ├── server.ts        ← 钱包/交易/SaaS/租户管理
│   │   └── services/        ← HD 生成、Gas 估算、Sweep 归集
│   ├── web/           # 前端 SPA + Node proxy, :9111
│   │   ├── server.js        ← 零依赖 HTTP proxy → 后端 API
│   │   ├── index.html       ← 主应用（Dashboard 仪表盘）
│   │   ├── connect.html     ← 钱包连接页（MetaMask 注入）
│   │   ├── admin.html       ← Admin 面板登录入口
│   │   ├── landing.html     ← 产品落地页
│   │   ├── img/             ← 链 Logo SVG × 6
│   │   └── modules/
│   │       ├── core.js      ← 核心库（afetch, getMe, setupNav, showToast）
│   │       ├── nc-wallet.js ← Dashboard 仪表盘（4 模块状态）
│   │       ├── datacenter.js← Data Center 模块（套餐/API Key/用量）
│   │       ├── mpc-wallet.js← MPC 模块（注册/恢复/Agent Wallet）
│   │       ├── waas.js      ← WaaS 模块（租户/地址/归集）
│   │       ├── waas-extras.js← WaaS 工具函数
│   │       ├── safe.js      ← Safe/Vault 模块（多签管理）
│   │       ├── exports.js   ← 导出模块
│   │       └── infrax.css   ← 统一样式
│   └── sdk/           # JS SDK v0.6.0 (TypeScript，@0xinfrax/infrax-dk)
│       └── src/             ← ix.mpc / ix.wallet / ix.vault / ix.dc / ix.payment / ix.market / ix.chainRpc
│   ├── data/sdk/python/     # Python SDK infra-data-client 0.2.0（已发布 PyPI，2026-08-11）
│   ├── ragservicer/sdk/python/  # Python SDK lightrag-client 2.0.0（已发布 PyPI，2026-08-11）
├── docs/
│   ├── API_ACCESS.md     # 三合一接入文档（REST/MCP/SDK）
│   ├── MCP_REQUIREMENTS.md
│   └── services/         # 13 篇微服务使用文档（Quick Start + 端点清单 + 样例 + 错误码）
│       ├── README.md     # 服务索引 + 通用鉴权契约 + MQ-16 计费矩阵 + SDK 命名空间对照
│       └── *.md          # admin / market / dc / mpc / vault / waas / web / data /
│                         # knowledge-injector / chain-rpc / payments / ragservicer / session-key
├── DEPLOYMENT.md
├── PROGRESS.md
└── README.md
```

### 架构原则

- **独立进程**: 每模块独立 Express 进程 + 独立 PostgreSQL DB
- **不跨 import**: 模块间通过 HTTP API 通信，不 import 源码
- **四种接入**: REST API → MCP → JS SDK / Python SDK，层层封装
- **前端数据流**: `Dashboard → getMe() (localStorage) + afetch (API) → 渲染`
- **afetch 契约**: 自动解包 `{code, data}` → 调用方直接拿到 `data` 内容
- **Web Proxy 统一入口**: 静态文件 + API 代理 + 安全头（HSTS / X-Frame-Options / X-Content-Type-Options）
- **MCP 独立端口**: 每个 MCP Server 独立进程，AI Agent 直连，不经 Web Proxy

### Web Proxy 路由表

```
/api/v2/data/*    → :9102 (DC)
/api/v2/market/*  → :9101 (Collector)   ← MQ-16 新增（2026-08-11）
/api/v2/mpc/*     → :9104 (MPC)
/api/v2/wallet/*  → :9109 (WAAS)
/api/v2/waas/*    → :9109 (WAAS)
/api/v2/saas/*    → :9109 (WAAS)
/api/v2/subscription/* → :9109 (WAAS)
/api/vault/*      → :9107 (Vault)
/api/v2/vault/*   → :9107 (Vault)
/api/v2/admin/*   → :9100 (Admin)
其他路径          → 静态文件 (web/)
```

---

## 支持的区块链

| 链 | chain 参数 | Chain ID | 类型 | 状态 |
|---|-----------|----------|------|------|
| **Sepolia** | `sepolia` | 11155111 | EVM 测试网 | 🟢 |
| **Ethereum** | `ethereum` / `eth` | 1 | EVM 主网 | 🟢 |
| **BSC** | `bsc` | 56 | EVM 主网 | 🟢 |
| **Solana** | `solana` | — | Non-EVM | 🟢 |
| **Base** | `base` | 8453 | EVM L2 | 🟢 |
| **OxaChain** | `oxa` | 19505 | EVM L1 Sovereign | 🟢 |
| Polygon | `polygon` | 137 | EVM L2 | 🟢 |
| Arbitrum | `arbitrum` | 42161 | EVM L2 | 🟢 |
| Optimism | `optimism` | 10 | EVM L2 | 🟢 |

> DC Free 套餐仅 Sepolia。Pro/Enterprise 支持 Sepolia/ETH/BSC/Polygon/Arbitrum/Optimism/Base/OxaChain。OxaChain RPC: `https://rpc.l1.oxachain.io`

## 当前服务状态

| 服务 | 端口 | DB | 状态 |
|------|------|-----|------|
| **Admin** | 9100 | pocketx_admin + 跨 7 DB | 🟢 SPA + REST |
| **Collector** | 9101 | pocketx_collector (10+ 表) | 🟢 5 链扫描 + Market 订阅 |
| **DC** | 9102 | pocketx_dc + pocketx_collector | 🟢 数据订阅（MQ-16 T-1） |
| **DC MCP** | 9103 | — | 🟢 11 tools |
| **MPC** | 9104 | pocketx_mpc (2 表) | 🟢 按量计费（MQ-16 T-4） |
| **MPC MCP** | 9105 | — | 🟢 17 tools |
| ~~**Payment**~~ | ~~9106~~ | ~~pocketx_payment (3 表)~~ | 🔴 已下线（MQ-15 T-7） |
| **Vault** | 9107 | pocketx_vault (4 表) | 🟢 |
| **Vault MCP** | 9108 | — | 🟢 13 tools |
| **WAAS** | 9109 | pocketx_waas (17 表) | 🟢 |
| **Wallet MCP** | 9110 | — | 🟢 34 tools（含 payments batch/invite/transfer） |
| **Web** | 9111 | — | 🟢 Node proxy + 静态 |
| **Chain RPC** | 9130 | pocketx_chainrpc (3 表) | 🟢 RPC 套餐订阅（MQ-16 T-3） |
| **Payments 引擎** | 9132 | pocketx_payments (11 表) | 🟢 通用支付（MQ-16 T-5） |
| **RPC MCP** | 3012 | — | 🟢 10 tools |
| **Market MCP** | 3013 | — | 🟢 18 tools（MQ-16 T-2） |

## E2E 测试 (v0.3.2)

| 测试类型 | 结果 | 详情 |
|---------|------|------|
| 浏览器钱包注入 | **19/19** ✅ | MetaMask mock → 连接 → MPC 注册 → Session Unlock → DC 订阅 |
| API E2E | **45/50** ✅ (90%) | 健康检查 + Web Proxy 路由 + Admin 认证 + DC/MPC/WAAS/Vault 端点 |
| MCP 真实调用 | **4/4 服务** ✅ | DC/MPC/Vault/Wallet 45 tools 全部可用 |
| 安全头 | ✅ | HSTS / X-Frame-Options / X-Content-Type-Options |

### 测试钱包

| 项目 | 值 |
|------|-----|
| 浏览器钱包 | `0x2bA20a76af1297D4Ef9BD242866F690aceaAb9f1` |
| MPC 钱包 | `0xcaCDbE995F5AbFf92968D7C45F622E3976a9547A` |
| DC API Key | `infrax_dc_513074f8b63a7df175d6a4ea834b9760dd3ae3e525af544e` |
| DC 套餐 | Data Free (10,000 次/月) |

## Dashboard 仪表盘

展示 4 项服务状态，数据源为 `getMe()` localStorage + 后端 API：

| 服务 | KPI | 数据来源 | 状态判定 |
|------|-----|---------|---------|
| MPC | 钱包注册状态 | `mpc.registered` | Active / Inactive |
| WaaS | 租户 + 计划 | `waas.status` + `planName` | Active / Inactive |
| Vault | Safe 数量 | `safe.count > 0` | Active / Inactive |
| Data Center | 计划 + 用量 | `dc.planName` + `currentUsage`/`monthlyQuota` | Active / Inactive |

## 部署

| 环境 | 服务器 | 规格 | 方式 |
|------|--------|------|------|
| **生产（单机全栈）** | **43.163.105.172** | 2C/3.6G/59G | systemd（数据栈 9112/9113/9721 + 区块链栈 9100-9111（9106 已下线）+ 平台服务 9130-9132/9200-9201/3500 + MCP 3008/3011/3012/9103/9105/9108/9110 + nginx 80/443，24 units + timer） |
| ml-service | 43.156.25.197 | 2C/4G | systemd（:9120，独立服务器） |
| 旧服务器 | ~~43.156.46.187 / 43.156.99.215 / 129.226.203.60~~ | — | 已弃用 |

- 区块链服务栈：详见 [DEPLOYMENT.md](./DEPLOYMENT.md)
- **数据服务栈（9112/9113/9721）**：详见 [docs/infrax_tasklist.md](./docs/infrax_tasklist.md)
- 合并进度：详见 [PROGRESS.md](./PROGRESS.md)

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| **v0.7.0** | 2026-08-11 | **MQ-16 套餐消费面全量补齐**：infrax-dk v0.6.0（DC 订阅 4 + Market 订阅 5 + Chain RPC 订阅 6 + MPC 计费 2 + payments batch/invite/transfer 15 = 27 方法）；MCP +32 tools（dc 11 / market 18 / rpc 10 / mpc 17 / wallet 34 = 123 total）；market-mcp 生产部署（:3013）；web 代理补 `/api/v2/market` → collector :9101；**Python SDK 发布 PyPI**（lightrag-client 2.0.0 + infra-data-client 0.2.0）；文档全量更新（SDK_INTEGRATION / SERVICE_API_REFERENCE / MCP_USAGE / API_ACCESS） |
| v0.5.1 | 2026-08-04 | AItrader 合并：data-service → projects/data (:9112)、knowledge-injector (:9113)、可配置解析层（YAML 规则驱动）、DC/Collector raw 注入 RAGservicer 构建图谱 |
| v0.3.2 | 2026-07-18 | 生产 E2E 测试：端口 9100-9111、Web Proxy /health+安全头、Admin API 修复、MPC 前端验证码流程、DB 建表补全、MCP 环境变量+端口修复、浏览器钱包注入 19/19 通过、MCP 45 tools 可用 |
| v0.3.1 | 2026-07-17 | 新服务器部署、Express 5 迁移、BSC RPC 池三层合并、依赖补全 |
| v0.3.0 | 2026-07-17 | MPC Agent Wallet（Session Token、EIP-191/712 签名、合约调用、5 链转账）、安全加固 × 3、Bug 修复 × 8、MCP 15 tools |
| v0.2.3 | 2026-07-15 | OxaChain L1 集成、全量 GitHub 同步、三合一接入文档 |
| v0.2.2 | 2026-07-15 | 字体放大、链 Logo SVG、WaaS Quick Start |
| v0.2.1 | 2026-07-15 | DC Chain Scan 卡片 UI |
| v0.2.0 | 2026-07-15 | Dashboard 重构 + 全 API 修复 |
| v0.1.0 | 2026-07-14 | 10 服务上线、改名、Landing |

## 相关项目

| 项目 | 生产 | GitHub |
|------|------|--------|
| Agentx | 43.163.105.172:3100 | `sftgroup/Agentx` |
| OxaChain | 43.163.105.172:18545 | `sftgroup/oxachain` |
| aihunter-saas | 129.226.202.72:3001 | `sftgroup/aihunter-saas` |
| AItrader | 129.226.202.72 (源码) | `sftgroup/AItrader` |
| aiservicer | — | `sftgroup/aiservicer` |
| aiops-saas | — | `sftgroup/aiops-saas` |
