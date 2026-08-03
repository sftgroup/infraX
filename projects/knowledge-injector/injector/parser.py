"""可配置解析层：raw 数据 → 注入文本（纯函数，配置驱动）。

将"结构化 raw 快照 → 自然语言文本"的转换从硬编码函数改为 YAML 规则驱动。
新增一种事件类型/数据源时，只需在 ``parsers/*.yaml`` 增加一条规则，无需改代码。

规则 schema（YAML）::

    parsers:
      - name: dc_transfer          # 解析器名
        source: infrax_dc         # 绑定的数据源 provider（信息性）
        match:                    # 过滤条件（全部满足才命中；空 {} = 全量）
          event_type: [transfer]
        template: |
          [OnChain] {chain} block {block_number}: {token_symbol} {amount:fmt} ...
        doc_id: "dc:{event_type}:{chain}:{block_number}:{event_id}"
        namespace: onchain        # 注入目标 namespace（默认 default）
        dedup: true               # 是否按 doc_id 幂等去重

模板字段：
  - ``{field}``           引用 raw 字段（缺失则渲染为空串）
  - ``{field:short}``     应用内置转换器（见 _TRANSFORMS）
  - ``{field:+.2f}``      直接作为 Python 格式说明符

设计原则：纯函数、无 IO、同输入同输出（可单测）。
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


# ═══════════════════════════════════════════════════════════════
#  InjectUnit
# ═══════════════════════════════════════════════════════════════

@dataclass
class InjectUnit:
    """一次注入单元：文本 + 幂等 doc_id + 目标 namespace。"""
    text: str
    doc_id: str
    namespace: str = "default"


# ═══════════════════════════════════════════════════════════════
#  内置转换器
# ═══════════════════════════════════════════════════════════════

def _short(value: Any) -> str:
    """地址/哈希截断：0x1234...abcd。"""
    s = str(value)
    return f"{s[:8]}...{s[-6:]}" if len(s) > 18 else s


def _fmt(value: Any) -> str:
    """千分位金额：1234567 → 1,234,567。"""
    try:
        return f"{float(value):,.0f}"
    except (TypeError, ValueError):
        return str(value)


def _upper(value: Any) -> str:
    return str(value).upper()


def _lower(value: Any) -> str:
    return str(value).lower()


_TRANSFORMS: dict[str, Any] = {
    "short": _short,
    "fmt": _fmt,
    "upper": _upper,
    "lower": _lower,
}


# ═══════════════════════════════════════════════════════════════
#  模板渲染
# ═══════════════════════════════════════════════════════════════

_FIELD_RE = re.compile(r"\{(\w+)(?::([^}]+))?\}")


def _render(template: str, snap: dict) -> str:
    """渲染模板：{field} / {field:transform} / {field:+.2f}。缺失字段渲染为空。"""

    def _sub(m: re.Match) -> str:
        name, spec = m.group(1), m.group(2)
        value = snap.get(name)
        if value is None:
            return ""
        if spec:
            if spec in _TRANSFORMS:
                return _TRANSFORMS[spec](value)
            try:  # Python 格式说明符，如 +.2f
                return format(value, spec)
            except (TypeError, ValueError):
                return str(value)
        return str(value)

    return _FIELD_RE.sub(_sub, template)


# ═══════════════════════════════════════════════════════════════
#  匹配与解析
# ═══════════════════════════════════════════════════════════════

def _match(snap: dict, match: Optional[dict]) -> bool:
    """规则匹配：match 中每个键都满足才算命中。

    - ``match: {}``（或 None）→ 全量匹配
    - ``match: {event_type: [transfer]}`` → snap[event_type] in [transfer]
    - 值为空列表 ``[]`` → 仅要求该字段存在
    """
    if not match:
        return True
    for key, allowed in match.items():
        value = snap.get(key)
        if value is None:
            return False
        if isinstance(allowed, list):
            if allowed and value not in allowed:
                return False
        elif allowed is not None and value != allowed:
            return False
    return True


def parse_snapshots(snapshots: list[dict], rules: list[dict]) -> list[InjectUnit]:
    """raw 快照 → 注入单元列表（每快照命中第一条规则）。

    纯函数：同输入同输出，可单测。
    """
    units: list[InjectUnit] = []
    for snap in snapshots:
        if not isinstance(snap, dict):
            continue
        for rule in rules:
            if not _match(snap, rule.get("match")):
                continue
            text = _render(rule.get("template", ""), snap).strip()
            if not text:
                continue
            units.append(
                InjectUnit(
                    text=text,
                    doc_id=_render(rule.get("doc_id", "injector:default"), snap),
                    namespace=rule.get("namespace", "default"),
                )
            )
            break  # 每快照只命中一条规则
    return units


# ═══════════════════════════════════════════════════════════════
#  规则加载与校验
# ═══════════════════════════════════════════════════════════════

_REQUIRED_RULE_FIELDS = ("name", "template", "doc_id")


def load_rules(parsers_dir: str = "parsers") -> list[dict]:
    """加载 ``parsers/*.yaml`` 下所有解析规则，启动时调用一次。"""
    if yaml is None:
        logger.error("PyYAML not installed — parsers/*.yaml unavailable. pip install PyYAML")
        return []

    base = Path(parsers_dir)
    if not base.is_dir():
        logger.warning("Parsers dir not found: %s", base)
        return []

    rules: list[dict] = []
    for f in sorted(base.glob("*.yaml")):
        try:
            data = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
        except Exception as exc:
            logger.error("Failed to load %s: %s", f, exc)
            continue
        for rule in data.get("parsers", []):
            missing = [k for k in _REQUIRED_RULE_FIELDS if not rule.get(k)]
            if missing:
                logger.error("Rule %s in %s missing fields: %s", rule.get("name", "?"), f, missing)
                continue
            rules.append(rule)
    logger.info("Loaded %d parsing rules from %s", len(rules), base)
    return rules


def validate_rules(rules: list[dict]) -> list[str]:
    """返回校验错误列表（未知转换器、非法格式说明符）。"""
    errors: list[str] = []
    for rule in rules:
        name = rule.get("name", "?")
        for field in ("template", "doc_id"):
            for m in _FIELD_RE.finditer(rule.get(field, "")):
                spec = m.group(2)
                if spec and spec not in _TRANSFORMS:
                    try:
                        format(0, spec)  # 校验 Python 格式说明符
                    except (TypeError, ValueError):
                        errors.append(f"[{name}] {field}: invalid format spec '{spec}'")
    return errors
