# AItrader 中文新闻数据源补充需求（R-I2 收尾）

> 提交方：AItrader 客户端
> 日期：2026-08-20
> 关联：[AITRADER_I18N_DATA_REQ.md](./AITRADER_I18N_DATA_REQ.md) §3.2 / §4

infraX 同学好，R-I1~R-I4 已完成验收，其中 R-I3（`name_zh`）、R-I4（`reason` 结构化）均已生效。还剩 R-I2 有一个数据源缺口需要 B 端配合。

## 现状

`/snapshots?type=news&lang=zh` 的 lang 过滤机制已生效，但实测 `news` 与 `news_moomoo` 两个 bucket 的数据**全部为英文**（75 条同源 "QUICK SPARK" 类，`lang=en`）。AItrader 前端 zh-CN 界面下新闻流只能降级显示英文（已加 EN/ZH 徽标如实标注）。

## 请求

请补充**中文新闻数据源**，任选其一：

1. NewsAPI `language=zh` 抓取（`_API_LANG_MAP` 已支持 `zh`，确认 news collector 对 zh bucket 有稳定供给）
2. 接入 moomoo 中文站新闻源

## 说明

AItrader 侧链路（lang 过滤、不足降级、EN/ZH 徽标、`news_moomoo` 透传）已全部就绪，B 端中文数据到位即自动生效，无需 AItrader 再改代码。

## 验收标准

`/snapshots?type=news&lang=zh` 返回的 `items` 中标题为中文且 `lang=zh`（允许英文降级但 `lang` 字段如实标注）。
