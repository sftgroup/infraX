# 通用支付引擎迁移记录（InfraX 视角）

> **接收方**：InfraX 通用平台团队（sftgroup）
> **交接方**：AgentX（sftgroup）
> **迁移状态**：✅ 已迁入（2026-08-08）——源码位于 `projects/payments/`，npm 包 `@0xinfrax/payments@0.1.0` 已发布
> **原包**：`@agentxv2/payments`（AgentX 历史版本至 0.2.2，旧包 deprecate 提示迁移）
> **新包**：`@0xinfrax/payments`（v0.1.0，InfraX 账号发布与维护）
> **仓库**：https://github.com/sftgroup/infraX · 目录 `projects/payments/`

---

## 1. 迁移概要

通用支付引擎（chain / Stripe / x402 v1+v2 / MPP 支付通道 / 稳定币）在 AgentX 侧已沉淀为**零业务耦合**的独立模块，经双方确认整体移交 InfraX 统一维护。

迁移决策：
1. **代码迁入** infraX 仓库 `projects/payments/`，不再由 AgentX 仓库维护通用包源码。
2. **包名归属** `@0xinfrax/payments`，由 InfraX 账号发布；`@agentxv2/payments` 旧包 deprecate，提示迁移。
3. **AgentX 保留定制层**：`@agentxv2/sdk` 的 `SubscriptionPayments` 业务封装 + 协议客户端 re-export 留在 AgentX，依赖方向改为 **AgentX → @0xinfrax/payments（registry）**，无反向依赖。
4. **能力对齐**：`@0xinfrax/payments@0.1.0` 与原 `@agentxv2/payments@0.2.2` 功能完全一致（仅包名与归属变化）。
5. **场景剥离（2026-08-10）**：模块定位收敛为**通用支付通道**，a2a-pay、period 授权制等**业务场景定义**已从模块剥离（`A2AClient` / `PeriodClient` / `payment_authorizations` 表 / 005 迁移等一并删除）；只保留通用通道能力（chain / fiat / x402 / MPP / 稳定币）。见 [HANDOVER.md §10](./HANDOVER.md#10-已知注意点踩坑记录)。

## 2. 迁入内容清单

| 资产 | 说明 | 状态 |
| --- | --- | --- |
| `src/`（engine 全部源码） | 服务 / store 接缝 / adapters / protocol / client / router | ✅ |
| `db/migrations/`（001-004） | 模块自有 `payment_*` 表，随包发布 | ✅ |
| `tests/` | 10 文件 89 断言 | ✅ 全绿 |
| `scripts/` | 解耦验证 harness（`run-decouple.sh` / `decouple-test.mjs` / `mock-stripe.mjs` / `docker-compose.yml`） | ✅ |
| 文档 | `README.md` / `DEPLOY.md` / `HANDOVER.md` / 本文件 | ✅ |
| 合约（IdentityRegistry / SubscriptionManager） | 体积约 22M，**未迁入**；验证时经 `CONTRACTS_DIR` 环境变量注入（默认指向 AgentX 合约目录） | ⚠️ 外部依赖 |

## 3. InfraX 维护责任（自本文件起）

- **发布**：npm 包 `@0xinfrax/payments`，scope `@0xinfrax`（发布账号 stevenwang000x，read-write）。
- **质量门槛**（每次发版必须全绿）：
  ```bash
  npm run build && npm run typecheck && npm test     # 89 断言
  bash scripts/run-decouple.sh                        # 解耦验证 19 断言（需 docker + CONTRACTS_DIR）
  ```
- **兼容承诺**：`PaymentsService` 既有方法签名不变；`PaymentStore` 新接口成员一律可选（`?`）；新能力以「可选 store 注入 + 新增方法」添加；intent 生命周期扩展走 `updateIntentStatus`（宿主未实现则 no-op）。
- **零耦合红线**：`dependencies` 仅 `pg` + `viem`（`express` 为 optional peer）；`src/` 禁止出现任何业务 token（`fiat_subscriptions`、`x402_*`、`agentId` 等），由解耦验证脚本自动断言。

> 详细架构、协议实现、踩坑记录见 [HANDOVER.md](./HANDOVER.md)（交接方交付内容）；使用与部署见 [README.md](./README.md) / [DEPLOY.md](./DEPLOY.md)。

## 4. 发版流程（InfraX 侧）

```bash
# 1. bump version（package.json + README/DEPLOY 版本引用）
# 2. 最小验证
npm run build && npm run typecheck && npm test
# 3. 解耦验证（独立库形态，证明零 AgentX 耦合）
bash scripts/run-decouple.sh
# 4. 发布
npm publish --access public --registry=https://registry.npmjs.org/
# 5. 验证
npm view @0xinfrax/payments dist-tags
```

> 注意：发布后 npm CDN 边缘节点可能短暂返回 404（packument/tarball 缓存），使用 `npm install --prefer-online` 或等待数分钟即可恢复；用版本级 endpoint（`npm view pkg@x.y.z`）确认。

## 5. 消费方协作与版本策略

**当前消费方**：AgentX（首个，参考实现）——`@agentxv2/sdk` 定制层 + gateway 直接依赖 `@0xinfrax/payments@^0.1.0`。

版本对接约定：
- 消费方使用 semver `^` 范围：`^0.1.0` 只自动接收 0.1.x 补丁（bugfix/安全），`0.2.0+` 不会自动进入。
- **breaking / 新能力发 0.2.0** 时，InfraX 需**主动知会 AgentX**，由 AgentX 评估升级窗口。
- **安全补丁建议回填当前 0.1.x 线**（不能只修在 0.2.0），否则滞留旧版的消费方暴露风险。

AgentX 跟随升级 check-list（InfraX 发版后，AgentX 侧执行）：

```
InfraX 发布 @0xinfrax/payments 新版
  → AgentX 升级该依赖
  → 解耦验证回归（19 项断言）
  → sdk build + typecheck + test
  → 发布 @agentxv2/sdk 新版本
  → gateway / 应用方升级 sdk
```

## 6. 职责边界

| 事项 | 负责方 |
| --- | --- |
| 通用引擎 bug / 安全修复 / 能力演进 | InfraX |
| 引擎发布与版本兼容 | InfraX |
| 消费方升级通知（breaking 时） | InfraX |
| AgentX 定制层（SubscriptionPayments 等） | AgentX |
| 宿主集成（gateway 路由 / store 实现 / 业务回调） | AgentX |
| 应用方升级节奏与窗口 | AgentX |

## 7. 遗留与待办

- [x] 源码迁入 `projects/payments/` 并改造为 `@0xinfrax/payments@0.1.0`
- [x] 构建 / typecheck / 单测全绿（87 断言）
- [x] 解耦验证全绿（19 断言）
- [x] `@0xinfrax/payments@0.1.0` 发布至 npm
- [x] `@0xinfrax/payments@0.1.1` 发布（新增 `createWebhookForwarder` + ChainAdapter `rpcHeaders`）
- [x] 首次「跟随升级」演练（0.1.1 触发一次完整 check-list，解耦回归 19 断言 + gateway 回归全绿）
- [x] 旧包 `@agentxv2/payments` deprecate 提示（npm 侧执行）
- [x] 场景剥离（2026-08-10）：a2a / period 授权制从模块删除，定位收敛为通用支付通道
- [ ] AgentX 侧：若定制层仍引用 `A2AClient` / `PeriodClient` 等场景能力，需自行实现或移除（见 AgentX 侧通知）
