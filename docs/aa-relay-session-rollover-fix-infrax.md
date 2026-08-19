# Kernel v3 单 Session 结构下的会话轮换问题（L12）— infraX 修复建议

> 作者：AgentX 技术团队
> 日期：2026-08-19
> 对象：infraX aa-sdk / aa-relay / Session Module 团队
> 关联：`docs/test-cases-aa-auto-renew.md` §7.2（L12）、`docs/infrax-bundler-restore-handoff.md`

---

## 1. 背景：L12 在生产被真实复现

2026-08-19 全链路真实测试中，**同一智能账户重复 enable 自动续订失败**：

1. 测试主钱包 `0xd8e2cf33…` 曾成功 enable 过一次（链上 session 已绑定）。
2. 测试清理阶段清空了 AgentX 网关登记表 `aa_auto_renew`，但**未在链上撤销 session**（历史上 disable 只是本地停用，从不真正上链）。
3. 再次 enable → `confirm` 上链报 **`FailedOpWithRevert`（AA23 signature error）**，bundler tracer 显示：

   ```
   EntryPoint → Kernel (DELEGATECALL → 0x5131d75a… impl)
             → STATICCALL → 0xb0d4f548… (ECDSA Validator) → REVERT
   ```

4. 已排除"签名本身错误"：owner 对 digest 的 ECDSA 签名经 `recoverAddress` 验证有效。

**结论**：失败不是签名问题，而是**账户链上已绑定一个 session validator，再次 enable（installModule + enableSession）被拒绝**。

---

## 2. 根因：Kernel v3 是"单 session"结构

### 2.1 结构事实（链上实证）

- Kernel v3（0.3.0-beta）同一时刻只允许一个 **session validator** 绑定在账户上。
- `enable` 实际做两件事：
  1. `installModule(VALIDATOR, sessionModule, enableData)` 把 Session Module 挂到账户的 validator 槽位；
  2. `enableSession(sessionId, …)` 写入该 session 的策略。
- 账户的 validator 绑定状态可用 Kernel v3.0-beta 的 **ERC-7579 视图** 探测：
  `isModuleInstalled(moduleType=1 VALIDATOR, sessionModule, 0x)`（eth_call）——返回 `true` ＝ 已绑定 session validator。
- **⚠️ 探测方法修正（2026-08-19 实证）**：早期用 `eth_getStorageAt(account, 0x7bcaa2ced2a71450ed5a9a1b4848e8e5206dbc3f06011e595f7f55428cc6f84f)` 判残留是**误报**——该槽存的是常驻 ECDSA root validator 的绑定（永远非零，卸载 session 后该槽不变；`isModuleInstalled(1, ecdsaValidator)` 恒为 true）。正确判定必须针对 session 模块本身调用 `isModuleInstalled`。
- 当账户已有 session 时，再次 enable 的 `installModule`/`enableSession` 覆盖被拒 → UserOp 在验证阶段 revert → bundler 返回 AA23。

### 2.2 为什么"本地 disable"无法自愈

- AgentX 的 disable 历史实现是**本地停用**（DB 置 disabled），`aa-relay /v1/session/disable` 只返回 `disableCallData`，**上链需要 owner 签名的 UserOp**，此前从未真正广播。
- 因此链上 session 一直存活 → 残留 → 重复 enable 必失败。
- 这是一个产品级缺陷（disable 后 session key 仍可调用），不只是测试残留问题。

### 2.3 关键约束：disable 与 enable 不能在同一个 confirm 回合完成

- **disable UserOp**：普通 Kernel execute（root nonce key = 0），owner ECDSA 签名上链。它会推进账户 `currentNonce()`。
- **enable UserOp**（ENABLE-mode）：EIP-712 digest **绑定构建时的 `currentNonce`** 做防重放。
- 因此**必须先广播 disable（推进 nonce）→ 再构建 enable digest**，顺序不能反、也不能并发；若先算好 enable digest 再撤销，digest 会因 nonce 变化而失配。

### 2.4 第二个坑：撤销后重 enable 的 `InvalidNonce`（2026-08-19 实证修复）

路径 A 落地后再验证发现，**仅卸载模块还不够**——紧接着的 enable 仍会 revert `InvalidNonce`（FailedOp AA23，0x756688fe）。根因在 Kernel `ValidationManager._installValidation`：

```solidity
if (state.validationConfig[vId].nonce == state.currentNonce) {
    state.currentNonce++;   // 重装时先推进 currentNonce
}
if (state.currentNonce != config.nonce || state.validationConfig[vId].nonce >= config.nonce) {
    revert InvalidNonce();  // config.nonce 还是旧值 → 必炸
}
```

- `uninstallModule` **只清 hook 不清 `validationConfig[vId].nonce`**：卸载后该 nonce 停留在旧值（例如 1），`currentNonce` 也未变（仍是 1）。
- 紧接着的 enable 用**同一个旧 currentNonce=1** 构建 digest/config.nonce → `currentNonce` 先自增到 2，再与 `config.nonce=1` 比对 → revert。
- **修复**：撤销 UserOp 不再只是 `uninstallModule`，而是**批量 execute** 同时做两件事：
  `execute(BATCH, abi.encode([uninstallModule(...), self.invalidateNonce(currentNonce + 1)]))`
  `invalidateNonce(cur+1)` 把账户 `currentNonce`/`validNonceFrom` 推进，后续 enable 读到推进后的 nonce，`validationConfig[vId].nonce >= config.nonce` 不再触发。
- **编码实证**：Kernel v3 **没有独立的 `executeBatch` 函数**（用 `executeBatch` selector 必 revert）。批量只能走 `execute(execMode, executionCalldata)`，execMode = `ExecLib.encodeSimpleBatch()` = `CALLTYPE_BATCH(0x01) | EXECTYPE_DEFAULT(0x00)` → `0x0100…0`（MSB 布局），`executionCalldata = abi.encode(Execution[])`。`execute(bytes32,bytes)` selector = `0xe9ae5c53`。链上 eth_call + 真实上链均通过。

**给 infraX 的提示**：`aa-sdk` 目前只有 `encodeExecute`（单调用），建议补充 `encodeExecuteBatch(executions)` 封装（`ExecLib.encodeSimpleBatch` 布局），业务方无需各自踩 batch 编码的坑。

### 2.5 第三、四个坑（2026-08-20 infraX 链上 E2E 实证）

- **2.5.1 `onUninstall` 为空实现 → 撤销必须直接调用 `disableSession`**：部署的 Session Module 合约 `onUninstall` 是**空实现**（字节码实证 `POP POP JUMP → STOP`），`uninstallModule` 的 deInitData 无论传 `disableSession(sessionId)` 编码还是空数据，都**不会删除 session 记录**。仅"卸载模块 + 重装新 session"后，旧 session 记录仍残留 → 旧 session key 仍可通过 `validateUserOp` 验证。**修复**：撤销 UserOp 的批量 callData 为**三段** `[disableSession(oldId)@module, uninstallModule(VALIDATOR, module, disableData), invalidateNonce(cur+1)]`，第一段直接删记录（`KernelV3SessionDataBuilder.disableData` 编码 `disableSession(bytes32)`，selector `0xf42c859d`）。
- **2.5.2 单笔轮换（一次 UserOp `[uninstall + invalidateNonce + installModule]`）不可行 → AA24**：试图把"撤销旧 + 装新"合并为单笔 root-mode UserOp，在 Kernel v3.0-beta **两次链上实测均失败**——root-mode `installModule` 只写 `validationConfig`，**不调用 `ValidationManager._setSelector`** → `allowedSelectors[vId][executeSelector]` 不设置（缺省 false）→ `validateUserOp` 的 selector 检查 revert `InvalidValidator` → EntryPoint 报 **AA24 signature error**（`0x220266b6`）。
- **正确轮换 = 两笔**（缺一不可，顺序不能反）：
  1. **① root-mode** `[disableSession(旧) + uninstallModule + invalidateNonce(cur+1)]`（owner ECDSA 签 userOpHash）——删记录 + 卸载 + 推进 nonce；
  2. **② ENABLE-mode** `enableSession(新)`（owner 签 digest + agent 签 op）——必须等 ① 上链确认后再构建（digest 绑定 ① 推进后的 `currentNonce`）。ENABLE-mode 经 `enableSession` 内部设置 selector → `validateUserOp` 正常放行。
- **验证**：`aa-session-replace-e2e.ts`（OxaChain，12/12 全绿）：enable A → 复现 AA23（重复 enable 被拒）→ ① 三段批量 disable A 上链成功 + 模块卸载 → ② enable B 上链成功 + 模块重装 → agent B 调用成功 / **agent A 调用被拒（AA24）**——旧 session 彻底撤销、新 session 完整生效。

---

## 3. 推荐的三种解决路径

| 路径 | 位置 | 调用方感知 | 链上交易 | 上线成本 | 治本程度 |
|---|---|---|---|---|---|
| **A. 调用方自愈（enable 前检测 + 先撤销再 enable）** | AgentX 网关/前端 | 多一次签名 | disable + enable 两笔 | 已实现 | 中 |
| **B. relay 层会话轮换/复用** | aa-relay / aa-sdk | 零感知或更少交互 | 复用则 0 笔，否则 1 笔 | 低–中 | 较高 |
| **C. Session Module 升级支持覆盖** | Session Module 合约 | 零感知 | 1 笔（enable 内完成轮换） | 高（重部署+审计） | 高 |

### 路径 A：调用方自愈（AgentX 已落地）

流程（enable 时）：

```
前端点击 Enable
  → POST /billing/auto-renew/enable
     ① 预测智能账户地址（factory + salt 0）
     ② isModuleInstalled(1, sessionModule) 探测残留（ERC-7579 视图，非 storage slot）
     ③ 有残留 → 解析旧 sessionId（登记表 → relay /v1/session 兜底）
     ④ 构建 disable UserOp draft（root nonce + 批量 invalidateNonce，见 §2.4）→ 返回 disableUserOpHash
  → 前端 eth_sign(disableUserOpHash) → POST /billing/auto-renew/revoke
     （网关重建 draft 校验 userOpHash 一致 → relay /v1/userops 广播）
  → 撤销成功 → 前端自动重跑 enable → 正常生成 enable digest → 签名 → confirm
```

同时，disable 时前端也自动走"签名撤销上链"，从源头消除残留。

**优点**：
- 不动 relay / 合约，AgentX 立即解决问题；
- 对 Kernel 单 session 结构零假设，只依赖一个已验证的 storage slot 布尔探测。

**缺点**：
- 用户多一次 eth_sign；
- 残留 sessionId 依赖登记表或 relay session store（两处都被清空的极端场景无法自动撤销，需要人工兜底）；
- 每轮轮换两笔链上交易（gas 成本略增）。

**给 infraX 的最小配合（可选，不阻塞）**：
1. `GET /v1/session` 返回每个 session 的 `createdAt` / 是否已链上 enable，便于调用方选残留；
2. `POST /v1/session` 响应里增加 `isBound`（账户是否已绑定 session validator），免去调用方自己读 slot。

### 路径 B：relay 层会话轮换 / 复用（推荐 infraX 评估）

两个子方案：

**B1. 一键撤销端点**：relay 提供 `POST /v1/session/disable` 的"带签名上链"变体——调用方传入 owner 对 userOpHash 的签名，relay 内部组装 disable UserOp、估算 gas、广播并返回收据。把路径 A 的"构建 + 广播"收进 relay，调用方只需一次签名，交互更简单。

**B2. session 复用**：`POST /v1/session` 创建前，relay 侧探测账户是否已绑定 session；若已绑定且**策略兼容**（同 product、target/selector 白名单覆盖、限额 ≥ 本次请求、未过期），直接返回既有 session（复用 sessionId/sessionKey），调用方完全零感知，且**无需任何额外链上交易**。不兼容（如换 plan、限额变化）时返回 `409 session-conflict`，调用方走"先撤销再 enable"。

**注意**：
- 链上 validator 状态不会因 relay session store 的清理而消失——复用判断必须以**链上状态为准**（读 slot 或调用模块视图），不能只看本地 store；
- 复用方案要解决 sessionId/私钥的跨调用方暴露问题（session key 已在 relay store，复用即再次下发，需鉴权确认调用方是同一 owner）。

### 路径 C：Session Module 升级支持 enableSession 覆盖（治本，影响面最大）

在 Kernel Session Module 合约层面支持"轮换"语义：

- **C1**：`enableSession` 在已有 session 时先自动 `disableSession(oldId)` 再启用新的（幂等覆盖）；
- **C2**：`installModule` 层面幂等——模块已安装时不再 revert，而是执行数据替换。

**优点**：调用方完全无感，单笔 enable 交易完成轮换，链路最简单。

**代价与风险**：
- 需改合约 + 重新部署 + 重新审计 + 版本兼容管理（已集成方同步升级 aa-sdk 指向新模块地址）；
- 需明确覆盖的**授权与语义边界**：谁有权覆盖旧 session？跨 plan 覆盖是否要求额外确认？（建议：仅同 owner、同 product 允许覆盖，跨 product 拒绝并提示先撤销）；
- 已部署账户不受影响（模块升级只影响新 enable），但旧账户在重新 enable 前仍需一次显式撤销（旧模块逻辑下无法覆盖），仍需配合路径 A/B 的迁移。

---

## 4. 建议

1. **短期（AgentX 已上线并全链路验证）**：路径 A 作为立即止血方案，AgentX 生产已部署。2026-08-19 生产全链路验证通过：干净 enable → confirm → 残留检测 → 批量撤销（uninstall + invalidateNonce）→ 干净 enable → confirm，`L12_HEAL_VERIFY_PASS`。测试残留已清理。
2. **中期（infraX）**：评估路径 B1（一键撤销端点）+ B2（session 复用）。B 对调用方侵入最小，且能消除"多一次签名"的体验成本。建议 relay 侧提供 `isBound` 与 disable-with-signature 两个 API，让调用方从"自建 disable 流程"中解脱。**infraX 落地结果（2026-08-19~20）**：B1/B2 已实现（`POST /v1/session/disable` + `/v1/session/revoke` 签名广播、`POST /v1/session` isBound 复用/409）；AA-7 会话轮换落地为**两笔**（`/v1/session/replace` → disable 旧 + `/v1/session/replace/submit` → enable 新走常规流程），链上 E2E 12/12 全绿（详见 §2.5）。
3. **长期**：若多业务方都依赖 session key 能力，路径 C 是彻底解，但需走合约升级流程，建议放在版本规划里评估，不与短期止血互相阻塞。
4. **保留既有兼容补丁**：Alto bundler 的 TIMESTAMP / Kernel DELEGATECALL storage 放行补丁与本问题独立，继续保留（见 `infrax-bundler-restore-handoff.md`）。

---

## 5. AgentX 侧落地位置（供 infraX 对照）

- 网关服务：`gateway/src/services/aa-autorenew.ts`
  - `hasOnChainSession()` — Kernel `isModuleInstalled(1, sessionModule)` 探测（ERC-7579 视图）
  - `resolveExistingSessionId()` — 登记表 / relay 兜底
  - `buildDisableUserOpDraft()` — disable UserOp（root nonce），callData = `execute(BATCH, abi.encode([uninstallModule, invalidateNonce(cur+1)]))`（commit 7696db6）
  - `revokeAutoRenew()` — 签名校验 + relay `/v1/userops` 广播（支持调用方回传 account/sessionId 兜底）
  - `createAutoRenew()` — enable 前残留检测（返回 `needsSessionRevoke`）
  - `disableAutoRenew()` — 本地停用 + 返回 disable draft
- 网关路由：`gateway/src/routes/auto-renew.ts`（`POST /billing/auto-renew/revoke`）
- 前端：`frontend/components/user/AutoRenewCard.tsx`（enable 自愈循环 / disable 一键撤销）、`frontend/lib/auto-renew.ts`
- 测试记录：`docs/test-cases-aa-auto-renew.md` §7.2

以上文档供 infraX 团队评估，欢迎反馈路径选择与排期。
