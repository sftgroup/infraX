#!/bin/bash
# InfraX 数据保留清理：保留最近 5 天的 events 数据
# 每天凌晨 3:00 由 systemd timer 触发

LOG="/var/log/infrax-cleanup.log"
echo "[$(date)] Starting cleanup, keeping last 5 days..." >> "$LOG"

# Collecter events: 删除 5 天前的数据
DELETED=$(sudo -u postgres psql -d pocketx_collector -t -A -c \
  "WITH deleted AS (DELETE FROM events WHERE collected_at < NOW() - INTERVAL '5 days' RETURNING id) SELECT COUNT(*) FROM deleted" 2>&1)

echo "[$(date)] Deleted $DELETED events older than 5 days" >> "$LOG"

# Payment events cleanup (uses created_at)
PAY_DELETED=$(sudo -u postgres psql -d pocketx_collector -t -A -c \
  "WITH deleted AS (DELETE FROM payment_events WHERE created_at < NOW() - INTERVAL '5 days' RETURNING id) SELECT COUNT(*) FROM deleted" 2>&1)

echo "[$(date)] Deleted $PAY_DELETED payment_events older than 5 days" >> "$LOG"

# OKX token snapshots cleanup
OKX_DELETED=$(sudo -u postgres psql -d pocketx_collector -t -A -c \
  "WITH deleted AS (DELETE FROM okx_token_snapshots WHERE collected_at < NOW() - INTERVAL '5 days' RETURNING id) SELECT COUNT(*) FROM deleted" 2>&1)

echo "[$(date)] Deleted $OKX_DELETED okx_token_snapshots older than 5 days" >> "$LOG"

# Binance futures prices cleanup (uses bucket)
BNB_DELETED=$(sudo -u postgres psql -d pocketx_collector -t -A -c \
  "WITH deleted AS (DELETE FROM binance_futures_prices WHERE bucket < NOW() - INTERVAL '5 days' RETURNING id) SELECT COUNT(*) FROM deleted" 2>&1)

echo "[$(date)] Deleted $BNB_DELETED binance_futures_prices older than 5 days" >> "$LOG"

# VACUUM to reclaim disk space
sudo -u postgres psql -d pocketx_collector -c "VACUUM ANALYZE events" >> "$LOG" 2>&1
echo "[$(date)] VACUUM complete" >> "$LOG"