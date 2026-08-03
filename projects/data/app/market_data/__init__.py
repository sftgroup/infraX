"""Market data collector — split into logical submodules."""
from .core import MarketDataCollector

from .price_kline import _attach_methods as _price_patch
from .indicators import _attach_methods as _ind_patch
from .fundamental import _attach_methods as _fund_patch
from .crypto import _attach_methods as _crypto_patch
from .cache_external import _attach_methods as _cache_patch
from .macro_news import _attach_methods as _macro_patch

_price_patch(MarketDataCollector)
_ind_patch(MarketDataCollector)
_fund_patch(MarketDataCollector)
_crypto_patch(MarketDataCollector)
_cache_patch(MarketDataCollector)
_macro_patch(MarketDataCollector)

from .core import get_market_data_collector

__all__ = ['MarketDataCollector', 'get_market_data_collector']
