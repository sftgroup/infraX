# WaaS 钱包即服务 使用指南（:9109）

> 最后更新：2026-08-19 | 生产状态：🟢 已验证可用（2026-08-19 WAAS 16 项安全优化部署 + 冒烟测试通过）

## 0. 快速开始（Quick Start）

**1）安装**

```bash
npm install @0xinfrax/infrax-dk
```

**2）获取凭据**

订阅套餐目录（`/api/v2/subscription/plans`）为公开端点；受保护端点需**租户 API key**——经 `POST /api/v2/saas/tenants/:tenantId/apikey`（服务端管理操作）签发，或钱包签名（EIP-191）走 `POST /api/v2/saas/apikeys` 生成；`infra.wallet.*` 另需配置 `walletAddress` + `walletSign`（未配置时 fail-closed 明确抛错）。

**3）最小示例**

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  baseUrl: 'http://127.0.0.1:9109',   // 内网直连；公网 baseUrl 用 https://infrax.0xainet.top
  apiKey: process.env.WAAS_TENANT_API_KEY, // 租户 API key（自动带 x-api-key 头）
});

// 订阅套餐目录（公开；生产实测 200：Starter free / Pro 49 / Enterprise 199）
const plans = await infrax.sub.plans();
console.log(plans.data);
```

**4）验证**

```bash
curl -s http://127.0.0.1:9109/health
# 或公网经代理：curl -s https://infrax.0xainet.top/api/v2/subscription/plans
```

> 完整端点清单 / 鉴权细节 / 错误码见下文对应章节。

## 1. 服务定位

钱包即服务 B2B 平台（systemd `infrax-waas`，DB `pocketx_waas`）：托管钱包 / HD 地址分配、交易（send/estimate-gas/sweep）、SaaS 租户管理（tenant CRUD + API key + 归集/提现）、订阅计费（MQ-12，支付走通用支付引擎 :9132）。`/api/v2/*` 按模块挂载：`wallet` / `tx` / `saas` / `subscription` / `data`（DC 数据订阅）/ `auth` / `risk` / `events` / `dashboard`。

生产访问：
- 内网直连 `http://127.0.0.1:9109`
- 公网经 nginx→web 代理（自动注入 `X-Service-Key`）：
  - `https://infrax.0xainet.top/api/v2/wallet/...`
  - `https://infrax.0xainet.top/api/v2/saas/...`
  - `https://infrax.0xainet.top/api/v2/subscription/...`

### 1.1 签名模型（类 CEX 托管：平台内部签名，外部零链上签名）

WAAS 定位为**类中心化交易所（CEX）的托管模型**，链上签名全部发生在平台内部，B 端 / C 端用户**全程无链上签名动作**：

- **私钥归属**：平台托管（`custodial_wallets` + `address_pool` 地址池）。B 端租户从地址池分配地址给自己的用户，B 端与用户**均不持有私钥**。
- **充值**：用户向分配地址打币 → 平台链上监控确认 → 入账（用户侧无签名）。
- **提币**：用户发起请求 → **B 端业务审批**（风控策略 / 后台审核）→ **平台托管私钥签名广播**。提币授权 = `paymentPassword`（资金密码，类似 CEX 资金密码）+ B 端审批，**不是**链上签名。
- **`walletSign`（EIP-191）仅用于 API 身份认证**：识别"请求来自该钱包地址的所有者"（服务端按地址 24h 缓存，同一地址 24h 内只需签一次），**并非**钱包操作签名，也不代表用户持有托管钱包私钥。

## 2. 鉴权方式

三种鉴权并存（按端点组区分）：

1. **钱包签名（EIP-191）**——`/api/v2/wallet/*`、`/api/v2/tx/*`、以及 saas 的租户自身操作（`/api/v2/saas/apikeys` 等）：
   - 三个 header：`x-wallet-address` + `x-wallet-signature` + `x-wallet-timestamp`
   - 签名消息：`InfraX auth: <timestamp>`（毫秒时间戳），服务端 `ethers.verifyMessage` 恢复地址比对
   - 24h session cache：同一地址 24h 内无需重复签名（服务端内存缓存）
   - SDK `infra.wallet.*` 配置 `walletAddress` + `walletSign` 回调后**自动生成**这三个 header；未配置时 fail-closed 明确抛错
2. **租户 API key**——`/api/v2/saas/*`（`x-api-key`，`requireTenantApiKey` 校验 tenant 表）；平台签发的 admin/tenant key 走 `requireApiKey`（`api_keys` 表 SHA-256 哈希）
3. **公开**——`/api/v2/subscription/plans`、`/api/v2/data/plans`、`/health`

响应统一信封 `{code, message, data}`。外部回调 `/api/v2/subscription/payment-callback` 用 HMAC-SHA256 验签（`x-payments-signature`）。

## 3. 端点清单

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 公开 | 健康检查（version 2.0.0） |
| GET | `/api/v2/subscription/plans` | **公开** | 订阅套餐目录（Starter free / Pro 49 / Enterprise 199，含 features 配额） |
| GET | `/api/v2/subscription/me` | 钱包签名 | 当前用户订阅状态（无订阅回退 Starter/free） |
| POST | `/api/v2/subscription/subscribe` | 钱包签名 | 订阅，body `{planId, rail?}`（rail: chain/fiat/x402；free 直激活，付费返回 pending + payment 意图） |
| POST | `/api/v2/subscription/check` | 钱包签名 | 轮询支付状态（chain rail 链上确认 → active） |
| POST | `/api/v2/subscription/verify` | 钱包签名 | x402 确认，body `{txHash}`（payer 需匹配 x-wallet-address，否则 409） |
| POST | `/api/v2/subscription/payment-callback` | HMAC 验签 | 支付引擎出站回调（webhook/credit，`sub:` 前缀激活） |
| POST | `/api/v2/subscription/cancel` | 钱包签名 | 取消当前 active 订阅 |
| GET | `/api/v2/wallet/balance?address=&chain=&token=` | 钱包签名 | 钱包余额 |
| POST | `/api/v2/wallet/rpc` | 钱包签名 | 经钱包网关执行 RPC |
| POST | `/api/v2/tx/send` | 钱包签名 | 发交易 |
| POST | `/api/v2/tx/estimate-gas` | 钱包签名 | 估算 gas（simulate） |
| POST | `/api/v2/tx/sweep` | 钱包签名 | 归集扫币 |
| GET | `/api/v2/tx/status/:txHash` | 钱包签名 | 交易状态 |
| POST | `/api/v2/saas/tenants` | admin | 注册企业租户（body `{name, contactEmail, webhookUrl?}`） |
| GET | `/api/v2/saas/tenants` | admin | 租户列表 |
| GET | `/api/v2/saas/tenants/:id` | admin | 租户详情 |
| PATCH | `/api/v2/saas/tenants/:id` | admin | 更新租户配置 |
| DELETE | `/api/v2/saas/tenants/:id` | admin | 挂起租户 |
| POST | `/api/v2/saas/tenants/:tenantId/apikey` | 服务端 | **签发租户 API key**（`{apiKey}`；`/rotate` 轮换、DELETE 删除） |
| GET | `/api/v2/saas/apikeys` | 钱包签名 | 当前租户 key 列表 |
| POST | `/api/v2/saas/apikeys` | 钱包签名 | 生成租户新 key |
| POST | `/api/v2/saas/apikeys/:id/rotate` | 钱包签名 | 轮换 key |
| DELETE | `/api/v2/saas/apikeys/:id` | 钱包签名 | 吊销 key |
| POST | `/api/v2/saas/address` | 钱包签名 / tenant key | 分配地址（body `{externalUserId, chain, label?}`） |
| GET | `/api/v2/saas/address/:userId` | tenant key | 地址详情 |
| GET | `/api/v2/saas/balances` | tenant key | 租户余额总览 |
| GET | `/api/v2/saas/transactions` | tenant key | 租户交易历史 |
| GET | `/api/v2/data/plans` | **公开** | DC 数据套餐（data_free/pro/enterprise） |
| POST | `/api/v2/data/subscribe` | 钱包签名 | 订阅 DC 套餐（`{planId}` → 返回 `dcApiKey`） |
| GET | `/api/v2/data/usage` | 钱包签名 | DC 订阅用量 |
| GET | `/api/v2/data/key` | 钱包签名 | 获取/轮换 DC API key（`?regenerate=true`） |
| POST | `/api/v2/auth/totp/setup` | 钱包签名 | W-15 TOTP 绑定（返回 `secret` + `otpauthUrl`，未启用） |
| POST | `/api/v2/auth/totp/enable` | 钱包签名 | W-15 TOTP 激活（body `{code}`） |
| POST | `/api/v2/auth/totp/disable` | 钱包签名 | W-15 TOTP 关闭（body `{code}`，需当前有效码） |
| GET | `/api/v2/auth/totp/status` | 钱包签名 | W-15 TOTP 状态（`{configured, enabled}`） |
| GET | `/api/v2/internal/config` | admin | W-14 SystemConfig 白名单列表（敏感值脱敏回显） |
| PUT | `/api/v2/internal/config/:key` | admin | W-14 写白名单配置（body `{value}`；非白名单 key 403） |

**W-15 TOTP 强制场景**（用户启用 TOTP 后，以下资金操作必须带 `totpCode`，否则 400）：
- `POST /api/v2/tx/send`（body 增 `idempotencyKey?`、`totpCode?`）——W-8 幂等键：相同 `idempotencyKey` 命中直接返回既有结果，不重复广播
- `POST /api/v2/tx/:id/confirm`（body 增 `totpCode?`）
- `POST /api/v2/saas/withdraw`、`POST /api/v2/saas/withdraw/:id/approve`
- `POST /api/v2/subscription/subscribe`、`POST /api/v2/data/subscribe`

> ⚠️ 生产访问注意（2026-08-19 复核）：waas 目前**仅内网直连** `http://127.0.0.1:9109`，生产 nginx 无 waas 公网映射（钱包 API 属资金敏感服务，未公网暴露）。旧文档中「公网经 nginx→web 代理 `/api/v2/wallet` 等」路径当前不再成立，如需公网接入需另配代理并加服务端鉴权。

## 4. 样例代码

### 4.1 curl（内网直连 + 公网经代理两种）

```bash
# ═══ 内网直连 ═══
BASE=http://127.0.0.1:9109

# ═══ 公网经 nginx→web 代理（:9111）═══
# BASE=https://infrax.0xainet.top

# ── 套餐列表（公开，生产实测 200：Starter free / MPC Wallets 3 / Safe 3 等）──
curl -s $BASE/api/v2/subscription/plans

# ── 钱包签名鉴权（/api/v2/wallet、/api/v2/tx、订阅操作需 EIP-191 签名头）──
TS=$(date +%s%3N)
SIG=$(node -e "const {Wallet}=require('ethers');const w=new Wallet('<WALLET_PRIVATE_KEY>');w.signMessage('InfraX auth: '+process.argv[1]).then(s=>console.log(s))" $TS)
WALLET_HDRS='-H "x-wallet-address: <WALLET_ADDRESS>" -H "x-wallet-signature: '$SIG'" -H "x-wallet-timestamp: '$TS'"'

# ── 订阅免费套餐（钱包签名，free 直激活）──
curl -s -X POST $BASE/api/v2/subscription/subscribe \
  -H 'Content-Type: application/json' -H "x-wallet-address: <WALLET_ADDRESS>" \
  -H "x-wallet-signature: $SIG" -H "x-wallet-timestamp: $TS" \
  -d '{"planId":"free"}'
# → {"code":0,"message":"Subscribed","data":{"subscription":{...},"payment":{"rail":"none"}}}

# ── 租户 API key 签发（服务端管理端点；也可钱包签名走 /api/v2/saas/apikeys）──
curl -s -X POST $BASE/api/v2/saas/tenants/<TENANT_ID>/apikey \
  -H "x-api-key: <WAAS_TENANT_API_KEY>"
# → {"code":0,"message":"success","data":{"apiKey":"<TENANT_KEY>"}}
```

### 4.2 JS SDK（@0xinfrax/infrax-dk v0.6.0）

```ts
import { InfraX } from '@0xinfrax/infrax-dk';
import { Wallet } from 'ethers';

const signer = new Wallet(process.env.WALLET_PRIVATE_KEY!); // EIP-191 签名者

const infrax = new InfraX({
  baseUrl: 'http://127.0.0.1:9109',      // 内网直连；公网 baseUrl 用 https://infrax.0xainet.top
  walletAddress: signer.address,          // x-wallet-address
  walletSign: (msg) => signer.signMessage(msg), // EIP-191 签名回调（x-wallet-signature）
});

// ── 套餐目录（公开，无需签名）──
const plans = await infrax.sub.plans();   // GET /api/v2/subscription/plans
console.log(plans.data); // Starter(free)/Pro/Enterprise

// ── 订阅套餐（钱包签名自动带上；free 直激活，付费返回 pending 支付意图）──
const sub = await infrax.sub.subscribe('free');
console.log(sub.data.subscription.status); // 'active'

// ── 当前订阅 ──
const cur = await infrax.sub.current();

// ── 钱包操作（wallet.* 自动生成签名头）──
const bal = await infrax.wallet.balance({ address: signer.address, chain: 'sepolia' });
// 发送：签名 send({ walletId, toAddress, amount, chain, paymentPassword, tokenAddress? })，经 /api/v2/tx/send
await infrax.wallet.send({
  walletId: '<WALLET_ID>',        // 托管钱包 ID（wallet.balance 响应中的 id）
  toAddress: '0x...',
  amount: '0.01',
  chain: 'sepolia',
  paymentPassword: process.env.WALLET_PAYMENT_PASSWORD!,  // 平台托管钱包支付密码（必填）
});

// ── SaaS：租户 API key 创建 / 轮换（saas.*）──
const key = await infrax.saas.createApiKey('<TENANT_ID>'); // POST /api/v2/saas/tenants/:id/apikey
console.log(key.data.apiKey);
await infrax.saas.rotateApiKey('<TENANT_ID>');
```

### 4.3 常见错误码

| HTTP | code | 场景 |
|---|---|---|
| 400 | 1001 | 缺少必填字段（subscribe 缺 planId / verify 缺 txHash 等） |
| 401 | 401/1002 | 缺/错钱包签名头（`Missing x-wallet-address` / `Invalid signature` / `Signature expired`）；缺租户 x-api-key |
| 409 | 1001 | `verify` 时 tx payer 与当前 x-wallet-address 不匹配 |
| 404 | 2002 | 无租户 / 订阅不存在 |
| 502 | 1003 | 支付引擎（:9132）不可达 |
| 503 | 1003 | `/payment-callback` 未配置 webhook secret |
| 403 | 1002 | W-14 写非白名单 config key；W-15 错 TOTP 码 / 启用后缺失（400） |

## 5. 安全与可靠性增强（2026-08-19 部署）

依据 arb 上传的 WAAS 设计方案（`prd/arbitrage-waas-design.md`）对照评审，落地 16 项优化（清单见 `docs/infrax_tasklist.md §9.9`，全部通过 `tsc --noEmit`）：

| 编号 | 优化 | 说明 |
|---|---|---|
| W-1 | 充值入账原子化 | 余额 UPDATE / 入账 INSERT / webhook 同事务；`transactions` 加 `UNIQUE(wallet_id, tx_hash)` 部分唯一索引 + `ON CONFLICT DO NOTHING` |
| W-2 | 确认数门槛 | 扫描到未达确认数 → `deposit_pending` 两段式入账；`receipt.blockNumber` 与当前块号对比（`MIN_CONFIRMATIONS` 按 chainId） |
| W-3 | 广播重试 | 广播失败 → `retrying` + `retry_count`；worker（30s 周期）重试，≥3 次 → `failed`（资金回退语义） |
| W-4 | gas 熔断 | 广播前检查 gas pool 余额（`GAS_POOL_ALERT_THRESHOLD`，默认 0.05），不足 → `gas_blocked` |
| W-5/W-6/W-7 | 风控 USD 口径 | 先 `convertToUsd` 再判限额；日限额仅计**出账**（`from_address=钱包`）、排除 failed/rejected、纳入 pending 态；`getUserLimits` 应用 DB `risk_rules` 参数 |
| W-8 | 幂等键 | `idempotency_key` 部分唯一索引；命中返回既有结果，防双击/超时重试重复广播 |
| W-9 | 分布式锁 | PG `pg_try_advisory_lock`（零依赖）`withLock` 接入 block-scan / 广播重试 / sweep / 冷热归集调度，多实例不重复执行 |
| W-10 | DRY_RUN | `DRY_RUN=true` 模拟广播（随机 hash 落审计），不触链上 |
| W-11/W-12 | sweep 闭环 | `sweepTenantFunds` 改用**链上真实余额** + dust/gas 阈值建 pending；执行器 `processPendingSweeps` 解密 HD 私钥广播确认；`batch_id` 聚合审计 |
| W-13 | 生产 fail-closed | 生产缺 `HD_WALLET_SEED` / `WALLET_ENCRYPTION_KEY` 启动即抛错（⚠️ 见下方部署注意） |
| W-14 | SystemConfig | `system_config` 表白名单配置（risk_*/sig_*/gas_pool_*/sweep_*/hot_wallet_*/webhook_*），admin 端点读写，敏感值脱敏回显 |
| W-15 | TOTP 2FA | RFC 6238（SHA-1/6 位/30s±1，node crypto 零依赖）；提现/审批/发送/购买强校验 |
| W-16 | 冷热分离 | 热钱包原生余额超 `HOT_WALLET_COLD_SWEEP_THRESHOLD`（默认 5.0）自动排期归集 master wallet |

**新增配置项（env）**：`GAS_POOL_ALERT_THRESHOLD`、`DRY_RUN`、`SWEEP_WORKER_INTERVAL_MS`（默认 30000）、`SWEEP_DUST_THRESHOLD`、`SWEEP_GAS_RESERVE`、`HOT_WALLET_COLD_SWEEP_THRESHOLD`、`MIN_CONFIRMATIONS`（按 chainId JSON）。

**部署记录（2026-08-19）**：commit `f3154eb`（16 项主体）+ `18b731f`（购买链路 TOTP）+ `92552ff`/`ef8a180`（生产冒烟修复：`/internal/config` 补挂 authenticate、`setupTotp` SQL 占位符）。DB 迁移随 `initDatabase` 自动执行，已核验：`transactions` 新列/新 CHECK、`deposit_pending`/`system_config` 表、`sweep_records` 新列、`users.totp_*`、两个唯一索引全部落库。

> ⚠️ **W-13 部署注意**：生产 unit 当前**未设 `NODE_ENV`**（服务按 development 运行），且未配置 `HD_WALLET_SEED` / `WALLET_ENCRYPTION_KEY`——因此生产暂未触发 fail-closed。若要真正启用 W-13，需在 systemd unit 补 `NODE_ENV=production` **并同时**提供上述两个密钥（涉及托管私钥派生，换值会导致旧派生地址无法解密，需评审后执行）。
