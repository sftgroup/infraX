# Vault Safe 多签保险库 使用指南（:9107）

> 最后更新：2026-08-11 | 生产状态：🟢 已验证可用（2026-08-11 生产实测）

## 0. 快速开始（Quick Start）

**1）安装**

```bash
npm install @0xinfrax/infrax-dk
```

**2）获取凭据**

平台 `VAULT_API_KEY`（bridge key），或 data 服务签发的 scope=`vault` 外部 key（`vx_` 前缀，经 data `/api-keys/verify` 实时校验）。`/health` 公开豁免。

**3）最小示例**

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  baseUrl: 'http://127.0.0.1:9107',   // 内网直连；公网 baseUrl 用 https://infrax.0xainet.top（前缀 /api/vault/*）
  apiKey: process.env.VAULT_API_KEY,  // 自动带 x-api-key 头
});

// dashboard 总览（生产实测 200：safeCount=28, txCount=3）
const dash = await infrax.vault.dashboard();
console.log(dash.data.safeCount, dash.data.txCount);

// Safe 列表
const safes = await infrax.vault.safes();
```

**4）验证**

```bash
curl -s http://127.0.0.1:9107/health
# 或带 key：curl -s http://127.0.0.1:9107/api/vault/dashboard -H "X-API-Key: <VAULT_API_KEY>"
```

> 完整端点清单 / 鉴权细节 / 错误码见下文对应章节。

## 1. 服务定位

基于 Safe{Core} 协议的多签保险库微服务（systemd `infrax-vault`，DB `infrax_vault`）：Safe 合约部署、交易提案/确认/执行、Owner 管理（走链上多签）、pending 交易重试/同步，以及链上交易风控规则（risk rules）检查。独立于其他模块，集成 Safe{Core} SDK。

生产访问：
- 内网直连 `http://127.0.0.1:9107`
- 公网经 nginx→web 代理：`https://infrax.0xainet.top/api/vault/...`（代理自动注入 `X-Service-Key`，前端无需带 key）

### 1.1 签名责任（签名方 = Safe owner，用户本人）

Vault 是**用户自托管多签**：Safe 合约的 owner 是用户自己的地址，**确认交易的签名必须由 owner 钱包本人 EIP-712 签名**（`confirm` 的 `signature` 字段）。服务端只负责**编排**（部署 / 提案 / 执行 / 风控 / 重试），**不代表用户签名**。这是自托管多签的产品特性，不是集成负担；需要"用户免每笔签名"时，可将平台 MPC / session-key 钱包配置为 owner（一次性授权 / 验证码解锁后由平台签名通道完成确认，见 tasklist §9.10 W-4）。

## 2. 鉴权方式

统一平台鉴权契约（三选一，任一匹配即通过）：

```
Authorization: Bearer <key>
X-API-Key: <key>
X-Service-Key: <key>
```

- key：平台 `VAULT_API_KEY`（bridge key），或 data 服务签发的 **scope=`vault`**（`vx_` 前缀）外部 key（外部 key 经 data `POST /api-keys/verify` 实时校验）。
- 豁免：`/health`（公开）；`/metrics`。
- 响应统一信封 `{code, message, data}`（`code=0` 成功；错误如 `{code:1001, message:'...', data:null}` + HTTP 状态码）。
- 用户维度（owned/participating/status 等）用 query `userId` 或 header `x-user-id` / `x-wallet-address` 标识。

## 3. 端点清单

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 公开 | 健康检查 |
| GET | `/api/vault/dashboard` | key | 总览：`{safeCount, txCount, pendingSig, activeRules}`（生产实测 safeCount=28, txCount=3） |
| POST | `/api/vault/safe/create` | key | 部署 Safe，body `{userId?, chainId, owners[], threshold, name?}` → 201 |
| POST | `/api/vault/safe/propose` | key | 提案多签交易，body `{userId?, safeAddress, to, value?, data?}` → 201 |
| POST | `/api/vault/safe/confirm` | key | 确认提案，body `{userId?, safeAddress, safeTxHash, signature}`（达阈值提示 ready to execute） |
| POST | `/api/vault/safe/execute` | key | 执行已达标交易，body `{safeTxHash}` |
| GET | `/api/vault/safe/list?userId=&chain=&status=` | key | Safe 列表 |
| GET | `/api/vault/safe/owned?userId=\|x-user-id\|x-wallet-address` | key | 我拥有的 Safe |
| GET | `/api/vault/safe/participating` | key | 我参与的 Safe |
| GET | `/api/vault/safe/status?walletAddress=` | key | 某地址是否已有 Safe：`{enabled, count}` |
| GET | `/api/vault/safe/:address` | key | Safe 详情 + 交易列表（地址须 0x + 42 位） |
| PUT | `/api/vault/safe/:address/owners` | key | Owner 管理（链上多签提案），body `{userId?, owners[], threshold, signature?}` |
| POST | `/api/vault/safe/retry` | key | 重试 pending 部署，body `{chainId?}` |
| POST | `/api/vault/safe/execute-ready` | key | 执行所有已就绪交易，body `{safeAddress}` |
| POST | `/api/vault/safe/sync` | key | 同步链上 Safe 状态，body `{safeAddress}` |
| GET | `/api/vault/risk/rules` | key | 风控规则列表 |
| POST | `/api/vault/risk/rules` | key | 新建风控规则，body `{name, chain, max_single, max_daily, enabled?}` |
| POST | `/api/vault/risk/check` | key | 风控检查，body `{amount, chain}` → `{pass, reason?, rule?}` |

## 4. 样例代码

### 4.1 curl（内网直连 + 公网经代理两种）

```bash
# ═══ 内网直连 ═══
BASE=http://127.0.0.1:9107

# ═══ 公网经 web 代理（:9111，自动注入 X-Service-Key；直连调用方需自带 key）═══
# BASE=https://infrax.0xainet.top
KEY="X-API-Key: <VAULT_API_KEY>"

# ── dashboard（生产实测 200）──
curl -s $BASE/api/vault/dashboard -H "$KEY"
# → {"code":0,"message":"success","data":{"safeCount":28,"txCount":3,"pendingSig":0,"activeRules":0}}

# ── Safe 列表 ──
curl -s "$BASE/api/vault/safe/list" -H "$KEY"

# ── 创建 Safe（部署多签）──
curl -s -X POST $BASE/api/vault/safe/create -H "$KEY" -H 'Content-Type: application/json' \
  -d '{"userId":"alice","chainId":"eip155:19505","owners":["0x1111111111111111111111111111111111111111","0x2222222222222222222222222222222222222222"],"threshold":2,"name":"Treasury"}'
# → {"code":0,"message":"Safe wallet created","data":{"safeAddress":"0x...",...}}

# ── 提案多签交易 ──
curl -s -X POST $BASE/api/vault/safe/propose -H "$KEY" -H 'Content-Type: application/json' \
  -d '{"safeAddress":"0x...","to":"0x2222222222222222222222222222222222222222","value":"0.01","data":"0x"}'
# → {"code":0,"message":"Transaction proposed","data":{"safeTxHash":"0x...",...}}
```

### 4.2 JS SDK（@0xinfrax/infrax-dk v0.6.0）

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  baseUrl: 'http://127.0.0.1:9107',   // 内网直连；公网 baseUrl 用 https://infrax.0xainet.top（经 /api/vault 代理）
  apiKey: process.env.VAULT_API_KEY,  // 自动带 x-api-key 头
});

// ── dashboard 总览 ──
const dash = await infrax.vault.dashboard();   // GET /api/vault/dashboard
console.log(dash.data.safeCount, dash.data.txCount);

// ── Safe 列表 / 详情 ──
const safes = await infrax.vault.safes();       // GET /api/vault/safe/list
const detail = await infrax.vault.safeInfo(safes.data[0]?.address ?? '0x...');

// ── 创建 Safe（签名：createSafe({ name?, signers, threshold, chain })）──
const safe = await infrax.vault.createSafe({
  chain: 'oxachain',           // oxachain（勿写成 chainId；那是 safe.create 的签名）
  signers: [                   // 签名者地址（勿写成 owners）
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222',
  ],
  threshold: 2,
  name: 'Treasury',
});

// ── 多签流程：提案 → 确认 → 执行（infra.safe.* 同样走 /api/vault/*）──
const tx = await infrax.safe.propose({
  safeAddress: safe.data.address,
  to: '0x2222222222222222222222222222222222222222',
  value: '0.01',
  data: '0x',
});
const confirmed = await infrax.safe.confirm({
  safeAddress: safe.data.safeAddress,
  safeTxHash: tx.data.safeTxHash,
  signature: '<owner-signature>',   // 由 owner 钱包签名
});
if (confirmed.data.sigCount >= confirmed.data.threshold) {
  await infrax.safe.execute({ safeTxHash: tx.data.safeTxHash });
}

// ── 风控检查（发送前预检）──
const risk = await infrax.vault.riskCheck({ to: '0x2222222222222222222222222222222222222222', amount: '0.01', chain: 'oxachain' });
console.log(risk.data.pass, risk.data.rule);
```

### 4.3 常见错误码

| HTTP | code | 场景 |
|---|---|---|
| 400 | 1001 | 缺少必填字段（create 缺 signers/chain、propose 缺 safeAddress/to、confirm 缺签名、safe/:address 格式非法） |
| 401 | — | 未带 key / key 无效（scope 不匹配） |
| 404 | — | Safe 不存在 |
| 201 | 0 | 创建成功（create/propose 返回 201） |
| 5xx | — | 内部错误（链 RPC 不可达、链上部署失败等） |
