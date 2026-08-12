#!/usr/bin/env bash
# A-15: session-key-engine 健康探活（:3500 /api/v1/health，公开端点）。
# 用法: session-key-health.sh            # exit 0=健康 1=不健康
#       session-key-health.sh --restart  # 探活失败时重启 infrax-session-key（供外部定时器驱动）
set -u
PORT="${SESSION_KEY_PORT:-3500}"
URL="http://127.0.0.1:${PORT}/api/v1/health"

if ! timeout 10 curl -fsS "${URL}" >/dev/null 2>&1; then
  echo "[session-key-health] ${URL} 不可达"
  [ "${1:-}" = "--restart" ] && sudo systemctl restart infrax-session-key
  exit 1
fi

echo "[session-key-health] OK"
exit 0
