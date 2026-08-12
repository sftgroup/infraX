# 需求文档 6：因子工厂（Factor Factory）— InfraX ml-service 因子引擎

> 需求方：Steven ｜ 归档：**InfraX** ｜ 日期：2026-08-09 ｜ 状态：待开发
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

- [ ] 因子从硬编码14个升级为可挖掘/评估/管理
- [ ] 合格因子自动登记 catalog 并在 data-service `/factors/current` 可见
- [ ] AItrader factor_client 无改动即可消费新因子（全量透传）
- [ ] 支持对话驱动挖掘（偏好+限制）
- [ ] 现有 `/ml/*` 预测端点不受影响

---

*相关文档：〔需求5 自动寻找因子〕 · 〔需求4 ml-service 架构优化〕 · 〔策略工厂〕*
