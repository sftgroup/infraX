# RAGSERVICER 写路径可用性 —— SQLite 写锁导致上传/建租户大面积失败（database is locked）

> 提交方：AIServicer（aiservicer.0xainet.top，RAGSERVICER 的集成方）
> 提交日期：2026-08-21
> 目标仓库：sftgroup/infraX（`projects/ragservicer/` 模块）
> 优先级：P0（直接导致集成方上传/租户开通不可用，客户业务中断）
> 关联需求：`RAGSERVICER_DEDUP_REQ.md`（去重结果不透明，本需求侧重写锁可用性）

---

## 1. 问题概述

2026-08-21 上午（约 06:30-06:50 CST）RAGSERVICER 写路径持续不可用：

- `POST /api/v1/tenants`（建租户，Admin API）连续多次返回 **HTTP 500 `{"message":"database is locked"}`**，每次耗时 **10-11 秒**（非立即失败，是等待后失败）；
- `POST /documents`（上传）返回 **500 HTML（Flask 错误页）**，耗时 10 秒+；
- 服务健康检查 `GET /api/v1/health` 由正常毫秒级劣化为 **5.5 秒**；
- 故障期间集成方（客户）上传全部失败：SDK 挂起无响应（>5 分钟）、HTTP 客户端 15 秒超时、网关透传 `fetch failed` / 502；
- **故障持续 20+ 分钟**，不是瞬时抖动；恢复后写路径仍偶发 10 秒级慢响应（SQLite 写锁残留）。

## 2. 复现证据（集成方实测）

| 时间点 | 请求 | 结果 | 耗时 |
|---|---|---|---|
| 故障期 | health | 200 | 5.5s |
| 故障期 | 建租户（Admin） | 500 `database is locked` | 10.2-11.5s ×3 连发 |
| 故障期 | 上传文档 | 500 HTML | 10.5s |
| 故障期 | query | 500 HTML | 10.5s |
| 恢复后 | health | 200 | 13ms |
| 恢复后 | 建租户 | 201（首次）/ 500 UNIQUE（幂等冲突） | 20ms / **10.0s** |
| 恢复后 | 上传文档 | 202 + task_id | **10.0s** |

> 注意：幂等冲突（UNIQUE constraint）本应毫秒级返回，实测耗时 10 秒——说明写锁等待（busy 等待）发生在连接层，与业务是否冲突无关。

## 3. 根因分析（基于源码）

1. **租户存储为 SQLite 且单写者**：[tenants/manager.py](projects/ragservicer/tenants/manager.py) 每次操作新建连接（`_get_conn()`），**未设置 `busy_timeout`**。SQLite 单写者模型下，一旦有长写事务持锁，其他写操作立即/超时失败，抛 `database is locked`。
2. **写路径与读路径并发模型**：[api/tasks.py](projects/ragservicer/api/tasks.py) 写操作（insert/batch/delete）进有界队列 + 后台 worker 线程，读操作（query/retrieve）在请求线程直连全局事件循环。但 **Admin API 的建租户（`create_tenant`）走请求线程同步写 SQLite**，与后台 worker 的 LightRAG 写入并发争锁。
3. **锁等待不透明**：写锁冲突时返回 500 + `database is locked`，HTTP 语义上无法区分"可重试的瞬时锁冲突"与"持久故障"，集成方只能盲猜重试。
4. **慢任务持锁放大**：LightRAG 索引任务（切块/嵌入/写库）耗时数分钟级，若期间占用 SQLite 写锁，整个服务的租户/文档写路径全部阻塞（本次故障即表现为所有写操作 10s+ 失败）。
5. **无监控/告警**：无写锁竞争、队列深度、慢任务指标的暴露，故障只能靠集成方探测反馈。

## 4. 影响

1. 集成方上传、租户开通、Key 签发等所有写操作大面积失败，**客户业务中断**；
2. 错误形态多样（500 HTML / database is locked / 超时 / fetch failed），排查成本极高；
3. 写锁冲突被包装成普通 500，触发不了集成方重试策略 → 静默失败面扩大；
4. 健康检查指标失真（health 5.5s 仍返回 200），无法作为存活/健康判据。

## 5. 期望改进（建议）

按优先级：

1. **【P0】SQLite 写锁友好化**：
   - `_get_conn()` 设置 `busy_timeout`（如 30s，建议从配置读取），让短锁冲突自动等待而不是直接抛错；
   - 长事务最小化：写操作失败后关闭连接、快速返回；
   - 对幂等写（如 `INSERT OR IGNORE`）短路，避免无谓写锁。
2. **【P0】锁冲突可重试语义**：`database is locked` / `WriteQueueFull` 统一返回 **503 + Retry-After**（而非 500/HTML），让集成方按标准语义重试。
3. **【P1】写锁监控与告警**：暴露指标——SQLite busy 次数/等待时长、写队列深度、worker 积压、慢任务清单；故障期触发告警。
4. **【P1】建租户与文档写并发解耦**：租户元数据建议迁移 PostgreSQL（服务已有 PG），避免租户 CRUD 与 LightRAG 索引写争同一个 SQLite 文件；至少确保 Admin API 与 worker 使用不同 SQLite 文件。
5. **【P1】连接复用**：租户 SQLite 使用连接级联复用 + WAL（已有），减少每请求建连/关连的开销与锁窗口。

## 6. 联系方式

- 平台：AIServicer（aiservicer.0xainet.top）
- 如需联调验证用例或访问凭证，请通过 InfraX 对接渠道联系我方。

---

## 7. 复现追加（2026-08-21 晚间，同一故障模式复发）

客户（bitbyte）反馈「transaction Bot 知识库上传接口不可用，0/7 文档失败；support/sales 正常」，等待我方确认 RAGSERVICER 健康。实测（2026-08-21 约 21:40 CST，生产主机 curl）：

| 时间点 | 请求 | 结果 | 耗时 |
|---|---|---|---|
| 坏窗口 | health ×3 连发 | 200 | **10.01s / 10.02s / 10.01s**（稳定 10s，非抖动） |
| 坏窗口 | POST 单篇上传（不存在租户，403 预期） | 403 | **20.03s** |
| 坏窗口 | DELETE 文档 | 403 | **10.02s** |
| 坏窗口 | GET list documents（客户租户） | 超时 | **20s 无响应（HTTP 000）** |
| 恢复窗口（连测 2/3 轮） | query | 200 | 正常（数秒内返回） |

**结论**：服务在线但处于**稳定慢响应窗口**——所有请求固定 10-20s（写路径 20s、读/健康 10s），与上午 SQLite 写锁故障（10-11s）模式一致；时好时坏（偶发恢复）。此窗口内客户上传全部失败（响应超时后失败），符合 bitbyte「transaction 0/7 上传不可用」反馈。

**持续影响**：客户知识库上传/检索不可用（生产 `bmt1rmh9w7kxa` 等租户）；我方已指导客户待服务恢复后重传。请 InfraX 侧按第 5 节建议排查写锁/慢任务持锁；并请确认是否已有修复排期。
