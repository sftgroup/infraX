# infraX 交接：恢复 OxaChain Alto Bundler，打通 AgentX ERC-4337 自动续订全链路

- 交接方：AgentX（生产 43.159.60.46 / 网关代码仓库 Agentx）
- 日期：2026-08-18
- 目的：请 infraX 恢复 OxaChain 自建 Alto bundler（源码与执行私钥随 `/opt/pocketx` 一并丢失），并确认两点配置，使 AgentX 自动续订的 on-chain E2E 能跑通。

---

## 1. 背景

AgentX 网关（`gateway`）实现了 ERC-4337 自动续订：用户 EOA 一次授权（ENABLE-mode UserOp）后，服务端用 session key 在订阅到期前签发 UserOp 调 `SubscriptionManager.subscribe`。全流程依赖 infraX AA 栈：

```
AgentX gateway ──▶ aa-relay (:9131, 43.163.105.172) ──▶ Alto bundler (:4338, 43.159.60.46) ──▶ EntryPoint v0.7
                        ▲ session 创建 / UserOp 广播 / A-10 计费         ▼
                   aa-sdk（Kernel v3 + ENABLE-mode）
```

## 2. 当前状态

| 项 | 状态 |
|---|---|
| AgentX 网关代码 | ✅ 已部署（commit `b415ad1`），enable 流程通过，**智能账户已成功部署上链** |
| aa-relay kernel 版本 | ✅ 已由 AgentX 侧修复（见 §4.2，**请 infraX 确认保留**） |
| Alto bundler | 🔴 **已从 43.159.60.46 删除**（`/opt/pocketx/alto/` 及 `.env` 私钥全部丢失），relay 广播 UserOp 无 bundler 可用 |
| confirm / 续订 | 🔴 阻塞（bundler 下线 → 无法广播 UserOp） |
| 智能账户 escrow 余额 | 🟡 产品侧待设计充值路径（见 §5） |

**已完成的链上验证**（2026-08-18）：
- `enable` → relay `/v1/session` 创建 session 成功；
- 平台代付部署智能账户 `0x02a6bf2B9d1F213B3BBEb0E905489a6E38Ded9A3`（`eth_getCode` 非空 ✅）；
- `confirm` 已越过网关侧 jsonb 解析缺陷，到达 relay A-10 计费层，被 402 拦截（智能账户 escrow 余额为 0）。

## 3. 需要 infraX 完成：重建 Alto bundler

### 3.1 安装（与 2026-08-07 原部署一致）

1. Pimlico `alto` 仓库 clone，`pnpm install` → `pnpm run build:contracts` → `pnpm build`；
2. rsync 至 `/opt/pocketx/alto/`（pm2 进程名 `pocketx-alto`）；
3. **必须禁用 Alto 自动部署 simulations**（上游 `DETERMINISTIC_DEPLOYER_TRANSACTION` 常量损坏 + OxaChain 无 deterministic deployer）：
   - `--deploy-simulations-contract false`
   - 显式传地址：`--pimlico-simulation-contract` / `--entrypoint-simulation-contract-v7/v8/v9`（见 §3.3）

### 3.2 配置（`/opt/pocketx/alto/.env`，chmod 600）

```
ALTO_RPC_URL=https://rpc-oxa.0xainet.top
ALTO_ENTRYPOINTS=0x97e4cddcffeaf4580bc6315fee512f2b2d82798a
ALTO_UTILITY_PRIVATE_KEY=<需新 key>
ALTO_EXECUTOR_PRIVATE_KEYS=<同 key>
ALTO_PORT=4338
ALTO_ENABLE_CORS=true
ALTO_BLOCK_TIME=31000        # OxaChain 区块 ~31s
```

- **执行私钥**：原 key（executor `0x52Ec58173042E8d0C9be0BdA81e95a8CbB5B8e06`，~10 OXA）随 `/opt/pocketx` 丢失无法找回，**需新建 key 并充值 OXA**（预计若干 OXA 足够，gas 成本很低）。
- 安全组 `4338` 端口放行（原已放行，若重建需确认保留）。

### 3.3 simulations 合约地址（已部署在链上，无需重新部署）

| 合约 | 地址 |
|---|---|
| PimlicoSimulations | `0x9b3d340da2f685b765933e7ad446b82c92831dd3` |
| EntryPointSimulations07 | `0x0453aa5a8dd183b0bd868f6979ac171e914a901c` |
| EntryPointSimulations08 | `0x91d444464761938481062341ceea4d3bad49e4cc` |
| EntryPointSimulations09 | `0x292cf1519b860739974f96c35e1b874169fc525b` |

### 3.4 必须应用 SafeValidator 定制补丁（OxaChain 定制 EP 模拟解码）

修改 `/opt/pocketx/alto/src/esm/rpc/validation/SafeValidator.js`（TS 源 `src/rpc/validation/SafeValidator.ts` 同步，避免重新构建覆盖）：

1. 解码用 `EntryPointV07Abi` 回退（含 `DelegateAndRevert` error 定义）：先试 `pimlicoSimulationsAbi`，失败回退 `EntryPointV07Abi`；
2. `errorName === "DelegateAndRevert"` 时解包 `(success, ret)`：`success=false` → 解内层 error 并抛 `RpcError(SimulateValidation)`；`success=true` → 用**手写单 tuple v0.7 ValidationResult 参数**（returnInfo 5 字段 preOpGas/prefund/accountValidationData/paymasterValidationData/paymasterContext + senderInfo/factoryInfo/paymasterInfo/aggregatorInfo）`decodeAbiParameters` 解码 ret；
3. 其余分支（AA24/AA31 等）原有映射逻辑保留。

> 不应用此补丁 → `eth_sendUserOperation` 返回 HTTP 500（模拟 revert data 无法解码）。

### 3.5 启动后验证

```
eth_supportedEntryPoints          → ["0x97e4Cddc...82798a"]
eth_chainId                       → 0x4c31（19505）
pimlico_getUserOperationGasPrice  → maxFee ≈ 1 gwei
eth_sendUserOperation             → 正常返回 userOpHash（可再用 AgentX 的 E2E 验证）
```

## 4. 需 infraX 确认保留的配置

### 4.1 ⚠️ 链上 Kernel 实现的 initialize 是 4 参数（关键实证）

OxaChain 上 Kernel 实现 `0x5131d75af2126eba05edbb6bc24902c42d1b52b4` 的字节码中：
- ✅ 含 **4 参数 initialize selector `0x12af322c`**（对应 aa-sdk `kernelVersion: '0.3.0-beta'`）；
- ❌ **不含** 5 参数 selector `0x3c3b752b`。

`eth_call` 实测（2026-08-18）：`createAccount` 用 **0.3.0-beta 编码部署成功**；0.3.1/0.3.2/0.3.3 的 5 参数编码**必 revert**。即：设计文档 §8.3 中"Kernel v3.1"的表述与链上字节码的 initialize 签名不一致，**请 infraX 复核**；但不论标签如何，**工作配置就是 4 参数编码（0.3.0-beta）**。

### 4.2 aa-relay 的 kernel 版本（AgentX 已修改，请确认保留）

在 **43.163.105.172** 的 `infrax-aa-relay.service.d/kernel-version.conf` 已新增并重启生效：

```
[Service]
Environment="AA_OXACHAIN_KERNEL_VERSION=0.3.0-beta"
```

否则 relay `/v1/session` 返回的账户地址按 0.3.1 编码计算（与链上实际部署的 4 参数账户不同，无法使用）。

### 4.3 relay bundler 指向

`AA_OXACHAIN_BUNDLERS` 当前仍为 `http://43.159.60.46:4338`（等 Alto 恢复即自动生效，无需改动）。

## 5. 需 infraX 协同设计：智能账户 escrow 充值路径

relay A-10 计费当前为 **escrow 模式**（`ESCROW_MODE=true`）：
- 每次 UserOp 向 `op.sender`（= 智能账户）预扣「固定费 + 预估 gas」（本次 enable 实测约 **0.00246 OXA**）；
- 余额取自链上 `InfraXEscrow(0x8bf8ffee86f1d4a160f0953eb13bedcbf99eaf9e).balanceOf(sender)`；
- `deposit()` 只记 `msg.sender`，因此**无法由用户 EOA 直接给智能账户充值**。

AgentX 产品流程是"用户自付 gas"（EOA 转 OXA 给智能账户 → Kernel `receive()` 转 EntryPoint deposit → 自付 gas 调 `escrow.deposit()`）。请 infraX 确认该充值链路可行，或提供更简洁的充值方案（如 `depositFor`/`deposit` 变体、或按需关闭 escrow 预扣走纯链上结算）。

## 6. 恢复后的 AgentX 全链路验证清单（由 AgentX 执行）

1. `enable` → relay 创建 session + 智能账户部署（已验证 ✅）；
2. 智能账户 escrow 充值（§5 方案落定后）；
3. `confirm` → ENABLE-mode UserOp 经 bundler 上链（receiptSuccess=true）；
4. 订阅到期窗口内 daemon 自动续订 → 新 subscription_id + renew 收据落库；
5. 审计日志（enable/confirm/renew 幂等）。

测试钱包：`0xd8e2cf33e9784dc521d7d7f5fbb4a690be502812`（oxachain，~79 OXA）；订阅 `subscription_id=10 / agent_id=30 / plan_id=18`。

---

### 附：本次 AgentX 侧已交付的代码修复（不影响 infraX，仅存档）

- `d8ad3a2` relayRequest BigInt 序列化；`14d9141`/`b66df11`/`2bd2503` kernel 版本对齐（含 `getAaChainConfig` 与 `ensureAccountDeployed` 两处）；`b415ad1` `parsePolicy` 兼容 pg jsonb 对象。
- 测试文档：`docs/test-cases-aa-auto-renew.md`（128 用例）。
