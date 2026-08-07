# InfraX MCP 使用文档（MCP Usage Guide）

> 面向 AI Agent / MCP 客户端的接入指南。覆盖 **7 个 MCP 服务**：hub-index（统一入口，:3008）、vault-mcp（:9108）、mpc-mcp（:9105）、session-key-mcp（:3011）、dc-mcp（:9103）、wallet-mcp（:9110）、LightRAG STDIO MCP（5 工具）。
> 数据来源：生产代码盘点 + 生产实测（2026-08-06，`43.163.105.172`）。

---

## 1. 总览

| MCP 服务 | 端口 | 传输 | systemd 单元 | 工具数 | 后端 |
|---|---|---|---|---|---|
| **hub-index（统一入口）** | 3008 | Streamable HTTP | `infrax-hub-index` | 13 | data :9112 / injector :9113 / ragservicer :9721 |
| vault-mcp | 9108 | JSON-RPC over HTTP | `infrax-vault-mcp` | 13 | vault :9107 |
| mpc-mcp | 9105 | JSON-RPC over HTTP | `infrax-mpc-mcp` | 15 | mpc :9104 |
| session-key-mcp | 3011 | Streamable HTTP | `infrax-session-key-mcp` | 7 | session-key :3500 |
| dc-mcp | 9103 | Streamable HTTP | `infrax-dc-mcp` | 7 | dc :9102 |
| wallet-mcp | 9110 | SSE + JSON-RPC over HTTP | `infrax-wallet-mcp` | 10 | waas :9109 |
| LightRAG STDIO | — | stdio | — | 5 | ragservicer :9721 |

**对外暴露**：仅 hub-index 经 nginx 以 `/mcp/*` 对外；其余 5 个 HTTP MCP 端口监听 `0.0.0.0` 且未经 nginx 代理（受信方直连）。

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
| vault / mpc / session-key / dc / wallet | ⚠️ **无入站鉴权** | 未校验入站 key；仅监听内网/受信直连（B-12 待办：统一 MCP 入站鉴权） |

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

## 5. mpc-mcp（:9105，15 工具）

邮箱验证码 MPC 钱包：注册/恢复 + 会话解锁 + 签名/交易/合约。

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

## 7. dc-mcp（:9103，7 工具）

链上数据中心：事件/统计/检查点/套餐/代币/链/价格。

| 工具 | 参数 | 说明 |
|---|---|---|
| `dc_events` | chain, address, event_type, from_block, to_block, limit | 链上事件查询 |
| `dc_stats` | — | 数据中心统计 |
| `dc_checkpoints` | chain | 区块索引检查点 |
| `dc_plans` | — | 订阅套餐 |
| `dc_tokens` | chain | 支持代币列表 ⚠️ **已知必失败**（端点调 dc `/api/v2/data/tokens` 不存在，B-10-3） |
| `dc_chains` | — | 支持链列表 |
| `dc_price` | symbol* | 实时价格（Binance 公共 API，USDT 对） |

---

## 8. wallet-mcp（:9110，10 工具）

WAAS 代理：钱包余额/发送/模拟 + 支付（x402）。

| 工具 | 参数 | 说明 |
|---|---|---|
| `wallet_balance` | address*, chain | 链上代币余额 |
| `wallet_send` | to*, amount*, chain | 从 gas 池发送（单笔上限 0.05 ETH） |
| `wallet_simulate` | from*, to*, amount*, chain | gas 预估模拟 |
| `wallet_rpc` | — | 各链 RPC 端点 |
| `wallet_health` | — | WAAS 后端健康 |
| `wallet_sweep` | chain | 托管资金归集（admin） |
| `wallet_status` | txHash*, chain | 交易上链状态 |
| `payment_create` | planId*, amount*, method, currency | 创建支付单 ⚠️ 依赖 waas paymentRoutes 挂载（B-10-5 未挂载） |
| `payment_status` | paymentId* | 支付单状态 ⚠️ 同上 |
| `x402_pay` | recipient*, amount*, token, chain, description | HTTP 402 支付流程 ⚠️ 同上 |

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
| vault-mcp | ⚠️ 无 | VAULT_API_KEY | 需 B-12 统一入站鉴权 |
| mpc-mcp | ⚠️ 无 | MPC_API_KEY | 同上 |
| session-key-mcp | ⚠️ 无 | SESSION_KEY_API_KEY | 同上 |
| dc-mcp | ⚠️ 无 | DC_API_KEY | 同上 |
| wallet-mcp | ⚠️ 无 | WAAS_API_KEY | 同上 |
| LightRAG STDIO | ✅ 本地进程（自带 env key） | RAG_API_KEY | 已闭环 |

### 10.2 已知缺口（B-10 / B-12 待办）

- **MCP 入站鉴权**（B-12）：仅 hub-index 有入站鉴权，其余 5 个 HTTP MCP 服务入站裸奔（依赖网络隔离），需复用 hub-index 的 `MCP_API_KEYS` + data verify 模式
- **dc_tokens 必失败**（B-10-3）：dc-mcp `dc_tokens` 调用 dc `/api/v2/data/tokens` 不存在
- **支付工具 404**（B-10-5）：wallet-mcp `payment_create/payment_status/x402_pay` 依赖 waas paymentRoutes，尚未挂载
- **market-index 未部署**：市场指数 MCP 服务代码存在但生产未运行
- **hub-index 注释过时**：nginx 注释称"端点无入站鉴权"，实际 hub-index 已有鉴权，建议更新注释

---

## 11. 生产验证方式

```bash
# 健康检查
curl -s http://127.0.0.1:3008/health   # hub-index
curl -s http://127.0.0.1:9108/health   # vault-mcp
curl -s http://127.0.0.1:9105/health   # mpc-mcp
curl -s http://127.0.0.1:3011/health   # session-key-mcp
curl -s http://127.0.0.1:9103/health   # dc-mcp
curl -s http://127.0.0.1:9110/health   # wallet-mcp

# 工具清单
curl -s -X POST http://127.0.0.1:3008/mcp/message \
  -H 'Content-Type: application/json' -H 'X-API-Key: <key>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
