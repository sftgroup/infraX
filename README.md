# InfraX — Web3 基础设施平台

> Monorepo | 11 模块 | 11/11 在线 | Commit `e42ea9c` | Version `v0.2.0-dashboard-20260715`

## 项目介绍

InfraX 是一个 Web3 基础设施平台，提供钱包即服务（WaaS）、多签保险库（Vault）、链上数据中心（DC）、MPC 密钥分片等模块。面向 B 端 SaaS 租户，支持 REST API / MCP / JS SDK 三种接入方式。

### 核心能力

| 模块 | 说明 | 端口 |
|------|------|------|
| **WAAS** | 托管钱包、HD 地址生成、Gas Sponsor、热钱包、SaaS 租户管理 | 6001 |
| **Vault** | Safe 多签：部署/提案/确认/执行、Owner 管理、风控 | 6002 |
| **DC** | 链上事件查询（5链）、订阅计划、API Key 管理 | 3001 |
| **MPC** | 邮件验证码、密钥分片注册/恢复 | 6003 |
| **Payment** | x402 支付引擎、订单管理 | 6004 |
| **Collector** | 链上数据采集 (5链 29端点)、OKX ChainOS 资产快照、Binance 行情 | 3008 |
| **Admin** | 跨模块聚合管理后台 (14 页，React SPA) | 3002 |
| **Dashboard** | 前端仪表盘 — 4 服务状态总览（MPC/WaaS/Vault/DC） | 6100 |
| **Landing** | 产品落地页 — 介绍、定价、文档导航 | 6100 |

### 三种接入方式

| | REST API | MCP | JS SDK |
|------|----------|-----|--------|
| WAAS/Wallet | ✅ | ✅ | ✅ |
| Safe/Vault | ✅ | ✅ | ✅ |
| Payment | ✅ | ✅ | ✅ |
| Data Center | ✅ | ✅ | ✅ |
| MPC | ✅ | ✅ | ✅ |
| Admin | ✅ | — | — |

> 三种接入方式通过相同后端 API 端点，**API 合约完全一致**，仅接入层不同。

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
│   ├── mcp-server/   # 3 MCP Server (:3004/:3005/:3006)
│   ├── web/          # 前端 + Landing, :6100 (Node proxy)
│   │   ├── index.html / connect.html / admin.html / landing.html
│   │   ├── server.js (零依赖 proxy → /api/v2/* 转发)
│   │   └── modules/ (core.js + 7 业务模块)
│   └── sdk/          # JS SDK v0.2
├── docs/
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
| DC MCP | 3005 | — | 🟢 |
| Wallet MCP | 3004 | — | 🟢 |
| Vault MCP | 3006 | — | 🟢 |
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

**当前版本**: `v0.2.0-dashboard-20260715` (tag on `aff8903`, HEAD at `e42ea9c`)

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.2.0 | 2026-07-15 | Dashboard 重构 + 全 API 修复 + DC 5链展示 |
| v0.1.0 | 2026-07-14 | 10/10 服务上线、改名、Landing |

## 相关项目

| 项目 | 生产 | GitHub |
|------|------|--------|
| Agentx | 43.156.99.215:3100 | `sftgroup/Agentx` |
| aihunter-saas | 129.226.202.72:3001 | `sftgroup/aihunter-saas` |
| AItrader | 129.226.202.72 (源码) | `sftgroup/AItrader` |
