# 需求单：Session Key 自动交易能力（托管服务 + SDK 封装）

> **提出方**：AIHunter SaaS（Gateway / signal-service 消费端）
> **日期**：2026-08-12
> **目标版本**：`@0xinfrax/infrax-dk` ≥ 0.8（SessionKeyAPI）
> **状态**：待评审

## 一、背景与痛点

AIHunter SaaS 交易策略托管分双轨：**轨道 A = MPC 代理钱包**（`MPCAPI` 已覆盖，用户充币式托管）；**轨道 B = Session Key 授权自动交易**（用户自持私钥，EIP-712 签名 session key，服务端在限额内自动执行）。当前痛点：

1. **SDK 无 SessionKey 能力**：`@0xinfrax/infrax-dk` 已覆盖 Wallet/Safe/Payment/MPC/Vault/DC 等 API，唯独 **SessionKeyAPI 缺失**（全仓库无 sessionKey 导出）。
2. **session-key-engine 是独立服务，无托管实例**：`projects/session-key/`（Fastify :3500）为开源独立部署形态（自带 PG/Redis/AA 基建），InfraX 未提供 **SaaS 托管实例**——消费端需自行部署、运维、接密钥，无法像 MPCAPI 一样开箱即用。
3. **客户端碎片化**：engine 自带 TS client（`packages/client`）是独立包，未纳入主 SDK 统一鉴权体系（`rx_`/`cr_` 读/写 key），Python 消费端无对应客户端。
4. **执行能力缺口**：engine 现有 ERC-4337 Kernel AA 基础（userOp + paymaster 已有雏形），但无 **SOL 等多链覆盖**、无 **userOp 回执/审计查询**、限额校验与安全审计待加固。

## 二、需求目标

1. **托管交付**：InfraX 提供 session-key-engine 的 **SaaS 托管实例**（生产可用 URL + API key），消费端免自部署。
2. **SDK 统一**：SessionKey 能力并入 `@0xinfrax/infrax-dk`（TS + Python 客户端），鉴权纳入现有 key 体系。
3. **执行面完整**：nonce → 创建 session（EIP-712 验签 + 限额）→ 自动执行（userOp 广播）→ 回执/审计查询，端到端可用。
4. **安全不降级**：限额为**服务端硬约束**（不可绕过），会话撤销即时生效，私钥/签名材料不落服务端明文日志。

## 三、需求项

### R1 SessionKey 托管服务（SaaS 实例）— P0

InfraX 侧部署生产实例（对齐 `projects/session-key` 现有 API 面，见附 A）：

| 端点 | 鉴权 | 语义 |
|---|---|---|
| `GET /api/v1/health` | 公开 | 服务存活 |
| `GET /api/v1/nonce?user=<userAddress>` | 公开 | 签发 EIP-712 签名用 nonce（防重放） |
| `POST /api/v1/sessions` | 公开 | 创建 session：EIP-712 验签 + `permissions{contracts,functions}` + `validDays`/`maxPerTx`/`maxTotal` 限额 |
| `GET /api/v1/sessions?user=&active=` / `GET /api/v1/sessions/:id` | Bearer | 会话查询 |
| `DELETE /api/v1/sessions/:id` | Bearer | 撤销会话（即时生效） |
| `POST /api/v1/execute` | Bearer | 自动执行：服务端持 session key 构建 userOp → 广播 → 返回回执 |

- 交付物：生产 URL（HTTPS）、API key（`sdk_` 前缀 Bearer token）、SLA 说明、日志/审计接口。
- 消费端无需自部署，仅配置 `SESSION_KEY_ENGINE_URL` + `SESSION_KEY_API_KEY`。

### R2 SessionKeyAPI 并入主 SDK — P1

- `@0xinfrax/infrax-dk` 新增 `SessionKeyAPI` 类：`getNonce / createSession / listSessions / getSession / revokeSession / execute`，TS 类型 + Python 客户端同步发布。
- 鉴权统一：非公开端点走平台 key（与现有 `rx_`/`cr_` 体系一致，可选 `X-API-Key` 或 Bearer）。
- EIP-712 域参数（chainId/verifyingContract/name/version）由 SDK 内置管理，调用方无需拼装。

### R3 执行能力增强 — P1

- **多链**：ETH / BSC / BASE / Arbitrum / Polygon（+ Solana 候选）。
- **userOp 回执**：`POST /api/v1/execute` 返回 `{userOpHash, txHash, status, blockNumber, gasUsed}`；新增查询端点 `GET /api/v1/execute/:id`。
- **Paymaster**：落地 engine 现有 paymaster 雏形（gas 赞助可配置）。
- **审计**：execute 全程审计（调用方、session id、限额快照、结果），便于对账。

### R4 安全加固 — P0

- 限额为**服务端硬校验**：`maxPerTx`/`maxTotal`/`validUntil` 在构建 userOp 前强制校验，服务端逻辑不可绕过；**任何路径不得将 session key 原文写入日志/事件**。
- nonce 单次有效（消费即失效），EIP-712 防重放。
- 撤销即时生效：`DELETE /sessions/:id` 后已签发 key 立即失效。
- 公开端点与 Bearer 端点隔离（现有 auth 插件语义，生产实例沿用）。

## 四、验收标准

1. 托管实例可用：`GET /api/v1/health` → 200；提供 URL + API key 即可对接。
2. SDK `SessionKeyAPI`：`getNonce → createSession（EIP-712 验签）→ execute` 端到端通过（模拟 + 真实小额 token 转移）。
3. 限额强校验：超 `maxPerTx` / 累计超 `maxTotal` / 过期 / 已撤销 → 服务端拒绝且**不产生上链交易**。
4. 安全自证：实例日志与审计接口中无 session key / 签名原文。
5. 多链：≥3 条链（ETH/BSC/BASE）execute 通过。

## 五、优先级

- **P0**：R1（托管实例）+ R4（安全）——决定轨道 B 是否可免自部署直接上线。
- **P1**：R2（SDK 封装）+ R3（多链/回执/审计）。
- **P2**：Paymaster 赞助、Solana、ws 会话事件推送。

## 六、对调用方（AIHunter SaaS）的意义

- R1 落地：轨道 B 从「自建引擎」降级为「配置即用」，Gateway 适配器（`/api/session-key/*` 反向代理）已就绪，填 URL/key 即切 live。
- R2 落地：TS/Python 双端统一走 `@0xinfrax/infrax-dk`，不再维护独立 client 依赖。
- 配合已提的行情 RPC + DEX 执行需求单（FEATURE_REQUEST_MARKET_RPC_DEX_EXEC.md），交易面全部收敛到 InfraX SDK。

---

## 附 A：session-key-engine 现有 API 面（`projects/session-key`，供托管对齐）

- 鉴权插件（`packages/server/src/plugins/auth.ts`）：`/api/v1/health`、`GET /api/v1/nonce`、`POST /api/v1/sessions` 公开；其余 Bearer。
- `packages/client`：现成 TS 客户端（`getNonce/createSession/listSessions/getSession/revokeSession/execute`），可直接并入主 SDK。
- AA 基建：`packages/core/src/aa/`（userop.ts / paymaster.ts / types.ts）+ `packages/evm`（eip712.ts / evm-adapter.ts / rpc-registry.ts）。
- 限额模型：`permissions{contracts[], functions[]}` + `validDays` + `maxPerTx` + `maxTotal`（单位 wei，服务端强校验）。
