"""LLM 意图解析（需求5 R5-4.1 / R5-4.2）。

自然语言 → job spec（preferences + constraints）。调用 OpenAI 兼容 LLM
（默认 DeepSeek，FACTOR_LLM_HOST/KEY 配置），要求结构化 JSON 输出；
「硬限制/必须/不允许」类表述落入 constraints（偏好不可覆盖，spec 校验兜底）。
LLM 未配置/调用失败 → 抛 IntentError（调用方 400 提示，不静默降级）。
"""
from __future__ import annotations

import json
import logging
import urllib.request
from typing import Any

import config

logger = logging.getLogger(__name__)


class IntentError(Exception):
    """意图解析失败（LLM 未配置 / 调用失败 / 输出非法 JSON）。"""


_PROMPT = """你是量化因子挖掘需求解析器。把用户的自然语言需求解析为严格 JSON：
{{
  "preferences": {{
    "market_types": ["crypto"|"us_stock"|"hk_stock"|"any"],
    "factor_styles": ["momentum"|"volatility"|"trend"|"mean_reversion"|"any"],
    "investment_style": "value"|"growth"|"momentum"|"balanced",
    "asset_pool": ["SYMBOL", ...] 或 [],
    "timeframe": "1d"|"1h",
    "horizon": 7
  }},
  "constraints": {{
    "max_factors": 20, "max_runtime_min": 60, "max_targets": 50,
    "min_ic": 0.0, "min_icir": 0.3, "max_independence": 0.7,
    "require_monotonicity": false, "blacklist_keys": [], "whitelist_keys": []
  }},
  "formulas": ["DSL公式1", ...] 或 []
}}
可用数据列（K线 + 技术指标）：open, high, low, close, volume,
  rsi_14, macd_hist, bb_upper, bb_lower, atr_14, ma_5, ma_10, ma_20, ma_30, ma_60
DSL 公式语法（可选，最多 5 个；只允许上述列 + 这些方法）：
  方法白名单: abs, pct_change, diff, shift, std, mean, max, min, sum, prod,
    skew, kurt, rank, quantile, fillna, clip, rolling, ewm
  函数白名单: log, exp, sqrt, sign, maximum, minimum
  示例:
    close.pct_change(20).rolling(60).std() / close
    (close - close.rolling(20).mean()) / close
    close.pct_change().ewm(span=20).mean() - close.pct_change().ewm(span=60).mean()
    (high - low) / close
  参数必须为数字字面量（rolling(窗口) / ewm(span=)/ewm(alpha=) / pct_change(期数) /
  shift(期数) / diff(期数) / quantile(分位 0-1) / rank(pct=布尔) / fillna(值) /
  clip(lower=, upper=)）。不要用白名单外的方法/函数/列。
规则：
- 用户表达「必须/不允许/硬性/不能超过」等 → 放 constraints（硬限制，偏好不可覆盖）
- 用户表达「喜欢/偏好/尽量」等 → 放 preferences（软偏好）
- 用户要求「自己设计/创新/生成因子公式」等 → 设计符合 DSL 语法的公式放 formulas
- 未提及的字段给保守默认；不确定市场/风格给 "any"
- 只输出 JSON，不要任何解释。
用户输入：{text}
"""


def _call_llm(text: str) -> str:
    """调用 OpenAI 兼容 chat completions；未配置抛 IntentError。"""
    key = config.FACTOR_LLM_API_KEY
    host = config.FACTOR_LLM_HOST or "https://api.deepseek.com/v1"
    model = config.FACTOR_LLM_MODEL
    if not key:
        raise IntentError("FACTOR_LLM_API_KEY 未配置（LLM 意图解析不可用）")
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a JSON-only factor-mining intent parser."},
            {"role": "user", "content": _PROMPT.format(text=text)},
        ],
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")
    req = urllib.request.Request(
        host.rstrip("/") + "/chat/completions", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        raise IntentError(f"LLM 调用失败: {exc}") from exc
    try:
        return payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise IntentError(f"LLM 响应异常: {exc}") from exc


def parse_intent(text: str) -> dict[str, Any]:
    """自然语言 → {"preferences": {...}, "constraints": {...}, "formulas": [...]}。

    输出交给 build_spec 生成 JobSpec（spec 校验负责冲突提示/默认值）。
    formulas：LLM 生成的 DSL 公式（FF-5），逐条白名单校验，非法公式静默丢弃。
    """
    raw = _call_llm(text)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise IntentError(f"LLM 输出非 JSON: {raw[:200]}") from exc
    prefs = parsed.get("preferences") or {}
    cons = parsed.get("constraints") or {}
    # 白名单字段过滤（防 LLM 注入未知键污染 schema）
    from app.factorengine.job import FactorConstraints, FactorPreferences

    allowed_prefs = set(FactorPreferences.model_fields)
    allowed_cons = set(FactorConstraints.model_fields)
    prefs = {k: v for k, v in prefs.items() if k in allowed_prefs}
    cons = {k: v for k, v in cons.items() if k in allowed_cons}

    # FF-5：DSL 公式（最多 5 条；非法公式丢弃）
    from app.factorengine import dsl

    formulas: list[str] = []
    raw_formulas = parsed.get("formulas") or []
    if isinstance(raw_formulas, list):
        for f in raw_formulas[:5]:
            if not isinstance(f, str) or not f.strip():
                continue
            try:
                dsl.validate_formula(f.strip())
            except dsl.DslError as exc:
                logger.warning("intent formula invalid, dropped (%s): %s", f[:60], exc)
                continue
            formulas.append(f.strip())
    if formulas:
        logger.info("intent parsed %d DSL formulas", len(formulas))
    return {"preferences": prefs, "constraints": cons, "formulas": formulas}
