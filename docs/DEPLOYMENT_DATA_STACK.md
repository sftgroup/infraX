# InfraX 数据服务栈部署文档

> 最后更新: 2026-08-04 | 适用版本 `v0.5.1-20260804`
>
> 覆盖模块：`data` (:9112) / `knowledge-injector` (:9113) / `ragservicer` (:9721)

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
                 └───────────────┬──────────────────────────────┘
                                 │ HTTP (raw_snapshots / injectors)
                 ┌───────────────▼──────────────────────────────┐
                 │  knowledge-injector :9113                     │
                 │  内置注入器(15类) + YAML 可配置解析层          │
                 │  结构化文本 + 幂等 doc_id                      │
                 └───────────────┬──────────────────────────────┘
                                 │ POST /api/v1/namespaces/{ns}/documents
                 ┌───────────────▼──────────────────────────────┐
                 │  ragservicer :9721 (LightRAG 微服务)           │
                 │  实体抽取(LLM) + embedding + 知识图谱           │
                 └──────────────────────────────────────────────┘
```

- **data**: 聚合 Crypto(ccxt)/美股/港股/A股/外汇/期货行情、K线、因子与快照数据
- **knowledge-injector**: 定时把快照转成结构化文本注入 RAGservicer，构建知识图谱
- **ragservicer**: LightRAG 微服务（实体抽取需 LLM key，embedding 需 DashScope key）

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

`multi_kline` 段驱动美股/期货/A股/港股/外汇日线采集，`timeframes` 当前仅 `1d`（akshare 免费源仅日线）。**外汇 `symbols` 在 yfinance 限流期间留空**，恢复后填回 `EURUSD=X` 等 Yahoo 代码。

---

## 5. 数据源与降级链（yfinance 限流绕过）

> 背景：本机 IP 被 Yahoo Finance 全接口限流（`Too Many Requests. Rate limited.`）。已将美股/期货/因子切换到免费备用源，全部免 API key。

| 数据 | 主源 | 备用 | 最终兜底 |
|---|---|---|---|
| 美股 K线 | akshare 新浪 `stock_us_daily` | — | 记 warning 跳过 |
| 期货 K线 | akshare 东财 `futures_foreign_hist` | — | 记 warning 跳过 |
| A股 K线 | akshare 新浪 `stock_zh_a_daily` | — | 记 warning 跳过 |
| 港股 K线 | akshare 新浪 `stock_hk_daily` | — | 记 warning 跳过 |
| 外汇 K线 | （留空，yfinance 恢复后填回） | | |
| Crypto K线 | ccxt binance | | |
| VIX | **CBOE 官方 CSV** | yfinance | 最近快照 stale |
| US10Y | **akshare 东财美债收益率** | yfinance | 最近快照 stale |
| DXY | yfinance | — | 最近快照 stale |
| 美股指数 | akshare 新浪 `index_us_stock_sina` | yfinance（非美指数） | 跳过 |
| Fear&Greed | alternative.me | | |

**实现位置**：
- 多市场 K线：`projects/data/app/kline_store.py`（`_fetch_akshare_us/cn/hk/futures`，2s symbol 间节流 + 3 次退避重试）
- 因子：`projects/data/app/collectors/external_factors.py`（CBOE CSV / akshare bond_zh_us_rate / stale 快照回退）
- 指数：`projects/data/app/collectors/market_data.py`（`_SINA_INDEX_MAP`）

**已内置的防挂起机制**（`app/kline_store.py` 模块级）：
- 给 `requests.Session.request` 注入默认 12s 超时（akshare 内部请求大多不传 timeout，无响应会无限挂起）
- `socket.setdefaulttimeout(10)` 兜底非 requests 连接

**已知限制**：新浪对连续快速请求有 IP 风控（约 10+ 次后返回空，静默 30s 恢复）。受风控时该批 symbol 会快速失败并留待下一采集周期（300s），不会阻塞整个周期。

---

## 6. 验证清单

```bash
# ① 服务状态
systemctl is-active infrax-data infrax-knowledge-injector infrax-ragservicer
# → active active active

# ② 健康检查
curl -s http://127.0.0.1:9112/health            # {"code":0,"data":{"service":"infrax-data",...}}
curl -s http://127.0.0.1:9113/health            # lightrag_enabled:true 表示注入器已连上 ragservicer
curl -s http://127.0.0.1:9721/api/v1/health     # {"code":0,"instances":0,...}

# ③ 数据已采集
curl -s http://127.0.0.1:9112/stats             # kline_rows / symbols / snapshot_rows
curl -s "http://127.0.0.1:9112/bars?symbol=AAPL&timeframe=1d&limit=3"
curl -s "http://127.0.0.1:9112/bars?symbol=GC=F&timeframe=1d&limit=3"
curl -s http://127.0.0.1:9112/factors/catalog

# ④ 注入器 → ragservicer 鉴权
curl -s -X POST http://127.0.0.1:9113/inject/macro -H 'Content-Type: application/json' -d '{"dry_run":true}'
curl -s http://127.0.0.1:9721/api/v1/instances -H "X-API-Key: <ADMIN_API_KEY>"
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
```

### 7.2 日志

| 服务 | 日志文件 |
|---|---|
| data | `projects/data/service.log` |
| knowledge-injector | `projects/knowledge-injector/service.log` |
| ragservicer | `projects/ragservicer/service.log`（或 `journalctl -u infrax-ragservicer`） |

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
| 日志 `akshare ... fetch failed xxx: empty` | 新浪/东财 IP 风控 | 静默后自动恢复；减少 `data_config.json` 中标的数可降低触发概率 |
| 服务卡死不输出日志 | 旧代码无 requests 超时 | 确保代码为最新（已内置 12s 超时补丁）并重启 |
| 注入返回 403 | ragservicer `ADMIN_API_KEY`/桥接 key 未配置或与注入器不一致 | 按 4.3 配置后重启两个服务 |
| 注入失败 `LLM/embedding` 错误 | ragservicer 密钥未填 | 填 `LLM_BINDING_API_KEY` / `EMBEDDING_API_KEY` 后重启 |
| 外网 curl 不通 | 云安全组未放行 | 腾讯云控制台 → 安全组 → 添加入站规则（9112/9113/9721） |

---

## 9. 待办

- [ ] ragservicer 配置 LLM / embedding / admin 密钥（见 4.3），跑通端到端注入 → `POST /query` 命中验证
- [ ] 腾讯云安全组放行 9112/9113/9721（如需公网访问）
- [ ] yfinance 限流解除后，恢复外汇 `symbols`（`data_config.json`）并评估切换回 yfinance 主源
