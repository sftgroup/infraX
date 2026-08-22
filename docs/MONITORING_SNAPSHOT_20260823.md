# InfraX 系统监控快照 — 2026-08-23 01:50 CST

> 基线快照：记录一次全系统巡检的**实时数据**，用于对比异常。与 [INFRAX_MONITORING.md](./INFRAX_MONITORING.md)（手册/端点/阈值）配套使用。
> 采集方法：SSH 直查三机 + curl health；本快照由巡检实际执行得到。

## 1. 服务健康（全绿 ✅）

### data 机 43.163.105.172（10.3.8.12）

| 端口 | 服务 | health | 端口 | 服务 | health |
| --- | --- | --- | --- | --- | --- |
| :9100 | admin | 200 | :9112 | data | 200 |
| :9101 | collector | 200 | :9130 | chain-rpc | 200 |
| :9102 | dc | 200 | :9131 | aa-relay | 200 |
| :9103 | dc-mcp | 200 | :9132 | payments | 200 |
| :9104 | mpc | 200 | :9134 | aa-paymaster | 200 |
| :9105 | mpc-mcp | 200 | :9200 | tss-signer | 200 |
| :9107 | vault | 200 | :9201 | mpc-signer | 200 |
| :9108 | vault-mcp | 200 | :3500 | session-key (`/api/v1/health`) | 200 |
| :9109 | waas | 200 | :3008/:3012/:3013/:3014 | hub/rpc/market/factor-mcp | 200 |
| :9110 | wallet-mcp | 200 | :3011 | session-key-mcp | 经工具查（无 /health） |
| :9111 | web | 200 | | | |

### rag-PG 机 43.156.78.59（10.3.8.6）

| 端口 | 服务 | health |
| --- | --- | --- |
| :9721 | ragservicer | 200 |
| :9113 | knowledge-injector | 200 |
| :5432 | PostgreSQL 14 | 正常（13 个 infrax 连接） |

### ml 机 43.156.25.197

| 端口 | 服务 | health |
| --- | --- | --- |
| :9120 | ml-service | 200 |

## 2. 磁盘与资源

| 节点 | 容量 | 已用 | 使用率 | 备注 |
| --- | --- | --- | --- | --- |
| data 机 | 59G | 28G | **50%** | journal 1000M（可限容 200M） |
| rag-PG 机 | 59G | 15G | **26%** | 8/23 事故后 truncate 42G 恢复 |
| ml 机 | 59G | — | — | 本快照未复查（见 §5 备注） |

## 3. 数据库（生产 PG = rag 机）

| 指标 | 值 |
| --- | --- |
| 库清单 | `infrax_admin/cache/chainrpc/collector/dc/mpc/payment/payments/vault/waas` + `postgres` + `session_key_engine`（零 pocketx_ 残留） |
| events 分区数 | 10（RANGE(collected_at)，72h 保留，cleaner 每小时维护） |
| PG 活跃连接（infrax 库） | 13 |
| PG 主日志 | **1007B**（修复后零增长，业务 ERROR 归零） |
| WAL 目录 `/var/lib/pgdata_wal` | 4.1G（正常） |
| `qd_market_cache` crypto_factors | 4 条，TTL 窗口内正常刷新（写入不再触发 ERROR） |

## 4. 日志防线与定时任务

| 项 | 值/状态 |
| --- | --- |
| infrax-cleanup（data 机 `/opt/infrax-cleanup.sh`） | ✅ 手动验证完成：events 0 行（分区 cleaner 已兜底）、payment_events 5、okx_token_snapshots 90,900、binance_futures_prices 29,820；**VACUUM complete 01:36**；每日 00:00 timer（库名已 infrax_*） |
| PG logrotate | daily + maxsize 200M + rotate 7（8/23 加固） |
| collector logrotate | daily + maxsize 500M + rotate 7 |
| disk-guard.sh | cron `*/15` 生效 |
| syslog | 897K（正常） |

## 5. 备注（本次巡检发现）

1. **data-service 重启预热现象**：本次部署 `db_postgres.py` 修复后 `restart infrax-data`，进程进入全量 K 线预热（150 标的 × 8 周期 KlineStore upsert，~15 分钟），期间进程 STAT=D、系统 wa 35%、内存仅剩 116M、swap 1.67G，**HTTP health 超时（15s 无响应）**；预热完成后 health 200（0.2ms）。data 机仅 3.7G 内存且重度 swap，**重启 data-service 应安排低峰并预留 15min 预热窗口**（同类现象：图谱冷构建 3-4 分钟 CPU 饱和）。
2. ml 机 9120 本快照沿用此前验证（200），未重复采集。
3. 后续对比基线：磁盘 ≥85%、PG 日志单日 >200M、events 分区 <3（未来不足）、health 非 200，任一出现即对照本快照定位。
