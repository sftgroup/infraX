# InfraX 部署文档

> 最后更新: 2026-07-14 04:00 GMT+8

## 部署服务器

```
Host:   101.33.109.117
User:   ubuntu
Ports:  6000-6999
```

## 当前运行服务（6 个）

| 服务 | 端口 | DB | 启动方式 | 状态 |
|------|------|-----|---------|------|
| WAAS | 6001 | pocketx_waas | `npx tsx src/index.ts` | 🟢 |
| Vault | 6002 | pocketx_vault | `npx tsx server.ts` | 🟢 |
| DC | 3001 | pocketx_dc | `node index.js` | 🟢 |
| Payment | 6004 | pocketx_payment | `node dist/index.js` | 🟢 |
| DC MCP | 3005 | — | `npx tsx dc-index.ts` | 🟢 |
| Web | 6100 | — | `python3 -m http.server 6100` | 🟢 |

### 停用服务

| 服务 | 端口 | 原因 |
|------|------|------|
| Admin | 3002 | 未启动 |
| MPC | 6003 | 未启动 |
| Wallet MCP | 3004 | 未启动 |
| Vault MCP | 3006 | 未启动 |
| MPC MCP | 3007 | 未启动 |
| Collector | 3000 | OOM 已停，代码已清理待重启 |

## 目录结构

```
服务器部署目录:
/home/ubuntu/infrax-wallet/         → WAAS :6001
/home/ubuntu/infrax-ault/           → Vault :6002
/home/ubuntu/infrax-c/              → DC :3001
/home/ubuntu/infrax-ayment/         → Payment :6004
/home/ubuntu/infrax-c-mcp/          → DC MCP :3005
/opt/pocketx/projects/web/             → Web Frontend :6100

源码仓库:
GitHub sftgroup/infraX → projects/
```

## 启动/重启命令

### 一键检查

```bash
for p in 6001 6002 6004 3001 3005 6100; do
  curl -s http://localhost:$p/health && echo " :$p OK" || echo " :$p FAIL"
done
```

### 逐服务启动

```bash
# WAAS :6001
cd /home/ubuntu/infrax-wallet && DATABASE_URL=postgres://... npx tsx src/index.ts

# Vault :6002
cd /home/ubuntu/infrax-ault && DATABASE_URL=postgres://... npx tsx server.ts

# DC :3001
cd /home/ubuntu/infrax-c && DATABASE_URL=postgres://... node index.js

# Payment :6004
cd /home/ubuntu/infrax-ayment && DATABASE_URL=postgres://... node dist/index.js

# DC MCP :3005
cd /home/ubuntu/infrax-c-mcp && npx tsx dc-index.ts

# Web :6100
cd /opt/pocketx-web && nohup python3 -m http.server 6100 > /tmp/web-6100.log 2>&1 &
```

## Nginx 路由

```
6200 → /opt/pocketx/projects/web/
   ├── /api/v2/payment → proxy :6004
   └── /api/            → proxy :6001
```

## 数据库

```
pocketx_waas      → tenants, users, transactions, wallets, ...
pocketx_vault     → safe_wallets, safe_transactions, risk_rules, ...
pocketx_dc        → dc_subscriptions
pocketx_payment   → payment_orders, subscriptions, ...
pocketx_mpc       → mpc_key_shares, mpc_wallets, ...
pocketx_collector → events(630万行), chains, tokens, ...
```

## 部署流程

```
本地改代码 → git push → git sync (GitHub) → build → curl 下载产物 → scp 到服务器
```

- 🔴 不在服务器直接改源码
- 🔴 部署前打 tag: `vX.Y.Z-YYYYMMDD`
- 🔴 验收版本 infraX 修改需谨慎确认
