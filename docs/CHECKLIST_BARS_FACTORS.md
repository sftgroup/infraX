# 端点契约核对表 —— data-service `/bars` 与 `/factors/*`

> **用途**：7.2 数据查询审查中 `/bars` 与 `/factors/*` 的契约明细核对表（勾选式）。
> **代码依据**：`projects/data/main.py`（路由 L125~L272）+ `projects/data/app/enrich.py` `query_bars` + `projects/data/app/factors.py`（`get_catalog`/`get_current_factors`/`get_history_factors`）。
> **关联**：tasklist §9.7-7.2（`docs/DEPLOYMENT_DATA_STACK.md`）。
> 状态标记：⬜ 待核对 ｜ ✅ 已核对 ｜ ⚠️ 发现差异

---

## 1. `GET /bars`（K 线主端点，OHLCV + 预计算指标 + 外部因子）

### 1.1 请求参数

| 参数 | 必填 | 类型 | 默认 | 约束 | 说明 |
|------|:---:|:---:|:---:|------|------|
| `symbol` | ✅ | str | — | — | 例 `BTC/USDT`；swap 时按 ccxt 惯例 `BTC/USDT:USDT` 存储键查询 |
| `timeframe` | — | str | `1m` | 文档描述 `1m/5m/15m/1h/4h/1D` | ⚠️ 描述含 `1D` 大写，与 `.env` 配置 `1d` 小写不一致，需核对存储键大小写归一 |
| `market_type` | — | str | `spot` | pattern `^(spot\|swap)$` | spot/swap 数据互不混淆（DS-8 方案 A） |
| `start` | — | int | null | unix **ms** | 含边界 `ts >= start` |
| `end` | — | int | null | unix **ms** | 含边界 `ts <= end` |
| `limit` | — | int | `500` | `1 ≤ limit ≤ 5000` | — |

### 1.2 响应结构

顶层：`{symbol, timeframe, market_type, count, bars}`；**时间戳单位为毫秒，bars 按 ts 升序**。

`bars[]` 元素字段：

| 字段 | 类型 | 说明 |
|------|:---:|------|
| `ts` | int | bar 时间戳（ms） |
| `open` / `high` / `low` / `close` / `volume` | float | OHLCV |
| `rsi_14` / `macd` / `macd_signal` / `macd_hist` | float | 技术指标（值为 None 时**省略**字段） |
| `bb_upper` / `bb_middle` / `bb_lower` | float | 布林带 |
| `atr_14` / `ma_5` / `ma_10` / `ma_20` | float | ATR / 均线 |
| 外部因子（如 `us10y` 等） | 任意 | 按**最近快照** join（`fetched_at <= ts` 最近者；全部晚于 bar 则用最新），字段名来自 raw_snapshots 顶层 key |

错误：内部异常 → `500 {"detail": "<msg>"}`（FastAPI 默认错误体，⚠️ 与其他服务 `{code,message,data}` 不一致）。

### 1.3 核对项

- [ ] ① `symbol` 输入接受 `BTC/USDT` 与 `BTCUSDT` 两种形式（`_normalize_kline_symbol` 归一化）实测
- [ ] ② `timeframe` 大小写：`1d` vs `1D` 查询一致性实测（存储键实际大小写）
- [ ] ③ `market_type=swap` 的 `BTC/USDT:USDT` 存储键查询实测
- [ ] ④ `start`/`end` 时间过滤边界（含端点）实测
- [ ] ⑤ `limit` 上界 5000 与默认 500 实测
- [ ] ⑥ 指标字段 None 省略行为实测（缺指标时 bar 是否缺字段）
- [ ] ⑦ 外部因子 join 的"最近快照"语义实测（bar 早于全部快照时行为）
- [ ] ⑧ 响应无 `code/message/data` 包装 —— 与 ragservicer/ml-service 统一结构的差异确认（联动 7.1-⑥）

### 1.4 实测记录（2026-08-05）

- ✅ `symbol=BTC/USDT&timeframe=5m&limit=2`：`count=2`，指标完整（rsi_14/macd/macd_hist/bb_*/atr_14/ma_*/us10y）
- ✅ `15m`/`30m`/`1h`/`4h` 全部出数（DS-8 分钟级覆盖闭环）

---

## 2. `GET /factors/catalog`（因子目录）

### 2.1 请求参数

无参数。

### 2.2 响应结构

`{factors: [{id, name, category, type, range}, ...]}`

| 字段 | 类型 | 说明 |
|------|:---:|------|
| `id` | str | 因子标识（如 `rsi_14`） |
| `name` | str | 显示名（如 `RSI(14)`） |
| `category` | str | `technical`/`macro`/`sentiment`/`onchain`/`external`（config extra 默认） |
| `type` | str | `float`/`int` |
| `range` | list\|null | `[min, max]` 或 null |

内置 18 项：technical 11（rsi_14/macd/macd_signal/macd_hist/bb_upper/bb_middle/bb_lower/atr_14/ma_5/ma_10/ma_20）+ macro 3（vix/dxy/us10y）+ sentiment 2（fear_greed/sentiment_score）+ onchain 2（btc_difficulty/btc_hashrate）；另加 `FACTORS_CONFIG_PATH` JSON `extra` 项。

### 2.3 核对项

- [ ] ① 目录共 18 项内置因子，与实际 /factors/current、/factors/history 可用因子一致
- [ ] ② `range` 值正确（rsi_14 [0,100]、fear_greed [0,100] int、atr_14 [0,∞]、us10y [0,10]、dxy [50,150]）
- [ ] ③ `FACTORS_CONFIG_PATH` 未配置时目录不含 extra 项
- [ ] ④ 目录字段与 `_CATEGORY_MAP` 分类映射一致（catalog.category vs current 的 category 过滤）

### 2.4 实测记录

- ⬜ 待实测（2026-08-05 未调用）

---

## 3. `GET /factors/current`（最新因子值）

### 3.1 请求参数

| 参数 | 必填 | 类型 | 默认 | 约束 | 说明 |
|------|:---:|:---:|:---:|------|------|
| `symbols` | — | str | `BTC` | 逗号分隔 | ⚠️ 默认裸 `BTC`（无市场后缀）；内部对 kline 符号做 `replace("/","").replace("USDT","")` 规范化，需核对语义 |
| `category` | — | str | null | ⚠️ 路由文档写 `external/heatmap/calendar/snapshot`，实现 `_CATEGORY_MAP` 实际支持 7 类 | external/sentiment/news/opportunities/heatmap/calendar/snapshot |

### 3.2 响应结构

`{ts, factors: {symbol: {fid: value}}, _complex?: {fid: raw}}`

- `ts`：最新快照 fetched_at（ms）
- `factors.<symbol>.<fid>`：简单数值因子（`_SIMPLE_FACTOR_IDS` = fear_greed/vix/dxy/us10y/btc_difficulty/sentiment_score）映射到每个目标 symbol，float 保留 6 位；技术因子从 kline 最新 bar 附加
- `_complex`（仅复杂数据时）：heatmap/calendar/snapshot 类原始结构，单 key 数据解包

### 3.3 核对项

- [ ] ① `symbols` 默认 `BTC` 与显式 `BTC/USDT` 的取值差异实测（技术因子归属 symbol 键）
- [ ] ② `category` 7 类过滤（external/sentiment/news/opportunities/heatmap/calendar/snapshot）各实测
- [ ] ③ `_SIMPLE_FACTOR_IDS` 简单因子值、6 位舍入实测
- [ ] ④ `_complex` 解包行为（单 key 数据 unwrap）实测
- [ ] ⑤ 空库时 `ts=0`、factors 仅含 symbol 空对象的行为实测
- [ ] ⑥ ⚠️ 路由 docstring 与 `_CATEGORY_MAP` 枚举不一致 —— 文档同步修正

### 3.4 实测记录

- ⬜ 待实测（2026-08-05 未调用）

---

## 4. `GET /factors/history`（逐 bar 因子时间序列）

### 4.1 请求参数

| 参数 | 必填 | 类型 | 默认 | 约束 | 说明 |
|------|:---:|:---:|:---:|------|------|
| `symbol` | ✅ | str | — | — | `BTC/USDT` 或 `BTCUSDT`；查不到时自动尝试基础符号（`split("/")[0]`） |
| `timeframe` | — | str | `1m` | — | 与 kline 存储键一致 |
| `ids` | — | str | null | 逗号分隔因子 id | 默认全部技术因子（_TECH_FACTORS 11 项） |
| `start` / `end` | — | int | null | unix **ms** | 含边界 |
| `limit` | — | int | `500` | `1 ≤ limit ≤ 5000`（内部 clamp） | — |

### 4.2 响应结构

`{symbol, timeframe, count, series: [{ts, fid: value, ...}, ...]}`

- `series[]`：每项 `{ts}` + 请求的 `ids`（默认 11 个技术因子）中非 None 字段；**ts 单位 ms，与 /bars 一致**
- 技术因子：`rsi_14/macd/macd_signal/macd_hist/bb_upper/bb_middle/bb_lower/atr_14/ma_5/ma_10/ma_20`

### 4.3 核对项

- [ ] ① 无数据时 `count=0`、`series=[]`（返回 200 而非 404）实测
- [ ] ② `ids` 过滤：仅返回请求因子字段，未知 id 忽略实测
- [ ] ③ symbol 无 `/` 数据时自动回退基础符号逻辑实测
- [ ] ④ 时间窗口 `start`/`end` 与 limit 组合分页行为实测
- [ ] ⑤ series 升序/降序与 /bars 一致性核对（`ORDER BY ts DESC` 后未反转，⚠️ 需实测确认）

### 4.4 实测记录

- ⬜ 待实测（2026-08-05 未调用）

---

## 5. 审查发现汇总（差距/待确认）

| # | 级别 | 发现 | 处理 |
|:---:|:---:|------|------|
| D1 | ⚠️ | `/bars` timeframe 文档描述 `1D`（大写）与 `.env` `1d`（小写）不一致 | 实测存储键大小写后修正文档或归一化 |
| D2 | ⚠️ | `/bars` 500 错误体为 FastAPI 默认 `{"detail":...}`，无 `{code,message,data}` 包装（data 数据面端点整体无统一包装） | 联动 7.1-⑥ 统一响应体核对 |
| D3 | ⚠️ | `/factors/current` docstring 仅列 4 类 category，实现支持 7 类 | 同步文档枚举 |
| D4 | ⚠️ | `/factors/history` `ORDER BY ts DESC` 后未反转，series 顺序待实测确认（与 /bars 升序不一致风险） | 实测后决定是否补反转 |
| D5 | ⚠️ | `/factors/current` 默认 `symbols=BTC` 与 kline 存储符号规范（BTC/USDT）语义差异 | 实测后明确调用方约定 |
| D6 | ℹ️ | swap 符号 `BTC/USDT:USDT` 存储键约定未在 OpenAPI/文档显式说明 | 补充文档 |
