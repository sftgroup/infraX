"""InfraX data-service 官方 SDK 全端点示例。

Usage:
    python quickstart.py --base-url http://127.0.0.1:9112 --api-key <KEY> [--verify]
"""
from __future__ import annotations

import argparse
import json
import sys

from infra_data_client import InfraDataClient, InfraDataError


def main() -> int:
    ap = argparse.ArgumentParser(description="InfraDataClient quickstart")
    ap.add_argument("--base-url", default="http://127.0.0.1:9112")
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--verify", action="store_true", help="启用 TLS 校验（默认关闭）")
    args = ap.parse_args()

    client = InfraDataClient(
        base_url=args.base_url,
        api_key=args.api_key,
        verify=args.verify,
        fail_silent=False,  # 示例显式抛错，便于定位；生产建议保持 fail_silent=True
    )

    def show(title: str, data) -> None:
        print(f"\n== {title} ==")
        if data is None:
            print("  (None)")
        else:
            print(json.dumps(data, ensure_ascii=False, default=str)[:600])

    try:
        show("health", client.health())
        show("stats", client.get_stats())
        show("bars BTC/USDT 1h limit=2", client.get_bars("BTC/USDT", timeframe="1h", limit=2))
        show("bars BTC/USDT:USDT swap", client.get_bars("BTC/USDT:USDT", timeframe="1h", limit=2))
        show("factor_catalog", client.get_factor_catalog())
        show("current_factors BTC,ETH", client.get_current_factors("BTC,ETH"))
        show("history_factors BTC/USDT rsi_14", client.get_history_factors("BTC/USDT", timeframe="1h", ids="rsi_14,ma_5", limit=3))
        show("snapshots market_overview", client.get_snapshots("market_overview"))
        show("ticker BTC/USDT", client.get_ticker("BTC/USDT"))
        show("resolve BTC", client.resolve_symbol("BTC"))
        show("search btc", client.search_symbols("btc", market="crypto", limit=5))
        show("broker_market_policy", client.get_broker_market_policy())
    except InfraDataError as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        return 1
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
