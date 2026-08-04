# B 端 data-service 进度催办清单

> 提交方：AItrader 项目 ｜ 日期：2026-08-05
> 关联文档：[AITRADER_DATA_SERVICE_REQ.md](./AITRADER_DATA_SERVICE_REQ.md)（2026-08-04 提交的完整需求）
> 目的：AItrader 侧 M3（单体行情层全切 B 端）已被以下待补项阻塞，请 B 端确认排期与完成时间。

---

## 1. 一句话现状

AItrader 侧**服务间鉴权（WS-A）与配置统一下发（WS-B）已全部完成并上线**（`SERVICE_API_KEY`/`X-User-Id` 已随单体 client 统一携带，`DATA_SERVICE_URL` 已集中配置、compose 强校验）。**当前唯一阻塞点在 B 端 data-service 的 5 个待补需求（DS-7~DS-11）**，落地后单体即可删除本地 `data_sources/`、`data_providers/` 全量切换。

---

## 2. 催办清单

| 编号 | 需求 | 状态 | 优先级 | 阻塞范围 | 请 B 端确认 |
|---|---|---|---|---|---|
| **DS-8** | `/bars` 数据覆盖保证 + spot/swap 区分 | ✅ 已实现（da2cd34，2026-08-05 已部署实测） | **P0** | backtest/trading/analysis **3 个微服务已依赖**；当前仅 `BTC/USDT 4h` 有数据，`1m`/`1D` 为空 = **功能实际不可用** | swap 采集器已上线（BTC/ETH/SOL 1m 各 500 根，`/bars?market_type=swap` 已通）；5m/15m/30m/1h/4h 覆盖待配置 `KL_TIMEFRAMES` |
| **DS-7** | 实时报价 `GET /ticker` | ✅ 已实现（1375a38，2026-08-05 已部署实测） | **P0** | 单体持仓现价、持仓盈亏告警、快交易、全局行情页（`KlineService.get_realtime_price` 依赖） | 验收：BTC spot+swap / 美股 / 外汇已通，A股港股走腾讯源 |
| **DS-9** | 符号搜索 `GET /symbols/search` | 🔲 待补 | **P0** | 单体符号搜索（前端"添加自选/搜索交易对"），现有 `/symbol/resolve` 不支持模糊搜索 | 排期与完成时间 |
| **DS-10** | `/snapshots` 补齐 `commodities`/`forex_pairs`/`market_overview` | 🔲 待补 | P1 | 单体全局市场页"商品/外汇/顶部概览"板块 | 排期与完成时间 |
| **DS-11** | `/symbol/resolve` 多市场覆盖确认 | 🔲 待 B 端确认 | P1 | 单体 `symbol_name.py` 跨市场名称解析（crypto/美股/外汇/期货/A股/港股） | **决策点**：覆盖范围？若仅 crypto，AItrader 侧保留非 crypto 本地降级 |
| **DS-12** | 入站鉴权 `X-Service-Key`（`/health` 豁免） | 🔲 待补 | P1 | 生产安全；**AItrader 侧已就绪**（key 已随所有出站请求携带），B 端校验落地即可联通 | 排期与完成时间 |

---

## 3. 关键契约摘要（详见 REQ 文档第 3 节）

### DS-7 `GET /ticker`（P0）

```
query: symbol      必填，如 BTC/USDT
       market_type 可选，spot | swap（默认 spot）
       exchange_id 可选，如 binance
       market      可选，crypto | usstock | forex | futures | cnstock | hkstock

响应 200: { "symbol", "price", "change", "changePercent",
            "high", "low", "open", "previousClose", "ts" }
```

要点：字段对齐 AItrader `KlineService.get_realtime_price` 返回结构，避免二次映射；B 端建议 5-30s 缓存；非 200 返回 `{"detail": "<原因>"}`。

### DS-8 `/bars` 数据覆盖（P0，最高优先）

| 市场 | 标的 | timeframe | 最低历史深度 |
|---|---|---|---|
| Crypto spot / swap | BTC/ETH/SOL（可扩展） | 1m/5m/15m/30m/1h/4h/1D | 1m≥30 天；5m/15m/30m≥180 天；1h/4h≥1 年；1D≥3 年 |
| 美股 | SPY/QQQ/AAPL 等 | 1m/5m/15m/1h/4h/1D | 1D≥3 年，分钟级≥30 天 |
| 外汇 | 主流货币对 | 15m/1h/4h/1D | 1D≥1 年 |
| 期货 | 主流商品期货 | 1h/4h/1D | 1D≥1 年 |
| A股/港股 | 活跃标的 | 15m/1h/4h/1D | 1D≥1 年 |

spot/swap 区分（二选一，推荐方案 A）：A=`/bars` 增加 `market_type` 参数；B=`symbol` 接受 `BTC/USDT:USDT`。数据连续性不允许静默丢 bar。

### DS-9 `GET /symbols/search`（P0）

```
query: keyword 必填，模糊关键字（如 "btc"）
       market  可选，crypto | usstock | forex | futures（默认 crypto）
       limit   可选，默认 20，上限 100

响应 200: { "keyword", "symbols": [ { "symbol", "market", "market_type",
            "exchange", "active" } ] }
```

要点：只返回 `active=true` 且 quote=USDT（crypto）；支持 spot/swap 双市场返回；B 端结果缓存（对标单体 4 小时缓存）。

### DS-10 `/snapshots` 补齐（P1）

缺失 `commodities`（商品）、`forex_pairs`（外汇对）、`market_overview`（多市场概览），消费方为全局市场页；返回结构与现有 `{ts, snapshots}` 信封一致；刷新节奏对标单体缓存 TTL（商品/外汇 30 分钟、概览 15 分钟）。

### DS-11 `/symbol/resolve` 覆盖确认（P1，决策点）

请确认 resolve 是否覆盖 crypto/美股/外汇/期货/A股/港股；若仅 crypto，AItrader 侧将保留非 crypto 解析的本地降级（yfinance/finnhub/腾讯/MOEX）。

### DS-12 入站鉴权（P1）

data-service 全部端点（`/health` 豁免）校验 `X-Service-Key`，缺失/不匹配返回 401 `{"detail": "unauthorized"}`。AItrader 侧出站已统一携带，B 端落地即可全链路鉴权闭环。

---

## 4. 验收标准（B 端上线后 AItrader 侧验证）

1. `/ticker`：BTC/USDT（spot+swap）、任一美股、任一外汇标的返回非 0 `price`，字段齐全。
2. `/bars`：BTC/USDT `1m` 最近 30 天连续无缺口；`1D` 最近 3 年；ETH/SOL 同；任一美股 `1D` ≥ 1 年；`BTC/USDT:USDT`（或 `market_type=swap`）可查。
3. `/symbols/search?keyword=btc` 返回 ≥ 10 个 USDT 交易对（含 spot 与 swap），全部 `active=true`。
4. `/snapshots?type=commodities|forex_pairs|market_overview` 均返回非空数据。
5. 全部端点（除 `/health`）带 `X-Service-Key`：无 key → 401，有 key → 200。
6. AItrader 单体删除本地 `data_sources/`、`data_providers/` 后，kline/持仓现价/告警/符号搜索/仪表盘全流程可用。

---

## 5. 建议行动

1. **DS-8 优先**：3 个微服务（backtest/trading/analysis）已全部依赖 `/bars`，当前只有 4h 数据意味着回测/策略执行/AI 分析在生产均不可用，请最先解决。
2. DS-7/DS-9 与 DS-8 可并行开发；DS-10/DS-11 可随后排期。
3. 每项完成后请按第 4 节验收标准自测，并同步 AItrader 侧进行联调。
4. 期望本周内回复：各待补项的排期与预计完成时间。
