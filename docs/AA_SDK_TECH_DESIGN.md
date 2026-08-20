# aa-sdk 技术方案细化 — ERC-4337 智能账户实现

> **版本**: v1.10 | **日期**: 2026-08-21 | **作者**: stevenwang 团队（架构师）
> **上游需求**: `docs/POCKETX_EXPANSION.md` §5（ERC-4337 智能账户集成，P0 最高优先级）
> **状态**: 评审中
>
> **v1.10（2026-08-21）**：**SDK v0.1.3——InfraXEscrow 充值构建 helper（AgentX 自动续订 REQ-1/REQ-5）**——新增 `src/escrow.ts`：`InfraXEscrowAbi`（deposit/depositFor/depositForBatch/depositForERC20/depositForERC20Batch，对齐 `projects/escrow/contracts/interfaces/IInfraXEscrow.sol`）+ 编码 helper（`encodeDepositFor*`）+ UserOp 构建（`buildDepositForUserOp`/`buildDepositForBatchUserOp`/`buildDepositForERC20UserOp`/`buildDepositForERC20BatchUserOp`，组合 Kernel v3 execute/executeBatch；users/amounts 不等长抛错防链上 revert）。两条路径：EOA 直连 `InfraXEscrowAbi`+viem `writeContract`（REQ-1 主钱包代充值）；智能账户自付 `buildDepositFor*UserOp`（session key 兜底，REQ-4）。barrel 已导出，13 单测（134 全绿）。计费语义见 `docs/AA_RELAY_BILLING.md` §5。`@0xinfrax/aa-sdk@0.1.3`。
>
> **v1.9（2026-08-16）**：**SDK v0.1.1——自定义 headers 支持（PocketX 联调反馈 ⑤）**——`PaymasterClient` 构造第三参数 `headers`（或 `PaymasterConfig.headers`，config 优先）、`BundlerClient` 构造第二参数 `headers`（或 `BundlerConfig[].headers`，端点级优先），relay 模式注入 `X-API-Key` 过 aa-relay 鉴权（此前 rpc() 硬编码 headers 导致 wallet 端直用 relay 时 401）；`parseBundlers` 透传 `headers` 字段，`parsePaymaster` 支持 JSON `{"url","headers"}`；单测 +2（bundler 构造/端点级 headers 注入、paymaster config/构造 headers 合并）。`@0xinfrax/aa-sdk@0.1.1`。
>
> **v1.8（2026-08-16）**：**SDK 公开发布**——`@0xinfrax/aa-sdk@0.1.0` 发布至 npm（`@infrax` scope 私有发布需付费 E402，改 `@0xinfrax` scope + `--access public`）；`entryPointAbi`（activate.ts）、`parseBundlers`（config.ts）按 PocketX 需求单三.1/三.2 导出；aa-relay 公网入口 `https://rpc-gw.0xainet.top/aa-relay/` 上线（9131 网关对外 / 9134 内部 signer 仅内网）。详见 `docs/PAYMASTER_PROVISION_REQUEST.md` §八。
>
> **v1.7（2026-08-10）**：**产品方向修正（stevenwang 确认）：不做免 gas / 不替用户付费**——用户自行充值原生代币支付 gas（引导充值流程，余额不足时提示）；Paymaster 保留为可选组件（默认不启用，不用于替用户付费）。同步修正 §1.1 需求表、D5、§5.5、§6.2、§10.2 验收、§11 风控、§13 M3 完成标准。
>
> **v1.6（2026-08-09）**：MQ-10 补充 E-1 三缺口完成状态——**E-1a Paymaster 客户端 ✅**（`PaymasterClient` 落地 `pimlico_getPaymasterStubData/Data`，直连或 aa-relay `/v1/paymaster` 代理双模式隐藏 apikey；`estimateUserOpGas` 编排 stub→估算→正式 data）；**E-1c aa-relay ✅**（`/v1/userops` 转发+多 bundler 容灾、`/v1/userops/:hash` 收据、`/v1/estimate`、`/v1/paymaster` 代理、`/v1/session` 系列；systemd unit `infrax-aa-relay.service`）；**E-1d MPC 接入 ✅**（`MpcSigner` 落地，`signUserOp`→MPC `POST /api/v2/mpc/sign-digest`（raw 32B 摘要 TSS 签名，免二次哈希）、`signMessage`→`/sign-message`）；**E-1b 多链扩展 🟡**（env 模板就绪，逐链合约部署+链上实测待生产）；链上验收（用户自充 gas 发起 UserOp / ≥3 新链 UserOp 实测）待生产机执行。
>
> **v1.5（2026-08-08）**：源码已移交 infraX 仓库 `projects/aa-sdk/`（白标 `@0xinfrax/aa-sdk` 0.1.0，79/79 绿）；§8.1 `SESSION_KEY_ENGINE_URL/TOKEN` 生效——`SessionKeySigner`（signUserOp/signMessage）已接线 Engine `execute`（P3.1 完成，14 条单测）。
>
> **v1.4（2026-08-07）**：新增 §1.3 三层架构与 InfraX 统一管理：aa-sdk 定位升级为 InfraX 共享 SDK（`@0xinfrax/aa-sdk` 白标），PocketX 仅基于 SDK 构建；链上/服务能力归 InfraX 统一承载；新增 product 多租户隔离（`SessionStore` 键 `(product, network, sessionId)`）。
>
> **v1.3（2026-08-07）**：新增 §7.6 任意地址转账模式（原生币）：哨兵 target 授权（data 必须为空 + value 单笔/日限额 + 目标非合约），随 P0.12 增强模块一并实现；说明原生币与 ERC-20 转账接收方约束差异。
>
> **v1.2（2026-08-07）**：新增 §7.5 ERC-20 金额级限额（P0.4 扩展）：自建增强 session 模块方案（per-token 单笔/日限额，validate 阶段 calldata 解析 + 日累计记账）。
>
> **v1.1（2026-08-07）**：新增 §7.4 多网络 session 授权（BSC/ETH/BASE + Solana，每网络独立授权）；链矩阵新增 BSC 行；§8.2 联调前提更新（OxaChain Bundler 已部署）。

---

## 1. 设计目标与范围

### 1.1 目标

为 PocketX 提供一套生产级 ERC-4337 智能账户 SDK，支撑两大角色：

| 使用方 | 需求 | 关键能力 |
|--------|------|----------|
| SDK Hub（角色 A） | 免弹窗交易、批量操作 | 一次性签名 + 会话授权；gas 由用户自充原生代币支付 |
| Agent Center（角色 B） | Agent 自主交易无需反复确认 | Session Key 权限系统 |

### 1.2 范围

- ✅ Smart Account 创建/部署（Counterfactual，地址预计算）
- ✅ UserOp 构建/签名/发送/状态监控
- ✅ Bundler 多端点容灾
- ✅ Paymaster（Verifying Paymaster 起步，ERC-20 后置）
- ✅ Session Key 权限系统（对接 InfraX）
- ✅ 多签名器适配（私钥 / MPC / Session Key）
- ✅ 社交恢复（MVP 后置）
- ❌ 不重复开发 Session Key Engine（P3 对接 InfraX :3500）
- ❌ 不做协议级 AA（EIP-7702 暂缓，见 §12）

### 1.3 三层架构与 InfraX 统一管理（stevenwang 2026-08-07 确认）

**定位**：aa-sdk 升级为 **InfraX 共享 SDK**（`@0xinfrax/aa-sdk` 白标）——PocketX 及所有产品**只基于 SDK 构建**，链上与服务能力由 InfraX 统一承载。

```
┌─ 产品层：PocketX（wallet-base / mobile / desktop）───────────┐
│  仅依赖 @0xinfrax/aa-sdk（链上交互 + Signer 抽象）+ InfraX SDK │
├─ 服务层：InfraX 统一管理（多产品共享）───────────────────────┤
│  · Session Key Engine :3500（签发/托管/签名委托，P3.1 对接） │
│  · aa-relay（UserOp 转发 / apikey，P0.5）                   │
│  · 统一管理面板（授权/限额/撤销/审计/告警）                  │
├─ 链上层：共享合约栈（InfraX 部署，各链复用）─────────────────┤
│  · EntryPoint v0.7 + Kernel v3 + 增强 validator（§7.5-§7.6）│
│  · 自建 Alto Bundler                                       │
└─────────────────────────────────────────────────────────────┘
```

| 能力 | 归属 | 说明 |
|------|------|------|
| 链上合约栈 + Bundler | InfraX 共享部署 | 一次部署，多产品/多链复用 |
| Session Key 签发/托管/签名 | InfraX :3500 | 不重复开发（§1.2 / P3.1） |
| UserOp 中继 + apikey | InfraX aa-relay | 前端零密钥（P0.5） |
| aa-sdk | **InfraX 共享 SDK**（`@0xinfrax/aa-sdk`） | 白标；PocketX 基于其构建 |
| 产品 UI / 品牌 / 授权配置入口 | PocketX | 只调 SDK |

**多租户隔离（关键）**：InfraX 统一管理多个产品，授权数据按 `product` 维度隔离——`SessionStore` 键从 `(network, sessionId)` 扩展为 **`(product, network, sessionId)`**；每产品独立授权记录、互不可见。

**多网络维度支撑**：`NetworkId`（evm/solana）+ 每网络独立授权（§7.4）天然适配 InfraX 统一管理多链/多产品。

**落地**：P0.5（aa-relay 归 InfraX）+ P3.1（完整三层架构集成）。

---

## 2. 关键技术选型决策

### 2.1 决策总表

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| D1 | EntryPoint 版本 | **v0.7** | 见 §2.2 |
| D2 | 账户实现 | **Kernel v3**（ERC-7579 模块化） | 见 §2.3 |
| D3 | 底层库 | **viem + permissionless.js** | 见 §2.4 |
| D4 | Bundler | **Pimlico Alto（主）+ Stackup/自建（备）** | 多端点容灾 |
| D5 | Paymaster | **用户自充 gas（默认，引导充值）**；Pimlico Verifying Paymaster（可选，不替用户付费） | 不替用户付费，Paymaster 仅作可选 sponsor 扩展（ERC-20 后置） |
| D6 | 签名器抽象 | 统一 `Signer` 接口（私钥/MPC/SessionKey） | 对接现有 core |
| D7 | 测试网首链 | **Base Sepolia** | Pimlico 原生支持、费用低 |
| D8 | 主网上线首链 | **Base / Arbitrum** | 共享 mempool、AA 生态成熟 |

### 2.2 D1 — EntryPoint 版本：为什么是 v0.7（不是 v0.8/v0.9）

**标准演进时间线**（2026 年现状）：

| 版本 | 发布时间 | 关键变化 | 生态现状 |
|------|----------|----------|----------|
| v0.6 | 2023-03 | 原始规范（`paymasterAndData` 单字段） | ⚠️ 供应商 2026 年起退役，**弃用** |
| v0.7 | 2024-05 | `PackedUserOperation`、factory/paymaster 字段分离、结构化错误、postOp gas 简化 | ✅ **生产主流**，所有账户实现支持 |
| v0.8 | 2025-03 | 原生 EIP-7702 支持、EIP-712 userOp hashing、未用 gas 惩罚门槛 40k、每链独立 singleton | ⚠️ 仅 SimpleAccount 支持 |
| v0.9 | 2025-11 | 并行 paymaster 签名、区块号有效期窗口、多 op 部署语义 | 🟡 逐步普及 |

**关键约束**（Pimlico 各链支持矩阵，2026-07 实测数据）：
- v0.8/v0.9 目前**只支持 Simple Account**（参考实现，非生产级）
- Kernel v3 / LightAccount / Safe 等成熟账户实现**最高支持到 v0.7**
- 账户实现 > EntryPoint 版本：我们优先要模块化账户（Session Key 是角色 B 的核心），所以锁 v0.7

**结论**：EntryPoint **v0.7**，地址（全 EVM 链通用 singleton）：
```
0x0000000071727De22E5E9d8BAf0edAc6f37da032
```
> 后续 v0.8/v0.9 生态成熟（Kernel 等支持）后，SDK 内部预留 `entryPointVersion` 配置项平滑升级。

### 2.3 D2 — 账户实现：Kernel v3（ERC-7579 模块化）

**候选对比**：

| 账户 | 模块化(7579) | Session Key | 社交恢复 | 多签 | 生态数据(6mo) | 备注 |
|------|:---:|:---:|:---:|:---:|:---:|------|
| **Kernel v3** | ✅(作者) | ✅ 成熟 | ✅ | ✅ | ~133k | ZeroDev 团队，被 Offchain Labs 收购 |
| LightAccount | ❌ | ❌ | ❌ | ❌ | ~7.3M | 轻量，简单场景 |
| Nexus | ✅ | ✅ | ✅ | ✅ | 新 | Biconomy |
| Safe | ⚠️ 需适配模块 | ✅ | ✅ | ✅ | ~34k | 最成熟但重 |

**选 Kernel v3 的理由**：
1. **Session Key 生态最成熟** — 角色 B（Agent 自主交易）的直接依赖
2. ERC-7579 作者团队维护，权限系统（`permissions`）设计完备：可约束 target 白名单、每笔限额、日限额、有效期
3. 支持多签名器（ECDSA + 自定义 validator），可同时挂私钥 owner + MPC validator
4. gas 效率高（静态 calldata 优化）

**工厂/实现地址**：由 `@zerodev/sdk` constants 按链提供，部署时登记进 `project-config.md`（每链不同，禁止硬编码）。

### 2.4 D3 — 底层库：viem + permissionless.js

**为什么不自研 UserOp 逻辑**（与"最小自研"原则一致）：
- UserOp 编码/哈希/EIP-712 签名/gas 估算/非标准化错误处理，细节多、易错
- `permissionless` 封装了 bundler/paymaster 全套 RPC（`eth_sendUserOperation`、`pimlico_*` 等），自动处理 gas 估算与替换
- viem 与现有 ethers v6 可共存（`packages/core` 保留 ethers，aa-sdk 用 viem，交接层做地址/签名互转）

**依赖**：
```json
{
  "viem": "^2.x",
  "permissionless": "^0.3.x",
  "@zerodev/sdk": "（Kernel v3 相关）"
}
```

---

## 3. 包结构设计

```
packages/aa-sdk/
├── src/
│   ├── index.ts                # barrel export
│   ├── types.ts                # 全包共享类型（见 §4）
│   ├── config.ts               # 链配置 + 环境变量加载（零硬编码）
│   ├── signers/                # 签名器抽象（D6）
│   │   ├── index.ts
│   │   ├── types.ts            # Signer 接口
│   │   ├── private-key.ts      # 对接 keystore.ts（私钥签名）
│   │   ├── mpc.ts              # 对接 mpc.ts（远程 MPC 签名）
│   │   └── session-key.ts      # Session Key 签名（对接 InfraX）
│   ├── smart-account.ts        # Kernel v3 创建/部署/地址预计算
│   ├── userop.ts               # UserOp 构建/编码/签名（v0.7）
│   ├── escrow.ts               # InfraXEscrow 充值构建（REQ-1/REQ-5：depositFor 等编码 + UserOp）
│   ├── bundler.ts              # Bundler 客户端（多端点 + 容灾）
│   ├── paymaster.ts            # Verifying Paymaster 对接
│   ├── session.ts              # Session Key 权限管理（创建/撤销/查询）
│   ├── recovery.ts             # 社交恢复（MVP 后置，接口预留）
│   ├── errors.ts               # 错误分类（AAError / BundlerError）
│   └── utils/
│       ├── gas.ts              # gas 估算（paymaster 模式）
│       └── eth-address.ts      # 地址校验/checksum 工具
├── __tests__/
│   ├── userop.test.ts          # UserOp 编解码/哈希单测
│   ├── escrow.test.ts          # InfraXEscrow 充值编码/UserOp 构建单测
│   ├── bundler.test.ts         # 多端点容灾逻辑
│   └── session.test.ts         # 权限策略校验
├── package.json
└── tsconfig.json
```

---

## 4. 核心类型设计（`types.ts`）

```typescript
/** 链配置：从环境变量加载，零硬编码 */
export interface ChainAAConfig {
  chainId: number;
  entryPointVersion: '0.7';
  entryPoint: Address;                 // 0x00000000...da032
  kernelFactory: Address;              // 按链
  kernelImplementation: Address;       // 按链
  bundlers: BundlerConfig[];           // 多端点（主 + 备）
  paymaster?: PaymasterConfig;         // 可空
}

export interface BundlerConfig {
  url: string;                         // 完整 URL（含 apikey 由服务端代理注入）
  priority: number;                    // 0 = 主，1 = 备
  timeoutMs: number;
}

export interface PaymasterConfig {
  type: 'verifying' | 'erc20' | 'none';
  url: string;                         // Pimlico paymaster RPC
  /** erc20 模式下扣费的 token（如 USDC） */
  token?: Address;
}

/** 统一签名器抽象（D6） */
export interface Signer {
  readonly type: 'private-key' | 'mpc' | 'session-key';
  readonly address: Address;
  /** 对 EIP-712 打包后的 userOpHash 签名 */
  signUserOp(userOpHash: Hex): Promise<Hex>;
  /** 对任意消息签名（EIP-191，供验证/登录用） */
  signMessage(message: Hex): Promise<Hex>;
}

/** Session Key 权限策略 */
export interface SessionPolicy {
  sessionId: string;
  signer: Address;                     // session key 公钥地址
  validUntil: bigint;                  // 到期时间（秒）
  validAfter: bigint;                  // 生效时间（秒）
  permissions: SessionPermission[];
}

export interface SessionPermission {
  /** 允许调用的目标合约白名单（空 = 全部禁止） */
  targets: Address[];
  /** 允许的 selector 白名单（空 = 全部允许） */
  selectors?: Hex[];
  /** 单笔 ETH 限额（0 = 不限） */
  valueLimit?: bigint;
  /** 调用次数上限（0 = 不限） */
  countLimit?: number;
  /** 日消耗限额 */
  dailyLimit?: bigint;
}
```

---

## 5. UserOp 生命周期（ERC-4337 具体实现细节）

### 5.1 UserOperation v0.7 结构

v0.7 相对 v0.6 的关键变化：`factory`/`factoryData` 从 `initCode` 拆分、`paymaster*` 三字段替代 `paymasterAndData`。

```typescript
// v0.7 PackedUserOperation（permissionless 已封装，SDK 内部使用）
interface UserOperationV7 {
  sender: Address;              // Smart Account 地址（= Kernel 合约地址）
  nonce: bigint;                // EntryPoint 管理的 nonce
  factory?: Address;            // 首次部署时：KernelFactory
  factoryData?: Hex;            // 部署参数（owner、index 等）
  callData: Hex;                // execute(target, value, data) 编码
  callGasLimit: bigint;         // 执行阶段 gas
  verificationGasLimit: bigint; // 验证阶段 gas
  preVerificationGas: bigint;   // 补偿 bundler 的 gas
  maxFeePerGas: bigint;         // EIP-1559
  maxPriorityFeePerGas: bigint; // EIP-1559 tip
  paymaster?: Address;          // 使用 paymaster 时
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterData?: Hex;
  signature: Hex;               // EIP-1271 兼容签名
}
```

### 5.2 完整执行流程（一次 Swap 的 UserOp）

```
用户点 Swap
   │
   ▼
[1] 组装 callData
    execute(target=UniswapRouter, value=0, data=swapExactTokens...)
   │
   ▼
[2] 获取 nonce（EntryPoint.getNonce(sender, 0)）
   │
   ▼
[3] 预计算/确认 sender 地址（§5.4 create2）
   │
   ▼
[4] 估算 gas
    ├─ 无 paymaster: 模拟 + client.estimateUserOperationGas()
    └─ 有 paymaster: pimlico_estimateUserOperationGas（paymaster 参与）
   │
   ▼
[5] 请求 paymaster 签名（§5.5，验证方签名 + 返回 paymasterData）
   │
   ▼
[6] 计算 userOpHash（EIP-712，§5.3）
   │
   ▼
[7] signer.signUserOp(userOpHash)
    ├─ private-key: 本地 ECDSA
    ├─ mpc: POST /api/v2/mpc/sign
    └─ session-key: InfraX :3500 签名（session 有效期内免用户确认）
   │
   ▼
[8] eth_sendUserOperation → 主 bundler（§5.6，失败自动切备）
   │
   ▼
[9] 轮询 eth_getUserOperationReceipt（1s 间隔，超时 120s）
   │
   ▼
[10] 结果：success 返回 txHash（userOp hash + 实际 tx hash 双返回）
       失败：解析 AA 错误码（§5.7）→ 分类处理
```

### 5.3 userOpHash 计算（签名对象）

```typescript
// EIP-712 domain（v0.7 用 domainSeparator + hashStruct，非旧的 4337 专用 prefix）
const domain = {
  name: 'ERC4337',
  version: '1',
  chainId,
  verifyingContract: entryPoint,       // 0x00000000...da032
};

// 签名字节 = ECDSA(userOpHash)，packed 结构
// permissionless 提供 getUserOperationHash()，SDK 不手写
```

**注意**：v0.7 的 userOpHash 计算与 v0.6 不同（v0.6 用 `keccak("\x19\x01" || ...)` 特殊 prefix，v0.7 用标准 EIP-712）。**必须使用与 EntryPoint v0.7 匹配的哈希函数**，permissionless 的 `getUserOperationHash(userOp, entryPoint)` 自动处理。

### 5.4 Counterfactual 部署（create2）

Kernel v3 通过 `KernelFactory` 的 create2 部署，地址可离线预计算：

```typescript
// 地址预计算（无需上链）
const address = getAccountAddress({
  factory: kernelFactory,        // 0x...(按链)
  factoryData: encodeAbiParameters(
    ['address', 'address', 'uint256'],
    [owner, validatorAddress, index]  // index=0 常规账户
  ),
  salt: keccak256(owner + index),
  provider,
});

// 首次 UserOp 携带 factory + factoryData → 一笔交易同时完成部署 + 首次操作
// （bundler 会先调用 factory.createAccount 再执行 callData）
```

**部署模式决策**：
- **懒部署**：首次 UserOp 顺带部署（推荐，零前置成本）
- 预部署：注册/创建钱包后立刻部署（可提前打开 ENS/收款等场景，MVP 不需要）

### 5.5 Paymaster 交互（Verifying Paymaster，可选）

> **默认路径：用户自充原生代币支付 gas**（entryPoint 直接从账户余额扣费），Paymaster **不默认启用、不替用户付费**。以下为可选 sponsor 场景的对接方案，启用前需单独评审并配套服务端风控。

```
[SDK]                          [Pimlico Verifying Paymaster API]
  │  POST pm_validateSponsorshipPolicies             │
  │  提交未签名 userOp + 用户地址 + 策略ID           │
  │─────────────────────────────────────────────────►│
  │  返回: { paymasterAndData: (addr+data),         │
  │          preVerificationGas,                    │
  │         verificationGasLimit, postOpGasLimit }  │
  │◄─────────────────────────────────────────────────│
  │  把返回字段填入 userOp → 签名 → 发 bundler       │
```

- 后端先校验：用户是否被赞助（白名单/额度/风控），再签名
- **apiKey 放服务端代理**（`packages/mpc-server` 扩展或独立 `aa-relay`），前端不暴露

### 5.6 Bundler 多端点容灾

```
sendUserOperation(userOp):
  for bundler of bundlers.sort(by priority):
    try:
      return await bundler.send(userOp)      # eth_sendUserOperation
    catch (e):
      if e.isNetworkOrTimeout: continue       # 网络类错误才切换
      throw e                                 # 业务错误（AA 拒绝）直接抛出
  throw new AllBundlersFailedError()
```

业务错误（如 `AA24 signature error`）切换端点无用，必须抛给上层；只有网络/超时错误才切。

### 5.7 错误分类处理

| 错误码 | 含义 | 处理 |
|--------|------|------|
| `AA24` | signature error | 重签 + 重发（最多 3 次） |
| `AA13` | 签名过期（validUntil） | 提示用户重新授权 |
| `AA10` | 已入 mempool（重复提交） | 转查询状态，不重发 |
| `AA20`/`AA21` | account 部署失败 | 检查 factory/owner |
| `AA31-33` | paymaster 拒绝 | 转用户自充 gas 直接支付（默认路径） |
| 网络超时 | — | 切换备 bundler |

---

## 6. 与现有 core 的集成方案

### 6.1 签名器接线

```
packages/core/               packages/aa-sdk/
  keystore.ts ──► private-key.ts   (HD/导入的私钥 → Signer)
  mpc.ts      ──► mpc.ts           (邮箱 MPC 签名 → Signer)
  tx.ts       ──► (保留 EOA 直发路径，AA 新增并行路径)
```

**MPC 签名器关键点**：现有 `mpcSign(email, message)` 返回 ECDSA 签名（r,s,v 打包 hex）。Kernel 的 ECDSA validator 验证标准 `ecrecover`，MPC 签名可直接作为 owner 签名使用 —— **MPC 账户无缝成为 Kernel owner**（这是 PocketX 的差异化：MPC 邮箱恢复 + AA 智能账户叠加）。

### 6.2 双路径共存策略

| 场景 | 路径 |
|------|------|
| 未激活 AA | 现有 EOA 直发（tx.ts） |
| 已激活 AA | UserOp 路径（aa-sdk） |
| 余额 = 0 | 引导用户充值原生代币（不支持免 gas、不替用户付费） |
| Session Key 生效 | InfraX 自动签名 |

SDK 提供 `isActivated(address)` 查询，钱包 UI 据此切换。

### 6.3 `packages/core/src/index.ts` 扩展（新增导出）

```typescript
export * from '@pocketx/aa-sdk'  // 或显式转发核心 API
```
> monorepo workspace 依赖：`packages/aa-sdk` 被 `wallet-base` 和 `apps/mobile` 直接引用。

---

## 7. Session Key 设计（角色 B 核心）

### 7.1 定位

- **不是**重造 Session Key Engine（那是 InfraX :3500 的事）
- aa-sdk 负责：**权限策略的 on-chain 管理**（注册/撤销/查询）+ **签名委托给 InfraX**
- 与 ERC-7710（Permission Delegation 标准）的关系：ERC-7710 2026 年仍未完全标准化，实践上用 Kernel v3 的 permission 系统（等价能力），**预留 7710 适配层**

### 7.2 生命周期

```
[创建]
用户配置: 允许的合约 + 每笔限额 + 日限额 + 有效期
  → 构造 SessionPermission（§4）
  → 生成 session key 密钥对（服务端 InfraX 托管或客户端生成）
  → 通过一次 UserOp 调用 Kernel 的 session key validator 安装/注册
    （此步需用户签名 1 次）

[使用]（有效期/限额内，免签名）
Agent 交易 → 用 session key 签 userOpHash → 发 bundler

[撤销]
用户发起 UserOp 删除 session → 立即失效
```

### 7.3 安全边界（Session Key 必须满足）

| 约束 | 实现 |
|------|------|
| 目标合约白名单 | permission.targets 非空校验 |
| 每笔限额 | permission.valueLimit |
| 日限额 | permission.dailyLimit（validator 内累计） |
| 过期强制失效 | validUntil（链上强制） |
| 撤销 | 链上删除 + 事件广播 |
| 永不触碰 | session key **无权**：owner 变更、validator 变更、撤销其他 session |

> ⚠️ 审计红线：session key 权限逻辑直接关系到 Agent 能支配的资金范围，P0 阶段实现 + security-check 重点审查。

### 7.4 多网络授权（BSC/ETH/BASE + Solana，P0.4 扩展）

**决策（stevenwang 2026-08-07 确认）**：session 授权支持多网络，**每网络独立授权**；同密钥可跨网络复用，授权记录各自生效。

| 维度 | 设计 |
|------|------|
| 网络抽象 | `NetworkId = 'evm' \| 'solana'`；`SessionPolicy.network` 标记授权所属网络（aa-sdk `types.ts`） |
| EVM 多链（BSC/ETH/BASE） | 复用 Kernel v3 + ERC-7579 session validator：`CHAIN_ALIASES` 已含 `bsc:56` / `ethereum:1` / `base:8453`，各链经 `AA_{CHAIN}_*` env 注入合约地址与 Bundler（§8.2 链矩阵）；链上 enable/disable 走 `encodeEnableSessionCall`（链无关，按链选 validator 地址） |
| 登记表隔离 | `SessionStore` 以 `(network, sessionId)` 为键，`listSessions(account, network)` / `revokeSessionKey(id, network)` 按网络隔离（`session.ts`） |
| UI | `SessionKeyManagerPage` 增加网络 Tab（`networks` prop，缺省仅 EVM）；切换网络加载/创建/撤销对应网络 session（`pocketx-ui`） |
| Solana（阶段 2） | 智能账户 **PDA + 自建 session 程序**（白名单/限额/有效期合约强制，语义对齐 EVM）；权限类型扩展为 `programs`（阶段 1 仅预留 `network: 'solana'` 维度，权限仍复用 targets，阶段 2 切换） |

**落地顺序（stevenwang 确认）**：① EVM 多链先行（代码改造 + 各链合约/Bundler 部署）；② Solana PDA + session 程序（独立排期）。

### 7.5 ERC-20 金额级限额（P0.4 扩展）

**背景与缺口**：当前权限粒度 `(target, selector)`，validator **不解析 calldata** —— ERC-20 `transfer`/`approve` 的 `amount` 参数不受 `valueLimit` 约束（`valueLimit` 仅约束调用附带的原生币 value），实际资金风险敞口由 dailyLimit 的 value 累计也无法覆盖 token 金额。

**目标**：对白名单内 ERC-20 的 `transfer`/`approve` 实现**金额级限额**（单笔 `maxPerTx` + 日累计 `maxDaily`），链上强制、无需依赖服务端在线。

**方案选型**：

| 方案 | 链上强制 | 实现成本 | 结论 |
|------|:---:|:---:|------|
| A. 自建增强 session 模块（calldata 解析） | ✅ | 中（1 个 Solidity 模块 + 每链部署） | **采用** |
| B. 服务端签名中介（InfraX policy 前校验） | ❌ 依赖服务端 | 低 | 降级/辅助（服务端离线则失效） |
| C. 通用 calldata 模板匹配 | 部分 | 高 | 不采用（仅标准 ERC-20 selector 可解析） |

**方案 A：增强 session 模块 `KernelSessionWithTokenLimitModule`**（EVM 链通用）

1. **定位**：向下兼容原 `KernelSessionModule` 的 `(target, selector, valueLimit, countLimit)` 授权；新增 per-token 金额限额。部署后经 `AA_{CHAIN}_SESSION_MODULE` 切换（原 session 需重新 enable，见迁移风险）。
2. **enable 数据扩展**：

```solidity
struct CallPermission {
    address target;
    bytes4[] selectors;
    uint256 valueLimit;   // 原生币单笔（原语义）
    uint256 countLimit;
}
struct TokenLimit {
    address token;        // ERC-20 合约地址
    uint256 maxPerTx;     // 单笔限额（0 = 不限）
    uint256 maxDaily;     // 日限额（0 = 不限）
}
function enableSession(
    bytes32 sessionId, address sessionKey,
    uint48 validUntil, uint48 validAfter,
    TokenLimit[] tokenLimits,      // 新增：金额限额（可空 = 纯原授权）
    CallPermission[] calls         // 原有：target/selector 白名单
) external;
```

3. **`validateUserOp` 校验流程**：
   - ① 签名校验：session key ECDSA(userOpHash)（复用现有，EIP-712）
   - ② 有效期窗口：`validAfter ≤ now < validUntil`（链上强制）
   - ③ **calldata 解析**：解析 Kernel `execute(target, value, data)`（单调用）与 `executeBatch(...)`（逐笔），对每笔调用做 ④⑤
   - ④ **金额校验**：`data` 命中标准 ERC-20 selector 且 `target ∈ tokenLimits`：
     - `transfer 0xa9059cbb` / `approve 0x095ea7b3` / `transferFrom 0x23b872dd`
     - 解析 `amount`（末位 `uint256` 参数）→ `amount ≤ maxPerTx` 且 `used[sessionId][day][token] + amount ≤ maxDaily`
   - ⑤ **白名单兜底**：token 不在 tokenLimits → 走原 `calls` 白名单 + valueLimit；两者均不匹配 → 拒绝（安全默认）
4. **日累计记账**（validate 阶段预扣，保守设计）：

```solidity
// sessionId => day(block.timestamp/86400) => token => 当日已用
mapping(bytes32 => mapping(uint256 => mapping(address => uint256))) private _used;
```

   - 记账时机在 `validateUserOp`（ERC-7579 validator 无 postOp）：**即使 UserOp 执行失败，额度也已扣减** —— 宁可少用不可超用，安全优先；天然按日过期、无需清理。
5. **解析边界（明确）**：
   - 仅标准 `transfer(address,uint256)` / `approve(address,uint256)` / `transferFrom(address,address,uint256)`（amount = 末位 uint256）
   - DEX swap / 自定义 calldata 内嵌金额**不解析** → 由 `calls` 白名单 + valueLimit 兜底
   - selector 碰撞 / 解析失败 → 拒绝
   - `transferFrom` 需账户预先 approve 给调用者，语义特殊 → **MVP 仅支持 transfer + approve**，transferFrom 阶段 2

**aa-sdk 集成**：

```typescript
// types.ts
export interface TokenLimit {
  token: Address;
  maxPerTx: bigint;  // 单笔限额（0 = 不限）
  maxDaily: bigint;  // 日限额（0 = 不限）
}
// SessionPermission 新增：
//   tokenLimits?: TokenLimit[];   // ERC-20 金额限额（空 = 不启用金额级限制）
```

- `session.ts`：`SessionModuleDataBuilder` 扩展 tokenLimits 序列化（enableData 拼接）；`validateSessionCall` 新增金额分支（off-chain 预检，与链上语义一致，入参补 `token` + `amount`）
- `pocketx-ui`：`CreateSessionModal` 增加可折叠"Token 限额"配置区（token 地址 + 单笔 + 日限额）；`summarizePermissions` 展示 token 限额摘要
- 单测：aa-sdk off-chain 预检（transfer/approve 金额超限、跨 token 隔离、daily 累计）；Solidity 模块 forge 单测（签名/有效期/金额解析/日累计/白名单兜底）

**链上部署项**（每链）：`KernelSessionWithTokenLimitModule` 部署 → 登记 `AA_{CHAIN}_SESSION_MODULE`。⚠️ **迁移风险**：从原模块切换后旧 session 失效，需引导用户重新 enable（UI 提示 + 撤销旧记录）。⚠️ **ABI 校准（2026-08-07 修复）**：`enableSession` 的 calls 为 **`CallPermission[]`**（增强 6 参数 selector `0xc620957b` / 5 参数 `0x7d993787`），禁止再用 bytes[] 预编码（旧 `0x6991a8aa...3c29` 因此作废）；后续 BSC/BASE/ETH 部署必须使用修复后源码编译，且 aa-sdk `KernelV3SessionDataBuilder` 默认编码已对齐（单测含 selector 断言防漂移）。

**落地顺序**：① aa-sdk types + 序列化器 + off-chain 预检 + 单测 → ② Solidity 模块 + forge 单测 → ③ security-check 审查（金额解析边界 + 记账正确性）→ ④ 各链部署登记（OxaChain → BSC/ETH/BASE）→ ⑤ P0.2 链上实测通过后联调 UI → ⑥ tester 回归。

### 7.6 任意地址转账模式（原生币，P0.12 扩展）

**场景（stevenwang 提出）**：session key 需要给**任意地址**转原生币，且受金额限额约束。当前 targets 白名单语义下原生币转账的 `target` = 接收方地址，无法枚举任意地址。

**关键差异（为什么只有原生币需要这个模式）**：
- 原生币转账：`execute(target=接收方, value=amount, data="")`，接收方就是 target → 必须逐个人白名单
- ERC-20 转账：`transfer(recipient, amount)` 的 recipient 是 calldata 参数，validator 不解析 recipient → **天然支持任意接收方**（仅需 token + transfer selector 入白名单 + §7.5 金额限额）

**方案**：在增强模块 `KernelSessionWithTokenLimitModule`（§7.5）内实现**转账哨兵**授权条目：

```solidity
// 哨兵 target：代表"任意地址原生币转账"授权（仅限 data 为空 + value 受限）
address public constant ANY_TRANSFER_SENTINEL = address(0x0000000000000000000000000000000000000001);

// enableSession 的 calls 中 target=哨兵地址的条目 → 登记转账授权：
struct TransferAuthorization {
    uint256 maxPerTx;   // 单笔限额（0 = 不限）
    uint256 maxDaily;   // 日限额（0 = 不限）
}
```

- **`validateUserOp` 校验**（命中哨兵条目时，`execute(target, value, data)` 需同时满足）：
  - `data` 为空（纯原生币转账，无 calldata）
  - `value ≤ maxPerTx`
  - 日累计 `used[sessionId][day][TRANSFER_KEY] + value ≤ maxDaily`（复用 §7.5 记账）
  - `target.code.length == 0`（目标非合约，防止把任意调用包装成转账）
- **安全**：哨兵地址为 EOA/空地址不可调用，不会与真实合约 target 冲突；`data` 非空一律拒绝

**aa-sdk 集成**：

```typescript
// SessionPermission 新增：
//   allowAnyTransfer?: { maxPerTx: bigint; maxDaily: bigint };  // 原生币任意地址转账授权
```

- `encodeCallPermission` 对 `allowAnyTransfer` 条目编码为哨兵 target；`validateSessionCall` off-chain 预检（data 空 + value 校验 + 目标非合约）

**落地**：随 P0.12 增强模块一并实现（同一模块、同一部署批次）。

### 7.7 与 OKX 能力对照（E-3c，2026-08-08 完成）

**背景**：OKX 的 Agent 钱包授权 = **TEE 钱包整体授权 + spending limit**（粗粒度、链下、不可验证）；我们对齐为 Kernel v3 **链上 session validator**（细粒度、链上强制、可撤销、可验证），实现反超。

| 维度 | OKX（TEE 钱包） | InfraX（Kernel v3 链上 session） |
|------|----------------|----------------------------------|
| 授权粒度 | 钱包整体授权 + spending limit（粗粒度） | `(target, selector, valueLimit, dailyLimit, countLimit, tokenLimits, allowAnyTransfer)` 细粒度（§7.3-§7.6） |
| 强制执行位置 | 链下（TEE 内执行器，链上不可验证） | **链上 validator**（`validateUserOp` 内强制，任何 bundler/relayer 一致生效） |
| 可验证性 | 不可验证（黑盒 TEE） | 可验证（`isModuleInstalled` + 链上字节码/事件，`aa-session-e2e.ts` 已链上验证） |
| 撤销 | 依赖服务端（TEE 控制面） | **用户即时收回**（`uninstallModule` 一条 UserOp，撤销后 agent 交易被链上拒绝） |
| 有效期 | 服务端管理 | `validUntil` 链上强制过期 |
| 跨链 | 依赖 TEE 网络 | 每网络独立授权，`AA_{CHAIN}_*` env 注入各链合约（§7.4） |
| x402 自动支付 | 支持 | **延后**（2026-08-08 用户决策，待 E-1/E-3 主线稳固后评估） |

**验收**：对照表（本节）+ 演示已达成 —— `aa-relay/scripts/aa-session-e2e.ts` 链上 E2E：owner 撤销 session 后 agent 再次调用被 EntryPoint 链上 revert（handleOps eth_call 预演失败），与 OKX"服务端才能收回"形成对比。

### 7.8 两种 Session 的边界（E-3d，2026-08-08 完成）

**决策（stevenwang 确认）**：两种 session **并存互不冲突**，边界以「谁持有控制权」划分：

| 维度 | ① Engine 代签通道（原 :3500 Session Key Engine） | ② Kernel v3 链上 session（aa-sdk） |
|------|-----------------------------------------------|-----------------------------------|
| 定位 | **平台服务端代签通道**：平台自主操作 / 内部服务交易（非用户钱包） | **用户钱包授权**：用户自愿共享控制权给 agent（§7.1） |
| 控制者 | InfraX 服务端（Engine 独立 EOA 持钥） | 用户 EOA（owner，可随时撤销） |
| 链上可验证 | 不可验证（服务端声明式 `from`） | 可验证（session validator 模块 + 链上强制） |
| 签名路径 | Engine 代签 UserOp（`SessionKeySigner` 已对接 Kernel `execute`） | session key 本地签 `userOpHash` → bundler |
| 适用场景 | 平台批量操作、内部服务交易、托管钱包 | 用户钱包授权 agent 执行（白名单/限额内） |

- `SessionKeySigner`（Engine 代签）**可作 Kernel 的替代签名器**：即使用户钱包启用了链上 session，平台自身操作仍走 Engine 通道，两者互不干扰。
- **边界规则**：凡「用户可控制的资产/操作」走 ②（用户授权、可撤销）；凡「平台自主/内部」走 ①。链上 enable/disable（②）与 Engine 代签（①）的密钥体系完全独立。
- **验收**：`aa-session-e2e.ts` 链上 E2E 证明 ② 全流程（enable → agent 调用 → disable → 拒绝）可用；① 维持原 Engine 能力不变，两者无共享状态、无冲突。

---

## 8. 链配置与环境变量（零硬编码）

### 8.1 环境变量（根 `.env`）

```bash
# --- ERC-4337 通用 ---
AA_ENTRYPOINT_V07=0x0000000071727De22E5E9d8BAf0edAc6f37da032
AA_ENABLED_CHAINS=base-sepolia,base,arbitrum

# --- 按链覆盖（base-sepolia 示例）---
AA_BASE_SEPOLIA_FACTORY=0x...        # KernelFactory（部署登记）
AA_BASE_SEPOLIA_IMPLEMENTATION=0x... # Kernel v3 implementation
AA_BASE_SEPOLIA_BUNDLERS=[{"url":"https://api.pimlico.io/v2/84532/rpc","priority":0},...]
AA_BASE_SEPOLIA_PAYMASTER_URL=https://api.pimlico.io/v2/84532/rpc?apikey=__SERVER__

# --- 目标主网 OxaChain（chainId 19505，原生代币 OXA）---
# RPC: https://rpc-oxa.0xainet.top（✅ 2026-08-07 确认可达，DNS → 43.163.105.172，chainId 0x4c31=19505）
# Explorer: https://explorer.l1.oxachain.io
AA_OXACHAIN_RPC_URL=https://rpc-oxa.0xainet.top
AA_OXACHAIN_FACTORY=0x...            # KernelFactory（OxaChain 待部署登记）
AA_OXACHAIN_IMPLEMENTATION=0x...     # Kernel v3 implementation（OxaChain 待部署登记）
AA_OXACHAIN_BUNDLERS=[{"url":"...","priority":0}]
AA_OXACHAIN_PAYMASTER_URL=http://127.0.0.1:9134  # ✅ 自建 verifying paymaster signer（2026-08-16，aa-paymaster :9134）

# --- Session Key Engine（P3）---
SESSION_KEY_ENGINE_URL=http://129.226.202.72:3500
SESSION_KEY_ENGINE_TOKEN=xxx

# --- 服务端代理（aa-relay）---
AA_RELAY_API_KEY=xxx                 # Pimlico apikey，仅服务端可见
```

### 8.2 上线链矩阵（P0-P1）

| 链 | EntryPoint | Bundler | Paymaster | 说明 |
|----|-----------|---------|-----------|------|
| Base Sepolia | v0.7 | Pimlico | Pimlico VP | ✅ 测试首链 |
| **OxaChain（L1, 19505）** | **✅ v0.7 已部署**（`0x97e4cddcffeaf4580bc6315fee512f2b2d82798a`） | **✅ 自建 Alto**（`http://43.156.78.59:4338`，2026-08-19 迁移，原 43.159.60.46） | **✅ 自建 VerifyingPaymaster**（合约 `0xc894ef13597f15a2fe8475b5914d1151da852f33` + signer :9134，2026-08-16 E2E 5/5） | ⭐ **目标主网**，原生代币 OXA；RPC `rpc-oxa.0xainet.top` ✅ 可达；**ERC-4337 合约全栈 + 自建 Bundler + 自建 Paymaster 已就绪** |
| Base | v0.7 | Pimlico | Pimlico VP | ✅ 主网上线 |
| **BSC** | v0.7 | 待部署（可复用自建 Alto） | 待定 | 🟢 **多网络 session（2026-08-07 新增）**：`CHAIN_ALIASES` 已含 `bsc:56`，合约/Bundler 待部署 |
| Arbitrum | v0.7 | Pimlico | Pimlico VP | ✅ 备选主网 |
| Optimism | v0.7 | Pimlico | Pimlico VP | 🟡 |
| Polygon | v0.7 | Pimlico | Pimlico VP | 🟡 |
| Ethereum | v0.7 | Pimlico | Pimlico VP | 🟢 远期（gas 高） |
| XLayer | 待验证 | bundler.xlayer.tech | 待验证 | ⚠️ 需求文档提及，Pimlico 不支持，需单独调研（§12） |

> **OxaChain 联调前提**（P0.2 链上实测目标链，2026-08-07 stevenwang 指定）：
> 1. ✅ RPC 可达：`rpc-oxa.0xainet.top`（DNS → 43.163.105.172），chainId 19505 确认，区块活跃（85240+）
> 2. ✅ **EntryPoint v0.7 已部署**：`0x97e4cddcffeaf4580bc6315fee512f2b2d82798a`（0.8.23 + runs 1e6 编译，runtime 17,690 bytes；非标准 create2 地址，须 `AA_OXACHAIN_ENTRYPOINT_V07` 覆盖）
> 3. ✅ **Kernel v3.1 implementation + KernelFactory + ECDSA validator 已部署**（2026-08-07 全栈部署成功）：implementation `0x5131d75af2126eba05edbb6bc24902c42d1b52b4`（runtime 20,427 bytes = 主网官方字节码一致）/ factory `0xf8abe4510a6810d5ef26aa3222c0f63d32b757d1` / ECDSA validator `0xb0d4f548e022b8a9d5b454ffb7f327ee2afeb16c`
> 4. ✅ **Bundler 已部署（自建 Alto）**：`http://43.156.78.59:4338`（2026-08-19 迁移：原 `43.159.60.46:4338` 随 AgentX 系统盘丢失，已按 infraX 通用服务重建于 43.156.78.59 pm2 `pocketx-alto`，node 20.20.2，指向 `rpc-oxa.0xainet.top`，chainId 19505，block time ~31s，新执行钱包 `0xF434e525...65c8B` 余额 5 OXA）。Pimlico 不支持 19505，故自建 Alto；simulations 合约已手动部署（见 §8.3 第 6-9 行），`--deploy-simulations-contract false` + 显式传地址启动。✅ 安全组已放行 4338（163.105 → 78.59 连通验证，见 tasklist AA Bundler 迁移与恢复）。
> 5. ✅ **P0.2 链上实测通过**（2026-08-07）：`chain-smoke.mjs` 场景④——create2 懒部署 + 首笔 UserOp 转账 0.001 OXA 经自建 Alto 成功上链（smart account 已部署 61 B，收款地址余额 = 0.001 OXA）。修复了 Alto 对 OxaChain 定制 EP 的模拟结果解码崩溃（见 §8.3「Alto 定制补丁」）。→ **P0.2 前置全部就绪**

> 需求文档中 `AA_BUNDLER_URL=https://bundler.xlayer.tech` 的 XLayer 需要单独验证其 AA 生态；**首期不阻塞**，P0 用 Base Sepolia 打通。

### 8.3 OxaChain 合约部署清单（2026-08-07 已完成，部署者 0x52Ec58173042E8d0C9be0BdA81e95a8CbB5B8e06）

OxaChain（chainId 19505）ERC-4337 全栈已部署并验证（部署方式：Foundry 编译 + Node.js viem 脚本发交易，部署钱包 5 OXA，总 gas ≈ 9.8M）：

| # | 合约 | 地址 | runtime | 部署 tx hash | 源码/编译 |
|---|------|------|---------|--------------|-----------|
| 1 | **EntryPoint v0.7** | `0x97e4cddcffeaf4580bc6315fee512f2b2d82798a` | 17,690 B | `0x14bc12e40d249791ad97081cd99bce51ec5c81eecda7d3aa0bece5d509af7c2a` | eth-infinitism/account-abstraction v0.7.0，solc **0.8.23** + optimizer runs **1e6**（⚠️ 0.8.24+ 编译会超 24KB 上限） |
| 2 | **Kernel v3.1 implementation** | `0x5131d75af2126eba05edbb6bc24902c42d1b52b4` | 20,427 B | `0x0f8138782807c9ee3464d729c0fb633b8571af8b345fa3d18912f2bc8a168048` | zerodevapp/kernel v3.1 **官方 init code**（Deploy.s.sol KERNEL_CODE，尾部构造参数替换为本链 EntryPoint） |
| 3 | **KernelFactory** | `0xf8abe4510a6810d5ef26aa3222c0f63d32b757d1` | 1,727 B | `0x9bab2b31c6fa2b45c02cfbd84bc959724ee4c8493d3bacce42786439cb3c5c58` | zerodevapp/kernel v3.1 编译（构造参数 = 本链 Kernel） |
| 4 | **ECDSA Validator** | `0xb0d4f548e022b8a9d5b454ffb7f327ee2afeb16c` | 3,809 B | `0x063f01e2d582c6b0143876e6a9b3fd4149fac4ea0642dba5fda8b6a0a5256ccb` | zerodevapp/kernel v3.1 编译（无构造参数） |
| 5 | **SessionKey Validator（P0.12 增强版）** | `0xfbbca78d2d7d08c1163aa57a0056973ef4fd8c74` | 7,608 B | `0x40a97e2d606a6522b32dc63634af42f1ec3d9b88d878a8857c004f485cd9aab7` | `contracts/` foundry 项目 `KernelSessionWithTokenLimitModule`（solc 0.8.24 + optimizer 200）：ERC-20 金额限额 + 任意转账哨兵（§7.5/§7.6），forge 单测 24/24；**ABI 修复重部署（2026-08-07）**：calls 对齐 `CallPermission[]`（增强 `0xc620957b` / 5 参数 `0x7d993787`），链上实测 13/13 通过；旧地址 `0x6991a8aa...3c29` 作废 |
| 6 | **PimlicoSimulations（Alto gas 模拟）** | `0x9b3d340da2f685b765933e7ad446b82c92831dd3` | 14,563 B | `0x44de5ad1b6e8899e1d17f5f1ba4facf59a00712fb7805fd98e757d884fcb343f` | Alto `contracts/` forge 编译产物，普通 CREATE 部署（无构造参数） |
| 7 | **EntryPointSimulations07（Alto gas 模拟）** | `0x0453aa5a8dd183b0bd868f6979ac171e914a901c` | 19,705 B | `0x22c31b1d17c4ac98f9003f8152cf8d1b6bccb9796d81a487e827c8696e00dd94` | 同上（v0.7，paris EVM） |
| 8 | **EntryPointSimulations08（Alto gas 模拟）** | `0x91d444464761938481062341ceea4d3bad49e4cc` | 22,145 B | `0x507e04a40f7f75ae9b901746b06bc0b515712e9594121d2770647dcdd1158212` | 同上（v0.8，cancun EVM，Alto 视为可选） |
| 9 | **EntryPointSimulations09（Alto gas 模拟）** | `0x292cf1519b860739974f96c35e1b874169fc525b` | 21,912 B | `0xf526b4b0a7320813494a44467992f70d1d297df160edce9fdd124bad8afdcfc9` | 同上（v0.9，cancun EVM，Alto 视为可选） |

> **Alto Bundler 部署要点**（2026-08-07 首建 43.159.60.46；**2026-08-19 迁移至 infraX 43.156.78.59**）：
> - 安装：Pimlico `alto` 仓库 clone + `pnpm install` + `pnpm run build:contracts`（forge 编译 simulations）+ `pnpm build`，部署于 `/home/ubuntu/infraX-1/projects/bundler/alto/`（迁移后）；**node ≥20.10 必需**（alto 产物依赖 `import attributes` 语法，原 18 报 SyntaxError，已升级 20.20.2）
> - ⚠️ **上游 `DETERMINISTIC_DEPLOYER_TRANSACTION` 常量损坏**（hex 中含 `V` 字符），且 OxaChain 无 deterministic deployer（`0x4e59b44847b379578588920ca78fbf26c0b4956c` 未部署）→ **禁用 Alto 自动部署**（`--deploy-simulations-contract false`），改手动 CREATE 部署 simulations 合约后以 `--pimlico-simulation-contract` / `--entrypoint-simulation-contract-v7/v8/v9` 显式传地址
> - 配置：全部走 `ALTO_*` env（yargs `.env("ALTO")`），私钥/地址在 `/home/ubuntu/infraX-1/projects/bundler/alto/.env`（chmod 600，**不入库**）：`ALTO_RPC_URL=https://rpc-oxa.0xainet.top` / `ALTO_ENTRYPOINTS=0x97e4cddc...` / `ALTO_UTILITY_PRIVATE_KEY` / `ALTO_EXECUTOR_PRIVATE_KEYS`（同一执行钱包 `0xF434e525...65c8B`，余额 5 OXA 周转）/ `ALTO_PORT=4338` / `ALTO_ENABLE_CORS=true` / `ALTO_BLOCK_TIME=31000`（OxaChain 区块 ~31s）
> - 验证：`eth_supportedEntryPoints` → `["0x97e4Cddc...82798a"]` ✅、`eth_chainId` → `0x4c31` ✅、`pimlico_getUserOperationGasPrice` ✅（maxFee ≈1 gwei）、无效签名 UserOp 模拟 → 标准 `AA30 paymaster not deployed`（补丁生效）✅
> - ✅ 安全组已放行 `4338`（163.105 直连验证）→ **P0.2 链路恢复**（2026-08-19 迁移后）

> **Alto 定制补丁（OxaChain 定制 EP 模拟解码，2026-08-07）**：
> - **背景**：OxaChain 的 EntryPoint 是 v0.7 定制 fork——模拟通过 `delegateAndRevert(target, data)`（selector `0x850aaf62`）最终 `revert DelegateAndRevert(bool success, bytes ret)`（error selector `0x99410554`）传播结果。Alto `SafeValidator.getValidationResultWithTracerV07` 用 `pimlicoSimulationsAbi`（**无任何 error 定义**）对顶层 revert data 执行 `decodeErrorResult` → 抛 `AbiErrorSignatureNotFoundError` → `eth_sendUserOperation` 返回 HTTP 500。
> - **修复**（修改 `/opt/pocketx/alto/src/esm/rpc/validation/SafeValidator.js`，pm2 实际运行产物；TS 源 `src/rpc/validation/SafeValidator.ts` 同步，避免重新构建覆盖）：
>   1. 解码用 `EntryPointV07Abi` 回退（含 `DelegateAndRevert` error 定义）：先试 `pimlicoSimulationsAbi`，失败回退 `EntryPointV07Abi`；
>   2. `errorName === "DelegateAndRevert"` 时解包 `(success, ret)`：`success=false` → 解内层 error 并抛 `RpcError(SimulateValidation)`；`success=true` → 用**手写单 tuple v0.7 ValidationResult 参数**（returnInfo 5 字段 preOpGas/prefund/accountValidationData/paymasterValidationData/paymasterContext + senderInfo/factoryInfo/paymasterInfo/aggregatorInfo，来自 `IEntryPointSimulations.sol` L93-99）`decodeAbiParameters` 解码 ret；
>   3. 其余分支（AA24/AA31 等）原有映射逻辑保留。
> - **验证**：模拟 trace 合法（preOpGas=156,694 / prefund=0.0020500000287 OXA）；pm2 restart 后 `chain-smoke.mjs` ✅（smart account 61 B 部署 + 0.001 OXA 转账成功）。

⚠️ 编译注意（复现时必读）：
- **EntryPoint**：必须 solc 0.8.23（v0.7.0 官方 hardhat 配置），0.8.24+ 编译产物 26KB 超 EIP-170 上限
- **Kernel**：自身源码编译 46KB+ 超限，官方部署使用**预编译 init code**（主网字节码，20,427 B runtime）；Kernel 构造参数 = EntryPoint 地址，部署时替换 init code 尾部 32 字节
- 部署后 `eth_getCode` 验证非 0x 且 <24KB

**登记项已写入根 `.env`**（`AA_OXACHAIN_*`）：
```
AA_OXACHAIN_RPC_URL=https://rpc-oxa.0xainet.top
AA_OXACHAIN_ENTRYPOINT_V07=0x97e4cddcffeaf4580bc6315fee512f2b2d82798a
AA_OXACHAIN_IMPLEMENTATION=0x5131d75af2126eba05edbb6bc24902c42d1b52b4
AA_OXACHAIN_FACTORY=0xf8abe4510a6810d5ef26aa3222c0f63d32b757d1
AA_OXACHAIN_ECDSA_VALIDATOR=0xb0d4f548e022b8a9d5b454ffb7f327ee2afeb16c
AA_OXACHAIN_SESSION_MODULE=0xfbbca78d2d7d08c1163aa57a0056973ef4fd8c74  # ✅ P0.12 增强 Session 模块（2026-08-07 ABI 修复重部署，§7.5/§7.6）
AA_OXACHAIN_BUNDLERS=http://43.156.78.59:4338  # ✅ 自建 Alto（2026-08-19 迁移，原 43.159.60.46 随 AgentX 系统盘丢失；infraX 通用服务）
AA_OXACHAIN_PAYMASTER_URL=http://127.0.0.1:9134  # ✅ 自建 verifying paymaster signer（2026-08-16，aa-paymaster :9134）
```

---

## 9. 服务端组件（可选扩展）

MVP 阶段两个服务端职责可在 `packages/mpc-server` 内新增路由（避免新建仓库）：

```
POST /api/v1/aa/relay           # 代理 eth_sendUserOperation（隐藏 apikey）
POST /api/v1/aa/paymaster       # 代理 pimlico_* paymaster 调用（隐藏 apikey）
POST /api/v1/aa/session/create  # 创建 session key（返回私钥给 InfraX 或客户端）
```

---

## 10. 测试计划

### 10.1 单元测试（`__tests__/`）
- UserOp v0.7 编解码与 `getUserOperationHash` 正确性（对照官方向量）
- Bundler 容灾切换逻辑（mock 主端点超时）
- 权限策略校验（限额/有效期/白名单边界）

### 10.2 集成测试（Base Sepolia，走 autotest-web3 `evm_*` MCP）

| 场景 | 验证点 |
|------|--------|
| 部署 + 转账 | 一笔 UserOp 完成 create2 部署 + ETH 转账，receipt success |
| 用户自充 gas | 用户充值原生代币后成功发起 UserOp（receipt success） |
| 余额不足 | UserOp 前检查余额，不足时提示充值（不替用户付费） |
| Session Key 交易 | 创建 session → session 签名发 3 笔 → 第 4 笔超限被拒 |
| 撤销 Session | 撤销后立即拒绝 |
| 错误路径 | 错误签名 → AA24；重复提交 → AA10 幂等 |
| 批处理 | 一笔 UserOp 内两笔 ERC-20 转账（batch） |

### 10.3 测试场景文档

更新 `test-reports/TEST_SCENARIOS_CT.md`（新增 AA 章节），由 tester 子代理通过 `autotest-web3__evm_contract_test()` 执行。

---

## 11. 安全设计（审计重点）

| 风险 | 缓解 |
|------|------|
| owner 私钥泄露 | MPC 邮箱恢复 + Kernel validator 支持轮换 owner |
| Session Key 过度授权 | 白名单 + 限额 + 有效期 + 日限额（§7.3） |
| 代付滥用（若启用 Paymaster） | 服务端风控：白名单 + 额度 + 频率限制；默认不启用 Paymaster |
| 恶意 bundler | 多 bundler + 校验 receipt 的 from/to 与 userOp 一致 |
| 前端密钥暴露 | apikey 走服务端代理，前端零密钥 |
| 升级风险 | Kernel v3 实现地址固定（非 proxy），升级走迁移流程 |
| 签名重放跨链 | userOpHash 绑定 chainId（EIP-712 domain） |

---

## 12. 边界与后续

- **EIP-7702**：Pectra 已上线主网（2025-05），但 L2 支持不一；Kernel 等账户 v0.8 支持成熟后再评估，**本期不做**
- **XLayer 支持**：单独验证其 bundler/paymaster 生态后决定是否加入链矩阵
- **ERC-20 支付 gas**：P1 后用户可用 USDC 付 gas（仍由用户付费，仅替换支付代币），扩展 `PaymasterConfig.type='erc20'`
- **ERC-7710 适配层**：预留接口，标准稳定后从 Kernel 原生权限迁移

---

## 13. 里程碑（对齐 P0）

| 步骤 | 内容 | 完成标准 |
|------|------|----------|
| M1 | 脚手架 + 依赖 + 链配置加载 | `pnpm build` 通过，配置读环境变量 |
| M2 | Kernel v3 账户 + UserOp 构建/签名 | 单测通过，Base Sepolia 部署 + 转账成功 |
| M3 | Bundler 容灾 | 用户自充 gas 成功发起 UserOp；Paymaster 仅可选、不替用户付费 |
| M4 | Session Key 权限系统 | 限额/撤销场景测试通过 |
| M5 | 服务端 aa-relay 路由 | apikey 不出前端 |
| M6 | WalletBase SmartAccountSetup 向导接线 | 全流程 UI 可操作（UI 属 pocketx-ui，本包提供 API） |

---

## 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-07-28 | 初稿：技术选型 + UserOp 生命周期 + 签名器集成 + Session Key 设计 |
| v1.1 | 2026-08-08 | E-3：新增 §7.7 与 OKX 能力对照（E-3c）、§7.8 两种 Session 的边界（E-3d）；§7.2 生命周期补充 ENABLE-mode 链上实现注记 |
