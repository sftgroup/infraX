# AASDK-4 & A-11 技术方案

> 生成日期：2026-08-12 ｜ 关联 tasklist：§9.8.11（AASDK-4）、§9.10（A-11）
> 需求源：[FEATURE_REQUEST_POCKETX_AASDK_ACCESS.md](./FEATURE_REQUEST_POCKETX_AASDK_ACCESS.md)、
> [FEATURE_REQUEST_MARKET_RPC_DEX_EXEC.md](./FEATURE_REQUEST_MARKET_RPC_DEX_EXEC.md)
> 用户裁定：AASDK-4 走方案 A（MpcSigner 双端点兼容，不单独发包）；A-11 DEX 排期执行（P0）

---

## 第一章 AASDK-4：MpcSigner 双端点兼容

### 1.1 背景与现状

PocketX 侧现基于 `@pocketx/aa-sdk@0.1.0` 的 `MpcSigner` 契约构建（构造 + 两个签名端点），
与 InfraX `aa-sdk`（发布在 `@0xinfrax/session-key-core` 的 `Aa` 命名空间）契约差异：

| 维度 | PocketX 现有（@pocketx/aa-sdk 0.1.0） | InfraX 现有（aa-sdk `MpcSigner`） |
|------|--------------------------------------|-----------------------------------|
| 构造签名 | `new MpcSigner(address, serviceUrl, { email? \| token? })` | `new MpcSigner(address, serviceUrl, token: string)`（仅 token） |
| signUserOp | `POST /api/v2/mpc/sign { message, mode:'digest', email }` | `POST /api/v2/mpc/sign-digest { token, digest }` |
| signMessage | `POST /api/v2/mpc/sign { message, mode:'eip191' }`（服务端 hashMessage） | `POST /api/v2/mpc/sign-message { token, message }` |

InfraX 生产 mpc-server（`projects/mpc/server.ts`，:9104）现有 token 鉴权端点：
`/api/v2/mpc/sign-message`、`/api/v2/mpc/sign-typed-data`、`/api/v2/mpc/sign-digest`（`getSession(token)` 校验）；
**无** email 鉴权 `/sign` 端点。用户裁定：不单独发包，维持 `Aa` 命名空间，**功能覆盖** PocketX 契约。

### 1.2 目标

1. `MpcSigner` 构造兼容 `{ email? | token? }`（双模式），PocketX 零改动接入。
2. token 模式：保持现有 `sign-digest` / `sign-message` 行为不变。
3. email 模式：mpc-server 新增 `/api/v2/mpc/sign`（`mode: 'digest' | 'eip191'`，email 鉴权），
   `signUserOp → mode='digest'`、`signMessage → mode='eip191'`。

### 1.3 安全模型（email 路径不引入裸鉴权）

mpc-server 现有鉴权 = session token（`unlock` 后发放，含验证码校验）。email 模式若只凭 email 即可
签名，等于把邮箱当全部凭证，安全不可接受。因此 **`/api/v2/mpc/sign` 的 email 鉴权语义 = 该 email
关联的 MPC 钱包必须已处于解锁会话**：

- 服务端由 email 定位钱包（`wallets` 表按 email 查询，1:1 约束）；
- 校验该钱包存在 `unlocked` 会话（与 `/session/status` 同一判定逻辑，含过期检查）；
- 命中后走与 token 模式完全相同的 TSS 2-of-2 签名路径；
- 未命中 → 401 `email session not unlocked`（提示先 `send-code` + `unlock`）。

> 与 PocketX 旧 `/sign`（email 直接签名）语义的差异在方案评审时同步给对方；该模型下 PocketX
> wallet-base 仍需先完成一次 unlock（其流程已含 email 验证码，无新增交互）。

### 1.4 接口规格

**新增端点** `POST /api/v2/mpc/sign`

```json
// 请求
{ "email": "user@example.com", "message": "0x... 或原文", "mode": "digest|eip191" }
// digest 模式：message 必须为 32B hex（userOpHash / EIP-712 摘要），服务端不二次哈希（对齐 sign-digest）
// eip191 模式：message 为任意文本/hex，服务端 ethers.hashMessage(message) 后签名（对齐 sign-message）

// 响应（复用 apiResponse 信封）
{ "code": 0, "message": "Message signed", "data": { "signature": "0x...65B serialized", "address": "0x..." } }
```

**MpcSigner 新签名**（`projects/aa-sdk/src/signers/mpc.ts`）：

```ts
export type MpcSignerAuth = { email?: string; token?: string };
export class MpcSigner implements Signer {
  constructor(address: Address, serviceUrl: string, auth: string | MpcSignerAuth);
  // string → token 模式（旧签名兼容）；{token} → token 模式；{email} → email 模式
  async signUserOp(userOpHash: Hex): Promise<Hex>;  // token: /sign-digest；email: /sign {mode:'digest'}
  async signMessage(message: Hex): Promise<Hex>;    // token: /sign-message；email: /sign {mode:'eip191'}
}
```

### 1.5 代码改动点

| 文件 | 改动 |
|---|---|
| `projects/mpc/server.ts` | 新增 `/api/v2/mpc/sign`：email → 钱包定位 + 解锁会话校验 + TSS 签名（digest/eip191 双分支，复用 `tssSign`/`ethersSignatureFromRs` 与 `sign-digest`/`sign-message` 内部逻辑） |
| `projects/aa-sdk/src/signers/mpc.ts` | 构造兼容 `string \| {email?\|token?}`；signUserOp/signMessage 双模式路由 |
| `projects/aa-sdk/src/index.ts` | barrel 导出 `MpcSignerAuth` 类型 |
| `projects/mpc-sdk/` | （如需）提供对应 Python/TS 客户端方法同步 |

### 1.6 拆解任务（对应 tasklist AASDK-4 拆分子任务）

| 编号 | 任务 | 说明 | 优先级 |
|---|---|---|---|
| AASDK-4.1 | mpc-server 新增 `/api/v2/mpc/sign` 端点 | email 定位钱包 + 解锁会话校验 + mode digest/eip191 双分支 TSS 签名；401 语义（email 未解锁）；对齐 `sign-digest`/`sign-message` 返回信封 | P0 |
| AASDK-4.2 | MpcSigner 双模式改造 | 构造兼容 `string \| {email?\|token?}`；signUserOp/signMessage 双模式路由；barrel 导出 `MpcSignerAuth` | P0 |
| AASDK-4.3 | 回归与联调验证 | aa-sdk vitest（构造兼容/双模式路由/错误语义）；生产 mpc-server `/sign` 双模式 curl E2E（unlock 后 email 签名 + token 签名一致性比对） | P0 |
| AASDK-4.4 | PocketX 侧回归（外部） | PocketX 按需求单四.1 替换 import + 适配；wallet-base tsc/vitest 44/44 + build 回归 | —（外部执行） |

> 前置：AASDK-2（导出 `entryPointAbi`）、AASDK-3（导出 `parseBundlers`）在发布版本一并处理；
> 发布形态 = 现有 `@0xinfrax/session-key-core`（`Aa` 命名空间）升版本，不单独发包。

---

## 第二章 A-11：DEX 交易执行 RPC（DexAPI）

### 2.1 背景与现状

- 需求单 R2（P0）：`dex.quote`（聚合报价 500+ 源）/ `dex.approve` / `dex.swap`（构建**待签名** rawTransaction）/ `dex.broadcast`（复用广播端点）。
- 现状：chain-rpc（`projects/chain-rpc`，:9130）仅有 `/v1/rpc/:chain`（读，白名单 + batch ≤100/并发 8）、
  `/v1/broadcast/:chain`（广播，`{rawTransaction, wait, timeoutMs}` → `{txHash, confirmed, receipt}`）、
  `/v1/status`、`/v1/ws`、`/v1/subscription`。**无聚合报价与 swap/approve 构建能力**。
- 支持链：`sepolia,ethereum,bsc,base,oxa,solana`（`CHAIN_RPC_CHAINS`）；A-11 覆盖链需补
  `arbitrum, polygon`（联动 §9.8.10 RPC-3 链补齐）与 X Layer。
- 行情 MarketAPI 在 **collector**（`projects/collector`，经 web `/api/v2/data/market/*` 代理，12 组端点）——R1 行情 RPC 的宿主，见 2.7。

### 2.2 目标架构

```
chain-rpc (:9130)
 ├─ /v1/rpc/:chain          读（rx_）            ← 现有
 ├─ /v1/broadcast/:chain    广播（cr_）          ← 现有，dex.broadcast 复用
 ├─ /v1/dex-rpc             聚合报价/构建（rx_ 读、构建方法走 cr_） ← 新增
 │    dex.quote    → 聚合器报价（OKX DEX Aggregator，500+ 流动性源）
 │    dex.approve  → 构建 ERC20 approve rawTransaction（待签名）
 │    dex.swap     → 构建 swap rawTransaction（待签名）
 └─ /v1/status /v1/ws /v1/subscription           ← 现有
```

- **安全约束（与需求单一致）**：`/v1/dex-rpc` **无任何 sign 端点**；`dex.approve/swap` 只构建、不持有、
  不接触私钥；rawTransaction 由调用方（InfraX MPC `sign-digest`/`sign-typed-data` 或本地钱包）签名后
  交 `/v1/broadcast/:chain` 广播。
- **鉴权分级**：`dex.quote` 挂读鉴权（rx_）；`dex.approve/swap` 挂广播鉴权（cr_，构建权高于读权，
  避免读 key 无限制构造任意链上交易——与现有读/广播分 router 同一模式，见 `index.ts` 挂载方式）。

### 2.3 聚合器选型（quote 层）

| 候选 | 流动性源 | 选型理由 | 备注 |
|---|---|---|---|
| **OKX DEX Aggregator** | 500+ 源（对齐需求单"同源 OKX ChainOS"） | 与 ChainOS 生态一致；`GET /api/v5/dex/aggregator/quote` + `supported/chain`；报价/路由/calldata 一条链 | **首选** |
| 1inch | 300+ 源 | 成熟、文档好 | 备选 |
| ParaSwap | 200+ 源 | 备选 | 备选 |

- 新增 `DEX_AGGREGATOR_URL` / `DEX_API_KEY`（env，config.ts 注入），chain-rpc 服务端代理，key 不下发。
- 若 OKX DEX API 无服务端权限/不可用，回退 1inch；未配置聚合器时 `dex.quote` 返回 503
  （fail-closed，不静默给错报价）。

### 2.4 接口规格

**`POST /v1/dex-rpc`**（信封复用 `{code, message, data}`；请求头 `X-Json-Rpc: raw` 透传逻辑同 /v1/rpc）

```json
// dex.quote（读 key）
{ "method": "dex.quote", "params": { "chain": "base", "tokenIn": "0x...", "tokenOut": "0x...", "amountIn": "1000000000000000000", "slippage": 0.005 } }
→ data: { chain, route: [...], amountOut, minAmountOut, priceImpact, fee, aggregator: "okx" }

// dex.approve（广播 key）
{ "method": "dex.approve", "params": { "chain": "base", "token": "0x...", "spender": "0x...router", "amount": "0" } }  // amount=0 → max uint256
→ data: { chain, rawTransaction: { to, data, value, chainId, gasLimit }, from: "0x...(caller 填)" }

// dex.swap（广播 key）
{ "method": "dex.swap", "params": { "chain": "base", "tokenIn": "0x...", "tokenOut": "0x...", "amountIn": "...", "slippage": 0.005, "recipient": "0x...", "deadline": 1893456000 } }
→ data: { chain, rawTransaction: { to, data, value, chainId, gasLimit }, aggregator, amountOutMin }
```

- `rawTransaction` 返回**未签名 tx 字段**（to/data/value/chainId/gasLimit 预估），调用方补齐 nonce/gasPrice
  后签名（MPC `sign-typed-data` 或本地钱包），再交 `/v1/broadcast/:chain { rawTransaction: serialized, wait: true }`。
- `dex.broadcast` = 直接调 `/v1/broadcast/:chain`（复用，不在 dex-rpc 重复实现）。

### 2.5 链覆盖与前置

- 覆盖链：X Layer / Ethereum / Base / BSC / Arbitrum / Polygon + Solana（Solana 的 DEX 构建走
  Jito/聚合器 calldata 同构，先实现 quote，swap 构建二期）。
- **前置依赖 RPC-3**（§9.8.10）：chain-rpc 新增 `arbitrum, polygon` 池端点 + 白名单方法（eth_call 已含）；
  X Layer（`xlayer`）若 ChainOS 路由已有则加池。`dex.quote` 需链上 RPC 校验 token 精度/余额时依赖此。

### 2.6 代码改动点

| 文件 | 改动 |
|---|---|
| `projects/chain-rpc/src/config.ts` | 新增 `DEX_AGGREGATOR_URL` / `DEX_API_KEY` / `DEX_SUPPORTED_CHAINS` |
| `projects/chain-rpc/src/services/dexAggregator.ts`（新增） | 聚合器客户端（quote/路由/calldata），OKX DEX API 首选 + 1inch 回退；超时/失败 fail-closed |
| `projects/chain-rpc/src/services/dexBuilder.ts`（新增） | approve/swap 未签名 tx 构建（ethers，ERC20 ABI + 路由 calldata，gasLimit 预估） |
| `projects/chain-rpc/src/routes/dexRoutes.ts`（新增） | `/v1/dex-rpc` 路由：method 分发 + 信封 + raw 透传；quote 读鉴权 / approve+swap 广播鉴权 |
| `projects/chain-rpc/src/index.ts` | 挂载 `/v1/dex-rpc`（分权限 router）；日志路由标签 + `dex-rpc` |
| `projects/chain-rpc/src/services/rpcPoolConfig.ts` | 链池补 `arbitrum/polygon/xlayer`（联动 RPC-3） |
| `projects/sdk/src/`（infrax-dk） | `DexAPI`（TS 类型 + Python 客户端同步发布，`quote/approve/swap`） |
| `projects/mpc/` | 签名路径打通验证（MPC sign → broadcast 全链路，配合验证脚本） |

### 2.7 拆解任务（对应 tasklist A-11 拆分子任务）

| 编号 | 任务 | 说明 | 优先级 |
|---|---|---|---|
| A-11.1 | 聚合器接入（quote） | `dexAggregator.ts`：OKX DEX Aggregator 客户端（quote/supported-chains）+ 1inch 回退 + fail-closed 503 | P0 |
| A-11.2 | approve/swap 构建 | `dexBuilder.ts`：ERC20 approve（amount=0→max）+ swap 未签名 tx（to/data/value/chainId/gasLimit 预估） | P0 |
| A-11.3 | `/v1/dex-rpc` 路由与鉴权 | `dexRoutes.ts` + `index.ts` 挂载；quote=读 key、approve/swap=广播 key（分 router）；信封 + `X-Json-Rpc: raw` 透传；请求日志 `dex-rpc` 标签 | P0 |
| A-11.4 | 链池补齐与白名单 | rpcPoolConfig 补 `arbitrum/polygon/xlayer`；`dex.quote` 链上校验（token 精度/余额）所需方法入白名单（联动 RPC-3） | P1 |
| A-11.5 | SDK 封装 | infrax-dk `DexAPI`（TS + Python）：`quote/approve/swap` 类型化 + 文档；`dex.broadcast` 复用现有 `ChainRpcAPI.broadcast` | P1 |
| A-11.6 | 安全加固与限流 | `/v1/dex-rpc` 纳入 rpcQuotaEnforce（读）/广播配额；approve/swap 校验 `chain` 在白名单链集；gasLimit 预估上限保护（防超长 calldata 滥用） | P1 |
| A-11.7 | E2E 验证（生产） | `quote → approve → swap` 模拟 + 真实小额定单：SDK 构建 → MPC `sign-digest` → `/v1/broadcast {wait:true}` → 收据核对；quote P95 < 100ms；接口清单自证无 sign 端点 | P0 |

### 2.8 与 R1 行情 RPC（A-12~A-14）联动

- 行情 RPC（`/v1/market-rpc`，P1）宿主为 **collector**（MarketAPI 同源），复用 `marketRoutes.ts`
  内部函数保证同源同缓存；12 组方法映射 + 多 token 批量 + 信封 `{code,message,data}`；鉴权 rx_。
- ws 行情订阅（A-14，P2）：collector `okxMarketWs` 增量推送。
- 本方案不展开 R1（独立任务 A-12~A-14），但 `/v1/market-rpc` 与 `/v1/dex-rpc` 并列挂在网关层，
  SDK 层 `MarketRpcAPI` + `DexAPI` 统一在 infrax-dk ≥ 0.8 发布（目标版本对齐需求单）。

---

## 第三章 验证与验收

### AASDK-4
1. aa-sdk vitest：构造兼容（string/token/email 三形态）、双模式路由、401 语义。
2. 生产 mpc-server：`unlock` 后 `POST /api/v2/mpc/sign {email, message, mode:'digest'|'eip191'}` 与
   token 模式签名一致（同一钱包同一摘要 → 同签名）。
3. PocketX 侧回归（外部）：wallet-base tsc/vitest 44/44 + build。

### A-11
1. `dex.quote`：OKX DEX 与 1inch 报价一致性抽样；P95 < 100ms；未配聚合器 → 503。
2. `dex.approve/swap`：返回未签名 tx 字段齐全；本地私钥签名 → `/v1/broadcast {wait:true}` 收据确认
   （sepolia/base 测试网先验，真实小额定单后验）。
3. 安全自证：`/v1/dex-rpc` 方法清单无 sign 端点；读 key 调 `dex.approve` → 403。
4. 全链路：SDK `DexAPI.quote→approve→swap` + MPC `sign-digest` + `ChainRpcAPI.broadcast` 端到端。
