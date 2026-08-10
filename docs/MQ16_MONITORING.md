# MQ-16 上线监控 — DC 配额使用率与订阅状态分布

> 2026-08-11 · 覆盖 MQ-16 T-1（DC 套餐配额真实扣减）上线后的可观测性。
> 数据源：`pocketx_dc`（`api_usage` 月度计数 + `tenants.dc_sub_status`），经 [dc/index.ts](../projects/dc/index.ts) 的 `GET /metrics` 暴露为 Prometheus 指标。

## 1. 指标清单（infrax-dc :9102 `/metrics`）

免鉴权（对齐 [projects/shared/metrics.py](../projects/shared/metrics.py) 的统一接入，探针可拉取），15s TTL 内复用上次查库结果。

| 指标 | 类型 | Labels | 说明 |
| --- | --- | --- | --- |
| `dc_subscription_status_total` | Gauge | `status`（active/pending/none） | 租户订阅状态分布 |
| `dc_quota_used_total` | Gauge | `plan`（data_free/data_pro/data_enterprise） | 本月已用配额（api_usage 月度 COUNT） |
| `dc_quota_limit_total` | Gauge | `plan` | 套餐配额上限（apiCallsPerMonth） |
| `dc_quota_usage_ratio` | Gauge | `tenant`（租户 UUID）/ `plan` | 租户级本月使用率（used/quota，超限按 1） |

默认指标（`process_*`、`nodejs_*`）由 `collectDefaultMetrics` 一并暴露。

## 2. Prometheus 抓取配置

```yaml
scrape_configs:
  - job_name: infrax-dc
    metrics_path: /metrics
    static_configs:
      - targets: ['127.0.0.1:9102']   # 生产：dc 服务端口
    scrape_interval: 30s
```

## 3. Grafana 看板

导入 [deploy/monitoring/mq16_dashboard.json](../deploy/monitoring/mq16_dashboard.json)（uid `infrax-mq16-dc-quota`，数据源变量 `DS_PROMETHEUS` 选 Prometheus 即可）：

- **Stat**：活跃订阅数 / 待支付（pending）数 / 租户总数
- **时间序列**：各套餐配额使用率趋势（`dc_quota_used_total / dc_quota_limit_total`，0.7 黄 / 0.9 红阈值）
- **柱状图**：本月已用 vs 配额上限（按套餐）
- **饼图**：订阅状态分布（active 绿 / pending 橙 / none 蓝）
- **表格**：Top 20 租户配额使用率（`sort_desc(topk(20, dc_quota_usage_ratio))`）

## 4. 告警建议（Prometheus alerting 规则）

```yaml
groups:
  - name: infrax-dc-quota
    rules:
      - alert: DcQuotaUsageHigh
        expr: dc_quota_used_total / dc_quota_limit_total > 0.9
        for: 10m
        labels: { severity: warning }
        annotations: { summary: 'DC 套餐配额即将耗尽', description: '{{ $labels.plan }} 使用率 > 90%' }
      - alert: DcPendingSubscription
        expr: dc_subscription_status_total{status="pending"} > 0
        for: 30m
        labels: { severity: info }
        annotations: { summary: '存在待支付订阅', description: '{{ $value }} 个租户订阅待支付确认' }
```

## 5. SQL 兜底查询（无 Prometheus/Grafana 时，直查 `pocketx_dc`）

```sql
-- 配额使用率（按套餐）
SELECT t.data_plan_id, COUNT(a.id) AS used
FROM tenants t
LEFT JOIN api_usage a ON a.tenant_id = t.id AND a.timestamp >= date_trunc('month', now())
GROUP BY 1;

-- 订阅状态分布
SELECT COALESCE(dc_sub_status, 'none') AS status, COUNT(*) AS cnt
FROM tenants GROUP BY 1;

-- 近 7 日调用量（api_usage_daily 日聚合）
SELECT date, endpoint, SUM(total_calls) AS calls
FROM api_usage_daily
WHERE date >= current_date - 7
GROUP BY 1, 2 ORDER BY 1;
```

## 6. 备注

- 租户级 `dc_quota_usage_ratio` 为高基数 label；自托管规模可直接使用，租户量大时建议改为只暴露 Top-N（见 [dc/index.ts](../projects/dc/index.ts) `refreshMetrics` 注释）。
- `/metrics` 查库失败仅记日志、返回空集，不影响业务（与配额记账的故障不阻断策略一致）。
