# B 端 data-service 进度催办清单

> 提交方：AItrader 项目 ｜ 日期：2026-08-05
> 关联文档：[AITRADER_DATA_SERVICE_REQ.md](./AITRADER_DATA_SERVICE_REQ.md)（2026-08-04 提交的完整需求）
> 目的：AItrader 侧 M3（单体行情层全切 B 端）已被以下待补项阻塞，请 B 端确认排期与完成时间。

---

## 1. 一句话现状

AItrader 侧**服务间鉴权（WS-A）与配置统一下发（WS-B）已全部完成并上线**（`SERVICE_API_KEY`/`X-User-Id` 已随单体 client 统一携带，`DATA_SERVICE_URL` 已集中配置、compose 强校验）。B 端已按 DS-7~DS-12 落地：**DS-7/8/9/10/12 经 2026-08-06 实测全部可用**（swap 采集器、ticker、symbols/search、snapshots 补齐、X-Service-Key 鉴权均已部署）；**仅余 4 项实现缺口**（crypto 1D 深度回填、EUR/USD ticker 映射、/factors/history 因子列、多市场分钟级 K 线）与 **DS-11 决策点**待 B 端确认。详见第 6 节联调回执。

---

## 2. 催办清单

| 编号 | 需求 | 状态 | 优先级 | 阻塞范围 | 请 B 端确认 |
|---|---|---|---|---|---|
| **DS-8** | `/bars` 数据覆盖保证 + spot/swap 区分 | ✅ 已实现（da2cd34，swap 采集器已部署） | **P0** | backtest/trading/analysis **3 个微服务已依赖**；当前仅 `BTC/USDT 4h` 有数据，`1m`/`1D` 为空 = **功能实际不可用** | AItrader 侧已全量配置 `KL_TIMEFRAMES=1m,5m,15m,30m,1h,4h,1d` + `KL_BACKFILL_DAYS`（见 .env.example），请 B 端重启并按新配置回填；**1D/ETH 日线仍 count:0（8-06 实测），1D 深度 3 年未达标** |
| **DS-7** | 实时报价 `GET /ticker` | ✅ 已实现（1375a38） | **P0** | 单体持仓现价、持仓盈亏告警、快交易、全局行情页（`KlineService.get_realtime_price` 依赖） | 8-06 实测 BTC spot+swap / SPY 全字段 ✅；**EUR/USD ticker 404**（yfinance `EURUSD=X` vs 展示 `EUR/USD` 符号映射，请修复） |
| **DS-9** | 符号搜索 `GET /symbols/search` | ✅ 已实现（8-06 实测 200） | **P0** | 单体符号搜索（前端"添加自选/搜索交易对"） | 实测已通；请核对 seed 表 SPY/QQQ 已补（AItrader 侧已更新 market_symbols_seed.py） |
| **DS-10** | `/snapshots` 补齐 `commodities`/`forex_pairs`/`market_overview` | ✅ 已实现（8-06 实测三类型全 200） | P1 | 单体全局市场页"商品/外汇/顶部概览"板块 | 已通，无需处理 |
| **DS-11** | `/symbol/resolve` 多市场覆盖确认 | ⚠️ 新路径 `/api/data/symbol/resolve` 已通（旧 `/api/v1/symbol/resolve` 已废） | P1 | 单体 `symbol_name.py` 跨市场名称解析（crypto/美股/外汇/期货/A股/港股） | **决策点仍待确认**：覆盖范围？若仅 crypto，AItrader 侧保留非 crypto 本地降级 |
| **DS-12** | 入站鉴权 `X-Service-Key`（`/health` 豁免） | ✅ 已实现（8-06 实测无 key 401） | P1 | 生产安全 | 已通，无需处理 |

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

---

## 6. AItrader 侧 2026-08-06 联调回执

### 6.1 线上契约实测（B 端 43.163.105.172 已部署版本）

| 端点 | 结果 |
|---|---|
| `/health` | ✅ 200 |
| `/bars`（1m/1h） | ✅ 有真实数据含全套技术指标 |
| `/ticker`（BTC spot+swap、SPY） | ✅ 全字段返回 |
| `/symbols/search` | ✅ 200 |
| `/snapshots`（commodities/forex_pairs/market_overview） | ✅ 全 200 |
| 无 key 请求 | ✅ 401 |
| 旧 `/api/v1/symbol/resolve` | ❌ 已废（新路径 `/api/data/symbol/resolve`） |

### 6.2 剩余缺口（请 B 端处理）

| # | 缺口 | 说明 |
|---|---|---|
| 1 | **crypto 1D / ETH 日线 count:0** | DS-8 要求 1D≥3 年；AItrader 侧已配置 `KL_BACKFILL_DAYS={"1m":30,"1d":1095}` 示例，请 B 端启用历史回填并验证 |
| 2 | **EUR/USD ticker 404** | 外汇符号映射（yfinance `EURUSD=X` ↔ 展示 `EUR/USD`），DS-7 覆盖缺口 |
| 3 | **`/factors/history` 因子列 NULL** | backtest 因子注入（C2-8）依赖历史因子序列，当前仅技术因子且列值 NULL，宏观/情绪历史序列待补齐 |
| 4 | **多市场分钟级 K 线** | 美股/外汇/期货/A股/港股采集器当前仅落 1d；timeframes 目标已写入 data_config.json（15m/1h/4h/1d），分钟级采集待扩展 |

### 6.3 数据列表更新（2026-08-06，随本清单同批推送）

- `data_config.json`：crypto 补 30m；美股补 SPY/QQQ（12 只）；外汇 7 对、A股 6 只；各市场 timeframes 对齐 DS-8 深度表；新增 `crypto_swap` 段（BTC/ETH/SOL 永续）
- `.env.example`：`KL_TIMEFRAMES=1m,5m,15m,30m,1h,4h,1d`（原仅 1m）+ 启用 `FACTORS_CONFIG_PATH=factors.json`；远端 `KL_BACKFILL_DAYS`/`KL_SWAP_*` 配置已保留合并
- `factors.json`：结构说明（内置 18 因子已覆盖 C2-8 需要，extra 暂空）
- `market_symbols_seed.py`：美股 seed 补 SPY/QQQ
