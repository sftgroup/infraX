# InfraX Knowledge Injector

知识图谱注入微服务（`infrax-knowledge-injector`，**端口 9113**）。定时从数据源拉取快照 → 生成结构化文本 → 注入 **RAGservicer**（InfraX LightRAG 微服务 :9721）构建知识图谱，为 AI Agent / MCP 提供背景知识。

## 功能

- **内置注入器（15 类）**：宏观、情绪、加密货币概览、波动率、新闻情感、重大事件、FRED 经济、财报指数、BTC 链上、DeFi TVL、宏观趋势、EVM、多区域宏观、股指、技术分析
- **配置化解析注入（可扩展）**：YAML 规则驱动，把 **raw 数据**（如 DC 链上事件、Collector 市场信号）解析为自然语言文本注入，新增事件类型只加配置不改代码
- **幂等去重**：确定性 `doc_id`（如 `dc:transfer:SOL:283456789:1001`），重复注入自动跳过
- **原始数据存档**：SQLite `raw_snapshots` 留存，可回溯审计
- **namespace 隔离**：市场数据 → `market`，链上数据 → `onchain`

## 启动

```bash
python -m venv .venv && ./.venv/bin/pip install -r requirements.txt
cp .env.example .env   # 按需修改（RAGSERVICER_URL / RAGSERVICER_API_KEY）
./.venv/bin/python main.py                      # 定时注入器（默认 6h 一轮）
./.venv/bin/python main.py --api               # REST API 模式 (:9113)
./.venv/bin/python main.py --once              # 执行一次全量注入
./.venv/bin/python main.py --inject macro      # 单类型注入
./.venv/bin/python main.py --db-stats          # 查看注入统计
```

systemd：`sudo cp infrax-knowledge-injector.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now infrax-knowledge-injector`

> 生产环境完整部署（systemd / .env / 注入链路验证）见 [docs/infrax_tasklist.md](../../docs/infrax_tasklist.md)。

## 环境变量

见 [.env.example](./.env.example)。核心项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `RAGSERVICER_URL` | 空(=禁用) | RAGservicer 地址（回退 `DOC_URL` / `LIGHTRAG_URL`） |
| `RAGSERVICER_API_KEY` | 空 | RAGservicer 内部桥接鉴权 key |
| `DEFAULT_NAMESPACE` | `market` | 默认注入 namespace |
| `DC_URL` / `DC_API_KEY` | 空 | DC 链上 raw 事件（infrax_dc provider） |
| `COLLECTOR_URL` / `COLLECTOR_API_KEY` | 空 | Collector 市场信号（infrax_collector provider） |
| `INJECTOR_INTERVAL_SEC` | 21600 | 注入间隔（秒） |

## 配置化解析（parsers/*.yaml）

规则：`match`（过滤）→ `template`（模板，支持 `{field}` / `{field:short}` / `{field:+.2f}`）→ `doc_id`（幂等）→ `namespace`。

示例 [parsers/dc_events.yaml](./parsers/dc_events.yaml)：DC raw 事件按 `event_type` 匹配渲染为 `[OnChain] SOL block 283456789: USDC 1,000,000 moved from 0xAbC... to 0xDef...`，doc_id 去重。

手动触发：

```bash
curl -X POST localhost:9113/inject/parsed -H 'Content-Type: application/json' \
  -d '{"source":"infrax_dc","limit":100,"dry_run":true}'   # dry-run 预览
curl -X POST localhost:9113/inject/parsed -H 'Content-Type: application/json' \
  -d '{"source":"infrax_dc","limit":100}'                   # 真实注入
```

## REST API

| 端点 | 说明 |
|---|---|
| `GET /health` | 健康检查（InfraX 标准格式） |
| `POST /inject/<source>` | 手动触发内置注入器 |
| `POST /inject/parsed` | 配置化解析注入（`{source, limit, dry_run}`） |
| `POST /inject/all` | 全量注入 |
| `POST /query` | 查询知识图谱 |
| `GET /status` / `/injectors` / `/stats` / `/stats/recent` | 状态与统计 |

## 测试

```bash
./.venv/bin/python -m pytest tests/ -q   # 85 passed（含可配置解析层单测）
```
