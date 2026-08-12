# FEATURE REQUEST — @infrax/aa-sdk 接入需求（PocketX → InfraX）

- **提交方**: PocketX（wallet-base / pocketx-ui / pocketx-sdk）
- **日期**: 2026-08-12
- **关联**: tasklist A-4（Paymaster 对接）、E-1（aa-sdk 三缺口补齐）

## 一、背景

PocketX 侧 wallet-base / pocketx-ui / pocketx-sdk 原基于 `@pocketx/aa-sdk@0.1.0` 构建。按交接约定，切换为贵方白标 `@infrax/aa-sdk`（认可 E-1 成果：Paymaster 客户端 stubData/data、aa-relay `/v1/paymaster` 代理、MpcSigner sign-digest、estimateUserOpGas 编排）。

## 二、请求：发布 `@infrax/aa-sdk` 至 npm

当前 registry 返回 404，且包 `private: true` 无法安装。请发布至 npm（公开或私有 registry 均可），或提供等效可安装形式（git 依赖 / tarball）。我方将以此作为唯一依赖来源，此后 SDK 更新由贵方发布、我方升版本吸收。

## 三、3 处 API 兼容性补齐（请在发布版本处理，或随包提供适配指南）

### 1. 导出 `entryPointAbi`

`activate.ts` 中现为模块私有（`const entryPointAbi`）。我方 `wallet-base/src/host/aa.ts` 依赖 `entryPointAbi` 导出（P0.15 起，用于 EntryPoint 只读调用）。请求导出该常量。

### 2. 导出 `parseBundlers`

`config.ts` 中现为私有函数且缺省抛错。我方 host 层依赖导出实现"非法/缺失 → `[]`"的容错包装（单测既有预期，不虚报）。请求导出 `parseBundlers`（保留抛错语义亦可，我方侧自行容错）。

### 3. `MpcSigner` 构造与端点兼容

| 维度 | 我方现有（@pocketx/aa-sdk 0.1.0） | 贵方（@infrax/aa-sdk） |
|------|-----------------------------------|------------------------|
| 构造签名 | `new MpcSigner(address, serviceUrl, { email? \| token? })` | `new MpcSigner(address, serviceUrl, token: string)` |
| signUserOp | `POST /api/v2/mpc/sign { message, mode:'digest', email }` | `POST /api/v2/mpc/sign-digest { token, digest }` |
| signMessage | `POST /api/v2/mpc/sign { message, mode:'eip191' }`（服务端 hashMessage） | `POST /api/v2/mpc/sign-message { token, message }` |

我方生产 mpc-server 当前提供 `/sign`（digest/eip191 双契约，email 鉴权），**无** `sign-digest` / `sign-message` 端点。请二选一：

- **方案 A（推荐，我方无改动）**：`MpcSigner` 兼容双端点——保留 token 鉴权路径，同时支持 email 鉴权 + `/sign {mode:'digest'|'eip191'}`（构造参数兼容 `{ email? | token? }`）；
- **方案 B**：贵方同步为生产 mpc-server 部署 `sign-digest` / `sign-message` 端点 + token 鉴权方案，我方按新构造对齐（需我方侧适配）。

## 四、我方收到 npm 包后执行

1. 全量替换 `@pocketx/aa-sdk` → `@infrax/aa-sdk`（wallet-base、pocketx-ui、pocketx-sdk，共 7 处 package.json / import）
2. 按三.3 结论适配 `MpcSigner`（方案 A 则零适配）
3. 回归：wallet-base tsc + vitest 44/44 + build；pocketx-sdk 单测
4. 联动 aa-relay / Paymaster 联调（E-1b 待生产部署，等待服务商 Paymaster 物料）

## 五、已核对兼容、无需处理

`Signer` / `AAError` / `isAAError` / `SessionPolicy` / `SessionPermission` / `UserOpResult` / `BundlerClient` / `createAAClient` / `createKernelAccount` / `ExternalWalletSigner` / `PrivateKeySigner` / `estimateFeesPerGas` / `activateSmartAccount` / `ChainAAConfig` / `BundlerConfig` / `PaymasterConfig` 等 barrel 导出齐全。
