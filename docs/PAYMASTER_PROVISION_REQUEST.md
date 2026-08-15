# PocketX → InfraX 物料索取 — OxaChain Paymaster 对接清单

> 关联任务：tasklist §9.10 A-4（Paymaster 对接）｜ 定稿：2026-08-11 ｜ 状态：✅ **已闭环（2026-08-16）**：PocketX 回复澄清——不运营 Paymaster、AA 链上栈归 InfraX 维护、OxaChain Pimlico 官方不支持（既定约束）→ 催料路径关闭，转 **B-4 自建 verifying paymaster** 实施（用户 2026-08-16 裁定启动）。对方确认：EntryPoint v0.7 `0x97e4cddcffeaf4580bc6315fee512f2b2d82798a`（08-07 部署 eth_getCode 通过）+ 直接主网小额联调（PocketX 提供小额 OXA）+ 降级"用户自充"已设计。

## 背景

按交接约定，链上 AA 栈已移交 InfraX 维护。PocketX 侧 aa-sdk 已具备 Paymaster 接入的接口骨架（Pimlico 协议，EntryPoint v0.7），客户端方法（`pimlico_getPaymasterStubData` / `pimlico_getPaymasterData`）与服务端代理（aa-relay）为待建项——收到物料后立即完成实现并联调。目前唯一缺口为 **OxaChain 上可用的 Paymaster 服务**，请按下列清单提供对接物料。

## 我方已具备（无需提供）

| 项 | 值 |
|---|---|
| EntryPoint v0.7（OxaChain 19505） | `0x97e4cddcffeaf4580bc6315fee512f2b2d82798a` |
| Bundler（自建 Alto） | `http://43.159.60.46:4338` |
| 接入形态 | aa-sdk PaymasterClient（Pimlico 协议 v0.7）+ 服务端代理 aa-relay（apikey 服务端注入，前端零密钥） |
| 现有模式 | 用户自充 gas 为主（v1.7 决策）；Paymaster 为可选 sponsor 组件，供集成方开箱即用 |

## 一、服务端点与接入

1. **Paymaster RPC URL**：\_\_\_\_\_\_\_\_\_\_（OxaChain 19505 生产端点，Pimlico 协议）
2. **认证方式**：□ apikey　□ bearer token　□ 无需认证　→ header 名：\_\_\_\_\_\_，获取方式：\_\_\_\_\_\_
3. **计价与结算**：□ 按调用　□ 按 Gas 比例　□ 月费　→ 费率：\_\_\_\_\_\_，我方充值/结算方式：\_\_\_\_\_\_

## 二、链上合约与 EntryPoint 兼容

4. **Paymaster 合约地址（19505）**：\_\_\_\_\_\_\_\_\_\_
5. **EntryPoint 兼容性声明**：适配 EntryPoint 地址/版本：\_\_\_\_\_\_\_\_\_\_（须为 v0.7 = `0x97e4cddcffeaf4580bc6315fee512f2b2d82798a`；若仅兼容其他 EntryPoint 请注明）
6. **存款状态**：`EntryPoint.balanceOf(paymaster)` = \_\_\_\_\_\_\_\_\_\_（须非零，否则 UserOp 验证将返回 `AA31 paymasterDepositTooLow`）
7. **验证人（Verifying Signer）**：签名私钥由 □ 服务商服务端托管　□ 需我方配置；是否支持代付白名单（sender/合约）：□ 支持　□ 不支持（不支持则我方在 aa-relay 层自建风控）
8. **链上登记**：部署 txHash：\_\_\_\_\_\_，浏览器链接：\_\_\_\_\_\_，部署者：\_\_\_\_\_\_，时间：\_\_\_\_\_\_

## 三、Pimlico 协议物料

9. **接口文档**：`getPaymasterStubData` / `getPaymasterData` 请求/响应样例（含 context 处理；ERC20 版本不需要）
10. **验证样例**：dummy UserOp → stub → 估算 → data → sendUserOperation → 链上 txHash；或主网已验证 txHash：\_\_\_\_\_\_\_\_\_\_
11. **协议版本声明**：v0.7 spec 兼容确认（`entryPoint` 参数传 `0x97e4cddc…`）：□ 确认

## 四、验证流程与联调

12. **测试环境**：□ 测试网　□ 测试额度　□ 直接主网小额联调（我方用小额 OXA 验证）
13. **验证流程文档**（若有，直接给链接/文件）：\_\_\_\_\_\_

## 五、运营 SLA

14. **可用性与限流**：QPS 上限：\_\_\_\_\_\_，超时时间：\_\_\_\_\_\_ s，SLA 承诺：\_\_\_\_\_\_
15. **降级策略**：Paymaster 不可用时我方回退「用户自充」模式——需服务商配合：□ 提前通知　□ 维护窗口　□ 无需配合

## 六、我方收到后立即执行（无需贵方配合）

> **2026-08-16 全部完成**（自建路径，见 §9.10 A-4 / §9.11 B-4）：对方澄清后物料转自建侧补齐，以下 4 项均已落地并验证。

1. ✅ 验证 URL 可达 + Pimlico 协议响应 → 自建 signer 服务 `http://127.0.0.1:9134`（aa-paymaster，systemd `infrax-aa-paymaster.service`），health 正常
2. ✅ 验证 EntryPoint v0.7 兼容 + Paymaster 存款非零 → 自建合约 `0xc894ef13597f15a2fe8475b5914d1151da852f33` 对接 EntryPoint v0.7 `0x97e4cddc…`，`depositTo` 充值 1 OXA（非零，避 AA31）
3. ✅ 实现 aa-sdk PaymasterClient（stubData / data）+ aa-relay `/v1/paymaster` 服务端代理 → `AA_OXACHAIN_PAYMASTER_URL=http://127.0.0.1:9134` 已接线（aa-relay drop-in），代理链路 curl 验证通过
4. ✅ 端到端验证（带 paymaster 的 UserOp 主网实测）→ E2E 5/5 通过（`scripts/aa-e2e-paymaster.ts`：stub 填充 → 260 字符 paymasterAndData → 签名 → bundler 广播 receipt success → sender 余额不变 → EntryPoint balanceOf(paymaster) 减少，tx `0xed508087…`）→ tasklist A-4 已闭环

---

> 以上物料齐备后，我方预计即可完成接入并联调。如有疑问随时沟通。

---

## 七、多调用者通用化设计（接入时一并确定）

> Paymaster 为**平台统一服务**（非 PocketX 定制）：链上 Paymaster 对所有 UserOp 开放，平台 aa-relay 为统一入口，SDK（session-key-core 0.2.0 `Aa.PaymasterClient`）统一。PocketX 是首个调用者，其他集成方接入路径一致。接入时须一并确定以下通用化设计：

1. **成本归属**：Paymaster 代付 gas 成本归属——
   - 方案 A：平台统一 sponsor（默认关闭），按集成方 API Key 对账，从其余额扣费
   - 方案 B：仅白名单集成方启用 sponsor，非白名单回退"用户自充"
   - 需在 aa-relay 落地"按调用者记账/扣费"（复用 payments 引擎 ledger）
2. **策略隔离**：按集成方/场景区分代付策略——Pimlico sponsorship `policyId`（`PaymasterRequestContext.policyId` 已支持）：
   - 每调用者独立 policy（可代付 sender 白名单 / 单笔与日限额）
   - 无 policyId 的调用走统一默认策略 + relay 层风控
3. **多服务商容灾**：当前只对接一个第三方——故障影响所有调用者：
   - 支持多 Paymaster URL 列表（按链 + 优先级，参考 Bundler 多端点容灾）
   - 保底降级：Paymaster 不可用时回退"用户自充"（现有 v1.7 决策，已具备）
4. **配额与限流**：aa-relay `/v1/paymaster` 按调用者 API Key 做配额/限流，防止单一调用者挤占其他（对齐现有 1 分钟滑动窗口限流模式）

> 上述 1-4 均落在平台侧（aa-relay / payments），SDK 与调用方接口不变。
