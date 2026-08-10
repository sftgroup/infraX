# session-key 服务（会话密钥授权引擎）使用指南（:3500）

> 最后更新：2026-08-11 | 生产状态：🟢 已验证可用（2026-08-11 生产实测）

## 1. 服务定位

**session-key**（Session Key Engine，v0.1.0）是 InfraX 的**会话密钥授权服务**：用户主钱包一次性 EIP-712 签名授权后，服务端为其生成会话密钥对（Session Key），在有效期内自动代签交易——实现 **Agent 免签名交易**（Bundler/Paymaster 执行路径）。

核心流程：

```
1. GET  /api/v1/nonce?user=0xUser            → 获取一次性 nonce（15 分钟 TTL）+ 签名提示消息
2. 用户主钱包对 SessionAuth 消息做 EIP-712 签名
3. POST /api/v1/sessions                     → 创建 Session Key（服务端生成 sessionAddress，验签通过后加密存储）
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
  "nonce": "abc123..."                           // GET /nonce 返回值
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

> 注意：`sessionAddress` 由**服务端在 createSession 时生成**（`generateSessionKey`）并以其校验签名（`session-service.ts`），即签名内容中的 sessionAddress 需与服务端生成的会话地址一致——签名环节需按服务端生成的地址构建消息，或与客户端预生成地址的集成方式对齐（当前 REST 契约不暴露预生成接口，属服务端设计约束）。

### 安全机制

- **Nonce 防重放**：一次性消费，15 分钟 TTL（NONCE_TTL_MS），过期/重复 → `NONCE_EXPIRED`/`NONCE_INVALID`。
- **三重额度**：有效期（validUntil）+ 单笔上限（maxPerTx）+ 累计上限（maxTotal，成功交易后记账 `totalSpent`）。
- **合约/函数白名单**：`permissions.contracts` 精确校验、`functions` 4-byte selector 校验。
- **私钥加密存储**：AES-256-GCM（`ENCRYPTION_KEY` 注入）。
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

# ── 2. 创建会话（公开端点，但需合法 EIP-712 签名；signature 由主钱包按上文签名域生成）──
curl -s -X POST "$BASE/api/v1/sessions" -H "Content-Type: application/json" \
  -d '{
    "signature": "0x<USER_SIGNATURE>",
    "chain": "eth",
    "permissions": {"contracts": ["0xUniswapRouter"], "functions": ["0x38ed1739"]},
    "validDays": 30,
    "maxPerTx": "1000",
    "maxTotal": "10000",
    "userAddress": "0x0000000000000000000000000000000000000001",
    "nonce": "<NONCE_FROM_STEP_1>"
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

// ── 2. EIP-712 签名（SessionAuth，域 "Session Key Engine" v1 + chainId）──
// sessionAddress / validUntil 为服务端 createSession 时生成与计算，
// 此处以占位展示签名结构；签名必须基于服务端生成的 sessionAddress（见 §3 签名域说明）。
const signature = await signTypedData({
  privateKey: userPrivateKey, // 用户主钱包私钥（仅本地签名，不上传）
  domain: { name: 'Session Key Engine', version: '1', chainId: 1 },
  types: {
    SessionAuth: [
      { name: 'nonce', type: 'string' },
      { name: 'sessionAddress', type: 'address' },
      { name: 'contracts', type: 'string' },
      { name: 'validUntil', type: 'uint256' },
      { name: 'maxPerTx', type: 'uint256' },
      { name: 'maxTotal', type: 'uint256' },
    ],
  },
  primaryType: 'SessionAuth',
  message: {
    nonce,
    sessionAddress: '<SESSION_ADDRESS>',           // 服务端生成的会话地址
    contracts: JSON.stringify(['0xUniswapRouter']),
    validUntil: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
    maxPerTx: BigInt(1000),
    maxTotal: BigInt(10000),
  },
});

// ── 3. 创建会话（签名通过后返回会话 id + sessionAddress）──
const session = await sk.createSession({
  signature,
  chain: 'eth',
  permissions: { contracts: ['0xUniswapRouter'], functions: ['0x38ed1739'] },
  validDays: 30,
  maxPerTx: '1000',
  maxTotal: '10000',
  userAddress,
  nonce,
});
console.log(session.sessionAddress);

// ── 4. 执行交易（Agent 免签名）──
const result = await sk.execute({
  sessionId: session.id,
  chain: 'eth',
  to: '0xUniswapRouter',
  data: '0x38ed1739...',
  value: '0',
  gasLimit: '200000',
});
console.log(result.txHash, result.status);

// ── 5. 列表 / 详情 / 撤销 ──
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

## 参考

- 源码：`projects/session-key/packages/server/src/routes/index.ts`（端点）、`plugins/auth.ts`（API_TOKENS 白名单）、`services/{nonce,session,execution}-service.ts`（nonce 消费 / 验签 / 三重校验）、`packages/evm/src/eip712.ts`（签名域）
- Client SDK：`projects/session-key/packages/client/src/index.ts`（npm：@0xinfrax/session-key-client）
- PRD / 设计：`docs/SESSION_KEY_ENGINE_PRD.md`、`docs/SESSION_KEY_ENGINE_DEV_PLAN.md`；MCP 接入见 `docs/API_ACCESS.md`（:3011，7 工具）
