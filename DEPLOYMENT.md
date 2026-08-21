# InfraX 部署文档

> 最后更新: 2026-08-19 | 版本 `v0.8.0-20260816`（2026-08-19 WAAS 16 项安全优化发布，详见 [docs/services/waas.md §5](./docs/services/waas.md)）

> 📌 **生产环境为三台服务器**（2026-08-16 扩容迁移完成，详见 [docs/INFRAX_MIGRATION_SCALE_OUT.md](./docs/INFRAX_MIGRATION_SCALE_OUT.md)）：
> - **43.163.105.172**（主，新加坡·腾讯云）：区块链栈（9100-9111）+ 平台服务（9130-9132/9200-9201/3500）+ MCP（3008/3011/3012/3013/9103/9105/9108/9110）+ admin/web + nginx 公网入口（80/443）同机部署（**23 个 systemd 服务 + 清理 timer**）；postgres 数据盘已物理迁移新机，本机 postgres 已 disable。
> - **43.156.78.59**（新机，2026-08-16 上线）：PostgreSQL 14 整盘迁移（10 库，vdb 196G）+ ragservicer :9721 + knowledge-injector :9113 + 5 条 egress 隧道（18848~18852）。
> - **43.156.25.197**（ML 推理机）：ml-service :9120（独立部署）。
>
> 服务总数：**25 个 systemd 服务**（172×23 + 78.59×2）+ 172 清理 timer + 新机 egress 隧道 ×5 + ML 机 ml-service。
> **本文档覆盖区块链服务栈（9100-9111）与平台服务（9130-9132）**；数据栈详细部署见 [docs/infrax_tasklist.md](./docs/infrax_tasklist.md)。
> 历史服务器 ~~101.33.109.117 / 43.156.46.187 / 43.156.99.215 / 129.226.203.60~~ 均已弃用。

## 生产服务器

| 服务器 | 角色 | User | 代码路径 | 公网 | 内网 |
|--------|------|------|----------|------|------|
| **43.163.105.172** | 主（入口） | ubuntu | `/home/ubuntu/infraX-1` | SSH 直连 | 10.3.8.12 |
| **43.156.78.59** | 存储 + RAG 数据栈 | ubuntu | `/home/ubuntu/infraX-1` | SSH 直连 | **10.3.8.6** |
| **43.156.25.197** | ML 推理 | ubuntu | `/home/ubuntu/infraX-1/projects/ml-service` | SSH 直连 | — |

```bash
ssh ubuntu@43.163.105.172
ssh ubuntu@43.156.78.59    # 新机（postgres/rag/ki）
ssh ubuntu@43.156.25.197   # ML 机
```

### 172（主）端口总览

| 项目 | 值 |
|------|-----|
| 服务端口 | 区块链栈 9100-9111；平台服务 9130-9132/9200-9201/3500；MCP 3008/3011/3012/3013/9103/9105/9108/9110；nginx 80/443 |
| 公网入口 | 统一经 nginx（80 → 301 → 443）；**唯一对外域名 `https://infrax.0xainet.top`**（DNS→Cloudflare→172，2026-08-19 实测全前缀 200）；⚠️ `infrax.app` 已失效（解析至 Google Frontend，非本栈，勿用） |
| DB | postgres 已迁新机（`10.3.8.6:5432`），本机 `postgresql@14-main` 已 disable |

## 当前运行服务（25 个 systemd，分布两台）

### A. 43.163.105.172 — 区块链栈（9100-9111）

| 服务 | 端口 | DB | 启动 | 状态 |
|------|------|-----|------|------|
| Admin | 9100 | 跨 10 DB（@10.3.8.6） | `systemctl start infrax-admin` | 🟢 |
| Admin Legacy | 3002 | — | `systemctl start infrax-admin-legacy` | 🟢 |
| Collector | 9101 | pocketx_collector（@10.3.8.6） | `systemctl start infrax-collector` | 🟢 |
| DC | 9102 | pocketx_dc + pocketx_collector（@10.3.8.6） | `systemctl start infrax-dc` | 🟢 |
| MPC | 9104 | pocketx_mpc（@10.3.8.6） | `systemctl start infrax-mpc` | 🟢 |
| ~~Payment（旧支付）~~ | ~~9106~~ | pocketx_payment（历史残留） | ~~infrax-payment~~ 已删除 | 🔴 已下线（MQ-15 T-7，代码保留 git 历史） |
| Vault | 9107 | pocketx_vault（@10.3.8.6） | `systemctl start infrax-vault` | 🟢 |
| WAAS | 9109 | pocketx_waas（@10.3.8.6） | `systemctl start infrax-waas` | 🟢 |
| Web | 9111 | — | `systemctl start infrax-web` | 🟢 |

### B. 43.163.105.172 — 平台服务（9130-9132 / 9200-9201 / 3500）

| 服务 | 端口 | DB | 启动 | 状态 |
|------|------|-----|------|------|
| Chain RPC（链 RPC 网关） | 9130 | pocketx_chainrpc（@10.3.8.6） | `systemctl start infrax-chain-rpc` | 🟢 |
| AA Relay | 9131 | pocketx_mpc（@10.3.8.6，drop-in override.conf） | `systemctl start infrax-aa-relay` | 🟢 |
| **Payments（通用支付引擎）** | 9132 | pocketx_payments（@10.3.8.6） | `systemctl start infrax-payments` | 🟢 |
| MPC TSS Signer | 9200 | — | `systemctl start infrax-mpc-tss-signer` | 🟢 |
| MPC Signer | 9201 | — | `systemctl start infrax-mpc-signer` | 🟢 |
| Session Key | 3500 | session_key_engine（@10.3.8.6，`.env`） | `systemctl start infrax-session-key` | 🟢 |

### C. 43.163.105.172 — 数据栈（本机 9112；rag/ki 已迁新机）

| 服务 | 端口 | DB | 启动 | 状态 |
|------|------|-----|------|------|
| Data（数据中心，含 OpenD 行情网关） | 9112 | — | `systemctl start infrax-data` | 🟢 |
| ~~Knowledge Injector~~ | ~~9113~~ | — | 已迁 **43.156.78.59**（本机 disable） | 🔵 迁出 |
| ~~RAGservicer~~ | ~~9721~~ | — | 已迁 **43.156.78.59**（本机 disable） | 🔵 迁出 |

> 172 上 admin（:9100）的 `RAGSERVICER_BASE` / `INJECTOR_BASE` 与 hub-index 的 `RAG_URL` / `INJECTOR_URL` 均指向新机内网 `http://10.3.8.6:9721` / `http://10.3.8.6:9113`。

### D. 43.163.105.172 — MCP Server（3008/3011/3012/3013 + 区块链栈内 9103/9105/9108/9110）

| 服务 | 端口 | 说明 | 启动 | 状态 |
|------|------|------|------|------|
| Hub Index MCP | 3008 | mcp-server 入口（hub-index.ts） | `systemctl start infrax-hub-index` | 🟢 |
| Session-Key MCP | 3011 | mcp-server 入口 | `systemctl start infrax-session-key-mcp` | 🟢 |
| RPC MCP | 3012 | mcp-server 入口（rpc-index.ts，10 tools） | `systemctl start infrax-rpc-mcp` | 🟢 |
| **Market MCP** | **3013** | **mcp-server 入口（market-index.ts，18 tools，MQ-16 T-2）** | `systemctl start infrax-market-mcp` | 🟢 |
| DC MCP | 9103 | — | `systemctl start infrax-dc-mcp` | 🟢 |
| MPC MCP | 9105 | — | `systemctl start infrax-mpc-mcp` | 🟢 |
| Vault MCP | 9108 | — | `systemctl start infrax-vault-mcp` | 🟢 |
| Wallet MCP | 9110 | — | `systemctl start infrax-wallet-mcp` | 🟢 |

### E. 43.156.78.59（新机）— 存储 + RAG 数据栈

| 服务 | 端口 | DB | 启动 | 状态 |
|------|------|-----|------|------|
| PostgreSQL 14 | 5432 | **10 库整盘（vdb 196G）** | `systemctl start postgresql@14-main` | 🟢 |
| RAGservicer | 9721 | — | `systemctl start infrax-ragservicer` | 🟢 |
| Knowledge Injector | 9113 | — | `systemctl start infrax-knowledge-injector` | 🟢 |
| egress 隧道 ×5 | 18848~18852 | SSH 出口（公钥入 5 台出口 authorized_keys） | 随新机常驻 | 🟢 |

> 新机 `pg_hba.conf` 放行 172 内网（10.3.8.12/32）；`postgresql.conf` 已按 2C4G 调优。rag/ki 代码由 M-1 阶段 rsync（含 `projects/shared` 共享 metrics 模块）+ venv + unit。

### F. 43.156.25.197（ML 机）

| 服务 | 端口 | 启动 | 状态 |
|------|------|------|------|
| ml-service（模型推理） | 9120 | `systemctl start ml-service`（或独立部署脚本） | 🟢 |

### G. 定时任务（172）

| 服务 | 端口 | 说明 | 启动 | 状态 |
|------|------|------|------|------|
| Cleanup | — | 每日清理 5 天前数据（连 **10.3.8.6:5432**） | `systemctl start infrax-cleanup` | 🟢 (timer) |
| fd-monitor | — | 文件描述符水位监控（独立） | `systemctl start infrax-fd-monitor` | 🟢 (timer) |

> 对照：`sudo systemctl --no-pager list-units 'infrax-*' --all`（172 应见 23 服务 + timer，rag/ki 为 disable；新机 2 服务）；172 `sudo ss -tlnp` 应看到 3002/3008/3011/3012/3013/3500/9100-9105/9107-9112/9130-9132/9200-9201 共 24 个监听端口（9106 旧支付已下线；9113/9721 在新机）。

## 目录结构

```
/home/ubuntu/infraX-1/projects/
├── admin/              → Admin :9100 + Admin Legacy :3002  (Express 5 SPA + REST API)
├── collector/          → Collector :9101  (5 链区块扫描)
├── dc/                 → DC :9102  (数据中心 API)
├── mcp-server/         → 8 个 MCP 入口 (dc/mpc/vault/wallet/rpc/session-key/hub-index/market)
├── mpc/                → MPC :9104  (多方计算钱包)
├── payment/            → Payment :9106 (旧支付，🔴 已下线，代码保留 git 历史)
├── sdk/                → infrax-dk npm 包 (TypeScript SDK，非运行时服务)
├── vault/              → Vault :9107  (Safe 多签)
├── waas/               → WAAS :9109  (钱包即服务)
├── web/                → Web :9111  (SPA + Landing Page)
│   ├── server.js          ← Node proxy (路由到后端 API)
│   ├── index.html         ← 主应用
│   ├── landing.html       ← 产品落地页
│   ├── connect.html       ← 钱包连接页
│   ├── admin.html         ← Admin 面板入口
│   ├── img/               ← 链 Logo SVG (chain-*.svg × 6)
│   └── modules/
│       ├── core.js        ← 核心库 (afetch, user, setupNav, showToast)
│       ├── nc-wallet.js   ← Dashboard 仪表盘
│       ├── datacenter.js  ← Data Center 模块
│       ├── mpc.js         ← MPC 模块
│       ├── waas.js        ← WaaS 模块
│       ├── waas-extras.js ← WaaS 工具函数
│       ├── safe.js        ← Safe/Vault 模块
│       ├── exports.js     ← 导出模块
│       └── infrax.css     ← 统一样式
├── payments/           → Payments :9132  (通用支付引擎 @0xinfrax/payments)
├── chain-rpc/          → Chain RPC :9130  (链 RPC 网关)
├── aa-relay/           → AA Relay :9131
├── session-key/        → Session Key :3500
├── data/               → Data :9112  (数据中心，Python FastAPI)
├── knowledge-injector/ → Knowledge Injector :9113 (Flask)  ← 运行于 43.156.78.59
└── ragservicer/        → RAGservicer :9721                 ← 运行于 43.156.78.59
```

> ml-service 位于独立服务器 **43.156.25.197**:9120（`projects/ml-service`，不在 172）。公网经 nginx `/api/ml/*`、`/ml/*` 域名化（2026-08-19，`/api/ml/health` 200 实测）。rag/ki 代码在 172 与新机 78.59 各一份（新机为运行副本，git 同源）。

## Web Proxy 路由 (`server.js`，172)

```
/api/v2/data    → :9102 (DC)
/api/v2/data/market → :9101 (Collector 行情)
/api/v2/data/my-keys → :9112 (用户级 key)
/api/v2/market   → :9101 (Collector)   ← MQ-16 新增（2026-08-11）
/api/v2/mpc     → :9104
/api/v2/wallet  → :9109
/api/v2/waas    → :9109
/api/v2/saas    → :9109
/api/v2/admin   → :9100
/api/vault      → :9107
/api/v2/vault   → :9107
/api/v2/subscription → :9109
/v1             → :9131 (aa-relay)
/factors /graph /rag → :9112 (data-service)
/ml             → :9120 (ml-service)
/payments       → :9132 (payments 引擎)  ← 前端网关面板（2026-08-20 新增）
```

> **代理鉴权注入**（server.js）：默认注入 `X-Service-Key: $SERVICE_API_KEY`（平台 bridge key）；`/ml` 特判注入 `Authorization: Bearer $ML_API_KEY`；`/payments` 特判覆盖注入 `X-Service-Key: $PAYMENTS_API_KEY`（payments 引擎独立 key，与平台 bridge key 不同源，infrax-web drop-in `payments.conf` 配置）。

### nginx 公网入口（172，80/443，统一对外）

所有公网流量统一经 172 nginx 进入（后端服务大多绑定 127.0.0.1，外部不可直连）：

| 前缀 | 上游 | 说明 |
|---|---|---|
| `/api/data/*`、`/api/v1/*` | `http://127.0.0.1:9112/` | 数据栈（`/api/v1/*` 为旧契约兼容段） |
| `/api/rag/*` | **`http://10.3.8.6:9721/`** | ragservicer（**已指向新机**，M-3 调整） |
| `/api/ml/*` | **`http://43.156.25.197:9120/ml/`** | ml-service 推理机（`/api/ml/health` → `/health`，2026-08-19 新增） |
| `/api/v2/*`、`/api/vault` | web `server.js` → 各 91xx 服务 | 区块链栈 |
| `/api/v2/data/my-keys` | **`http://127.0.0.1:9111/`** | **nginx 专用 location（2026-08-20 新增）**：`/api/v2/data/my-keys`（B-11-3 用户级 key）必须走 web `server.js` → data `:9112`（钱包签名鉴权）；若不经此专用路由，会被下方 `location /api/v2/data/`（→ dc `:9102`）截获导致 404。勿删！ |
| `/mcp/*` | `http://127.0.0.1:3008/` | hub-index 统一 MCP 入站（`/mcp/message`，2026-08-19 实测 `/mcp/health` 200） |
| `/mcp/vault/*`、`/mcp/mpc/*`、`/mcp/dc/*`、`/mcp/wallet/*`、`/mcp/chain-rpc/*`、`/mcp/market/*` | `http://127.0.0.1:9108/` 等对应端口 | 7 个独立 HTTP MCP 子路由（2026-08-19 新增；`/mcp/session-key/*`→:3011） |
| `/api-keys/verify`、`/metrics` | — | 鉴权校验 / 监控指标 |
| `/` | admin/web 前端 | InfraX Web3 平台（需登录态） |

- 80 端口一律 301 → 443；TLS 经 Cloudflare 边缘证书（自动续期）
- **唯一对外域名 `https://infrax.0xainet.top`**（DNS→Cloudflare→172）；2026-08-19 实测：`/api/data/health`、`/api/rag/api/v1/health`、`/api/v1/health`、`/api/v2/data/stats`（需 key）、`/mcp/health` 均到达本栈并返回 JSON
- ⚠️ **`infrax.app` 域名已失效**：2026-08-19 实测解析至 `34.111.179.208`（Google Frontend），返回外部页面而非 infraX；对外一律使用 `infrax.0xainet.top`，`infrax.app` 待域名方处理/回收（此前文档若引用均需改用 `infrax.0xainet.top`）
- Chain RPC 公网 HTTPS 入口：`https://rpc-gw.0xainet.top`（nginx TLS 反代 `:9130`，certbot 自动续期，见 [docs/API_ACCESS.md](./docs/API_ACCESS.md)）
- AA Relay 公网入口：`https://rpc-gw.0xainet.top/aa-relay/`（9131 对外 / 9134 内部 signer 仅内网）

## 防火墙端口

### 172（主）
| 端口 | 服务 | 对外 |
|------|------|------|
| **80/443** | nginx 公网入口 | **必须开放** |
| **9111** | Web / Landing Page | **开放**（亦经 nginx） |
| **9100** | Admin 面板 | **开放**（亦经 nginx） |
| 9103/9105/9108/9110/3011/3012/3013 | MCP 服务 | 外部 AI Agent 调用时开放 |
| 9101/9102/9104/9107/9109 | 后端 API | 仅内部调用 |
| 9130-9132（chain-rpc/aa-relay/payments 引擎） | 平台服务 | 仅内部调用（外部 key 经业务服务/nginx 进入） |

### 43.156.78.59（新机）
| 端口 | 服务 | 对外 |
|------|------|------|
| 5432 | postgres | **仅内网**（pg_hba 放行 10.3.8.12/32，即 172） |
| 9721 / 9113 | ragservicer / ki | 仅内网（172 经 `10.3.8.6` 调用） |
| 18848~18852 | egress 隧道 | 出站（公钥入 5 台出口） |

### 43.156.25.197（ML 机）
| 端口 | 服务 | 对外 |
|------|------|------|
| 9120 | ml-service | 对外（SDK `mlUrl` 指向） |

## 支持的区块链

| 链 | chain 参数 | Chain ID | RPC |
|---|-----------|----------|-----|
| Sepolia | `sepolia` | 11155111 | publicnode |
| Ethereum | `eth` / `ethereum` | 1 | publicnode |
| BSC | `bsc` | 56 | dataseed (12 端点 via rpc-pool.json + env) |
| Base | `base` | 8453 | mainnet.base.org |
| **OxaChain** | `oxa` | 19505 | **rpc.l1.oxachain.io**（公网 `rpc-oxa.0xainet.top`，DNS→172） |

> Collector 5 链扫描：sepolia / ethereum / bsc / base / oxa
> RPC Pool: `rpc-pool.json` 静态基线 + env 环境变量 + DB `admin_rpc_config` 三层合并

## systemd 管理

### 一键检查
```bash
# 172 上所有服务（应 23 服务 + timer，rag/ki disable）
sudo systemctl --no-pager list-units 'infrax-*' --all
# 新机
ssh ubuntu@43.156.78.59 'systemctl --no-pager list-units "infrax-*" --all'

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

### 172 全部重启
```bash
for s in \
  infrax-admin infrax-admin-legacy infrax-collector infrax-dc infrax-mpc infrax-vault infrax-waas infrax-web \
  infrax-chain-rpc infrax-aa-relay infrax-payments infrax-session-key infrax-mpc-signer infrax-mpc-tss-signer \
  infrax-data \
  infrax-dc-mcp infrax-mpc-mcp infrax-vault-mcp infrax-wallet-mcp infrax-hub-index infrax-session-key-mcp infrax-rpc-mcp infrax-market-mcp; do
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

# /etc/systemd/system/infrax-collector.service.d/secrets.conf  (root:600, EPF-8 2026-08-22)
# 敏感密钥统一集中在此文件，禁止写入 .env.production / .env（两文件均不入 git）。
# 系统加载顺序：systemd Environment 优先于 dotenv，dotenv 不覆盖已存在环境变量。
Environment="DATABASE_URL=postgresql://pocketx_app:<强密码>@10.3.8.6:5432/pocketx_collector"
Environment="ADMIN_USERNAME=admin"
Environment="ADMIN_PASSWORD=<强随机 24+ 字符>"
Environment="CWALLET_API_KEY=<64 hex>"
```

## 数据库（43.156.78.59，10.3.8.6:5432）

> **PostgreSQL 14 位于新机 43.156.78.59**（2026-08-16 整盘迁移），172 及各服务经内网 `10.3.8.6:5432` 连接。
> **collector 从 2026-08-22 起使用专用低权限用户 `pocketx_app`**（EPF-8；仅 pocketx_collector 库，库内 31 表 owner），
> 不再使用 `postgres:postgres` 超管连接；`postgres:postgres` 仅保留运维用途。

| 数据库 | 表数 | 说明 |
|--------|------|------|
| pocketx_payments | 11 | **通用支付引擎 ledger**（余额/转账/邀请/批次/意图/授权，MQ-14/16 能力全量） |
| pocketx_chainrpc | 3 | **Chain RPC 对外套餐**（rpc_keys/rpc_usage/rpc_usage_daily，MQ-16 T-3） |
| pocketx_collector | 18 | 事件 + checkpoint + OKX + Binance + Market 套餐（market_usage，MQ-16 T-2；含 ~90 万行 events） |
| pocketx_waas | 18 | 钱包/用户/交易/SaaS/订阅 |
| pocketx_dc | 4 | 订阅 + api_usage/api_usage_daily 配额（MQ-16 T-1） |
| pocketx_mpc | 5 | MPC 钱包/会话/验证码 + 订阅（MQ-16 T-4；aa-relay 共用） |
| pocketx_vault | 5 | Safe 多签 |
| pocketx_payment | 3 | 旧支付（🔴 已下线，历史残留） |
| pocketx_admin | 0 | 管理（数据跨库查询，本库无表） |
| session_key_engine | 2 | Session Key :3500 会话密钥 |

## 数据盘挂载（43.156.78.59）

vdb 200G（196G 可用）承载全部 postgres 数据（**从 172 物理整盘迁移**，2026-08-16 M-2 阶段），挂载方式：

```bash
# 查看磁盘
lsblk
# 确认挂载
df -h /mnt/pgdata
# Filesystem      Size  Used Avail Use% Mounted on
# /dev/vdb        196G   92G  104G  47%  /mnt/pgdata

# 结构（/etc/fstab 持久化 + 符号链接）
echo '/dev/vdb /mnt/pgdata ext4 defaults 0 2' | sudo tee -a /etc/fstab
# /var/lib/postgresql → /mnt/pgdata
```

> 172 已无数据盘（迁移后系统盘 31G/59G，26G 可用）；新机 `pg_wal` 配置与 postgresql.conf 调优见 [docs/INFRAX_MIGRATION_SCALE_OUT.md](./docs/INFRAX_MIGRATION_SCALE_OUT.md)。

## 数据保留策略（5 天，172 上执行）

通过 systemd timer 每日凌晨 3:00 自动清理 5 天前的历史数据（**连接 10.3.8.6:5432**，M-3 已同步连接串）。

### 清理脚本：`/opt/infrax-cleanup.sh`

| 表 | 清理条件 | 说明 |
|---|---------|------|
| `events` | `collected_at < 5 days` | Collector 链上事件 |
| `payment_events` | `created_at < 5 days` | 支付事件 |
| `okx_token_snapshots` | `collected_at < 5 days` | OKX 代币快照 |
| `binance_futures_prices` | `bucket < 5 days` | Binance 合约价格 |
| 最后执行 `VACUUM ANALYZE events` | — | 回收磁盘空间 |

### 部署清理服务（172）
```bash
# 复制脚本
sudo cp infrax-cleanup.sh /opt/infrax-cleanup.sh
sudo chmod +x /opt/infrax-cleanup.sh

# 创建 systemd service
sudo tee /etc/systemd/system/infrax-cleanup.service << 'EOF'
[Unit]
Description=InfraX Data Retention Cleanup (5 days)
After=network.target

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

> 清理脚本内 `DATABASE_URL` 需指向 `postgresql://postgres:postgres@10.3.8.6:5432/pocketx_collector`。

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

所有服务通过 systemd unit 文件注入环境变量，详见 `deploy_infrax.sh`。**迁移后数据库连接统一为 `10.3.8.6:5432`**。

### Collector
```bash
PORT=9101
DATABASE_URL=postgresql://postgres:postgres@10.3.8.6:5432/pocketx_collector
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
RAGSERVICER_BASE=http://10.3.8.6:9721    # 新机
INJECTOR_BASE=http://10.3.8.6:9113       # 新机
```

### MPC
```bash
PORT=9104
MPC_ENCRYPTION_SECRET=<32-byte-hex>  # 必填
DATABASE_URL=postgresql://postgres:postgres@10.3.8.6:5432/pocketx_mpc
```

### MCP Servers
```bash
WALLET_API_URL=http://localhost:9109
VAULT_API_URL=http://localhost:9107
DC_API_URL=http://localhost:9102
MPC_URL=http://localhost:9104
RAG_URL=http://10.3.8.6:9721         # hub-index（新机）
INJECTOR_URL=http://10.3.8.6:9113    # hub-index（新机）
```

### MQ-16 套餐服务（dc/collector/chain-rpc/mpc/payments）
各服务套餐/计费配置通过 systemd drop-in 注入（`PAYMENTS_URL` / `PAYMENTS_API_KEY` / `PAYMENTS_WEBHOOK_SECRET` / `PAYMENTS_DEFAULT_RAIL` / `PAYMENTS_CHAIN` / `PAYMENTS_PLAN_ID_MAP`），完整清单与部署步骤见下文「MQ-16 对外套餐服务」章节。

## 数据栈部署（data / knowledge-injector / ragservicer / ml-service）

> 本章节自 [docs/infrax_tasklist.md](./docs/infrax_tasklist.md) 原 §1~§8 迁入（2026-08-21 精简 tasklist）。
> 原 §2 生产服务器 / §2.1 nginx 路由已合并至本文档顶部「生产服务器」「nginx 公网入口」章节（三台架构、公网 `infrax.0xainet.top` 全 200，2026-08-19 实测）。
> 数据栈运行位置：data :9112 与 admin-legacy :3002 在 172；ragservicer :9721 + knowledge-injector :9113 在新机 **43.156.78.59**（公网入方向保持关闭，B 端一律经 172 nginx `/api/rag/*`、`/api/data/*` 进入）；ml-service :9120 在 **43.156.25.197**（ML 机）。

### 1. 架构总览

```
                 ┌──────────────────────────────────────────────┐
  外部数据源 ───▶ │  data :9112                                  │
  (akshare/CBOE/ │  ┌────────────────────────────────────────┐  │
   yfinance/     │  │ kline_store   → K线 SQLite (data.db)    │  │
   ccxt/...)     │  │ external_     → 因子快照 (raw_snapshots) │  │
                 │  │ factors        (VIX/US10Y/DXY/F&G)      │  │
                 │  └────────────────────────────────────────┘  │
                 └───────┬───────────────┬──────────────────────┘
                         │ HTTP          │ HTTP (/bars /symbols → 数据)
                 ┌───────▼────────┐  ┌───▼───────────────────────┐
                 │ ml-service :9120│  │ knowledge-injector :9113 │
                 │ (独立服务器常开) │  │ 内置注入器(21类) + YAML  │
                 │ LightGBM/       │  │ 结构化文本 + 幂等 doc_id  │
                 │ FinBERT/Kronos  │  └───────┬──────────────────┘
                 └────────────────┘          │ POST /api/v1/namespaces/{ns}/documents
                 ┌───────────────▼──────────────────────────────┐
                 │  ragservicer :9721 (LightRAG 微服务)           │
                 │  实体抽取(LLM) + embedding + 知识图谱           │
                 └──────────────────────────────────────────────┘
```

> 虚线关系：`ml-service` 拉取 data 的 K 线数据（不直连 SQLite），data/injector 通过 `ML_SERVICE_URL` 拉取推理结果（见 8.5）。

- **data**: 聚合 Crypto(ccxt)/美股/港股/A股/外汇/期货行情、K线、因子与快照数据
- **knowledge-injector**: 定时把快照转成结构化文本注入 RAGservicer，构建知识图谱
- **ragservicer**: LightRAG 微服务（实体抽取需 LLM key，embedding 需 DashScope key）
- **ml-service**: 独立服务器常开，承载 LightGBM / FinBERT / Kronos 模型推理（详见 8.5）
- **nginx**: 唯一公网入口（80/443，与区块链栈/web 共用）——`/api/data/*`→:9112、`/api/rag/*`→:9721、`/`→admin/web；域名 `infrax.0xainet.top`（详见 §2.1）

---
### 3. 首次部署（一次性）

#### 3.1 前置依赖

```bash
sudo apt-get update
sudo apt-get install -y python3.12-venv   # venv 必须
sudo usermod -aG docker ubuntu            # 可选：Docker 方式部署 ragservicer 时用
```

#### 3.2 拉取代码

```bash
git clone https://github.com/sftgroup/infraX.git /home/ubuntu/infraX-1
```

#### 3.3 创建 venv 并安装依赖（三个项目）

```bash
cd /home/ubuntu/infraX-1/projects
for d in data knowledge-injector ragservicer; do
  cd $d
  rm -rf .venv
  python3 -m venv .venv
  ./.venv/bin/pip install -q --upgrade pip
  ./.venv/bin/pip install -q -r requirements.txt
  cd ..
done
```

> 说明：
> - `data` 依赖较重（pandas/akshare/yfinance/ccxt），安装约 2-5 分钟
> - `ragservicer` 依赖 `lightrag-hku`（含 torch/sentence-transformers），安装约 3-8 分钟
> - 也可用 Docker 方式部署 ragservicer：`cd projects/ragservicer && docker compose build && docker compose up -d`

#### 3.4 配置 .env

```bash
cd /home/ubuntu/infraX-1/projects
cp data/.env.example data/.env
cp knowledge-injector/.env.example knowledge-injector/.env
cp ragservicer/.env.example ragservicer/.env
```

详细配置项见第 4 节。密钥项（ragservicer）可后补，填入后重启对应服务即可。

#### 3.5 安装 systemd 单元并启动

```bash
cd /home/ubuntu/infraX-1/projects
sudo cp data/infrax-data.service \
        knowledge-injector/infrax-knowledge-injector.service \
        ragservicer/infrax-ragservicer.service \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now infrax-data
sudo systemctl enable --now infrax-knowledge-injector
sudo systemctl enable --now infrax-ragservicer
```

三个服务均已开机自启（`Restart=always`）。

#### 3.6 管理后台（infrax-admin，可选）

Admin Panel 统一管理数据栈三个服务（健康、K线/因子/注入/实例）+ LLM API Key 配置：

```bash
# 前置：Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs

cd /home/ubuntu/infraX-1/projects/admin
npm install --no-audit --no-fund
npm run build                        # 构建 React 前端 → dist/

# 生成管理密码，写入 systemd 单元
ADMIN_PASS_VAL=$(openssl rand -hex 16)

# /etc/systemd/system/infrax-admin.service
#   [Unit]
#   Description=InfraX Admin Panel (data stack)
#   After=network.target
#   [Service]
#   Type=simple
#   User=ubuntu
#   WorkingDirectory=/home/ubuntu/infraX-1/projects/admin
#   Environment="ADMIN_PASS=<ADMIN_PASS_VAL>"
#   Environment="ADMIN_USER=admin"
#   Environment="PORT=3002"
#   Environment="RESTART_CMD=sudo"        # 面板保存 key 后需免密 sudo 重启 ragservicer
#   Environment="PATH=/usr/local/bin:/usr/bin:/home/ubuntu/infraX-1/projects/admin/node_modules/.bin:$PATH"
#   ExecStart=/home/ubuntu/infraX-1/projects/admin/node_modules/.bin/tsx server/index.ts
#   Restart=on-failure
#   RestartSec=5
#   [Install]
#   WantedBy=multi-user.target

sudo systemctl daemon-reload
sudo systemctl enable --now infrax-admin
```

访问 `http://<服务器IP>:3002`，账号 `admin`，密码为上述 `ADMIN_PASS_VAL`（服务器上也保存在 `/home/ubuntu/.admin_pass.txt`）。
注意：`3002` 端口需在腾讯云安全组放行。

---

### 4. 配置详解

#### 4.1 data（`projects/data/.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATA_SERVICE_PORT` | 9112 | 服务端口 |
| `DATA_DB_PATH` | data/data.db | SQLite 存储 |
| `KL_SYMBOLS` | BTC/USDT,ETH/USDT,SOL/USDT | Crypto K线标的（ccxt binance） |
| `KL_TIMEFRAMES` | 1m | Crypto K线周期 |
| `KL_INTERVAL_SEC` | 300 | K线采集间隔 |
| `DATA_CONFIG_PATH` | data_config.json | 多市场采集配置（见 4.4） |
| `FACTOR_COLLECT_INTERVAL_SEC` | 300 | 因子采集间隔 |

#### 4.2 knowledge-injector（`projects/knowledge-injector/.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `RAGSERVICER_URL` | http://127.0.0.1:9721 | RAGservicer 地址（systemd 单元已注入） |
| `RAGSERVICER_API_KEY` | 空 | 与 ragservicer 的桥接 key 一致（见 4.3） |
| `DEFAULT_NAMESPACE` | market | 注入 namespace |
| `INJECTOR_INTERVAL_SEC` | 21600 | 注入间隔（6h） |
| `INJECTOR_STARTUP_DELAY` | 120 | 启动延迟 |
| `DC_URL` / `COLLECTOR_URL` | 空 | raw 数据注入源（未配置时跳过） |

#### 4.3 ragservicer（`projects/ragservicer/.env`）

| 变量 | 默认 | 说明 | 状态 |
|---|---|---|---|
| `LLM_BINDING_HOST` | https://api.deepseek.com/v1 | LLM 实体抽取 | ✅ 默认 |
| `LLM_MODEL` | deepseek-chat | | ✅ 默认 |
| `LLM_BINDING_API_KEY` | YOUR_DEEPSEEK_API_KEY | **必填，需替换** | ⚠️ 待填 |
| `EMBEDDING_BACKEND` | dashscope | 云端 embedding | ✅ 默认 |
| `EMBEDDING_MODEL` | text-embedding-v4 | | ✅ 默认 |
| `EMBEDDING_API_KEY` | YOUR_DASHSCOPE_API_KEY | **必填，需替换** | ⚠️ 待填 |
| `ADMIN_API_KEY` | YOUR_ADMIN_KEY | 管理接口鉴权（/instances 等） | ⚠️ 待填 |
| `STORAGE_MODE` | local | 本地 JSON 存储 | ✅ 默认 |
| `REST_PORT` | 9721 | | ✅ 默认 |

**密钥配置步骤**（服务无需重建，填好重启即可）：

```bash
sudo -u ubuntu sed -i \
  -e 's/^LLM_BINDING_API_KEY=.*/LLM_BINDING_API_KEY=<你的DeepSeekKey>/' \
  -e 's/^EMBEDDING_API_KEY=.*/EMBEDDING_API_KEY=<你的DashScopeKey>/' \
  -e 's/^ADMIN_API_KEY=.*/ADMIN_API_KEY=<自定义管理key>/' \
  /home/ubuntu/infraX-1/projects/ragservicer/.env

# 注入器桥接 key 保持一致（任选其一，空则注入返回 403）
echo 'RAGSERVICER_API_KEY=<与上面ADMIN_API_KEY一致>' >> /home/ubuntu/infraX-1/projects/knowledge-injector/.env

sudo systemctl restart infrax-ragservicer infrax-knowledge-injector
```

#### 4.4 多市场采集配置（data/data_config.json）

`multi_kline` 段驱动美股/期货/A股/港股/外汇日线采集，`timeframes` 当前仅 `1d`（免费源仅日线）。**外汇 `symbols` 已填回（EURUSD=X 等 7 对，2026-08-08 实测全量 796-800 根）**：优先走 Twelve Data（配置 `TWELVE_DATA_API_KEY` 后），否则回退 yfinance——yfinance 仍受限流影响时该对日采集会失败并计入 failed 告警。**A股/港股走腾讯日线**（`web.ifzq.gtimg.cn`，独立于新浪风控），新浪仅作回退。

#### 4.5 管理后台（infrax-admin）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_PASS` | 必填 | 后台登录密码（无则拒绝启动） |
| `ADMIN_USER` | admin | 登录用户名 |
| `PORT` | 3002 | 后台端口 |
| `RESTART_CMD` | sudo | 保存 key 后重启服务用（需免密 sudo；root 可留空） |
| `RAGSERVICER_ENV_PATH` | `/home/ubuntu/infraX-1/projects/ragservicer/.env` | ragservicer 配置落点 |
| `DATA_BASE` / `INJECTOR_BASE` / `RAGSERVICER_BASE` | `http://127.0.0.1:9112/9113/9721` | 数据栈服务地址（跨机部署时改） |

**LLM API Key 管理**：后台「Data Stack」页可直接填写 LLM/Embedding/Admin/桥接 4 个 key，保存后自动写入 `ragservicer/.env` 并 `systemctl restart infrax-ragservicer`（若改了桥接 key 还会重启注入器），无需再 SSH。读取时仅返回脱敏值（`sk-n********7890`），不暴露明文。

**REST 接口**（均需后台登录 cookie 或 `X-Admin-Token`）：
- `GET /api/v2/data/overview` — 三服务健康 + K线/快照/注入统计
- `GET /api/v2/data/factors` — 因子目录 + 最新外部因子值
- `GET /api/v2/data/llm-keys` / `POST /api/v2/data/llm-keys` — 脱敏读取 / 写入 key 并重启

#### 4.6 服务间鉴权（业务端点 API Key）

三个服务的业务端点鉴权现状：

| 服务 | 业务端点鉴权 | 管理端点 |
|---|---|---|
| data :9112 | **可配置**（`DATA_API_KEY`，回退 `RAGSERVICER_API_KEY`→`DOC_API_KEY`→`LIGHTRAG_API_KEY`）+ **多租户签发 key**（`/admin/api-keys`，`dx_` 前缀）；未配置则开放 | `/admin/config`、`/admin/status`、`/admin/symbols`、`/admin/api-keys` 需 Bearer `ADMIN_API_KEY` |
| knowledge-injector :9113 | **可配置**（`INJECTOR_API_KEY`，回退 `RAGSERVICER_API_KEY`）；未配置则开放 | `/admin/config` 需 Bearer `ADMIN_API_KEY` |
| ragservicer :9721 | **强制**（bridge key / admin key / 租户 key 三层，见 4.3） | `/api/v1/admin/*`、`/instances` 需 Bearer `ADMIN_API_KEY` |

调用方式统一：`Authorization: Bearer <key>`、`X-API-Key: <key>` 或 `X-Service-Key: <key>` 三选一（AItrader 服务间约定用 `X-Service-Key`）。

**key 一致性要求**：data-service 与 knowledge-injector 建议配置**同一把** `RAGSERVICER_API_KEY`（与 ragservicer/注入器 bridge key 一致），这样：
- injector → data-service 联动（`GET /snapshots` 拉情绪因子）自动带 `X-API-Key`，无需额外配置
- admin 后台自动读取三个服务 `.env` 中的 key 转发请求（`DATA_API_KEY`/`INJECTOR_API_KEY`/`RAGSERVICER_API_KEY`），改 key 后无需重启 admin

**启用方式**：在对应服务 `.env` 填入 key 并重启即强制校验；删除 key 即回退开放模式（向后兼容，便于 aitrader 调用方逐步接入）。

##### 4.6.1 data 多租户 key 签发（`/admin/api-keys`，复用旧栈 collector api_keys 模式）

面向下游平台（aitrader 等）签发独立业务 key，与 bridge key 等价可访问全部业务端点；携带方式三 header 任一。仅存 SHA-256 哈希，不存明文。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/admin/api-keys` | GET | 列表（key 掩码：前 8 + `...` + 后 4，含 enabled / rate_limit / last_used_at / request_count 用量监控） |
| `/admin/api-keys` | POST | 签发 `{label, rate_limit?}` → 完整 key **仅此一次**返回 |
| `/admin/api-keys/{id}` | PATCH | `{label?, enabled?, rate_limit?}`（热启停 / 调限流） |
| `/admin/api-keys/{id}/rotate` | POST | 轮换（同 id 新 key，旧 key 立即失效） |
| `/admin/api-keys/{id}` | DELETE | 吊销 |

行为契约：
- 未携带 / 非法 key → `401 {"detail": "unauthorized"}`；已禁用 → `403`；超 RPM → `429`（每 key 1 分钟滑动窗口，内存单实例）
- `dx_` 前缀 + 32 字节 hex（51 字符）；表 `api_keys` 存于共享 SQLite `data/data.db`
- 签发/轮换的完整 key 需立即保存（服务端仅存哈希，无法二次读取）

```bash
# 签发（Bearer ADMIN_API_KEY）
curl -X POST http://<host>:9112/admin/api-keys \
  -H "Authorization: Bearer <ADMIN_API_KEY>" -H "Content-Type: application/json" \
  -d '{"label":"aitrader-prod","rate_limit":100}'
# → {"code":0,"message":"ok","data":{"id":1,"api_key":"dx_...","label":"aitrader-prod",...}}

# aitrader 侧调用
curl -H "X-Service-Key: dx_..." http://<host>:9112/stats
```

#### 4.7 ml-service（`projects/ml-service/.env`，独立服务器）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ML_SERVICE_PORT` | 9120 | 服务端口 |
| `DATA_SERVICE_URL` | 空 | **必填**，指向主栈 data（`http://<主服务器IP>:9112`），未配置则 LightGBM/Kronos fail-silent |
| `DATA_API_KEY` | 空 | 主栈 data 的鉴权 key（主栈未配置 key 可留空） |
| `ML_API_KEY` | 空 | 本服务自身鉴权（主栈 data/injector 侧 `ML_API_KEY` 需同步） |
| `TREE_ML_ENABLED` / `TREE_ML_HORIZON`(7) / `TREE_ML_UP_THR`(0.01) / `TREE_ML_MIN_SAMPLES`(300) / `TREE_ML_MIN_BARS`(120) / `TREE_ML_MAX_BARS`(2000) / `TREE_ML_RETRAIN_HOURS`(24) | false / … | LightGBM 方向预测开关与训练参数；模型文件 `models/`（git 忽略） |
| `XGB_ENABLED` / `RF_ENABLED` | false | XGBoost / Random Forest 方向预测对比家族开关；与 LightGBM **同一数据集/同一切分**训练，仅作对照（RF 用 sklearn 自带） |
| `FINBERT_ENABLED` / `FINBERT_MODEL` | false / `ProsusAI/finbert` | FinBERT 新闻情绪开关与模型名（可换 `yiyanghkust/finbert-tone` 支持中英） |
| `KRONOS_ENABLED` / `KRONOS_MODEL` / `KRONOS_LOOKBACK`(400) / `KRONOS_PRED_LEN`(30) / `KRONOS_SAMPLE_COUNT`(12) | false / `NeoQuasar/Kronos-mini` / … | Kronos 波动率预测开关与参数；需 systemd `PYTHONPATH` 指向 Kronos 源码 |
| `BOLT_ENABLED` / `MOIRAI_ENABLED` / `TIMESFM_ENABLED` | false | P2 时序基础模型开关（Chronos-Bolt / Moirai 2.0 / TimesFM 2.5） |
| `P2_TARGET_SYMBOLS` | 空 | 目标符号池（逗号分隔，显式覆盖 data-service 动态发现；空走动态） |
| `ML_CACHE_TTL_SEC` | 1800 | 端点结果缓存时长（秒）；TTL 内命中秒回不重算 |
| `ML_PREWARM_ENABLED` / `ML_PREWARM_DELAY_SEC` / `ML_PREWARM_INTERVAL_SEC` | true / 60 / 900 | 预热线程开关与周期（缓存缺失/过期时后台刷新；interval 建议 < TTL） |

**主栈联动配置**（见 8.5 主栈切换）：
- data `.env`：`ML_SERVICE_URL=http://43.156.25.197:9120`（可选 `ML_API_KEY`）
- injector `.env`：`ML_SERVICE_URL=http://43.156.25.197:9120`（可选 `ML_API_KEY`）

---

### 5. 数据源与降级链（yfinance 限流绕过）

> 背景：本机 IP 被 Yahoo Finance 全接口限流（`Too Many Requests. Rate limited.`）。已将美股/期货/因子切换到免费备用源，全部免 API key。

| 数据 | 主源 | 备用 | 最终兜底 |
|---|---|---|---|
| 美股 K线 | akshare 新浪 `stock_us_daily` | — | 记 warning 跳过 |
| 期货 K线 | akshare 东财 `futures_foreign_hist` | — | 记 warning 跳过 |
| A股 K线 | **腾讯日线（不复权）** | akshare 新浪 `stock_zh_a_daily` | 记 warning 跳过 |
| 港股 K线 | **腾讯日线（前复权）** | akshare 新浪 `stock_hk_daily` | 记 warning 跳过 |
| 外汇 K线 | Twelve Data（需 key） | yfinance | 记 warning 跳过 |
| Crypto K线 | ccxt binance | | |
| VIX | **CBOE 官方 CSV** | yfinance | 最近快照 stale |
| US10Y | **akshare 东财美债收益率** | yfinance | 最近快照 stale |
| DXY | yfinance | Twelve Data（需 key）→ FRED DTWEXBGS（需 key） | 最近快照 stale |
| 美股指数 | akshare 新浪 `index_us_stock_sina` | yfinance（非美指数） | 跳过 |
| Fear&Greed | alternative.me | | |

**实现位置**：
- 多市场 K线：`projects/data/app/kline_store.py`（`_fetch_akshare_us/futures`、`_fetch_tencent_daily`（A股/港股，腾讯源）+ 新浪回退，2s symbol 间节流 + 3 次退避重试）
- 因子：`projects/data/app/collectors/external_factors.py`（CBOE CSV / akshare bond_zh_us_rate / stale 快照回退）
- 指数：`projects/data/app/collectors/market_data.py`（`_SINA_INDEX_MAP`）

**已内置的防挂起机制**（`app/kline_store.py` 模块级）：
- 给 `requests.Session.request` 注入默认 12s 超时（akshare 内部请求大多不传 timeout，无响应会无限挂起）
- `socket.setdefaulttimeout(10)` 兜底非 requests 连接

**已知限制**：新浪对连续快速请求有 IP 风控（约 10+ 次后返回空，静默 30s 恢复）。A股/港股已切腾讯源（独立域名，不受新浪风控影响），仅美股/指数仍走新浪；受风控时该批 symbol 快速失败并留待下一采集周期（300s），不阻塞整个周期。东财 `stock_zh_a_hist`/`stock_hk_hist`（push2his 端点）对本机 IP 连接被重置，已弃用。

---

### 6. 验证清单

```bash
# ① 服务状态
systemctl is-active infrax-data infrax-knowledge-injector infrax-ragservicer
# → active active active（ml-service 独立服务器：infrax-ml-service）

# ② 健康检查
curl -s http://127.0.0.1:9112/health            # {"code":0,"data":{"service":"infrax-data",...}}
curl -s http://127.0.0.1:9113/health            # lightrag_enabled:true 表示注入器已连上 ragservicer
curl -s http://127.0.0.1:9721/api/v1/health     # {"code":0,"instances":0,...}
curl -s http://127.0.0.1:9120/health            # ml-service（独立服务器）

# ③ 数据已采集
curl -s http://127.0.0.1:9112/stats             # kline_rows / symbols / snapshot_rows
curl -s "http://127.0.0.1:9112/bars?symbol=AAPL&timeframe=1d&limit=3"
curl -s "http://127.0.0.1:9112/bars?symbol=GC=F&timeframe=1d&limit=3"
curl -s http://127.0.0.1:9112/factors/catalog
curl -s "http://127.0.0.1:9112/symbols?timeframe=1d&min_bars=120"   # ml-service 训练标的发现

# ③b ML 推理（ml-service，独立服务器；未配置 ML_SERVICE_URL 时下方快照为空）
curl -s http://127.0.0.1:9120/ml/tree_predictions
curl -s http://127.0.0.1:9120/ml/volatility
curl -s http://127.0.0.1:9112/snapshots?provider=ml               # tree_predictions 快照
curl -s http://127.0.0.1:9112/snapshots?provider=sentiment        # finbert_sentiment 快照

# ④ 注入器 → ragservicer 鉴权
curl -s -X POST http://127.0.0.1:9113/inject/macro -H 'Content-Type: application/json' -d '{"dry_run":true}'
curl -s http://127.0.0.1:9721/api/v1/instances -H "X-API-Key: <ADMIN_API_KEY>"

# ⑤ 管理后台
systemctl is-active infrax-admin                 # active
curl -s http://127.0.0.1:3002/health             # {"status":"ok","service":"infrax-admin",...}
# 登录后聚合数据（cookie 或 X-Admin-Token）
curl -s -c /tmp/cj -X POST http://127.0.0.1:3002/api/v2/admin/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"<ADMIN_PASS>"}'
curl -s -b /tmp/cj http://127.0.0.1:3002/api/v2/data/overview   # 三服务健康 + 统计
curl -s -b /tmp/cj http://127.0.0.1:3002/api/v2/data/llm-keys   # 脱敏 key 状态
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/api/v2/data/overview   # 未登录 → 401

# ⑥ nginx / 公网入口（B 端反馈 P2-7 排查用）
curl -s http://127.0.0.1:9112/health                              # 服务本身
curl -sk -H 'Host: infrax.0xainet.top' https://127.0.0.1/api/data/health   # 本地经 nginx（带域名 Host，预期 200）
curl -sk https://43.163.105.172/api/data/health                   # 公网直连 IP（预期 200，/health 豁免鉴权）
curl -sk -H 'Host: infrax.0xainet.top' https://43.163.105.172/api/data/bars?symbol=BTC/USDT&timeframe=1D   # 无 key 预期 401 {code:401,...}
curl -s https://infrax.0xainet.top/api/data/health                # 公网域名（当前 502：Cloudflare 回源失败，待修）
getent hosts infrax.0xainet.top                                   # DNS 应为 Cloudflare 104.21.21.11
```

预期结果（已实测 2026-08-04）：`/stats` 显示 21 symbols / 5000+ K线行；`/bars` 返回真实 OHLCV + us10y 因子；因子周期日志 `ExternalFactorCollector cycle: 3/4 sources ok`（DXY 受 yfinance 限流，其余 3 项正常）。

---

### 7. 运维

#### 7.1 更新流程

```bash
# 本地改代码 → push
cd /home/ubuntu/infraX-1 && git pull origin master
cd projects/data            && ./.venv/bin/pip install -q -r requirements.txt 2>/dev/null || true
cd ../knowledge-injector    && ./.venv/bin/pip install -q -r requirements.txt 2>/dev/null || true
cd ../ragservicer           && ./.venv/bin/pip install -q -r requirements.txt 2>/dev/null || true
sudo systemctl restart infrax-data infrax-knowledge-injector infrax-ragservicer

# 管理后台（改了 admin 前端/后端时）
cd /home/ubuntu/infraX-1/projects/admin && npm install --no-audit --no-fund && npm run build
sudo systemctl restart infrax-admin
```

#### 7.2 日志

| 服务 | 日志文件 |
|---|---|
| data | `projects/data/service.log` |
| knowledge-injector | `projects/knowledge-injector/service.log` |
| ragservicer | `projects/ragservicer/service.log`（或 `journalctl -u infrax-ragservicer`） |
| ml-service（独立服务器） | `projects/ml-service/service.log`（或 `journalctl -u infrax-ml-service`） |

```bash
tail -f projects/data/service.log                # 采集日志（kline/因子/快照）
sudo journalctl -u infrax-knowledge-injector -f
```

#### 7.3 数据位置

| 数据 | 位置 |
|---|---|
| K线/因子/快照 | `projects/data/data/data.db`（SQLite） |
| 注入日志 | `projects/knowledge-injector/data/injector.db` |
| RAG 图谱 | `projects/ragservicer/data/`（`STORAGE_MODE=local`） |

---

### 8. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `/bars` 返回空 | 采集周期未完成/新浪风控 | 等 300s 下轮周期，或 `journalctl -u infrax-data` 看 `multi-market failed` 明细 |
| 日志 `akshare ... fetch failed xxx: empty` | 新浪/东财 IP 风控或断连 | A股/港股已切腾讯源（不受新浪风控）；美股受风控时静默后自动恢复，减少 `data_config.json` 中标的数可降低触发概率 |
| 服务卡死不输出日志 | 旧代码无 requests 超时 | 确保代码为最新（已内置 12s 超时补丁）并重启 |
| 注入返回 403 | ragservicer `ADMIN_API_KEY`/桥接 key 未配置或与注入器不一致 | 按 4.3 配置后重启两个服务 |
| 注入失败 `LLM/embedding` 错误 | ragservicer 密钥未填 | 填 `LLM_BINDING_API_KEY` / `EMBEDDING_API_KEY` 后重启 |
| 外网 curl 不通 | 云安全组未放行 | 腾讯云控制台 → 安全组 → 添加入站规则（9112/9113/9721） |

---

### 8.5 ML 模型服务（独立 ml-service，:9120）

四个模型（Kronos / FinBERT / LightGBM 三家族）已从主数据栈拆分到**独立 ml-service**，部署在另一台 2C4G 服务器上常开。主栈（data / injector）仅通过 HTTP 拉取结果，不承载推理。

```
                 ┌──────────────────────────────┐
  data :9112 ──▶ │  ml-service :9120            │
  (HTTP /bars    │  ├─ LightGBM   TREE_ML_ENABLED│  方向三分类（主模型）
   + /symbols) ─▶│  ├─ XGBoost    XGB_ENABLED   │  同上（对照，同数据集）
                 │  ├─ RandomForest RF_ENABLED  │  同上（sklearn 基线）
                 │  ├─ FinBERT    FINBERT_ENABLED│  新闻情绪
                 │  └─ Kronos     KRONOS_ENABLED│  波动率预测
  injector :9113 ──▶ GET /ml/volatility          │
  data :9112    ──▶ GET /ml/tree_predictions     │
  data :9112    ──▶ POST /ml/sentiment           │
                 └──────────────────────────────┘
```

| 模型 | 开关 | 用途 | 数据源 |
|---|---|---|---|
| **LightGBM**（P1 主） | `TREE_ML_ENABLED` | 方向三分类 + 机会评分（自训，24h 重训） | 经 data-service `GET /symbols` + `GET /bars` 拉 K 线 |
| **XGBoost**（P1 对照） | `XGB_ENABLED` | 同 LightGBM，作对照（**同一数据集/同一切分**训练，仅对比 val_acc） | 同上 |
| **Random Forest**（P1 基线） | `RF_ENABLED` | 同 LightGBM，sklearn 自带对照基线 | 同上 |
| **FinBERT**（P1a） | `FINBERT_ENABLED` | 新闻文本情绪分类 | 由 data-service `POST /ml/sentiment` 传入文章 |
| **Kronos-mini**（P0） | `KRONOS_ENABLED` | K 线波动率/方向预测 | 经 data-service `/bars`（yfinance 回退） |

**端点**（全部 `{"code":0,"message":"ok","data":...}` 信封，异常 data=None）：
- `GET /ml/tree_predictions` — 主家族（LightGBM）快照（model 含 n_samples/val_accuracy + predictions），另含 `families` 字段：启用对比家族（xgboost / random_forest）各自的 model + predictions；数据可用时附带 `macro_context`（FRED 宏观特征）
- `POST /ml/sentiment` — body `{"articles":[...]}`，返回聚合情绪 stats
- `GET /ml/volatility` — Kronos 对目标资产池的波动率预测（`{generated_at, n_symbols, model, avg_volatility_score, symbols[]}`）
- `GET /ml/bolt` `/ml/moirai` `/ml/timesfm` — P2 时序模型概率预测（`{generated_at, n_symbols, model, avg_prob_up, symbols[]}`）
- `GET /ml/consensus` — 跨模型信号共识（tree + Kronos + FinBERT + P2，`{generated_at, signals, n_symbols, avg_consensus_score, market_risk_flag, n_divergence, symbols[]}`）
- `GET /ml/macro_features` — FRED 宏观特征 + DXY/VIX/US10Y 快照
- `GET /ml/cache/stats` — 端点缓存统计（免鉴权）
- `GET /health` — 健康检查（`/health` `/docs` `/ml/cache/stats` 免鉴权）

**异步 + 预热（2026-08 性能改造）**：重计算端点（tree/volatility/bolt/moirai/timesfm/consensus）结果走 TTL 缓存 `ML_CACHE_TTL_SEC`（默认 1800s）；缓存 miss 时请求立即返回 `data=null`，推理在后台 daemon 线程完成（不阻塞请求线程池）；预热线程周期刷新缓存（`ML_PREWARM_ENABLED=true` 默认开，`ML_PREWARM_DELAY_SEC` 60s / `ML_PREWARM_INTERVAL_SEC` 900s）。生产符号池可用 `P2_TARGET_SYMBOLS` 显式覆盖（默认从 data-service `/symbols` 动态拉取）。

**鉴权**：ml-service 配置 `ML_API_KEY` 后，主栈调用需 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`；未配置则开放。

**数据方向**：ml-service **不直连主栈 SQLite**，全部经 data-service HTTP（`/symbols?timeframe=1d&min_bars=120`、`/bars?limit=5000` 含指标列）。data-service 未配置 `DATA_SERVICE_URL` 时，LightGBM/Kronos fail-silent 返回空。

#### 部署步骤（新 2C4G 服务器）

```bash
# ① 前置依赖
sudo apt-get update && sudo apt-get install -y python3.12-venv

# ② 拉代码 + venv + 依赖
git clone https://github.com/sftgroup/infraX.git /home/ubuntu/infraX-1
cd /home/ubuntu/infraX-1/projects/ml-service
python3 -m venv .venv
./.venv/bin/pip install -q --upgrade pip
./.venv/bin/pip install -q -r requirements.txt            # FastAPI + 轻量依赖
./.venv/bin/pip install -q lightgbm scikit-learn joblib    # LightGBM
./.venv/bin/pip install -q torch --index-url https://download.pytorch.org/whl/cpu
./.venv/bin/pip install -q transformers huggingface-hub einops   # FinBERT + Kronos

# ③ Kronos 源码（PYTHONPATH 指向）
git clone https://github.com/shiyu-coder/Kronos /home/ubuntu/Kronos

# ④ 配置 .env（DATA_SERVICE_URL 指向主栈）
cp .env.example .env
# .env:  DATA_SERVICE_URL=http://43.163.105.172:9112
#        DATA_API_KEY=<与主栈 data 一致的 key>（主栈未配置 key 可留空）
#        TREE_ML_ENABLED=true  FINBERT_ENABLED=true  KRONOS_ENABLED=true
#        ML_API_KEY=<可选，主栈侧需同步>

# ⑤ systemd 单元（开机自启，Restart=always）
sudo cp ml-service.service /etc/systemd/system/
# 注意加 Environment=PYTHONPATH=...:/home/ubuntu/Kronos（与 data-service 配置方式一致）
sudo systemctl daemon-reload
sudo systemctl enable --now infrax-ml-service
```

> 生产已部署（2026-08-05 实测）：服务器 **43.156.25.197**，三家族（LightGBM / XGBoost / RF）+ FinBERT + Kronos 全部启用。LightGBM 5849 样本 val_acc 0.474 / XGBoost 0.477 / RF 0.467（同一数据集/同一切分 1434 验证，33 symbols）；FinBERT 实测分类正确；Kronos BTC/ETH 真实预测（SPY/QQQ 无数据 fail-silent）。

#### 主栈切换（ml-service 就绪后）

- **data `.env`**：设 `ML_SERVICE_URL=http://43.156.25.197:9120`（可选 `ML_API_KEY`）；原 `TREE_ML_ENABLED`/`FINBERT_ENABLED` 本地推理开关不再使用（推理已在 ml-service），未配置 `ML_SERVICE_URL` 时 ML 类 collector 空转 fail-silent
- **injector `.env`**：设 `ML_SERVICE_URL=http://43.156.25.197:9120`（可选 `ML_API_KEY`）；Kronos 推理已从 injector 移除，改 HTTP 联动
- 重启 `infrax-data` / `infrax-knowledge-injector` 后生效

#### 验证清单

```bash
curl -s http://127.0.0.1:9120/health                       # {"code":0,...}
curl -s "http://127.0.0.1:9112/symbols?timeframe=1d&min_bars=120"   # ml-service 发现标的用
curl -s http://127.0.0.1:9120/ml/tree_predictions          # 首次约 5s（含训练），之后复用模型
curl -s -X POST http://127.0.0.1:9120/ml/sentiment \
  -H 'Content-Type: application/json' -d '{"articles":[]}' # FinBERT 未启用时 data=null
curl -s http://127.0.0.1:9120/ml/volatility                # Kronos 预测列表（未启用时 data=null）
```

- LightGBM 自动流程：启动/24h 后训练（kline 日线 ≥300 样本，时序切分验证，2C4G 秒级）→ 每 30min 预测全部 symbol；模型文件 `projects/ml-service/models/`（git 忽略）
- FinBERT 数据前提：主栈需 `NEWSAPI_API_KEY`（管理后台 Data Stack 页可热配）——无新闻快照时 collector 空转不产生数据；输出 `raw_snapshots`（provider=sentiment, data_type=finbert_sentiment）
- Kronos 数据前提：crypto 需采日线（主栈 data `.env` 设 `KL_TIMEFRAMES=1m,1d`）；SPY/QQQ 走 yfinance 回退
- 注入：injector `inject_ml_predictions`（Kronos）、`inject_tree_ml`（LightGBM，拉主栈 tree_predictions 快照）、`inject_consensus`（跨模型共识）、`inject_p2_predictions`（P2 历史，拉主栈 /ml/predictions）均在默认注入列表，ml-service/无数据时 fail-silent

> 内存预算（2C4G + 2G swap）：三模型均懒加载；常驻增量 ~200MB（Torch 库），推理峰值 FinBERT ~1.5G / Kronos ~0.5G，不同时高峰即可。独立服务器常开不影响主栈稳定性。

## 部署流程

```
本地改代码 → git push → 各服务器 git pull → systemctl restart
```

```bash
# 172：区块链栈 + 平台 + MCP + data
cd /home/ubuntu/infraX-1
git pull origin master
# 如有新增依赖
for d in admin collector dc mcp-server mpc vault waas web payments chain-rpc aa-relay session-key; do
  cd /home/ubuntu/infraX-1/projects/$d && npm install 2>/dev/null || true
done
# 重启变更的服务
sudo systemctl restart infrax-admin

# 43.156.78.59：rag/ki
ssh ubuntu@43.156.78.59
cd /home/ubuntu/infraX-1 && git pull origin master
sudo systemctl restart infrax-ragservicer infrax-knowledge-injector

# 43.156.25.197：ml-service（独立）
ssh ubuntu@43.156.25.197
cd /home/ubuntu/infraX-1/projects/ml-service && git pull origin master
sudo systemctl restart ml-service
```

## MQ-16 对外套餐服务（2026-08-11 部署完成，迁移后不变）

> 计费矩阵：**业务服务管"权益激活"、支付引擎管"钱"**——业务服务复制 waas 订阅模式（plans / checkout / payment-check / payment-callback / verify / usage），支付引擎统一记账（ledger balance/transfer + chain/fiat/x402 收款 + period 周期授权）。五任务全部完成并部署（T-1~T-5，验收详见 [docs/infrax_tasklist.md §9.8.9](./docs/infrax_tasklist.md)）。

### 服务矩阵与生产 drop-in

| 服务 | 端口 | 套餐/能力 | 生产 drop-in | 验证（生产 api） |
|---|---|---|---|---|
| DC（数据中心） | 9102 | 三档订阅 + 配额真实扣减（超限 **429**） | `infrax-dc.service.d/dc-payments.conf` | `mq16_verify.sh` 18/18 |
| Market/行情（collector） | 9101 | market_free/pro/enterprise（超限 **503**） | `infrax-collector.service.d/payments.conf` | `mq16_t2_verify.sh` 16/16 |
| Chain RPC | 9130 | rpc_free/pro/enterprise + `rx_` key（超限 **503**） | `infrax-chain-rpc.service.d/payments.conf` | `mq16_t3_verify.sh` 18/18 |
| MPC Agent Wallet | 9104 | 按量计费：签名 **0.0001** / 写链 **0.001** ETH（欠费 **402**） | `infrax-mpc.service.d/payments.conf` | `mq16_t4_verify.sh` 20/20 |
| Payments 引擎 | 9132 | invite/transfer/batch 对外开放 + x402 全量 | `infrax-payments.service.d/`（capability + open-external + webhook-forward） | `mq16_t5_verify.sh` 24/24 |

各业务服务 drop-in 通用配置（`/etc/systemd/system/infrax-<svc>.service.d/*.conf`）：

```ini
[Service]
Environment="PAYMENTS_URL=http://127.0.0.1:9132"     # 引擎地址
Environment="PAYMENTS_API_KEY=<引擎 bridge key>"       # 引擎鉴权（记费用）
Environment="PAYMENTS_WEBHOOK_SECRET=<HMAC 验签密钥>"   # webhook 回调验签
Environment="PAYMENTS_DEFAULT_RAIL=chain"              # 默认收款轨（chain 免 webhook，轮询 payment-check）
Environment="PAYMENTS_CHAIN=oxachain"
Environment="PAYMENTS_PLAN_ID_MAP={...}"               # 套餐 → 引擎 period 套餐映射
```

### 引擎（:9132）对外能力（T-5）

- **x402 收款**：链上转账至**平台钱包 `0x52Ec58173042E8d0C9be0BdA81e95a8CbB5B8e06`**（oxachain），`POST /payments/verify` 验 tx 入账——MPC 充值闭环同路径；`open-external.conf` 启 `X402_ENABLED=true` + `X402_PAY_TO`/`X402_PRICE_WEI=1e15`/`X402_CHAIN=oxachain`
- **外部 key 契约**：data 签发 `px_` key（scope=payment，`POST {DATA_URL}/admin/api-keys`，Bearer ADMIN_API_KEY）；引擎三 header 任一命中即放行（Authorization: Bearer / X-API-Key / X-Service-Key），实时调 `POST {DATA_URL}/api-keys/verify` 校验；scope 映射 `data→dx_` / `mcp→mx_` / `payment→px_` / `vault→vx_` / `mpc→mp_`
- **能力探测**：`GET /payments/capabilities` 返回全部 rail enabled/endpoints/config，未启用能力端点 **503**；现全量：`chain, x402, a2a, batch, period, invite, transfer`
- **Agent 三场景**：invite 自动收费邀请 / transfer 账本内原子划转（reference 幂等）/ batch 批量收款——端到端调用文档见 [projects/payments/CALLER_SETUP.md §6](./projects/payments/CALLER_SETUP.md)

### 部署步骤（任一服务）

```bash
# 1. 代码同步
git pull origin master
# 2. 写 drop-in 配置（路径见上表）
sudo tee /etc/systemd/system/infrax-<svc>.service.d/payments.conf << 'EOF'
[Service]
Environment="PAYMENTS_URL=http://127.0.0.1:9132"
Environment="PAYMENTS_API_KEY=..."
EOF
# 3. 生效
sudo systemctl daemon-reload && sudo systemctl restart infrax-<svc>
# 4. 验证（生产执行）
bash projects/web/scripts/mq16_t5_verify.sh api
```

## 待办事项（ToDo）

### T-1 W-13 生产 fail-closed 密钥初始化（infrax-waas，✅ 已完成 2026-08-19）
**背景**：生产 unit 未设 `NODE_ENV`（服务按 development 运行），未配置 `HD_WALLET_SEED` / `WALLET_ENCRYPTION_KEY`，W-13 生产 fail-closed 尚未生效。

**实施记录（2026-08-19）**：
1. 前置核验：生产 `address_pool` / `custodial_wallets` 均为 0 条（无任何存量托管地址/加密私钥）→ 可安全用全新随机密钥初始化，无存量地址破坏风险
2. 生成随机 `WALLET_ENCRYPTION_KEY`（`openssl rand -hex 32`，64 hex）与全新随机 12 词 `HD_WALLET_SEED`（ethers）
3. 写入 `/etc/systemd/system/infrax-waas.service.d/prod.conf`（**chmod 600 root-only**）：`NODE_ENV=production` + `HD_WALLET_SEED` + `WALLET_ENCRYPTION_KEY`
4. 补充 `/etc/systemd/system/infrax-waas.service.d/cwallet.conf`：`CWALLET_API_KEY`（`openssl rand -hex 32`）——生产原 unit 未配此 key，production 下 fail-closed 会拒绝启动；该 key 为 waas 与 CWallet 对接鉴权 key，**CWallet 侧需同步同一值**
5. `daemon-reload && restart` → `active`，日志 `env:"production"`，:9109 正常
6. **fail-closed 验证通过**：临时停用 `cwallet.conf` 重启 → 服务拒绝启动（auto-restart 循环）→ 恢复后 `active`
7. 密钥备份：三个密钥值仅存于生产 drop-in（root:root 600）与本地线下备份，**未写入 git**。`HD_WALLET_SEED` 丢失=托管地址无法还原，务必离线保存

### T-2 waas nginx 公网代理（infrax-waas，✅ 已完成 2026-08-19，开放完整 API）
**背景**：生产 nginx 当前无 waas 映射，钱包 API 仅内网 `127.0.0.1:9109` 直连。2026-08-19 经用户确认**开放完整 API**。

**实施记录（2026-08-19）**：
1. `sites-enabled/infrax` 在 `/api/v2/data/` 块后新增两个 location（备份 `infrax.bak.<ts>`）：
```
    location = /api/v2/waas/health { proxy_pass http://127.0.0.1:9109/health; ... }
    location /api/v2/waas/ { proxy_pass http://127.0.0.1:9109/api/v2/; ... proxy_read_timeout 300s; }
```
2. 鉴权：沿用 waas 上游强制认证（钱包签名 / admin JWT / 支付密码），未在 nginx 层加锁（与 `/api/v2/data/` 等现有模式一致）
3. `sudo nginx -t`（通过，仅既有 warning）→ `sudo systemctl reload nginx`
4. 公网验证通过：`https://infrax.0xainet.top/api/v2/waas/health` → 200；未认证 `/api/v2/waas/auth/totp/setup` → 401；admin login → token；原主站 `https://infrax.0xainet.top/` → 200 不受影响
5. 回滚：`sudo cp /etc/nginx/sites-enabled/infrax.bak.<ts> /etc/nginx/sites-enabled/infrax && sudo nginx -t && sudo systemctl reload nginx`

**注意**：waas 为资金敏感服务，公网已暴露完整 API（含 `/tx/send`、`/saas/withdraw` 等资金端点）。防护依赖 waas 自身认证，务必确保 `ADMIN_PASS` 强口令、TOTP 启用、`CWALLET_API_KEY` 不泄露。原「建议保持内网」提示作废。

## 修复备忘

### v0.8.0 生产扩容迁移（2026-08-16）
| 项目 | 说明 |
|------|------|
| 单机 → 三台 | 172 主 + 43.156.78.59 新机（postgres 整盘迁移 + rag/ki）+ 43.156.25.197 ML 机 |
| DB 连接串 | 9 服务 `localhost:5432 → 10.3.8.6:5432`（collector/dc/vault/waas/mpc/payments/session-key/admin-legacy/chain-rpc 主 unit+drop-in）+ aa-relay drop-in `override.conf` |
| nginx | `/api/rag/` → `10.3.8.6:9721`；admin/hub-index env 指新机 |
| 172 负载 | loadavg 3.19 → 0.56~0.76；swap 1.3G → 504M；系统盘 90G+ → 31G/59G |
| 新机 | postgres 10 库全、rag:9721 / ki:9113 active、egress ×5 通、loadavg 1.23（启动期回落中） |

> 完整执行记录（含 UID 对齐、WAL 排障、drop-in 覆盖坑、aa-relay 连接串遗漏补记）见 [docs/infrax_tasklist.md §9.19](./docs/infrax_tasklist.md)。

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
| 200G 数据盘 | `/dev/vdb` → `/mnt/pgdata`，PostgreSQL 数据迁移到新盘（现位于 43.156.78.59） |
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
| Web Proxy 缺 Payment（旧 Payment :9106，MQ-15 T-7 已下线） | 前端调 `/api/v2/payment` 不行 | 补全代理 |

### v0.2.3 OxaChain 集成 (2026-07-15)
| 问题 | 根因 | 修复 | Commit |
|------|------|------|--------|
| OxaChain RPC SSL 不可用 | HTTP 无 SSL，钱包拒绝 | HTTPS + Let's Encrypt 证书 | `2858c50` |
| 生产 → Git 漏 20 文件 | server/git 不同步 | 全量补全 + `.gitignore` | `6a72ff0` `2156c57` |
| 无统一接入文档 | 分散在 MCP_REQUIREMENTS + SDK 源码 | `docs/API_ACCESS.md` 三合一 | `7aa3572` |

## 健康检查

### 172（主）
```bash
for port in 3002 3008 3011 3012 3013 3500 9100 9101 9102 9103 9104 9105 9107 9108 9109 9110 9111 9112 9130 9131 9132 9200 9201; do
  curl -s --max-time 2 http://localhost:$port/health 2>/dev/null \
    && echo ":$port OK" || echo ":$port DOWN"
done

# Collector 扫描状态
sudo journalctl -u infrax-collector --no-pager -n 20 | grep scanner

# DB checkpoint（连新机）
psql "postgresql://postgres:postgres@10.3.8.6:5432/pocketx_collector" -c \
  "SELECT chain, collector_name, last_block, status FROM event_checkpoints ORDER BY chain;"
```

### 43.156.78.59（新机）
```bash
ssh ubuntu@43.156.78.59
curl -s http://127.0.0.1:9721/health   # ragservicer
curl -s http://127.0.0.1:9113/health   # knowledge-injector
sudo -u postgres pg_isready             # postgres
df -h /mnt/pgdata                       # 数据盘水位
ss -tlnp | grep -E ':(5432|9721|9113|1884[8-9]|1885[0-2])'
```

### 43.156.25.197（ML 机）
```bash
curl -s http://127.0.0.1:9120/health
```

### 公网（域名验证全 200）
```bash
curl -s https://infrax.0xainet.top/api/rag/api/v1/health
curl -s https://infrax.0xainet.top/api/data/health
curl -s https://infrax.0xainet.top/api/v1/health
curl -s https://infrax.0xainet.top/api/ml/health
```

## 负载参考（2026-08-16 迁移后实测）

| 指标 | 172（主） | 43.156.78.59（新机） |
|---|---|---|
| CPU | idle 90%+（loadavg 15min 0.56~0.76，迁移前 3.19） | loadavg 1.23（1min）/3.48（15min，启动期 autovacuum/索引预热，回落中） |
| 内存 | 2C/3.6G，swap 504M（迁移前 1.3G） | 2.2G/3.6G，swap 158M |
| 系统盘 | 31G/59G（26G 可用） | 60G（剩 25G） |
| 数据盘 | 无（已迁新机） | vdb 196G（已用 92G，collector 持续批量 INSERT） |
| 已知问题 | OKX ChainOS API 404（遗留），BSC 部分端点限流 | 启动期负载高峰，24h 后复核稳定值 |

> 建议 24h 后复核新机 loadavg 稳定值（[docs/infrax_tasklist.md §9.19](./docs/infrax_tasklist.md) 观察项）。

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
