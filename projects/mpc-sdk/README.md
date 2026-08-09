# @0xinfrax/mpc-sdk

InfraX MPC 独立轻量 SDK —— 面向 MPC 微服务（邮箱分片托管钱包）的零依赖 TypeScript 客户端。
不依赖整包 `infrax-dk`，版本独立演进（MQ-10 补充 E-5）。

**首期覆盖两个模块（8 方法）**：

| 模块 | 方法 | 端点 |
|---|---|---|
| 钱包 | `wallet.sendCode` | `POST /api/v2/mpc/send-code` |
| 钱包 | `wallet.register` | `POST /api/v2/mpc/register` |
| 钱包 | `wallet.recover` | `POST /api/v2/mpc/recover` |
| 钱包 | `wallet.status` | `GET /api/v2/mpc/status` |
| 钱包 | `wallet.createWallet` | `POST /api/v2/mpc/send-code`（组合入口） |
| 会话 | `session.unlock` | `POST /api/v2/mpc/session/unlock` |
| 会话 | `session.lock` | `POST /api/v2/mpc/session/lock` |
| 会话 | `session.status` | `GET /api/v2/mpc/session/status` |

链上模块（balance/signMessage/signTypedData/sendTransaction/contractRead/contractWrite/gasEstimate，7 方法）为 MQ-10 补充 E-5d，后续版本补充。

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

// 5. 锁定会话
await mpc.session.lock(token);

// 6. 邮箱恢复（封装「验证码 → 分片重建 → 地址校验」完整流程）
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
