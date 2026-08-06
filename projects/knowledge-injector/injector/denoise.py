"""注入前语义去噪（MQ-8 / C-6）。

新闻/链上/OKX 等源此前仅做去重+截断，广告、重复公告等低价值噪音直接进入
LightRAG，污染图库。本模块提供两步去噪：
  1. 黑名单规则：广告 / 推广 / 无效空档文本（中英文关键词 + 正则）。
  2. 相似文本去重：对归一化文本计算字符级相似度，与近期已注入文本高度相似
     （>= similarity_threshold）则跳过，抑制重复公告/同源滚动。

设计约束：
  - 零第三方依赖（仅标准库），避免引入向量相似度库；
  - 相似度用字符 4-gram Jaccard，线性近似且可解释；
  - 去重记忆窗口有界（默认 200 条），防止内存膨胀。
"""
from __future__ import annotations

import re
import threading
from collections import deque

# ── 1. 黑名单规则 ─────────────────────────────────────────────────────────
# (pattern, reason)，pattern 已含 IGNORECASE。
_BLOCK_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"点击.{0,6}(领取|下载|购买)|扫码.{0,6}(领取|进群)|限时(优惠|秒杀|抢购)|免费.{0,4}(领取|送)", re.IGNORECASE), "advertise_cn"),
    (re.compile(r"subscribe.{0,10}(now|today)|limited.{0,4}(time|offer)|click.{0,6}(here|link)|download.{0,6}app|free.{0,6}(trial|gift)", re.IGNORECASE), "advertise_en"),
    (re.compile(r"join.{0,6}(telegram|discord|channel)|follow.{0,6}(twitter|x)\b", re.IGNORECASE), "promotion"),
    (re.compile(r"(免责声明|风险提示|仅供(参考|学习)|不构成(投资|购买)建议)", re.IGNORECASE), "disclaimer"),
    (re.compile(r"^(您|你)?好，?欢迎(关注|订阅)|本文由.{0,20}发布$", re.IGNORECASE), "boilerplate"),
    (re.compile(r"^\s*$"), "empty"),
]

# 短于该长度且无数字/字母的文本视为噪音
_MIN_MEANINGFUL_LEN = 24

# 相似度高于该值视为重复（0-1）
DEFAULT_SIMILARITY_THRESHOLD = 0.86
# 去重记忆窗口（最近 N 条已注入文本）
_DEDUP_WINDOW = 200
# 字符 n-gram 大小
_NGRAM = 4


def _normalize(text: str) -> str:
    """归一化：小写、折叠空白、剥离常见标点，利于相似比较。"""
    t = re.sub(r"\s+", " ", text.lower())
    t = re.sub(r"[^\w\s]", "", t, flags=re.UNICODE)
    return t.strip()


def _ngrams(s: str, n: int = _NGRAM) -> set[str]:
    if len(s) < n:
        return {s} if s else set()
    return {s[i : i + n] for i in range(len(s) - n + 1)}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter == 0:
        return 0.0
    return inter / len(a | b)


class Denoiser:
    """注入去噪器：黑名单规则 + 相似文本去重（线程安全）。"""

    def __init__(
        self,
        similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
        window: int = _DEDUP_WINDOW,
    ):
        self._threshold = similarity_threshold
        self._lock = threading.Lock()
        self._recent: deque[str] = deque(maxlen=window)
        self._stats = {"blocked_rules": 0, "blocked_dup": 0, "passed": 0}

    # ── 规则检查 ──
    def _hit_rules(self, text: str) -> str | None:
        for pat, reason in _BLOCK_PATTERNS:
            if pat.search(text):
                return reason
        # 低信息量短文本（无实际内容）
        if len(text.strip()) < _MIN_MEANINGFUL_LEN and not re.search(r"\w{4,}", text):
            return "short_noise"
        return None

    # ── 相似去重 ──
    def _is_duplicate(self, norm: str) -> bool:
        ng = _ngrams(norm)
        with self._lock:
            for prev in self._recent:
                if _jaccard(ng, _ngrams(prev)) >= self._threshold:
                    return True
        return False

    def should_inject(self, text: str) -> tuple[bool, str]:
        """返回 (是否注入, 若被拒的原因)。True 表示应注入。"""
        reason = self._hit_rules(text)
        if reason:
            with self._lock:
                self._stats["blocked_rules"] += 1
            return False, reason

        norm = _normalize(text)
        if self._is_duplicate(norm):
            with self._lock:
                self._stats["blocked_dup"] += 1
            return False, "duplicate_similar"

        with self._lock:
            self._recent.append(norm)
            self._stats["passed"] += 1
        return True, ""

    def stats(self) -> dict:
        with self._lock:
            return dict(self._stats)
