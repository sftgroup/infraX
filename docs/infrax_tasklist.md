# InfraX 统一任务清单（infrax_tasklist）

> 最后更新: 2026-08-12 | 适用版本 `v0.7.0-20260811`
>
> MQ-10 收敛与优化 DC-1~DC-10 已全部完成并在生产验证（2026-08-08），见 §9.7 MQ-10 方案段。
> **Agent 钱包架构决策（MQ-10 补充 E，2026-08-08）**：以 aa-sdk（Kernel v3 ERC-4337）为主主线，aa-sdk 三缺口（Paymaster/多链/aa-relay）已排期（MQ-10 补充 E-1，🔲）。
> **MQ-12 套餐支付接入通用支付引擎（2026-08-10）**：waas subscribe 支付意图化（T-1~T-3/T-5~T-6 代码已实现，T-7~T-9 生产部署/验收待办），见 §9.8.8 MQ-12 段。
> **MQ-16 对外套餐服务矩阵（✅ 2026-08-11 全部完成）**：五任务全量生产部署 + 验收通过——T-1 DC 配额真实扣减 / T-2 Market 按量套餐 / T-3 Chain RPC 对外读套餐 / T-4 MPC 按量计费 / T-5 Agent 专属能力开放，见 §9.8.9 MQ-16 段（各服务验证脚本全绿，生产 drop-in 清单见 [DEPLOYMENT.md](./DEPLOYMENT.md)）。
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

## 2. 生产服务器

| 项目 | 值 |
|------|-----|
| Host | **43.163.105.172**（新加坡 · 腾讯云，**单机承载全部服务**） |
| User | ubuntu |
| 系统 | Ubuntu 24.04.4 LTS |
| 规格 | 2C / 3.6G / 59G |
| 代码路径 | `/home/ubuntu/infraX-1` |
| 承载范围 | 数据栈（9112/9113/9721/3002）+ 区块链栈（9100-9111）+ 平台服务（9130-9132/9200-9201/3500）+ MCP（3008/3011/3012/9103/9105/9108/9110）+ admin/web + nginx（80/443）——24 个 systemd 服务 + 1 清理 timer |
| 旧服务器 | ~~43.156.46.187 / 43.156.99.215 / 129.226.203.60~~ **已彻底移除**（2026-08-11 全量核查：systemd/nginx/cron、服务 env、代码库非文档、`.env`、PostgreSQL 均无残留引用；`projects/data/.env.example` COLLECTOR_URL 已改指 `43.163.105.172:9101`） |

```bash
ssh ubuntu@43.163.105.172
```

**公网入口（nginx，唯一对外面）**
- 域名 `infrax.0xainet.top` → Cloudflare（A `104.21.21.11` / AAAA `2606:4700:…`，代理已开）；TLS 证书为 **Cloudflare Origin CA**（生产 443 已配，过期 2041-07）
- ⚠️ **当前状态（2026-08-07 复测）**：域名 `/` 经 Cloudflare 200，但 `/api/*` 全部 502（`/api/data/health`、`/mcp/health`、`/api/v2/data/tokens` 均 502；origin 侧 nginx 直连均 200，access log 无 Cloudflare 回源请求）——**Cloudflare 面板回源问题未修**（DNS 回源 IP=43.163.105.172、SSL 模式与 `/api/*` 相关 Origin Rule/Worker 检查）。2026-08-07 新增 nginx 路由 `/api/v2/data/` → dc(:9102)，本机直连 200 已验证，公网同样受此 Cloudflare 502 影响
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

**B 端访问方式（2026-08-19 确认）**：所有 B 端（含 AItrader）**走 SDK/API 通用方案**，经 nginx 唯一公网入口访问，不直连后端端口：`lightrag_client` SDK / 通用 API → `https://43.163.105.172/api/rag/*` → `http://127.0.0.1:9721/`（ragservicer）。因此 **43.156.78.59:9721 公网入方向应保持关闭**（安全组 140.44 白名单规则可移除；nginx 同机 127.0.0.1 或内网 10.3.8.6 可达即可）。GF 新端点经公网路径实测可用：`/api/rag/api/v1/factors/graph`、`/api/rag/api/v1/graph/entities`、`/api/rag/api/v1/factors/catalog`（AItrader key 鉴权，2026-08-19 实测 200）。

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

`multi_kline` 段驱动美股/期货/A股/港股/外汇日线采集，`timeframes` 当前仅 `1d`（免费源仅日线）。**外汇 `symbols` 已填回（EURUSD=X 等 7 对，2026-08-08 实测全量 796-800 根）**：优先走 Twelve Data（配置 `TWELVE_DATA_API_KEY` 后），否则回退 yfinance——yfinance 仍受限流影响时该对日采集会失败并计入 failed 告警。**A股/港股走腾讯日线**（`web.ifzq.gtimg.cn`，独立于新浪风控），新浪仅作回退。

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
| `BOLT_ENABLED` / `MOIRAI_ENABLED` / `TIMESFM_ENABLED` | false | P2 时序基础模型开关（Chronos-Bolt / Moirai 2.0 / TimesFM 2.5） |
| `P2_TARGET_SYMBOLS` | 空 | 目标符号池（逗号分隔，显式覆盖 data-service 动态发现；空走动态） |
| `ML_CACHE_TTL_SEC` | 1800 | 端点结果缓存时长（秒）；TTL 内命中秒回不重算 |
| `ML_PREWARM_ENABLED` / `ML_PREWARM_DELAY_SEC` / `ML_PREWARM_INTERVAL_SEC` | true / 60 / 900 | 预热线程开关与周期（缓存缺失/过期时后台刷新；interval 建议 < TTL） |

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

### 9.1 AItrader data-service 需求（源：projects/data/AITRADER_DATA_SERVICE_REQ.md；DS-16/17 源：requirements-infrax.md REQ-1/REQ-2）

| 编号 | 需求 | 状态 | 优先级 | 备注 |
|---|---|---|---|---|
| DS-1 | `/bars` K 线（OHLCV+指标+因子） | ✅ | P0 | 契约确认 |
| DS-2 | `/factors/*` 因子目录/最新/历史 | ✅ | P0 | |
| DS-3 | `/snapshots` 复杂快照 | ✅ | P0 | 契约确认；缺的 3 类（commodities/forex_pairs/market_overview）已由 DS-10 补齐 |
| DS-4 | `/symbol/resolve` 符号解析 | ✅ | P1 | **crypto 精确解析已实现**（1df5e77 + swap 规范化 d3b313f，2026-08-05 生产实测：BTC→BTCUSDT、swap BTC/USDT:USDT→BTCUSDT、非 crypto 种子直通 EUR/USD→EURUSD、未知 404）；**全市场覆盖已实现（DS-11，见 DS-11 行）** |
| DS-5 | `/policy/broker-market` 券商市场策略 | ✅ | P1 | **静态配置已实现**（2a7ce7f，2026-08-05 生产实测 200 符合契约：crypto 10 家交易所 + default Binance；无 key 401）；多市场扩展待 DS-11 |
| DS-6 | `/stats` `/health` | ✅ | — | |
| DS-7 | `/ticker` 实时报价 | ✅ | P0 | 1375a38，已部署实测 |
| DS-8 | `/bars` 数据覆盖 + spot/swap 区分 | ✅ | P0 | da2cd34 已部署实测；**深度已对齐验收标准**（2026-08-05 aa3f1c1 crypto 回填：1d 1095 根/3 年、1m 43202 根/30 天；76a9419 非 crypto `fetch_bars` 200→400：美股 AAPL/MSFT 400 根≈585 天、期货 GC=F 565 天、A股 600519 602 天、港股 00700 597 天均达标）；**外汇已全量补齐（2026-08-08 生产实测）**：Twelve Data 主源 7 对 796-800 根（EURUSD 799 / GBPUSD 800 / USDJPY 800 / USDCHF 800 / AUDUSD 800 / USDCAD 799 / NZDUSD 796，见 9.3 外汇补齐记录）；**7 档 timeframe 全达标**（1m 321,887 / 5m 366,760 / 15m 137,363 / 30m 61,125 / 1h 83,632 / 4h 36,746 / 1d 26,133，46 符号，1h·4h 自 2024-07-25 起≈2y） |
| DS-9 | `/symbols/search` 符号搜索 | ✅ | P0 | 3b9da2b 已部署实测：btc 20 条（spot5+swap15，binance/okx/bybit，全 active）；**usstock/forex/futures/cnstock/hkstock 在线 lookup（DS-11 后，见 DS-11 行）** |
| DS-10 | `/snapshots` 补齐 commodities/forex_pairs/market_overview | ✅ | P1 | 2d78050 已部署；生产实测：market_overview ✅（crypto 15 项）、commodities ✅（SI=F 白银/CL=F 原油 WTI 等）、forex_pairs ✅（EUR/USD/GBP/USD 等），yfinance 免费源正常出数 |
| DS-11 | `/symbol/resolve` 多市场覆盖确认 | ✅ | P1 | **全市场覆盖已实现**（09a9d65 + 3bfa660，2026-08-06 生产实测）：新增 `app/symbol_lookup.py` 在线符号搜索（美股→Finnhub search 主 + TwelveData symbol_search 备；外汇/期货→TwelveData；A股/港股→AkShare 全量表 24h 缓存 + TwelveData 备）；resolve 实测 apple→AAPL、MSFT→MSFT、600519→600519、00700→00700、EUR/USD→EURUSD、gold→GOLD；search 实测茅台→600519、腾讯→00700（中文名匹配）、apple→AAPL/APLE 等（Finnhub 已过滤 .SS/.HK/.L 非美后缀）；种子→在线回退链，全市场路由 market 参数统一 crypto/usstock/forex/futures/cnstock/hkstock |
| DS-12 | 入站鉴权 `X-Service-Key`（`/health` 豁免） | ✅ | P1 | 1f4deea 统一鉴权契约 app_auth 落地；生产三服务实测闭环（见 9.3） |
| DS-13 | ML 因子并入标准因子面（catalog/current/history） | ✅ | P1 | `app/factors.py` 新增 10 个 ML 因子（category="ml"：tree/finbert/consensus/bolt/moirai/timesfm 的 direction+prob，direction 统一数值化 up=1/flat=0/down=-1）；catalog 28 因子、current 按 symbol 广播、history asof 对齐（fetched_at ≤ bar ts，无未来函数）；2026-08-07 已部署生产实测三端点全出数 |
| DS-14 | 官方 Python SDK（封装全部端点） | ✅ | P1 | `projects/data/sdk/python/`（包名 infra-data-client，现 **0.2.0**，SemVer）：单构造 `Client(base_url, api_key)` 内置 X-Service-Key、`verify` 可配置、429 重试/退避（Retry-After 优先）、fail-silent 默认返回 None 不抛错、秒↔毫秒自动归一化、全方法类型注解；覆盖 /bars /factors/* /snapshots /ticker /symbol/resolve /symbols/search /policy/broker-market /stats /health + **`get_ml_predictions()`（2026-08-08 v0.2.0 新增，/ml/predictions 快照优先路径）**；集成示例 `examples/ml_predictions_integration.py`（快照优先 + data=null 兜底 + /ml/cache/stats 就绪判断）；wheel 构建通过 + 生产实测 12 方法全绿 |
| DS-15 | **ML 因子历史回填**（对已上线 30 符号按历史 1d bars 回放推理写 `ml_predictions` / `raw_snapshots`，解决「回测含 ML 因子早期区间全空」） | ✅ | P1 | 脚本：ml-service `scripts/backfill_ml_history.py`（bolt/moirai 单变量·多变量回放、tree 逐日聚合、timesfm 单变量长上下文）+ data `scripts/ingest_backfill.py`（INSERT OR IGNORE 幂等落库）。**阶段一完成（2026-08-08，不停服）**：bolt **+4853** / moirai **+4044**（2024-09-09 → 2026-08-07）+ tree **+1723** 个按日聚合快照（2023-10-06 → 2026-08-07）。**阶段二完成（2026-08-08，停服窗口，实测 36min）**：timesfm **+4856** 行（2024-09-09 → 2026-08-07；峰值 RSS 1.89Gi，停服执行无 swap 压力，落库后服务已恢复）。全量收口：`ml_predictions` 现 **14524 行**（bolt 5126 / moirai 4294 / timesfm 5104）+ tree 快照 1782，30 符号全覆盖；`/factors/history` 早期区间（2024-10-01）实测已含 tree/bolt/moirai/timesfm 因子 |
| DS-16 | **K 线数据整体缺失修复**（/bars 全周期 count:0，源：requirements-infrax.md REQ-1） | ✅ | P0 | **根因（2026-08-18 定位）**：非链路中断，而是标的缺失——`KL_SYMBOLS`/`KL_SWAP_SYMBOLS` 仅有 USDT 对（BTC/USDT, ETH/USDT, SOL/USDT），**从未采集 USDC 对**。**修复**：`.env.example` + 生产 `.env` 增补 `BTC/USDC`、`ETH/USDC`（spot+swap），热更新走 `PUT /admin/symbols`（Bearer ADMIN_API_KEY，免重启）后回填全周期（1d 1095 根、4h 2185 根等）。**验证**：`/bars?symbol=BTC/USDC` 等 count≥500 且 bars 非空，连续采样稳定 |
| DS-17 | **热力图全市场覆盖**（crypto-only → 股票/外汇/大宗商品，源：requirements-infrax.md REQ-2） | ✅ | P1 | **实现（2026-08-18 上线）**：新增 `app/data_providers/tradfi_heatmap.py`——stocks（4 指数+11 板块 ETF+40 大盘股）Finnhub 串行限速 0.2s（并发 8 触发 429）<28 只时 yfinance 兜底；fx（12 对）frankfurter → yfinance → Tiingo → TwelveData 多源回退；commodities（12 只）yfinance → Tiingo(金/银) → TwelveData。`heatmap.py` crypto 每类上限 30→50（CoinGecko per_page 100→150）+ 并行合并 tradfi；cache key `market_heatmap_v4`→`v5`；`collectors/heatmap.py` 统一走 `generate_heatmap_data()`；forex/commodities `_fetch_td` 增 429 短路。**生产实测**：crypto topcap/other 各 50、stocks 39、fx 12 对全齐、commodities 2 只（金/银）。⚠️ commodities 其余 10 只受 yfinance 临时限流（YFRateLimitError）+ TwelveData 免费额度今日 429 耗尽（4065/800）未出数，源解封后自愈回 12 只 |
| GP-1 | 图谱端点服务端缓存（源：`projects/data/AITRADER_GRAPH_PERF_REQ.md` R1）：首次生成后对相同查询（symbol/namespace/limit）缓存结果（Redis 或磁盘）直接返回；实体/文档增量更新时保持旧图可用、后台重建 + 原子切换 | ✅ 已部署 | **P1** | **2026-08-20 完成（commit f3dfd7b）**：ml-service `/ml/graph/edges` 接入 `_endpoint_cache`（1800s）+ 纳入 prewarm 预热，冷态不阻塞返回 `meta.status="building"`，后台构建完成自动就绪；图快照 `_GRAPH_SNAPSHOT_TTL_S`(1800s) 新鲜窗口内多入口复用（graph_factors/graph_edges/预热共享一次构建）。data-service：entities/factors 缓存 TTL 1h(3600s)、edges/history 30m(1800s)，`fetch_graph_history` 新增 1800s 缓存。ragservicer：graphml/entities/relations 三 loader SWR 缓存（TTL 1800s `GRAPH_CACHE_TTL_S` 可配）——过期返回旧图 + 后台重建 + 原子切换 + 防重入 |
| GP-2 | 图谱首次生成异步化（R2）：冷缓存查询返回 `202 Accepted`+`jobId`，B 端后台生成，客户端轮询 `status?jobId=` | 🔲 待办 | P2 | 改动大：ml-service 后台生成 + data-service 适配 + AItrader 前端 jobId 轮询，作为二期；ml-service `async_cache`/prewarm 框架可复用 |
| GP-3 | 图谱生成链路性能优化（R3）：embedding 结果缓存（同一文档/实体不重复向量化）、图谱分片/增量构建、LLM 并发/批处理 | ✅ 部分实现 | P2 | **2026-08-20 落地部分（commit f3dfd7b）**：ml-service `_fetch_bars_parallel` 新增 300s 结果缓存（`ML_GRAPH_BARS_CACHE_TTL_S` 可配，按标的集合键控复用，universe 在快照新鲜窗口内稳定时避免重复拉取全市场日线）+ 图快照新鲜检查（`_GRAPH_SNAPSHOT_TTL_S` 1800s 内复用 `_LAST_GRAPH`，消除多入口重复全量构建）。其余（embedding 结果缓存、图谱分片/增量构建、LLM 并发/批处理）仍待后续评估 |
| GP-4 | 图谱端点 SLA 承诺（R4）：缓存命中 P95<500ms、冷生成 P95<10s（R1/R2 落地后目标）、失败返回结构化错误（`503+reason`）替代 fail-silent | ✅ 已部署 | P2 | **2026-08-20 落地（commit f3dfd7b）**：ml-service `/ml/graph/edges`、data-service `/factors/graph*` 四端点统一返回 `meta.status`（ready/building/error）+ 结构化 reason/warning——冷态返回 `building`（附 reason）而非空结构，AItrader 可区分「生成中/故障/就绪」。`202 Accepted+jobId` 异步化方案（GP-2）留待二期 |

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
- [x] 统一鉴权契约 + 共享 app_auth（`projects/shared/app_auth.py` 唯一来源；data/injector/ragservicer/ml-service 同一实现：Bearer/X-API-Key/X-Service-Key、统一 401、健康端点豁免——data/injector/ml 为 `/health`、ragservicer 为 `/api/v1/health`（Blueprint 前缀）、bridge key 回退链收敛，1f4deea）
- [x] 生产部署重启实测 X-Service-Key 鉴权闭环（2026-08-05，43.163.105.172）：data /stats 无key→401 有key→200；injector /status 同；ragservicer /api/v1 docs 同（Bearer/X-API-Key/X-Service-Key 均过）；ml-service 独立服务器 43.156.25.197（:9120）当时版本 ff2bad5 未含 app_auth，已于同日升级至 7350d47 完成闭环（见下）
- [x] 安全组放行 9112/9113/9721（公网已可访问实测）
- [x] DS-8 遗留：data `.env` 配置 `KL_TIMEFRAMES=1m,5m,15m,30m,1h,4h,1d` 补齐分钟级覆盖（2026-08-05 复核：生产 `.env` 已是该值；`/bars` 实测 BTC/USDT 5m/15m/30m/1h/4h 全部出数，指标完整）
- [x] yfinance 限流解除后恢复外汇 `symbols` 并评估切回主源（**2026-08-06 完成，无需再等 yfinance**）：Twelve Data key 已配置接管外汇主源（620 行），采集降频至 30min（9828840，1728→96 次/天 低于免费 tier）；`data_config.json` 外汇 6 对已在 Twelve Data 出数（EURUSD 599 根 / AUDUSD·USDCAD·USDCHF·USDJPY 各 396 根，GBPUSD 199 根待下一轮补齐）；**2026-08-08 已全量补齐**：外汇扩至 7 对（+NZDUSD）且 1d 均 796-800 根，Twelve Data 主源稳定（EURUSD 799 / GBPUSD 800 / USDJPY 800 / USDCHF 800 / AUDUSD 800 / USDCAD 799 / NZDUSD 796）；P2 SPY/QQQ 数据经 yfinance/腾讯美股兜底不受影响
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
- [x] **数据服务数据目录文档 `docs/DATA_SERVICE_CATALOG.md`（2026-08-06 完成，commit fac3899 已推送 GitHub origin/master；2026-08-08 复核更新至 32 类快照/46 符号/ML 回填完成，commit 16a7e96）** 明确列出数据服务可获取的数据与类型全清单：行情（/bars 7 timeframe 覆盖实测表 + /ticker 5 市场回退链）、因子与快照（raw_snapshots 32 类 provider/data_type 清单，生产实证）、ML 预测、符号元数据、**graph 图谱数据**（ragservicer LightRAG entities+relations+chunks + 6 种 query mode + knowledge-injector 注入端点 + MCP）、数据源总览 9 类、管理端点——供 B 端/数据调用方对照
- [x] **B 端反馈闭环补充（2026-08-06 完成）** ① `/ticker` 响应补回显 `market_type`（commit d32b157，生产实测 swap 64621.6 / spot 64650.74，C2 切换可区分）；② P2-5 公开文档入口与 nginx `/api/v1` 兼容段**生产实际生效**（此前声称已加但未生效，本日确认配置缺失并插入 reload 验证，`/api/v1/symbol/resolve` 401 JSON 不再 HTML）；③ 生产 git 提交 A+B 类 23 文件（commit 14d19cf，含 api_keys.py/auth-express.ts 首次入库）+ 与 origin 合并同步（merge dbbaf3c，解决 .gitignore 与 session-key auth.ts 两处冲突，auth.ts 采用 addHook 新方案与生产 dist 一致）；④ `ragservicer/data/` 加入 .gitignore（commit 3963c78，运行时产物防误提交）
- [x] **对外微服务三件套文档（2026-08-06 完成，commit ea80e69 已推送 GitHub + 生产 merge bb93300）** ① `docs/SERVICE_API_REFERENCE.md`——六大微服务（VAULT/Session/MPC/WAAS/DATA/LightRAG）对外 API 端点全清单 + 统一鉴权契约 + 生产实测鉴权矩阵（7 服务全实测：VAULT/MPC/Session/DATA/injector 无 key→401 闭环，ragservicer health 200/admin 403，**WAAS 无 key→200 裸奔**，见 9.8 B-12-1）；② `docs/SDK_INTEGRATION.md`——npm `@0xinfrax/infrax-dk` 0.3.0（data/vault/mpc/waas/dc/market 九模块）+ Python `lightrag-client` 2.0.0 + OpenAPI 契约生成指南；③ `docs/MCP_USAGE.md`——7 个 MCP 服务工具清单（hub 13/vault 13/mpc 15/sk 7/dc 7/wallet 10/STDIO 5）+ 入站/出站鉴权总表（**仅 hub-index 有入站鉴权，其余 5 个 HTTP MCP 入站裸奔，B-12 待办**）+ 生产端口实测（dc-mcp 9103 / wallet-mcp 9110 非默认值）
- [x] **B 端联调回执登记（2026-08-06，B 端 commit 105cb1c 推送 `B_END_PROGRESS_CHASER.md` §6）** AItrader 侧实测：`/health` `/bars(1m/1h)` `/ticker(BTC spot+swap/SPY)` `/symbols/search` `/snapshots(commodities/forex_pairs/market_overview)` 全部 200、无 key 401、旧 `/api/v1/symbol/resolve` 已废（新路径 `/api/data/symbol/resolve`）。**我方复核生产（2026-08-06 22:5x）**：① **crypto 1D 深度已达标**——BTC/ETH 1d count=1096（2023-08-07→2026-08-05，≈3 年），B 端回执"1D count:0"应为回填完成前观察；② **EUR/USD ticker 已通**——`/ticker?symbol=EUR/USD` 与 `EURUSD=X` 均 200 全字段（price 1.1546），P1-3 符号映射已生效；③ **`/factors/history` 技术因子完整**——1d 最新区间 rsi_14/macd/bb/atr/ma 全字段返回（1065/1096 行有 RSI），前导窗口 NULL 属正常预热；**④ 真缺口 2 项**见下
- [x] **B 端缺口④：`/factors/history` 并入宏观/情绪历史序列（2026-08-06 完成，commit ae3f461）** `get_history_factors` 现对每条 kline bar 先取技术因子，再对 vix/dxy/us10y/fear_greed/sentiment_score 5 项从 raw_snapshots 历史做 asof 对齐（bisect 二分最近 fetched_at ≤ bar ts）。**生产实测通过**：`/factors/history?symbol=BTC/USDT&timeframe=1d` 系列返回 vix:16.5/dxy:119.7034/us10y:4.63/fear_greed:27.0/sentiment_score:-0.138；技术因子 1d 1065/1096 行有 RSI。注：宏观窗口自 8-03 起采集，更早 bar 无宏观值属正常
- [x] **B 端缺口⑤：多市场分钟级 K 线采集（2026-08-06 完成 v2，commit b8cf9a6 + 后续 4h 复用修复）** 生产实测发现：Twelve Data 免费 tier 每日 800 credits 被全服务共享消耗（当日实际 3087）、yfinance 从生产 IP 被 Yahoo 稳定 429、东财 push2his 网络阻断。落地能力（生产实测 23:14）：**cn_stocks 15m/1h/4h 全落库**（腾讯分钟线 1970 根 + 1h 聚合 4h，600519 等 6 只，免费无额度）；**forex 改为轮换采集**（每周期只拉 1 个 timeframe × 7 对 + 请求间 8s 节流，28→7 请求/周期，额度友好，当日已超支待 UTC 重置后出数）；**yfinance 4h 修复**（先拉 1h 再聚合，V/XOM 1h/4h 实测落库 400/103 根）；**us_stocks/futures 1h/4h 受 Yahoo 限流部分成功**（V/XOM 通、SPY 等失败记 failed）。⚠️ 遗留：hk 分钟级源未找到（仅 1d）；Twelve Data 额度超支需 B 端提供付费 tier 或降其他消费方
- [x] **B 端缺口⑤后续：外汇轮换出数验证（2026-08-08 完成）** 轮换采集代码已就绪并部署生产（commit b8cf9a6：每周期只拉 1 个 timeframe × 7 对外汇 + 请求间 8s 节流，28→7 请求/周期），Twelve Data 免费 tier 当日额度被全服务共享超支（实际 3087/800）→ 当日 15m 请求全 429；08-07 08:00 CST 额度重置后轮换采集持续出数。**验证结果**：外汇 **1d 全量达标**（7 对 796-800 根，Twelve Data 主源稳定）；**15m/1h/4h 外汇受免费 tier 800 credits/天额度限制仅部分落库**（crypto 全量覆盖），完整分钟级周期需 B 端提供 Twelve Data 付费 tier
- [x] **B 端 DS-11 决策点：`/symbol/resolve` 多市场覆盖（2026-08-06 答复，commit 后续）** 生产实测全市场矩阵：crypto（BTC/BTCUSDT 含 swap）✅、外汇 `EUR/USD`→`EURUSD=X` ✅（斜杠与裸对 EURUSD 均支持，裸对识别为本次新增）、usstock/futures/cnstock/hkstock 种子直通（SPY/GC=F/600519/00700）✅。**决策：全市场已覆盖，AItrader 无需保留非 crypto 本地降级；调用需显式传 market 参数**（默认 crypto 会把 SPY 误匹配 SPYUSDT）。已同步 B_END_PROGRESS_CHASER.md §2/§3
- [x] **ml-service 性能改造 + 双 SDK 发布 + 文档同步（2026-08-08 完成，commit a7cf6bc + ed076a3 + e9cc90f + eb1a66f + 512685f，均推送 GitHub origin/master）** ① **异步化 + 缓存预热**：重计算端点（tree_predictions/volatility/bolt/moirai/timesfm/consensus）全部走 `app/async_cache.py`（AsyncCacheRunner：缓存 miss 后台 daemon 线程计算、请求立即返回 `data=null`；prewarm_loop 周期刷新），TTL 缓存 `peek/bump`，`ML_PREWARM_ENABLED/DELAY_SEC/INTERVAL_SEC`（默认 true/60/900），新增 `/ml/cache/stats` 监控端点（免鉴权，total hits/misses + 各端点 cached/expires_in/last_compute_ms）；② **consensus 事件循环阻塞修复**（原 async def 同步调 build_consensus 卡死 /health → 改 def + _async_runner）；③ **响应结构统一**：volatility/bolt/moirai/timesfm 由裸数组统一为 `{generated_at, n_symbols, model, avg_<score_key>, symbols}`（volatility→volatility_score，其余→prob_up），tree/consensus 保持原 dict；缓存 miss 时 `data=null` 属预期；④ **宏观因子**：FRED VIXCLS/DTWEXBGS/DGS10 → vix/dxy/us10y + FNG 显示名 "Fear & Greed"（alternative.me 365 天回填）；⑤ **文档 5 份**：SERVICE_API_REFERENCE §3 ml-service 章节、SDK_INTEGRATION（ml 消费要点）、MCP_USAGE（ml_predictions 链路）、DATA_SERVICE_CATALOG（因子 FRED 源/显示名 + §4 拆分）、SERVICE_ENDPOINTS_OBSERVABILITY（ml 端点表/预热）、DATA_SERVICE.md v2.0 重写（端口 9112/46 符号/7 timeframe）；⑥ **Python SDK infra-data-client 0.2.0**：新增 `get_ml_predictions(model, symbol, ...)`（/ml/predictions 快照优先，404→None fail-silent）+ `examples/ml_predictions_integration.py`（快照优先 + data=null 兜底 + cache/stats 就绪判断，生产两条路径实测通过）；⑦ **npm @0xinfrax/infrax-dk 0.4.0 已发布**（registry latest 验证）：新增 `infra.ml.*` 命名空间 9 方法（treePredictions/volatility/bolt/moirai/timesfm/consensus/macroFeatures/sentiment/cacheStats），`mlUrl`/`mlApiKey` 独立配置，生产实测 bolt 30 symbols / cacheStats / data.mlPredictions 全通。**集成方配合点**：优先读 data `/api/data/ml/predictions` 快照；直连 ml-service 缓存 miss 得到 `data=null`，用 `/ml/cache/stats` 判断就绪并按 TTL（默认 1800s）轮询

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

> 品牌化 MCP & Skill（hub-index 统一入口 + TEE 钱包 + DC 事件分类 + 多市场发布）。**PRD 待审阅；Phase 1（DC 事件分类）已实施完成（2026-08-12，见下）**

**需求补录（2026-08-11 商业对齐评审，对标 OKX OnchainOS）**

| # | 需求 | 说明 | 状态 |
|:---:|------|------|:---:|
| 6.0 | **AI 生态 Skills 插件（对齐 onchainos-skills）** | 现有 wallet/dc/vault/mpc 四个 MCP 服务器为底座（✅ 已具备），补齐生态发布层：为 Claude Code（`.claude-plugin`）/ Cursor（`.cursor-plugin`）/ OpenCode（`.opencode`）/ Codex（`.codex-plugin`）/ OpenClaw（`.openclaw`）提供官方 Skills 插件，覆盖 wallet/dc/vault/mpc/data/payment/session-key 全能力（含 session-key 签名代理与零签名模式）；发布物对齐 OKX onchainos-skills（GitHub 3449 commits、多 IDE 插件市场 + SKILL.md） | ✅ 代码完成（ai-skills/ 仓库，6.1~6.3 全绿） |

**需求 6.0 实现子任务（2026-08-11 拆解）**

| # | 任务 | 说明 | 状态 |
|:---:|------|------|:---:|
| 6.1 | Skills 插件仓库脚手架 | 新建 `ai-skills/` 仓库：SKILL.md 模板 + 7 组 skill（wallet/dc/vault/mpc/data/payment/session-key），基于 4 个 MCP 服务器现有工具清单生成 | ✅ `ai-skills/SKILL.md.template` + `skills/{wallet,payment,vault,mpc,data,dc,session-key}/SKILL.md` + `shared/mcp-config.json`（6 server 统一注册） |
| 6.2 | 多 IDE 发布物 | Claude Code `.claude-plugin` / Cursor / OpenCode / Codex / OpenClaw 五市场配置 | ✅ `.claude-plugin`、`cursor/.cursor-plugin`、`opencode/.opencode`、`codex/.codex-plugin`、`openclaw/.openclaw` 各含 plugin.json + README |
| 6.3 | 文档与示例 | 每个 skill 附 Quick Start 样例（含 vault MPC 验证码确认 / session-key 零签名模式） | ✅ `ai-skills/docs/QUICKSTART.md`（7 场景 + vault MPC SDK confirmMpc 示例 + session-key 零签名模式） |

**Phase 1: DC 数据强化（1 周）**

| # | 任务 | 估计 | 状态 |
|:---:|------|:---:|:---:|
| 1.1 | `event_categories` 表 + 分类数据 | 1d | ✅ `0c5605a`（migration 10 条种子：asset_transfer/authorization/dex_trading/wrapping/supply/unclassified） |
| 1.2 | `events` 表加 `category_id`/`label_id` 列 | 0.5d | ✅ `0c5605a`（含 idx_events_category_block/label_block 索引） |
| 1.3 | collector 事件分类逻辑 | 2d | ✅ `0c5605a` + `37387dd`（insertEvents 插入分类 + reclassifier 同源映射 + 采集时增量计数 `event_category_stats`） |
| 1.4 | dc-index.ts 扩展 → v2（+2 tools） | 2d | ✅ `0c5605a`（v1.3.0：dc_event_categories / dc_event_stats，dc_events +category/label） |
| 1.5 | DC API v3（/api/v3/data/*） | 2d | ✅ `0c5605a` + `37387dd`（v3 events category/label 过滤 + event-categories/event-stats O(1)） |

**Phase 2: TEE 钱包 + 品牌 MCP Hub（2 周）**

| # | 任务 | 估计 | 状态 |
|:---:|------|:---:|:---:|
| 2.1 | TEE Enclave 环境搭建（SGX/Nitro） | 2d | 🔲 |
| 2.2 | MPC API 底层切 TEE | 3d | 🔲 |
| 2.3 | mpc-index.ts → tee-index.ts（改名+swap+approve） | 2d | 🔲 |
| 2.4 | 新增 `hub-index.ts` 统一入口 | 2d | ✅（G-5 已补齐，2026-08-08）`projects/mcp-server/src/hub-index.ts` :3008，13 工具聚合 data/injector/ragservicer |
| 2.5 | hub-index systemd unit | 0.5d | ✅（2026-08-08）`deploy/systemd/infrax-hub-index.service` 生产已部署 |

**Phase 3: SkillHub + 多市场发布（1 周）**

| # | 任务 | 估计 | 状态 |
|:---:|------|:---:|:---:|
| 3.1 | SKILL.md + mcp-config.json 编写 | 1d | ✅（2026-08-16 修正：与 §6.1 产物重叠，`ai-skills/skills/{7 组}/SKILL.md` + `shared/mcp-config.json` 均已存在） |
| 3.2 | OpenAPI 3.1 自动生成（从 hub-index.ts） | 1d | ✅（2026-08-16）`src/openapi-spec.ts`（源码解析 13 工具）+ `GET /openapi.json`（hub :3008，鉴权豁免）+ `npm run gen:openapi` → 产物 `ai-skills/openapi.json`；本地验证 openapi 3.1.0 / 13 tools / paths=/health,/mcp/message / 无鉴权 200 |
| 3.3 | ClawHub 发布 | 0.5d | ✅（2026-08-16 用户裁定**跳过外部发布**，交付物已就绪可随时发布） |
| 3.4 | MCP Hub (mcp.so) 注册 | 0.5d | ✅（2026-08-16 用户裁定**跳过外部注册**，`ai-skills/openapi.json` + `/openapi.json` 端点已就绪可随时接入） |
| 3.5 | 其他市场适配 | 1d | ✅（2026-08-16 修正：与 §6.2 产物重叠，5 IDE 插件发布物已存在：`.claude-plugin` / `cursor` / `opencode` / `codex` / `openclaw`） |

> **发布物**（§6.1，随 Phase 2-3 实施）：ClawHub SKILL / MCP Hub = P0；OpenAI GPT Store / Cursor / Claude / GitHub = P1。非功能目标（§8）：hub 启动 <5s、查询 P95<2s、交易 P95<10s、TEE 签名 <500ms。
>
> **Phase 3 完成（2026-08-16，用户裁定跳过 3.3/3.4 外部市场发布）**：本地产物全部就绪（7 组 SKILL + 5 IDE 插件 + OpenAPI 3.1），ClawHub/mcp.so 外部发布留待有客户/市场诉求时再执行，交付物无需变更。

> **决策确认（2026-08-15 用户）：TEE 维持延后，维持现状**。2.1~2.3 继续 P3 延后（待 TEE 环境审批）；软件侧以真 TSS 分片签名（E-4，cggmp21，签名全程无完整私钥重建）为当前安全基线，已满足现有 B 端需求（AIHunter/PocketX），无需软件替代方案（云 KMS/HSM 等）；如有 B 端客户提出 TEE 合规要求再行评估。

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

- [x] ① 四服务探活矩阵实测（9112/9113/9721/9120，`code==0`）— 核对通过（data/injector 走 `/health`、ragservicer 走 `/api/v1/health`（Blueprint 前缀）、ml-service 独立服务器 `/health`，均 active 且 200）
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
- [x] ⑥ SDK 版本管理方式（PyPI/npm 发布 vs 仓库内引用）决策 — **✅ G-9 已发布**：npm `@0xinfrax/infrax-dk@0.5.0` 已发布 registry 验证（2026-08-08，含 `infra.ml.*` ml-service 实时推理命名空间 + `infra.chainRpc.*` chain-rpc 网关命名空间 `call/broadcast/status/health` + `chainRpcBroadcastKey` 独立广播 key）；**2026-08-08 追加发布 0.5.1**（MQ-10 补充 D：`walletAddress`+`walletSign` 钱包签名鉴权，HttpClient per-request headers，`wallet.*` fail-closed）——registry 已验证 latest=0.5.1；PyPI `lightrag-client 2.0.0` 已于 **2026-08-11 发布**（连同 `infra-data-client 0.2.0`，pypi.org 验证 + `pip install` 测试通过）

**9.7 差距报告（2026-08-06 审查输出，G-1~G-9 已按序实现）**

> 首轮 9.7 审查修复 4 项（D7/D8/injector namespace/rag `_write_env` 锁，均已在生产实测闭环）；本轮按 G-1→G-4→G-3→G-8→G-7→G-6→G-2→G-5→G-9 顺序实现 9 项（本地验证通过，部署见 9.3）。G-9 中 PyPI 发布已于 **2026-08-11 完成**（lightrag-client 2.0.0 + infra-data-client 0.2.0）。

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
| G-9 | 低 | SDK 未发布 npm/PyPI；Flask 无自动 OpenAPI | 外部获取 SDK 需 clone 仓库 | ✅ **完成**：npm `@0xinfrax/infrax-dk@0.5.0` 已发布（registry.npmjs.org 已验证 main/types/engines；0.5.0 含 `infra.ml.*` 9 方法 + `infra.chainRpc.*` 4 方法，2026-08-08）；injector `/openapi.json`（10 paths）+ ragservicer `/api/v1/openapi.json`（15 paths）已上线生产（免 key 访问实测 200）；PyPI `lightrag-client 2.0.0` + `infra-data-client 0.2.0` 已于 **2026-08-11 发布**（pypi.org 验证通过） |

**9.7 审查结论**：四服务对外集成面与 `SERVICE_ENDPOINTS_OBSERVABILITY.md` 一致；统一鉴权契约（app_auth）、错误体（data D2）、数据面契约（7.2 详细核对表）均已闭环；差距项 **G-1~G-9 全部实现**（G-9 全闭环：PyPI 已于 2026-08-11 发布 lightrag-client 2.0.0 + infra-data-client 0.2.0；本轮提交见 git log）。**9.7 首轮修复提交**：`0f6d3d5`（D7/D8）、`1ddcc97`（injector namespace）、`1cf5a4d`（rag _write_env 锁）。

### 9.8 区块链栈 / 平台集成需求（2026-08-06 全量盘点，B 端需求 9/10/11）

> **盘点结论**：data/rag/MCP/SDK 数据栈已完整（鉴权 + admin API Keys 面板 + SDK v0.3.0 + 文档）；**区块链栈（MPC/Vault/Session Key/WAAS/Payment/DC）未达可发布状态**——payment/vault 运行期无鉴权、mpc 验证码硬编码（P0 安全缺口），另有 dc_tokens 端点缺失、session-key 未部署、web subscription 代理缺失、admin 缺用户/套餐/订单页等功能缺口。
> **决策（2026-08-06 B 端确认）**：① 先修 P0 安全 + P1 功能缺口，完成后统一更新 SDK/MCP 并发布文档；② 鉴权复用统一契约（Bearer/X-API-Key/X-Service-Key 三选一）+ admin 面板统一签发 key（与 data 栈一致，Node 服务新增共享鉴权中间件）。
> 状态标记同前：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办

**9.8.1 需求 9：TEE（MPC 钱包）与 Session 签名**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|:---:|
| B-1 | MPC 邮箱验证码：`projects/mpc/server.ts` L228 硬编码 `888888` → `crypto.randomInt` 6 位（waas `mpcRoutes` 同步） | ✅ `148cc42`（mpc + waas 均 randomInt） | P0 |
| B-2 | MPC 服务接入统一鉴权契约（当前 15 REST 端点无 key 鉴权） | ✅ `148cc42`（共享中间件 + `mp_` scope） | P0 |
| B-3 | MPC 是否升级真 MPC/TEE（当前单 EOA 私钥、`shard_count` 恒 1/1、无 TEE 硬件隔离） | ✅ 真 TSS 分片签名已落地（E-4：cggmp21，M1-M4 生产 9200/9201，签名全程无完整私钥重建）；🔲 **TEE 硬件隔离（SGX/Nitro）延后**（2026-08-11 用户决策：先延后，待 TEE 环境审批，与 9.6 Phase 2 排期联动，P3） | P2 |
| B-4 | Vault 运行期接入鉴权：`auth.ts` 已定义 5 种中间件但 `server.ts` 未挂载 → 全部端点裸奔 | ✅ `148cc42`（共享中间件 + `vx_` scope） | P0 |
| B-5 | Vault 功能补齐：`safe_owners` 表建表、`updateSafeOwners` 走链上、多链支持（当前仅 Sepolia）、`GAS_POOL_PRIVATE_KEY` 注入 systemd | ✅ `a0dbc76`（见 §9.8.1-B5 备注：safe_owners 表 + 链上多签 + 4 链 + GAS_POOL，生产 schema 修复 + E2E 9/9） | P1 |
| B-6 | Session Key Engine（:3500）+ MCP 生产部署（已上线：engine :3500 + MCP :3011，per-request stateless transport；session-key 实现完整：Bearer + EIP-712 + 白名单 + Redis 锁） | ✅ `414248c`（engine :3500 + MCP :3011 per-request stateless transport；E2E 401/403/200 + MCP initialize 200/7 工具全通） | P1 |

> **B-5 备注（已完成）**：`multiSigService.ts` 新增 `SAFE_MANAGEMENT_ABI` + `SENTINEL_OWNERS` + `parseOwners`/`computeOwnerOps`/`encodeOwnerOp`；`updateSafeOwners` 改为生成 Safe owner 管理交易（addOwner/removeOwner/changeThreshold，`to=safeAddress` self-call）逐条 propose 为 `safe_transactions`（链上 nonce，RPC 不可达 fallback DB MAX(nonce)+1），可选 `signature` 自动 confirm；`createSafe`/`executeTransaction` 成功后同步写/回写 `safe_owners`；`CHAIN_CONFIG` 扩展 4 链（11155111/1/56/8453，Sepolia 沿用历史 Safe 地址，其余官方 Safe v1.4.1）。生产部署：GAS_POOL key 注入 `override.conf`；**生产 schema 修复**（旧 `safe_owners` id=integer → drop 重建 UUID + backfill 17 行；`safe_signatures` 旧 schema 无 `safe_tx_hash` → 重建；`safe_transactions` 补 `executor_id/executed_at/tx_hash/error_message`）；E2E 全绿 9/9（4 链 createSafe、owners ADD propose、safe 详情 tx 可见、no-op 不产生 tx）。注：GAS_POOL 各链余额为 0，createSafe 当前落 pending（代码路径已验证，链上部署待充币后生效）。

**9.8.2 需求 10：WAAS / RPC / 交易广播服务封装**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|:---:|
| B-10-1 | Payment 服务接入统一鉴权（`server.ts` 仅 `express.json()+cors`，**全部端点无鉴权**） | ✅ `148cc42`（共享中间件 + `px_` scope，E2E 直连 200/非法 401/跨 scope 401） | P0 |
| B-10-2 | Payment x402/pay 伪实现（返回随机 tx_hash）→ 接真实签名/广播链路 | ✅ 已消除（MQ-12 T-6 关停伪支付路径；MQ-13 a2a 真实两阶段链上验 tx 入账；wallet-mcp payment 工具已迁移 :9132）；✅ **平台 :9132 已自配凭证启用 x402（D-2 闭环，2026-08-12 核验）**：`open-external.conf` `X402_ENABLED=true` + `X402_PAY_TO=0x52Ec…8e06` + `X402_PRICE_WEI=1e15`（0.001 ETH, oxachain），`/payments/info` rails.x402:true；**各 B 端实例 x402 rail 由实例自配凭证启用（D-2，2026-08-11 决策：平台只提供通道与工具，不代 B 端配凭证）** | P1 |
| B-10-3 | dc-index `dc_tokens` 工具调 `/api/v2/data/tokens` → 必失败 | ✅ 双修：① MQ-3 dc 已补 `GET /api/v2/data/tokens`（okx_token_snapshots 最新快照，见 §9.8 MQ-3）；② 根因 `DC_API_KEY` 未配置时静默回退 `test-key` → DC 按 `requireDcApiKey` 必 401——dc-index/market-index 改 fail-fast 明确报错，生产 `infrax-dc-mcp.service.d/dc-api-key.conf` 注入真实租户 key，模板 `deploy/overrides/templates/dc-mcp-key.conf.template`；本地 E2E：无 key → 明确 isError，有 key → 正常请求 | P1 |
| B-10-3b | dc `events/stats/health` 对 152GB events 表全表 COUNT/GROUP BY 卡死 pg-pool（曾拖垮 dc 服务） | ✅ 生产修复（`4417ba9`）：stats/health 改读 `event_checkpoints.event_count`（collector 每批增量维护，O(1)，实测 0.1s/0.02s 秒回，uniqueTx 停用）；`idx_events_block_number` 已加 migration + 生产 CONCURRENTLY 构建（被 64min VACUUM 阻塞，完成后无过滤 `ORDER BY block_number DESC` 走索引）；**2026-08-12 补修**：该索引曾变 INVALID（indisvalid=f）→ 默认 /events 路径退化全表扫描，`REINDEX INDEX CONCURRENTLY` 修复（33min）；v2/v3 events 双键 `ORDER BY block_number DESC, event_id ASC` 在 LIMIT 为绑定参数时计划器无法 top-N、Sort 全量排序匹配集（reclassifier 积累后超时）→ 改单键 `ORDER BY block_number DESC`（`3f2a9ce`），分类/无过滤查询全部索引直达毫秒级 | P1 |
| B-10-4 | 通用 RPC 转发代理端点（WAAS/DC 均无 `eth_sendRawTransaction` 类转发；仅 collector :9101 `POST /api/v1/relay` 广播最完整） | ✅ **chain-rpc 网关已承担**（B-10-6 盘点确认）：读 `/v1/rpc/:chain`（白名单 + raw JSON-RPC 透传，viem/ethers 可直连）+ 广播 `/v1/broadcast/:chain`（广播 key 隔离）；dc/waas/mpc/collector/vault 已全部收敛 | P1 |
| B-10-5 | WAAS `paymentRoutes`/`mpcRoutes` 已定义未挂载 → 确认并挂载 | ✅ 已解决：遗留 `routes/paymentRoutes.ts` / `routes/mpcRoutes.ts` / `services/mpcService.ts` **已删除**，支付功能移交 payments 引擎、MPC 为独立服务（waas/index.ts L26 注明） | P1 |
| B-10-6 | 交易广播链路统一：collector relay / waas `/internal/send-tx` / dc 余额 RPC 盘点并文档化 | ✅（2026-08-11 盘点 + vault 收口，commit `e3dd19c`）——见下方「B-10-6 广播链路盘点结论」 | P2 |

**B-10-6 广播链路盘点结论（2026-08-11）**

全站链上访问已统一收敛 **chain-rpc 网关（:9130）为唯一入口**（读 `/v1/rpc/:chain` + 广播 `/v1/broadcast/:chain`，读/广播独立 key 隔离，网关不可用直接抛错）：

| 服务 | 读路径 | 广播路径 | 状态 |
|---|---|---|---|
| waas :9109 | `GatewayProvider` → `/v1/rpc/:chain`（读 key） | `GatewayProvider` → `/v1/broadcast/:chain`（广播 key，`/internal/send-tx` Gas Pool 交易） | ✅ |
| mpc :9104 | `GatewayProvider` → `/v1/rpc/:chain` | `GatewayProvider` → `/v1/broadcast/:chain`（TSS 签名后广播） | ✅ |
| dc :9102 | `rpcCall()` → `/v1/rpc/:chain`（余额 eth_getBalance 等） | —（只读） | ✅ |
| collector :9101 | — | `relayer.ts` → `/v1/broadcast/:chain`（`POST /api/v1/relay`，唯一广播入口） | ✅ |
| vault :9107 | **2026-08-11 收口**：`GatewayProvider`（ethers）+ viem `http(…/v1/rpc/:alias)` raw 头（读）；广播走 `GatewayProvider` `/v1/broadcast/:chain`；未配置 `CHAIN_RPC_URL` 回退直连（开发环境） | ✅ 本次收口 |

关键约定：① **禁止直连上游 RPC**（仅未配置网关的开发环境回退）；② 广播必须走 `/v1/broadcast`（读 key 永远无法触达）；③ 网关 key 由服务端签发（`CHAIN_RPC_READ_KEY` / `CHAIN_RPC_BROADCAST_KEY`），不入 git。

**9.8.3 需求 11：用户端套餐/apikey 界面 + 管理后台查看与配置**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|:---:|
| B-11-1 | web `server.js` 代理表补 `/api/v2/subscription`（waasUpgradePlan 点击无响应） | ✅ `414248c`（API_ROUTES 新增 `/api/v2/subscription` → waas:9109；生产 `/api/v2/subscription/plans` 200 返回 waas 真实套餐 JSON） | P1 |
| B-11-2 | 用户端套餐购买页：套餐硬编码 HTML → 服务端下发（waas/dc plans） | ✅ **MQ-12 T-5（2026-08-10）**：[waas.js](projects/web/modules/waas.js) `waasUpgradePlan`——free 直通 / chain escrow 轮询 / fiat sessionUrl / x402 verify，三 rail UI 走通 | P1 |
| B-11-3 | 用户端展示/获取 `dx_`/`mx_`/`lr_` key 界面（打通 data 与区块链两套 key 体系） | ✅（2026-08-12 生产部署 + E2E：web「🗝️ My Keys」面板 [datacenter.js](projects/web/modules/datacenter.js) + data `/api/v2/data/my-keys` 钱包签名鉴权 [wallet_auth.py](projects/data/app/wallet_auth.py)——create/list/rotate/owner 删除/重放语义闭环，测试数据已清理） | P1 |
| B-11-4 | admin 用户管理页（当前无传统注册/登录体系，仅钱包 connect + MPC 邮箱注册） | ✅（2026-08-12 生产部署 + 验证：[Users.tsx](projects/admin/src/pages/Users.tsx) 聚合 waas/dc/mpc 用户，`GET /api/v2/admin/users`） | P1 |
| B-11-5 | admin 套餐管理（CRUD）页 | ✅（2026-08-12 生产部署 + 验证：[Plans.tsx](projects/admin/src/pages/Plans.tsx) + `GET/POST/PATCH/DELETE /api/v2/admin/plans`，waas/dc billing_plans 覆盖表 CRUD，测试数据已清理） | P1 |
| B-11-6 | admin 订单 / 支付管理页 | ✅ **MQ-12 T-8（8544feb）**：[Orders.tsx](projects/admin/src/pages/Orders.tsx) + `GET /api/v2/admin/orders`（listIntents 分页/status/subscriber 过滤） | P1 |
| B-11-7 | admin 孤儿页面（Tenants/Transactions/Webhooks/Sweeps/RpcPool/System）挂进导航或清理 | ✅ 全部挂载：`App.tsx` NAV+Route 新增 6 页；[System.tsx](projects/admin/src/pages/System.tsx) 改为消费 `/admin/status` 服务健康矩阵（原 `/admin/system` 端点不存在）；[RpcPool.tsx](projects/admin/src/pages/RpcPool.tsx) 适配现有 `/admin/rpc`（admin_rpc_config CRUD），server 补 `DELETE /api/v2/admin/rpc/:id` | P2 |

**9.8.4 SDK / MCP / 文档（前置：P0/P1 完成后，B 端需求"更新 SDK/MCP 且发布文档"）**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|:---:|
| B-12-1 | 区块链服务统一鉴权 + admin 面板统一签发管理（key 前缀按服务；当前 data `dx_`/mcp `mx_`/rag `lr_` 已统一，区块链栈未接入） | ✅ 服务端鉴权收口（C-1~C-5）+ admin 统一签发：[ApiKeys.tsx](projects/admin/src/pages/ApiKeys.tsx) 签发表新增 5 链栈 option（payment `px_`/vault `vx_`/mpc `mp_`/chain-rpc `cr_`/waas `wa_`，CHAIN_SCOPE_META 前置表）；「区块链栈 keys」卡片：签发/启用/轮换/删除 | P1 |
| B-12-2 | SDK 扩展 waas/dc/vault/session 方法并发布（`@0xinfrax/infrax-dk` 当前 0.3.0 仅 data） | ✅ **D-1/D-2（7a0e333）**：infrax-dk 0.7.1（14 类全导出 + dc.balance）+ 7 独立包 **全部 npm 已发布**（2026-08-12，`0xinfrax` org token：infrax-dk@0.7.1 + waas/vault/dc/market/chain-rpc/payments/data-sdk@0.1.0，registry 消费验证通过） | P2 |
| B-12-3 | MCP 工具更新（hub-index 聚合 + dc_tokens 修复 + mpc/sk 工具鉴权） | ✅ 三部分全完成：hub-index 聚合（:3008 13 工具，`infrax-hub-index.service`）✅；dc_tokens 修复 ✅ MQ-3；mpc/sk 入站鉴权 ✅ MQ-10 补充 D（`inboundAuth` 7 HTTP MCP） | P2 |
| B-12-4 | 文档发布：`docs/API_ACCESS.md` 更新为真实生产端口/状态（当前为 v0.5.0 旧布局），各区块链服务接入文档 | ✅ [API_ACCESS.md](docs/API_ACCESS.md) v0.7.0-20260811：真实生产端口矩阵（9101~9132 + MCP 3008/3011/3012/3013）+ 全服务 REST 端点 + MCP 工具速查 + SDK 模块覆盖 + curl 测试 | P2 |

**9.8.5 调研补充（2026-08-07，B 端三问对照：RPC / okxchainos / TEE·MPC·Session）**

> 本轮对照 B 端三个问题（对外 RPC 服务是否实现、okxchainos 数据是否正常获取、TEE/MPC 与 Session 是否完善且提供 SDK）的代码级复核结论。状态标记同前：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办

| # | 发现 | 代码证据 | 状态 |
|:---:|---|---|:---:|
| R-1 | **SDK `wallet.rpc()`（通用 RPC 转发代理）服务端不存在**：`POST /api/v2/wallet/rpc` 无路由 → 调用必 404（B-10-4 实锤） | `projects/sdk/src/index.ts` `rpc()` vs `projects/waas/routes/walletRoutes.ts`（仅 create/import/balance/address/transactions/token-info/token-balance/nfts/:chainId/custom-token*） | ✅ 已收口：MQ-1（2026-08-07）waas `POST /api/v2/wallet/rpc` 通用 RPC 转发代理落地，SDK `wallet.rpc()` 返回真实链上结果（B-10-4 关闭）；MQ-10 起由 chain-rpc 网关统一承载 |
| R-2 | **SDK WalletAPI 与后端契约系统性错位**：`wallet.send/simulate/sweep/txStatus` 指向不存在端点；waas 真实端点为 `/api/v2/tx/*`（txRoutes）与 `/api/v2/internal/*` | `projects/sdk/src/index.ts` L174-179 | ✅ 已收口：MQ-2（2026-08-07）SDK WalletAPI 对齐 waas 真实端点（send/simulate/sweep/txStatus/rpc） |
| R-3 | **okxchainos 新栈仅 2 类快照**：`okx_hot_tokens` + `okx_index_prices`（60s 落 raw_snapshots，自旧栈 collector `COLLECTOR_URL` 拉取）；candles 仅旧栈落库；SDK MarketAPI 14 方法按需直连 collector 不落库 | `projects/data/app/collectors/okx_chainos.py`；`okxMarketScheduler.ts` | ✅ 已收口（2026-08-12）：SDK `market.*` 已封装并发布（`@0xinfrax/market-sdk@0.1.0` + infrax-dk MarketAPI，数据面直连 collector :9101 为设计，MQ-16 订阅面已补） |
| R-4 | **okxchainos 生产出数无实证**：仓库无 data `.env`（生产值不可验证），`.env.example` 的 `COLLECTOR_URL` 示例当时指向旧服务器 43.156.99.215（2026-08-11 核查：L87 已改指 `43.163.105.172:9101`，旧服务器地址已彻底移除，见 §2 旧服务器行）；需实测 `/snapshots?type=okx` 与 collector `okx_token_snapshots` 表 | `.env.example` L87-88；本文件 §2 旧服务器行 | ✅ 已实测闭环（2026-08-07，okxchainos 数据实时出数正常，key 配置完整）；`.env.example` COLLECTOR_URL 已更新（2026-08-11） |
| R-5 | **MPC SDK 封装不完整**：infrax-dk `MPCAPI` 仅 5/15 方法（send-code/register/recover/status/createWallet），签名/会话/交易/合约读写未封装 | `projects/sdk/src/index.ts` L270-277 vs `projects/mpc/server.ts` | ✅ 已收口：MQ-7（2026-08-07）infrax-dk `MPCAPI` 5→15 方法全端点封装；另有独立包 `@0xinfrax/mpc-sdk`（16 方法，0.3.0） |
| R-6 | **Session Key 额度校验未实现**：`maxPerTx/maxTotal/totalSpent` 无校验，`addSpent()` 无调用点，`quota_exhausted` 不可达（PRD S-05"额度三重校验"实为两重）；`expireStale()` 过期清理未接线 | `session-key/packages/server/src/services/execution-service.ts` L30-40；`session-repo.ts` L59-63 | ✅ 已收口：MQ-4（2026-08-07）三重额度校验落地（`addSpent` 接线、`maxPerTx/maxTotal` 真实校验、`quota_exhausted` 可达）+ `expireStale()` 过期清理接线 |
| R-7 | **Session Key PRD 未定稿**（v1.0 Draft）+ 声明的集成测试文件不存在（全仓无 `*.test.ts`） | `docs/SESSION_KEY_ENGINE_PRD.md` | ✅ 已收口：MQ-5（2026-08-07）PRD v1.0 已标 Released；集成测试已补齐 |
| R-8 | **session-key 四包未发布 npm**（`@0xinfrax/session-key-core/evm/client/server` 均 0.1.0、`workspace:*`、无 publishConfig）；infrax-dk 发布记录矛盾（SDK_INTEGRATION.md 0.3.0 vs DELIVERY_SUMMARY.md 0.2.0）；~~5 个 HTTP MCP（dc/wallet/mpc/sk/hub）入站鉴权裸奔（仅 hub-index 有鉴权）~~ | 各 `package.json`；`docs/MCP_USAGE.md` L57 | ✅ 已收口：四包已发布（MQ-6）；MCP 入站鉴权已全部闭环（MQ-10 补充 D：7 个 HTTP MCP 均挂 `inboundAuth`，no-key 401 / bridge 200） |

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
| C-6 | **图谱注入无语义去噪**：新闻/链上/OKX 源仅去重+截断，广告/重复公告直接进 LightRAG | `projects/knowledge-injector/injector/*.py` | ✅（MQ-8） |
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

> 注：okx `price_change_24h` numeric overflow 已修复 ✅（`a925065`，生产已 ALTER）；DS-14 Python SDK 已交付 ✅（`8e92921` + tag `v0.1.0`；**v0.2.0 于 2026-08-08 新增 `get_ml_predictions`**）；R-4 okx 生产出数已实测闭环 ✅。

**9.8.8 其他微服务需求补充（完整规格，2026-08-07，B 端需求：再补其他微服务）**

> 其他微服务 = 区块链栈（waas/dc/mpc/payment/session-key）+ 数据相关微服务（collector/knowledge-injector）。将 R 项、C-6 及 B-10 关键项细化为可执行需求（MQ 编号）。

| 编号 | 需求 | 契约 | 验收标准 | 优先级 |
|:---:|---|---|---|:---:|
| MQ-1 | **通用 RPC 转发代理**（R-1 / B-10-4）：waas 新增 `POST /api/v2/wallet/rpc`，收编 SDK `wallet.rpc()`（现 404） | `POST /api/v2/wallet/rpc` `{chain, method, params[]}` → 转发对应 RPC 节点，返回标准 JSON-RPC `{result/error}`；鉴权沿用统一契约 | SDK `wallet.rpc()` 返回真实链上结果；未授权 401 | ✅ P1 |
| MQ-2 | **SDK WalletAPI 契约对齐**（R-2）：`wallet.send/simulate/sweep/txStatus` 由不存在端点改为 waas 真实 `/api/v2/tx/*`；**钱包签名鉴权**（MQ-10 补充 D）：`InfraXConfig` 增 `walletAddress`+`walletSign`，`WalletAPI` 自动生成 `x-wallet-address/x-wallet-signature/x-wallet-timestamp`（EIP-191），HttpClient 支持 per-request headers，未配置时 fail-closed 报错 | SDK 方法 → waas `txRoutes`/`walletRoutes` 对应端点（参数/响应按 waas 契约；签名头走 authenticate） | E2E 各方法 200 且返回真实 tx 数据；生产实测带签名 balance `code 0`、未配置时明确报错 | ✅ P1 |
| MQ-3 | **dc `tokens` 端点补全**（B-10-3）：MCP dc-index 的 `dc_tokens` 调 `/api/v2/data/tokens` 必 404——dc 补端点或工具改接 `/plans` `/chains` | dc 新增 `GET /api/v2/data/tokens`（返回租户链/计划明细）或 dc-index 工具改接现有端点 | MCP `dc_tokens` 调用返回真实数据、不再 404 | ✅ P1 |
| MQ-4 | **Session Key 额度三重校验落地**（R-6）：execution-service 接 `addSpent()`，`maxPerTx/maxTotal` 真实校验，`quota_exhausted` 可达；`expireStale()` 过期清理接线 | 超 maxPerTx/maxTotal 拒绝执行并返回 `quota_exhausted`；过期 key 定时清理 | 构造超限调用 → 拒绝；过期 key 不再可用 | ✅ P1 |
| MQ-5 | **Session PRD 定稿 + 测试补齐**（R-7）：PRD v1.0 发布（去 Draft），补声明缺失的集成测试 | PRD 标注 Released；全仓补充 `*.test.ts` 覆盖执行/额度/过期 | PRD 非 Draft；测试可运行通过 | ✅ P2 |
| MQ-6 | **session-key 四包发布 + MCP/SDK 鉴权**（R-8）：发布 `@0xinfrax/session-key-core/evm/client/server` 至 npm；5 个 HTTP MCP（dc/wallet/mpc/sk/hub）入站鉴权；修正 SDK 发布记录矛盾（0.3.0 vs 0.2.0） | npm publish（去 `workspace:*` 补 publishConfig）；MCP 入站校验 `X-Service-Key`/Bearer | `pip/npm` 安装成功；未授权 MCP 调用 401；文档记录一致 | ✅ P2（2026-08-08 四包发布收口：core/client/evm@0.1.0 已在 registry + server@0.1.0 补发；消费者验证发现 evm 顶层读 env 崩溃 → **evm/server bump 0.1.1** 懒加载 RPC 配置修复后重发，registry 验证 evm import 无 env 不崩；server 为服务启动包（顶层 `start()`，需部署 env），core/client 不受影响） |
| MQ-7 | **MPC SDK 扩展**（R-5 / B-12-2）：infrax-dk `MPCAPI` 由 5/15 方法扩至全端点（签名/交易/合约读写/余额/gas） | SDK 方法对齐 mpc server 15 端点（`/api/v2/mpc/*`） | SDK 各方法 E2E 200 真实返回 | ✅ P2 |
| MQ-8 | **图谱注入语义去噪**（C-6）：knowledge-injector 注入前过滤广告/重复公告/低价值噪音（黑名单规则 + 相似文本去重） | 注入器加 `denoise` 步骤（规则表 + 相似度阈值），注入 doc 数显著下降 | 图库噪音文档比例下降（抽样对比） | ✅ P2 |
| MQ-9 | **payment/mpc 路由挂载确认**（B-10-5）：waas `paymentRoutes`/`mpcRoutes` 已定义未挂载——确认并挂载 | `server.ts` 挂载两路由；端点可访问 | 对应端点路由可达（非 404） | ✅ P1 |
| MQ-10 | **链上 RPC 网关独立化**（2026-08-08 新增，RPC 读+广播从 waas 解耦）：所有中心化服务都需要链上 RPC、不一定需要 waas 钱包管理；现状 RPC 分散在 waas/collector/mpc/dc 4 进程、5 套 URL 来源、3+ 鉴权体系。新建 `projects/chain-rpc` 独立服务，复用 collector `RpcPoolManager` 内核（failover/限流/健康检查/配置合并）+ 补广播，作为全仓唯一链上 RPC 网关 | `POST /api/v2/rpc` `{chain, method, params[]}` → 任意 JSON-RPC 透传（读）；`POST /api/v2/rpc/broadcast` `{chain, rawTx}` → `eth_sendRawTransaction`/Solana `sendTransaction` 返回 txHash；`GET /api/v2/rpc/health`、`GET /api/v2/rpc/chains`（monitor 只读）；鉴权=统一契约（Bearer/X-API-Key/X-Service-Key）+ **读写分离 scope**：读=普通 service key（rpc scope）、广播=独立 key（rpc_broadcast scope）且强制限流；waas `/api/v2/wallet/rpc` 保留外层钱包签名、内部转发网关 | 全链（sepolia/eth/base/bsc/oxa/Solana）read+broadcast E2E 通过；权限矩阵验证（读 key 广播→403）；waas 兼容端点不断；collector/mpc/dc 只读与广播收敛到网关 | ✅ P1（2026-08-08 开发完成 + **生产已部署**，T-1~T-8 ✅（T-7 为 waas 收敛+评估，dc/mpc 后续）、见下方实施 Tasks） |

> **MQ-1~MQ-9 全部完成 ✅（2026-08-07 本地开发完成）**：waas 新增 `POST /api/v2/wallet/rpc` 通用 RPC 转发代理（`getRpcUrl` + `rpcProxy`，JSON-RPC 透传）+ `sweepNative`；SDK `WalletAPI` 对齐 waas 真实端点（send/simulate/sweep/txStatus/rpc）；dc 新增 `GET /api/v2/data/tokens`（`okx_token_snapshots`）；session-key execution-service 三重额度校验（maxPerTx/maxTotal/addSpent + expireStale 接线，crypto import 修复）+ 11 单测全绿 + PRD Released；session-key 四包发布配置（`workspace:*`→`^0.1.0` + publishConfig）+ 5 个 MCP 入站鉴权（`mcp-auth.ts` `inboundAuth`）+ SDK 发布记录修正 0.3.0；infrax-dk `MPCAPI` 5→15 方法（unlockSession/lockSession/sessionStatus/balance/signMessage/signTypedData/sendTransaction/contractRead/contractWrite/gasEstimate）；knowledge-injector 注入前语义去噪（`injector/denoise.py` 黑名单正则 + 4-gram Jaccard 相似去重，窗口 200，阈值 0.86，`DENOISE_ENABLED` 可关，9 单测 + 121 全量测试全绿）；waas payment/mpc 路由确认为死代码已删除（生产独立服务 :9106/:9104 active）。**排期项**：~~session-key 四包 npm 实际发布~~（✅ 已发布，见 §9.8 MQ 表）、~~lightrag-client / infra-data-client PyPI 发布~~（✅ 已于 2026-08-11 发布，见 G-9）、**ML 历史回填已全部完成 ✅（2026-08-08）**：阶段一 bolt/moirai/tree（不停服，+4853/+4044/+1723）+ 阶段二 timesfm（停服窗口，实测 36min，+4856）；`ml_predictions` 现 14524 行 / 30 符号 / 2024-09-09 起（脚本 `scripts/backfill_ml_history.py` + `scripts/ingest_backfill.py`，详见 DS-15 行）。

**MQ-10 实施 Tasks（链上 RPC 网关独立化，2026-08-08 方案定稿 → 本地开发 + 生产部署完成）**：
- [x] T-1 **服务骨架**：新建 `projects/chain-rpc/`（Express + tsx + config + logger + 双 key 鉴权），端口 **:9130**
- [x] T-2 **内核迁移**：迁移 collector `RpcPoolManager` + `rpcPoolConfig`（`rpc-pool.json` 基线 27 端点 + 链 env URL + `INFRAX_RPC_POOL` 覆盖）+ 补广播 `eth_sendRawTransaction`；链覆盖 sepolia/ethereum/bsc/base/oxa/solana
- [x] T-3 **端点**：`POST /v1/rpc/:chain`（读，白名单 20 EVM + 10 Solana 方法透传）、`POST /v1/broadcast/:chain`（广播返回 txHash+receipt）、`GET /v1/status`（脱敏池状态）、`GET /health`（公开）
- [x] T-4 **鉴权分级**：读/广播独立 router 挂载（读 key 无法触达广播）；`CHAIN_RPC_READ_KEY`（读）/`CHAIN_RPC_BROADCAST_KEY`（广播）；可选外部签发 key 校验（data `/api-keys/verify`，scope=rpc/rpc_broadcast）；广播仅白名单方法
- [x] T-5 **waas 兼容**：`rpcProxy` 配置 `CHAIN_RPC_URL` 后优先转发网关（读 key），网关不可用回退直连单 URL；`wallet.rpc()` 行为不变，E2E 返回真实区块号
- [x] T-6 **SDK**：infra-dk 新增 `infra.chainRpc` 命名空间（call/broadcast/status/health），独立 HttpClient（`chainRpcUrl`/`chainRpcApiKey`）
- [x] T-7 **配置收敛（部分）**：**waas 生产已启用网关转发（2026-08-08）**——unit 注入 `CHAIN_RPC_URL` + 读 key，`rpcProxy` 信封解析修复（chain-rpc 统一信封 `data.result`），内联 E2E 走网关 200（sepolia 区块号 / eth 别名 chainId）；chain-rpc 补请求日志中间件（访问可观测，不记 headers）。**评估结论**：dc `rpcCall` 仅 tx receipt 一场景（低成本）建议先收敛；collector relayer 广播可选收敛（collector 批量扫描保持自建池——网关端点同源，避免加一跳）；mpc `getProvider`（ethers 直连，balance/tx/合约/gas 多端点）中成本，后续候选
- [x] T-8 **部署验证**：**生产部署完成（2026-08-08，43.163.105.172 systemd `infrax-chain-rpc` :9130，开机自启）**——全 6 链 read E2E 通过（sepolia 区块号 / eth 别名 → ethereum / solana getHealth+getSlot）；鉴权矩阵 401（未授权）/403（写方法白名单）/401（读 key 打广播）通过；广播 key 链路可达（无效 rawTx 502 上游错误）；`/v1/status` 6 链健康、端点脱敏；真实密钥已生成仅存生产 unit（`/etc/systemd/system/infrax-chain-rpc.service`），不入 git

**MQ-10 收敛与后续优化方案（2026-08-08 定稿）**：现状——读+广播能力已独立为 chain-rpc 网关（生产 :9130），但消费端收敛未完成：waas ✅（已转发）、dc/collector/mpc 仍各自直连（5 套 URL、无池化/重试/降级）；网关侧仍有能力短板（广播仅 EVM、无 WS/批量、参数硬编码）。收敛原则：**低吞吐 HTTP 读场景优先收敛，批量扫描保持自建池（网关端点同源，避免加一跳 + 限流瓶颈），ethers 深度耦合场景暂缓**。

- [x] **DC-1（✅ 2026-08-08 完成）dc 收敛**：`rpcCall` 优先走网关（`CHAIN_RPC_URL` + 读 key），失败回退直连；覆盖 raw-receipt（`eth_getTransactionReceipt`）+ balance（`eth_getBalance`）两场景；两方法均在网关白名单。生产验证：unit 注入网关配置，balance 5 链走网关 200（chain-rpc 日志确认 `POST /v1/rpc/*`），raw-receipt 走网关 200（pending 分支）
- [x] **DC-2（✅ 2026-08-08 完成）collector 收敛**：relayer 广播（`CHAIN_RPCS` 3 端点硬编码）改走网关 `/v1/broadcast`（broadcast key），失败回退直连；批量扫描 `fetchBlockRange/fetchLogs` **保持自建池**（同源端点，避免加一跳 + 限流瓶颈）。生产验证：unit 注入网关配置，relay 广播走网关（chain-rpc 日志 `POST /v1/broadcast/sepolia 502`）+ 回退直连（collector 日志 `gateway broadcast failed, falling back to direct RPC` + `EVM RPC attempt failed`）
- [x] **DC-3（✅ 2026-08-08 完成）mpc 收敛**：新增 `projects/mpc/gatewayProvider.ts`——继承 ethers `JsonRpcProvider` 重写 `send()`：读方法走 `/v1/rpc/:chain`（读 key）、广播 `eth_sendRawTransaction` 走 `/v1/broadcast/:chain`（广播 key），构造显式传 network 避免 ethers `eth_chainId` 探测；`server.ts` 原 `*_RPC_URL` 直连段整体替换为 `getProvider`（`GatewayProvider` + `CHAIN_IDS` 查 chainId），6 处调用点（原生/ERC20 余额、gas 估算、eth_call、sendTransaction、Contract 读写）自动收敛。生产验证：systemd unit 移除 5 条直连 URL、注入 `CHAIN_RPC_URL/CHAIN_RPC_READ_KEY/CHAIN_RPC_BROADCAST_KEY`；重启后读（`eth_blockNumber`/`eth_getBalance` 200）与广播（无效 rawTx 链上校验错误 400）均命中网关（chain-rpc 日志 `route=rpc`/`route=broadcast chain=sepolia`），网关不可用时直接报错、无直连回退
- [x] **DC-4（✅ 2026-08-08 完成）Solana 广播**：`sendTransaction` 加入广播白名单；`pool.broadcast` 按链选方法（EVM→`eth_sendRawTransaction`，Solana→`sendTransaction`）；`waitReceipt` Solana 用 `getSignatureStatuses` 轮询（confirmed/finalized），EVM 逻辑不变。生产验证：Solana 广播走 sendTransaction（无效 tx 502）、Solana 读 `getSlot` 无回归、EVM 广播无回归；结构化日志 `route=broadcast chain=sol`
- [x] **DC-5（✅ 2026-08-08 完成）WebSocket 订阅**：新增 `/v1/ws` 订阅代理——每客户端连接建一条到上游节点的 WS（`getWsEndpoint`：活跃端点 http→ws(s) 换协议），仅透传 `eth_subscribe`/`eth_unsubscribe`（读 key 鉴权，X-Service-Key/X-API-Key header 或 `?key=`），消息双向转发 + 上游未就绪前客户端消息缓冲（修复订阅请求丢失），客户端断开即关闭上游连接；非订阅方法回 `-32601`，未授权 `4001`、不支持链 `4002`、无活跃端点 `4003`。代码修改点：新增 `src/routes/ws.ts`、`index.ts` 改 `http.createServer(app)` + `attachWs(server, pool)`、`rpcPool.ts` 加 `getWsEndpoint`、`package.json` 加 `ws`/`@types/ws`。生产验证：`eth_subscribe newHeads` 收到订阅 ID + 新块通知 + `eth_unsubscribe=true`，未授权 4001/坏链 4002/非订阅方法 -32601 全部通过，网关日志确认 ws 连接/关闭
- [x] **DC-6（✅ 2026-08-08 完成）批量批处理**：读端点 `POST /v1/rpc/:chain` 支持 JSON-RPC batch（数组请求）——单次 HTTP 完成多条读，降低高频读的请求数；上限 100 条，逐条白名单校验 + 网关调用，按条返回 `{id, result|error}`（错误隔离，单条上游失败不影响其余），空数组 400；日志记录 `batch` 条数。生产验证：3 条 batch（2 成功 + eth_gasPrice 上游 404 被隔离）、混合白名单外方法按条 `-32601`、空 batch 400、单条请求无回归、日志 `{"route":"rpc","chain":"sepolia","batch":3}`
- [x] **DC-7（✅ 2026-08-08 完成）参数可配置化**：健康检查间隔（30s）、退避重试次数（3）、请求超时（15s）硬编码 → env 配置——`CHAIN_RPC_HEALTH_INTERVAL_MS` / `CHAIN_RPC_MAX_RETRIES` / `CHAIN_RPC_REQUEST_TIMEOUT_MS`（config.ts 3 项 → `RpcPoolManagerOptions` 构造参数 → 替换 rpcCall/startHealthChecks 常量）；启动日志打印 `pool params` 便于核对；默认值与现状一致。生产验证：unit 注入 `CHAIN_RPC_HEALTH_INTERVAL_MS=60000` 后启动日志 `pool params: healthInterval=60000ms retries=3 timeout=15000ms`，读请求无回归
- [x] **DC-8（✅ 2026-08-08 完成）链 profile 抽象落地**：新增 `src/services/chainProfiles.ts`——`ChainProfile` 接口（readMethods/healthMethod/healthOk/latestBlockMethod/latestBlockParse/broadcastMethod/receiptMethod/receiptParams/receiptConfirmed）+ EVM/Solana 两 profile + `profileFor(chain)`（先 `normalizeChain` 再查表）；`whitelist.ts` `isReadMethod` 改为查 profile 读方法表、`rpcPool.ts` 5 处 EVM/Solana 特判（`getLatestBlock`/`runHealthChecks`/`broadcast`/`waitReceipt`）改为查表。接入新链类型只需新增 profile + `normalizeChain` 别名，无需改业务分支。生产验证：EVM/Solana 读无回归（`eth_blockNumber`/`getSlot` 200）、白名单拒绝 403、batch 正常
- [x] **DC-9（✅ 2026-08-08 完成）网关可观测**：① 请求日志端点细分——结构化字段 `route`（rpc/broadcast/status）/`chain`（URL 归一化）/`method`（请求体 RPC 方法）；配置项 `CHAIN_RPC_LOG_METHOD`（默认 true）、`CHAIN_RPC_LOG_PARAMS`（默认 false，含地址/哈希）、`CHAIN_RPC_LOG_SKIP_HEALTH`（默认 true）；② 状态脱敏可配置——`CHAIN_RPC_STATUS_URL_MODE` = `none`（默认，现状无 url）/ `host`（仅 host，内部监控）/ `full`（完整 url + query 中 key/token/secret/auth 自动打码 `***`，运维排障）；代码修改点：`src/config.ts`（加 4 个配置项）、`src/services/rpcPool.ts`（`status(mode?)` 支持 url 字段 + `maskUrl`）、`src/index.ts`（日志中间件结构化 + `/v1/status` 传 mode）；默认值下行为与现状一致。生产验证：`CHAIN_RPC_STATUS_URL_MODE=host` 注入后 status 返回 host url；结构化日志 `{"route":"rpc","chain":"sepolia","method":"eth_blockNumber"}`（修复 finish 时 req.path 被路由改写的坑，改用 req.originalUrl）
- [x] **DC-10（✅ 2026-08-08 完成）消费端回退直连移除（无直连原则）**：按「RPC 在网关汇总后再分发，禁止消费端直连上游」落地——waas `rpcProxy` / dc `rpcCall` / collector `relayer.ts` 删除「网关失败回退直连上游」分支，网关不可用/未配置直接抛错（collector 批量扫描 `fetchBlockRange/fetchLogs` 保持自建池，已确认保留）；mpc 见 DC-3（同批移除直连 URL）。生产验证：三服务重启 active；dc balance 5 链读命中网关（chain-rpc 日志 `route=rpc 200`）、collector relay 无效 rawTx 走网关广播（日志 `route=broadcast 502` + rlp 错误透传）、waas 启动正常；生产 unit 已全部注入网关 key
- [x] **DC-10 补充（✅ 2026-08-08 完成）waas 非回退直连 provider 全量收敛（无直连彻底清理）**：waas 全部主路径直连 `ethers.JsonRpcProvider(上游URL)` 改为 `GatewayProvider(chain)` 网关透传——walletService 5 处（getNCBalance/getNCTransactions/getTokenInfo/getTokenBalance/getNFTs）、txService sweepNative 1 处、internalRoutes 4 处（estimate-gas/send-tx/balance/sweep）、saasService withdrawal 广播 1 处、hdWalletService signAndSendTransaction 1 处；删除 `getRpcUrl()` 与死配置 `chainRpc/*RpcUrl`（1rpc.io 等上游 URL）；`rpc-config` 端点改为返回网关 URL、PUT 拒绝运行时切换上游；DB chains seed 清空上游 rpc_url。修复 ethers 6.17 探测坑：构造传 `Network` 实例 + `staticNetwork`，避免低层 `_send` 的 `eth_chainId` 探测打到网关根路径 404（此前导致 getFeeData 失败）；同款修复 mpc `gatewayProvider.ts`。生产验证：waas/mpc active；estimate-gas 返回真实 gasPrice（修复前为 fallback）、internal balance 真实余额；chain-rpc 日志全部 `route=rpc 200`（eth_getBlockByNumber/eth_gasPrice/eth_maxPriorityFeePerGas/eth_estimateGas/eth_getBalance），无 eth_chainId 探测残留；分级 key 验证（读 key 访问广播端点 401、广播 key 通过鉴权）；详见 `docs/CHAIN_RPC_NO_DIRECT_VERIFY.md`
- [x] **性能基准（✅ 2026-08-08 完成）**：见 `docs/CHAIN_RPC_PERF_REPORT.md`——batch 并发修复（DC-6）后方法吞吐 batch×5=89.6、batch×10=85.4 method/s ≈ 网关单发 23.3 的 3.7~3.9 倍；单方法耗时 54-55ms（vs 单发 195ms）；网关单发 vs 直连 +60ms（池化/鉴权/降级一跳代价）
- [x] **MQ-10 补充 A（✅ 2026-08-08 完成）SDK `chainRpc.broadcast` 独立广播 key**：现状 `ChainRpcAPI` 复用单 HttpClient（仅 `x-api-key`=读 key），广播端点只认 broadcast key → SDK 广播能力受限。方案：`InfraXConfig` 增 `chainRpcBroadcastKey`；`ChainRpcAPI` 拆分读/广播两个 HttpClient（读=read key，广播=broadcast key）；未配置广播 key 时 `broadcast()` fail-closed 明确报错；重新编译 dist。**验证**：`npm run build` 通过（dist/index.js 5 处 / index.d.ts 2 处 `chainRpcBroadcastKey`）；本地 Node 实测——未配置 key → `broadcast()` 抛 `chainRpcBroadcastKey not configured`；配置后走独立 broadcastHttp 发起请求（读调用仍走读 HttpClient）。**已发布 npm `@0xinfrax/infrax-dk@0.5.0`**（2026-08-08，registry latest 验证 0.5.0；从 registry 拉包实测含 5 处 `chainRpcBroadcastKey` + fail-closed + 带 key 广播均正常）
- [x] **MQ-10 补充 B（✅ 2026-08-08 完成）chain-rpc MCP 工具（rpc-index）**：mcp-server 新增 `src/rpc-index.ts`（独立进程，仿 mpc-index）——工具 `chain_rpc_read`（POST /v1/rpc/:chain，读 key）、`chain_rpc_broadcast`（POST /v1/broadcast/:chain，广播 key）、`chain_rpc_status`（GET /v1/status）、`chain_rpc_health`；出站网关 key 走 `X-Service-Key`（`CHAIN_RPC_READ_KEY`/`CHAIN_RPC_BROADCAST_KEY`），入站复用 `inboundAuth`（`MCP_API_KEY`）。生产部署：systemd `infrax-rpc-mcp.service`（:3012，仿 infrax-mpc-mcp）+ drop-in override.conf（读/广播 key + `MCP_API_KEY`），`tsc --noEmit` 编译通过、rsync 到生产、daemon-reload + enable --now。**生产验证**：`tools/list` 返回 4 工具；`chain_rpc_read`（sepolia eth_blockNumber）命中网关 `route=rpc 200`（0xae9644）；`chain_rpc_status` 命中 `route=status 200`；`chain_rpc_broadcast` 无效交易命中 `route=broadcast 502`（广播 key 通过鉴权、进入上游 rlp 解析，证明 key 与路由正确）；`chain_rpc_health` 200；入站无 key / 错 key 均 401、有 key 200
- [x] **MQ-10 补充 C（✅ 2026-08-08 完成）ragservicer 健康路径文档修正 + 生产鉴权矩阵复核**：健康路径从文档旧记法 `/health` 统一修正为实际路径 `/api/v1/health`（Blueprint 前缀 `/api/v1` + 路由 `/health`），同步 `docs/SERVICE_API_REFERENCE.md`（鉴权说明 + 端点表）与 `docs/infrax_tasklist.md`（探活矩阵/统一鉴权契约/文档登记），并 rsync 到生产。**代码层零变更**：本地与生产 5 个关键文件（main.py/routes/auth.py/middleware.py/app_auth.py）md5 完全一致，生产行为本就是 `/api/v1/health`。**生产鉴权矩阵 10 项全过**：`GET /api/v1/health` 无 key 200（豁免）、`GET /api/v1/openapi.json` 无 key 200（豁免）、旧路径 `GET /health` 404、业务端点（query）无 key/错 key 401、bridge key 放行（400 参数校验，鉴权通过）、`GET /api/v1/tenants` 无 key/错 Bearer/bridge X-Service-Key 均 403（admin 独占）、正确 admin Bearer 200；`ADMIN_API_KEY`/`RAGSERVICER_API_KEY`/`MONITOR_API_KEY` 生产均 set
- [x] **MQ-10 补充 D（✅ 2026-08-08 完成）WAAS/VAULT 三面鉴权巡检修复**：巡检发现 7 项，全部修复并生产验证——① **wallet-mcp 误锁**：unit 未注入 `MCP_API_KEY` → 全部 401；修复=为 wallet/vault/mpc/session-key/dc 五 unit 统一注入 `MCP_API_KEY=infrax-bridge-...` drop-in override.conf，重启后 wallet/vault/mpc/rpc 均 no-key 401 / bridge 200；session/dc/hub 为 StreamableHTTP 协议（需 `Accept: application/json, text/event-stream` + `MCP-Protocol-Version` 头，406 系协议要求），带标准头验证 no-key 401 / bridge 200——**7 个 HTTP MCP 入站全部闭环**；② **vault-mcp 裸奔**：`vault-index.ts` 挂 `inboundAuth`（L8/L13），编译通过、rsync 生产，验证 no-key 401 / bridge 200（13 工具）；③ **MCP_USAGE §2.2/§10.1** 更新为全部门禁 `inboundAuth` 表格；④ **waas `/api/v2/data/*`**：subscribe/usage/key 挂 `authenticate`（钱包签名）+ 改用 `req.user.walletAddress`（不再信任裸 `x-wallet-address` 头），plans/docs 保留公开目录；验证 usage/key/subscribe 无 key 均 401、plans 200；⑤ **waas `/api/v2/subscription/plans`**：套餐目录无敏感数据保留公开（注释说明）；⑥ **waas `/auth/login`**：硬编码 admin/admin123 → 环境变量 `ADMIN_USER`/`ADMIN_PASS`（config 增 `admin` 段，缺省 fail-closed）；验证 admin123 401 / env 凭据 200 / 错密码 401；⑦ **SDK wallet 鉴权**：`InfraXConfig` 增 `walletAddress`+`walletSign` 回调，`WalletAPI` 每次请求自动生成 `x-wallet-address/x-wallet-signature/x-wallet-timestamp`（EIP-191，消息 `InfraX auth: <ts>`），HttpClient 支持 per-request headers；build 通过；生产实测带签名 balance 返回 `code 0 Success data-ok`、未配置时 fail-closed 明确报错。**遗留说明（✅ 已闭环 2026-08-11）**：wallet-mcp `payment_create/payment_status/x402_pay` 原 404——现 payment 工具已全量迁移至通用支付引擎 :9132（`payment_create→/payments/checkout`、`payment_verify→/payments/verify`、新增 `payment_price`/`payment_balance`/`payment_access`/`mpp_*`；`x402_pay`/`payment_status` 两旧工具已移除）；生产 `infrax-wallet-mcp.service.d/payments.conf` 注入 `PAYMENTS_URL`+`PAYMENTS_API_KEY`（与 infrax-payments unit 一致）→ 重启验证 `payment_price` 返回真实套餐数据（planId=1 → 0.01 ETH/monthly/trialDays=7）
- [x] **MQ-10 补充 E（✅ 2026-08-08 完成）Agent 钱包架构决策（OKX ChainOS 对比调研）**：基于 OKX Agentic Wallet 官方文档（TEE 密钥托管 + 风险预检分级 + spending limit + 近 20 链 + 50 子钱包 + x402 自动支付）与本地三套实现（MPC / Session Key Engine / aa-sdk）代码级核查，得出架构决策。**用户意图澄清（2026-08-08）**：① **MPC 与 Session 是两个独立应用场景、独立微服务**——MPC=用户**不能**直接控制的托管钱包（agent 全权），Session=用户**可直接**控制但自愿共享控制权（授权）；② **用 MPC 替代 TEE 的本质是可用性**：用户无法备份私钥/助记词 → 需邮箱恢复 → MPC 需加上**可行的加密方式**（分片/恢复因子），而非追求硬件隔离；③ **Session 现状未用 Kernel v3（链下声明式）**，需明确是否切换及与 OKX session 的差异。**调研结论**：① 本地"MPC"实为单 EOA + AES 托管（非真 MPC），无 TEE（PRD 明示 SGX/Nitro 硬件不支持 → TEE mock 后置）；② agent 直调签名授权已由授权引擎承担（Session Key Engine :3500 + aa-sdk Kernel v3 session validator 链上强制），TEE 仅为签名介质选项，不作为前置；③ 当前 Session Key 为**链下声明式**（交易 `from`=服务端生成独立 EOA，与用户钱包无链上关联；白名单/额度仅服务端内存校验，链上不可验证；单链绑定）——**不满足"用户钱包 + 共享控制"语义**，需切换 Kernel v3 链上 session validator；④ **决策**：MPC 走"分片加密 + 邮箱恢复"路线（替代 TEE 达成可用性，见 E-2）；Session 走 Kernel v3 链上共享控制（见 E-3）；aa-sdk 三缺口为两条线共用基座（E-1）。排期见 E-1/E-2/E-3/E-4。调研证据：`projects/mpc/server.ts`（L260 单私钥）、`projects/session-key/packages/server/src/services/execution-service.ts`（L16-98 代签广播 + L63 解密私钥）、`projects/aa-sdk/src/session.ts`（L420-472 预检 + L296-349 模块安装）、`docs/AA_SDK_TECH_DESIGN.md`、`docs/INFRAX_HANDOVER.md`
- [ ] **MQ-10 补充 E-1（🔲 2026-08-08 排期）aa-sdk 三缺口补齐（Agent 钱包主线落地）**：以 `@infrax/aa-sdk`（Kernel v3 + EntryPoint v0.7，已迁入 `projects/aa-sdk/`，79/79 测试绿，OxaChain 全栈已生产部署 + 自建 Alto Bundler `43.159.60.46:4338`）为主主线，补齐三个缺口：
  - [x] **E-1a Paymaster 客户端接通（M2）**：✅ **2026-08-09 实现**：`projects/aa-sdk/src/paymaster.ts` `PaymasterClient` 落地 `pimlico_getPaymasterStubData`（估算阶段，返回 paymaster+data+gas）/ `pimlico_getPaymasterData`（正式计费签名），直连 Pimlico 或 relay 代理双模式（relay 模式 body `{chain, method, params}`，apikey 由服务端持有）；`utils/gas.ts` `estimateUserOpGas` 编排落地（stubData → eth_estimateUserOperationGas → 正式 paymasterData）；aa-relay 新增 `POST /v1/paymaster` 代理端点（隐藏 apikey，转发到 `AA_{CHAIN}_PAYMASTER_URL`）；单测 6/6（`__tests__/paymaster.test.ts`）；**🟡 链上验收待生产**：默认路径=**用户自充原生代币支付 gas**（引导充值流程，余额不足时提示，不替用户付费，2026-08-10 产品方向确认）；Paymaster 保留为可选组件（OxaChain（19505）Pimlico 官方不支持 → 自建/自托管 verifying paymaster 或接第三方，仅 sponsor 场景、默认不启用），验收：用户自充 gas 后 UserOp 成功入 mempool 且 receipt success
  - [ ] **E-1b 多链扩展（智能账户合约：BSC/ETH/BASE/ARBITRUM/OP；🟡 2026-08-16 用户裁定延后，暂不进行）**：`projects/aa-sdk/src/config.ts` `CHAIN_ALIASES` 已含别名（L13-24）；**chain-rpc 网关/rawdata 已支持 5 链（OxaChain/ETH/BSC/BASE/SOL + sepolia 测试网，2026-08-08 确认，见 T-2 与 rpc-pool.json）**，但 **aa-sdk 智能账户合约生产仅 OxaChain 部署** → 按 `AA_{CHAIN}_*` env 逐链部署 EntryPoint/Kernel v3.1/KernelFactory/ECDSA Validator/P0.12 Session 模块（含 TokenLimit），验证方法同 `scripts/chain-smoke.mjs`；注意各链 Bundler（Alto 自建或 Pimlico）与 Paymaster 可用性；**env 模板已备（`deploy/systemd/infrax-aa-relay.service` 示例，E-1c 2026-08-09）**；验收：`activateSmartAccount` + `enableSession` + UserOp 在 ≥3 条新链链上实测通过
  - [x] **E-1c aa-relay 实现（UserOp 转发/apikey 代理，P0.5）**：✅ **核心已实现（2026-08-09 确认，`projects/aa-relay/src/index.ts`）**：`POST /v1/userops`（转发 eth_sendUserOperation，多 bundler 容灾，wait=false 广播-only）、`GET /v1/userops/:hash`（收据查询单次，主端点失败切备）、`POST /v1/estimate`（eth_estimateUserOperationGas）、`POST /v1/session` 系列（E-3 创建/查询/撤销/预检，Postgres 持久化）；入站鉴权 `AA_RELAY_API_KEY`（Bearer/X-API-Key/X-Service-Key 三选一，未配置时开发模式开放）；**本轮补全（2026-08-09）**：`POST /v1/paymaster` 代理端点（E-1a：隐藏 Pimlico apikey，转发到 `AA_{CHAIN}_PAYMASTER_URL`）+ 生产 systemd unit `deploy/systemd/infrax-aa-relay.service`（含 `AA_ENABLED_CHAINS`/每链 RPC/bundler/paymaster env 示例）；**✅ 已生产（2026-08-16 生产安装完成）**：生产 unit + drop-in 全量落地 oxachain（`AA_OXACHAIN_RPC_URL/ENTRYPOINT_V07/IMPLEMENTATION/FACTORY/ECDSA_VALIDATOR/SESSION_MODULE/BUNDLERS` 实值，模板 `deploy/systemd/infrax-aa-relay.service` 已对齐生产）+ drop-in `override.conf`/`paymaster.conf`（`DATABASE_URL=10.3.8.6`、`AA_PAYMENTS_URL/API_KEY`、`AA_PLATFORM_ADDRESS`、`AA_OXACHAIN_PAYMASTER_URL=127.0.0.1:9134`）；静态 apikey 校验启用（无 key/错 key 401）；BigInt 500 修复（`apiResponse()`/`jsonSafe()`，提交 f742ec1）；session 表 DB 连接串 `localhost → 10.3.8.6` 修正（drop-in，§9.19 M-3 补记）；**✅ 外部 apikey 实时校验生产启用（2026-08-17 E-1c 遗留收尾）**：data 服务 `api_keys.py` 补 `aa-relay: ar_` scope（生产最小 patch + 重启）；签发 ar_ key 落盘 `/etc/infrax/aa-relay-external.key`（600 root）；aa-relay drop-in `escrow-verify.conf` 配置 `AA_API_KEY_VERIFY_URL=http://127.0.0.1:9112`、`AA_API_KEY_VERIFY_KEY=<DATA_API_KEY>`（46 字符，与 chain-rpc 同源）、`AA_API_KEY_VERIFY_SCOPE=aa-relay`；端到端验证：静态 key / 有效 ar_ key → 进入业务（400 业务参数），无效 key / 无 key → 401，data 日志 `POST /api-keys/verify` 200/401 命中
  - [x] **E-1d 主线收编与文档**：✅ **2026-08-09 实现**：`projects/aa-sdk/src/signers/mpc.ts` `MpcSigner` 落地——`signUserOp` 对接 MPC 新增 `POST /api/v2/mpc/sign-digest` 端点（raw 32B 摘要签名，TSS 2-of-2 免二次哈希，server.ts L864-887）、`signMessage` 对接 `/sign-message`（EIP-191）；65B serialized 签名与 Kernel v3 ECDSA validator 兼容；单测 4/4（`__tests__/mpc-signer.test.ts`）；Session Key 保留为链下服务端代签通道（`SessionKeySigner` 已对接 Engine `execute`）；`AA_SDK_TECH_DESIGN.md` 三缺口完成状态标注见本轮更新；决策依据见 MQ-10 补充 E
  - [x] **E-1e PocketX 联调反馈处理（✅ 2026-08-16）**：PocketX UserOp 主网实测 ①依赖切换 ②契约对接 ③技术链路全通；两阻塞处理——**⑤ SDK headers 缺陷**：`@0xinfrax/aa-sdk@0.1.1`（`PaymasterClient` 第三参/`PaymasterConfig.headers`、`BundlerClient` 第二参/`BundlerConfig[].headers`，relay 模式注入 X-API-Key；`parseBundlers` 透传 headers、`parsePaymaster` 支持 JSON；单测 +2 全绿）已发布；**④ 计费 402**：A-10 计费拦截（subscriber 余额 0，需 0.00466 OXA）——充值路径 = subscriber → 平台钱包 `0x5682e2d55770e46ad24b92e51d6d0a3b629fa0b3` 转 OXA + `POST /payments/verify {txHash, chain}` 入账到 payer ledger；联调专用 = payments 引擎 `payment_balances` 表 ledger 直充（需 PocketX 提供 subscriber 地址，可 `INSERT ... ON CONFLICT` 预存测试额度）；AA_USEROP_FEE_WEI 默认 0.0001 OXA/次。**收尾闭环（2026-08-16）**：① 402 计费通过——`payment_balances` ledger 预存 1 OXA（`INSERT ... ON CONFLICT` 按 subscriber 地址累加）后 402 拦截解除、真实 UserOp 上链成功；② BigInt 500 修复——`wait:true` 收据含 BigInt 字段报 `Do not know how to serialize a BigInt`，`apiResponse()` 统一接入 `jsonSafe()`（BigInt→string 递归，全端点）修复（提交 f742ec1），生产部署后日志 0 条 500；③ aa-relay session 表 DB 连接串修正——`localhost:5432 → 10.3.8.6:5432`（drop-in `override.conf`，重启后 `/health` 正常、无 ECONNREFUSED，§9.19 M-3 补记）
- [x] **MQ-10 补充 E-2（✅ 2026-08-08 完成，生产回归 25/25 全绿）MPC 邮箱恢复 + 分片加密升级（场景一：Agent 托管钱包，P0）**：MPC=用户不能直接控制的托管钱包（agent 全权），核心诉求=**可用性**（用户无法备份私钥/助记词 → 邮箱恢复）。现状单 EOA + AES 加密（PBKDF2(email+secret)）无可恢复语义、`shard_count` 恒 1/1。方案（推荐 B，演进 A）：
  - [x] **E-2a 私钥分片加密（SSS 2-of-2）**：私钥 Shamir 拆 2 片——片1 服务端 AES 加密存储（沿用 `MPC_ENCRYPTION_SECRET`），片2 由 RecoveryKey（email+secret+recovery 上下文，加密串自带 salt）加密存 DB；恢复=邮箱验证 → 取片2 → 与片1 合并重建私钥（内存短暂）；`shard_count=2/total_shards=2` 真实字段；✅ 验证（生产 E2E）：register 后 DB 仅存双片 AES-GCM 密文（salt:iv:tag:ct）、recover 邮箱流程地址一致
  - [x] **E-2b 邮箱恢复打通（真实发信）**：验证码下发 `console.log` → **真实 SMTP 发信**（nodemailer，`SMTP_HOST/PORT/USER/PASS/MAIL_FROM/MAIL_FROM_NAME`）：
    - ✅ 依赖与实现：`nodemailer`（仅 server 侧依赖）；`getMailer` 未配置 → `console.log` 回退（向后兼容，生产 E2E 走 journal 取码路径不变）；发信失败回退日志不阻断 API
    - ✅ 验证码落库：`mpc_verification_codes` 表（email/code_hash/expires_at/attempts，**存 HMAC 哈希不存明文**、5min 过期、5 次尝试上限），恢复流程跨重启稳健
    - ✅ 恢复端点 `recover` 复用验证码 → 片2 重解密 → 私钥合并重建（联动 E-2a），生产 E2E 地址一致
    - ⚠️ **真实发信待 SMTP 凭证**：凭证（SMTP_HOST/PORT/USER/PASS + MAIL_FROM）用户提供后注入 unit env 即自动切真实发信（实现已就绪，回退日志当前生效）
  - [x] **E-2c Agent 授权控制补强（对齐 OKX risk pre-check）**：✅ 额度拆分原生币/ERC20 分设限额（`MPC_AGENT_TX_LIMIT_ETH` 默认 0.1 / `MPC_AGENT_ERC20_LIMIT` 默认 1000）；✅ 交易前白名单预检（`MPC_TRANSFER_WHITELIST` 收款地址 / `MPC_CONTRACT_WHITELIST` 合约 / `MPC_APPROVE_WHITELIST` spender，配置为空=不限制向后兼容）；✅ 保留 `staticCall` 预检 + `mpc_agent_logs` 审计；✅ 验证（生产 E2E）：原生币超额拒绝 400、ERC20 超额拒绝 400、限额内放行通过预检
  - [x] **E-2d 会话安全增强**：✅ session 由纯内存 Map → 落库（`mpc_sessions` 表，token **哈希存储**，重启后经 token_hash 定位 + 双片重建 wallet 写回内存，重启不失效）；✅ `SESSION_TTL_MS` 可配（env `MPC_SESSION_TTL_MS`，默认 30min）；✅ `contract-read/gas-estimate` 补 session 校验（无 token 400、无效/过期 401，生产 E2E 验证）；✅ 验证：lock 后内存+DB 双删、生产 E2E 通过
  - [x] **E-2e（可选，P3）真 TSS/MPC 分片签名（方案 A，=E-4①）**：引入 cggmp24（Rust，跨进程 2-of-2），签名全程无完整私钥重建（服务端片1 + 邮箱恢复片2 共同完成阈值签名）；✅ M1 集成验证（demo 签名 ethers 可验证）；✅ M2 存量迁移（`mpc_signer /v1/import` trusted_dealer 按现有私钥分片、地址不变）；✅ M3 服务端替换（`server.ts` 四签名端点改调 TSS 签名器、`getSession` 持分片句柄不再 `sssMerge` 重建私钥，遗留 Shamir 路径保留回退）；✅ 本地四端点 E2E 13/13 通过（`projects/mpc-tss/scripts/e2e-mpc.mjs`：sign-message/sign-typed-data ethers recoverAddress 复核 + send-transaction 链上 receipt + contract-write ERC20 余额变动）；详情 `docs/TSS_EVALUATION.md` §6；✅ M4 生产部署完成（2026-08-09，提交 f9c84ed）：`tss_signer`/`mpc_signer` systemd 上线（9200/9201）、`infrax-mpc.service` 带 TSS env；生产验证——TSS 钱包注册（0xb8416155…）sign-message/sign-digest 恢复地址 MATCH、旧钱包（agent@infrax.io）兼容解锁、链上 balance 走 chain-rpc 网关、mpc-sdk 0.3.0 生产回归 27/27 全绿
- [x] **MQ-10 补充 E-3（✅ 2026-08-08 完成）Session 切换 Kernel v3 链上共享控制（场景二：用户钱包授权，P2）**：Session=用户可直接控制但自愿共享控制权（授权）。现状 Session Key Engine 为**链下声明式**（`from`=服务端独立 EOA、链上不可验证、单链）不满足语义 → **切换为 Kernel v3 链上 session validator**（aa-sdk 已实现链上强制）：
  - [x] **E-3a 用户钱包 session API 新建**：owner=用户 EOA（MetaMask 等，`ExternalWalletSigner` 已实现 EIP-1193），agent=session key；创建 = 用户签名 `enableSession` UserOp → `installModule(VALIDATOR, sessionModule, enableData)`（aa-sdk `session.ts`，ENABLE-mode 一次 UserOp 完成安装+授权，`buildEnableSessionUserOp`/`signEnableUserOp`）；撤销 = `uninstallModule`（用户即时收回控制权）；✅ 验收（2026-08-08 链上验证）：`aa-relay/scripts/aa-session-e2e.ts` E2E **12/12 全绿**——owner 签名 ENABLE-mode enableSession 上链（handleOps 直接交易，绕过 bundler FailedOp 前置检查）→ agent 用 session key 经 validator nonce 路由调用成功 → owner disable（root-mode uninstallModule）→ agent 再调用被链上 revert
  - [x] **E-3b 权限策略下发**：策略复用 aa-sdk `SessionPolicy`（targets 白名单/selectors/valueLimit/dailyLimit/countLimit/tokenLimits/allowAnyTransfer）+ 链下预检 `validateSessionCall`；✅ 验收：策略在链上模块生效且链下预检一致（E2E 第⑤步 validateSessionCall allowed）；⚠️ 遗留：多租户 `(product, network, sessionId)` 键落到代码（现 `network:sessionId` 两维，SessionStore/InMemorySessionStore），待 E-3 系列后续按需扩展
  - [x] **E-3c 与 OKX 能力对照**：OKX= TEE 钱包整体授权 + spending limit（粗粒度、链下、不可验证）；我们=链上强制、可撤销、可验证、细粒度（反超）；~~对齐 OKX 的 x402 自动支付~~（**延后，2026-08-08 用户决策**）；✅ 对照表已写入 `docs/AA_SDK_TECH_DESIGN.md` §7.7；✅ 演示（owner 撤销 session 后 agent 交易被链上拒绝）E2E 第⑦步达成
  - [x] **E-3d session-key 服务重定位**：原 Engine（:3500）保留为**平台服务端代签通道**（非用户钱包 session：平台自主操作/内部服务交易）；`SessionKeySigner` 可作 Kernel 的替代签名器（Engine 代签 UserOp，已对接 `execute`）；✅ 边界已文档化 `docs/AA_SDK_TECH_DESIGN.md` §7.8（两种 session 并存互不冲突）
- [x] **MQ-10 补充 E-4（✅ 2026-08-09 完成：① M1-M4 ✅ + ④ ✅；② 延后（用户决策）、③ 并入 E-1b）真 TSS + 50 子钱包**（范围已按用户决策修正，2026-08-08：x402 延后、链覆盖以下方现状为准）：① **MPC 演进真 TSS 分片签名**（=E-2e，签名全程无完整私钥重建，✅ M1-M3 完成 2026-08-09——选型 cggmp21 评估文档 `docs/TSS_EVALUATION.md`；M1 集成验证、M2 存量迁移 trusted_dealer 地址不变、M3 服务端四签名端点 TSS 化（本地四端点 E2E 13/13，`projects/mpc-tss/scripts/e2e-mpc.mjs`）；✅ M4 生产部署完成（2026-08-09，提交 f9c84ed）：signer systemd 上线（9200/9201）、生产 TSS 钱包注册 + 旧钱包兼容解锁、mpc-sdk 0.3.0 生产回归 27/27 全绿；详见 E-2e 与 `docs/TSS_EVALUATION.md` §5/§6）；② ~~x402 自动支付接入智能账户~~ **（延后）**——待 E-1（aa-sdk 三缺口）与 E-3（Session 链上授权）主线稳固后再评估；③ **链覆盖：现状已支持 5 链（OxaChain/ETH/BSC/BASE/SOL + sepolia 测试网，chain-rpc 网关 + rawdata，2026-08-08 确认）**；其余链（ARB/OP/POLYGON 等对齐 OKX 近 20 链）**记为待办**——扩展入链先走 chain-rpc `rpc-pool.json`/`CHAIN_RPC_CHAINS`，aa-sdk 智能账户合约逐链部署见 E-1b；④ **✅ 50 子钱包并发模型（2026-08-08 完成，生产 E2E 27/27 全绿）**（单邮箱派生多 agent 子钱包）：注册语义 **1:1 → 1:N**（`register` 每次创建新子钱包返回 `walletId`，原「重复注册 1006」语义升级）；接口加 walletId 维度（`recover`/`status`/`session/unlock` 带 `walletId` 精确命中子钱包，缺省首个向后兼容；新增 `GET /api/v2/mpc/wallets` 列表端点）；`getSession` 改按 `wallet_address` 唯一定位（1:N 不歧义），token 绑定子钱包后签名/交易自动归属；`@0xinfrax/mpc-sdk` **0.2.0 已发布**（新增 `listWallets` + walletId 参数/返回）；验收：生产 E2E 覆盖二次注册新钱包、listWallets 计数、status/recover/unlock 按 walletId 命中、两钱包地址互异
- [x] **MQ-10 补充 E-5（✅ 2026-08-08 完成首期，钱包模块 + 会话模块）MPC 独立 SDK（需求登记，PRD §4.5）**：MPC 为独立微服务 → 独立轻量 SDK，不依赖整包 `infrax-dk`。已发布 `@0xinfrax/mpc-sdk@0.1.0`（`projects/mpc-sdk/`，零运行时依赖），生产 E2E 22/22 全绿。拆分子任务：
  - [x] **E-5a 包结构与发布管道**：`@0xinfrax/mpc-sdk`（`projects/mpc-sdk/`）独立包；`package.json`（`main: dist/index.js`、`types: dist/index.d.ts`、`build: tsc`、`files: [dist]`）+ `npm publish` 已发布 registry（2026-08-08 @0.1.0）；仅依赖 MPC 服务契约（内置零依赖 HttpClient），版本与 `infrax-dk` 解耦；验收达成：生产 `npm i @0xinfrax/mpc-sdk` 安装成功、TS 类型可用
  - [x] **E-5b 钱包模块（5 tools）**：`sendCode` / `register` / `recover` / `status`（email/walletAddress 双查询键）/ `createWallet`（组合）；端点 `/api/v2/mpc/{send-code,register,recover,status}`；TS 类型完整；验收达成：对生产 :9104 实测 5 方法返回与 REST 一致
  - [x] **E-5c 会话模块（3 tools）**：`unlockSession` / `lockSession` / `sessionStatus`（token 查询）；端点 `/api/v2/mpc/session/{unlock,lock,status}`；验收达成：unlock→status→lock 全流程生产实测通过
  - [x] **E-5d 链上模块（7 tools）**：`balance`（原生+ERC20）/ `signMessage` / `signTypedData` / `sendTransaction` / `contractRead` / `contractWrite` / `gasEstimate`；端点 `/api/v2/mpc/{balance,sign-message,sign-typed-data,send-transaction,contract-read,contract-write,gas-estimate}`；✅ **0.3.0 已发布（2026-08-09）**：`projects/mpc-sdk/src/chain.ts` `ChainModule` 7 方法 1:1 封装（交易类数量参数统一 string，服务端 parseUnits/parseEther 自理）；`@0xinfrax/mpc-sdk` 16 方法（钱包 6 + 会话 3 + 链上 7）；mock smoke 16/16（`scripts/chain-smoke.mjs`，路径映射/body 序列化/响应解析/401 语义）；服务端四签名/交易端点已 TSS 就绪（E-4①/M3，本地四端点 E2E 13/13，见 E-2e）；✅ 生产回归完成（2026-08-09，mpc-sdk 0.3.0 生产 E2E 27/27 全绿，见 E-4① M4）
  - [x] **E-5e 恢复流程封装 + 错误分支测试**：`recover` 显式封装「邮箱验证码 → 服务端分片重建 → 客户端地址校验（expectedAddress）」；错误码对齐（401/403/400/404/409/429 语义，`errors.ts` MpcApiError.kind）；验收达成：生产 E2E 覆盖恢复成功 + 错误验证码 400 + 地址不一致 409/40900 + 未注册 404/1004
  - [x] **E-5f 鉴权对齐 + 文档**：出站统一 `X-API-Key`（服务端契约 Bearer/X-API-Key/X-Service-Key 三选一）；README（`projects/mpc-sdk/README.md`，安装/QuickStart/8 方法表/错误语义/与 MCP 对应关系）；SDK_INTEGRATION.md §2A 登记完成
  - **🎁 附带生产缺陷修复（E-5 生产 E2E 发现）**：MPC server 缺统一 JSON 错误处理器 → 错误路径返回 Express HTML 而非信封；`projects/mpc/server.ts` 新增 `app.use` 错误中间件（statusCode→status、code 映射 1007/1001），已 rsync 生产 + 重启 infrax-mpc，错误分支现返回 `{code,message,data}`

**MQ-11 支付引擎交接与发布（2026-08-10 需求登记；payment = 与 WAAS/MPC **平级**的通用微服务：链上 / x402 / 法币）**：
> 背景：AgentX 通用支付引擎整体移交 infraX——源码迁入 `projects/payments/`，以 `@0xinfrax/payments@0.1.0` 发布 npm（registry）；AgentX 保留定制支付 SDK（`@agentxv2/sdk` 的 `SubscriptionPayments` + 协议客户端 re-export），依赖方向固定 **AgentX → @0xinfrax/payments（无反向）**。AgentX 侧代码切换已提交（Agentx `323d3c9`），R17 发布流程（Agentx `docs/PROGRESS.md`）待执行。方案：Agentx `docs/payments-infrax-migration.md`；交接：infraX `projects/payments/HANDOVER.md`。
>
> **两个 SDK 定位区分**：`@agentxv2/sdk` = AgentX 平台**业务 SDK**（定制层，对话/任务/发布/订阅/支付全能力，维护方 AgentX）；`@0xinfrax/payments` = InfraX **通用支付通道 SDK**（与 WAAS/MPC 平级的支付微服务客户端，维护方 infraX，零 AgentX 依赖）。升级语义：应用方只升级 `@agentxv2/sdk`（业务零改动）；支付引擎能力升级走 `@0xinfrax/payments` 版本跟随（AgentX 是消费方，F2 演练）。
>
> **B 端接入方式（2026-08-11 决策）**：通用支付 = **独立实例 + 自配凭证**——每个 B 端（调用方）自行部署/嵌入 `@0xinfrax/payments` 实例，在**自己实例**的 env/Options 里配置自己的收款凭证（chain `SubscriptionManager` 合约 / `STRIPE_SECRET_KEY` / `X402_PAY_TO` / `MPP_PAYEE`），**一个实例 = 一套收款**，钱进 B 端自己的账户；平台 `infrax-payments :9132` 仅为**平台自用实例**（配平台自身凭证，服务 waas/dc 订阅激活），不代 B 端收钱；共享多租户实例（凭证按调用方/租户维度解析）未实现、暂不需要——需要多收款主体时按租户多实例（复制 unit + 不同 env）。接入模板见 `projects/payments/CALLER_SETUP.md`（收款配置全景 / 形态 A 嵌入式 / 形态 B 独立服务 / 自检清单）。

**infraX 侧（已完成 ✅）**：
- [x] **P-1 源码迁入**：`projects/payments/`（package `@0xinfrax/payments@0.1.0`，commit `cc98172`，2026-08-08），依赖仅 `pg`+`viem`、`express` optional peer，零 AgentX 业务 token
- [x] **P-2 发布与文档**：npm 已发布（latest=0.1.0，39 文件 dist + db/migrations 5 SQL）；解耦验证 19 断言全绿（`scripts/local-payments/run-decouple.sh`）；HANDOVER/MIGRATION/README/DEPLOY 齐备
- [x] **P-3 一致性核对（2026-08-10）**：与 Agentx `payments/` 源码 diff 仅包名头注释差异（`@agentxv2/payments`→`@0xinfrax/payments`），内容完全一致

**AgentX 侧 R17 发布流程（A-E + F1 + F2 ✅ 全部完成，2026-08-10）**：
- [x] **R17-A 前置确认**：A1 infraX 集成完成打勾（Agentx PROGRESS.md R17 表）｜A2 本地 main 最新且干净｜A3 `npm view @0xinfrax/payments version` → 0.1.0
- [x] **R17-B sdk 验证+发布**：B1 `npm run build && npm run typecheck && npm test` 全绿（Agentx/sdk）｜B2 `dist/` 无 `@agentxv2/payments` 残留｜B3 bump 0.11.0（commit+tag）｜B4 `npm publish --registry=https://registry.npmjs.org/`｜B5 `npm view @agentxv2/sdk@0.11.0 dependencies` 含 `@0xinfrax/payments`——✅ sdk@0.11.0 已发布（commit `3435a01` + tag `v0.11.0`）
- [x] **R17-C gateway 升级**：C1 `npm install @agentxv2/sdk@^0.11.0 --registry=https://registry.npmjs.org/`｜C2 `package-lock.json` 无 `@agentxv2/payments`/`../payments` 残留｜C3 gateway build+typecheck+test 全绿——✅ lock 残留 0、46/46 全绿
- [x] **R17-D 旧包+文档**：D1 `npm deprecate @agentxv2/payments "已迁移至 @0xinfrax/payments"`｜D2 sdk CHANGELOG 0.11.0 条目（依赖切换 / `PAYMENT_VERSION`→0.1.0 / 升级提示）｜D3 Agentx PROGRESS.md R17 打勾 + 迁移方案文档 §三/§四标记完成｜D4 commit + push——✅ 4 版本全部 deprecate；commit `47d3d72` + tag `v0.11.0` 已推送 origin/main
- [x] **R17-E 生产升级（2026-08-10）**：E1 生产机（43.159.60.46）`git pull` 至 `2e2aaa8` + gateway `npm install --registry=https://registry.npmjs.org/`（sdk=0.11.0 / @0xinfrax/payments=0.1.0，旧包移除）｜E2 rebuild + pm2 restart + 冒烟：`/api/v1/payments/info`（统一引擎 payload，fiat/x402 按配置 disabled）、`/access`（active:false）正常；x402/fiat 轨道 disabled 待 R4/R5 凭据，无法各验一笔——✅ 三服务 online，文档已提交推送 `8b3970f`
- [x] **R17-F 通知收尾（F1 ✅，F2 ✅）**：F1 应用方通知——文案见 Agentx `payments-infrax-migration.md` §五，应用方盘点：aiservicer（^0.9.1，不受影响、升级为推荐项）、autoops/pocketx-wallet（无 sdk 依赖）｜F2 **首次跟随演练（2026-08-10 完成）**——infraX 发布 `@0xinfrax/payments@0.1.1`（补丁：`createWebhookForwarder` + ChainAdapter `rpcHeaders`）→ AgentX 依赖升级 `^0.1.1`（sdk/gateway）→ 解耦回归 19 项断言通过（run-decouple.sh 改消费已安装 npm 包）→ sdk 32/32 → 发布 `@agentxv2/sdk@0.11.1`（commit `99427a9` + tag `v0.11.1`，`PAYMENT_VERSION='0.1.1'`）→ gateway 升级 `^0.11.1`（46/46）→ 生产机（43.159.60.46）pull 至 `99427a9` + npm install + rebuild + pm2 restart，冒烟 `/info`（统一引擎 payload）与 `/access`（active:false）正常，与 R17 基线一致
- [x] **R17-后置（P3）payment 微服务生产独立部署——已评估（2026-08-10，结论：可行，就绪度 ~90%）**：形态=**通用支付网关**（与 waas/mpc 平级）——新建 `infrax-payments` 服务（建议端口 **:9132**，避开老版 payment :9106），`createPaymentsRouter` 15 端点现成、express optional peer、auth-express 统一鉴权、systemd 模板现成；DB=`pocketx_payments` 独立库只跑本模块 5 迁移；**需 2 处小开发**：① `onWebhookEvent/onCredit` 进程内回调 → 出站 POST 转发（~50 行，带重试/幂等）② ChainAdapter 由直连 rpcUrl 改走 chain-rpc 网关（单文件 [chain.ts]，对齐 DC-10）。**AgentX 保持嵌入式不动**（已生产跑通），独立服务面向新调用方/未来多平台。风险：事件回调断链、两层账本一致性（依赖 reference 幂等+对账）、与老版 payment 命名/端口混淆。参考：老版 `projects/payment/server.ts`（:9106 模板）+ `scripts/run-decouple.sh`（独立库接入姿势）——✅ 评估完成（2026-08-10），实施任务见下「P3 实施」

- [x] **P3 实施（✅ 2026-08-10 完成，payment 通用支付网关落地）**
  - [x] **P3-1 事件出站转发**：`projects/payments/src/forwarder.ts` 新增 `createWebhookForwarder({ targetUrl, secret?, timeoutMs?, maxRetries? })` → 返回 `{ onWebhookEvent, onCredit }`，把归一化事件 POST 到业务方回调端点；`Idempotency-Key`=event object id / credit.reference（幂等）；`X-Payments-Signature`=HMAC-SHA256（复用 `crypto.ts hmacSha256Hex`）；指数退避重试（maxRetries 次）；失败仅 warn 不阻塞支付主流程；`src/index.ts` 导出——✅ 单测 5/5（转发/idempotency-key/签名/重试成功/失败不 throw）
  - [x] **P3-2 ChainAdapter 走 chain-rpc**：`src/adapters/chain.ts` `ChainInfo` 新增可选 `rpcHeaders?: Record<string,string>`，`getPublicClient` 用 `http(info.rpcUrl, { fetchOptions: { headers } })`——独立部署传 `X-Service-Key` 走 chain-rpc 网关（对齐 DC-10，读方法白名单含 eth_call）；直连形态（decouple 测试）不受影响——✅ typecheck 通过
  - [x] **P3-3 服务入口**：`projects/payments/server.ts`（tsx 直跑，参照老版 `projects/payment/server.ts`）：Express + `createAuthMiddleware({ PAYMENTS_API_KEY, scope:'payments', DATA_URL/DATA_API_KEY, exempt:['/payments/webhook'] })` + `express.json({ verify })` 保 rawBody + `PgPaymentStore`/`PgMPPSessionStore`/`PgAuthorizationStore`（DATABASE_URL 默认 pocketx_payments）+ 启动自动执行 db/migrations 001-005 + `GET /health` + `createPaymentsRouter`（前缀 `/payments`）+ `WEBHOOK_FORWARD_URL` 注入 forwarder + env 前缀链配置（CHAIN_<NAME>_RPC_URL/CHAIN_ID/SUBSCRIPTION_MANAGER + CHAIN_RPC_READ_KEY 自动带 X-Service-Key）+ 无链/缺 x402 配置 fail-fast
  - [x] **P3-4 依赖**：payments `package.json` devDependencies 补 `tsx` / `cors` / `@types/cors`——✅ npm install（官方 registry）完成
  - [x] **P3-5 systemd unit**：`deploy/systemd/infrax-payments.service`（`PORT=9132`、`DATABASE_URL=pocketx_payments`、链/轨道/转发 env 占位、`After=...infrax-chain-rpc.service`，参照 infrax-payment.service 模板）
  - [x] **P3-6 本地验证**：typecheck + build + vitest **92/92** 全绿（含新增 forwarder 5 项）；docker postgres（pocketx_payments）起服务冒烟 **5/5 PASS**：`/health` 200 豁免 / 无 key 401 / 带 key `/payments/info` 200（rails payload） / `/payments/balance` 200（空表 0）/ webhook 缺签名 400（rawBody 生效）；迁移 5 个 → 8 张 payment_* 表全部创建；容器已清理
  - [x] **P3-7 生产部署（✅ 2026-08-10）**：43.163.105.172 建 `pocketx_payments` 库 → 装依赖（tsx）→ 跑迁移（5/5，8 表）→ 注册 systemd（`infrax-payments.service`，:9132）→ 冒烟 **5/6 → 6/6 全绿**：`/health` 200 豁免 / 无 key 401 / 带 key `/payments/info` 200 / `/payments/balance` 200 / webhook 缺签名 400 / **`/payments/price?planId=1` 200**（planId=1：price 0.01 ETH、period=monthly、active、trialDays=7）——途中修复 2 个问题：① 生产机 DNS 无法解析 `rpc.l1.oxachain.io`（ENOTFOUND）→ chain-rpc `rpc-pool.json` oxa 端点改 `https://rpc-oxa.0xainet.top`（AgentX 生产在用）+ drop-in 备用；② `/payments/price` 500 `getPlan returned no data ("0x")` —— 根因：chain-rpc 网关默认响应为信封 `{code,message,data:{result}}`，viem http transport 只认标准 JSON-RPC 顶层 `result` → 新增 **raw 透传模式**（请求头 `X-Json-Rpc: raw` → `{jsonrpc,id,result|error}`，batch 同理，[rpcRoutes.ts] 支持），payments `server.ts` buildChains 走网关时自动带该头；既有信封消费方（waas/dc/mcp/sdk/mpc）零影响

> 回滚预案：依赖回滚 `npm install @agentxv2/sdk@0.10.3` / `@agentxv2/payments@^0.2.2`（官方 registry）；代码回滚 `git revert 323d3c9`（旧包未删，双保险）。

**MQ-12 用户套餐支付接入通用支付引擎（2026-08-10 需求登记；方案：waas 保持业务层，支付统一走 @0xinfrax/payments 独立服务）**：
> 背景：现状 waas `/api/v2/subscription/subscribe`（[subscriptionRoutes.ts](projects/waas/routes/subscriptionRoutes.ts)）与 `saas/tenants/activate`（[tenantService.ts](projects/waas/services/tenantService.ts)）均为**伪支付**——校验套餐后直接 INSERT `status='active'` + `expires_at=now+30d`，pro/enterprise 免费直通，对应 B-10-2（x402 伪实现）与 B-11-2（套餐购买页）。通用支付引擎 `@0xinfrax/payments`（独立服务 **infrax-payments :9132**，chain/fiat/x402/mpp/stablecoin 五通道 + `metadata` 透传 + P3-1 webhook 出站转发）已生产就绪 → **用户套餐购买接入通用支付通道，关停伪支付路径**。
> 先决决策（推荐已标注）：**D-1 套餐目录形态**——推荐：目录以 waas `subscriptions` 为业务侧唯一事实（现状硬编码 free/pro/enterprise 保留），支付按套餐 rail 路由：chain=链上 SubscriptionManager escrow（`/payments/price` 取价，oxa planId=1 已实测 0.01 ETH/月）、x402=原生代币周期支付、fiat=Stripe checkout；链上 planId 与 waas plan 建立对齐表；**D-2 rails 启用**——平台 `:9132` 自用实例启用 chain rail（生产实测）；**x402/Stripe 为可插拔能力、不等待平台凭证**（2026-08-11 决策：平台只提供通道与工具，按「独立实例 + 自配凭证」由各 B 端实例配自己的 x402/Stripe 凭证即启用，平台不代 B 端配置）；**D-3 subscriber 映射**——waas `req.user.walletAddress` 即 payments `subscriber`（天然一致，[auth.ts](projects/waas/middleware/auth.ts) 已解析），无额外映射。
> 状态标记同前：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办；优先级 P1；关联 B-10-2 / B-11-2 / B-11-6 / MQ-11(P3)。

- [x] **T-1 支付意图创建（✅ 已实现 2026-08-10）**：`POST /api/v2/subscription/subscribe`——free 直通；pro/enterprise 按 rail 调 infrax-payments：chain→`GET /payments/price` + `GET /payments/chain-info`（escrow 地址/金额/chainId）、fiat→`POST /payments/checkout`（`clientReference=sub:<id>` + metadata）、x402→`GET /payments/info` 挑战；`subscriptions` 落 `status='pending'`（expires_at 空）不再直接 active；rail 失败 → `failed`。验收：pending+支付信息返回、无 active 直通
- [x] **T-2 支付确认回调端点（✅ 已实现 2026-08-10）**：waas `POST /api/v2/subscription/payment-callback`（forwarder 目标）——HMAC-SHA256 验签（`PAYMENTS_WEBHOOK_SECRET`）+ 幂等（`activateSubscription` 已 active 跳过）；webhook→解析 `client_reference_id=sub:<id>` 激活；credit→按 payer 匹配 pending x402 激活。验收：伪造签名 401、重复事件幂等、回调后 /subscription/me active
- [x] **T-3 chain rail 链上兜底校验（✅ 已实现 2026-08-10）**：payments router 新增 `GET /payments/subscription/:chain/:subscriber/:resourceId`（`hasActiveSubscription`）+ `GET /payments/chain-info/:chain`（chainId+SubscriptionManager 地址）；waas `POST /api/v2/subscription/check` 轮询链上状态 → active 则激活；plan 对齐表 `PAYMENTS_PLAN_ID_MAP`（free:0/pro:1/enterprise:2，env 可配）。验收：链上 escrow 有订阅 → /subscription/me active（即使回调缺失）
- [ ] **T-4 访问控制对齐**：waas `/api/v2/subscription/me` 直查 `subscriptions` 已一致（回调落库，无需自定义 PaymentStore）；payments `POST /payments/access` 供第三方路径文档标注并入 T-10
- [x] **T-5 前端套餐购买流程（✅ 已实现 2026-08-10）**：[waas.js](projects/web/modules/waas.js) `waasUpgradePlan`——free 直通；chain→展示 escrow 地址/金额 + 4s 轮询 `/check`；fiat→跳转 `sessionUrl`；x402→提示转账 + prompt 提交 txHash 调 `/verify`；pending→active 状态实时反馈。验收：三 rail UI 流程可走通、pending 态明确提示
- [x] **T-6 伪支付路径关停（✅ 已实现 2026-08-10）**：[tenantService.ts](projects/waas/services/tenantService.ts) `activateTenant` 非 free 抛错（仅 free 试用直通）；subscribe 无"直接 active"分支；`subscriptions` 写入口审计——仅 free 直通 + 支付确认（回调/check/verify）两路。验收：pro/enterprise 无支付不再出现 active 记录
- [x] **T-7 rails 生产配置（✅ 2026-08-10 部署完成）**：waas drop-in `payments.conf`（PAYMENTS_URL=127.0.0.1:9132 / PAYMENTS_API_KEY / PAYMENTS_WEBHOOK_SECRET / DEFAULT_RAIL=chain / CHAIN=oxachain）；infrax-payments drop-in `webhook-forward.conf`（WEBHOOK_FORWARD_URL=http://127.0.0.1:9109/api/v2/subscription/payment-callback + WEBHOOK_FORWARD_SECRET 与 waas 一致）；rails 启用状态：**平台自用实例仅 chain**（x402/Stripe 为可插拔能力，按 D-2 由各 B 端实例自配凭证启用，平台不代配）——验收：`/payments/info` → `{"enabled":false,"mpp":{"enabled":false}}`
- [x] **T-8 admin 支付订单视图（✅ 代码完成 2026-08-12，B-11-6 联动）**：payments 引擎新增只读审计端点——[store.ts](file:///home/ubuntu/infraX-1/projects/payments/src/store.ts) `listIntents`（`payment_intents` 查 status/subscriber 过滤 + 分页，`PgPaymentStore` 实现）+ [service.ts](file:///home/ubuntu/infraX-1/projects/payments/src/service.ts) 委托 + `GET /payments/orders`（limit/offset/status/subscriber）；admin server 新增 `GET /api/v2/admin/orders`（直读 `pocketx_payments.payment_intents`，requireAdmin）+ admin 前端「Orders」页（[Orders.tsx](file:///home/ubuntu/infraX-1/projects/admin/src/pages/Orders.tsx)：intent_id/method/subscriber/金额（wei→原生币格式化）/asset/chain/status/created/metadata + 状态筛选）。payments typecheck ✅ + admin build ✅。验收（生产）：订单可见、状态与库一致——待生产部署
- [ ] **T-9 验收（E2E，⚠️ 部分完成 2026-08-10）**：✅ 已通过——钱包签名 E2E（生产实测）：subscribe pro→201 pending+chain 支付信息（price 0.01ETH/period/trialDays/subscriptionManager/chainId 19505，真实调 payments）、/check 链上兜底（active:false→stays pending）、payment-callback 正向（HMAC 签名→pending→active+expires_at=now+30d）与负向（伪造/缺失签名→401）、subscribe free→active 直通、/subscription/me 状态切换、DB 落库（payment_method/status/ref 正确）、web :9111 代理链路、payments 新端点（chain-info/subscription/price）+ 无 key 401、**测试数据已清理**。🔲 未覆盖——链上真实 escrow 支付（无钱包/无链上订阅，依赖 SubscriptionManager 实际订阅）、前端浏览器钱包流程（waas.js 已部署）、x402/Stripe 链上真实支付（按 D-2 由 B 端实例自配凭证后验收，平台不代配）
- [x] **T-10 文档与回滚预案（✅ 2026-08-12）**：`SERVICE_API_REFERENCE.md` 新增 §7.1 WAAS 套餐订阅章节（pending/active 状态机 + rail 路由表 + 回调契约 + 回滚预案）；`SDK_INTEGRATION.md` 新增 §2.4B WAAS 订阅支付流程消费示例（`subscription.plans/subscribe` + chain/fiat/x402 三 rail 激活路径）；回滚预案——waas 恢复直接订阅逻辑 + payments rails 停用即回退（业务零耦合，互不影响）

**MQ-13 通用支付通道能力层重构（2026-08-10 需求登记；方案：方案 B 全量配置化，已批准）**：
> 背景：用户提出通用支付通道"不应只是包装原有支付通道"——作为可编程、针对 agent 支付特殊优化的通道，应有更多可配置端点；此前被删除的 **a2a**（两阶段意图支付）与 **period**（订阅周期授权）应恢复为可配置项；并新增 **batch**（agent 一次性向多个 agent 收款）场景。
> 方案 B 核心：rails 全部重构为**可插拔能力**——构造参数配置 + 端点动态挂载 + `GET /payments/capabilities` 探测；未启用能力端点返回 503（显式而非 404）；ENV 开关：`X402_ENABLED`/`MPP_ENABLED`/`STRIPE_*`/`A2A_ENABLED`（默认随 x402）/`PERIOD_ENABLED`/`BATCH_ENABLED`。
> 状态标记同前：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办；优先级 P1；关联 MQ-12 / B-10-2 / P4。

- [x] **T-1 能力层模型设计（✅ 2026-08-10）**：`Capabilities`/`CapabilityInfo` 类型（id/enabled/description/endpoints/config）；能力注册表 `PaymentsService.capabilities()`；router 按能力 `cap()` 守卫动态挂载（禁用→503）
- [x] **T-2 a2a rail 恢复（✅ 2026-08-10）**：`POST /payments/a2a`（phase1 意图：subscriber+valueWei+payee?→paymentId/amountWei/payee）+ `POST /payments/a2a/settle`（phase2 链上 tx 验证入账，复用 x402 `verifyAndCredit`，幂等）；`payment_intents.payee` 列恢复（005 迁移）；事件 `a2a.created`/`a2a.settled`
- [x] **T-3 period rail 恢复（✅ 2026-08-10）**：`payment_authorizations` 表恢复（005 迁移：owner/asset/chain/amount_wei/remaining_wei/period_price_wei/periods/nonce/reference/status）+ `PgAuthorizationStore`（create/get/chargePeriod 原子扣减+exhausted 状态）；`POST /payments/period/charge`（续费）+ `GET /payments/period/authorization`；事件 `authorization.charged`
- [x] **T-4 batch rail 新增（✅ 2026-08-10）**：`payment_batches` 表（006 迁移：items JSONB + 原子全完成→completed）+ `PgBatchStore`；`POST /payments/batch`（一次建 N 个 a2a 意图）→ `POST /payments/batch/settle`（逐项验证 tx）→ `GET /payments/batch`（状态）→ `POST /payments/batch/cancel`；事件 `batch.created`/`batch.item.settled`/`batch.completed`
- [x] **T-5 能力探测端点（✅ 2026-08-10）**：`GET /payments/capabilities` 返回全部 rail 的 enabled/endpoints/config；服务启动日志打印能力清单（原 rails 打印替换）
- [x] **T-6 服务端 ENV 配置化（✅ 2026-08-10）**：[server.ts](projects/payments/server.ts) 增加 `A2A_ENABLED`（默认 true 随 x402）/`PERIOD_ENABLED`/`BATCH_ENABLED` 开关，按开关注入 `PgAuthorizationStore`/`PgBatchStore`
- [x] **T-7 回归（✅ 2026-08-10）**：tsc 通过 + vitest **11 文件 106 用例全绿**（新增 `tests/capabilities.test.ts` 17 例：capabilities 探测/a2a 两阶段/period 授权扣减耗尽/batch 创建结算完成取消/router 503 守卫）
- [x] **T-8 部署生产 + 验证（✅ 2026-08-10）**：迁移 005/006 上生产（`migrations applied (6)`）→ 重启 infrax-payments → 验证：`/payments/capabilities` 完整清单（默认仅 chain 启用）、a2a/period/batch 未启用端点 503 守卫、chain-info 200（chain 能力无回归）、无 key 401 → drop-in 开启 `PERIOD_ENABLED`/`BATCH_ENABLED` 后 capabilities 显示 chain+period（batch 依赖 x402，生产未启保持关闭）→ **period 生产实测**：插入 3 周期授权 → `/period/charge` 三次：renewed true/true/false（剩余 2000→1000→0，第三次 exhausted）→ 第四次 500 → `/period/authorization` 状态正确 → **测试数据已清理**。batch 依赖 x402（按 D-2：由 B 端实例自配凭证后启用，平台不代配）——**B 端实例启用 batch 需自配参数**：`BATCH_ENABLED=true` + 收款③ x402（`X402_ENABLED=true` / `X402_PAY_TO=<B端自己的收款钱包>` / `X402_PRICE_WEI` / `X402_CHAIN=oxachain`）+ 收款① chain（`CHAIN_<SLOT>_RPC_URL` + `CHAIN_<SLOT>_CHAIN_ID` + `CHAIN_<SLOT>_SUBSCRIPTION_MANAGER`，或经 chain-rpc 网关配 `CHAIN_RPC_READ_KEY`）+ 自有 `DATABASE_URL` / `PAYMENTS_API_KEY`；settle 复用 `a2aSettle` 链上验 tx 入账（启用条件 = batch store 注入 && x402 存在 && a2a enabled，见 [service.ts capabilities](file:///home/ubuntu/infraX-1/projects/payments/src/service.ts)）；生产平台 :9132 保持 batch 关闭（无 x402）
- [x] **T-9 文档更新（✅ 2026-08-10）**：`projects/payments/README.md`（迁移表 001-006 + 能力层章节：探测/503 守卫/新端点）；`HANDOVER.md`（§1 范围说明改为可插拔能力、§2 功能矩阵新增 a2a/period/batch/capabilities 四行、§12 能力开关说明）；`MIGRATION.md`（§7 遗留更新）；本 tasklist MQ-13 段登记

**MQ-14 agent 自动收费邀请 + 账本内转账（2026-08-10 需求登记；方案已批准并实施）**：
> 背景：用户确认"agent 应具备自动发收费邀请"的能力，选择增强方向：**邀请端点+状态机**（invite）+ **账本内转账**（transfer）。方案要点：invite 复用 a2a 意图，封装业务账单（payer/payee/amount/dueAt/memo），状态机 `created→sent→settled|expired|cancelled`，两种结算路径（链上 settle / 余额 pay）；transfer 为平台余额间原子划转（debit+credit 单事务，无新签名），reference 幂等，解决"settle 后资金记在付款方余额、收款方未直接到账"的归属问题。ENV：`INVITE_ENABLED`（依赖 x402）/`TRANSFER_ENABLED`。
> 状态标记同前：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办；优先级 P1；关联 MQ-13 / MQ-12。

- [x] **T-1 能力设计（✅ 2026-08-10）**：`invite`/`transfer` 加入能力注册表（`CapabilityId` 扩展）；未启用端点 503 守卫沿用；`GET /payments/capabilities` 暴露新端点清单
- [x] **T-2 store 层（✅ 2026-08-10）**：[store.ts](projects/payments/src/store.ts) 新增 `InviteStore`/`PgInviteStore`（create/get/list/markSettled/markCancelled/expireDue 惰性过期）、`TransferStore`/`PgTransferStore`（executeTransfer 单事务 claim→debit→credit，余额不足整笔回滚）；`SqlExecutor` 增加可选 `transaction` runner（server.ts 以 pg client BEGIN/COMMIT 实现）
- [x] **T-3 迁移（✅ 2026-08-10）**：`007_payment_invites.sql`（invite_id/payment_id/payer/payee/amount_wei/memo/due_at/status/settled_method/settled_ref + 索引）、`008_payment_transfers.sql`（transfer_id/from/to/amount/status/confirm_method/reference UNIQUE 幂等键 + 索引）
- [x] **T-4 service 层（✅ 2026-08-10）**：[service.ts](projects/payments/src/service.ts) `createInvite`（包装 a2a 意图+账单）/`getInvite`（读时惰性过期）/`listInvites`（按 payer/payee+状态）/`cancelInvite`/`settleInvite`（链上验 tx，过期→410 EXPIRED）/`payInviteByBalance`（余额结算，reference=inviteId 幂等，不足→400 INSUFFICIENT_BALANCE）；`createTransfer`（reference 幂等）/`confirmTransfer`（原子执行）/`getTransfer`/`cancelTransfer`/`listTransfers`；事件 `invite.created/settled/expired/cancelled`、`transfer.requested/executed/rejected`；`errors.ts` 新增 `EXPIRED`/`INSUFFICIENT_BALANCE` 码
- [x] **T-5 router 层（✅ 2026-08-10）**：[router.ts](projects/payments/src/router.ts) `POST /invites`、`GET /invites?address=&role=`、`GET /invites/:id`、`POST /invites/:id/cancel|settle|pay`、`POST /transfers`、`POST /transfers/:id/confirm`、`GET /transfers?address=&role=`、`GET /transfers/:id`、`POST /transfers/:id/cancel`
- [x] **T-6 服务端开关（✅ 2026-08-10）**：[server.ts](projects/payments/server.ts) `INVITE_ENABLED`/`TRANSFER_ENABLED` + `PgInviteStore`/`PgTransferStore` 注入 + `sql` executor（带 transaction runner）
- [x] **T-7 单元测试（✅ 2026-08-10）**：新增 `tests/invite-transfer.test.ts` **18 用例**：invite 状态机（创建/链上 settle/无效 tx 拒绝/重复 settle 幂等/取消/惰性过期 410/未来不期/按角色查询/余额支付成功+引用/余额不足分文不动/无 x402 时创建+余额结算可用而链上 settle 503/503 守卫）+ transfer 原子划转（reference 幂等/确认扣增正确/余额不足整笔不动/重复确认不双扣/取消后不可执行/503 守卫）；**全量 12 文件 124 用例全绿** + tsc/build 通过
- [x] **T-8 部署生产 + 验证（✅ 2026-08-10）**：迁移 007/008 上生产（migrations applied 8）→ drop-in 开启 INVITE/TRANSFER_ENABLED → 探测 /capabilities（chain, period, invite, transfer）→ `scripts/mq14_verify.sh` 11 步全通过：邀请创建/双角色查询/余额支付（payer 1000000→900000、payee 100000）/transfer 充足执行（300000 划转）/余额不足 422/重复 confirm 幂等不双扣/过期状态/测试数据清理；过程中修复 listInvites+expireDue SQL 占位符错位（commit 34e2e4e）
- [x] **T-9 文档更新（✅ 2026-08-10，commit f637263）**：README（能力清单+迁移 001-008+invite/transfer 端点与能力说明）/HANDOVER（§1 能力范围、§2 矩阵新增 invite/transfer 行、迁移表 005-008、§8 生产实测、§10 修正 MQ-13 推翻说明+占位符踩坑、§12 开关）/CALLER_SETUP（账本内结算模型、嵌入式注入+事务 runner 示例、env 开关、自检清单 6-7 项）

**MQ-15 旧 payment 服务下线迁移（2026-08-10 需求登记；方案：前端切至 waas 订阅 → admin 收口 → 停服归档）**：
> 背景：盘点确认旧 payment（:9106，projects/payment）为**僵尸服务**——唯一调用方是 web proxy `/api/v2/payment → :9106`，而前端请求的端点一半不存在（`/x402/request`、`/methods` 404，其余靠 afetchMock 兜底成空数据）；生产 `pocketx_payment.payment_orders` 仅 3 行全部 pending、最新 2026-07-21，近 3 周零新增、0 活跃连接；内部服务（mcp-server `PAYMENTS_URL→:9132`、waas MQ-12）早已迁移新引擎。方案分两阶段：**阶段一**前端路由切换（Payment 模块并入 waas 订阅流程、移除 proxy 路由与页面、admin 统计收口到 `pocketx_payments` 库）；**阶段二**停服归档（pg_dump → stop/删除 unit → 代码保留 git 历史）——T-6 验证无回归后**应业务要求于 2026-08-11 直接执行 T-7 停服**（未等待 1 周观察期）。
> 状态标记同前：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办；优先级 P1；关联 MQ-12 / MQ-14。

- [x] **T-1 前端 payment 模块并入 waas 订阅（✅ 2026-08-10）**：[payment.js](projects/web/modules/payment.js) 四个端点（`/x402/request`、`/create-order`、`/orders`、`/methods`）全部改走 WaaS 订阅 API——`/api/v2/subscription/plans`（套餐列表渲染 + 卡片直接订阅）、`/api/v2/subscription/me`（当前套餐状态）、`waasUpgradePlan`（free 直通/chain 轮询/fiat 跳转/x402 输 txHash，已走 :9132）；Payment 导航点击 → [core.js](projects/web/modules/core.js) 分发至 `switchToWaasSubscription()` 跳转 WaaS 订阅页（高亮保留在 Payment 导航项）
- [x] **T-2 web proxy 移除路由（✅ 2026-08-10）**：[server.js](projects/web/server.js) 删除 `/api/v2/payment` → `PAYMENT_HOST:PAYMENT_PORT(:9106)` 代理 + `PAYMENT_HOST`/`PAYMENT_PORT` 常量（health `backends` 与启动日志自动派生，随之更新）；node --check 通过
- [x] **T-8 SDK PaymentClient 迁移（✅ 2026-08-10）**：[sdk/src/index.ts](projects/sdk/src/index.ts) `PaymentAPI` 由旧 `/api/v2/payment/*`（:9106）全面改为对接新引擎 :9132 `/payments/*`——新增 `paymentsUrl`/`paymentsApiKey` 独立 HttpClient（模式同 data/ml/chainRpc）+ `getRaw`/`postRaw`（引擎响应非 InfraXResponse 包装）；新方法 `checkout/a2a/a2aSettle/verify/balance/capabilities/price`；旧方法兼容壳保留（`create` 按 method 路由到 checkout/a2a、`confirm(paymentId,txHash)` → a2a/settle、`x402Info(planId)` → price）；移除 `status/history/x402Pay`（假支付，无新等价，SDK 无真实消费者）；类型全量替换（PaymentCheckoutParams/A2ACreateParams/A2ASettleParams/PaymentVerifyResult 等）；[API_ACCESS.md](docs/API_ACCESS.md) 端点表 + SDK 示例更新（旧 x402Pay 示例 → checkout/a2a/a2aSettle/verify）；[landing.html](projects/web/landing.html#L240) 示例 `createOrder()` → `payment.checkout()`；`npm run build`（tsc）通过
- [x] **T-3 页面清理（✅ 2026-08-10）**：[index.html](projects/web/index.html) 移除 Payment 导航项、`page-payment` 区块（L767-999）与 `payment.js` script 引用；[core.js](projects/web/modules/core.js) 同步清理 `paymentEnabled` 变量、`PAGE_TITLES.payment`、afetchMock 的 `/api/v2/payment/*` 条目、setupNav payment 分支、loaders 两处 `payment: paymentInit`、tab 映射 `pay-*`（全部对已删函数的引用，否则 ReferenceError）；删除 [payment.js](projects/web/modules/payment.js)；[landing.html](projects/web/landing.html) 静态文案 `:9106 · Web3-native billing` → `:9132 · Universal payment gateway`（含架构图）；node --check 通过；残留确认：waas.js `d.payment` 为新引擎订阅返回对象（保留）、admin.html i18n 字典（保留）、landing L240 `infrax.payment.createOrder()` SDK 示例（归 T-8 SDK 迁移）
- [x] **T-4 admin 统计收口（✅ 2026-08-10）**：[admin/server/index.ts](projects/admin/server/index.ts) pool `payment→pocketx_payment` 改为 `payments→pocketx_payments`（env `PAYMENTS_DB`）；dashboard `totalRevenue`：`payment_orders confirmed` → `payment_intents status='paid'`；revenue 30d：`payment_orders` 按 status 分组 → `payment_intents` 按 status 分组；服务状态 `payment:9106` → `payments:9132`（健康检查 /health）；[Revenue.tsx](projects/admin/src/pages/Revenue.tsx) 修复历史遗留 `p.total_usd`（后端从未返回，恒 NaN）——30d Revenue 卡改为 paid 意图笔数，表格去除 Total USD 列；`npm run build`（tsc+vite）通过
- [x] **T-5 联调验证（✅ 2026-08-10）**：新增 [mq15_verify.sh](projects/web/scripts/mq15_verify.sh)（`static` 本地静态回归 7/7 通过：web/admin/sdk 零旧引用 + 语法检查；`api` 生产联调 14/14 通过）——payments 引擎 :9132（health/capabilities=chain,period,invite,transfer/price/balance）；waas 订阅全流程（plans 三套餐 → free→active → /me → pro chain rail 支付信息含 price → 回归 → 测试钱包数据清理）；admin /health 正常；fiat 未启用按能力开关跳过断言；日志基线：web 24h 内 :9106 命中 1 次（部署前，T-6 后复核应恒 0）、admin 0 次
- [x] **T-6 生产部署 + 观察（✅ 2026-08-11 部署完成，观察期至 08-18）**：生产 git 仓库 c9917c3 → **4fe67d7**（清理 28 个 MQ-12~14 scp 残留未跟踪文件：备份 `/tmp/untracked_conflict.tgz` + `/tmp/mq_residue.patch`，payments 迁移 006/007/008 + paymentsClient.ts 由提交正式版接管，ragservicer/data 与 .env.bak 保留）；admin `npm run build`（Revenue 统计 UI）；重启 infrax-payments（migrations 8，capabilities: chain,period,invite,transfer）/infrax-web（代理路由已无 `/api/v2/payment`）/infrax-admin；验证——web 首页零 payment 引用、`POST /api/v2/payment/create` 返回 HTML（路由已移除）、**web/admin 日志自重启后 :9106 命中 0**、admin dashboard/revenue 读 `pocketx_payments`（login token 流程）、mq15_verify.sh api **16/16 全绿**（含日志归零断言）；**观察 1 周**至 08-18 无回归后执行 T-7
- [x] **T-7 停服归档（✅ 2026-08-11，应业务要求跳过观察期直接执行）**：`pg_dump pocketx_payment` → `/home/ubuntu/backups/pocketx_payment_20260811.sql`（146 行，payment_orders 3 行历史订单全 pending）→ `sudo systemctl stop --now infrax-payment`（服务本为僵尸 inactive，无存活进程）→ 删除 `/etc/systemd/system/infrax-payment.service` + `daemon-reload` → 确认 9106 端口无监听；[README.md](README.md)/[DEPLOYMENT.md](DEPLOYMENT.md) 全量标注已下线（服务表/拓扑图/目录结构/防火墙端口/重启列表/DB 列表/部署循环/健康检查端口/修复备忘；服务计数 25→24）；`projects/payment` 代码保留 git 历史

**9.8.9 MQ-16 对外套餐服务矩阵（2026-08-10 需求登记；方案：以 waas 订阅为模板 + 引擎统一账本/period 能力）**：
> 背景：盘点对外服务套餐能力——waas 已有完整闭环（`subscriptions` 表 + pending→active + 三 rail 支付，MQ-12，作为模板）；dc 有套餐模型但**配额无真实扣减**（usage 硬编码 0、全仓无 api_usage 写入方）；market（39 端点免费）、chain-rpc（对外读）、mpc（Agent Wallet）无套餐；agent 专属能力（invite/transfer/batch）未对外开放。方案：统一入口复制 waas 订阅模式——业务服务管"权益激活"、支付引擎管"钱"（chain/fiat/x402 收钱 + 账本 balance/credit/deduct 记钱 + period 周期授权扣费 + invite/transfer/batch 满足 agent 场景）。优先级：DC 配额真实扣减（P0）→ Market/Chain RPC 按量套餐（P1）→ MPC/Agent 专属开放（P2）。
> 状态标记同前：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办；优先级 P1（T-1 P0）；关联 MQ-12 / MQ-14 / MQ-15。

- [x] **T-1 DC 套餐配额真实扣减（✅ 2026-08-11，P0）**：[dc/index.ts](projects/dc/index.ts) 落地——新增 `api_usage`（tenant_id/endpoint/timestamp 请求级明细，idx_api_usage_tenant_ts）与 `api_usage_daily`（tenant_id/date/endpoint/total_calls 日聚合，PK 复合）**写入方**（对齐 waas dataSubscriptionRoutes 已读表结构）；`tenants` 新增订阅状态列（`dc_sub_status`/`dc_payment_method`/`dc_payment_ref`/`dc_sub_updated_at`，pending→active 状态机）；`dcQuotaEnforce` 中间件（COUNT 月度用量 + 请求级落库 + 日聚合 upsert，超配额 → **429** + 升级提示，记账故障不阻断业务）；6 个 B 端端点（events/stats/health/checkpoints/tokens/raw-receipt）全量挂载扣减；订阅购买走引擎（chain/fiat/x402 三 rail，PAYMENTS config + paymentsApi 客户端 + `activateDcSubscription` 幂等激活补发 dc_api_key）；新增端点——`POST /api/v2/data/payment-check`（chain rail 轮询）、`POST /api/v2/data/payment-callback`（引擎 webhook，HMAC-SHA256 验签，`dcsub:` clientReference 前缀，webhook/credit 两种事件）、`POST /api/v2/data/verify`（x402 rail txHash 确认）；`/api/v2/data/usage` 改为真实用量（api_usage COUNT + api_usage_daily 列表 + dcSubStatus）；前端 [datacenter.js](projects/web/modules/datacenter.js) 适配付费流程（chain 显示链上订阅信息+轮询 / fiat 跳转 sessionUrl / x402 prompt txHash 后 verify，参考 waasUpgradePlan）+ free 直通不变 + pending 态 intro 提示与「刷新支付状态」按钮 + 修复 explorer 无结果误判；[index.html](projects/web/index.html) 新增 `dc-sub-status` 支付状态元素。⚠️ 备注：引擎 webhook 转发器原为**单目标**（指向 waas），生产仅 chain rail 启用时 DC 激活走 payment-check 轮询**无需 webhook**；fiat/x402 启用时需多目标转发——**已作为 T-2 前置项闭环（见下）**；**生产部署 + 验证（2026-08-11）**：`git` 3a6f821 → 生产 pull → infrax-dc drop-in `dc-payments.conf`（PAYMENTS_URL/API_KEY/WEBHOOK_SECRET/DEFAULT_RAIL=chain/CHAIN=oxachain/PLAN_ID_MAP）→ 重启 infrax-dc/infrax-web（表自举成功）→ [mq16_verify.sh](projects/web/scripts/mq16_verify.sh) **static 18/18 + api 18/18 全绿**（free 直通、真实用量扣减 0→1、data_pro chain rail pending+引擎价/chainId 19505、payment-check pending、灌库超配额 429、回调无签名 401、回归+清理）→ web :9111 代理与前端已生效
- [x] **T-2 前置项·引擎 webhook 多目标转发（✅ 2026-08-11）**：[forwarder.ts](projects/payments/src/forwarder.ts) `targetUrl` → `targets[]`（多业务方回调端点，事件逐一投递、各目标独立重试/退避、单目标失败不影响其余，reference 幂等对账）；[server.ts](projects/payments/server.ts) `WEBHOOK_FORWARD_URL` 逗号分隔解析；新增 2 条单测（多目标同事件体、目标隔离）——vitest 12 文件 126 用例全绿；生产 `webhook-forward.conf` 增配 DC 目标（waas + dc 双目标）
- [x] **T-2 配套·MQ-16 监控看板（✅ 2026-08-11）**：[dc/index.ts](projects/dc/index.ts) 新增 `GET /metrics`（免鉴权，Prometheus：`dc_subscription_status_total` 订阅状态分布 + `dc_quota_used_total/limit_total` 按套餐配额 + `dc_quota_usage_ratio` 租户使用率，15s TTL 防频繁查库，查库失败不影响业务）；Grafana 看板 [deploy/monitoring/mq16_dashboard.json](deploy/monitoring/mq16_dashboard.json)（活跃/待支付 Stat + 配额使用率趋势 + 已用 vs 上限柱状 + 状态分布饼图 + Top 20 租户表）+ 告警规则（>90% 配额 / pending>30min）+ Prometheus 抓取配置与 SQL 兜底查询见 [MQ16_MONITORING.md](docs/MQ16_MONITORING.md)
- [x] **T-2 配套·订阅交互文档（✅ 2026-08-11）**：pending 态 intro 提示 + 「刷新支付状态」按钮 + 三 rail 分支与辅助函数交互逻辑整理见 [DC_SUBSCRIPTION_UX.md](docs/DC_SUBSCRIPTION_UX.md)
- [x] **T-2 Market/行情 API 按量套餐（✅ 2026-08-11，P1）**：[collector](projects/collector) 落地——[marketPlans.ts](projects/collector/src/marketPlans.ts)（market_free 10k / market_pro 100k $49 / market_enterprise 1M $199，自然月结算，paymentsApi 客户端 + PAYMENTS_PLAN_ID_MAP `{"market_pro":3,"market_enterprise":4}`）；`api_keys` 新增订阅状态列（`market_plan_id`/`market_sub_status`/`market_payment_method`/`market_payment_ref`/`market_sub_updated_at`，free→pending→active 状态机）；[marketQuotaEnforce.ts](projects/collector/src/middleware/marketQuotaEnforce.ts) 中间件（COUNT 月度用量 + 请求级落库 + 日聚合 upsert，超配额 → **503** + 升级提示，记账故障不阻断业务）；[marketSubscriptionRoutes.ts](projects/collector/src/routes/marketSubscriptionRoutes.ts) 新增端点——`GET /api/v2/market/plans`（公开）、`POST /checkout`（免费直激活；chain→chainInfo；fiat→checkout sessionUrl clientReference=`mktsub:${keyId}`；x402→info.payTo）、`POST /payment-check`（pending + chain rail 轮询）、`POST /payment-callback`（HMAC-SHA256 验签，`mktsub:` 前缀激活）、`POST /verify`（x402 txHash）、`GET /usage`（真实用量）；39 个行情端点全量挂载计费；**生产部署 + 验证（2026-08-11）**：git efd54a3 → 生产 pull → infrax-collector drop-in `payments.conf`（PAYMENTS_URL/API_KEY/WEBHOOK_SECRET/DEFAULT_RAIL=chain/CHAIN=oxachain/PLAN_ID_MAP）→ 重启（表自举：market_usage/market_usage_daily + api_keys 5 列）→ [mq16_t2_verify.sh](projects/web/scripts/mq16_t2_verify.sh) **static 25/26 + api 16/16 全绿**（套餐列表、key 直插、真实扣减 0→1、usage、401、chain rail pending、payment-check pending、灌库超配额 503、回调无签名 401、清理）
- [x] **T-3 Chain RPC 对外读套餐（✅ 2026-08-11，P1）**：[chain-rpc](projects/chain-rpc) 落地——[rpcSubscription.ts](projects/chain-rpc/src/services/rpcSubscription.ts)（独立库 pocketx_chainrpc，表自举 rpc_keys（`rx_` 前缀，仅存 SHA-256 哈希 + `key_prefix`/`key_tail` 掩码）/rpc_usage/rpc_usage_daily；三档套餐 rpc_free 10k / rpc_pro 100k $79 / rpc_enterprise 1M $299 自然月结算；paymentsApi 客户端 + PAYMENTS_PLAN_ID_MAP `{"rpc_pro":5,"rpc_enterprise":6}`；free→pending→active 状态机 + HMAC 验签）；[auth.ts](projects/chain-rpc/src/middleware/auth.ts) readAuth 支持 `rx_` key 校验（findRpcKeyByRaw 哈希查询，禁用 key 401），本地 bridge key 豁免配额；[rpcQuotaEnforce.ts](projects/chain-rpc/src/middleware/rpcQuotaEnforce.ts) 中间件（月度配额 COUNT + 请求级落库 + 日聚合 upsert，超配额 → **503** + 升级提示，记账故障不阻断业务）；[rpcSubscriptionRoutes.ts](projects/chain-rpc/src/routes/rpcSubscriptionRoutes.ts) 新增端点——`GET /v1/subscription/plans`（公开）、`POST /issue-key`（本地 bridge key 签发 `rx_` key，默认 rpc_free）、`POST /checkout`（免费直激活；chain→chainInfo；fiat→checkout sessionUrl clientReference=`rpclin:${keyId}`；x402→info.payTo）、`POST /payment-check`（pending + chain rail 轮询）、`POST /payment-callback`（HMAC-SHA256 验签，`rpclin:` 前缀激活）、`POST /verify`（x402 txHash）、`GET /usage`（真实用量）；/v1/rpc 读端点全量挂载计费；**生产部署 + 验证（2026-08-11）**：git d3f6595 → 生产 pull → 建库 pocketx_chainrpc → infrax-chain-rpc drop-in `payments.conf`（CHAIN_RPC_DATABASE_URL/PAYMENTS_URL/API_KEY/WEBHOOK_SECRET/DEFAULT_RAIL=chain/CHAIN=oxachain/PLAN_ID_MAP，DATABASE 用 postgres:postgres）→ 重启（表自举 rpc_keys/rpc_usage/rpc_usage_daily）→ [mq16_t3_verify.sh](projects/web/scripts/mq16_t3_verify.sh) **static 38/39 + api 18/18 全绿**（套餐列表、issue-key 签发、无 key/伪造 key 401、rx_ 读调用 200 + 真实扣减 0→1、usage、付费 chain rail pending、payment-check pending、免费直激活、灌库超配额 503、回调无签名 401、清理）
- [x] **T-4 MPC Agent Wallet 按量套餐（✅ 2026-08-11，P2）**：[mpc](projects/mpc) 落地——[mpcPlans.ts](projects/mpc/src/mpcPlans.ts)（新建，费用表 `mpcFees()`：签名三件套 sign_message/sign_typed_data/sign_digest 每次 **0.0001 ETH** + 写链两件套 send_transaction/contract_write 每次 **0.001 ETH**，`MPC_SIGN_FEE_WEI`/`MPC_TX_FEE_WEI` 可覆盖；`chargeMpcCall` 钱包地址即引擎 ledger subscriber——余额不足 → **402** + 充值提示，充足则 `POST /transfers`（from=钱包/`valueWei`/reference=`mpc:${operation}:${uuid}` 幂等）+ `POST /transfers/:id/confirm` 原子 debit+credit 扣费，引擎 422 insufficient 映射 402，记账故障 503 不静默）；[server.ts](projects/mpc/server.ts) 修改——`mpcMeter(operation)` 计费中间件挂 5 个收费端点，读操作（balance/contract-read/gas-estimate）**豁免**；新增 `GET /api/v2/mpc/plans`（公开，exempt，费用表 + 充值路径）与 `POST /api/v2/mpc/ledger-balance`（查引擎 ledger 余额 + fees + topupHint）；未配置引擎时免费放行（向后兼容）；[.env.example](projects/mpc/.env.example) 新建（MPC_PAYMENTS_URL/API_KEY/PLATFORM_ADDRESS/SIGN_FEE_WEI/TX_FEE_WEI）；充值链路：链上转平台钱包 `0x52Ec...8e06` → 引擎 `/payments/verify` 入账；**生产部署 + 验证（2026-08-11）**：git 6980dd9 → 生产 pull → infrax-payments 开 TRANSFER_ENABLED + infrax-mpc drop-in `payments.conf`（MPC_PAYMENTS_URL=http://127.0.0.1:9132/API_KEY/PLATFORM_ADDRESS/费率）→ 重启（configured:true）→ [mq16_t4_verify.sh](projects/web/scripts/mq16_t4_verify.sh) **static 34/34 + api 20/20 全绿**（注册→journal 取码→解锁→0 余额 402→灌余额→扣费 0.001→0.0009→重复扣费→读豁免→耗尽 402→清理）
- [x] **T-5 Agent 专属能力开放（✅ 2026-08-11，P2）**：invite/transfer/batch 端点对外开放 + CALLER_SETUP 调用文档（自动收费邀请、账本内转账、批量收款）——[payments](projects/payments) 收尾——**外部 key 链路修复**：[server.ts](projects/payments/server.ts) `scope: 'payments'` → `'payment'`（对齐 data `PREFIX_BY_SCOPE` px_，此前外部 px_ key 被降级 mcp 校验必 401）+ 生产 drop-in 补 `DATA_API_KEY`（此前为空 → 外部 key 校验完全未启用）；**batch 开放**：生产启用 x402 rail（`X402_ENABLED=true` + `X402_PAY_TO=0x52Ec...8e06` 平台钱包 + `X402_PRICE_WEI=1e15` + `X402_CHAIN=oxachain`）→ capabilities 现含 `chain, x402, a2a, batch, period, invite, transfer` 全量（batch 依赖 x402，同时打通 MPC 充值链路：链上转平台钱包 → `/payments/verify` 入账）；**调用面**：外部调用方持 data 签发 px_ key（scope=payment）三 header 任一直接调引擎，engine 经 `POST {DATA_URL}/api-keys/verify` 实时校验（scope 已对齐）；**文档**：[CALLER_SETUP.md](projects/payments/CALLER_SETUP.md) 新增 §6「Agent 专属能力调用」——三场景端到端（invite 自动收费邀请含余额支付/链上 settle + 状态机与列表语义、transfer 账本内原子划转 + reference 幂等、batch 批量收款 + x402 settle）+ px_ key 用法 + 错误码速查；**生产部署 + 验证（2026-08-11）**：git 8cae0cd → 生产 pull → drop-in `open-external.conf`（DATA_API_KEY + x402 五项）→ 重启（capabilities 全量）→ [mq16_t5_verify.sh](projects/web/scripts/mq16_t5_verify.sh) **static 23/23 + api 24/24 全绿**（px_ key 签发→外部调用 200→invite 创建/余额不足失败/灌余额结算/幂等/查询→transfer 创建 reference 幂等/confirm 原子/余额不足 422→batch 创建/状态/cancel→伪造 key 401→清理）

**9.8.10 RPC 基础设施切换（2026-08-12 需求登记；源：docs/FEATURE_REQUEST_RPC_SWITCH.md，AIHunter SaaS 提出）**

> 背景：AIHunter SaaS 决定将全部链上 RPC 基础设施切换至 InfraX chain-rpc 网关（:9130），5 处 RPC 依赖收敛为 1 网关 + 2 key。现有阻塞：chain-rpc 仅内网（nginx 未配公网路由）、链集缺 polygon/arbitrum/optimism（对齐 OKX ChainOS 7 链执行面）、读/广播 key 需为我方签发。目标版本 infrax-dk ≥ 0.6（ChainRpcAPI 已具备）。

| 编号 | 任务 | 说明 | 状态 | 优先级 |
|---|---|---|---|---|
| RPC-1 | 公网接入路径 | nginx 为 `/v1/rpc/:chain` `/v1/broadcast/:chain` `/v1/status` `/v1/subscription/*` `/v1/ws` 提供 **HTTPS 公网入口**（建议独立域名如 `rpc-gw.0xainet.top` 或 Cloudflare 路由），复用平台 key 鉴权（X-API-Key/X-Service-Key/Bearer 三选一契约不变）；交付公网 base URL + TLS 证书有效说明（或等价 VPN/跳板方案） | ✅ **已完成+生产验证**（2026-08-13：DNS 橙云 + certbot SAN 证书 + nginx 反代；`https://rpc-gw.0xainet.top/v1/rpc/polygon` eth_chainId=0x89、arbitrum blockNumber 全通） | P0 |
| RPC-2 | 双 key 签发（AIHunter） | 为 AIHunter 签发读 key（`rx_` scope=rpc）+ 广播 key（scope=rpc_broadcast）；验收：读 key 调广播端点 → 401、广播 key 可读可广播、`X-Json-Rpc: raw` 透传正常 | ✅ **已完成+生产验收**（2026-08-14：修 3 处阻断——data `PREFIX_BY_SCOPE` 增 `rpc`/`rpc_broadcast`（cr_ 前缀）+ verify 家族互认（广播 key 可读）；chain-rpc 开启 `CHAIN_RPC_ENABLE_EXTERNAL_VERIFY=true` + 注入正确 `DATA_API_KEY`（⚠️ 曾因 `tr -d "\"\x27"` 污染 key）；签发 rx_ 读 key（keyId=3）+ cr_ 广播 key（id=29）；验收 4/4 全绿：读 key 调广播 401 / 广播 key 读 eth_chainId 200 / 广播鉴权通过（非 401）/ raw 透传 `{"jsonrpc":"2.0","id":9,"result":"0x38"}`） | P0 |
| RPC-3 | 链覆盖补齐 | 现有 6 链（sepolia/ethereum/bsc/base/oxa/solana）保持稳定；**新增 polygon/arbitrum/optimism**（对齐 OKX ChainOS 多链执行面，路由表 137/42161/10；补齐 broadcast 兜底与风控链读缺口）；链参数与链 ID 映射文档化（`GET /v1/status`/plans 返回完整链表） | ✅ **已完成+生产验证**（2026-08-13：rpc-pool.json 公共端点 + CHAIN_RPC_CHAINS 全链已部署；curl /v1/rpc/{polygon,arbitrum,optimism,xlayer} chainId/blockNumber 全通：0x89/0xa4b1/0xa/0xc4） | P1 |
| RPC-4 | 方法白名单确认 | 放行 AIHunter 读方法清单（`eth_blockNumber/chainId/gasPrice/feeHistory/eth_call/getBalance/getCode/getStorageAt/getTransactionByHash/getTransactionReceipt/getBlockByNumber/getLogs` + solana `get*`）；非白名单 403 语义保留 | ✅ **已完成**（2026-08-13 核对 chainProfiles.ts：EVM_READ_METHODS/SOLANA_READ_METHODS 已覆盖清单全部方法，非白名单 403 由 whitelist.ts 保证） | P1 |
| RPC-5 | 生产 SLA 与配额 | 免费套餐（rpc_free）单 key 月度配额/并发；pro/enterprise 建议与定价；超限 503 升级路径；P95 读 < 500ms（单链非 batch）；batch 并发上限 8、≤100 条/批确认（信号链同秒多策略并发） | ✅ **已完成+生产验证**（2026-08-14：RPC_PLANS 加 per-plan `concurrent`——free 10k/月+并发10、pro $79 100k+并发50、enterprise $299 1M+并发200；rpcQuotaEnforce 加 per-key in-memory 并发限制，超限 503+upgradeUrl（25 并行 → 15 个 503 ✓）；月度配额 10k + 记账 rpc_usage 生效（今日 bsc 15 条 ✓）；P95 实测 bsc p50=223ms/p95=468ms 达标；⚠️ ankr 免费端点全挂时受影响链 p95 尖峰 3~8s（池故障转移保可用性，pro/enterprise 建议付费端点） | P1 |
| RPC-6 | 广播语义确认 | `wait=true` 回执轮询语义稳定；`confirmed=false` 错误/超时语义；非 2xx 重试建议；广播链覆盖同 RPC-3（含 oxa 19505——nft/subscription 写路径） | ✅ **已完成+生产验证**（2026-08-14：wait=true 默认 30s/3s 轮询（timeoutMs 可覆盖），确认→`confirmed:true+receipt`、超时→HTTP 200 `confirmed:false reason:"timeout"`；wait=false→立即 `confirmed:false reason:"wait=false"`；**修复 waitReceipt 轮询容错**（上游端点异常不再中断抛 502，吞错续轮至超时，生产实测 8.8s→timeout ✓）；重试建议：先查 txHash 状态未上链再重发；广播链覆盖 10 链含 oxa 19505（/v1/status ✓） | P1 |
| RPC-7 | WS 订阅面 | `/v1/ws`（`eth_subscribe`）链覆盖与配额；高频链上事件订阅（预留，非当前阻塞） | ✅ **已完成+生产部署验证**（2026-08-14：修复 DC-5 纯透传性能瓶颈（1 客户端=1 上游连接+1 订阅的 N 倍放大）→ [wsHub.ts](projects/chain-rpc/src/services/wsHub.ts) 订阅去重注册表（同 (chain,subKey) 复用一条上游订阅，事件只拉一份网关内广播；最后一位客户端离开才 eth_unsubscribe；孤儿订阅确认清理）+ [ws.ts](projects/chain-rpc/src/routes/ws.ts) 重写（每链共享上游 refcount、鉴权分级 local/rx_/外部 data key、慢消费者背压驱逐 close 4004、rx_ key 连接数按套餐 concurrent 限制 close 4005、每客户端订阅上限 WS_MAX_SUBS_PER_CLIENT、ws 订阅计费 rpc_usage）；config 增 WS_MAX_BUFFER_BYTES/WS_MAX_SUBS_PER_CLIENT/WS_ENABLE_QUOTA；单测 [wsHub.test.ts](projects/chain-rpc/src/services/wsHub.test.ts)+[ws.e2e.test.ts](projects/chain-rpc/src/services/ws.e2e.test.ts) **21/21 全绿**（去重 isNew/共享广播/最后离开释放上游/孤儿 confirm=false/背压 4004/配额并发上限/4001/4002/4003/-32602）；生产部署（2026-08-14 16:03：scp 4 文件 → restart infrax-chain-rpc → `ws endpoint /v1/ws ready (RPC-7)` → 实测无 key/错 key 4001、newHeads/logs 订阅出本地 subId、非法类型 -32602、取消 true 全过） | P2 |
| RPC-8 | AIHunter 2026-08-16 接入需求单交付 | bx_ 广播订阅 key（读写分离双 key）+ 10 链集确认 + 方法白名单逐项 + 配额 SLA + 广播语义 + polygon/arbitrum/optimism 已上线 + 行情 RPC 免申请 | ✅ **已完成+公网验证**（2026-08-16：① `generateRpcKey` 支持 kind→`bx_` 前缀，issue-key 增 `kind` 参数，auth readAuth 兼容 rx_/bx_、broadcastAuth 新增 bx_（rx_ 不可广播）；broadcast 路由挂 rpcQuotaEnforce；② 签发 AIHunter rx_ 读 key（id=4）+ bx_ 广播 key（id=5），禁用旧 rx_ key（id=3）——key 值线下交付不入 git（rpc_keys 表仅存哈希）；③ solana 白名单补 `getSignatureStatuses`；④ **oxa 双端点容灾**：rpc-pool.json 增裸节点 `http://43.156.99.215:18545`（chain-rpc+collector），/v1/status oxa total=2 active=2；⑤ **方法级 RPC 错误语义修复**：rpcCall 对节点 JSON-RPC error（revert/无效参数/nonce/余额——节点健康）不再重试3次并降级端点，原样上抛；raw 模式 HTTP 200+JSON-RPC error（viem/ethers 正确解析，此前 502 被 viem 判 HttpRequestError 丢语义）、信封模式 400 `{detail:节点消息, code:"rpc_error"}`——公网实测 solana 无效签名→400、bx_ 广播无效 tx→`invalid sender` 400；⑥ 公网全链路验证：rx_ 读 oxa/eth/bsc/base/sol 全 200、rx_ 广播 401、bx_ 读 200、bx_ 广播鉴权过、oxa 20/20 压测无失败；完整答复见 [FEATURE_REQUEST_RPC_SWITCH.md §七](FEATURE_REQUEST_RPC_SWITCH.md) | P0 |
| RPC-9 | AIHunter 追加需求：标准 JSON-RPC 2.0 兼容端点 | `/v1/rpc/{chain}`、`/v1/broadcast/{chain}` 支持 ethers/viem/Web3.py 零改动直连 | ✅ **已完成+公网验收**（2026-08-16：内容协商——请求体含 `jsonrpc:"2.0"`（单条或 batch 数组）自动标准 JSON-RPC 透传（`{jsonrpc,id,result\|error}`，错误码 -32601/-32602/-32000 语义透传），无 `jsonrpc` 字段走旧信封（waas/dc/mcp-server/sdk 零影响），显式 `X-Json-Rpc: raw` 强制标准；广播标准 body `eth_sendRawTransaction` → `result:"0xtxhash"`，wait 语义保留在信封模式；公网验收全过：ethers `JsonRpcProvider(FetchRequest.setHeader)` eth_chainId=0x4c31/eth_call ✓、viem `http(url,{fetchOptions:{headers}})` getChainId/getBlockNumber ✓、batch `[{jsonrpc,id,result}×3]` ✓、`eth_sign`→403 -32601 ✓、bx_ 无效 tx→200 -32000 `invalid sender` ✓、rx_ 广播→401 ✓、信封回归 code:0 ✓；详见 [FEATURE_REQUEST_RPC_SWITCH.md §七之二](FEATURE_REQUEST_RPC_SWITCH.md) | P0 |

> 备注：附 A 6 个使用点切换由 AIHunter 侧执行（risk-engine env 切换 / broadcast 兜底 / chain-sync / nft / subscription）；验收 = 6 使用点全量切换后 24h 生产无 RPC 错误（用现有监控对账）。

**9.8.11 PocketX aa-sdk 发布（2026-08-12 需求登记；源：docs/FEATURE_REQUEST_POCKETX_AASDK_ACCESS.md，PocketX 提出）**

> ⚠️ **与 §9.11 白标决策关系（2026-08-12 用户裁定）**：**不单独发布 `@infrax/aa-sdk`**，维持 §9.11 决策（并入 `@0xinfrax/session-key-core` v0.2.0 以 `Aa` 命名空间导出，✅ 已发布）——**要求功能覆盖** PocketX 需求单 3 处兼容（AASDK-2/3/4 在现有包内补齐，见下）。关联 E-1（aa-sdk 三缺口）与 tasklist A-4（Paymaster）。
> ✅ **2026-08-16 补充（PocketX 三项阻塞响应）**：PocketX 反馈 `@infrax/aa-sdk` 与 `session-key-core` registry 404 无法安装。已按对方要求另行发布**独立 SDK `@0xinfrax/aa-sdk@0.1.0`**（`@infrax` scope 私有发布需付费 E402，改 `@0xinfrax` scope + `--access public`；`npm install @0xinfrax/aa-sdk`）——与 `Aa` 命名空间（session-key-core）双通道并存，PocketX 可任选；`@0xinfrax/session-key-core@0.2.1` 本就已发布（对方误查无 scope 名）。aa-relay 公网入口 `https://rpc-gw.0xainet.top/aa-relay/` 同步就绪，三项阻塞全部关闭（详见 `docs/PAYMASTER_PROVISION_REQUEST.md` 八）。

| 编号 | 任务 | 说明 | 状态 | 优先级 |
|---|---|---|---|---|
| AASDK-1 | 发布形式裁定 | ✅ **已裁定（2026-08-12 用户）**：不单独发包，维持 `Aa` 命名空间（session-key-core v0.2.0）——功能覆盖为准，不发布独立 `@infrax/aa-sdk`；**2026-08-16 同步（PocketX 实际接入方式）**：对方实际使用独立包 `@0xinfrax/aa-sdk@^0.1.1`（含 0.1.1 headers 修复，三包 wallet-base/pocketx-ui/pocketx-sdk 回归全绿），与 `Aa` 命名空间**双通道并存** | ✅ 已裁定（接入方式 2026-08-16 同步） | P0 |
| AASDK-2 | 导出 `entryPointAbi` | `activate.ts` 中模块私有 `const entryPointAbi` → 在 session-key-core `Aa` 命名空间导出（PocketX wallet-base `host/aa.ts` 依赖，用于 EntryPoint 只读调用） | ✅ 完成（`activate.ts` `export const entryPointAbi` + `Aa` 命名空间导出，core v0.2.1） | P1 |
| AASDK-3 | 导出 `parseBundlers` | `config.ts` 中私有函数（缺省抛错）→ 在 session-key-core `Aa` 命名空间导出（保留抛错语义，PocketX 侧自行容错包装"非法/缺失 → []"） | ✅ 完成（`config.ts` `export function parseBundlers` + `Aa` 命名空间导出，保留抛错语义，core v0.2.1） | P1 |
| AASDK-4 | MpcSigner 双端点兼容（✅ 方案定稿 2026-08-12） | 技术方案：[AASDK4_A11_TECH_DESIGN.md](docs/AASDK4_A11_TECH_DESIGN.md) §1。**方案 A**：MpcSigner 构造兼容 `string \| {email?\|token?}`（token 模式走现有 sign-digest/sign-message；email 模式走 mpc-server 新增 `/api/v2/mpc/sign {message, mode:'digest'\|'eip191', email}`，鉴权语义=email 关联钱包已解锁会话，不引入裸 email 鉴权）；子任务 AASDK-4.1~4.4 | ✅ 已裁定（方案 A） | P0 |
| AASDK-4.1 | mpc-server 新增 `/api/v2/mpc/sign` | email 定位钱包 + 解锁会话校验 + mode digest/eip191 双分支 TSS 签名（复用 `tssSign`/`ethersSignatureFromRs`）；401 语义（email 未解锁）；对齐 sign-digest/sign-message 返回信封 | ✅ 完成（2026-08-12 生产回归：TSS/Shamir 双钱包 digest+eip191 双模式签名，恢复地址均匹配） | P0 |
| AASDK-4.2 | MpcSigner 双模式改造 | `aa-sdk/src/signers/mpc.ts`：构造兼容 `string \| {email?\|token?}`；signUserOp（digest）/signMessage（eip191）双模式路由；barrel 导出 `MpcSignerAuth` | ✅ 完成（2026-08-12：[mpc.ts](projects/session-key/packages/core/src/aa/signers/mpc.ts) MpcSignerAuth token\|email 双模式 + 路由 + barrel 导出） | P0 |
| AASDK-4.3 | 回归与联调验证 | aa-sdk vitest（构造三形态/双模式路由/401 语义）；生产 mpc-server `/sign` 双模式 curl E2E（unlock 后 email 签名与 token 签名一致性比对） | ✅ 完成（2026-08-12 生产：TSS 钱包 register→unlock→sign digest+eip191 恢复地址校验通过；Shamir 钱包同验） | P0 |
| AASDK-4.4 | PocketX 侧回归（外部） | PocketX 替换 import → `@0xinfrax/aa-sdk@^0.1.1`（独立包，2026-08-16 实际接入）+ 适配；wallet-base tsc/vitest 44/44 + build 回归 | ✅（2026-08-16 PocketX 三包回归全绿，alto 直连验证 PASS） | — |

> 备注（PocketX 收到包后执行，非 InfraX 任务）：**接入包更新（2026-08-16）**：PocketX 实际替换 `@pocketx/aa-sdk` → **独立包 `@0xinfrax/aa-sdk@^0.1.1`**（三包 wallet-base/pocketx-ui/pocketx-sdk 回归全绿；alto 直连验证 PASS），非 `session-key-core` 的 `Aa` 命名空间（该通道保留，双通道并存）；wallet-base tsc/vitest 44/44 + build 回归 + aa-relay/Paymaster 联调（E-1b 待生产部署）。

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
| `docs/MCP_REQUIREMENTS.md` | MCP 工具清单（Wallet/DC/Market/Vault/MPC/SK 6 组） | §9.6 + §9.7 | ✅ 已上线（MQ-6：5 个 MCP 入站鉴权已完成） |
| `docs/SESSION_KEY_ENGINE_DEV_PLAN.md` | Session Key 开发任务（v1.0） | §9.4 | ✅ Released（MQ-5） |
| `docs/SESSION_KEY_ENGINE_PRD.md` | Session Key PRD（S-01~S-11） | §9.4 | ✅ Released（MQ-5） |
| `docs/MERGE_PLAN_AITRADER.md` | AItrader 合并计划 | §9.5 | — |
| `prd/PRD.md` | MCP & Skill 产品需求（v1.1） | §9.6 + §9.7 | ⚠️ 待审阅（2026-08-08 更新：§4 加架构决策注记 TEE 降级 P3、新增 §4.5 MPC 独立 SDK 需求 → tasklist MQ-10 补充 E-5）；✅ **§3 Phase 1（DC 事件分类）已实施完成（2026-08-12，`0c5605a`+`37387dd`+`3f2a9ce`，生产 E2E 全绿）** |
| `docs/MCP_USAGE.md` / `docs/SDK_INTEGRATION.md` | MCP/SDK 使用与集成 | §9.7 | ✅（MQ-6：SDK 发布记录已修正 0.3.0；2026-08-08 更新 SDK 0.5.0 `chainRpc` + MCP `rpc-index` 4 工具；SDK 0.5.1 `walletAddress`+`walletSign` 钱包签名鉴权 + MCP 7 服务入站 `inboundAuth` 闭环） |
| `docs/DEPLOYMENT.md` / `docs/PROJECT_STATUS.md` 等 | 区块链栈部署/状态（旧布局） | §9.8 | ⚠️ 引用已随改名更新 |
| `docs/FEATURE_REQUEST_RPC_SWITCH.md` | RPC 基础设施切换 InfraX（公网入口 + 双 key + 链补齐 + SLA，AIHunter SaaS） | §9.8.10 | ✅ **已完成**（2026-08-16：RPC-1~RPC-9 全部交付并公网验证——公网 `rpc-gw.0xainet.top` + rx_/bx_ 双 key + 10 链集 + 方法白名单 + 配额 SLA + 广播语义 + 标准 JSON-RPC 兼容端点；详见 §9.8.10） |
| `docs/FEATURE_REQUEST_POCKETX_AASDK_ACCESS.md` | `@infrax/aa-sdk` 发布 npm + 3 处 API 兼容（PocketX） | §9.8.11 | ✅ **已完成**（2026-08-16：AASDK-1~4.4 全部交付；另按对方要求发布独立 `@0xinfrax/aa-sdk@0.1.1`（含 0.1.1 headers 修复），与 `Aa` 命名空间双通道并存；aa-relay 公网入口就绪） |
| `docs/FEATURE_REQUEST_MARKET_RPC_DEX_EXEC.md` | 行情数据 RPC + DEX 交易执行（AIHunter SaaS） | §9.10 | ✅ **全部完成**（2026-08-14/16：A-11.1~A-11.7 DEX 聚合真实订单 E2E 成功；A-12 行情 RPC + x402 门控、A-13 同源同缓存、A-14 ws 订阅均生产验证） |
| `docs/FEATURE_REQUEST_SESSION_KEY_AUTOEXEC.md` | Session Key 自动交易托管：托管实例 + SDK 封装 + 安全加固（AIHunter SaaS） | §9.10 | ✅ **已完成**（2026-08-15：A-15~A-18 全部交付——托管实例 :3500 生产运行 + SessionKeyAPI 并入 SDK + 多链执行 + 安全加固） |
| `docs/req-04-infrax-mlservice-arch-opt.md` | ml-service 架构优化（Provider 注册表/Device 参数化/因子解耦/统一端点） | §9.15 | ✅ 已实现（2026-08-14 完成；R4-2 用户决策跳过，余全完成并生产验证） |
| `docs/req-05-auto-find-factor.md` | 自动寻找因子（对话驱动 + 偏好/限制，MCP 工具集） | §9.15 | ✅ 已实现（2026-08-14；R5-3 MCP 生产部署 :3014；R5-4 LLM 意图解析生产已配置 deepseek-v4-flash） |
| `docs/req-06-factor-factory.md` | 因子工厂（挖掘/评估/管理/入库 → data-service `/factors/current`） | §9.15 | ✅ 已实现（2026-08-14；FF-1~FF-4 全绿，含 FF-4.1 定时调度线程） |
| `docs/FACTOR_FACTORY_HW_EVOLUTION.md` | 因子工厂硬件进化方案（双路 2683v4+64G+V100 32G，两阶段） | §9.15 | ⏸️ 延后（2026-08-12 用户决策：硬件升级延后，先做当前阶段 CPU 优化；HW-1） |
| `docs/INFRAX_REQ_SUMMARY_ARCH_AUTOFIND_FACTORY.md` | 需求 4/5/6 汇总 + 附录 A 复合/非线性因子计算架构 | §9.15 | 汇总文档（同 R4/R5/FF 状态） |
| `docs/MOOMOO_DATA_INTEGRATION.md` | MooMoo 行情强化接入（K线/宏观/新闻/资金流/F10/卖空/日历/榜单/筛选，15 任务） | §9.14 | 🔲 **待评审 → ✅ 已评审执行中**（2026-08-13 用户确认：全量接入 MM-1~MM-10，含新闻/资金流/Kronos 供给；MM-7 OpenD 生产化 P0 前置） |
| `docs/PAYMASTER_ONCHAIN_ESCROW_DESIGN.md` | 平台钱包 EOA → 托管合约 + 计费链上化（Escrow 记账合约 + relay 双轨 + 对账，P1） | §9.20 | 🔲 **已登记**（2026-08-16：OE-1~OE-8，阶段 1 优先消除 EOA 资金单点风险；治理不引入外部多签，由智能合约直接承担） |

**9.10 微服务定位纠正与体验对齐（2026-08-11 商业评审，对标 OKX OnchainOS）**

> 背景：本轮评审纠正了此前对 waas/vault/mpc 的**定位偏差**（曾把 waas 的 API 身份认证误当"钱包操作签名"、把 vault 用户签名误当"集成方负担"）。以下为**纠正后的正确模型**，作为后续功能/文档/任务基准；相关文档（services/waas.md、vault.md、mpc.md、SDK_INTEGRATION.md、README 对比表）的偏差表述按任务 A-1 统一修正。

**W-1 WAAS = 类 CEX 托管模型（签名全部在平台内部，外部零链上签名）**

- 私钥：平台托管（`custodial_wallets` + `address_pool` 地址池），B 端与 C 端用户**均不持私钥**
- 充值：C 端用户打币到分配地址 → 平台链上监控确认入账
- 提币：C 端发起请求 → B 端业务审批（风控策略 / 后台审核）→ **平台托管私钥签名广播**
- EIP-191 `walletSign` = **API 身份认证**（服务端按地址 24h sessionCache，仅身份识别），**非**钱包操作签名
- 提币授权 = `paymentPassword`（资金密码）+ B 端审批；**B 端 / C 端全程零链上签名**
- 对 L1 影响：waas **不在零签名差距内**（天然平台签名，无需签名代理）

**W-2 Vault = 用户自托管多签（签名方 = 用户本人，不可消除）**

- 用户建 Safe 多签合约、确认交易均**用户自己 EIP-712 签名**（自托管本质，属于产品特性而非负担）
- 可增强方向：用户以平台 **MPC 钱包 / session-key 作为 Safe owner** → confirm 签名收敛到平台签名通道（邮箱验证码解锁 / 一次性授权），但用户授权动作保留

**W-3 MPC = 邮箱验证码 + TSS 2-of-2 的 Agent 钱包（:9104）**

- 身份：**email 主 id**（小写唯一）+ `walletId` 子钱包（1 邮箱 N 钱包，UUID 定位）；支持按 `walletAddress`/`connected_wallet_address` 查询归属
- 验证码：6 位随机 / 5min 有效 / 5 次尝试上限 / 哈希存储 / 一次性；SMTP 真实发信（未配置回退日志）
- 会话：`session/unlock` 返回 `mpc_<hex>` token（默认 30min，DB 只存哈希，可 lock/status；重启不失效）
- 签名：M3 TSS 2-of-2（Node 持片1 AES + tss_signer 持片2 RecoveryKey，上下文分离，完整私钥永不重建）；`sign-message`/`sign-typed-data`/`sign-digest`（raw 32B，供 ERC-4337 userOpHash）
- 执行：`send-transaction`/`contract-write`/`contract-read`/`balance`/`gas-estimate`；限额（原生 0.1 ETH / ERC20 1000 / 合约·approve·transfer 白名单）
- 计费：MQ-16 T-4 按量（sign 0.0001 ETH / tx 0.001 ETH，引擎 ledger 扣费，402 余额不足）
- 链：sepolia/eth/bsc/base/oxa(19505)；审计 `mpc_agent_logs`
- SDK：`@0xinfrax/mpc-sdk` **0.3.0 已发布 ✅**（16 方法，npm = 本地）+ infrax-dk `infra.mpc.*` 15 方法

**W-4 L1（session-key 签名代理）方案修正**

- 原方案范围"waas+vault 零签名" → **修正为 vault 增强**（waas 无需代理，见 W-1）
- 新 L1 目标：统一"**平台签名通道**"——C 端用户用 MPC 钱包（邮箱验证码解锁）或 session-key（EIP-712 一次性授权）作为 Safe owner，vault confirm 由平台签名通道完成，用户签名从"每笔 EIP-712"收敛为"一次授权 / 验证码解锁"
- 实施前需完成 A-3（MPC 作为 Safe owner 的契约评估）；session-key Adapter 扩展（signMessage/signTypedData）评估后决定是否仍需要

**W-4.1 vault 增强方案（A-2/A-3 结论，2026-08-11 定稿）**

> A-3 可行性核实（源码级）：vault `confirm` 验签 = `ethers.verifyMessage(toUtf8Bytes(safeTxHash))`，即 **EIP-191 personal_sign**（非 Safe 标准 EIP-712）——[multiSigService.ts](projects/vault/src/services/multiSigService.ts) L597；MPC `sign-message` = EIP-191 personal_sign（TSS 2-of-2，`ethers.hashMessage` 摘要）——[server.ts](projects/mpc/server.ts) L863-868 → **签名格式完全匹配，vault/mpc 均零改造**。Safe owner 只是普通 EOA 地址，MPC 派生地址可直接作为 owner（链上无差别）。

**推荐路径（MPC 现成可用，优先）**：

1. 用户注册 MPC 钱包（邮箱验证码）→ 派生地址作为 Safe owner（`createSafe` 的 owners 传入）
2. 确认交易：前端/集成方携带 MPC session token（`session/unlock` 验证码解锁，30min 有效）→ vault 调 MPC `sign-message(safeTxHash)` → 得签名 → `confirm({signature})` → 达阈值自动执行
3. 体验：用户每笔确认输入邮箱验证码（30min 会话内免输），**无需 EIP-712 钱包签名**——对齐 CEX/OKX 的"验证码授权"体验

**⚠️ 集成点（必须处理）**：vault `executeTransaction` 打包签名依赖 vault DB `wallets` 表（`signer_id`→`address`）映射 owner 地址——MPC 钱包地址须登记进 vault `wallets` 表，否则 ownerSigs 打包为空；加固建议改为由 `safe_signatures.signer_id` 直接关联 owner 地址（或 confirm 时记录签名者 owner 地址），不再依赖 wallets 表。

**备选路径（session-key，需扩展）**：session-key 现有 `signAndBroadcast` 不返回签名，需新增 `signMessage` 方法后才可用于 confirm——作为并存选项，与 MPC 路径共用"平台签名通道"。

**W-5 体验对齐结论（对标 OKX OnchainOS，2026-08-11）**

- **广度三项延后（用户决策）**：swap/DEX 聚合执行、钱包多链广度（20+/60+ 链）、多链矩阵扩展 —— 不排期
- **AI 生态 Skills 插件**：✅ 已实现（A-7，commit `743ede1`：ai-skills 仓库 7 组 skill + 5 IDE 发布物 + QUICKSTART 文档；§9.6 需求 6.0 子任务 6.1~6.3 见 §9.6）
- **Paymaster**：自建方案 + 用户自充可选模式；OxaChain 已有 AA 栈（EntryPoint/Kernel/Bundler 已部署）；**2026-08-16 已闭环**：自建 verifying paymaster 全链路落地（合约 + signer 服务 :9134 + aa-relay 接线 `AA_OXACHAIN_PAYMASTER_URL=http://127.0.0.1:9134` + E2E 5/5，见 §9.10 A-4 / §9.11 B-4）

**任务拆解（2026-08-11 登记）**

| 编号 | 任务 | 说明 | 状态 | 优先级 |
|---|---|---|---|---|
| A-1 | 文档定位纠正 | 修正 waas.md / vault.md / mpc.md / SDK_INTEGRATION.md / README 对比表中"集成方/用户需签名"偏差表述（按 W-1~W-3） | ✅（2026-08-11 完成） | P1 |
| A-2 | L1 方案重写 | session-key 签名代理范围收缩为 vault 增强（W-4.1 定稿）：**MPC 路径优先（现成可用）+ session-key 扩展备选** | ✅（2026-08-11 方案定稿） | P2 |
| A-3 | MPC 作为 Safe owner 接入评估 | 可行性 ✅：vault confirm 验签 = EIP-191 personal_sign，与 MPC `sign-message` 格式匹配、零改造；Safe owner 兼容普通 EOA；集成点 = vault `wallets` 表登记 MPC 地址 / executeTransaction 加固 | ✅（2026-08-11 评估完成） | P2 |
| A-4 | Paymaster 对接 | 物料清单已定稿（docs/PAYMASTER_PROVISION_REQUEST.md）并发出（2026-08-12）→ **PocketX 2026-08-16 回复澄清**：不运营 Paymaster、按交接约定 AA 链上栈（含 Paymaster）由 InfraX 维护，OxaChain 19505 Pimlico 官方不支持（既定约束），物料须自建侧补齐；对方确认 EntryPoint v0.7=`0x97e4cddcffeaf4580bc6315fee512f2b2d82798a`（08-07 部署 eth_getCode 通过）+ 主网小额联调 + 降级"用户自充"已设计 → **用户裁定：启动自建 verifying paymaster（2026-08-16）**，拆 P-1~P-6 实施（见 §9.11 B-4）。**2026-08-16 自建全链路闭环**：合约 `0xc894ef13597f15a2fe8475b5914d1151da852f33`（部署 tx `0x70709923…`，EntryPoint v0.7 存款 1 OXA）+ signer 服务 :9134（systemd）+ aa-relay drop-in 接线（`AA_OXACHAIN_PAYMASTER_URL=http://127.0.0.1:9134`）+ E2E 主网实测 5/5（代付上链 success、sender 余额不变、EntryPoint balanceOf(paymaster) 减少）；paymaster 代付 gas 成本按文档 §7 payments ledger 结算 | ✅ **已闭环（2026-08-16）** | P1 |
| A-5 | mpc-sdk 发布核查 | `@0xinfrax/mpc-sdk` 0.3.0 = npm 最新 ✅（已归档，无需操作） | ✅ | — |
| A-6 | 广度项：swap/DEX 部分恢复排期（2026-08-12） | **用户裁定**：swap/DEX 聚合执行**重新排期**（A-11 DEX 交易执行 RPC，2026-08-12 需求单覆盖原延后项）；多链 / 60+ 链仍维持延后不排期 | 部分恢复（A-11）| — |
| A-7 | AI 生态 Skills 插件 | §9.6 需求 6.0（已登记，子任务 6.1~6.3 见 §9.6） | ✅ `743ede1`：ai-skills 仓库（7 组 skill + 5 IDE 发布物 + QUICKSTART 文档） | P2 |
| A-8 | vault 增强实施（2026-08-11 完成） | 按 W-4.1：vault 支持 MPC session confirm（`POST /api/vault/safe/confirm-mpc` → MPC `sign-message` EIP-191 代签 → `safe_signatures` 记 `owner_address`+`signature_type='mpc'` → `wallets` 表登记 → threshold 达标自动 execute）；`executeTransaction` 加固（owner_address 直接关联，老数据回退 wallets 表）；SDK `SafeAPI.confirmMpc` 透传；未配 MPC_URL fail-fast 503 | ✅（2026-08-15 生产部署：vault :9107 重启加载新代码；MPC_URL=http://127.0.0.1:9104 + MPC_API_KEY 接线；confirm-mpc 全链路验证——参数校验→DB 定位→MPC sign-message 通道就绪） | P2 |
| A-9 | Paymaster/relay 配额前端展示（2026-08-11 完成） | 集成方控制台**统一租户视图**——Dashboard 用量表聚合 5 产品线真实数据：DC（`/usage` plan/quota/used）、MPC（`/api/v2/mpc/plans` 模式）、WaaS（订阅套餐）、Safe Vault（`/api/vault/plans` + `ledger-balance` gas 自付余额）、AA/Session（`/v1/plans` + `ledger-balance`）；web 代理新增 `/v1 → aa-relay`；计费仍 per-product 分离（A-10），仅展示层聚合；未购买显示「—/未激活」，端点不可用显示「不可用」 | ✅（2026-08-15 生产部署：infrax-web :9111 已加载 A-9 代码；5 产品线代理全链路验证——/api/v2/mpc/plans、/api/v2/data/usage、/api/v2/subscription/plans、/api/vault/ledger-balance、/v1/plans+/v1/ledger-balance 均通；修复 aa-relay key 对齐平台 bridge key 使 /v1 代理免 401） | P2 |
| A-10 | per-product 计费接入（2026-08-11 完成） | **机制统一、账户分离**：payments 引擎 ledger 机制复用——dc/market/chain-rpc/mpc 已接入 ✅（MQ-16 T-1~T-4）；**2026-08-11 新增接入**：vault 线（`vaultBilling.ts`：gas 自付，createSafe/execute 广播前按预估成本预扣（5% 缓冲），收据后按 gasUsed×gasPrice 结算退差，GAS_POOL 仅广播不垫付；`GET /api/vault/plans` + `POST /api/vault/ledger-balance`；未配引擎免费/余额不足 402/故障 503）、session/AA 线（`aa-relay/src/billing.ts`：UserOp 次数费（默认 0.0001）+ paymaster gas 代付按收据 actualGasCost 结算，广播前预扣、失败全额退；`GET /v1/plans` + `POST /v1/ledger-balance`） | ✅（2026-08-15 生产部署：vault :9107 + aa-relay :9131 重启加载计费代码并接线 payments 引擎（VAULT_PAYMENTS_URL/AA_PAYMENTS_URL=http://127.0.0.1:9132 + API key + platform address：vault=GAS_POOL_ADDRESS、aa=共享平台钱包）；`/api/vault/plans`、`/api/vault/ledger-balance`、`/v1/plans`、`/v1/ledger-balance` 全部 configured:true 且真实返回 ledger 余额） | P1 |
| A-11 | DEX 交易执行 RPC（2026-08-12 需求单，✅ 已裁定排期，P0） | 技术方案：[AASDK4_A11_TECH_DESIGN.md](docs/AASDK4_A11_TECH_DESIGN.md) §2。源 [FEATURE_REQUEST_MARKET_RPC_DEX_EXEC.md](docs/FEATURE_REQUEST_MARKET_RPC_DEX_EXEC.md)：chain-rpc 新增 `/v1/dex-rpc`——`dex.quote`（聚合器报价，OKX DEX 首选/1inch 回退）、`dex.approve`/`dex.swap`（构建**待签名** rawTransaction）、`dex.broadcast` 复用 `/v1/broadcast/:chain`；**安全**：无 sign 端点、quote=读 key、approve/swap=广播 key（分 router）；覆盖链 X Layer/ETH/Base/BSC/Arbitrum/Polygon（联动 RPC-3 链补齐）+ Solana（quote 先行）；子任务 A-11.1~A-11.7 | ✅ 已裁定排期（覆盖 A-6 原"swap/DEX 延后"） | P0 |
| A-11.1 | 聚合器接入（quote） | `chain-rpc/src/services/dexAggregator.ts`（新增）：OKX DEX Aggregator 客户端（quote/supported-chains）+ 1inch 回退；超时/失败 fail-closed 503；`DEX_AGGREGATOR_URL`/`DEX_API_KEY` 入 config；**2026-08-14 增强：OKX_DEX_KEYS_JSON 凭证池多账号轮询（round-robin + 401/403 failover，commit e4e30be）** | ✅（2026-08-14 生产验证：3 组 key 轮询 quote 9/9 200，P95 ~70ms） | P0 |
| A-11.2 | approve/swap 构建 | `chain-rpc/src/services/dexBuilder.ts`（新增）：ERC20 approve（amount=0→max uint256）+ swap 未签名 tx（to/data/value/chainId/gasLimit 预估） | ✅（2026-08-14 E2E 真实订单验证：BNB→USDT 0.006，OKX tx 构建→MPC 签名→广播 成功） | P0 |
| A-11.3 | `/v1/dex-rpc` 路由与鉴权 | `chain-rpc/src/routes/dexRoutes.ts`（新增）+ `index.ts` 挂载：method 分发（quote 读鉴权 / approve+swap 广播鉴权，分 router）；信封 `{code,message,data}` + `X-Json-Rpc: raw` 透传；请求日志 `dex-rpc` 标签 | ✅（2026-08-14 生产验证：quote 走该路由 200） | P0 |
| A-11.4 | 链池补齐与白名单 | `rpcPoolConfig.ts` 补 `arbitrum/polygon/xlayer`；`dex.quote` 链上校验（token 精度/余额）方法入白名单（联动 RPC-3）。**2026-08-14 用户裁定：arbitrum/polygon/xlayer 暂不加**，DEX 白名单保持 `ethereum,bsc,base`（config `DEX_SUPPORTED_CHAINS`，commit 14029a6） | ⏸️ 延后（白名单已收紧并生产验证） | P1 |
| A-11.5 | SDK 封装 | infrax-dk `DexAPI`（TS + Python）：`quote/approve/swap` 类型化 + 文档；`dex.broadcast` 复用现有 `ChainRpcAPI.broadcast` | ✅（`projects/sdk/src/index.ts` `DexAPI` 已封装，chain-rpc-sdk 重导出；BSC/ETH/BASE 全链复用读/广播双 HttpClient） | P1 |
| A-11.6 | 安全加固与限流 | `/v1/dex-rpc` 纳入 rpcQuotaEnforce（读）/广播配额；approve/swap 校验 `chain` 白名单链集；gasLimit 预估上限保护 | ✅（index.ts 读/广播双中间件挂载；`assertDexChain` 白名单校验；dexBuilder `dexMaxApproveGas`/`dexMaxSwapGas` 上限） | P1 |
| A-11.7 | E2E 验证（生产） | `quote → approve → swap` 模拟 + 真实小额定单：SDK 构建 → MPC `sign-digest` → `/v1/broadcast {wait:true}` → 收据核对；quote P95 < 100ms；接口清单自证无 sign 端点 | ✅（2026-08-14 真实订单成功：BNB→USDT 0.006→3.66 USDT，tx `0x6514c88b…` status=0x1；根因 RFQ 订单有效期短 → `dex-e2e.ts` 加 preflight eth_call + 快速签名广播 + 自动重试） | P0 |
| A-12 | 行情数据 RPC（2026-08-12 需求单，P1） | 入口 `/v1/market-rpc`（与 `/v1/rpc/:chain` 并列）：`tokenSearch/tokenInfo/hotTokens/leaderboard/signals/mempump/candles/price/balances/transactions/trackedTokens/customSigs` 12 组方法，支持**多 token 批量**，响应信封 `{code,message,data}`，鉴权沿用 `rx_` 读 key | ✅ 完成（2026-08-16：**x402 门控已落地**——marketRpcRoutes `x402Gate` 前置检查：4 收费方法 `tokenSearch $0.002/tokenInfo $0.001/price $0.0005/candles $0.001`（token 维度按批量倍增），匿名调用 → HTTP 402 + `X-PAYMENT-*` 清单（network/token/amount/resource/request-verify URL），已付凭据 `X-Payment-Order-Id` 回放放行，非收费方法匿名仍 401；自测 17/17 + typecheck 通过；**SDK 0.8.3 支持**：`X402RequiredError` + `postWithMeta`，遇 402 抛结构化支付清单错误（单测通过）；**文档同步**：API_ACCESS §1.7 / SERVICE_API_REFERENCE §7.6.6 / SDK_INTEGRATION MarketRpc 章节） | P1 |
| A-13 | 行情 RPC 一致性保障（2026-08-12 需求单，P1） | 行情 RPC 与 REST MarketAPI **同源同缓存**（口径一致）；SDK TS 类型 + Python 客户端同步发布；P95：quote < 100ms、行情 RPC < 200ms | ✅（2026-08-15 生产验证：`okxMarketV6.ts` 单例内共享 TTL 缓存（price 2s/kline+hot 5s/search+signal 10s，MAX 5000）；REST `/api/v2/data/market/*` 与 `/v1/market-rpc` 走同一 `getMarketClient()` 实例——实测 REST #1 冷 205ms → REST #2 缓存命中 5ms → RPC 命中 REST 填充缓存 4ms，跨协议同缓存；行情 RPC 10 连发 P95=170ms < 200ms（缓存命中 ~5ms）；SDK TS `MarketRpcAPI`（commit dfe61dd，与 MarketAPI 同 HttpClient 同源同缓存） | P1 |
| A-14 | ws 行情订阅（2026-08-12 需求单，P2） | 行情 RPC 订阅面：price/candles 增量推送，对齐低延迟场景 | ✅ 完成（2026-08-16：**x402 门控已落地**——marketWs `handleMarketWsUpgrade`：无有效 key 且无已付凭据（paymentOrderId query / X-Payment-Order-Id header）→ HTTP 402 + X-PAYMENT-* 清单（会话价 $0.001，对齐 A-12 费率/配置）；已付凭据 → 放行；生产验证：无 key 402、带凭据 101 升级成功；上游 OKX Market 自有 x402 透传兜底不变） | P2 |
| A-15 | SessionKey 托管实例（2026-08-12 需求单，P0） | 源 [FEATURE_REQUEST_SESSION_KEY_AUTOEXEC.md](docs/FEATURE_REQUEST_SESSION_KEY_AUTOEXEC.md)：生产部署 session-key-engine **SaaS 托管实例**（对齐 `projects/session-key` API 面：`/api/v1/health`、`/nonce` 公开，`/sessions`、`/execute` Bearer）；交付 HTTPS URL + `sdk_` 前缀 Bearer key + SLA + 日志/审计接口；消费端仅配 `SESSION_KEY_ENGINE_URL` + `SESSION_KEY_API_KEY` | ✅ 完成（2026-08-15：生产 :3500 运行中，health/nonce 公开、sessions/execute Bearer；createSession 全链路 E2E 通过——客户端生成 session keypair + EIP-712 签名 + 服务端派生校验后加密存储） | P0 |
| A-16 | SessionKeyAPI 并入主 SDK（2026-08-12 需求单，P1） | infrax-dk 新增 `SessionKeyAPI`（`getNonce/createSession/listSessions/getSession/revokeSession/execute`），TS 类型 + Python 客户端同步发布；EIP-712 域参数（chainId/verifyingContract/name/version）SDK 内置；鉴权纳入平台 key 体系 | ✅ 完成（2026-08-15：`@0xinfrax/infrax-dk@0.8.2` SessionKeyAPI 全方法 + `sessionAuthTypedData`/`sessionKeyDomain`/`SESSION_KEY_CHAIN_IDS` 内置；**createSession 死锁修复**——客户端生成 session keypair（viem `generatePrivateKey`+`privateKeyToAccount`）提交公/私钥，服务端 `deriveAddressFromPrivateKey` 一致性校验后加密存储；validUntil 客户端显式提交 + 服务端窗口校验消除时钟竞态；`@0xinfrax/session-key-client@0.1.2`/`session-key-evm@0.1.2` 同步发布） | P1 |
| A-17 | SessionKey 执行能力增强（2026-08-12 需求单，P1） | 多链 ETH/BSC/BASE/Arbitrum/Polygon（+Solana 候选）；`execute` 返回 `{userOpHash,txHash,status,blockNumber,gasUsed}` + 新增 `GET /execute/:id`；Paymaster 赞助可配置（联动 E-1b）；execute 全程审计（调用方/session id/限额快照/结果） | ✅ 完成（2026-08-15：7 链 RPC（ETH/BSC/BASE/Polygon/Arbitrum/Optimism/XLayer）经 env 注入；`execute` 返回 `{executionId,userOpHash,txHash,status,blockNumber,gasUsed}` + `GET /execute/:id` 明细（含调用方掩码/限额快照）；审计 `execution_repo.insert` 全程落库；Paymaster 联动 E-1b 按用户裁定跳过） | P1 |
| A-18 | SessionKey 安全加固（2026-08-12 需求单，P0） | 限额**服务端硬校验**（maxPerTx/maxTotal/validUntil 构建 userOp 前强制，任何路径不写 session key 原文日志）；nonce 单次有效（消费即失效，EIP-712 防重放）；撤销即时生效（DELETE `/sessions/:id` 后已签发 key 立即失效）；公开/Bearer 端点隔离 | ✅ 完成（2026-08-15：execute 限额硬校验（maxPerTx/maxTotal/validUntil + 合约白名单 + selector）构建前强制 + 全程审计；nonce 单次消费即删；撤销即时生效（置 revoked，execute 拒绝）；公开（/health /nonce）/Bearer（其余）隔离；session key 私钥加密存储、响应永不含原文；执行 11/11 单测通过） | P0 |

**9.11 PocketX → InfraX 交接更新（2026-08-11）**

**接收确认（commit 47568ca / e95564e，sftgroup/pocketx-wallet main）**

- `vendor/aa-contracts/`：OxaChain（19505）ERC-4337 合约栈上游源码（EntryPoint v0.7.0 / Kernel v3.1 + Factory + ECDSAValidator / Alto simulations，含 commit 溯源与 solady/OZ 最小依赖）；`scripts/deploy-oxachain.mjs` 可复现（Kernel/Factory 尾部替换构造参数法，EntryPoint runtime 17,690 B 与链上一致，dry-run 3/3）
- `docs/INFRAX_SDK_BUILD.md`：workspaces 拓扑 / `--legacy-peer-deps` / 7 包构建顺序 / wallet-base VITE env / 白标步骤
- `docs/INFRAX_HANDOVER.md` v1.4：职责边界确认
- **职责边界（InfraX 接收）**：链上合约栈 + 新链部署 / `@infrax/aa-sdk` 白标 SDK / Bundler（Alto 实例 + SafeValidator 补丁）→ InfraX 维护；PocketX-Wallet 产品层仅依赖 SDK 构建，零链上维护

**白标调整决策（2026-08-11，用户裁定）**

- aa-sdk **不独立发布**（@infrax/aa-sdk 保持 private），**合并进 session-key 包体系发布**
- 实施：aa-sdk 全部源码（2584 行 / 21 文件）并入 `@0xinfrax/session-key-core` **v0.2.0**（已发布 ✅，60.1 kB）
  - 以 **`Aa` 命名空间**导出（72 项：BundlerClient / PaymasterClient / MpcSigner / SessionKeySigner / KernelV3SessionDataBuilder / CHAIN_ALIASES 含 oxachain 等），规避与 core 现有 Chain/ChainId/Signer 命名冲突
  - 依赖收敛：仅 peerDeps `viem>=2.0.0`（permissionless 已被 aa-sdk 绕开，源码中仅注释引用）
  - 用法：`import { Aa } from '@0xinfrax/session-key-core'`
- `projects/aa-sdk` 定位更新：作为合并源归档，功能以 core 0.2.0 为准，避免双份维护

**跟进事项**

| # | 事项 | 状态 | 优先级 |
|---|---|---|---|
| B-1 | Paymaster 对接物料索取（PocketX → InfraX 清单） | ✅ **已归档（2026-08-16 对方回复）**：PocketX 澄清不运营 Paymaster、AA 链上栈归 InfraX 维护、OxaChain Pimlico 不支持（既定约束）→ 物料须自建侧补齐；对方确认 EntryPoint v0.7 地址 + 主网小额联调 + 降级"用户自充"。催料路径关闭，转入 B-4 自建实施 | — |
| B-4 | **自建 verifying paymaster（A-4 闭环，2026-08-16 用户裁定启动）**：P-1 部署 VerifyingPaymaster 合约（19505，生产机 vendor/aa-contracts，缺则引标准实现）→ P-2 `EntryPoint.depositTo` 充值非零（避 AA31）→ P-3 signer 后端（Pimlico 协议 stubData/data，服务端持验证人私钥，chainId=19505 + entryPoint=0x97e4cddc…）→ P-4 接线（aa-relay 配 `AA_OXACHAIN_PAYMASTER_URL` + systemd）→ P-5 E2E 主网小额实测 → P-6 文档闭环（tasklist/AA_SDK_TECH_DESIGN/归档物料清单）。**前置待用户**：部署钱包 + OXA gas、signer 私钥保管位置；sponsor gas 成本归属按文档 §7（payments ledger 对账） | ✅ **已完成（2026-08-16）**：P-1 合约 `0xc894ef13597f15a2fe8475b5914d1151da852f33`（`@account-abstraction/contracts` 0.7.0 标准 VerifyingPaymaster，signer=部署钱包派生）→ P-2 EntryPoint v0.7 `depositTo` 充值 1 OXA → P-3 signer 服务 :9134（aa-paymaster，`pimlico_getPaymasterStubData/Data` 协议，systemd `infrax-aa-paymaster.service`）→ P-4 aa-relay drop-in `paymaster.conf`（`AA_OXACHAIN_PAYMASTER_URL=http://127.0.0.1:9134`，relay 代理链路 curl 验证）→ P-5 E2E 5/5（`scripts/aa-e2e-paymaster.ts`：stub 填充→260 字符 paymasterAndData→签名→bundler 广播 receipt success→sender 余额不变→EntryPoint balanceOf(paymaster) 减少；tx `0xed508087…`）→ P-6 本表闭环 + commit `af3496a` 登记 | P1 |
| B-2 | Alto executor（生产部署钱包）余额 ≈ **0.0193 OXA**，运营充值 | ✅ 已完成（2026-08-16 核实：executor 地址 `0x52ec58173042e8d0c9be0bda81e95a8cbb5b8e06`（`ALTO_EXECUTOR_PRIVATE_KEYS` 与 `ALTO_UTILITY_PRIVATE_KEY` 同 key），余额 **10.014 OXA**（nonce=123 活跃 EOA），远超充值目标 ≥1 OXA，无需额外转账；aa-relay 生产 E2E 已通过） | P1 |
| B-3 | 新链部署规范：以 vendor/aa-contracts deploy 脚本为基准（BSC/ETH/BASE 待部署） | ✅ 规范已归档 `docs/AA_NEW_CHAIN_DEPLOYMENT.md`（流程/前置/验证清单/注意事项）；BSC/ETH/BASE 实际部署需在生产机 vendor 目录执行（本地无 vendor），见规范 | P2 |

---

**9.12 服务鉴权审计（2026-08-11，全站 15 服务源码审计）**

> 触发：用户提问"各个服务是不是都已经做好了鉴权？"。结论：**非全部**——waas 存在裸路由漏洞群 + `requireAdmin` 形同虚设；dc 余额查询无鉴权；collector / chain-rpc / aa-relay / data / injector 为**条件性开放**（配置 key 才强制校验）。shared `auth-express`（三选一 header + fail-closed）已在部分服务生效，但 waas 未接入全局兜底。

**审计结论（按服务）**

| 服务 | 结论 | 关键发现 |
|---|---|---|
| waas :9109 | 🔴 严重 | 无全局鉴权兜底；`requireAdmin` 校验失败仍 `next()` 形同虚设（[auth.ts](projects/waas/middleware/auth.ts) L104-115）；**裸路由漏洞群**——`/api/v2/saas/tenants/:tenantId/{apikey,apikey/rotate,hot-wallet,tokens}` 的 API key 生成/轮换/删除、hot-wallet、tokens 增删查**均无鉴权**（[saasRoutes.ts](projects/waas/routes/saasRoutes.ts) L563-683；对照 L474-546 有 authenticate 的 `/apikeys`） |
| dc :9102 | 🔴 P0 | `GET /api/v2/data/balance` **无鉴权**（[index.ts](projects/dc/index.ts) L811-829，可枚举任意地址跨链余额；对照 L659 checkpoints 有 `requireDcApiKey`） |
| collector :9101 | 🟡 P1 | 弱密码：默认 `ADMIN_PASSWORD=infrax123` 仅 warn 不阻断（[config.ts](projects/collector/src/config.ts) L22/L86-87）；明文 key：`CWALLET_API_KEY` 默认 `dev-cwallet-key`（L16） |
| chain-rpc :9130 | 🟡 条件性 | 配置 READ/BROADCAST key 才强制校验，未配置则开放（[auth.ts](projects/chain-rpc/src/middleware/auth.ts)） |
| aa-relay :9131 | 🟡 条件性 | `if (!RELAY_KEY) return next()` 开放语义（[index.ts](projects/aa-relay/src/index.ts) L68-75） |
| data :9112 / injector :9113 | 🟡 条件性 | `DATA_API_KEY`/`INJECTOR_API_KEY` 可配置，未配置则开放（§4.6） |
| vault :9107 | ✅ 良好 | 鉴权完整（`148cc42`） |
| mpc :9104 | ✅ 良好 | 鉴权 + 验证码完整（`148cc42`） |
| payments :9132 | ✅ 良好 | 三 header + webhook 豁免 |
| session-key | ✅ 良好 | 三层鉴权 |
| admin :3002 | ✅ 良好 | 登录态 + X-Admin-Token |
| ragservicer :9721 | ✅ 良好 | 强制三层（bridge/admin/租户） |
| payment（已下线 :9106） | ✅ 良好 | 历史服务，代码保留 |

**任务拆解（2026-08-11 登记）**

| 编号 | 任务 | 说明 | 状态 | 优先级 |
|---|---|---|---|---|
| C-1 | waas 裸路由补鉴权 | `/api/v2/saas/tenants/:tenantId/*`（apikey 生成/rotate/删除、hot-wallet、tokens 增删查）全部挂 `requireTenantApiKey`（前端 waasFetch 已带 `x-api-key`）；合并 L563-682 两组完全重复路由定义 | ✅（2026-08-11 完成，见 C 段收口说明） | P0 |
| C-2 | waas `requireAdmin` 修复 | [auth.ts](projects/waas/middleware/auth.ts)：fail-closed——仅 `req.adminUser`（authenticate 校验 admin JWT 后注入）放行，否则 `next(Errors.unauthorized(...))` | ✅（2026-08-11 完成） | P0 |
| C-3 | dc balance 补鉴权 | `GET /api/v2/data/balance` 挂 `requireDcApiKey` + `dcQuotaEnforce`（对齐 checkpoints） | ✅（2026-08-11 完成） | P0 |
| C-4 | collector 弱密码/明文 key | 移除 `infrax123`/`dev-cwallet-key` 默认值；生产 fail-closed 启动校验（缺 `ADMIN_PASSWORD`/`CWALLET_API_KEY` 或仍用已知默认 `infrax123` 即拒绝启动） | ✅（2026-08-11 完成） | P1 |
| C-5 | 条件性开放服务收口 | chain-rpc / aa-relay / data / injector 未配置 key 时 fail-closed（或文档显式声明仅内网开放边界） | ✅（2026-08-11 收口，见下方 C-5 收口说明） | P1 |

**C-1~C-5 收口说明（2026-08-11）**

- **C-1/C-2/C-3/C-4**：代码修复完成并已验证——collector `npm run build` 通过；waas/dc 为 tsx 直跑（无 tsconfig），改动为中间件挂载与去重，已逐段核读。**生产部署待执行**：三服务代码同步 + 重启 + 回归（无 key 401 / 带 key 200 / admin JWT 200），部署步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md) §3.3。
- **C-5 决策**：`projects/shared/app_auth.py` 与 chain-rpc/aa-relay 的"未配置 key 即开放"为**有意向后兼容设计**（SDK 文档声明"无鉴权环境可留空"，四服务生产均未配置过 key 时开放以支持本地开发），**不改共享文件**（影响 4 服务 + 测试环境）。收口方式 = **文档声明内网边界**：
  - 生产全部服务均已配置 key → 生产实际为强制鉴权（2026-08-08 生产鉴权矩阵实测闭环）；
  - 未配置 key 的环境按"仅内网/本机开放，严禁公网暴露"边界声明（§4.6 服务间鉴权章节已含此约定，本行登记结论）；
  - 若未来出现公网直连未配置 key 的需求，再评估 fail-closed 改造。

---

**9.13 SDK 独立包拆分（2026-08-11 用户裁定；§1.1 已写入 SDK_INTEGRATION.md，commit 7a76c17）**

> 用户裁定 SDK 架构：**统一包覆盖 + 每个服务有独立包**。`@0xinfrax/infrax-dk` 保持统一入口（一次配置覆盖全部服务），同时每微服务提供独立 npm 包——**独立包薄封装 infrax-dk 对应 API 类，同源同步发版**，调用方可按需二选一（全量或单服务）。

**独立包矩阵（已发布 ✅，2026-08-12 全量发布）**

| 微服务 | 独立包 | 覆盖方法 | 状态 |
|---|---|---|---|
| WAAS | `@0xinfrax/waas-sdk` | wallet + safe + saas + sub | ✅ 0.1.0（2026-08-12） |
| Vault | `@0xinfrax/vault-sdk` | vault | ✅ 0.1.0（2026-08-12） |
| DC | `@0xinfrax/dc-sdk` | dc（含 MQ-16 订阅） | ✅ 0.1.0（2026-08-12） |
| Market | `@0xinfrax/market-sdk` | market（数据面 + 订阅面） | ✅ 0.1.0（2026-08-12） |
| ChainRPC | `@0xinfrax/chain-rpc-sdk` | chainRpc（读/广播/订阅） | ✅ 0.1.0（2026-08-12） |
| Payments | `@0xinfrax/payments-sdk` | payment（引擎 15 + 订阅） | ✅ 0.1.0（2026-08-12） |
| Data / ML | `@0xinfrax/data-sdk` | data + ml | ✅ 0.1.0（2026-08-12） |
| MPC | `@0xinfrax/mpc-sdk` | 16 方法（钱包/会话/链上） | ✅ 0.3.0 |
| Session Key | `@0xinfrax/session-key-{core,client,evm,server}` | 引擎 + `Aa`（aa-sdk） | ✅ 0.2.0/0.1.x |
| LightRAG | `lightrag-client`（Python） | insert/query/delete/retrieve | ✅ 2.0.0 |
| Data 因子 | `infra-data-client`（Python） | bars/ticker/factors/snapshots/ml_predictions | ✅ 0.2.0 |

**任务拆解（2026-08-11 登记）**

| 编号 | 任务 | 说明 | 状态 | 优先级 |
|---|---|---|---|---|
| D-1 | 独立包脚手架 | 7 个规划包（waas/vault/dc/market/chain-rpc/payments/data）monorepo 结构 + publishConfig | ✅ 已发布（2026-08-12） | P2 |
| D-2 | 薄封装实现 | 各包薄封装 infrax-dk 对应 API 类（同源同步发版，不复制实现） | ✅ 已发布（2026-08-12） | P2 |
| D-3 | SDK_INTEGRATION.md 更新 | §1 总览 + §1.1 独立包总览表已更新（commit 7a76c17） | ✅ | — |

**D-1/D-2 实现与发布记录（2026-08-12，已发布）**：
- infrax-dk `0.6.0 → 0.7.0`：13 个内部 API 类改为 `export class`（HttpClient/WalletAPI/SafeAPI/PaymentAPI/SaaSAPI/SubAPI/DCAPI/VaultAPI/MPCAPI/MarketAPI/DataAPI/MlAPI/ChainRpcAPI）——d.ts 全量导出，供独立包类型引用（向后兼容，不破坏现有 API）
- 7 个独立包（`projects/<name>-sdk/`，mpc-sdk 同构模板）：`waas-sdk`（wallet+safe+saas+sub）/ `vault-sdk` / `dc-sdk` / `market-sdk` / `chain-rpc-sdk` / `payments-sdk`（payment+sub）/ `data-sdk`（data+ml）
- 每个包：`package.json`（`@0xinfrax/<name>-sdk@0.1.0`、`main/types: dist`、`files:[dist]`、`publishConfig` 依赖 `@0xinfrax/infrax-dk: ^0.7.0`）+ `tsconfig.json`（mpc-sdk 模板）+ `src/index.ts`（**薄封装**：re-export 对应 API 类 + `InfraXConfig` + `createXxxClient(config)` 工厂返回命名空间，零实现复制）
- 本地验证：infrax-dk build 14 export classes → 7 包逐一 `npm i ../sdk --no-save && npm run build` 全部 tsc 通过（dist 生成）
- **发布（2026-08-12 已完成，commit `7a0e333` 见 B-12-2）**：① `@0xinfrax/infrax-dk@0.7.1`（14 类全导出 + dc.balance）→ ② 7 个 `@0xinfrax/*-sdk@0.1.0` 全部 npm 已发布（`--registry=https://registry.npmjs.org/` 避免镜像延迟；registry 消费验证通过）

**9.14 MooMoo 行情强化接入（2026-08-12 需求登记；详细方案：docs/MOOMOO_DATA_INTEGRATION.md）**

> 动机：① 美股 K 线 1h/4h 依赖 yfinance（生产 IP 常 429，`_collect_multi_market` 频繁记 failed）；
> ② 港股分钟级缺口（仅腾讯日线）；③ 宏观（FRED）/新闻（NewsAPI）依赖第三方 key。
> **实测（账号 107803923，US LV3/HK LV1/Crypto LV1）**：moomoo 提供美股/港股分钟 K 线、
> 宏观指标（US 24 项，历史**含 predict_value 一致预期**，优于 FRED）、新闻搜索（Moomoo News/
> MT Newswires/Benzinga）、美股资金流（分钟级）——**全部免额外 key**；
> **不可用**：外汇 / 全球股指指数（USIndices 无权限）/ A股 / 期货（保留现有源）。
> 接入原则：新增 `MoomooDataSource` 走既有 `BaseDataSource` 契约 + 回退链头部插入，
> 失败自动降级现有源（fail-silent），B 端零感知。
> **2026-08-12 补充**：官方 skill `opend-skills/moomooapi/` 已入库（SKILL.md + docs/API_REFERENCE.md
> 65+ 接口 + scripts/quote 100+ 成品脚本），已纳入方案（MOOMOO_DATA_INTEGRATION.md §2.1/§4.7/§7）；
> 由此新增 MM-11~MM-15 增量数据任务（F10/卖空机构ARK/日历/榜单热力/筛选板块，P2，权限待生产验证）。

**任务拆解（子任务级；阶段依赖：MM-7 → MM-1 → MM-2/3 → MM-6；MM-4/5/8 独立可并行；MM-11~15 依赖 MM-7 + 权限验证）**

| 编号 | 任务 | 说明 | 状态 | 优先级 |
|---|---|---|---|---|
| **MM-1** | data-service 新增 Moomoo 适配器（依赖 MM-7） | | ✅ | P1 |
| MM-1.1 | 适配器骨架 | `app/data_sources/moomoo.py` 实现 `BaseDataSource`（get_kline/get_ticker）；符号映射 AAPL→US.AAPL、00700→HK.00700，复用 ticker.py `infer_market` | ✅ | P1 |
| MM-1.2 | K线调用 + timeframe 映射 | `request_history_kline`（ktype 字符串 K_5M/K_60M/K_DAY、显式 start/end、page_req_key 分页）；映射 1m/5m/15m/30m/1H→K_60M、4H→60m 聚合、1D→K_DAY；**time_key 本地交易所时区→UTC 对齐 kline 表 ts** | ✅ | P1 |
| MM-1.3 | 连接池 + 降级 | OpenD 断连自动重连、短 TTL 缓存、fail-silent（未启动/断连/额度耗尽→回退现有源） | ✅ | P1 |
| MM-1.4 | 单测 | 本机 pytest 单测（符号/timeframe 映射、降级路径） | ✅ | P1 |
| **MM-2** | multi_kline 采集接入（依赖 MM-1） | | ✅ | P1 |
| MM-2.1 | US 换源 | `kline_store._collect_multi_market`：US 1h/4h 改 moomoo（替代 yfinance 429），1d 保留 akshare/切换对比后定；失败回退 yfinance | ✅ | P1 |
| MM-2.2 | HK 分钟级 | HK 补 1m/5m/15m/1h（HK LV1 实测 5m 可用），1d 保留腾讯/切 moomoo 对比 | ✅ | P1 |
| MM-2.3 | 额度节流 | 历史K线 1000 额度控制：复用 `_THROTTLE` + page_req_key 分页，防批量超限 | ✅ | P1 |
| MM-2.4 | 生产验证 | `/bars?market=usstock&symbol=AAPL&timeframe=1h&limit=200` 连续 7 天无 failed | ✅ | P1 |
| **MM-3** | /ticker 回退链插入（依赖 MM-1） | | ✅ | P1 |
| MM-3.1 | ticker 头部插入 | `ticker.py` usstock/hkstock 第一优先 moomoo `get_market_snapshot`（实时性优于 yfinance/腾讯） | ✅ | P1 |
| MM-3.2 | 回退 + 源标记 | 失败走现有链（yfinance fast_info/腾讯）；响应标记 source=moomoo | ✅ | P1 |
| MM-3.3 | 生产验证 | `/ticker?symbol=AAPL&market=usstock` 返回 moomoo 源标记 | ✅ | P1 |
| **MM-4** | 宏观指标采集器 | | ✅ | P1 |
| MM-4.1 | 采集器实现 | `app/collectors/moomoo_macro.py`：`get_macro_indicator_list('US')`→`get_macro_indicator_history`→写 `macro_history`（series `MM:US:CPI` 命名空间）+ `raw_snapshots`（provider=moomoo_macro） | ✅ | P1 |
| MM-4.2 | 周期 + 并存 | 6h 增量对齐 FRED；`/macro/history` 按源过滤，默认 moomoo 优先 FRED 兜底；含 predict_value/release_time | ✅ | P1 |
| MM-4.3 | 生产验证 | `/macro/history?series=MM:US:CPI` 含 predict_value | ✅ | P1 |
| **MM-5** | 新闻采集增强（依赖 MM-7） | | ✅ | P2 |
| MM-5.1 | 新闻分支 | `collectors/news.py` 增 moomoo 分支：`get_search_news`（NEWS/NOTICE/RATING）按自选池+市场关键词抓取 | ✅（news.py moomoo 分支 `get_search_news` 按关键词抓取，生产运行中） | P2 |
| MM-5.2 | 双源去重 | 与 NewsAPI 并存（url 幂等去重）→ raw_snapshots（provider=news_moomoo）；无 key 时 moomoo 主源 | ✅（2026-08-15 生产验证：`raw_snapshots` provider=news 快照 17 items，moomoo 新闻源正常） | P2 |
| MM-5.3 | 生产验证 | `/snapshots?provider=news_moomoo` 非空 | ✅ | P2 |
| **MM-6** | ml-service Kronos 供给（依赖 MM-2） | | ✅ | P2 |
| MM-6.1 | Kronos 供给 | Kronos 目标池（SPY/QQQ 等）日 K 回填/增量经 data-service moomoo 路径（get_kline 透传） | ✅ | P2 |
| MM-6.2 | 生产验证 | 45 符号预测无 429 输入缺口（Kronos 全量 ~18min 属预期） | ✅ | P2 |
| **MM-7** | OpenD 生产部署（P0 前置） | | ✅ | P0 |
| MM-7.1 | 生产环境安装 | 生产机 43.163.105.172 装 JRE + 部署 OpenD（版本与开发机一致 10.9.6918）+ venv 装 moomoo SDK | ✅ | P0 |
| MM-7.2 | 凭证落盘 | OpenD.xml 复用账号 107803923，权限 600，**不入 git**（仓库保持占位/示例） | ✅ | P0 |
| MM-7.3 | systemd 化 | `infrax-opend.service`：FIFO stdin、Restart=always、11111 健康探活脚本 | ✅ | P0 |
| MM-7.4 | 生产验证 | `get_market_snapshot(['US.SPY'])` 生产机直连通过（含短信验证码登录确认） | ✅ | P0 |
| **MM-8** | 资金流/股票列表（依赖 MM-7） | | ✅ | P2 |
| MM-8.1 | 资金流落库 | `get_capital_flow`（分钟级 super/big/mid/sml）→ raw_snapshots（provider=moomoo_capital_flow）供 FinBERT/情绪因子 | ✅ | P2 |
| MM-8.2 | 自选池候选 | `get_stock_basicinfo` 作美股自选池候选 | ✅ | P2 |
| MM-8.3 | 生产验证 | `/snapshots?provider=moomoo_capital_flow` 非空 | ✅ | P2 |
| **MM-9** | 边界确认（指数保留 yfinance） | | ✅ | P2 |
| MM-9.1 | 指数边界 | knowledge-injector indices.py 保持 yfinance（USIndices 无权限不可替代）——不动代码，登记结论 | ✅（`projects/knowledge-injector/providers/indices.py` 经核对仍为 yfinance 实现；`data/app/data_providers/indices.py` 为 Finnhub 主 + yfinance 兜底，moomoo 均未介入指数路径） | P2 |
| MM-9.2 | 宏观因子边界 | VIX/DXY/US10Y 保持 CBOE/akshare/FRED 链（moomoo macro 仅作宏观序列增强，不作实时因子替代） | ✅（`/macro/history?series=MM:US:CPI` 走 moomoo_macro 序列（predict_value 字段），VIX/DXY/US10Y 实时因子链未改） | P2 |
| MM-9.3 | 方案核对 | MOOMOO_DATA_INTEGRATION.md §4.4 边界段与 tasklist 同步更新 | ✅（阶段六 [M-9] 边界结论登记） | P2 |
| **MM-10** | 生产验证与文档（收尾） | | ✅ | P1 |
| MM-10.1 | 降级演练 | `systemctl stop infrax-opend` → 全部 moomoo 路径自动回退不报错；恢复后自动回归 | ✅（2026-08-15 生产实测：OpenD 掉线（infrax-opend inactive、11111 无监听）→ ticker 快速回退 AAPL 1.08s/00700 0.72s 均 HTTP 200（yfinance/腾讯）；恢复 OpenD → 自动回归 source=moomoo AAPL 0.25s/00700 0.05s。**核心修复**：SDK 同步构造无限 6s 重试曾致降级阻塞 195s → moomoo.py 改 TCP 预检 `_opend_port_open` + `is_async_connect=True` + `_sync_query_connect_timeout=5` 有界等待 + 死连接 `_reset_ctx` 冷却；查询路径 20s `event.wait` 兜底已确认） | P1 |
| MM-10.2 | 额度监控 | 订阅/历史K线 1000 额度监控 + 超限告警 | ✅（`moomoo_extra.fetch_quota_status`：`get_history_kl_quota(get_detail=True)`→{used,remain,limit,detail_count} + `query_subscription`→{used,remain}，≥90% 使用率 logger.warning+alert 标记；`collectors/moomoo_extra.py` 增 mm_quota 组（6h）落库 raw_snapshots provider=moomoo_quota。2026-08-15 生产验证：history_kl {used:17,remain:983,limit:1000,detail_count:17}、subscription {used:0,remain:1000}） | P1 |
| MM-10.3 | 验收 + 文档 | E2E 验收脚本合集（/bars /ticker /macro/history /snapshots）+ docs 更新 | ✅（2026-08-15 生产 E2E：/bars AAPL 1h 200 条、/ticker source=moomoo、/macro/history MM:US:CPI 含 predict_value、raw_snapshots 各 provider 非空（news 466 / moomoo_f10 20 / moomoo_capital_flow 1185 / moomoo_quota 2 等）；docs 与 tasklist 同步） | P1 |
| **MM-11** | F10 基本面/估值/评级（依赖 MM-7） | | ✅ | P2 |
| MM-11.1 | 权限验证 | 生产机 §7 清单：`get_financials_statements`/`get_research_analyst_consensus`/`get_valuation_detail` | ✅（2026-08-15 生产实测三层全 ret=0 可用：financials `{next_key,structure_list,report_list}` dict、consensus `{highest,average,lowest,rating,total,buy,hold,sell}` dict、valuation `{valuation_type,last_update_time,trend,market_distribution,...}` dict——**均为 dict 非 DataFrame**，`_df_records` 已重写兼容三形态） | P2 |
| MM-11.2 | F10 采集器 | skill 脚本（get_financials_*.py/get_research_*.py/get_valuation_*.py）为雏形 → raw_snapshots（provider=moomoo_f10） | ✅（`moomoo_extra.py` fetch_financials 解析 report_list/structure_list（field_id→display_name 映射）；collectors/moomoo_extra.py `_collect_f10` 五标的 AAPL/MSFT/NVDA/TSLA/SPY 6h 周期，任一数据才落库） | P2 |
| MM-11.3 | 生产验证 | `/snapshots?provider=moomoo_f10` 非空 | ✅（2026-08-15 生产：mm_f10 快照 5 条（financials 2 条×item_count=19 + consensus rating=4 + valuation 1 条），`raw_snapshots` provider=moomoo_f10 连续落库） | P2 |
| **MM-12** | 卖空/机构/内部人/ARK（依赖 MM-7） | | ✅ | P2 |
| MM-12.1 | 权限验证 | `get_short_interest`/`get_daily_short_volume`/`get_institution_holding_list`/`get_insider_trade_list`/`get_ark_fund_holding` | ✅ | P2 |
| MM-12.2 | 采集器 | skill 脚本为雏形 → raw_snapshots（provider=moomoo_smart_money） | ✅ | P2 |
| MM-12.3 | 生产验证 | `/snapshots?provider=moomoo_smart_money` 非空 | ✅ | P2 |
| **MM-13** | 日历增强（依赖 MM-7） | | ✅ | P2 |
| MM-13.1 | 权限验证 | `get_earnings_calendar`/`get_economic_calendar`/`get_dividend_calendar` | ✅（2026-08-15 生产实测 `get_economic_calendar` 7 天窗口 50 条含 title/time/country/star/previous/consensus/actual） | P2 |
| MM-13.2 | 日历增强 | `collectors/calendar.py` 增强（FRED/Finnhub/FOMC 静态兜底） | ✅（`_fetch_moomoo_calendar`：moomoo 并入 events（source=moomoo，consensus→forecast），与 FRED/Finnhub/FOMC 静态并存；**修复根因 bug：`timedelta` 未导入导致每次调用抛 NameError 被静默吞掉 → 补 `from datetime import timedelta`（commit 生产已部署）+ 时间戳解析兼容 `T` 分隔符**） | P2 |
| MM-13.3 | 生产验证 | 日历端点含 moomoo 源数据 | ✅（2026-08-15 生产：collector 日志 `moomoo source (50 event(s))`；`raw_snapshots` provider=calendar 最新快照 sources={moomoo:2, fred:2, static:3}） | P2 |
| **MM-14** | 榜单/热力/盘前盘后（依赖 MM-7） | | ✅ | P2 |
| MM-14.1 | 权限验证 | `get_hot_list`/`get_top_movers_rank`/`get_us_{pre,after,overnight}_rank`/`get_period_change_rank`/`get_heat_map_data` | ✅ | P2 |
| MM-14.2 | 采集器 | → raw_snapshots（榜单/热力/盘前盘后排名） | ✅ | P2 |
| MM-14.3 | 生产验证 | `/snapshots?provider=moomoo_hot` 非空 | ✅ | P2 |
| **MM-15** | 股票筛选/板块（依赖 MM-7） | | ✅ | P2 |
| MM-15.1 | 权限验证 | `get_stock_screen`(V2 244+ 因子)/`get_plate_list`/`get_industrial_chain_*` | ✅ | P2 |
| MM-15.2 | 筛选/板块增强 | 作自选池/候选池增强 | ✅ | P2 |
| MM-15.3 | 生产验证 | 筛选/板块端点可用 | ✅ | P2 |

**实测依据（2026-08-12，本机 OpenD :11111）**：AAPL 5m/60m/1D K线 ✅、HK.00700 5m ✅、CC.BTCUSD 快照 ✅、
macro US 24 项 + CPI 历史含 predict_value ✅、search news TSLA/AAPL ✅、capital flow AAPL 分钟级 ✅、
外汇 `Unsupported quote market` ❌。SDK 版本 MMAPI4Python 10.9.6908（venv `/home/ubuntu/opend/venv`，
`pip install moomoo` 不可用需官网包）。

---

**9.15 因子工厂体系（2026-08-12 需求登记；源：docs/req-04-infrax-mlservice-arch-opt.md / req-05-auto-find-factor.md / req-06-factor-factory.md + docs/FACTOR_FACTORY_HW_EVOLUTION.md + INFRAX_REQ_SUMMARY_ARCH_AUTOFIND_FACTORY.md）**

> 需求方 Steven，归档 InfraX（ml-service 因子工程体系）。三个需求关系：
> ① **需求4 ml-service 架构优化**（R4）：Provider 基类+注册表消除 4 份样板、Device 参数化（V100 准备）、
> 因子工程解耦（14 硬编码 → 注册表）——**架构前置**，不动现有 6 模型行为；
> ② **需求5 自动寻找因子**（R5）：AI 对话驱动（偏好 direction + 限制 guardrails）+ factor_factory MCP 工具集——**挖掘入口**；
> ③ **需求6 因子工厂**（FF）：挖掘/评估/管理/入库 → data-service `/factors/current`（AItrader factor_client
> 无改动全量透传）——**目标链路**，依赖 R4 + R5；
> 硬件：双路 E5-2683v4 + 64G + V100 32G 两阶段（HW-1）；**附录 A 关键结论**：复合/非线性因子计算 =
> 向量化矩阵计算（numpy/GPU 均可），**不需要 vLLM/大模型推理**。
> 部署约束：ml-service 在生产 43.156.25.197（2C4G），集成验证须生产机（本机仅写码）。

**任务拆解（子任务级；2026-08-12：HW-1 硬件升级延后，先做当前阶段 CPU 优化。依赖链：R4-1→R4-2→R4-3 架构主线；R4-4→FF-1→FF-2→FF-3→FF-4 因子主线；R5-1→R5-2→R5-3→R5-4 对话主线；R5-1 与 FF-2 同内核）**

> **2026-08-14 完成状态**：R4/R5/FF 全系实现并生产验证（除 R4-2 用户决策跳过）。代码此前已实现（R4 系列 `7c2b341` / R5/FF 系列 `305cc89`）；本次补齐并验证：R5-3 MCP 工具集（`mcp-server/src/factor-index.ts`，:3014 systemd）、FF-3.3 data 透传（`/factors/current` 附 `ml_factory`）、生产全链路（start→QUEUED→RUNNING→COMPLETED；动态/白名单标的池；catalog 登记→激活→透传）。修复：① job 无数据时 None 不落终态 → 标 FAILED；② 裸符号 BTC 无 K 线 → 自动补 `/USDT` 回退；③ `_spearman` 索引不一致 IndexError → inner 对齐 fail-open；④ FF-3.1 登记未接线 → 完成自动 `register_qualified`；⑤ data `ml_client` `_FF_CACHE` 未声明 global → UnboundLocalError。单测 33 全绿（生产 .venv）。

| 编号 | 任务 | 说明 | 状态 | 优先级 |
|---|---|---|---|---|
| **R4-1** | Provider 基类 + 注册表 | | ✅ | P1 |
| R4-1.1 | 基类实现 | `app/providers/base.py`：`ModelProvider(ABC)` + `registry`，`instance()` 上收懒加载单例/失败 flag/`threading.Lock`（对齐 kronos.py L82-115 现状） | ✅ | P1 |
| R4-1.2 | kronos 迁移 | `kronos.py` 继承基类，只留 `load()`+`predict_all()`，删 `_load_predictor` 样板 | ✅ | P1 |
| R4-1.3 | bolt/moirai/timesfm 迁移 | `chronos_bolt.py`/`moirai2.py`/`timesfm25.py` 同法迁移 | ✅ | P1 |
| R4-1.4 | 回归 | 6 模型行为/输出不变（本机 typecheck/import；生产 ml-service 43.156.25.197 回归） | ✅ | P1 |
| **R4-2** | Device 参数化 | | ⏸️ | P1 |
| R4-2.1 | config 开关 | `config.py` 加 `DEVICE=os.getenv("DEVICE","cpu")` + `ML_GPU_VENDOR` 探测 | ⏸️ | P1 |
| R4-2.2 | provider 接入 | 4 provider `load()` 用 `device_map=DEVICE`/`map_location=DEVICE` 替代硬编码 cpu；GPU 不可用回落 cpu（fail-open） | ⏸️ | P1 |
| R4-2.3 | V100 适配 | Volta 无 bf16 → 预留 fp16 适配开关 | ⏸️ | P1 |
| R4-2.4 | 回归 | 默认 DEVICE=cpu 行为不变 | ⏸️ | P1 |
| **R4-3** | 统一端点挂载 + 预热 | | ✅ | P2 |
| R4-3.1 | 动态端点 | `main.py` 遍历 `ModelProvider.registry` 动态挂 `GET /ml/{key}` | ✅ | P2 |
| R4-3.2 | 预热遍历 | `_PRECOMPUTE` 预热表改为 registry 遍历生成 | ✅ | P2 |
| R4-3.3 | 兼容验证 | 现有手写端点保留向后兼容 | ✅ | P2 |
| **R4-4** | 因子工程解耦 | | ✅ | P1 |
| R4-4.1 | 因子注册表 | 新增 `app/factorengine/`：14 因子定义化（rsi_14/macd_hist/bb_pos/bb_width/atr_pct/ma_5/10/20 等，对齐 tree_models.build_features L107-147） | ✅ | P1 |
| R4-4.2 | 模板化展开 | 因子模板化（多窗口/多参数展开） | ✅ | P1 |
| R4-4.3 | build_features 改造 | 注册表驱动重写，行为不变（回归：LGBM 训练/预测输出一致） | ✅ | P1 |
| R4-4.4 | 评估入口预留 | 预留因子评估 + 动态选因接口（承接 L0-L6） | ✅ | P1 |
| **R5-1** | 偏好/限制结构化 job spec | | ✅ | P1 |
| R5-1.1 | 数据模型 | preferences（市场类型/因子风格/投资风格/资产池/周期）+ constraints（数量/资源/耗时/标的/IC/ICIR≥0.3/独立度/单调性/黑白名单）Pydantic schema | ✅ | P1 |
| R5-1.2 | spec 生成 | 偏好+限制 → 结构化 job spec JSON（保守默认 + **硬限制不可被偏好覆盖** + 冲突提示） | ✅ | P1 |
| R5-1.3 | factor_pool | L0-L6 因子模板 + 参数展开（100+）→ 按偏好过滤 | ✅ | P1 |
| R5-1.4 | factor_eval | IC/超额/单调性/独立度评估（对齐 tree_models make_labels 标签） | ✅ | P1 |
| **R5-2** | 挖掘任务状态机 + 持久化 | | ✅ | P1 |
| R5-2.1 | 建表 | `factor_jobs` + `factor_results`（SQLite 零依赖；PostgreSQL 为后续可选项） | ✅ | P1 |
| R5-2.2 | 状态机 | CREATED→PARSED→QUEUED→RUNNING(POOL→EVAL→SELECT→PERSIST)→COMPLETED/FAILED/CANCELLED/TIMEOUT | ✅ | P1 |
| R5-2.3 | 异步执行器 | 线程池/队列执行 + 重启可恢复 + 超时/取消保留部分结果 | ✅ | P1 |
| R5-2.4 | 状态 API | `GET status(job_id)` / `GET list` | ✅ | P1 |
| **R5-3** | MCP 对话工具集 | | ✅ | P2 |
| R5-3.1 | 架构定位 | 定：独立 Factor-Factory MCP 进程（`mcp-server/src/factor-index.ts`，:3014，systemd `infrax-factor-mcp`） | ✅ | P2 |
| R5-3.2 | 工具集 | `factor_factory.start/status/result/list/cancel`，接收结构化参数（内核不吃自然语言）；intent 走 ml-service `/mine` | ✅ | P2 |
| R5-3.3 | 入站鉴权 | inboundAuth 对齐（参考 dc-index/mpc-index 模式） | ✅ | P2 |
| **R5-4** | LLM 意图解析 + 结果报告 | | ✅ | P2 |
| R5-4.1 | 意图解析 | 自然语言→job spec（DeepSeek API / 本地 V100 LLM，function calling/结构化输出）；生产已配置（2026-08-14：复用 ragservicer `LLM_BINDING_API_KEY` → ml `.env` `FACTOR_LLM_API_KEY`，`FACTOR_LLM_MODEL=deepseek-v4-flash`，实测意图"动量波动率 BTC ETH SOL 日线 5个 10分钟"→ spec 正确解析并 COMPLETED） | ✅ | P2 |
| R5-4.2 | 冲突检测 | 偏好 vs 硬限制冲突回传提示，不静默 | ✅ | P2 |
| R5-4.3 | 结果报告 | 入选因子/IC/ICIR/独立度/稳定性报告 + 可视化 | ✅ | P2 |
| **FF-1** | ml-service 因子引擎解耦（承接 R4-4） | | ✅ | P1 |
| FF-1.1 | 定义上收 | 因子定义/计算上收 factorengine 注册表 | ✅ | P1 |
| FF-1.2 | 零复制接入验证 | 新增一个因子仅注册定义即可用 | ✅ | P1 |
| **FF-2** | factor_pool + factor_eval 内核（依赖 R5-1） | | ✅ | P1 |
| FF-2.1 | pool 展开 | 模板展开（100+）→ 按偏好过滤 | ✅ | P1 |
| FF-2.2 | 评估 | IC/超额/单调性/独立度评估 | ✅ | P1 |
| FF-2.3 | 选因 | top-K + 去冗余（独立度）+ IC 淘汰 | ✅ | P1 |
| FF-2.4 | 合格因子产出 | 写 catalog 候选（供 FF-3 登记） | ✅ | P1 |
| **FF-3** | 因子管理 + 入库 | | ✅ | P1 |
| FF-3.1 | catalog | `factor_catalog` DB 表：定义（key/公式/数据源/窗口/版本）+ 状态（active/inactive）；job 完成自动 `register_qualified`（2026-08-14 接线） | ✅ | P1 |
| FF-3.2 | 管理端点 | `GET /factors/catalog` + `POST /factors/{key}/activate|deactivate`（生产实测激活生效） | ✅ | P1 |
| FF-3.3 | 入库 data-service | 合格因子自动登记 → data-service `/factors/current` 附 `ml_factory` 字段（AItrader factor_client 无改动全量透传；60s TTL 缓存；生产实测 `["ret_20","vol_20"]`） | ✅ | P1 |
| FF-3.4 | 因子值暴露 | ml-service `GET /factors/values?symbols=` 按 active 因子 × symbol 算最新值；data `/factors/current` 透传 `ml_factory.values`（客户端免复算公式；data 侧 60s TTL 按 symbols 键控防串值；跨服务回调用 `asyncio.to_thread` 防死锁；commit c3e7f66）；**官方 SDK infra-data-client 0.3.0** 新增 `get_ml_factory`/`get_current_factors_full`（旧方法向后兼容），生产 data venv 已装并验证（6 因子 × BTC/USDT+SPY，commit 077ca6e + 0bc58f2） | ✅ | P1 |
| **FF-4** | 对话驱动 + 自动挖掘验证（依赖 R5） | | ✅ | P1 |
| FF-4.1 | 触发方式 | 定时/手动触发挖掘；2026-08-14 实现进程内调度线程（`factorengine/scheduler.py`，仿 prewarm_loop）：`.env` `FACTOR_MINER_SCHEDULE_ENABLED/INTERVAL_H(6h)/DELAY_S(60)/SPEC/INTENT`；负载控制=单 worker + 活跃任务跳过 + 距上次终态不足 interval 跳过 + interval 下限 1h；生产实测自动触发 `job=ff_20260814_b27353f68ab2` COMPLETED（动态池 10 标的） | ✅ | P1 |
| FF-4.2 | 对话集成 | R5-3 MCP 入口接入（生产实测 start→COMPLETED） | ✅ | P1 |
| FF-4.3 | 端到端验证 | 自动挖掘→登记 catalog→/factors/current 可见（生产全链路验证通过）；现有 `/ml/*` 不受影响 | ✅ | P1 |
| FF-4.4 | 衰退淘汰 | 挖掘 COMPLETED 后对 active 因子用登记评估环境（asset_pool/horizon）重评估，`abs(IC)<0.01 或 abs(ICIR)<0.03` 自动停用（`FACTOR_MINER_DEACTIVATE_IC/ICIR/ENABLED` 可调；未登记环境跳过防误停；单测 test_health_check_active_decays；commit c3e7f66） | ✅ | P1 |
| **HW-1** | 因子工厂硬件评估/采购 | 双路 E5-2683v4 + 64G + V100 32G（阶段一/二）；**⏸️ 延后（2026-08-12 用户决策：硬件升级延后，先做当前阶段 CPU 优化）**；附录 A 结论：复合/非线性因子=向量化矩阵计算，无需 vLLM | ⏸️ 延后 | P2 |

**验收标准（对齐三需求文档）**：
- [ ] 现有 6 模型行为/输出完全不变（回归通过）
- [ ] 新增模型只需「config + provider 子类继承 load/predict_all」三步；DEVICE 全局可切 CPU/GPU 无硬编码
- [ ] 因子从硬编码 14 个升级为可挖掘/评估/管理（catalog 含定义/版本/启停）
- [ ] 合格因子自动登记 catalog 并在 data-service `/factors/current` 可见，AItrader factor_client 无改动可消费
- [ ] 对话驱动：自然语言设定偏好+限制启动挖掘，硬限制不越界（预算/数量/耗时受控），任务状态可查、多轮对话可恢复
- [ ] 现有 `/ml/*` 预测端点不受影响

---

**2026-08-13 生产运维：PG 数据盘满紧急处置（/dev/vdb 196G）**

**现象**：`/mnt/pgdata`（数据盘）100% 满 → PG 无法写 `pg_wal`/`pg_subtrans` → PANIC 频繁崩溃；collector events 表 149GB（123G heap + 26G 索引）占满全盘。

**根因**：events 表按 7 天保留（cleaner `RETENTION_HOURS=7*24`），但实测写入约 30GB/天 → 7 天数据 ~210GB 超出 196G 数据盘容量；且全量数据都在保留窗口内时 `deleted:0`，表只增不减直到堆满。

**处置（已完成，collector 已恢复写入）**：
1. `pg_wal` 软链迁移至根盘 `/var/lib/pgdata_wal`（WAL 不再吃数据盘，**永久保留该布局**）
2. root 删除损坏索引段文件（idx_events_dedup 27G / idx_events_to_chain_block 10G）+ SIGKILL 释放文件句柄 + `DROP INDEX` 清 catalog
3. `CREATE TABLE events_keep (LIKE events)` 分片复制近 24h（索引强制位图扫描，避开全表 seq scan；共 17.8M 行 / 15GB），TRUNCATE → DROP → RENAME 换表，数据盘从 100% → 11%（167G 可用）
4. 去重 138 万行重复（索引缺失窗口期混入）后重建全部 13 个索引（含 UNIQUE `idx_events_dedup`）
5. **cleaner 改造（`collector/src/services/cleaner.ts`，已部署生产）**：保留窗口 7 天 → **72h**（`CLEANER_RETENTION_HOURS` 可覆盖）+ **磁盘守卫**：数据盘可用 <15% 自动按 24h 紧急保留清理；批量 DELETE + 非 FULL VACUUM（空间复用，物理尺寸封顶在窗口峰值）
6. 恢复 `LIKE` 未复制的 20 个列 DEFAULT（`updated_at` 等 NOT NULL 依赖默认值）

**遗留建议**：① 长期方案 = events 按 collected_at 做时间分区表（DROP PARTITION 物理回收），cleaner 换 `drop_chunks` 类机制；② 数据盘扩容 / 减少采集冗余（如 `idx_events_to_chain_block` 与 `chain_block` 部分重叠）；③ 磁盘使用率告警阈值建议接入监控（>85% 告警）。

---

**9.16 数据获取优化：RPC 池 + 多 IP 出口 + 节流（2026-08-13 登记；方案：docs/INFRAX_BACKUP_MULTI_IP.md）**

> **背景**：生产 RPC 全为免费公共节点（publicnode/bsc-dataseed/base.org/oxachain，**无 Infura/Alchemy**），全部出口走主服务器单 IP；免费公共节点均按 IP 限流，Yahoo/OKX 高频易 429。
> **评审确认（2026-08-13）**：① events **不做归档**（72h 保留不变）；② 用户将提供 **Infura/Alchemy API key** → 升级付费主 RPC；③ **免费 RPC 用多 IP 轮换确实有效**（配额 ×N）。
> **实施约束**：生产验证（本机仅写码）；B 端零感知、fail-silent；key 不入 git（systemd override/.env 权限 600）；全部配置驱动、默认直连可回滚。

**任务拆解（依赖链：A→B→C 可并行于 D；D-1 前置=用户提供目标服务器清单；RI-1 前置=用户提供 key）**

| 任务 | 内容 | 验收 | 状态 | 优先级 |
|---|---|---|---|---|
| **RI-1** | 接入 Infura/Alchemy 主 RPC（✅ 2026-08-13 key 已提供并部署） | | ✅ | P0 |
| RI-1.1 | key 配置 | 10 个 Infura key（实测限额不一）+ 2 账号 Alchemy（eth/base/solana 主网）写入 `collector/rpc-pool.json`（✅ 已部署生产） | 配置生效 | ✅ | P0 |
| RI-1.2 | 主链路由 | **按链分拆 key 池**（每 key 只服务一条链，避免三链共用耗配额）：eth=infura×4+alchemy×2、bsc=infura×3、base=infura×3+alchemy×2、solana=alchemy×2+public | 主 RPC 切换完成 | ✅ | P0 |
| RI-1.3 | 生产验证 | 34 端点加载；ethereum/bsc/base/sepolia 均经 Infura/Alchemy 持续出数（块号前进）；残余 429 为 Infura 免费 key 突发限额（单 key ~3-5 req/s），重试自愈；公共节点 403 已降级排除 | | ✅ | P0 |
| **RI-2** | 免费节点多提供商池（failover 备选） | | 🔲 | P1 |
| RI-2.1 | 多 provider 列表 | rpc-pool 本已含多 provider（publicnode/llamarpc/ankr/dataseed）并实现轮询+健康检查+故障切换（rpcPool.ts 既有能力）；本次补齐 solana（alchemy×2+public）并入 static 过滤（rpcPoolConfig.ts activeChains 已加 solana） | 列表入配置 | ✅ | P1 |
| RI-2.2 | rpc-pool 多 provider 轮询 | 现有降级检测+round-robin+epoch 分片已实现；**改进点（2026-08-16 确认，commit e80af2c 已实现）**：429 重试改换端点而非重试同一 key（`rpcPool.ts` `pickAlternativeEndpoint` 按链 failoverCursor 轮换到同链其他健康端点，无可用端点才退避重试同一 key） | 单节点故障无感知切换 | ✅ | P1 |
| RI-2.3 | 生产验证 | 公共节点 403/limit 自动降级排除；付费端点接管 | | ✅ | P1 |
| **RI-3** | 请求侧节流 | | 🔲 | P1 |
| RI-3.1 | 指数退避+jitter 封装 | collector okx 客户端、knowledge-injector yfinance 统一封装（429/5xx → 1s→2s→4s + jitter） | ✅（2026-08-15 部署：`okxMarketV6.ts` request 内 429/5xx → `1000×2^n×(0.6+rand×0.8)` 退避重试 3 次（402/其他 4xx 不重试透传），本地 mock 验证 backoff 区间 PASS；`knowledge-injector/providers/_yf_helpers.py` `_MAX_RETRIES 1→3`、退避加 jitter、`_is_rate_limit` 覆盖 429/5xx（500/502/503/504/server error）。生产部署 infrax-collector + infrax-knowledge-injector 重启，okx Snapshot 300 tokens 0 errors 无回归） | 🔲 | P1 |
| RI-3.2 | 基线观察 | 24-48h 记录 429/错误率基线 | 🔲（2026-08-15 04:38 部署后起算观察期，journald 日志留存：`journalctl -u infrax-collector | grep -E '429|rate-limit'` 可统计 okx/rpc-pool 429 基线；okx 429 重试现走 warn 日志） | P1 |
| **RI-4** | 多 IP 出口代理池（免费 RPC 多 IP 轮换核心） | | ✅ | P1 |
| RI-4.1 | 代理部署 | 5 台服务器装轻量 CONNECT 代理（自写 `connect_proxy.py`，select+threading）+ token 鉴权 + 本机绑定（`127.0.0.1:8848`）+ systemd；主服务器经 5 条 SSH `-L` 隧道（本地 18848-18852）接入，规避云防火墙 | ✅（2026-08-15 部署：5 台 systemd `infrax-egress-proxy` 均 active，5 条 `infrax-egress-tunnel-{1..5}` active，经代理 curl ipify 验证 5 个不同出口 IP：43.156.99.215/225.164/138.166/133.37.213/159.60.46） | ✅ | P1 |
| RI-4.2 | EGRESS_PROXIES 配置层 | 主服务器调用侧代理池配置（JSON，默认空=直连；回滚=清空重启） | ✅（2026-08-15：collector `.env` + knowledge-injector systemd drop-in `egress.conf` 注入 5 代理 JSON；collector `config.ts` `egressProxies` 解析（非法 JSON→`[]` 直连）；knowledge-injector `_yf_helpers._load_egress_proxies()` 加载（修复 drop-in 非法 JSON key 无引号导致池空→改写为合法 JSON，进程 environ 验证 `json.loads` OK）） | ✅ | P1 |
| RI-4.3 | 免费 RPC 出口轮换 | 公共节点请求经代理池轮换出口 IP（分摊 per-IP 配额） | ✅（2026-08-15：`collector/src/services/egressProxy.ts` EgressProxyManager（round-robin+30s 探测）+ `rpcPool.ts` axios `proxy:` 注入；生产部署后 5 台出口 TUNNEL 流量均匀 55-56 条，轮换生效） | ✅ | P1 |
| RI-4.4 | yfinance 出口轮换 | proxies 按请求轮换（Yahoo 单 IP 高频 429） | ✅（2026-08-15：yfinance 1.5.2 `_make_request` 每次用 `YfConfig.network.proxy` 覆盖 session.proxies（data.py），故改设 `YfConfig.network.proxy` 为 round-robin 选中代理（session.proxies 方式会被覆盖失效）；`safe_history` 带池实测 `hist=(5,7)` 成功，5 台出口 yahoo TUNNEL 12/10/10/… 条确认轮换） | ✅ | P1 |
| RI-4.5 | 健康探测+降级 | 30s 探测，代理故障自动回直连（fail-silent） | ✅（2026-08-15：collector egressProxy 30s 探测 ipify；knowledge-injector `_egress_probe` 30s 探测，unhealthy 跳过+日志告警。单代理故障演练：停 `infrax-egress-tunnel-5` → 18852 探测失败自动跳过（8 次轮换无 18852），safe_history 正常 `hist=(5,7)`；恢复后 18852 自动回归轮换） | ✅ | P1 |
| RI-4.6 | 验收 | 免费 RPC/Yahoo 出口 IP 可轮换；单代理故障 fail-silent；24h 观察 | 🔲（2026-08-15 验证完毕，24h 观察自 05:13 起） | ✅ | P1 |

> **遗留（2026-08-13 部署发现，非本次改动引入）**：
> ① ~~oxa 链 DNS 失败~~（✅ 2026-08-13 已修复）：`rpc.l1.oxachain.io` DNS 已死（ENOTFOUND），确认正确域名为 `rpc-oxa.0xainet.top`（chain-rpc 网关 8-10 起在用，AgentX 生产同域名）；collector `rpc-pool.json`+生产 `OXA_RPC_URL` drop-in、dc/index.ts、deploy 模板/文档已全部修正，oxa 扫描已恢复（checkpoint 82,556→前进中，落后 ~21k 块补扫约半天）；
> ② **eth 扫描慢**：单周期 ~30s（每块 getLogs 响应巨大，5 千+ 事件/块），落后实时约 N 块，属既有性能特征；
> ③ **solana 扫描：保持关闭（2026-08-13 用户决策）**。端点已配置（alchemy×2+public，rpc-pool.json 就绪）但 `scanner.ts ACTIVE_CHAINS` 未含 solana。实测（30 slot 采样外推）：**1.41 亿事件/天 ≈ 270GB/天 写入**（当前 5 链合计 ~1780 万/30GB），getBlock 全量响应 8.7MB/slot → 日下载 1.8TB，数据盘一天爆满、Alchemy 免费额度秒尽——全量不可控。如需采集，须先设计白名单（指定代币）+ 金额阈值过滤并小样本验证。

> **备注**：备份（P0）按 docs/INFRAX_BACKUP_MULTI_IP.md §2 另行排期，前置=用户确认目标服务器清单（**2026-08-17 口径确认：9 业务库 pg_dump ~87MB/日 + 加密配置，collector 整库不备份**；systemd timer 每日 03:30，14日+4周+12月，每月恢复演练）。

---

**9.17 生产负载诊断与优化：data 服务单核打满（2026-08-13 诊断+修复，生产已部署）**

**症状**：172 服务器 2 核 load 3.33，swap 1.5G 改用，IO wait 30%；infrax-data（:9112）24h 烧 16h59m CPU（~70% 单核）。

**根因**（证据链）：
1. `raw_snapshots`（58.5k 行 / 720MB）**无索引**，两个热点查询每次全表扫：`enrich.py _join_factors`（`WHERE symbol=? OR symbol='' ORDER BY fetched_at DESC LIMIT 50`）与 `factors.py get_current_factors`（`ORDER BY fetched_at DESC LIMIT 200`）；
2. **最新 200 条里仅 27 个唯一 (provider,data_type)**，73 条重复 —— 每次请求解析 200 条大 JSON（每条 10-50KB）浪费约 7 倍；
3. **4 个外部 IP 持续高频轮询**（43.156.25.197 ml 服务器 / 43.156.50.6 / 43.133.37.213 / 43.156.55.212），`/bars`（limit 500-1000）、`/factors/current` 单请求 3-5s。

**修复（生产已部署，2026-08-13 13:17 重启生效）**：
- ✅ 生产 SQLite 建索引：`idx_raw_snapshots_fetched (fetched_at DESC)`、`idx_raw_snapshots_sym_fetched (symbol, fetched_at DESC)`（EXPLAIN 已确认被采用；join 仍残留 `USE TEMP B-TREE FOR ORDER BY` 因 OR 分支合并）；
- ✅ `factors.py get_current_factors`：SQL 改 `WHERE id IN (SELECT MAX(id) GROUP BY provider,data_type)` 去重（200→27 条解析）+ **5s TTL 结果缓存**（键=(symbols, category)，上限 64 条）；
- ✅ `enrich.py _join_factors`：SQL 去重（每 data_type 最新 1 条）+ **5s TTL 快照缓存**（键=symbol，上限 128 条）。

**效果（重启后验证）**：`/factors/current` 5s → 279ms（miss）/ 52ms（hit）；`/bars` 3-5s → 40-200ms；data 服务 CPU 70% → **14.5% 稳态**；load 3.33 → 1.71。剩余负载 = collector 四链扫描（eth/bsc/base/sepolia）+ PG 写 events（正常采集业务）。

**遗留**：
> ① **CLOSE-WAIT 连接泄漏**（data 服务 python 重启后 ~10min 又积累 20+ 个对外 HTTPS CLOSE-WAIT，Recv-Q 积压）：疑 akshare/moomoo 等外部 HTTP 会话连接池对端关 keep-alive 未及时 close，需定位具体 collector（次要，不直接致 CPU 高但 fd/内存缓慢增长）；
> ② ~~`/factors/history` 单请求 0.5-1.5s~~（✅ 2026-08-13 修复）：元凶为 `_load_non_tech_history`（每次全量扫 5 万条 raw_snapshots 逐条 JSON 解析）+ `_load_ml_history`；已加 30s TTL 缓存（非 tech 全局 / ML 按 symbol），实测 1.6s → 18ms（命中）；
> ③ `/bars` limit=1000 大查询 + clean_bars 清洗逻辑本身有成本（clean_bars 为 O(n) 线性判定，毫秒级非瓶颈；40-200ms 已可控，外部轮询频率如有上升需再评估）。
>
> **CLOSE-WAIT 采样结论（2026-08-13，两次对比后判定非泄漏）**：重启后 ~10min cw=17/fd=99（目标=东财/新浪/腾讯云/CloudFront 数据源）；重启后 ~16min **cw=0/fd=103**。fd 稳定无增长、CLOSE-WAIT 可归零 → 属连接池正常残留（服务端 keep-alive 关闭后 urllib3 在下一采集周期复用前处于 CLOSE-WAIT 的临时状态），**无需代码修复**。可选兜底：systemd timer 每 5min 检查 fd 数（阈值 1500）超限自动重启。

**9.18 ml-service 性能优化：consensus 复用外层信号缓存，消除 Kronos 重复全量推理（2026-08-14 登记；方案见下）**

**背景/症状**（ML 负载诊断时发现，2026-08-14）：
- `volatility` 与 `consensus` 各并行触发 **Kronos 全量推理（各 ~22min/轮）**：prewarm 并行 trigger 各 key，consensus 内部 [consensus.py `build_consensus`](projects/ml-service/app/analytics/consensus.py) 直接调 `kronos.predict_all_volatility()` 不走外层 `_async_runner` 缓存 → 每轮 2C4G CPU 双倍（约 44min 计算 / 25min 周期）；
- consensus 内部另有 25min 缓存（`_cached`），与外层 `_endpoint_cache` 30min TTL **双层缓存错位**，语义混乱。

**目标**：consensus 复用外层 `_async_runner` 的 volatility/tree/bolt/moirai/timesfm 缓存（SWR 语义），避免重复全量推理；consensus 与各信号**同源一致**（同一份缓存数据）。

**方案**（依赖注入，避免 main.py ↔ consensus.py 循环导入）：
- `consensus.py`：`build_consensus(signal_providers: Optional[dict] = None)` — providers 为 `{信号名: 获取回调}`（tree/volatility/bolt/moirai/timesfm/sentiment/macro）；**None = 直接底层计算（保持库函数向后兼容）**；注入模式下内部 `_cached` 停用（统一外层 TTL 1800）；
- `main.py`：`_compute_consensus()` 注入 providers：`volatility → _async_runner.get("volatility", _compute_volatility)`（SWR：miss 触发后台计算并返回 stale/None，consensus 该信号降级，不阻塞）；
- TTL 对齐：consensus 外层缓存 TTL=1800 与依赖信号一致（默认已满足）。

**任务拆分**：
- C-1 `consensus.py` 签名参数化 + 信号获取解耦（默认行为不变，本地单测覆盖）
- C-2 `main.py` `_compute_consensus` 注入 providers（读外层缓存，miss 降级）
- C-3 双层缓存语义梳理：注入模式停用 `_cached`，统一走 `_endpoint_cache`
- C-4 本地验证：py_compile + build_consensus 注入假 provider 单测（聚合逻辑输出结构不变）
- C-5 生产验证：load 峰值减半（22min×2 → 22min×1）、`/ml/volatility` 与 `/ml/consensus` 数据同源、错误计数零新增

**风险/注意**：
- consensus 首次启动（volatility 缓存未就绪）→ 该信号缺失 → 聚合降级（risk 项减少）但仍出数据；数据滞后一周期可接受（30min 粒度，volatility 本就是慢变数据）；
- 依赖注入后需回归 consensus 输出结构（`n_symbols/avg_consensus_score/risk_flag`）与现有消费方（data-service collector）兼容。

**验收**：① load 峰值单轮（不再 2×22min 并行）；② volatility/consensus 数据同源；③ 端点 30 天无 null（SWR 兜底）。

**实施与验证记录（✅ 2026-08-14 commit `da04029`）**：
- C-1 `consensus.py`：`build_consensus(signal_providers=None)` 信号获取解耦为 `_safe_call` + `_default_*` 回调，默认行为不变（向后兼容库调用）
- C-2 `main.py`：`_compute_consensus()` 注入 providers，tree/volatility/bolt/moirai/timesfm 全走 `_async_runner.get(...)`（SWR：miss 后台触发 + 返回 stale/None 降级不阻塞）；sentiment/macro 保留轻量默认路径
- C-3 注入模式停用模块级 `_cached`（缓存职责移交外层 AsyncCacheRunner，统一 TTL 1800）
- C-4 本地验证：单测 4 项全过（注入无缓存 / 全 None / fail-silent 降级 / 聚合结构不变）；2026-08-15 复核同断言通过
- C-5 生产验证（43.156.25.197，2026-08-14 + 08-15 复核 `/ml/cache/stats`）：consensus `last_compute_ms` **1351839 → 1198.8**（-99.9%）；volatility `computes=27` 独立计算、consensus 不再重复触发 Kronos（每次仅 ~ms 聚合）；六 key 全部 `cached=True`，SWR stale 兜底正常；首轮 volatility 未就绪时 consensus 正常降级（30 符号，avg 0.72）

---

**9.19 生产扩容迁移（方案 C：整盘迁移 + ML 服务外迁，2026-08-15 定稿，详见 docs/INFRAX_MIGRATION_SCALE_OUT.md）**

> 背景：172（2C3.6G）swap 已用 1.3G、15min load 曾达 3.19（postgres ~60% CPU + ~1.1G 内存为最大户）；新增 43.156.78.59（2C4G Ubuntu 22.04，同地域可挂盘）。**核心决策**：172 数据盘 /dev/vdb（200G）是 postgres 唯一数据目录（10 库全在盘上，含 85G collector 事件库）→ 腾讯云控制台**物理整盘迁移**，零数据传输。
>
> 新机环境已核查：2C/3.6G 内存、系统盘 60G（剩 25G）、Python 3.12.3 + Node v22.23.1、内网 10.3.8.6/22 与 172（10.3.8.12）同网段互通（RTT 0.225ms、0% 丢包）；⚠️ 新机预装 postgres 16（172 是 14，需卸载 16 装 14 对齐）、docker/tailscale 已装、/opt/pocketx 残留 mpc-server 旧代码（无关）、.trae-cn-server 16G 占用（无碍）。

| # | 任务 | 内容 | 状态 |
|---|---|:---:|:---:|
| M-1 | 阶段 0 准备 | 新机装 postgresql-14（对齐 172）；172 pg_dump 备份 9 小库；rsync ragservicer/ki 代码+venv+units；新机公钥入 5 台出口 authorized_keys | ✅ |
| M-2 | 阶段 1 盘迁移（停机 10-30min） | 172 `stop postgresql` → 控制台卸载 vdb → 挂新机 → mount+fstab+符号链接 → postgresql.conf 调优 + pg_hba 放行 172 → 启动验证 10 库齐全 | ✅ |
| M-3 | 阶段 2 服务切换 | 172 9 服务连接串 `localhost:5432 → 10.3.8.6:5432`（collector/chain-rpc/dc/vault/waas/mpc/payments/session-key/admin-legacy）；nginx `/api/rag/` → 10.3.8.6:9721；admin-legacy/hub-index env 指新机 rag/ki；新机起 ragservicer+ki+5 条 egress 隧道 | ✅ |
| M-4 | 阶段 3 验证 | events 持续写入新机、dc/chain-rpc 查询正常、公网 /api/data、/api/rag、/api/v1 200、172 swap 归零 | ✅ |
| M-5 | 验收收尾 | 172 负载降至 ~1.0 确认、tasklist 更新、git 提交 | ✅ |
| M-6 | 二期可选 | collector 跟随数据迁新机（跨机 URL 5 处），本次不做 | 🔲 |

> 网络波动评估：唯一敏感链路 collector/chain-rpc/dc → 新机 postgres（内网 0.225ms RTT），collector 写库 ~1 事务/秒批量 INSERT 幂等，断线重连不丢不重；高耦合服务群全留 172 同机，风险可忽略。

**实际执行记录（✅ 2026-08-16，安全组放行后整体切换）**：
- **阶段 1**：172 16 个写库服务 + postgres 停止 → vdb 卸载挂新机（盘热拔触发 postgres PANIC，WAL 完整在 172 系统盘 `/var/lib/pgdata_wal` 4.1G，内网 12s 传新机完成 crash recovery，10 库齐全）
- **新机 postgres 排障链**：UID 对齐（172 postgres 112:113 vs 新机 111:112 → usermod/groupmod）→ 配置/日志/`/var/run/postgresql` 属主 → pg_wal 符号链接失效（补传 WAL）→ 权限 → 启动成功
- **阶段 2**：9 服务连接串 `localhost:5432 → 10.3.8.6:5432`（collector/dc/vault/waas/mpc/payments/session-key/admin-legacy 直接 sed unit；chain-rpc 主 unit 已改但**被 drop-in `payments.conf` 覆盖**——需同改 drop-in；session-key 在 `.env`）；nginx `/api/rag/` → 10.3.8.6:9721；admin `RAGSERVICER_BASE/INJECTOR_BASE`、hub-index `RAG_URL/INJECTOR_URL` → 新机；172 旧 rag/ki disable
- **补记（2026-08-16 12:08）aa-relay 连接串遗漏**：M-3 计划 9 服务未含 aa-relay（其 `DATABASE_URL` 不在主 unit、实际在 drop-in `override.conf`）→ 迁移后 session 表 init 报 `connect ECONNREFUSED 127.0.0.1:5432` → 人工修正 drop-in `localhost → 10.3.8.6` + daemon-reload + restart；运行时 env 验证 `@10.3.8.6:5432/pocketx_mpc`、`/health` 正常、日志无 ECONNREFUSED（关联 E-1c/E-1e）
- **新机服务**：ragservicer:9721 + knowledge-injector:9113（补 rsync `projects/shared` 共享 metrics 模块）+ 5 条 egress 隧道（18848~18852，新机公钥入 5 台出口 authorized_keys，https 出口 IP 逐一验证）
- **阶段 3**：collector 持续向新机 INSERT/UPDATE/VACUUM events（~90.6 万行）；公网 `infrax.app/api/rag/v1/health`、`/api/data/health`、`/api/v1/health` 全部 200；172 loadavg 3.19→0.87、swap 1.3G→513M 并回落

**迁移效果实测（✅ 2026-08-16 迁移完成后）**：

| 指标 | 迁移前 | 迁移后 |
|---|---|---|
| 172 loadavg（15min） | 3.19 | **0.56~0.76**（↓76%） |
| 172 swap 已用 | 1.3G | **504M**（↓61%，持续回落） |
| 172 postgres | ~1.1G 内存 + ~60% CPU | 已迁新机；`postgresql@14-main` failed（数据目录空）→ 已 `disable` 防开机误启 |
| 172 核心服务 | — | 11 个全部 active（collector/chain-rpc/dc/vault/waas/mpc/payments/session-key/admin-legacy/hub-index/web） |
| 172 系统盘 | 90G+ 被 pgdata 占用 | 31G/59G（26G 可用） |
| 新机 postgres | — | active，vdb 196G（已用 92G），collector 持续批量 INSERT events |
| 新机 rag :9721 / ki :9113 | — | active（`/api/v1/health`、`/api/v1/health` 200） |
| 新机 egress 隧道 ×5 | — | 全通，5 个独立出口 IP（18848~18852） |
| 新机 loadavg | — | 1.23（1min）/3.48（15min，启动期 autovacuum/索引预热高峰，正在回落） |
| 新机内存 | — | 2.2G/3.6G，swap 158M |
| 公网入口 | — | `/api/rag/v1/health`、`/api/data/health`、`/api/v1/health`、`/api/v2/data/stats` 全部 200 |

> 📌 观察项：新机 loadavg 属迁移后首小时后台恢复期（autovacuum/索引预热），建议 24h 后复核稳定值。

**9.20 平台钱包 EOA → 托管合约 + 计费链上化（2026-08-16 需求登记；源：docs/PAYMASTER_ONCHAIN_ESCROW_DESIGN.md，P1 演进方向）**

> 背景：平台钱包 `0x5682e2d55770e46ad24b92e51d6d0a3b629fa0b3` 为 **EOA**（`eth_getCode=0x`，托管 10 OXA 单点风险）；计费依赖中心化 DB ledger（不可链上验证）。链上 gas 结算（VerifyingPaymaster + EP deposit 扣减）**已存在**，本方案解决**服务费计费层 + 平台资金托管层**。方案要点：`InfraXEscrow` 托管记账合约（deposit/withdraw/charge/refund，storage 原子记账）+ relay 授权扣款（限额约束）+ 多签治理；ledger 降级为索引/对账层。当前（联调/小规模）ledger 仍最优，**P1 公开市场前优先落地阶段 1 消除单点风险**。

| 编号 | 任务 | 内容 | 状态 | 优先级 |
|---|---|---|---|---|
| OE-1 | Escrow 合约开发 + 测试 | `IInfraXEscrow` 实现（balances 记账/dailyCharged 限额/relayer 授权/ReentrancyGuard/UUPS 升级/pause）+ 单元测试（Hardhat/Foundry） | ✅（2026-08-16：合约 + 接口 + mocks + Hardhat 测试 26/26 全绿；OZ 5.6.1 UUPS + 手写 nonReentrant（OZ ReentrancyGuard 带 constructor 不满足升级安全）） | P1 |
| OE-2 | 第三方安全审计 | 重入/权限/限额/升级安全审计（上线前置） | 🔲（需第三方审计方，外部排期） | P1 |
| OE-3 | Escrow 部署（无多签，合约直接治理） | 直接部署 Escrow（oxachain 19505），**owner = 平台管理地址**（密钥 HSM/轮换，不引入外部多签；治理全部由合约机制承担：pause 冻结计费 + 限额兜底 + 升级需先暂停） | ✅（2026-08-16：已部署 oxachain 主网，proxy `0x8Bf8Ffee86F1D4a160f0953Eb13BEDcBF99eaF9E`，implementation `0x954940235982EE3F8D17EBF2e1E30bDdAC9c0153`，owner=`0x257a0E…BbF4`（AA_PAYMASTER_DEPLOY_PK），perTx/perDay 默认 1/10 OXA；ERC-1967 验证通过） | P1 |
| OE-4 | 平台 EOA 资金迁移清零 | EOA `0x5682e2…fa0b3` 10 OXA → **直接注资 Escrow/paymaster**（无多签环节）；EOA 提现清零、私钥作废 | ✅（2026-08-17：EOA 调 `escrow.deposit()` 全迁，tx `0x5d226851…c84a5e`（success）；Escrow balanceOf(EOA)=9.99994 OXA（留 0.0000054 OXA gas 找零）；EOA 余额 10→~0 清零；充值路径已切换 Escrow（OE-5），私钥作废由用户执行） | P1 |
| OE-5 | x402 充值目标切换 | `AA_PLATFORM_ADDRESS` → Escrow；verify 解析 Escrow deposit 入账事件 | ✅（2026-08-16 代码 + **2026-08-17 生产应用**：payments `X402Adapter` escrow deposit 解析 + server.ts `X402_ESCROW_ADDRESS` 装配；**生产 drop-in 已注入 `X402_ESCROW_ADDRESS=0x8Bf8Ff…`**（deploy/oe5-escrow-config.sh --apply），服务 active；测试 130/130 全绿） | P1 |
| OE-6 | aa-relay escrowMode 双轨计费 | `billing.ts` charge/refund 走 Escrow（feature flag），ledger 保留 fallback | ✅（2026-08-16 代码 + **2026-08-17 生产应用**：`billing.ts` escrowCharge/Refund/Balance；**生产 drop-in 已注入 `ESCROW_MODE=true` + RPC/ADDRESS/CHAIN_ID/RELAYER_KEY**；relayer `0xd2D3c8…614c` 已链上授权（tx `0x2647b2aa…`）；服务 active 且日志干净） | P1 |
| OE-7 | 并发/退差对账测试 | 100 并发 userOp 无超扣（合约原子）；收据退差与 ledger 结果一致（差异=0） | ✅（2026-08-16：合约层 100 并发 charge 无超扣 + 多笔 charge/refund 退差后链上余额 == ledger 期望（差异=0）+ 当日累计回退一致） | P1 |
| OE-8 | ledger 转索引/对账层 | 新用户默认 Escrow；ledger 事件索引 + 日终对账（ledger sum == 链上扣减）；存量余额（联调 1 OXA）结算清零 | ✅（2026-08-16 对账脚本 `projects/escrow/scripts/reconcile.ts` 落地（链上 balanceOf/chargedToday + 事件聚合 vs ledger payment_credits/payment_balances，守恒+索引+余额三断言，exit 0/1）；**2026-08-17 存量结算完成**——5 个联调/测试余额用户清零（合计 11.002 OXA，审计 5 条 balance.settled + CSV 快照 /tmp/ledger-settle/），ledger 0 正余额；**对账脚本加迁移基准过滤**（LEGACY_BASE_BLOCK=114033 / LEGACY_BASE_BY_USER，只对账迁移后增量，历史 credits 计入基准），重跑 **[PASS] 6/6 用户全通过**；ledger 事件索引 = OE-5 verify 入账；新用户默认 Escrow = ESCROW_MODE=true 双轨切换） | P2 |

> 阶段划分：OE-1~OE-5 = 阶段 1（优先，消除资金单点风险）；OE-6~OE-7 = 阶段 2（计费链上化双轨）；OE-8 = 阶段 3（ledger 转对账层）。每阶段可独立验收/回滚。
> **执行记录（2026-08-16）**：OE-1/5/6/7 代码完成（本地验证全绿）；OE-8 对账脚本完成（生产排期）；OE-2/3/4 为运维/外部项（第三方审计、Escrow 部署、资金迁移）。**治理决策（2026-08-16）：不引入外部多签**，由智能合约直接承担（owner=平台管理地址密钥 HSM/轮换 + pause 冻结计费 + 限额兜底 + 升级需先暂停）。
> **生产应用（2026-08-17）**：OE-5/OE-6 生产配置已落地（`deploy/oe5-escrow-config.sh --apply --mode=true`）：payments drop-in 注入 `X402_ESCROW_ADDRESS`，aa-relay drop-in 注入 `ESCROW_MODE=true` 全套配置；relayer `0xd2D3c8…614c` 链上授权完成（tx `0x2647b2aa…`），Escrow 合约 paused=false、relayerEnabled=true；两服务 active 且日志干净。资金未动（OE-4 待用户确认）。
> **OE-4 资金迁移（2026-08-17）**：平台 EOA 持私钥调 `escrow.deposit()` 全迁 9.99994 OXA（tx `0x5d226851…c84a5e`），EOA 余额 10→~0 清零；迁移脚本 `projects/escrow/scripts/migrate-oe4.ts`（ethers 本地填充 gas，规避 RPC 不支持 eth_fillTransaction / eip-1559 gasPrice 限制）；EOA 私钥作废由用户线下执行。**Escrow 托管余额合计 9.99994 OXA，链上计费已全部就绪（OE-4/5/6 全链路打通）。**
> **OE-8 存量结算 + 对账（2026-08-17）**：ledger 存量 5 个联调/测试余额用户清零（合计 11.002 OXA，payment_balances 置 0 + 审计 5 条 balance.settled + CSV 快照 `/tmp/ledger-settle/balances-before-settle-20260817-034310.csv`）；对账脚本新增迁移基准参数（LEGACY_BASE_BLOCK=114033 + LEGACY_BASE_BY_USER=0x5682e2…=9999944462999222482，链上事件与 credits 只统计迁移后增量），生产重跑 **`[PASS] 全部 6 个用户对账通过`**（EOA 链上 9.99994 OXA 由基准余额覆盖，5 个历史用户结清为 OK）。

**9.21 部署文档三台架构同步 + systemd unit 清单补全（2026-08-16 执行）**

> 触发：对照生产部署文档核查 25 个 systemd 服务 → 源码映射，发现 `deploy/systemd` 缺 8 个 unit 且 DEPLOYMENT.md 仍为单机版（2026-08-11 v0.7.0，与 8-16 三台迁移后实际不符）。

| 编号 | 任务 | 内容 | 状态 |
|---|---|---|---|
| U-1 | DEPLOYMENT.md 彻底更新 | 单机版 → **v0.8.0-20260816** 三台架构（43.163.105.172 主 23 服务 + 43.156.78.59 新机 postgres/rag/ki/egress + 43.156.25.197 ML 机）；DB 连接串全量 10.3.8.6；nginx `/api/rag/` → 新机；公网主域 infrax.app（迁移后全 200）；防火墙/健康检查/负载参考按服务器分区；修复备忘新增 v0.8.0 迁移条目 | ✅ |
| U-2 | cleanup 脚本连接串同步 | `deploy/infrax-cleanup.sh` 从 `sudo -u postgres psql`（本地 socket）改为 `psql -h 10.3.8.6 -U postgres`（迁移后 PG 在新机），bash -n 校验通过 | ✅ |
| U-3 | 缺失 unit 补全 ×8 | data/knowledge-injector/ragservicer/session-key 复用项目内现成 unit；rpc-mcp/market-mcp/session-key-mcp/admin-legacy 从模板推演新增；session-key-mcp 端口修正 **9111→3011**（源码默认）；敏感值统一走 drop-in（不入 git） | ✅ |
| U-4 | 三端代码一致性核验 | 本地 / 101.33.109.117（历史生产源码机）/ GitHub(sftgroup/infraX) master 全为 7f341d3；30 项目源码树逐项比对一致（远程多出文件均为 .gitignore 排除项） | ✅ |

> 生产三台实机（172/78.59/25.197）代码版本未经 SSH 直接核验（无凭证）；101.33.109.117 源码副本与 GitHub 完全一致。部署文档健康检查、端口、DB 连接等信息以 §9.19 迁移记录与迁移文档（INFRAX_MIGRATION_SCALE_OUT.md）为准。

---

**9.9 AgentX 通用支付能力需求（源：docs/FEATURE_REQUEST_AGENTX_ESCROW_PAYPERCALL_20260817.md，2026-08-17 拆分）**

> 提交方：AgentX 平台。通用能力上收、宿主策略保留。协同：InfraX 发版（payments 0.1.4+ / session-key 0.2.x+ / mpc-sdk 0.3.x+）→ AgentX npm bump。
> 编号说明：**AX-** 为 tasklist 内部编号（避免与既有 OE-1~OE-8 链上计费编号冲突）；括号内为需求文档原始编号。
> 状态标记：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办
> 实现顺序（按需求文档建议）：**P0（AX-1/AX-2/AX-3/AX-5/AX-6/AX-7）→ P1（AX-8/AX-9/AX-10/AX-11）→ P2（AX-12/AX-13）**

| 编号 | 需求（原始） | 任务内容 | 现状 | 优先级 |
|---|---|---|---|---|
| AX-1 | OE-1 公开 escrow 配置与 ABI | payments 服务层 escrow 透传修复：`X402Options` 加 `escrow` 字段并在 `PaymentsService` 构造时透传（当前 [service.ts](projects/payments/src/service.ts) 丢弃 escrow → HTTP 路径 escrow 判定不可达）；导出 `escrowDepositAbi`；`GET /capabilities` 暴露 escrow 地址；README 补齐配置说明 | ✅ | P0 |
| AX-2 | OE-2 标准 Escrow 参考实现 | 提供 Escrow 部署/集成指引文档（如何部署并配置 `x402.escrow.address` + `GET /capabilities` 暴露）；治理能力确认——owner 提现/资金总额上限列为可选项（多签按设计不引入，`docs/PAYMASTER_ONCHAIN_ESCROW_DESIGN.md` 为准） | ✅ 部署/集成指引见 [INFRAX_ESCROW_GUIDE.md](docs/INFRAX_ESCROW_GUIDE.md) | P0 |
| AX-3 | OE-3 ERC20 deposit 走 escrow | [x402.ts](projects/payments/src/adapters/x402.ts#L274) `verifyEscrowDepositTx` 支持 `token != 0`（按 token 校验 + 入账），补测试；或明确 stablecoin 判定 | ✅ | P0 |
| AX-4 | OE-4 对账参考实现 | 已实现：[reconcile.ts](projects/escrow/scripts/reconcile.ts)（链上 balanceOf/chargedToday/事件 ↔ ledger 守恒+索引+阈值断言，迁移基准过滤）。补：README/文档说明（集成方可跑对账任务） | ✅ 已实现（文档待补） | P0 |
| AX-5 | PC-1 resolveAccess 默认组合器 | `AccessCheckOptions` 扩展（优先级 + 子判定来源配置）；实现默认组合器 `chain 订阅 OR offchain 订阅 OR balance ≥ price`；AgentX 用默认组合器可复现 canAccessAgentOrPay | ✅ | P0 |
| AX-6 | PC-2 按次扣费审计/幂等 | `payment_access_log` 表 + `access.deducted` 事件 + deduct ref_id 幂等（对齐 AgentX `a2a_pay_log` 语义） | ✅ [009_payment_access_log.sql](projects/payments/db/migrations/009_payment_access_log.sql) | P0 |
| AX-7 | PC-3 402 响应结构化 | 引擎 402 body 结构化 `{ priceWei, payTo, resource, resumeRef, mode: 'topup'\|'subscribe' }`；构造 helper；宿主（collector :9101 / payment :9132）接入替换自拼 body | ✅ | P0 |
| AX-8 | A2A-1 a2aSettle balance 模式 | `a2aSettle` 增 `mode: 'tx'\|'balance'`（默认 tx 兼容）；balance 模式校验余额 → deduct → intent paid + 事件/onCredit，ref 幂等 | ✅ | P1 |
| AX-9 | SK-1 代付授权模板 | session-key 提供典型代付授权模板（contracts=[Escrow/Vault], functions=[deposit]）的 SessionAuth 生成示例/辅助函数 | ✅ [session-key.md §5](docs/services/session-key.md) | P1 |
| AX-10 | SK-2 文档与实现对齐 | [docs/services/session-key.md](docs/services/session-key.md) 7 处"服务端生成 sessionAddress"→ 客户端提交 publicKey；`CreateSessionRequest.sessionAddress` 类型字段对齐 | ✅ | P1 |
| AX-11 | SK-3 测试补强 | 补会话创建/撤销、白名单拒绝（CONTRACT/FUNCTION_FORBIDDEN）、并发锁（SESSION_LOCKED 429）、过期路径测试（当前仅 execution-service.test.ts 覆盖限额/过期） | ✅ session-service.test.ts 10 例 + execution-service.test.ts 16 例 | P1 |
| AX-12 | SK-4 会话私钥托管加固（可选） | AES-256-GCM 已就绪；补 KMS/外部密钥托管可选接缝 + 文档标注密钥管理最佳实践 | ✅ IKeyVault/EnvKeyVault（core 0.2.2）+ HttpKeyVault/buildKeyVault（server）+ 文档 §6；core/evm 已发布 0.2.2/0.1.3 | P2 |
| AX-13 | MPC-1 2-of-3 阈值演进 | TSS_EVALUATION 加片3（独立签名机/HSM）落地：签名/恢复路径支持 3 片 2 阈值 + 2-of-3 测试 + 2-of-2 平滑兼容 | ✅ mpc_signer `/v1/import` 3 片 t=2 + `/v1/sign` `partner_index` 1/2（TSS_SIGNER_URL_1/2 路由）；tss_signer `TSS_PARTY_ID` 实例标签；`m4_2of3` 3 子集签名全部有效 + `verify-2of3.mjs` HTTP 级两路径复核；server.ts 六端点 `partnerIndex` 透传 + `recovery_shard2` 列迁移（存量 2-of-2 平滑兼容）；文档见 [TSS_EVALUATION.md §7](docs/TSS_EVALUATION.md) | P2 |

> **现状核对记录（2026-08-17）**：三组 search 调研确认——OE-2/OE-4 已实现；OE-1 部分（服务层透传断裂）；SK-2/3/4 部分；OE-3、PC-1/2/3、A2A-1、SK-1、MPC-1 未实现。详见上方任务表。
>
> **REQ-1~5 智能账户充值闭环（AgentX 自动续订需求，源：docs/aa-auto-renew-funding-requirements-infrax.md，2026-08-19 提交）**：
> - **REQ-1（P0 合约）`depositFor`/`depositForERC20`**：EOA 代子账户入账（`_balances[user] += msg.value`，与 EP depositTo 同语义，无权限要求）+ 事件 `DepositedFor(user, amount, token, by)`。✅ **已上链**（commit `62d6d27`，4 单测/30 passing；UUPS 升级 impl `0x5ff8638103723d38b5103bf6bb9ba2abf36e3bca`，2026-08-19 生产机执行 + 链上实测 tx status 1；`depositFor` selector eth_call 复核可调用）
> - **REQ-2（P0 relay）计费/资金能力**：✅ **生产部署**（commits `62d6d27`/`bce1491`/`71f6892`）——2a `/v1/ledger-balance` escrow 模式放行（不再误 503）；2b 资金总览 `funds{escrowWei, epDepositWei, nativeWei}`；2c 402 `topupHint` 按计费主体区分（子账户场景指引 depositFor）。生产实测（2026-08-20）：`POST /v1/ledger-balance` 返回 `funds{escrowWei:0, epDepositWei:0, nativeWei:10.09 OXA}`（escrow 模式 200）
> - **REQ-3（P1 文档）价目与结算语义**：✅ **已完成**——`docs/AA_RELAY_BILLING.md`（预扣构成=固定费+预估 gas、退差语义 refund/extra/全额退、SLA 建议 ≥150s、异步提交模式 202+轮询）；**2026-08-21 P1 代码落地**（commit `3da283e`）：`wait:false` 返回 **202 Accepted**（原 200）+ 异步**后台收据结算退差**（与同步同口径，多退少补；120s 无收据保留预扣仅告警；广播失败仍全额退），`waitForUserOpReceipt`/`asyncSettle` 接入 `/v1/userops` 与 session revoke/replace（submitSignedOp），生产已部署（plans 200 验证）；**202 端到端待 AgentX 集成验证**；**P2 优化落地**（commit `accade2`）：① 结算/退款失败重试（`retrySettle` 3 次指数退避，402 不重试，接入全部 settle/refund 调用点）；② `GET /v1/userops/:hash` 状态机 `status: pending/confirmed/reverted`；③ `GET /v1/plans` 透出 `limits`（perTx=1/perDay=10 OXA 合约默认，用户级 `setChargeLimit` 可定制；评估结论：自动续订单次 ~0.0025 OXA，默认限额日支撑 ~4000 次续订，无需调高）——生产已验证（plans limits 返回 + 状态机 pending）
> - **REQ-4（P2 AgentX 备选）self-pay fallback**：AgentX 侧自理（session 白名单加 `escrow.deposit()`）；infraX 已文档化兜底路径（AA_RELAY_BILLING.md §5 / AA_STACK_GOTCHAS.md §4）——REQ-1 落地后不再需要
> - **REQ-5（P2 批量）`depositForBatch`/`depositForERC20Batch`**：✅ **已上链**（commit `d6dd9b3`，3 单测；与 REQ-1 同批升级 impl；生产实测 tx `0x0bd95a6c` 两账户精确入账）
> - **SDK 充值构建 helper（2026-08-21，`@0xinfrax/aa-sdk@0.1.3` 已发版 npm）**：✅ 新增 `projects/aa-sdk/src/escrow.ts`——`InfraXEscrowAbi`（deposit/depositFor/depositForBatch/depositForERC20/depositForERC20Batch）+ 编码 helper（`encodeDepositFor*`）+ UserOp 构建（`buildDepositForUserOp`/`buildDepositForBatchUserOp`/`buildDepositForERC20UserOp`/`buildDepositForERC20BatchUserOp`，组合 Kernel v3 execute/executeBatch；users/amounts 不等长抛错防链上 revert）。EOA 直连路径用 `InfraXEscrowAbi` + viem `writeContract`（REQ-1 主钱包代充值）；智能账户自付路径用 `buildDepositFor*UserOp`（session key 兜底，REQ-4）。134 单测全过（新增 13），typecheck+build 通过；文档同步（README 关键导出 / AA_SDK_TECH_DESIGN §3 包结构 / AA_RELAY_BILLING §5 SDK 用法表）。
> - **遗留**：AgentX 前端按 REQ-1 落地（SDK 0.1.3 `buildDepositForUserOp`/`InfraXEscrowAbi` + 续订资金预检告警）；tasklist 原 §9.20「OE-3 第三方审计」仍未排。

---

**9.22 图谱因子（Graph Factor）统一方案（源：projects/data/AITRADER_GRAPH_FACTOR_REQ.md，2026-08-18 AItrader 提交；扩展 GX 源：docs 图谱因子技术设计）**

> 提交方：AItrader。基于 **LightRAG 知识图谱**（RAGservicer :9721，namespace `market`）的数值因子 + 存量文档 `[no-context]` 故障。通用方案覆盖事件面（GF，RAGservicer 契约）+ 结构面（GX 扩展，moomoo 供应链/相关性图）。
> 数据源：knowledge-injector `crypto:daily:*`（事件/新闻实体关系）、**moomoo MM-11 F10（财报 income/balance/cashflow + 一致预期 + 估值，`fetch_financials`）**、data-service `/bars`（滚动相关性）、宏观锚点。
> 状态标记：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办
> 实施顺序：Phase 0（GF-1/GF-2 P0）→ Phase 1（GF-3/GF-4/GF-5 P1）→ Phase 2（GF-6 P2）→ Phase 3（GX-1 M1 结构因子）→ Phase 4（GX-2 M2 图嵌入+FF 联动）→ Phase 5（GX-3 扩展数据面框架）。
>
> **扩展机制设计（统一图模型，支持灵活添加数据面）**：
> - **数据源适配器（Source Adapter）**：统一接口 `fetch → normalize → upsert`（节点/边/属性）；新数据源仅需实现一个适配器，接入 `graph_factor.db` 无需改图结构
> - **边构建器注册表（Edge Builder Registry）**：每类边独立构建器（industry/supply_chain/corr/event/earnings_event/financial_similarity），注册即用、按图层权重合并
> - **属性注入器（Attribute Injector）**：财报/估值/情绪等作为节点属性（features 表 JSON 字段），不占图结构
> - **数据面清单**：已规划——moomoo F10（财报 income/balance/cashflow/一致预期/估值/卖空兴趣/资金流/新闻）、data-service `/bars`、knowledge-injector 19 源、宏观锚点；可扩展——链上 defi tvl、衍生品（资金费率/持仓）、社媒情绪、多语言新闻
> - **接入路径**：适配器 → 边构建器/属性注入器 → `graph_factor.db` → 因子 compute 注册 → catalog/FF

| 编号 | 需求 | 任务内容 | 现状 | 优先级 |
|---|---|---|---|---|
| GF-1 | 存量文档图谱构建修复 | 1163 篇文档在库但检索 `[no-context]`。**已完成（2026-08-19）**：根因=LightRAG 事件循环劣化（服务 3 天未重启）致异步任务假成功/状态不回写 + denoise 去重残留 `dup-*`。处理：重启 ragservicer（indexed 742→923，积压全消化）+ 清理 287 篇 error（286 dup-* + 1 defi:tvl，fail=0）。终态：indexed 923 / error 0 | ✅ | **P0** |
| GF-2 | 图谱检索回归验证 | **已完成（2026-08-19）**：8 条标准查询（BTC_ETF/ETH_L2/RATE/POLICY/MINER/DEFI_TVL/INSTITUTION/MACRO）retrieve 回归——**8/8 PASS（100% 命中，no-context 归零）**，平均响应 11.2s | ✅ | **P0** |
| GF-3 | 图谱因子端点 `GET /factors/graph` | RAGservicer :9721 实现，契约 8 数值因子（graph_entity_count/relation_count/sentiment/event_intensity/centrality/momentum_affinity/policy_exposure + top_entities/events）；子图聚合 + PageRank/边加权情绪；日频（随 `crypto:daily:*`）；验证：与 fear_greed/finbert_sentiment 方向一致 ≥70% | ✅ 生产验证（2026-08-19）：`/factors/graph?symbol=BTC` 8 因子 + top_entities/top_events，大小写不敏感，缺 symbol 400；graph_sentiment vs finbert 100% 同向；topcap 租户数据回退 default | P1 |
| GF-4 | 因子目录并入 catalog | `/factors/graph` 输出并入 `/factors/catalog`（graph 分类，metadata 对齐 catalog 规范） | ✅ 生产验证（2026-08-19）：`/factors/catalog` 9 条 graph 分类（factor_id/name/category/type/range/description），无 key 401 | P1 |
| GF-5 | 可视化端点 `GET /graph/entities` | 力导向图数据：nodes（category 9 枚举：asset/central_bank/exchange/fund/whale/project/media/event/policy + size=sentiment）+ edges（relation 8 枚举：affects/funding/custody/listing/whale_move/etf_flow/regulation/sentiment_correlate + weight）；前端 ECharts 渲染 | ✅ 生产验证（2026-08-19）：`/graph/entities?namespace=market&limit=100` 100 nodes / 672 edges，node keys=category/id/sentiment/size，edge keys=relation/source/target/weight | P1 |
| GF-6 | AItrader 专用 key | 签发 `RAGSERVICER_API_KEY`（现借用 aiservicer），key 隔离治理 | ✅ 生产验证（2026-08-19）：`lr_a1a683d4b905e9c32ef10d3569b8ef38edad9c3f1eab5af7`（tenant=aitrader，GF-3/4/5 全端点 200，无 key 401）；凭证见 [docs/PRODUCTION_CREDENTIALS.md §7](docs/PRODUCTION_CREDENTIALS.md)；图谱数据回退 default 共享数据面；**B 端访问经 nginx `/api/rag/*` 通用方案，不直连 :9721（见 §2.1）** | P2 |
| GX-1 | moomoo 供应链/行业图 + 结构因子（M1 扩展） | ml-service graph_engine：静态图（moomoo 行业/供应链 + F10 财报传导）+ 结构特征 `gf_degree/gf_betweenness/gf_pagerank/gf_community/gf_structural_hole/gf_neighbor_mom/gf_neighbor_vol/gf_sector_mom/gf_cc_spillover`；data `/factors/current?category=graph` 透传（60s TTL） | ✅ 生产部署（2026-08-19）：ml-service graph_engine（SourceAdapter/Industry/SupplyChain 边）+ `graph built: nodes=180 edges=4087 sectors=10 communities=9`；data `/factors/current` graph 透传（6 symbols 命中，catalog 18 条） | P1 |
| GX-2 | 相关性动态图 + 图嵌入 + FF 联动（M2 扩展） | `/bars` 滚动 60 日 |ρ|≥0.6 动态边 + 社区动量 + Node2Vec（`gf_node2vec_1..k`）；FF 挖掘候选 IC/ICIR 评估 → 自动激活/衰退淘汰（FF-4.4） | ✅ 生产部署（2026-08-19）：CorrelationEdgeBuilder（`/bars` 60 日 |ρ|≥0.6，crypto 裸对 /USDT 回退）+ 谱嵌入 `gf_node2vec_1..8` + 社区动量因子；FF 联动（GF-2.4 候选池评估）待接入 | P2 |
| GX-3 | 扩展数据面接入框架（Source Adapter + Edge Builder + Attribute Injector） | 统一图模型扩展机制：Source Adapter（`fetch→normalize→upsert`）、Edge Builder Registry（边构建器注册 + 图层权重合并）、Attribute Injector（财报/估值/情绪节点属性）；接入验证数据面：moomoo 卖空兴趣/资金流、财报事件边/基本面相似边（财报进图）、衍生品资金费率、链上 defi tvl；文档：扩展接入指南 | ✅ 生产部署（2026-08-19）：graph_engine 扩展机制（SOURCE_ADAPTERS/EDGE_BUILDERS/ATTRIBUTE_INJECTORS 注册表 + register_*）；内置 HeatmapAdapter/Industry/SupplyChain/Correlation/HeatmapBarsInjector；文档 [docs/services/ml-graph-factors.md](docs/services/ml-graph-factors.md)（GX-3.6） | P2 |

> **要点记录**：GF-1 已锁定根因方向——AItrader 对照实验证明注入→实体抽取→检索链路正常（sync=1 注入 `aitrader-diagnose-20260818` 命中），问题在存量异步任务。moomoo MM-11 F10 含财报（income/balance/cashflow）可作 GX-1 供应链传导的数据基础（生产权限待验证，`fetch_financials` 本地 ret=0 空）。验证基线：GF-2 回归、GF-3 方向一致 ≥70%、GF-5 ECharts 渲染、GX 单因子 IC/分层收益单调性、回测区间 2024-09 起（对齐 ML 因子）。

> **GF-1 执行拆分（2026-08-18 生产验证后）**：
> - GF-1.1 试点重灌：`POST /inject/crypto_overview` + `POST /inject/defi_tvl`（ki :9113，X-API-Key=INJECTOR/RAGSERVICER key），验证新 doc_id 为 indexed（打通链路）
> - GF-1.2 批量重灌：其余 17 个来源逐个 `POST /inject/<source>`（onchain/tech_analysis/indices/macro/sentiment/volatility/news_sentiment/major_events/fred_economics/earnings_index/global_macro/evm/macro_trend/tree_ml/consensus/p2_predictions/ml_predictions）
> - GF-1.3 残留清理：脚本翻页收集 `status∈{error,indexing}` 的 doc_id（454 篇）→ `DELETE /documents/<doc_id>?sync=1`（先重灌后清理）
> - GF-1.4 向量一致性核查：重灌后对比 expected vs retrieved chunk（日志 `data inconsistency` 是否消失）
> - GF-1.5 缺失向量重建：对仍缺失 chunk 的文档重嵌入（重灌/re-embed）
> - GF-1.6 GF-2 回归：retrieve/query 命中率、no-context 归零、`crypto:daily:*` 实体上下文覆盖
> - GF-1.7 日志验证：`Vector similarity data inconsistency` 警告消失、indexed 占比 >95%
> - GF-1.8 状态登记：GF-1/GF-2 更新为 ✅ 并汇报

> **GF-1/GF-2 执行结果（2026-08-19 凌晨）**：GF-1.1 试点重灌成功（crypto_overview 46s / defi_tvl 262s，今日 47 篇 indexed）；GF-1.2 重启 ragservicer 后积压全消化（indexed 742→923）——LightRAG 事件循环劣化根因（服务 3 天未重启，异步任务假成功）；GF-1.3 清理 287 篇 error（286 dup-* denoise 去重残留 + 1 defi:tvl，fail=0）；GF-1.4 向量核查：**仍有 data inconsistency 警告**（defi:tvl/onchain 部分文档 chunk 向量缺失，检索 fallback WEIGHT 可用），修复见 GF-1.5（重嵌入/repair，待办）；GF-1.6 GF-2 回归 8/8 PASS（no-context 归零，平均 11.2s）；GF-1.7 重启后日志验证：inconsistency 警告降至部分（vs 修复前常态）；GF-1.8 已登记。

> **GF-1.5 执行结果（2026-08-19 凌晨）**：向量重建完成。①全量核查：text chunks 1035 vs vdb 709，缺失 328（defi 239 + onchain 79 + other 10）；②重嵌入：dashscope `text-embedding-v4`（batch 上限 10，>10 报 400 InvalidParameter），NanoVectorDB 增量 upsert，修复后 vdb 1037 / still_missing=0（vector=base64(zlib(float16)) 1024d 格式对齐）；③残留索引清理：实体/关系 chunk 索引引用 6 个已删除 chunk id（e2e.txt 等清洗遗留，非向量缺失）→ 从 entity_chunks/relation_chunks 移除 93 条引用（48+45，relation count 同步）；④验证：`/api/v1/namespaces/market/retrieve` 命中 Arbitrum/DeFi TVL/BTC 上下文，日志 `data inconsistency` 计数归零，检索不再 fallback WEIGHT。备份：vdb_chunks.bak.json / entity_chunks.bak.json / relation_chunks.bak.json（/tmp）。
> **GF-1.5 补充（检索稳定性回归，2026-08-19）**：服务重启后压测 10/10 串行 + 8/8 并发全部 200，响应 0.3~5s（cache 命中）；查日志仍有 2 个残留 chunk id（`onchain:checkpoints...2030` / `onchain:btc_transfers...1534`）——根因是 **graphml 图存储节点 `source_id`**（d3 属性，`&lt;SEP&gt;` 分隔）也引用已删除 chunk，且 **vdb_entities/vdb_relationships 的 `source_id` 同样需清理**（查询实体节点数据来自图存储，非 entity_chunks 文件）。处理：vdb_entities 清 28 行/32 id、vdb_relationships 清 22 行/22 id、graphml 清 28 处引用，重启后 `data inconsistency` 完全归零（仅剩 rerank 未配置/development server 无害提示）；误触发的 admin/market 空实例已删除。备份：vdb_entities.bak.json / graph_chunk_entity_relation.bak.graphml（/tmp）。
> **GF-1.5 残留 chunk id 修复清单（已修复 ✅，2026-08-19）**：以下 6 个 chunk id 已从 text/vdb 删除但残留于 graphml（28 处）、vdb_entities（32 处）、vdb_relationships（22 处）、entity_chunks/relation_chunks（93 处）索引引用，**全部清除完毕**，检索日志 `data inconsistency` 归零：
> - `onchain:checkpoints:daily:20260805T2030-chunk-000`（清洗遗留，日志最后一次报错 item）
> - `onchain:btc_transfers:daily:20260805T1534-chunk-000`（清洗遗留）
> - `onchain:btc:daily:20260805T1532-chunk-000`（清洗遗留）
> - `okx:market:daily:20260805T2032-chunk-000`（清洗遗留）
> - `defi:tvl:Polygon:20260807T1336-chunk-000`（清洗遗留）
> - `e2e.txt-chunk-000`（e2e 测试文档残留）

> **GF-2 执行拆分（图谱检索回归）**：
> - GF-2.1 回归用例集：定义标准查询集（BTC/ETH/宏观/情绪/政策 ≥10 条），记录修复前基线（no-context 率）
> - GF-2.2 执行回归：重灌清理后跑用例集，统计命中率、no-context 归零
> - GF-2.3 登记：GF-2 更新 ✅，基线对比存档

> **GF-3 执行拆分（/factors/graph 端点，RAGservicer :9721）**：
> - GF-3.1 子图提取：从 LightRAG 图谱取目标 symbol 子图（实体/关系/边权重）
> - GF-3.2 因子计算：8 数值因子（entity_count/relation_count/sentiment/event_intensity/centrality/momentum_affinity/policy_exposure）+ top_entities/events；子图聚合 + PageRank + 边加权情绪
> - GF-3.3 端点接入：新增 `GET /factors/graph` 路由 + 鉴权 + 日频缓存（随 `crypto:daily:*`）
> - GF-3.4 方向一致性验证：与 `/factors/live` fear_greed/finbert_sentiment 对比 ≥70%

> **GF-4 执行拆分（catalog 并入）**：
> - GF-4.1 契约对齐：`/factors/graph` 输出 metadata 对齐 catalog 规范
> - GF-4.2 目录合并：`/factors/catalog` 新增 graph 分类条目
> - GF-4.3 文档同步：catalog/数据服务文档更新

> **GF-5 执行拆分（/graph/entities 可视化）**：
> - GF-5.1 数据端点：`GET /graph/entities` 返回 nodes（category 9 枚举 + size=sentiment）+ edges（relation 8 枚举 + weight）
> - GF-5.2 前端验证：ECharts 力导向图渲染
> - GF-5.3 文档：前端集成说明

> **GF-6 执行拆分（AItrader 专用 key）**：
> - GF-6.1 签发专用 `RAGSERVICER_API_KEY`（多租户，对齐 app_auth）
> - GF-6.2 迁移：AItrader 接入方替换新 key，废弃借用 aiservicer
> - GF-6.3 凭证/文档更新

> **GX-1 执行拆分（moomoo 供应链/行业图 + 结构因子，M1）**：
> - GX-1.1 数据准备：moomoo 行业分类 + 供应链映射 + F10 财报字段（生产权限验证，`fetch_financials` ret=0 待实机确认）
> - GX-1.2 graph_engine 静态图：networkx 构图（same_industry/supply_chain 边）+ SQLite graph_factor.db（nodes/edges/features）
> - GX-1.3 结构特征：`gf_degree/gf_betweenness/gf_pagerank/gf_community/gf_structural_hole`
> - GX-1.4 邻居聚合特征：`gf_neighbor_mom/gf_neighbor_vol/gf_sector_mom/gf_cc_spillover`
> - GX-1.5 data-service 接入：`/factors/current?category=graph` 透传 + catalog（graph 分类，60s TTL）
> - GX-1.6 验证：单因子 IC/分层收益单调性、回测 2024-09 起（对齐 ML 因子）

> **GX-2 执行拆分（相关性动态图 + 图嵌入 + FF 联动，M2）**：
> - GX-2.1 动态相关边：`/bars` 滚动 60 日 |ρ|≥0.6 建边
> - GX-2.2 社区动量：Louvain 社区 + 社区动量因子
> - GX-2.3 Node2Vec：64 维嵌入取前 k（`gf_node2vec_1..k`）
> - GX-2.4 FF 联动：`gf_*` 入挖掘候选池，IC/ICIR 评估 → 自动激活/衰退淘汰（FF-4.4）
> - GX-2.5 全链路验证：端到端 + 回测

> **GX-3 执行拆分（扩展数据面接入框架）**：
> - GX-3.1 Source Adapter 框架：统一接口 `fetch→normalize→upsert`（节点/边/属性）
> - GX-3.2 Edge Builder Registry：边构建器注册表 + 图层权重合并（industry/supply_chain/corr/event）
> - GX-3.3 Attribute Injector：财报/估值/情绪节点属性注入（features JSON 字段）
> - GX-3.4 财报事件边/基本面相似边：财报发布→标的事件边 + 财务结构相似聚簇（财报进图，可选）
> - GX-3.5 扩展数据面验证：moomoo 卖空兴趣/资金流、衍生品资金费率、链上 defi tvl 接入试点
> - GX-3.6 文档：扩展接入指南（适配器/边构建器/属性注入器规范）

> **GF-3/GF-4/GF-5/GF-6 执行结果（2026-08-19 生产部署+验证）**：
> - 部署前根因修复：生产 ragservicer（43.156.78.59:9721）缺失 GF 代码（routes/factors.py、routes/graph.py、api/graph_engine.py 均不存在）→ scp 部署 6 文件（api/graph_engine.py + routes/{factors,graph}.py + routes/__init__.py + openapi.py + requirements.txt，MD5 全对齐）+ 生产 venv 装 networkx 3.6.1/scipy 1.18.0 + 重启 `infrax-ragservicer`（active）。
> - 503 根因修复：AItrader key 绑定 tenant=aitrader，`data/aitrader/market/` 空（无注入数据）→ graph_engine 三个 loader 增加 `resolve_graph_dir`（租户目录缺 GraphML 时回退 default 共享 market 数据面，仅影响只读图谱数据路径，不破坏 tenant 鉴权）。
> - GF-3 生产验证：`/factors/graph?symbol=BTC`（AItrader key）→ 8 因子（graph_entity_count=205/relation_count=353/centrality=0.0162/sentiment=0.2378/event_intensity=0.1173/momentum_affinity=-0.8413/policy_exposure=0）+ top_entities 10 + top_events 5；eth 大小写不敏感；缺 symbol→400；无 key→401。
> - GF-3.4 方向一致性：graph_sentiment vs finbert_sentiment **4/4=100% 同向**（BTC/ETH/SOL/XRP + vs +0.027）；fear_greed=41（恐慌，全局指数）当前快照与所有文本情绪信号（含 finbert）反向，属市场状态域差异非算法缺陷。
> - GF-4：`/factors/catalog` 9 条 graph 分类（factor_id/name/category/type/range/description）。
> - GF-5：`/graph/entities?namespace=market&limit=100` → 100 nodes / 672 edges（node keys=category/id/sentiment/size；edge keys=relation/source/target/weight，契约对齐）。
> - GF-6：AItrader 专用 key `lr_a1a683d4b905e9c32ef10d3569b8ef38edad9c3f1eab5af7`（tenant=aitrader）GF 全端点 200 / 无 key 401；凭证文档见 PRODUCTION_CREDENTIALS §7。

> **GX-1/GX-2/GX-3 执行结果（2026-08-19 生产部署+验证）**：
> - 部署：ml-service（43.156.25.197:9120）`app/graph_engine.py`（GX-1/2/3 统一扩展机制）+ `data_client.fetch_heatmap` + main.py `_PRECOMPUTE["graph_factors"]` + `/ml/graph_factors`、`/ml/graph/catalog` 端点 + requirements networkx/scipy；data-service（43.163.105.172:9112）`/factors/current` graph 透传（60s TTL）+ `/factors/catalog` 并入 18 条 `_GRAPH_FACTORS`。重启两服务（active）。
> - 图规模：`graph built: nodes=180 edges=4087 sectors=10 communities=9 values=150`（corr + sector 边合并后；对比修复前 1862 边）。关键修复：`/bars` crypto 裸对补 `/USDT` 回退（裸对返回 0 根）+ topcap/other 板块 `_SECTOR_MAP` 回填。
> - 因子验证：BTC/ETH/SOL/XRP 同社区 0（Layer1 行业边+相关性边），LINK 社区 3、UNI 社区 2；BTC gf_degree=0.402/gf_neighbor_mom=0.0035/gf_neighbor_vol=0.0141/gf_node2vec_1..8 非空。
> - 端点验证：`/ml/graph_factors?symbols=BTC,ETH,SOL,XRP,LINK,UNI` 6/6 命中（code 0）；`/ml/graph/catalog` 18 条全 graph 分类；无 key 401。data-service `/factors/current` graph block present（6 symbols + catalog 18）。
> - 文档：GX-3.6 [docs/services/ml-graph-factors.md](docs/services/ml-graph-factors.md)（概览/端点契约/18 因子清单/扩展机制规范/数据面规划/运维）。
> - 待办：GX-2.4 FF 联动（`gf_*` 入挖掘候选池 IC/ICIR 评估）、GX-3.4 财报事件边/基本面相似边、GX-3.5 扩展数据面试点（moomoo 卖空兴趣/资金费率/链上 defi tvl）。

> **待办拆分登记（2026-08-19，GX-2.4 / GX-3.4 / GX-3.5 细化）**：
> 前置现状：FF-4.4 引擎已完整实现并生产启用（ml-service `app/factorengine/`：pool 候选池 / eval IC·ICIR / catalog 登记·自动激活·衰退淘汰）；moomoo F10 已生产实测可用（MM-11.1/11.3，`provider=moomoo_f10` 快照 6h 落库）；资金费率已产出（data-service `_get_crypto_derivatives_metrics`，Coinglass+Binance，`collector:crypto_factors`）；defi tvl 已落库（data-service `/snapshots?type=tvl`，DeFiLlama）。
>
> **GX-2.4 FF 联动（`gf_*` 入挖掘候选池，M2 收尾）**：
> - GX-2.4.1 候选池注册：`factorengine/pool.py` `expand_factor_pool()` 增加 graph 因子模板（category="graph"），18 个 `gf_*`（gf_degree/gf_betweenness/gf_pagerank/gf_community/gf_structural_hole/gf_neighbor_mom/gf_neighbor_vol/gf_sector_mom/gf_cc_spillover/gf_community_mom/gf_node2vec_1..8）按 id 注册为 FactorCandidate（params={factor_id}），支持 `FACTOR_MINER_SPEC` 过滤启用
> - GX-2.4.2 历史序列落库：graph 因子日频快照持久化（graph_factors 历史表或对齐 data-service snapshot），保证 IC 评估窗口有 ≥N 日历史（对齐 FF 评估 horizon，缺失期自动跳过）
> - GX-2.4.3 IC/ICIR 评估接入：`eval.py` 对 `gf_*` 复用 `evaluate_factor()`（数据源=graph 历史序列），门槛对齐 FF（`FACTOR_MINER_MIN_IC 0.03 / MIN_ICIR 0.3`），IC 独立性去冗余入 top-K
> - GX-2.4.4 登记 + 自动激活：`register_qualified()` 登记通过评估的 `gf_*`（inactive，评估环境 asset_pool/horizon 入 params）→ `auto_activate()` 置 active → data-service `/factors/current` 合并可见（AItrader factor_client 无改动可消费）
> - GX-2.4.5 衰退淘汰覆盖：`health_check_active()`（FF-4.4）对 active `gf_*` 用登记评估环境重评估，`abs(IC)<0.01` 或 `abs(ICIR)<0.03` 自动停用并追加 `[FF-4.4 decayed]` 标记（未登记评估环境跳过防误停）
> - GX-2.4.6 验证：候选池展开含 18 个 `gf_*`、挖掘作业 COMPLETED、`gf_*` 登记 factor_catalog、`/factors/current` 可见 `gf_*`、健康检查覆盖无误停
>
> **GX-3.4 财报事件边/基本面相似边（财报进图，M2）**：
> 数据域说明：moomoo F10 为美股标的（AAPL/MSFT/NVDA/TSLA/SPY），与 crypto 图宇宙并集接入（stocks 板块共存）。
> - GX-3.4.1 F10 数据面适配器：`FinancialsAdapter`（SourceAdapter）拉 data-service `/snapshots?provider=moomoo_f10`（financials[:2]/consensus/valuation），normalize 节点（_financial_type/items 关键指标），fail-silent
> - GX-3.4.2 财报属性注入：`FinancialsAttributeInjector` 注入节点属性（净利润/营收/估值/一致预期 → features JSON，不建边）
> - GX-3.4.3 财报事件边：`EarningsEventEdgeBuilder`（kind="earnings_event"）——财报期 report 时间 → 标的事件边，权重可配置（对齐 `_EDGE_WEIGHT_*` 常量）
> - GX-3.4.4 基本面相似边：`FinancialSimilarityEdgeBuilder`（kind="financial_similarity"）——财务结构特征向量（ROE/毛利率/资产负债率等归一化）余弦相似 ≥ 阈值建边，并入 Edge Builder Registry 图层权重合并
> - GX-3.4.5 验证：新边/属性并入后图规模与 community 可观测（betweenness/community 受影响）、`/ml/graph_factors` 无回归、单数据面缺失降级不影响构图
>
> **GX-3.5 扩展数据面验证（moomoo 卖空/资金流、资金费率、链上 defi tvl 接入试点，M2）**：
> - GX-3.5.1 卖空/资金流落库：data-service `MoomooExtraCollector` 扩展落库 `fetch_short_interest`/`fetch_daily_short_volume`/`fetch_capital_flow`（对齐 mm_f10 模式，6h 周期）
> - GX-3.5.2 卖空/资金流属性注入：`MoomooShortAttributeInjector`（short_interest/资金流 → 节点属性，F10 标的域）
> - GX-3.5.3 资金费率数据面：`FundingRateAdapter`（SourceAdapter）拉 data-service crypto_factors（funding_rate/open_interest/open_interest_change_24h/long_short_ratio）→ crypto 节点属性（衍生品情绪），fail-silent
> - GX-3.5.4 链上 defi tvl 数据面：`DefiTvlAdapter`（SourceAdapter）拉 `/snapshots?type=tvl` → 链节点/属性（tvl/change_24h/dominance）+ 链-资产关系边（可选）
> - GX-3.5.5 试点验证：新数据面全部进图（nodes/attrs 日志可观测）、单数据面失败 fail-silent 降级、全链路回归（`graph built` 规模 + `/ml/graph_factors` + data-service 透传）无退化
>
> 依赖关系：GX-3.4 与 GX-3.5 均依赖 graph_engine 扩展注册表（已就位），GX-3.4 依赖 moomoo_f10 快照（已就位）、GX-3.5.1 依赖 data-service collector 扩展（需先行）；GX-2.4 依赖 graph 历史序列落库（GX-2.4.2，可先行）与 FF 引擎（已就位）。三者数据面相互独立，可并行开发。
>
> **GX-2.4 / GX-3.4 / GX-3.5 执行结果（2026-08-19，完成）**：
> - 部署 commit：`3343d3a`（GX-2.4/3.4/3.5 主代码）+ `2498497`（CryptoFactorsCollector + CacheConfig）+ `b9bee94`（market_data `_core_patch` 挂载 `__init__`/`_crypto_metric_cache`）+ `13b96a3`（APIKeys 补 COINGLASS/CRYPTOQUANT）。ML 机（43.156.25.197）与 data 机（43.163.105.172）均已 pull + 重启（infrax-ml-service / infrax-data active）。
> - **GX-2.4 FF 联动**：`pool.py` 候选池注册 18 个 `gf_*`（category="graph"）；`graph_history.py` SQLite 幂等快照（自然日归一化 ts）；`eval.py`/`jobs.py` 复用 `evaluate_graph_factors`（横截面 IC/ICIR，门槛对齐 FF）；`catalog.py` gf_ 前缀登记 + `auto_activate`；`health_check_graph_factor` 衰退淘汰分支（无评估历史防误停）。
>   - 生产验证：`/ml/graph/catalog` 18 条全 graph 分类；`/ml/graph_factors` 150 值（6 symbols × 25）；data-service `/factors/current` graph block 6/6 symbols + catalog 18 + ml_factory；factor-factory 挖掘作业 COMPLETED/persist；**graph_history 快照 2433 rows / 150 symbols / 1 自然日幂等**（`gf_degree=0.4302` 等，由 prewarm 自动落库）。
> - **GX-3.4 财报事件边/基本面相似边**：`graph_engine.py` 注册 `financials` SourceAdapter + `financials_attrs` AttributeInjector + `earnings_event` / `financial_similarity` EdgeBuilder（moomoo F10 数据面，fail-silent）。生产 `graph built: nodes=69 edges=430 sectors=7 communities=6 values=69` 无回归；`/snapshots?provider=moomoo_f10` 快照端点可用。
> - **GX-3.5 扩展数据面试点**：`FundingRateAdapter`（crypto 衍生品情绪）+ `DefiTvlAdapter`（tvl/change_24h/dominance）+ `MoomooShortAttributeInjector`（卖空/资金流）；data-service `CryptoFactorsCollector`（300s 周期 → db_cache）+ `/factors/crypto-derivatives` 端点。
>   - 生产验证：`/factors/crypto-derivatives?symbols=BTC,ETH,SOL,XRP` 4/4 真实数据（funding_rate 3.65e-05 / open_interest 6.86e9 / long_short_ratio 1.48 等）；`/snapshots?type=tvl` 可用；Coinglass 无 key 时 Binance 兜底降级正常。
> - 关键修复：market_data 子模块拆分后 `__init__.py` 缺失 `_core_patch`（`MarketDataCollector.__init__`/`_crypto_metric_cache` 未挂载 → crypto 采集 AttributeError）；`APIKeys` 补 COINGLASS/CRYPTOQUANT 类属性。均已本地验证 + 生产复验。
>
> **AA Bundler 迁移与恢复（Alto，2026-08-19，完成）**：
> - **背景**：原自建 Alto Bundler 部署于 AgentX 机 `43.159.60.46:4338`（`/opt/pocketx`，MQ-10 E-1 登记）。AgentX 侧重建系统盘后 `/opt/pocketx` 随盘丢失 → bundler 服务不可用（AgentX 提交的需求）
> - **架构决策（用户裁定 2026-08-19）**：Bundler 属**通用服务**，**所有权与维护责任归 infraX**，部署于 infraX 服务器（`43.156.78.59:4338`，与 ragservicer 同机，腾讯云安全组已放行）；AgentX 等 B 端**仅通过 relay/SDK 调用**，不直接管理
> - **重建内容**：① alto **v1.2.8** git clone + pnpm build（contracts 9 合约 + src 编译通过）；② **SafeValidator 补丁**重新应用（`DelegateAndRevert` 解码 + `validationResultParamV7`，编译产物 `src/esm/rpc/validation/SafeValidator.js` 已验证含补丁）；③ node 18.19.1 → **20.20.2** 升级（alto 产物依赖 `import attributes` 语法）+ pnpm 8.15.4；④ **新执行钱包 `0xF434e5254C4a4DD314F1e80087FBC54533065c8B`**（utility=executor 同 key，beneficiary 退款回流）；⑤ `.env`（chmod 600）：RPC `https://rpc-oxa.0xainet.top`、EntryPoint v0.7 `0x97e4cddc...`、4 个 simulations 合约地址显式传入 + `ALTO_DEPLOY_SIMULATIONS_CONTRACT=false`、`ALTO_BLOCK_TIME=31000`、port 4338；⑥ pm2 进程 `pocketx-alto`（active，监听 4338）
> - **验证**：`eth_supportedEntryPoints` → `0x97e4cddc...` ✅；`eth_chainId` → `0x4c31` ✅；`pimlico_getUserOperationGasPrice` → 1 gwei ✅；构造无效签名 UserOp 走模拟 → 返回标准 ERC-4337 错误 `AA30 paymaster not deployed`（补丁生效、模拟解码正常，非 500）✅
> - **中转资金**：测试钱包 `0xd8e2cf...`（= `AA_DEPLOYER_PRIVATE_KEY`，46 网关 .env）转 **5 OXA** 至执行钱包（tx `0x4ea0da4e...`，块 `0x1d48d`，余额 5 OXA）；余额用于 bundler 广播 tx 周转，EntryPoint beneficiary 退款回流
> - **relay 变更**：data 机 `AA_OXACHAIN_BUNDLERS` `http://43.159.60.46:4338` → **`http://43.156.78.59:4338`**（`infrax-aa-relay.service`，daemon-reload + restart active）；`AA_OXACHAIN_KERNEL_VERSION=0.3.0-beta`/escrow/paymaster 配置全部保留；163.105 → 78.59:4338 公网连通验证 ✅
> - **遗留**：① escrow 充值路径设计（§5，待落地，用户自充 gas 方向已确认）；② AgentX 侧全链路回归（§6，AgentX 执行：alipay/无 gas 等场景重跑 E2E）；③ 旧机 60.46 `pocketx` 目录已丢失无需清理

> **因子双轨收敛：统一入口 `/factors/graph`（GF-3 语义图谱因子并入 data-service，2026-08-19 完成）**：
> - **背景**：语义图谱因子（ragservicer `/api/v1/factors/graph`，`lr_*` key）与 data-service 统一因子通道（`/factors/current`，`dx_*` key）双轨并行，B 端需分别持有 lr_*/dx_* 两类 key，调用方（AItrader 等）持多个 key 易混乱。
> - **方案（用户裁定 2026-08-19）**：语义图谱因子迁入 data-service **统一入口 `GET /factors/graph`**（`/factors/current` 与 `/factors/crypto-derivatives` 之间）；data-service 内部持 ragservicer default 租户服务 key 透传，B 端**仅需 data-service key（dx_*）**，单 key 单入口消费全部因子。
> - **代码（commit `96accd3`）**：
>   - `projects/data/app/config.py`：新增 `RAGSERVICER_BASE_URL` + `RAGSERVICER_SERVICE_KEY`（注释说明统一入口方案）
>   - `projects/data/app/ml_client.py`：新增 `fetch_rag_graph_factors(symbols)`（逐 symbol 调 `/api/v1/factors/graph`，数值因子过滤，60s TTL 按 symbols 集合键控）+ `fetch_rag_graph_catalog()`（300s TTL），均 fail-silent
>   - `projects/data/main.py`：新增 `GET /factors/graph` 端点（返回 `{"ts","meta":{"source":"ragservicer","catalog","updated_at"},"factors":{symbol:{...}}}`）
> - **生产部署**：data 机 163.105 `git pull` → `.env` 追加 `RAGSERVICER_BASE_URL=http://43.156.78.59:9721` + `RAGSERVICER_SERVICE_KEY=lr_16c4aa5d…`（data-service-internal 服务 key）→ `systemctl restart infrax-data`（active）
> - **key 治理（立即吊销旧 key）**：吊销 aitrader `prod` `lr_db9f5e4c04bbffa88b46b98990805f7580d48a8a8dad5e45`（key_3f10effdd05ad073）与 aihunter-saas `prod` `lr_db0c2ac4c…`（key_eff09eb7e0a2d0fe），均 active=0；保留 data-service-internal（内部透传，禁外发）+ aitrader-main/aihunter-saas-main（B 端备用直连）。B 端最终 key 由用户转发（见 PRODUCTION_CREDENTIALS §7）
> - **验证**：`GET /factors/graph?symbols=BTC,ETH` 无 key 401 / 带 dx_* key 200 → 8 因子真实返回（BTC graph_centrality=0.0165/graph_entity_count=205/graph_sentiment=0.2314/graph_momentum_affinity=-0.8426 等）+ catalog；服务日志无新增报错
> - **遗留**：B 端（AItrader/AIHunter SaaS）确认是否迁移至 data-service key 消费 `/factors/graph`（备用 lr_* 直连 key 保留但非推荐）

> **因子通道收敛·第二轮（2026-08-19，key 定位收窄：lr_ 仅文档，因子全走 dx_）**：
> - **用户裁定**：业务逻辑上 `lr_*` key 应只用作 LightRAG 微服务**文档写入 + 信息读取**；**因子一律走 data-service `dx_*` key**。此前把 aitrader-main / aihunter-saas-main 定义为"B 端备用图谱直连 key"与原则冲突。
> - **代码（commit `4e30aa1`）**：ragservicer `api/auth.py` 新增 `require_service` 装饰器（请求 key 必须在 `RAGSERVICER_FACTOR_KEYS` 白名单内，否则 403）；`routes/factors.py` `/factors/graph` + `/factors/catalog` 改用 `require_service`；`config.py` ServerConfig 新增 `factor_service_keys`（env `RAGSERVICER_FACTOR_KEYS`）；`/graph/entities` 归读取信息保留 `require_tenant`（B 端 lr_ key 可用）。
> - **生产部署（78.59）**：scp 3 文件（MD5 全对齐，原文件 .bak.20260819 备份）+ `.env` 追加 `RAGSERVICER_FACTOR_KEYS=lr_16c4aa5d…`（data-service-internal 服务 key）→ `systemctl restart infrax-ragservicer` active。
> - **验证（吊销前）**：服务 key → `/factors/graph`/`/factors/catalog` 200；B 端 lr_ key → 因子端点 **403**（`Service-level key required for factor endpoints`）、`/graph/entities` 200、documents 200；无 key 401。
> - **key 治理（用户澄清后恢复）**：用户澄清——`lr_*` 属**独立 LightRAG 微服务**（供项目方上传/读取资料，documents 注入/列表、query/retrieve 检索、graph/entities 可视化），与因子/金融数据方案无关；**今日（2026-08-19）以前发放的 lr_ key 全部保持有效**。据此恢复全部 4 把 B 端 key（aitrader prod/main + aihunter-saas prod/main，active=1；e2e 测试 key `key_434b4736…` 维持吊销）。
> - **复验（恢复后全通过）**：B 端 lr_ key → `/graph/entities` 200、documents/retrieve 200、**因子端点 403**（service-only）；服务 key → 因子端点 200；**data-service `/factors/graph` 透传 200**（dx_* key 消费）。
> - **REQ-G1（commit `c796f14`）**：ml-service `_LAST_GRAPH` 图快照 + `compute_graph_edges_payload()` + `GET /ml/graph/edges`；data-service `fetch_graph_edges()`（300s TTL）+ **`GET /factors/graph/edges`** 统一入口。生产部署（197/163.105 git pull + restart）验证：BTC `gf_community=0/gf_pagerank=0.007843` 与 edges 节点完全同口径（同图快照）。
> - **REQ-G3 回复**：market 图谱 1176 节点（graphml 3.4MB，limit 建议 200~500）、日频持续灌入、category 9 枚举 + relation 8 枚举清单（详见 requirements-infrax-graph-rag.md「B 端回复」）。
> - **后续**：因子消费仅需已有 dx_* key；文档写入/检索/图谱可视化继续用现有 lr_ key（全部有效，见 PRODUCTION_CREDENTIALS §7）。

> **REQ-G8 / REQ-G9 修复（aihunter-saas 需求，2026-08-20 完成）**：
> - **REQ-G8 图谱实体双语（name_en 映射表）**：`projects/ragservicer/api/entity_name_en.json`（439 条中文→英文映射，覆盖 top-300 有意义术语与值后缀变体）；`graph_engine.py` 新增 `load_name_en_map()`/`name_en_of()`，`build_graph_payload()` 节点新增 `name_en`（精确查表 → 剥离值后缀回查核心词，如「机会评分48/100」→ Opportunity Score 48/100，`美元`→` USD` 语言化 → 未命中 null）。生产部署（78.59）：`/factors/graph/entities?namespace=market&limit=300` 300 节点中 124 个带 name_en（加密货币市场→Crypto Market、机会评分→Opportunity Score），噪音降级 null。
> - **REQ-G9 edges 真实相关系数（组合方案）**：
>   - **根因**：data-service `kline` 表 1d 仅 40 symbols（crypto 仅 BTC/ETH/SOL/XRP 5 对）→ ml-service 150 标的 universe 大多无 bars → returns 空 → 真实 corr 边为 0 → `compute_graph_edges_payload` 把非 corr 边图层权重（industry weight=1.0）当 `corr` 输出恒 1。
>   - **修复**：① ml-service `graph_engine.py` edges 仅输出真实 corr 边（`rho` 存在才输出，`corr` 带符号、`abs_corr`=|ρ|，abs_corr 降序截断）；② data 机 `.env` `KL_SYMBOLS` 5 对 → **81 对**主流币（`data_config.json` `kline.symbols` 同步），预置 75 新币 1d bars（ccxt binance，5 个非现货对 POPCAT/MNT/CRO/OKB/KAS 剔除）。
>   - **生产验证**：data 机 163.105 + ml 机 156.25.197 重启，ml 预热重建图 `nodes=129 edges=1373 sectors=10 communities=11`；`/factors/graph/edges` 透传返回全 kind=corr 真实相关性（BTC-ETH ρ=0.9147、SPY-QQQ ρ=0.9098、GC=F/SI=F ρ=0.8960），无伪造 1.0。
> - **遗留**：AIHunter 前端按 |ρ| 归一化线宽 + corr 正负染色、英文界面 name_en 消费，实测无回归（B 端确认）。
> - 需求原文与实现依据见 `requirements-infrax-graph-rag.md` REQ-G8 / REQ-G9。

### 9.9 WAAS 优化任务（源：arb 上传 `prd/arbitrage-waas-design.md` 对照评审，2026-08-19）

> **评审背景**：Arbitrage 上传其平台 WAAS 设计方案（充值 HD 地址/冷热分离/归集/提现状态机/SystemConfig/dry-run/审计），我方对 `projects/waas`（:9109 多租户钱包服务）逐项对照，产出优化清单。已对齐项（无需改）：每用户唯一充值地址（address_pool UNIQUE(tenant_id,chain,external_user_id)）、四类风控规则 + 签名策略阈值、租户级 sweep 配置 + sweep_records 审计、paymentPassword 二次确认、admin fail-closed、chain-rpc 网关读/广播 key 分级（B-10-6 已收口）。
> **对照维度**：arb §2 架构 / §3 SystemConfig / §4 核心流程（充值幂等·确认数、提现重试、sweepAll gas 赞助）/ §5 安全风控 / §6 优化建议。
> 状态标记同前：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办

**9.9.1 P0 资金安全**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|---|
| W-1 | **充值入账原子化 + 唯一约束兜底**：`processDeposits`（scannerService.ts）余额 UPDATE / 入账 INSERT / webhook INSERT 三独立语句改单事务；`transactions` 加 `UNIQUE(wallet_id, tx_hash)` + `INSERT … ON CONFLICT DO NOTHING`（当前仅先查后插，并发扫描窗口可重复入账；arb §4.1 `Deposit.txHash unique`） | ✅ | P0 |
| W-2 | **确认数门槛**：扫描到即入账，`blockScanner.confirmations` 未用、`minConfirmations` 配置未接入 → 按链两段式 `pending_confirmations → confirmed`（arb §4.1 确认数≥阈值） | ✅ | P0 |
| W-3 | **广播重试与失败回退**：`sendTransaction` 广播失败生产环境直接 `status='failed'` → 引入重试计次（>3 次 → failed + 资金回退状态，arb §4.2） | ✅ | P0 |
| W-4 | **gas 赞助熔断**：恒 `gas_sponsor=true` 无熔断 → 广播前检查 gas pool 余额，低于告警阈值暂停自动广播并告警（arb §3.2 `gas_alert_bnb`） | ✅ | P0 |

**9.9.2 P1 风控准确性**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|---|
| W-5 | **风控限额改 USD 口径**：`checkRisk` 用 `parseFloat(amount)`（token 数量），而 `convertToUsd` 在风控之后才执行，非稳定币限额失真 → 先换算 USD 再判限额（arb 全按 USDT 面值） | ✅ | P1 |
| W-6 | **getUserLimits DB 覆盖补全/移除**：riskService L196-206 两处 `// Override` 空实现，返回恒默认值，前端展示与实际校验不一致 | ✅ | P1 |
| W-7 | **daily_limit 口径统一**：当前仅统计 `confirmed/pending` → 对齐 arb"排除 failed/canceled"、纳入 pending_confirmation/pending_approval | ✅ | P1 |

**9.9.3 P2 健壮性/可运维**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|---|
| W-8 | **客户端幂等键**：`sendTransaction` 无 requestId，双击/超时重试可重复广播 → 幂等键 + `UNIQUE(idempotency_key)` | ✅ | P2 |
| W-9 | **分布式任务化**：index.ts `setInterval` 扫描 / eventRoutes 心跳 / webhook 重试均进程内，多实例会重复扫描/重复 sweep → Redis 锁或 BullMQ（arb §6）；以 PG advisory lock（`pg_try_advisory_lock`，零依赖）实现 `withLock` 接入扫描/重试/归集调度 | ✅ | P2 |
| W-10 | **DRY_RUN 开关**：当前仅 `NODE_ENV=development` 分支 mock txHash → 显式 env 开关 + 模拟广播落审计表（arb §2/§5） | ✅ | P2 |
| W-11 | **sweep 链上对账 + 执行闭环**：`sweepTenantFunds` 基于 DB 账本 net_balance 且仅建 pending 记录，无链上广播/确认 → 改链上真实余额 + dust/gas 阈值 + 执行器（arb §4.3 sweepAll） | ✅ | P2 |
| W-12 | **sweep_records 补 batchId**：聚合审计归属（arb §6 自提问题同样适用） | ✅ | P2 |
| W-13 | **私钥分层**：WALLET_ENCRYPTION_KEY / HD seed 缺省时静默降级 dev（仅 warn）→ 生产 fail-closed（2026-08-19 已生产启用：NODE_ENV=production + 随机 seed/密钥 + 移除 key 拒启验证通过）；KMS/HSM + 密钥轮换（arb §3.1/§5，远期增强） | ✅ | P2 |
| W-14 | **运行时 SystemConfig**：当前配置全 env、调参需重发 → DB 化配置白名单 + maskSecret 回显（arb §3） | ✅ | P2 |
| W-15 | **提现/购买 2FA**：当前仅 paymentPassword → 增加 TOTP（arb §5 强校验） | ✅ | P2 |
| W-16 | **冷热分离动态额度**：热钱包只留当日预估流水，超出自动归冷（arb §6） | ✅ | P2 |

### 9.10 AA Session 会话轮换优化任务（源：AgentX 修复文档 `docs/aa-relay-session-rollover-fix-infrax.md`，2026-08-19 对照评审）

**背景**：AgentX 生产复现 L12 —— Kernel v3 **单 session** 结构下，同一智能账户重复 enable 自动续订失败（AA23）。根因：① 本地 disable 从不上链 → 链上 session validator 残留，再次 `installModule`/`enableSession` 覆盖被拒；② 撤销后重 enable 的 `InvalidNonce`（`uninstallModule` 不清 `validationConfig[vId].nonce`），需批量 execute `uninstallModule + invalidateNonce(cur+1)` 推进 nonce。AgentX 路径 A（调用方自愈）已上线；推荐 infraX 评估路径 B（relay 层会话轮换/复用）。

**infraX 现状对照（2026-08-19 更新）**：`aa-relay /v1/session/disable` 已实现上链闭环（本地 remove + draft + `/v1/session/revoke` 签名广播）；aa-sdk 已补 `encodeExecuteBatch`、`isModuleInstalled` 探测、`isPolicySuperset` 复用判定；`GET /v1/session` 已返回 createdAt/isBound；`POST /v1/session` 已实现 B2 复用（兼容复用 / 不兼容 409）。

**9.10.1 P1 缺陷修复（disable 上链闭环 + 残留自愈）**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|---|
| AA-1 | **disable 上链闭环（B1）**：`POST /v1/session/disable` 仅本地 remove + 返回 disableCallData，链上 session 永不撤销 → 提供"带签名上链"撤销端点（调用方传 owner 签名，relay 组装 disable UserOp=批量 `[disableSession@module, uninstallModule, invalidateNonce(cur+1)]`（三段，2026-08-20 修订：必须直接 disableSession 删记录——部署模块 onUninstall 为空实现）、估 gas、广播返回收据）；保留本地停用 + 返回 draft 兼容路径（AgentX §2.2/§4 路径 B1） | ✅ | P1 |
| AA-2 | **aa-sdk 补 encodeExecuteBatch**：仅 `encodeExecute`（单调用）→ 新增批量 execute 编码（`ExecLib.encodeSimpleBatch` = CALLTYPE_BATCH\|EXECTYPE_DEFAULT 布局，`execute(bytes32,bytes)`），供 disable 批量 uninstall+invalidateNonce 复用（AgentX §2.4 实证 + 提示） | ✅ | P1 |
| AA-3 | **aa-sdk 补 isModuleInstalled 探测**：新增 ERC-7579 `isModuleInstalled(1 VALIDATOR, sessionModule, 0x)` 链上视图探测账户 session 绑定；注意勿用 storage slot 判残留（误报，见 AgentX §2.1 探测修正） | ✅ | P1 |
| AA-4 | **relay 残留自愈（enable 前检测）**：`POST /v1/session` 创建前用 isModuleInstalled 探测链上绑定；已绑定 → 响应 `isBound:true` + `needsSessionRevoke`，引导调用方先撤销再 enable（AgentX 路径 A relay 侧配合） | ✅ | P1 |

**9.10.2 P2 体验/复用（中期）**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|---|
| AA-5 | **GET /v1/session 补 createdAt + isBound**：`session-store.list()` 未返回 `created_at`；新增链上 isBound 字段，供调用方选残留 session（AgentX「给 infraX 的最小配合」） | ✅ | P2 |
| AA-6 | **B2 session 复用**：`POST /v1/session` 创建前探测链上绑定；已绑定且策略兼容（同 product、target/selector 白名单覆盖、限额 ≥ 请求、未过期）→ 复用既有 session（sessionId/sessionKey），零额外链上交易；不兼容返回 `409 session-conflict` 引导先撤销再 enable（AgentX 路径 B2；复用判断必须以链上状态为准，且需鉴权确认同一 owner） | ✅ | P2 |

**9.10.3 P3 远期（记录不排期）**

| 编号 | 任务 | 现状 | 优先级 |
|---|---|---|---|
| AA-7 | **Session Module 合约升级支持覆盖**：`enableSession`/`installModule` 幂等覆盖（C1/C2），需改合约+重部署+审计+已集成方升级 aa-sdk；建议放版本规划评估（AgentX 路径 C）。**已改为 SDK 层"两笔轮换"等价实现（不改合约）**：① root-mode 批量 `[disableSession(旧)@module + uninstallModule + invalidateNonce(cur+1)]`（owner 签）→ ② ENABLE-mode enable 新 session（owner 签 digest + agent 签 op），达到与合约升级等价的幂等覆盖效果。⚠️ **单笔 installModule 轮换不可行**（root-mode installModule 不设置 allowedSelectors → validateUserOp revert InvalidValidator → AA24，2026-08-20 链上 E2E 实证，勿改回单笔） | ✅（SDK 两笔方案） | P3→已落地 |

**AA-7 版本规划评估记录**（2026-08-19，来源 `docs/aa-relay-session-rollover-fix-infrax.md` §3 路径 C）：

- **目标（治本）**：合约层支持"轮换"语义 —— C1：`enableSession` 已有 session 时先自动 `disableSession(oldId)` 再启用（幂等覆盖）；C2：`installModule` 已安装时不再 revert，改为执行数据替换。
- **前提/代价**：改合约 + 重新部署 + 重新审计 + 版本兼容管理（已集成方同步升级 aa-sdk 指向新模块地址）。
- **覆盖授权边界（必答）**：谁有权覆盖旧 session？建议**仅同 owner、同 product 允许覆盖；跨 product 拒绝并提示先撤销**。
- **存量迁移**：已部署账户不受影响（模块升级只影响新 enable），但旧账户在旧模块逻辑下无法覆盖，重新 enable 前仍需一次显式撤销（配合 AA-1 disable 上链闭环 / AA-6 复用完成迁移）。
- **状态**：~~🔲 记录不排期~~ → **✅ 已落地（2026-08-19，SDK 方案，不改合约；2026-08-20 修订为"两笔轮换"——单笔 installModule 链上实证 AA24，见下）**。

**AA-7 实现方案（SDK 层两笔轮换，等效 C1 幂等覆盖；2026-08-20 修订）**：

- **核心**：轮换 = **两笔 UserOp**（Kernel v3.0-beta 链上实证约束，勿改回单笔）：
  - **① disable 旧 session**（root nonce，owner ECDSA 签名）：`encodeDisableSessionBatch` 批量 execute
    `[disableSession(oldId)@module, uninstallModule(VALIDATOR, module, disableData(old)), invalidateNonce(currentNonce+1)]`
    —— 直接调用 `disableSession` 删除 session 记录（部署模块 `onUninstall` 为空实现，deInitData 传 disableData 不会清记录）+ 卸载模块 + 推进 nonce。
  - **② enable 新 session**（ENABLE-mode，owner 签 digest + agent 签 op）：必须**在 ① 上链确认后**再构建（enable digest 绑定 ① 推进后的 currentNonce），走常规 `buildEnableSessionUserOp`。
- **根治点**：`disableSession` 真正删除旧 session 记录（防旧 key 复用）；`invalidateNonce` 推进 `currentNonce`，从根上消除重 enable 的 `InvalidNonce`（AA23/0x756688fe）；卸载 + 重装天然幂等覆盖。
- **⚠️ 单笔方案为何废弃**：`encodeReplaceSessionBatch`（一次 UserOp `[uninstall + invalidate + install]`）在 Kernel v3.0-beta **链上实证不可行** —— root-mode `installModule` 不调用 `ValidationManager._setSelector`，`allowedSelectors[vId][executeSelector]` 不设置 → `validateUserOp` revert `InvalidValidator` → EntryPoint 报 **AA24**（aa-session-replace-e2e.ts 两轮实测）。两笔方案下 ② 走 ENABLE-mode，`_setSelector` 正常 → selector 放行。
- **draft 构建**：① 由 `buildDisableSessionUserOp`（aa-sdk `session-revoke.ts`）—— root nonce + 三段批量 callData + gas/fee 注入后重算 `userOpHash`。
- **relay 端点（修订）**：`POST /v1/session/replace`（阶段 1：owner 派生账户 + 生成新 session 落库 + 构建 ① disable draft 返回 `disableDraft.userOpHash`）；`POST /v1/session/replace/submit`（阶段 2：owner 签名校验 + op hash 一致性校验 + 广播 ① + 移除旧 session 记录）；② enable 由调用方用 SDK 对新 policy 构建（`buildEnableSessionUserOp`）后走 `/v1/userops` 上链。
- **覆盖授权边界**：端点要求 owner 派生账户 === account（防篡改），即仅账户 owner 可轮换，天然满足"仅同 owner 允许覆盖"。
- **相比合约升级**：零合约改动、零重部署、零审计；SDK/relay 即可交付，已集成方无需升级链上模块。

**AA-1~AA-7 生产部署记录**（2026-08-19，生产机 43.163.105.172，`/home/ubuntu/infraX-1`）：

- 部署 commit：`ef8a180 → 5e91b44`（fast-forward，无冲突；含 AA-1~AA-7 全部代码；本次未改 package.json，无需 npm install）。
- 服务：`sudo systemctl restart infrax-aa-relay` → `active`；`/health` 返回 `{"status":"ok","chains":["oxachain"]}`；日志无启动错误。
- AA-5 验证：`GET /v1/session?account=0x02a6...`（真实 agentx-auto-renew 账户）→ 每个 session 项返回 `createdAt` + `isBound`。
- AA-6 验证：`POST /v1/session`（测试 product `aa-deploy-verify*`，测试 owner，测后已 DELETE 清理）→ 正常创建路径返回 `isBound:false`/`needsSessionRevoke:false` + `sessionKey`；DB 确认 `session_key_private_key` 已持久化（key_len=66，复用 `getWithKey` 可取回）。
- AA-6 已绑定→复用/409 分支需真实链上绑定状态触发，逻辑由 aa-sdk 单测（session-reuse.test.ts 18 用例）覆盖；生产未造链上绑定测试数据。
- 无生产数据污染：测试 session 已清理。

**AA-7 生产部署记录**（2026-08-19，生产机 43.163.105.172，`/home/ubuntu/infraX-1`）：

- 部署 commit：`9eebf3d → 801d45e`（fast-forward；新增 `encodeReplaceSessionBatch`/`buildReplaceSessionUserOp` + relay `/v1/session/replace` `/v1/session/replace/submit`；未改 package.json，无需 npm install）。
- 服务：`sudo systemctl restart infrax-aa-relay` → `active`；日志 `aa-relay running on port 9131`；`/health` 返回 `{"status":"ok","chains":["oxachain"]}`。
- 端点冒烟：`POST /v1/session/replace` 缺参 → 400（参数校验正常）；完整 draft 请求 → 返回新 sessionId/sessionKey/accountAddress；`isDeployed:false` 未部署账户安全降级（draft=null 不抛 500，与 AA-1 disable 同构）。
- 未部署账户 `currentNonce()` 返回 `0x` 导致 draft=null —— 预期行为：replace 只适用于已部署已绑定账户，未部署走正常 `POST /v1/session` 创建。
- 回归：`aa-relay-e2e.mjs` 8/10（2 个 FAIL 为测试 op 无 ledger 余额 → 402 余额不足，计费预期行为，非回归）。
- 单测：aa-sdk 125 用例全绿（含 AA-7 新增 4 用例：encodeReplaceSessionBatch 三段 batch 结构 + buildReplaceSessionUserOp draft）；SDK typecheck/build 通过。
- 无生产数据污染：`aa-replace-verify*` 测试 session 已 DELETE 清理。

**AA-7 修订为"两笔轮换"（2026-08-20，链上 E2E 实证单笔方案不可行）**：

- **背景**：单笔轮换 batch（`[uninstall + invalidateNonce + install]` 一次 UserOp）在 Kernel v3.0-beta **链上实测两次失败** —— root-mode `installModule` 不设置 `allowedSelectors` → `validateUserOp` revert `InvalidValidator` → EntryPoint **AA24 signature error**。此外链上实证部署的 session module `onUninstall` 为**空实现**（字节码 POP POP JUMP→STOP），`uninstallModule` 的 deInitData 传 disableData **不会删除 session 记录** → 仅卸载+重装后旧 session key 仍可验证。
- **代码改造（工作区未提交，待 commit）**：
  - aa-sdk `session-module.ts`：`encodeDisableSessionBatch` 改为**三段批量** `[disableSession(oldId)@module, uninstallModule(VALIDATOR,module,disableData), invalidateNonce(cur+1)]`（①a 直接删 session 记录，根治旧 key 复用）；新增 `encodeValidatorInstallData(hook, validatorData, hookData)`（Kernel v3.0-beta installModule initData 格式：`abi.encode(hook, validatorData, hookData)`，hook=address(1)）。
  - aa-sdk `session-revoke.ts`：`buildDisableSessionUserOp` 走三段批量；**删除** `buildReplaceSessionUserOp`/`encodeReplaceSessionBatch`（单笔方案废弃）。
  - aa-relay `src/index.ts`：`POST /v1/session/replace` 返回 `disableDraft`（阶段 1/2：disable 旧）；`/v1/session/replace/submit` 广播 ①；② enable 新 session 由调用方用 SDK `buildEnableSessionUserOp` 走 `/v1/userops`。
  - `scripts/aa-session-replace-e2e.ts`：轮换流程改为 ① 三段批量 disable 旧 + ② ENABLE-mode enable 新 + agent B 成功 / agent A 被拒。
- **验证**：`aa-session-replace-e2e.ts` 链上 E2E **12/12 全绿**（OxaChain，deployer=`0xF434e5254C4a4DD314F1e80087FBC54533065c8B` alto executor，块 `0x1dexx` 段）：注资/激活/deposit → enable A → 复现 AA23（重复 enable 被拒）→ ① 三段批量 disable A 上链成功+模块卸载 → ② enable B 上链成功+模块重装 → **agent B 调用成功 / agent A 调用被拒（AA24，旧 session 已彻底撤销）**。
- **单测**：aa-sdk **122 用例全绿**（session-revoke.test.ts 13 用例适配三段 batch：disableSession@module + uninstall + invalidateNonce）；SDK typecheck + relay typecheck 通过。
- **上线状态**：已上线 ✅ —— commit `579d360` 推送 origin/master 并部署生产机 43.163.105.172（`git pull` fast-forward + `systemctl restart infrax-aa-relay` active，`aa-relay running on port 9131`）；`/health` 返回 `{"status":"ok","service":"aa-relay","chains":["oxachain"],"bundlers":{...}}`；replace 端点冒烟通过：缺参 → 400、完整 draft → 200（`disableDraft` 字段，未部署账户安全降级 null）、测试 session 已清理（GET 复核 0 行，无生产数据污染）。
- **session-key 内嵌副本对齐（2026-08-20，commit `739d53e`）**：session-key 内嵌 aa-sdk 副本（`packages/core/src/aa/`）存在与 AA-1/AA-2/AA-7 同源缺陷 → 已对齐：`encodeExecuteBatch`、`encodeValidatorInstallData`（修复 `encodeEnableSessionCall` initData 直传的 AA24 隐患）、`encodeDisableSessionBatch` 三段批量（`encodeDisableSessionCall` 保留兼容并标注遗留缺陷）；新增 `__tests__/session-align.test.ts` 6 用例。单测 core 6/6 + server 26/26 + 全包 tsc 构建通过；已部署生产 43.163.105.172（pull + core dist `npx tsc` 重建 + restart `infrax-session-key` active，`/api/v1/health` OK；MCP `infrax-session-key-mcp` active 未改动无需重启）。

**代码审查修复（2026-08-20，commit `1228c41` + `a887175`，5 项全部完成）**：

| # | 审查发现 | 修复 | 验证 |
|---|---------|------|------|
| Fix1 | `/v1/session/disable` 返回遗留 `disableCallData` 字段（单调用编码，与三段批量 draft 并存易误用） | relay 移除该字段；aa-sdk 删除 `encodeDisableSessionCall` 及 `DisableSessionCallParams`，撤销统一走 `encodeDisableSessionBatch` | session.test.ts 删对应用例；relay typecheck ✅ |
| Fix2 | revoke/replace/submit 三端点重复"签名校验+计费+广播+结算"逻辑 | 抽取 `submitSignedOp` 公共 helper（helpers.ts），支持 `onSuccess` 回调（replace 移除旧 session） | relay typecheck ✅ |
| Fix3 | aa-relay `index.ts` 单文件 869 行 | 拆分为 `src/index.ts`（引导）+ `routes/session.ts`（session 域 6 路由）+ `routes/relay.ts`（4 转发路由）+ `helpers.ts`（共享工具） | 生产 9131 端口路由冒烟：/v1/session、/replace、/revoke 均 401（挂载成功非 404）✅ |
| Fix4 | session-key `packages/core/src/aa/` 内嵌 20 个 aa-sdk 手工副本，双代码库漂移（739d53e 对齐后仍有复发风险） | 删除全部 20 个副本文件；`aa/index.ts` 改为 `export * from '@0xinfrax/aa-sdk'`（file: 依赖，单一事实源）；补齐 aa-sdk 缺口（recovery.ts 接口占位、utils/eth-address.ts、RecoveryConfig、ChainId） | aa-sdk 121/121；session-key build 4 包 + core 4/4 + server 26/26；生产重建 core dist + 重启 infrax-session-key ✅ |
| Fix5 | 'evm' 硬编码 9 处（index.ts 及 session/relay 路由） | 全部改用 `cfg.network` | 生产 `/health` 返回 `chains:["oxachain"]` ✅ |

- **生产部署记录**（2026-08-20，生产机 43.163.105.172，`/home/ubuntu/infraX-1`）：
  - 部署 commit：`e159ba6 → a887175`（fast-forward，含上述 2 个 commit）。
  - 构建：生产机 aa-sdk `npx tsc` 重建 dist（新增 recovery/eth-address 导出）；core 建 `node_modules/@0xinfrax/aa-sdk` 符号链接 → `packages/core` `npx tsc` 重建 dist。
  - 服务：`sudo systemctl restart infrax-session-key` + `infrax-aa-relay` → 均 `active`（MCP 未改动无需重启）。
  - 验证：`curl 127.0.0.1:9131/health` → `{"status":"ok","service":"aa-relay","chains":["oxachain"]}`；session-key `/health` 401（缺 token 正常）；两服务日志无 `MODULE_NOT_FOUND`/aa-sdk 解析错误。

**@0xinfrax/aa-sdk 0.1.2 发布（2026-08-20，bump 0.1.1 → 0.1.2）**：

- **背景**：npm 发布版 0.1.0/0.1.1 的 dist 为旧单文件 `session.js`（无独立 session-revoke/session-module 产物），外部 npm 消费方拿不到三段批量 disable 等新能力。
- **核对结论**：源码 barrel 早已导出所需符号 —— [src/session.ts](`projects/aa-sdk/src/session.ts`) 为聚合桥（re-export session-store/module/enable/revoke/reuse/validate），`index.ts` 再 re-export `session.js`；`buildDisableSessionUserOp` / `encodeDisableSessionBatch` / `KernelV3SessionDataBuilder` / `MODULE_TYPE_VALIDATOR` / `encodeValidatorInstallData` / `buildEnableSessionUserOp` / `isSessionModuleInstalled` / `verifyDisableSignature` 均可达。真正过期的是 **npm 发布版 dist**，非 barrel。
- **`encodeDisableSessionCall` 不恢复**：已在上轮审查（Fix1）中删除（单调用只做 uninstallModule，链上实证不删 session 记录，旧 key 可复用 = AA23/AA24 根因）。消费方应改用三段批量 `encodeDisableSessionBatch`。
- **动作**：`package.json` version → `0.1.2`；`npm run build`（tsc 全量）；`npm publish` 成功（`@0xinfrax/aa-sdk@0.1.2`，`stevenwang000x`）。
- **发布产物验证**：`npm pack` 解包确认含 `session-module.js`/`session-revoke.js`（含 `.d.ts`）；运行时 import `dist/index.js` 验证 8 项新导出全部 OK（`encodeDisableSessionCall` MISSING 为预期）。
- **消费方**：**aa-sdk 是对外公开发布的 npm 包**（`--access public`），PocketX 及所有产品"只基于 SDK 构建"（`docs/AA_SDK_TECH_DESIGN.md` §1.3 三层架构）；内部 aa-relay 走相对路径直引源码、session-key core 走 `file:` 链接（二者为服务端内部消费，不走 npm 包）。外部集成方接入 session 有两条通道：**HTTP 服务接口**（agentx/aitrader 等经 aa-relay `/v1/session/*`、session-key `/api/v1/sessions`、MCP）或 **npm SDK 直用**（PocketX 等 `npm i @0xinfrax/aa-sdk` 后 import `buildEnableSessionUserOp`/`buildDisableSessionUserOp` 自行构建 UserOp，配合 relay `/v1/userops` 上链）。0.1.2 发布正是为外部 SDK 消费方补齐三段批量 disable 能力。

### 9.11 AItrader 多语言数据层修复（源：`projects/data/AITRADER_I18N_DATA_REQ.md`，2026-08-20，用户裁定"全部含 P3"）

**背景**：AItrader 全站国际化已完成（vue-i18n 10 语言），残留问题集中在数据层——B 端返回字段值为单一语言，前端无法自行翻译。按 GitHub 需求 R-I1~R-I4 逐项修复。

| 编号 | 需求 | 现状 | 优先级 |
|---|---|---|---|
| R-I1 | **图谱实体补 name_en（双语渲染）**：`name_en_of()` 纯 ASCII/数字实体（BTC/SPY/OKX DEX）兜底返回自身（此前 48.6% 覆盖率 → 现 90.6%）；中文实体继续走 439 条映射表 + 值后缀回查，未命中 null | ✅ | P1 |
| R-I2 | **news 接口 lang 参数过滤**：`/snapshots?type=news&lang=` 按 `items[].lang` 过滤；请求语言无数据降级英文并如实标注 `lang` 字段；moomoo 无 lang 条目按英文兜底；`main.py` 透传 `lang` | ✅ | P1 |
| R-I3 | **symbol 元数据补 name_zh**：`/symbols/search` 含中文名的标的（cn/hk AkShare 种子）输出 `name_zh`，英文名标的缺失（前端 fallback）；crypto 不输出空字段保持契约兼容 | ✅ | P3 |
| R-I4 | **opportunities reason 结构化**：四个 analyzer（crypto/stocks/local_stocks/forex）输出 `reason_key`（= signal，前端 i18n key `reason.{market}.{signal}`）+ `params`（change_24h/change_7d/name），`reason` 保留中文兼容 | ✅ | P1 |

**代码（commit `b5aa4f2`）**：

- `projects/ragservicer/api/graph_engine.py`：新增 `_CJK_RE`，`name_en_of()` 无 CJK 兜底返回自身。
- `projects/data/app/factors.py`：`get_snapshots()` 增加 `lang` 参数 + `_NEWS_TYPES = {"news", "news_moomoo"}` 过滤（含英文降级）。
- `projects/data/main.py`：`/snapshots` 增加 `lang` Query 透传。
- `projects/data/app/symbol_search.py`：新增 `_CJK_RE`；crypto/在线/种子分支条件输出 `name_zh`。
- `projects/data/app/collectors/opportunities.py`：四个 analyzer 输出 `reason_key` + `params`。

**本地验证**：py_compile 全通过；symbol_search 测试 9/9；opportunities 19 场景（reason_key==signal、params 非空、consolidation 含 name）；R-I1 name_en_of 单测（纯 ASCII 兜底/map 命中/含 CJK 未命中 None）；R-I2 lang 过滤 monkeypatch 单测（zh 保留 zh、en 保留 en+无 lang、zh 无数据降级 en、无 lang 不过滤）。

**生产部署（2026-08-20）**：

- **主生产机 43.163.105.172**：`git pull`（c915098 → b5aa4f2，fast-forward）→ `systemctl restart infrax-data` active，`/health` `{code:0, message:ok}`。
- **ragservicer 新机 43.156.78.59**（文件拷贝部署无 git）：scp 同步 `graph_engine.py`（MD5 对齐确认 `_CJK_RE` 落盘）→ `systemctl restart infrax-ragservicer` active。

**生产回归验证**：

- R-I2：`lang=en` → 74 条全英文；`lang=zh` → 降级英文 74 条（当前 news 数据仅英文，`lang` 字段如实标注 en）。
- R-I3：cnstock `keyword=贵州` → `600519 贵州茅台 name_zh=贵州茅台`；usstock `keyword=apple` → AAPL 等 `name_zh` 缺失（fallback）。
- R-I4：`/snapshots?type=opportunities` 50 条全部带 `reason_key` + `params`（如 `bullish_momentum {change_24h: 9.48}`、`overbought {change_24h: 17.64, change_7d: 0.0}`）。
- R-I1：`/factors/graph/entities?namespace=market&limit=500` → **name_en 非空率 90.6%**（453/500，此前 48.6%；剩余缺失为纯中文事件/描述实体，需存量翻译回填脚本+LLM 补齐，见遗留）。

**遗留**：① R-I1 验收标准 ≥95%，剩余缺失实体（「50篇文章」「方向分布」等）需批量 LLM 翻译回填 `name_en` 映射表；② R-I2 需 news collector 按 lang 分 bucket 稳定供给（当前 NewsAPI 仅英文站数据）；③ I6 market 枚举规范化（非阻塞，前端已兜底）。

### 9.12 RAGSERVICER 迁移后租户分片模型（R-TN，源：AIServicer B 端客户反馈，2026-08-20）

**背景**：客户（AIServicer，B 端多租户平台）迁移到新机 `43.156.78.59:9721` 后实测 `X-Tenant-ID` 未生效（查询响应 tenant 恒为 "admin"），且租户/Key 管理端点 403。

**根因定位**（代码 + 生产实测）：

- 生产机 `ADMIN_API_KEY` 是**模板占位符** `YOUR_ADMIN_KEY`（.env len=14，systemd/进程环境无覆盖）——客户使用的 key 恰好等于占位符，命中 [auth.py](file:///home/steven/infraX/projects/ragservicer/api/auth.py) admin 分支直接返回 "admin"（该分支不读 X-Tenant-ID）。审计日志佐证：客户测试时段（14:14-14:16）20+ 条请求 tenant 全部 admin。
- 管理端点 `require_admin` 只认 `Authorization: Bearer <ADMIN_API_KEY>`（不认 X-API-Key），且 admin key 是占位符 → 403 Admin access required。
- **服务端 X-Tenant-ID 本身正常**（实测带 header 即生效）；但存在安全缺陷：X-Tenant-ID 覆盖不做授权校验，**任意有效 key 可越权访问任意租户**。

**方案**（用户裁定：完整方案 = 配置 admin key + X-Tenant-ID 权限边界）：

1. **tenant_scope 授权模型**（[manager.py](file:///home/steven/infraX/projects/ragservicer/tenants/manager.py#L218-L255)）：
   - `api_keys.tenant_scope` 幂等迁移（PRAGMA 检查兼容 SQLite <3.35）：`''` 仅绑定租户 / `'*'` 任意**已存在**租户 / `'t1,t2'` 允许列表。
   - `is_tenant_allowed()`：目标租户必须存在（租户由 Admin API 创建，不隐式自动创建）+ 在 key 授权范围。
2. **auth 授权边界**（[auth.py](file:///home/steven/infraX/projects/ragservicer/api/auth.py#L20-L25)）：`TenantForbiddenError` → `require_tenant`/`require_service` 返回 `403 TENANT_FORBIDDEN`；`register_tenant_on_g` 越权记录为 `unauthorized` 审计。
3. **管理端点**（[admin.py](file:///home/steven/infraX/projects/ragservicer/api/routes/admin.py#L179-L190)）：新增 `POST /api/v1/keys/{key_id}/scope`（Admin Key）。
4. **文档**：[API.md](file:///home/steven/infraX/projects/ragservicer/docs/API.md) 1.4.1 租户模型与鉴权表 + 7.4 scope 端点。

**本地验证**：py_compile 通过；`is_tenant_allowed` 12/12（绑定租户放行/无 scope 拒绝/'*' 已存在 OK/不存在拒绝/列表匹配/空 target 放行）；extract_tenant+require_tenant 集成 6/6（key 归属 / 绑定 key 越权 403 / 共享 key 分片 200 / 不存在租户 403 / 非法 key 401 / 无 key 401）。

**生产部署（新机 43.156.78.59，commit `dec66bc`）**：

- scp 同步 `auth.py`/`code_refactor.py`/`admin.py`/`manager.py`/`API.md`（文件拷贝部署无 git）。
- `ADMIN_API_KEY` 占位符替换为真实值 `rag_admin_<hex48>`（.env 先备份），`systemctl restart infrax-ragservicer` active，health 200。
- aiservicer prod key（`key_5cf5dd333e35`）设置 `scope='*'`（客户共享 key）；创建客户租户 `mmt1lc9qj8zm0`。

**生产回归验证**：

| 场景 | 结果 |
|---|---|
| admin `GET /api/v1/tenants`（Bearer admin key） | 200 ✅ |
| `POST /tenants` 创建 + `POST /keys/{id}/scope` 设置 | 201/200 ✅ |
| 共享 key + `X-Tenant-ID: mmt1lc9qj8zm0` query | **200 tenant=mmt1lc9qj8zm0** ✅ |
| 共享 key + `X-Tenant-ID: nope-tenant`（不存在） | **403 TENANT_FORBIDDEN** ✅ |
| 共享 key 无 X-Tenant-ID | 200 tenant=aiservicer（key 归属）✅ |
| 绑定 key + `X-Tenant-ID: aitrader`（越权） | **403 TENANT_FORBIDDEN** ✅ |

**遗留/待办**：① admin key 明文需安全交付客户（平台侧租户/Key 自助管理，`Authorization: Bearer` 方式）；② 客户正式共享 key 需确认：使用现有 aiservicer prod key（`lr_9ccd9547c...`）或新签发一把 `scope='*'` 共享 key 交付；③ 客户每新 Bot 上线需调 `POST /api/v1/tenants` 预创建租户（不会隐式自动创建）。

### 9.13 DEX 策略数据需求（源：`docs/requirements-infrax-dex-data.md`，AIHunter SaaS 产品方提交，2026-08-21）

**背景**：AIHunter 定位 DEX-only（hyperliquid 唯一实盘通道），现有 infrax 数据为 CEX 视角，不覆盖链上微观结构（流动性/滑点/社交热度/资金流/风险）。交付经 gateway 透传 `/api/dex/*` 供前端与 python-backend 消费。

**架构裁定（评审结论）**：数据层与交易层解耦——**数据层**（热门榜/池子/流动性）用 **DexScreener**（免费免 key、单源聚合 4 链全部主流 DEX，实测 GeckoTerminal 429 / Uniswap 409 / PancakeSwap 502 / Raydium 500 均不可用）；**交易层**（quote/swap/approve/broadcast）保留 **OKX OnchainOS aggregator**（生产已验证 [dex-dispatcher.ts](../backend/services/dex-dispatcher.ts)）。落地流程：DexScreener 找币/看池 → OKX aggregator 下单执行 → hyperliquid 永续对冲。

**字段约定**：金额一律 USD（缺失用 null 不用 0）；`24h` 为滚动 24h；链枚举 `ETH/BSC/BASE/SOL`（DexScreener 原始值 eth/bsc/base/solana 需映射）；地址 EVM 小写 hex / SOL base58；驼峰命名透传。

| # | 需求 | 优先级 | 候选数据源 | 状态 |
|---|---|---|---|---|
| R1 | 热门代币列表（Trending + X 提及双排行，补齐 11 字段） | **P0** | OKX OnchainOS `token/hot-tokens`（ranking-type=4/5） | ✅ 已完成 |
| R1b | 主流 DEX 原生热门榜（按链真实成交量/TVL，DexScreener 单源聚合） | **P0** | DexScreener `/latest/dex/search` + `token-profiles` + `token-boosts` | ✅ 已完成 |
| R2 | 单币行情与基本面（价格/量/市值/流动性/多时间窗涨跌/ath/atl/holders） | **P0** | OKX `price-info` / DexScreener `token/{chain}/{addr}` | ✅ 已完成 |
| R3 | 社交热度（逐币 X 提及 + 环比变化 + trendingScore） | **P0** | OKX hot-tokens / LunarCrush（备选） | 🟡 部分（上游免费层无该字段，透传 null） |
| R4 | 安全与风险评分（riskLevel/蜜罐/rug%/新地址占比/owner/dev/锁仓） | **P0** | OKX security / `advanced-info` / `cluster-overview` | ✅ 已完成（字段透传，上游缺省 null） |
| R5 | 巨鲸动向/聪明钱（smart money 净流入/大额转账/KOL 持仓） | P1 | OKX Signal API（用户重点） | ✅ 已完成 |
| R6 | 持有者结构（Top100/top10 占比/HHI/聚类） | P1 | OKX `holders` / `cluster-overview` | ✅ 已完成 |
| R7 | 流动性池/深度（Top5 池/深度/TVL） | P1 | OKX `liquidity` / DexScreener pairs | ✅ 已完成（OKX top-liquidity 402 付费 → DexScreener 池降级） |
| R8 | 顶级交易者/交易历史（pnl/胜率/近期交易） | P1 | OKX `top-trader` / `trades` | ✅ 已完成（top-trader 免费；trades 402 付费 → paymentRequired 降级） |
| R9 | hyperliquid 永续（funding/OI/深度） | P1 | hyperliquid `/info`（python-backend 已直连，**infrax 不实现**，仅透传语义） | 跳过 |
| R10 | 池龄/新币生命周期（首个池创建/上线天数） | P2 | DexScreener `createdAt` / OKX advanced-info | ✅ 已完成（poolCreatedAt 最早池龄透传） |

**生产实测契约修正（2026-08-21 部署验证，commit 366c6b1/8a1a4eb/4d5bfda）**：
- OKX `token/toplist` **生产仅支持 sortBy∈{2 change,5 volume,6 mcap}**（11 mentions/15 tokenScore 均 400），且返回字段**不含 mentions/tokenScore** → R1 双榜降级：trending=sortBy5 volume、x_mentions=同源按 txs 交易笔数客户端排序（`getHotTokensRanked`）
- OKX `token/search` 与 `trades`、`top-liquidity` 为 **x402 付费端点**（402 Payment Required）→ 路由层降级：`{items:[], paymentRequired:true}`（search 用 DexScreener 兜底）
- DexScreener `/latest/dex/tokens/{chain}/{addr}` 端点已废弃（404）→ `getTokensDetail` 改用 `/latest/dex/search?q={address}` 按链过滤聚合
- OKX `top-trader`/`top-liquidity` 参数名为 `tokenContractAddress`（原 tokenAddress 报 400 missing）
- DexScreener `token-profiles/boosts` 仅覆盖新币/推广（ETH 主流链榜为空）→ 主流链以 OKX 榜为主，DexScreener 榜兜底新币链（SOL/BASE 实测有数据）

**热门代币画像自动快照（2026-08-21 追加，commit 29aa586）**：
- 新增 `okx_market_token_profiles` 表 + scheduler `snapshotTokenProfiles`（默认 5min/链 top 10，`OKX_MARKET_PROFILE_INTERVAL_MS` 可配）：
  top list（volume24h）合并 price-info 批量（免费）→ 落库多时间窗（5M/1H/4H/24H 变化率）+ price/marketCap/liquidity/circSupply/maxPrice(ATH)/minPrice(ATL)/holderCount
- 新增 `GET /api/v2/data/market/dex/token/history?chain&address&hours` → 画像时间序列（价格历史，5min 粒度）
- 与既有 60s 价格快照（`okx_market_hot_tokens`/`okx_market_index_prices`）+ 5min K 线（`okx_market_candles`）共同构成完整历史价格层
- **公网 nginx 规则（2026-08-21 修复）**：`location /api/v2/data/market/dex/ → web :9111`（位于 `/api/v2/data/ → dc :9102` 之前，nginx 最长前缀优先），否则 SDK 直连路径 `/api/v2/data/market/dex/*` 被 nginx 吞到 DC 返回 404；SDK 方法（`infrax.market.dex*`）与 `/api/dex/*` 两条公网路径均已端到端验证通过（collector 测试 8/8 + SDK 实测 OKX 100 币榜/SOL 新币榜/search/token 画像）
- **dx_ key 鉴权接入（2026-08-21 修复，commit `d016fe1`）**：collector `/api/v2/data` 的 apiKeyAuth 原本只查本地 postgres `api_keys` 表（仅 pkx_），外部 dx_ key 一律 401。修复：本地表未命中且前缀为外部家族（dx_/mx_/ar_/cr_/wa_/px_/vx_/mp_）时，实时调 data `/api-keys/verify`（`DX_API_KEY_VERIFY_URL`/`DX_API_KEY_VERIFY_KEY`=DATA_API_KEY，E-1c 同款 fail-closed 5s）；`marketQuotaEnforce` 对 external key 放行（RPM 由 data 侧限流）。生产已验证：新签 dx_ key 访问 DEX 端点内网 :9101 与公网网关均 200（存量 dx_ key 无需重签，实时校验即用）

**首批交付（P0：R1-R4，含 R1b）**：热门榜单（OKX 热度 + DexScreener 原生榜）+ 单币行情 + 社交热度 + 安全风险——直接支撑当前用户可选交易对面板与 DEX 策略风控。

**实施排期**：
- T-1（P0）：DexScreener 数据接入（search/pairs/token-profiles/token-boosts），热门代币统一端点（`source: okx | dexscreener` 双来源），单币行情 + 社交热度 + 风险画像聚合 ✅ 已完成
- T-2（P0）：OKX hot-tokens 双榜扩展（补 xMentions/trendingScore 全字段），与 DexScreener 榜合并 ✅ 已完成（按生产契约降级，见上方"契约修正"）
- T-3（P1）：OKX Signal API（巨鲸/聪明钱）+ holders + liquidity + top-trader ✅ 已完成（trades/top-liquidity 为付费端点已降级）
- T-4（P2）：池龄/新币生命周期 + MEV 风险（EigenPhi 专项源）🟡 池龄已完成（poolCreatedAt），MEV 专项源待排期
- 交付形态：gateway `/api/dex/*`（web/server.js 已配置代理 `{host: COLLECTOR_HOST, port: COLLECTOR_PORT, strip: '/api/dex', prefix: '/api/v2/data/market/dex'}`）✅ 已部署

**验收依赖**：① DexScreener 免费层配额（60 req/min 需评估高频榜单缓存策略）；② OKX OnchainOS 各端点实测可用性（price-info/holders/trades/top-trader/security/signal 需逐一验证）；③ 交付后前端交易对面板切换双榜单来源联调。

