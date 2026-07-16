# InfraX 部署文档

> 最后更新: 2026-07-17 | 版本 `v0.3.0-20260717`

## 生产服务器

```
Host:   43.156.46.187
User:   ubuntu
Pass:   Asdf1234!
Ports:  3000-6100
Spec:   4C/7.5G/178G
```

## 当前运行服务（12 个）

| 服务 | 端口 | DB | 启动命令 | 状态 |
|------|------|-----|---------|------|
| WAAS | 6001 | pocketx_waas | `npx tsx index.ts` | 🟢 |
| Vault | 6002 | pocketx_vault | `npx tsx server.ts` | 🟢 |
| DC | 3001 | pocketx_dc + pocketx_collector | `npx tsx index.ts` | 🟢 |
| MPC | 6003 | pocketx_mpc | `npx tsx server.ts` | 🟢 |
| Payment | 6004 | pocketx_payment | `npx tsx server.ts` | 🟢 |
| Collector | 3008 | pocketx_collector | `npx tsx src/index.ts` | 🟢 |
| Admin | 3002 | 跨 7 DB | `npx tsx server/index.ts` | 🟢 |
| Wallet MCP | 3004 | — | `npx tsx index.ts` | 🟢 |
| DC MCP | 3005 | — | `npx tsx dc-index.ts` | 🟢 |
| Vault MCP | 3006 | — | `npx tsx vault-index.ts` | 🟢 |
| MPC MCP | 3007 | — | `npx tsx mpc-index.ts` | 🟢 |
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
    ├── img/              ← 链 Logo SVG (chain-*.svg × 6，含 OxaChain)
    └── modules/
        ├── core.js          ← 核心库 (afetch, user, setupNav, showToast)
        ├── nc-wallet.js     ← Dashboard 仪表盘 (ncDash)
        ├── datacenter.js    ← Data Center 模块 (dcInit, DC_CHAINS 6链)
        ├── mpc.js           ← MPC 模块
        ├── waas.js          ← WaaS 模块 (包含 GasSponsor/开发网)
        ├── waas-extras.js   ← WaaS 工具函数 (按钮回调等)
        ├── safe.js          ← Safe/Vault 模块
        └── infrax.css       ← 统一样式（全平台字体 1.26x 放大）

## Web Proxy 路由 (`server.js`)

```
/api/v2/data   → :3001 (DC)
/api/v2/mpc    → :6003
/api/v2/wallet → :6001
/api/v2/waas   → :6001
/api/v2/saas   → :6001
/api/vault     → :6002
/api/v2/vault  → :6002
/api/v2/payment → :6004
```

**特性**:
- 零依赖 Node.js HTTP server
- `Cache-Control: no-store, no-cache, must-revalidate` 防止 JS 缓存
- SPA fallback：未知路径返回 `index.html`

## 支持的区块链

| 链 | chain 参数 | Chain ID | RPC |
|---|-----------|----------|-----|
| Sepolia | `sepolia` | 11155111 | publicnode |
| Ethereum | `eth` / `ethereum` | 1 | publicnode |
| BSC | `bsc` | 56 | dataseed |
| Solana | `solana` | — | alchemy |
| Base | `base` | 8453 | mainnet.base.org |
| **OxaChain** | `oxa` | 19505 | **rpc-oxa.0xainet.top** |

> OxaChain: Clique PoA, 2s blocks, gas=OXA, server=43.156.99.215, HTTPS+LE

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

### CSS 关键类

| 类名 | 组件 | 备注 |
|------|------|------|
| `.nav-item` | 侧边导航 | `white-space:nowrap` 防换行 |
| `.chain-card` | DC 链卡片 | 6 网格，hover 上浮 |
| `.chain-card-icon` | 链 Logo | 40×40，内含 36×36 SVG img |
| `.waas-quickstart` | WaaS 步骤卡 | flex 横向排列 |
| `.waas-qs-card` | 步骤卡片 | 带编号 badge + hover 动效 |
| `.waas-qs-step` | 步骤数字 | 彩色圆形（蓝→金→紫→绿） |

## 部署流程

```
本地改代码 → git push → git sync (GitHub) → SSH scp 到服务器 → 重启
```

或通过 raw-upload 方式：
```
tar czf /tmp/infrax.tar.gz --exclude=node_modules --exclude=.next .
curl --data-binary @/tmp/infrax.tar.gz http://43.156.46.187:3088/raw-upload/InfraX
```

### 代码同步铁律
- 🔴 不在生产服务器直接改源码
- 🔴 先 curl raw-upload 再 git_push → git_sync
- 🔴 部署后刷新前端须更新 JS `?v=` 参数

## 一键检查

```bash
ssh 43.156.46.187
for p in 6001 6002 6003 6004 3001 3002 3004 3005 3006 3007 3008 6100; do
  curl -s --max-time 2 http://localhost:$p/health 2>/dev/null \
    && echo ":$p OK" || echo ":$p DOWN"
done
```

## 逐服务管理

### Collector :3008
```bash
cd /opt/pocketx/projects/collector
PORT=3008 nohup npx tsx src/index.ts > /tmp/collector.log 2>&1 &
```

### WAAS :6001
```bash
cd /opt/pocketx/projects/waas
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
ETH_RPC_URL=https://ethereum-rpc.publicnode.com \
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org \
BASE_RPC_URL=https://mainnet.base.org \
SUPPORTED_CHAINS=sepolia,eth,bsc,base,oxa \
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
MPC_ENCRYPTION_SECRET=<32-byte-hex-secret> \
MPC_AGENT_TX_LIMIT_ETH=0.1 \
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
ETH_RPC_URL=https://ethereum-rpc.publicnode.com \
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org \
BASE_RPC_URL=https://mainnet.base.org \
OXA_RPC_URL=https://rpc-oxa.0xainet.top \
PORT=6003 \
  nohup npx tsx server.ts > /tmp/mpc.log 2>&1 &
```

### Payment :6004
```bash
cd /opt/pocketx/projects/payment
PORT=6004 nohup npx tsx server.ts > /tmp/payment.log 2>&1 &
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

# MPC MCP :3007
PORT=3007 MPC_URL=http://localhost:6003 nohup npx tsx mpc-index.ts > /tmp/mpc-mcp.log 2>&1 &
```

### Web :6100
```bash
cd /opt/pocketx/projects/web
nohup node server.js > /tmp/web.log 2>&1 &
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
SUPPORTED_CHAINS=sepolia,eth,bsc,base,oxa
PORT=6001
DATABASE_URL=postgresql://ubuntu@localhost:5432/pocketx_waas
```

### DC (自动双池，无需额外配置)
- `DATABASE_URL` → pocketx_dc (users/tenants)
- `COLLECTOR_DB_URL` → pocketx_collector (events, 默认同 localhost)

### MPC (v0.3.0 Agent Wallet)
```bash
DATABASE_URL=postgresql://ubuntu@localhost:5432/pocketx_mpc
MPC_ENCRYPTION_SECRET=<generated-32-byte-hex>   # 🔴 必填，不设则拒绝启动
MPC_AGENT_TX_LIMIT_ETH=0.1                       # Agent 单笔转账上限（ETH）
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
ETH_RPC_URL=https://ethereum-rpc.publicnode.com
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org
BASE_RPC_URL=https://mainnet.base.org
OXA_RPC_URL=https://rpc-oxa.0xainet.top
```

### Admin (v0.3.0 安全加固)
```bash
ADMIN_PASS=<strong-password>   # 🔴 必填，不设则拒绝启动
ADMIN_USER=admin
```

### MCP Servers (通过 HTTP 调后端 API)
```bash
WALLET_API_URL=http://localhost:6001
VAULT_API_URL=http://localhost:6002
DC_API_URL=http://localhost:3001
```

## 修复备忘

### v0.3.0 MPC Agent Wallet + 安全加固 (2026-07-17)
| 问题 | 根因 | 修复 |
|------|------|------|
| Vault 6 路由行为异常 | `POST /risk/rules` 缺闭合 `}));` 导致后续路由嵌套 | 补全闭包，删除孤立闭包 |
| Collector 启动崩溃 | 两处 `infrax123'` 缺前引号 | 补 `'` |
| MPC 验证码硬编码 888888 | 生产仍用固定验证码 | `crypto.randomInt(100000, 999999)` |
| MPC_ENCRYPTION_SECRET 用默认值 | 不设环境变量时使用 dev secret | 强制校验，拒绝默认值 |
| Admin 密码硬编码 admin123 | 写在源码中 | 环境变量 `ADMIN_PASS`，不设拒绝启动 |
| MPC 无 Agent 签名能力 | 仅有注册/恢复，无私钥使用能力 | 新增 Session Token 机制 + 9 个端点（签名/转账/合约） |
| MPC MCP 仅 5 tools | 零 Agent 操作能力 | 扩展至 15 tools |
| Web Proxy 缺 Payment | 前端调 `/api/v2/payment` 不行 | 补全代理 |

### v0.2.3 OxaChain 集成 (2026-07-15)
| 问题 | 根因 | 修复 | Commit |
|------|------|------|--------|
| OxaChain RPC SSL 不可用 | HTTP 无 SSL，钱包拒绝 | HTTPS + Let's Encrypt 证书，非 CF 代理 | `2858c50` |
| 生产 → Git 漏 20 文件 | server/git 不同步 | 全量补全 + `.gitignore` | `6a72ff0` `2156c57` |
| 无统一接入文档 | 分散在 MCP_REQUIREMENTS + SDK 源码 | `docs/API_ACCESS.md` 三合一 | `7aa3572` |

### v0.2.2 UI 美化 (2026-07-15)
| 问题 | 根因 | 修复 | Commit |
|------|------|------|--------|
| 全平台字体太小 | 基础 14px 偏小 | 两轮乘法：1.15×1.10≈1.26x，body 14→18px | `5a8bd25` `06009cd` |
| WaaS Overview 一直转 | `#waas-token-list` spinner 无人清除 | `waasLoadOverview()` 末尾加 `waasTokens()` | `7230d3d` |
| Safe Vault 换行 | 字体放大后 `nav-item` 宽度不够 | `white-space:nowrap` | `b552552` |
| DC 链卡片 emoji 丑 | emoji 图标不专业 | 5 条链本地 SVG logo | `e6d7af9` `8ad3eea` `80e6fdf` |
| WaaS Quick Start 简陋 | 纯文字链接 | 编号步骤卡 (4 色 badge) | `ae1a2fd` |

### v0.2.1 DC 5链 + 卡片UI (2026-07-15)
| 问题 | 根因 | 修复 |
|------|------|------|
| DC spinner 一直转 | `dcLoadDashboard` 未清 `dc-chain-stats` | `setHtml('dc-chain-stats', 5链状态)` |
| DC 只显示 1 条链 | 硬编码 | `DC_CHAINS` 常量 5 链 |
| 全 ○ Inactive | 误用 `.data` 包装 | 直接访问字段 |
| DC tab 永远 "Subscribe" | auth: 'wallet' 触发 MetaMask | `auth: 'none'` |
| Vault API 返回 HTML | `/api/vault` 缺代理 | 加 proxy 路由 |

### v0.2.0 Dashboard 重构 (2026-07-15)
| 问题 | 根因 | 修复 |
|------|------|------|
| WaaS plan 为空 | SQL 缺 `t.plan_id` | 加 planId + planName |
| Vault `relation "safes"` | 表名 `safe_wallets` | 修正 SQL |
| DC 用户查询失败 | users 表空 | populate + JOIN |

## 负载参考

```
正常: CPU idle 90%+, 内存 1.5-2G / 7.5G
Collector: ~19% CPU (6 链扫描正常)
已清理: Chrome headless ×4 + docker-bench-security.sh
```
