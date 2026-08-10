# knowledge-injector 服务（知识注入器）使用指南（:9113）

> 最后更新：2026-08-11 | 生产状态：🟢 已验证可用（2026-08-11 生产实测）

## 1. 服务定位

**knowledge-injector**（`infrax-knowledge-injector` v1.0.0）是 InfraX 数据栈的**知识注入器**：按固定周期拉取 data-service 快照与外部数据源 → 语义去噪 → 生成结构化文本 → 注入 ragservicer（:9721）构建知识图谱。内置 **19 类注入器**，每类独立 try/except、fail-silent（一个数据源挂掉不影响其他）。

数据链路：`data-service（:9112 快照/因子/预测）` + `外部数据源（FRED/Finnhub/等）` → **injector 文本化** → `ragservicer /api/v1/namespaces/{ns}/documents` → LightRAG 知识图谱 → B 端经 ragservicer `/query` 检索。

**注入器清单（19 类）**：macro（VIX/DXY/US10Y）、sentiment（恐惧贪婪）、crypto_overview（币市概览）、volatility（VXN/GVZ/Put-Call）、news_sentiment（新闻情感）、major_events（重大事件）、onchain（BTC 链上）、defi_tvl（DeFi TVL）、macro_trend（宏观趋势）、fred_economics（FRED 经济指标）、earnings_index（巨头财报）、evm（ETH 供应/燃烧/质押）、global_macro（多区域宏观）、indices（全球股指）、tech_analysis（技术指标分析）、tree_ml（LightGBM 方向预测）、consensus（跨模型共识）、p2_predictions（P2 单模型预测历史）、ml_predictions（Kronos 波动率预测）。

**生产实测（2026-08-11）**：`GET /health` → 200（`injector_count: 19`、`lightrag_enabled: true`）。

**网络拓扑**：服务绑定 `127.0.0.1:9113`，仅本机直连；**无独立公网入口**（内部服务，不经 nginx 对外暴露）。

## 2. 鉴权方式

统一鉴权契约（`projects/shared/app_auth.py`），key 携带 `Authorization: Bearer` / `X-API-Key` / `X-Service-Key` 三选一：

- **业务 key**：`INJECTOR_API_KEY`，未配置时**回退 `RAGSERVICER_API_KEY`**（与 ragservicer bridge key 一致）；均未配置则开放（向后兼容）。
- **只读监控 key**：`MONITOR_API_KEY` 仅允许 GET/HEAD/OPTIONS。
- **豁免（免 key）**：`/health` `/metrics` `/openapi.json`。
- **管理端点**：`/admin/*` 前缀走独立 `ADMIN_API_KEY`（`Authorization: Bearer <ADMIN_API_KEY>`）。
- **统一 401 响应体**：`{"detail": "unauthorized"}`（app_auth 契约）。

## 3. 端点清单

### 3.1 业务端点（INJECTOR_API_KEY（回退 RAGSERVICER_API_KEY）/ monitor key（只读））

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 豁免 | 健康检查：`{"code":0,"message":"ok","data":{"service":"infrax-knowledge-injector","lightrag_enabled":true,"uptime":"...","injector_count":19,"version":"1.0.0"}}` |
| GET | `/metrics` | 豁免 | Prometheus 指标 |
| GET | `/openapi.json` | 豁免 | OpenAPI 文档 |
| POST | `/inject/{source}` | ✓ | 手动触发单类注入（source 见上文 19 类清单）。返回 `{"success": bool, "duration_ms": ...}` |
| POST | `/inject/all` | ✓ | 触发全量注入。返回 `{注入器名: success}` 字典 |
| POST | `/inject/parsed` | ✓ | 按 YAML 规则解析注入。body `{"source": "infrax_dc"\|"infrax_collector", "limit": 100, "dry_run": false}` |
| POST | `/query` | ✓ | 查询知识图谱（转发 ragservicer）。body `{"query": "...", "top_k": 5, "namespace": "market"}` |
| GET | `/status` | ✓ | 注入器状态：lightrag_enabled / injectors 列表 / 去噪配置与拦截统计（denoise） |
| GET | `/injectors` | ✓ | 注入器清单 + 数量 |
| GET | `/stats` | ✓ | 注入统计汇总 |
| GET | `/stats/recent` | ✓ | 最近注入记录（`limit` 默认 20，上限 100） |

### 3.2 管理端点（Bearer `ADMIN_API_KEY`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/config` | 数据源 key 配置快照（掩码展示）：FRED_API_KEY / ETHERSCAN_API_KEY / FINNHUB_API_KEY / TUSHARE_API_KEY / NEWSAPI_KEY |
| PUT | `/admin/config` | 行级原子写 .env 热更新 key（`{"keys": {...}}`），更新后重置 key 轮询池 |

> 注意：注入器**无** `/api/v1/admin/status` 端点；运行状态看 `/status` + `/stats`。文档注入是注入器**直接调用 ragservicer 的 HTTP 接口**（`injector/client.py`：POST `/api/v1/namespaces/{ns}/documents`，`async: true`，提交后轮询 `/tasks/{task_id}` 至 success），不在本服务暴露转发端点。

## 4. 样例代码

> key 为占位符。BASE_URL 仅 `http://127.0.0.1:9113`（本机）。

### 4.1 curl

```bash
BASE=http://127.0.0.1:9113
KEY=<INJECTOR_API_KEY>        # 未配置时回退 RAGSERVICER_API_KEY
ADMIN_KEY=<ADMIN_API_KEY>

# ── 健康检查（免鉴权，生产实测 200）──
curl -s $BASE/health
# {"code":0,"message":"ok","data":{"service":"infrax-knowledge-injector","lightrag_enabled":true,"uptime":"120h 30m","injector_count":19,"version":"1.0.0"}}

# ── 运行状态（注入器 + 去噪统计）──
curl -s $BASE/status -H "X-API-Key: $KEY"
# {"lightrag_enabled":true,"injectors":["macro","sentiment",...],"denoise":{"enabled":true,"similarity_threshold":0.86,"stats":{...}}}

# ── 注入统计 ──
curl -s $BASE/stats -H "Authorization: Bearer $KEY"

# ── 手动触发单类注入（如宏观注入）──
curl -s -X POST "$BASE/inject/macro" -H "X-API-Key: $KEY"
# {"success":true,"duration_ms":1234.5}

# ── 触发全量注入（生产不建议手动，worker 每 6h 自动执行）──
curl -s -X POST "$BASE/inject/all" -H "X-API-Key: $KEY"

# ── Admin：数据源 key 配置查询（Bearer ADMIN_API_KEY）──
curl -s $BASE/admin/config -H "Authorization: Bearer $ADMIN_KEY"
# {"code":0,"message":"ok","data":{"keys":{"FRED_API_KEY":{"set":true,"key_count":1,"keys":["AB12********90ab"]},...},"env_file":".../.env","hot_reload":true}}

# ── 查询知识图谱（转发 ragservicer）──
curl -s -X POST "$BASE/query" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"query": "比特币近期走势", "top_k": 5, "namespace": "market"}'
```

### 4.2 自动注入机制（重点）

无需任何 API 调用，服务启动即自动运行（`injector/worker.py` → `start_worker_thread`）：

```
启动 → 等待 INJECTOR_STARTUP_DELAY(默认 120s) → 循环：
        inject_all() 全量注入（21 个方法，19 类对外）→ 休眠 INJECTOR_INTERVAL_SEC
```

| 配置项（.env） | 默认 | 说明 |
|---|---|---|
| `RAGSERVICER_URL` | http://127.0.0.1:9721 | ragservicer 地址（systemd 单元已注入） |
| `RAGSERVICER_API_KEY` | 空 | 与 ragservicer 的 bridge key 一致（必配，否则注入 403） |
| `DEFAULT_NAMESPACE` | market | 默认注入 namespace（链上类注入 `onchain`） |
| `INJECTOR_INTERVAL_SEC` | 21600 | 注入间隔（6 小时） |
| `INJECTOR_STARTUP_DELAY` | 120 | 启动延迟（秒） |
| `DENOISE_ENABLED` / `DENOISE_SIMILARITY_THRESHOLD` | true / 0.86 | 注入前语义去噪（黑名单 + 相似去重） |
| `DC_URL` / `COLLECTOR_URL` | 空 | raw 数据注入源（未配置时跳过） |

注入特征：
- **doc_id 幂等**：`file_source:UTC时间戳`（如 `macro:daily:20260811T1200`），同 id 重复注入 ragservicer 返回 409 视为成功。
- **fail-silent**：每个注入器独立 try/except，数据源无 key / 无快照 / 网络失败均返回 False 不中断循环。
- **去噪拦截**：被拦截内容仍存档原始数据（可审计）但不注入 LightRAG，拦截统计见 `/status`。

### 4.3 常见错误码

| 状态码 | 含义 | 排查建议 |
|---|---|---|
| 401 | 未携带 key / key 不匹配（`{"detail":"unauthorized"}`） | 检查 `INJECTOR_API_KEY` 或回退 `RAGSERVICER_API_KEY` |
| 400 | 参数错误（/inject 未知 source、/query 缺 query、/inject/parsed source 非法） | 核对 body / 路径 |
| 404 | 路由不存在（统一 `{"code":404,"message":"Not Found"}`） | 检查路径拼写 |
| 500 | 内部错误 | 查看 injector 日志 |

## 参考

- 源码：`projects/knowledge-injector/api/routes.py`、`injector/worker.py`（19 类注入器）、`injector/client.py`（ragservicer HTTP 客户端）、`config.py`（§4.2 配置）
- 统一鉴权契约：`projects/shared/app_auth.py`
- 生产配置：`docs/infrax_tasklist.md` §4.2（`INJECTOR_INTERVAL_SEC=21600` 等）、§2（注入器桥接 key 一致性）
