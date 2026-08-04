# InfraX 数据服务栈部署文档

> 最后更新: 2026-08-05 | 适用版本 `v0.5.1-20260804`
>
> 覆盖模块：`data` (:9112) / `knowledge-injector` (:9113) / `ragservicer` (:9721) / `ml-service` (:9120, 独立服务器)

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

---

## 2. 生产服务器

| 项目 | 值 |
|------|-----|
| Host | **43.163.105.172**（新加坡 · 腾讯云） |
| User | ubuntu |
| 系统 | Ubuntu 24.04.4 LTS |
| 规格 | 2C / 3.6G / 59G |
| 代码路径 | `/home/ubuntu/infraX-1` |

```bash
ssh ubuntu@43.163.105.172
```

**ML 推理服务器**（ml-service，待提供后填入）：独立 2C4G 服务器，常开承载三模型（详见 8.5 部署步骤）。

> 注：旧的区块链服务栈（9100-9111）部署在另一台服务器 **43.156.99.215**，见 [DEPLOYMENT.md](../DEPLOYMENT.md)。

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
| data :9112 | **可配置**（`DATA_API_KEY`，回退 `RAGSERVICER_API_KEY`→`DOC_API_KEY`→`LIGHTRAG_API_KEY`）；未配置则开放 | `/admin/config` 需 Bearer `ADMIN_API_KEY` |
| knowledge-injector :9113 | **可配置**（`INJECTOR_API_KEY`，回退 `RAGSERVICER_API_KEY`）；未配置则开放 | `/admin/config` 需 Bearer `ADMIN_API_KEY` |
| ragservicer :9721 | **强制**（bridge key / admin key / 租户 key 三层，见 4.3） | `/api/v1/admin/*`、`/instances` 需 Bearer `ADMIN_API_KEY` |

调用方式统一：`Authorization: Bearer <key>` 或 `X-API-Key: <key>` 二选一。

**key 一致性要求**：data-service 与 knowledge-injector 建议配置**同一把** `RAGSERVICER_API_KEY`（与 ragservicer/注入器 bridge key 一致），这样：
- injector → data-service 联动（`GET /snapshots` 拉情绪因子）自动带 `X-API-Key`，无需额外配置
- admin 后台自动读取三个服务 `.env` 中的 key 转发请求（`DATA_API_KEY`/`INJECTOR_API_KEY`/`RAGSERVICER_API_KEY`），改 key 后无需重启 admin

**启用方式**：在对应服务 `.env` 填入 key 并重启即强制校验；删除 key 即回退开放模式（向后兼容，便于 aitrader 调用方逐步接入）。

### 4.7 ml-service（`projects/ml-service/.env`，独立服务器）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ML_SERVICE_PORT` | 9120 | 服务端口 |
| `DATA_SERVICE_URL` | 空 | **必填**，指向主栈 data（`http://<主服务器IP>:9112`），未配置则 LightGBM/Kronos fail-silent |
| `DATA_API_KEY` | 空 | 主栈 data 的鉴权 key（主栈未配置 key 可留空） |
| `ML_API_KEY` | 空 | 本服务自身鉴权（主栈 data/injector 侧 `ML_API_KEY` 需同步） |
| `TREE_ML_ENABLED` / `TREE_ML_HORIZON`(7) / `TREE_ML_UP_THR`(0.01) / `TREE_ML_MIN_SAMPLES`(300) / `TREE_ML_MIN_BARS`(120) / `TREE_ML_MAX_BARS`(2000) / `TREE_ML_RETRAIN_HOURS`(24) | false / … | LightGBM 方向预测开关与训练参数；模型文件 `models/`（git 忽略） |
| `FINBERT_ENABLED` / `FINBERT_MODEL` | false / `ProsusAI/finbert` | FinBERT 新闻情绪开关与模型名（可换 `yiyanghkust/finbert-tone` 支持中英） |
| `KRONOS_ENABLED` / `KRONOS_MODEL` / `KRONOS_LOOKBACK`(400) / `KRONOS_PRED_LEN`(30) / `KRONOS_SAMPLE_COUNT`(12) | false / `NeoQuasar/Kronos-mini` / … | Kronos 波动率预测开关与参数；需 systemd `PYTHONPATH` 指向 Kronos 源码 |

**主栈联动配置**（见 8.5 主栈切换）：
- data `.env`：`ML_SERVICE_URL=http://<ml-server>:9120`（可选 `ML_API_KEY`）
- injector `.env`：`ML_SERVICE_URL=http://<ml-server>:9120`（可选 `ML_API_KEY`）

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

三个模型（Kronos / FinBERT / LightGBM）已从主数据栈拆分到**独立 ml-service**，部署在另一台 2C4G 服务器上常开。主栈（data / injector）仅通过 HTTP 拉取结果，不承载推理。

```
                 ┌──────────────────────────────┐
  data :9112 ──▶ │  ml-service :9120            │
  (HTTP /bars    │  ├─ LightGBM  TREE_ML_ENABLED │  LightGBM 自训→预测
   + /symbols) ─▶│  ├─ FinBERT   FINBERT_ENABLED │  FinBERT 新闻情绪
                 │  └─ Kronos    KRONOS_ENABLED  │  Kronos 波动率预测
  injector :9113 ──▶ GET /ml/volatility          │
  data :9112    ──▶ GET /ml/tree_predictions     │
  data :9112    ──▶ POST /ml/sentiment           │
                 └──────────────────────────────┘
```

| 模型 | 开关 | 用途 | 数据源 |
|---|---|---|---|
| **LightGBM**（P1） | `TREE_ML_ENABLED` | 方向三分类 + 机会评分（自训，24h 重训） | 经 data-service `GET /symbols` + `GET /bars` 拉 K 线 |
| **FinBERT**（P1a） | `FINBERT_ENABLED` | 新闻文本情绪分类 | 由 data-service `POST /ml/sentiment` 传入文章 |
| **Kronos-mini**（P0） | `KRONOS_ENABLED` | K 线波动率/方向预测 | 经 data-service `/bars`（yfinance 回退） |

**端点**（全部 `{"code":0,"message":"ok","data":...}` 信封，异常 data=None）：
- `GET /ml/tree_predictions` — LightGBM 快照（model 含 n_samples/val_accuracy + predictions）
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
# .env:  DATA_SERVICE_URL=http://<主服务器IP>:9112
#        DATA_API_KEY=<与主栈 data 一致的 key>（主栈未配置 key 可留空）
#        TREE_ML_ENABLED=true  FINBERT_ENABLED=true  KRONOS_ENABLED=true
#        ML_API_KEY=<可选，主栈侧需同步>

# ⑤ systemd 单元（开机自启，Restart=always）
sudo cp ml-service.service /etc/systemd/system/
# 注意加 Environment=PYTHONPATH=...:/home/ubuntu/Kronos（与 data-service 配置方式一致）
sudo systemctl daemon-reload
sudo systemctl enable --now infrax-ml-service
```

### 主栈切换（ml-service 就绪后）

- **data `.env`**：设 `ML_SERVICE_URL=http://<ml-server>:9120`（可选 `ML_API_KEY`）；原 `TREE_ML_ENABLED`/`FINBERT_ENABLED` 本地推理开关不再使用（推理已在 ml-service），未配置 `ML_SERVICE_URL` 时 ML 类 collector 空转 fail-silent
- **injector `.env`**：设 `ML_SERVICE_URL=http://<ml-server>:9120`（可选 `ML_API_KEY`）；Kronos 推理已从 injector 移除，改 HTTP 联动
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
- 注入：injector `inject_ml_predictions`（Kronos）与 `inject_tree_ml`（LightGBM，拉主栈 tree_predictions 快照）均在默认注入列表，ml-service 未启用时 fail-silent

> 内存预算（2C4G + 2G swap）：三模型均懒加载；常驻增量 ~200MB（Torch 库），推理峰值 FinBERT ~1.5G / Kronos ~0.5G，不同时高峰即可。独立服务器常开不影响主栈稳定性。

---

## 9. 待办

- [ ] ragservicer 配置 LLM / embedding / admin 密钥（见 4.3），跑通端到端注入 → `POST /query` 命中验证
- [ ] 腾讯云安全组放行 9112/9113/9721（如需公网访问）
- [ ] yfinance 限流解除后，恢复外汇 `symbols`（`data_config.json`）并评估切换回 yfinance 主源
