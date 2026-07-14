# InfraX — Web3 基础设施平台

> Monorepo | 10 模块 | 6/11 服务在线 | Tag: v2.7.1-20260714

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
| **Admin** | 跨模块聚合管理后台 (14 页，React SPA) | 3002 |

### 三种接入方式覆盖度

| | REST API | MCP | JS SDK |
|------|----------|-----|--------|
| WAAS/Wallet | 12 | 7 | 6 |
| Safe/Vault | 15 | 12 | 15 |
| Payment | 9 | 3 | 6 |
| SaaS/Tenant | 25 | 0 | 13 |
| Subscription | 4 | 0 | 4 |
| DC/Data | 12 | 7 | 8 |
| MPC | 4 | 5 | 4 |
| Admin | 20 | 0 | 0 |
| **总计** | **~101** | **34** | **59** |

---

## 代码结构

```
infraX/
├── projects/
│   ├── waas/                    # WAAS 钱包服务 :6001
│   │   ├── index.ts             # Express 入口
│   │   ├── config/index.ts
│   │   ├── models/database.ts   # PostgreSQL (pocketx_waas, 14 表)
│   │   ├── middleware/           # auth, dcAuth, rateLimiter, errorHandler, requestLogger
│   │   ├── routes/               # 12 路由 ~101 端点:
│   │   │   │                     #   authRoutes (3), walletRoutes (12), txRoutes (9),
│   │   │   │                     #   saasRoutes (25), dataQueryRoutes, dataSubscriptionRoutes (5),
│   │   │   │                     #   dashboardRoutes (5), paymentRoutes (9), eventRoutes (3),
│   │   │   │                     #   riskRoutes (2), subscriptionRoutes (4), internalRoutes (10),
│   │   │   │                     #   mpcRoutes (4)
│   │   ├── services/             # 18 服务: hdWallet/encryption/risk/tx/webhook/tenant/batch/scanner...
│   │   └── utils/
│   │
│   ├── vault/                   # Vault 多签服务 :6002 (独立)
│   │   ├── server.ts            # Express 入口, 16 端点
│   │   └── src/
│   │       ├── config/
│   │       ├── middleware/       # auth
│   │       ├── models/          # database (pocketx_vault)
│   │       ├── services/        # multiSigService (812 行), hdWalletService, riskService
│   │       └── utils/           # errors, logger
│   │
│   ├── mpc/                     # MPC 密钥分片 :6003 (独立)
│   │   └── server.ts            # Express 入口, 4 端点
│   │
│   ├── dc/                      # DC 数据中心 :3001 (独立)
│   │   ├── index.ts             # Express 入口
│   │   └── package.json
│   │
│   ├── payment/                 # 支付引擎 :6004 (独立)
│   │   ├── server.ts
│   │   └── src/
│   │       ├── middleware/
│   │       └── routes/          # paymentRoutes, subscriptionRoutes
│   │
│   ├── collector/               # 链上数据采集 :3000 (暂停, OOM 已停)
│   │   ├── src/
│   │   │   ├── index.ts         # Express 入口
│   │   │   ├── config.ts
│   │   │   ├── database.ts      # 精简至 14 行 (原 385 行)
│   │   │   ├── middleware/       # apiKeyAuth, sessionAuth
│   │   │   ├── routes/          # admin/data/price/relay
│   │   │   └── services/        # binanceFutures/okxChainOS/scanner/normalizer/relayer/rpcPool
│   │   └── sdk/infrax-dk.ts
│   │
│   ├── admin/                   # Admin 管理后台 :3002
│   │   ├── server/index.ts      # Express, 20 端点, 跨 6 DB
│   │   └── src/                 # React SPA (Vite)
│   │       └── pages/           # 14 页面: Dashboard/Waas/Dc/Vault/Mpc/Revenue/Tenants/...
│   │
│   ├── mcp-server/              # MCP 适配层 (4 Server)
│   │   └── src/
│   │       ├── index.ts         # Wallet MCP :3004 (10 tools)
│   │       ├── vault-index.ts   # Vault MCP :3006 (12 tools)
│   │       ├── dc-index.ts      # DC MCP :3005 (7 tools) 🟢
│   │       └── mpc-index.ts     # MPC MCP :3007 (5 tools)
│   │
│   ├── sdk/                     # InfraX JS SDK v0.2
│   │   └── src/index.ts         # 8 classes, ~60 methods, 完整 TS 类型
│   │
│   └── web/                     # 前端 SPA :6100 (Python http.server)
│       ├── index.html           # 主页面
│       ├── admin.html           # 管理面板
│       ├── connect.html         # 钱包连接
│       └── modules/
│           ├── core.js          # auth/me/afetch/UI 框架
│           ├── waas.js          # Wallet 页面
│           ├── safe.js          # Safe 多签页面
│           ├── datacenter.js    # DC 页面
│           ├── nc-wallet.js     # NC Wallet
│           ├── mpc-wallet.js    # MPC Wallet
│           ├── payment.js       # 支付
│           └── pocketx.css      # 币安黄主题 (FCD535)
│
├── docs/                        # 技术文档
├── test-reports/                # E2E/Code Review 报告
├── DEPLOYMENT.md                # 部署文档
└── README.md                    # 本文件
```

### 架构原则

- **独立进程**: 每模块独立 Express 进程 + 独立 PostgreSQL DB
- **不跨 import**: 模块间通过 HTTP API 通信，不 import 源码
- **三种接入**: REST API → MCP → JS SDK，层层封装

---

## REST API — 完整端点清单

### WAAS (`/api/v2/*`) :6001

**认证** (authRoutes)
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v2/auth/send-code` | POST | 发送邮件验证码 |
| `/api/v2/auth/verify-code` | POST | 验证码校验 |
| `/api/v2/auth/me` | GET | 当前用户信息 |

**钱包** (walletRoutes)
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v2/wallet/balance` | POST | 查询余额 |
| `/api/v2/wallet/send` | POST | 发币 |
| `/api/v2/wallet/simulate` | POST | 估算 Gas |
| `/api/v2/wallet/rpc` | POST | RPC 配置 |
| `/api/v2/wallet/sweep` | POST | 归集 |
| `/api/v2/wallet/tx-status` | GET | 交易状态 |
| `/api/v2/wallet/custom-tokens` | GET | 自定义 Token |
| `/api/v2/wallet/hot-wallets` | GET | 热钱包列表 |
| `/api/v2/wallet/addresses` | GET | 地址池 |
| `/api/v2/wallet/chains` | GET | 支持链列表 |
| `/api/v2/wallet/tokens` | GET | Token 列表 |

**交易** (txRoutes)
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v2/tx/send` | POST | 发送交易 |
| `/api/v2/tx/simulate` | POST | Gas 模拟 |
| `/api/v2/tx/status` | GET | 交易状态 |
| `/api/v2/tx/history` | GET | 历史记录 |
| `/api/v2/tx/gas-price` | GET | 实时 Gas |
| `/api/v2/tx/estimate` | POST | 预估费用 |
| `/api/v2/tx/batch` | POST | 批量发送 |
| `/api/v2/tx/relay` | POST | Gas 代付 |

**SaaS 租户** (saasRoutes)
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v2/saas/tenants` | GET/POST | 租户列表 / 创建 |
| `/api/v2/saas/tenants/:id` | GET/PATCH/DELETE | 租户详情 / 更新 / 删除 |
| `/api/v2/saas/tenants/:id/apikey` | POST/DELETE | 创建 / 删除 API Key |
| `/api/v2/saas/tenants/:id/apikey/rotate` | POST | 轮换 API Key |
| `/api/v2/saas/tenants/:id/activate` | POST | 激活租户 |
| `/api/v2/saas/tenants/:id/usage` | GET | API 用量 |
| `/api/v2/saas/tenants/:id/hot-wallet` | POST | 创建热钱包 |
| `/api/v2/saas/stats` | GET | 平台统计 |
| `/api/v2/saas/audit` | GET | 审计日志 |
| `/api/v2/saas/users` | GET | 用户列表 |

**DC 数据** (dataQueryRoutes + dataSubscriptionRoutes)
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v2/data/events` | GET | 链上事件查询 |
| `/api/v2/data/stats` | GET | 数据统计 |
| `/api/v2/data/health` | GET | 健康检查 |
| `/api/v2/data/checkpoints` | GET | 区块检查点 |
| `/api/v2/data/plans` | GET | 订阅计划 |
| `/api/v2/data/subscribe` | POST | 订阅 DC |
| `/api/v2/data/usage` | GET | API 用量 |
| `/api/v2/data/key` | GET | DC API Key |
| `/api/v2/data/docs` | GET | API 文档 |
| `/api/v2/data/tokens` | GET | Token 列表 |
| `/api/v2/data/chains` | GET | 链列表 |
| `/api/v2/data/price` | GET | 实时价格 (Binance) |

**支付** (paymentRoutes)
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v2/payment/methods` | GET | 支付方式 |
| `/api/v2/payment/create` | POST | 创建订单 |
| `/api/v2/payment/status` | GET | 订单状态 |
| `/api/v2/payment/confirm` | POST | 确认支付 |
| `/api/v2/payment/history` | GET | 支付历史 |
| `/api/v2/payment/x402/info` | GET | x402 信息 |
| `/api/v2/payment/x402/pay` | POST | x402 支付 |
| `/api/v2/payment/webhook` | POST | 支付回调 |

**MPC** (mpcRoutes)
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v2/mpc/send-code` | POST | 发送验证码 |
| `/api/v2/mpc/register` | POST | 注册密钥分片 |
| `/api/v2/mpc/recover` | POST | 恢复分片 |
| `/api/v2/mpc/status` | GET | MPC 状态 |

**仪表板** (dashboardRoutes)
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v2/dashboard/summary` | GET | 资产总览 |
| `/api/v2/dashboard/daily-flow` | GET | 日交易流水 |
| `/api/v2/dashboard/active-users` | GET | 活跃用户 |
| `/api/v2/dashboard/batch-upload` | POST | 批量转账上传 |
| `/api/v2/dashboard/batch-execute` | POST | 批量执行 |

**内部** (internalRoutes) — CWallet 余额/交易回传 (10 端点)

**事件** (eventRoutes)
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v2/events/query` | POST | 事件查询 |
| `/api/v2/events/list` | GET | 事件列表 |
| `/api/v2/events/sync` | POST | 事件同步 |

**风控** (riskRoutes)
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v2/risk/rules` | GET | 风控规则列表 |
| `/api/v2/risk/rules` | POST | 更新风控规则 |

**订阅** (subscriptionRoutes)
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v2/subscription/plans` | GET | 套餐列表 |
| `/api/v2/subscription/current` | GET | 当前订阅 |
| `/api/v2/subscription/subscribe` | POST | 订阅套餐 |
| `/api/v2/subscription/cancel` | POST | 取消订阅 |

### Vault (`/api/vault/*`) :6002

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/vault/dashboard` | GET | 金库总览 |
| `/api/vault/safe/create` | POST | 部署 Safe 合约 |
| `/api/vault/safe/propose` | POST | 提案多签交易 |
| `/api/vault/safe/confirm` | POST | 签名确认 |
| `/api/vault/safe/execute` | POST | 执行交易 |
| `/api/vault/safe/list` | GET | 列出 Safe 钱包 |
| `/api/vault/safe/owned` | GET | 我的 Safe |
| `/api/vault/safe/participating` | GET | 我参与的 Safe |
| `/api/vault/safe/:address` | GET | Safe 详情 |
| `/api/vault/safe/:address/owners` | PUT | 更新签名者 |
| `/api/vault/safe/retry` | POST | 重试部署 |
| `/api/vault/safe/execute-ready` | POST | 执行全部就绪 |
| `/api/vault/safe/sync` | POST | 同步链上状态 |
| `/api/vault/safe/status` | GET | Safe 启用状态 |
| `/api/vault/risk/check` | POST | 风控检查 |

---

## MCP Tools (34 tools, 4 Server)

### Wallet MCP (`pocketx-wallet-mcp`)
wallet_balance, wallet_send, wallet_simulate, wallet_rpc, wallet_health, wallet_sweep, wallet_status, payment_create, payment_status, x402_pay (10 tools)

### Vault MCP (`infrax-ault-mcp`)
vault_dashboard, vault_safes, vault_safe_info, vault_create_safe, vault_update_owners, vault_create_tx, vault_confirm_tx, vault_execute_tx, vault_retry, vault_execute_ready, vault_sync, vault_status, vault_risk_check (12 tools)

### DC MCP (`infrax-c-mcp`) 🟢
dc_events, dc_stats, dc_checkpoints, dc_plans, dc_tokens, dc_chains, dc_price (7 tools)

### MPC MCP (`infrax-pc-mcp`)
mpc_send_code, mpc_register, mpc_recover, mpc_status, mpc_create_wallet (5 tools)

---

## JS SDK v0.2

npm/ts 包，8 classes ~60 methods，完整 TS 类型。

### class InfraX (主入口)
```ts
const px = new InfraX({ baseUrl: 'https://api.pocketx.io', apiKey: '...' })
px.wallet.balance({ address: '0x...' })
px.safe.create({ chainId: 1, owners: [...], threshold: 2 })
px.payment.x402Pay({ recipient: '0x...', amount: '0.01' })
```

### 子 API

| Class | 说明 | 主要方法 |
|-------|------|---------|
| `WalletAPI` | 钱包操作 | balance, send, simulate, rpc, sweep, txStatus, customTokens |
| `SafeAPI` | 多签 | propose, confirm, execute, create, list, owned, dashboard, riskCheck |
| `PaymentAPI` | 支付 | create, status, confirm, history, x402Pay, x402Info |
| `SaaSAPI` | 租户管理 | createTenant, listTenants, getTenant, updateTenant, deleteTenant, createApiKey, rotateApiKey |
| `SubAPI` | 订阅 | plans, current, subscribe, cancel |
| `DCAPI` | 数据中心 | events, stats, checkpoints, plans, tokens, chains, subscribe, usage |
| `VaultAPI` | 保险库 | dashboard, create, propose, confirm, execute, list, status |
| `MPCAPI` | MPC | sendCode, register, recover, status, createWallet |

---

## 当前服务状态

| 服务 | 端口 | DB | 状态 |
|------|------|-----|------|
| WAAS | 6001 | pocketx_waas | 🟢 |
| Vault | 6002 | pocketx_vault | 🟢 |
| DC | 3001 | pocketx_dc | 🟢 |
| Payment | 6004 | pocketx_payment | 🟢 |
| DC MCP | 3005 | — | 🟢 |
| Web Proxy | 6100 | — | 🟢 |
| Admin | 3002 | 跨 6 DB | 🔴 未启动 |
| MPC | 6003 | pocketx_mpc | 🔴 未启动 |
| Collector | 3000 | pocketx_collector | 🔴 暂停 |
| Wallet MCP | 3004 | — | 🔴 未启动 |
| Vault MCP | 3006 | — | 🔴 未启动 |
| MPC MCP | 3007 | — | 🔴 未启动 |

---

## 数据库

| 数据库 | 模块 | 核心表 |
|--------|------|--------|
| pocketx_waas | WAAS | tenants, users, transactions, custodial_wallets, address_pool, subscriptions, api_usage, chains, tokens, fee_configs |
| pocketx_vault | Vault | safe_wallets, safe_transactions, safe_signatures, risk_rules, mpc_wallets, hot_wallet_balances |
| pocketx_dc | DC | dc_subscriptions, event_checkpoints |
| pocketx_mpc | MPC | mpc_key_shares, mpc_registrations, mpc_wallets |
| pocketx_payment | Payment | payment_orders, payment_events, subscriptions, fee_configs |
| pocketx_admin | Admin | admin_users, admin_okx_accounts, admin_rpc_config |
| pocketx_collector | Collector | events(630 万), chains, tokens, api_keys |

---

## Git 工作流

```
refactor/xxx → 开发 → push → sync → merge main → tag vX.Y.Z-YYYYMMDD → deploy
```

- 🔴 不准直接在 main 上改
- 🔴 不准跳过 tag 部署
- 🔴 验收版本修改需谨慎确认

---

## 部署

详见 [DEPLOYMENT.md](./DEPLOYMENT.md)

```
Server: 101.33.109.117 (ubuntu)
端口范围: 6000-6999
源码: GitHub sftgroup/infraX (144 文件)
```
