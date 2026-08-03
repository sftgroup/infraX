"""Data collectors — background threads for external data acquisition."""
from .external_factors import ExternalFactorCollector
from .calendar import CalendarCollector
from .market_data import SnapshotCollector
from .heatmap import HeatmapCollector
