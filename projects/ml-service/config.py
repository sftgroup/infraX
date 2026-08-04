"""ml-service configuration — env-var driven（与 data-service 风格一致）。

独立模型推理服务（:9120），承载三个模型：
  - LightGBM 方向预测（/ml/tree_predictions）
  - FinBERT 文本情绪（/ml/sentiment）
  - Kronos 波动率预测（/ml/volatility）

数据来源：data-service /bars + /symbols（HTTP），不直连 SQLite。
所有开关默认 false；模型不可用/数据不足时 fail-silent 返回 null（无模拟数据）。
"""
import os

# ── 服务 ───────────────────────────────────────────────────
ML_SERVICE_PORT = int(os.getenv("ML_SERVICE_PORT", "9120"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# ── data-service 联动（K线/符号清单） ─────────────────────
DATA_SERVICE_URL = os.getenv("DATA_SERVICE_URL", "")
# data-service 业务端点鉴权（/bars /symbols 需 X-API-Key）
DATA_API_KEY = os.getenv("DATA_API_KEY", "")

# ── ml-service 自身鉴权（可选） ──────────────────────────
# 配置后要求客户端带 X-API-Key；未配置保持开放（内网部署建议配置）。
ML_API_KEY = os.getenv("ML_API_KEY", "")

# ── LightGBM 方向预测（TREE_ML_ENABLED） ─────────────────
TREE_ML_ENABLED = os.getenv("TREE_ML_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")
TREE_ML_HORIZON = int(os.getenv("TREE_ML_HORIZON", "7"))
TREE_ML_UP_THR = float(os.getenv("TREE_ML_UP_THR", "0.01"))
TREE_ML_MIN_SAMPLES = int(os.getenv("TREE_ML_MIN_SAMPLES", "300"))
TREE_ML_MIN_BARS = int(os.getenv("TREE_ML_MIN_BARS", "120"))
TREE_ML_MAX_BARS = int(os.getenv("TREE_ML_MAX_BARS", "2000"))
TREE_ML_RETRAIN_HOURS = float(os.getenv("TREE_ML_RETRAIN_HOURS", "24"))
TREE_ML_MODEL_DIR = os.getenv("TREE_ML_MODEL_DIR", "models")

# ── FinBERT 文本情绪（FINBERT_ENABLED） ─────────────────
FINBERT_ENABLED = os.getenv("FINBERT_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")
FINBERT_MODEL = os.getenv("FINBERT_MODEL", "ProsusAI/finbert")

# ── Kronos 波动率（KRONOS_ENABLED） ─────────────────────
KRONOS_ENABLED = os.getenv("KRONOS_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")
KRONOS_MODEL = os.getenv("KRONOS_MODEL", "NeoQuasar/Kronos-mini")
KRONOS_LOOKBACK = int(os.getenv("KRONOS_LOOKBACK", "400"))
KRONOS_PRED_LEN = int(os.getenv("KRONOS_PRED_LEN", "30"))
KRONOS_SAMPLE_COUNT = int(os.getenv("KRONOS_SAMPLE_COUNT", "12"))
