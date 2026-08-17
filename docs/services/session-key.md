# session-key 服务（会话密钥授权引擎）使用指南（:3500）

> 最后更新：2026-08-11 | 生产状态：🟢 已验证可用（2026-08-11 生产实测）

## 0. 快速开始（Quick Start）

**1）安装**

```bash
npm install @0xinfrax/session-key-client @0xinfrax/session-key-core @0xinfrax/session-key-evm
```

> session-key 为独立 3 包（不在 `@0xinfrax/infrax-dk` 中）。

**2）获取凭据**

服务端 `SESSION_KEY_API_TOKEN`（`API_TOKENS` 白名单 env，逗号分隔）；`GET /api/v1/nonce`、`POST /api/v1/sessions`、`GET /api/v1/health` 为豁免（公开）端点。

**3）最小示例**

```ts
import { SessionKeyClient } from '@0xinfrax/session-key-client';

const sk = new SessionKeyClient({
  baseUrl: 'http://127.0.0.1:3500',   // 内网直连；网关 https://infrax.0xainet.top/api/session-key（按部署路由）
  apiKey: '<SESSION_KEY_API_TOKEN>',  // 豁免端点外的请求自动带 Bearer
});

// 1. 获取 nonce（公开）→ 用户主钱包展示签名提示消息
const { nonce, message } = await sk.getNonce('0x0000000000000000000000000000000000000001');
console.log(message);

// 2. 创建会话（客户端生成 session keypair 并提交；签名消息中的 sessionAddress = 客户端生成的公钥地址，见下文 §3 签名域）
const session = await sk.createSession({
  signature: '<0xEIP712_SIGNATURE>',
  chain: 'eth',
  permissions: { contracts: ['0xUniswapRouter'], functions: ['0x38ed1739'] },
  validDays: 30,
  maxPerTx: '1000',
  maxTotal: '10000',
  userAddress: '0x0000000000000000000000000000000000000001',
  nonce,
  sessionPublicKey: '<0xSESSION_PUBLIC_KEY>',   // A-16：客户端生成 keypair 后提交公钥地址
  sessionPrivateKey: '<0xSESSION_PRIVATE_KEY>', // 客户端生成的私钥（服务端加密托管，仅用于代签）
});
console.log(session.id, session.sessionAddress);
```

**4）验证**

```bash
curl -s "http://127.0.0.1:3500/api/v1/nonce?user=0x0000000000000000000000000000000000000001"   # 公开，生产实测 200
```

> 完整端点清单 / 鉴权细节 / 错误码见下文对应章节。

## 1. 服务定位

**session-key**（Session Key Engine，v0.1.0）是 InfraX 的**会话密钥授权服务**：用户主钱包一次性 EIP-712 签名授权后，**客户端生成会话密钥对（Session Key）**并提交公钥/私钥，服务端校验派生一致性后加密托管，在有效期内自动代签交易——实现 **Agent 免签名交易（服务端受限代执行）**。

> **能力边界（重要）**：本服务**不是 ERC-4337 智能账户方案**——无 UserOp / Bundler / Paymaster / EntryPoint。会话私钥由**客户端生成**（A-16 修复：EIP-712 签名消息含 sessionAddress，服务端随机生成会签名死锁），提交后由服务端 **AES 加密托管**（`sessionKeyEnc`），`/api/v1/execute` 由服务端解密后经 viem 直接签名广播；授权模型为「用户对会话元数据做 EIP-712 签名 + 服务端白名单/限额执行」。若集成方需要**去信任的链上验证器（ERC-4337）**，属另一条产品线，可与 InfraX 托管钱包 / MPC 能力组合实现。

核心流程：

```
1. GET  /api/v1/nonce?user=0xUser            → 获取一次性 nonce（15 分钟 TTL）+ 签名提示消息
2. 客户端生成 session keypair（address + privateKey），用户主钱包对含该 sessionAddress 的 SessionAuth 消息做 EIP-712 签名
3. POST /api/v1/sessions                     → 提交 sessionPublicKey + sessionPrivateKey（服务端校验派生一致 + 验签，加密托管）
4. POST /api/v1/execute                      → 有效期内自动代签交易（额度/白名单三重校验）
5. DELETE /api/v1/sessions/:id               → 手动撤销授权
```

**生产实测（2026-08-11）**：`GET /api/v1/nonce?user=0x0000000000000000000000000000000000000001` → 200（返回 nonce + 签名 message）。

**网络拓扑**：服务绑定 `127.0.0.1:3500`（生产 nginx 内网转发）；MCP 接入经 `:3011`（Session Key MCP，`sk_nonce`/`sk_create_session`/`sk_execute` 等 7 个工具）。支持链：`eth` / `bsc` / `base` / `polygon` / `arbitrum` / `optimism` / `xlayer` / `sol`。

## 2. 鉴权方式

- **API_TOKENS 白名单**（env 逗号分隔，必配）：除豁免端点外，所有端点需 `Authorization: Bearer <SESSION_KEY_API_TOKEN>`。
- **豁免（公开）**：`GET /api/v1/nonce`、`POST /api/v1/sessions`（创建会话）、`GET /api/v1/health`。
- 鉴权失败语义（与数据栈不同，注意区分）：
  - **401**：未携带 Bearer 头或格式错误 → `{"code":401,"message":"Missing or invalid Bearer token"}`
  - **403**：Bearer 值不在白名单 → `{"code":403,"message":"Invalid API token"}`

## 3. 端点清单

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v1/nonce?user=0x...` | 豁免 | 获取一次性签名 nonce（15 分钟 TTL，消费后失效）。返回 `{nonce, message}`，message 供钱包展示 |
| GET | `/api/v1/health` | 豁免 | 健康检查：`{"status":"ok","service":"session-key-engine"}` |
| POST | `/api/v1/sessions` | 豁免（创建公开，验签把关） | 创建 Session Key。body 见下；成功 **201** `{code:201, data:{id, sessionAddress, status, validUntil}}`；nonce 同时消费 |
| GET | `/api/v1/sessions?user=&chain=&status=` | Bearer | 会话列表（status: active/revoked/expired/quota_exhausted） |
| GET | `/api/v1/sessions/:id` | Bearer | 会话详情 |
| DELETE | `/api/v1/sessions/:id` | Bearer | 撤销会话（`{revoked: true}`） |
| POST | `/api/v1/execute` | Bearer | 通过 Session Key 执行交易（**注意：路径为 `/api/v1/execute`，非 `/sessions/:id/execute`**）。body 见下 |

### Create Session 请求体

```json
{
  "signature": "0x...",                          // 用户主钱包 EIP-712 签名（SessionAuth）
  "chain": "eth",
  "permissions": {
    "contracts": ["0xUniswapRouter"],            // 合约白名单（必填，精确校验）
    "functions": ["0xa9059cbb"]                  // 函数选择器白名单（可选）
  },
  "validDays": 30,                               // 有效期天数（默认 30，建议 7/14/30/90）
  "maxPerTx": "1000",                            // 单笔上限（USDC 单位，默认 1000）
  "maxTotal": "10000",                           // 累计上限（USDC 单位，默认 10000）
  "userAddress": "0xUserWallet",
  "nonce": "abc123...",                          // GET /nonce 返回值
  "sessionPublicKey": "0x...",                   // 客户端生成的会话公钥地址（= 签名消息中的 sessionAddress）
  "sessionPrivateKey": "0x...",                  // 客户端生成的会话私钥（服务端校验派生一致后加密托管）
  "validUntil": 1787040000                       // 可选：客户端签名时使用的 unix 秒；省略则服务端按 validDays 计算
}
```

### Execute 请求体

```json
{
  "sessionId": "uuid",
  "chain": "eth",
  "to": "0xContract",          // 必须命中会话合约白名单
  "data": "0xencodedCallData", // 前 10 字符（4-byte selector）命中函数白名单（若配置）
  "value": "0",                // wei（18 位小数，可选，默认 0）
  "gasLimit": "200000"         // 可选
}
```

### EIP-712 签名域（`packages/evm/src/eip712.ts`）

```
domain: { name: "Session Key Engine", version: "1", chainId: <链 ID> }
types : SessionAuth [
  { name: "nonce",         type: "string"  },
  { name: "sessionAddress",type: "address" },
  { name: "contracts",     type: "string"  },   // permissions.contracts 的 JSON.stringify
  { name: "validUntil",    type: "uint256" },   // now + validDays*86400（秒）
  { name: "maxPerTx",      type: "uint256" },
  { name: "maxTotal",      type: "uint256" },
]
primaryType: "SessionAuth"
```

> 注意（A-16）：`sessionAddress` 由**客户端在本地生成 keypair 后提交**（`generateSessionKey` 派生公钥地址，见 `packages/evm/src/eip712.ts`），服务端仅做「提交私钥派生地址 == 提交公钥地址」的一致性硬校验 + EIP-712 验签（`session-service.ts`）。因此签名环节须**先由客户端生成 keypair**，再用该 sessionAddress 构建 EIP-712 消息由用户主钱包签名，最后连同 sessionPublicKey/sessionPrivateKey 一起提交。

### 安全机制

- **Nonce 防重放**：一次性消费，15 分钟 TTL（NONCE_TTL_MS），过期/重复 → `NONCE_EXPIRED`/`NONCE_INVALID`。
- **三重额度**：有效期（validUntil）+ 单笔上限（maxPerTx）+ 累计上限（maxTotal，成功交易后记账 `totalSpent`）。
- **合约/函数白名单**：`permissions.contracts` 精确校验、`functions` 4-byte selector 校验。
- **私钥加密存储**：AES-256-GCM（`ENCRYPTION_KEY` 注入）；可选 KMS/外部密钥托管接缝（AX-12/SK-4），见 §6。
- **Redis 分布式锁**：`lock:session:<id>` 30 秒防并发执行，命中返回 429 `SESSION_LOCKED`。

## 4. 样例代码

> token 为占位符。BASE_URL 二选一：
> - 直连（仅生产机本机）：`http://127.0.0.1:3500`
> - 内网/网关：`https://infrax.0xainet.top/api/session-key`（按部署路由）
> 非豁免端点需 `Authorization: Bearer <SESSION_KEY_API_TOKEN>`。

### 4.1 curl

```bash
BASE=http://127.0.0.1:3500
TOKEN=<SESSION_KEY_API_TOKEN>

# ── 1. 获取 nonce（公开；生产实测 200）──
curl -s "$BASE/api/v1/nonce?user=0x0000000000000000000000000000000000000001"
# {"code":200,"data":{"nonce":"7f3a...","message":"Session Key Engine\n\nAuthorise a session key to execute transactions on your behalf.\n\nNonce: 7f3a..."},"message":"ok"}

# ── 2. 创建会话（公开端点，但需合法 EIP-712 签名；客户端先生成 keypair，signature 由主钱包按上文签名域生成）──
curl -s -X POST "$BASE/api/v1/sessions" -H "Content-Type: application/json" \
  -d '{
    "signature": "0x<USER_SIGNATURE>",
    "chain": "eth",
    "permissions": {"contracts": ["0xUniswapRouter"], "functions": ["0x38ed1739"]},
    "validDays": 30,
    "maxPerTx": "1000",
    "maxTotal": "10000",
    "userAddress": "0x0000000000000000000000000000000000000001",
    "nonce": "<NONCE_FROM_STEP_1>",
    "sessionPublicKey": "<0xCLIENT_GENERATED_PUBLIC_KEY>",
    "sessionPrivateKey": "<0xCLIENT_GENERATED_PRIVATE_KEY>"
  }'
# {"code":201,"data":{"id":"<sessionId>","sessionAddress":"0x...","status":"active","validUntil":"2026-09-10T..."},"message":"Session created"}

# ── 3. 执行交易（需 Bearer；白名单/额度校验通过后服务端代签广播）──
curl -s -X POST "$BASE/api/v1/execute" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "<sessionId>",
    "chain": "eth",
    "to": "0xUniswapRouter",
    "data": "0x38ed1739...",
    "value": "0",
    "gasLimit": "200000"
  }'
# {"code":200,"data":{"executionId":"uuid","txHash":"0x...","status":"success","gasUsed":"...","errorReason":null},"message":"Transaction sent"}

# ── 4. 会话列表 / 撤销（需 Bearer）──
curl -s "$BASE/api/v1/sessions?user=0x0000000000000000000000000000000000000001&status=active" \
  -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE "$BASE/api/v1/sessions/<sessionId>" -H "Authorization: Bearer $TOKEN"
# {"code":200,"data":{"revoked":true},"message":"ok"}
```

### 4.2 TypeScript SDK（项目自带 client：`@0xinfrax/session-key-client`）

`SessionKeyClient`（`packages/client/src/index.ts`）：`getNonce` / `createSession` / `listSessions` / `getSession` / `revokeSession` / `execute` / `health`。

```bash
npm install @0xinfrax/session-key-client
```

```typescript
import { SessionKeyClient } from '@0xinfrax/session-key-client';
import { signTypedData } from 'viem/accounts';

const sk = new SessionKeyClient({
  baseUrl: 'http://127.0.0.1:3500',
  apiKey: '<SESSION_KEY_API_TOKEN>',   // 豁免端点外的请求自动带 Bearer
});

const userAddress = '0x0000000000000000000000000000000000000001';

// ── 1. 获取 nonce ──
const { nonce, message } = await sk.getNonce(userAddress);
console.log(message); // 用户主钱包展示并签名

// ── 2. 客户端生成 session keypair（A-16：先于签名生成，sessionAddress 进入签名消息）──
import { generateSessionKey, buildSessionAuthMessage } from '@0xinfrax/session-key-evm';
const sessionKey = generateSessionKey(); // { address, privateKey }

// ── 3. EIP-712 签名（SessionAuth，域 "Session Key Engine" v1 + chainId）──
// 注意：签名消息中的 sessionAddress = 上面生成的 sessionKey.address（客户端生成，非服务端生成）。
const validUntil = Math.floor(Date.now() / 1000) + 30 * 86400;
const { domain, types, primaryType, message } = buildSessionAuthMessage({
  nonce,
  chainId: 1,
  sessionAddress: sessionKey.address,          // 客户端生成的会话公钥地址
  permissions: { contracts: ['0xUniswapRouter'] },
  validUntil,
  maxPerTx: '1000',
  maxTotal: '10000',
});
const signature = await signTypedData({
  privateKey: userPrivateKey, // 用户主钱包私钥（仅本地签名，不上传）
  domain,
  types,
  primaryType,
  message,
});

// ── 4. 创建会话（提交客户端 keypair，签名通过后返回会话 id + sessionAddress）──
const session = await sk.createSession({
  signature,
  chain: 'eth',
  permissions: { contracts: ['0xUniswapRouter'], functions: ['0x38ed1739'] },
  validDays: 30,
  maxPerTx: '1000',
  maxTotal: '10000',
  userAddress,
  nonce,
  sessionPublicKey: sessionKey.address,    // A-16：提交公钥地址
  sessionPrivateKey: sessionKey.privateKey, // 提交私钥（服务端加密托管，仅用于代签）
  validUntil,                               // 与签名消息中的 validUntil 一致
});
console.log(session.sessionAddress);

// ── 5. 执行交易（Agent 免签名）──
const result = await sk.execute({
  sessionId: session.id,
  chain: 'eth',
  to: '0xUniswapRouter',
  data: '0x38ed1739...',
  value: '0',
  gasLimit: '200000',
});
console.log(result.txHash, result.status);

// ── 6. 列表 / 详情 / 撤销 ──
const sessions = await sk.listSessions(userAddress, 'eth', 'active');
await sk.getSession(session.id);
await sk.revokeSession(session.id);
```

### 4.3 常见错误码

响应结构 `{"code": <status>, "message": ..., "errorCode": ...}`：

| 状态码 | errorCode | 含义 | 排查建议 |
|---|---|---|---|
| 400 | `NONCE_INVALID` / `NONCE_EXPIRED` | nonce 无效 / 过期（15min TTL，一次性） | 重新 `GET /nonce` |
| 400 | `INVALID_SIGNATURE` | EIP-712 签名与 userAddress 不匹配 | 核对签名域（name/version/chainId）与消息字段 |
| 400 | `DUPLICATE_SESSION` | 同用户+链+合约组合已有活动会话 | 复用现有会话或先撤销 |
| 400 | `PER_TX_EXCEEDED` / `QUOTA_EXHAUSTED` | 超单笔上限 / 累计上限（会话转 quota_exhausted） | 调高额度或新建会话 |
| 400 | `SESSION_EXPIRED` / `SESSION_REVOKED` | 会话过期 / 已撤销 | 新建会话 |
| 403 | — | Bearer token 不在 API_TOKENS 白名单 | 检查 token 配置 |
| 403 | `CONTRACT_FORBIDDEN` / `FUNCTION_FORBIDDEN` | to / data selector 未命中白名单 | 核对 permissions 配置 |
| 404 | `SESSION_NOT_FOUND` | 会话 id 不存在 | 确认 sessionId |
| 429 | `SESSION_LOCKED` | 会话正在执行（Redis 锁 30s） | 稍后重试 |
| 401 | — | 未携带 Bearer 头 | 非豁免端点必须携带 token |

## 5. 代付授权模板（Agent 自主付费 / pay-per-call）

> SK-1：面向「Agent 自主付费」场景的典型代付授权模板——`contracts=[Escrow/Vault 地址], functions=[deposit]`（或 x402 payTo 转账）的一键 SessionAuth 生成。集成方（如 AgentX）可据此快速生成"只允许付给金库、限额定次"的会话。

### 5.1 模板函数

```ts
import { SessionKeyClient } from '@0xinfrax/session-key-client';
import { generateSessionKey, buildSessionAuthMessage } from '@0xinfrax/session-key-evm';
import { signTypedData } from 'viem/accounts';

// 合约函数选择器（可用 viem toFunctionSelector 现场计算，勿硬编码）
const SELECTORS = {
  deposit: '0xd0e30db0',              // deposit() — 原生币充值金库
  depositERC20: '0x97feb926',         // depositERC20(address,uint256) — 稳定币充值金库
  transfer: '0xa9059cbb',             // transfer(address,uint256) — ERC20 转账
};

export interface DelegationSpec {
  userAddress: string;          // 用户主钱包地址
  userPrivateKey: string;       // 用户主钱包私钥（仅本地签名，不上传）
  chain: 'eth' | 'bsc' | 'base' | 'polygon' | 'arbitrum' | 'optimism' | 'xlayer';
  chainId: number;              // 签名域 chainId
  /** 授权目标。二选一： */
  mode: 'escrow-deposit' | 'escrow-deposit-erc20' | 'x402-pay';
  escrowAddress?: string;       // mode 含 escrow 时必填（InfraXEscrow 金库地址）
  stablecoinAddress?: string;   // escrow-deposit-erc20 时的 ERC20 token 地址
  x402PayTo?: string;           // x402-pay 时的收款地址（payTo）
  priceUsd: string;             // maxPerTx/maxTotal 限额（USDC 单位）
  validDays?: number;           // 默认 30
}

/** 一键生成"只允许付给金库/收款方、限额定次"的会话（创建后返回 session + 可直接执行） */
export async function createPayDelegation(spec: DelegationSpec, sk: SessionKeyClient) {
  const { nonce } = await sk.getNonce(spec.userAddress);

  // 1. 客户端生成 session keypair（A-16：sessionAddress 必须进入签名消息）
  const sessionKey = generateSessionKey();

  // 2. 按代付模式构建白名单
  let contracts: string[];
  let functions: string[] | undefined;
  if (spec.mode === 'escrow-deposit') {
    contracts = [spec.escrowAddress!];
    functions = [SELECTORS.deposit];                  // 只允许 deposit()
  } else if (spec.mode === 'escrow-deposit-erc20') {
    contracts = [spec.escrowAddress!, spec.stablecoinAddress!];
    functions = [SELECTORS.depositERC20, SELECTORS.transfer]; // approve 由用户主钱包另签；此处仅 deposit 走 session
  } else { // x402-pay
    contracts = [spec.x402PayTo!];
    functions = undefined;                            // 纯 value 转账，data=0x，不限制函数
  }

  // 3. 构建 SessionAuth 并签名（validUntil 需与会话创建请求一致）
  const validUntil = Math.floor(Date.now() / 1000) + (spec.validDays ?? 30) * 86400;
  const typed = buildSessionAuthMessage({
    nonce,
    chainId: spec.chainId,
    sessionAddress: sessionKey.address,
    permissions: { contracts, functions },
    validUntil,
    maxPerTx: spec.priceUsd,
    maxTotal: spec.priceUsd,
  });
  const signature = await signTypedData({
    privateKey: spec.userPrivateKey as `0x${string}`,
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });

  // 4. 创建会话（提交客户端 keypair）
  return sk.createSession({
    signature,
    chain: spec.chain,
    permissions: { contracts, functions },
    validDays: spec.validDays ?? 30,
    maxPerTx: spec.priceUsd,
    maxTotal: spec.priceUsd,
    userAddress: spec.userAddress,
    nonce,
    sessionPublicKey: sessionKey.address,
    sessionPrivateKey: sessionKey.privateKey,
    validUntil,
  });
}
```

### 5.2 使用示例

```ts
const sk = new SessionKeyClient({ baseUrl: 'http://127.0.0.1:3500', apiKey: '<SESSION_KEY_API_TOKEN>' });

// 示例 A：只允许给 Escrow 金库充值原生币（deposit()），单笔/累计 ≤ $50
const escrowSes = await createPayDelegation({
  userAddress: '0xUserWallet', userPrivateKey: '0x<USER_PK>',
  chain: 'base', chainId: 8453,
  mode: 'escrow-deposit', escrowAddress: '0x<ESCROW_CONTRACT>',
  priceUsd: '50',
}, sk);

// 充值执行：value=1 ETH（单位 wei），data=deposit()，命中白名单 → 服务端代签广播
await sk.execute({
  sessionId: escrowSes.id, chain: 'base',
  to: '0x<ESCROW_CONTRACT>',
  data: '0xd0e30db0',
  value: '1000000000000000000',
});

// 示例 B：x402 按次付费（payTo 收款地址 + 纯 value 转账，无函数白名单）
const paySes = await createPayDelegation({
  userAddress: '0xUserWallet', userPrivateKey: '0x<USER_PK>',
  chain: 'oxachain', chainId: <OXA_CHAIN_ID>,
  mode: 'x402-pay', x402PayTo: '0x<PAYTO_ADDRESS>',
  priceUsd: '5',
}, sk);

await sk.execute({
  sessionId: paySes.id, chain: 'oxachain',
  to: '0x<PAYTO_ADDRESS>',
  data: '0x', value: '5000000000000000', // 等价 x402 priceWei
});
```

> 安全提示：session 会话是"限额定次"的代签授权——被授权的函数集仅限充值/付款路径（deposit/depositERC20/x402 转账），**不应**把 `withdraw`/`refund`（`0x2e1a7d4d`）等出金函数加入白名单；一旦授权即等价于给会话"花多少、付给谁"的能力，请按最小权限原则设置 `maxPerTx`/`maxTotal` 与有效期，并在任务完成后 `DELETE /api/v1/sessions/:id` 撤销。

## 6. 密钥托管接缝（AX-12/SK-4：可选 KMS / 外部密钥服务）

> 默认路径为 **EnvKeyVault**（`ENCRYPTION_KEY` 32 字节 hex + AES-256-GCM）。集成方可注入自己的密钥托管实现（AWS/GCP KMS 代理、HashiCorp Vault transit、自建密钥网关），让**会话私钥不落明文 env**，由外部密钥管理系统托管加解密。

### 6.1 配置

| env | 默认 | 说明 |
|---|---|---|
| `KEY_VAULT_TYPE` | `env` | `env` = 本地 ENCRYPTION_KEY；`http` = 转发外部密钥服务 |
| `KEY_VAULT_URL` | — | `KEY_VAULT_TYPE=http` 时必填，外部密钥服务 baseUrl |
| `KEY_VAULT_TOKEN` | — | 可选 Bearer token，转发时带 `Authorization: Bearer <token>` |
| `ENCRYPTION_KEY` | — | `env` 模式必填，32 字节 hex（64 字符） |

### 6.2 HTTP 托管协议（`HttpKeyVault` 现成实现）

`KEY_VAULT_TYPE=http` 时服务端把加解密转发给外部服务：

```
POST {KEY_VAULT_URL}/vault/encrypt  body {"plaintext": string}  → {"ciphertext": string}
POST {KEY_VAULT_URL}/vault/decrypt  body {"ciphertext": string} → {"plaintext": string}
```

### 6.3 代码接缝

核心包导出 `IKeyVault`（`encrypt`/`decrypt`，均为 Promise）与默认实现 `EnvKeyVault`；服务端 `buildKeyVault(config.keyVault)` 按 `KEY_VAULT_TYPE` 选择实现，并通过 `EvmAdapter` 第二参数注入（`packages/server/src/app.ts`）：

```ts
import { IKeyVault } from '@0xinfrax/session-key-core';

// 自建实现（如 AWS/GCP KMS 代理）——实现 IKeyVault 后即可替换默认路径
class MyKmsVault implements IKeyVault {
  async encrypt(plaintext: string): Promise<string> { /* KMS 加密 */ }
  async decrypt(ciphertext: string): Promise<string> { /* KMS 解密 */ }
}
```

> 说明：`IKeyVault`/`EnvKeyVault` 由 `@0xinfrax/session-key-core@0.2.2` 导出；`EvmAdapter` 第二参数注入密钥托管（`@0xinfrax/session-key-evm@0.1.3`，`encryptKey`/`decryptKey` 走该接缝）；`HttpKeyVault`/`buildKeyVault` 在 server（`packages/server/src/services/key-vault.ts`）中提供。

## 参考

- 源码：`projects/session-key/packages/server/src/routes/index.ts`（端点）、`plugins/auth.ts`（API_TOKENS 白名单）、`services/{nonce,session,execution}-service.ts`（nonce 消费 / 验签 / 三重校验）、`packages/evm/src/eip712.ts`（签名域）
- Client SDK：`projects/session-key/packages/client/src/index.ts`（npm：@0xinfrax/session-key-client）
- PRD / 设计：`docs/SESSION_KEY_ENGINE_PRD.md`、`docs/SESSION_KEY_ENGINE_DEV_PLAN.md`；MCP 接入见 `docs/API_ACCESS.md`（:3011，7 工具）
