---
name: payment
description: |
  Use this skill when the user needs to create or verify payments through the InfraX generic payment engine
  (@0xinfrax/payments): fiat checkout (Stripe), on-chain x402/stablecoin verification, plan pricing, ledger balance,
  batch collection, billing invitations, ledger-internal transfers, and MPP (multi-party payment) channels.
  Covers the payment_*/mpp_* tools of the wallet MCP.
version: 1.0.0
license: MIT
metadata:
  infrax:
    mcp: infrax-wallet-mcp
    tools:
      - payment_info
      - payment_create
      - payment_verify
      - payment_price
      - payment_balance
      - payment_access
      - payment_batch_create
      - payment_batch_settle
      - payment_batch_get
      - payment_batch_cancel
      - payment_invite_create
      - payment_invite_list
      - payment_invite_get
      - payment_invite_cancel
      - payment_invite_settle
      - payment_invite_pay
      - payment_transfer_create
      - payment_transfer_list
      - payment_transfer_get
      - payment_transfer_confirm
      - payment_transfer_cancel
      - mpp_open
      - mpp_voucher
      - mpp_topup
      - mpp_settle
      - mpp_close
      - mpp_session
---

# Payment — InfraX AI Skill

## 能力概览

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `payment_info` | 发现支付通道：价格、收款钱包、网络、启用的 rail | 无 |
| `payment_create` | 法币通道创建支付意图，返回 Stripe Checkout 链接 | `subscriber`（必填）、`amountCents`/`planId`、`metadata` |
| `payment_verify` | 校验链上支付（x402/稳定币）并幂等入账 | `txHash`（必填）、`chain`（默认 oxachain） |
| `payment_price` | 读取链上套餐定价 | `planId`（必填）、`chain` |
| `payment_balance` | 读取地址的模块账本余额 | `address`（必填）、`asset` |
| `payment_access` | 订阅者对资源的统一访问检查 | `subscriber`、`resource`（必填） |
| `payment_batch_create/settle/get/cancel` | 批式收款：一人向多人发起收款 | `subscriber`+`items` / `batchId`+`itemId`+`txHash` |
| `payment_invite_create/list/get/cancel/settle/pay` | 计费邀请（payer→payee），链上或账本结算 | `payer`、`payee`、`valueWei`（必填） |
| `payment_transfer_create/list/get/confirm/cancel` | 账本内部转账，confirm 时原子执行 | `from`、`to`、`valueWei`（必填） |
| `mpp_open/voucher/topup/settle/close/session` | MPP 支付通道：开/凭证/充值/结算/关闭/查询 | `channelId` 等（见各工具描述） |

## 接入方式

- MCP server：`infrax-wallet-mcp`（与 wallet skill 同一 server，`:9110` 生产）
- 上游：`@0xinfrax/payments` 独立引擎 `:9132`（systemd `infrax-payments.service`），MCP 通过 `PAYMENTS_URL`/`PAYMENTS_API_KEY` 桥接
- 鉴权：`Authorization: Bearer <INFRAX_MCP_API_KEY>`；引擎侧为 `X-API-Key`

## Quick Start

### 场景 1：法币收款

```
1. payment_create { "subscriber": "0xPayer", "amountCents": 1990, "currency": "USD",
                    "metadata": { "agentId": 1, "orderId": "o1" } }
2. 用户打开返回的 sessionUrl 完成支付 → 引擎 webhook 回调自动入账
```

### 场景 2：链上 x402 支付并校验

```
1. 用户在平台钱包支付后获得 txHash
2. payment_verify { "txHash": "0x...", "chain": "oxachain" }
   → verified: true 表示已幂等入账
```

### 场景 3：邀请结算（账本余额支付，无需链上交易）

```
1. payment_invite_create { "payer": "0xA", "payee": "0xB", "valueWei": "1000000000000000000" }
2. payment_invite_pay { "inviteId": "<inviteId>" }   # B 从账本余额支付
```

## 约束与注意事项

- `payment_verify` 幂等：同一 txHash 重复校验只入账一次。
- batch/invite/transfer 系列返回引擎裸 JSON（非 `{code,message,data}` 信封），解析时注意。
- `payment_create` 省略 `amountCents` 时按 `planId` 自动计价。
- 金额字段一律为 **wei 字符串**（`valueWei`/`depositWei`/`additionalWei`），不要传 ETH 小数。
