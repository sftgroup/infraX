"""MQ-8 / C-6: 注入前语义去噪测试。

覆盖：
  - 黑名单规则：广告（中/英）、推广、免责声明、低信息量噪音
  - 相似文本去重：同源滚动/重复公告被拦截，正常文本放行
  - 去重窗口 & 阈值行为
"""
import sys
from pathlib import Path

# 保证可导入 injector 包（tests 由项目根 pytest 运行时可自动解析；
# 直接运行本文件时手动补路径）
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from injector.denoise import Denoiser  # noqa: E402


def test_advertise_cn_blocked():
    d = Denoiser()
    ok, reason = d.should_inject("点击链接领取免费代币，限时优惠先到先得！")
    assert ok is False
    assert reason == "advertise_cn"


def test_advertise_en_blocked():
    d = Denoiser()
    ok, reason = d.should_inject("Subscribe now to get exclusive alpha, limited time offer!")
    assert ok is False
    assert reason == "advertise_en"


def test_promotion_blocked():
    d = Denoiser()
    ok, reason = d.should_inject("Join our telegram channel for signals and follow us on X")
    assert ok is False
    assert reason == "promotion"


def test_disclaimer_blocked():
    d = Denoiser()
    ok, reason = d.should_inject("BTC 价格观察。以上内容仅供参考，不构成投资建议。")
    assert ok is False
    assert reason == "disclaimer"


def test_short_noise_blocked():
    d = Denoiser()
    ok, reason = d.should_inject("！！！")
    assert ok is False
    assert reason == "short_noise"


def test_normal_text_passes():
    d = Denoiser()
    ok, reason = d.should_inject(
        "Bitcoin difficulty adjusted +3.2% to 92.67T as network hash rate reached a new all-time high this week."
    )
    assert ok is True
    assert reason == ""


def test_duplicate_similar_blocked():
    d = Denoiser()
    base = (
        "Whale address 0xabc123 moved 5,000 BTC to exchange as long-term holders distribute into strength "
        "following the recent rally to all-time highs."
    )
    assert d.should_inject(base)[0] is True
    # 几乎相同文本（同一公告的重复推送，仅轻微措辞差异）→ 判重
    dup = base.replace("rally to all-time", "rally at all-time")
    ok, reason = d.should_inject(dup)
    assert ok is False
    assert reason == "duplicate_similar"


def test_distinct_text_not_blocked():
    d = Denoiser()
    a = "Macro: US 10Y yield at 4.32%, VIX up 8% on tariff headlines."
    b = "On-chain: stablecoin inflows on Ethereum +$1.2B over the past 24 hours."
    assert d.should_inject(a)[0] is True
    assert d.should_inject(b)[0] is True


def test_stats_counts():
    d = Denoiser()
    d.should_inject("点击领取免费代币")
    d.should_inject("正常新闻标题：美联储维持利率不变，市场解读偏鸽派")
    d.should_inject("正常新闻标题：美联储维持利率不变，市场解读偏鸽派，全文稍长一点以规避长度限制")
    s = d.stats()
    assert s["blocked_rules"] == 1
    assert s["passed"] >= 1
