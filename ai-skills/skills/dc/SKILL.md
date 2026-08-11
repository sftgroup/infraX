---
name: dc
description: |
  Use this skill when the user needs on-chain data from the InfraX Data Center: query events by chain/contract,
  data statistics, indexing checkpoints, supported tokens/chains, real-time token prices, or manage DC subscriptions
  (subscribe to plans, poll payment status, verify x402 payments, read usage).
  Covers the dc_* tools of the DC MCP.
version: 1.0.0
license: MIT
metadata:
  infrax:
    mcp: infrax-dc-mcp
    tools:
      - dc_events
      - dc_stats
      - dc_checkpoints
      - dc_plans
      - dc_tokens
      - dc_chains
      - dc_subscription_subscribe
      - dc_subscription_payment_check
      - dc_subscription_verify
      - dc_subscription_usage
      - dc_price
---

# DC (Data Center) — InfraX AI Skill

## 能力概览

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `dc_events` | 按链/合约/事件类型查询链上事件 | `chain`、`address`、`event_type`、`from_block`、`to_block`、`limit` |
| `dc_stats` | 数据统计（事件数、活跃链） | 无 |
| `dc_checkpoints` | 各链区块索引水位 | `chain` 过滤 |
| `dc_plans` | DC 订阅套餐列表 | 无 |
| `dc_tokens` | 支持的代币与元数据 | `chain` 过滤 |
| `dc_chains` | 支持的区块链网络 | 无 |
| `dc_subscription_subscribe` | 订阅套餐：免费计划立即激活返回 dcApiKey；付费计划返回待支付意图 | `planId`、`walletAddress`（必填）、`rail`（chain/fiat/x402） |
| `dc_subscription_payment_check` | 轮询订阅支付状态（chain rail 确认链上付款） | `walletAddress`（必填） |
| `dc_subscription_verify` | 提交 x402 txHash 确认付款，支付钱包必须匹配 | `txHash`、`walletAddress`（必填） |
| `dc_subscription_usage` | 订阅用量：套餐、配额、已用、每日明细 | `walletAddress`（必填） |
| `dc_price` | Binance 公开 API 实时价格（USDT 对） | `symbol`（必填） |

## 接入方式

- MCP server：`infrax-dc-mcp`（HTTP Streamable 传输）
- 端口：dev `:3005`，生产 `:9103`（systemd `infrax-dc-mcp.service`）
- 上游：DC 引擎 `infrax-dc.service` `:9102`（生产）
- 鉴权：查询类用 `Authorization: Bearer <INFRAX_MCP_API_KEY>`；**订阅面端点（dc_subscription_*）用 `x-wallet-address` 头鉴权**（标识 DC 租户），且需 DC 侧配置 `DC_API_KEY`（MCP 启动 fail-fast 缺失即报错）

## Quick Start

### 场景 1：链上事件分析

```
dc_events { "chain": "ethereum", "address": "0xUniswapV2", "event_type": "Swap", "limit": "100" }
```

### 场景 2：免费订阅即用

```
1. dc_subscription_subscribe { "planId": "data_free", "walletAddress": "0xUser" }
   → 立即激活，返回 dcApiKey
2. dc_subscription_usage { "walletAddress": "0xUser" }
```

### 场景 3：付费计划（x402 支付确认）

```
1. dc_subscription_subscribe { "planId": "data_pro", "rail": "x402", "walletAddress": "0xUser" }
   → 返回 pending payment intent（含付款信息）
2. 用户链上支付获得 txHash
3. dc_subscription_verify { "txHash": "0x...", "walletAddress": "0xUser" }
   → activated: true
```

## 约束与注意事项

- 订阅面端点一律携带 `walletAddress`，且必须与付款钱包一致，否则 verify 被拒。
- 免费计划立即激活；付费计划 pending → 需 `payment_check` 轮询或 `verify` 确认后转 active。
- `dc_price` 仅支持主流币种（ETH/BTC/SOL/BNB/ARB/OP/MATIC 等），小众符号返回错误提示。
