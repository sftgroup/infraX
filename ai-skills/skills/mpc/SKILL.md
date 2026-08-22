---
name: mpc
description: |
  Use this skill when the user needs email-based MPC (multi-party computation) wallet operations:
  send verification code, register/recover wallets, unlock sessions, sign messages and typed data,
  send transactions, read/write contracts, estimate gas, or check MPC billing plans and ledger balance.
  Covers the mpc_* tools of the MPC MCP.
version: 1.0.0
license: MIT
metadata:
  infrax:
    mcp: infrax-mpc-mcp
    tools:
      - mpc_send_code
      - mpc_register
      - mpc_recover
      - mpc_status
      - mpc_create_wallet
      - mpc_session_unlock
      - mpc_session_lock
      - mpc_session_status
      - mpc_balance
      - mpc_sign_message
      - mpc_sign_typed_data
      - mpc_send_transaction
      - mpc_contract_read
      - mpc_contract_write
      - mpc_gas_estimate
      - mpc_plans
      - mpc_ledger_balance
---

# MPC — InfraX AI Skill

## 能力概览

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `mpc_send_code` | 向邮箱发送验证码 | `email`（必填） |
| `mpc_register` | 注册 MPC 钱包（验证码换地址） | `email`、`code`（必填） |
| `mpc_recover` | 找回钱包 | `email`、`code` |
| `mpc_status` | 查询邮箱/地址是否已注册 | `email` 或 `walletAddress` |
| `mpc_create_wallet` | 创建子钱包 | `email`、`code` 等 |
| `mpc_session_unlock` | 验证码解锁会话，返回短期 token | `email`、`code`（必填） |
| `mpc_session_lock` | 锁定会话（token 失效） | `token`（必填） |
| `mpc_session_status` | 会话状态与剩余秒数 | `token`（必填） |
| `mpc_balance` | 查询链上余额（原生+ERC20） | `token`（必填）、`chain`、`tokenAddress` |
| `mpc_sign_message` | 签名任意消息（EIP-191） | `token`、`message`（必填） |
| `mpc_sign_typed_data` | 签名 EIP-712 结构化数据 | `token`、`domain`、`types`、`value` |
| `mpc_send_transaction` | 发送代币转账交易 | `token`、`to`、`amount`（必填）、`chain`、`tokenAddress` |
| `mpc_contract_read` | 合约只读调用 | `contractAddress`、`abi`、`method`、`args` |
| `mpc_contract_write` | 合约写调用 | `token`、`contractAddress`、`abi`、`method`、`args` |
| `mpc_gas_estimate` | 估算 gas | `to`、`value`、`data`、`chain` |
| `mpc_plans` | MPC 计费计划与费率 | 无 |
| `mpc_ledger_balance` | 地址在 MPC 模块账本的余额 | `token`（必填） |

## 接入方式

- MCP server：`infrax-mpc-mcp`（HTTP Streamable 传输）
- 端口：dev `:3007`，生产 `:9105`（systemd `infrax-mpc-mcp.service`）
- 上游：MPC 引擎 `infrax-mpc.service` `:9104`（生产），DB `infrax_mpc`
- 鉴权：`Authorization: Bearer <INFRAX_MCP_API_KEY>`；MPC 引擎业务端点需 `MPC_API_KEY`

## Quick Start

### 场景 1：注册 → 解锁 → 签名

```
1. mpc_send_code { "email": "user@example.com" }
2. 用户提供邮箱收到的 6 位验证码（生产走 SMTP 邮件 / dev 从 journal 取）
3. mpc_register { "email": "user@example.com", "code": "123456" }
   → address / walletId
4. mpc_session_unlock { "email": "user@example.com", "code": "123456" }
   → token（短期有效）
5. mpc_sign_message { "token": "<token>", "message": "Hello InfraX" }
   → signature / address
```

### 场景 2：合约调用

```
1. mpc_contract_read { "contractAddress": "0x...", "abi": [...], "method": "balanceOf",
                       "args": ["0xAddr"], "chain": "oxachain" }
2. mpc_contract_write { "token": "<token>", "contractAddress": "0x...", "abi": [...],
                        "method": "approve", "args": ["0xSpender","1000000000000000000"] }
```

## 约束与注意事项

- 所有链上写操作（交易/合约写/签名）都需要先 `mpc_session_unlock` 取得 token。
- token 短期有效且会话可被 `mpc_session_lock` 主动吊销——敏感操作后建议立即 lock。
- 验证码 6 位、邮箱 + 时间戳落库 `mpc_verification_codes`（哈希存储），发送走 SMTP，未配置时回退 console.log。
- `amount` 为原生币小数（如 "0.5"）；`valueWei` 类字段才是 wei。
