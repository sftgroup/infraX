# InfraX — Web3 基础设施平台

> Monorepo | 10 模块 | 10/10 在线 | Commit `22fc612`

## 项目介绍

InfraX 是一个 Web3 基础设施平台，提供钱包即服务（WaaS）、多签保险库（Vault）、链上数据中心（DC）、MPC 密钥分片等模块。面向 B 端 SaaS 租户，支持 REST API / MCP / JS SDK 三种接入方式。

### 核心能力

| 模块 | 说明 | 端口 |
|------|------|------|
| **WAAS** | 托管钱包、HD 地址生成、Gas Sponsor、热钱包、SaaS 租户管理 | 6001 |
| **Vault** | Safe 多签：部署/提案/确认/执行、Owner 管理、风控 | 6002 |
| **DC** | 链上事件查询、区块检查点、订阅计划、实时价格 (Binance API) | 3001 |
| **MPC** | 邮件验证码、密钥分片注册/恢复、子钱包创建 | 6003 |
| **Payment** | x402 支付引擎、订单管理 | 6004 |
| **Collector** | 链上数据采集 (5链 29端点)、OKX ChainOS 资产快照、Binance 行情 | 3008 |
| **Admin** | 跨模块聚合管理后台 (14 页，React SPA) | 3002 |

### 三种接入方式

| | REST API | MCP | JS SDK |
|------|----------|-----|--------|
| WAAS/Wallet | 12 | 7 | 6 |
| Safe/Vault | 15 | 12 | 15 |
| Payment | 9 | 3 | 6 |
| SaaS/Tenant | 25 | — | 13 |
| DC/Data | 12 | 7 | 8 |
| MPC | 4 | 5 | 4 |
| Admin | 20 | — | — |
| **总计** | **~101** | **34** | **59** |

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
│   └── sdk/          # JS SDK v0.2
├── docs/
├── DEPLOYMENT.md
└── README.md
```

### 架构原则

- **独立进程**: 每模块独立 Express 进程 + 独立 PostgreSQL DB
- **不跨 import**: 模块间通过 HTTP API 通信，不 import 源码
- **三种接入**: REST API → MCP → JS SDK，层层封装

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
| Web | 6100 | — | 🟢 Node proxy + landing |

---

## 部署

**服务器**: 43.156.46.187 (4C/7.5G/178G)

| 项目 | 端口范围 | 在线 |
|------|---------|------|
| InfraX (本项目) | 3001-6100 | 10/10 |
| team8 OpenClaw | 14350 | 🟢 |
| team7 OpenClaw | 14350 | 🟢 |

详见 [DEPLOYMENT.md](./DEPLOYMENT.md)

## Git 工作流

```
refactor/xxx → 开发 → push → sync → tag vX.Y.Z-YYYYMMDD → deploy
```

## 相关项目

| 项目 | 生产 | GitHub |
|------|------|--------|
| Agentx | 43.156.99.215:3100 | `sftgroup/Agentx` |
| aihunter-saas | 129.226.202.72:3001 | `sftgroup/aihunter-saas` |
| AItrader | 129.226.202.72 (源码) | `sftgroup/AItrader` |
