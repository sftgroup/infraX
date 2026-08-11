---
name: wallet
description: |
  Use this skill when the user needs to check wallet token balances, send native tokens from the InfraX gas pool,
  estimate gas before sending, list RPC endpoints, sweep custodial funds, or check on-chain transaction status.
  Covers the InfraX WAAS custodial wallet surface (wallet_* tools of the wallet MCP).
version: 1.0.0
license: MIT
metadata:
  infrax:
    mcp: infrax-wallet-mcp
    tools:
      - wallet_balance
      - wallet_send
      - wallet_simulate
      - wallet_rpc
      - wallet_health
      - wallet_sweep
      - wallet_status
---

# Wallet — InfraX AI Skill

## 能力概览

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `wallet_balance` | 查询钱包在某链上的代币余额 | `address`（必填）、`chain`（默认 sepolia） |
| `wallet_send` | 从 gas 池向任意地址发送原生代币（单笔上限 0.05 ETH） | `to`、`amount`（必填）、`chain` |
| `wallet_simulate` | 发送前估算 gas 成本，不花费资金 | `from`、`to`、`amount`（必填）、`chain` |
| `wallet_rpc` | 查询各链可用 RPC 端点 | 无 |
| `wallet_health` | 检查 WAAS 后端与数据库健康状态 | 无 |
| `wallet_sweep` | 将托管钱包资金归集到主钱包（管理员） | `chain`（默认 sepolia） |
| `wallet_status` | 按 txHash 查询链上交易状态 | `txHash`（必填）、`chain` |

## 接入方式

- MCP server：`infrax-wallet-mcp`（HTTP Streamable 传输）
- 端口：dev `:3004`，生产 `:9110`（systemd unit `infrax-wallet-mcp.service`，WorkingDirectory `/opt/infraX/projects/mcp-server`）
- 鉴权：`Authorization: Bearer <INFRAX_MCP_API_KEY>`（入站校验见 `mcp-auth.ts`，MCP_API_KEY 白名单或 mx_ 签发 key）

## Quick Start

### 场景 1：查询余额

```
wallet_balance { "address": "0xAbC...", "chain": "sepolia" }
```

### 场景 2：先估算再发送（安全流程）

```
1. wallet_simulate { "from": "0xSender", "to": "0xRecv", "amount": "0.01", "chain": "sepolia" }
2. 用户确认估算成本后：
   wallet_send { "to": "0xRecv", "amount": "0.01", "chain": "sepolia" }
```

### 场景 3：核对交易是否上链

```
wallet_status { "txHash": "0x...", "chain": "sepolia" }
```

## 约束与注意事项

- `wallet_send` 单笔上限 **0.05 ETH**，超出会被拒；大额请拆笔或走 vault/mpc 通道。
- `wallet_sweep` 为管理员操作，非管理员调用返回鉴权错误。
- 发送前先用 `wallet_simulate` 估算，避免 gas 不足失败。
- 链名取值：`ethereum / sepolia / bsc / base / polygon / arbitrum / optimism`。
