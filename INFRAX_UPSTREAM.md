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
