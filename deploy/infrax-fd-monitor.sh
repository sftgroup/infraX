#!/bin/bash
# InfraX fd 兜底监控：infrax-data 文件描述符超阈值自动重启。
# 每 5 分钟由 systemd timer 触发。
# 背景（2026-08-13 §9.17）：data 服务有大量外部 HTTPS 连接池（akshare/东财/新浪等），
# CLOSE-WAIT 属正常残留（fd 稳定），但需兜底防 fd 持续增长触发 Too many open files。

LOG="/var/log/infrax-fd-monitor.log"
THRESHOLD="${FD_THRESHOLD:-1500}"

PID=$(systemctl show infrax-data -p MainPID --value 2>/dev/null)
if [ -z "$PID" ] || [ "$PID" = "0" ]; then
    echo "[$(date)] infrax-data not running (PID=${PID:-none}), skip" >> "$LOG"
    exit 0
fi

FD=$(ls /proc/$PID/fd 2>/dev/null | wc -l)
if [ "$FD" -ge "$THRESHOLD" ]; then
    echo "[$(date)] WARN infrax-data fd=$FD >= $THRESHOLD, restarting" >> "$LOG"
    systemctl restart infrax-data
    echo "[$(date)] infrax-data restarted (was fd=$FD)" >> "$LOG"
else
    # 正常路径记录 fd 值（每 5 分钟一行，日增量 <12KB）—— 可观测性：确认 timer 在跑、fd 趋势
    echo "[$(date)] infrax-data fd=$FD < $THRESHOLD, ok" >> "$LOG"
fi
