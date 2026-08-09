# @0xinfrax/mpc-sdk

InfraX MPC 独立轻量 SDK —— 面向 MPC 微服务（邮箱分片托管钱包）的零依赖 TypeScript 客户端。
不依赖整包 `infrax-dk`，版本独立演进（MQ-10 补充 E-5）。

**当前覆盖三个模块（16 方法，E-4④ 起支持单邮箱 1:N 多子钱包；链上模块 E-5d 接 TSS 分片签名）**：

| 模块 | 方法 | 端点 |
|---|---|---|
| 钱包 | `wallet.sendCode` | `POST /api/v2/mpc/send-code` |
| 钱包 | `wallet.register` | `POST /api/v2/mpc/register`（每次注册新建一个子钱包，返回 `walletId`） |
| 钱包 | `wallet.recover` | `POST /api/v2/mpc/recover`（`walletId` 可指定子钱包，缺省首个） |
| 钱包 | `wallet.status` | `GET /api/v2/mpc/status`（email 可带 `walletId` 定位子钱包） |
| 钱包 | `wallet.listWallets` | `GET /api/v2/mpc/wallets`（同邮箱全部子钱包） |
| 钱包 | `wallet.createWallet` | `POST /api/v2/mpc/send-code`（组合入口） |
| 会话 | `session.unlock` | `POST /api/v2/mpc/session/unlock`（`walletId` 可指定子钱包） |
| 会话 | `session.lock` | `POST /api/v2/mpc/session/lock` |
| 会话 | `session.status` | `GET /api/v2/mpc/session/status` |
| 链上 | `chain.balance` | `POST /api/v2/mpc/balance`（原生币 + 可选 ERC20） |
| 链上 | `chain.signMessage` | `POST /api/v2/mpc/sign-message`（EIP-191，TSS 分片签名） |
| 链上 | `chain.signTypedData` | `POST /api/v2/mpc/sign-typed-data`（EIP-712，TSS 分片签名） |
| 链上 | `chain.sendTransaction` | `POST /api/v2/mpc/send-transaction`（原生币 / ERC20 transfer） |
| 链上 | `chain.contractRead` | `POST /api/v2/mpc/contract-read`（只读 eth_call） |
| 链上 | `chain.contractWrite` | `POST /api/v2/mpc/contract-write`（staticCall 模拟 + TSS 签名广播） |
| 链上 | `chain.gasEstimate` | `POST /api/v2/mpc/gas-estimate` |

> **E-4④ 单邮箱 1:N**：一个邮箱可派生多个 Agent 子钱包（如 50 子钱包并发模型）。`register` 每次创建新钱包返回 `walletId`；`recover` / `status` / `session.unlock` 带 `walletId` 精确命中子钱包，缺省作用于同邮箱首个（向后兼容）。token 一经解锁即绑定到该子钱包，后续链上操作无需再带 `walletId`。

> **E-5d 链上模块（TSS 就绪）**：服务端四签名/交易端点已迁移 cggmp24 TSS 2-of-2 分片签名（服务端仅持分片、不再重建完整私钥，见 `docs/TSS_EVALUATION.md`）；SDK 侧为纯 HTTP 封装——签名端点返回 65B 序列化签名（`0x + r||s||v`），交易端点返回 `txHash`；交易类数量参数统一用字符串（服务端 parseUnits/parseEther 自理）。

## 安装

```bash
npm i @0xinfrax/mpc-sdk
```

Node.js >= 18（使用原生 fetch，零运行时依赖）。

## QuickStart

```ts
import { MpcClient, MpcApiError } from '@0xinfrax/mpc-sdk';

const mpc = new MpcClient({
  baseUrl: process.env.MPC_URL ?? 'http://127.0.0.1:9104', // 生产按实际可达地址
  apiKey: process.env.MPC_API_KEY, // MPC 服务鉴权 key（出站 X-API-Key）
});

// 1. 发验证码 → 邮箱收码
await mpc.wallet.sendCode({ email: 'agent@example.com' });

// 2. 注册托管钱包
const reg = await mpc.wallet.register({ email: 'agent@example.com', code: '123456' });
console.log(reg.data.walletAddress);

// 3. 解锁会话（后续链上操作的凭证）
const s = await mpc.session.unlock({ email: 'agent@example.com', code: '123456' });
const token = s.data.token;

// 4. 会话状态
const st = await mpc.session.status({ token });
console.log(st.data.unlocked, st.data.remainingSeconds);

// 5. 链上操作（E-5d，token 即凭证）
const bal = await mpc.chain.balance({ token, chain: 'sepolia' });
console.log(bal.data.nativeBalance, bal.data.nativeSymbol);

const sig = await mpc.chain.signMessage({ token, message: 'hello' });
console.log(sig.data.signature, sig.data.address);

const tx = await mpc.chain.sendTransaction({
  token, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', amount: '0.01', chain: 'sepolia',
});
console.log(tx.data.txHash);

// 6. 锁定会话
await mpc.session.lock(token);

// 7. 邮箱恢复（封装「验证码 → 分片重建 → 地址校验」完整流程）
const recovered = await mpc.wallet.recover({
  email: 'agent@example.com',
  code: '654321',
  expectedAddress: reg.data.walletAddress, // 可选：客户端二次地址校验
});
console.log(recovered.data.walletAddress === reg.data.walletAddress);
```

## 错误处理

所有失败均抛 `MpcApiError`（含 HTTP 状态 + 业务 code + 语义 kind）；网络/超时抛 `MpcNetworkError`。

| kind | 语义 | 典型场景 |
|---|---|---|
| `unauthorized` (401) | 未授权 | 缺/错 key；会话不存在或过期 |
| `forbidden` (403) | 禁止 | 外部签发 key 被禁用 |
| `bad_request` (400) | 参数错误 | 验证码错误/过期（业务 code 1001） |
| `not_found` (404) | 未找到 | 未注册钱包（1004） |
| `conflict` (409) | 冲突 | 恢复地址与期望不一致（SDK 40900） |
| `rate_limited` (429) | 限流 | 验证码尝试次数超限 |
| `server_error` (5xx) | 服务端错误 | 分片解密失败（500/1007） |

```ts
try {
  await mpc.wallet.register({ email, code: '000000' });
} catch (e) {
  if (e instanceof MpcApiError) {
    console.log(e.kind, e.status, e.code, e.message);
    // → bad_request 400 1001 Invalid code
  }
}
```

## 与 MCP 对应关系

本 SDK 方法对应 Wallet MCP 工具（`mcp-server/src/index.ts`）：`mpc_send_code` ↔ `wallet.sendCode`、`mpc_register` ↔ `wallet.register`、`mpc_recover` ↔ `wallet.recover`、`mpc_status` ↔ `wallet.status`、`mpc_create_wallet` ↔ `wallet.createWallet`、`mpc_session_unlock/lock/status` ↔ `session.unlock/lock/status`。入站（经 MCP 调用）沿用 `inboundAuth`（`MCP_API_KEY`），出站（本 SDK）统一 `X-API-Key`。

## 开发

```bash
npm run build   # tsc → dist/
npm publish     # 发布 @0xinfrax/mpc-sdk（@0xinfrax scope）
```
