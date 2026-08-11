---
name: data
description: |
  Use this skill when the user needs market data from the InfraX data stack: OHLCV klines, tickers, technical/macro/on-chain factors,
  snapshots, symbol search/resolve, ML predictions, broker policy, data stats, knowledge-graph injection, or RAG knowledge queries.
  Covers the data_*/ml_*/injector_*/rag_* tools of the hub MCP (unified entry for data :9112 / injector :9113 / rag :9721).
version: 1.0.0
license: MIT
metadata:
  infrax:
    mcp: infrax-hub-index
    tools:
      - data_bars
      - data_ticker
      - data_factors
      - data_factors_history
      - data_snapshots
      - data_symbols
      - ml_predictions
      - data_symbol_search
      - data_symbol_resolve
      - data_broker_policy
      - data_stats
      - injector_trigger
      - rag_query
---

# Data — InfraX AI Skill

## 能力概览

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `data_bars` | 查询 OHLCV K 线（股票/外汇/加密 spot/swap/A 股） | `symbol`、`interval`、`start`、`end` |
| `data_ticker` | 最新行情价格 | `symbol`（必填） |
| `data_factors` | 技术/宏观/链上因子（当前值） | `symbol`（必填） |
| `data_factors_history` | 因子历史序列 | `symbol`、`start`、`end` |
| `data_snapshots` | 快照数据（macro/crypto/onchain/defi/indices） | `type`（必填）、`date`、`limit` |
| `data_symbols` | 列出/搜索支持标的 | `market`、`query` 过滤 |
| `ml_predictions` | ML 模型预测（Kronos 45 符号全量 ~18min，接口按符号/日期查询） | `symbol`、`date` 等 |
| `data_symbol_search` | 跨市场模糊搜索标的 | `query`（必填）、`market` |
| `data_symbol_resolve` | 原始关键词解析为规范交易符号 | `keyword`（必填） |
| `data_broker_policy` | 各市场主交易场所策略 | 无 |
| `data_stats` | 数据服务库统计（K 线行数、快照行数、覆盖范围） | 无 |
| `injector_trigger` | 触发一次知识图谱数据注入（后台执行） | `source`/`config` |
| `rag_query` | 知识库 RAG 检索 | `query`（必填）、`mode`（默认 mix） |

## 接入方式

- MCP server：`infrax-hub-index`（HTTP Streamable 传输，统一入口）
- 端口：`:3008`（dev 与生产一致，systemd `infrax-hub-index.service`）
- 上游：data `:9112` / knowledge-injector `:9113` / ragservicer `:9721`；ml-service `:9120`（独立机 43.156.25.197）
- 鉴权：`Authorization: Bearer <INFRAX_MCP_API_KEY>`（MCP_API_KEY 白名单，或 mx_ 前缀 scope=mcp 签发 key 经 data /api-keys/verify 实时校验）

## Quick Start

### 场景 1：查行情与因子

```
1. data_ticker { "symbol": "BTCUSDT" }
2. data_bars { "symbol": "BTCUSDT", "interval": "1h", "start": "2026-08-01", "end": "2026-08-12" }
3. data_factors { "symbol": "BTCUSDT" }
```

### 场景 2：ML 预测

```
ml_predictions { "symbol": "BTC", "date": "2026-08-13" }
```

### 场景 3：RAG 知识检索

```
rag_query { "query": "InfraX DC 事件分类规则", "mode": "mix" }
```

## 约束与注意事项

- `data_symbols`/`ml_predictions` 全量场景耗时较长（Kronos 全符号 ~18min），查询优先按符号/日期收敛，避免超时。
- `injector_trigger` 是写操作，注入间隔 21600s（6h），高频触发会被限流。
- 符号解析用 `data_symbol_resolve`（如 `BTC` → `BTCUSDT`）后再查行情，命中率更高。
