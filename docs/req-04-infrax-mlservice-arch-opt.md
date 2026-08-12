# 需求文档 4：InfraX ml-service 架构优化

> 需求方：Steven ｜ 归档：InfraX ｜ 日期：2026-08-09 ｜ 状态：待开发
> 定位：基于**当前运行中版本**的 ml-service 做**架构层优化**，消除重复样板、统一扩展机制，为后续接入更多模型/因子/GPU 铺路。**不改业务行为，不破坏现有 6 模型。**

---

## 1. 现状（运行中版本确认）

`projects/ml-service`（FastAPI :9120），纯 CPU、进程内、fail-silent：

- 6 模型：LightGBM(+XGB/RF) / FinBERT / Kronos-mini / Chronos-Bolt-small / Moirai-2.0-small / TimesFM-2.5-200m
- 4 个 provider（Kronos/Bolt/Moirai/TimesFM）各自复制了几乎相同的**懒加载单例样板**（`_load_xxx()` + `_failed` flag + `threading.Lock`）
- 统一数据入口 `app.data_client`（HTTP data-service）、统一 TTL 缓存 + 异步预热（`AsyncCacheRunner`）、统一鉴权（`app_auth`）
- 全部 `*_ENABLED` 默认 false，`DEVICE` 硬编码 "cpu"

**架构痛点**：加新模型 = 复制粘贴样板；加 GPU = 逐文件改 device；加因子 = 手工改 `tree_models.build_features`。

---

## 2. 优化目标

1. **Provider 注册表 + 基类**：消除 4 份重复样板，新模型零复制接入
2. **Device 参数化**：CPU/GPU 全局可切，为 V100 做准备
3. **因子工程解耦**：因子池 + 评估 + 动态选因（而非硬编码 14 因子）
4. **统一端点挂载**：新模型自动获得 `/ml/{key}`
5. **不动现有行为**：6 模型、缓存、鉴权、fail-silent 全部保持

---

## 3. 架构优化设计

### 3.1 Provider 基类 + 注册表（核心）

新增 `app/providers/base.py`：

```python
class ModelProvider(ABC):
    registry: dict[str, "ModelProvider"] = {}
    def __init__(self, key, enabled, model_id=""):
        self.key, self.enabled, self.model_id = key, enabled, model_id
        ModelProvider.registry[key] = self
    @abstractmethod
    def load(self): ...
    @abstractmethod
    def predict_all(self): ...
    def instance(self):   # 懒加载单例 + 失败置flag，逻辑全部上收基类
        if self._instance is not None or self._failed: return self._instance
        if not self.enabled(): return None
        with self._lock:
            ...
            self._instance = self.load()
```

**迁移现有 4 provider** → 各自继承，只保留 `load()` + `predict_all()`，删样板。

### 3.2 Device 参数化

- `config.py` 加 `DEVICE = os.getenv("DEVICE", "cpu")`（及 `ML_GPU_VENDOR` 探测）
- provider `load()` 用 `device_map=DEVICE` / `map_location=DEVICE` 替代硬编码 "cpu"
- GPU 不可用时回落 cpu（fail-open）
- 为 V100(Volta，无 bf16) 预留 fp16 适配开关

### 3.3 统一端点挂载 + 预热

- main.py 遍历 `ModelProvider.registry` 动态挂 `GET /ml/{key}`
- `_PRECOMPUTE` 预热表改为从 registry 遍历生成
- 保留现有手写端点向后兼容

### 3.4 因子工程解耦（为找银根/扩展铺路）

- 把 `tree_models.build_features` 的 14 因子收敛为**因子注册表**（`app/factorengine/`）
- 支持模板化因子展开（多窗口/多参数）
- 预留因子评估 + 动态选因入口（后续接 InfraX 找银根 L0-L6 因子）

---

## 4. 文件变更清单

| 文件 | 变更 |
|------|------|
| `app/providers/base.py` | 新增：ModelProvider 基类 + 注册表 |
| `app/providers/kronos.py` 等 ×4 | 重构：继承基类，删样板 |
| `config.py` | 新增 DEVICE / ML_GPU_VENDOR / 因子相关开关 |
| `main.py` | 动态端点挂载 + 预热遍历注册表 |
| `app/factorengine/` | 新增：因子注册表 + 模板化（解耦 build_features）|

---

## 5. 验收标准
- [ ] 现有 6 模型行为/输出完全不变（回归通过）
- [ ] 新增一个模型只需「config + provider 子类继承 load/predict_all」三步
- [ ] DEVICE 全局可切 CPU/GPU，无硬编码
- [ ] 新模型自动获得 `/ml/{key}` 端点 + 预热
- [ ] 因子从 build_features 解耦为注册表，可扩展

---

## 6. 里程碑
| 阶段 | 内容 |
|------|------|
| M1 | Provider 基类 + 4 provider 迁移 + 回归 |
| M2 | Device 参数化 |
| M3 | 动态端点 + 预热遍历 |
| M4 | 因子工程解耦 → 注册表 |
