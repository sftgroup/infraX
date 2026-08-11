---
name: session-key
description: |
  Use this skill when the user needs session-key based delegated signing: get a one-time nonce for EIP-712
  authorization, create/list/get/revoke session keys, execute transactions through an authorized session key
  (with contract whitelist + spend limits), or check Session Key Engine health.
  Supports both signature-required mode and the zero-signature (recovery) flow where the user pre-authorizes.
  Covers the sk_* tools of the Session Key MCP.
version: 1.0.0
license: MIT
metadata:
  infrax:
    mcp: infrax-session-key-mcp
    tools:
      - sk_nonce
      - sk_create_session
      - sk_list_sessions
      - sk_get_session
      - sk_revoke_session
      - sk_execute
      - sk_status
---

# Session Key — InfraX AI Skill

## 能力概览

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `sk_nonce` | 获取一次性 nonce（用于 EIP-712 授权签名） | `user`（必填，0x 地址） |
| `sk_create_session` | 创建会话密钥：用户签 EIP-712 授权 session key 代执行 | `signature`、`userAddress`、`nonce`、`chain`（必填）；`contracts`、`functions`、`validDays`、`maxPerTx`、`maxTotal` |
| `sk_list_sessions` | 列出用户全部会话密钥 | `user`（必填）、`chain`/`status` 过滤 |
| `sk_get_session` | 按 ID 查会话详情 | `sessionId`（必填） |
| `sk_revoke_session` | 立即吊销会话密钥 | `sessionId`（必填） |
| `sk_execute` | 用已授权会话密钥执行交易（合约需在白名单） | `sessionId`、`chain`、`to`、`data`（必填）；`value`、`gasLimit` |
| `sk_status` | Session Key Engine 健康检查 | 无 |

## 接入方式

- MCP server：`infrax-session-key-mcp`（HTTP Streamable 传输）
- 端口：`:3011`（B-6 与 web 生产端口 9111 隔离；dev 默认 3011）
- 上游：Session Key Engine `SESSION_KEY_URL`（默认 `http://localhost:3500`）
- 鉴权：MCP 入站 `Authorization: Bearer <INFRAX_MCP_API_KEY>`；上游 `Authorization: Bearer <SESSION_KEY_API_KEY>`

## Quick Start

### 场景 1：标准签名模式（AI 代理持短期授权）

```
1. sk_nonce { "user": "0xOwner" }
   → nonce（一次性，30min 内有效）
2. 用户钱包对授权消息（EIP-712，含 nonce/权限/限额）签名 → signature
3. sk_create_session {
     "userAddress": "0xOwner", "nonce": "<nonce>", "signature": "0x...",
     "chain": "base", "contracts": "0xSwapRouter,0xLimitOrder",
     "functions": "0x095ea7b3,0x38ed1739", "validDays": "30", "maxPerTx": "1000", "maxTotal": "10000" }
   → sessionId
4. sk_execute { "sessionId": "<sessionId>", "chain": "base", "to": "0xSwapRouter",
                "data": "0x..." }   # 白名单合约内自由执行，无需再签名
```

### 场景 2：零签名模式（用户预授权，AI 全程无签名交互）

- 用户在会话密钥引擎后台一次性完成 EIP-712 授权（或通过 MPC/vault 托管代签）。
- 之后所有交易走 `sk_execute`，AI 代理不再向用户索要签名——适用于无人值守 Agent（如自动策略、批量空投）。
- 安全边界：白名单合约 + 函数选择器 + `maxPerTx`/`maxTotal` 三重限制，超限即拒绝；可随时 `sk_revoke_session` 一键吊销。

### 场景 3：审计与吊销

```
1. sk_list_sessions { "user": "0xOwner" }
2. sk_get_session { "sessionId": "<sessionId>" }
3. sk_revoke_session { "sessionId": "<sessionId>" }   # 泄露或到期前主动吊销
```

## 约束与注意事项

- `nonce` 一次性：创建失败或过期需重新 `sk_nonce`。
- `contracts` 白名单必填且逐字匹配；`functions` 为空 = 允许全部函数（慎用）。
- 限额以 USDC 计（`maxPerTx` 默认 1000 / `maxTotal` 默认 10000）。
- `sk_execute` 要求会话 active 且目标合约在白名单内，否则拒绝执行。
- 支持链：`eth / bsc / base / polygon / arbitrum / optimism / xlayer`。
