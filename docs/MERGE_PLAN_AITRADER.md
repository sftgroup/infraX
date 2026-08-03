# AItrader 数据微服务合并进 InfraX 方案（v3 详细版）

> 状态：**待评审** ｜ 日期：2026-08-04 ｜ 依据：aitrader `TARGET_PROJECT_HANDOVER.md`（2026-08-04 新版，commit `a4767f9`）
> 本版新增：可配置解析层设计（§4）、DC raw data 注入方案（§7）、文件级迁移清单、验收清单

---

## 1. 背景与目标

### 1.1 背景

AItrader 新版交接文档将交付范围收敛为 **3 个微服务目录**（analysis/backtest/trading 留在 AItrader 侧通过 HTTP 调用）：

| AItrader 目录 | 端口 | 技术栈 | 职责 |
|---------------|:---:|--------|------|
| `data-service` | 8765 | FastAPI + ccxt + SQLite | 行情/K线/因子/日历/热力图 |
| `knowledge-injector` | 3611 | Flask + waitress | 定时注入 LightRAG 知识图谱 |
| `lightrag-service` | 3610 | lightrag-hku 官方镜像 | LightRAG 本体 |

InfraX 现状：已有 **Collector**（:9101 数据获取）、**DC**（:9102 链上数据）、**RAGservicer**（:9721 LightRAG 微服务）。

### 1.2 已确认决策

| 编号 | 决策 | 状态 |
|------|------|------|
| D1 | data-service 迁入命名为 `data`（`projects/data`，服务名 `infrax-data`） | ✅ 已确认 |
| D3 | 端口：data :9112、knowledge-injector :9113 | ✅ 已确认 |
| D5 | DC/Collector 注入采用**扩展 knowledge-injector** 方式 | ✅ 已确认 |

### 1.3 目标

1. data-service、knowledge-injector 迁入 InfraX 统一管理，减少双份维护
2. lightrag-service 不迁入（RAGservicer 是超集，§2.3），注入器与 AItrader 调用方统一指向 RAGservicer
3. **DC/Collector 的 raw data 通过"可配置解析层"注入 RAGservicer**，赋予 AI Agent 自然语言查询链上/市场能力

---

## 2. 现状资产盘点

### 2.1 AItrader 待合并资产（文件级）

**data-service（63 个文件）**：

```
data-service/
├── main.py                     # FastAPI 入口（:8765）
├── app/
│   ├── config.py               # 配置（环境变量读取）
│   ├── factors.py              # 因子引擎（/factors/*）
│   ├── kline_service.py        # K线聚合服务
│   ├── kline_store.py          # K线存储
│   ├── enrich.py               # 数据富化
│   ├── symbol_name.py          # 交易对→名称映射
│   ├── collectors/             # 采集器（calendar/external_factors/heatmap/market_data/urls）
│   ├── data_providers/         # 15 个数据提供方（crypto/forex/commodities/indices/news/finnhub/cnbc/...）
│   ├── data_sources/           # 17 个数据源接入（crypto/us_stock/hk_stock/cn_stock/asia_kline/futures/tencent/...）
│   ├── market_data/            # 核心市场数据（core/crypto/fundamental/indicators/macro_news/price_kline）
│   ├── storage/sqlite.py       # SQLite 持久化
│   └── utils/                  # cache/db/db_postgres/logger
├── data_config.json            # 数据源配置
├── factors.json                # 因子定义
├── requirements.txt
├── Dockerfile
├── data-service.service        # systemd（可直接参考迁移）
├── README.md / DATA_SERVICE.md
└── .env.example
```

**knowledge-injector（32 个文件）**：

```
knowledge-injector/
├── main.py                     # 入口（--api 模式启动 Flask :3611；默认定时 worker）
├── config.py                   # 配置（RAG_API_BASE/RAG_API_TOKEN/INJECT_QUIET_HOURS/...）
├── api/routes.py               # Flask REST：/health、/inject/<source>（手动触发）
├── injector/
│   ├── client.py               # LightRAGClient（注入+查询，适配点 §6.3）
│   ├── worker.py               # GraphInjector：15 个 inject_* 方法 + 6h 定时
│   ├── textify.py              # 结构化数据→文本（硬编码函数，§4.1 改造点）
│   ├── enrichment.py           # 指标计算（RSI/MACD/布林带/趋势...）
│   ├── stats.py                # 注入统计
├── providers/                  # 12 类数据源（macro/sentiment/news/onchain/defi/earnings/evm/volatility/...）
├── storage/db.py               # SQLite：raw_snapshots + inject_log
├── tests/                      # test_textify / test_providers_logic / test_enrichment
├── requirements.txt / Dockerfile / README.md / .env.example
```

### 2.2 InfraX 现有能力

| 服务 | 端口 | 能力 |
|------|:---:|------|
| Collector | 9101 | `/market/*`：candles/price/trades/token-holders/signals/hot-tokens/leaderboard；全链事件扫描（5 链） |
| DC | 9102 | `/api/v2/data/*`：events（**raw 链上事件**）/subscribe/usage/key/stats；API Key 鉴权 |
| RAGservicer | 9721 | `/api/v1/namespaces/<ns>/documents|query|retrieve`；tenant+namespace 隔离、三层鉴权、统一响应、MCP |

**DC `/api/v2/data/events` 返回的 raw 字段**（确认原始数据形态）：

```
event_id, event_type, chain, block_number, tx_hash, from_address, to_address,
contract_address, token_address, token_symbol, amount, amount_raw,
confirmations, collected_at, created_at
```

### 2.3 能力对照与去重结论

| 能力域 | AItrader | InfraX 现有 | 结论 |
|--------|----------|-------------|------|
| 加密行情/K线 | data-service（ccxt） | Collector `/market/*` | **重叠** → 双跑，长期收敛 |
| 链上事件 | 注入器 onchain/evm provider | DC raw events + Collector 扫描 | InfraX 更强，**且是 raw data** |
| 美股/港股/A股/外汇/期货/宏观/因子 | data-service 独有 | ✗ | **互补，保留** |
| 数据→知识图谱注入 | knowledge-injector | ✗ 空白 | **迁入** |
| LightRAG 服务 | lightrag-service（官方单租户） | RAGservicer（多租户/鉴权/MCP 超集） | **不迁入**，指向 RAGservicer |
| 可配置解析 raw→文本 | ✗ 硬编码 | ✗ | **本次新建（§4）** |

---

## 3. 总体架构

### 3.1 目标拓扑

```
┌─────────────────────────── InfraX 平台 ───────────────────────────┐
│                                                                    │
│  :9101 Collector ──┐        :9113 knowledge-injector (迁入)       │
│    /market/*       │  HTTP     │ provider(拉取)                   │
│                    ├──────────►│ ├─ aitrader 12 类 (保留)          │
│  :9102 DC          │           │ ├─ infrax_dc     (新增) ← raw    │
│    /api/v2/data/*  │           │ └─ infrax_collector(新增) ← 信号  │
│  (raw events) ─────┘           │        │                         │
│                                │        ▼ Parser(配置驱动 §4)      │
│  :9721 RAGservicer ◄───────────┤  text → /documents               │
│    /api/v1/namespaces/*        └──► ns: market / onchain          │
│                                                                    │
│  :9112 data-service (迁入) ←── AItrader analysis/backtest/trading │
│    /bars /factors/* /snapshots                                     │
└────────────────────────────────────────────────────────────────────┘
        ▲ 自然语言查询（Agent / MCP ragservicer）
```

### 3.2 数据流（注入链路）——含图谱构建

```
[Provider 拉取 raw 快照]
   DC raw events / Collector 信号 / aitrader 12 类数据源
        │
        ▼
[SQLite 存档 raw_snapshots]  ← 原始数据留存，可回溯（raw 数据本身不进入图谱）
        │
        ▼
[Parser 可配置解析层]  ← raw dict + YAML 规则 → 自然语言文本（<500 token）
        │
        ▼
[Injector]  ← doc_id 去重 → POST RAGservicer /api/v1/namespaces/<ns>/documents
        │
        ▼
[LightRAG 图谱构建 ★]  ← 插入时由 LLM 做实体抽取 + 关系抽取
   实体：链 / 代币 / 地址 / 事件类型（如 SOL、USDC、0xAbC...、transfer）
   关系：transfer / swap / 持有 / 触发（如 "USDC transferred from X to Y"）
        │
        ▼
[图谱检索查询]  ← /api/v1/namespaces/<ns>/query（only_need_context=True，零 LLM）
   ns: market / onchain，供 Agent 与 MCP 自然语言查询
```

> ★ **图谱构建时机**：每次文档插入时触发（LLM 实体/关系抽取）；查询阶段不消耗 LLM。

---

## 4. 可配置解析层设计（核心新增）

### 4.1 现状问题

aitrader 的 [textify.py](file:///home/ubuntu/aitrader/knowledge-injector/injector/textify.py) 全是**硬编码 Python 函数**（`macro()`、`price_action()`、`tech_analysis()`…），每个函数签名写死命名参数。缺点：

- 新增一种事件类型/数据源 = 改代码 + 发版
- DC raw 事件的 `event_type` 多样（transfer/swap/liquidation…），无法逐一写死
- 维护成本高

### 4.2 设计目标

- **配置驱动**：解析规则放 YAML，新增类型只加配置
- **确定性**：同输入同输出，可测试
- **纯函数**：无 IO，与 textify 现有原则一致
- **兼容旧版**：现有 15 个硬编码注入器保留为"内置解析器"，配置化解析器为扩展通道

### 4.3 配置 Schema（`parsers/*.yaml`）

```yaml
# parsers/dc_events.yaml —— DC raw 事件 → 文本
parsers:
  - name: dc_transfer                     # 解析器名（= 注入器名）
    source: infrax_dc                    # 绑定数据源 provider
    match:                                # 过滤条件（全部满足才命中）
      event_type: [transfer, transfer_batch]
    template: |
      [OnChain] {chain} block {block_number}: {token_symbol} {amount:fmt} moved
      from {from_address:short} to {to_address:short}. tx {tx_hash:short}
    doc_id: "dc:{event_type}:{chain}:{block_number}:{event_id}"
    namespace: onchain                   # 注入目标 namespace
    dedup: true                          # doc_id 重复则跳过

  - name: dc_swap
    source: infrax_dc
    match:
      event_type: [swap]
    template: |
      [OnChain Swap] {chain} block {block_number}: {token_symbol} {amount:fmt}
      ({amount_raw} raw) at tx {tx_hash:short}
    doc_id: "dc:{event_type}:{chain}:{block_number}:{event_id}"
    namespace: onchain
    dedup: true
```

```yaml
# parsers/collector_signals.yaml —— Collector 信号 → 文本
parsers:
  - name: market_signal
    source: infrax_collector
    match: {}                             # 所有信号
    template: |
      [Signal] {symbol} {signal_type} at {price:fmt} ({change_pct:+.2f}%),
      confidence {confidence}, {reason}
    doc_id: "signal:{symbol}:{signal_type}:{timestamp}"
    namespace: market
    dedup: true
```

字段语义：

| 项 | 说明 |
|----|------|
| `match` | 键=raw 字段，值=允许列表；`{}` 表示全量 |
| `template` | `{field}` 引用 raw 字段；`{field:transform}` 应用转换器；`{field:+.2f}` 直接进 Python 格式串 |
| `doc_id` | 确定性 ID（天然幂等去重） |
| `namespace` | RAGservicer namespace |
| `dedup` | 是否按 doc_id 去重（对比 inject_log） |

### 4.4 解析引擎（`injector/parser.py`，新文件）

```python
def parse_snapshots(snapshots: list[dict], rules: list[dict]) -> list[InjectUnit]:
    """raw 快照 → 注入单元列表（text, doc_id, namespace）。
    纯函数：同输入同输出，可单测。"""
    units = []
    for snap in snapshots:
        for rule in rules:
            if not _match(snap, rule["match"]):
                continue
            text = _render(rule["template"], snap)   # 模板渲染 + 转换器
            if not text.strip():
                continue
            units.append(InjectUnit(
                text=text,
                doc_id=_render(rule["doc_id"], snap),
                namespace=rule.get("namespace", "default"),
            ))
            break  # 每快照命中一条规则
    return units
```

- 加载：启动时扫描 `parsers/*.yaml`（配置热更新可选）
- 校验：启动时 schema 校验（未知转换器/字段引用报错）

### 4.5 内置转换器

| 转换器 | 说明 | 示例 |
|--------|------|------|
| `short` | 地址/哈希截断 | `0x1234...abcd` |
| `fmt` | 千分位金额 | `1,234,567` |
| `+.2f` 等 | 直接 Python 格式串 | `{change_pct:+.2f}` |
| `upper` / `lower` | 大小写 | — |
| `iso_time` | 时间戳→ISO | — |
| `ellipsis:N` | 文本截断 | 新闻正文前 N 字符 |

### 4.6 配置示例：DC raw event → 文本

DC events 返回（raw）：

```json
{
  "event_id": 1001, "event_type": "transfer", "chain": "SOL",
  "block_number": 283456789, "tx_hash": "0x9f3a...c2de",
  "from_address": "0xAbC...", "to_address": "0xDef...",
  "token_symbol": "USDC", "amount": 1000000, "amount_raw": "1000000000000000",
  "collected_at": "2026-08-04T03:00:00Z"
}
```

命中 `dc_transfer` 规则渲染：

```
[OnChain] SOL block 283456789: USDC 1,000,000 moved from 0xAbC... to 0xDef.... tx 0x9f3a...c2de
```

doc_id `dc:transfer:SOL:283456789:1001` → 重复采集自动跳过。

### 4.7 与现有 textify 的兼容策略

| 方式 | 说明 | 用途 |
|------|------|------|
| 内置解析器（保留） | 现有 15 个 `inject_*` + textify 函数 | aitrader 原有 12 类数据源 |
| 配置化解析器（新增） | §4.3-4.5 YAML 规则 | DC/Collector 及未来新数据源 |

两者在 `GraphInjector` 中统一调度：先按配置规则匹配，未命中走内置方法。

---

## 5. data-service 迁移 → `projects/data`

### 5.1 目录映射（文件级）

| aitrader 源 | → projects/data 目标 | 说明 |
|-------------|---------------------|------|
| `main.py` | `main.py` | 改端口 9112 |
| `app/` 全部子包 | `app/` 原样 | 代码零改动 |
| `data_config.json` | `data_config.json` | 保留 |
| `factors.json` | `factors.json` | 保留 |
| `requirements.txt` | `requirements.txt` | 保留 |
| `data-service.service` | `infrax-data.service` | 重命名+改路径/端口 |
| `Dockerfile` | `Dockerfile` | 保留 |
| `README.md` / `DATA_SERVICE.md` | `README.md` | 合并为一份 |
| `.ua/` 图谱缓存 | ✗ 不迁移 | aitrader 本地分析产物 |

### 5.2 配置项

| 环境变量 | 值 | 说明 |
|----------|-----|------|
| `PORT` | `9112` | 原 8765 |
| `DATA_SERVICE_ENV` | `production` | 沿用 |
| 数据源密钥 | 沿用 aitrader 配置 | ccxt/yfinance/tencent 等 |

### 5.3 API 端点适配

| aitrader 端点 | 处理 |
|---------------|------|
| `/bars`（K线）、`/factors/catalog`、`/factors/current`、`/snapshots`、`/stats` | **保留**，供 AItrader 调用 |
| `/api/v1/*`（交接文档标注损坏） | **删除** |
| `/health` | 对齐 `{code:0,message:"ok",data:{...}}` |

### 5.4 部署单元

`infrax-data.service`（参考 ragservicer 模式，指向自建 `.venv/bin/uvicorn main:app`）。

---

## 6. knowledge-injector 迁移 → `projects/knowledge-injector`

### 6.1 目录映射

| aitrader 源 | → 目标 | 说明 |
|-------------|--------|------|
| `main.py` `config.py` | 原样 | 端口 9113 |
| `api/routes.py` | 保留 | `/health` `/inject/<source>` |
| `injector/client.py` | **改造** | 指向 RAGservicer（§6.3） |
| `injector/worker.py` `textify.py` `enrichment.py` `stats.py` | 原样 | 保留 15 内置注入器 |
| **新增** `injector/parser.py` | 新文件 | 可配置解析引擎（§4.4） |
| **新增** `parsers/*.yaml` | 新目录 | DC/Collector 解析规则 |
| `providers/` 12 类 | 原样 | + 新增 `infrax_dc.py` `infrax_collector.py` |
| `storage/db.py` | 原样 | SQLite 存档 |
| `tests/` | 原样 + 新增 | 保留 3 测试 + parser 单测 |
| `knowledge-injector.service` | `infrax-knowledge-injector.service` | 重命名 |

### 6.2 配置项（新增/变更）

| 环境变量 | 说明 |
|----------|------|
| `RAGSERVICER_URL` | `http://127.0.0.1:9721`（替代原 `RAG_API_BASE`） |
| `RAGSERVICER_API_KEY` | 内部桥接 key（替代 `RAG_API_TOKEN`） |
| `INJECT_INTERVAL_HOURS` | 默认 6（沿用） |
| `DC_URL` + `DC_API_KEY` | infrax_dc provider 用 |
| `COLLECTOR_URL` + `COLLECTOR_API_KEY` | infrax_collector provider 用 |

### 6.3 客户端适配（关键差异点）

| 操作 | aitrader 原路径 | RAGservicer 目标路径 |
|------|----------------|----------------------|
| 注入 | `POST {base}/documents/text` `{text, file_source}` | `POST {rag}/api/v1/namespaces/{ns}/documents` `{text, doc_id}` + `X-API-Key` |
| 查询 | `POST {base}/query` `{query, top_k}` | `POST {rag}/api/v1/namespaces/{ns}/query` `{query, mode}` + `X-API-Key` |

- `file_source` → `doc_id`（解析器生成，§4.4）
- `X-API-Key` = `RAGSERVICER_API_KEY`（internal bridge → tenant `default`）
- namespace 由解析规则指定（market/onchain）

### 6.4 REST API 保留

`POST /inject/<source>` 手动触发；新增 `POST /inject/parsed`（按 YAML 规则触发解析注入）用于维护调试。

### 6.5 部署单元

`infrax-knowledge-injector.service`：`ExecStart=.venv/bin/python main.py --api`（保留 waitress :9113）。

---

## 7. DC/Collector 数据注入 RAGservicer

### 7.1 结论

**可行且推荐**。DC 数据是 raw data（§2.2 字段），只需增加 §4 的可配置解析层即可文本化注入，无需改 DC 本身。

### 7.2 数据源接入（新增 provider）

| provider | 数据源 | 拉取方式 | 输出 |
|----------|--------|----------|------|
| `infrax_dc` | DC `/api/v2/data/events` | GET + DC API Key，按 chain/event_type 过滤，增量 since=上次游标 | raw event 列表 |
| `infrax_collector` | Collector `/market/signals` `/market/hot-tokens` `/market/price` | GET + API Key | 信号/热点列表 |

### 7.3 解析规则（§4.6 示例）

- `dc_transfer` / `dc_swap`（以及按 event_type 继续扩展）→ namespace `onchain`
- `market_signal` → namespace `market`

### 7.4 namespace 规划

| namespace | 内容 | 消费方 |
|-----------|------|--------|
| `market` | 宏观/情绪/新闻/技术分析/Collector 信号 | Agent、MCP |
| `onchain` | DC 链上事件、持有人/巨鲸 | Agent、MCP |

### 7.5 消费方

- RAGservicer MCP server（`infrax-ragservicer-mcp`）
- `GET/POST /api/v1/namespaces/{market|onchain}/query`（mode=hybrid，only_need_context）

### 7.6 收益

- AI Agent 自然语言查询："最近 24h 有哪些大额 SOL 转账？""BTC 是否出现买入信号？"
- 链上/市场历史沉淀进知识图谱，供推理引用
- 解析规则配置化 → 新增事件类型零代码

### 7.7 链上数据 → 图谱构建（明确标注）

读取到的链上数据**会注入 LightRAG 并构建实体-关系图谱**：

| 环节 | 说明 |
|------|------|
| 数据形态 | DC 返回 **raw 链上事件**（`event_id/event_type/chain/block_number/tx_hash/from_address/to_address/token_symbol/amount/amount_raw/...`） |
| 解析 | YAML 模板把 raw 事件渲染为自然语言文本（§4.6 示例：`[OnChain] SOL block 283456789: USDC 1,000,000 moved from 0xAbC... to 0xDef...`） |
| 注入 | 文本 POST 到 RAGservicer `/api/v1/namespaces/onchain/documents`（doc_id 去重） |
| **图谱构建** | 插入时 RAGservicer 调用 LLM 做**实体抽取 + 关系抽取**，产出图谱节点（链/代币/地址/事件）与边（transfer/swap/持有） |
| 存档 | 原始 raw 快照保留在注入器 SQLite（**不直接进图谱**），可回溯审计 |
| 查询 | `/api/v1/namespaces/onchain/query` 或 MCP 检索图谱返回上下文（only_need_context，零 LLM） |

---

## 8. 平台对齐规范

| 项 | 规范 |
|----|------|
| 端口 | data :9112、knowledge-injector :9113（910x 段） |
| 鉴权 | knowledge-injector 出站：`RAGSERVICER_API_KEY`/`DC_API_KEY`/`COLLECTOR_API_KEY`；入站 `/inject/*` 增加 `INJECTOR_ADMIN_KEY` |
| 响应格式 | 非 SSE 端点统一 `{code,message,data}` |
| 日志 | 统一 JSON 日志、logger 名 `infrax.{service}` |
| 环境变量 | 密钥环境注入不入库；提供 `.env.example` |
| 部署 | systemd 单元 × 2，参考 `infrax-ragservicer.service` |
| 文档 | 各服务 README + 根 README 模块表 |
| 图谱 | `.ua/knowledge-graph.json` 补 data/knowledge-injector 节点 |

---

## 9. 实施里程碑与验收

### 9.1 里程碑

| 里程碑 | 内容 |
|--------|------|
| **M1 迁入 data** | `projects/data` 落盘，端口 9112，删 `/api/v1/*`，systemd，health 对齐 |
| **M2 迁入 injector** | `projects/knowledge-injector` 落盘，端口 9113，RAGservicer 客户端适配，health 对齐 |
| **M3 可配置解析层** | `parser.py` + `parsers/*.yaml` + 单测；`/inject/parsed` 端点 |
| **M4 DC/Collector 注入** | `infrax_dc` / `infrax_collector` provider；端到端注入验证 |
| **M5 平台收尾** | 文档、图谱、根 README、commit+push |

### 9.2 验收清单

- [ ] `GET :9112/health` → `{code:0,data:{service:"infrax-data"},message:"ok"}`
- [ ] `GET :9112/factors/catalog` 返回因子列表
- [ ] `GET :9113/health` 返回注入器状态
- [ ] `POST :9113/inject/parsed`（dry-run）输出解析后文本
- [ ] 一次真实注入 → `POST :9721/api/v1/namespaces/onchain/query`（"recent large SOL transfers"）命中
- [ ] **图谱构建验证**：注入后 `local` 模式查询命中图谱实体/关系（如返回实体 `SOL`、`USDC` 与关系 `transfer`），确认插入时 LLM 实体/关系抽取已生效
- [ ] 相同 raw 快照重复注入 → inject_log 显示 dedup，无重复文档
- [ ] 新增一个 `event_type` 规则（仅 YAML）→ 无需重启代码即生效（或热加载）
- [ ] 3 个 systemd 单元 enabled + 运行中
- [ ] 图谱节点、根 README 已更新

---

## 10. 风险与回滚

| 风险 | 等级 | 缓解 |
|------|:---:|------|
| aitrader 调用方接口变更（响应格式/端口） | 中 | 先双跑：aitrader 仍可指向旧服务，切换窗口内对齐 |
| RAGservicer 鉴权（internal bridge）未开通 | 中 | 先在 RAGservicer 建 tenant 并签发 key |
| YAML 规则错误导致注入失败 | 低 | schema 校验 + dry-run + dedup 兜底 |
| 双 LightRAG（若选 D7 备选） | 低 | 默认不迁入 lightrag-service |
| 回滚 | — | 新服务独立目录+独立端口，停 systemd 即回退 |

---

## 11. 决策点汇总（评审用）

| 编号 | 问题 | 建议 |
|------|------|------|
| D1/D3/D5 | data 命名、端口 9112/9113、扩展注入器 | ✅ 已确认 |
| D4 | namespace 划分 `market`/`onchain` | 建议确认 |
| D6 | 响应格式对齐 InfraX 标准 | 建议确认（影响 aitrader 调用方，需协调） |
| D7 | lightrag-service 不迁入 | 建议确认 |
| D8 | 解析规则热加载 vs 重启加载 | 建议先重启加载（简单），热加载留作增强 |
| D9 | data-service 加密行情端点是否停用（与 Collector 重叠） | 建议保留双跑，注入器统一消费 |

---

## 12. 参考资料

- aitrader `TARGET_PROJECT_HANDOVER.md`（2026-08-04 新版）
- aitrader `data-service/README.md`、`knowledge-injector/README.md`
- InfraX `projects/ragservicer`（迁入模式参考）、`projects/collector`、`projects/dc`
