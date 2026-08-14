# MooMoo 行情强化 infraX 数据栈 — 详细方案

> 状态：Draft ｜ 登记日期：2026-08-12 ｜ 需求源：用户调研指令（第 5 条）
> 任务状态统一登记于 `docs/infrax_tasklist.md` §9.14（本文件为方案契约，不维护状态）

## 1. 背景与动机

infraX data-service（:9112）当前多市场行情源依赖免费/受限渠道，存在三个痛点：

1. **美股 K 线依赖 yfinance**：生产 IP（新加坡腾讯云）常被 Yahoo 限流（429），`_collect_multi_market`
   中 US 1h/4h 周期频繁失败记 failed（见 [kline_store.py](../projects/data/app/kline_store.py)）；
2. **港股分钟级缺口**：仅腾讯日线（1d），`timeframes` 配置里分钟级直接跳过（"分钟级源待扩展"）；
3. **宏观/新闻依赖第三方 key**：FRED（`FRED_API_KEY`）+ NewsAPI（`NEWSAPI_API_KEY`），免费 tier
   配额有限，未配 key 时宏观历史/新闻采集整线程空转。

本方案引入 **moomoo OpenAPI**（平台账号登录 OpenD 网关，非传统 API key）作为高优先级数据源，
覆盖上述痛点，并在不影响现有降级链的前提下逐步接入。

## 2. moomoo 能力矩阵（账号 107803923，2026-08-12 实测）

| 数据类别 | 接口 | 实测结果 | 权限/额度 |
|---|---|---|---|
| 美股实时快照 | `get_market_snapshot` | ✅ AAPL/SPY/QQQ | US LV3（推广期免费）|
| 美股 K 线 | `request_history_kline` | ✅ 1m/5m/60m/日/周全通 | US LV3，历史K线额度 1000 |
| 港股实时快照/K线 | `get_market_snapshot` / `request_history_kline` | ✅ 00700 快照 + 5m K线 | HK LV1 |
| 加密快照 | `get_market_snapshot` | ✅ CC.BTCUSD | Crypto LV1 |
| 宏观指标列表 | `get_macro_indicator_list(region)` | ✅ US 24 / HK 12 / JP 19 / SG 15 / AU 15 / CA 13 / MY 15 | 无额外限制 |
| 宏观历史 | `get_macro_indicator_history` | ✅ 含 `predict_value`（一致预期）、`release_time` | 同上 |
| 新闻搜索 | `get_search_news(keyword, sub_type)` | ✅ Moomoo News/MT Newswires/Benzinga，含 url | 无额外限制 |
| 美股资金流 | `get_capital_flow` | ✅ 分钟级 super/big/mid/sml_in_flow | US LV3 |
| 股票基本信息 | `get_stock_basicinfo` | ✅ | US |
| 外汇 | — | ❌ `Unsupported quote market` | 无权限，不可用 |
| 全球股指指数（^GSPC 等）| — | ❌ USIndices Nopermission | 不可用 |
| A股 / 期货 | — | ❌ 无权限 | 不可用 |

**代码格式约定**：美股 `US.AAPL`、港股 `HK.00700`、加密 `CC.BTCUSD`；`request_history_kline`
返回 3 值 `(ret, data, page_req_key)`，`ktype` 传字符串（`K_5M`/`K_60M`/`K_DAY`），需显式传 `start/end`。

### 2.1 扩展数据类别（moomooapi skill 覆盖面，2026-08-12 拉取自 `opend-skills/moomooapi/`）

官方 skill（SKILL.md + docs/API_REFERENCE.md 65+ 接口 + scripts/quote 100+ 成品脚本）在 §2 基础之上
还覆盖以下数据类别。**多数依赖 US LV3 / HK LV1 权限（账号已具备），未逐一实测，接入前需按 §7 清单
在生产机验证权限**：

| 数据类别 | 代表接口/脚本 | infraX 现状 | 价值 |
|---|---|---|---|
| F10 基本面（财报/估值）| `get_financials_statements`/`get_research_analyst_consensus`/`get_valuation_detail` | Finnhub（依赖 key）| 免 key 补强 |
| 股东/机构持仓 | `get_shareholders_institutional`/`get_institution_holding_list` | 无 | 增量数据 |
| 内部人交易 | `get_insider_trade_list` | 无 | 增量数据 |
| 卖空数据 | `get_daily_short_volume`/`get_short_interest`/`get_short_selling_rank` | 无 | 增量数据 |
| ARK 持仓/交易 | `get_ark_fund_holding`/`get_ark_active_transaction` | 无 | 增量数据 |
| 日历 | `get_earnings_calendar`/`get_economic_calendar`/`get_dividend_calendar` | FRED/Finnhub/FOMC 静态 | 免 key 增强 |
| 榜单/热度/盘前盘后 | `get_hot_list`/`get_top_movers_rank`/`get_us_pre_market_rank`/`get_us_after_hours_rank`/`get_us_overnight_rank`/`get_period_change_rank` | 无 | 增量数据 |
| 热力图/涨跌分布 | `get_heat_map_data`/`get_rise_fall_distribution` | 仅 crypto CoinGecko 热力 | 美股热力增强 |
| 股票筛选 | `get_stock_filter`(V1)/`get_stock_screen`(V2 244+ 因子) | 无 | 自选池/候选池 |
| 板块/产业链 | `get_plate_list`/`get_industrial_chain_*` | 无 | 增量数据 |
| 期权数据 | `get_option_chain`/`get_option_volatility`/`get_option_underlying_*`（US Options LV1）| 无 | 增量数据 |
| 评级变动 | `get_rating_change` | 无 | 增量数据 |
| 预测市场 | `get_event_contract_*`（`EC.xxx` 二元合约）| 无 | 增量数据 |
| 用户自选/提醒 | `get_user_security`/`get_price_reminder` | 自选池内建 | 参考 |

## 3. 目标架构

```
   moomoo 平台账号 ──▶ OpenD（本地网关，127.0.0.1:11111，TCP 自研协议）
                              │
                              ▼
                    moomoo SDK (Python, 生产机安装)
                              │
              ┌───────────────┼───────────────────┐
              ▼               ▼                   ▼
      data-service      ml-service            knowledge-injector
   (MoomooDataSource   (Kronos 美股日K)      (宏观因子/新闻增强，边界见 §4.4)
    + macro/news 采集)
```

- **OpenD 为唯一对外数据管道**：生产机（43.163.105.172）systemd 常驻，stdin 走 FIFO
  供交互命令（短信验证码等），重启策略 + 健康检查。
- **data-service 侧**：新增 `MoomooDataSource` 实现既有 `BaseDataSource` 接口
  （`get_kline`/`get_ticker`），通过 `DataSourceFactory` 接入，**不改变调用方契约**；
  其余采集器（宏观/新闻）以独立 collector 形式接入，复用现有 `raw_snapshots`/`macro_history` 落库。
- **降级链不变**：moomoo 失败（OpenD 未启动/断连/额度耗尽）时自动回退现有源
  （yfinance/腾讯/Twelve Data/FRED/NewsAPI），**fail-silent**。

## 4. 分阶段实施方案

### 阶段一：OpenD 生产部署（前置依赖）

- [M-7] OpenD 生产机 systemd 化：`infrax-opend.service`（WorkingDirectory、FIFO stdin、
  `Restart=always`、健康检查脚本探活 11111 端口）；登录凭证（moomoo 号/密码）写入
  `/home/ubuntu/opend/OpenD.xml`（权限 600，**不入 git**，仓库保持占位/示例）。
- 验证：`get_market_snapshot(['US.SPY'])` 生产机直连通过。

### 阶段二：data-service K 线 / ticker 接入 moomoo（核心）

- [M-1] 新增 `projects/data/app/data_sources/moomoo.py`：
  - 实现 `BaseDataSource`：`get_kline`（符号映射 `AAPL → US.AAPL`、`00700 → HK.00700`，
    timeframe 映射 `1m/5m/15m/30m/1H→K_60M/4H→60m聚合/1D→K_DAY`）、`get_ticker`
    （`get_market_snapshot`）；
  - 连接池与重连（OpenD 断连自动重试）、短 TTL 缓存、fail-silent 降级；
  - 符号映射规则：`infer_market` 已能区分 usstock/hkstock（见 [ticker.py](../projects/data/app/ticker.py)）。
- [M-2] `kline_store._collect_multi_market` 接入：
  - US：`1h/4h` 由 moomoo（US LV3 稳定源）替代 yfinance（429 重灾区），`1d` 保留 akshare
    或切换 moomoo（对比验证后定）；失败回退 yfinance；
  - HK：补 `1m/5m/15m/1h` 分钟级（HK LV1 实测 5m 可用），`1d` 保留腾讯/切 moomoo 对比。
- [M-3] `/ticker` 回退链插入 moomoo：`usstock/hkstock` 第一优先 `get_market_snapshot`
  （实时性/稳定性优于 yfinance fast_info 与腾讯），失败再走现有链。

### 阶段三：宏观指标采集（FRED 的 moomoo 增强）

- [M-4] 新增 `app/collectors/moomoo_macro.py`：
  - `get_macro_indicator_list('US')` 拿到 indicator_id 列表 → `get_macro_indicator_history`，
    写 `macro_history` 表（series_id 用 `MM:US:CPI` 命名空间避免与 FRED 冲突），
    同时落 `raw_snapshots`（provider=`moomoo_macro`）；
  - 周期增量（间隔 6h 对齐 FRED 采集器）；**优势：含 `predict_value`（一致预期）与
    `release_time`（发布时间），FRED 无预测值**；
  - 与 FRED 并存：`/macro/history` 支持按源过滤，默认优先 moomoo、FRED 兜底。

### 阶段四：新闻采集增强（NewsAPI 的 moomoo 补充）

- [M-5] `app/collectors/news.py` 增加 moomoo 分支：`get_search_news`（NEWS/NOTICE/RATING）
  按配置关键词（默认自选池股票代码 + 市场关键字）抓取，写 `raw_snapshots`（provider=`news_moomoo`）；
  与 NewsAPI 并存（双源合并去重，`url` 幂等）；无 key 时 moomoo 作为主源（免 key）。

### 阶段五：ml-service 数据供给优化

- [M-6] Kronos 目标符号池（SPY/QQQ 等美股标的）的日 K 回填/增量改为经 data-service
  的 moomoo 路径（`get_kline` 已透传），消除 yfinance 429 导致的预测输入缺口。

### 阶段六：边界确认与可选增强

- [M-8]（可选 P2）美股资金流 `get_capital_flow` 落库 `raw_snapshots`（provider=`moomoo_capital_flow`），
  供 FinBERT/情绪因子/投研；`get_stock_basicinfo` 作为美股自选池候选。
- [M-9] knowledge-injector 边界：**指数保持 yfinance**（USIndices 无权限，不可替代）；
  宏观因子（VIX/DXY/US10Y）保持 CBOE/akshare/FRED 链（moomoo macro 只作宏观序列增强，
  不做实时因子替代）。
  - 2026-08-15 边界结论（登记，不动代码）：`knowledge-injector/providers/indices.py` 仍为 yfinance
    实现；`data/app/data_providers/indices.py` 为 Finnhub 主 + yfinance 兜底；moomoo 均未介入指数路径。
    `/macro/history?series=MM:US:CPI` 走 moomoo_macro 序列（含 predict_value），实时因子链未改。
- [M-10] 生产验证与文档：降级链演练（停 OpenD → 自动回退）、额度监控
  （订阅 1000/历史K线 1000）、`docs/` 更新。
  - 2026-08-15 验收：OpenD 掉线 → ticker 快速回退（AAPL 1.08s/00700 0.72s，yfinance/腾讯兜底）；
    恢复 → 自动回归 moomoo（0.05~0.25s）。核心修复：SDK 同步构造无限 6s 重试（曾致降级阻塞 195s）
    → `moomoo.py` 改 TCP 预检 + `is_async_connect=True` + `_sync_query_connect_timeout=5` + 死连接冷却。
    额度监控：`moomoo_extra.fetch_quota_status`（历史K线/订阅 used+remain，≥90% 告警）经
    `mm_quota` 组落库 `raw_snapshots`（provider=moomoo_quota，实测 used 17/983、订阅 0/1000）。

### 阶段七：moomooapi skill 复用与增量数据（2026-08-12 补充）

- **skill 位置**：`opend-skills/moomooapi/`（SKILL.md 入口 + docs/API_REFERENCE.md 65+ 接口全签名
  + docs/API_LIMITS.md 额度规则 + docs/FIELD_MAPPING.md + scripts/quote 100+ 成品脚本 + trade/subscribe）。
- **脚本即参考实现**：M-1 参考 `get_kline.py`/`get_snapshot.py`；M-4 参考
  `get_macro_indicator_list.py`/`get_macro_indicator_history.py`；M-5 参考 `get_search_news.py`；
  M-8 参考 `get_capital_flow.py`；增量采集器直接以 scripts/quote 下脚本为雏形改造成 collector。
- **增量数据任务**（MM-11~MM-15，见 tasklist §9.14）：F10 基本面/估值、卖空/机构/内部人/ARK、
  日历（earnings/economic/dividend）、榜单/热力/盘前盘后排名、股票筛选/板块产业链。
- **约束**：以上接口多数未实测权限，按 §7 清单先在生产机验证（US LV3/HK LV1 账号已具备）；
  预测市场（`EC.xxx`）、用户自选/提醒类以"研究性接入"对待，不阻塞主线。

## 5. 风险与约束

1. **账号合规**：OpenD 登录依赖平台账号 + 短信验证码 + 已完成的 API 合规问卷；
   账号凭证属敏感信息，**仅存生产机 OpenD.xml（600）**，不入 git。
2. **OpenD 单点**：行情网关是单进程，需 systemd 保活 + 健康检查；断开时全部 moomoo 路径降级。
3. **额度限制**：订阅额度 1000、历史K线额度 1000——K 线批量采集需控制并发/频率，必要时分页
   （`page_req_key`）与节流（复用现有 `_THROTTLE` 机制）。
4. **时区/交易日历**：moomoo K 线 `time_key` 为本地交易所时区，需转 UTC 对齐现有 `kline` 表 ts。
5. **不回退现有源**：所有改动为"插入优先级头部 + 失败降级"，存量源（yfinance/腾讯/FRED/NewsAPI）
   保留为兜底，保证 B 端零感知。

## 6. 验证方式

- 本地（开发机）：仅单测/typecheck；集成验证在生产机（43.163.105.172）执行，
  遵循「开发与测试分工」硬约束。
- 生产验收脚本（对标既有 E2E 风格）：
  - K 线：`GET /bars?market=usstock&symbol=AAPL&timeframe=1h&limit=200` 连续 7 天无 failed；
  - ticker：`GET /ticker?symbol=AAPL&market=usstock` 返回 moomoo 源（响应头/字段标记 source）；
  - 宏观：`GET /macro/history?series=MM:US:CPI` 含 predict_value；
  - 新闻：`GET /snapshots?provider=news_moomoo` 非空；
  - 降级：`systemctl stop infrax-opend` 后上述接口自动回退且不报错。

## 7. 数据盘点：moomoo 可用数据 vs infraX 现状（2026-08-12）

> 依据 `opend-skills/moomooapi/SKILL.md` + `docs/API_REFERENCE.md`（65+ 接口，MarketData 41 个）
> 对 infraX data 栈（`projects/data/app/`）逐类盘点。✅=已实测/现有能力；⚠️=未实测待验证；❌=权限不可用。

| # | moomoo 数据类别 | 代表接口 | 权限(实测/预期) | infraX 现状 | 结论 |
|---|---|---|---|---|---|
| 1 | 美股 K 线（1m~日）| `request_history_kline` | ✅ US LV3 | yfinance 1h/4h（常 429）| 已纳入 MM-1/2/6 |
| 2 | 港股 K 线（分钟级）| `request_history_kline` | ✅ HK LV1 | 仅腾讯日线 | 已纳入 MM-2 |
| 3 | 实时快照/quote | `get_market_snapshot` | ✅ US/HK | 腾讯/ccxt/yfinance 链 | 已纳入 MM-3 |
| 4 | 加密行情 | `get_market_snapshot` | ✅ Crypto LV1 | ccxt | 可选（不强求）|
| 5 | 资金流 | `get_capital_flow/distribution` | ✅ US 分钟级 | 无 | 已纳入 MM-8 |
| 6 | 宏观指标（含一致预期）| `get_macro_indicator_list/history` | ✅ 7 region 110+ 项 | FRED（无 predict_value）| 已纳入 MM-4 |
| 7 | 新闻 | `get_search_news` | ✅ 免 key | NewsAPI（依赖 key）| 已纳入 MM-5 |
| 8 | F10 财报/估值/评级 | `get_financials_*`/`get_research_*`/`get_valuation_*` | ⚠️ 预期 US/HK 可用 | Finnhub（依赖 key）| **新增** MM-11 |
| 9 | 卖空/机构/内部人/ARK | `get_short_interest`/`get_institution_*`/`get_insider_*`/`get_ark_*` | ⚠️ 预期 US 可用 | 无 | **新增** MM-12 |
| 10 | 日历（财报/经济/分红）| `get_earnings_calendar`/`get_economic_calendar`/`get_dividend_calendar` | ⚠️ 预期可用 | FRED/Finnhub/FOMC 静态 | **新增** MM-13 |
| 11 | 榜单/热度/盘前盘后/隔夜 | `get_hot_list`/`get_top_movers_rank`/`get_us_{pre,after,overnight}_rank`/`get_period_change_rank` | ⚠️ 预期 US 可用 | 无 | **新增** MM-14 |
| 12 | 热力图/涨跌分布 | `get_heat_map_data`/`get_rise_fall_distribution` | ⚠️ 预期 US/HK/CN | 仅 crypto CoinGecko | **新增** MM-14 |
| 13 | 股票筛选/板块/产业链 | `get_stock_screen`(V2)/`get_plate_*`/`get_industrial_chain_*` | ⚠️ 预期可用 | 无 | **新增** MM-15 |
| 14 | 期权数据 | `get_option_chain`/`get_option_volatility`/`get_option_underlying_*` | ⚠️ US Options LV1 | 无 | 候选（投研）|
| 15 | 预测市场（EC 二元合约）| `get_event_contract_*` | ⚠️ 未验证 | 无 | 研究性 |
| 16 | 自选/价格提醒 | `get_user_security`/`get_price_reminder` | ⚠️ 账号维度 | 自选池内建 | 参考 |
| 17 | 外汇 | — | ❌ `Unsupported quote market` | Twelve Data | 保持现状 |
| 18 | 全球股指指数 | — | ❌ USIndices 无权限 | yfinance（injector indices.py）| 保持现状 |
| 19 | A股/期货/日股/新马 | — | ❌ 无权限 | akshare/腾讯 | 保持现状 |

**结论**：moomoo 对 infraX 的增量价值集中在三块——① 行情主链路（美股/港股 K 线与 ticker，MM-1~3/6）；
② 宏观/新闻/资金流免 key 增强（MM-4/5/8）；③ **14 类 infraX 当前缺失的增量数据**（MM-11~15 及候选，
含 F10/卖空/机构/ARK/日历/榜单/期权/预测市场），均可在 MM-7（OpenD 生产部署）落地后按 §7 清单先验证权限再接入。
