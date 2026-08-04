# InfraX 数据模块 + RAG 完整方案（AItrader 数据栈 v2）

> 版本: v2.0 | 日期: 2026-08-05 | 适用代码: master @ `b9af44b`
>
> 覆盖：data-service (:9112) / ml-service (:9120, 独立服务器) / knowledge-injector (:9113) / ragservicer (:9721)
>
> 关联文档：[DEPLOYMENT_DATA_STACK.md](./DEPLOYMENT_DATA_STACK.md)（部署步骤与运维）、[MERGE_PLAN_AITRADER.md](./MERGE_PLAN_AITRADER.md)（合并入 InfraX 的历史方案）

---

## 1. 目标与范围

本方案定义 AItrader 数据栈的完整架构：**数据采集 → 快照存储 → 模型推理 → 知识图谱注入 → RAG 查询消费**，并明确：

1. **数据模块**：data-service（采集/存储/API）+ ml-service（模型推理）的分工与数据流
2. **模型方案**：P0–P2 模型清单、各自用途、部署状态（本次更新：新增 P1 三家族、共识分层设计）
3. **RAG 链路**：injector 定时注入 → ragservicer 知识图谱 → 查询消费
4. **模型共识分层**（v2 新增）：多模型信号的交叉验证机制——事实层存 RAG、共识层在 ml-service 计算

**核心设计原则**（贯穿全文）：
- **注入器是记录仪，不是分析师**——图谱只存事实，不存判断
- **无模拟回退**——模型不可用时返回空（fail-silent），不产生污染数据
- **信号源头汇聚于 ml-service**——共识等派生计算在源头做，调用方零负担

---

## 2. 总体架构

```
                 ┌────────────────── 主服务器 43.163.105.172 (2C/3.6G) ──────────────────┐
                 │                                                                        │
 外部数据源 ───▶ │  data-service :9112      knowledge-injector :9113     ragservicer :9721│
 (akshare/       │  ┌───────────────────┐  ┌─────────────────────┐  ┌───────────────────┐ │
  CBOE/          │  │ kline_store SQLite │  │ 定时注入(6h)         │  │ LightRAG 知识图谱  │ │
  yfinance/      │  │ 快照 snapshots     │  │ textify 文本化       │  │ namespace: market │ │
  news...)       │  │ /bars /symbols     │  │ 幂等 doc_id 去重     │  │ /query /retrieve  │ │
                 │  │ /factors /snapshots│──▶│                     │──▶│ /documents        │ │
                 │  └───────────────────┘  └─────────────────────┘  └───────────────────┘ │
                 └──────────────┬──────────────────────────────────────────────────────────┘
                                │ HTTP (仅拉数据，不直连 SQLite)
                                ▼
                 ┌────────────────── ml-service 43.156.25.197 (2C/3.6G) ─────────────────┐
                 │  GET /ml/tree_predictions  树模型三家族方向预测（LightGBM/XGBoost/RF）  │
                 │  GET /ml/volatility        Kronos 波动率/方向共识                       │
                 │  POST /ml/sentiment        FinBERT 新闻情绪                            │
                 │  GET /ml/consensus         （v2 新增）跨模型共识聚合                     │
                 └─────────────────────────────────────────────────────────────────────────┘
```

**职责边界**：

| 组件 | 职责 | 不做 |
|---|---|---|
| data-service | 采集外部数据、K线+指标落库、快照存储、HTTP 数据接口 | 不承载模型推理 |
| ml-service | 全部模型推理 + 共识聚合（v2） | 不直连 SQLite，数据全经 data-service HTTP |
| knowledge-injector | 拉快照 → 文本化 → 注入图谱（记录事实） | 不做分析判断 |
| ragservicer | 图谱构建、实体/关系抽取、查询/检索 | 不产生市场信号 |

---

## 3. 数据模块

### 3.1 data-service (:9112)

**数据层**：SQLite（kline_store + snapshots），主栈另有 Postgres 通路（`utils/db_postgres.py`）。

**核心端点**（全部 `{"code":0,"message":"ok","data":...}` 信封）：

| 端点 | 用途 |
|---|---|
| `GET /bars?symbol=&timeframe=&limit=` | K 线 OHLCV + 技术指标列（rsi_14/macd_hist/bb_*/atr_14/ma_*） |
| `GET /symbols?timeframe=&min_bars=` | 可用于训练的 symbol 发现（ml-service 训练依据） |
| `GET /factors/catalog` `/factors/current` `/factors/history` | 因子目录/最新/历史 |
| `GET /snapshots?provider=&type=&limit=` | 快照查询（ml/tree_predictions、ml/volatility、sentiment 等） |
| `GET /stats` `/health` | 统计与健康检查 |

**采集器**（collectors/，后台线程定时拉取）：
- 行情：`market_data`、`crypto`、`commodities`、`indices`、`heatmap`
- 因子：`external_factors`
- 情绪：`sentiment`、`news`、`finbert_sentiment`（调 ml-service）
- 宏观：`calendar`、`adanos`
- ML 联动：`tree_ml`（调 ml-service `/ml/tree_predictions` → 落 `ml/tree_predictions` 快照）

### 3.2 ml-service (:9120，独立 2C4G 服务器)

**推理模型与端点**：

| 端点 | 模型 | 产出 |
|---|---|---|
| `GET /ml/tree_predictions` | LightGBM（主）+ XGBoost + RF | 33 symbol × 7日方向(up/flat/down 概率) + 机会评分(0-100) + 波动率档位；`families` 字段含对比家族 |
| `GET /ml/volatility` | Kronos-mini | BTC/ETH 波动率档位 + 方向共识 + 不确定性 |
| `POST /ml/sentiment` | FinBERT | 文章情绪分类 → 聚合 sentiment_score |
| `GET /ml/consensus`（v2 新增） | —（聚合层） | 跨模型共识（见 §5） |

**数据方向**：ml-service 经 `DATA_SERVICE_URL` 调 data-service `/bars` + `/symbols`，**不直连 SQLite**。

**懒加载与开关**：全部模型按 `*_ENABLED` 环境开关懒加载，失败置 flag 不重试，无模拟回退。当前生产启用：`TREE_ML_ENABLED` / `XGB_ENABLED` / `RF_ENABLED` / `FINBERT_ENABLED` / `KRONOS_ENABLED`。

**资源占用（生产实测）**：常驻 ~223MB RSS；三家族训练 5849 样本/33 symbols 秒级；Kronos 全量 volatility 约 60s（CPU 唯一瓶颈）。

### 3.3 快照机制

- 所有模型产出以**快照**形式经 data-service 落库（`snapshots` 表，provider + type + payload + ts）
- 快照带时间戳（`trained_at_ms` / `generated_at`），供注入器消费与失效判断
- 节奏：树模型 30min / 注入器 6h / FinBERT 随新闻事件

---

## 4. 模型方案（P0–P2 更新版）

### 4.1 模型清单与状态

| 模型 | 类型 | 训练方式 | 用途 | 状态 |
|---|---|---|---|---|
| **Kronos-mini** | 单变量时序基础模型 | 零训练（下载权重） | K线波动率/方向共识 → 注入 RAG | ✅ 已实装（P0） |
| **FinBERT** | 金融文本情绪 | 零训练（下载权重） | 新闻/推文情绪 → sentiment_score | ✅ 已实装（P1a） |
| **LightGBM** | 梯度提升树 | 自训（秒级 CPU） | 因子→7日方向/波动率分级/机会评分 | ✅ 已实装（P1 主） |
| **XGBoost** | 梯度提升树 | 自训 | 同上（同数据集/同切分对照） | ✅ 已实装（P1 对照） |
| **Random Forest** | 树集成（sklearn） | 自训 | 同上（对照基线） | ✅ 已实装（P1 基线） |
| **Chronos-Bolt** | 单变量时序基础模型 | 零训练 | 快速点预测/概率基线（交叉验证） | ✅ 已实装（P2） |
| **Moirai 2.0** | 多变量时序基础模型 | 零训练 | 多资产联动/跨序列传导 | ✅ 已实装（P2） |
| **TimesFM 2.5** | 长上下文时序基础模型 | 零训练 | 16K 长历史点预测 + 置信区间 | ✅ 已实装（P2） |
| **LSTM** | 循环神经网络 | 自训+无权重 | 无（已被以上全部覆盖） | ❌ 放弃 |

> 更新说明（v2）：P1 由单一 LightGBM 扩展为**三家族**（LightGBM/XGBoost/RF），同一数据集/同一切分训练，仅对比 val_acc。生产实测：LGBM 0.474 / XGB 0.477 / RF 0.467（5849 样本、1434 验证、33 symbols）。

### 4.2 已部署模型的用途

```
K线 → 树模型三家族 ──► 方向信号（up/flat/down 概率 + 机会评分 + 波动率档位）
新闻 → FinBERT     ──► 情绪信号（sentiment_score ∈ [-1,1]）
K线 → Kronos       ──► 风险信号（波动率档位 + 方向共识 + 不确定性）
        │  三路输出 → 快照 → textify 文本化 → 注入 RAG 图谱
        ▼
图谱节点（事实）: "BTC: direction up (up 77%/flat 8%/down 15%), opportunity 81, vol moderate"
                "Market sentiment_score -0.50 → bearish"
                "BTC: volatility high (score 0.72), direction_consensus 0.55"
```

- **树模型** = 量化方向；**FinBERT** = 文本情绪；**Kronos** = 波动风险
- 三者输出**全部作为事实节点进入图谱**，供 LLM 查询时引用（非直接交易信号）

### 4.3 P2 模型用途（已部署，2026-08-05）

| P2 模型 | 承担的分析任务 | 补的短板 | 部署实测 |
|---|---|---|---|
| Chronos-Bolt-small | 快速概率基线，与树模型方向交叉验证（分歧→降置信） | 树模型过拟合技术指标，缺独立"第二意见" | ✅ 端点 `/ml/bolt`，BTC/ETH 稳定，~270MB |
| Moirai-2-small | 跨资产联动信号（ETH 传导→BTC 联动风险） | 现有模型全为单标的 | ✅ 端点 `/ml/moirai`，多变量一批喂入，~50MB |
| TimesFM-2.5-200m | 长周期趋势 + 置信区间（风险预算） | Kronos 上限 400-500 根 | ✅ 端点 `/ml/timesfm`，yfinance 可用时 4/4 资产，~1.1GB |
| TimesFM-2.5 完整版(2.5B) | — | — | ~10G ❌ 两台均不可 |

**实测要点**：
- 三模型错峰懒加载，未调用不占内存；全部加载后 ml-service used ~2.1G / avail 1.6G（swap 2G 兜底）
- context 统一 400（适配 data-service BTC/ETH 现有 ~460 根日线）
- SPY/QQQ 依赖 yfinance 回退，受外部限流影响（间歇性）；data-service 覆盖的 BTC/ETH 稳定

---

## 5. 模型共识分层方案（v2 新增）

### 5.1 设计原则

- **注入器是记录仪**：图谱只存各模型**原始信号**（事实层），不存共识判断
- **共识是派生确定性数据**：用代码规则计算，不依赖 LLM 现算（LLM 综合多信号不稳定）
- **信号源头汇聚**：所有模型信号产自 ml-service，共识在源头算，零跨服务开销

### 5.2 分层结构

```
┌─ 事实层（存 RAG 图谱）──────────────────────────┐
│  每个模型原始输出独立成节点（保持现状）：          │
│  BTC: tree_direction up 77%                     │
│  BTC: bolt_prob_up 58%   (P2 后)                │
│  BTC: kronos_vol high 0.72                      │
│  BTC: finbert_sentiment -0.50                   │
└─────────────────────────────────────────────────┘
              ▲ 消费方按需聚合
              │
┌─ 共识层（ml-service 计算 + 快照缓存）──────────────┐
│  GET /ml/consensus → 确定性规则聚合多模型信号：    │
│  consensus_score / 信号分歧标记 / 降置信建议       │
│  → 落 consensus 快照 → 注入图谱快捷字段            │
└─────────────────────────────────────────────────┘
```

### 5.3 共识计算位置：ml-service（不是调用方）

| 位置 | 结论 | 理由 |
|---|---|---|
| **ml-service** | ✅ 推荐 | 六类信号全产自 ml-service，聚合时零 HTTP 开销；调用方/RAG 只读现成字段 |
| 调用方（RAG 查询层） | ❌ | 每次问答跨服务拉全量信号（33×N 模型），2C4G 链路重；LLM 现算不稳定 |

### 5.4 生成时机：随快照落库（不是每次调用现算）

| 方案 | 结论 | 理由 |
|---|---|---|
| **随快照落库缓存** | ✅ 推荐 | 共识与原始信号同快照同生共死，天然一致；查询方零计算 |
| 每次调用现算不缓存 | ❌ | 信号节奏不同（30min/6h），现算结果随时刻漂移 |

**实现方式**（ml-service 新增聚合端点）：

```
ml-service 内（现拉自己的三类预测）：
  tree_predictions（三家族方向概率）
  + volatility（Kronos 波动率档位/共识）
  + sentiment（FinBERT 情绪分）
  → 确定性规则聚合：
     同向模型数/总模型数 → consensus_score ∈ [0,1]
     方向分歧（树 vs Kronos vs 情绪）→ divergence 标记
     高波动 + 负面情绪 + 宽置信区间 → risk_flag
  → 落 consensus 快照（带 trained_at_ms）
  → injector 文本化（textify.consensus_report）→ 注入 RAG
```

### 5.5 消费方式

- RAG 查询时：引用 consensus 快照的现成字段（快捷路径）
- 高级调用方：可从图谱拉原始信号节点**自行调权重重算**（共识逻辑可演进，不需重灌 RAG）
- 共识是辅助字段，**不作为最终判断**——最终研判仍由消费方综合

### 5.6 实现记录（consensus 模块，M3 已完成）

- [x] ml-service 新增 `GET /ml/consensus`（聚合 tree + volatility + sentiment）
- [x] 确定性规则：consensus_score / divergence / risk_flag
- [x] data-service 新增 `ConsensusCollector` 拉 consensus 快照落库（30min）
- [x] injector 新增 `inject_consensus` + `textify.consensus_report` 文本化
- [x] 单测 12 项（规则边界 / fail-silent / 缓存命中 / 符号归一化）
- [x] **P2 整合（v2，M4 后）**：聚合扩展到六路信号（tree + volatility + sentiment + bolt + moirai + timesfm）
- [x] P2 投票规则 + 阈值单测 + textify 展示 P2 方向（ff2bad5，2026-08-05 已部署实测）

**实现要点（与设计一致）**：
- 聚合在 ml-service（信号源头），`/ml/consensus` 确定性规则，六路信号全不可用返回 null
- **TTL 缓存**（`CONSENSUS_CACHE_TTL_SEC=1500`）：首次聚合触发 Kronos 全量推理（~200s）+ P2 推理（TimesFM 首次 ~70s），25min 内秒回缓存；data-service 侧超时 300s 覆盖首算
- **情绪回退链**：`finbert_sentiment`（FinBERT 真实分类）→ `sentiment_score`（市场情绪快照），生产无 FinBERT 快照时仍可用
- **符号归一化**：tree 的 `BTC/USDT` ↔ Kronos/P2 的 `BTC` 对齐为同一标的
- **P2 投票（第二意见交叉验证）**：`prob_up ≥ 0.55` 投 +1、`≤ 0.45` 投 -1、中间置信不投票；`consensus_score` = 主导方向票数 / 有方向票数（单票 1.0、N 票反向各半 0.5）；`divergence` = 票集同时存在 up 与 down；风险项新增任一 P2 模型 `uncertainty=high`
- **实测（P2 整合后）**：33 symbols，六信号全开，avg_consensus 0.5455 / market_risk elevated / 31 项分歧；BTC 4 票 3:1 = 0.75（bolt up + timesfm up vs sentiment down，moirai 中间置信不投）；缓存命中 1.8ms

### 5.7 P2 单模型快照落库 + 历史查询（v2 新增，2026-08-05）

**背景**：`consensus` 快照只有最新一份（聚合视图），调用方无法按 模型 × 标的 × 时间范围 查询 P2 单模型（bolt/moirai/timesfm）的历史预测序列。

**目标**：P2 预测明细落库，提供历史可追溯的单模型视图，与 consensus（聚合最新视图）互补。

```
ml-service /ml/bolt|moirai|timesfm（实时推理，fail-silent）
   → data-service P2MlCollector（30min 轮询，独立 try/except）
   → ml_predictions 表（逐 symbol 一行，明细可追溯）
   → GET /ml/predictions?model=&symbol=&start=&end=&limit=（历史查询，DATA_API_KEY 鉴权）
```

**存储设计**（明细表，启动自动建表；按 symbol 序列查询，与 kline 同构）：

```sql
CREATE TABLE IF NOT EXISTS ml_predictions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    model         TEXT    NOT NULL,   -- bolt | moirai | timesfm
    symbol        TEXT    NOT NULL,   -- 归一化裸代号（BTC/USDT → BTC）
    generated_at  INTEGER NOT NULL,   -- unix ms（预测时间）
    direction     TEXT,               -- up / down
    prob_up       REAL,
    uncertainty   TEXT,               -- low / moderate / high
    point_forecast TEXT,              -- JSON 数组
    quantiles     TEXT,               -- JSON（{0.1,0.5,0.9} 或 {min,max}）
    fetched_at    REAL NOT NULL       -- 落库时间（unix ms）
);
CREATE INDEX idx_mlpred_model_sym_ts ON ml_predictions(model, symbol, generated_at);
```

**采集器**（`collectors/p2_ml.py`，模板同 consensus_ml）：
- `ml_client` 新增 `fetch_bolt() / fetch_moirai() / fetch_timesfm()`（解析 `data: [{symbol,...}]`，timeout 300s）
- 每 `P2_COLLECT_INTERVAL_SEC`（默认 1800s）拉三端点，**逐 symbol** 写 `ml_predictions`；任一模型失败跳过不影响其他
- 幂等：`INSERT OR IGNORE` + `UNIQUE(model, symbol, generated_at)`（ml-service 25min 缓存 TTL 内重复拉取不产生重复行）
- **滚动清理**：保留 `P2_RETENTION_DAYS`（默认 90）天内数据，采集时顺带删除更早行

**查询端点**（data-service）：

```
GET /ml/predictions?model=bolt&symbol=BTC&start=<unix ms>&end=<unix ms>&limit=500
→ {model, symbol, count, predictions: [
     {generated_at, direction, prob_up, uncertainty, point_forecast, quantiles}, ...]}
```

- `model` 必填（枚举 bolt/moirai/timesfm）；`symbol` 交易对/裸代号归一化；`start/end` 区间过滤；按 `generated_at` 升序
- 走现有 `DATA_API_KEY` 鉴权；无数据返回 404 `{"detail": ...}`

**配置**：`P2_COLLECT_ENABLED`（默认 true） / `P2_COLLECT_INTERVAL_SEC`（1800） / `P2_RETENTION_DAYS`（90）；未配 `ML_SERVICE_URL` 时整线程空转

**与共识/RAG 关系**：consensus（聚合视图，最新一份）与 ml_predictions（明细视图，历史可追溯）并存各司其职；injector 可后续将 P2 预测历史文本化注入 RAG（事实层扩展，可选）

**验收**：部署后 30min 内 `/ml/predictions?model=timesfm&symbol=BTC` 返回非空序列；三模型均可查；`start/end` 区间过滤生效；90 天前数据被清理

---

## 6. RAG 链路

### 6.1 knowledge-injector (:9113)

- **调度**：`inject_all()` 每 6h 全量注入（`INJECTOR_INTERVAL_SEC=21600`），每个 `inject_xxx` 独立 try/except fail-silent
- **注入列表**（16 项）：macro / sentiment / crypto_overview / volatility / news_sentiment / major_events / onchain / defi_tvl / macro_trend / fred_economics / earnings_index / evm / global_macro / indices / tech_analysis / **tree_ml**
- **文本化**：`injector/textify.py` 纯函数，输出 <500 token，前缀标记（[Macro]/[Price]/[Sentiment]/[ML Tree Direction] 等）引导实体/关系抽取
- **去重**：幂等 doc_id，重复注入被忽略
- **存储**：原始数据存档 raw_snapshots + 注入结果 inject_log（支持失败重放）

### 6.2 ragservicer (:9721, LightRAG)

- namespace 划分：`market`（行情/宏观/情绪/ML 预测）/ `onchain`（链上）
- 端点：`POST /namespaces/<ns>/query`、`POST /namespaces/<ns>/retrieve`、`POST/GET/DELETE /namespaces/<ns>/documents`
- 插入时 LLM 实体/关系抽取 → 知识图谱（实体=标的/指标/方向/评分；关系=联动/风险/情绪）
- 已知问题：外部 LLM API 瞬时超时会导致 `_worker_loop` 任务超时（ragservicer 基础设施，与本方案无关）

### 6.3 完整数据流

```
采集 (data :9112) → K线/因子/新闻/宏观快照
      │
      ▼
推理 (ml-service :9120) ──► 快照回写 data（tree_predictions / volatility / sentiment）
      │
      ▼
注入 (injector :9113, 6h) ── textify 文本化 ──► ragservicer 图谱（market/onchain）
      │
      ▼
消费：RAG query / retrieve（LLM 引用图谱节点综合研判）
```

---

## 7. 部署拓扑与资源

| 服务器 | 规格 | 承载 | 内存占用（实测） |
|---|---|---|---|
| **43.163.105.172**（主） | 2C/3.6G/swap 2G | data-service :9112 + injector :9113 + ragservicer :9721 | 已用 1.5G / 可用 2.2G |
| **43.156.25.197**（ml） | 2C/3.6G/swap 2G | ml-service :9120（八模型：树三家族 + FinBERT + Kronos + Bolt + Moirai + TimesFM） | 常驻 223MB / P2 全加载后 used ~2.1G / 可用 1.6G |

- **常开结论**：P0+P1 五模型在 ml-service 一台常开无压力；P2 三件套（Bolt-small/Moirai-small/TimesFM-200m）**已全部部署**（2026-08-05），错峰懒加载
- **不拆回主服务器**：主栈承载数据+图谱，已满负荷，模型统一在 ml-service 维护

---

## 8. 里程碑（更新版）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0 基础数据栈** | data-service + injector + ragservicer 三服务生产部署 | ✅ 完成 |
| **M1 模型拆分** | ml-service 独立服务器，Kronos/FinBERT/LightGBM 拆分 | ✅ 完成 |
| **M2 P1 三家族** | XGBoost + RandomForest 对照家族（同数据集同切分） | ✅ 完成（be86dec） |
| **M3 共识分层** | ml-service `/ml/consensus` + 快照 + RAG 注入 | ✅ 完成（8c1f772） |
| **M4 P2 备选** | Bolt-small → Moirai-small → TimesFM-200m（三件套全部） | ✅ 完成（bcf1223 起，2026-08-05） |

---

## 9. 参考资料

- [DEPLOYMENT_DATA_STACK.md](./DEPLOYMENT_DATA_STACK.md) — 部署步骤、配置项、验证清单
- [MERGE_PLAN_AITRADER.md](./MERGE_PLAN_AITRADER.md) — AItrader 数据栈并入 InfraX 历史方案
- 代码：`projects/data` / `projects/ml-service` / `projects/knowledge-injector` / `projects/ragservicer`
