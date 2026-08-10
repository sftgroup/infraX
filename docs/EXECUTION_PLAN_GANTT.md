# InfraX 数据栈 — 待办事项执行计划甘特图

- **生成日期**：2026-08-06
- **基线假设**：9.6 PRD 于 2026-08-07 审阅通过，实施自 2026-08-10（周一）启动；外部阻塞项（yfinance 限流 / Tushare 积分）以「待解锁」标注，解锁后按前置顺序插入（PyPI token 已于 2026-08-11 解锁，T1 完成）
- **来源**：`docs/DELIVERY_SUMMARY.md` §三 待办事项 + `docs/infrax_tasklist.md` §9.6 排期

---

## 一、待办概览（7 项）

| # | 待办 | 预估工期 | 前置条件 | 阻塞 | 责任人建议 |
|:---:|---|---|---|---|---|
| T1 | ~~PyPI 发布 lightrag-client 2.0.0~~ | ✅ 已完成 | ✅ 2026-08-11 发布（lightrag-client 2.0.0 + infra-data-client 0.2.0，pypi.org 验证通过） | ~~PyPI API token~~ 已解锁 | 后端 |
| T2 | 9.6 排期实施（Phase 1/2/3 剩余） | 21d（PRD 基线） | PRD 审阅通过；Phase 2 需 TEE 环境 | TEE 环境审批（2.1） | 后端 + 安全 |
| T3 | yfinance 限流解除后恢复外汇 | 1.5d | 数据源恢复 | **yfinance 限流** | 数据 |
| T4 | MONITOR_API_KEY 轮换 | 0.2d | 无 | 无（按需） | 运维 |
| T5 | data 限流配额调整（RATE_LIMIT_RPM） | 0.2d | 无 | 无（按需） | 后端 |
| T6 | Tushare 积分提升 | —（3d 验证） | 账号积分达标 | **Tushare 积分审核** | 数据 |
| T7 | SDK 增加 DataAPI 类封装（data 数据面） | 1d | 无（OpenAPI 契约已就绪） | 无（可并行） | 后端 |

---

## 二、Mermaid 甘特图（建议基线）

```mermaid
gantt
    title InfraX 数据栈待办执行计划（基线 2026-08-10 启动）
    dateFormat YYYY-MM-DD
    axisFormat %m-%d

    section 前置与运维
    9.6 PRD 审阅            :prd, 2026-08-07, 1d
    T4 MONITOR_API_KEY 轮换  :t4, 2026-08-10, 0.2d
    T5 data 限流配额调整     :t5, 2026-08-10, 0.2d
    T7 SDK DataAPI 封装      :t7, 2026-08-10, 1d

    section T1 PyPI 发布（✅ 已完成 2026-08-11）
    PyPI 发布（lightrag-client + infra-data-client） :p1, done, 2026-08-11, 0d

    section T2 Phase1 DC 数据强化
    event_categories 表     :d1, after prd, 1d
    events 加 category 列   :d2, after d1, 0.5d
    collector 分类逻辑      :d3, after d2, 2d
    dc-index v2（+2 tools） :d4, after d3, 2d
    DC API v3               :d5, after d3, 2d

    section T2 Phase2 TEE 钱包（待环境）
    TEE Enclave 环境搭建    :e1, after d4, 2d
    MPC API 切 TEE          :e2, after e1, 3d
    tee-index（改名+swap）  :e3, after e2, 2d

    section T2 Phase3 SkillHub 发布
    OpenAPI 3.1 自动生成    :s2, after e3, 1d
    ClawHub 发布            :s3, after s2, 0.5d
    MCP Hub 注册            :s4, after s2, 0.5d
    其他市场适配            :s5, after s3, 1d

    section T3 外汇恢复（待限流解除）
    yfinance 限流解除       :y1, 2026-08-10, 1d
    外汇种子回填            :y2, after y1, 0.5d

    section T6 Tushare 积分（外部阻塞）
    Tushare 积分提升        :u1, 2026-09-01, 3d
```

> 说明：Mermaid 图中未完成项为「假设性基线」；2.4/2.5/3.1（hub-index/SKILL/mcp-config）已在 G-5 完成，故从 Phase 3 仅保留 3.2~3.5。TEE（2.1~2.3）与 DC 强化（1.x）无硬依赖，若 TEE 环境提前到位可并行（见关键路径）。

---

## 三、ASCII 甘特图

```
2026-08   07 10 11 12 13 14    17 18 19 20 21    24 25 26 27 28   (月/日)
T2-9.6 PRD ▓▓(07)
T4 轮换      ▒
T5 限流      ▒
T7 SDK DataAPI ▓▓
T1 PyPI     ◌▓▓(token)  ——待解锁——
T2-P1.1 分类表      ▓▓
T2-P1.2 加列         ▓
T2-P1.3 collector   ▓▓▓▓
T2-P1.4 dc-index v2      ▓▓▓▓
T2-P1.5 DC API v3         ▓▓▓▓
T2-P2.1 TEE 环境 ◌──────── 待环境审批 ────────── ▓▓
T2-P2.2 MPC 切 TEE                             ▓▓▓▓▓▓
T2-P2.3 tee-index                               ▓▓▓▓
T2-P3.2 OpenAPI 3.1                               ▓▓
T2-P3.3/3.4 发布                                    ▓
T2-P3.5 市场适配                                     ▓▓
T3 外汇      ◌▓(限流)  ——待 yfinance 恢复——
T6 Tushare  ◌  ——待积分审核——（9 月起）
```

图例：`▓`=实施 `▒`=当日运维 `◌`=等待外部解锁（无固定工期）`▓▓`=1 天

---

## 四、关键路径与依赖

```
关键路径：PRD 审阅 → P1.1 → P1.2 → P1.3 → [P1.4 并行 P1.5]
           → P2.1(TEE) → P2.2 → P2.3 → P3.2 → P3.3/3.4 → P3.5
最长链条：约 16.5d 实施（8/10 启动 → 8/28 结束），另加 TEE 环境审批等待期
```

| 依赖规则 | 说明 |
|---|---|
| P1.1→1.2→1.3 | 分类表 → 表结构 → 分类逻辑（数据前置） |
| 1.4 ∥ 1.5 | dc-index 扩展与 API v3 均在 1.3 后可并行 |
| 2.1→2.2→2.3 | TEE 环境 → MPC 切换 → tee-index 索引 |
| 2.x 相对 1.x | 无硬依赖；2.1 TEE 环境可提前并行申请，缩短总工期 |
| 3.2→3.3/3.4 | OpenAPI 生成（依赖已完成的 hub-index）→ 平台发布；3.5 在 3.3 后 |
| T1 ∥ T3 | PyPI 与外汇均只依赖外部解锁，解锁即可独立插入，不占关键路径 |
| T7 ∥ 其余 | SDK DataAPI 封装仅依赖已上线的 OpenAPI 契约（/openapi.json 16 路径），可并行实施，不占关键路径 |

## 五、风险与提示

1. **TEE 环境审批**（P2.1）是 9.6 关键路径上唯一外部依赖，建议立即发起环境申请与 PRD 审阅并行
2. **yfinance / Tushare 积分**两个外部阻塞可随时解锁插入（T1 PyPI 已于 2026-08-11 完成发布：lightrag-client 2.0.0 + infra-data-client 0.2.0）
3. 若 T2 整体排期推迟，T4/T5 运维项（各 0.2d）可先行消化，不影响主路径
