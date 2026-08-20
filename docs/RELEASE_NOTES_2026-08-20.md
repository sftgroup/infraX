# InfraX 平台发布说明 — v2026-08-20

> 发布范围：生产环境（43.163.105.172）全量缺陷修复 + 前端 UI 修复 + 仓库治理
> 发布窗口：2026-08-20（北京时间）
> 关联提交：`68673f6` → `df96595` → `3ccd123` → `3bd2fe1`（master 分支）
> 关联文档：[DEPLOYMENT.md](./DEPLOYMENT.md) / [FEATURE_INVENTORY.md](./FEATURE_INVENTORY.md) / [SCENARIO_TEST_SPEC.md](./SCENARIO_TEST_SPEC.md)

---

## 1. 发布概述

本次发布源于对生产环境的**浏览器全模块 E2E 测试**（钱包私钥签名注入方式，3 批次覆盖 12 个功能模块），共修复：

| 类别 | 数量 | 严重度 |
|---|---|---|
| 生产缺陷修复 | 3 | P0 × 1、P1 × 2 |
| 基础设施配置修复（Nginx 路由） | 1 | P2 |
| 前端 UI 修复 | 2 | P2 |
| 仓库治理（异常提交处理） | 1 | — |
| 文档更新 | 2 | — |

**影响面**：所有使用 Multi-Sig Vault、AA Session、WaaS、Data Center（用户级 key）的生产用户；web 前端全部页面。

---

## 2. 变更清单

### 2.1 生产缺陷修复（来自浏览器 E2E 测试发现）

| # | 严重度 | 模块 | 问题现象 | 根因 | 修复 | 代码引用 |
|---|---|---|---|---|---|---|
| F-1 | **P0** | Multi-Sig Vault | 28 个 Safe 的 "Propose"/"Txns" 按钮 onclick 参数均为字面量 `"undefined"`，点击弹窗请求 `/api/vault/safe/undefined` 返回 400 | 后端 `listSafes()` 原样返回 DB snake_case 行（`safe_address`/`chain_id`…），前端 `safeLoadOwned` 使用 camelCase `s.address`，取值为 undefined | `listSafes()` 将 DB 行映射为 camelCase API 对象（`address`、`chainId`、`owners`、`threshold`、`saltNonce`…） | [multiSigService.ts](file:///home/steven/infraX/projects/vault/src/services/multiSigService.ts#L561-L578) |
| F-2 | **P1** | AA Sessions | AA 面板 derive 请求报 `unknown or misconfigured chain 'base-sepolia'`，面板无法派生智能账户 | 前端默认链写死为 `base-sepolia`，生产仅配置 oxachain 链（缺 `AA_BASE_SEPOLIA_RPC_URL`） | 默认链改为 `oxachain`，且从 localStorage 读取链时校验其是否在 `AA_CHAINS` 中，非法值回退 oxachain | [aa.js](file:///home/steven/infraX/projects/web/modules/aa.js#L23) / [aa.js#L108](file:///home/steven/infraX/projects/web/modules/aa.js#L108) |
| F-3 | **P1** | WaaS | `/api/v2/saas/tenants/:id/tokens` 返回 500（前端 Tokens 面板报 Internal server error） | 生产 `tokens` 表缺 `tenant_id`、`min_sweep_amount` 列（saas 路由查询依赖），本地建表定义亦缺失 | 生产执行 `ALTER TABLE` 补列；本地建表语句同步补齐两列 | [database.ts](file:///home/steven/infraX/projects/waas/models/database.ts#L197-L198) |

### 2.2 基础设施配置修复（Nginx 路由）

| # | 严重度 | 问题现象 | 根因 | 修复 |
|---|---|---|---|---|
| C-1 | **P2** | 公网 `GET /api/v2/data/my-keys` 返回 Express HTML 404（此前测试为 "Invalid response"） | Nginx `location /api/v2/data/`（前缀匹配，直连 DC :9102）截获 `/api/v2/data/my-keys`，绕过了 web 代理 `server.js` 中硬编码的 `/api/v2/data/my-keys` → data :9112 路由 | 新增 nginx 专用 `location /api/v2/data/my-keys` → web 代理 :9111 |

> ⚠️ **端口说明（关键）**：web 代理 `server.js` 在生产环境的**实际监听端口为 9111**（非代码默认值 6100）。本次修复首版误将 nginx upstream 写成 `:6100`，导致 502，已修正为 `:9111`。见 [server.js](file:///home/steven/infraX/projects/web/server.js#L37) 中 `/api/v2/data/my-keys` 路由指向 `DATA_HOST:DATA_PORT`（生产 = 9112）。

**Nginx 配置明细**（文件：`/etc/nginx/sites-enabled/infrax`，变更前已备份为 `infrax.bak-20260820`）：

```nginx
#   /api/v2/data/my-keys → web :9111 → data :9112（B-11-3 用户级 key；必须位于 /api/v2/data → dc :9102 之前）
location /api/v2/data/my-keys {
    proxy_pass http://127.0.0.1:9111;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
}
```

- **生效机制**：nginx 最长前缀匹配优先，`/api/v2/data/my-keys` 优先于 `/api/v2/data/`，因此即使配置在后者之后也能命中；为可读性置于前者之前。
- **请求链路**：`https://infrax.0xainet.top/api/v2/data/my-keys` → Nginx → web `server.js`(:9111) → data-service(:9112，钱包签名鉴权) → `{"code":0,"message":"ok","data":{"owner":"0x…","keys":[]}}`
- **验证**：`nginx -t` 通过 + `systemctl reload nginx`；公网带钱包签名返回 200 JSON。

### 2.3 前端 UI 修复（P2，浏览器测试第二批发现）

| # | 模块 | 问题现象 | 根因 | 修复 | 代码引用 |
|---|---|---|---|---|---|
| U-1 | WaaS | 点击 "Tokens" 标签后内容区整块空白 | Add Token 表单与 token 列表内嵌在 Overview 面板内且无 `sub-waas-dash-tokens` 容器；tab 切换逻辑全量 deactive 后无面板可激活 | 拆出独立 `sub-waas-dash-tokens` 面板，承载 Add Token 表单与 token 列表 | [index.html](file:///home/steven/infraX/projects/web/index.html#L409) |
| U-2 | 全局顶部栏 | 钱包地址文本为空（仅绿点显示 connected） | `updateTopbar()` 定义后从未被调用 | 页面初始化（DOMContentLoaded / 就绪分支）后补调用 `updateTopbar()`，带 `typeof` 守卫 | [core.js](file:///home/steven/infraX/projects/web/modules/core.js#L206) |

### 2.4 仓库治理：异常远程提交处理

- **事件**：远程 master 出现提交 `c9c9bbb`（message 为 "docs: AItrader 图谱端点性能问题说明与优化需求"），但混入了基于过期分支的 **2200+ 行前端功能删除**（AA/Insights/Payments 页面与模块、Safe Txns 审批弹窗、`/factors`/`/graph`/`/rag`/`/ml`/`/payments` 代理路由、aa-relay `/v1/account/derive` 端点）。
- **评估结论**：删除与提交声称的性能主题无关（性能缓解方案为 AItrader 服务端缓存）；被删功能均为 2026-08-20 当天新增并已部署生产；采纳删除将导致生产前端崩溃。
- **处置**：新增恢复提交 `68673f6`，将 web 前端与 aa-relay 恢复至 `a28f5ad` 状态，**仅保留** `projects/data/AITRADER_GRAPH_PERF_REQ.md`（性能需求文档，纯文档）；恢复提交后叠加三处缺陷修复。

### 2.5 文档更新

| 文档 | 变更 |
|---|---|
| [DEPLOYMENT.md](file:///home/steven/infraX/DEPLOYMENT.md#L186) | nginx 路由表新增 `/api/v2/data/my-keys` → :9111 专用 location 说明（标注勿删，防回退） |
| [FEATURE_INVENTORY.md](file:///home/steven/infraX/docs/FEATURE_INVENTORY.md) | 新增：12 大功能域 + 架构概览 + 服务端口表 + 近期改进 |
| [SCENARIO_TEST_SPEC.md](file:///home/steven/infraX/docs/SCENARIO_TEST_SPEC.md) | 新增：64 条场景用例（TCNNN 编号，12 模块 + 5 跨模块回归，P0/P1/P2 优先级） |

---

## 3. 部署步骤与验证

### 3.1 生产变更操作（已在 43.163.105.172 执行）

```bash
# 1) 拉取代码（/home/ubuntu/infraX-1）
git pull origin master                      # df96595 → 3bd2fe1

# 2) 重启受影响服务（全部为源码直跑，tsx/node，无需编译）
sudo systemctl restart infrax-web infrax-vault infrax-waas infrax-aa-relay
systemctl is-active infrax-web infrax-vault infrax-waas infrax-aa-relay   # 均为 active

# 3) Nginx 配置（C-1）
sudo cp /etc/nginx/sites-enabled/infrax /etc/nginx/sites-enabled/infrax.bak-20260820
#   → 新增 location /api/v2/data/my-keys（见 2.2）
sudo nginx -t && sudo systemctl reload nginx

# 4) 数据库（F-3，已在发布前执行）
#   ALTER TABLE tokens ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
#   ALTER TABLE tokens ADD COLUMN IF NOT EXISTS min_sweep_amount VARCHAR(32) DEFAULT '0';
```

### 3.2 发布后验证结果

| 验证项 | 方式 | 结果 |
|---|---|---|
| Safe 列表真实地址 | 浏览器 + `/api/vault/safe/owned` | 28 个 Safe，Propose/Txns 按钮全为真实 0x 地址 |
| Safe Txns 弹窗 | 浏览器点击 | Threshold/Nonce/Owners + 交易表正常渲染，可开关 |
| AA derive | 浏览器 + `POST /v1/account/derive` | chain=oxachain，返回 accountAddress，无 misconfigured |
| WaaS tokens | `GET /api/v2/saas/tenants/:id/tokens` | HTTP 200 `{"code":0,"items":[]}` |
| my-keys | `GET /api/v2/data/my-keys`（钱包签名） | HTTP 200 `{"code":0,"keys":[]}` |
| WaaS Tokens 标签 | 浏览器点击 | 表单 + 空态列表渲染，非空白 |
| 顶部栏地址 | 浏览器读取 `#topbar-wallet-addr` | 显示 `0x2ba2…b9f1` |
| 服务健康 | `systemctl is-active` + 各 `/health` | 全部 active / 200 |

---

## 4. 测试摘要（浏览器 E2E，钱包私钥签名注入）

| 批次 | 覆盖模块 | 结果 |
|---|---|---|
| 批 1 | Dashboard、Non-Custodial、MPC Wallet、WaaS | 4/4 PASS（发现 U-1/U-2 两个 P2 UI 问题，已修复） |
| 批 2 | Multi-Sig Vault、AA Sessions、Insights、Payments、Data Center | 5/5 PASS（P0/P1 修复回归通过） |
| 批 3 | 回归：顶部栏地址、WaaS Tokens 标签、Safe、AA | 4/4 PASS（2 个 P2 UI 修复生效） |

- 登录态下全部模块测试期 console **零新增错误**、网络无 4xx/5xx。
- 测试钱包：EOA `0x2ba20a76af1297d4ef9bd242866f690aceaab9f1`（私钥签名注入 localStorage `px_user`/`px_sig`/`px_ts`）。

---

## 5. 回滚方案

| 场景 | 操作 |
|---|---|
| 代码回滚 | `git checkout <上一发布点> && sudo systemctl restart infrax-web infrax-vault infrax-waas infrax-aa-relay`（无数据库 schema 变更，除 F-3 的 tokens 表新增列——新增列不影响旧代码） |
| Nginx 回滚 | `sudo cp /etc/nginx/sites-enabled/infrax.bak-20260820 /etc/nginx/sites-enabled/infrax && sudo nginx -t && sudo systemctl reload nginx` |
| 数据库回滚 | 无需回滚（仅新增列，列缺失由新代码依赖；若回退旧代码则新增列无副作用） |

---

## 6. 遗留事项（非阻塞，建议后续处理）

| # | 事项 | 说明 |
|---|---|---|
| L-1 | 未登录首次加载 3 条守卫报错 | `waasTokens 500` / `my-keys Invalid response` / `/api/vault/safe/undefined`，仅在未登录初始化时出现，登录态下不复现；建议对未登录态下发请求加守卫或静默 |
| L-2 | `infrax-web` 端口约定 | web 服务生产实际监听 9111（非 server.js 默认 6100），由 nginx/systemd 对齐；建议在服务注释与 env 文档中显式标注 |
| L-3 | 远程提交审查 | 建议对非本人提交（如 `c9c9bbb`）在合并前执行 diff 审查，防止基于过期分支的删除混入 |

---

## 7. RAGSERVICER 故障反馈处置（2026-08-20 晚）

**客户反馈**：AIServicer 平台调用 RAGSERVICER（Doc Service）文档上传/检索持续失败，`43.163.105.172:9721` Connection refused。

**根因**：ragservicer 已于 2026-08-16 随存储扩容迁移至新机（见 [INFRAX_MIGRATION_SCALE_OUT.md](./INFRAX_MIGRATION_SCALE_OUT.md)），172 上 `infrax-ragservicer`/`infrax-knowledge-injector` 均已停用（inactive dead）。客户仍使用旧地址属预期失效，非服务故障。

**处置**：
1. 确认新机 `43.156.78.59:9721` 服务运行正常（`/api/v1/*` 带 key 实测 200）；knowledge-injector 在新机内网 `10.3.8.6:9113`，不对外暴露。
2. **修复 nginx `/api/rag/` 网关转发缺陷**：`proxy_pass http://10.3.8.6:9721/` → `http://10.3.8.6:9721/api/v1/`（原配置转发后丢失 `/api/v1` 蓝本前缀导致 404），备份 `infrax.bak.<ts>`，`nginx -t` 通过 + reload。
3. 实测公网网关 `https://infrax.0xainet.top/api/rag/namespaces/{ns}/documents`（GET 200 code 0）与 `/query`（POST 200 code 0）；无 key → 401（鉴权生效）。

**客户侧新配置**：服务地址 `http://43.156.78.59:9721`（或经网关 `https://infrax.0xainet.top/api/rag/`），路径带 `/api/v1` 前缀，沿用 `X-API-Key` 鉴权（401 则重新签发，见 PRODUCTION_CREDENTIALS §7）。

