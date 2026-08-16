# Chain RPC 网关 使用指南（:9130）

> 最后更新：2026-08-16 | 生产状态：🟢 已验证可用（2026-08-16 公网实测：标准 JSON-RPC 兼容 + rx_/bx_ 双 key + 10 链）

## 0. 快速开始（Quick Start）

**1）安装**

```bash
npm install @0xinfrax/infrax-dk
```

**2）获取凭据**

读 key：服务端 `CHAIN_RPC_READ_KEY`；广播 key：服务端单独签发的 `CHAIN_RPC_BROADCAST_KEY`（仅 `/v1/broadcast` 端点可用，读端点拒绝）；或订阅面 `POST /v1/subscription/issue-key` 签发 `rx_` 读 key（`kind` 缺省）或 `bx_` 广播 key（`kind:"broadcast"`，均仅展示一次）。**公网入口**：`https://rpc-gw.0xainet.top`（nginx TLS 反代，2026-08-13 交付；读/广播端点标准 JSON-RPC 兼容，ethers/viem 可直连）；内网 `http://127.0.0.1:9130`。

**3）最小示例**

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  chainRpcUrl: 'https://rpc-gw.0xainet.top',   // 公网入口（标准 JSON-RPC 兼容；内网可 http://127.0.0.1:9130）
  chainRpcApiKey: process.env.CHAIN_RPC_READ_KEY, // 读 key（自动带 x-api-key 头）
});

// 通用链上读（生产实测 eth_blockNumber）
const bn = await infrax.chainRpc.call({ chain: 'sepolia', method: 'eth_blockNumber' });
console.log(bn.data.result);

// 服务健康
await infrax.chainRpc.health();
```

**4）验证**

```bash
curl -s http://127.0.0.1:9130/v1/rpc/sepolia \
  -H "X-Service-Key: <CHAIN_RPC_READ_KEY>" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

> 完整端点清单 / 鉴权细节 / 错误码见下文对应章节。

## 1. 服务定位

全仓唯一链上 RPC 读取 + 交易广播网关（systemd `infrax-chain-rpc`）：所有中心化服务（waas / dc / collector / mpc / payments…）统一经本网关读链上数据、广播已签名交易；网关**不持有任何私钥**，广播仅转发调用方已签名的 rawTx。读写鉴权分级——读 key 无法触达广播端点。MQ-16 T-3 附加 **RPC 读套餐订阅**面（`/v1/subscription/*`，`rx_` key 鉴权、配额超限返回 **503**）。

生产访问：
- 公网入口 `https://rpc-gw.0xainet.top`（nginx TLS 反代 `:9130`，2026-08-13 交付；读/广播端点支持标准 JSON-RPC 透传，ethers/viem 零改动直连）
- 内网直连 `http://127.0.0.1:9130`

## 2. 鉴权方式

统一平台契约（三选一，任一匹配即通过）：

```
Authorization: Bearer <key>
X-API-Key: <key>
X-Service-Key: <key>        # 服务间调用约定
```

分级规则：
- **读端点**（`POST /v1/rpc/:chain`、`GET /v1/status`）：认 `CHAIN_RPC_READ_KEY` 或 `CHAIN_RPC_BROADCAST_KEY`（广播 key 权限更高，可读）；`rx_`/`bx_` 前缀订阅 key（`rpc_keys` 表 SHA-256 哈希校验，`X-RPC-Key` / `X-API-Key` / `Authorization` / body `api_key` 均可携带）；外部 data 签发 `dx_`/`mx_` key（scope=`rpc`，经 data `/api-keys/verify` 实时校验，`CHAIN_RPC_ENABLE_EXTERNAL_VERIFY=true` 时启用）。
- **广播端点**（`POST /v1/broadcast/:chain`）：**仅认 `bx_` 广播订阅 key**（或 `CHAIN_RPC_BROADCAST_KEY` / 外部 scope=`rpc_broadcast` key），`rx_` 读 key 永远 401。
- **订阅端点**（`/v1/subscription/*`）：`issue-key` 是管理操作（X-Service-Key = 本地 bridge key，body 可带 `kind`：缺省签发 `rx_` 读 key、`kind:"broadcast"` 签发 `bx_` 广播 key）；`checkout`/`payment-check`/`verify`/`usage` 需 `rx_` key；`plans` 与 `/health` **公开**；`payment-callback` 为支付引擎出站回调（HMAC-SHA256 验签，`x-payments-signature`）。
- `rx_`/`bx_` 订阅 key 受配额限制（`rpcQuotaEnforce`，读/广播路由均挂载，月度配额用尽 → **503** + 升级提示）；本地 bridge key / 外部 `dx_`/`mx_` key 豁免配额。

响应默认统一信封 `{code, message, data}`。**内容协商（RPC-9，2026-08-16）**：请求体含 `jsonrpc:"2.0"`（单条或 batch 数组）自动切换为标准 JSON-RPC 透传（`{jsonrpc, id, result|error}`，错误码 -32601/-32602/-32000 语义透传）——ethers/viem 零改动直连；无 `jsonrpc` 字段走旧信封（waas/dc/mcp-server/sdk 零影响）；显式 `X-Json-Rpc: raw` 强制标准。广播端点同理：标准 body `eth_sendRawTransaction` → `{jsonrpc:"2.0", result:"0xtxhash"}`。方法级 RPC 错误（revert/无效参数/nonce/余额）raw 模式 HTTP 200 + JSON-RPC error、信封模式 400 `{detail, code:"rpc_error"}`。

## 3. 端点清单

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 公开 | 健康检查（`{status, service, chains}`） |
| POST | `/v1/rpc/:chain` | 读 key / 广播 key / `rx_`/`bx_` key | 通用 JSON-RPC 读调用（**10 链**：`sepolia`/`eth`/`bsc`/`base`/`oxa`/`solana`/`polygon`/`arbitrum`/`optimism`/`xlayer`；方法走白名单：`eth_*` 读方法 / solana `get*`；非白名单 403；内容协商标准透传见 §2） |
| POST | `/v1/rpc/:chain`（数组 body） | 同上 | JSON-RPC batch（≤100 条，并发 8；body 含 `jsonrpc` 时返回标准 batch 结果，否则信封） |
| POST | `/v1/broadcast/:chain` | **仅广播 key（`bx_`）** | 交易广播，body `{rawTransaction, wait?, timeoutMs?}` → `{chain, txHash, confirmed, receipt}`（wait=true 轮询回执）；标准 body `eth_sendRawTransaction` → `{jsonrpc, result}` |
| GET | `/v1/status` | 读 key | RPC 池状态（脱敏：链 × 端点状态，不含 url） |
| WS | `/v1/ws` | 读 key | WebSocket 订阅代理（仅 `eth_subscribe`/`eth_unsubscribe`） |
| GET | `/v1/subscription/plans` | **公开** | RPC 套餐目录（rpc_free/rpc_pro/rpc_enterprise） |
| POST | `/v1/subscription/issue-key` | 管理（X-Service-Key = bridge key） | 签发 `rx_` 读 key（`{label?}` → `{keyId, rpcKey, planId, status}`；key 仅展示一次）；`kind:"broadcast"` → 签发 `bx_` 广播 key |
| POST | `/v1/subscription/checkout` | `rx_` key | 发起订阅支付，body `{plan_id, rail?, subscriber?}`（rail: chain/fiat/x402；免费直接激活，付费返回 pending + payment 意图） |
| POST | `/v1/subscription/payment-check` | `rx_` key | 轮询支付状态（chain rail 链上确认 → active） |
| POST | `/v1/subscription/payment-callback` | HMAC 验签 | 支付引擎出站事件回调（`x-payments-signature`，`rpclin:` 前缀 clientReference 激活） |
| POST | `/v1/subscription/verify` | `rx_` key | x402 支付确认，body `{txHash}` → `{verified, activated}` |
| GET | `/v1/subscription/usage` | `rx_` key | 订阅用量（planId/planName/monthlyQuota/currentUsage/dailyBreakdown） |

## 4. 样例代码

### 4.1 curl（公网入口 / 内网直连）

```bash
# ── 读：eth_blockNumber（生产实测 result=0xaee36d）──
curl -s http://127.0.0.1:9130/v1/rpc/sepolia \
  -H "X-Service-Key: <CHAIN_RPC_READ_KEY>" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
# → {"code":0,"message":"ok","data":{"chain":"sepolia","method":"eth_blockNumber","result":"0xaee36d"}}

# ── 读：标准 JSON-RPC 透传（viem/ethers 直连消费）──
curl -s http://127.0.0.1:9130/v1/rpc/sepolia \
  -H "X-Service-Key: <CHAIN_RPC_READ_KEY>" -H 'X-Json-Rpc: raw' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# → {"jsonrpc":"2.0","id":1,"result":"0xaa36a7"}

# ── 广播（仅广播 key）：转发已签名 rawTx ──
curl -s -X POST http://127.0.0.1:9130/v1/broadcast/sepolia \
  -H "X-Service-Key: <CHAIN_RPC_BROADCAST_KEY>" \
  -H 'Content-Type: application/json' \
  -d '{"rawTransaction":"0x02f8...（调用方已签名）","wait":true}'
# → {"code":0,"message":"ok","data":{"chain":"sepolia","txHash":"0x...","confirmed":true,"receipt":{...}}}

# ── 池状态（脱敏）──
curl -s http://127.0.0.1:9130/v1/status -H "X-Service-Key: <CHAIN_RPC_READ_KEY>"

# ── 订阅：套餐目录（公开）──
curl -s http://127.0.0.1:9130/v1/subscription/plans

# ── 订阅：签发 rx_ 读 key / bx_ 广播 key（管理操作，bridge key）──
curl -s -X POST http://127.0.0.1:9130/v1/subscription/issue-key \
  -H "X-Service-Key: <CHAIN_RPC_READ_KEY>" -H 'Content-Type: application/json' \
  -d '{"label":"my-agent"}'
# → {"code":0,"message":"ok","data":{"keyId":1,"rpcKey":"rx_...","planId":"rpc_free","status":"active",...}}
curl -s -X POST http://127.0.0.1:9130/v1/subscription/issue-key \
  -H "X-Service-Key: <CHAIN_RPC_READ_KEY>" -H 'Content-Type: application/json' \
  -d '{"label":"my-agent-broadcast","kind":"broadcast"}'
# → {"code":0,"message":"ok","data":{"keyId":5,"rpcKey":"bx_...","planId":"rpc_free","status":"active",...}}
```

### 4.2 JS SDK（@0xinfrax/infrax-dk v0.6.0）

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  // 网关独立入口（chainRpcUrl 缺省回退 baseUrl）
  chainRpcUrl: 'https://rpc-gw.0xainet.top',          // 公网入口（标准 JSON-RPC 兼容；内网可 http://127.0.0.1:9130）
  chainRpcApiKey: process.env.CHAIN_RPC_READ_KEY,     // 读 key（x-api-key；缺省回退 apiKey；亦可用 rx_ 订阅 key）
  chainRpcBroadcastKey: process.env.CHAIN_RPC_BROADCAST_KEY, // 独立广播 key（bx_ / cr_；缺省时 broadcast() 明确抛错，fail-closed）
});

// ── 读：eth_blockNumber ──
const bn = await infrax.chainRpc.call({ chain: 'sepolia', method: 'eth_blockNumber' });
console.log(bn.data.result); // '0xaee36d'

// ── 广播：转发已签名 rawTx（走广播 key；读 key 无法触达 /v1/broadcast）──
const tx = await infrax.chainRpc.broadcast({
  chain: 'sepolia',
  rawTransaction: '0x02f8...',   // 调用方已签名交易
  wait: true,                     // 可选：轮询回执
});
console.log(tx.data.txHash, tx.data.confirmed);

// ── 池状态 + 健康 ──
await infrax.chainRpc.status();
await infrax.chainRpc.health();

// ── 订阅面：套餐目录（公开）──
const plans = await infrax.chainRpc.subscriptionPlans();
console.log(plans.data); // [rpc_free, rpc_pro, rpc_enterprise]

// ── 订阅面：签发 rx_ 读 key / bx_ 广播 key（管理操作，x-api-key 需为 bridge key）──
const k = await infrax.chainRpc.issueRpcKey('my-agent');
const rpcKey = k.data.rpcKey;   // rx_...，仅展示一次
const kb = await infrax.chainRpc.issueRpcKey('my-agent-broadcast', { kind: 'broadcast' });
const bxKey = kb.data.rpcKey;   // bx_...（广播 key，仅展示一次）

// ── 订阅面：订阅套餐（免费直激活 / 付费返回 pending 支付意图）──
const r = await infrax.chainRpc.subscriptionCheckout({ plan_id: 'rpc_pro', rail: 'x402' });
if (r.data.rpcSubStatus === 'pending') {
  // 用户钱包向 r.data.payment.payTo 支付 priceWei → 提交 txHash 确认
  const v = await infrax.chainRpc.subscriptionVerify('0x...'); // {verified, activated}
}
const usage = await infrax.chainRpc.subscriptionUsage(); // planId/quota/currentUsage
```

### 4.3 常见错误码

| HTTP | code | 场景 |
|---|---|---|
| 200 | — | raw 模式方法级 RPC 错误（revert/无效参数/nonce/余额）→ `{jsonrpc, id, error:{code,message}}`（节点健康，非网关故障） |
| 400 | `rpc_error` | 信封模式方法级 RPC 错误（`{detail: 节点消息}`）；未知 chain（`unsupported chain: xxx`）、缺 method、batch 超 100 条 |
| 401 | 1004 | 无 key / key 无效 / `rx_` 读 key 调广播端点（`unauthorized`）；伪造 `rx_`/`bx_` key |
| 403 | — | 读端点请求非白名单方法（`method X is not allowed on read endpoint`，raw 模式 -32601） |
| 404 | 2002 | `usage` 时 key 不存在 |
| 502 | `upstream_error` / 1003 | 上游 RPC 端点不可达 / 支付引擎不可达 |
| 503 | 503 | **配额用尽**（`RPC quota exhausted — upgrade your plan`）；或 `payment-callback` 未配置 webhook secret（code 1003） |
