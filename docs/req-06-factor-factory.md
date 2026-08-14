# 需求文档 6：因子工厂（Factor Factory）— InfraX ml-service 因子引擎

> 需求方：Steven ｜ 归档：**InfraX** ｜ 日期：2026-08-09 ｜ 状态：✅ 已实现（2026-08-14；挖掘/评估/管理/入库链路生产就绪，FF-4.1 定时挖掘、R5-4 LLM 意图解析；落地明细见 `infrax_tasklist.md §9.15` 与 `DATA_SERVICE_CATALOG.md §3.4`）
> 定位：**优化 InfraX 的 ml-service / data-service 因子链路，构建「因子工厂」**：负责因子挖掘、评估、管理、入库，并把合格因子提供给 data-service `/factors/current`（供下游如 AItrader 策略工厂消费）。
> 承接：〔需求5 自动寻找因子〕（对话+偏好限制）作为因子挖掘的入口；〔需求4 ml-service 架构优化〕的 Provider/因子工程解耦。

---

## 1. 现状核实（基于运行代码）

| 组件 | 现状 | 角色 |
|------|------|------|
| **ml-service**(:9120) | `/ml/*` 端点均为模型预测；因子硬编码于 `tree_models.build_features`（14因子） | 因子**生成/挖掘**（待优化） |
| **data-service**(:8765) | 经 InfraDataClient SDK 提供 `/factors/current`（AItrader `factor_client.py` 正在消费） | 因子**对外提供 API**（已存在，复用） |
| **AItrader factor_client** | 已按 symbol 拉取 `/factors/current`，TTL 缓存 + fail-silent | **下游消费**（已就绪） |

**当前缺口**：
- ml-service 因子是**硬编码 14 个**，无法挖掘新因子、无法评估淘汰
- 因子如何从 ml-service **进入 data-service /factors/current** 的链路尚未打通
- 无偏好/限制、无对话入口（需求5 解决）

---

## 2. 目标

构建「因子工厂」：把 ml-service 从"固定14因子"升级为**可挖掘、可评估、可管理、可入库**的因子引擎。

```plaintext
┌────────────────────────────────────────────────────────────┐
│  因子工厂 = ml-service 因子引擎（本需求）                    │
│  ├─ 因子挖掘（需求5 对话+偏好限制）                          │
│  │    factor_pool(模板展开100+) → factor_eval(IC/超额/稳定性) │
│  │    → 选因(top-K/去冗余) → 合格因子                        │
│  ├─ 因子管理（目录/版本/启停）                                │
│  └─ 因子入库（写入 data-service 的 factor 目录）              │
└──────────────────────────────────┬─────────────────────────┘
                                   │ 写入因子定义 + 计算值
┌──────────────────────────────────▼─────────────────────────┐
│  data-service /factors/current（复用，已存在）               │
│  因子 API → 供 AItrader 策略工厂等下游消费                    │
└────────────────────────────────────────────────────────────┘
```

---

## 3. 核心功能

### 3.1 因子挖掘（内核，承接需求5）
- `factor_pool.py`：从 L0–L6 因子模板 + 参数展开（100+）
- `factor_eval.py`：IC / 超额 / 单调性 / 独立度评估
- **选因**：top-K + 去冗余(独立度) + IC 淘汰
- 入口：需求5 的对话驱动（偏好 + 限制）或定时/手动

### 3.2 因子管理（目录/版本/启停）
- `factors_catalog.json` 或 DB：注册所有合格因子的**定义**（key、计算公式、数据源、窗口、版本）
- 因子**状态**：active / inactive（可启停）
- **版本**：因子口径变更时记录版本，避免下游用错

### 3.3 因子入库 → data-service `/factors/current`
- 合格因子的**计算逻辑**登记到 factor 目录
- 计算值由 data-service（或 ml-service 计算后推送）写入 `/factors/current` 响应
- **AItrader 无需改代码**：`factor_client` 默认全量透传 → 新因子自动可见（现有 `_filtered` 机制已支持）

### 3.4 与既有端点衔接
- ml-service 现有 `/ml/*` 预测端点不动
- 新增因子管理端点（见下）

---

## 4. 因子工厂 API / MCP

### 4.1 因子管理端点（ml-service 或 data-service）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/factors/catalog` | 因子目录（定义/状态/版本） |
| POST | `/factors/catalog` | 登记/更新因子定义 |
| POST | `/factors/{key}/activate|deactivate` | 启停因子 |
| GET | `/factors/current` | **对外因子值 API（复用已有）** |

### 4.2 对话入口（承接需求5 Factor-Factory MCP）

| tool | 说明 |
|------|------|
| `factor_factory.start(spec)` | 按偏好+限制启动挖掘 |
| `factor_factory.status(job_id)` | 进度/状态 |
| `factor_factory.result(job_id)` | 入选因子报告 |
| `factor_factory.publish(catalog)` | 入库 data-service `/factors/current` |

> 自动挖掘产出的合格因子，**自动登记进 catalog** 并可用，无需人工。

---

## 5. 工程化要求

- **状态机**：挖掘任务（CREATED→RUNNING→COMPLETED/FAILED）+ 可恢复（多轮对话续查）
- **因子版本化**：口径变更不静默覆盖
- **fail-silent**：data-service 不可用不崩（对齐现有机制）
- **硬限制**：偏好不越界（预算/数量/耗时受控，见需求5）
- **下游兼容**：新增因子对现有 `/factors/current` 消费方（AItrader factor_client）透明

---

## 6. 落地优先级

| 阶段 | 内容 | 依赖 |
|------|------|------|
| F1 | ml-service 因子引擎解耦（承接需求4：Provider/因子上收注册表） | 需求4 |
| F2 | factor_pool + factor_eval 内核（可评估选出合格因子） | F1 |
| F3 | 因子管理（catalog/版本/启停）+ 入库 data-service `/factors/current` | F2 |
| F4 | 对话驱动（需求5 MCP）+ 自动挖掘验证 | 需求5 |

---

## 7. 验收标准

- [x] 因子从硬编码14个升级为可挖掘/评估/管理
- [x] 合格因子自动登记 catalog 并在 data-service `/factors/current` 可见（FF-3.1/FF-3.3）
- [x] AItrader factor_client 无改动即可消费新因子（全量透传，`ml_factory` 字段）
- [x] 支持对话驱动挖掘（R5-4 LLM 意图解析 + 结构化偏好/限制）
- [x] 现有 `/ml/*` 预测端点不受影响

---

## 8. 实现与验证记录（2026-08-14 生产就绪）

### 8.1 R5-3：Factor-Factory MCP 服务（生产部署 ✅）

| 项 | 值 |
|---|---|
| 服务 | `infrax-factor-mcp`（systemd，tsx 直跑 `src/factor-index.ts`，WorkingDirectory `projects/mcp-server`） |
| 端口 | **3014**（内网；公网测试走 SSH 隧道） |
| 端点 | `GET /health`（豁免鉴权）；`POST /mcp/message`（MCP streamable HTTP，`enableJsonResponse`，**无状态会话**） |
| 入站鉴权 | `Authorization: Bearer` / `X-API-Key` / `X-Service-Key` 三选一；key=**MCP_API_KEY**（systemd override Environment，46 字符）或 data 签发 `mx_` key 实时校验；无 key `/mcp/*` → 401 |
| 出站 | `X-Service-Key`（ML_API_KEY bridge key）→ ml-service :9120 |
| 工具（5） | `factor_factory_start`（preferences/constraints 结构化 + `intent` 自然语言）/ `status` / `result` / `list` / `cancel` |

> **MCP 客户端调用要点**：请求头必须含 `Accept: application/json, text/event-stream`（MCP SDK 校验，否则 `-32000 Not Acceptable`）；`initialize`（protocolVersion 2025-03-26）→ `notifications/initialized` → `tools/call`。

### 8.2 R5-4：LLM 意图解析（生产配置 ✅）

- ml-service `.env`：`FACTOR_LLM_API_KEY`（复用 ragservicer `LLM_BINDING_API_KEY`，DeepSeek）+ `FACTOR_LLM_MODEL=deepseek-v4-flash`（host 默认 api.deepseek.com/v1，与 ragservicer 一致）
- 入口：`factor_factory_start` 传 `intent` → 走 `POST /factor-factory/mine`（LLM 解析自然语言 → 自动生成 JobSpec）→ 创建任务
- 实测：`"动量波动率 BTC ETH SOL 日线 5个 10分钟"` → job `ff_20260814_c10869320f9d` RUNNING→COMPLETED，result 返回 5 个候选因子（意图 spec 未带 `min_ic` 时不过滤质量，属预期）

### 8.3 完整工具测试记录（2026-08-14，全通过）

| # | 步骤 | 结果 |
|---|---|---|
| 1 | `initialize` | ✅ serverInfo `infrax-factor-mcp v1.0.0` / 2025-03-26 |
| 2 | `tools/list` | ✅ 5 工具全部注册 |
| 3 | `factor_factory_start`（结构化 constraints） | ✅ QUEUED |
| 4 | `factor_factory_status` | ✅ RUNNING → **COMPLETED**（stage persist） |
| 5 | `factor_factory_result` | ✅ 返回合格因子列表（IC/ICIR） |
| 6 | `factor_factory_list` | ✅ 历史任务可见（含自动挖掘 ff_20260814_*） |
| 7 | `factor_factory_start`（R5-4 intent） | ✅ LLM 解析 → RUNNING → COMPLETED |
| 8 | `factor_factory_cancel` | ✅ `cancelled:true` → status **CANCELLED**（修复后） |

### 8.4 修复的 Bug（commit 88d51ce）

- **问题**：`factor_factory_cancel` 以 **GET** 调 ml-service `/factor-factory/cancel`，但该端点定义为 `@app.post`（main.py:484）→ 恒 **405 Method Not Allowed**
- **修复**：`projects/mcp-server/src/factor-index.ts` cancel 改 `{ method: "POST" }`（job_id 仍走 query 参数）
- **验证**：typecheck ✅ → 生产重启 infrax-factor-mcp → start→cancel→`cancelled:true` → status `CANCELLED` ✅
- **ml-service 路由方法对照**（main.py）：`start`=POST / `status`·`result`·`list`=GET / `cancel`=POST；带 `intent` 的 start 走 `POST /factor-factory/mine`

### 8.5 相关生产配置

- 因子引擎：SQLite `factor_factory.db`（jobs/results/catalog 同库）；`FACTOR_EVAL_BARS=800`
- 定时挖掘（FF-4.1）：`FACTOR_MINER_SCHEDULE_ENABLED=true / INTERVAL_H=6 / DELAY_S=60 / SPEC=<JSON>`（单 worker + 有任务跳过 + 距上次终态 < interval 跳过）
- 透传：data-service `/factors/current` 响应附 `ml_factory` 字段（FF-3.3/3.4，60s TTL）：`{"updated_at": <ms>, "factors": [...], "values": {symbol: {factor_key: value}}}`——`values` 由 ml-service `GET /factors/values?symbols=` 按请求 symbols 实时计算（FF-3.4），客户端直接取 `ml_factory.values[symbol][factor_key]` 免复算公式；生产实测 `factors=["ret_1","ret_10","ret_20","ret_3","ret_5","vol_20"]`（commit c3e7f66）
- 衰退淘汰（FF-4.4）：挖掘任务 COMPLETED 后对 active 因子用**登记评估环境**（`register_qualified` 存入 params 的 asset_pool/horizon）重新评估，`abs(IC)<0.01 或 abs(ICIR)<0.03` 自动停用并记录 `[FF-4.4 decayed...]`；阈值 `FACTOR_MINER_DEACTIVATE_IC/ICIR/ENABLED` 可调，未登记环境（旧数据/动态池）跳过防误停

---

*相关文档：〔需求5 自动寻找因子〕 · 〔需求4 ml-service 架构优化〕 · 〔策略工厂〕*
