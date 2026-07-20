# InfraX 部署文档

> 最后更新: 2026-07-21 | 版本 `v0.3.4-20260721`

## 生产服务器

| 项目 | 旧服务器 | 新服务器 |
|------|---------|---------|
| Host | ~~43.156.46.187~~ | **43.156.99.215** |
| User | ubuntu | ubuntu |
| SSH | 直连 | 直连 |
| Ports | 3000-6100 | **9100-9111** |
| Spec | 4C/7.5G/178G | 4C/8G + **200G 数据盘 (/dev/vdb)** |

```bash
# SSH 直连
ssh ubuntu@43.156.99.215
```

## 当前运行服务（12 个 systemd）

| 服务 | 端口 | DB | 启动 | 状态 |
|------|------|-----|------|------|
| Admin | 9100 | 跨 7 DB | `systemctl start infrax-admin` | 🟢 |
| Collector | 9101 | pocketx_collector | `systemctl start infrax-collector` | 🟢 |
| DC | 9102 | pocketx_dc + pocketx_collector | `systemctl start infrax-dc` | 🟢 |
| DC MCP | 9103 | — | `systemctl start infrax-dc-mcp` | 🟢 |
| MPC | 9104 | pocketx_mpc | `systemctl start infrax-mpc` | 🟢 |
| MPC MCP | 9105 | — | `systemctl start infrax-mpc-mcp` | 🟢 |
| Payment | 9106 | pocketx_payment | `systemctl start infrax-payment` | 🟢 |
| Vault | 9107 | pocketx_vault | `systemctl start infrax-vault` | 🟢 |
| Vault MCP | 9108 | — | `systemctl start infrax-vault-mcp` | 🟢 |
| WAAS | 9109 | pocketx_waas | `systemctl start infrax-waas` | 🟢 |
| Wallet MCP | 9110 | — | `systemctl start infrax-wallet-mcp` | 🟢 |
| Web | 9111 | — | `systemctl start infrax-web` | 🟢 |
| Cleanup | — | pocketx_collector | `systemctl start infrax-cleanup` | 🟢 (timer) |

## 目录结构

```
/opt/infraX/projects/
├── admin/         → Admin :9100  (Express 5 SPA + REST API)
├── collector/     → Collector :9101  (5 链区块扫描)
├── dc/            → DC :9102  (数据中心 API)
├── mcp-server/    → 4 个 MCP Server (dc/mpc/vault/wallet)
├── mpc/           → MPC :9104  (多方计算钱包)
├── payment/       → Payment :9106
├── sdk/           → infrax-dk npm 包 (TypeScript SDK，非运行时服务)
├── vault/         → Vault :9107  (Safe 多签)
├── waas/          → WAAS :9109  (钱包即服务)
└── web/           → Web :9111  (SPA + Landing Page)
    ├── server.js          ← Node proxy (路由到后端 API)
    ├── index.html         ← 主应用
    ├── landing.html       ← 产品落地页
    ├── connect.html       ← 钱包连接页
    ├── admin.html         ← Admin 面板入口
    ├── img/               ← 链 Logo SVG (chain-*.svg × 6)
    └── modules/
        ├── core.js        ← 核心库 (afetch, user, setupNav, showToast)
        ├── nc-wallet.js   ← Dashboard 仪表盘
        ├── datacenter.js  ← Data Center 模块
        ├── mpc.js         ← MPC 模块
        ├── waas.js        ← WaaS 模块
        ├── waas-extras.js ← WaaS 工具函数
        ├── safe.js        ← Safe/Vault 模块
        ├── exports.js     ← 导出模块
        └── infrax.css     ← 统一样式
```

## Web Proxy 路由 (`server.js`)

```
/api/v2/data    → :9102 (DC)
/api/v2/mpc     → :9104
/api/v2/wallet  → :9109
/api/v2/waas    → :9109
/api/v2/saas    → :9109
/api/vault      → :9107
/api/v2/vault   → :9107
/api/v2/payment → :9106
/api/v2/admin   → :9100
```

## 防火墙端口

| 端口 | 服务 | 对外 |
|------|------|------|
| **9111** | Web / Landing Page | **必须开放** |
| **9100** | Admin 面板 | **建议开放** |
| 9103/9105/9108/9110 | MCP 服务 | 外部 AI Agent 调用时开放 |
| 9101/9102/9104/9106/9107/9109 | 后端 API | 仅内部调用 |

## 支持的区块链

| 链 | chain 参数 | Chain ID | RPC |
|---|-----------|----------|-----|
| Sepolia | `sepolia` | 11155111 | publicnode |
| Ethereum | `eth` / `ethereum` | 1 | publicnode |
| BSC | `bsc` | 56 | dataseed (12 端点 via rpc-pool.json + env) |
| Base | `base` | 8453 | mainnet.base.org |
| **OxaChain** | `oxa` | 19505 | **rpc-oxa.0xainet.top** |

> Collector 5 链扫描：sepolia / ethereum / bsc / base / oxa
> RPC Pool: `rpc-pool.json` 静态基线 + env 环境变量 + DB `admin_rpc_config` 三层合并

## systemd 管理

### 一键检查
```bash
# 所有服务
sudo systemctl --no-pager list-units 'infrax-*' --all

# 清理 timer 状态
sudo systemctl list-timers --all | grep infrax
```

### 逐个管理
```bash
sudo systemctl start infrax-collector
sudo systemctl stop infrax-collector
sudo systemctl restart infrax-collector
sudo systemctl status infrax-collector
sudo journalctl -u infrax-collector -f   # 实时日志
sudo journalctl -u infrax-collector --since '5 min ago'
```

### 全部重启
```bash
for s in infrax-collector infrax-admin infrax-dc infrax-dc-mcp infrax-mpc infrax-mpc-mcp infrax-payment infrax-vault infrax-vault-mcp infrax-waas infrax-wallet-mcp infrax-web; do
  sudo systemctl restart $s
done
```

### Collector Override 配置
```bash
# /etc/systemd/system/infrax-collector.service.d/okx.conf
Environment="OKX_CHAINOS_API_KEY=..."
Environment="OKX_CHAINOS_API_SECRET=..."
Environment="OKX_CHAINOS_API_PASSPHRASE=..."

# /etc/systemd/system/infrax-collector.service.d/oxa.conf
Environment="OXA_RPC_URL=https://rpc-oxa.0xainet.top"
```

## 数据库

```
localhost:5432, postgres:postgres
```

| 数据库 | 表数 | 说明 |
|--------|------|------|
| pocketx_collector | 10+ | 事件 + checkpoint + OKX + Binance |
| pocketx_waas | 17 | 钱包/用户/交易/SaaS |
| pocketx_vault | 4 | Safe 多签 |
| pocketx_dc | 2 | 订阅 |
| pocketx_mpc | 2 | MPC 钱包 |
| pocketx_payment | 3 | 支付 |
| pocketx_admin | 3 | 管理 |

## 数据盘挂载

200G 数据盘用于存储 PostgreSQL 数据库，避免系统盘被占满：

```bash
# 查看磁盘
lsblk

# 格式化（仅首次）
sudo mkfs.ext4 /dev/vdb

# 挂载
sudo mkdir -p /mnt/pgdata
sudo mount /dev/vdb /mnt/pgdata

# 持久化挂载（/etc/fstab）
echo '/dev/vdb /mnt/pgdata ext4 defaults 0 2' | sudo tee -a /etc/fstab

# 迁移 PostgreSQL 数据目录
sudo systemctl stop postgresql
sudo rsync -av /var/lib/postgresql/ /mnt/pgdata/
sudo mv /var/lib/postgresql /var/lib/postgresql.bak
sudo ln -s /mnt/pgdata /var/lib/postgresql
sudo systemctl start postgresql
```

确认挂载：
```bash
df -h /mnt/pgdata
# Filesystem      Size  Used Avail Use% Mounted on
# /dev/vdb        196G   XXG  XXXG  XX%  /mnt/pgdata
```

## 数据保留策略（5 天）

通过 systemd timer 每日凌晨 3:00 自动清理 5 天前的历史数据，确保数据库不占用过多磁盘空间。

### 清理脚本：`/opt/infrax-cleanup.sh`

| 表 | 清理条件 | 说明 |
|---|---------|------|
| `events` | `collected_at < 5 days` | Collector 链上事件 |
| `payment_events` | `created_at < 5 days` | 支付事件 |
| `okx_token_snapshots` | `collected_at < 5 days` | OKX 代币快照 |
| `binance_futures_prices` | `bucket < 5 days` | Binance 合约价格 |
| 最后执行 `VACUUM ANALYZE events` | — | 回收磁盘空间 |

### 部署清理服务

```bash
# 复制脚本
sudo cp infrax-cleanup.sh /opt/infrax-cleanup.sh
sudo chmod +x /opt/infrax-cleanup.sh

# 创建 systemd service
sudo tee /etc/systemd/system/infrax-cleanup.service << 'EOF'
[Unit]
Description=InfraX Data Retention Cleanup (5 days)
After=postgresql.service
Requires=postgresql.service

[Service]
Type=oneshot
ExecStart=/opt/infrax-cleanup.sh
StandardOutput=journal
StandardError=journal
EOF

# 创建 systemd timer（每日凌晨 3:00）
sudo tee /etc/systemd/system/infrax-cleanup.timer << 'EOF'
[Unit]
Description=InfraX Data Retention Cleanup Timer (daily at 3:00 AM)

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
EOF

# 启用并启动
sudo systemctl daemon-reload
sudo systemctl enable --now infrax-cleanup.timer
```

### 手动触发与监控

```bash
# 查看 timer 状态
sudo systemctl status infrax-cleanup.timer

# 手动执行一次清理
sudo systemctl start infrax-cleanup.service

# 查看清理日志
sudo tail -20 /var/log/infrax-cleanup.log

# 查看 timer 下次触发时间
sudo systemctl list-timers --all | grep infrax
```

## 环境变量关键项

所有服务通过 systemd unit 文件注入环境变量，详见 `deploy_infrax.sh`。

### Collector
```bash
PORT=9101
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pocketx_collector
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
ETH_RPC_URL=https://ethereum-rpc.publicnode.com
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org
BASE_RPC_URL=https://mainnet.base.org
OXA_RPC_URL=https://rpc-oxa.0xainet.top
```

### Admin
```bash
PORT=9100
ADMIN_PASS=<required>   # 不设拒绝启动
ADMIN_USER=admin
```

### MPC
```bash
PORT=9104
MPC_ENCRYPTION_SECRET=<32-byte-hex>  # 必填
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pocketx_mpc
```

### MCP Servers
```bash
WALLET_API_URL=http://localhost:9109
VAULT_API_URL=http://localhost:9107
DC_API_URL=http://localhost:9102
MPC_URL=http://localhost:9104
```

## 部署流程

```
本地改代码 → git push → 服务器 git pull → systemctl restart
```

```bash
# 在服务器上
cd /opt/infraX
git pull origin master
# 如有新增依赖
for d in admin collector dc mcp-server mpc payment vault waas web; do
  cd /opt/infraX/projects/$d && npm install 2>/dev/null || true
done
# 重启变更的服务
sudo systemctl restart infrax-admin
```

## 修复备忘

### v0.3.4 浏览器E2E测试 + 6项Bug修复 (2026-07-21)

| 问题 | 根因 | 修复 |
|------|------|------|
| nc-wallet.js 浏览器报 `ERR_INCOMPLETE_CHUNKED_ENCODING` | `server.js` `writeHead()` 未设 `Content-Length`，Node.js 使用 chunked 传输 + keep-alive 导致 chunk 流中断 | `writeHead` 显式添加 `Content-Length: data.length` |
| Dashboard 初始登录后页面空白骨架 | `core.js` 的 `ncDash` 仅绑定在 nav 点击事件上，页面初始加载从不触发 loader | 新增 `initActivePage()`，页面加载完成后自动触发当前 active 页面的 loader |
| 已激活 MPC 用户看到的是 Register 注册表单 | `mpc-wallet.js` 检测到已激活后显示了 dashboard-area，但 HTML 默认 active 子标签是 `mpc-reg` | 已激活时自动切换到 Dashboard 子标签并调用 `mpcDash()` |
| Safe Vault 列表报 `userId required` | `vault/server.ts` `/safe/owned` 只接受 `x-user-id` header，前端 `afetch` 只传 `x-wallet-address`，与同文件 `safe/status` 不一致 | `/safe/owned` 和 `/safe/participating` 添加 `x-wallet-address` 作为 fallback |
| Payment 创建订单点击无响应 | `payment.js` 请求体字段名 `paymentMethod` 但后端 destructure `method`，字段名不匹配 | 前端字段名改为 `method` |
| WaaS 地址分配点击无响应 | `waas.js` 请求体缺少 `tenantId`，API 返回 `Missing required fields: tenantId` | 请求体添加 `tenantId: waasActiveTenantId` |

**测试覆盖**: 真实浏览器操作（Playwright + Chromium）验证 Landing → 私钥登录 → Dashboard → MPC/WaaS/Safe/DC/Payment 全部用户路径 + Admin 后台。

### v0.3.3 数据盘挂载 + 数据 5 天清理 (2026-07-20)

| 项目 | 说明 |
|------|------|
| 200G 数据盘 | `/dev/vdb` → `/mnt/pgdata`，PostgreSQL 数据迁移到新盘 |
| 数据保留策略 | systemd timer 每日清理 5 天前数据（events/payment_events/okx_token_snapshots/binance_futures_prices） |
| 清理服务 | `infrax-cleanup.service` + `infrax-cleanup.timer`（每日凌晨 3:00） |

### v0.3.1 新服务器部署 + Express 5 修复 (2026-07-17)

| 问题 | 根因 | 修复 |
|------|------|------|
| 新服务器 SSH 超时 | 防火墙限制外部直连 | 跳板机 `129.226.203.60` |
| git clone 后语法错误 | `core.autocrlf` 导致单引号丢失 | `git config core.autocrlf false` + reset |
| Admin 反复 crash | Express 5 `path-to-regexp` v8 不支持 `'*'` | `app.get('*'` → `app.get('/{*splat}'` |
| Collector BSC 仅 2 端点 | rpc-pool.json 未被加载 | 新增 `loadStaticPoolConfig()` 三层合并 |
| Oxa 无 checkpoint | `UPDATE` 新链无行静默失败 | `INSERT...ON CONFLICT DO UPDATE` |
| Web 端口冲突 | `server.js` 硬编码 6100 | `process.env.PORT \|\| 6100` |
| payment/waas 缺依赖 | 项目无 package.json | `npm init -y` + `npm i express pg cors` |

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
| OxaChain RPC SSL 不可用 | HTTP 无 SSL，钱包拒绝 | HTTPS + Let's Encrypt 证书 | `2858c50` |
| 生产 → Git 漏 20 文件 | server/git 不同步 | 全量补全 + `.gitignore` | `6a72ff0` `2156c57` |
| 无统一接入文档 | 分散在 MCP_REQUIREMENTS + SDK 源码 | `docs/API_ACCESS.md` 三合一 | `7aa3572` |

## 健康检查

```bash
# 全部服务
for port in 9100 9101 9102 9103 9104 9105 9106 9107 9108 9109 9110 9111; do
  curl -s --max-time 2 http://localhost:$port/health 2>/dev/null \
    && echo ":$port OK" || echo ":$port DOWN"
done

# Collector 扫描状态
sudo journalctl -u infrax-collector --no-pager -n 20 | grep scanner

# DB checkpoint
sudo -u postgres psql -d pocketx_collector -c \
  "SELECT chain, collector_name, last_block, status FROM event_checkpoints ORDER BY chain;"
```

## 负载参考

```
新服务器 (43.156.99.215): CPU idle 90%+, 内存 ~1.5G / 8G
Collector: 5 链扫描 (sepolia/ethereum/bsc/base/oxa)，每链 ~17% CPU
已知问题: OKX ChainOS API 404（遗留），BSC 部分端点限流
```

### v0.3.2 E2E 测试 + MCP 调试 (2026-07-18)
| 问题 | 根因 | 修复 |
|------|------|------|
| Web Proxy /health 返回 HTML | server.js 无 /health 路由 | 新增 JSON 格式 /health + 安全头 |
| Proxy 路由 404 | 硬编码端口 3001/6001-6004 | 改为可配置 env 变量，默认 9100-9111 |
| Admin 前端登录失败 | endpoint/token/auth header 错误 | 修复 /api/v2/admin/login + 正确密码 |
| MPC 前端仍用 888888 | mpc-wallet.js 硬编码 | 改为真实验证码流程, 发码→用户输入→注册 |
| MCP 4 服务环境变量不匹配 | dc-index.ts用DC_URL, service设DC_API_URL | 双重env支持: DC_URL/DC_API_URL + 默认端口更新 |
| Vault 缺 safe_* 表 | server.ts 未调用 initDatabase() | 手动建表 + future: 启动时自动初始化 |
| MPC/DC Vault 缺 DB 建表 | server.ts 启动时未 CREATE TABLE | mpc_wallets/users/tenants 补全 |
