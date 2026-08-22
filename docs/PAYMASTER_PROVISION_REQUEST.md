# InfraX → InfraX 物料索取 — OxaChain Paymaster 对接清单

> 关联任务：tasklist §9.10 A-4（Paymaster 对接）｜ 定稿：2026-08-11 ｜ 状态：✅ **已闭环（2026-08-16）**：InfraX 回复澄清——不运营 Paymaster、AA 链上栈归 InfraX 维护、OxaChain Pimlico 官方不支持（既定约束）→ 催料路径关闭，转 **B-4 自建 verifying paymaster** 实施（用户 2026-08-16 裁定启动）。对方确认：EntryPoint v0.7 `0x97e4cddcffeaf4580bc6315fee512f2b2d82798a`（08-07 部署 eth_getCode 通过）+ 直接主网小额联调（InfraX 提供小额 OXA）+ 降级"用户自充"已设计。

## 背景

按交接约定，链上 AA 栈已移交 InfraX 维护。InfraX 侧 aa-sdk 已具备 Paymaster 接入的接口骨架（Pimlico 协议，EntryPoint v0.7），客户端方法（`pimlico_getPaymasterStubData` / `pimlico_getPaymasterData`）与服务端代理（aa-relay）为待建项——收到物料后立即完成实现并联调。目前唯一缺口为 **OxaChain 上可用的 Paymaster 服务**，请按下列清单提供对接物料。

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

> Paymaster 为**平台统一服务**（非 InfraX 定制）：链上 Paymaster 对所有 UserOp 开放，平台 aa-relay 为统一入口，SDK（session-key-core 0.2.0 `Aa.PaymasterClient`）统一。InfraX 是首个调用者，其他集成方接入路径一致。接入时须一并确定以下通用化设计：

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

---

## 八、InfraX 三项接入阻塞响应（2026-08-16，全部就绪 ✅）

InfraX 链上核实确认（合约 `0xc894ef…852f33` / EntryPoint v0.7 `0x97e4cddc…` / balanceOf≈1 OXA / chainId 19505 / E2E 5/5）后提出 3 项接入阻塞，均已解决：

### ① SDK 发布 ✅ → `@0xinfrax/aa-sdk@0.1.0`

- 原 `@infrax/aa-sdk` 404：`@infrax` scope 私有包发布需付费（E402），改 **`@0xinfrax` scope + `--access public`** 发布
- `https://registry.npmjs.org/@0xinfrax/aa-sdk/-/aa-sdk-0.1.0.tgz`（43 files，`type: module`，peer: viem ≥2 / permissionless ≥0.2）
- `@0xinfrax/session-key-core@0.2.1` 亦已发布（InfraX 误查无 scope 名才 404）
- 若需 git 依赖形式：`https://github.com/sftgroup/infraX` `projects/aa-sdk/`

### ② 导出补齐 ✅（3 处全齐，需求单三.1/三.2/三.3）

- 三.1 `entryPointAbi`：`activate.ts` `export const`（EntryPoint v0.7 getNonce ABI）✅
- 三.2 `parseBundlers`：`config.ts` `export function`（JSON 数组 / URL 容错 / 缺失抛错语义保留）✅
- 三.3 `MpcSigner` 双模式（email/token）——方案 A，InfraX 已确认 ✅
- 产物验证：`dist/index.d.ts` barrel 导出 `config.js`/`activate.js`，`import { entryPointAbi, parseBundlers } from '@0xinfrax/aa-sdk'` 可达

### ③ aa-relay 公网入口 ✅（端口澄清 + 对外 URL）

**端口澄清**（通知中 9134 与 systemd 9131 不一致的原因）：

| 端口 | 服务 | 说明 |
|------|------|------|
| **9131** | aa-relay 网关 | **对外入口**（systemd `infrax-aa-relay`，`PORT=9131`）——InfraX 应对接这里 |
| 9134 | 内部 signer | aa-paymaster 签名服务（`infrax-aa-paymaster.service`），**仅内网**，不可直连；aa-relay 经 `AA_OXACHAIN_PAYMASTER_URL=http://127.0.0.1:9134` 代理 |

**公网入口**：`https://rpc-gw.0xainet.top/aa-relay/`（nginx 172 `rpc-gw` vhost 新增 `/aa-relay/` → `127.0.0.1:9131`）

> 注：`infrax.0xainet.top` 域 CF Worker 层存在既有 502（非本次引入，影响该域全部路径含 /mcp/），故 aa-relay 入口落在 CF→172 可达的 `rpc-gw` 域；infrax 域 nginx 亦已加同款 `/aa-relay/` 代理，待 CF 修复后可直接切换。

| 端点 | 契约 |
|------|------|
| `GET /aa-relay/health` | 健康检查（免鉴权） |
| `POST /aa-relay/v1/userops` | `{chain, op, wait?}` → `{userOpHash, bundlerUrl, receipt}`（wait 轮询 120s） |
| `GET /aa-relay/v1/userops/:hash?chain=oxachain` | 收据查询 |
| `POST /aa-relay/v1/estimate` | `{chain, op}` → gas 估算 |
| `POST /aa-relay/v1/paymaster` | `{chain, method, params}` → Pimlico paymaster 代理（隐藏 apikey） |

**鉴权**：`X-API-Key: infrax-bridge-2fd4fbe0d33805362ac980fde74c86b2`（或 `X-Service-Key` / `Authorization: Bearer`）——所有 `/v1/*` 必须携带，否则 401。

**配置示例（InfraX 侧 aa-sdk env）**：

```bash
AA_OXACHAIN_PAYMASTER_URL=https://rpc-gw.0xainet.top/aa-relay/v1/paymaster
AA_OXACHAIN_BUNDLERS=[{"url":"http://43.159.60.46:4338","priority":0}]
# 入口（userops/estimate）指向：https://rpc-gw.0xainet.top/aa-relay
```

**公网验证（2026-08-16）**：`/aa-relay/health` 200；无 key `/v1/userops` 401；带 key 契约校验 400；`/v1/paymaster` stub 请求返回 paymaster `0xc894ef…852f33` + stub data（全链路 公网→CF→nginx→aa-relay:9131→signer:9134 打通）。

**InfraX 后续动作**：切换依赖 → 配置 `AA_OXACHAIN_PAYMASTER_URL` 与 aa-relay 入口 → 带 paymaster 的 UserOp 主网端到端实测 → 闭环归档。

---

## 九、测试额度预存操作记录（2026-08-16 InfraX 需求单 需求1）

> 背景：InfraX relay 广播至 `/v1/userops` 被 A-10 计费 402 拦截（subscriber ledger 余额 0）。
> 采用方案 A：payments 引擎 ledger 预存 1 OXA 测试额度（联调专用，勿用于生产）。
> 预存对象（Subscriber/sender）：`0x121E843DA317522634a0b64f3305cD03337f1a83`
> （联调固定测试私钥推导；运营钱包 `0x52Ec58…8e06` 已直调 factory 预部署，code 61 B）

**执行位置**：生产机 payments DB（systemd 配置 `postgresql://postgres:postgres@localhost:5432/infrax_payments`；payments 引擎无预存 REST 端点，入账仅 x402 verify，故走 DB 直写）。

```sql
BEGIN;
-- 台账（幂等：reference 唯一，重复执行不重复入账）
INSERT INTO payment_credits (reference, payer, amount_wei, asset, chain_id, metadata)
VALUES ('topup-infrax-test-20260816-1oxa',
        '0x121e843da317522634a0b64f3305cd03337f1a83',
        '1000000000000000000',                                  -- 1 OXA
        '0x0000000000000000000000000000000000000000',          -- 原生资产
        19505,                                                 -- oxachain
        '{"purpose":"InfraX P0.3 relay test topup (1 OXA)","requested":"2026-08-16"}'::jsonb)
ON CONFLICT (reference) DO NOTHING;
-- 余额（幂等累加：重复执行只加一次）
INSERT INTO payment_balances (address, asset, balance_wei)
VALUES ('0x121e843da317522634a0b64f3305cd03337f1a83',
        '0x0000000000000000000000000000000000000000',
        '1000000000000000000')
ON CONFLICT (address, asset)
DO UPDATE SET balance_wei = payment_balances.balance_wei + EXCLUDED.balance_wei,
              updated_at = NOW();
COMMIT;
```

**验证**：

```bash
# ① DB 直查（期望 1000000000000000000）
psql "postgresql://postgres:postgres@localhost:5432/infrax_payments" -tAc \
  "SELECT balance_wei FROM payment_balances WHERE address='0x121e843da317522634a0b64f3305cd03337f1a83';"
# ② 引擎 REST（aa-relay A-10 计费实际查询路径）
curl -s "http://127.0.0.1:9132/payments/balance?address=0x121E843DA317522634a0b64f3305cD03337f1a83"
```

**执行状态**：✅ 已执行（2026-08-16 预存 SQL 在生产 ledger DB 执行成功；`payment_balances` 入账 1 OXA = 1,000,000,000,000,000,000 wei，`payment_credits` 台账 reference=`topup-infrax-test-20260816-1oxa`，均验证通过；已回复 InfraX 确认，等待其重跑 relay 广播回传 txHash + 存款扣减验证）。

> 注：首次执行曾因 `balance_wei` 为 text 类型、`text + text` 无累加运算符报错回滚；修正为 `(balance_wei::numeric + EXCLUDED.balance_wei::numeric)::text` 后执行成功。链上转账（InfraX 已转 10 OXA）只增链上原生余额，不计入 ledger；ledger 仅 DB 直插或 x402 verify 入账。

### 补充：为什么计费用 ledger 而非直接读链上余额

- **原子预扣**：ledger 预扣是账本内记账（防并发超扣）；链上余额只能读不能冻结，并发 userop 会超卖。
- **零 gas 结算**：ledger 结算（平台 ↔ subscriber 划转、退款）是 DB 行更新，零 gas、可回滚；链上结算需真实转账 tx（gas + 失败重试）。
- **平台可动用性**：subscriber 链上余额归用户控制，平台无法自主扣款；ledger 由平台托管。

### 正式充值路径（x402，生产推荐，替代 DB 直插）

链上资产 → ledger 的自动入账桥（[billing.ts](https://github.com/sftgroup/infraX/blob/main/projects/aa-relay/src/billing.ts) 充值提示即此路径）：

```text
1. 用户从 subscriber 地址向平台钱包转入 OXA
   平台钱包（AA_PLATFORM_ADDRESS）: 0x5682e2d55770e46ad24b92e51d6d0a3b629fa0b3
2. 调用引擎 POST {AA_PAYMENTS_URL}/payments/verify { txHash }
3. 自动入账到转出方（subscriber）对应的 ledger 账户，与 DB 直插等效
```

> 2026-08-16 联调实测：InfraX 将 10 OXA 转给 subscriber **自身智能账户**（链上原生余额），未走上述桥（转平台钱包 + verify），故 ledger 仍为 0。正确做法是转给平台钱包后调 verify，即自动入账；已预存 1 OXA 足够本次联调（需求 0.00466 OXA）。
