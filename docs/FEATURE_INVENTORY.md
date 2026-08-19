# InfraX 平台功能清单（Feature Inventory）

> 版本：2026-08-20 ｜ 覆盖范围：前端门户 + 10 个后端服务 + 反向代理网关
> 生产入口：https://infrax.0xainet.top ｜ 更新依据：`projects/web`、各服务路由定义

## 0. 平台架构概览

- **前端**：`projects/web` 静态门户（零依赖 Node 反代 `server.js`，端口 6100）
  - 页面：`landing.html`（落地页）、`connect.html`（钱包连接登录）、`index.html`（主应用 8 模块）、`admin.html` + `admin-login.html`（管理控制台）
- **反向代理**（`server.js`，前缀转发 + 鉴权注入三级模式）
  - 默认注入 `X-Service-Key: SERVICE_API_KEY`（平台 bridge key）
  - `/ml` 特判注入 `Authorization: Bearer ML_API_KEY`
  - `/payments` 特判覆盖注入 `X-Service-Key: PAYMENTS_API_KEY`（独立 key）
- **统一鉴权契约**（`projects/shared/auth-express.ts`）：`Authorization: Bearer` / `X-API-Key` / `X-Service-Key` 任一匹配即通过，失败返回 401 `{"detail":"unauthorized"}`
- **安全头**：HSTS、CSP、X-Frame-Options 等（`server.js` 全响应注入）

### 后端服务与端口

| 服务 | 端口 | 说明 |
|---|---|---|
| admin | 9100 | 管理控制台 API（SaaS WaaS 运营） |
| collector | 9101 | 行情/事件采集（多链索引、MemPump、信号） |
| dc | 9102 | 数据中心（事件流订阅） |
| mpc | 9104 | MPC 钱包（TSS 签名） |
| vault | 9107 | Safe 多签钱包 |
| waas | 9109 | WaaS 钱包即服务（核心） |
| data | 9112 | K 线/因子/图谱/RAG 数据服务 |
| ml-service | 9120 | ML 模型推理 + 因子工厂 |
| aa-relay | 9131 | ERC-4337 UserOp 中继 + AA 会话 |
| payments | 9132 | 通用支付网关（invites/transfers/a2a/mpp） |

---

## 1. 认证与连接（connect.html）

| 功能 | 说明 |
|---|---|
| MetaMask 连接 | `personal_sign` 签名认证，`x-wallet-signature` 头提交 |
| 私钥连接 | ethers `signMessage('InfraX auth: <ts>')` 签名认证 |
| 会话持久化 | `localStorage['px_user']`，`logout()` 清空并跳转 connect |
| Admin 登录 | `admin-login.html` → `POST /api/v2/admin/login` |

## 2. 非托管钱包（Non-Custodial Wallet）

| 功能 | 说明 |
|---|---|
| 服务状态仪表盘 | 各服务（waas/dc/mpc 等）状态、计划、详情一览 |
| 收发/历史/复制地址 | 面板骨架（当前为占位） |

## 3. MPC 钱包（mpc-wallet.js / mpc :9104）

| 功能 | 说明 |
|---|---|
| 注册激活 | 邮箱验证码 → `POST /api/v2/mpc/send-code` + `register` |
| 找回恢复 | 验证码 → `POST /api/v2/mpc/recover` |
| 仪表盘 | 钱包状态/余额（`/status`、`/wallets`、`/balance`） |
| 发送/接收 | `send-transaction`、gas 预估、复制收款地址 |
| 会话锁 | `session/unlock`、`session/lock`、`session/status` |
| 签名能力 | `sign-message`、`sign-typed-data`、`sign-digest`、`sign` |
| 合约交互 | `contract-read`、`contract-write` |
| 订阅 | `plans`、`ledger-balance` |

## 4. WaaS 钱包即服务（waas.js / waas :9109）

| 功能 | 说明 |
|---|---|
| 订阅激活/升级 | 选择计划 → 订阅（X402 支付、支付轮询） |
| 概览/Token/地址 | `waas-dash-overview`、`waasTokens`（添加 token）、`waasAddresses`（创建/加载地址） |
| Sweep 归集 | 多目标/单地址/定时配置、手动触发、归集日志（`/api/v2/tx/sweep`） |
| 提现与规则 | 热钱包加载、提现规则持久化、失败重试（`withdrawRules`） |
| API Key | 生成/轮换/删除（`/api/v2/saas/apikeys`） |
| 支付密码 + TOTP | `set-payment-password`、`totp/setup|enable|disable` |
| 批量 | dashboard `batch-upload` / `batch-execute` |
| 风险 | 限额查询 `risk/limits`、黑名单 `risk/blacklist` |
| Webhooks | 事件流 `events/stream`、`events/token`、`webhook-events` 重试 |

### WaaS 后端路由明细

- `wallet`：create / import / balance / rpc / address / transactions / token-info / token-balance / nfts / custom-tokens(CRUD) / `:chainId`
- `tx`：send / estimate-gas / status / sweep / batch / batch/:id/progress / pending / `:id/confirm` / `:id/reject`
- `saas`：tenants(CRUD+activate) / address / withdraw / withdrawal 审批(approve/reject) / sweep / balances / transactions / apikeys(CRUD+rotate) / hot-wallet / tokens
- `subscription`：plans / me / subscribe / check / verify / payment-callback / cancel
- `data`：plans / subscribe / usage / key / docs
- `internal`：balance / transaction-status / estimate-gas / send-tx / rpc-config / sweep / config

## 5. Safe 多签钱包（safe.js / vault :9107）

| 功能 | 说明 |
|---|---|
| 创建 Safe | owners + threshold（chainId 11155111 默认） |
| 提案交易 | `POST /api/vault/safe/propose`（to/value/name） |
| 交易确认 | `personal_sign(safeTxHash)` → `confirm`；达 threshold 提示可执行 |
| 交易执行 | `POST /api/vault/safe/execute` |
| 我的/参与 | `owned`、`participating` 列表 |
| 交易明细弹窗 | `GET /api/vault/safe/:address` 详情 + confirm/execute 闭环 |
| 管理与运维 | status / owners 变更(PUT) / retry / execute-ready / sync |
| 风控 | `risk/rules`(GET/POST)、`risk/check` |
| 计费 | `plans`、`ledger-balance` |

## 6. 数据中心（datacenter.js / dc :9102 + collector）

| 功能 | 说明 |
|---|---|
| 订阅计划 | `GET /api/v2/data/plans`、`chains` |
| 订阅支付 | `subscribe` → `payment-check` 轮询 → `verify`（X402） |
| 用量查询 | `usage`、`balance` |
| 我的 API Key | 创建/轮换/删除（`/api/v2/data/my-keys`，钱包签名鉴权） |
| 事件查询 | `events`（分页 token）、`event-categories`、`event-stats`、`raw-receipt` |
| 文档 | `docs` |
| 状态 | `health`、`stats`、`checkpoints`、`tokens` |

## 7. AA 智能账户会话（aa.js / aa-relay :9131）

| 功能 | 说明 |
|---|---|
| 链切换 | OxaChain 等网络上下文切换 |
| 账户派生 | `POST /v1/account/derive`（counterfactual 只读派生） |
| 会话列表 | 会话、权限摘要、有效期 |
| 会话创建 | 权限预设（perms presets）→ draft → 签名提交 |
| 会话撤销 | 签名 draft UserOp（签名注入）→ revoke |
| 会话替换 | batch UserOp：uninstallModule + invalidateNonce + installModule |
| 计费 | `/v1/plans`、`/v1/ledger-balance` |

## 8. Insights 智能洞察（insights.js / data :9112 + ml :9120）

| 功能 | 说明 |
|---|---|
| 图谱 | `/factors/graph` 可视化（entities + edges，双语 name_en） |
| 因子 | `/factors/catalog`、`/factors/current` |
| 历史 | `/factors/history`（按因子/时间跨度） |
| RAG 检索 | `POST /rag/retrieve` |
| ML 预测 | `/ml/sentiment`、`/ml/volatility`、`/ml/consensus`、`/ml/tree_predictions` |
| K 线/行情 | `/bars`、`/ticker`、`/stats`、`/symbols`、`/symbol/search`、`/macro/history` |

## 9. Payments 支付网关（payments.js / payments :9132）

| 功能 | 说明 |
|---|---|
| Overview | capabilities、info（enabled/price/payTo/chain）、价格、链信息 |
| Invites | 创建邀请 → 支付(pay) → 结算(settle) → 取消(cancel)，列表/详情 |
| Transfers | 创建转账 → 确认(confirm) → 取消(cancel)，列表/详情 |
| A2A | 账户对账户转账（create / settle） |
| 订阅/批量/周期 | checkout/verify、orders、access、balance；mpp(open/voucher/topup/settle/close/session)；period charge/authorization；batch(create/settle/cancel) |

## 10. Admin 管理控制台（admin.html / admin :9100）

| 功能 | 说明 |
|---|---|
| Dashboard | KPI：租户数、交易、钱包地址、收入、风控概览 |
| Tenants | 租户列表/详情/编辑（PATCH） |
| Transactions | 交易列表、状态修改 |
| Risk Center | 风控规则、代币黑名单 |
| Revenue / Orders | 收入、订单 |
| DC Subscriptions | 数据中心订阅状态 |
| API Usage | 各 key 用量 |
| Plans | 计划 CRUD |
| Webhook Events | 事件列表与重试 |
| Sweep Queue | 归集队列 |
| Settings / Audit Logs | 配置、审计日志 |
| 跨模块统计 | `waas/stats`、`dc/stats`、`vault/stats`、`mpc/stats`、`okx/accounts` |

## 11. 行情与事件采集（collector :9101）

| 功能 | 说明 |
|---|---|
| 行情 | price / candles / trades / token-info / hot-tokens / top-liquidity / balances / transactions / 指数 / 组合分析 |
| MemPump | chains / list / details / devinfo / similar / bundle / apedwallets |
| 信号/榜单 | signals / signal-chains / leaderboard / cluster |
| 订阅 | `/api/v2/market/plans`、checkout、payment-check/callback、verify、usage |
| 管理 | RPC 端点 CRUD、OKX/Binance 健康、事件导出、tracked-tokens、custom-sigs、users、audit、system |
| 市场 RPC / Relay | `POST /v1/market-rpc/`、`POST /api/v1/relay` |

## 12. 平台服务与工具

| 功能 | 说明 |
|---|---|
| 因子工厂 | `/factor-factory/start|mine|status|result|list|cancel`（自动因子挖掘） |
| 图谱数据面 | `/factors/graph`、`/graph/entities|edges|history` |
| ML 模型 | moirai / timesfm / bolt / sentiment / volatility / consensus |
| 知识注入 | ragservicer（RAG 服务） |
| SDK 家族 | aa-sdk、waas-sdk、vault-sdk、mpc-sdk、dc-sdk、data-sdk、chain-rpc-sdk、market-sdk、session-key、payments-sdk、sdk |
| MCP Server | 平台 MCP 能力接入 |

---

## 近期上线的关键改进（回归关注点）

| 领域 | 改进 |
|---|---|
| 资金安全 | 原子入金、确认阈值、广播重试、gas pool 熔断 |
| 风控精度 | USD 计价限额、日限额一致计算 |
| 系统健壮 | 幂等 key、分布式任务锁、dry-run 模式 |
| Safe 审批闭环 | 明细弹窗 + personal_sign 确认 + 达阈值自动可执行 |
| Payments UI | 网关面板（invites/transfers/a2a） |
| AA 会话 | 撤销/替换（uninstall+invalidateNonce+install）、签名注入、私钥持久化 |
| Admin 契约 | 死链修复、租户 View All、地址 KPI 数据源修正 |
