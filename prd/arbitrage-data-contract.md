# Arbitrage 平台 · InfraX 数据契约确认（v1.0）

> 本文件为《Arbitrage 数据服务需求文档》（`prd/arbitrage-data-requirements.md`）**§7 开放问题的定稿回复**。
> 三个开放问题由 **InfraX 侧确定通用契约**，Arbitrage 平台按本方方案接入，不再等待对方逐项确认。
> 日期：2026-08-19 ｜ 状态：✅ 全部字段经公网生产实测

---

## 0. 通用接入约定（对齐 PRD §5 / §6.1）

| 项 | 约定 |
|---|---|
| Base URL | `https://infrax.0xainet.top/api/data` |
| 鉴权 | `X-Service-Key: <dx_* key>`（等价头：`Authorization: Bearer <key>` / `X-API-Key: <key>`，三选一） |
| 租户 key | 已签发（label=`arbitrage`，600 次/分）；明文仅签发时可见，登记见 `PRODUCTION_CREDENTIALS` §8 |
| 超时 / 重试 | 单次 ≤ 5s；429 限流指数退避重试 ≤ 2 次（同 PRD §5） |
| 时间戳 | 一律 **unix 毫秒（UTC）** |
| 可选信封 | 请求带 `?envelope=1` 或 `X-Envelope: 1` → 响应包装为 `{code, message, data}` |
| 失败语义 | 401 → `{"code":401,"message":"unauthorized","data":null}`；缺字段/超时按 PRD §1 fail-silent 降级 |

---

## 0.1 因子端口全景（勿只认 `/factors/catalog`）

| 端口 | 内容 | 用途 |
|---|---|---|
| `/factors/catalog` | **固定因子目录 49 个**（31 内置/ML + 18 graph，静态） | 字段名 / 单位 / 取值范围查阅 |
| `/factors/current` | **最新因子值**（category 过滤）；附 `ml_factory`（挖掘因子）、`graph`、`_complex`（news / put_call_ratio） | 实时展示 / 决策 |
| `/factors/history` | 逐 bar 因子时序（对齐 /bars ts） | 回测 |
| `/factors/graph` + `/factors/graph/edges` | 语义图谱因子（gf_*）+ 相关性图边 | 图谱联动 / 传导分析 |
| `/ml/predictions` | ML 预测快照明细（model=bolt/moirai/timesfm） | 模型明细核对 |
| 因子工厂 MCP（:3014）/ `/factor-factory/*` | 挖掘任务编排（start/status/result/list/cancel） | 因子挖掘（平台侧） |

> ⚠️ **因子工厂挖掘因子不在 `/factors/catalog`**（catalog 只含内置/ML/graph 固定因子）：激活因子列表与实时值一律走 `/factors/current` 的 `ml_factory`（`factors`=激活列表、`values`=各 symbol 实时值，随每日挖掘动态增减）。

---

## 1. 开放问题 1：新闻标题流 —— ✅ 我方提供

**非仅情绪因子，提供真实标题/摘要列表**（替换 B 端 mock）。

端点：

```
GET /factors/current?symbols=BTC&category=news
```

返回（`factors._complex.news`）：

```json
{
  "items": [
    {
      "title": "Live Coverage: 2026 Pro Farmer Crop Tour kicks off after record rainfall…",
      "link": "https://www.profarmer.com/news/live/live-coverage-2026-pro-farmer-crop-tour-…",
      "snippet": "Follow along as scouts pull thousands of corn and soybean samples across …",
      "source": "Pro Farmer",
      "published": "2026-08-19T…",
      "category": "…",
      "lang": "en"
    }
  ],
  "fetched_at": 1787092916347
}
```

| 字段 | 说明 |
|---|---|
| `title` | 标题 |
| `link` | 原文链接 |
| `snippet` | 摘要（≤ ~200 字符） |
| `source` | 来源媒体 |
| `published` | 发布时间 |
| `category` / `lang` | 分类 / 语言 |

- **更新频率**：分钟级（新闻采集器实时入库，NewsAPI + moomoo 多源）
- **数量**：当前 109 条滚动（生产实测），B 端按时间倒序取最新即可
- **注意**：新闻为**全局新闻池**，非按 symbol 严格过滤；按 symbol 的情绪标量请用 `sentiment_score`（-1~1，见 §4）

---

## 2. 开放问题 2：ML 因子扩展 —— ✅ 我方提供

`category=ml` 返回 **21 个 symbol 维度字段**（10 ML 因子 + 11 技术指标），另附因子工厂实时因子。

端点：

```
GET /factors/current?symbols=BTC,ETH,SOL&category=ml
```

**symbol 维度字段清单**：

| 分组 | 字段 |
|---|---|
| ML 方向/概率 | `tree_direction`(1/0/-1)、`tree_prob_up`(0-1)、`finbert_sentiment`(-1~1)、`consensus_score`(0-1)、`bolt_direction`、`bolt_prob_up`、`moirai_direction`、`moirai_prob_up`、`timesfm_direction`、`timesfm_prob_up` |
| 技术指标 | `rsi_14`、`macd`、`macd_signal`、`macd_hist`、`bb_upper`、`bb_middle`、`bb_lower`、`atr_14`、`ma_5`、`ma_10`、`ma_20` |

**多周期动量/波动率因子（因子工厂 ml_factory，每日自动挖掘）**：响应 `ml_factory.factors` 为当前**激活因子列表**，`ml_factory.values` 为各 symbol 实时值：

```json
"ml_factory": {
  "updated_at": 1787093638975,
  "factors": ["mom_10_30", "mom_20_60", "mom_5_20", "ret_1", "ret_10", "ret_20",
              "ret_3", "ret_5", "ret_60", "vol_20"],
  "values": { "BTC": { "mom_10_30": -0.00368973, "ret_1": 0.00142363, "vol_20": 0.01123626 } }
}
```

- 激活因子清单会随每日挖掘/IC 评估**动态增减**——B 端按 `ml_factory.factors` 动态渲染，勿硬编码
- **更新频率**：ML 预测分钟级 ~ 日更；技术指标随 bar；ml_factory 60s 级
- **category 聚合行为**：category 决定拉取哪些因子，但响应 symbol 维度为**并集**（外部 + 技术 + ML 同时返回）——B 端按需取字段，忽略多余字段即可

---

## 3. 开放问题 3：bars crypto —— ✅ 我方可用

```
GET /bars?symbol=BTC/USDT&timeframe=1D&market_type=spot|swap&start=&end=&limit=
```

- **crypto 可用**：`BTC/USDT` 等全部 20 对，`market_type=spot|swap` 双市场
- **支持 7 个 timeframe**（大小写不敏感），生产实测覆盖：

| timeframe | 覆盖区间 | timeframe | 覆盖区间 |
|---|---|---|---|
| `1m` | ≥30 天 | `1h` | ≥1 年 |
| `5m` | ≥180 天 | `4h` | ≥1 年 |
| `15m` | ≥180 天 | `1D` | ≥3 年 |
| `30m` | ≥180 天 | | |

- 返回每根 bar：`ts, open, high, low, close, volume` + 11 技术指标（同 §2）+ 最近外部因子 join（vix/dxy/us10y 等）
- **分页**：单次 `limit ≤ 5000`；`start=0` 首拉最旧 5000 根，以返回最大 `ts` 为下一次 `start` 循环，直到返回 <5000 根

---

## 4. 字段归一化差异（B 端适配要点）

| PRD §3 期望 | 实际契约 | 适配 |
|---|---|---|
| `put_call`（数值+interpretation） | `_complex.put_call_ratio`：`{value, vix, vix3m, change, level, signal, interpretation, interpretation_en}` | 取 `put_call_ratio.value` 为数值；`interpretation_en` 为英文解读（`interpretation` 为中文） |
| PRD §3 样例 `{BTC: {...}}` 平铺 | 实际完整响应 `{ts, meta, factors: {SYMBOL: {...}, _complex: {...}}, ml_factory?}` | 取 `factors[SYMBOL]`；`.factors` 顶层即为按 symbol 聚合 |
| `category=external` 期望 8 字段 | 返回外部因子 + 技术指标 + ML 并集 | 按字段名取用，忽略多余 |
| 时间戳 | 一律 unix ms | PRD §2.4 `timestamp` 按 ms 解析 |

---

## 5. 交付验收对照（PRD §6）

| PRD 联调顺序 | 端点 | 实测状态（2026-08-19，`dx_7ee2…` key） |
|---|---|---|
| ① | `/factors/current?category=external` | ✅ 200：8 外部字段 + `put_call_ratio` 完整解读 |
| ① | `/factors/current?category=ml` | ✅ 200：21 字段 + ml_factory 10 因子实时值 |
| ① | `/factors/current?category=news` | ✅ 200：`_complex.news` 109 条标题流 |
| ② | `/snapshots?type=calendar` | ✅ 200（FRED/Finnhub/moomoo 多源真实事件） |
| ③ | `/snapshots?type=indices|tvl|crypto_prices|earnings|heatmap` | ✅ 200 |
| ④ | `/bars`（spot/swap × 7 timeframe） | ✅ 200 全通 |
