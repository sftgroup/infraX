# InfraX 综合进度报告 — 2026-07-14

## 架构总览

```
infraX/ (Monorepo, 10 modules)
├── waas/         # WAAS 钱包 :6001 🟢
├── vault/        # Vault 多签 :6002 🟢 (2026-07-13 独立)
├── mpc/          # MPC 分片 :6003 🔴
├── dc/           # DC 数据 :3001 🟢
├── payment/      # 支付 :6004 🟢 (2026-07-14 独立)
├── collector/    # 采集器 :3000 🔴 暂停
├── admin/        # 管理后台 :3002 🔴
├── mcp-server/   # MCP 4 Server 🔴 (仅 dc-mcp :3005 🟢)
├── sdk/          # JS SDK v0.2
└── web/          # 前端 :6100 🟢
```

## 服务在线: 6/11

| 端口 | 服务 | 状态 |
|------|------|------|
| 6001 | WAAS | 🟢 |
| 6002 | Vault | 🟢 |
| 3001 | DC | 🟢 |
| 6004 | Payment | 🟢 |
| 3005 | DC MCP | 🟢 |
| 6100 | Web | 🟢 |
| 3002 | Admin | 🔴 |
| 6003 | MPC | 🔴 |
| 3000 | Collector | 🔴 |
| 3004 | Wallet MCP | 🔴 |
| 3006 | Vault MCP | 🔴 |
| 3007 | MPC MCP | 🔴 |

## 数据库: 7 独立 PostgreSQL

| DB | 表数 | 说明 |
|----|------|------|
| pocketx_waas | 14 | tenants, users, transactions, wallets, subscriptions, api_usage, chains, tokens |
| pocketx_vault | 9 | safe_wallets, safe_transactions, safe_signatures, risk_rules, mpc_wallets |
| pocketx_dc | 1 | dc_subscriptions |
| pocketx_mpc | 3 | mpc_key_shares, mpc_registrations, mpc_wallets |
| pocketx_payment | 5 | payment_orders, payment_events, subscriptions, fee_configs |
| pocketx_admin | 2 | admin_users, admin_rpc_config |
| pocketx_collector | 9 | events(630万行), chains, tokens, api_keys |

## Git

- Latest: `30d72fbf` — full codebase push (144 files)
- Branch: main
- Next tag: v2.7.1-20260714

## 关键里程碑

| 日期 | 事件 |
|------|------|
| 07-14 | Payment 独立化, Vault/dc_price 部署, web :6100 恢复, GitHub 全量推送 |
| 07-13 | 架构解耦完成: DB 拆分, management 端点迁移, E2E 13/13 |
| 07-12 | WaaS 币安化, NC Wallet 精简, 热钱包加密 |
