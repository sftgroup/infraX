# InfraX — Web3 基础设施平台

> Monorepo | 11 模块 | Version `v0.3.0-20260717`

## 项目介绍

InfraX 是一个 Web3 基础设施平台，提供钱包即服务（WaaS）、多签保险库（Vault）、链上数据中心（DC）、MPC 密钥分片等模块。面向 B 端 SaaS 租户，支持 REST API / MCP / JS SDK 三种接入方式。

### 核心能力

| 模块 | 说明 | 端口 |
|------|------|------|
| **WAAS** | 托管钱包、HD 地址生成、Gas Sponsor、热钱包、SaaS 租户管理 | 6001 |
| **Vault** | Safe 多签：部署/提案/确认/执行、Owner 管理、风控 | 6002 |
| **DC** | 链上事件查询（6链，含 OxaChain）、订阅计划、API Key 管理 | 3001 |
| **MPC** | 邮件验证码、密钥分片注册/恢复、**Agent Wallet（会话签约/合约调用/转账）** | 6003 |
| **MPC MCP** | **15 个 MCP Tool**：Agent 会话管理 + EIP-191/712 签名 + 转账 + 合约读写 | 3007 |
| **Payment** | x402 支付引擎、订单管理 | 6004 |
| **Collector** | 链上数据采集 (6链 29端点)、OKX ChainOS 资产快照、Binance 行情 | 3008 |
| **Admin** | 跨模块聚合管理后台 (14 页，React SPA) | 3002 |
| **Dashboard** | 前端仪表盘 — 4 服务状态总览（MPC/WaaS/Vault/DC） | 6100 |
| **Landing** | 产品落地页 — 介绍、定价、文档导航 | 6100 |

### 三种接入方式

| | REST API | MCP | JS SDK |
|------|----------|-----|--------|
| WAAS/Wallet | ✅ | ✅ | ✅ |
| Safe/Vault | ✅ | ✅ | ✅ |
| Payment | ✅ | ✅ | ✅ |
| Data Center | ✅ | ✅ (7 tools) | ✅ |
| MPC | ✅ | ✅ (15 tools) | ✅ |
| Admin | ✅ | — | — |

> 三种接入方式通过相同后端 API 端点，**API 合约完全一致**，仅接入层不同。详见 [docs/API_ACCESS.md](./docs/API_ACCESS.md)

---

## 代码结构

```
infraX/
├── projects/
│   ├── waas/         # Express TS, :6001 — 钱包/交易/SaaS/MPC
│   ├── vault/        # Express TS, :6002 — Safe 多签
│   ├── mpc/          # Express TS, :6003 — MPC 密钥分片
│   ├── dc/           # Express TS, :3001 — 数据中心 (双 PG pool)
│   ├── payment/      # Express TS, :6004 — 支付引擎
│   ├── collector/    # Express TS, :3008 — 链上采集 + OKX + Binance
│   ├── admin/        # Express + React SPA, :3002 — 管理后台
│   ├── mcp-server/   # 4 MCP Server (:3004/:3005/:3006/:3007)
│   ├── web/          # 前端 + Landing, :6100 (Node proxy)
│   │   ├── index.html / connect.html / admin.html / landing.html
│   │   ├── server.js (零依赖 proxy → /api/v2/* 转发)
│   │   ├── img/ (链 logo SVG × 6，含 OxaChain)
│   │   └── modules/ (core.js + 7 业务模块)
│   └── sdk/          # JS SDK v0.2
├── docs/
│   ├── API_ACCESS.md     # 三合一接入文档 (REST/MCP/SDK)
│   └── MCP_REQUIREMENTS.md
├── DEPLOYMENT.md
└── README.md
```

### 架构原则

- **独立进程**: 每模块独立 Express 进程 + 独立 PostgreSQL DB
- **不跨 import**: 模块间通过 HTTP API 通信，不 import 源码
- **三种接入**: REST API → MCP → JS SDK，层层封装
- **前端数据流**: `Dashboard → getMe()(localStorage) + afetch(API) → 渲染`
- **afetch 契约**: 自动解包 `{code, data}` → 调用方直接拿到 `data` 内容，无需 `.code === 0` 检查

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

> DC Free 套餐仅 Sepolia。Pro/Enterprise 支持 Sepolia/ETH/BSC/Polygon/Arbitrum/Optimism/Base/OxaChain。OxaChain RPC: `https://rpc-oxa.0xainet.top`

## 当前服务状态

| 服务 | 端口 | DB | 状态 |
|------|------|-----|------|
| WAAS | 6001 | pocketx_waas (17 表) | 🟢 |
| Vault | 6002 | pocketx_vault (4 表) | 🟢 |
| DC | 3001 | pocketx_dc + pocketx_collector | 🟢 |
| MPC | 6003 | pocketx_mpc (2 表) | 🟢 |
| Payment | 6004 | pocketx_payment (3 表) | 🟢 |
| Collector | 3008 | pocketx_collector (10 表, 2.8M events) | 🟢 |
| Admin | 3002 | 跨 6 DB | 🟢 |
| Wallet MCP | 3004 | — | 🟢 |
| DC MCP | 3005 | — | 🟢 |
| Vault MCP | 3006 | — | 🟢 |
| MPC MCP | 3007 | — | 🟢 15 tools |
| Web | 6100 | — | 🟢 Node proxy + 静态 |

## Dashboard 仪表盘

**位置**: 首页 → `🏠 Dashboard` 标签

展示 4 项服务状态，数据源为 `getMe()` localStorage（零延迟）+ DC API：

| 服务 | KPI | 数据来源 | 状态判定 |
|------|-----|---------|---------|
| 🔐 MPC | 钱包注册状态 | `mpc.registered` | Active / Inactive |
| 💰 WaaS | 租户 + 计划 | `waas.status` + `planName` | Active(计划名) / Inactive |
| 🏦 Vault | Safe 数量 | `safe.count > 0` | Active(N个Safe) / Inactive |
| 📡 Data Center | 计划 + 用量 | `dc.planName` + `currentUsage`/`monthlyQuota` | Active(计划) / Inactive |

> 未连接钱包时显示 "🔌 Connect your wallet" 引导页

### WaaS Quick Start 步骤卡

Overview 激活后显示编号步骤卡片（①→②→③→④），每步可点击跳转到对应 Tab：
- ① 添加 Token · ② 获取 API Key · ③ 设置 Sweep · ④ 配置提现

### DC Chain Scan Status 卡片

6 链独立卡片（Sepolia / Ethereum / BSC / Solana / Base / **OxaChain**），每卡片展示：
- 链 SVG logo + 名称
- 🟢 scanning 状态灯
- ⛽ gas + 📦 区块数据

## 部署

**服务器**: 43.156.46.187 (4C/7.5G/178G)

| 项目 | 端口范围 | 在线 |
|------|---------|------|
| InfraX (本项目) | 3001-6100 | 11/11 |
| team8 OpenClaw | 14350 | 🟢 |
| team7 OpenClaw | 14350 | 🟢 |

详见 [DEPLOYMENT.md](./DEPLOYMENT.md)

## Git 工作流

```
refactor/xxx → 开发 → push → sync → tag vX.Y.Z-YYYYMMDD → deploy
```

**当前版本**: `v0.3.0-20260717`

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.3.0 | 2026-07-17 | MPC Agent Wallet：Session Token 机制、EIP-191/712 签名、合约调用、转账（5链）；安全加固（验证码随机化、Secret 强制校验、管理密码脱敏）；Bug 修复（Vault 路由嵌套、Collector 语法错误）；MCP 15 tools；Web Proxy 补全 Payment |
| v0.2.3 | 2026-07-15 | OxaChain L1 集成 (6链)、全量 GitHub 同步、三合一接入文档 |
| v0.2.2 | 2026-07-15 | 全平台字体放大 1.26x、链 Logo SVG 化、WaaS Quick Start 美化、spinner 修复 |
| v0.2.1 | 2026-07-15 | DC Chain Scan 卡片 UI、全量同步 |
| v0.2.0 | 2026-07-15 | Dashboard 重构 + 全 API 修复 + DC 5链展示 |
| v0.1.0 | 2026-07-14 | 10/10 服务上线、改名、Landing |

## 相关项目

| 项目 | 生产 | GitHub |
|------|------|--------|
| Agentx | 43.156.99.215:3100 | `sftgroup/Agentx` |
| OxaChain | 43.156.99.215:18545 | `sftgroup/oxachain` |
| aihunter-saas | 129.226.202.72:3001 | `sftgroup/aihunter-saas` |
| AItrader | 129.226.202.72 (源码) | `sftgroup/AItrader` |
| aiservicer | — | `sftgroup/aiservicer` |
| aiops-saas | — | `sftgroup/aiops-saas` |

### v0.3.0 MPC Agent Wallet (2026-07-17)
- 🤖 **MPC Agent Wallet** — AI Agent 可直接使用的 MPC 钱包能力
  - `session/unlock` 验证码一次性解锁，返回 session token
  - `sign-message` EIP-191、`sign-typed-data` EIP-712 签名
  - `send-transaction` 原生 ETH/ERC20 转账，0.1 ETH 限额
  - `contract-read` 合约只读、`contract-write` 合约写（先模拟后签名）
  - `balance` 多链余额查询、`gas-estimate` Gas 估算
  - 30 分钟 session TTL，审计日志写入 `mpc_agent_logs` 表
- 🔒 **安全加固**: 验证码 `888888` → 6 位加密随机数；MPC_ENCRYPTION_SECRET 强制校验；Admin 密码脱敏
- 🐛 **Bug 修复**: Vault 路由闭包嵌套（6 路由被吞）；Collector config 语法错误
- 🛰️ **MCP MPC**: 从 5 个 tool 扩展到 15 个 tool（session/签名/转账/合约）
- 🌐 **Web Proxy**: 补全 `/api/v2/payment → :6004` 代理

### v0.2.3 更新
- 🔗 **OxaChain L1 集成**: Collector/WAAS/DC 全链路支持 0xAINet 主权链
  - RPC: `https://rpc-oxa.0xainet.top`（HTTPS + Let's Encrypt）
  - Chain ID: `19505`，Clique PoA，2s 出块，Gas: `OXA`
  - Dashboard 6 链卡片 + 独立 SVG logo
- 📚 **三合一接入文档** `docs/API_ACCESS.md`：REST API（5 模块 40+ 端点）、MCP（4 服务 36 tools）、JS SDK（7 模块）
- 📦 **全量 GitHub 同步**: 20 个缺失文件补全，`.gitignore` 排除 logs/backup
