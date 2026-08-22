# MPC 多方计算钱包 使用指南（:9104）

> 最后更新：2026-08-11 | 生产状态：🟢 已验证可用（2026-08-11 生产实测）

## 0. 快速开始（Quick Start）

**1）安装**

```bash
npm install @0xinfrax/infrax-dk
```

**2）获取凭据**

平台 `MPC_API_KEY`（bridge key），或 data 服务签发的 scope=`mpc` 外部 key（`mp_` 前缀）。`/api/v2/mpc/plans` 公开豁免；注册/会话/签名等操作还需邮件验证码与 `mpc_` 会话令牌（见下文对应章节）。

**3）最小示例**

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  baseUrl: 'http://127.0.0.1:9104',   // 内网直连；公网 baseUrl 用 https://infrax.0xainet.top
  apiKey: process.env.MPC_API_KEY,    // 自动带 x-api-key 头
});

// 按量费率表（公开；生产实测 200：mode=pay_per_use + 费率表）
const plans = await infrax.mpc.plans();
console.log(plans.data.mode, plans.data.platformAddress, plans.data.fees);
```

**4）验证**

```bash
curl -s http://127.0.0.1:9104/api/v2/mpc/plans   # 公开，生产实测 200
```

> 完整端点清单 / 鉴权细节 / 错误码见下文对应章节。

## 1. 服务定位

**MPC（多方计算钱包 / Agent Wallet）**是 InfraX 的密钥分片托管钱包服务（`projects/mpc/server.ts`，独立 PostgreSQL `infrax_mpc`；签名链路经 TSS 签名器 :9200/:9201 完成 2-of-2 分片签名，完整私钥不落库、不重建）。

- **邮件验证码**：`send-code` 下发 6 位验证码（SMTP 真实发信；5 分钟过期、5 次尝试上限、哈希落库）。
- **密钥分片**：注册时 TSS 2-of-2 分片（片 1 服务端 AES 加密、片 2 RecoveryKey 加密，双片密钥上下文分离），支持 `register` / `recover` / `status` / `wallets`。
- **Agent Wallet 会话**：`session/unlock` 解锁 → 返回 `mpc_` 会话令牌（默认 30 分钟、落库可跨重启），凭令牌执行签名 / 合约 / 转账操作。
- **按量计费（MQ-16 T-4）**：预付费 ledger 模式——签名类操作单价 0.0001 ETH、写链类 0.001 ETH（`src/mpcPlans.ts` 可 env 覆盖），每次调用从引擎账本按次扣费，**余额不足 → 402 + 充值提示**。
- **生产实测（2026-08-11）**：`GET /api/v2/mpc/plans` 200——`mode=pay_per_use`、`platformAddress=0x52ec...`、sign_message 等费率表正常返回。

## 2. 鉴权方式

| 面 | 端点 | 鉴权 |
|---|---|---|
| 全局 | 除下方豁免外全部端点 | **平台统一 key**：`Authorization: Bearer <key>` / `X-API-Key: <key>` / `X-Service-Key: <key>` 三选一；本地 `MPC_API_KEY`（bridge key）或 data 服务签发的 `mp_` key（scope=mpc，经 data `/api-keys/verify` 实时校验） |
| 豁免 | `/health`、`/metrics`、`/api/v2/mpc/plans` | **公开**（plans 为费率表，豁免放行） |
| 操作级 | `sign-message`、`sign-typed-data`、`sign-digest`、`send-transaction`、`contract-write`、`balance`、`contract-read`、`gas-estimate`、`ledger-balance`、`session/status` | key 之外还需 **body `token`（session token，`mpc_` 前缀）**；计费端点经 `mpcMeter` 按次扣费 |
| 计费 | 签名/写链端点 | 预付费 ledger：余额不足 → **402**；引擎未配置（开发环境）→ 免费放行 |

- key 缺失/无效 → 401 `{"detail":"unauthorized"}`（统一契约，fail-closed）。
- 会话令牌：`session/unlock` 返回 `token`（`mpc_` 前缀）；过期/无效 → 401；锁定后失效。

## 3. 端点清单（`/api/v2/mpc`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/v2/mpc/send-code` | key | 下发邮箱验证码（body：`email`） |
| POST | `/api/v2/mpc/register` | key | 注册托管钱包（body：`email`+`code`+可选 `walletAddress`；1 邮箱可派生多子钱包） |
| POST | `/api/v2/mpc/recover` | key | 恢复钱包（body：`email`+`code`+可选 `walletId`；分片重建+地址校验） |
| GET | `/api/v2/mpc/status` | key | 钱包状态（`email` 或 `walletAddress` 双查询键，可选 `walletId`） |
| GET | `/api/v2/mpc/wallets` | key | 同邮箱全部子钱包列表（`email`） |
| POST | `/api/v2/mpc/session/unlock` | key | 解锁会话（body：`email`+`code`+可选 `walletId`）→ `mpc_` token |
| POST | `/api/v2/mpc/session/lock` | key | 锁定会话（body：`token`） |
| GET | `/api/v2/mpc/session/status` | key | 会话状态 + 剩余秒数（`token`） |
| POST | `/api/v2/mpc/balance` | key + token | 链上余额（body：`token`+`chain`+可选 `tokenAddress`） |
| POST | `/api/v2/mpc/sign-message` | key + token（计费） | EIP-191 消息签名（body：`token`+`message`） |
| POST | `/api/v2/mpc/sign-typed-data` | key + token（计费） | EIP-712 结构化数据签名（body：`token`+`domain`+`types`+`value`） |
| POST | `/api/v2/mpc/sign-digest` | key + token（计费） | 原始 32B 摘要签名（body：`token`+`digest`；用于 userOpHash 等） |
| POST | `/api/v2/mpc/send-transaction` | key + token（计费） | 转账（body：`token`+`to`+`amount`+`chain`+可选 `tokenAddress`；原生单笔限额默认 0.1 ETH，ERC20 默认 1000） |
| POST | `/api/v2/mpc/contract-read` | key + token | 合约读（body：`token`+`contractAddress`+`abi`+`method`+`args`） |
| POST | `/api/v2/mpc/contract-write` | key + token（计费） | 合约写（body：`token`+`contractAddress`+`abi`+`method`+`args`+可选 `value`；写前模拟校验） |
| POST | `/api/v2/mpc/gas-estimate` | key + token | Gas 估算（body：`token`+`to`/`value`/`data`+`chain`） |
| GET | `/api/v2/mpc/plans` | **公开** | 按量费率表（生产实测 200：mode=pay_per_use、platformAddress、fees[]、topup 路径） |
| POST | `/api/v2/mpc/ledger-balance` | key + token | 引擎 ledger 余额（body：`token`；区别于链上 /balance，含 fees + topupHint） |

> 计费费率（默认，`mpcFees()`）：`sign_message` / `sign_typed_data` / `sign_digest` = 0.0001 ETH；`send_transaction` / `contract_write` = 0.001 ETH。

## 4. 样例代码

### 4.1 curl

```bash
# ① 费率表（公开，无需 key；生产实测 200）
curl -s http://127.0.0.1:9104/api/v2/mpc/plans

# ② 下发验证码（需 key）
curl -s -X POST http://127.0.0.1:9104/api/v2/mpc/send-code \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <MPC_API_KEY>" \
  -d '{"email":"agent@example.com"}'

# ③ 注册钱包（需 key + 验证码；验证码经邮件/服务日志获取）
curl -s -X POST http://127.0.0.1:9104/api/v2/mpc/register \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <MPC_API_KEY>" \
  -d '{"email":"agent@example.com","code":"<6_DIGIT_CODE>"}'

# ④ 解锁会话 → 获得 mpc_ token
curl -s -X POST http://127.0.0.1:9104/api/v2/mpc/session/unlock \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <MPC_API_KEY>" \
  -d '{"email":"agent@example.com","code":"<6_DIGIT_CODE>"}'

# ⑤ ledger 余额（需 key + body token；预付费账本，区别于链上余额）
curl -s -X POST http://127.0.0.1:9104/api/v2/mpc/ledger-balance \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <MPC_API_KEY>" \
  -d '{"token":"<MPC_SESSION_TOKEN>"}'
# 响应：{code:0, data:{address, balanceWei, balance, fees[], topupHint}}

# ⑥ 消息签名（计费端点：余额不足 → 402）
curl -s -X POST http://127.0.0.1:9104/api/v2/mpc/sign-message \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <MPC_API_KEY>" \
  -d '{"token":"<MPC_SESSION_TOKEN>","message":"InfraX agent sign test"}'
```

### 4.2 JS SDK

`infra.mpc.*`（v0.6.0）：`sendCode` / `register` / `recover` / `status` / `createWallet` / `unlockSession` / `lockSession` / `sessionStatus` / `balance` / `signMessage` / `signTypedData` / `sendTransaction` / `contractRead` / `contractWrite` / `gasEstimate` + 计费面 `plans` / `ledgerBalance`。key 经 `apiKey` 配置自动带 `X-API-Key` 头。

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  baseUrl: 'http://127.0.0.1:9104',   // 或公网 baseUrl 用 https://infrax.0xainet.top
  apiKey: process.env.MPC_API_KEY,    // ← 平台统一 key（MPC_API_KEY 或 mp_ key）
});

// 费率表（公开；生产实测 200）
const plans = await infrax.mpc.plans();
console.log(plans.data.mode, plans.data.platformAddress, plans.data.fees);

// 注册流程：发码 → 注册（验证码经邮件/日志获取）
await infrax.mpc.sendCode({ email: 'agent@example.com' });
const created = await infrax.mpc.register({ email: 'agent@example.com', code: '<6_DIGIT_CODE>' });

// 会话：解锁 → 凭 token 操作
const sess = await infrax.mpc.unlockSession({ email: 'agent@example.com', code: '<6_DIGIT_CODE>' });
const token = sess.data.token;

// 计费面：ledger 余额（预付费账本；余额不足时签名/转账返回 402）
const ledger = await infrax.mpc.ledgerBalance(token);

// 链上操作（计费：签名 0.0001 ETH / 写链 0.001 ETH）
const sig = await infrax.mpc.signMessage({ token, message: 'InfraX agent sign test' });
const tx = await infrax.mpc.sendTransaction({ token, to: '0x...', amount: '0.001', chain: 'sepolia' });
```

### 4.3 常见错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | 1001 | 参数缺失/非法（缺 email/code/token、digest 非 32B hex、验证码错误/过期、金额超 Agent 限额或白名单外） |
| 401 | - | 缺/无效 key（`{"detail":"unauthorized"}`）；会话 token 无效/过期/已锁定 |
| 402 | 1001 | **ledger 余额不足**（响应含充值提示：向平台钱包转入原生资产 → 引擎 `/payments/verify` 入账） |
| 404 | 1004 | 未注册钱包（先 register） |
| 429 | - | 验证码尝试超限（5 次） |
| 500 | 1007 | 服务端错误（TSS 分片失败、分片解密失败、私钥重建地址不匹配） |
| 503 | 1007 | 按量计费未配置 / ledger 查询或扣费失败（付费服务不可在无法记账时免费放行） |
