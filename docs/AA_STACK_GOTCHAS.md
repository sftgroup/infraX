# AA 栈踩坑与运维注意事项（AA STACK GOTCHAS）

> 沉淀来源：AgentX ERC-4337 自动续订接入（2026-08-18/19 全链路打通）实踩问题 + infraX 实施 REQ-1~3 中的发现。
> 适用：OxaChain + Kernel v3 + Session Module + Alto bundler + aa-relay 全家桶的运维/SDK 接入方。

## 1. Kernel initialize 是 4 参数（必须 `0.3.0-beta`）

- 链上 Kernel 实现 `0x5131d75af2126eba05edbb6bc24902c42d1b52b4` 字节码**只有 4 参数 selector `0x12af322c`**（对应 aa-sdk `kernelVersion: '0.3.0-beta'`），**不含 5 参数 `0x3c3b752b`**。
- 0.3.1/0.3.2/0.3.3 的 5 参数编码 **必 revert**；`createAccount` 必须用 0.3.0-beta 编码。
- relay 必须配：`AA_OXACHAIN_KERNEL_VERSION=0.3.0-beta`（drop-in `kernel-version.conf`），否则 `/v1/session` 返回的账户地址按 0.3.1 计算，与链上实际部署的 4 参数账户不符，**账户不可用**。
- 设计文档"Kernel v3.1"的表述与链上字节码不一致——以链上实测为准（工作配置就是 4 参数编码）。

## 2. Alto bundler 两处兼容补丁（重建会被覆盖，需保留）

位置 `projects/bundler/alto/src/esm/rpc/validation/TracerResultParserV07.js`（及 V06）：

- **补丁 A：banned opcodes 移除 `TIMESTAMP`**——Session Module 的 `validAfter/validUntil` 依赖 `block.timestamp`；任何会话有效期账户（Kernel Session、Safe）在 Alto 模拟阶段都会被拒（`account uses banned opcode: TIMESTAMP`）。
- **补丁 B：放行 Kernel DELEGATECALL 模块合约的 storage 访问**——白名单 `ECDSA Validator` / `Session Module` 地址，其 SLOAD/SSTORE 是 sender 账户自己的 storage，但 Alto tracer 按调用目标归类为"外部合约 storage 访问" → 误判 forbidden read/write（ENABLE-mode 会 SSTORE session 映射必触发）。

不应用 → `eth_sendUserOperation` 返回 HTTP 500（模拟 revert data 无法解码）。

## 3. Alto 重建必须禁用 simulations 自动部署

- 上游 `DETERMINISTIC_DEPLOYER_TRANSACTION` 常量损坏 + OxaChain 无 deterministic deployer。
- 必须 `--deploy-simulations-contract false` + 显式传 simulation 合约地址：
  `PimlicoSimulations 0x9b3d340d…` / `EntryPointSimulations07 0x0453aa5a…` / 08 `0x91d44446…` / 09 `0x292cf151…`。
- 安全组 4338 放行；executor 私钥丢失需重建并充值 OXA。

## 4. `deposit()` 只记 `msg.sender` —— 子账户充值必须 `depositFor`

- `InfraXEscrow.deposit()` 记账到 `_balances[msg.sender]`：**用户 EOA 调 deposit()，钱到 EOA 名下，永远到不了智能账户（子账户）名下**；relay 计费的 `subscriber = op.sender`（子账户）→ EOA 充值无效。
- `receive()` 兜底收转账但不改任何余额 → 直接向合约转账也不入账。
- **正确路径**：主钱包 EOA 单笔 tx 调 `depositFor(子账户)`（REQ-1，2026-08-19 已实施）；或子账户自身 session key 调 `deposit()` 自付（需会话白名单含 `escrow.deposit()`）。
- 402 提示（`topupHint`）已按计费主体区分文案，子账户场景指引 `depositFor`（REQ-2c）。

## 5. relay `/v1/plans` 需要鉴权（非公开）

- 文档曾写"公开豁免 /v1/plans"，**生产实测需 `AA_RELAY_API_KEY`**（401）。豁免仅 `/health`。

## 6. escrow UUPS 升级必须先 pause

- `_authorizeUpgrade` 要求 `paused()`，否则升级 revert。
- 升级序列：`pause()` → `upgradeTo(新实现)` → `unpause()`；升级脚本 `projects/escrow/scripts/upgrade.ts`（owner 签名，`DEPLOYER_PRIVATE_KEY`）。
- 生产代理 `0x8Bf8Ffee86F1D4a160f0953Eb13BEDcBF99eaF9E`，owner `0x257a0e759b4a7b97680354728cda2796edbdbbf4`（owner 私钥不在生产 env，需平台侧保管）。
- 2026-08-19 升级内容：REQ-1 `depositFor`/`depositForERC20` + 事件 `DepositedFor`（impl `0x8dd8ea…`）；REQ-5 批量代充 `depositForBatch`/`depositForERC20Batch`（impl `0x5ff8638103723d38b5103bf6bb9ba2abf36e3bca`）——均已在生产机执行并链上实测（单笔/批量 tx status 1）。
- ⚠️ **hardhat-upgrades 误报陷阱**：`upgrades.upgradeProxy` 成功后脚本可能抛 `transaction execution reverted`（内部 validateUpgrade 对目标链的模拟调用 revert）——**不代表升级失败**。判别标准：① ERC-1967 slot 是否已指向新 impl；② `paused()` 状态；③ 新函数（如 `depositFor` selector）是否可调用。升级中若 pause 已生效而脚本中断，先查 `paused()`，为 true 则补执行 `unpause()` 恢复计费。
- ⚠️ **生产 git 脏导致 pull 失败**：生产机跑 hardhat 编译会改动 `projects/escrow/artifacts/` 与 `cache/`（.dbg.json / solidity-files-cache.json 等已跟踪产物），`git pull --rebase` 报 `Please commit or stash them`。部署前先 `git checkout -- projects/escrow/artifacts projects/escrow/cache`（均为构建产物，丢弃安全）。
- **RPC 域名**：hardhat 默认 `rpc.l1.oxachain.io` 不可解析；生产用 `https://rpc-oxa.0xainet.top`（仅生产机可达，本地直连超时，升级须在生产机执行）。

## 7. relay 生产计费 env 位置

- ESCROW_* 在 drop-in `/etc/systemd/system/infrax-aa-relay.service.d/escrow.conf`（ESCROW_MODE=true / ESCROW_ADDRESS / ESCROW_RELAYER_KEY / ESCROW_CHAIN_ID）。
- 资金总览需 `ESCROW_ENTRYPOINT`（或复用 `AA_OXACHAIN_ENTRYPOINT_V07`）——2026-08-19 已追加，`/v1/ledger-balance` 返回 `funds{escrowWei, epDepositWei, nativeWei}`（EP/native 读取失败仅告警，对应字段 null）。

## 8. 其它本次发现

- `Promise.all` 解构陷阱：`const [deposit] = await Promise.all([readContract, getBalance])` 会丢弃 getBalance 结果，且 `deposit[1]` 是 staked 布尔（曾导致 nativeWei="false"）。**双值应 `const [depositInfo, nativeBal]`**。
- AgentX 网关端到端耗时：charge ~12s + bundler 模拟 ~24s+ → 客户端超时建议 **≥150s**（详见 AA_RELAY_BILLING.md）。
