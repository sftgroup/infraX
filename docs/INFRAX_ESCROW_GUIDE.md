# InfraXEscrow 部署与集成指引

> 对应需求：AgentX 通用支付能力需求 **OE-2**（标准 Escrow 合约参考实现）；tasklist **AX-2**。
> 合约源码：`projects/escrow/contracts/InfraXEscrow.sol`（UUPS 升级 + 手写 nonReentrant，OZ 5.6.1）。
> 当前生产部署（oxachain 19505）：proxy `0x8Bf8Ffee86F1D4a160f0953Eb13BEDcBF99eaF9E`，implementation `0x5ff8638103723d38b5103bf6bb9ba2abf36e3bca`（2026-08-19 REQ-1/REQ-5 两次升级），owner `0x257a0E759B4A7B97680354728cda2796eDbDBbF4`。

## 1. 这是什么

`InfraXEscrow` 是标准的**金库托管合约**，解决"x402 余额资金直转平台 EOA"的单点私钥托管风险：用户充值资金进入金库合约托管，引擎通过链上事件验收入账（ledger 仅作索引/对账层，链上为权威）。

接口与 `X402Adapter.verifyEscrowDepositTx` 的 OE-5 判定完全对齐（`Deposited(user, amount, token)` + `balanceOf(user)`），AgentX 可直接部署使用，**无需自写金库合约**。

## 2. 合约能力

| 能力 | 函数 | 说明 |
|---|---|---|
| 充值 | `deposit()` / `depositERC20(token, amount)` | native / ERC20 入金（记 msg.sender），emit `Deposited(user, amount, token)` |
| 代充（REQ-1） | `depositFor(user)` / `depositForERC20(token, amount, user)` | EOA 单笔 tx 代**他人**入账（智能账户充值闭环）；emit `DepositedFor(user, amount, token, by)` |
| 批量代充（REQ-5） | `depositForBatch(users, amounts)` / `depositForERC20Batch(token, users, amounts)` | 单 tx 多账户入账（msg.value 须等于各额之和），逐账户事件；多子账户/多期续订场景 |
| 提现 | `withdraw()` / `withdrawERC20(token, amount)` | 仅用户本人提取自有余额 |
| 计费 | `charge(user, amount)` / `refund(user, amount)` | 仅 relayer 调用；原子记账 + perTx/perDay 限额 |
| 查询 | `balanceOf(u)` / `erc20BalanceOf(u, t)` / `chargedToday(u, day)` | 对账锚点 |
| 治理 | `pause()/unpause()` | 仅 owner；冻结计费（升级前置条件） |
| 限额 | `setChargeLimit(u, perTx, perDay)` / `setChargeDefaultLimit(...)` | 默认 perTx=1 OXA / perDay=10 OXA |
| relayer | `setRelayer(addr)` | 仅 owner；授权扣款方 |
| 升级 | UUPS `upgradeTo` | 仅 owner，且**升级前必须 pause** |

## 3. 部署步骤

```bash
cd projects/escrow
# 本地测试网试跑
npx hardhat run scripts/deploy.ts
# 目标链主网（需 DEPLOYER_PRIVATE_KEY + 可选 RPC）
DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.ts --network oxachain
```

部署产物：proxy + implementation（UUPS）。脚本输出两者地址、owner、默认限额。

**升级记录（2026-08-19）**：`scripts/upgrade.ts`（pause → upgradeTo → 校验 → unpause）。
- REQ-1：新 implementation `0x8dd8ea5631bb042403006ac2442e8398b1ee182b`（`depositFor`/`depositForERC20` + `DepositedFor` 事件）；生产实测 owner 代充 0.001 OXA → `balanceOf` 精确 +0.001（tx `0x4b798174…`）✅
- REQ-5：新 implementation `0x5ff8638103723d38b5103bf6bb9ba2abf36e3bca`（批量代充）；生产实测 `depositForBatch` 单 tx 双账户精确入账（tx `0x0bd95a6c…`）✅
- ⚠️ hardhat-upgrades 执行后可能误报 `transaction execution reverted`（内部 validateUpgrade 模拟 revert），**以链上状态为准**（ERC-1967 impl 地址 + paused + 新函数 selector），详见 `docs/AA_STACK_GOTCHAS.md` §6。

**上线前必做**：
1. **owner 移交**平台管理地址（脚本注释处 `transferOwnership`；密钥 HSM/轮换保管）。
2. 校验 ERC-1967：`upgrades.erc1967.getImplementationAddress(proxy)` 与脚本输出一致。
3. （如启用 relayer 扣费）`setRelayer(relayerAddr)` 授权。
4. （如启用计费限额）按业务 `setChargeDefaultLimit(perTx, perDay)`。

## 4. 集成到 payments（x402 金库判定）

1. 部署 escrow（见 §3），得到 `ESCROW_ADDRESS`。
2. 在 payments 部署注入配置：

```bash
# systemd drop-in / .env
X402_ESCROW_ADDRESS=0x<escrow-proxy-address>
```

3. 配置后 `PaymentsService` 构造 `X402Adapter` 自动携带 `escrow`，`verifyAndCredit` 走 `verifyEscrowDepositTx` 判定：`tx.to == escrow.address` + `Deposited(user, amount, token)` 事件 + `amount ≥ price` → 幂等入账 ledger。

   > AX-1 已修复服务层透传（此前 server.ts 注入的地址被 `PaymentsService` 丢弃，HTTP 路径 escrow 判定不可达）。

4. 核对能力暴露：`GET /capabilities` 的 `x402.config` 现在含 `escrow` 字段（未配置时省略）。
5. 集成方合约对齐事件 ABI：`@0xinfrax/payments` 导出 `escrowDepositAbi`（`Deposited(address indexed user, uint256 amount, address token)`）。

### 验收（OE-1/OE-2）

- 集成方按文档配置 `x402.escrow.address` 后，`verifyAndCredit` 自动走 escrow 判定，无需改引擎代码。
- `GET /capabilities` 返回 `x402.config.escrow`。
- 资金进入金库托管（`balanceOf(user)` 增长），payTo 直收路径不再承接余额充值。

## 5. 治理说明（OE-2 确认）

- **不引入外部多签**：治理全部由合约机制承担（owner=平台管理地址，密钥 HSM/轮换）。
- **熔断**：`pause` 冻结计费；**升级安全**：UUPS 升级要求已暂停。
- **资金上限**：现行为 perTx/perDay 扣款限额兜底；**托管资金总额上限列为可选项**（如需可在下一版本加 `totalBalanceCap`，见下）。

## 6. 可选增强（未实现，按需排期）

- **owner 提现 / sweep**：合约仅用户本人 `withdraw`；如需 owner 归集（如资金池回收），可加 `sweep(user, amount)`（仅 owner，多签治理时使用）。
- **资金总额上限**：`deposit`/`depositERC20` 增加 `totalBalance + amount ≤ cap` 校验。
- **ERC20 充值判定（OE-3）**：引擎侧 `verifyEscrowDepositTx` 目前仅 native；ERC20 escrow 判定见 tasklist AX-3。

## 7. 对账（OE-4 参考实现）

`projects/escrow/scripts/reconcile.ts` 提供链上余额 ↔ ledger 对账参考：`balanceOf/chargedToday` + Deposited/Withdrawn/Charged/Refunded 事件聚合 ↔ `payment_credits/payment_balances`，守恒 + 索引 + 阈值三断言，exit 0/1。运行：

```bash
cd projects/escrow
npm run reconcile   # 详见脚本头部注释（迁移基准参数 LEGACY_BASE_* 说明）
```
