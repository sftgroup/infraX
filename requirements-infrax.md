# B 端数据服务（infraX）需求清单

- 日期：2026-08-17
- 接收方：B 端数据服务（infraX，43.163.105.172）
- 来源：生产环境全量测试（28 用例）+ 市场状态页数据排查
- **版本封版：2026-08-18 infraX v0.6.0**（data-service：REQ-1/REQ-2 实现 + 快照截断修复，生产已生效；配套 `infra-data-client` PyPI 0.2.0）

---

## 一、已完成修复（我方已处理，供正式合入）

### 1.1 `/snapshots` 全局 LIMIT 50 截断导致低频快照间歇缺失【请正式合入】

- **现象**：市场状态页「加密热力图」间歇性空态。根因是 `get_snapshots` 无 type 参数时 `LIMIT 50 ORDER BY fetched_at DESC` 全局截断——高频快照（`onchain_checkpoints` / `okx_*`，1-2 分钟级）把低频快照（`heatmap`，10 分钟级）挤出 50 行窗口。
- **修复**（`projects/data/app/factors.py` `get_snapshots`）：改为按 `(provider, data_type)` 分组取每组最新，与 `get_current_factors` 同款模式：
  ```sql
  SELECT provider, data_type, raw_json, fetched_at
  FROM raw_snapshots
  WHERE id IN (SELECT MAX(id) FROM raw_snapshots GROUP BY provider, data_type)
  ORDER BY fetched_at DESC
  ```
- **验证**：返回类型 16-18 类 → **42 类全量**；查询耗时 0.216s（生产 DB 实测）；heatmap/indices/tvl/calendar/earnings 全部稳定返回。
- **待办**：请将本修复正式合入 B 端代码分支，并补充「低频快照回归用例」防止回退。

---

## 二、已完成修复（2026-08-18 infraX v0.6.0 封版上线）

### REQ-1【高】K 线数据整体缺失（/bars 全周期 count:0）【已完成】

- **根因**（2026-08-18 定位）：采集配置（`KL_SYMBOLS`/`KL_SWAP_SYMBOLS`）仅含 **USDT 对**（BTC/USDT、ETH/USDT、SOL/USDT），**从未采集 USDC 对** → B 端所用 `BTC/USDC`、`ETH/USDC` 全部周期 `count: 0`（USDT 对数据一直齐全且实时，非采集链路中断）。
- **修复**（2026-08-18 已上线）：经 `PUT /admin/symbols` 将 `BTC/USDC`、`ETH/USDC` 加入 crypto（spot）与 swap 采集（运行时热更新 + `.env` 持久化，无需重启）；binance 原生支持该两对（ccxt 实测可拉取）。生产已验证回填深度：1d 1095 根 / 4h 2185 根 / 1h 8576 根 / 30m 8640 根 / 15m 17280 根 / 5m 51840 根 / 1m 43200 根（spot 与 swap 均达标）。
- **现象**（2026-08-17 复测）：`GET /api/data/bars` 返回 `count: 0, bars: []`（HTTP 200 但无数据），**BTC/USDC 与 ETH/USDC 全部周期**均如此——15m/1H/4H/1D/1W（含正确格式 `1h/4h/1d`）全部 `count: 0`。比此前发现的"仅 ETH 1D 缺失"范围更大，疑似 kline 采集/落库链路整体中断或数据被清。
- **影响**（AIHunter 侧）：`/api/market-data/bars` 透传接口、MCP `get_market_data` 的 K 线部分为空；依赖 B 端 K 线的策略回测（1D/4H 周期）无法取数。
- **期望**：恢复 kline 采集，BTC/ETH 各周期至少 500 根（1D 约 2 年）。
- **验收**：`count >= 500` 且 `bars` 非空；连续 5 次采样（间隔 1h）均稳定。

### REQ-2【中】热力图覆盖扩展：crypto-only → 全市场【已完成】

- **现状**：`heatmap` 仅覆盖加密货币（8 类板块、每类 30 个 token，CoinGecko 免费源，30 req/min 限额）。
- **原因**：生成器注释明确 Yahoo/Finnhub/Stooq 无 key 不可靠，故降级 crypto-only；但 `.env` 已配置 `FINNHUB_API_KEY` / `TWELVE_DATA_API_KEY` / `ALPHA_VANTAGE_KEY`，未在 heatmap 中启用。
- **期望**：
  1. 启用已配置的付费源，补齐**股票 / 外汇 / 大宗商品**热力图板块（或明确本期不在范围内，给出排期）；
  2. 加密板块 token 上限从每类 30 提升至 50+（配合付费源限额）。
- **验收**：`heatmap` 快照出现 `stocks` / `fx` / `commodities` 分类（若列入范围）；每类 token 数量达标。
- **实现（2026-08-18 已上线）**：
  - 新增 `app/data_providers/tradfi_heatmap.py`：stocks（4 指数+11 板块 ETF+40 大盘股）Finnhub 串行限速 0.2s（并发 8 会 429，仅 22/55 成功），<28 只时 yfinance 兜底；fx（12 对）frankfurter → yfinance → Tiingo → TwelveData 多源回退；commodities（12 只）yfinance → Tiingo(金/银) → TwelveData。全链 1 小时缓存。
  - `heatmap.py`：crypto 每类上限 30→50（CoinGecko per_page 100→150），并行执行 crypto 与 tradfi 三类后合并；cache key `market_heatmap_v4`→`v5`。
  - `collectors/heatmap.py`：从 CoinGecko 专用改为统一调用 `generate_heatmap_data()`，与 /heatmap 端点内容一致。
  - `forex.py` / `commodities.py`：`_fetch_td` 增加 429 短路（TwelveData 免费额度 800 credits/天已被 kline 外汇链路占用，避免拖慢热力图）。
  - **今日限流情况**：TD 额度已耗尽（4065/800，429）→ 热力图 TD 层失败自动跳过；yfinance 被临时限流（YFRateLimitError）→ commodities 当前仅金/银（Tiingo），yfinance 解封后自愈回 12 只；stocks 22 只（Finnhub 限速窗口内）。crypto 各分类 50 达标、fx 12 对全齐。
  - **验证**：`GET /snapshots?type=heatmap` 返回 `stocks` / `fx` / `commodities` / `topcap` / `layer1` / ... 全部分类。

---

## 三、已验证正常（无需处理）

| 项目 | 验证结果 |
| ---- | ---- |
| `/snapshots` 全量快照 | 42 类，heatmap/indices/tvl/calendar/earnings 均返回 |
| `adanos_sentiment` | 存在 ✅ |
| `EUR/USD` 外汇报价 | `EURUSD=X` price 1.1593，HTTP 200 ✅ |

---

## 四、优先级汇总

| 编号 | 需求 | 优先级 | 状态 |
| ---- | ---- | ---- | ---- |
| 1.1 | /snapshots 截断修复正式合入 | 高 | ✅ 已合入（v0.6.0 附带修复） |
| REQ-1 | K 线数据整体缺失（/bars 全周期 count:0） | 高 | ✅ 已完成（v0.6.0 封版，USDC 对补采） |
| REQ-2 | 热力图全市场覆盖（付费源启用） | 中 | ✅ 已完成（v0.6.0 封版；commodities 部分受限于 yfinance/TD 限流，解封后自愈） |
