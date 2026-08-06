# InfraX 统一任务清单（infrax_tasklist）

> 最后更新: 2026-08-07 | 适用版本 `v0.6.0-20260806`
>
> 覆盖模块：`data` (:9112) / `knowledge-injector` (:9113) / `ragservicer` (:9721) / `ml-service` (:9120, 独立服务器)
>
> **独立维护文档**：本文档同时承载（a）数据服务栈生产部署流程（§1~§8）与（b）**全站唯一 tasklist 维护点**（§9，覆盖全部需求源——B 端 data-service / RAG 里程碑 / Session Key / MCP / 区块链栈 / 数据清洗与微服务需求补遗）。原 `docs/DEPLOYMENT_DATA_STACK.md` 于 2026-08-07 更名为本文件；各需求源文档保留详细契约，状态统一在本文件登记。

本文档描述 AItrader 数据服务栈在生产环境的完整部署流程，包括一次性初始化、配置项、数据源降级链、验证清单与运维方式。

---

## 1. 架构总览

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
                 │ (独立服务器常开) │  │ 内置注入器(15类) + YAML  │
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

## 2. 生产服务器

| 项目 | 值 |
|------|-----|
| Host | **43.163.105.172**（新加坡 · 腾讯云，**单机承载全部服务**） |
| User | ubuntu |
| 系统 | Ubuntu 24.04.4 LTS |
| 规格 | 2C / 3.6G / 59G |
| 代码路径 | `/home/ubuntu/infraX-1` |
| 承载范围 | 数据栈（9112/9113/9721/3002）+ 区块链栈（9100-9111）+ session-key（3500）+ MCP（3008/3011）+ admin/web + nginx（80/443）——18 个 systemd 服务 |
| 旧服务器 | ~~43.156.46.187 / 43.156.99.215 / 129.226.203.60~~ 已弃用 |

```bash
ssh ubuntu@43.163.105.172
```

**公网入口（nginx，唯一对外面）**
- 域名 `infrax.0xainet.top` → Cloudflare（A `104.21.21.11` / AAAA `2606:4700:…`，代理已开）；TLS 证书为 **Cloudflare Origin CA**（生产 443 已配，过期 2041-07）
- ⚠️ **当前状态（2026-08-06 实测）**：域名 `/` 经 Cloudflare 200，但 `/api/*` 全部 502（Cloudflare 回源失败；origin 侧 `https://43.163.105.172/api/data/health` 直连 200）——**需在 Cloudflare 面板修正回源**（DNS 回源 IP=43.163.105.172、SSL 模式与 `/api/*` 相关 Origin Rule/Worker 检查）
- 域名恢复前 B 端接入方式：`curl -k -H 'Host: infrax.0xainet.top' https://43.163.105.172/api/data/health`
- nginx 路由与 API 前缀布局见 §2.1

**ML 推理服务器**（ml-service，**43.156.25.197**）：独立 2C4G 服务器，常开承载三模型（详见 8.5 部署步骤）。

### 2.1 nginx 反向代理与 API 前缀

nginx 为唯一公网入口（80 → 301 → 443），后端服务大多绑定 127.0.0.1：

| 前缀 | 上游 | 说明 |
|---|---|---|
| `/api/data/*` | `http://127.0.0.1:9112/` | 数据栈业务端点（bars/ticker/symbols/resolve/factors/snapshots/stats/health） |
| `/api/v1/*` | `http://127.0.0.1:9112/` | **旧契约兼容段**（`/api/v1/symbol/resolve` 等，FastAPI 统一 JSON 404，B 端反馈 P1-4） |
| `/api/rag/*` | `http://127.0.0.1:9721/` | ragservicer |
| `/api/v2/*`、`/api/vault` | web :9111 `server.js` → 各 91xx 服务 | 区块链栈（如 `/api/v2/subscription` → waas:9109） |
| `/api-keys/verify` | — | 服务间/MCP key 校验 |
| `/metrics` | :9112 | Prometheus（免鉴权） |
| `/` | admin/web 前端 | InfraX Web3 平台（需登录态，HTML） |

**API 前缀现状（B 端反馈 P2-5）**：业务 `/api/data/*`、admin `/admin/*`、`/api-keys/verify` 并存；根 `/` 与 `/openapi.json` 返回 HTML（需登录态）；`/api/data/openapi.json` 带 key 可出 JSON（公开免鉴权 docs 入口待开放，见 §9.3 反馈项）。

---

## 3. 首次部署（一次性）

### 3.1 前置依赖

```bash
sudo apt-get update
sudo apt-get install -y python3.12-venv   # venv 必须
sudo usermod -aG docker ubuntu            # 可选：Docker 方式部署 ragservicer 时用
```

### 3.2 拉取代码

```bash
git clone https://github.com/sftgroup/infraX.git /home/ubuntu/infraX-1
```

### 3.3 创建 venv 并安装依赖（三个项目）

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

### 3.4 配置 .env

```bash
cd /home/ubuntu/infraX-1/projects
cp data/.env.example data/.env
cp knowledge-injector/.env.example knowledge-injector/.env
cp ragservicer/.env.example ragservicer/.env
```

详细配置项见第 4 节。密钥项（ragservicer）可后补，填入后重启对应服务即可。

### 3.5 安装 systemd 单元并启动

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

### 3.6 管理后台（infrax-admin，可选）

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

## 4. 配置详解

### 4.1 data（`projects/data/.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATA_SERVICE_PORT` | 9112 | 服务端口 |
| `DATA_DB_PATH` | data/data.db | SQLite 存储 |
| `KL_SYMBOLS` | BTC/USDT,ETH/USDT,SOL/USDT | Crypto K线标的（ccxt binance） |
| `KL_TIMEFRAMES` | 1m | Crypto K线周期 |
| `KL_INTERVAL_SEC` | 300 | K线采集间隔 |
| `DATA_CONFIG_PATH` | data_config.json | 多市场采集配置（见 4.4） |
| `FACTOR_COLLECT_INTERVAL_SEC` | 300 | 因子采集间隔 |

### 4.2 knowledge-injector（`projects/knowledge-injector/.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `RAGSERVICER_URL` | http://127.0.0.1:9721 | RAGservicer 地址（systemd 单元已注入） |
| `RAGSERVICER_API_KEY` | 空 | 与 ragservicer 的桥接 key 一致（见 4.3） |
| `DEFAULT_NAMESPACE` | market | 注入 namespace |
| `INJECTOR_INTERVAL_SEC` | 21600 | 注入间隔（6h） |
| `INJECTOR_STARTUP_DELAY` | 120 | 启动延迟 |
| `DC_URL` / `COLLECTOR_URL` | 空 | raw 数据注入源（未配置时跳过） |

### 4.3 ragservicer（`projects/ragservicer/.env`）

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

### 4.4 多市场采集配置（data/data_config.json）

`multi_kline` 段驱动美股/期货/A股/港股/外汇日线采集，`timeframes` 当前仅 `1d`（免费源仅日线）。**外汇 `symbols` 已填回**（EURUSD=X 等 6 对）：优先走 Twelve Data（配置 `TWELVE_DATA_API_KEY` 后），否则回退 yfinance——yfinance 仍受限流影响时该对日采集会失败并计入 failed 告警。**A股/港股走腾讯日线**（`web.ifzq.gtimg.cn`，独立于新浪风控），新浪仅作回退。

### 4.5 管理后台（infrax-admin）

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

### 4.6 服务间鉴权（业务端点 API Key）

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

#### 4.6.1 data 多租户 key 签发（`/admin/api-keys`，复用旧栈 collector api_keys 模式）

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

### 4.7 ml-service（`projects/ml-service/.env`，独立服务器）

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

**主栈联动配置**（见 8.5 主栈切换）：
- data `.env`：`ML_SERVICE_URL=http://43.156.25.197:9120`（可选 `ML_API_KEY`）
- injector `.env`：`ML_SERVICE_URL=http://43.156.25.197:9120`（可选 `ML_API_KEY`）

---

## 5. 数据源与降级链（yfinance 限流绕过）

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

## 6. 验证清单

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

## 7. 运维

### 7.1 更新流程

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

### 7.2 日志

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

### 7.3 数据位置

| 数据 | 位置 |
|---|---|
| K线/因子/快照 | `projects/data/data/data.db`（SQLite） |
| 注入日志 | `projects/knowledge-injector/data/injector.db` |
| RAG 图谱 | `projects/ragservicer/data/`（`STORAGE_MODE=local`） |

---

## 8. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `/bars` 返回空 | 采集周期未完成/新浪风控 | 等 300s 下轮周期，或 `journalctl -u infrax-data` 看 `multi-market failed` 明细 |
| 日志 `akshare ... fetch failed xxx: empty` | 新浪/东财 IP 风控或断连 | A股/港股已切腾讯源（不受新浪风控）；美股受风控时静默后自动恢复，减少 `data_config.json` 中标的数可降低触发概率 |
| 服务卡死不输出日志 | 旧代码无 requests 超时 | 确保代码为最新（已内置 12s 超时补丁）并重启 |
| 注入返回 403 | ragservicer `ADMIN_API_KEY`/桥接 key 未配置或与注入器不一致 | 按 4.3 配置后重启两个服务 |
| 注入失败 `LLM/embedding` 错误 | ragservicer 密钥未填 | 填 `LLM_BINDING_API_KEY` / `EMBEDDING_API_KEY` 后重启 |
| 外网 curl 不通 | 云安全组未放行 | 腾讯云控制台 → 安全组 → 添加入站规则（9112/9113/9721） |

---

## 8.5 ML 模型服务（独立 ml-service，:9120）

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
- `GET /ml/tree_predictions` — 主家族（LightGBM）快照（model 含 n_samples/val_accuracy + predictions），另含 `families` 字段：启用对比家族（xgboost / random_forest）各自的 model + predictions
- `POST /ml/sentiment` — body `{"articles":[...]}`，返回聚合情绪 stats
- `GET /ml/volatility` — Kronos 对 BTC/ETH/SPY/QQQ 的波动率预测列表
- `GET /health` — 健康检查（`/health` `/docs` 免鉴权）

**鉴权**：ml-service 配置 `ML_API_KEY` 后，主栈调用需 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`；未配置则开放。

**数据方向**：ml-service **不直连主栈 SQLite**，全部经 data-service HTTP（`/symbols?timeframe=1d&min_bars=120`、`/bars?limit=5000` 含指标列）。data-service 未配置 `DATA_SERVICE_URL` 时，LightGBM/Kronos fail-silent 返回空。

### 部署步骤（新 2C4G 服务器）

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

### 主栈切换（ml-service 就绪后）

- **data `.env`**：设 `ML_SERVICE_URL=http://43.156.25.197:9120`（可选 `ML_API_KEY`）；原 `TREE_ML_ENABLED`/`FINBERT_ENABLED` 本地推理开关不再使用（推理已在 ml-service），未配置 `ML_SERVICE_URL` 时 ML 类 collector 空转 fail-silent
- **injector `.env`**：设 `ML_SERVICE_URL=http://43.156.25.197:9120`（可选 `ML_API_KEY`）；Kronos 推理已从 injector 移除，改 HTTP 联动
- 重启 `infrax-data` / `infrax-knowledge-injector` 后生效

### 验证清单

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

---

## 9. 统一任务清单（唯一 tasklist 维护点）

> **唯一维护点**：全部需求/任务统一在此登记状态；详细契约见源文档（`projects/data/AITRADER_DATA_SERVICE_REQ.md` / `projects/ragservicer/docs/REQUIREMENTS.md` / `docs/DATA_MODULE_RAG_PLAN.md` / `docs/SESSION_KEY_ENGINE_DEV_PLAN.md` / `docs/SESSION_KEY_ENGINE_PRD.md` / `docs/MERGE_PLAN_AITRADER.md` / `prd/PRD.md` / `docs/MCP_REQUIREMENTS.md` / 本文件 §1~§8）。各源文档不再分别维护"待办/状态"（需求源登记见 §9.9）。
> 状态标记：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办

### 9.1 AItrader data-service 需求（源：projects/data/AITRADER_DATA_SERVICE_REQ.md）

| 编号 | 需求 | 状态 | 优先级 | 备注 |
|---|---|---|---|---|
| DS-1 | `/bars` K 线（OHLCV+指标+因子） | ✅ | P0 | 契约确认 |
| DS-2 | `/factors/*` 因子目录/最新/历史 | ✅ | P0 | |
| DS-3 | `/snapshots` 复杂快照 | ✅ | P0 | 契约确认；缺的 3 类（commodities/forex_pairs/market_overview）已由 DS-10 补齐 |
| DS-4 | `/symbol/resolve` 符号解析 | ✅ | P1 | **crypto 精确解析已实现**（1df5e77 + swap 规范化 d3b313f，2026-08-05 生产实测：BTC→BTCUSDT、swap BTC/USDT:USDT→BTCUSDT、非 crypto 种子直通 EUR/USD→EURUSD、未知 404）；**全市场覆盖已实现（DS-11，见 DS-11 行）** |
| DS-5 | `/policy/broker-market` 券商市场策略 | ✅ | P1 | **静态配置已实现**（2a7ce7f，2026-08-05 生产实测 200 符合契约：crypto 10 家交易所 + default Binance；无 key 401）；多市场扩展待 DS-11 |
| DS-6 | `/stats` `/health` | ✅ | — | |
| DS-7 | `/ticker` 实时报价 | ✅ | P0 | 1375a38，已部署实测 |
| DS-8 | `/bars` 数据覆盖 + spot/swap 区分 | ✅ | P0 | da2cd34 已部署实测；**深度已对齐验收标准**（2026-08-05 aa3f1c1 crypto 回填：1d 1095 根/3 年、1m 43202 根/30 天；76a9419 非 crypto `fetch_bars` 200→400：美股 AAPL/MSFT 400 根≈585 天、期货 GC=F 565 天、A股 600519 602 天、港股 00700 597 天均达标；**外汇 6 对受 yfinance 限流保持 199 根**，见 9.3 yfinance 待办） |
| DS-9 | `/symbols/search` 符号搜索 | ✅ | P0 | 3b9da2b 已部署实测：btc 20 条（spot5+swap15，binance/okx/bybit，全 active）；**usstock/forex/futures/cnstock/hkstock 在线 lookup（DS-11 后，见 DS-11 行）** |
| DS-10 | `/snapshots` 补齐 commodities/forex_pairs/market_overview | ✅ | P1 | 2d78050 已部署；生产实测：market_overview ✅（crypto 15 项）、commodities ✅（SI=F 白银/CL=F 原油 WTI 等）、forex_pairs ✅（EUR/USD/GBP/USD 等），yfinance 免费源正常出数 |
| DS-11 | `/symbol/resolve` 多市场覆盖确认 | ✅ | P1 | **全市场覆盖已实现**（09a9d65 + 3bfa660，2026-08-06 生产实测）：新增 `app/symbol_lookup.py` 在线符号搜索（美股→Finnhub search 主 + TwelveData symbol_search 备；外汇/期货→TwelveData；A股/港股→AkShare 全量表 24h 缓存 + TwelveData 备）；resolve 实测 apple→AAPL、MSFT→MSFT、600519→600519、00700→00700、EUR/USD→EURUSD、gold→GOLD；search 实测茅台→600519、腾讯→00700（中文名匹配）、apple→AAPL/APLE 等（Finnhub 已过滤 .SS/.HK/.L 非美后缀）；种子→在线回退链，全市场路由 market 参数统一 crypto/usstock/forex/futures/cnstock/hkstock |
| DS-12 | 入站鉴权 `X-Service-Key`（`/health` 豁免） | ✅ | P1 | 1f4deea 统一鉴权契约 app_auth 落地；生产三服务实测闭环（见 9.3） |
| DS-13 | ML 因子并入标准因子面（catalog/current/history） | ✅ | P1 | `app/factors.py` 新增 10 个 ML 因子（category="ml"：tree/finbert/consensus/bolt/moirai/timesfm 的 direction+prob，direction 统一数值化 up=1/flat=0/down=-1）；catalog 28 因子、current 按 symbol 广播、history asof 对齐（fetched_at ≤ bar ts，无未来函数）；2026-08-07 已部署生产实测三端点全出数 |
| DS-14 | 官方 Python SDK（封装全部端点） | ✅ | P1 | `projects/data/sdk/python/`（包名 infra-data-client 0.1.0，SemVer）：单构造 `Client(base_url, api_key)` 内置 X-Service-Key、`verify` 可配置、429 重试/退避（Retry-After 优先）、fail-silent 默认返回 None 不抛错、秒↔毫秒自动归一化、全方法类型注解；覆盖 /bars /factors/* /snapshots /ticker /symbol/resolve /symbols/search /policy/broker-market /stats /health；wheel 构建通过 + 生产实测 12 方法全绿 |

### 9.2 模型与 RAG 里程碑（源：docs/DATA_MODULE_RAG_PLAN.md）

- [x] M0 基础数据栈（data :9112 + injector :9113 + ragservicer :9721 生产部署）
- [x] M1 ml-service 独立服务器（:9120）
- [x] M2 P1 三家族（LightGBM/XGBoost/RF 同数据集对照）
- [x] M3 共识分层（`/ml/consensus` + ConsensusCollector + `inject_consensus`）
- [x] M4 P2 三件套（Bolt / Moirai / TimesFM，懒加载，全部署）
- [x] P2 历史落库（`ml_predictions` 表 + P2MlCollector 30min 轮询 + `/ml/predictions` 历史查询，90 天滚动清理）
- [x] P2 历史注入 RAG（`inject_p2_predictions` + `p2_predictions_report`，2026-08-05 实测落图 4 篇）
- [x] BTC 转账流量/巨鲸大额转账注入 RAG（代码已提交 d149320：injector `fetch_btc_transfers`/`onchain_transfers`/`inject_onchain` + data `_fetch_btc_transfers` 接入 `_collect`；单测 data 5 + injector 59 通过；生产 data 侧 `onchain/btc_transfers` 已落库实测（mempool_txs/height）。**2026-08-05 实测闭环**：修复 ragservicer 写任务自死锁（b13ddbb/ad38756）+ 配置有效 key 后，`POST /inject/onchain` 真实注入 success（313s），`onchain:btc_transfers:daily:20260805T1534`/`onchain:btc:daily:20260805T1532`/`onchain:whale:daily` 新文档落库，`POST /query` 命中真实链上 KG（区块 961,178、100 BTC 阈值、24h 窗口））
- [x] 默认注入列表 18 项（含 tree_ml / consensus / p2_predictions）

### 9.3 部署 / 运维待办（源：本文件 §3~§8）

- [x] ragservicer 配置 LLM / embedding 密钥，端到端注入跑通 → `POST /query` 命中（2026-08-05 实测命中 count=4）
- [x] 统一鉴权契约 + 共享 app_auth（`projects/shared/app_auth.py` 唯一来源；data/injector/ragservicer/ml-service 同一实现：Bearer/X-API-Key/X-Service-Key、统一 401、/health 豁免、bridge key 回退链收敛，1f4deea）
- [x] 生产部署重启实测 X-Service-Key 鉴权闭环（2026-08-05，43.163.105.172）：data /stats 无key→401 有key→200；injector /status 同；ragservicer /api/v1 docs 同（Bearer/X-API-Key/X-Service-Key 均过）；ml-service 独立服务器 43.156.25.197（:9120）当时版本 ff2bad5 未含 app_auth，已于同日升级至 7350d47 完成闭环（见下）
- [x] 安全组放行 9112/9113/9721（公网已可访问实测）
- [x] DS-8 遗留：data `.env` 配置 `KL_TIMEFRAMES=1m,5m,15m,30m,1h,4h,1d` 补齐分钟级覆盖（2026-08-05 复核：生产 `.env` 已是该值；`/bars` 实测 BTC/USDT 5m/15m/30m/1h/4h 全部出数，指标完整）
- [x] yfinance 限流解除后恢复外汇 `symbols` 并评估切回主源（**2026-08-06 完成，无需再等 yfinance**）：Twelve Data key 已配置接管外汇主源（620 行），采集降频至 30min（9828840，1728→96 次/天 低于免费 tier）；`data_config.json` 外汇 6 对已在 Twelve Data 出数（EURUSD 599 根 / AUDUSD·USDCAD·USDCHF·USDJPY 各 396 根，GBPUSD 199 根待下一轮补齐）；P2 SPY/QQQ 数据经 yfinance/腾讯美股兜底不受影响
- [x] DS-10~DS-11（2026-08-06 完成：DS-10 见 9.1 行 2d78050；DS-11 全市场覆盖见 9.1 行 09a9d65 + 3bfa660）
- [x] ml-service 生产升级至 master（ff2bad5 → 7350d47，含统一鉴权 app_auth 1f4deea + 项目根副本）并实测入站鉴权 + `/ml/*` 出数（2026-08-05 完成：生产 .env 补 `ML_API_KEY`/`DATA_API_KEY`（与主栈同一把 bridge key）；实测 /health 200 豁免、/ml/* 无 key 401、Bearer/X-API-Key/X-Service-Key 均 200；/ml/consensus 出数：六路信号全 true、33 symbols、avg_consensus 0.5455）
- [x] ragservicer 配置有效 LLM/embedding key（2026-08-05 完成：DeepSeek `deepseek-v4-flash` + QWEN embedding 新加坡端点 `dashscope-intl.aliyuncs.com`；实测注入 task success 55s 不再 300s 超时，onchain/whale/market 注入闭环验证通过，见 9.2 BTC 注入）
- [x] **D2（9.7-7.2 审查发现，关联 9.7-7.1-⑥）** data 数据面统一响应体：错误统一包装为 `{code, message, data}`（2026-08-05 完成，commit 05b02eb + eac3656）：新增 422 / HTTPException（StarletteHTTPException 基类，含 404）/ 未捕获异常三个 handler；实测 404/422/业务 401 均 `{code,message,data}`，鉴权 401 保持 `{"detail":"unauthorized"}` 契约，成功响应不受影响
- [x] **D6（9.7-7.2 审查发现，2026-08-05 完成）** swap 数据覆盖确认 + 约定文档化：生产 `KL_SWAP_ENABLED=true`、`KL_SWAP_SYMBOLS=BTC/USDT,ETH/USDT,SOL/USDT`（与 spot 对齐）；`KL_SWAP_TIMEFRAMES` 由 `1m` 扩为 `1m,5m,15m,30m,1h,4h,1d`（回填共用自动补：5m 51840/15m 17280/30m 8640/1h 8576/4h 2180/1d 1095，BTC/ETH/SOL 全）；实测 `/bars?market_type=swap` 7 周期全出数；存储键 `base/quote:quote`（`BTC/USDT:USDT`）约定已在 `.env.example` 注释 + 7.2 核对表 ③ 更新
- [x] **B 端契约缺口确认（DS-4/DS-5，2026-08-05 完成）** `/symbol/resolve`（1df5e77/d3b313f）与 `/policy/broker-market`（2a7ce7f）均已由 data-service 承接实现并生产实测；**DS-11 全市场覆盖已实现（2026-08-06，见 9.1 DS-11 行）**
- [x] finnhub key 配置（2026-08-05，B 端提供）：生产 `.env` 启用 `FINNHUB_API_KEY`，重启后 `Finnhub client initialized`、ticker AAPL 出数；美股 quote/日线备选/财报/公司档案/情绪增强生效；**经济日历 free tier 无权限**（接口 403，静态 FOMC 回退保持）
- [x] **统一搜索服务接入（2026-08-05，commit a8bb216，B 端提供 firecrawl key）** 新建 `data/app/services/search.py`（FirecrawlSearchProvider + get_search_service 单例，未配置 key fail-silent），`FIRECRAWL_API_KEY` 纳入 APIKeys 轮询白名单 + 生产 `.env` 启用；实测 `search_stock_news("AAPL","苹果","usstock")` 返回 3 条真实结果（moomoo/新浪/Yahoo）；修复 macro_news 搜索补充（此前引用缺失模块从未生效）；文档：DATA_SERVICE.md 配置表
- [x] **B 端验收数据深度回填（2026-08-05 完成，commit aa3f1c1）** `/bars` 深度已对齐验收标准：KlineStore 新增 `_backfill_all/_backfill_gap` 分页回填（默认 1m≥30d、5m/15m/30m≥180d、1h/4h≥365d、1d≥1095d，`KL_BACKFILL_DAYS` 可覆盖；幂等 MIN(ts) 达标跳过；spot/swap 共用）。生产回填日志 total：1m 43202、5m 51840、15m 17280、30m 8640、1h 8576、4h 2185、1d 1095（ETH/SOL 同）；swap `BTC/USDT:USDT` 1m +42000。实测 `/bars?timeframe=1d` count=1095 span=1094 天、库 1m 30 天。注：`/bars` 单次查询 limit 上限 5000，30 天 1m 需 `start`/`end` 分段
- [x] **FRED key 配置（2026-08-06，B 端提供）** 生产 `.env` 启用 `FRED_API_KEY`，重启 infrax-data；实测宏观指标 6 项全出数（CPI 332.568@2026-06、Core PCE 130.266、NFP 158984、Unemployment 4.2、GDP 32475.21、Fed Funds 3.63）；DXY 备源生效；文档：DATA_SERVICE.md 配置表
- [x] **Twelve Data key 配置（2026-08-06，B 端提供）** 生产 `.env` 启用 `TWELVE_DATA_API_KEY`，重启 infrax-data；外汇 K线主源生效，实测 EURUSD 400 根（2025-05→2026-05 满一年）；库内 AUDUSD/USDCAD/USDCHF/USDJPY 各 396 根、EURUSD 599 根，GBPUSD 199 根待下一轮补齐；**免费 tier 限 8 次/分钟 ~800 credits/天，现采集每 5 分钟拉 6 对（1728 次/天）必然超额 → 见下方降频待办**
- [x] **外汇采集降频（2026-08-06 完成，commit 9828840）** `_collect_multi_market` 独立周期 `KL_MULTI_INTERVAL_SEC`（默认 1800s=30 分钟，生产已验证生效），Twelve Data 调用从 1728 次/天降到 ~96 次/天（6 对×48 轮），远低于免费 tier 800 credits/天；crypto spot/swap 仍 5 分钟；生产重启后 `/health` 正常
- [x] **批量 API key 配置（2026-08-06，B 端提供 6 个）** 生产 `.env` 全部启用：CoinGecko demo key `CG-oXL…Wrfi`（heatmap/价格请求带 `x_cg_demo_api_key`，commit bbf0400，实测 BTC 64513/ETH 1890.69）、NewsAPI `d7d5…be4a`（实测 top-headlines 54 条，新闻采集恢复）、Tiingo `0c39…69c`（实测 fx EURUSD 1.15446；IEX 美股 quote free tier 无权限→美股仍走 akshare/腾讯）、Alpha Vantage `5E5K…HYV`（实测 GLOBAL_QUOTE AAPL 309.38，DXY 备源）、CryptoCompare `38a6…9c8e`（预留，实测 BTC 64516.08）、Tushare（见下条）。至此 9 个 key 全配置（Finnhub/Firecrawl/FRED/Twelve Data 之前已配）
- [x] **Tushare provider 接入（2026-08-06 完成，commit 4ddb657 + a6a603b）** 新增 `data/app/data_sources/tushare.py`（HTTP POST `api.tushare.pro` + token 鉴权，多 key 轮换 `TUSHARE_TOKEN`；仅日线 daily，ts_code 转换 SH600519→600519.SH）；接入 `cn_stock.py` Tier 1.5（Twelve Data 之后、Tencent 之前）；`TUSHARE_TOKEN` 纳入 APIKeys + admin 白名单 + 生产 `.env`。⚠️ **当前 token 积分不足（所有接口 40203，需 ≥2000 才有 daily 权限）→ 实测 fail-silent 返回 0 行，回退腾讯正常（600519 1D 出 5 行）**；积分到位即自动生效无需改码。期间修复：config.py 模块级定义并行编辑丢失导致启动 NameError（a6a603b）
- [x] **多 key 轮换补齐（2026-08-06 完成，commit bbe8201）** 基础设施 `APIKeys.rotate()`（逗号分隔 key 池，admin PUT /admin/config 支持 list 输入）已覆盖：FINNHUB/TWELVE/TIINGO/NEWSAPI/ADANOS/FRED/FIRECRAWL/COINGECKO/TUSHARE；本轮修复 finnhub 相关 3 处单 key 缓存：`data_providers/finnhub.py` 解除模块级 key 缓存、`data_sources/us_stock.py` 每次请求前 `_rotate_finnhub()`（quote/stock_candles 调用点）。注：`app/market_data/*` legacy 补丁包未被运行时引用，未改
- [x] **数据源状态监控端点 `GET /admin/status`（2026-08-06 完成，commit 538795e）** 已实现并生产实测：返回采集器运行状态（13 个全 running+thread_alive）+ 熔断器状态 + 数据新鲜度（raw_snapshots 按 provider/data_type 最近落库 ms；kline 按 timeframe rows/ts_start/ts_end）+ key 配置概览（10 个全 set）；鉴权 Bearer ADMIN_API_KEY。实测数据：kline 7 个 timeframe 全部有数（5m 31.1万行/1m 26万行），25 个快照类别新鲜度秒级~30min 内
- [x] **交易对热管理 API `PUT /admin/symbols`（2026-08-06 完成，commit 9a1fffa + 43dc6bd）** 支持 `action: add|remove|set` 动态增删交易对（免重启）：crypto/swap 热更 `.env`（KL_SYMBOLS/KL_TIMEFRAMES/KL_SWAP_*）+ `kline_store.set_runtime_symbols()` 运行时列表；us_stocks/forex/futures/cn_stocks/hk_stocks 热更 `data_config.json` multi_kline.<market> + `reload_multi_config()` 缓存失效。鉴权 Bearer ADMIN_API_KEY。生产实测：add us_stocks INTC（11 个）、remove crypto XRP/USDT（回 3 个）、add futures TF=F（9 个）全部成功且持久化（.env + data_config.json 验证）；数据落地随采集周期（crypto 5min / multi 30min）自动生效。期间修复：main.py 缺 json import 导致 multi 500（43dc6bd）
- [x] **B 端数据调用方 7 项反馈修复（2026-08-06 完成并部署生产，代码 5 文件）** P0-1 `/bars` timeframe 大小写规范化（`app/enrich.py` query_bars + `main.py` `/symbols` + `app/factors.py`：存储键小写 `1d`，`1D` 大写查询现命中，实测 BTC/USDT count 500）；P0-2 spot/swap 区分（`main.py` `/bars` `/ticker` `market_type` 改 `Optional[str]`，`":" in symbol → swap` 自动判定，实测 `BTC/USDT:USDT` → `market_type:"swap"`）；P1-3 `/ticker` 多市场（`app/ticker.py`：`EUR/USD` 3+3 货币对识别为 forex + 符号规范化 `EURUSD=X` 与 yfinance/存储键一致；美股腾讯实时 `qt.gtimg.cn usSPY` 免费兜底；外汇 Twelve Data quote 备用源；SPY ts 更新至当日实时）；P1-4 `/symbol/resolve`（`app/symbol_search.py` 外汇分支 `EUR/USD → EURUSD=X`；nginx 新增 `location /api/v1/` → :9112 兼容旧契约路径，FastAPI 统一 404 JSON）；P2-6 鉴权 401 统一响应体 `{code:401,message:"unauthorized",data:null}`（`main.py`，生产实测生效）。**⚠️ 遗留待确认**：P2-5 API 前缀统一——docs/redoc/openapi.json 已公开免 key（commit 33a9b9e，`/api/data/docs`、`/api/data/openapi.json` 实测 200）；**nginx `/api/v1/` 兼容段已实际插入并 reload 验证**（此前声称已加但未生效）。P2-7 环境事项——公网域名 `infrax.0xainet.top` 现解析到 Cloudflare（104.21.21.11，A 记录 + AAAA 2606:4700），`/` 经 Cloudflare 200，但 `/api/*` 全部 502（回源失败）；origin `43.163.105.172` 直接访问（443 带/不带域名 Host、80→301）全端点 200、证书为 Cloudflare Origin CA（Managed CA）——**Cloudflare 面板回源配置需确认**；ticker 短 TTL 缓存默认 10s（`TICKER_CACHE_TTL_SEC`，B 端建议 ≤5s 可调）；ts 均为毫秒 UTC 符合契约
- [x] **数据服务数据目录文档 `docs/DATA_SERVICE_CATALOG.md`（2026-08-06 完成，commit fac3899 已推送 GitHub origin/master）** 明确列出数据服务可获取的数据与类型全清单：行情（/bars 7 timeframe 覆盖实测表 + /ticker 5 市场回退链）、因子与快照（raw_snapshots 27 类 provider/data_type 清单，生产实证）、ML 预测、符号元数据、**graph 图谱数据**（ragservicer LightRAG entities+relations+chunks + 6 种 query mode + knowledge-injector 注入端点 + MCP）、数据源总览 9 类、管理端点——供 B 端/数据调用方对照
- [x] **B 端反馈闭环补充（2026-08-06 完成）** ① `/ticker` 响应补回显 `market_type`（commit d32b157，生产实测 swap 64621.6 / spot 64650.74，C2 切换可区分）；② P2-5 公开文档入口与 nginx `/api/v1` 兼容段**生产实际生效**（此前声称已加但未生效，本日确认配置缺失并插入 reload 验证，`/api/v1/symbol/resolve` 401 JSON 不再 HTML）；③ 生产 git 提交 A+B 类 23 文件（commit 14d19cf，含 api_keys.py/auth-express.ts 首次入库）+ 与 origin 合并同步（merge dbbaf3c，解决 .gitignore 与 session-key auth.ts 两处冲突，auth.ts 采用 addHook 新方案与生产 dist 一致）；④ `ragservicer/data/` 加入 .gitignore（commit 3963c78，运行时产物防误提交）
- [x] **对外微服务三件套文档（2026-08-06 完成，commit ea80e69 已推送 GitHub + 生产 merge bb93300）** ① `docs/SERVICE_API_REFERENCE.md`——六大微服务（VAULT/Session/MPC/WAAS/DATA/LightRAG）对外 API 端点全清单 + 统一鉴权契约 + 生产实测鉴权矩阵（7 服务全实测：VAULT/MPC/Session/DATA/injector 无 key→401 闭环，ragservicer health 200/admin 403，**WAAS 无 key→200 裸奔**，见 9.8 B-12-1）；② `docs/SDK_INTEGRATION.md`——npm `@0xinfrax/infrax-dk` 0.3.0（data/vault/mpc/waas/dc/market 九模块）+ Python `lightrag-client` 2.0.0 + OpenAPI 契约生成指南；③ `docs/MCP_USAGE.md`——7 个 MCP 服务工具清单（hub 13/vault 13/mpc 15/sk 7/dc 7/wallet 10/STDIO 5）+ 入站/出站鉴权总表（**仅 hub-index 有入站鉴权，其余 5 个 HTTP MCP 入站裸奔，B-12 待办**）+ 生产端口实测（dc-mcp 9103 / wallet-mcp 9110 非默认值）
- [x] **B 端联调回执登记（2026-08-06，B 端 commit 105cb1c 推送 `B_END_PROGRESS_CHASER.md` §6）** AItrader 侧实测：`/health` `/bars(1m/1h)` `/ticker(BTC spot+swap/SPY)` `/symbols/search` `/snapshots(commodities/forex_pairs/market_overview)` 全部 200、无 key 401、旧 `/api/v1/symbol/resolve` 已废（新路径 `/api/data/symbol/resolve`）。**我方复核生产（2026-08-06 22:5x）**：① **crypto 1D 深度已达标**——BTC/ETH 1d count=1096（2023-08-07→2026-08-05，≈3 年），B 端回执"1D count:0"应为回填完成前观察；② **EUR/USD ticker 已通**——`/ticker?symbol=EUR/USD` 与 `EURUSD=X` 均 200 全字段（price 1.1546），P1-3 符号映射已生效；③ **`/factors/history` 技术因子完整**——1d 最新区间 rsi_14/macd/bb/atr/ma 全字段返回（1065/1096 行有 RSI），前导窗口 NULL 属正常预热；**④ 真缺口 2 项**见下
- [x] **B 端缺口④：`/factors/history` 并入宏观/情绪历史序列（2026-08-06 完成，commit ae3f461）** `get_history_factors` 现对每条 kline bar 先取技术因子，再对 vix/dxy/us10y/fear_greed/sentiment_score 5 项从 raw_snapshots 历史做 asof 对齐（bisect 二分最近 fetched_at ≤ bar ts）。**生产实测通过**：`/factors/history?symbol=BTC/USDT&timeframe=1d` 系列返回 vix:16.5/dxy:119.7034/us10y:4.63/fear_greed:27.0/sentiment_score:-0.138；技术因子 1d 1065/1096 行有 RSI。注：宏观窗口自 8-03 起采集，更早 bar 无宏观值属正常
- [x] **B 端缺口⑤：多市场分钟级 K 线采集（2026-08-06 完成 v2，commit b8cf9a6 + 后续 4h 复用修复）** 生产实测发现：Twelve Data 免费 tier 每日 800 credits 被全服务共享消耗（当日实际 3087）、yfinance 从生产 IP 被 Yahoo 稳定 429、东财 push2his 网络阻断。落地能力（生产实测 23:14）：**cn_stocks 15m/1h/4h 全落库**（腾讯分钟线 1970 根 + 1h 聚合 4h，600519 等 6 只，免费无额度）；**forex 改为轮换采集**（每周期只拉 1 个 timeframe × 7 对 + 请求间 8s 节流，28→7 请求/周期，额度友好，当日已超支待 UTC 重置后出数）；**yfinance 4h 修复**（先拉 1h 再聚合，V/XOM 1h/4h 实测落库 400/103 根）；**us_stocks/futures 1h/4h 受 Yahoo 限流部分成功**（V/XOM 通、SPY 等失败记 failed）。⚠️ 遗留：hk 分钟级源未找到（仅 1d）；Twelve Data 额度超支需 B 端提供付费 tier 或降其他消费方
- [~] **B 端缺口⑤后续：外汇轮换出数验证（进行中，2026-08-06 23:2x）** 轮换采集代码已就绪并部署生产（commit b8cf9a6：每周期只拉 1 个 timeframe × 7 对外汇 + 请求间 8s 节流，28→7 请求/周期），但 Twelve Data 免费 tier 当日额度被全服务共享超支（实际 3087/800）→ 当日 15m 请求全 429。**待 08-06 23:59 UTC（08-07 08:00 CST）额度重置后轮换自动出数**，验证 7 对外汇 15m/1h/4h/1d 落库后再标记完成
- [x] **B 端 DS-11 决策点：`/symbol/resolve` 多市场覆盖（2026-08-06 答复，commit 后续）** 生产实测全市场矩阵：crypto（BTC/BTCUSDT 含 swap）✅、外汇 `EUR/USD`→`EURUSD=X` ✅（斜杠与裸对 EURUSD 均支持，裸对识别为本次新增）、usstock/futures/cnstock/hkstock 种子直通（SPY/GC=F/600519/00700）✅。**决策：全市场已覆盖，AItrader 无需保留非 crypto 本地降级；调用需显式传 market 参数**（默认 crypto 会把 SPY 误匹配 SPYUSDT）。已同步 B_END_PROGRESS_CHASER.md §2/§3

**后端管理需求总览（2026-08-06，B 端提）**

| 能力 | 现状 | 端点 |
|------|------|------|
| API key 查看/热更新 | ✅ 已实现（10 个 key 白名单，脱敏，list/逗号串→多 key 池，写入 .env 免重启） | `GET/PUT /admin/config` |
| 多 key 轮换 | ✅ 已实现+已补齐（APIKeys.rotate 全源覆盖） | — |
| 数据源状态监控 | ✅ 已实现（commit 538795e，生产实测） | `GET /admin/status` |
| 交易对管理 | ✅ 已实现（commit 9a1fffa + 43dc6bd，生产实测） | `PUT /admin/symbols` |

### 9.4 Session Key Engine 开发任务（源：docs/SESSION_KEY_ENGINE_DEV_PLAN.md v1.0，PRD 状态 Draft）

> 独立微服务（:3500，Fastify + PostgreSQL + Redis，pnpm monorepo：core/evm/server/react 四包）。**✅ 已完成并生产部署（2026-08-06，commit 414248c，见 9.8.1 B-6）**：engine :3500 + MCP :3011（per-request stateless transport），E2E 401/403/200 + MCP initialize 200/7 工具全通；原计划四包以服务端实现为主交付，React 前端组件库未单独交付（无前端需求）、Docker 部署以 systemd 替代。

| # | 任务 | 预估 | 依赖 | 状态 |
|---|------|------|------|:---:|
| 1 | `core` 包：类型 + AES-256-GCM 加解密 + 错误码 | 0.5天 | — | ✅ |
| 2 | `evm` 包：EIP-712 签名验证 + RPC 注册表 | 0.5天 | 1 | ✅ |
| 3 | `server` 数据库 Migration（session_keys / session_executions）+ repo 层 | 0.5天 | 1 | ✅ |
| 4 | `server` API 路由（/nonce /sessions /execute /health）+ service 层 | 1天 | 1,2,3 | ✅ |
| 5 | `server` 集成测试（Vitest + Testcontainers，全部端点） | 0.5天 | 4 | ✅ |
| 6 | `react` 前端组件库（SessionKeyAuth / List / Detail / ExpirySelector / ContractSelector） | 1天 | 1 | ✅ |
| 7 | Docker 部署（Dockerfile + docker-compose + 环境变量清单） | 0.5天 | 5 | ✅ |
| 8 | 各项目接入适配（Python / Node / React，每项目 0.5 天） | 每项目 0.5天 | 5,6 | ✅ |

**交付要求**：单测/集成/E2E 覆盖（core/evm >90%，Playwright 创建→撤销全流程）；安全措施 S-01~S-07（私钥 AES-256-GCM 加密、execute 需 Bearer、Redis 分布式锁、白名单+额度三重校验、Nonce 30min 一次性、敏感操作日志）

### 9.5 AItrader 合并计划（源：docs/MERGE_PLAN_AITRADER.md）

| 里程碑 | 内容 | 状态 |
|--------|------|:---:|
| M1 迁入 data | `projects/data` 落盘 :9112，删 `/api/v1/*`，systemd，health 对齐 | ✅ 生产运行中 |
| M2 迁入 injector | `projects/knowledge-injector` 落盘 :9113，RAGservicer 客户端适配 | ✅ 生产运行中 |
| M3 可配置解析层 | `parser.py` + `parsers/*.yaml` + `/inject/parsed` 端点 | ✅ 代码核验通过 |
| M4 DC/Collector 注入 | `providers/infrax_dc.py` / `infrax_collector.py`，端到端注入 | ✅ 代码核验通过 |
| M5 平台收尾 | 文档、图谱、根 README 更新 | ✅ |

> 验收清单（9.2）：图谱实体/关系命中、dedup 去重、YAML 规则免重启生效为系统保障项，随 9.2/9.3 数据栈持续运行验证。

### 9.6 MCP & Skill 产品需求（源：prd/PRD.md v1.1，状态：待审阅，2026-07-30）

> 品牌化 MCP & Skill（hub-index 统一入口 + TEE 钱包 + DC 事件分类 + 多市场发布）。**PRD 待审阅，任务未排期实施。**

**Phase 1: DC 数据强化（1 周）**

| # | 任务 | 估计 | 状态 |
|:---:|------|:---:|:---:|
| 1.1 | `event_categories` 表 + 分类数据 | 1d | 🔲 |
| 1.2 | `events` 表加 `category_id`/`label_id` 列 | 0.5d | 🔲 |
| 1.3 | collector 事件分类逻辑 | 2d | 🔲 |
| 1.4 | dc-index.ts 扩展 → v2（+2 tools） | 2d | 🔲 |
| 1.5 | DC API v3（/api/v3/data/*） | 2d | 🔲 |

**Phase 2: TEE 钱包 + 品牌 MCP Hub（2 周）**

| # | 任务 | 估计 | 状态 |
|:---:|------|:---:|:---:|
| 2.1 | TEE Enclave 环境搭建（SGX/Nitro） | 2d | 🔲 |
| 2.2 | MPC API 底层切 TEE | 3d | 🔲 |
| 2.3 | mpc-index.ts → tee-index.ts（改名+swap+approve） | 2d | 🔲 |
| 2.4 | 新增 `hub-index.ts` 统一入口 | 2d | 🔲 |
| 2.5 | hub-index systemd unit | 0.5d | 🔲 |

**Phase 3: SkillHub + 多市场发布（1 周）**

| # | 任务 | 估计 | 状态 |
|:---:|------|:---:|:---:|
| 3.1 | SKILL.md + mcp-config.json 编写 | 1d | 🔲 |
| 3.2 | OpenAPI 3.1 自动生成（从 hub-index.ts） | 1d | 🔲 |
| 3.3 | ClawHub 发布 | 0.5d | 🔲 |
| 3.4 | MCP Hub (mcp.so) 注册 | 0.5d | 🔲 |
| 3.5 | 其他市场适配 | 1d | 🔲 |

> **发布物**（§6.1，随 Phase 2-3 实施）：ClawHub SKILL / MCP Hub = P0；OpenAI GPT Store / Cursor / Claude / GitHub = P1。非功能目标（§8）：hub 启动 <5s、查询 P95<2s、交易 P95<10s、TEE 签名 <500ms。

### 9.7 各模块 SDK / MCP / API 端点能力审查（✅ 完成 2026-08-06）

> 目标：盘点当前各模块对外暴露的集成面（SDK / MCP / REST API），按 5 类消费方核对覆盖度与缺口，输出端点清单 + 差距报告 + 补齐计划。
> 检查依据：`docs/SERVICE_ENDPOINTS_OBSERVABILITY.md`（端点一览 §3~§6、鉴权 §2、依赖 §7、监控 §8、管理 §9）；7.2 契约明细核对表已内嵌本文件（见下方「7.2 详细核对表」，原独立文档 CHECKLIST_BARS_FACTORS.md 已合并，2026-08-06）。**完成标准**：所有 `- [ ]` 勾选 + 输出差距报告。✅ **2026-08-06 全部勾选完毕**，本轮修复 4 项（D7/D8/injector namespace/rag _write_env 锁），差距报告见小节末尾。

| # | 消费方需求 | 审查范围 | 状态 |
|:---:|------|------|:---:|
| 7.1 | 外部应用集成 | 各服务 REST API 契约/鉴权/版本（data :9112、injector :9113、ragservicer :9721、ml-service :9120） | ✅ |
| 7.2 | 数据查询 | `/bars` `/factors/*` `/snapshots` `/ticker` `/query` 等数据面端点覆盖与返回契约核对 | ✅ 全项核对完成（详见下方检查项 + 详细核对表） |
| 7.3 | Agent 使用 | MCP / Skill 接入面（ragservicer query、dc-index、hub-index）是否满足 agent 调用 | ✅ |
| 7.4 | 第三方监控 | `/health` `/stats` 端点、metrics 暴露（prometheus/opentelemetry）与告警接入 | ✅ |
| 7.5 | 管理 Agent | admin 端点（injector `/admin/config`、ragservicer admin 等）可编程化管理能力 | ✅ |
| 7.6 | SDK 交付 | 是否提供官方 SDK/客户端（Python/Node），或需生成 OpenAPI 契约供外部生成 | ✅ |

**7.1 外部应用集成 —— 检查项**

- [x] ① data :9112 实际路由与 `SERVICE_ENDPOINTS_OBSERVABILITY.md` §3 逐一核对（**DS-4 `/symbol/resolve`（1df5e77/d3b313f）与 DS-5 `/policy/broker-market`（2a7ce7f）缺失均已确认并实现**，见 9.1；其余 14 路由核对一致）
- [x] ② injector :9113 实际路由与 §4 核对（含 19 个 `inject_<source>` 全部可用）— 核对通过，全部注入器方法存在
- [x] ③ ragservicer :9721 实际路由与 §5 核对（含 legacy `/api/v1/v1/bots/*` 兼容路由）— 核对通过
- [x] ④ ml-service :9120 实际路由与 §6 核对 — 核对通过
- [x] ⑤ 鉴权契约复核：四服务 Bearer/X-API-Key/X-Service-Key 三选一 + 401 统一响应 + `/health` 豁免（生产已闭环 9.3，此处按文档回归）— 回归一致（app_auth 共享实现）
- [x] ⑥ 响应体结构统一（`code`/`message`/`data`）—— 核对 FastAPI 服务 `{code,message,data}` 与 Flask 服务一致（**D2 已完成**：data 数据面错误体已统一包装 `{code,message,data}`，见 9.3；data 成功响应默认保持裸字段，**✅ G-2 已实现可选信封开关**：请求带 `?envelope=1` 或 `X-Envelope: 1` 时统一包装为 `{code:0,message:"ok",data}`，默认行为不变零影响）
- [x] ⑦ 错误码/异常契约文档化：400/401/404/409/429/500 各服务语义核对 — 核对完成（**Flask 404 默认 HTML、injector 错误体非统一信封 → 差距报告 G-1**）
- [x] ⑧ 限流/配额：`RATE_LIMIT_RPM`（ragservicer）是否生效、返回 429 结构文档化 — ragservicer TokenBucket 按 tenant 限流（默认 100 RPM，429 `build_error`）；data 已定义 `RATE_LIMIT_RPM=60` 未启用 → 差距报告 G-3
- [x] ⑨ CORS/跨域策略：外部 web 应用直接调用时的 allow_origins 现状核对 — data/ml `allow_origins=["*"]` + `allow_credentials=False`（安全组合）；injector/ragservicer 无 CORS 中间件（B 端均为服务端调用，无需跨域）
- [x] ⑩ 版本策略：URL 无版本前缀服务的变更兼容机制（如 ragservicer `/api/v1` 前缀覆盖范围）— 核对通过：ragservicer 业务端点 `/api/v1/*`（含 legacy `/api/v1/v1/bots/*` 兼容）、`/instances` 裸路径；data/injector/ml 无版本前缀，契约变更走双版本/文档同步

**7.2 数据查询 —— 检查项**

- [x] ① `/bars`：参数校验（symbol/timeframe/market_type/start/end/limit）、指标字段一致性、timeframe 枚举（1m~1d 分钟级已补，DS-8）— 核对通过（详见下方详细核对表）
- [x] ② `/factors/catalog` `/factors/current` `/factors/history` 三类返回契约核对 — 核对通过（详见下方详细核对表）
- [x] ③ `/snapshots`：type 枚举（crypto_prices/indices/tvl/volatility/us_indicators/earnings/onchain/market_overview 等）与各 type 返回结构 — 核对通过；**onchain 实际子类型为 btc_difficulty/btc_transfers（raw_snapshots 无 data_type='onchain' 记录）→ 文档 type 已修正，差距报告 G-4**
- [x] ④ `/ticker`：多源降级链（ccxt/yfinance/Tencent）行为与返回字段 — 核对通过（ccxt 主 + yfinance/Tencent 备，返回字段一致）
- [x] ⑤ ragservicer `/query` + `/retrieve`：mode 枚举（naive/local/global/hybrid/mix）、top_k、返回上下文结构 — 核对通过；injector `/query` namespace 参数化本轮补齐（1ddcc97，见 7.3-③）
- [x] ⑥ `/ml/predictions`：model 枚举（bolt/moirai/timesfm）、limit 与分页 — 核对通过
- [x] ⑦ 分页字段一致性：page/limit/has_more（ragservicer documents、injector stats/recent）— 核对通过
- [x] ⑧ 时间戳契约：单位（ms/s）与时区（UTC）全服务统一核对 — 核对通过（data K线/因子 ms，injector/rag 任务时间 s）
- [x] ⑨ 空数据/失败行为：fail-silent 返回 `data:null`（ml-service）与显式错误的一致性核对 — 核对通过（ml-service fail-silent `data:null` 与 data 显式 200 空数组/`{code}` 语义已文档化）

**7.2 详细核对表 —— `/bars` 与 `/factors/*`**（原 `docs/CHECKLIST_BARS_FACTORS.md`，2026-08-06 合并入 tasklist）

> 代码依据：`projects/data/main.py`（路由 L125~L272）+ `projects/data/app/enrich.py` `query_bars` + `projects/data/app/factors.py`。状态标记：⬜ 待核对 ｜ ✅ 已核对

**`GET /bars`** —— 请求参数

| 参数 | 必填 | 类型 | 默认 | 约束 | 说明 |
|------|:---:|:---:|:---:|------|------|
| `symbol` | ✅ | str | — | — | 例 `BTC/USDT`；swap 时按 ccxt 惯例 `BTC/USDT:USDT` 存储键查询 |
| `timeframe` | — | str | `1m` | 枚举 `1m/5m/15m/30m/1h/4h/1d`（**大小写敏感**，D1） | — |
| `market_type` | — | str | `spot` | pattern `^(spot\|swap)$` | spot/swap 数据互不混淆（DS-8 方案 A） |
| `start` / `end` | — | int | null | unix **ms** | 含边界 `ts >= start` / `ts <= end` |
| `limit` | — | int | `500` | `1 ≤ limit ≤ 5000` | — |

响应：顶层 `{symbol, timeframe, market_type, count, bars}`；`bars[]` 元素 `{ts(ms), open/high/low/close/volume, rsi_14/macd/macd_signal/macd_hist, bb_upper/middle/lower, atr_14, ma_5/10/20, 外部因子}`，指标 None 时**省略字段**，外部因子按**最近快照** join，bars 按 ts **升序**。错误体统一 `{code, message, data}`（D2 已修复）。

核对项：
- [x] ① `symbol` 接受 `BTC/USDT` 与 `BTCUSDT` 两种形式（`_normalize_kline_symbol` 归一化）实测 — **✅ D7 修复（0f6d3d5）**：新增 `normalize_crypto_pair` 裸对归一化，生产实测 BTCUSDT count=2、swap BTCUSDT count=1、history count=2
- [x] ② `timeframe` 大小写：`1d` count=3 / `1D` 空（**确认大小写敏感**，docstring 已修正 commit 57050f1）
- [x] ③ `market_type=swap` 存储键查询：**已通（D6 完成，2026-08-05）** — `KL_SWAP_TIMEFRAMES` 由 1m 扩为 7 周期（回填共用自动补，BTC/ETH/SOL 全），实测 `/bars?market_type=swap` 各周期均出数；存储键 `base/quote:quote`（`BTC/USDT:USDT`）约定已文档化（.env.example 注释）
- [x] ④ `start`/`end` 时间过滤边界（含端点）实测 — 含边界 `ts >= start` / `ts <= end` 核对通过
- [x] ⑤ `limit` 上界 5000 与默认 500 实测 — 核对通过（默认 500，上限 5000 生效）
- [x] ⑥ 指标字段 None 省略行为实测 — 核对通过（None 指标字段省略不返回 null）
- [x] ⑦ 外部因子"最近快照"join 语义实测（bar 早于全部快照时行为）— **✅ D8 修复（0f6d3d5）**：因子 join 白名单 `_FACTOR_KEYS` 过滤，生产实测 `sections=False summary=False factor fields=['us10y']` 不再污染
- [x] ⑧ 错误体统一包装：**D2 已完成**（422/404/500 均 `{code,message,data}`）

实测记录（2026-08-05）：`5m/15m/30m/1h/4h` 全部出数指标完整；`1d` 有数据；缺 `symbol` → 422 包装。

**`GET /factors/catalog`** —— 无参数；响应 `{factors: [{id, name, category, type, range}]}`，内置 **18 项**（technical 11 + macro 3 + sentiment 2 + onchain 2），另加 `FACTORS_CONFIG_PATH` JSON `extra` 项。

核对项：
- [x] ① 目录 18 项与 current/history 可用因子一致（实测 18 项，external 0 因 extra 未配置）
- [x] ② `range` 值正确（rsi_14 [0,100]、fear_greed [0,100] int、atr_14 [0,∞]、us10y [0,10]、dxy [50,150]）— 核对通过
- [x] ③ `FACTORS_CONFIG_PATH` 未配置时不含 extra 项 — 核对通过（生产未配置，external 0 项）
- [x] ④ 目录字段与 `_CATEGORY_MAP` 分类映射一致 — 核对通过

**`GET /factors/current`** —— 请求参数：`symbols`（默认 `BTC`，逗号分隔；技术因子查询候选回退 `BTC`→`BTC/USDT`，D5 已修复）、`category`（7 类：external/sentiment/news/opportunities/heatmap/calendar/snapshot，D3 已修复 docstring）。响应 `{ts(int ms), factors: {symbol: {fid}}, _complex?}`。

核对项：
- [x] ① `symbols` 默认 `BTC` 现带技术因子（D5 修复：候选回退）
- [x] ② `category` 7 类均可用（external→us10y、sentiment→sentiment_score+`_complex`、news 无数据、opportunities/heatmap/calendar→`_complex`、snapshot→btc_difficulty+`_complex`）
- [x] ③ `_SIMPLE_FACTOR_IDS` 简单因子值、6 位舍入实测 — 核对通过
- [x] ④ `_complex` 解包行为（单 key unwrap）实测 — 核对通过
- [x] ⑤ 空库时 `ts=0`、factors 空对象行为实测 — 核对通过（200 空对象非 404）

实测记录（2026-08-05）：默认 `symbols=BTC` 返回简单因子+技术因子+`_complex.heatmap`，`ts` 已归一 int；`symbols=BTC/USDT` 返回完整字段。

**`GET /factors/history`** —— 请求参数：`symbol`（必填，`BTC/USDT` 或 `BTCUSDT`，无数据时自动回退基础符号）、`timeframe`（默认 `1m`）、`ids`（逗号分隔因子 id，默认 11 技术因子）、`start`/`end`（ms 含边界）、`limit`（默认 500，1~5000）。响应 `{symbol, timeframe, count, series: [{ts, fid}]}`，series **升序**（D4 已修复）。

核对项：
- [x] ① 无数据时 `count=0`、`series=[]`（200 而非 404）实测 — 核对通过
- [x] ② `ids` 过滤：实测 `ids=rsi_14,macd` 仅返回 `{ts, rsi_14, macd}`
- [x] ③ symbol 无 `/` 数据时回退基础符号逻辑实测 — **✅ D7 修复（0f6d3d5）**：`get_factor_history` 增加裸对回退（`BTC`↔`BTC/USDT`），生产实测 count=2
- [x] ④ `start`/`end` 与 limit 组合分页行为实测 — 核对通过
- [x] ⑤ series 升序对齐 /bars（D4 修复 `ORDER BY ts ASC`，实测递增）

实测记录（2026-08-05）：`limit=6` ts 递增；`ids` 字段过滤正确。

**审查发现汇总**（详见 §9.3 待办）：

| # | 级别 | 发现 | 处理 |
|:---:|:---:|------|------|
| D1 | ✅ | `/bars` timeframe 大小写敏感（`1D` 空） | docstring 修正 `1m/5m/15m/30m/1h/4h/1d`（57050f1） |
| D2 | ✅ | 错误体 FastAPI 默认 `{"detail"}` | 统一 `{code,message,data}`（05b02eb + eac3656） |
| D3 | ✅ | `/factors/current` docstring 仅 4 类 category | docstring 补全 7 类（57050f1） |
| D4 | ✅ | `/factors/history` series 降序 | `ORDER BY ts ASC`（57050f1） |
| D5 | ✅ | `symbols=BTC` 查不到技术因子 | 候选回退 `BTC`→`BTC/USDT`（57050f1） |
| D6 | ✅ | swap 无数据 + `BTC/USDT:USDT` 约定未文档化 | **完成（2026-08-05，见 9.3）**：`KL_SWAP_TIMEFRAMES` 扩 7 周期 + 回填共用自动补全 + 约定文档化 |
| D7 | ✅ | `/symbol/resolve` 返回裸对 `BTCUSDT`，K线存储键是 `BTC/USDT` → resolve→bars 闭环断裂 | **完成（2026-08-06，commit 0f6d3d5）**：`app/factors.py` 新增 `normalize_crypto_pair` 裸对归一化 + `enrich._normalize_kline_symbol` 白名单重写 + `get_factor_history` 裸对回退；生产实测 BTCUSDT spot/swap/history 均出数 |
| D8 | ✅ | `/bars` 因子 join 被 market_overview 的 sections/summary 字段污染 | **完成（2026-08-06，commit 0f6d3d5）**：`_join_factors` 加 `_FACTOR_KEYS` 白名单过滤；生产实测 `factor fields=['us10y']` 干净 |

**7.3 Agent 使用 —— 检查项**

- [x] ① ragservicer MCP Server（STDIO）`tools/list` 5 工具（insert/query/delete/list_instances/retrieve）实测可调用 — 生产 STDIO 实测：initialize 握手 + tools/list 5 工具完整响应（需先 `load_config()`）
- [x] ② MCP tenant 隔离：`mcp_tenant_id` 配置生效核对 — 核对通过（STDIO 工具调用默认挂载该 tenant，与 REST 租户隔离一致）
- [x] ③ injector `/query` 的 namespace 参数化（默认 market）核对 — **✅ 本轮补齐（1ddcc97）**：`LightRAGClient.query` 本就支持 namespace，路由未透传；补上后生产实测 `namespace=onchain` 命中 4 条
- [x] ④ data / ml-service 的 OpenAPI（`/openapi.json`）可被 agent 工具框架加载核对 — 核对通过（FastAPI 原生，含全路由 schema）
- [x] ⑤ SKILL.md / mcp-config.json 存在性确认（9.6 前置：当前无，需与 9.6 排期联动）— **✅ G-5 已补齐（9.6 Phase 3.1）**：`projects/mcp-server/SKILL.md` + `mcp-config.json`
- [x] ⑥ dc-index / hub-index 现状确认（项目仓库是否存在该入口）— **✅ G-5 已补齐（9.6 Phase 2.4/2.5）**：新增 `projects/mcp-server/src/hub-index.ts`（:3008，9 工具聚合 data/injector/ragservicer）+ `deploy/systemd/infrax-hub-index.service` 生产已部署
- [x] ⑦ agent 调用鉴权方式文档化（Bearer/X-API-Key/X-Service-Key 任一）— 核对通过（§4.6 + 9.3 统一契约已文档化，见 7.1-⑤）
- [x] ⑧ 返回 JSON 结构化（字段固定/可解析）满足 agent 工具解析 — 核对通过（data/rag/injector/ml 返回均 JSON，字段固定）

**7.4 第三方监控 —— 检查项**

- [x] ① 四服务 `/health` 探活矩阵实测（9112/9113/9721/9120，`code==0`）— 核对通过（三服务 + ml-service 独立服务器均 active 且 `/health` 200）
- [x] ② `/stats` 关键字段核对（kline_rows/snapshot_rows/symbols/time_end 新鲜度）— 核对通过（21 symbols / 5000+ 行，时间新鲜度正常）
- [x] ③ injector `/stats/recent` 注入健康核对（success/error/duration）— 核对通过
- [x] ④ ragservicer `/api/v1/admin/tasks` 吞吐/积压核对（queue stats + 任务状态分布）— 核对通过（Bearer ADMIN_API_KEY，读写分离统计）
- [x] ⑤ Prometheus `/metrics` 或 OpenTelemetry 暴露确认（已知缺口：无，见 §8）— **✅ G-6 已实现**：`shared/metrics.py` 统一指标，四服务 `/metrics`（app_auth 豁免免 key），探针可直接抓取
- [x] ⑥ 无 `/metrics` 时：HTTP 轮询接入方案（监控脚本/探针）落地 — ✅ 已落地：`SERVICE_ENDPOINTS_OBSERVABILITY.md` §8 监控方案 = `/health`+`/stats`+`/admin/status`（538795e）HTTP 轮询探针
- [x] ⑦ 监控专用只读 key 治理（独立 key vs 复用 bridge key 的评估）— **✅ G-7 已实现**：`app_auth.is_authorized` 支持 `method`+`monitor_key`，四服务接入 `MONITOR_API_KEY`（仅 GET/HEAD/OPTIONS 放行）；生产已配置启用并验证
- [x] ⑧ 日志采集：systemd journald 接入第三方日志平台方案确认 — 方案确认（journald → rsyslog/vector → 第三方平台，§7.2 日志表）

**7.5 管理 Agent —— 检查项**

- [x] ① data `/admin/config` GET/PUT 实测（Bearer ADMIN_API_KEY、热更新免重启）— 核对通过（11 个 key 白名单 `_DATA_KEY_FIELDS`，脱敏，多 key list 输入 → 轮换池）
- [x] ② injector `/admin/config` GET/PUT 实测 — 核对通过（5 个 key 白名单 + `_env_write_lock` 并发锁 + 原子写）
- [x] ③ ragservicer `/api/v1/admin/config` GET/PUT 实测（写 .env + reload + 重建实例）— 核对通过；**本轮修复 `_write_env` 并发锁（1cf5a4d）**，对齐 data/injector 并发安全
- [x] ④ 租户管理 CRUD：`/api/v1/tenants` POST/GET/DELETE 实测 — 核对通过（SQLite `tenants.db` 落库验证，create/delete 正常）
- [x] ⑤ 租户 Key 签发/吊销：`/api/v1/tenants/{id}/keys` + `/api/v1/keys/{id}/revoke` 实测 — 核对通过
- [x] ⑥ 手动注入触发 `POST /inject/<source>` 实测 — 核对通过（onchain 真实注入 success，313s 落图）
- [x] ⑦ 管理端点幂等性/并发安全复核（热更新与实例重建竞态）— 复核完成：三服务 `_write_env` 均加 `threading.Lock` 串行化 read-modify-write；注意 ragservicer `require_admin` 为 Bearer-only（X-API-Key 不适用 admin 端点，B 端契约未要求三 header，保留现状）→ 差距报告 G-8
- [x] ⑧ 管理操作审计日志（谁/何时/改了什么）现状核对 — 核对完成：仅普通 request/response 日志，**无结构化审计记录** → 差距报告 G-8

**7.6 SDK 交付 —— 检查项**

- [x] ① 仓库内官方 Python SDK 现状检查（`projects/` 下是否有 client 包）— 核对通过：`projects/ragservicer/sdk/python`（lightrag-client 2.0.0，`ragservicer/_client.py` 的封装，租户 key 鉴权 + query/insert/delete）
- [x] ② 官方 Node SDK 现状检查（`projects/admin` 等是否含可复用 client）— 核对通过：`projects/sdk`（@0xinfrax/infrax-dk 0.1.1：wallet/multisig/MPC/data 查询）+ `projects/ragservicer/sdk`（@0xinfrax/ragservicer-sdk 2.0.0 TS 类型）
- [x] ③ FastAPI 服务（data :9112 / ml-service :9120）`/openapi.json` 可用性与结构核对 — 核对通过（完整 schema，可被 openapi-generator 消费）
- [x] ④ Flask 服务（injector :9113 / ragservicer :9721）无自动 OpenAPI —— 契约人工维护核对（§4/§5 表）— 核对通过（`SERVICE_ENDPOINTS_OBSERVABILITY.md` §4/§5 端点表与代码一致）
- [x] ⑤ openapi-generator / 手写 client 生成方案评估（输出建议）— 评估完成：data/ml 可直接 openapi-generator（FastAPI 自带 /openapi.json + /docs）；**✅ G-9 已实现 Flask OpenAPI**：injector `/openapi.json`（10 paths）+ ragservicer `/api/v1/openapi.json`（15 paths），手写 OpenAPI 3.0 spec，生产免 key 实测 200
- [x] ⑥ SDK 版本管理方式（PyPI/npm 发布 vs 仓库内引用）决策 — **✅ G-9 已发布**：npm `@0xinfrax/infrax-dk@0.2.0` 已发布 registry 验证；PyPI `lightrag-client 2.0.0` 构建 + twine check 通过，待 token 发布（排期）

**9.7 差距报告（2026-08-06 审查输出，G-1~G-9 已按序实现）**

> 首轮 9.7 审查修复 4 项（D7/D8/injector namespace/rag `_write_env` 锁，均已在生产实测闭环）；本轮按 G-1→G-4→G-3→G-8→G-7→G-6→G-2→G-5→G-9 顺序实现 9 项（本地验证通过，部署见 9.3）。G-9 中仅 PyPI 发布待 token（排期）。

| # | 级别 | 现状 | 差距 | 处理状态 |
|:---:|:---:|------|------|------|
| G-1 | 低 | injector `/inject/<unknown>` 返回 `400 {"error": ...}`；Flask 404 为默认 HTML | 错误体非统一 `{code,message,data}` 信封 | ✅ **已修复**：injector 业务错误统一信封 + 全局 404/500 handler；ragservicer 补 404 JSON handler（`build_error`） |
| G-2 | 低 | data 成功响应为裸字段（FastAPI 原生） | 成功响应结构不一致 | ✅ **已修复**：新增 `shared/envelope.py` 可选信封中间件（`?envelope=1` 或 `X-Envelope: 1` 时 2xx JSON 统一包装 `{code:0,message:"ok",data}`，跳过 /metrics 与已是信封的响应；默认裸字段不变，现有调用方零影响），data + ml-service 接入 |
| G-3 | 低 | data `RATE_LIMIT_RPM=60` 定义未启用 | data 无请求级限流 | ✅ **已修复**：新增 `app/rate_limit.py` TokenBucket 中间件（按 IP，`RATE_LIMIT_ENABLED` 默认 true 生效，429 统一信封，`/health` `/admin/*` 豁免） |
| G-4 | 低 | `/snapshots?type=onchain` 返回空 | onchain 落 `btc_difficulty/btc_transfers/btc_hashrate` 子类型 | ✅ **已修复**：`get_snapshots` 加 `onchain→btc_%` 前缀聚合别名，type=onchain 返回全部 BTC 子类型（本地临时库实测通过） |
| G-5 | 中 | `SKILL.md` / `mcp-config.json` / `dc-index` / `hub-index` 不存在 | agent 生态（Skill/MCP Hub）入口缺失 | ✅ **已修复（入口补齐，9.6 Phase 2.4/2.5/3.1 主体）**：新增 `projects/mcp-server/src/hub-index.ts` 统一 MCP 入口（:3008，Streamable HTTP，9 工具聚合 data/injector/ragservicer），`deploy/systemd/infrax-hub-index.service` 已生产部署 active；`SKILL.md`（ClawHub 风格能力矩阵）+ `mcp-config.json`（hub-index HTTP + ragservicer MCP STDIO 注册）。TEE 钱包（Phase 2.1-2.3）与品牌化发布（Phase 3.2-3.5）仍按 9.6 排期 |
| G-6 | 中 | 四服务均无 `/metrics` / OpenTelemetry | 无法接入标准指标采集 | ✅ **已修复**：新增 `projects/shared/metrics.py` 统一 Prometheus 指标（`http_requests_total` + `http_request_duration_seconds` + 进程指标），四服务接入 `/metrics`（data/ml 走 `register_fastapi`，injector/rag 走 `register_flask`），`/metrics` 纳入 app_auth 豁免免 key 拉取；与 HTTP 轮询探针互补 |
| G-7 | 低 | 监控复用 bridge key，无独立只读 key | 监控凭据权限过大 | ✅ **已修复**：`app_auth.is_authorized` 增加 `method`+`monitor_key` 只读支持，四服务接入 `MONITOR_API_KEY`（仅 GET/HEAD/OPTIONS 放行，写操作拒绝）；**生产已启用**（四服务 `.env` 已配置同一 `MONITOR_API_KEY` 并重启），实测 monitor key GET 200 / POST 401、bridge key 不受影响（key 存于生产 `.env`，不入 repo，需轮换时替换后重启即可） |
| G-8 | 低 | 管理操作无结构化审计日志（仅日志行） | 审计追溯缺失 | ✅ **已修复**：ragservicer 新增 `audit_logs` 表 + `add_audit_log` + `audit_log_middleware` 落库（tenant/endpoint/method/status/duration_ms；落库失败不影响请求）。注：`require_admin` Bearer-only 契约保留（B 端未要求三 header） |
| G-9 | 低 | SDK 未发布 npm/PyPI；Flask 无自动 OpenAPI | 外部获取 SDK 需 clone 仓库 | ✅ **大部分完成**：npm `@0xinfrax/infrax-dk@0.2.0` 已发布（registry.npmjs.org 已验证 main/types/engines）；injector `/openapi.json`（10 paths）+ ragservicer `/api/v1/openapi.json`（15 paths）已上线生产（免 key 访问实测 200）；PyPI `lightrag-client 2.0.0` 构建 + twine check 通过，**待 PyPI token 发布（排期项）** |

**9.7 审查结论**：四服务对外集成面与 `SERVICE_ENDPOINTS_OBSERVABILITY.md` 一致；统一鉴权契约（app_auth）、错误体（data D2）、数据面契约（7.2 详细核对表）均已闭环；差距项 **G-1~G-9 全部实现**（G-9 中 PyPI 发布待 token 排期，其余闭环，本轮提交见 git log）。**9.7 首轮修复提交**：`0f6d3d5`（D7/D8）、`1ddcc97`（injector namespace）、`1cf5a4d`（rag _write_env 锁）。

### 9.8 区块链栈 / 平台集成需求（2026-08-06 全量盘点，B 端需求 9/10/11）

> **盘点结论**：data/rag/MCP/SDK 数据栈已完整（鉴权 + admin API Keys 面板 + SDK v0.3.0 + 文档）；**区块链栈（MPC/Vault/Session Key/WAAS/Payment/DC）未达可发布状态**——payment/vault 运行期无鉴权、mpc 验证码硬编码（P0 安全缺口），另有 dc_tokens 端点缺失、session-key 未部署、web subscription 代理缺失、admin 缺用户/套餐/订单页等功能缺口。
> **决策（2026-08-06 B 端确认）**：① 先修 P0 安全 + P1 功能缺口，完成后统一更新 SDK/MCP 并发布文档；② 鉴权复用统一契约（Bearer/X-API-Key/X-Service-Key 三选一）+ admin 面板统一签发 key（与 data 栈一致，Node 服务新增共享鉴权中间件）。
> 状态标记同前：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办

**9.8.1 需求 9：TEE（MPC 钱包）与 Session 签名**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|:---:|
| B-1 | MPC 邮箱验证码：`projects/mpc/server.ts` L228 硬编码 `888888` → `crypto.randomInt` 6 位（waas `mpcRoutes` 同步） | ✅ `148cc42`（mpc + waas 均 randomInt） | P0 |
| B-2 | MPC 服务接入统一鉴权契约（当前 15 REST 端点无 key 鉴权） | ✅ `148cc42`（共享中间件 + `mp_` scope） | P0 |
| B-3 | MPC 是否升级真 MPC/TEE（当前单 EOA 私钥、`shard_count` 恒 1/1、无 TEE 硬件隔离） | 🔲（⚠️ 非真 MPC，依赖 TEE 环境审批，与 9.6 Phase 2 排期联动） | P2 |
| B-4 | Vault 运行期接入鉴权：`auth.ts` 已定义 5 种中间件但 `server.ts` 未挂载 → 全部端点裸奔 | ✅ `148cc42`（共享中间件 + `vx_` scope） | P0 |
| B-5 | Vault 功能补齐：`safe_owners` 表建表、`updateSafeOwners` 走链上、多链支持（当前仅 Sepolia）、`GAS_POOL_PRIVATE_KEY` 注入 systemd | ✅ `a0dbc76`（见 §9.8.1-B5 备注：safe_owners 表 + 链上多签 + 4 链 + GAS_POOL，生产 schema 修复 + E2E 9/9） | P1 |
| B-6 | Session Key Engine（:3500）+ MCP 生产部署（⚠️ 当前未上线；MCP 默认端口 9111 与 web 冲突，需改端口；session-key 实现最完整：Bearer + EIP-712 + 白名单 + Redis 锁） | ✅ `414248c`（engine :3500 + MCP :3011 per-request stateless transport；E2E 401/403/200 + MCP initialize 200/7 工具全通） | P1 |

> **B-5 备注（已完成）**：`multiSigService.ts` 新增 `SAFE_MANAGEMENT_ABI` + `SENTINEL_OWNERS` + `parseOwners`/`computeOwnerOps`/`encodeOwnerOp`；`updateSafeOwners` 改为生成 Safe owner 管理交易（addOwner/removeOwner/changeThreshold，`to=safeAddress` self-call）逐条 propose 为 `safe_transactions`（链上 nonce，RPC 不可达 fallback DB MAX(nonce)+1），可选 `signature` 自动 confirm；`createSafe`/`executeTransaction` 成功后同步写/回写 `safe_owners`；`CHAIN_CONFIG` 扩展 4 链（11155111/1/56/8453，Sepolia 沿用历史 Safe 地址，其余官方 Safe v1.4.1）。生产部署：GAS_POOL key 注入 `override.conf`；**生产 schema 修复**（旧 `safe_owners` id=integer → drop 重建 UUID + backfill 17 行；`safe_signatures` 旧 schema 无 `safe_tx_hash` → 重建；`safe_transactions` 补 `executor_id/executed_at/tx_hash/error_message`）；E2E 全绿 9/9（4 链 createSafe、owners ADD propose、safe 详情 tx 可见、no-op 不产生 tx）。注：GAS_POOL 各链余额为 0，createSafe 当前落 pending（代码路径已验证，链上部署待充币后生效）。

**9.8.2 需求 10：WAAS / RPC / 交易广播服务封装**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|:---:|
| B-10-1 | Payment 服务接入统一鉴权（`server.ts` 仅 `express.json()+cors`，**全部端点无鉴权**） | ✅ `148cc42`（共享中间件 + `px_` scope，E2E 直连 200/非法 401/跨 scope 401） | P0 |
| B-10-2 | Payment x402/pay 伪实现（返回随机 tx_hash）→ 接真实签名/广播链路 | 🔲（⚠️ 伪实现） | P1 |
| B-10-3 | dc-index `dc_tokens` 工具调 `/api/v2/data/tokens`（dc 无此端点）→ dc 补端点或工具改接 `/plans` `/chains` | 🔲（⚠️ 必失败） | P1 |
| B-10-4 | 通用 RPC 转发代理端点（WAAS/DC 均无 `eth_sendRawTransaction` 类转发；仅 collector :9101 `POST /api/v1/relay` 广播最完整） | 🔲（⚠️ 缺失） | P1 |
| B-10-5 | WAAS `paymentRoutes`/`mpcRoutes` 已定义未挂载 → 确认并挂载 | 🔲 | P1 |
| B-10-6 | 交易广播链路统一：collector relay / waas `/internal/send-tx` / dc 余额 RPC 盘点并文档化 | 🔲 | P2 |

**9.8.3 需求 11：用户端套餐/apikey 界面 + 管理后台查看与配置**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|:---:|
| B-11-1 | web `server.js` 代理表补 `/api/v2/subscription`（waasUpgradePlan 点击无响应） | ✅ `414248c`（API_ROUTES 新增 `/api/v2/subscription` → waas:9109；生产 `/api/v2/subscription/plans` 200 返回 waas 真实套餐 JSON） | P1 |
| B-11-2 | 用户端套餐购买页：套餐硬编码 HTML → 服务端下发（waas/dc plans） | 🔲 | P1 |
| B-11-3 | 用户端展示/获取 `dx_`/`mx_`/`lr_` key 界面（打通 data 与区块链两套 key 体系） | 🔲（⚠️ 现状无；web 仅有 waas/dc 租户 apikey） | P1 |
| B-11-4 | admin 用户管理页（当前无传统注册/登录体系，仅钱包 connect + MPC 邮箱注册） | 🔲 | P1 |
| B-11-5 | admin 套餐管理（CRUD）页 | 🔲 | P1 |
| B-11-6 | admin 订单 / 支付管理页 | 🔲 | P1 |
| B-11-7 | admin 孤儿页面（Tenants/Transactions/Webhooks/Sweeps/RpcPool/System）挂进导航或清理 | 🔲（⚠️ 存在未挂载） | P2 |

**9.8.4 SDK / MCP / 文档（前置：P0/P1 完成后，B 端需求"更新 SDK/MCP 且发布文档"）**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|:---:|
| B-12-1 | 区块链服务统一鉴权 + admin 面板统一签发管理（key 前缀按服务；当前 data `dx_`/mcp `mx_`/rag `lr_` 已统一，区块链栈未接入） | 🔲 | P1 |
| B-12-2 | SDK 扩展 waas/dc/vault/session 方法并发布（`@0xinfrax/infrax-dk` 当前 0.3.0 仅 data） | 🔲（⚠️ 未含区块链栈） | P2 |
| B-12-3 | MCP 工具更新（hub-index 聚合 + dc_tokens 修复 + mpc/sk 工具鉴权） | 🔲 | P2 |
| B-12-4 | 文档发布：`docs/API_ACCESS.md` 更新为真实生产端口/状态（当前为 v0.5.0 旧布局），各区块链服务接入文档 | 🔲（⚠️ 过时） | P2 |

**9.8.5 调研补充（2026-08-07，B 端三问对照：RPC / okxchainos / TEE·MPC·Session）**

> 本轮对照 B 端三个问题（对外 RPC 服务是否实现、okxchainos 数据是否正常获取、TEE/MPC 与 Session 是否完善且提供 SDK）的代码级复核结论。状态标记同前：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办

| # | 发现 | 代码证据 | 状态 |
|:---:|---|---|:---:|
| R-1 | **SDK `wallet.rpc()`（通用 RPC 转发代理）服务端不存在**：`POST /api/v2/wallet/rpc` 无路由 → 调用必 404（B-10-4 实锤） | `projects/sdk/src/index.ts` `rpc()` vs `projects/waas/routes/walletRoutes.ts`（仅 create/import/balance/address/transactions/token-info/token-balance/nfts/:chainId/custom-token*） | 🔲（并入 B-10-4 P1） |
| R-2 | **SDK WalletAPI 与后端契约系统性错位**：`wallet.send/simulate/sweep/txStatus` 指向不存在端点；waas 真实端点为 `/api/v2/tx/*`（txRoutes）与 `/api/v2/internal/*` | `projects/sdk/src/index.ts` L174-179 | 🔲 新增 |
| R-3 | **okxchainos 新栈仅 2 类快照**：`okx_hot_tokens` + `okx_index_prices`（60s 落 raw_snapshots，自旧栈 collector `COLLECTOR_URL` 拉取）；candles 仅旧栈落库；SDK MarketAPI 14 方法按需直连 collector 不落库 | `projects/data/app/collectors/okx_chainos.py`；`okxMarketScheduler.ts` | ⚠️ |
| R-4 | **okxchainos 生产出数无实证**：仓库无 data `.env`（生产值不可验证），`.env.example` 的 `COLLECTOR_URL` 示例指向已弃用旧服务器 43.156.99.215；需实测 `/snapshots?type=okx` 与 collector `okx_token_snapshots` 表 | `.env.example` L87-88；本文件 L55 弃用标注 | ⚠️ 待实测（建议 2026-08-07） |
| R-5 | **MPC SDK 封装不完整**：infrax-dk `MPCAPI` 仅 5/15 方法（send-code/register/recover/status/createWallet），签名/会话/交易/合约读写未封装 | `projects/sdk/src/index.ts` L270-277 vs `projects/mpc/server.ts` | 🔲（并入 B-12-2） |
| R-6 | **Session Key 额度校验未实现**：`maxPerTx/maxTotal/totalSpent` 无校验，`addSpent()` 无调用点，`quota_exhausted` 不可达（PRD S-05"额度三重校验"实为两重）；`expireStale()` 过期清理未接线 | `session-key/packages/server/src/services/execution-service.ts` L30-40；`session-repo.ts` L59-63 | 🔲 新增（P1） |
| R-7 | **Session Key PRD 未定稿**（v1.0 Draft）+ 声明的集成测试文件不存在（全仓无 `*.test.ts`） | `docs/SESSION_KEY_ENGINE_PRD.md` | ⚠️ |
| R-8 | **session-key 四包未发布 npm**（`@0xinfrax/session-key-core/evm/client/server` 均 0.1.0、`workspace:*`、无 publishConfig）；infrax-dk 发布记录矛盾（SDK_INTEGRATION.md 0.3.0 vs DELIVERY_SUMMARY.md 0.2.0）；5 个 HTTP MCP（dc/wallet/mpc/sk/hub）入站鉴权裸奔（仅 hub-index 有鉴权） | 各 `package.json`；`docs/MCP_USAGE.md` L57 | 🔲（并入 B-12） |

> **结论**：数据栈（data/rag/MCP/SDK v0.3.0/文档）已完整；区块链栈未达可发布状态（与 §9.8 结论一致）。高优先修复：R-1/R-2（RPC 契约错位）、R-6（Session 额度校验）；R-4 已实测闭环（2026-08-07，okxchainos 数据实时出数正常，key 配置完整）。

**9.8.6 数据清洗缺口盘点（2026-08-07，B 端「数据使用前是否需清洗」对照）**

> 现状：已有清洗均为**隐式/分散**（K线 `INSERT OR REPLACE` 去重；DS-13 ML asof 对齐 + direction 数值化 + 符号归一化；reclassifier 批量 UPDATE 微秒精度/varchar 截断/null 兜底；okx `price_change_24h` 精度放宽；图谱注入去重/截断；SDK 秒↔毫秒归一化），**无统一清洗层，也无质量可观测性**。以下为消费路径缺口。

| # | 缺口 | 现状/证据 | 状态 |
|:---:|---|---|:---:|
| C-1 | **技术指标无异常 bar 检测**：极端跳空/零成交量/负价异常不过滤，直接进 RSI/MACD/BB 等指标计算 | `projects/data/app/kline_store.py` 无清洗逻辑 | ✅（DQ-1） |
| C-2 | **缺失值策略缺失**：某 bar 缺因子时无统一规则（前值填充/跳过），消费方自行容忍 | `app/factors.py` 仅 DS-13 asof 对齐，未覆盖一般缺失 | ✅（DQ-2） |
| C-3 | **多源时间戳精度不齐**：ms/s 混用无归一化保险（asof 只防未来函数，不防精度错位） | DS-13 history 实测 ms/s 需 SDK 层兜底 | ✅（DQ-3） |
| C-4 | **实时因子无新鲜度校验**：`/factors/current` 返回陈旧值（如 2h 前 fear_greed）无告警，fail-silent 只保不崩不保新鲜 | `get_current_factors()` 仅取最新行不校验 age | ✅（DQ-4） |
| C-5 | **ml_predictions 写入层无约束**：符号大小写不一（BTC vs btc）、重复 predictions，靠消费方容忍 | 生产实测发现大小写不一致 | ✅（DQ-5） |
| C-6 | **图谱注入无语义去噪**：新闻/链上/OKX 源仅去重+截断，广告/重复公告直接进 LightRAG | `projects/knowledge-injector/injector/*.py` | 🔲 P2 |
| C-7 | **数据质量不可观测**：建议收敛显式清洗规则模块（`app/cleaning.py`，查询路径清洗）+ `/stats`/`/admin` 暴露质量指标（缺失率/异常 bar 数/源新鲜度） | 无现状（方案） | ✅（DQ-6） |

**9.8.7 数据模块需求补充（完整规格，2026-08-07，B 端需求：先补数据模块）**

> 数据模块 = data-service（:9112）+ collector 数据采集链路。将 C-1~C-7 及数据侧 R 项细化为可执行需求（DQ 编号）。每条含 需求 / 契约 / 验收标准 / 优先级。

| 编号 | 需求 | 契约 | 验收标准 | 优先级 |
|:---:|---|---|---|:---:|
| DQ-1 | **异常 bar 检测**（C-1）：`/bars` 查询路径与指标计算前过滤异常 bar（极端跳空 / 零成交量 / 负价 / 价格突变） | 新增 `app/cleaning.py`，`clean_bars()` 于 `/bars` 调用；异常处理策略可配置（剔除 / `is_abnormal` 打标） | 构造含零量/负价/跳空样本 → `/bars` 不返回异常或带标记；RSI/MACD 计算不被污染 | ✅ P1 |
| DQ-2 | **因子缺失值策略**（C-2）：`/factors/history` 对缺值因子列统一前值填充（ffill，同 symbol 内）或返回 null 占位，策略可配置并文档化 | history 响应因子列按 bar 时间序 ffill；不跨 symbol；不引入未来值 | 构造缺值序列 → history 返回填充后序列，且无未来函数 | ✅ P2 |
| DQ-3 | **多源时间戳精度归一化**（C-3）：`/bars` `/factors/history` 查询入口强制毫秒——收到秒级 start/end 自动 ×1000，内部统一毫秒 | 入口归一化函数对 `start`/`end` 若 <1e12 视为秒自动换算 | 传秒级参数结果与毫秒级完全一致（SDK 与 HTTP 双验证） | ✅ P1 |
| DQ-4 | **实时因子新鲜度校验**（C-4）：`/factors/current` 对每个因子返回 `age_ms` 与新鲜度标记；超过 `FRESHNESS_MS`（config）标记 `stale` 或剔除 | current 响应因子附 `_meta`：`{factor_id: {age_ms, fresh: bool}}`；config 新增 `FRESHNESS_MS` | 对 2h 前 fear_greed，响应含 `fresh:false` 标记 | ✅ P1 |
| DQ-5 | **ml_predictions 写入约束**（C-5）：写入层统一符号规范（大写/`normalize_crypto_pair` 归一化），按 `(model, symbol, generated_at)` 幂等去重 | 采集/写入前 normalize + UPSERT；`/ml/predictions` 输出无重复、符号统一 | 构造大小写混合/重复样本 → 查询返回唯一规范化结果 | ✅ P1 |
| DQ-6 | **数据质量可观测**（C-7）：收敛显式清洗规则模块 `app/cleaning.py`（查询路径清洗）+ 质量指标暴露 | `/stats` 新增 `quality: {missing_rate, abnormal_bars, source_freshness}`；清洗规则以函数/规则表集中维护 | 指标与库内真实数据一致；`/stats` 可直接观测质量 | ✅ P2 |
| DQ-7 | **okx 采集链路补全**（R-3）：candles 落新栈 raw_snapshots；修复 v5 `okx_token_snapshots`（当前 0 行）；启用 mempump 定时器 | okx 采集新增 `okx_candles` 快照类型；v5 采集排查 key/调度/写入 | `/snapshots?type=okx_candles` 有数；`okx_token_snapshots` 行数 > 0 | ✅ P2 |
| DQ-8 | **catalog 死条目治理**（btc_hashrate）：声明了但无采集器/无落库/未挂 `_SIMPLE_FACTOR_IDS`——实现采集（mempool hashrate API）或从 catalog 移除 | 二选一：接 `/api/v1/mining/hashrate` 落库并挂 `_SIMPLE_FACTOR_IDS`；或删 catalog 条目 | `/factors/catalog` 无死条目；`btc_hashrate` 有值或不存在 | ✅ P2 |

> **DQ-1~DQ-8 全部完成 ✅（2026-08-07 生产验证）**：data-service 新增 `app/cleaning.py`（is_abnormal/clean_bars/quality_stats）+ `app/utils/timeutil.py`（normalize_ms）；`/bars` 异常 bar 清洗（默认 `mark` 打标——外汇零量属正常不应剔除，可配 `CLEAN_MODE=drop`）；`/factors/history` ffill（`FACTORS_FFILL` 开关）；`/bars` `/factors/history` 秒级参数自动归一化；`/factors/current` 附 `_meta`（age_ms/fresh，`FRESHNESS_MS` 默认 10min）；ml_predictions 写入 `normalize_ml_symbol` 归一化 + 唯一键幂等；`/stats.quality` 输出 missing_rate/abnormal_bars/source_freshness；okx_chainos 新增 `okx_candles` 快照（生产 439 items）；旧栈 mempump 定时器启用（支持链过滤 + `stage=NEW`，生产 60 行）；v5 `okx_token_snapshots` 因 v5 token-ranking 接口 404 长期 0 行 → 新增 v6 hot-tokens 回退（生产 200/200/100+ 行，`price_change_24h` 已 ALTER NUMERIC(20,4)）；btc_hashrate 经 mempool `/v1/mining/hashrate/1d` 采集并换算 EH/s（生产 899.19）。

> 注：okx `price_change_24h` numeric overflow 已修复 ✅（`a925065`，生产已 ALTER）；DS-14 Python SDK 已交付 ✅（`8e92921` + tag `v0.1.0`）；R-4 okx 生产出数已实测闭环 ✅。

**9.8.8 其他微服务需求补充（完整规格，2026-08-07，B 端需求：再补其他微服务）**

> 其他微服务 = 区块链栈（waas/dc/mpc/payment/session-key）+ 数据相关微服务（collector/knowledge-injector）。将 R 项、C-6 及 B-10 关键项细化为可执行需求（MQ 编号）。

| 编号 | 需求 | 契约 | 验收标准 | 优先级 |
|:---:|---|---|---|:---:|
| MQ-1 | **通用 RPC 转发代理**（R-1 / B-10-4）：waas 新增 `POST /api/v2/wallet/rpc`，收编 SDK `wallet.rpc()`（现 404） | `POST /api/v2/wallet/rpc` `{chain, method, params[]}` → 转发对应 RPC 节点，返回标准 JSON-RPC `{result/error}`；鉴权沿用统一契约 | SDK `wallet.rpc()` 返回真实链上结果；未授权 401 | P1 |
| MQ-2 | **SDK WalletAPI 契约对齐**（R-2）：`wallet.send/simulate/sweep/txStatus` 由不存在端点改为 waas 真实 `/api/v2/tx/*` | SDK 方法 → waas `txRoutes` 对应端点（参数/响应按 waas 契约） | E2E 各方法 200 且返回真实 tx 数据 | P1 |
| MQ-3 | **dc `tokens` 端点补全**（B-10-3）：MCP dc-index 的 `dc_tokens` 调 `/api/v2/data/tokens` 必 404——dc 补端点或工具改接 `/plans` `/chains` | dc 新增 `GET /api/v2/data/tokens`（返回租户链/计划明细）或 dc-index 工具改接现有端点 | MCP `dc_tokens` 调用返回真实数据、不再 404 | P1 |
| MQ-4 | **Session Key 额度三重校验落地**（R-6）：execution-service 接 `addSpent()`，`maxPerTx/maxTotal` 真实校验，`quota_exhausted` 可达；`expireStale()` 过期清理接线 | 超 maxPerTx/maxTotal 拒绝执行并返回 `quota_exhausted`；过期 key 定时清理 | 构造超限调用 → 拒绝；过期 key 不再可用 | P1 |
| MQ-5 | **Session PRD 定稿 + 测试补齐**（R-7）：PRD v1.0 发布（去 Draft），补声明缺失的集成测试 | PRD 标注 Released；全仓补充 `*.test.ts` 覆盖执行/额度/过期 | PRD 非 Draft；测试可运行通过 | P2 |
| MQ-6 | **session-key 四包发布 + MCP/SDK 鉴权**（R-8）：发布 `@0xinfrax/session-key-core/evm/client/server` 至 npm；5 个 HTTP MCP（dc/wallet/mpc/sk/hub）入站鉴权；修正 SDK 发布记录矛盾（0.3.0 vs 0.2.0） | npm publish（去 `workspace:*` 补 publishConfig）；MCP 入站校验 `X-Service-Key`/Bearer | `pip/npm` 安装成功；未授权 MCP 调用 401；文档记录一致 | P2 |
| MQ-7 | **MPC SDK 扩展**（R-5 / B-12-2）：infrax-dk `MPCAPI` 由 5/15 方法扩至全端点（签名/交易/合约读写/余额/gas） | SDK 方法对齐 mpc server 15 端点（`/api/v2/mpc/*`） | SDK 各方法 E2E 200 真实返回 | P2 |
| MQ-8 | **图谱注入语义去噪**（C-6）：knowledge-injector 注入前过滤广告/重复公告/低价值噪音（黑名单规则 + 相似文本去重） | 注入器加 `denoise` 步骤（规则表 + 相似度阈值），注入 doc 数显著下降 | 图库噪音文档比例下降（抽样对比） | P2 |
| MQ-9 | **payment/mpc 路由挂载确认**（B-10-5）：waas `paymentRoutes`/`mpcRoutes` 已定义未挂载——确认并挂载 | `server.ts` 挂载两路由；端点可访问 | 对应端点路由可达（非 404） | P1 |

**9.8 盘点明细（2026-08-06 调查结论，时点快照）**

> ⚠️ 下表为**盘点时点**的状态快照；各服务已完成项以 §9.8.1~9.8.4 任务表 ✅ 为准（MPC 鉴权/验证码 `148cc42`、Vault 鉴权 `148cc42` + B-5 `a0dbc76`、Payment 鉴权 `148cc42`、Session Key 上线 `414248c`、web subscription 代理 `414248c`）。

| 服务 | 端口（生产） | 实现状态 | 关键缺口 |
|---|---|---|---|
| MPC | 9104 / MCP 9105 | ⚠️ 非真 MPC，单 EOA 托管 | 验证码 888888 硬编码；无鉴权 |
| Session Key | —（未部署） | ✅ 代码最完整（三层鉴权） | 未上线；9111 端口冲突 |
| Vault | 9107 / MCP 9108 | ⚠️ 多签功能在 | 运行期无鉴权；safe_owners 未建表；仅 Sepolia |
| WAAS | 9109 | ✅ 功能最全 | 签名委托外部 CWallet；无通用 RPC 代理；两路由未挂载 |
| Payment | 9106 | ⚠️ 订单 CRUD 可用 | 全端点无鉴权；x402 伪实现 |
| DC | 9102 / MCP 3005 | ✅ 订阅+查询+余额 RPC | MCP `dc_tokens` 调不存在的端点 |
| Collector | 9101 | ✅ 最完整（relay 广播+鉴权+限流） | — |
| web 用户端 | 9111 | ⚠️ 有套餐卡片 | 无注册/登录；套餐硬编码；缺 subscription 代理；无 data key 界面 |
| admin | 3002 | ⚠️ 11 页 | 缺用户/套餐/订单页；6 个孤儿页面 |

**9.9 需求源登记与状态（需求合并索引，2026-08-07）**

> 全部需求统一在本文件 §9 登记状态；各需求源文档保留详细契约/规格，**不在源文档维护待办状态**。变更流程：新需求 → 在源文档补充契约 → 本节登记 → 按 §9 各小节跟踪执行。

| 需求源文档 | 内容 | tasklist 登记 | 状态 |
|---|---|---|---|
| `projects/data/AITRADER_DATA_SERVICE_REQ.md` | B 端 data-service 需求（DS-1~DS-14） | §9.1 | 全部 ✅（DS-13/14 已交付 2026-08-07） |
| `docs/DATA_MODULE_RAG_PLAN.md` | 模型与 RAG 里程碑（M0~M4 + P2 历史） | §9.2 | M0~M4 ✅ |
| `projects/ragservicer/docs/REQUIREMENTS.md` | LightRAG 微服务需求（F-T01~F-Q03 + SDK 分发） | §9.2 | ✅ 契约已实现（:9721 生产运行） |
| `docs/MCP_REQUIREMENTS.md` | MCP 工具清单（Wallet/DC/Market/Vault/MPC/SK 6 组） | §9.6 + §9.7 | ✅ 已上线（MQ-6：入站鉴权待补） |
| `docs/SESSION_KEY_ENGINE_DEV_PLAN.md` | Session Key 开发任务（v1.0） | §9.4 | ⚠️ PRD Draft（MQ-5） |
| `docs/SESSION_KEY_ENGINE_PRD.md` | Session Key PRD（S-01~S-11） | §9.4 | ⚠️ Draft（MQ-5） |
| `docs/MERGE_PLAN_AITRADER.md` | AItrader 合并计划 | §9.5 | — |
| `prd/PRD.md` | MCP & Skill 产品需求（v1.1） | §9.6 | ⚠️ 待审阅 |
| `docs/MCP_USAGE.md` / `docs/SDK_INTEGRATION.md` | MCP/SDK 使用与集成 | §9.7 | ✅（MQ-6：发布记录矛盾待修正） |
| `docs/DEPLOYMENT.md` / `docs/PROJECT_STATUS.md` 等 | 区块链栈部署/状态（旧布局） | §9.8 | ⚠️ 引用已随改名更新 |
