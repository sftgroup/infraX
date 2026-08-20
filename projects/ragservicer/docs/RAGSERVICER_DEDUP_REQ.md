# RAGservicer 文档去重结果不透明 —— 上传 201 成功但内容未入索引，调用方无法感知

> 提交方：AIServicer（aiservicer.0xainet.top，RAGservicer 的集成方）
> 提交日期：2026-08-21
> 目标仓库：sftgroup/infraX（`projects/ragservicer/` 模块）
> 优先级：P1（影响所有依赖上传结果判断的集成方）
> 实施状态：**已实施**（2026-08-21，详见 §8 实施记录）

---

## 1. 问题概述

当上传的文档触发 LightRAG 内部去重时，RAGservicer **仍返回成功（HTTP 201 + task success），但文档内容实际未入索引**。集成方（平台/终端用户）无法从响应中感知"这篇文档被丢弃了"，表现为：

- 上传接口全部 201；
- 任务状态查询返回 success；
- 但 query 永远命中不到该文档内容。

实际业务中已造成真实客户故障：客户上传 7 篇文档均返回成功，其中多篇被判重复，检索始终 [no-context]。

## 2. 复现步骤

1. `POST /api/v1/namespaces/{ns}/documents`，`doc_id` 与已存在文档相同（或 text 与已有文档相同），body：`{ "text": "...", "doc_id": "same-name.txt" }`
2. 响应：`HTTP 201` + `{ "status": "queued", "task_id": "task_xxx" }`
3. 查询任务状态：`GET /api/v1/namespaces/{ns}/tasks/{task_id}` → success
4. 查询文档列表：能看到一条 `dup-<md5>` 记录，但 `chunks=0`、内容未进入索引
5. `POST /query` 检索该文档内容 → 无命中

## 3. 根因定位

LightRAG 流水线内置三通道去重（`pipeline.py`，约 L1290-1380）：

- **3a 文件名去重**：`doc_id`/file_name 与已存在文档相同；
- **3b 内容哈希去重**：text 的 content_hash 与已存在文档相同；
- **3c filename 冲突**：doc_id 冲突但内容不同。

命中任一通道后，流水线生成 `dup-<md5>` 元数据记录（`chunks=0`），**内容不进入切块/嵌入/索引环节**。但该决策只发生在索引 worker 内部，**未向上层返回**：

- `documents.py` 的 `_want_async()` 默认 `async=true`，所有写操作（insert/batch/delete）先行返回 `202 + task_id + status:"queued"`；
- 去重结果不体现在响应体、不体现在任务结果、不体现在文档状态；
- 列表接口的 `status` 字段为展示层映射（`_map_doc_status`），恒显 `"indexing"`，无法反映真实索引结果。

## 4. 影响

1. **调用方无法区分"已索引"与"被丢弃"**，对上传成功产生错误信任，形成静默数据丢失（本次客户故障的直接原因）；
2. 调试成本极高：需逐篇比照去重逻辑 + 遍历文档列表核对 `chunks` 才能定位；
3. 上游 API 成功语义与下游实际效果不一致，破坏集成方的对账能力。

## 5. 期望改进（建议）

按优先级：

1. **【核心】去重决策透出**：当文档被任一通道去重时，响应与文档状态应明确标记，例如：
   - 响应体增加 `deduplicated: true` + `dedup_reason: "file_name_dup" | "content_hash_dup" | "filename_conflict"` + `matched_doc_id`；
   - 文档列表/详情增加真实状态字段（如 `status: "duplicate"`、`chunks: 0`），不再恒显 `indexing`。
2. **任务结果携带失败/跳过明细**：`GET .../tasks/{task_id}` 的结果中返回每篇文档的最终处置（indexed / duplicated / error），而非仅 success。
3. **batch 接口同步反馈**：`/documents/batch` 目前返回 queued 后异步任务在生产环境不执行（见附带发现 6.1），建议批量接口改为逐篇执行或提供可靠的批任务完成状态，否则批量上传的文档永久卡在 indexing。
4. **列表接口支持租户/namespace 过滤**：当前列表为全局视图，集成方无法按租户核对文档（见附带发现 6.2）。

## 6. 附带发现（一并反馈）

### 6.1 `/documents/batch` 异步任务在生产环境未被执行
批量上传返回 `queued + task_id` 后，后台任务从未真正执行，文档永久停留在 indexing，query 永远 no-context。集成方被迫改为逐篇直传单篇 `/documents` 端点才可用。建议确认批量任务的调度/执行链路。

### 6.2 列表接口为全局视图
`GET /api/v1/namespaces/{ns}/documents` 忽略 namespace 与 `X-Tenant-ID`，返回**全部租户的全部文档**；文档 JSON 中无租户字段。这使按租户核对文档、按 bot 列出文档无法实现，集成方只能在自身元数据库另建列表（AIServicer 因此采用"Postgres 元数据 + RAGservicer 纯内容索引"的双写架构绕开）。

### 6.3 删除时序
删除请求同样走异步队列，队列繁忙时删除排队，短暂时间窗口内已删除文档仍可被检索命中（本平台实测：空闲队列删除即时生效，0.4s 内 GONE）。

## 7. 联系方式

- 平台：AIServicer（aiservicer.0xainet.top）
- 如需联调验证用例或访问凭证，请通过 InfraX 对接渠道联系我方。

---

## 8. 实施记录（2026-08-21）

> 对应期望改进 1–4，代码引用 `projects/ragservicer/`。

| # | 期望改进 | 实施 |
|---|---|---|
| 1 | 去重决策透出 | `api/engine.py`：`_insert_one` 在 insert 后比对 FAILED 桶增量（`_disposition_from_failed`），识别 `dup-*` 记录并透出 `deduplicated` / `dedup_reason`（`file_name_dup` / `content_hash_dup` / `filename_conflict`）/ `matched_doc_id`；列表接口（`list_documents`）对 `dup-*` 记录标记 `status: "duplicate"` + `chunks: 0`，不再恒显 indexing；响应字段文档见 `docs/API.md` §4.1–4.3 |
| 2 | 任务结果携带逐篇处置 | `tasks.py` 任务 `result` 字段透出 disposition；batch 任务的 `result.results[]` 为每篇最终处置（indexed / duplicate / error） |
| 3 | batch 同步反馈 / 修复异步不执行 | `_insert_batch_coro` 由"合并单次插入"改为**逐篇走单文档路径**（复用经生产验证的 `_insert_one`），`?sync=1` 或 `async:false` 直接返回 `results[]`；同步函数 `insert_documents_batch` 同口径 |
| 4 | 列表按租户/namespace 过滤 | 列表本就按 `(tenant, namespace)` 实例隔离；补 `tenant` / `namespace` 字段到每篇文档 JSON 供调用方对账 |

**关键修复**：`ainsert` 显式传 `file_paths=[doc_id]`（原默认 `"unknown_source"`，filename 去重与 dup 记录无法按 doc_id 对账）。

**验证**：`pytest tests/test_dedup.py` 10/10 通过；`compileall` 全量编译通过。
**SDK**：python `insert`/`insert_batch` 默认改为同步（`async:false`），调用方可直接读取 `deduplicated` 处置；docstring 同步更新。

### 8.1 生产并发 500 修复（2026-08-21 部署）

去重功能部署后冒烟压测触发生产偶发 500，三层修复：

| 层 | 根因 | 修复 |
|---|---|---|
| 1 | `tenants/manager.py` 无 `busy_timeout`，每请求 `validate_api_key` 写 `last_used_at`，并发写即 `database is locked` → 500 | 连接加 `PRAGMA busy_timeout=10000`（commit `30797b3`） |
| 2 | busy_timeout 下仍偶发 | `last_used_at` 60s 节流 + 写失败降级 debug（commit `98d2a18`） |
| 3 | LightRAG 存储并发争用 | `api/engine.py` 按 `(tenant, namespace)` 用 `asyncio.Lock` 串行化插入（`_insert_one` → `_ns_insert_lock`），同时消除 FAILED 桶 before/after diff 竞态 |

### 8.2 跨 namespace 数据串号（重大缺陷，2026-08-21 发现并修复）

排查并发 500 时发现**跨 namespace 数据合并**：不同 namespace 的文档互相出现在对方的列表/存储中。

**根因**：生产 fork 版 LightRAG 1.5.5（`lightrag/kg/shared_storage.py`）的共享内存存储层以 `(workspace, namespace)` 为键缓存 KV 与锁；`engine.py` 创建实例时未传 `workspace`（默认空）→ 所有 namespace 实例键相同 → 共享同一份 doc_status KV → 数据互相合并 + 存储锁跨 namespace 争用。污染在 fork 引入（8-04）后即存在，**磁盘上 45/49 个 namespace 被污染（665/721 篇文档归属不可信）**。

**修复**（本提交）：`get_rag` 改为 `working_dir=<租户目录>` + `workspace=<namespace>`。fork 的 `global_config["working_dir"]/<workspace>` 文件路径与旧布局 `data/<tenant>/<ns>/` 完全一致，磁盘不变；共享存储键变为 `<ns>:doc_status` 实现隔离。验证：新 namespace 各自仅见自己的文档（iso-a/iso-b），去重仍在 namespace 内正常。

**数据处置**：被污染的 45 个 namespace 已清除（备份 `/home/ubuntu/infraX-1/rag-data-backup-20260821`），由数据方重新上传。`knowledge-injector` 每 6h 自动重灌 `default/market`、`default/onchain` 日报类文档（`crypto:daily` / `volatility:daily` / `tech:*:daily` / `defi:tvl` / `onchain:*` 等）；官网文档（`01-platform-overview.md` 等）与租户人工文档需源头重传。
