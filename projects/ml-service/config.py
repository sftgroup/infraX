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

# ── 推理设备（需求4 R4-2） ─────────────────────────────────
# DEVICE: "cpu"/"cuda"（cuda 目标不可用时 provider 自动回落 cpu，fail-open）；
# ML_GPU_VENDOR: GPU 型号探测结果（预留 V100 等 Volta 架构 fp16 适配开关，
#   Volta 无 bf16，统一走 fp16）。
DEVICE = os.getenv("DEVICE", "cpu").strip().lower()
ML_GPU_VENDOR = os.getenv("ML_GPU_VENDOR", "")

# ── data-service 联动（K线/符号清单） ─────────────────────
DATA_SERVICE_URL = os.getenv("DATA_SERVICE_URL", "")
# data-service 业务端点鉴权（/bars /symbols 需 X-API-Key）
DATA_API_KEY = os.getenv("DATA_API_KEY", "")

# ── 因子工厂（需求5/6 R5-1/FF-2~4） ──────────────────────
# 挖掘任务存储：默认 SQLite（标准库零依赖，生产立即可用）；FACTOR_DB_PATH
# 可指向自定义文件。PostgreSQL 支持为后续可选项（psycopg2 依赖）。
FACTOR_DB_PATH = os.getenv("FACTOR_DB_PATH", "factor_factory.db")
# 因子评估数据窗口（每标的拉取 K 线根数；需 ≥ 评估窗口 + horizon + 缓冲）
FACTOR_EVAL_BARS = int(os.getenv("FACTOR_EVAL_BARS", "800"))
# 挖掘 worker 并发数（小内存机保持 1，防挤爆 CPU/内存）
FACTOR_MINER_WORKERS = int(os.getenv("FACTOR_MINER_WORKERS", "1"))

# ── 因子工厂定时挖掘（需求6 FF-4.1） ─────────────────────
# 进程内 daemon 线程（仿 async_cache.prewarm_loop）：启动 delay 后每
# INTERVAL_H 小时触发一次 start_job。负载控制：
#   - 单 worker 串行 + 已有 QUEUED/RUNNING 任务跳过本 tick（手动/定时不叠加）
#   - 距上次终态任务不足 interval 跳过（重启后不立即重复跑）
#   - interval 下限 1h（防误配导致高频空转）；spec 用保守 max_targets/max_runtime
# 默认 spec：FACTOR_MINER_SCHEDULE_SPEC（结构化 JSON {preferences, constraints}）；
# 设置 FACTOR_MINER_SCHEDULE_INTENT（自然语言）时优先走 LLM 意图解析（R5-4）。
# 未启用 / SPEC/INTENT 均未配置 / 解析失败 → 调度线程不启动（fail-silent）。
FACTOR_MINER_SCHEDULE_ENABLED = os.getenv("FACTOR_MINER_SCHEDULE_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")
FACTOR_MINER_SCHEDULE_INTERVAL_H = float(os.getenv("FACTOR_MINER_SCHEDULE_INTERVAL_H", "6"))
FACTOR_MINER_SCHEDULE_DELAY_S = float(os.getenv("FACTOR_MINER_SCHEDULE_DELAY_S", "60"))
FACTOR_MINER_SCHEDULE_SPEC = os.getenv("FACTOR_MINER_SCHEDULE_SPEC", "")
FACTOR_MINER_SCHEDULE_INTENT = os.getenv("FACTOR_MINER_SCHEDULE_INTENT", "")
# 多市场定时挖掘（FF-4.2）：JSON 数组，每市场独立 preferences/constraints/formulas，
# 如 [{"name":"crypto","preferences":{...},"constraints":{"min_ic":0.03,"min_icir":0.05,...},"formulas":[...]}]
# 配置时优先于 INTENT/SPEC（单市场回退）；不同市场数据特性不同需独立阈值
FACTOR_MINER_SCHEDULE_MULTI = os.getenv("FACTOR_MINER_SCHEDULE_MULTI", "")
# 自动闭环（FF-4.3）：任务 COMPLETED 后，passed 因子自动激活（进 /factors/current
# 查询与模型特征）+ 置模型过期（下次预测自动用新特征重训）。全链路无需人工。
FACTOR_MINER_AUTO_ACTIVATE = os.getenv("FACTOR_MINER_AUTO_ACTIVATE", "true").strip().lower() in ("1", "true", "yes", "on")
FACTOR_MINER_AUTO_RETRAIN = os.getenv("FACTOR_MINER_AUTO_RETRAIN", "true").strip().lower() in ("1", "true", "yes", "on")
# IC / ICIR 阈值（动态可调）：INTENT 分支强制覆盖 LLM 解析值（LLM 输出数字不确定，
# 阈值调整只改 .env 这一个数字重启即生效，不依赖意图文案）。联合门槛为
# 同时满足 min_ic 与 min_icir；crypto 日线短样本下 IC 与 ICIR 往往此消彼长，
# 建议保持 ICIR 门槛明显低于 IC（如 IC≥0.03 配 ICIR≥0.05）才能收获因子。
FACTOR_MINER_SCHEDULE_MIN_IC = float(os.getenv("FACTOR_MINER_SCHEDULE_MIN_IC", "0.03"))
FACTOR_MINER_SCHEDULE_MIN_ICIR = float(os.getenv("FACTOR_MINER_SCHEDULE_MIN_ICIR", "0.3"))

# ── 因子工厂 LLM 意图解析（需求5 R5-4） ──────────────────
# OpenAI 兼容 chat completions（默认 DeepSeek）；未配置时自然语言入口 400 提示。
FACTOR_LLM_API_KEY = os.getenv("FACTOR_LLM_API_KEY", os.getenv("LLM_BINDING_API_KEY", ""))
FACTOR_LLM_HOST = os.getenv("FACTOR_LLM_HOST", "")
FACTOR_LLM_MODEL = os.getenv("FACTOR_LLM_MODEL", "deepseek-chat")

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

# ── 端点结果缓存（TTL，秒） ──────────────────────────────
# 重计算端点（tree/volatility/bolt/moirai/timesfm）结果缓存时长，
# TTL 内直接返回上次结果不重算（collector 30min 周期 + 缓存 30min →
# 实际约每 60min 重算一次，避免每次周期都全量跑分钟级推理）。
ML_CACHE_TTL_SEC = float(os.getenv("ML_CACHE_TTL_SEC", "1800"))

# ── 异步计算 + 预热（ML_PREWARM_*） ───────────────────────
# 重计算端点 miss 缓存时在后台 daemon 线程计算（请求立即返回，不阻塞
# worker 线程池，避免全量预测拖死 /health 等轻端点）；预热线程周期
# 串行检查各 key，缓存缺失/过期时后台刷新 → 缓存常满、请求几乎总是命中。
# PREWARM_INTERVAL 建议 < ML_CACHE_TTL_SEC（默认 900 < 1800）。
ML_PREWARM_ENABLED = os.getenv("ML_PREWARM_ENABLED", "true").strip().lower() in ("1", "true", "yes", "on")
ML_PREWARM_DELAY_SEC = float(os.getenv("ML_PREWARM_DELAY_SEC", "60"))
ML_PREWARM_INTERVAL_SEC = float(os.getenv("ML_PREWARM_INTERVAL_SEC", "900"))

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
