# 【InfraX 派发清单】当前可执行任务（数据 + ML）

> 需求方：Steven ｜ 日期：2026-08-09 ｜ 派发对象：**InfraX 团队**
> 说明：从架构方案中挑出**当前能立即落地**的增量任务（不依赖新硬件/新采购）。每项含代码位置 + 验收标准。涉及服务：`projects/data`（data-service :9112）、`projects/ml-service`（:9120）。

---

## 一、ml-service 前置（GPU 化做准备，纯代码，不依赖GPU）

### 任务 M1：DEVICE 参数化
- **代码**：`projects/ml-service/app/config.py`（现有硬编码 `cpu`）
- **内容**：`DEVICE = os.getenv("DEVICE","cpu")`，模型加载处读该变量（先支持 cpu，为 cuda 预留）
- **验收**：环境变量可切换 device，默认 cpu 行为不变，6 模型推理正常

### 任务 M2：ModelProvider 基类 + 注册表（承接需求4）
- **代码**：`projects/ml-service/app/`，现有 4 provider（kronos/chronos_bolt/moirai2/timesfm25）
- **内容**：加 `app/providers/base.py`（ModelProvider 基类 + 注册表），4 provider 继承，消重复懒加载样板；逻辑不动
- **验收**：加新模型只需继承基类；现有 `/ml/*` 端点回归通过

### 任务 M3：现有端点回归测试
- **代码**：`projects/ml-service/main.py` `/ml/*` 端点
- **内容**：重构后回归 6 模型/4 端点推理；`/ml/cache/stats` 正常
- **验收**：端点响应结构与重构前一致，无回归

---

## 二、data-service 数据接入扩展（架构已就绪，扩采集）

### 任务 D1：Universe 扩展（先扩到 50，不冲 500）
- **代码**：`projects/data/data_config.json` + `.env` 的 `KL_SYMBOLS`
- **内容**：加密 K 线 `KL_SYMBOLS` 从 3（BTC/ETH/SOL）扩到 **50**（按市值/交易量，用现有 ccxt）；美股财报股 20→**50**（现有 yfinance/Finnhub）
- **验收**：`GET /symbols?timeframe=1d&min_bars=120` 返回 ≥50 加密 + 50 美股；`/bars`/`/factors` 对新标的正常

### 任务 D2：新增数据类型（前置接入）
- **代码**：`projects/data/app/`（采集器，参照现有 ccxt/yfinance/FRED/Finnhub）
- **内容**：
  - **资金费率 / open interest**：OKX 期货接口（已有 OKX 接入）→ 新数据源 + 入 `/snapshots`
  - **DeFi TVL 明细**：DefiLlama → 现有 tvl 快照扩充
  - **宏观 FRED 扩序列**：现有 CPI/PCE/NFP 基础上 + M2 / 收益率曲线(DGS2/DGS10) / 信贷
- **验收**：新数据写入 `/snapshots?type=` 对应 27 类中扩展；无新数据源不崩（fail-silent）

### 任务 D3：数据质量 + 可观测
- **代码**：`projects/data/app/`（现有采集器 + `/admin`）
- **内容**：
  - asof 对齐扩展（现有 `/factors/history` 无未来函数，扩到全指标）
  - 采集成功率 / 延迟 / 缺口统计端点（新增 `/monitor` 或复用 admin）
- **验收**：能查询每个数据源的采集成功率/延迟/缺口；因子历史 asof 无未来函数

---

## 三、本地/云架构的数据同步模块（文档1）

### 任务 SY1：data-service 同步模块
- **代码**：`projects/data/` 新增同步模块（不动现有路由）
- **内容**：本地 → 云 的全量周期同步 + 实时增量推送（用现有 api_key/dx_* key 鉴权）
- **验收**：本地 A 写入数据可在云 B 查到；增量同步近实时；云不可用本地照常

---

## 依赖关系

```plaintext
ml 任务(M1→M2→M3)  独立，先做（GPU化前置）
data 任务(D1→D2→D3) 独立，扩采集
SY1(同步模块)        依赖 D1 后数据量上升时做
```

## 优先级

- **P0（先做）**：M1、M2（ml-service 架构，需求4 核心）、D1（扩标的，影响下游）
- **P1**：D2、D3、M3
- **P2**：SY1（等数据量上来）

---

*相关架构文档：〔Data-Service 本地化+云缓存〕·〔ML-Service 本地化+云暴露〕·〔数据抓取强化〕·〔需求4 ml架构优化〕*
