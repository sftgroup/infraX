# InfraX 部署文档

> 最后更新: 2026-07-15 00:35 GMT+8 | 版本 `v0.2.0-dashboard-20260715`

## 生产服务器

```
Host:   43.156.46.187
User:   ubuntu
Pass:   Asdf1234!
Ports:  3000-6100
Spec:   4C/7.5G/178G
```

## 当前运行服务（11 个）

| 服务 | 端口 | DB | 启动命令 | 状态 |
|------|------|-----|---------|------|
| WAAS | 6001 | pocketx_waas | `npx tsx index.ts` | 🟢 |
| Vault | 6002 | pocketx_vault | `npx tsx server.ts` | 🟢 |
| DC | 3001 | pocketx_dc + pocketx_collector | `npx tsx index.ts` | 🟢 |
| MPC | 6003 | pocketx_mpc | `npx tsx server.ts` | 🟢 |
| Payment | 6004 | pocketx_payment | `npx tsx server.ts` | 🟢 |
| Collector | 3008 | pocketx_collector | `npx tsx src/index.ts` | 🟢 |
| Admin | 3002 | 跨 6 DB | `npx tsx server/index.ts` | 🟢 |
| Wallet MCP | 3004 | — | `npx tsx index.ts` | 🟢 |
| DC MCP | 3005 | — | `npx tsx dc-index.ts` | 🟢 |
| Vault MCP | 3006 | — | `npx tsx vault-index.ts` | 🟢 |
| Web | 6100 | — | `node server.js` | 🟢 |

## 目录结构

```
/opt/pocketx/projects/
├── waas/          → WAAS :6001
├── vault/         → Vault :6002
├── mpc/           → MPC :6003
├── dc/            → DC :3001
├── payment/       → Payment :6004
├── collector/     → Collector :3008
├── admin/         → Admin :3002
├── mcp-server/    → Wallet MCP :3004 / DC MCP :3005 / Vault MCP :3006
└── web/           → Web :6100
    ├── server.js         ← Node proxy (零依赖，Cache-Control: no-store)
    ├── index.html        ← 主应用 (Dashboard / MPC / WaaS / DC / Safe tabs)
    ├── connect.html      ← 钱包连接页
    ├── landing.html      ← 产品落地页
    └── modules/
        ├── core.js          ← 核心库 (afetch, user, setupNav, showToast)
        ├── nc-wallet.js     ← Dashboard 仪表盘 (ncDash)
        ├── datacenter.js    ← Data Center 模块 (dcInit)
        ├── mpc.js           ← MPC 模块
        ├── waas.js          ← WaaS 模块 (包含 GasSponsor/开发网)
        ├── safe.js          ← Safe/Vault 模块
        └── infrax.css       ← 统一样式
```

## Web Proxy 路由 (`server.js`)

```
/api/v2/data   → :3001 (DC)
/api/v2/mpc    → :6003
/api/v2/wallet → :6001
/api/v2/waas   → :6001
/api/v2/saas   → :6001
/api/vault     → :6002
/api/v2/vault  → :6002
```

**特性**:
- 零依赖 Node.js HTTP server
- `Cache-Control: no-store, no-cache, must-revalidate` 防止 JS 缓存
- SPA fallback：未知路径返回 `index.html`

## 前端 JS 模块关键契约

### afetch() 行为 🔴
```javascript
// core.js 中的 afetch 自动解包后端 {code, data} 响应
return j.data !== undefined ? j.data : j;

// 所有 afetch 调用方拿到的已经是 data 内层，无需 .code 检查
const usage = await afetch('/api/v2/data/usage', { auth: 'none' });
// usage → { planId, planName, monthlyQuota, currentUsage }   ← 不是 { code: 0, data: {...} }
```

### auth 参数
| 值 | 行为 | 用途 |
|----|------|------|
| `'none'` | 自动带 `x-wallet-address` header，不签名 | 只读查询 |
| `'wallet'` | 调 `signOnce()` 触发 MetaMask 弹窗 | 写操作（订阅等） |

> ⚠️ `auth: 'wallet'` 不要用于只读查询——会触发 MetaMask 弹窗且要求用户签名

### getMe() 数据格式
`localStorage.px_user` → `{ walletAddress, connectedAt }`（由 `connect.html` 写入）

Dashboard 从 `getMe()` 并行读取 4 个 API：
- `afetch('/api/v2/mpc/status')` → `{ registered, email, walletAddress }`
- `afetch('/api/v2/saas/tenants/my')` → `{ tenantId, name, planId, planName, status }`
- `afetch('/api/vault/safe/status')` → `{ enabled, count }`
- `afetch('/api/v2/data/usage')` → `{ planId, planName, monthlyQuota, currentUsage }`

## 部署流程

```
本地改代码 → git push → git sync (GitHub) → SSH scp 到服务器 → 重启
```

或通过 raw-upload 方式：
```
tar czf /tmp/infrax.tar.gz --exclude=node_modules --exclude=.next .
curl --data-binary @/tmp/infrax.tar.gz http://43.156.46.187:3088/raw-upload/InfraX
ssh MCP-SERVER "cd /opt/mcp/repos/InfraX && git push origin master"
```

### 代码同步铁律
- 🔴 不在生产服务器直接改源码
- 🔴 从 GitHub clone 的 repo 无 raw archive → 需 SSH tar `/opt/mcp/repos/<name>/`
- 🔴 Git raw-upload 才能走 raw endpoint 下载
- 🔴 先 curl raw-upload 再 git_push → git_sync
- 🔴 部署后刷新前端须更新 JS `?v=` 参数（Cache-Control: no-store 是保险）

## 一键检查

```bash
ssh 43.156.46.187
for p in 6001 6002 6003 6004 3001 3002 3004 3005 3006 3008 6100; do
  curl -s --max-time 2 http://localhost:$p/health 2>/dev/null \
    && echo ":$p OK" || echo ":$p DOWN"
done
```

## 逐服务管理

### WAAS :6001
```bash
cd /opt/pocketx/projects/waas
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
ETH_RPC_URL=https://ethereum-rpc.publicnode.com \
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org \
BASE_RPC_URL=https://mainnet.base.org \
SUPPORTED_CHAINS=sepolia,eth,bsc,base \
PORT=6001 \
  nohup npx tsx index.ts > /tmp/waas.log 2>&1 &
```

### Vault :6002
```bash
cd /opt/pocketx/projects/vault
PORT=6002 nohup npx tsx server.ts > /tmp/vault.log 2>&1 &
```

### DC :3001
```bash
cd /opt/pocketx/projects/dc
PORT=3001 nohup npx tsx index.ts > /tmp/dc.log 2>&1 &
```

### MPC :6003
```bash
cd /opt/pocketx/projects/mpc
PORT=6003 nohup npx tsx server.ts > /tmp/mpc.log 2>&1 &
```

### Payment :6004
```bash
cd /opt/pocketx/projects/payment
PORT=6004 nohup npx tsx server.ts > /tmp/payment.log 2>&1 &
```

### Collector :3008
```bash
cd /opt/pocketx/projects/collector
PORT=3008 nohup npx tsx src/index.ts > /tmp/collector.log 2>&1 &
```

### Admin :3002
```bash
cd /opt/pocketx/projects/admin
PORT=3002 nohup npx tsx server/index.ts > /tmp/admin.log 2>&1 &
```

### MCP Servers
```bash
# Wallet MCP :3004
cd /opt/pocketx/projects/mcp-server
PORT=3004 nohup npx tsx index.ts > /tmp/wallet-mcp.log 2>&1 &

# DC MCP :3005
PORT=3005 nohup npx tsx dc-index.ts > /tmp/dc-mcp.log 2>&1 &

# Vault MCP :3006
PORT=3006 nohup npx tsx vault-index.ts > /tmp/vault-mcp.log 2>&1 &
```

### Web :6100
```bash
cd /opt/pocketx/projects/web
nohup node server.js > /tmp/web.log 2>&1 &
# server.js 零依赖，自动转发 /api/v2/* 到对应后端
# Cache-Control: no-store → 强缓存禁用
```

### 按端口杀进程
```bash
fuser -k 6001/tcp
```

## 数据库

```
localhost:5432, trust 认证, ubuntu 用户
```

| 数据库 | 表数 | 说明 |
|--------|------|------|
| pocketx_waas | 17 | 钱包/用户/交易/SaaS |
| pocketx_vault | 4 | Safe 多签（safe_wallets 表名，非 safes） |
| pocketx_dc | 2 | 订阅 users/tenants |
| pocketx_mpc | 2 | MPC 钱包/注册 |
| pocketx_payment | 3 | 支付订单 |
| pocketx_admin | 3 | 管理后台 |
| pocketx_collector | 10 | 事件采集 + OKX + Binance |

## 环境变量关键项

### WAAS (.env)
```
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
ETH_RPC_URL=https://ethereum-rpc.publicnode.com
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org
BASE_RPC_URL=https://mainnet.base.org
SUPPORTED_CHAINS=sepolia,eth,bsc,base
PORT=6001
DATABASE_URL=postgresql://ubuntu@localhost:5432/pocketx_waas
```

### DC (自动双池，无需额外配置)
- `DATABASE_URL` → pocketx_dc (users/tenants)
- `COLLECTOR_DB_URL` → pocketx_collector (events, 默认同 localhost)

### MCP Servers (通过 HTTP 调后端 API)
```bash
WALLET_API_URL=http://localhost:6001
VAULT_API_URL=http://localhost:6002
DC_API_URL=http://localhost:3001
```

## 最近修复备忘 (2026-07-15)

| 问题 | 根因 | 修复 |
|------|------|------|
| DC spinner 一直转 | `dcLoadDashboard` 未清 `dc-chain-stats` | `setHtml('dc-chain-stats', 5链状态)` |
| DC 只显示 1 条链 | 硬编码 `['Sepolia']` | `DC_CHAINS = ['Sepolia','Ethereum','BSC','Solana','Base']` |
| 全 ○ Inactive | 误用 `.data` 包装（afetch 已解包） | 直接访问 `me.mpc.registered` 等 |
| DC tab 永远 "Subscribe" | auth: 'wallet' 触发 MetaMask 弹窗 | 改回 `auth: 'none'` |
| Vault API 返回 HTML | `/api/vault` 缺代理路由 | 加到 server.js API_ROUTES |
| JS 缓存用旧文件 | Cache-Control: no-cache 不够 | 改为 `no-store, no-cache, must-revalidate` |
| WaaS plan 为空 | SQL 缺 `t.plan_id` SELECT | 加 `planId` + `planName` 到返回 |
| Vault `relation "safes"` 不存在 | 表名实际是 `safe_wallets` | 修正 SQL 查询 |
| DC 用户查询失败 | users 表为空 + tenants 未关联 | populate users + link via owner_user_id |

## 负载参考

```
正常: CPU idle 90%+, 内存 1.5-2G / 7.5G
Collector: ~19% CPU (5 链扫描正常)
已清理: Chrome headless ×4 + docker-bench-security.sh
```
