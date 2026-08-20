# AItrader 多语言数据层残留问题与 B 端修复需求（2026-08-20）

> 提交方：AItrader 项目 ｜ 日期：2026-08-20
> 背景：AItrader 全站多语言国际化已完成（vue-i18n 10 种语言，前端静态/动态 i18n key 校验均缺失 0，生产已上线并浏览器双语验证通过）。**剩余残留全部集中在数据层**——B 端返回的数据字段值为单一语言（中文或英文原文），前端无法自行翻译。
> 状态标记：🔲 待 B 端 ｜ ✅ 已确认 ｜ ⚠️ 异常待修 ｜ 🛠 AItrader 侧已兜底

---

## 1. 概述

前端 UI 框架文案（菜单/页脚/卡片标题/状态与信号标签）已 100% 国际化，切换 zh-CN / en-US 均正常。但以下 **数据字段值** 仍为中英文夹杂：

| 序号 | 数据模块 | 残留现象 | 归属层 |
|---|---|---|---|
| I1 | 图谱实体（力导向图/语义图） | 实体名仅有中文（LightRAG 数据），`name_en` 缺失 → en-US 下仍显示中文 | **B 端 RAGservicer / knowledge-injector** |
| I2 | 实时新闻流 | zh-CN 下混入英文标题、en-US 下混入中文标题（未按语言过滤） | **B 端 data-service news + AItrader 链路参数** |
| I3 | 美股/港股公司名 | Apple Inc. / Tesla Inc. 等无中文名（zh-CN 下仍英文） | **B 端 symbol 元数据**（可选，低优先级） |
| I4 | 机会雷达 reason | B 端/AItrader 生成中文硬编码文案（en-US 下仍中文） | **AItrader analysis-service + B 端同构代码**（见 §3.4） |
| I5 | 市场解读卡片标点 | en-US 下拼接用中文顿号/逗号（`Crypto、Indices`） | AItrader 前端（可自修，见 §3.5） |
| I6 | 板块标签 CRYPTO/USSTOCK | 数据返回全大写 market 值，zh-CN 下显示英文 | 🛠 前端已兜底（建议 B 端规范枚举，见 §3.6） |

---

## 2. 需求总览（需 B 端评估）

| 编号 | 需求 | 优先级 |
|---|---|---|
| R-I1 | 图谱实体补 `name_en`（英文名），双语渲染 | P1 |
| R-I2 | news 接口支持 `lang` 参数按语言返回标题/摘要；确保返回内容语言与请求一致 | P1 |
| R-I3 | symbol 元数据补 `name_zh`（中文名） | P3 |
| R-I4 | opportunities 输出结构化 `reason`（`reason_key` + 参数）替代中文硬编码文案 | P1（AItrader 侧同步改造） |

---

## 3. 详细字段与修复建议

### 3.1 R-I1 图谱实体补 `name_en`（P1）

**涉及端点**：`GET /factors/graph/entities`（namespace=market）、`GET /factors/graph`（语义图因子）

**当前行为**：AItrader 前端图节点/语义标签已做兜底 `name_en || name || id`，但 B 端 LightRAG 存量实体多数**没有 `name_en` 字段**，导致 en-US 界面下实体名仍为中文（如 BTC 生态节点、事件实体）。

**AItrader 侧现状**（[graph-insight/index.vue](file:///home/steven/AItrader/frontend-full/src/views/graph-insight/index.vue)）：
- 力导向图节点展示：`nodes.forEach((n) => { nameMap[n.id] = n.name_en || n.id })`
- 实体标签：`e.name || e.entity`（语义图返回字段）

**B 端修复建议**：
1. knowledge-injector 注入实体文档时，为每个实体提供双语字段：
   - `name_zh`：中文名（已有，即现有 `name`）
   - `name_en`：英文名（缺失，需补——币种/标的可用 ticker 或官方英文名，事件实体可 LLM 翻译一次并缓存）
2. 存量文档（1000+ 篇 crypto:daily:*）批量回填 `name_en`（一次性脚本 + LLM 翻译，写回 RAG 存储）
3. `/factors/graph/entities` 响应中**确保每个实体都携带 `name_en`**（缺省时由服务端兜底为 ticker/英文名，不要空）

**验收标准**：
- en-US 界面图谱实体名全部为英文；zh-CN 界面为中文
- 实体接口 `name_en` 非空率 ≥ 95%

---

### 3.2 R-I2 新闻按语言返回（P1）

**涉及端点**：B 端 data-service news collector/provider（`app/collectors/news.py`、`app/data_providers/news.py`）；AItrader analysis-service `/api/global-market/news`、`/api/global-market/insights`

**当前行为**：
- B 端 news 已有 `lang` 字段（`_article_to_dict` 返回 `title/summary/source/lang`，qd_news_cache 表含 `lang` 列）
- 但 AItrader 前端全球市场页新闻流（`insights.news[]`）展示混合语言标题：zh-CN 下出现 4 条英文标题，en-US 下出现中文标题
- 根因：AItrader `/insights` 聚合时未按当前语言过滤（默认 `lang=all`）

**字段**：`title`（标题，原文语言）、`summary`/`snippet`（摘要）、`lang`（已有）、`source`

**B 端修复建议**：
1. 确认 `/snapshots?type=news` 支持 `lang` 过滤，且仅返回该语言的 `title/summary`（若某语言数据不足，允许降级返回英文并在 `lang` 字段如实标注实际语言）
2. news collector 保证各语言 bucket 都有稳定供给（NewsAPI 已按 `language` 参数抓取，建议按 lang 分别落库、分别查询）
3. 响应增加 `lang` 字段供下游判断（已有）

**AItrader 侧配合**（非 B 端）：
- `/insights` 与 `/news` 请求携带 `lang` 参数（对应前端当前 locale），不传 `all`

**验收标准**：
- `lang=en` 请求返回的 `title` 全部为英文；`lang=zh` 返回中文（允许英文降级但 `lang` 字段如实标注）

---

### 3.3 R-I3 symbol 中文名 `name_zh`（P3，可选）

**当前行为**：美股公司名（Apple Inc. / Tesla Inc. / Salesforce）为数据源原文（moomoo/finnhub/yahoo），zh-CN 界面下仍为英文。

**说明**：中文金融语境常保留英文公司名，此项优先级最低。若 B 端 symbol 元数据已有中文名（如富途/moomoo 数据源的 `name_cn`），建议在 `/symbols`、`/ticker`、自选股等响应中附带 `name_zh`，AItrader 前端按 locale 选择展示。

**字段建议**：`name_zh`（可选，缺失时前端 fallback 到 `name`）

---

### 3.4 R-I4 机会雷达 `reason` 结构化（P1）

**⚠️ 归属说明**：前端机会雷达（AI 资产分析页）数据来自 **AItrader analysis-service** `GET /api/global-market/opportunities`（[routes/global_market.py](file:///home/steven/AItrader/python-backend/app/routes/global_market.py#L348)），中文 `reason` 由 AItrader `app/data_providers/opportunities.py` 硬编码生成；**infraX data-service 的 `app/collectors/opportunities.py` 为同构代码**（同一算法来源），若该数据也被外部消费，建议同步。

**当前行为**：`reason` 为中文硬编码模板：

| 场景 | 当前 reason 示例（中文） |
|---|---|
| overbought | `24h涨幅8.3%，7日涨幅12.1%，短期超买风险` |
| bullish_momentum | `24h涨幅8.3%，上涨动能强劲` |
| oversold | `24h跌幅5.2%，可能超卖反弹` |
| bearish_momentum | `24h跌幅4.1%，下跌趋势明显` |
| 本地股盘整 | `宁德时代窄幅震荡(+0.1%)，等待方向选择` |

**字段**：`signal`（枚举，已结构化）、`strength`、`impact`、`reason`（中文硬编码）、`market`、`price`、`change_24h`

**修复建议（AItrader 侧将同步实施）**：
1. 输出**结构化 reason** 替代自然语言拼接，例如：
   ```json
   {
     "reason_key": "bullish_momentum",
     "params": { "change_24h": 8.3 },
     "reason": "24h涨幅8.3%，上涨动能强劲"
   }
   ```
   `reason` 保留为默认语言（zh-CN）原文保证兼容；新增 `reason_key` + `params` 供前端按 locale 渲染多语言文案
2. 前端已建立 `aiAssetAnalysis.opportunities.reason.{market}.{signal}` 的 i18n key 映射（[ai-asset-analysis/index.vue](file:///home/steven/AItrader/frontend-full/src/views/ai-asset-analysis/index.vue#L249) `getReasonText` 优先用 i18n key，缺失时 fallback `opp.reason`）——只要 B 端提供 `reason_key` 或标准 `signal`，前端即可全量多语言，不再 fallback 中文

---

## 4. 实施状态与验收反馈（2026-08-20）

| 需求 | 实施状态 | 验收反馈 |
|---|---|---|
| R-I1 图谱 `name_en` | B 端已实现（ragservicer `name_en_of` 纯 ASCII/数字实体兜底为自身） | AItrader 前端已兜底 `name_en \|\| name \|\| id`；**中文实体仍无 name_en**，建议按原方案用 ticker/LLM 翻译补齐非 ASCII 实体 |
| R-I2 news 按语言返回 | B 端已实现 `/snapshots?type=news&lang=`（news/news_moomoo 过滤，不足降级英文并标注 lang） | **实测 news 与 news_moomoo 均为英文**（75 条同源 "QUICK SPARK" 类，`lang=en`）；`lang=zh` 请求全部降级英文。**缺中文新闻数据源**，请补充（NewsAPI `language=zh` bucket 或 moomoo 中文站），AItrader 侧链路（lang 过滤/降级/EN-ZH 徽标）已全部就绪 |
| R-I3 symbol `name_zh` | B 端已实现（/symbols/search 输出 name_zh） | AItrader 已接入：seed 搜索按名称语言标注 `name_zh`/`name_en`，前端 3 处搜索（portfolio/QuickTradePanel/trading-assistant）按界面语言显示；生产实测 `600519→name_zh=贵州茅台`、`AAPL→name_en=Apple Inc.` ✅ |
| R-I4 opportunities `reason` 结构化 | B 端已实现（`reason_key` 仅 signal + `params.change_24h/change_7d`） | AItrader 已兼容双格式：本侧 `reason_key='crypto.overbought'`（含市场前缀），B 端 `reason_key='overbought'`，前端 `getReasonText` 均可正确渲染；生产实测机会雷达 reason 中/英文模板正确 ✅ |

**B 端配合项**：data-service `collectors/opportunities.py` 同构代码输出增加 `reason_key`/`params` 字段（如 B 端 `/snapshots?type=opportunities` 被外部使用）。

---

### 3.5 I5 市场解读卡片标点（非 B 端，AItrader 自修，附知）

**现象**：en-US 下市场解读卡片拼接出现中文顿号/逗号（`Crypto、Indices relatively strong，Broad rally`）。

**根因**：[global-market/index.vue](file:///home/steven/AItrader/frontend-full/src/views/global-market/index.vue) `regimeVerdictText()` 前端拼接多个市场名用中文顿号 `、`（`names.join('、')`），en-US 下未切换分隔符。

**修复**：AItrader 前端按当前 locale 选择分隔符（zh 用 `、`，其余用 `, `）。**无需 B 端改动**，此处仅为完整性记录。

---

### 3.6 I6 板块标签全大写枚举（建议 B 端规范）

**现象**：数据返回 `market` 值为全大写（`CRYPTO`/`USSTOCK`/`CNSTOCK`/`HKSTOCK`/`FOREX`），zh-CN 界面下直接渲染英文。

**AItrader 侧已兜底**（已上线）：
- [global-market/index.vue](file:///home/steven/AItrader/frontend-full/src/views/global-market/index.vue#L822) `marketLabels` 增加全大写变体映射
- [ai-asset-analysis/index.vue](file:///home/steven/AItrader/frontend-full/src/views/ai-asset-analysis/index.vue#L241) `getMarketLabel` 归一化全大写值

**B 端建议**（非阻塞）：统一 `market` 枚举为规范大小写（`Crypto`/`USStock`/`CNStock`/`HKStock`/`Forex`），或在响应中增加 `market_label`（本地化名）。AItrader 前端兜底可继续保留。

---

## 4. 建议的响应格式约定（供 B 端参考）

对「需按语言返回」的字段，B 端可按此约定，AItrader 前端无需再兜底：

```json
{
  "title": "Bitcoin ETF inflows hit record",   // 当前语言原文
  "lang": "en",                                 // 实际语言（允许降级时如实标注）
  "name_zh": "比特币",                          // 可选：中文名
  "name_en": "Bitcoin"                          // 可选：英文名
}
```

优先级：**接口传 `lang` 参数直接返回对应语言 > 双语字段（`name_zh`/`name_en`）> 结构化 key+参数由前端渲染**。

---

## 5. 验收清单

- [ ] R-I1：`/factors/graph/entities` 全部实体含 `name_en`，en-US 图谱页无中文实体名
- [ ] R-I2：`lang=en`/`lang=zh` 新闻接口返回对应语言标题
- [ ] R-I4：opportunities 输出含 `reason_key`/`params`，前端切换 en-US 后机会雷达描述为英文
- [ ] I6：market 枚举统一规范大小写（可选）

---

## 6. 附：AItrader 前端已完成的兜底（供 B 端对照，无需处理）

| 位置 | 兜底逻辑 |
|---|---|
| [global-market/index.vue](file:///home/steven/AItrader/frontend-full/src/views/global-market/index.vue) `marketLabels` | 全大写 market 值 → 本地化 |
| [ai-asset-analysis/index.vue](file:///home/steven/AItrader/frontend-full/src/views/ai-asset-analysis/index.vue) `getMarketLabel`/`getReasonText` | market/reason 归一化 + i18n fallback |
| [graph-insight/index.vue](file:///home/steven/AItrader/frontend-full/src/views/graph-insight/index.vue) | 节点/实体 `name_en || name || id` |
| 语言包 | 22 个动态 key（assetState*/regime*/aiAnalysisChart.* 等）+ 9 个 sector key 已补齐，静态+动态校验缺失 0 |
