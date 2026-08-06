"""ml-service configuration — env-var driven（与 data-service 风格一致）。

独立模型推理服务（:9120），承载三个模型：
  - LightGBM 方向预测（/ml/tree_predictions）
  - FinBERT 文本情绪（/ml/sentiment）
  - Kronos 波动率预测（/ml/volatility）

数据来源：data-service /bars + /symbols（HTTP），不直连 SQLite。
所有开关默认 false；模型不可用/数据不足时 fail-silent 返回 null（无模拟数据）。
"""
import os

# ── 统一鉴权契约（app_auth）─────────────────────────────────
# 优先加载仓库级共享实现（../shared，systemd/本地 git checkout 路径）；
# Docker 构建无共享目录时回退到项目根同名副本。必须在 import app_auth 前执行。
import sys as _sys
from pathlib import Path as _Path

_SHARED_DIR = _Path(__file__).resolve().parents[1] / "shared"
if _SHARED_DIR.is_dir():
    _sys.path.insert(0, str(_SHARED_DIR))

# ── 服务 ───────────────────────────────────────────────────
ML_SERVICE_PORT = int(os.getenv("ML_SERVICE_PORT", "9120"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# ── data-service 联动（K线/符号清单） ─────────────────────
DATA_SERVICE_URL = os.getenv("DATA_SERVICE_URL", "")
# data-service 业务端点鉴权（/bars /symbols 需 X-API-Key）
DATA_API_KEY = os.getenv("DATA_API_KEY", "")

# ── P2/波动率目标符号池 ──────────────────────────────
# 默认从 data-service /symbols（timeframe=1d，min_bars=TREE_ML_MIN_BARS）动态拉取，
# 覆盖传统资产 1D + 加密资产；P2_TARGET_SYMBOLS 可显式覆盖（逗号分隔，留空走动态）。
P2_TARGET_SYMBOLS = os.getenv("P2_TARGET_SYMBOLS", "")

# ── ml-service 自身鉴权（可选） ──────────────────────────
# 收敛为平台 bridge key（RAGSERVICER_API_KEY → DOC_API_KEY →
# LIGHTRAG_API_KEY 回退链，统一契约见 app_auth）；配置后要求客户端带
# Bearer / X-API-Key / X-Service-Key；未配置保持开放（内网部署建议配置）。
ML_API_KEY = os.getenv(
    "ML_API_KEY",
    os.getenv("RAGSERVICER_API_KEY", os.getenv("DOC_API_KEY", os.getenv("LIGHTRAG_API_KEY", ""))),
)

# G-7: 监控只读 key（仅允许 GET/HEAD/OPTIONS 读操作，与 bridge key 权限解耦）
MONITOR_API_KEY = os.getenv("MONITOR_API_KEY", "")

# ── LightGBM 方向预测（TREE_ML_ENABLED） ─────────────────
TREE_ML_ENABLED = os.getenv("TREE_ML_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")
TREE_ML_HORIZON = int(os.getenv("TREE_ML_HORIZON", "7"))
TREE_ML_UP_THR = float(os.getenv("TREE_ML_UP_THR", "0.01"))
TREE_ML_MIN_SAMPLES = int(os.getenv("TREE_ML_MIN_SAMPLES", "300"))
TREE_ML_MIN_BARS = int(os.getenv("TREE_ML_MIN_BARS", "120"))
TREE_ML_MAX_BARS = int(os.getenv("TREE_ML_MAX_BARS", "2000"))
TREE_ML_RETRAIN_HOURS = float(os.getenv("TREE_ML_RETRAIN_HOURS", "24"))
TREE_ML_MODEL_DIR = os.getenv("TREE_ML_MODEL_DIR", "models")

# ── XGBoost / Random Forest 方向预测（P1 对比家族，默认关闭） ──
# 与 LightGBM 同数据集/同切分训练，作为方向预测的对照模型。
XGB_ENABLED = os.getenv("XGB_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")
RF_ENABLED = os.getenv("RF_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")

# ── FinBERT 文本情绪（FINBERT_ENABLED） ─────────────────
FINBERT_ENABLED = os.getenv("FINBERT_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")
FINBERT_MODEL = os.getenv("FINBERT_MODEL", "ProsusAI/finbert")

# ── Kronos 波动率（KRONOS_ENABLED） ─────────────────────
KRONOS_ENABLED = os.getenv("KRONOS_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")
KRONOS_MODEL = os.getenv("KRONOS_MODEL", "NeoQuasar/Kronos-mini")
KRONOS_LOOKBACK = int(os.getenv("KRONOS_LOOKBACK", "400"))
KRONOS_PRED_LEN = int(os.getenv("KRONOS_PRED_LEN", "30"))
KRONOS_SAMPLE_COUNT = int(os.getenv("KRONOS_SAMPLE_COUNT", "12"))

# ── Chronos-Bolt 单变量概率预测（BOLT_ENABLED，P2） ───────
# 快速零样本点预测/概率基线，用于与树模型方向交叉验证。
BOLT_ENABLED = os.getenv("BOLT_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")
BOLT_MODEL = os.getenv("BOLT_MODEL", "amazon/chronos-bolt-small")
BOLT_CONTEXT = int(os.getenv("BOLT_CONTEXT", "512"))
BOLT_PRED_LEN = int(os.getenv("BOLT_PRED_LEN", "30"))
BOLT_QUANTILES = os.getenv("BOLT_QUANTILES", "0.1,0.5,0.9")

# ── Moirai 2.0 多变量时序基础模型（MOIRAI_ENABLED，P2） ──
# 多资产联动/跨序列预测；单批喂入全部目标资产 variate。
MOIRAI_ENABLED = os.getenv("MOIRAI_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")
MOIRAI_MODEL = os.getenv("MOIRAI_MODEL", "Salesforce/moirai-2.0-R-small")
MOIRAI_CONTEXT = int(os.getenv("MOIRAI_CONTEXT", "512"))
MOIRAI_PRED_LEN = int(os.getenv("MOIRAI_PRED_LEN", "30"))
MOIRAI_PATCH_SIZE = int(os.getenv("MOIRAI_PATCH_SIZE", "32"))

# ── TimesFM 2.5 长上下文时序基础模型（TIMESFM_ENABLED，P2） ──
# 16K 长历史点预测 + 置信区间（连续分位数）。
TIMESFM_ENABLED = os.getenv("TIMESFM_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")
TIMESFM_MODEL = os.getenv("TIMESFM_MODEL", "google/timesfm-2.5-200m-pytorch")
TIMESFM_CONTEXT = int(os.getenv("TIMESFM_CONTEXT", "1024"))
TIMESFM_PRED_LEN = int(os.getenv("TIMESFM_PRED_LEN", "30"))
