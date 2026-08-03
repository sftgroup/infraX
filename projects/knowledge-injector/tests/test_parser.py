"""可配置解析层单测：纯函数、确定性。"""
from __future__ import annotations

import pytest

from injector.parser import (
    InjectUnit,
    _short,
    _fmt,
    _match,
    _render,
    load_rules,
    parse_snapshots,
    validate_rules,
)


# ─── 转换器 ────────────────────────────────────────

def test_short_truncates_long_addresses():
    addr = "0x9f3a1c2b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a"
    assert _short(addr) == "0x9f3a1c...7e8f9a"


def test_short_keeps_short_strings():
    assert _short("BTC") == "BTC"


def test_fmt_thousands():
    assert _fmt(1234567) == "1,234,567"
    assert _fmt("1000000000000000") == "1,000,000,000,000,000"


# ─── 模板渲染 ──────────────────────────────────────

def test_render_field():
    assert _render("price {price:fmt}", {"price": 1000}) == "price 1,000"


def test_render_format_spec():
    assert _render("{change_pct:+.2f}%", {"change_pct": 3.14159}) == "+3.14%"


def test_render_missing_field_is_empty():
    assert _render("a={missing}", {"a": 1}) == "a="


# ─── 匹配 ──────────────────────────────────────────

def test_match_empty_all():
    assert _match({"a": 1}, {}) is True
    assert _match({"a": 1}, None) is True


def test_match_list_allowed():
    assert _match({"event_type": "transfer"}, {"event_type": ["transfer", "swap"]}) is True
    assert _match({"event_type": "burn"}, {"event_type": ["transfer", "swap"]}) is False


def test_match_missing_field():
    assert _match({"a": 1}, {"b": ["x"]}) is False


# ─── 解析 ──────────────────────────────────────────

_DC_RULES = [
    {
        "name": "dc_transfer",
        "match": {"event_type": ["transfer"]},
        "template": "[OnChain] {chain} block {block_number}: {token_symbol} {amount:fmt} moved from {from_address:short}",
        "doc_id": "dc:{event_type}:{chain}:{block_number}:{event_id}",
        "namespace": "onchain",
    },
]


def test_parse_snapshots_hits_first_rule():
    snaps = [{
        "event_id": 1001, "event_type": "transfer", "chain": "SOL",
        "block_number": 283456789, "token_symbol": "USDC",
        "amount": 1000000, "from_address": "0xAbCdEf1234567890aBcDeF1234567890",
    }]
    units = parse_snapshots(snaps, _DC_RULES)
    assert len(units) == 1
    u = units[0]
    assert isinstance(u, InjectUnit)
    assert "USDC 1,000,000" in u.text
    assert u.doc_id == "dc:transfer:SOL:283456789:1001"
    assert u.namespace == "onchain"


def test_parse_snapshots_skips_non_matching():
    snaps = [{"event_type": "burn"}]
    assert parse_snapshots(snaps, _DC_RULES) == []


def test_parse_snapshots_empty_template_skipped():
    rules = [{"name": "x", "template": "   ", "doc_id": "d:{a}", "match": {}}]
    assert parse_snapshots([{"a": 1}], rules) == []


# ─── 规则加载与校验 ────────────────────────────────

def test_load_rules_from_yaml_files():
    rules = load_rules("parsers")
    assert len(rules) >= 4  # dc_events 3 + collector_signals 2
    names = {r["name"] for r in rules}
    assert {"dc_transfer", "dc_swap", "dc_liquidation", "market_signal"} <= names


def test_load_rules_missing_dir_returns_empty(tmp_path):
    assert load_rules(str(tmp_path / "nope")) == []


def test_validate_rules_rejects_bad_format_spec():
    rules = [{"name": "bad", "template": "{x:bad_spec_xyz}", "doc_id": "d"}]
    errors = validate_rules(rules)
    assert any("bad_spec_xyz" in e for e in errors)
