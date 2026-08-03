"""Data Service local SQLite storage."""
from .sqlite import get_db, init_db

__all__ = ["get_db", "init_db"]
