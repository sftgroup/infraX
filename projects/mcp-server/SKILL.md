---
name: "infrax-data-hub"
description: "InfraX 数据栈统一 MCP 入口（hub-index）— 通过一个 MCP endpoint 聚合四服务能力：data K线/因子/快照/ticker/交易对、ML 预测、knowledge-injector 注入触发、ragservicer 知识库混合查询。Invoke for market data queries, factor analysis, snapshot data, ML predictions, knowledge graph queries, or triggering data ingestion."
version: "1.0.0"
---

# InfraX Data Hub MCP

统一入口（`projects/mcp-server/src/hub-index.ts`，端口 3008，Streamable HTTP），聚合数据栈四服务，agent 只需注册一个 MCP endpoint。

## 能力矩阵

| 工具 | 后端 | 说明 |
|---|---|---|
| `data_bars` | data :9112 | OHLCV K 线（股票/外汇/加密 spot+swap/A 股） |
| `data_ticker` | data :9112 | 实时行情 |
| `data_factors` / `data_factors_history` | data :9112 | 技术/宏观/链上因子（当前值 + 历史序列） |
| `data_snapshots` | data :9112 | 快照（macro/onchain/defi_tvl/indices...） |
| `data_symbols` | data :9112 | 交易对列表/搜索 |
| `ml_predictions` | data :9112 | ML 方向预测 |
| `injector_trigger` | injector :9113 | 手动触发知识注入（写操作） |
| `rag_query` | ragservicer :9721 | 知识库混合查询（vector+graph+keyword） |

## 启动

```bash
# 本地
cd projects/mcp-server
npm install
PORT=3008 DATA_URL=http://localhost:9112 DATA_API_KEY=xxx npm run dev:hub
```

## 配置（环境变量，全部可选默认 localhost）

- `DATA_URL` / `DATA_API_KEY` → data :9112
- `INJECTOR_URL` / `INJECTOR_API_KEY` → injector :9113
- `RAG_URL` / `RAG_API_KEY` → ragservicer :9721

生产由 `deploy/hub-index.service` 注入密钥，`mcp-config.json` 供 Claude Desktop / Cursor / ClawHub 注册。

## 调用示例（MCP tools/call）

```
data_bars:     {"symbol": "BTC/USDT", "timeframe": "1d", "limit": 30}
data_factors:  {"symbol": "AAPL", "factor": "rsi14"}
rag_query:     {"namespace": "market", "query": "美联储 2026 降息预期"}
injector_trigger: {"source": "onchain"}
```

> 注：TEE 钱包（Phase 2.1-2.3）与 hub-index 全量品牌化（Phase 2.4/2.5 排期）见 docs/infrax_tasklist.md §9.6。本 SKILL 覆盖当前已上线能力。
