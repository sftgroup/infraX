---
name: vault
description: |
  Use this skill when the user needs to manage multi-signature safes: list/create safes, update owners,
  propose/confirm/execute transactions, retry failed executions, batch-execute ready transactions,
  synchronize on-chain state, or run risk checks on pending transactions.
  Covers the vault_* tools of the vault MCP.
version: 1.0.0
license: MIT
metadata:
  infrax:
    mcp: infrax-vault-mcp
    tools:
      - vault_dashboard
      - vault_safes
      - vault_safe_info
      - vault_create_safe
      - vault_update_owners
      - vault_create_tx
      - vault_confirm_tx
      - vault_execute_tx
      - vault_retry
      - vault_execute_ready
      - vault_sync
      - vault_status
      - vault_risk_check
---

# Vault — InfraX AI Skill

## 能力概览

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `vault_dashboard` | 多签总览（safe 数、待执行交易数） | 无 |
| `vault_safes` | 列 safe 列表 | `chain`、`status` 过滤 |
| `vault_safe_info` | safe 详情（threshold、signers、余额） | `safeId` |
| `vault_create_safe` | 创建多签 safe | `signers`、`threshold`、`chain`（必填） |
| `vault_update_owners` | 更新 safe 签名人 | `safeId`、`owners` 等 |
| `vault_create_tx` | 发起交易提案 | `safeId`、`to`、`amount`（必填） |
| `vault_confirm_tx` | 确认交易（普通签名确认） | `safeId`、`txId`/`safeTxHash`、`signature` |
| `vault_execute_tx` | 达阈值后执行交易 | `safeId`、`txId` |
| `vault_retry` | 重试失败的交易执行 | `safeId`、`txId` |
| `vault_execute_ready` | 批量执行所有已就绪交易 | `chain`（可选） |
| `vault_sync` | 与链上状态同步 | `safeId` |
| `vault_status` | vault 服务健康状态 | 无 |
| `vault_risk_check` | 待执行交易风险检查 | `safeId`、`txId` |

## 接入方式

- MCP server：`infrax-vault-mcp`（HTTP Streamable 传输）
- 端口：dev `:3006`，生产 `:9108`（systemd `infrax-vault-mcp.service`）
- 上游：vault 引擎 `infrax-vault.service` `:9107`（生产）
- 鉴权：`Authorization: Bearer <INFRAX_MCP_API_KEY>`

## Quick Start

### 场景 1：创建多签 + 发起交易

```
1. vault_create_safe { "name": "Treasury", "signers": ["0xA","0xB","0xC"], "threshold": 2, "chain": "base" }
2. vault_create_tx { "safeId": "<safeId>", "to": "0xPayee", "amount": "0.5" }
```

### 场景 2：确认并执行（达阈值自动可执行）

```
1. vault_confirm_tx { "safeId": "<safeId>", "txId": "<txId>", "signature": "0x..." }
2. 第二个 signer 确认后：
   vault_risk_check { "safeId": "<safeId>", "txId": "<txId>" }   # 执行前风险检查
3. vault_execute_tx { "safeId": "<safeId>", "txId": "<txId>" }
```

### 场景 3：MPC 会话确认（SDK 层）

MCP 层当前**未暴露** confirm-mpc 工具；如需 MPC session 确认签名（A-8），走 SDK：

```ts
import { createVaultClient } from "@0xinfrax/vault-sdk";
const v = createVaultClient({ baseUrl: process.env.VAULT_URL, apiKey: process.env.VAULT_API_KEY });
await v.vault.confirmMpc({ safeId, txId, token }); // token 来自 mpc_session_unlock
```

## 约束与注意事项

- 确认签名必须来自 safe 的 signers 列表；执行需达到 threshold。
- 执行前建议先 `vault_risk_check`；失败执行可用 `vault_retry`。
- MPC 会话确认属于 SDK 能力（`SafeAPI.confirmMpc`），MCP 层暂缺，见上例。
