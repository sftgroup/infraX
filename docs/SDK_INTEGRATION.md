# InfraX SDK 集成文档（SDK Integration Guide）

> 面向外部集成方的 SDK 使用指南。覆盖 **JS/TS SDK**（`@0xinfrax/infrax-dk`）、**Python SDK**（`lightrag-client`）、**OpenAPI 契约** 三类集成方式，对接 VAULT / MPC / WAAS / DATA / LightRAG / Session Key 六大微服务。

---

## 1. 总览

| SDK | 版本 | 发布状态 | 覆盖服务 |
|---|---|---|---|
| `@0xinfrax/infrax-dk`（npm） | 0.5.1 | ✅ 已发布（registry 已验证） | DATA / ML / VAULT / MPC / WAAS / DC / OKX ChainOS / x402 / **chain-rpc（含 `chainRpcBroadcastKey` 独立广播 key）** / **WAAS 钱包签名鉴权（`walletAddress`+`walletSign`）** |
| `@0xinfrax/mpc-sdk`（npm，独立轻量） | 0.1.0 | ✅ 已发布 + **生产 E2E 22/22 通过**（2026-08-08，MQ-10 补充 E-5） | MPC 钱包模块（sendCode/register/recover/status/createWallet）+ 会话模块（unlock/lock/status）；链上模块（7 方法）后续版本 |
| `lightrag-client`（PyPI） | 2.0.0 | ⏳ 构建+twine check 通过，待 PyPI token 发布 | LightRAG（ragservicer） |
| `@0xinfrax/ragservicer-sdk`（TS 类型） | 2.0.0 | ✅ 仓库内（`projects/ragservicer/sdk`） | LightRAG |
| FastAPI `/openapi.json`（data :9112 / ml-service :9120） | 原生 | ✅ 生产可访问 | DATA / ML |
| 手写 OpenAPI 3.0（injector :9113 / ragservicer :9721） | 3.0 | ✅ 生产免 key 可访问 | LightRAG |

---

## 2. JS/TS SDK：`@0xinfrax/infrax-dk`

### 2.1 安装

```bash
npm install @0xinfrax/infrax-dk        # Node >=18
# 或 yarn / pnpm add @0xinfrax/infrax-dk
```

### 2.2 初始化

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  baseUrl: 'https://43.163.105.172',   // 生产入口（域名恢复后用 https://infrax.0xainet.top）
  apiKey: process.env.INFRAX_API_KEY,  // 平台签发 key（dx_/vx_/mp_ 等，自动带 x-api-key 头）
  // ⚠️ JS SDK 无内置 TLS 跳过选项：当前生产自签证书下需
  //    NODE_TLS_REJECT_UNAUTHORIZED=0（Node）或待域名证书恢复后再用 https；
  //    内网直连 http://<host>:9112 无此问题。
});
```

> **数据域双服务区分（data :9112 vs dc :9102）**：
> - `infrax.data.*` → **data** 行情/因子服务：配置 `dataUrl`（及 `dataApiKey`）指向 :9112，未配置则回退 `baseUrl`；
> - `infrax.dc.*`、`infrax.market.*` → **dc** 链上 DEX 数据服务（:9102），走 `baseUrl`；nginx 已配 `/api/v2/data/*` 路由（2026-08-07），公网可达性受 Cloudflare 回源状态影响（见 infrax_tasklist §2.1）。
>
> ```ts
> const infrax = new InfraX({
>   baseUrl: 'https://43.163.105.172',
>   apiKey: process.env.INFRAX_API_KEY,
>   // data 服务独立入口（:9112；缺省回退 baseUrl）
>   dataUrl: 'http://<host>:9112',
>   dataApiKey: process.env.DATA_API_KEY,   // X-API-Key；缺省回退 apiKey
>   // ml-service 独立入口（:9120；缺省回退 baseUrl）
>   mlUrl: 'http://43.156.25.197:9120',
>   mlApiKey: process.env.ML_API_KEY,       // X-API-Key；缺省回退 apiKey
> });
> await infrax.data.factorsCatalog();       // → data
> await infrax.ml.cacheStats();             // → ml-service（免鉴权）
> await infrax.ml.bolt();                   // → ml-service（统一 dict；缓存 miss 时 data=null）
> await infrax.dc.tokens({ limit: 5 });     // → dc（公网受 Cloudflare 回源 502 影响，见 §2.1）
> ```

### 2.3 模块与方法（按服务分组）

| 服务 | 模块方法（`infrax.*`） | 对应 REST 端点 |
|---|---|---|
| **DATA 行情/因子** | `data.bars()`、`data.ticker()`、`data.factorsCurrent()`、`data.factorsHistory()`、`data.snapshots()`、`data.symbolSearch()`、`data.symbolResolve()`、`data.mlPredictions()`、`data.stats()` | `/api/data/*`（9112） |
| **ML 实时推理** | `ml.treePredictions()`、`ml.volatility()`、`ml.bolt()`、`ml.moirai()`、`ml.timesfm()`、`ml.consensus()`、`ml.sentiment()`、`ml.macroFeatures()`、`ml.cacheStats()`（免鉴权） | ml-service :9120 `/ml/*`（统一 dict+聚合；**缓存 miss 时 `data=null` 属预期**，配合 `/ml/cache/stats` 判断就绪） |
| **VAULT 多签** | `vault.safes()`、`vault.safeDetail()`、`vault.createSafe()`、`vault.proposeTx()`、`vault.confirmTx()`、`vault.executeTx()`、`vault.createTx()` | `/api/vault/*`（9107） |
| **MPC 钱包** | `mpc.sendCode()`、`mpc.register()`、`mpc.status()`、`mpc.signMessage()`、`mpc.signTypedData()`、`mpc.sendTransaction()` | `/api/v2/mpc/*`（9104） |
| **WAAS 钱包/支付/SaaS** | `wallet.balance()`、`wallet.send()`、`wallet.simulate()`、`wallet.rpc()`；`payment.create()`、`payment.status()`、`x402.pay()`；`saas.createTenant()`、`saas.listTenants()`、`saas.rotateApiKey()` | `/api/v2/*`（9109） |
| **DC 链上数据** | `dc.events()`、`dc.stats()`、`dc.tokens()`、`dc.chains()`、`dc.price()` | DC :9102 |
| **OKX ChainOS 市场** | `market.tokenInfo()`、`market.candles()`、`market.balance()`、`market.txHistory()`、`market.smartMoneySignals()`、`market.leaderboard()` 等 | DC :9102 |
| **chain-rpc 网关** | `chainRpc.call()`（读）、`chainRpc.broadcast()`（广播，需 `chainRpcBroadcastKey`）、`chainRpc.status()`、`chainRpc.health()` | chain-rpc :9130 `/v1/rpc/:chain`、`/v1/broadcast/:chain` |

> `data.*` 对应参数以 SDK 导出类型为准（`DataBarsParams`/`DataTickerParams`/`DataFactorCurrentParams`…，见 `src/index.ts`）。
>
> **chain-rpc 广播 key 说明（MQ-10 补充 A）**：网关读/广播为**分级 key**——读端点（`/v1/rpc`）只认读 key（`chainRpcApiKey`/`apiKey`），广播端点（`/v1/broadcast`）只认服务端签发的独立广播 key。SDK 自 0.5.0 支持独立配置：
>
> ```ts
> const infrax = new InfraX({
>   baseUrl: 'https://43.163.105.172',
>   apiKey: process.env.INFRAX_API_KEY,           // 读 key（x-api-key）
>   chainRpcUrl: 'http://<host>:9130',            // 网关（缺省回退 baseUrl）
>   chainRpcBroadcastKey: process.env.CHAIN_RPC_BROADCAST_KEY, // 独立广播 key
> });
> // 读：走读 key
> const bn = await infrax.chainRpc.call({ chain: 'sepolia', method: 'eth_blockNumber' });
> // 广播：走广播 key；未配置 chainRpcBroadcastKey 时明确抛错（fail-closed，不会用读 key 打广播端点）
> const tx = await infrax.chainRpc.broadcast({ chain: 'sepolia', rawTransaction: '0x...', wait: true });
> ```
>
> **WAAS 钱包签名鉴权（0.5.1，MQ-10 补充 D）**：waas 的 `/api/v2/wallet/*`、`/api/v2/tx/*` 端点要求钱包签名（EIP-191，消息 `InfraX auth: <ts>`，头 `x-wallet-address`/`x-wallet-signature`/`x-wallet-timestamp`）。SDK 自 0.5.1 支持 `walletAddress`+`walletSign` 回调自动生成签名头：
>
> ```ts
> import { Wallet } from 'ethers';
> const signer = new Wallet(process.env.WALLET_PRIVATE_KEY!);
> const infrax = new InfraX({
>   baseUrl: 'https://43.163.105.172',
>   walletAddress: signer.address,                       // 钱包地址（x-wallet-address）
>   walletSign: (msg) => signer.signMessage(msg),        // EIP-191 签名回调（x-wallet-signature）
> });
> // 带签名自动调用（balance/send/simulate/rpc/sweep/txStatus）
> const bal = await infrax.wallet.balance({ address: signer.address, chain: 'sepolia' });
> ```
>
> 未配置 `walletAddress`/`walletSign` 时 `wallet.*` 方法明确抛错（fail-closed），不会用 `x-api-key` 打需要签名的端点。`health()` 无需签名。

### 2.4 示例

```ts
// DATA：K 线
const bars = await infrax.data.bars({
  symbol: 'BTC/USDT', timeframe: '1d', marketType: 'spot', limit: 100,
});
console.log(bars.data.count, bars.data.bars[0]);

// VAULT：提案多签交易
const tx = await infrax.vault.proposeTx({
  safeAddress: '0x...', to: '0x...', value: '0.01', data: '0x',
});

// MPC：签名
const sig = await infrax.mpc.signTypedData({ walletId: '...', typedData });
```

---

## 2A. 独立 MPC SDK：`@0xinfrax/mpc-sdk`（MQ-10 补充 E-5）

独立轻量包，**不依赖 infrax-dk**，仅面向 MPC 微服务契约（`/api/v2/mpc/*`）。首期覆盖**钱包模块（5 方法）+ 会话模块（3 方法）**；链上模块（balance/signMessage/signTypedData/sendTransaction/contractRead/contractWrite/gasEstimate）为后续版本。

### 2A.1 安装与初始化

```bash
npm install @0xinfrax/mpc-sdk     # Node >=18，零运行时依赖
```

```ts
import { MpcClient, MpcApiError } from '@0xinfrax/mpc-sdk';

const mpc = new MpcClient({
  baseUrl: 'http://127.0.0.1:9104',   // 生产 MPC 服务地址（infrax-mpc :9104）
  apiKey: process.env.MPC_API_KEY,     // 出站统一 X-API-Key（生产 bridge key）
});
```

### 2A.2 钱包模块（5 方法）

| 方法 | 端点 | 说明 |
|---|---|---|
| `wallet.sendCode({ email })` | `POST /api/v2/mpc/send-code` | 下发 6 位验证码 |
| `wallet.register({ email, code, walletAddress? })` | `POST /api/v2/mpc/register` | 注册托管钱包（E2E 实测返回真实 EOA） |
| `wallet.recover({ email, code, expectedAddress? })` | `POST /api/v2/mpc/recover` | 恢复流程封装：验证码→分片重建→地址校验（不一致抛 409/40900） |
| `wallet.status({ email } \| { walletAddress })` | `GET /api/v2/mpc/status` | 双查询键钱包状态 |
| `wallet.createWallet({ email })` | `POST /api/v2/mpc/send-code` | 组合入口（发码→register） |

### 2A.3 会话模块（3 方法）

| 方法 | 端点 | 说明 |
|---|---|---|
| `session.unlock({ email, code })` | `POST /api/v2/mpc/session/unlock` | 解锁→`mpc_` 令牌 |
| `session.lock(token)` | `POST /api/v2/mpc/session/lock` | 锁定令牌 |
| `session.status({ token })` | `GET /api/v2/mpc/session/status` | 状态 + 剩余秒数 |

### 2A.4 错误语义（E-5e）

失败统一抛 `MpcApiError`（`status`/`code`/`kind`）：401 `unauthorized`（缺 key/会话无效）、400 `bad_request`（验证码错误/过期，code 1001）、404 `not_found`（未注册，code 1004）、409 `conflict`（SDK 恢复地址不一致，code 40900）、429 `rate_limited`（验证码尝试超限）、5xx `server_error`（分片解密失败 code 1007）。网络/超时抛 `MpcNetworkError`。

### 2A.5 生产验证（2026-08-08，43.163.105.172）

`projects/mpc-sdk/scripts/mpc-sdk-e2e.mjs` 生产实测 **22/22 全绿**：无 key 401、注册/重复注册、status 双键、unlock→status→lock 全流程、伪造/已锁 token、recover 一致/不一致(409)/未注册(404)。测试中发现并修复生产缺陷：**MPC server 缺统一 JSON 错误处理器**（错误路径曾返回 Express HTML 而非信封）——`projects/mpc/server.ts` 新增 `app.use` 错误中间件后已随 `infrax-mpc` 重启生效，错误分支现返回 `{code,message,data}`。

---

## 3. Python SDK：`lightrag-client`（LightRAG 图谱）

> 仓库位置 `projects/ragservicer/sdk/python`（包名 `lightrag-client==2.0.0`）。PyPI 发布待 token，现可从仓库源码安装。

```bash
pip install projects/ragservicer/sdk/python    # 或 pip install lightrag-client==2.0.0（发布后）
```

```python
from lightrag_client import LightRAGClient  # 实际导入名以包为准

client = LightRAGClient(
    base_url="https://43.163.105.172/api/rag/v1",  # ragservicer
    api_key="<lr_...>",                            # 租户签发 key
)

# 注入文档（异步）
task = client.insert(namespace="market", text="...")
# 查询（entities + relations + chunks）
result = client.query(namespace="market", mode="mix", query="BTC 近况")
# 删除文档 / 列出实例
client.delete(doc_id="..."); client.list_instances()
```

**TS 替代**：`@0xinfrax/ragservicer-sdk`（2.0.0，`projects/ragservicer/sdk` 内 TS 类型），方法与上对应（insert/query/delete/list_instances/retrieve）。

---

## 4. OpenAPI 契约（任意语言生成客户端）

| 服务 | OpenAPI 地址 | 生成方式 |
|---|---|---|
| DATA :9112 | `GET /api/data/openapi.json`（免 key） | openapi-generator / swagger-codegen 直接消费 |
| ml-service :9120 | `GET /ml/openapi.json` | 同上 |
| knowledge-injector :9113 | `GET /openapi.json`（10 paths，免 key） | 同上 |
| ragservicer :9721 | `GET /api/rag/v1/openapi.json`（15 paths，免 key） | 同上 |

```bash
# 示例：data 服务生成 TS 客户端
npx openapi-generator-cli generate -i https://43.163.105.172/api/data/openapi.json -g typescript-axios -o ./client
```

### 4.1 ml-service（:9120）消费要点

**推荐路径**：ML 预测优先读 **data-service `/api/data/ml/predictions`**（`infrax.data.mlPredictions()`，30min 周期快照落库，稳定低延迟）；需要实时推理结果时才直连 ml-service 以下端点。

> **鉴权说明（B 端必读）**：data 快照路径用 **data 签发的 `dx_*` key 即可**（SDK `apiKey`/`dataApiKey`，走统一三选一 header）；**直连 ml-service 实时端点需要单独的 `ML_API_KEY`**——ml-service 目前是**单一静态 key**（`app_auth.py` 单 key 常量时间比较，无租户多 key 签发体系，与 data 的 `dx_*` 不同）。未发放 `ML_API_KEY` 的 B 端请走 data 快照路径；如确需实时直连，需向平台申请或由 data-service 侧代理透传（`/api/data/ml/*` 带 ML_API_KEY 调用 ml-service）。

> **Python SDK**：`InfraDataClient.get_ml_predictions(model, symbol, start, end, limit)`（v0.2.0+）已内置快照读取（无快照 404→None，fail-silent）。完整集成示例（快照优先 + ml-service 直连 `data=null` 兜底 + `/ml/cache/stats` 就绪判断，生产实测通过）见 `projects/data/sdk/python/examples/ml_predictions_integration.py`。

**端点清单**（模型不可用/数据不足时 `data=null`，fail-silent）：

| 端点 | 模型 | 用途 |
|---|---|---|
| `/ml/tree_predictions` | LightGBM | 方向预测（全 symbol） |
| `/ml/volatility` | Kronos | 波动率预测 |
| `/ml/bolt` `/ml/moirai` `/ml/timesfm` | Chronos-Bolt / Moirai 2.0 / TimesFM 2.5 | P2 时序基础模型概率预测 |
| `/ml/consensus` | 多模型聚合 | 跨模型信号共识 |
| `/ml/sentiment` | FinBERT | 新闻文本情绪（POST） |
| `/ml/macro_features` | FRED 派生 | 宏观环境特征 |
| `/ml/cache/stats` | — | 缓存统计（免鉴权） |

**异步 + 预热语义（2026-08 改造，调用方必读）**：

1. 所有重计算端点结果走 **TTL 缓存**（`ML_CACHE_TTL_SEC` 默认 1800s）；
2. 缓存 **miss 时请求立即返回 `data=null`**，推理在后台线程完成——前端看到 null 不代表故障；
3. 预热线程（`ML_PREWARM_*`，默认开）周期刷新缓存，**缓存常满、请求几乎总是命中**；
4. 调用建议：首次调用若返回 null，按 `ML_CACHE_TTL_SEC`（30min）间隔轮询重试；或先查 `/ml/cache/stats` 确认缓存就绪。

**统一响应结构**（volatility/bolt/moirai/timesfm，2026-08 起由裸数组升级为 dict）：

```json
{
  "code": 0, "message": "ok",
  "data": {
    "generated_at": 1786089600000, "n_symbols": 30, "model": "chronos-bolt-small",
    "avg_prob_up": 0.5231,
    "symbols": [{"symbol": "BTC/USDT", "direction": 1, "prob_up": 0.61,
                 "point_forecast": 64512.3,
                 "quantiles": {"0.1": 61200.5, "0.5": 64512.3, "0.9": 67890.1},
                 "uncertainty": 0.21}]
  }
}
```

> 兼容性：`symbols[]` 内字段不变；新增顶层 `n_symbols` / `avg_<score_key>` / `model` 聚合指标。`?envelope=1` / `X-Envelope: 1` 时统一包装 `{code, message, data}`。

---

## 5. 鉴权集成要点

1. **统一三选一**：所有服务请求带任一 header——`Authorization: Bearer <key>` / `X-API-Key: <key>` / `X-Service-Key: <key>`。
2. **key 获取**：admin 面板 `GET /admin/api-keys` 签发（`dx_` 等前缀）；区块链服务另支持各服务 `.env` bridge key（`VAULT_API_KEY`/`MPC_API_KEY`/…）。
3. **WAAS 注意**：未接统一契约，租户调用用 `x-api-key: <tenant key>`（saas 路由），其余端点当前无鉴权（B-12-1 修复中）。
4. **HTTP 层**：域名 `infrax.0xainet.top` 证书生效前，直连 `https://43.163.105.172` 需 `-k`/`verifyTls:false`；`/api/*` 域名 502 为 Cloudflare 回源待配置（见部署文档 §2.1）。
5. **时间戳**：毫秒 UTC（unix ms）。

---

## 6. 覆盖缺口（B-12-* 待办）

- `session-key` 方法未入 SDK（`infrax.session.*` 待加，B-12-2）
- SDK 未含 ragservicer 图谱方法（走 `lightrag-client` / `ragservicer-sdk`）
- WAAS 统一鉴权接入后需同步更新 SDK 示例（B-12-1）
- PyPI 发布待 token（G-9）
