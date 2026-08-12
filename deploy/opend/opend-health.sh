#!/usr/bin/env bash
# MM-7.3: OpenD 健康探活（11111 端口 + SDK 登录态）。
# 用法: opend-health.sh            # 探活，exit 0=健康 1=不健康
#       opend-health.sh --restart  # 探活失败时重启 infrax-opend（供外部定时器驱动）
set -u
VENV=/opt/opend/venv
HOST=127.0.0.1
PORT=11111

# 1) TCP 端口探测（进程存活）
if ! timeout 5 bash -c "echo > /dev/tcp/${HOST}/${PORT}" 2>/dev/null; then
  echo "[opend-health] TCP ${PORT} 不通"
  [ "${1:-}" = "--restart" ] && sudo systemctl restart infrax-opend
  exit 1
fi

# 2) SDK 登录态探测（get_global_state 失败即视为不可用）
if [ -x "${VENV}/bin/python" ]; then
  if ! timeout 20 "${VENV}/bin/python" -c "
import sys
from moomoo import OpenQuoteContext
ctx = OpenQuoteContext(host='${HOST}', port=${PORT})
try:
    ret, data = ctx.get_global_state()
    ok = ret == 0 and data is not None
    sys.exit(0 if ok else 1)
finally:
    ctx.close()
" 2>/dev/null; then
    echo "[opend-health] SDK get_global_state 失败"
    [ "${1:-}" = "--restart" ] && sudo systemctl restart infrax-opend
    exit 1
  fi
fi

echo "[opend-health] OK"
exit 0
