#!/usr/bin/env bash
# 磁盘自动止血守卫（2026-08-22 事故防线 4）
#
# 用途：collector 日志异常刷屏时自动截断，防止单日数 GB 日志撑满系统盘
#      （2026-08-22 曾因 events 分区缺失，combined.log 单日刷至 9.7G）。
# 由 cron 每 15 分钟调用：
#   */15 * * * * /home/ubuntu/infraX-1/projects/collector/scripts/disk-guard.sh >/dev/null 2>&1
#
# 说明：
#   - truncate 对正在写入的文件安全（logrotate copytruncate 同机制，winston fd 保持 offset）
#   - 10.3.8.6 的 PG 数据盘（events 大表所在）本机无法 df，由 collector cleaner 的
#     diskFreePct 守卫（基于 events 表大小估算）负责，本脚本只管本机系统盘日志。
set -u

LOG_DIR="/home/ubuntu/infraX-1/projects/collector/logs"
THRESHOLD_PCT=85   # 本机 / 使用率阈值
WARN_LOG_MB=256    # df 超阈值时截断的日志下限
HARD_LOG_MB=1024   # 无条件截断的日志下限（防刷屏）

TRUNCATE="$(command -v truncate)"
LOGGER="$(command -v logger)"

log_guard() { [ -n "$LOGGER" ] && "$LOGGER" -t infrax-disk-guard "$*" || echo "infrax-disk-guard: $*" >&2; }

# 1) 硬阈值：>1G 的 .log 直接截断（刷屏最常见的形态，不等磁盘告警）
if [ -n "$TRUNCATE" ]; then
  find "$LOG_DIR" -maxdepth 1 -name '*.log' -type f -size +${HARD_LOG_MB}M 2>/dev/null | while read -r f; do
    "$TRUNCATE" -s 0 "$f"
    log_guard "truncated ${f} (was >${HARD_LOG_MB}M)"
  done
fi

# 2) 磁盘使用率守卫：/ 使用率 >=85% 时收紧截断阈值
USE=$(df / --output=pcent 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "$USE" ] && [ "$USE" -ge "$THRESHOLD_PCT" ]; then
  log_guard "disk ${USE}% >= ${THRESHOLD_PCT}%, forcing log truncation"
  if [ -n "$TRUNCATE" ]; then
    find "$LOG_DIR" -maxdepth 1 -name '*.log' -type f -size +${WARN_LOG_MB}M 2>/dev/null | while read -r f; do
      "$TRUNCATE" -s 0 "$f"
      log_guard "truncated ${f} (disk guard)"
    done
  fi
fi

exit 0
