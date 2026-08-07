# InfraX 接受文档（PocketX → InfraX 迁移交接）

> **版本**: v1.2 | **日期**: 2026-08-08 | **作者**: stevenwang 团队（架构师）
> **接收方**: InfraX 团队
> **依据**: `docs/AA_SDK_TECH_DESIGN.md`（§1.3 三层架构与 InfraX 统一管理 + §8.3 Alto 定制补丁）+ `docs/TASK_LIST.md`（P0.2/P0.12，v1.42）+ `docs/POCKETX_EXPANSION.md`（§5.4）
> **状态**: 待接受方确认
> **v1.1 变更**: P0.2 链上实测通过（首笔 UserOp 经自建 Alto 上链）+ Alto 模拟解码定制补丁 + aa-sdk Bundler receipt 解析修复 + 自建链配置经验（§5/§8）
> **v1.2 变更**: §6.1 新增 Session Key Engine 接口契约（`@0xinfrax/session-key-client` / `session-key-core` v0.1.0 已发布 npm，字段级契约 + aa-sdk 对接映射）

---

## 1. 文档目的

本文档是 PocketX → InfraX 迁移的**交接/接受文档**，供 InfraX 团队了解并接管从 PocketX 侧移交的资产。迁移核心定位（stevenwang 2026-08-07 确认）：

- **aa-sdk 升级为 InfraX 共享 SDK**（`@infrax/aa-sdk` 白标）——PocketX 及所有产品只基于 SDK 构建
- **链上与服务能力由 InfraX 统一承载**（共享合约栈 + Bundler + Session Key Engine + aa-relay）
- **多租户隔离**：授权数据按 `product` 维度隔离，每产品独立授权记录、互不可见

## 2. 三层架构（接收方需接管的职责边界）

```
┌─ 产品层：PocketX（wallet-base / mobile / desktop）───────────┐
│  仅依赖 @infrax/aa-sdk（链上交互 + Signer 抽象）+ InfraX SDK │
├─ 服务层：InfraX 统一管理（多产品共享）───────────────────────┤
│  · Session Key Engine :3500（签发/托管/签名委托，P3.1 对接） │
│  · aa-relay（UserOp 转发 / apikey，P0.5）                   │
│  · 统一管理面板（授权/限额/撤销/审计/告警）                  │
├─ 链上层：共享合约栈（InfraX 部署，各链复用）─────────────────┤
│  · EntryPoint v0.7 + Kernel v3 + 增强 validator（§7.5-§7.6）│
│  · 自建 Alto Bundler                                       │
└─────────────────────────────────────────────────────────────┘
```

| 能力 | 归属 | 现状 |
|------|------|------|
| 链上合约栈 + Bundler | InfraX 共享部署 | ✅ OxaChain 已部署（见 §5），BSC/ETH/BASE 待部署 |
| Session Key 签发/托管/签名 | InfraX :3500 | ⏳ 等 InfraX 微服务完成（P3.1） |
| UserOp 中继 + apikey | InfraX aa-relay | ⏳ P0.5 |
| aa-sdk | **InfraX 共享 SDK**（`@infrax/aa-sdk`） | ✅ 源码已就绪（现 `@pocketx/aa-sdk` 0.1.0），待白标 |
| 产品 UI / 品牌 / 授权配置入口 | PocketX | ✅ 只调 SDK |

## 3. 交付资产清单

### 3.1 代码仓库（`pocketx-wallet`，main 分支）

| 模块 | 路径 | 说明 | 测试 |
|------|------|------|------|
| aa-sdk | `packages/aa-sdk/`（`@pocketx/aa-sdk` 0.1.0，待白标 `@infrax/aa-sdk`） | ERC-4337 智能账户 SDK：Kernel v3 + UserOp v0.7 + Bundler + Paymaster + Session Key；**P0.2 链上实测通过**（含 `scripts/chain-smoke.mjs` 验证脚本） | vitest **65/65** |
| pocketx-ui aa 模块 | `packages/pocketx-ui/src/aa/` | SessionKeyCard / CreateSessionModal / hooks / 7 语言 i18n | vitest **76/76** |
| 合约（foundry） | `contracts/` | `KernelSessionWithTokenLimitModule`（P0.12 增强 session validator，solc 0.8.24 + optimizer 200） | forge **24/24** |

### 3.2 文档

| 文档 | 内容 |
|------|------|
| `docs/AA_SDK_TECH_DESIGN.md`（v1.4） | aa-sdk 完整技术方案：§1.3 三层架构 / §7.5 金额限额 / §7.6 任意转账 / §8 链配置与部署登记 / **§8.3 Alto 定制补丁（OxaChain 定制 EP 模拟解码）** |
| `docs/TASK_LIST.md`（v1.42） | 任务清单与 P0.2/P0.12 落地状态 |
| `DEPLOY_RECORDS.md` | 部署记录（链上地址/tx/验证） |
| `test-reports/TEST_SCENARIOS_CT.md` | 合约+链上测试场景（CT-12 链上 ABI 校准 + **CT-13 P0.2 链上实测**） |
| `docs/POCKETX_EXPANSION.md`（§5.4） | InfraX Session Key Engine 对接时序 |
| `packages/aa-sdk/scripts/chain-smoke.mjs` | **P0.2 链上实测脚本**：RPC/Bundler 连通 → 地址预计算+注资 → activateSmartAccount（create2 懒部署+转账）→ 收据/代码/余额验证；零硬编码（配置全走 `.env` `AA_OXACHAIN_*`） |

## 4. aa-sdk 共享 SDK 接口面（交付核心）

包结构（`packages/aa-sdk/src/`）：`types` / `config` / `signers` / `smart-account` / `userop` / `bundler` / `paymaster` / `session` / `recovery` / `utils`。

**Session Key 核心 API**（`session.ts`）：

| API | 说明 |
|-----|------|
| `createSessionKey()` | 生成 session key 密钥对 + 登记权限策略（signer 缺省时本地生成，交由 InfraX/客户端托管） |
| `revokeSessionKey()` | 本地即时失效 + 链上 disableSession |
| `listSessions()` | 按 (account, network) 查询授权 |
| `encodeEnableSessionCall()` / `encodeDisableSessionCall()` | 组装 enable/disable UserOp（用户签 1 次） |
| `KernelV3SessionDataBuilder` | 双路编码：5 参数兼容（`0x7d993787`）+ 6 参数增强（`0xc620957b`，tokenLimits + CallPermission[]） |
| `validateSessionCall()` | off-chain 预检（白名单/金额限额/任意转账哨兵） |
| `SessionStore` | 登记表接口（内存默认，可注入持久化）；多租户键 `(product, network, sessionId)` |

**签名器抽象**（`Signer`）：`private-key` / `mpc` / `session-key` / `external-wallet`（EIP-1193 MetaMask 等）。

**零硬编码**：所有链地址/URL 经 `AA_{CHAIN}_*` env 注入（`config.ts`，`CHAIN_ALIASES` 已含 `base:8453` / `bsc:56` / `oxachain:19505` 等）。P0.2 实测后补强（接受方接入新链必读）：
- `AA_{CHAIN}_ECDSA_VALIDATOR`：ECDSA root validator 地址（自建链无 permissionless 内置默认值时**必须显式配置**，否则地址预测/校验用默认地址）。
- `AA_{CHAIN}_ENTRYPOINT_V07`：按链优先取本链 EntryPoint，其次全局 `AA_ENTRYPOINT_V07`，最后内置默认值。
- `AA_{CHAIN}_BUNDLERS`：接受 JSON 数组**或纯 URL 字符串**（单端点容错）。
- **`useMetaFactory: false`（`smart-account.ts`）**：KernelFactory 直连，不走 ZeroDev MetaFactory——MetaFactory 仅部署在主流链，自建链（如 OxaChain）上不存在 → predictAddress 会**退化为零地址**。此修复是 P0.2 地址预计算正确的前提。

### 4.1 SmartAccount 激活向导（Web 端集成步骤）

> 产品层接入 AA 激活的标准路径（wallet-base 参考实现，P0.6/P0.8 ✅）：UI 只消费 `SmartAccountApi` 鸭子契约，SDK/链细节全在 host 层，产品零硬编码。向导组件 `SmartAccountSetup` 与状态机 `useSmartAccount` 位于 `@pocketx/ui`（`packages/pocketx-ui/src/aa/`），数据源装配位于 `wallet-base/src/host/aa.ts`。

**① 环境装配**（`wallet-base/src/host/appEnv.ts`，构建期 `VITE_AA_*` 注入）：

| 字段 | env | 说明 |
|------|-----|------|
| `aaEnabled` | `VITE_AA_ENABLED` | 激活入口开关（缺省 false = 隐藏；API 仍可安全构造） |
| `aaChainId` / `aaChainName` | `VITE_AA_CHAIN_ID` / `VITE_AA_CHAIN_NAME` | 目标链（缺省 19505 / OxaChain） |
| `aaRpcUrl` | `VITE_AA_RPC_URL` | 链 RPC（读取/发送） |
| `aaEntryPoint` | `VITE_AA_ENTRYPOINT` | EntryPoint v0.7（§5 #1） |
| `aaFactory` | `VITE_AA_FACTORY` | KernelFactory（§5 #3） |
| `aaImplementation` | `VITE_AA_IMPLEMENTATION` | Kernel 实现（§5 #2） |
| `aaSessionModule` | `VITE_AA_SESSION_MODULE` | Session 模块（§5 #5） |
| `aaBundlers` | `VITE_AA_BUNDLERS` | JSON 数组 `[{url, priority, timeoutMs}]`（§5 Bundler） |
| `aaPaymasterUrl` | `VITE_AA_PAYMASTER_URL` | Paymaster（OxaChain 未部署，可空） |

**② 装配数据源**（`host/aa.ts` `createSmartAccountApi(env, deps)`）：`resolveSigner`（external-wallet=MetaMask / private-key=keystore / mpc）、`predictAddress`（create2 counterfactual 预计算，无需上链）、`accountState`（部署状态/原生余额/EP nonce）、`estimateDeployCost`（bundler 估算，失败回 null → UI 提示「费用未知可继续」）、`estimateDeployCostDetail`（可选明细：totalWei + callGasLimit/verificationGasLimit/preVerificationGas/maxFeePerGas，E9；未实现时 hooks 退回 estimateDeployCost）、`activateAccount`（activateSmartAccount：build→sign→broadcast→receipt 轮询全流程；透传 `onStage` 阶段信号 + 返回 `receiptStatus`）。

**③ 挂载向导**（`App.tsx` 参考）：

```tsx
const aaApi = useMemo(() => createSmartAccountApi(WEB_ENV, { resolvePrivateKey }), [WEB_ENV])
// aaEnabled=false 时入口隐藏，API 仍可安全构造
{WEB_ENV.aaEnabled && <button type="button" onClick={() => setShowAA(true)}>⚡ Smart Account</button>}
{showAA && (
  <SmartAccountSetup
    open={showAA}
    api={aaApi}
    onClose={() => setShowAA(false)}
    onActivated={() => setShowAA(false)}
    footerNote="Kernel v3 · EntryPoint 0.7 · OxaChain"
    explorerBaseUrl="https://explorer.oxa.network/tx/"  // E2 txHash 区块浏览器链接（可空 = 纯文本）
    pollIntervalMs={3000}                                 // E5 余额/nonce 自动刷新（0 = 关）
    rememberSigner={true}                                 // E6 签名器记忆（localStorage px_aa_last_signer）
  />
)}
```

**④ 激活流程**（`useSmartAccount` 状态机，详见 `docs/AA_UI_STATE_MACHINE.md`）：

```
idle → connecting（选签名器）→ confirming（地址/余额/nonce/部署状态确认）
     → estimating（bundler 估算费用）→ signing（签名）→ broadcasting（广播已接受，等收据）
     → active（txHash 展示 + onActivated）
```

**E1–E10 增强（v1.43）**：E1 `onStage('broadcast')` → 状态机 `signing → broadcasting`（sign 步显示「已广播，等待链上确认」）；E2 done 步 txHash 渲染为 `explorerBaseUrl + txHash` 链接（未注入降级纯文本，零硬编码）；E3 收据 `receiptStatus: 'success' | 'failed'` 全链路透传，failed 显示 ⚠ 警告徽章；E4 部署状态徽章（未部署橙 / 本次新部署绿·NEW / 已存在绿）；E5 `pollIntervalMs > 0` 时 confirm 步周期刷新余额/nonce/isDeployed（hooks `refresh()` 不动状态机；signing/broadcasting 期间暂停）；E6 签名器「上次使用」记忆（`rememberSigner` 可关）；E7 地址一键复制；E8 错误卡 code+message 一键复制；E9 估算费用明细（gwei/maxFee + totalWei，非 sponsored 展示）；E10 已部署账户 estimate 步骤条显示 ◌ 跳过标记。

**激活后扩展**：`onActivated` 回调拿到 `{ address, txHash, deployed, receiptStatus, ... }` 后可进入 session key 授权（§4 Session API）、转账等能力。

**已知约束**：`private-key` 签名器草稿期经 `deps.resolvePrivateKey` 注入（生产应接 keystore 解密）；`mpc` 签名器待 P3.1 Session Key Engine 接线（当前 `resolveSigner('mpc')` 明确抛错）；OxaChain 无 Paymaster，激活费用由账户原生余额支付（部署前需注资，UI confirming 步骤展示余额）。

## 5. 链上资产（OxaChain 已部署，InfraX 接管清单）

> OxaChain：chainId `19505`，RPC `https://rpc-oxa.0xainet.top`，原生代币 OXA。部署钱包 `0x52Ec58173042E8d0C9be0BdA81e95a8CbB5B8e06`（余额 ~4.99 OXA）。

| # | 合约 | 地址 | 备注 |
|---|------|------|------|
| 1 | EntryPoint v0.7 | `0x97e4cddcffeaf4580bc6315fee512f2b2d82798a` | solc 0.8.23 + runs 1e6（0.8.24+ 会超 24KB） |
| 2 | Kernel v3.1 implementation | `0x5131d75af2126eba05edbb6bc24902c42d1b52b4` | 官方 init code，构造参数=本链 EntryPoint |
| 3 | KernelFactory | `0xf8abe4510a6810d5ef26aa3222c0f63d32b757d1` | 构造参数=本链 Kernel |
| 4 | ECDSA Validator | `0xb0d4f548e022b8a9d5b454ffb7f327ee2afeb16c` | — |
| 5 | **SessionKey Validator（P0.12 增强）** | `0xfbbca78d2d7d08c1163aa57a0056973ef4fd8c74` | 金额限额 + 任意转账；**ABI 修复后版本**，链上实测 13/13 |
| 6-9 | Alto simulations（PimlicoSimulations + EPSim07/08/09） | 见 `AA_SDK_TECH_DESIGN.md` §8.3 | 手动 CREATE 部署 |

**Bundler**：自建 Pimlico Alto，生产 `http://43.159.60.46:4338`（pm2 `pocketx-alto`），指向 `rpc-oxa.0xainet.top`。✅ 安全组 **4338 已放行**（外部可直达）；**P0.2 链上实测已通过**（2026-08-07：create2 懒部署 + 首笔 UserOp 转账 0.001 OXA 上链，smart account 已部署 61 B，收款地址余额验证通过）。

**⚠️ Alto 定制补丁（接受方必读，OxaChain 定制 EntryPoint 专用）**：

- OxaChain 的 EntryPoint 是 v0.7 定制 fork：模拟通过 `delegateAndRevert(target, data)`（`0x850aaf62`）最终 `revert DelegateAndRevert(bool success, bytes ret)`（`0x99410554`）包裹 ValidationResult。Alto `SafeValidator.getValidationResultWithTracerV07` 原用 `pimlicoSimulationsAbi`（**无 error 定义**）对顶层 revert data 执行 `decodeErrorResult` → 抛 `AbiErrorSignatureNotFoundError` → `eth_sendUserOperation` 返回 **HTTP 500**。
- **修复**：`/opt/pocketx/alto/src/esm/rpc/validation/SafeValidator.js`（pm2 实际运行产物；TS 源 `src/rpc/validation/SafeValidator.ts` 同步）：① `EntryPointV07Abi` 回退解码 `DelegateAndRevert`；② `success=true` 时用**手写单 tuple v0.7 ValidationResult**（returnInfo 5 字段 preOpGas/prefund/accountValidationData/paymasterValidationData/paymasterContext + sender/factory/paymaster/aggregator 4 组 StakeInfo，依据 `contracts/src/IEntryPointSimulations.sol` L93-99）`decodeAbiParameters` 解包 ret；③ `success=false` 时解内层 error 抛 `RpcError(SimulateValidation)`；④ 其余 AA24/AA31 映射保留。
- **验证**：模拟 trace 合法（preOpGas=156,694 / prefund=0.0020500000287 OXA）；pm2 restart 后 chain-smoke ✅。**新链若沿用 OxaChain 定制 EP 或部署新定制 EP，需同样携带该补丁。**

**⚠️ aa-sdk Bundler receipt 解析修复（接受方必读）**：

- 实测暴露 `activateSmartAccount` 返回 `txHash: undefined`：ERC-4337 规范 `eth_getUserOperationReceipt` 的 `transactionHash` **嵌套在 `receipt` 对象内**（Alto/Stackup），`waitForReceipt` 原误取顶层 `r.transactionHash`。
- **修复**（`src/bundler.ts`）：`txHash: r.transactionHash ?? r.receipt?.transactionHash`（兼容规范嵌套 + 旧扁平结构）；`UserOpReceipt.txHash` 改可选（`types.ts`）。回归单测：bundler.test.ts 4/4（全量 65/65）。

**⚠️ ABI 修复事件（接受方必读，防重复踩坑）**：

- 初部署 `0x6991a8aa...3c29` 的 `enableSession` 5 参数分支用 `0x12850ad9`（bytes[]）却 `abi.decode` 成 `CallPermission[]`，且 aa-sdk 增强 6 参数把 `calls` 编码为 `bytes[]`（`0x3e87962e`）→ 与链上真实签名（`CallPermission[]`）不兼容，enableSession 必然 revert。
- **修复**：aa-sdk `SessionModuleAbi`/`EnhancedSessionModuleAbi` 的 `calls` 对齐 `CallPermission[]`（5 参数 `0x7d993787` / 6 参数 `0xc620957b`）；合约 `_SEL_ENABLE_5` 改 `0x7d993787`。单测新增 selector 断言防再漂移。
- 已重部署 `0xfbbca78d2d7d08c1163aa57a0056973ef4fd8c74`（tx `0x40a97e2d...`，7,608 B），链上 eth_call 实测 **13/13 通过**。旧地址作废。

## 6. 服务对接点（InfraX 侧接管/待建）

| 服务 | 端点 | 状态 |
|------|------|------|
| Session Key Engine | `:3500`（`POST /api/v1/session_key` 签发、`POST /api/v1/execute` 委托签名） | ⏳ InfraX 开发中，P3.1 对接 |
| aa-relay | 待定 | ⏳ P0.5（前端零密钥） |
| 行情/数据 | `@0xinfrax/infrax-dk` `.market`（projects/data `:9112`） | ✅ 已有 SDK |
| Paymaster | OxaChain 未部署（Pimlico 不支持 19505） | ❌ 待建（第三方或自建） |

### 6.1 Session Key Engine 接口契约（SDK 已发布 v0.1.0，以 SDK 为准）

> **更新（2026-08-08）**：`@0xinfrax/session-key-client@0.1.0` + `@0xinfrax/session-key-core@0.1.0` 已发布 npm（作者 stevenwang000x），字段级契约以下方 SDK 实际类型为准，替代上表旧端点描述（`/api/v1/session_key` → **`POST /api/v1/sessions`**）。

**安装**：`@0xinfrax/session-key-client`（依赖 `@0xinfrax/session-key-core`）。

**客户端构造**：

```ts
import { SessionKeyClient } from '@0xinfrax/session-key-client';
const sk = new SessionKeyClient({ baseUrl: 'http://<engine>:3500', apiKey: 'xxx' });
```

**API 一览**（REST，`ApiResponse<T> { code, message, data }`，Bearer 鉴权）：

| 方法 | HTTP | 路径 | 请求 | 返回 `data` |
|------|------|------|------|------------|
| `getNonce(userAddress)` | GET | `/api/v1/nonce?user=` | — | `NonceData { nonce, message, expiresIn }` |
| `createSession({signature, chain, permissions, validDays?, maxPerTx?, maxTotal?, userAddress, nonce})` | POST | `/api/v1/sessions` | EIP-712 签名（用户钱包签 nonce.message） | `{ id, sessionAddress, status, validUntil }` |
| `listSessions(userAddress, chain?, status?)` | GET | `/api/v1/sessions?user=&chain=&status=` | — | `{ sessions: SessionKey[] }` |
| `getSession(id)` | GET | `/api/v1/sessions/:id` | — | `SessionKey` |
| `revokeSession(id)` | DELETE | `/api/v1/sessions/:id` | — | `{ revoked: boolean }` |
| `execute({sessionId, chain, to, data, value?, gasLimit?})` | POST | `/api/v1/execute` | 委托签名（Engine 侧 userOpHash 签名 + UserOp 上链） | `ExecuteResult { executionId, txHash, status, gasUsed?, errorReason? }` |
| `health()` | GET | `/api/v1/health` | — | `{ status }` |

**核心类型**（`@0xinfrax/session-key-core`）：

```ts
type Chain = 'eth' | 'bsc' | 'base' | 'polygon' | 'arbitrum' | 'optimism' | 'xlayer' | 'sol';
interface PermissionConfig { contracts: string[]; functions?: string[]; }
interface SessionKey {
  id: string; userId: string; chain: Chain; sessionAddress: string;
  sessionKeyEnc: string; validFrom: Date; validUntil: Date;
  permissions: PermissionConfig; maxPerTx: string; maxTotal: string;
  totalSpent: string; status: 'active'|'revoked'|'expired'|'quota_exhausted';
  createdAt: Date; revokedAt?: Date;
}
interface ExecuteRequest { sessionId: string; chain: string; to: string; data: string; value?: string; gasLimit?: string; }
interface ExecuteResult { executionId: string; txHash: string; status: 'success'|'failed'; gasUsed?: string; errorReason?: string; }
interface NonceData { nonce: string; message: string; expiresIn: number; }
```

**PocketX aa-sdk 对接映射（P3.1 完成态）**：

| aa-sdk | InfraX SDK | 说明 |
|--------|-----------|------|
| `createSessionKey()` 授权登记 | `getNonce` + `createSession` | 用户钱包签 EIP-712 message → Engine 托管 session key（`sessionKeyEnc` 加密存储，PocketX 不落私钥） |
| `revokeSessionKey()` | `revokeSession(id)` | 本地失效 + Engine 侧 DELETE |
| `listSessions()` | `listSessions(user, chain)` | 按 (product, network) 过滤 |
| `SessionKeySigner.signUserOp()`（[signers/session-key.ts](file:///home/ubuntu/pocketx-wallet/packages/aa-sdk/src/signers/session-key.ts) stub） | `execute({sessionId, chain, to, data, value})` | Engine 代签 userOpHash + 上链，返回 `txHash` |
| `SessionStore` 键 `(product, network, sessionId)` | Engine `userId` 维度隔离 + `chain` 字段 | 多租户：product 由 Engine 侧租户体系保证（apiKey），network 对应 `chain` |

> **交付状态**：aa-sdk `SessionKeySigner` 为 P3.1 stub（接口已定义、未接线）；Engine SDK 已发布，接线仅需按上表映射 + `VITE_AA_SESSION_KEY_ENGINE_URL` env 注入（`AA_SDK_TECH_DESIGN.md` §8.1）。

## 7. 多租户隔离（InfraX 实现要求）

- `SessionStore` 键必须为 **`(product, network, sessionId)`**；每产品独立授权记录、互不可见
- `NetworkId`（evm/solana）维度：每网络独立授权，同一 sessionId 密钥可跨网络复用但授权各自生效
- Session Key Engine / aa-relay / 管理面板按 `product` 隔离审计

## 8. 已知约束与迁移风险

1. **BSC / ETH / BASE 链未部署**：无现成部署脚本（`contracts/script/` 为空）；部署时**必须用 ABI 修复后版本编译**（calls=`CallPermission[]`），禁止沿用旧 `0x6991a8aa` 或 bytes[] 编码；完成后登记 `AA_{CHAIN}_SESSION_MODULE`，旧 session 需重新 enable（迁移风险，UI 需引导）。**新链接入另需**：登记 `AA_{CHAIN}_FACTORY/_IMPLEMENTATION/_ECDSA_VALIDATOR/_ENTRYPOINT_V07` 四件套 + `useMetaFactory:false`（§4），若 EP 沿用 OxaChain 定制 fork 还需 Alto SafeValidator 补丁（§5）。
2. **OxaChain Paymaster 未部署**（Pimlico 不支持 19505，第三方或自建待定）。**P0.2 链上实测已通过**（Bundler 4338 已放行，首笔 UserOp 上链成功，见 §5）。
3. **Alto 上游坑**：`DETERMINISTIC_DEPLOYER_TRANSACTION` 常量 hex 损坏 + OxaChain 无 deterministic deployer → 新链必须 `--deploy-simulations-contract false` + 显式传 simulations 地址。
4. **鉴权凭证**：RPC/私钥由 evm-build/security-tools MCP 内置；`.env` 不入库（含部署私钥）。接受方需自行管理密钥体系。
5. **测试账**：生产测试账号 `agentmkt_prod`（仅 agent 市场功能，与 AA 无关）。

## 9. 验收清单（InfraX 接受方）

- [ ] 代码仓库接收：`packages/aa-sdk` / `packages/pocketx-ui` / `contracts/` + 文档清单（§3）
- [ ] aa-sdk 白标 `@infrax/aa-sdk`：包名/导出/peerDependencies（viem ≥2、permissionless ≥0.2）
- [ ] 测试回归：aa-sdk **65/65**、pocketx-ui 76/76、forge 24/24
- [ ] 链上资产核对：对照 §5 地址 `eth_getCode` 字节码（SessionKey Validator = 7,608 B）+ selector `0xc620957b`/`0x7d993787`
- [ ] **P0.2 复测**：`packages/aa-sdk/scripts/chain-smoke.mjs`（读仓库根 `.env`）在 OxaChain 上首笔 UserOp 上链成功 + 收据 status success + txHash 非空
- [ ] **激活向导集成复验**：按 §4.1 装配 `VITE_AA_*` → 挂载 `SmartAccountSetup` → 完整走通 connecting→confirming→estimating→signing→active（onActivated 返回 txHash）
- [ ] 多租户 `(product, network, sessionId)` 隔离实现
- [ ] Session Key Engine :3500 对接方案（§6）
- [ ] BSC/ETH/BASE 部署计划（用 ABI 修复后模块 + §4 新链四件套 + §5 Alto 补丁评估）

## 10. 交接时间线

| 阶段 | 内容 | 状态 |
|------|------|------|
| 已完成 | P0.12 全量（aa-sdk + 合约 + UI + 测试）；OxaChain ERC-4337 全栈 + Bundler + Session 模块部署；ABI 修复重部署 + 链上 13/13 验证 | ✅ 2026-08-07 |
| 已完成 | **P0.2 链上实测通过**（首笔 UserOp 上链）+ Alto 模拟解码定制补丁 + aa-sdk Bundler receipt 解析修复（65/65） | ✅ 2026-08-07 |
| 待 InfraX | 白标 `@infrax/aa-sdk`、Session Key Engine、aa-relay、多租户管理面板 | ⏳ P3.1 / P0.5 |
| 待办 | BSC/ETH/BASE 部署（新链四件套 + Alto 补丁评估）、OxaChain Paymaster、SDK 交易费代付/Sponsor 方案 | 🔶 |
