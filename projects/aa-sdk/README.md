# @0xinfrax/aa-sdk

InfraX 共享 ERC-4337 智能账户 SDK（白标自 PocketX `@pocketx/aa-sdk`）——Kernel v3 + UserOp v0.7 + Bundler + Paymaster + Session Key。

- **npm**: `@0xinfrax/aa-sdk@0.1.1`（2026-08-16 发布；`0.1.1` 补 PaymasterClient/BundlerClient 自定义 headers——relay 模式注入 X-API-Key；`@infrax` scope 私有发布需付费订阅，故用 `@0xinfrax` scope + `--access public`）
- **文档**: `docs/AA_SDK_TECH_DESIGN.md`（技术方案）、`docs/PAYMASTER_PROVISION_REQUEST.md` §八（PocketX 对接与公网入口）
- **关联包**: `@0xinfrax/session-key-core`（`Aa` 命名空间导出同源能力，v0.2.1 已发布）——两通道并存，按需选用

## 安装

```bash
npm install @0xinfrax/aa-sdk
# peerDependencies: viem >=2.0.0、permissionless >=0.2.0（需一并安装）
npm install viem@^2 permissionless@^0.2
```

`type: module`，产物 `dist/`（43 files），含类型声明。

## 快速开始

```ts
import { createKernelAccount, createAAClient, getChainConfig, MpcSigner } from '@0xinfrax/aa-sdk';

const cfg = getChainConfig('oxachain', process.env); // 从 AA_OXACHAIN_* env 加载
const signer = new MpcSigner(address, 'https://.../api/v2/mpc', { email }); // 或 token 模式
const account = await createKernelAccount({ owner: signer, chainConfig: cfg });
const client = createAAClient({ account, chainConfig: cfg });
```

## 环境变量（链配置，零硬编码）

| 变量 | 说明 |
|------|------|
| `AA_ENABLED_CHAINS` | 启用链别名逗号列表（如 `oxachain`，缺省 `base-sepolia`） |
| `AA_OXACHAIN_RPC_URL` | 链 RPC（只读调用） |
| `AA_OXACHAIN_BUNDLERS` | JSON 数组或纯 URL（`parseBundlers` 解析，多端点容灾） |
| `AA_OXACHAIN_PAYMASTER_URL` | Pimlico paymaster RPC（经 aa-relay `/v1/paymaster` 代理可隐藏 apikey） |
| `AA_OXACHAIN_ENTRYPOINT_V07` | EntryPoint v0.7 地址（缺省内置默认值） |
| `AA_OXACHAIN_FACTORY` / `AA_OXACHAIN_IMPLEMENTATION` / `AA_OXACHAIN_ECDSA_VALIDATOR` / `AA_OXACHAIN_SESSION_MODULE` | Kernel v3 组件地址（可空，缺省用 permissionless 内置） |

链别名 → chainId：`oxachain:19505`、`base-sepolia:84532`、`base:8453`、`arbitrum:42161`、`optimism:10`、`polygon:137`、`ethereum:1`、`bsc:56`。

## Paymaster（代付，可选）

平台默认"用户自充"；开启 sponsor 时经 aa-relay 代理（服务端持有 apikey）：

```ts
import { PaymasterClient } from '@0xinfrax/aa-sdk';

const pm = new PaymasterClient(
  { type: 'verifying', url: 'https://rpc-gw.0xainet.top/aa-relay/v1/paymaster' },
  'https://rpc-gw.0xainet.top/aa-relay',   // relay 代理模式：{chain, method, params}
  { 'X-API-Key': AA_RELAY_KEY },          // v0.1.1：自定义 headers（relay 鉴权必需）
);
const stub = await pm.getPaymasterStubData(op, { chain: 'oxachain', entryPoint, chainId: 19505 });
const data  = await pm.getPaymasterData(op, { chain: 'oxachain', entryPoint, chainId: 19505 });
```

自定义 headers 支持（v0.1.1，PocketX 联调反馈 ⑤）：

- **PaymasterClient**：构造第三参数 `headers`，或 `PaymasterConfig.headers`（config 优先）；relay 模式下注入 `X-API-Key` 过 aa-relay 鉴权
- **BundlerClient**：构造第二参数 `headers`，或 `BundlerConfig[].headers`（端点级优先）；注入到所有 RPC 请求（send/estimate/receipt 轮询）
- env 形态：`AA_{CHAIN}_PAYMASTER_URL` 支持 JSON `{"url":"...","headers":{"X-API-Key":"..."}}`；`AA_{CHAIN}_BUNDLERS` 数组项支持 `"headers"` 字段

## 关键导出（barrel `dist/index.d.ts`）

- 配置：`getChainConfig` / `getEnabledChains` / `getAllChainConfigs` / `parseBundlers` / `parsePaymaster` / `entryPointAbi`（EntryPoint v0.7 `getNonce(address,uint192)`）
- 账户：`createKernelAccount` / `createAAClient` / `activateSmartAccount`
- 交易：`buildUserOp` / `signUserOp` / `estimateUserOpGas` / `userOpToRpc` / `PackedUserOperationV7`
- 客户端：`BundlerClient` / `PaymasterClient`
- 签名器：`MpcSigner`（email/token 双模式）/ `PrivateKeySigner` / `ExternalWalletSigner` / `SessionKeySigner`
- Session：`encodeEnableSessionCall` / `encodeDisableSessionCall` / `validateSessionCall` / `SessionPolicy` / `SessionPermission`
- 类型：`ChainAAConfig` / `BundlerConfig` / `PaymasterConfig` / `UserOperationV7` / `Signer` / `AAError` / `isAAError`

## aa-relay 公网入口

`https://rpc-gw.0xainet.top/aa-relay/`（nginx → aa-relay :9131；上游强制 `X-API-Key` 鉴权）

| 端点 | 契约 |
|------|------|
| `POST /aa-relay/v1/userops` | `{chain, op, wait?}` → `{userOpHash, bundlerUrl, receipt}` |
| `GET /aa-relay/v1/userops/:hash?chain=oxachain` | 收据查询 |
| `POST /aa-relay/v1/estimate` | `{chain, op}` → gas 估算 |
| `POST /aa-relay/v1/paymaster` | `{chain, method, params}` → Pimlico paymaster 代理 |
| `GET /aa-relay/health` | 健康检查（免鉴权） |

> 端口说明：**9131 = aa-relay 网关（对外入口）**；9134 = 内部 signer（aa-paymaster 签名服务，仅内网不可直连，由 aa-relay 代理）。

## 测试

```bash
npm test        # vitest（79/79 绿）
npm run build   # tsc → dist/
```
