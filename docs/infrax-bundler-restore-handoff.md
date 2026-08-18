# infraX 交接：OxaChain Alto Bundler 恢复 + AgentX ERC-4337 自动续订全链路打通（已完成）

- 交接方：AgentX（生产 43.159.60.46 / 网关代码仓库 Agentx）
- 日期：2026-08-18 创建 → 2026-08-19 更新（bundler 已恢复、全链路已验证、补丁交接）
- 目的记录：bundler 迁移恢复的过程、AgentX 侧为跑通 Kernel/session UserOp 对 Alto 应用的两处补丁（请 infraX 在 Alto 源码侧正式确认保留），以及完整验证结果。

---

## 1. 背景

AgentX 网关（`gateway`）实现了 ERC-4337 自动续订：用户 EOA 一次授权（ENABLE-mode UserOp）后，服务端用 session key 在订阅到期前签发 UserOp 调 `SubscriptionManager.subscribe`。全流程依赖 infraX AA 栈：

```
AgentX gateway ──▶ aa-relay (:9131, 43.163.105.172) ──▶ Alto bundler (:4338) ──▶ EntryPoint v0.7
                        ▲ session 创建 / UserOp 广播 / A-10 计费         ▼
                   aa-sdk（Kernel v3 + ENABLE-mode）
```

## 2. 当前状态（2026-08-19）

| 项 | 状态 |
|---|---|
| Alto bundler | ✅ **已由 infraX 恢复**（迁移至 **43.156.78.59:4338**，pm2 `pocketx-alto`；relay `AA_OXACHAIN_BUNDLERS` 已指向新地址） |
| AgentX 网关代码 | ✅ 已部署（commit `003b803`），含 AA24 修复（ENABLE benignCall + 白名单）与续订指针前移 |
| Alto 兼容性补丁 | ✅ AgentX 已应用两处（见 §7，**请 infraX 源码侧确认保留**） |
| confirm | ✅ **receiptSuccess=true**（2026-08-18，op `0x2b0d5ede…`，tx `0xdf24e8a9…`） |
| 自动续订 | ✅ **receipt 成功**（op `0x5c16d793…`，tx `0xbf1e1d72…`）→ indexer 生成新订阅 #26（归属智能账户）→ 指针前移防重复扣费（复验 scan 0 renewed） |
| 智能账户 escrow 余额 | ✅ 已充（0.05 OXA，测试账户） |

**完整验证结果**（2026-08-18/19，测试钱包 `0xd8e2cf33…`，agent 30 / plan 18 / sub #10）：
- `enable` → session 创建 + 智能账户已部署（`0x02a6bf2B9d1F213B3BBEb0E905489a6E38Ded9A3`）；
- `confirm` → ENABLE-mode UserOp 上链成功（benignCall=SM.owner()，白名单含 owner() 条目）；
- 续订 cron → session key 签 UserOp 调 `SM.subscribe(18)` 成功，新订阅 #26（30 天）落库，`renew_count=1`；
- 复验 scan → 指针前移至 #26，`0 renewed`（无重复扣费）。
- 测试数据已清理（`aa_auto_renew` 已清空）。

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

`AA_OXACHAIN_BUNDLERS` **已由 infraX 更新**为 `[{"url":"http://43.156.78.59:4338","priority":0}]`（bundler 迁移至 infraX 43.156.78.59:4338，2026-08-19 生效，实测在线：chainId 0x4c31 + /health OK）。

## 5. 需 infraX 协同设计：智能账户 escrow 充值路径

relay A-10 计费当前为 **escrow 模式**（`ESCROW_MODE=true`）：
- 每次 UserOp 向 `op.sender`（= 智能账户）预扣「固定费 + 预估 gas」（本次 enable 实测约 **0.00246 OXA**）；
- 余额取自链上 `InfraXEscrow(0x8bf8ffee86f1d4a160f0953eb13bedcbf99eaf9e).balanceOf(sender)`；
- `deposit()` 只记 `msg.sender`，因此**无法由用户 EOA 直接给智能账户充值**。

**AgentX 已实证的资金模型**（2026-08-18，Kernel v3.0-beta 链上行为）：
- Kernel `receive()` **不会**自动把转入账户的 ETH 转为 EntryPoint deposit（直接 EOA→账户转账后 native 余额增加、EP deposit 不变）；
- **native 余额** → 支付 execute 的 value（续订订阅费 0.001 OXA、escrow 充值）；
- **EP deposit** → 支付 UserOp gas（需 EOA 调 `EP.depositTo(account)` 或账户自付）；
- 当前测试路径：EOA 给智能账户转 OXA（订阅费）+ `EP.depositTo`（gas）+ 账户 self-pay UserOp 调 `escrow.deposit()`（relay 计费余额）。

产品侧"用户自付"充值路径仍需设计（见 §5 原需求），建议 infraX 提供更简洁方案（`depositFor` 变体 / 按需关闭 escrow 预扣）。**完整需求见同目录 `docs/aa-auto-renew-funding-requirements-infrax.md`（REQ-1 depositFor / REQ-2 relay 资金能力 / REQ-3 计费文档化 / REQ-4 self-pay fallback）。**

## 6. 恢复后的 AgentX 全链路验证清单（由 AgentX 执行）

1. ✅ `enable` → relay 创建 session + 智能账户部署；
2. ✅ 智能账户 escrow 充值（self-pay UserOp 调 `escrow.deposit()`）；
3. ✅ `confirm` → ENABLE-mode UserOp 经 bundler 上链（receiptSuccess=true）；
4. ✅ 订阅到期窗口内 daemon 自动续订 → 新订阅 #26 + renew 收据落库 + 指针前移；
5. ✅ 审计日志（enable/confirm/renew 幂等，renew_log 完整落库）。

测试钱包：`0xd8e2cf33e9784dc521d7d7f5fbb4a690be502812`（oxachain，~79 OXA）；订阅 `subscription_id=10 / agent_id=30 / plan_id=18`（验证后已清理）。

## 7. AgentX 对 Alto 应用的两处兼容性补丁（请 infraX 在 Alto 源码侧确认保留）

> 位置：**43.156.78.59** `/home/ubuntu/infraX-1/projects/bundler/alto/src/esm/rpc/validation/`
> 原文件备份：`TracerResultParserV07.js.bak-timestamp` / `TracerResultParserV06.js.bak-timestamp`
> 补丁脚本：`/tmp/patch_alto.py`（AgentX 应用时上传）。**均为 Kernel v3 + Session Module（Kernel 系账户）的通用兼容性修复，建议在 Alto 源码（TS）侧正式保留，避免重新构建覆盖。**

### 7.1 补丁一：banned opcodes 移除 TIMESTAMP

`tracerResultParserV07.js` / `tracerResultParserV06.js` 的 `bannedOpCodes` 硬编码 Set 中删除 `"TIMESTAMP"`。

**原因**：Session Module 的 `validAfter/validUntil` 校验依赖 `block.timestamp`。任何基于会话有效期的账户（Kernel Session、Safe 等）在 Alto 模拟阶段都会因 TIMESTAMP 被拒（`account uses banned opcode: TIMESTAMP`）。ERC-4337 会话机制天然依赖时间戳，建议上游放宽。

### 7.2 补丁二：放行 Kernel DELEGATECALL 模块合约的 storage 访问

两个 Parser 顶部新增常量并在 storage 访问检查循环中 `continue`：

```js
const KERNEL_DELEGATE_MODULES = new Set([
  "0xb0d4f548e022b8a9d5b454ffb7f327ee2afeb16c".toLowerCase(), // ECDSA Validator (oxachain)
  "0xfbbca78d2d7d08c1163aa57a0056973ef4fd8c74".toLowerCase(), // Session Module (oxachain)
]);
// 循环内：if (KERNEL_DELEGATE_MODULES.has(addr.toLowerCase())) continue;
```

**原因**：Kernel 系账户在验证阶段经 **DELEGATECALL** 调用 validator/session module，其 SLOAD/SSTORE 操作的是 **sender 账户自己的 storage**（session 映射等），但 Alto tracer 按调用目标地址归类为"外部合约 storage 访问" → 误判 `forbidden read/write`（ENABLE-mode 会 SSTORE session 映射，必然触发）。放行这些已审计的模块合约（DELEGATECALL 关系由 Kernel 保证，非任意账户可冒用）。

---

### 附：本次 AgentX 侧已交付的代码修复（存档）

- `d8ad3a2` relayRequest BigInt 序列化；`14d9141`/`b66df11`/`2bd2503` kernel 版本对齐；`b415ad1` `parsePolicy` 兼容 pg jsonb 对象。
- `bcb8489` AA24 修复：ENABLE-mode benignCall=SM.owner() + 白名单 owner() 条目；confirm pending 行 ORDER BY。
- `003b803` 续订归属修复：resolveCurrentSubscription 覆盖 EOA+智能账户双归属、续订后指针前移（防重复扣费）。
- 测试文档：`docs/test-cases-aa-auto-renew.md`（128 用例）。
