# EPF-9 全量去除 PocketX 品牌残留方案

> 提出：2026-08-22 ｜ 状态：🔲 待排期（T-0 已完成） ｜ 优先级：见各阶段
> 背景：平台原名 PocketX，已更名 **InfraX**，且 **PocketX 已另属一个独立项目**。代码库仍残留 414 处 `pocketx`（80 文件），会造成品牌混淆与误操作。本方案为**全量去除**的完整路径，含分级、风险控制、B 端通知文案。

---

## 1. 目标与原则

- **目标**：代码库中除"不可变运行语义"与历史归档外，消除全部 `pocketx` 品牌残留。
- **原则**：
  1. **改动分级**：按运行时影响从低到高分 T-0~T-3 执行，每级可独立上线、独立回滚。
  2. **不可变项保留**（T-4）：凡改动会导致**地址派生/签名验证/既有用户查询**失效的，一律保留并加注释，不改名。
  3. **B 端无感知**：数据库改名、SDK 包名变更均不改变 API 契约；需通知 B 端的仅在 SDK 包名变更场景。
  4. **archive/ 不动**：历史归档目录保持原样。

---

## 2. 残留全景（2026-08-22 统计，`grep -ri pocketx`，414 处 / 80 文件）

### 2.1 数据库名（9 库，T-3 范围）

| 库名 | 消费方（代码位置） |
|---|---|
| `pocketx_mpc` | [mpc/server.ts](file:///home/steven/infraX/projects/mpc/server.ts#L36)、aa-relay `session-store.ts` 复用、admin `MPC_DB` 池、mpc-e2e 脚本、`.env.example` |
| `pocketx_payments` | [payments/server.ts](file:///home/steven/infraX/projects/payments/server.ts#L57)、`CALLER_SETUP.md`、`env.b-instance.example`、mq14/mq16 脚本、admin `PAYMENTS_DB` 池 |
| `pocketx_payment` | [payment/server.ts](file:///home/steven/infraX/projects/payment/server.ts#L25)（旧支付 :6004） |
| `pocketx_dc` | [dc/index.ts](file:///home/steven/infraX/projects/dc/index.ts#L22)、mq16 verify 脚本、admin `DC_DB` 池 |
| `pocketx_collector` | [collector/src/config.ts](file:///home/steven/infraX/projects/collector/src/config.ts#L12)（生产 10.3.8.6）、dc 只读、`events_partition_migrate.sql`、admin `COLLECTOR_DB` 池 |
| `pocketx_waas` | [waas/config/index.ts](file:///home/steven/infraX/projects/waas/config/index.ts#L12)、mq15 脚本、admin `WAAS_DB` 池 |
| `pocketx_vault` | [vault/server.ts](file:///home/steven/infraX/projects/vault/server.ts#L28)、admin `VAULT_DB` 池 |
| `pocketx_admin` | [admin/server/index.ts](file:///home/steven/infraX/projects/admin/server/index.ts#L26)、admin `ADMIN_DB` 池 |
| `pocketx_chainrpc` | [chain-rpc/src/services/rpcSubscription.ts](file:///home/steven/infraX/projects/chain-rpc/src/services/rpcSubscription.ts#L37)、`rpcSubscription.ts`、`.env.example` |

> admin 侧为 `${BASE}/pocketx_*` 硬拼接（`BASE=postgresql://ubuntu@localhost:5432`，见 [admin/server/index.ts](file:///home/steven/infraX/projects/admin/server/index.ts#L22)），非环境变量可覆盖——**库名迁移必须同步改 admin 代码**。

### 2.2 SDK / 包名（T-2 范围）

| 项 | 现状 | 目标 |
|---|---|---|
| `aa-sdk` | 包名已是 `@0xinfrax/aa-sdk`（commit 626460e）；description 与注释仍引用 PocketX | 清 description/注释 |
| `payment` | `"name": "pocketx-payment"`（[package.json](file:///home/steven/infraX/projects/payment/package.json#L2) + lock） | `infrax-payment` |
| `collector/sdk` | 类名 `PocketX`、包名注释 `pocketx-collector-sdk`（[pocketx-sdk.ts](file:///home/steven/infraX/projects/collector/sdk/pocketx-sdk.ts)） | `Infrax` / `infrax-collector-sdk`（确认无 B 端已发布引用后） |

### 2.3 文档 / 注释 / 示例（T-1 范围，批量低风险）

- 根级：`README.md`、`DEPLOYMENT.md`(27)、`PROJECT_STATUS.md`(14)、`REPORT.md`(7)
- docs：`AA_SDK_TECH_DESIGN.md`(16)、`PAYMASTER_PROVISION_REQUEST.md`(23)、`INFRAX_HANDOVER.md`(23)、`PLATFORM_ARCHITECTURE.md`(15)、`INFRAX_BACKUP_MULTI_IP.md`(9)、`API_ACCESS.md`、`INFRAX_MIGRATION_SCALE_OUT.md`、`PAYMASTER_ONCHAIN_ESCROW_DESIGN.md`、`AA_NEW_CHAIN_DEPLOYMENT.md`、`AA_SDK_QUICKSTART.md`、`SERVICE_API_REFERENCE.md`、`SERVICE_ENDPOINTS_OBSERVABILITY.md`、`PRODUCTION_CREDENTIALS.md`、`infrax_tasklist.md`(9) 等
- 代码注释/示例：`dataSubscriptionRoutes.ts` 示例 curl `x-dc-api-key: pocketx_dc_...`、`collector/.env.production.example`（`pocketx_app` 用户名）、各服务文件头注释（mpc/dc/payments/vault/server.ts 等）

### 2.4 运行时语义 —— 不可变（T-4 保留）

| 位置 | 内容 | 不可改原因 |
|---|---|---|
| [waas/services/walletService.ts](file:///home/steven/infraX/projects/waas/services/walletService.ts#L45) | namespace = sha256(`${userId}:${chain}:pocketx`) | **改则所有既有地址派生路径改变**，存量钱包不可恢复 |
| [waas/services/tenantService.ts](file:///home/steven/infraX/projects/waas/services/tenantService.ts#L203) | `walletAddress@web3.pocketx.local` 邮箱模式 | 库中已按该格式存储租户 owner_email；改则 `getTenantByWallet` 查不到存量租户 |
| [payment/src/middleware.ts](file:///home/steven/infraX/projects/payment/src/middleware.ts#L67) | 签名消息 `PocketX auth: ${timestamp}` | 已有客户端按此消息签名；改则旧签名验证失败 |
| [payment/src/middleware.ts](file:///home/steven/infraX/projects/payment/src/middleware.ts#L21) | `ADMIN_JWT_SECRET = 'pocketx-admin-' + random` | JWT 为启动随机值、无持久依赖，**可改**（低风险，归 T-1） |
| [aa-sdk/__tests__/external-wallet.test.ts](file:///home/steven/infraX/projects/aa-sdk/__tests__/external-wallet.test.ts#L70) | EIP-712 domain `name: 'PocketX'` | 若已随 SDK 对外发布，改 domain 会改变签名校验语义；**仅当确认无外部使用者后才可改** |
| `archive/` | 历史快照 | 归档保留原样，不清理 |

---

## 3. 分阶段方案

### T-0 展示/命名类清理 —— ✅ 已完成（commit 626460e，2026-08-22）

admin SPA 侧边栏/登录页/footer 品牌、mpc/vault `/health` 服务标识、waas/mpc/vault npm 包名统一 `infrax-*`（含 lock、修正 `infrax-ault`/`infrax-pc` 笔误）。

### T-1 文档/注释/示例清理 —— 🔲 P2（零运行时风险，可批量执行）

- 执行方式：按 2.3 清单逐文件清理 `pocketx` 品牌字样（注释、README、docs、.env.example、示例 curl、verify 脚本中**纯展示**引用）。
- **范围外（保留）**：2.4 表内全部运行语义项。
- 验证：`grep -ri pocketx projects --include=*.ts --include=*.js --include=*.json | grep -v node_modules` 应仅剩 T-4 保留项；服务 smoke（waas health / payments health / collector health）。

### T-2 SDK 包名/类名变更 —— 🔲 P1（需发版 + 通知 B 端）

1. `payment`：`pocketx-payment` → `infrax-payment`（package.json + package-lock.json）。
2. `collector/sdk/pocketx-sdk.ts`：类名 `PocketX`/`PocketXConfig`/`PocketXError` → `Infrax*`；注释包名 → `infrax-collector-sdk`。**前置确认**：该 SDK 是否已发布 npm 或 B 端本地引用（若已发布，需双包名并存一个版本或直接通知）。
3. `aa-sdk`：description/注释中 PocketX 字样清理（包名已定 `@0xinfrax/aa-sdk` 无需再改）。
4. 通知 B 端（文案见 §5）。

### T-3 数据库改名（9 库） —— 🔲 P0（需停机窗口）

**核心结论：不需要重建任何表** —— `ALTER DATABASE ... RENAME` 只改库名、数据与约束原样保留。

1. **代码默认值**：9 个服务的 `DATABASE_URL` fallback 与 admin `${BASE}/pocketx_*` 拼接 → `infrax_*`。
2. **DB 用户**：`pocketx_app`（EPF-8 新建，仅 collector 库）→ `ALTER ROLE pocketx_app RENAME TO infrax_app`（同步改 10.3.8.6 授权与 systemd/drop-in、`.env.production.example`）。
3. **生产迁移**（逐库，停机窗口）：
   - 停对应服务（或 `SELECT pg_terminate_backend` 清空连接）；
   - `ALTER DATABASE pocketx_<x> RENAME TO infrax_<x>;`（collector 库在 10.3.8.6，其余库位置部署时确认）；
   - 更新生产 `.env`/systemd drop-in 的 `DATABASE_URL`（collector 由 systemd `Environment=` 优先）；
   - 启动服务，验证 health + 抽查关键表行数。
4. **脚本同步**：`mq14/mq15/mq16_*.sh`、`mpc-e2e-e2.mjs`、`events_partition_migrate.sql` 中的库名。
5. **admin 池**：改 9 个 Pool 的库名后重启 admin，验证 9 服务状态页全绿。
6. **验证清单**：见 §6。

> ⚠️ 风险提示：`pocketx_collector` 为 10.3.8.6 生产库（有 events 分区表），改名需在**无写入**窗口执行；`ALTER DATABASE RENAME` 不支持事务内回滚，建议先备份 `pg_dump --schema-only` + 保留改名前的连接串记录以便快速回切。

### T-4 保留项 —— 永不改（仅加注释）

按 §2.4 在四处代码上加 `// PocketX 保留：历史品牌，改动会破坏地址派生/签名验证/存量查询（EPF-9）` 注释，防止后续误改。

---

## 4. 实施顺序与依赖

```
T-0（已完成）→ T-1（独立，可先做）→ T-2（通知 B 端）→ T-3（停机窗口，最后）
```

- T-1、T-2 无依赖，可并行；T-3 依赖 T-2 完成（避免混淆）。
- T-3 建议按"低风险库 → collector"顺序：先 waas/vault/dc/payments/admin 等，最后处理 10.3.8.6 collector。

---

## 5. B 端通知文案（T-2 时发出）

> 各位：平台自即日起统一使用 **InfraX** 品牌，原历史品牌 PocketX 已不再使用（且现有同名项目为不同主体）。
>
> 本次变更对您**无 API 契约影响**：所有接口路径、鉴权 header、返回字段、地址派生规则、签名校验消息均保持不变；数据库迁移仅发生在服务内部，您无需任何操作。
>
> 若您的代码中有对 SDK 包名 `pocketx-*` / `@pocketx/*` 的直接依赖，请按如下升级：
> - `@pocketx/aa-sdk` → `@0xinfrax/aa-sdk`（如仍引用旧包名，请改 import 并升版）
> - `pocketx-collector-sdk` → `infrax-collector-sdk`（类名 `PocketX` → `Infrax`）
> - `pocketx-payment` → `infrax-payment`
>
> 旧包名自发布新版本后仍可短暂可用（过渡期 1 个版本），随后下线。如有问题请联系我们。

---

## 6. 验证清单

| 阶段 | 验证项 |
|---|---|
| T-1 | `grep -ri pocketx`（排除 node_modules/archive）仅剩 T-4 保留项；三服务 health 200 |
| T-2 | `npm pack --dry-run` 确认包名；B 端升级后 import smoke |
| T-3 | 9 服务 health 全 200；admin 状态页 9 池全绿；`\l` 列出 9 个 `infrax_*` 库；collector events 分区写入正常（5 分钟 10 万+ 行）；waas 存量钱包地址可正常派生验证（namespace 不变） |
| 总 | `git grep -ri pocketx` 最终仅剩 T-4 项 + archive/ |

---

## 7. 回滚与注意事项

- **T-3 回滚**：`ALTER DATABASE infrax_<x> RENAME TO pocketx_<x>` + 还原代码默认值/env，重启即可；collector 需停机窗口内完成。
- **T-2 回滚**：还原 package.json 名 + 重发版本；已通知 B 端则需二次通知。
- **禁止事项**：不得改动 walletService namespace 派生、tenantService `@web3.pocketx.local` 邮箱、payment `PocketX auth` 签名消息、EIP-712 domain（除非确认无外部使用者）——详见 §2.4。
