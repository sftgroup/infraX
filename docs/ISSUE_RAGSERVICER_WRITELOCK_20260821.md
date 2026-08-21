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

---

## 8. 修复验证结果（2026-08-21 深夜，服务已恢复，遗留 delete 问题）

2026-08-21 深夜对方处理后再测，**慢响应/写锁问题已修复**，但发现 **delete 接口不生效** 的遗留问题。实测（生产主机 curl，`bmt1rmh9w7kxa` 租户）：

### 8.1 已修复项

| 请求 | 之前（坏窗口） | 现在 |
|---|---|---|
| health ×4 连发 | 固定 10s | **12ms / 11ms / 10ms / 9ms** |
| GET list documents | 20s 超时（HTTP 000） | 26ms |
| POST 单篇上传 | 20s+ | **202 入队（18ms）**，task 正常执行 |
| 索引任务 | 永不执行（文档卡 `indexing`） | **已执行**：新文档 query 可命中（知识图谱 + chunk 完整返回） |

### 8.2 遗留问题（请 InfraX 处理）

1. **DELETE 接口不生效（P1）**：对同一文档连续两次 DELETE 均返回 `{"deleted":true}`（HTTP 200，12ms），但文档**仍可被 query 检索到**（命中全文与知识图谱），且 list 仍返回该文档。影响：客户「删同名 → 重传」流程失效（旧文档删不掉，重传同名文档会 dedup/叠加）。
   - 复现：`POST /api/v1/namespaces/{ns}/documents` 上传 `hc-1787333621.md` → `DELETE .../documents/hc-1787333621.md`（两次均 deleted:true）→ `POST /api/v1/namespaces/{ns}/query` 仍命中该文档内容。
2. **偶发超时仍存在（P2）**：连续 query 第 1 次 15s 超时（HTTP 000），第 2 次 185ms 正常——「时好时坏」概率已大幅下降但未完全消除。
3. **list 状态字段滞后（P3）**：已索引且可检索的文档仍显示 `status: indexing`，状态不更新。

### 8.3 对客户的影响与临时应对

- 客户可**开始重传文档**（索引链路已恢复）；但**暂不建议依赖「删同名」步骤**（DELETE 不生效）。
- 测试文档 `hc-1787333621.md`（13B，租户 `bmt1rmh9w7kxa`）已无法通过 DELETE 清理，保留作排查证据，请 InfraX 侧一并处理。

---

## 9. InfraX 修复确认（2026-08-22，commit 5f2683b，已部署生产）

针对第 8 节遗留问题，InfraX 已完成修复并部署：

**根因（delete 不生效）**：`delete_document` 忽略 LightRAG `adelete_by_doc_id` 的 `DeletionResult` 返回值。pipeline 忙（索引进行中）时 LightRAG 返回 `not_allowed`（删除未执行、12ms 快速返回），服务层掩盖为 `deleted:true` —— 与"返回成功但删不掉"现象完全吻合。

| 遗留项 | 修复 | 生产验证（租户 `bmt1rmh9w7kxa`） |
|---|---|---|
| **8.2-1 DELETE 不生效（P1）** | 透传 DeletionResult 四态：success→`deleted:true`；not_found→幂等 `deleted:true`+`found:false`；**not_allowed/fail→不再掩盖**，REST 同步删除 not_allowed → **503 + Retry-After**（`DELETE_NOT_ALLOWED`），fail → 500 | `hc-1787333621.md` DELETE **32ms 真实删除**（success），幂等重删 `not_found`+`found:false`，list total 0（文档已彻底清除，可正常「删同名→重传」） |
| **8.2-2 偶发 query 15s 超时（P2）** | 定位为冷查询首次图加载（服务端 `aquery` 超时 300s，客户端/网关 15s 截断）；二次命中缓存 185ms | 建议：客户端对首查放宽超时 15s→60s；服务端暂不做通用预热（query 需真实参数），待排期 |
| **8.2-3 list 状态滞后（P3）** | `_map_doc_status` 对 DocStatus 枚举取 `.value`（此前 `str(枚举)` 得 `"DocStatus.PROCESSED"` 恒显 `indexing`） | `hc-1787333621.md` 状态显示 **`indexed`**（此前恒显 `indexing`） |

**附加**：异步删除（`?async=1`）的任务结果现携带删除处置（`GET /tasks/{id}` → result `{status, message, status_code}`），调用方可对账。

**请 AIServicer 侧按第 8.2 节复现步骤回归**：上传 → DELETE → 确认 list 为空 / query 不再命中；删除未命中时按 503 + Retry-After 重试语义处理。单测 34 passed（含 9 个新增 RDL 用例）。

---

## 10. B 端调试指南（2026-08-22，AIServicer 回归对照用）

### 10.1 删除接口响应语义速查（RDL-1）

| HTTP | 响应体 | 含义 | B 端处理 |
|---|---|---|---|
| `200` | `{"deleted": true, "found": true, "status": "success"}` | **删除真实生效**：文档已从知识图谱移除 | 对账：`list` 不再出现该 doc_id；`query` 不再命中其内容 |
| `200` | `{"deleted": true, "found": false, "status": "not_found"}` | 文档本就不存在，**幂等删除成功** | 无需重试；「删同名→重传」的删除步骤可直接通过 |
| `503` | `{"code": "DELETE_NOT_ALLOWED", "message": "..."}` + `Retry-After: 5` | **pipeline 忙，删除未执行**（索引/其他删除进行中） | **必须按 `Retry-After`（5s）后重试**；重试期间文档仍存在属预期，不可判定为失败 |
| `500` | `{"code": "DELETE_FAILED", "message": "..."}` | 删除内部失败（图谱重建异常等） | 指数退避重试；连续失败提供 `message` 反馈给 InfraX |

> **判定删除是否成功的唯一标准**：响应 `status == "success"`（或幂等 `not_found`），且随后 `GET list` 不含该 `doc_id`。若 DELETE 返回 `200 deleted:true` 但 list 仍含该文档，说明遇到的是旧版服务（未部署 5f2683b），请确认网关/服务已更新。

### 10.2 curl 回归验证步骤（可直接执行）

```bash
BASE="http://<host>:9721/api/v1"          # 或公网入口 infrax.0xainet.top/api/rag/v1
KEY="<X-Tenant-ID 对应租户 API Key>"
T="<tenant_id>"; NS="<namespace>"         # 例：T=bmt1rmh9w7kxa NS=bmt1rmh9w7kxa

# 1) 上传测试文档（202 入队 → 轮询 task 至 indexed）
curl -s -X POST -H "Authorization: Bearer $KEY" -H "X-Tenant-ID: $T" \
  -H "Content-Type: text/markdown" --data-binary "RDL regression: delete me" \
  "$BASE/namespaces/$NS/documents"          # → {"data":{"task_id":"..."}}

# 2) list 确认状态为 indexed（RDL-3：此前恒显 indexing）
curl -s -H "Authorization: Bearer $KEY" -H "X-Tenant-ID: $T" \
  "$BASE/namespaces/$NS/documents?limit=50" # → status: "indexed"

# 3) 同步删除（应 200 success）
curl -s -X DELETE -H "Authorization: Bearer $KEY" -H "X-Tenant-ID: $T" \
  "$BASE/namespaces/$NS/documents/<doc_id>" # → 200 {"deleted":true,"found":true,"status":"success"}
#    若 503 → sleep 5 后重试，直至 success

# 4) 幂等重删（应 200 not_found）
curl -s -X DELETE -H "Authorization: Bearer $KEY" -H "X-Tenant-ID: $T" \
  "$BASE/namespaces/$NS/documents/<doc_id>" # → 200 {"deleted":true,"found":false,"status":"not_found"}

# 5) 对账：list 不再包含该文档
curl -s -H "Authorization: Bearer $KEY" -H "X-Tenant-ID: $T" \
  "$BASE/namespaces/$NS/documents?limit=50" # → total 不含 <doc_id>

# 6)（可选）异步删除 + task 对账
# DELETE ...?async=1 → 202 task_id → GET .../tasks/{task_id} → result.status ∈ {success,not_found}
```

### 10.3 常见问题排查

| 现象 | 判定 | 处理 |
|---|---|---|
| DELETE 返回 200 `deleted:true` 但 list 仍含文档 | 服务未部署 5f2683b（旧版掩盖 not_allowed） | 确认 ragservicer 已重启到新版本；仍复现则反馈 InfraX |
| DELETE 返回 503 `DELETE_NOT_ALLOWED` | pipeline 忙（索引任务进行中），删除未执行 | 按 `Retry-After` 重试；批量删除建议排队串行（每次 503 后 sleep 5） |
| 上传后 list 状态恒 `indexing` | 索引任务未完成（新上传需数十秒~分钟级） | 轮询 list 至 `indexed` 或 `error`；长期卡 indexing 反馈 InfraX |
| 首查 query 15s 超时（HTTP 000），重试即快 | 冷查询首次图加载（P2，RDL-4） | 对**首次**查询放宽超时到 60s；或预热：先执行一次任意小 query |
| 删除已索引文档耗时较长 | 正常：LightRAG 图谱重建 | 同步删除建议客户端超时 ≥120s；可改用 `?async=1` 轮询 task |

### 10.4 状态字段语义（RDL-3，list / task 通用）

| 状态 | 含义 |
|---|---|
| `indexed` | 已切块并写入知识图谱，可被 query 命中 |
| `indexing` | 处理中（切块/嵌入/写库未完成） |
| `error` | 切块/嵌入失败——可**重传同名文档**覆盖重试 |
| `duplicate` | 与已存在文档重复（`dedup_reason` 区分 文件名/内容哈希） |
