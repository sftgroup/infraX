"""Market symbol seed data. Provides fallback symbol lists when DB is empty."""

CRYPTO_SYMBOLS = [
    ("BTC/USDT", "Bitcoin"),
    ("ETH/USDT", "Ethereum"),
    ("BNB/USDT", "BNB"),
    ("SOL/USDT", "Solana"),
    ("XRP/USDT", "Ripple"),
    ("ADA/USDT", "Cardano"),
    ("DOGE/USDT", "Dogecoin"),
    ("DOT/USDT", "Polkadot"),
    ("AVAX/USDT", "Avalanche"),
    ("MATIC/USDT", "Polygon"),
    ("LINK/USDT", "Chainlink"),
    ("UNI/USDT", "Uniswap"),
    ("ATOM/USDT", "Cosmos"),
    ("LTC/USDT", "Litecoin"),
    ("ETC/USDT", "Ethereum Classic"),
    ("FIL/USDT", "Filecoin"),
    ("APT/USDT", "Aptos"),
    ("ARB/USDT", "Arbitrum"),
    ("OP/USDT", "Optimism"),
    ("NEAR/USDT", "NEAR Protocol"),
]

FOREX_SYMBOLS = [
    ("EUR/USD", "Euro/US Dollar"),
    ("GBP/USD", "British Pound/US Dollar"),
    ("USD/JPY", "US Dollar/Japanese Yen"),
    ("AUD/USD", "Australian Dollar/US Dollar"),
    ("USD/CAD", "US Dollar/Canadian Dollar"),
    ("USD/CHF", "Swiss Franc"),
    ("NZD/USD", "New Zealand Dollar/US Dollar"),
    ("EUR/GBP", "Euro/British Pound"),
    ("EUR/JPY", "Euro/Japanese Yen"),
    ("GBP/JPY", "British Pound/Japanese Yen"),
]

STOCK_SYMBOLS = [
    ("SPY", "SPDR S&P 500 ETF"),
    ("QQQ", "Invesco QQQ Trust"),
    ("AAPL", "Apple Inc."),
    ("MSFT", "Microsoft Corp."),
    ("GOOGL", "Alphabet Inc."),
    ("AMZN", "Amazon.com Inc."),
    ("TSLA", "Tesla Inc."),
    ("META", "Meta Platforms Inc."),
    ("NVDA", "NVIDIA Corp."),
    ("JPM", "JPMorgan Chase"),
    ("V", "Visa Inc."),
    ("JNJ", "Johnson & Johnson"),
]

CN_STOCK_SYMBOLS = [
    ("600519", "贵州茅台"),
    ("000001", "平安银行"),
    ("300750", "宁德时代"),
    ("601318", "中国平安"),
    ("600036", "招商银行"),
    ("002594", "比亚迪"),
    ("600276", "恒瑞医药"),
    ("601899", "紫金矿业"),
    ("000858", "五粮液"),
    ("000333", "美的集团"),
]

HK_STOCK_SYMBOLS = [
    ("00700", "腾讯控股"),
    ("09988", "阿里巴巴-W"),
    ("03690", "美团-W"),
    ("01810", "小米集团-W"),
    ("01299", "友邦保险"),
    ("00939", "建设银行"),
    ("02318", "中国平安"),
    ("09618", "京东集团-SW"),
    ("09888", "百度集团-SW"),
    ("01024", "快手-W"),
]

FUTURES_SYMBOLS = [
    ("GC=F", "Gold Futures"),
    ("SI=F", "Silver Futures"),
    ("CL=F", "Crude Oil WTI"),
    ("NG=F", "Natural Gas"),
    ("HG=F", "Copper Futures"),
    ("ZC=F", "Corn Futures"),
    ("ZS=F", "Soybean Futures"),
    ("ZW=F", "Wheat Futures"),
    ("KC=F", "Coffee Futures"),
    ("CT=F", "Cotton Futures"),
]

SEED_MAP = {
    "crypto": CRYPTO_SYMBOLS,
    "forex": FOREX_SYMBOLS,
    "stock": STOCK_SYMBOLS,
    "USStock": STOCK_SYMBOLS,
    "CNStock": CN_STOCK_SYMBOLS,
    "HKStock": HK_STOCK_SYMBOLS,
    "Futures": FUTURES_SYMBOLS,
}


def get_symbol_name(market: str, symbol: str) -> str:
    symbols = SEED_MAP.get(market, [])
    for sym, name in symbols:
        if sym == symbol:
            return name
    return symbol


def search_symbols(market: str, keyword: str = "", limit: int = 20) -> list[dict]:
    symbols = SEED_MAP.get(market, [])
    results = []
    kw = keyword.lower().strip()
    for sym, name in symbols:
        if kw and kw not in sym.lower() and kw not in name.lower():
            continue
        results.append({"symbol": sym, "name": name, "market": market})
        if len(results) >= limit:
            break
    return results


def get_hot_symbols(market: str, limit: int = 10) -> list[dict]:
    symbols = SEED_MAP.get(market, [])
    return [{"symbol": sym, "name": name, "market": market} for sym, name in symbols[:limit]]
