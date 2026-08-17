# B 端数据服务（infraX）需求清单

- 日期：2026-08-17
- 接收方：B 端数据服务（infraX，43.163.105.172）
- 来源：生产环境全量测试（28 用例）+ 市场状态页数据排查

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

## 二、待处理需求

### REQ-1【高】K 线数据整体缺失（/bars 全周期 count:0）

- **现象**（2026-08-17 复测）：`GET /api/data/bars` 返回 `count: 0, bars: []`（HTTP 200 但无数据），**BTC/USDC 与 ETH/USDC 全部周期**均如此——15m/1H/4H/1D/1W（含正确格式 `1h/4h/1d`）全部 `count: 0`。比此前发现的"仅 ETH 1D 缺失"范围更大，疑似 kline 采集/落库链路整体中断或数据被清。
- **影响**（AIHunter 侧）：`/api/market-data/bars` 透传接口、MCP `get_market_data` 的 K 线部分为空；依赖 B 端 K 线的策略回测（1D/4H 周期）无法取数。
- **期望**：恢复 kline 采集，BTC/ETH 各周期至少 500 根（1D 约 2 年）。
- **验收**：`count >= 500` 且 `bars` 非空；连续 5 次采样（间隔 1h）均稳定。

### REQ-2【中】热力图覆盖扩展：crypto-only → 全市场

- **现状**：`heatmap` 仅覆盖加密货币（8 类板块、每类 30 个 token，CoinGecko 免费源，30 req/min 限额）。
- **原因**：生成器注释明确 Yahoo/Finnhub/Stooq 无 key 不可靠，故降级 crypto-only；但 `.env` 已配置 `FINNHUB_API_KEY` / `TWELVE_DATA_API_KEY` / `ALPHA_VANTAGE_KEY`，未在 heatmap 中启用。
- **期望**：
  1. 启用已配置的付费源，补齐**股票 / 外汇 / 大宗商品**热力图板块（或明确本期不在范围内，给出排期）；
  2. 加密板块 token 上限从每类 30 提升至 50+（配合付费源限额）。
- **验收**：`heatmap` 快照出现 `stocks` / `fx` / `commodities` 分类（若列入范围）；每类 token 数量达标。

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
| 1.1 | /snapshots 截断修复正式合入 | 高 | 已修复，待合入 |
| REQ-1 | K 线数据整体缺失（/bars 全周期 count:0） | 高 | 待处理 |
| REQ-2 | 热力图全市场覆盖（付费源启用） | 中 | 待处理 |
