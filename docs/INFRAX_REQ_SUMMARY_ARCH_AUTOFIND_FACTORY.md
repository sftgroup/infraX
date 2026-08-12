# InfraX 需求文档汇总（ml-service 架构优化 + 自动寻因子 + 因子工厂）

> 需求方：Steven ｜ 归档：**InfraX** ｜ 日期：2026-08-09 ｜ 状态：待开发

> 本汇总整合 InfraX 侧的三项需求：**ml-service 架构优化（4）+ 自动寻找因子（5）+ 因子工厂（6）**。目标：把 InfraX ml-service 从"硬编码 14 因子 + 静态模型"升级为**可挖掘、可评估、可管理、可入库的因子引擎**，并产出因子供下游（AItrader 策略工厂）消费。

## 目录
- 第一部分：ml-service 架构优化
- 第二部分：自动寻找因子（对话驱动 + 偏好限制）
- 第三部分：因子工厂（ml-service 因子引擎）
- 附：与其余需求的关系

---

# 第一部分：ml-service 架构优化

> 独立文档：〔需求4〕 ｜ 基于运行中版本做架构层优化，消除重复样板、统一扩展机制。

## 1. 现状（运行中版本确认）

`projects/ml-service`（FastAPI :9120），纯 CPU、fail-silent：
- 6 模型：LightGBM(+XGB/RF) / FinBERT / Kronos-mini / Chronos-Bolt-small / Moirai-2.0-small / TimesFM-2.5-200m
- 4 个 provider 复制了几乎相同的懒加载单例样板（`_load_xxx()` + `_failed` + `threading.Lock`）
- 统一数据入口 `app.data_client`（HTTP data-service）、统一 TTL 缓存 + 异步预热（`AsyncCacheRunner`）、统一鉴权（`app_auth`）
- 全部 `*_ENABLED` 默认 false，`DEVICE` 硬编码 "cpu"

**痛点**：加新模型=复制粘贴；加 GPU=逐文件改 device；加因子=手工改 build_features。

## 2. 优化目标

1. Provider 注册表 + 基类：消除 4 份样板，新模型零复制接入
2. Device 参数化：CPU/GPU 全局可切，为 V100 做准备
3. 因子工程解耦：因子池 + 评估 + 动态选因（非硬编码 14 因子）
4. 统一端点挂载：新模型自动获得 `/ml/{key}`
5. 不动现有行为：6 模型、缓存、鉴权、fail-silent 全保持

## 3. 核心设计

### 3.1 Provider 基类 + 注册表（新增 `app/providers/base.py`）
```python
class ModelProvider(ABC):
    registry = {}
    @abstractmethod
    def load(self): ...
    @abstractmethod
    def predict_all(self): ...
    def instance(self):  # 懒加载单例+失败置flag，逻辑上收基类
        ...
```
迁移现有 4 provider → 各自继承，只保留 load() + predict_all()，删样板。

### 3.2 Device 参数化
- `config.py` 加 `DEVICE = os.getenv("DEVICE","cpu")` + `ML_GPU_VENDOR`
- provider load() 用 `device_map=DEVICE` 替代硬编码 "cpu"
- GPU 不可用回落 cpu（fail-open）；为 V100(Volta 无 bf16) 预留 fp16 开关

### 3.3 统一端点挂载 + 预热
- main.py 遍历 registry 动态挂 `GET /ml/{key}`
- `_PRECOMPUTE` 预热表改为从 registry 遍历生成
- 保留现有手写端点向后兼容

### 3.4 因子工程解耦（为找银根铺路）
- 把 `tree_models.build_features` 的 14 因子收敛为注册表（`app/factorengine/`）
- 支持模板化因子展开（多窗口/多参数）
- 预留因子评估 + 动态选因入口

## 4. 文件变更

| 文件 | 变更 |
|------|------|
| `app/providers/base.py` | 新增：ModelProvider 基类 + 注册表 |
| `providers/kronos.py` 等 ×4 | 重构：继承基类，删样板 |
| `config.py` | 新增 DEVICE / ML_GPU_VENDOR / 因子开关 |
| `main.py` | 动态端点 + 预热遍历 |
| `app/factorengine/` | 新增：因子注册表 + 模板化 |

## 5. 里程碑

| 阶段 | 内容 |
|------|------|
| M1 | Provider 基类 + 4 provider 迁移 + 回归 |
| M2 | Device 参数化 |
| M3 | 动态端点 + 预热遍历 |
| M4 | 因子工程解耦 → 注册表 |

---

# 第二部分：自动寻找因子（对话驱动 + 偏好限制）

> 独立文档：〔需求5〕 ｜ 对话驱动的因子挖掘，作为因子工厂的挖掘入口。

## 1. 核心交互（AI 对话）
```
用户/LLM 一句话："挖美股技术面动量因子，20个内，5分钟，CPU跑"
  → 意图解析 → 结构化 job spec(preferences + constraints)
  → factor_pool/factor_eval 执行 → 返回状态/结果
```
偏好/限制先转成结构化 job spec（JSON），再交给挖掘内核（可复现、可追踪）。

## 2. 偏好（direction）

| 维度 | 选项 |
|------|------|
| 市场类型 | 传统 / 链上(DEX) / 混合 |
| 因子风格 | 技术面 / 基本面 / 宏观 / 资金流 / 叙事 / 混合 |
| 投资风格 | 价值银子 / 动量银子 / 趋势银子 |
| 资产池 | 美股/加密/ETF/指定列表 |
| 周期 | 短/中/长 |

## 3. 限制（guardrails，硬限制不可被偏好覆盖）

| 限制 | 示例 |
|------|------|
| 因子数量上限 | ≤ 30 |
| 计算资源预算 | CPU/GPU、核数 |
| 耗时上限 | ≤ 5 min |
| 标的数量 | ≤ 100 |
| IC 门槛 | |IC| ≥ 0.03 |
| 稳定性 | ICIR ≥ 0.3 |
| 独立度 | |corr| ≤ 0.6 |
| 黑白名单 | 排除某类标的 |

未指定用保守默认；冲突时提示确认。

## 4. 对话接口（MCP tools）

| 操作 | tool |
|------|------|
| 启动 | `factor_factory.start(spec)` |
| 状态 | `factor_factory.status(job_id)` |
| 结果 | `factor_factory.result(job_id)` |
| 列表 | `factor_factory.list()` |
| 取消 | `factor_factory.cancel(job_id)` |

## 5. 状态机
```
CREATED → PARSED → QUEUED → RUNNING(POOL→EVAL→SELECT→PERSIST)
→ COMPLETED / FAILED / CANCELLED / TIMEOUT
```
持久化（DB `factor_jobs`），可恢复；超时/取消保留部分结果。

---

# 第三部分：因子工厂（ml-service 因子引擎）

> 独立文档：〔需求6〕 ｜ InfraX 侧整体目标：可挖掘、可评估、可管理、可入库。

## 1. 现状核实

| 组件 | 现状 |
|------|------|
| ml-service(:9120) | `/ml/*` 均模型预测；因子硬编码 14 个 |
| data-service(:8765) | `/factors/current`（AItrader factor_client 正在消费） |
| AItrader factor_client | 已按 symbol 拉取 /factors/current，TTL+fail-silent |

**缺口**：因子硬编码、无法挖掘/评估、ml-service 到 data-service 入库链路未打通。

## 2. 目标链路
```
因子工厂 = ml-service 因子引擎
  ├─ 因子挖掘(需求5) → factor_pool → factor_eval → 选因
  ├─ 因子管理(catalog/版本/启停)
  └─ 因子入库 → data-service /factors/current
        └─ 供 AItrader 策略工厂等下游消费（复用已有 API）
```

## 3. 核心功能
- **因子挖掘**：factor_pool（L0-L6 模板展开 100+）+ factor_eval（IC/超额/单调性/独立度）+ 选因（top-K/去冗余/IC淘汰）
- **因子管理**：`factors_catalog.json` 或 DB（定义/状态/版本），active/inactive 启停
- **因子入库 → /factors/current**：计算逻辑登记 + 值写入；AItrader 全量透传自动可见

## 4. 因子工厂 API / MCP

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/factors/catalog` | 因子目录 |
| POST | `/factors/catalog` | 登记/更新因子定义 |
| POST | `/factors/{key}/activate|deactivate` | 启停 |
| GET | `/factors/current` | 对外因子值 API（复用） |
| (MCP) | factor_factory.start/status/result/publish | 对话驱动 + 入库 |

## 5. 里程碑

| 阶段 | 内容 | 依赖 |
|------|------|------|
| F1 | 因子引擎解耦（承接需求4） | 需求4 |
| F2 | factor_pool + factor_eval 内核 | F1 |
| F3 | 因子管理 + 入库 /factors/current | F2 |
| F4 | 对话驱动(需求5 MCP) + 自动挖掘验证 | 需求5 |

---

# 附：与其余需求的关系

| 文档 | 归属 | 关系 |
|------|------|------|
| 需求7 策略工厂 | AItrader | 因子工厂的下游（消费 /factors/current） |
| 需求3 回测回调 | AItrader | 独立，与因子工厂无直接耦合 |
| 需求4→6→5 | InfraX | 架构优化(4)前置 → 因子引擎(6) → 对话挖掘(5) |

*InfraX 侧完整清单：〔需求4〕〔需求5〕〔需求6〕*

---

# 附录 A：复合因子 / 非线性因子的计算架构（关键结论）

> 2026-08-09 补充。回答：非线性/复合因子是否每次策略都要重算？—— **不需要**，但要区分「因子值」与「因子组合逻辑」两个层面。

## A.1 核心区分

| 层面 | 是什么 | 谁算 | 频率 |
|------|--------|------|------|
| **因子值** | 每个标的每个时点的因子数值（RSI/动量/聪明钱流/复合因子值） | **因子工厂（InfraX）** | **定期算好入库**（/factors/current），不随策略重算 |
| **因子组合逻辑** | 把多个因子值组合成信号（线性权重/非线性模型/复合公式） | **策略工厂（AItrader）** | 策略生成时定，用的是**已缓存的因子值** |

## A.2 关键结论

1. **因子值不随策略重算**：因子工厂把 L0-L6 + 复合因子算成因子值写入 data-service `/factors/current`；策略工厂 `factor_client` 直接拉当前值（TTL 缓存）。因子值随行情定期刷新（所有策略共享），非"每次策略重算"。
2. **复合/非线性因子的两种做法**：
   - **A. 组合算成新因子值入库（推荐）**：复合因子（如"聪明钱×技术突破+财报惊喜"）由因子工厂算好作为一个新因子值入库 → 所有策略共享，低频刷新，不每次重算
   - **B. 策略内部做非线性组合（次选）**：策略拿到底层因子值后，在策略代码里做非线性组合（GNN/随机森林打分），输入仍是缓存因子值（计算轻量）。适合策略专属复合因子。
3. **GNN/非线性模型也是"训练权重→推理打分"**：训练在因子工厂侧（低频，用 V100/双卡），推理用缓存因子值打分（高频、轻量），输入特征不需每次从头重算。

## A.3 对硬件方案的意义
- **复合因子挖掘（GNN/AutoML）** → 因子工厂侧、用 V100 双卡**低频训练**模型权重
- **训练好的复合因子** → 作为因子值入库 → 各策略**高频实时消费**（轻量推理）
- 如此 **32核+64G 处理因子刷新，V100 处理复合因子训练/推理**，GPU 不成为每次策略的瓶颈

*本附录补充到〔InfraX 需求汇总〕因子工厂部分与〔硬件进化方案〕。*
