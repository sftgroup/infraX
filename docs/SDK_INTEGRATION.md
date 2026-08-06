# InfraX SDK 集成文档（SDK Integration Guide）

> 面向外部集成方的 SDK 使用指南。覆盖 **JS/TS SDK**（`@0xinfrax/infrax-dk`）、**Python SDK**（`lightrag-client`）、**OpenAPI 契约** 三类集成方式，对接 VAULT / MPC / WAAS / DATA / LightRAG / Session Key 六大微服务。

---

## 1. 总览

| SDK | 版本 | 发布状态 | 覆盖服务 |
|---|---|---|---|
| `@0xinfrax/infrax-dk`（npm） | 0.3.0 | ✅ 已发布（registry 已验证） | DATA / VAULT / MPC / WAAS / DC / OKX ChainOS / x402 |
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
  apiKey: process.env.INFRAX_API_KEY,  // 平台签发 key（dx_/vx_/mp_ 等，Bearer 携带）
  // verifyTls: false,                 // 域名证书未配前需跳过校验
});
```

> **数据域双服务区分（data :9112 vs dc :9102）**：
> - `infrax.data.*` → **data** 行情/因子服务：配置 `dataUrl`（及 `dataApiKey`）指向 :9112，未配置则回退 `baseUrl`；
> - `infrax.dc.*`、`infrax.market.*` → **dc** 链上 DEX 数据服务（:9102），走 `baseUrl`；当前 nginx **未暴露** `/api/v2/` 路由，公网调用需先加反代或内网直连。
>
> ```ts
> const infrax = new InfraX({
>   baseUrl: 'https://43.163.105.172',
>   apiKey: process.env.INFRAX_API_KEY,
>   // data 服务独立入口（:9112；缺省回退 baseUrl）
>   dataUrl: 'http://<host>:9112',
>   dataApiKey: process.env.DATA_API_KEY,   // X-API-Key；缺省回退 apiKey
> });
> await infrax.data.factorsCatalog();       // → data
> await infrax.dc.tokens({ limit: 5 });     // → dc（需公网路由或内网）
> ```

### 2.3 模块与方法（按服务分组）

| 服务 | 模块方法（`infrax.*`） | 对应 REST 端点 |
|---|---|---|
| **DATA 行情/因子** | `data.bars()`、`data.ticker()`、`data.factorsCurrent()`、`data.factorsHistory()`、`data.snapshots()`、`data.symbolSearch()`、`data.symbolResolve()`、`data.mlPredictions()`、`data.stats()` | `/api/data/*`（9112） |
| **VAULT 多签** | `vault.safes()`、`vault.safeDetail()`、`vault.createSafe()`、`vault.proposeTx()`、`vault.confirmTx()`、`vault.executeTx()`、`vault.createTx()` | `/api/vault/*`（9107） |
| **MPC 钱包** | `mpc.sendCode()`、`mpc.register()`、`mpc.status()`、`mpc.signMessage()`、`mpc.signTypedData()`、`mpc.sendTransaction()` | `/api/v2/mpc/*`（9104） |
| **WAAS 钱包/支付/SaaS** | `wallet.balance()`、`wallet.send()`、`wallet.simulate()`、`wallet.rpc()`；`payment.create()`、`payment.status()`、`x402.pay()`；`saas.createTenant()`、`saas.listTenants()`、`saas.rotateApiKey()` | `/api/v2/*`（9109） |
| **DC 链上数据** | `dc.events()`、`dc.stats()`、`dc.tokens()`、`dc.chains()`、`dc.price()` | DC :9102 |
| **OKX ChainOS 市场** | `market.tokenInfo()`、`market.candles()`、`market.balance()`、`market.txHistory()`、`market.smartMoneySignals()`、`market.leaderboard()` 等 | DC :9102 |

> `data.*` 对应参数以 SDK 导出类型为准（`DataBarsParams`/`DataTickerParams`/`DataFactorCurrentParams`…，见 `src/index.ts`）。

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
