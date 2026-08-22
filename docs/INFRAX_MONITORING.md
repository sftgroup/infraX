# InfraX 全系统监控手册

> 最后更新：2026-08-23（纳入 8/23 PG 日志 42G 事故维度；EPF-9 库名已改 infrax_*）
>
> 适用版本 `v0.7.0-20260811`。本文覆盖**全系统**可观测性；业务专项指标见 [MQ16_MONITORING.md](./MQ16_MONITORING.md)（DC 配额）。

## 1. 监控对象与拓扑

| 节点 | 内网 IP | 承载 | 公网 |
| --- | --- | --- | --- |
| **data 机** `43.163.105.172` | 10.3.8.12 | 链栈 + 平台 + MCP（24 服务，:9100-9201/:3500/:3008-3014） | `infrax.0xainet.top`（172 nginx） |
| **rag-PG 机** `43.156.78.59` | 10.3.8.6 | **生产 PostgreSQL 14（10 库）** + ragservicer(:9721) + knowledge-injector(:9113) | 公网入方向关闭 |
| **ml 机** `43.156.25.197` | — | ml-service(:9120) | 经 172 nginx `/api/ml/*` |

> **要点**：生产 PG 与 rag 服务同机（10.3.8.6=43.156.78.59）。data 机不能直连 5432，PG 运维经 SSH 跳板；本机 127.0.0.1 的 PG 与生产无关。

## 2. 监控维度总览

| 维度 | 核心指标 | 端点/命令 | 频率 |
| --- | --- | --- | --- |
| ① 服务健康 | 24+ 服务存活 | `/health`、admin `/api/v2/admin/status` | 30s |
| ② 资源/磁盘 | 磁盘使用率、journal、WAL | `df`、`du /var/lib/pgdata_wal` | 15min |
| ③ 日志防线 | 日志大小/轮转/限流 | logrotate + disk-guard + logger 限流 | 15min |
| ④ 数据库 | 连接/锁/分区/表膨胀 | psql `pg_stat_activity` 等 | 1min~5min |
| ⑤ 业务指标 | 配额/请求量/事件速率 | `/metrics`（Prometheus）+ SQL 兜底 | 30s |
| ⑥ 定时任务 | 清理/分区/轮转是否正常 | journal + 日志尾部 | 每日 |

## 3. 维度①：服务健康（24+ 端点）

### 3.1 聚合入口（最快捷，data 机）

| 端点 | 说明 |
| --- | --- |
| `GET http://10.3.8.12:9100/api/v2/admin/status` | **单点聚合 12 服务状态**（collector/waas/dc/vault/mpc/payments/admin/web/4×MCP），需 `x-admin-token` |

### 3.2 data 机（10.3.8.12）

| 端口 | 服务 | health 端点 |
| --- | --- | --- |
| :9100 | admin | `/health` |
| :9101 | collector 链扫描器 | `/health` |
| :9102 | DC 数据中心 | `/health`（`/metrics` 见 §7） |
| :9103 | DC MCP | `/health` |
| :9104 | MPC 钱包 | `/health` |
| :9105 | MPC MCP | `/health` |
| :9107 | Vault 多签 | `/health` |
| :9108 | Vault MCP | `/health` |
| :9109 | WAAS B2B | `/health` |
| :9110 | Wallet MCP | `/health` |
| :9111 | Web | `/health` |
| :9112 | Data 数据服务 | `/health`（`/metrics` 见 §7） |
| :9130 | Chain RPC 网关 | `/health` |
| :9131 | AA Relay | `/health` |
| :9132 | Payments | `/health` |
| :9134 | AA Paymaster | `/health` |
| :9200 | TSS Signer | `/health` |
| :9201 | MPC Signer | `/health` |
| :3500 | Session Key Engine | `/api/v1/health` |
| :3008/:3012/:3013/:3014 | Hub/RPC/Market/Factor MCP | `/health` |
| :3011 | Session Key MCP | 无 /health（经 MCP 工具 `sk_health` 查上游 :3500） |

### 3.3 rag-PG 机（43.156.78.59）

| 端口 | 服务 | health 端点 |
| --- | --- | --- |
| :9721 | ragservicer | `/api/v1/health`（注意非 /health，含 `instances` 图谱实例数） |
| :9113 | knowledge-injector | `/health`（`/metrics` 见 §7） |
| :5432 | PostgreSQL 14 | 见 §5 |

### 3.4 ml 机（43.156.25.197）

| 端口 | 服务 | health 端点 |
| --- | --- | --- |
| :9120 | ml-service | `/health`（`/metrics` 见 §7） |

## 4. 维度②：资源与磁盘

```bash
# 三机根分区
for h in 43.163.105.172 43.156.78.59 43.156.25.197; do
  echo "== $h"; ssh ubuntu@$h 'df -h / | tail -1'
done
```

| 对象 | 位置 | 阈值 |
| --- | --- | --- |
| 根分区 | 三机 `/` | >85% 告警（disk-guard 自动收紧，见 §6） |
| PG 数据 | rag 机 `/var/lib/postgresql/14/main` + WAL `/var/lib/pgdata_wal` | WAL 持续增长=checkpoint 异常 |
| systemd journal | 三机 `/var/log/journal` | >500M 可 `journalctl --vacuum-size=200M` 限容 |

## 5. 维度③：数据库（生产 PG = rag 机）

### 5.1 库清单（10 库，EPF-9 已改名）

`infrax_admin / infrax_cache / infrax_chainrpc / infrax_collector / infrax_dc / infrax_mpc / infrax_payment / infrax_payments / infrax_vault / infrax_waas` + `session_key_engine`

### 5.2 关键监控项

| 监控项 | 命令（rag 机） | 异常信号 |
| --- | --- | --- |
| 连接/锁 | `sudo -u postgres psql -tAc "SELECT pid,state,wait_event_type,left(query,60) FROM pg_stat_activity WHERE state<>'idle' AND wait_event_type='Lock'"` | 长 Lock 等待=孤儿后端（EPF-5 教训：`pg_terminate_backend`） |
| 分区管理 | `sudo -u postgres psql -d infrax_collector -tAc "SELECT child.relname FROM pg_inherits i JOIN pg_class child ON i.inhrelid=child.oid JOIN pg_class parent ON i.inhparent=parent.oid WHERE parent.relname='events'"` | 未来分区缺失→`no partition found` 刷屏（EPF-10） |
| PG 主日志 | `sudo -n ls -lh /var/log/postgresql/postgresql-14-main.log` | 单日 >200M=SQL 刷屏（8/23 事故：RETURNING id 兼容层，42G） |
| 连接数 | `SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'infrax%'` | 接近 max_connections |

### 5.3 collector events 保留策略

`events` 为 RANGE(collected_at) 分区父表；**72h 保留**（cleaner 每小时自动建未来分区 + DROP 过期分区），5 天兜底清理由 infrax-cleanup 执行（见 §6）。

## 6. 维度④：日志防线与定时任务

| 任务 | 调度 | 作用 | 位置 |
| --- | --- | --- | --- |
| `infrax-cleanup.timer` | 每日 00:00 | 删 5 天前 payment_events/okx_token_snapshots/binance_futures_prices + events 兜底 + VACUUM | data 机 `/opt/infrax-cleanup.sh`（⚠️ 部署副本，改脚本须同步 /opt） |
| collector 分区 cleaner | 每小时（进程内） | events 72h 分区 建/DROP | collector（data 机） |
| `disk-guard.sh` | cron `*/15` | 日志 >1G 截断、`/` >85% 收紧 | data 机 `~/infraX-1/projects/collector/scripts/disk-guard.sh` |
| logrotate `infrax-collector` | daily + maxsize 500M + rotate 7 | collector `logs/*.log` 轮转 | data 机 |
| logrotate `postgresql-common` | **daily + maxsize 200M** + rotate 7 | PG 主日志轮转（8/23 加固） | rag 机 |
| logrotate nginx/rsyslog | daily | 平台日志 | data 机 |
| logger 限流 | 进程内 | collector 同 level:message 10s 窗口仅 1 条 + `_suppressed` 计数 | collector |

## 7. 维度⑤：业务指标（Prometheus）

| 服务 | 端口 | /metrics | 主要指标 |
| --- | --- | --- | --- |
| DC | :9102 | ✅ | `dc_subscription_status_total`、`dc_quota_used_total`、`dc_quota_limit_total`、`dc_quota_usage_ratio`（专项见 [MQ16_MONITORING.md](./MQ16_MONITORING.md)） |
| data | :9112 | ✅ | 请求量/耗时（[shared/metrics.py](../projects/shared/metrics.py)）+ `process_*` |
| knowledge-injector | :9113 | ✅ | 同上 |
| ragservicer | :9721 | ✅ | 同上（图谱写入锁 `busy` 计数） |
| ml-service | :9120 | ✅ | 同上 |
| collector | :9101 | ❌ 无 | SQL 兜底：`SELECT count(*) FROM events` 速率 |

### SQL 兜底（无 Prometheus 时）

```sql
-- events 写入速率（10.3.8.6，2 分钟间隔对比）
SELECT count(*) FROM events;   -- 注意 COUNT(*) 会全扫，用 reltuples 估：
SELECT COALESCE(reltuples::bigint,0) FROM pg_class WHERE relname='events';
-- 近 24h 分区清单
SELECT child.relname FROM pg_inherits i JOIN pg_class child ON i.inhrelid=child.oid
  JOIN pg_class parent ON i.inhparent=parent.oid WHERE parent.relname='events';
```

## 8. 巡检命令（推荐固化 `scripts/ops-health.sh`）

```bash
# 1) 服务聚合状态（data 机）
curl -s -H 'x-admin-token: <token>' http://10.3.8.12:9100/api/v2/admin/status
# 2) 磁盘（三机）
# 3) 日志防线
sudo -n ls -lh /var/log/postgresql/postgresql-14-main.log        # rag 机：>200M 告警
sudo -n du -sh /var/log/journal                                  # 三机
tail -5 /var/log/infrax-cleanup.log                              # data 机：应无 ERROR
# 4) PG 连接/锁（rag 机）
sudo -u postgres psql -tAc "SELECT count(*) FROM pg_stat_activity WHERE state='active'"
# 5) 图谱健康（经 172 nginx）
curl -s https://infrax.0xainet.top/api/rag/v1/health
```

## 9. 告警建议（阈值）

| 告警 | 表达式/条件 | 级别 |
| --- | --- | --- |
| 磁盘 >85% | `df` 三机 | P0（disk-guard 会先收紧日志） |
| 服务 health 非 200 | admin /status 任一 down | P0 |
| PG 主日志单日 >200M | 文件 size | P1（SQL 刷屏信号，对照 §5.2） |
| events 无新分区/写入停滞 | 分区清单 + reltuples | P0（collector 故障） |
| infrax-cleanup 日志 ERROR | `grep -i error /var/log/infrax-cleanup.log` | P1（库名/连接漂移） |
| WAL 目录 >10G | `du -sh /var/lib/pgdata_wal` | P2 |

## 10. 历史事故对照（各维度由来）

| 日期 | 事故 | 维度 | 修复 |
| --- | --- | --- | --- |
| 08-21 | ragservicer `.env/.venv/data` 被 `--delete-excluded` 删 | 部署纪律 | 备份/回滚预案（见 EPF-9 方案 §6） |
| 08-21 | syslog 13G 占满磁盘 | 日志防线 | rsyslog logrotate daily |
| 08-22 | collector combined.log 9.7G（`no partition found` 刷屏） | 数据库/日志 | EventPartitionManager + logger 限流 + disk-guard |
| 08-22 | collector 重启假死（孤儿 PG 后端持锁） | 数据库 | Pool keepAlive + PG keepalives + `idle_in_transaction_session_timeout` |
| 08-23 | **PG postgresql-14-main.log 42G**（RETURNING id 兼容层 ERROR 刷屏，根分区 100%） | 数据库/日志 | [db_postgres.py](../projects/data/app/utils/db_postgres.py) INSERT 前探测 id 列 + logrotate maxsize 200M |
| 08-23 | infrax-cleanup 每日失败（/opt 脚本仍是 pocketx_* 旧库名） | 定时任务 | 同步 /opt 副本 + 手动验证 |

## 11. 部署纪律提醒

- 改 `deploy/infrax-cleanup.sh` 后**必须同步** data 机 `/opt/infrax-cleanup.sh`（service ExecStart 指向 /opt，非仓库路径）
- 生产 systemd 改动：`daemon-reload` + 核验 ExecMainPID 与 `ss -ltnp` 实际监听 PID（曾有旧进程占端口）
- 新增密钥走 systemd drop-in（`secrets.conf` root:600），勿写入被 git 跟踪的 `.env.production`（EPF-8 待排期）
