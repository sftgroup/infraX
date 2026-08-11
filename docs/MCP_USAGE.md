# InfraX MCP 使用文档（MCP Usage Guide）

> 面向 AI Agent / MCP 客户端的接入指南。覆盖 **8 个 HTTP MCP 服务**：hub-index（统一入口，:3008）、vault-mcp（:9108）、mpc-mcp（:9105）、session-key-mcp（:3011）、dc-mcp（:9103）、wallet-mcp（:9110）、chain-rpc-mcp（:3012）、market-mcp（:3013）+ LightRAG STDIO MCP（5 工具）。
> 数据来源：生产代码盘点 + 生产实测（2026-08-06 / 2026-08-08 / 2026-08-11，`43.163.105.172`）。

---

## 1. 总览

| MCP 服务 | 端口 | 传输 | systemd 单元 | 工具数 | 后端 |
|---|---|---|---|---|---|
| **hub-index（统一入口）** | 3008 | Streamable HTTP | `infrax-hub-index` | 13 | data :9112 / injector :9113 / ragservicer :9721 |
| vault-mcp | 9108 | JSON-RPC over HTTP | `infrax-vault-mcp` | 13 | vault :9107 |
| mpc-mcp | 9105 | JSON-RPC over HTTP | `infrax-mpc-mcp` | **17** | mpc :9104 |
| session-key-mcp | 3011 | Streamable HTTP | `infrax-session-key-mcp` | 7 | session-key :3500 |
| dc-mcp | 9103 | Streamable HTTP | `infrax-dc-mcp` | **11** | dc :9102 |
| wallet-mcp | 9110 | SSE + JSON-RPC over HTTP | `infrax-wallet-mcp` | **34** | waas :9109 + payments :9132 |
| **chain-rpc-mcp** | 3012 | SSE + JSON-RPC over HTTP | `infrax-rpc-mcp` | **10** | chain-rpc :9130 |
| **market-mcp** | 3013 | Streamable HTTP | `infrax-market-mcp` | **18** | collector :9101 |
| LightRAG STDIO | — | stdio | — | 5 | ragservicer :9721 |

> **MQ-16（2026-08-11）**：dc-mcp +4（订阅）、market-mcp +5（订阅）、rpc-mcp +6（订阅）、mpc-mcp +2（计费）、wallet-mcp +15（payments batch/invite/transfer），共 **+32 个套餐工具**；market-mcp 新增独立 unit `infrax-market-mcp.service`（:3013，此前代码存在未部署）。

**对外暴露**：hub-index 经 nginx 以 `/mcp/*` 对外；其余 HTTP MCP 端口监听 `0.0.0.0` 且未经 nginx 代理（受信方直连）。

---

## 2. 统一接入方式

### 2.1 客户端连接

**Streamable HTTP（hub / session-key / dc）**——POST `/mcp/message`：

```bash
# initialize
curl -s -X POST http://<host>:3008/mcp/message \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <MCP_KEY>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'

# 列工具
curl -s -X POST http://<host>:3008/mcp/message \
  -H 'Content-Type: application/json' -H 'X-API-Key: <MCP_KEY>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 调工具
curl -s -X POST http://<host>:3008/mcp/message \
  -H 'Content-Type: application/json' -H 'X-API-Key: <MCP_KEY>' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"data_ticker","arguments":{"symbol":"BTC/USDT"}}}'
```

**JSON-RPC（vault / mpc / wallet-mcp）**——同样 POST `/mcp/message`，协议与上一致。

**SSE（wallet-mcp 可选）**：`GET /mcp/sse` 建立事件流，`data: endpoint` 返回 `/mcp/message?sessionId=<sid>`。

### 2.2 入站鉴权（MCP 层）

| MCP 服务 | 入站鉴权 | 说明 |
|---|---|---|
| **hub-index** | ✅ | `MCP_API_KEY` 白名单（逗号分隔，常量时间比较）或 data 签发 `mx_` 前缀 key（`scope=mcp`）经 `/api-keys/verify` 实时校验；请求头三选一 `Authorization: Bearer` / `X-API-Key` / `X-Service-Key`；豁免 `/health` `/` |
| wallet-mcp / vault-mcp / chain-rpc-mcp / mpc-mcp / session-key-mcp / dc-mcp | ✅（挂 `inboundAuth`） | 复用 `mcp-auth.ts` 同一入站中间件：`MCP_API_KEY` 白名单或 data `mx_` key 实时校验；三 header 三选一；豁免 `/health` `/`。⚠️ **注意**：生产须注入 `MCP_API_KEY`（或 `DATA_URL`+`DATA_API_KEY`），否则白名单为空 → 全部请求 401（fail-closed 误锁，2026-08-08 wallet-mcp 曾遇） |

### 2.3 出站鉴权（MCP → 后端）

各 MCP 调用后端服务时携带对应 bridge key：

| MCP | 出站 key | 目标 |
|---|---|---|
| hub-index | `DATA_API_KEY` / `INJECTOR_API_KEY` / `RAG_API_KEY`（X-API-Key） | data / injector / ragservicer |
| vault-mcp | `VAULT_API_KEY` | vault :9107 |
| mpc-mcp | `MPC_API_KEY` | mpc :9104 |
| session-key-mcp | `SESSION_KEY_API_KEY` | session-key :3500 |
| dc-mcp | `DC_API_KEY`（x-dc-api-key header） | dc :9102 |
| wallet-mcp | `WAAS_API_KEY`（x-api-key header） | waas :9109 |

---

## 3. hub-index — 统一入口（:3008，13 工具）

聚合数据栈三大服务（data/injector/rag）于一个 MCP 端点，**推荐外部 AI Agent 首选接入**。

### 3.1 DATA 行情/因子/ML（data :9112）

| 工具 | 参数 | 说明 |
|---|---|---|
| `data_bars` | symbol*, timeframe, start, end, limit | OHLCV K 线（7 timeframe，含技术指标+外部因子） |
| `data_ticker` | symbol* | 实时报价（crypto/美股/外汇/期货/A股/港股） |
| `data_factors` | symbol*, factor | 最新因子值（技术/宏观/链上） |
| `data_factors_history` | symbol*, factor*, start, end, limit | 逐 bar 因子时序 |
| `data_snapshots` | type, date, limit | 复杂快照（macro/onchain/defi/indices） |
| `data_symbols` | query, market, limit | 达标符号清单 / 搜索 |
| `data_symbol_search` | keyword*, market, limit | 符号模糊搜索（6 市场） |
| `data_symbol_resolve` | symbol*, market | 符号解析（BTC→BTCUSDT） |
| `data_broker_policy` | — | 券商市场策略 |
| `data_stats` | — | 库统计 |
| `ml_predictions` | symbol* | P2 模型预测（bolt/moirai/timesfm，data 侧采集快照；返回 `{generated_at, direction, prob_up, point_forecast, quantiles}`） |

> **ML 数据链路（2026-08 起）**：ml-service（:9120）实时推理 → data 采集器 30min 周期拉取落库 → hub-index `ml_predictions` / `/api/data/ml/predictions` 查询快照。ml-service 直连端点已**异步化 + 缓存预热**（缓存 miss 时立即返回 `data=null`，后台计算，预热线程保证缓存常满），生产场景优先走 data 快照；ml-service 直连端点的完整端点清单/响应结构见 `docs/SERVICE_API_REFERENCE.md §3`。

### 3.2 图谱（injector :9113 / ragservicer :9721）

| 工具 | 参数 | 说明 |
|---|---|---|
| `injector_trigger` | source* | 触发数据源注入图谱（写操作，后台任务） |
| `rag_query` | namespace*, query*, mode | 图谱混合检索（mix/local/global/hybrid/naive） |

### 3.3 示例

```bash
curl -s -X POST http://43.163.105.172/mcp/message \
  -H 'Content-Type: application/json' -H 'X-API-Key: <mx_...>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"rag_query","arguments":{"namespace":"market","query":"BTC 近三个月资金面变化","mode":"mix"}}}'
```

---

## 4. vault-mcp（:9108，13 工具）

Safe 多签保险库：创建/提案/确认/执行链上闭环 + owner 管理 + 风控。

| 工具 | 参数 | 说明 |
|---|---|---|
| `vault_dashboard` | — | 保险库总览（safe/tx/待签/规则数） |
| `vault_safes` | userId | Safe 列表 |
| `vault_safe_info` | address | Safe 详情（owners/threshold/余额/交易） |
| `vault_create_safe` | chainId*, owners*, threshold*, name | 创建 Safe |
| `vault_update_owners` | address*, owners*, threshold*, signature | 更新 owner（B-5 链上多签） |
| `vault_create_tx` | safeAddress*, to*, value, data | 提议交易 |
| `vault_confirm_tx` | safeAddress*, safeTxHash*, signature* | 签名确认 |
| `vault_execute_tx` | safeTxHash* | 执行交易 |
| `vault_retry` | chainId | 重试失败 Safe |
| `vault_execute_ready` | safeAddress | 批量执行已达阈值交易 |
| `vault_sync` | safeAddress* | 链上同步 |
| `vault_status` | walletAddress | Safe 启用状态 |
| `vault_risk_check` | amount*, chain* | 风控预检 |

---

## 5. mpc-mcp（:9105，17 工具）

邮箱验证码 MPC 钱包：注册/恢复 + 会话解锁 + 签名/交易/合约 + **MQ-16 按量计费（T-4）**。

| 工具 | 参数 | 说明 |
|---|---|---|
| `mpc_send_code` | email* | 发送 6 位验证码 |
| `mpc_register` | email*, code*, walletAddress | 注册钱包 |
| `mpc_recover` | email*, code* | 找回钱包 |
| `mpc_status` | email / walletAddress | 钱包状态 |
| `mpc_create_wallet` | email*, code* | 显式建钱包 |
| `mpc_session_unlock` | email*, code* | 会话解锁（获取签名能力） |
| `mpc_session_lock` | token* | 会话锁定 |
| `mpc_session_status` | token | 会话状态 |
| `mpc_balance` | address*, chain | 余额查询 |
| `mpc_sign_message` | token*, message* | 任意消息签名 |
| `mpc_sign_typed_data` | token*, typedData* | EIP-712 签名 |
| `mpc_send_transaction` | token*, to*, value*, chain | 发送交易 |
| `mpc_contract_read` | contract*, method*, args, chain | 合约读 |
| `mpc_contract_write` | token*, contract*, method*, args, chain | 合约写 |
| `mpc_gas_estimate` | from*, to*, amount, chain | gas 预估 |
| `mpc_plans` | — | **MQ-16**：套餐价目（公开，pay-per-use 费率表 + 平台钱包）→ `GET /api/v2/mpc/plans` |
| `mpc_ledger_balance` | token* | **MQ-16**：引擎账本余额（address/balanceWei/fees/topupHint）→ `POST /api/v2/mpc/ledger-balance` |

---

## 6. session-key-mcp（:3011，7 工具）

EIP-712 会话密钥：授权签名 → 托管 → 白名单额度内代执行。

| 工具 | 参数 | 说明 |
|---|---|---|
| `sk_nonce` | — | 一次性 nonce（EIP-712 签名用，30min） |
| `sk_create_session` | walletAddress*, signedEip712*, ... | 创建会话密钥（用户授权签名） |
| `sk_list_sessions` | walletAddress* | 会话列表 |
| `sk_get_session` | sessionId* | 会话详情 |
| `sk_revoke_session` | sessionId* | 立即撤销 |
| `sk_execute` | sessionId*, to*, data*, value, chainId | 白名单额度内代执行交易 |
| `sk_status` | — | 引擎健康 |

---

## 7. dc-mcp（:9103，11 工具）

链上数据中心：事件/统计/检查点/套餐/代币/链/价格 + **MQ-16 订阅面（T-1，x-wallet-address 鉴权）**。

| 工具 | 参数 | 说明 |
|---|---|---|
| `dc_events` | chain, address, event_type, from_block, to_block, limit | 链上事件查询 |
| `dc_stats` | — | 数据中心统计 |
| `dc_checkpoints` | chain | 区块索引检查点 |
| `dc_plans` | — | 订阅套餐 |
| `dc_tokens` | chain | 支持代币列表 ⚠️ **已知必失败**（端点调 dc `/api/v2/data/tokens` 不存在，B-10-3） |
| `dc_chains` | — | 支持链列表 |
| `dc_price` | symbol* | 实时价格（Binance 公共 API，USDT 对） |
| `dc_subscription_subscribe` | planId*, rail, walletAddress* | **MQ-16**：订阅数据套餐（免费直接激活返回 dcApiKey，付费返回 pending）→ `POST /api/v2/data/subscribe` |
| `dc_subscription_payment_check` | walletAddress* | **MQ-16**：轮询支付状态 → `POST /api/v2/data/payment-check` |
| `dc_subscription_verify` | txHash*, walletAddress* | **MQ-16**：x402 确认（payer 匹配钱包后激活）→ `POST /api/v2/data/verify` |
| `dc_subscription_usage` | walletAddress* | **MQ-16**：订阅用量（plan/dcApiKey/quota/日聚合）→ `GET /api/v2/data/usage` |

> ⚠️ 4 个订阅工具走 `x-wallet-address` 鉴权（非 dc_api_key），钱包地址由调用方显式传入。

---

## 8. wallet-mcp（:9110，34 工具）

WAAS 代理（钱包 7 个：余额/发送/模拟/RPC/健康/归集/状态）+ 通用支付引擎 :9132 通道（27 个：支付意图/fiat checkout/x402 验付/价格/账本/访问控制 + MPP 状态通道 + **MQ-16 batch/invite/transfer**）。

| 工具 | 参数 | 说明 |
|---|---|---|
| `wallet_balance` | address*, chain | 链上代币余额 |
| `wallet_send` | to*, amount*, chain | 从 gas 池发送（单笔上限 0.05 ETH） |
| `wallet_simulate` | from*, to*, amount*, chain | gas 预估模拟 |
| `wallet_rpc` | — | 各链 RPC 端点 |
| `wallet_health` | — | WAAS 后端健康 |
| `wallet_sweep` | chain | 托管资金归集（admin） |
| `wallet_status` | txHash*, chain | 交易上链状态 |
| `payment_info` | — | 通道发现：价格/pay-to 钱包/网络/rails 启用状态 → `GET /payments/info` |
| `payment_create` | subscriber*, planId, amountCents, period, currency, chain, metadata, clientReference | 创建支付意图（fiat → Stripe Checkout 会话）→ `POST /payments/checkout` |
| `payment_verify` | txHash*, chain | x402/stablecoin 链上验付 + 幂等入账 → `POST /payments/verify` |
| `payment_price` | planId*, chain | 链上套餐价格 → `GET /payments/price` |
| `payment_balance` | address*, asset | 模块账本余额 → `GET /payments/balance` |
| `payment_access` | subscriber*, resource*, chain | 订阅访问控制检查 → `POST /payments/access` |
| `payment_batch_create` | items*, chain, clientReference | **MQ-16**：创建批量收款意图 → `POST /payments/batch` |
| `payment_batch_settle` | batchId*, itemId*, txHash*, chain | **MQ-16**：结算 batch 中单笔（x402 验收入账）→ `POST /payments/batch/settle` |
| `payment_batch_get` | batchId* | **MQ-16**：查询 batch 状态 → `GET /payments/batch` |
| `payment_batch_cancel` | batchId* | **MQ-16**：取消 batch（未支付 items）→ `POST /payments/batch/cancel` |
| `payment_invite_create` | payer*, payee*, amountWei*, rail, chain, clientReference | **MQ-16**：创建账单邀请 → `POST /payments/invites` |
| `payment_invite_list` | address*, role*, status | **MQ-16**：列出邀请 → `GET /payments/invites` |
| `payment_invite_get` | inviteId* | **MQ-16**：邀请详情 → `GET /payments/invites/:id` |
| `payment_invite_cancel` | inviteId* | **MQ-16**：取消未结算邀请 → `POST /payments/invites/:id/cancel` |
| `payment_invite_settle` | inviteId*, txHash*, chain | **MQ-16**：链上结算邀请 → `POST /payments/invites/:id/settle` |
| `payment_invite_pay` | inviteId* | **MQ-16**：账本支付（payer ledger 扣款）→ `POST /payments/invites/:id/pay` |
| `payment_transfer_create` | from*, to*, amountWei*, asset | **MQ-16**：发起账本转账 → `POST /payments/transfers` |
| `payment_transfer_list` | address*, role* | **MQ-16**：列出转账 → `GET /payments/transfers` |
| `payment_transfer_get` | transferId* | **MQ-16**：转账详情 → `GET /payments/transfers/:id` |
| `payment_transfer_confirm` | transferId* | **MQ-16**：确认并执行（原子入账）→ `POST /payments/transfers/:id/confirm` |
| `payment_transfer_cancel` | transferId* | **MQ-16**：取消未执行转账 → `POST /payments/transfers/:id/cancel` |
| `mpp_open` | payer*, depositWei*, salt*, txHash*, chain | 打开 MPP 状态通道（验存款 tx + 建会话）→ `POST /payments/mpp/open` |
| `mpp_voucher` | channelId*, cumulativeAmount*, signature* | 提交 EIP-712 累计 voucher 消费通道余额 → `POST /payments/mpp/voucher` |
| `mpp_topup` | channelId*, txHash*, additionalWei* | 通道追加充值 → `POST /payments/mpp/topup` |
| `mpp_settle` | channelId* | 通道未结算消费批量扣减 → `POST /payments/mpp/settle` |
| `mpp_close` | channelId* | 关闭通道（先结算尾部，冻结会话）→ `POST /payments/mpp/close` |
| `mpp_session` | channelId* | 通道当前状态（status/cumulative/spent/deposit）→ `GET /payments/mpp/session` |

> 支付/通道 26 个工具统一转发通用支付引擎 :9132（`PAYMENTS_URL`+`PAYMENTS_API_KEY` 已生产注入；MQ-16 batch/invite/transfer 15 个工具 2026-08-11 新增）。x402_pay/payment_status 旧工具已移除。

---

## 8.5 chain-rpc-mcp（:3012，10 工具）

chain-rpc 网关（:9130）的 MCP 封装：通用链上读 + 已签名交易广播 + **MQ-16 订阅面（T-3）**，供 AI Agent 直接查询链上状态 / 提交交易 / 管理套餐。

| 工具 | 参数 | 说明 |
|---|---|---|
| `chain_rpc_read` | chain, method*, params | 通用链上读调用（JSON-RPC 读白名单：eth_blockNumber/eth_getBalance/eth_call/eth_getLogs/eth_estimateGas/eth_chainId/eth_feeHistory；Solana getSlot/getBalance/getHealth；经网关 `POST /v1/rpc/:chain`，读 key） |
| `chain_rpc_broadcast` | chain, rawTransaction*, wait | 广播已签名交易（EVM `eth_sendRawTransaction` / Solana `sendTransaction`；经网关 `POST /v1/broadcast/:chain`，**广播 key**；wait=true 附回执） |
| `chain_rpc_status` | — | 网关池状态（各链健康 / 活跃端点数，URL 脱敏） |
| `chain_rpc_health` | — | 网关健康（无需 key） |
| `chain_rpc_subscription_plans` | — | **MQ-16**：套餐目录（公开）→ `GET /v1/subscription/plans` |
| `chain_rpc_subscription_issue_key` | label | **MQ-16**：签发 `rx_` 读 key（管理操作，X-Service-Key）→ `POST /v1/subscription/issue-key` |
| `chain_rpc_subscription_checkout` | plan_id*, rail, subscriber | **MQ-16**：发起订阅支付（rx_ key 鉴权）→ `POST /v1/subscription/checkout` |
| `chain_rpc_subscription_payment_check` | subscriber | **MQ-16**：轮询支付状态 → `POST /v1/subscription/payment-check` |
| `chain_rpc_subscription_verify` | txHash* | **MQ-16**：x402 确认激活 → `POST /v1/subscription/verify` |
| `chain_rpc_subscription_usage` | — | **MQ-16**：订阅用量 → `GET /v1/subscription/usage` |

> **分级 key（MQ-10 补充 B）**：读工具走 `CHAIN_RPC_READ_KEY`，广播工具走 `CHAIN_RPC_BROADCAST_KEY`（服务端签发、读端点拒绝）；订阅工具 issue-key 走 `X-Service-Key`（bridge key），其余走 `rx_` key（X-RPC-Key）。服务端未配置广播 key 时 `chain_rpc_broadcast` 返回明确错误（fail-closed）。

**示例**（入站需 `X-Service-Key: <MCP_KEY>`，与 hub-index 同套 `MCP_API_KEY` 白名单）：

```bash
curl -s -X POST http://localhost:3012/mcp/message \
  -H 'Content-Type: application/json' -H 'X-Service-Key: <MCP_KEY>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"chain_rpc_read","arguments":{"chain":"sepolia","method":"eth_blockNumber","params":[]}}}'
```

---

## 8.6 market-mcp（:3013，18 工具）

行情/分析数据 + **MQ-16 订阅面（T-2）**：数据面经 collector :9101 `/api/v2/data/market/*`（OKX ChainOS v6），订阅面经 `/api/v2/market/*`。X-API-Key 识别 keyId。生产独立 unit `infrax-market-mcp.service`（2026-08-11 新增部署，此前代码存在未运行）。**入站鉴权：2026-08-12 已挂 `inboundAuth`**（与其他 7 个 HTTP MCP 一致）。

| 工具 | 参数 | 说明 |
|---|---|---|
| `market_search` | keyword*, chainIndex, limit | 代币搜索 |
| `market_hot` | chainIndex*, limit, rankingType, rankingTimeFrame, rankBy, riskFilter, protocolId | 热门代币（30+ 过滤参数） |
| `market_candles` | chainIndex*, tokenAddress*, period, limit | K 线（OHLCV） |
| `market_price` | chainIndex*, tokenAddress* | 实时 DEX 价格 |
| `market_balances` | address*, chains | 钱包余额（免费） |
| `market_transactions` | address*, chains, limit | 交易历史（免费） |
| `market_mempump` | chainIndex*, protocol, sortBy, limit | Meme 币列表（honeypot/bundle 检测） |
| `market_mempump_detail` | chainIndex*, tokenAddress* | Meme 币详情 |
| `market_signals` | chainIndex*, signalType, limit | 聪明钱/鲸鱼信号 |
| `market_leaderboard` | chainIndex*, leaderboardType, limit | 交易者排行 |
| `track_token` | chain*, tokenAddress*, label | 加入监控列表 |
| `list_tracked` | chain | 监控列表 |
| `register_event` | chain*, topicHash*, eventType*, eventName, abi | 注册自定义事件签名 |
| `market_subscription_plans` | — | **MQ-16**：套餐目录（公开）→ `GET /api/v2/market/plans` |
| `market_subscription_checkout` | plan_id*, rail, subscriber | **MQ-16**：发起订阅（免费直接激活；付费返回 pending）→ `POST /api/v2/market/checkout` |
| `market_subscription_payment_check` | subscriber | **MQ-16**：轮询支付状态 → `POST /api/v2/market/payment-check` |
| `market_subscription_verify` | txHash* | **MQ-16**：x402 确认激活 → `POST /api/v2/market/verify` |
| `market_subscription_usage` | — | **MQ-16**：订阅用量 → `GET /api/v2/market/usage` |

---

## 9. LightRAG STDIO MCP（5 工具）

ragservicer 自带 STDIO MCP（`projects/ragservicer/mcp_server/`），经 AI 框架本地拉起，直连 ragservicer :9721。

| 工具 | 说明 |
|---|---|
| `insert` | 注入文档到 namespace（异步任务） |
| `query` | 图谱混合检索（entities + relations + chunks） |
| `delete` | 按 doc_id 删除文档 |
| `list_instances` | 图谱实例列表 |
| `retrieve` | 纯检索上下文（top_k） |

**mcp-config 示例**：

```json
{
  "mcpServers": {
    "infrax-rag": {
      "command": "python",
      "args": ["-m", "mcp_server.server"],
      "env": {
        "RAG_API_URL": "http://localhost:9721",
        "RAG_API_KEY": "<lr_...>"
      }
    }
  }
}
```

---

## 10. 鉴权与已知缺口

### 10.1 鉴权总表

| MCP | 入站鉴权 | 出站 key | 状态 |
|---|---|---|---|
| hub-index | ✅ MCP_API_KEYS / mx_ scope | DATA/INJECTOR/RAG_API_KEY | 已闭环 |
| chain-rpc-mcp | ✅ MCP_API_KEYS / mx_ scope（复用 `mcp-auth.ts` `inboundAuth`） | CHAIN_RPC_READ_KEY / CHAIN_RPC_BROADCAST_KEY | 已闭环（MQ-10 补充 B，生产 :3012） |
| vault-mcp | ✅（2026-08-08 挂 `inboundAuth`，MQ-10 补充 D） | VAULT_API_KEY | 已闭环（生产需注入 MCP_API_KEY） |
| mpc-mcp | ✅（复用 `inboundAuth`） | MPC_API_KEY | 已闭环 |
| session-key-mcp | ✅（复用 `inboundAuth`） | SESSION_KEY_API_KEY | 已闭环 |
| dc-mcp | ✅（复用 `inboundAuth`） | DC_API_KEY | 已闭环 |
| wallet-mcp | ✅（复用 `inboundAuth`，生产曾因未注入 MCP_API_KEY 而 fail-closed 误锁，2026-08-08 修复） | WAAS_API_KEY | 已闭环 |
| market-mcp | ✅（2026-08-12 补挂 `inboundAuth`，此前为唯一裸奔 MCP） | DC_API_KEY（出站 collector :9101） | ✅ 已闭环 |
| LightRAG STDIO | ✅ 本地进程（自带 env key） | RAG_API_KEY | 已闭环 |

### 10.2 已知缺口（B-10 待办）

- **MCP 入站鉴权**（B-12）：2026-08-08 起全部 6 个 HTTP MCP 服务（vault/mpc/session-key/dc/wallet/chain-rpc）均挂 `mcp-auth.ts` `inboundAuth`；⚠️ 各服务生产须注入 `MCP_API_KEY`（或 `DATA_URL`+`DATA_API_KEY`），否则白名单为空 → 全部请求 401（fail-closed 误锁，wallet-mcp 曾遇，已修）
- **dc_tokens 必失败（B-10-3，✅ 2026-08-10 已修）**：dc-mcp `dc_tokens` 调用 dc `/api/v2/data/tokens` 401——根因生产 dc-mcp 缺 `DC_API_KEY`（默认发 test-key）。已注入生产 `infrax-dc-mcp.service.d/dc-api-key.conf`（租户 dc_api_key）+ 代码 fail-fast（2026-08-11，dc_tokens 返回真实数据）
- **支付工具 404（B-10-5，✅ 2026-08-11 已闭环）**：wallet-mcp 旧 `payment_create/payment_status/x402_pay` 依赖 waas paymentRoutes——现 payment/mpp 26 个工具已迁移通用支付引擎 :9132，生产 `infrax-wallet-mcp.service.d/payments.conf` 注入 `PAYMENTS_URL`+`PAYMENTS_API_KEY`，`payment_price` 实测返回真实套餐数据
- **market-index 已部署（✅ 2026-08-11）**：市场指数 MCP 服务此前代码存在但生产未运行——现新增 `infrax-market-mcp.service`（:3013，DC_URL=collector :9101 + 生产 DC_API_KEY），18 工具全量可用
- **hub-index 注释过时**：nginx 注释称"端点无入站鉴权"，实际 hub-index 已有鉴权，建议更新注释

---

## 11. 生产验证方式

```bash
# 健康检查
curl -s http://127.0.0.1:3008/health   # hub-index
curl -s http://127.0.0.1:9108/health   # vault-mcp
curl -s http://127.0.0.1:9105/health   # mpc-mcp（tools=17）
curl -s http://127.0.0.1:3011/health   # session-key-mcp
curl -s http://127.0.0.1:9103/health   # dc-mcp（tools=11）
curl -s http://127.0.0.1:9110/health   # wallet-mcp（tools=34）
curl -s http://127.0.0.1:3012/health   # chain-rpc-mcp（tools=10）
curl -s http://127.0.0.1:3013/health   # market-mcp（tools=18）

# 工具清单
curl -s -X POST http://127.0.0.1:3008/mcp/message \
  -H 'Content-Type: application/json' -H 'X-API-Key: <key>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
