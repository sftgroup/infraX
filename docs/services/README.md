# InfraX 微服务使用指南（docs/services/）

> 最后更新：2026-08-11 | 适用版本 `v0.7.0-20260811` | 生产：43.163.105.172（新加坡，单机）
>
> 13 个对外微服务**已逐一生产实测**（2026-08-11），全部可用。每篇文档含：服务定位、鉴权方式、完整端点清单、curl + JS SDK + Python SDK 样例代码、常见错误码。

## 服务清单与文档索引

| 服务 | 端口 | 公网访问 | 鉴权 | 文档 |
|---|---|---|---|---|
| Admin 管理后台 | 9100 | 经 web 代理 `/api/v2/admin` | 用户名密码登录 → token | [admin.md](./admin.md) |
| Collector / Market 行情 | 9101 | 经 web 代理 `/api/v2/data/market`、`/api/v2/market` | X-API-Key（pkx_）+ 按量计费（超限 503） | [market.md](./market.md) |
| DC 链上数据中心 | 9102 | 经 web 代理 `/api/v2/data` | 数据面 x-dc-api-key；订阅面 x-wallet-address（超限 429） | [dc.md](./dc.md) |
| MPC 多方计算钱包 | 9104 | 经 web 代理 `/api/v2/mpc` | 统一 key（MPC_API_KEY / mp_ key）；plans 公开（欠费 402） | [mpc.md](./mpc.md) |
| Vault Safe 多签 | 9107 | 经 web 代理 `/api/vault` | 统一 key（VAULT_API_KEY / vx_ key） | [vault.md](./vault.md) |
| WAAS 钱包即服务 | 9109 | 经 web 代理 `/api/v2/wallet`、`/api/v2/saas`、`/api/v2/subscription` | 钱包签名 / tenant key；plans 公开 | [waas.md](./waas.md) |
| Web 代理层 | 9111 | **公网入口**（nginx 80/443 → 9111） | 代理自动注入 X-Service-Key | [web.md](./web.md) |
| Data 数据中心 | 9112 | 经 nginx `/api/data/*` | 统一 key（DATA_API_KEY / dx_ key）；/health /docs 公开 | [data.md](./data.md) |
| Knowledge Injector | 9113 | 仅内网 | INJECTOR_API_KEY | [knowledge-injector.md](./knowledge-injector.md) |
| Chain RPC 网关 | 9130 | **仅内网**（外部 key 直连） | 读/广播 key / rx_ 订阅 key（超限 503） | [chain-rpc.md](./chain-rpc.md) |
| Payments 通用支付引擎 | 9132 | **仅内网**（业务服务经 key 调用） | 统一 key（PAYMENTS_API_KEY / px_ key） | [payments.md](./payments.md) |
| RAGservicer 知识库 | 9721 | 经 nginx `/api/rag/*` | 租户 key（RAGSERVICER_API_KEY / lightrag-client） | [ragservicer.md](./ragservicer.md) |
| Session Key 会话授权 | 3500 | 经 web 代理（SDK 直连） | API_TOKENS 白名单；nonce/sessions 创建公开 | [session-key.md](./session-key.md) |

> **ml-service（:9120，模型推理）**：独立服务器 `43.156.25.197`，不在本机；JS SDK `infra.ml.*` 已覆盖（treePredictions/volatility/bolt/moirai/timesfm/consensus/macroFeatures/sentiment）。

## 通用接入说明

### 1. 访问路径

- **内网直连**：`http://127.0.0.1:<端口>/...`（仅服务器本机）
- **公网经 web 代理**（:9111）：`http://<host>:9111/api/v2/...` → 转发到各 91xx 服务（路由表见 [web.md](./web.md)）
- **公网经 nginx**（80/443，域名 `infrax.0xainet.top`）：`/api/v2/*` → web 代理；`/api/data/*` → data；`/api/rag/*` → ragservicer

### 2. 鉴权契约（全站统一）

`Authorization: Bearer <key>` / `X-API-Key: <key>` / `X-Service-Key: <key>` 三选一（JS SDK 主类 `InfraX` 自动携带）。

- **业务服务 key**：payments/vault/mpc 用系统 key（PAYMENTS_API_KEY / VAULT_API_KEY / MPC_API_KEY）；dc 用 `x-dc-api-key`（tenants 表签发）；market 用 `X-API-Key`（api_keys 表签发 pkx_ key）；chain-rpc 用 X-Service-Key（读/广播 key）或 `rx_` 订阅 key
- **多租户签发**：data 服务 `/admin/api-keys`（Bearer ADMIN_API_KEY）签发 `dx_/mx_/px_/vx_/mp_` 前缀租户 key，可同时对接 data/payments/vault/mpc/chain-rpc
- **公开端点**：`/health`、各套餐目录 `/plans`、`/openapi.json`、`/docs`、支付回调（HMAC 验签）

### 3. 套餐计费（MQ-16，统一走 Payments 引擎 :9132）

| 服务 | 套餐面 | 超限/欠费表现 |
|---|---|---|
| DC :9102 | `/api/v2/data/plans` + subscribe（x-wallet-address） | 超限 **429**（code 4290） |
| Market :9101 | `/api/v2/market/plans` + checkout | 超限 **503** |
| Chain RPC :9130 | `/v1/subscription/plans` + checkout（rx_ key） | 超限 **503** |
| MPC :9104 | `/api/v2/mpc/plans`（pay-per-use 预付费） | 欠费 **402**（body code 1001） |

## 已知注意事项（2026-08-11 审查发现）

1. **web 代理已修复**：`/api/v2/data/market/*`（collector 行情数据面）此前会被 `/api/v2/data` 前缀吞掉（转发到 DC → 404），已调整 API_ROUTES 顺序修复（server.js）
2. **admin 双实例已收敛**：生产曾同时存在 `infrax-admin.service`（:3002，冗余）与 `infrax-admin-legacy.service`（:9100），unit 与进程 `ADMIN_PASS` 不一致源于两个服务各自配置；已停用冗余 :3002，唯一 admin=:9100（unit 与进程密码一致 a87c…）
3. **admin dashboard 聚合已优化**：collector.events 大表（8790 万行）的 `COUNT(*)` 已改为 `pg_class.reltuples` 估算，聚合接口 20s+ → <1s；`api-usage` 误查 waas 库（实为 pocketx_dc）已修复，返回真实数据
4. **payments/chain-rpc 仅内网**：公网不可直达，外部集成方经 SDK 命名空间（infra.payment / infra.chainRpc，配置 paymentsUrl/chainRpcUrl）或业务服务转发调用

## JS SDK（@0xinfrax/infrax-dk v0.6.0）命名空间对照

| 命名空间 | 对接服务 | 文档 |
|---|---|---|
| `infra.payment.*`（25 方法） | Payments :9132 | [payments.md](./payments.md) |
| `infra.chainRpc.*`（10 方法） | Chain RPC :9130 | [chain-rpc.md](./chain-rpc.md) |
| `infra.dc.*`（10 方法） | DC :9102 | [dc.md](./dc.md) |
| `infra.market.*`（21 方法） | Market :9101 | [market.md](./market.md) |
| `infra.mpc.*`（17 方法） | MPC :9104 | [mpc.md](./mpc.md) |
| `infra.wallet.*` / `infra.saas.*` / `infra.sub.*` | WAAS :9109 | [waas.md](./waas.md) |
| `infra.safe.*` / `infra.vault.*` | Vault :9107 | [vault.md](./vault.md) |
| `infra.data.*` | Data :9112 | [data.md](./data.md) |
| `@0xinfrax/session-key-client` 等**独立 4 包** | Session Key :3500（**不在 infrax-dk**，见下） | [session-key.md](./session-key.md) |

> **Session Key 接入说明**：`@0xinfrax/infrax-dk` v0.6.0 **不含** Session Key 能力（其类型中 `Session` 仅指支付会话 sessionUrl/sessionId 与 MPC 会话解锁，`gasSponsored` 为托管钱包代付标记，无 UserOp/Bundler/ERC-4337 封装）。Session Key 服务（:3500）提供**独立 SDK**：`@0xinfrax/session-key-client`（REST 客户端）+ `-core`（类型）+ `-evm`（EIP-712 签名工具），均已发布 npm；集成方请直接安装独立包，勿在 infrax-dk 中寻找 session 命名空间。

Python SDK（PyPI 已发布 2026-08-11）：`lightrag-client` 2.0.0（ragservicer）、`infra-data-client` 0.2.0（data）。
