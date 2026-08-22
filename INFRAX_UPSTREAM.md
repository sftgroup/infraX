# InfraX 上游依赖问题跟踪（3 项，待确认）

> 状态：2026-08-23｜关联：AIHunter SaaS（sftgroup/aihunter-saas）
> 范围：InfraX 数据网关（`https://infrax.0xainet.top`）DEX 数据层与 key 治理
> 协作原则（tasklist 13.5）：AIHunter 与 infraX 为独立项目，**只通知不代修不代合入**；问题与需求以文档形式推送。

---

## 1. 问题总览

| # | 问题 | 状态 | 影响面 | 我方兜底 | 待 InfraX 确认 |
|---|------|------|--------|----------|----------------|
| 1 | `token/history` 对多数币 `count:0` | 观测中 | TokenProfileDrawer History tab 显示 No data | Fail-Silent 空默认 + 前端空态 | 快照覆盖范围与数据来源 |
| 2 | 上游间歇 502/504（生产实测 ~1/3） | 观测中 | 榜单/画像首开偶发空数据（重开恢复） | last-ok 120s 缓存 + Fail-Silent | 根因与 SLA |
| 3 | `dx_6d2a2d` key 解冻 | 实测已恢复 | 曾导致全 DEX 层 401 空数据 | 自动复用 key + Fail-Silent | 正式回执 + 通知机制 |

---

## 2. 问题一：`token/history` 对多数币 `count:0`（画像快照覆盖限制）

### 2.1 现象

- 前端：`TokenProfileDrawer` → **History tab** 对多数代币显示 **"No data"**
- 接口：`GET /api/dex/v2/token/history?chain={chain}&address={address}&hours={hours}`
- 上游返回：`{code:200, data:{count:0, ...}}`（信封正常，业务数据为空）

### 2.2 代码链路

```
TokenProfileDrawer (HistoryTab)
  └─ fetchTokenHistory()                      frontend/src/api/dexApi.ts
       └─ GET /api/dex/v2/token/history        gateway
            └─ passthrough()                   backend/routes/dex-data.ts L145-152
                 └─ dexFetch()                 原生 https GET, X-API-Key, timeout 30s
                      └─ GET https://infrax.0xainet.top/api/v2/data/market/dex/token/history
                           （画像快照 5min 粒度）
```

关键注释（[dex-data.ts](file:///home/steven/aihunter-saas/backend/routes/dex-data.ts) L11、L144）：
> `token/history` 历史价格序列（**画像快照 5min 粒度**）

### 2.3 原因分析（推断）

上游 `token/history` 依赖「**画像快照**」数据：仅对进入快照覆盖范围的币种预生成历史价格序列；多数币不在快照覆盖 → `count:0`。此为非故障性空数据（非 401/502）。

### 2.4 影响与兜底

| 项 | 说明 |
|----|------|
| 影响面 | History tab 数据缺失（不影响画像其他 6 tab：profile/signals/holders/liquidity/traders/trades） |
| 兜底 | 网关 fail-silent 空默认 `{items:[], ts}`（dex-data.ts L150）；前端空态展示，不崩溃 |

### 2.5 待 InfraX 确认

1. `token/history` 的数据来源与**覆盖范围**（哪些币有历史序列？是否有白名单/快照策略）？
2. 覆盖策略：能否对任意 `address` **按需生成/回填**历史序列（而非仅快照币）？
3. `count:0` 的确切含义：币无快照 / 数据未入库 / 参数需调整（如 `hours` 范围）？
4. 若快照定期更新，可否提供快照覆盖的**币种清单**或状态字段，便于前端提示？

---

## 3. 问题二：上游间歇 502/504（生产实测 ~1/3 失败）

### 3.1 现象

- 热门榜单、单币画像等端点**间歇** 502/504，生产实测约 **1/3 失败**
- 前端 `TokenProfileDrawer` 偶发全占位（重开恢复）；`TokenUniversePanel` 热门榜偶发空榜闪烁

### 3.2 代码链路与兜底机制

```
gateway dex-data.ts
 ├─ dexFetch()      L28-70   原生 https GET；非 2xx / 超时 / 断连 → resolve(null)（日志 warn）
 ├─ passthrough()   L73-86   失败 → 回空默认信封（Fail-Silent）
 └─ passthroughCached() L93-117  ★ last-ok 缓存（仅 hot-tokens 榜单使用）
        · 120s TTL 内命中 → 秒回缓存
        · 上游成功 → 刷新缓存
        · 上游失败 → 回退**过期缓存**（避免空榜闪烁）
        · 无缓存 → 空默认
```

配置（`backend/config/index.ts` infraxDex）：`baseUrl` 默认 `https://infrax.0xainet.top`，`timeoutMs` 30s，`INFRAX_DEX_KEY` 优先缺省复用 `DATA_SERVICE_API_KEY`。

### 3.3 影响评估

| 场景 | 表现 | 恢复 |
|------|------|------|
| hot-tokens 失败 | last-ok 回退缓存 | 秒回，无感知 |
| 画像/其他端点失败 | 单 tab 空态 | 重开抽屉恢复 |
| 连续失败（>120s） | 空默认 | 上游恢复后自动恢复 |

### 3.4 待 InfraX 确认

1. 502/504 **根因**：网关聚合超时 / 上游交易所限流 / 单链慢查询？
2. 是否提供上游**可观测指标**（成功率/延迟/熔断状态）或 SLA？
3. 可否给出**降级建议**（如降并发、分批、参数优化）以减少失败率？
4. 502/504 是否会升级为**持续故障**（当前为间歇，fail-silent 已兜底）？

---

## 4. 问题三：`dx_6d2a2d` key 解冻（等正式回执）

### 4.1 背景（key 轮换，tasklist 14.6）

- 旧 key：`dx_5825`（已替换）
- 新 key：`dx_6d2a2d`（当前生效，DEX 数据层复用 `dx_` key）
- 配置：compose gateway 环境 `INFRAX_DEX_KEY=dx_6d2a2d`；`dex-data.ts` L5 注释「INFRAX_DEX_KEY 优先，缺省复用 DATA_SERVICE_API_KEY」

### 4.2 时间线

| 时间 | 事件 | 来源 |
|------|------|------|
| 2026-08-19 | 14.6 key 轮换（dx_5825 → dx_6d2a2d） | tasklist Phase 14.6 |
| 2026-08-21 | 17.5 实弹发现 **key 已放行**：`X-API-Key` 200 返回真实数据（此前 401 为上游权限未生效）；hot-tokens 返回 LINK $10.59 等真实行情 | DEPLOY_RECORDS 2026-08-21 22:10 |
| 2026-08-23 | 实测解冻恢复确认；**等 InfraX 正式回执** | tasklist 待办与延后 |

### 4.3 当前实测状态

- `GET /api/dex/v2/hot-tokens` → 200 真实数据（OKX + DexScreener 双源聚合）
- `GET /api/dex/v2/token` → 200 完整画像（quote/social/risk/pools）
- `GET /api/dex/v2/signals` → 200 真实聪明钱信号
- DEX 数据层 9 端点鉴权正常（401 已消除）

### 4.4 待 InfraX 确认

1. **解冻正式回执**：冻结原因、恢复时间、是否与我方操作相关？
2. 未来 **key 冻结的通知机制**：是否有主动告警/邮件/回调，避免影响上线窗口？
3. key 的**配额/限流策略**：当前用量是否接近上限？是否有建议的调用频控？
4. key 轮换/续期的**规范化流程**（避免 key 生效延迟导致的 401 窗口）。

---

## 5. 回执请求模板（可转发 InfraX）

> **【AIHunter SaaS 上游问题回执请求】**
>
> 1. `token/history`：数据来源与覆盖范围？能否对任意 address 按需回填历史序列？`count:0` 的确切含义？
> 2. 502/504：间歇 ~1/3 失败的根因？是否有上游 SLA/可观测指标？降级建议？
> 3. `dx_6d2a2d`：请正式确认解冻（原因/时间）；后续 key 冻结是否有主动通知机制？配额/限流策略？
>
> 联系：sftgroup/aihunter-saas 仓库维护者（问题以文档形式推送，见 infraX 侧 REQ 文档）

---

## 6. 相关引用

| 项 | 位置 |
|----|------|
| 网关 DEX 透传层 | [dex-data.ts](file:///home/steven/aihunter-saas/backend/routes/dex-data.ts)（dexFetch L28-70 / passthrough L73-86 / last-ok L88-117 / token/history L145-152） |
| 网关配置 | `backend/config/index.ts` `infraxDex`（baseUrl / timeoutMs / INFRAX_DEX_KEY） |
| 前端消费 | `frontend/src/api/dexApi.ts`、`frontend/src/components/dex/TokenProfileDrawer.tsx`（7 tab） |
| 部署记录 | [DEPLOY_RECORDS.md](file:///home/steven/aihunter-saas/DEPLOY_RECORDS.md) 2026-08-21（key 放行 22:10 / R1-R10 接入 21:30） |
| tasklist | Phase 14.6（key 轮换）、Phase 17（R1-R10，17.5 key 解冻确认）、待办与延后（3 项上游依赖） |
| 协作原则 | tasklist 13.5：只通知不代修不代合入 |

---

## 7. InfraX 侧回执（2026-08-23）

> 状态：3 项均已答复；其中 502/504 已修复、SOL 链覆盖已补齐（commit 见文末）。关联 InfraX 代码仓库 `sftgroup/infraX`。

### 7.1 问题一：`token/history` count:0 — 确认为「快照覆盖限制」（非故障）

**数据链路（InfraX collector）**
- `token/history` 读 collector 自有 PG 表 `okx_market_token_profiles`（[okxMarketScheduler.ts `snapshotTokenProfiles`](file:///home/steven/infraX/projects/collector/src/services/okxMarketScheduler.ts#L180-L227)），非实时上游查询
- 快照覆盖：**每链 OKX 热门榜 top 30**（`OKX_MARKET_CANDLE_TOKENS` 默认 30），5min 粒度（`schedulerProfileMs=300000`）
- 默认链：`1,56,8453`（ETH/BSC/BASE）；**SOL(501) 此前未纳入** → SOL 链 history 基本全空（已于本次补齐，见 7.2）

**结论**
1. `count:0` = 币不在每链热门 top 30 覆盖（非 401/故障/参数问题）
2. 覆盖策略：当前仅热门 top 30；**不支持任意 address 按需回填**（可评估：扩覆盖上限 / 白名单追加 / 按需快照，需 InfraX 排期）
3. 建议 AIHunter 侧：History tab 优先展示 hot-tokens 榜单币（保证有快照）；对非榜单币空态提示「无快照覆盖」

### 7.2 问题二：502/504 — 根因确认 + 已修复（2026-08-23）

**根因（三层）**
1. nginx `location /api/v2/data/market/dex/` **未配置 `proxy_read_timeout`**（默认 60s）；OKX OnchainOS 慢响应时超 60s → 504
2. collector OKX 客户端 `fetch()` **无超时**（[okxMarketV6.ts](file:///home/steven/infraX/projects/collector/src/services/okxMarketV6.ts)）→ 上游慢/挂起时无限等待，拖到 nginx 超时；OKX 5xx/429 指数退避重试（1s→2s→4s，最多 3 次）+ hot-tokens 逐 token 补池行情（串行）放大延迟 → 502（upstream 中断）
3. web 代理（[server.js](file:///home/steven/infraX/projects/web/server.js)）所有后端路由 **全局 socket `timeout: 15000`** → collector 冷调（OKX 慢响应 + 逐 token 补池，实测 22~25s）超 15s → 504（生产实测 hot-tokens 冷开 504@15s）

**已落地修复（collector/nginx 层 commit c8c78a4；web 层 commit 387576b）**
- nginx：`/api/v2/data/market/dex/` 增加 `proxy_read_timeout 120s`
- collector：OKX `fetch()` 增加 `AbortSignal.timeout(25000)`（`OKX_MARKET_HTTP_TIMEOUT_MS` 可调），超时抛明确错误并由各端点 try/catch / Promise.allSettled 降级（非 500）
- web：collector 路由（`/api/v2/data/market`、`/api/dex`、`/api/v2/market`）改路由级 `timeout: 90000`（`COLLECTOR_ROUTE_TIMEOUT_MS` 可调），其余路由保持 15s（`WEB_PROXY_TIMEOUT_MS` 可调）

**修复后生产实测（2026-08-23）**
- `hot-tokens` 冷调用：原 504@15s → 现 200@24s（OKX 慢响应被 25s 超时兜底，web 90s 放行）；缓存命中 0.5s
- `token/history`（SOL 链）：200 真实数据（Bicat count=1）

**可观测性建议（供后续）**
- 可提供上游成功率/延迟指标（collector 已有请求日志，可对接 Prometheus）；当前无 SLA 承诺
- 上游偶发慢/5xx 属 OKX OnchainOS 侧行为，已通过超时 + 降级收敛影响面

### 7.3 问题三：`dx_6d2a2d` key — 解冻正式回执 + 治理说明

1. **解冻确认**：2026-08-21 放行（`X-API-Key` 200 真实数据；此前 401 为上游权限未生效），当前 9 端点鉴权正常，无需额外操作
2. **冻结机制**：InfraX admin `PATCH /admin/api-keys/{id}` 置 `enabled=0` 即冻结（api_keys 表 enabled 字段，SHA-256 哈希存储）；**当前无主动通知机制**（key 冻结无 webhook/告警，依赖调用方发现 401）——已列为 InfraX 待办（key 冻结告警）
3. **配额/限流**：外部 key 统一 `DX_EXTERNAL_KEY_RATE_LIMIT=100` RPM 滑动窗口（collector 鉴权层）；当前 dx_6d2a2d 用量远低于上限
4. **轮换/续期规范**：建议走 InfraX admin 统一签发 API（`POST /admin/api-keys`），签发后即时生效；轮换前与调用方约定窗口

### 7.4 SOL 链覆盖补齐（2026-08-23）

- `OKX_MARKET_SCHED_CHAINS` 增加 `501`（SOL）：生产 collector 配置 `1,56,8453,501` → SOL 热门币进入 hot-tokens / token-profiles / candles 快照，`token/history` SOL 链可返回数据
- 生效条件：collector 重启后下一轮快照（5min 内）；历史序列从重启后累积

### 7.5 REQ-3：rx key RPC 配额升级 + 用量清单 + 告警（2026-08-23）

> 对应 AIHunter 侧 `docs/requirements-infrax.md` REQ-3（rpc_free 10000/10004 耗尽 → 读链 503，阻塞 11.7 NFT mint 端到端验证）。commit 1c34878 已部署生产。

**升级（已生效）**
- `aihunter-saas-rpc-read`（rx_d6f33…6d1f，rpc_keys id=4）：**rpc_free → rpc_pro**（1 万 → **10 万次/月**，$79/月档；实际用量集中在 8-16 单日 ~1 万次，升级后请求已恢复，实测用量 10004 → 10137 持续增长）
- 广播 key（bx_5b184）与钱包 key 未动；如需更高档（enterprise 100 万/月）可再升

**用量清单接口（新增）**
- `GET /v1/subscription/admin/keys`（X-Service-Key = CHAIN_RPC_READ_KEY / BROADCAST_KEY）→ 全部 rx_/bx_ keys 的掩码/套餐/配额/本月用量/使用率/告警标记 + 汇总（total/alerting/阈值）
- 说明：dx_/mx_ 等 data-service 签发 key 的用量清单在 data 服务管理面板（`/admin/api-keys`，request_count 累计）

**配额告警（新增）**
- chain-rpc 定时扫描（`RPC_QUOTA_ALERT_INTERVAL_MS` 默认 30min，启动即扫一次）：enabled keys 本月用量 ≥ 阈值（`RPC_QUOTA_ALERT_THRESHOLD` 默认 80%）→ `logger.warn`（掩码/用量/配额/使用率）+ 可选 webhook POST（`RPC_QUOTA_ALERT_WEBHOOK_URL` 配置则推送，未配置仅日志）
- 生产实测：注入 8500 条用量使 key 达 85% → 告警触发（`RPC quota alert: ... used=8500/10000 (85%)`），验证后已回滚
- 主动通知：平台暂无通用 webhook 基础设施；告警经日志 + 接口暴露，可对接既有监控（Prometheus/日志抓取）

**验收对照**：`eth_chainId` 恢复 200（用量 < 配额）；`admin/keys` 接口可用；告警机制可用（≥80% 触发）。

### 7.6 AIHunter /factory 页面两条观察回执（2026-08-23）

> AIHunter 侧 /factory 页面实测发现：`GET /api/market-data/catalog → 503`（因子目录不可用）与 `GET /api/strategy-factory/runs/10 → 404`。InfraX 侧逐条核实。

**① 因子目录 503（rx 配额耗尽连带）— 已恢复，无需 InfraX 改动**
- 链路：AIHunter gateway `dsFetch('/factors/catalog')` → InfraX data-service `:9112/factors/catalog`（X-Service-Key）；B 端非 2xx/不可达时 AIHunter 返回 `503 {code:50301}`，前端降级「因子目录不可用」（fail-silent 设计，降级行为正确）
- 根因：8 月中旬 rx key（`aihunter-saas-rpc-read`，rpc_keys id=4）rpc_free 1 万/月配额耗尽，读链 503 连带的间歇不可达现象
- 现状实证：rx key 已升级 **rpc_pro**（10 万/月，REQ-3 2026-08-23），本月已用 11072（≈11%）配额充足；data-service `/factors/catalog` 生产实测 **200 完整因子目录**（bridge key，:9111→:9112）
- 若 AIHunter 侧仍复现 503：需自查 `DATA_SERVICE_URL`（生产 `https://43.163.105.172/api/data` IP 直连）可达性与超时（默认 10s）

**② 历史运行 #10 404（旧记录不存在）— AIHunter 侧数据问题，只通知不代修**
- 链路：`GET /api/strategy-factory/runs/10` → AIHunter python-backend `get_run(10, user_id)` 查**自有运行记录表**，按用户隔离；run 10 不存在或归属他人 → `404 {code:404, run 10 not found}`
- 可能原因：旧记录被清理 / 表重建后 id 不连续 / 记录归属其他用户
- 建议 AIHunter 自查：runs 列表点击旧记录时前端处理 404（提示"记录已失效"或从列表移除）；确认运行记录保留策略（旧记录是否可删、id 是否可复用）
