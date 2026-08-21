# InfraX 统一任务清单（infrax_tasklist）

> 最后更新: 2026-08-21 | 适用版本 `v0.7.0-20260811`
>
> **2026-08-21 精简**：原 §1~§8 数据栈部署手册已迁入 [DEPLOYMENT.md](../DEPLOYMENT.md)「数据栈部署」章节；本文件自此为**全站唯一任务清单维护点**，久远已完成任务压缩为一行摘要（完整历史见 git）。原 `docs/DEPLOYMENT_DATA_STACK.md` 于 2026-08-07 更名并入本文件。
>
> 覆盖模块：`data` (:9112) / `knowledge-injector` (:9113) / `ragservicer` (:9721) / `ml-service` (:9120, 独立服务器) / 区块链栈 9100-9132 / 平台服务 9200-9201/3500 / MCP 3008-3013
>
> 状态标记：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办 ｜ ⏸️ 延后 ｜ 🟡 部分

---

## 1. 数据栈部署手册（已迁至 DEPLOYMENT.md）

> 原 §1~§8（架构 / 首次部署 / 配置详解 / 数据源降级链 / 验证清单 / 运维 / 故障排查 / ML 模型服务）已于 **2026-08-21** 整体迁入 [DEPLOYMENT.md「数据栈部署」章节](../DEPLOYMENT.md)。
>
> 速查：
> - **架构**：data :9112（K线/因子/快照，SQLite）←→ ml-service :9120（ML 机 43.156.25.197）；knowledge-injector :9113 → ragservicer :9721（LightRAG 图谱，均在新机 43.156.78.59）
> - **入口**：B 端一律经 172 nginx 唯一公网入口 `infrax.0xainet.top`（`/api/data/*`→:9112、`/api/rag/*`→10.3.8.6:9721、`/api/ml/*`→43.156.25.197:9120）；新机 9721/9113 公网入方向保持关闭
> - **配置**：四服务 `.env` 表、多市场采集（data_config.json）、服务间鉴权三 header（Bearer / X-API-Key / X-Service-Key）、`dx_` 多租户 key（`/admin/api-keys` 签发，仅存 SHA-256 哈希）
> - **运维**：日志 `projects/{data,knowledge-injector,ragservicer,ml-service}/service.log`；数据 `data/data.db` / `knowledge-injector/data/injector.db` / `ragservicer/data/`
> - **ML 模型**：LightGBM / XGBoost / RF / FinBERT / Kronos 2026-08-05 起独立部署（43.156.25.197），主栈仅 HTTP 拉取结果

---

## 9. 统一任务清单（唯一 tasklist 维护点）

> **唯一维护点**：全部需求/任务统一在此登记状态；详细契约见源文档（`projects/data/AITRADER_DATA_SERVICE_REQ.md` / `projects/ragservicer/docs/REQUIREMENTS.md` / `docs/DATA_MODULE_RAG_PLAN.md` / `docs/SESSION_KEY_ENGINE_DEV_PLAN.md` / `docs/SESSION_KEY_ENGINE_PRD.md` / `docs/MERGE_PLAN_AITRADER.md` / `prd/PRD.md` / `docs/MCP_REQUIREMENTS.md` / 本文件 §1~§8）。各源文档不再分别维护"待办/状态"（需求源登记见 §9.9）。
> 状态标记：✅ 已完成 ｜ ⚠️ 部分/待确认 ｜ 🔲 待办

### 9.1 AItrader data-service 需求（源：projects/data/AITRADER_DATA_SERVICE_REQ.md；DS-16/17 源：requirements-infrax.md REQ-1/REQ-2）

> **DS-1~DS-17 全部完成（2026-08-05~08-18，P0/P1）**：/bars 7 周期全达标（1d 1095 根/3 年、1m 43202 根/30 天；外汇 7 对 796-800 根；spot/swap 区分）；/factors 目录/最新/历史（技术 + ML 因子）；/snapshots 补齐 commodities/forex_pairs/market_overview；/symbol/resolve + /symbols/search 全市场覆盖（crypto/usstock/forex/futures/cnstock/hkstock，app/symbol_lookup.py 在线搜索）；/ticker 实时报价；X-Service-Key 统一鉴权；ML 因子并入标准因子面；官方 SDK `infra-data-client` 0.2.0（12 方法全绿）；ML 历史回填 `ml_predictions` 14524 行；DS-16 K 线缺失修复（补 BTC/ETH/USDC，PUT /admin/symbols 热更新回填）；DS-17 热力图全市场（tradfi_heatmap：stocks 39/fx 12 对/commodities）。完整实现与提交见 git 历史 / `docs/DATA_SERVICE_CATALOG.md`。

**图谱性能系列（GP-1~GP-4，2026-08-20 commit f3dfd7b）**

| 编号 | 需求 | 状态 | 优先级 | 备注 |
|---|---|---|---|---|
| GP-1 | 图谱端点服务端缓存 | ✅ 已部署 | P1 | ml-service `/ml/graph/edges` `_endpoint_cache` 1800s + 图快照新鲜检查 + prewarm；data entities/factors 1h、edges/history 30m 缓存；ragservicer 三 loader SWR（1800s）过期旧图+后台重建+原子切换 |
| GP-2 | 图谱首次生成异步化（R2） | ✅ 已部署 | P2 | ml-service `AsyncCacheRunner` job 跟踪（trigger 返 job_id / active_job_id / get_job_status）+ `/ml/graph/edges` 冷态 202+meta.job_id + 新增 `GET /ml/graph/jobs/{job_id}`；data-service 透传 building+job_id（30s 短 TTL 轮询）；web insights.js 冷态「生成中」+轮询 12×5s。生产验证（commit 53771d3）：冷态 202→job→success（206s 全量构建，带锁后只触发一次）→ready 150 节点/271 边；二次触发复用同 job_id（防重入）；data-service 透传 ready |
| GP-3 | 图谱生成链路性能优化（R3） | ✅ 已部署 | P2 | bars 300s 结果缓存 + 图快照新鲜检查 + 谱嵌入签名缓存（`_EMBEDDING_CACHE`，TTL 3600s 按拓扑+权重签名键控，图未变复用 SVD 避免 O(n³)）+ 全量构建互斥锁 `_BUILD_LOCK`（commit 53771d3：graph_factors/graph_edges/prewarm 并发冷触发时锁内二次快照检查，避免重复全量构建——生产曾并发重复构建 >14 分钟，带锁后恢复 206s）；图谱分片 / LLM 批处理不在本链路（图谱无 LLM 调用，评估后无需实施） |
| GP-4 | 图谱端点 SLA 承诺（R4） | ✅ 已部署 | P2 | 四端点统一 `meta.status`（ready/building/error）+ 结构化 reason；202 Accepted+jobId 异步化已随 GP-2 落地（`/ml/graph/edges` 冷态 202 + `/ml/graph/jobs/{job_id}`） |

### 9.2 模型与 RAG 里程碑（源：docs/DATA_MODULE_RAG_PLAN.md）

> **✅ 全部完成（2026-08-05~08-08）**：M0 数据栈（data :9112 + injector :9113 + ragservicer :9721 生产部署）→ M4 P2 三件套（Bolt/Moirai/TimesFM）全部署；P2 历史落库 `ml_predictions` + 注入 RAG；BTC 转账流量/巨鲸大额转账注入 RAG（2026-08-05 实测闭环）；默认注入列表 18 项。

### 9.3 部署 / 运维待办（源：本文件 §3~§8）

> **✅ 全部完成（2026-08-05~08-08）**：统一鉴权契约 + 共享 app_auth（Bearer/X-API-Key/X-Service-Key 三选一 + 统一 401 + 健康端点豁免）生产闭环；B 端 9+ 数据 key 配置（Finnhub/Firecrawl/FRED/Twelve Data/CoinGecko/NewsAPI/Tiingo/Alpha Vantage/Tushare，多 key 轮换）；外汇采集降频（1728→96 次/天）；`/admin/status` 数据源监控 + `PUT /admin/symbols` 交易对热管理；B 端 7 项反馈修复（timeframe 规范化/spot-swap 区分/ticker 多市场/resolve/401 统一体/公开文档/Cloudflare）；数据目录/API 参考/集成/MCP 四件套文档；B 端联调回执闭环 + 多市场分钟级 K 线 + 外汇轮换出数；ml-service 异步化改造 + 双 SDK 发布（infra-data-client 0.2.0 / infrax-dk 0.4.0）。P2-7 Cloudflare 502 已于 2026-08-19 域名全 200 实测（见 DEPLOYMENT.md）。

### 9.4 Session Key Engine 开发任务（源：docs/SESSION_KEY_ENGINE_DEV_PLAN.md v1.0，PRD 状态 Draft）

> **✅ 已完成并生产部署（2026-08-06，commit 414248c）**：engine :3500 + MCP :3011（per-request stateless transport），core/evm/server 三包交付；E2E 401/403/200 + MCP initialize 200/7 工具全通；安全措施 S-01~S-07 落地（私钥 AES-256-GCM、execute Bearer、Redis 分布式锁、白名单+额度三重校验、Nonce 30min 一次性、敏感操作日志）。React 前端组件库未单独交付（无前端需求）、Docker 以 systemd 替代。

### 9.5 AItrader 合并计划（源：docs/MERGE_PLAN_AITRADER.md）

> **✅ M1~M5 全部完成**：data 迁入 :9112、injector 迁入 :9113、可配置解析层（parser.py + /inject/parsed）、DC/Collector 注入、平台收尾；验收清单随 9.2/9.3 数据栈持续运行验证。

### 9.6 MCP & Skill 产品需求（源：prd/PRD.md v1.1，状态：待审阅，2026-07-30）

> **Phase 1（DC 事件分类）✅ 完成（2026-08-12，`0c5605a`+`37387dd`+`3f2a9ce`，生产 E2E 全绿）**；**需求 6.0 生态 Skills 插件 ✅ 代码完成（ai-skills/ 仓库，6.1~6.3 全绿）**；**Phase 3（SkillHub + 多市场发布）✅ 完成（2026-08-16：7 组 SKILL + 5 IDE 插件 + OpenAPI 3.1 `/openapi.json`，ClawHub/mcp.so 外部发布留待有客户诉求）**；2.4 hub-index :3008（13 工具聚合）✅、2.5 systemd ✅。
> 🔲 **Phase 2 TEE 钱包延后（P3）**：2.1~2.3（TEE Enclave 搭建 / MPC API 切 TEE / tee-index）待 TEE 环境审批（2026-08-15 用户决策维持延后）；软件侧以真 TSS 分片签名（E-4，cggmp21）为当前安全基线，无需软件替代方案。

### 9.7 各模块 SDK / MCP / API 端点能力审查（✅ 完成 2026-08-06）

> **✅ 全部完成（2026-08-06 审查，G-1~G-9 全部实现）**：四服务（data/injector/ragservicer/ml-service）对外集成面与 `SERVICE_ENDPOINTS_OBSERVABILITY.md` 一致；统一鉴权契约（app_auth）、错误体（data D2 信封）、数据面契约（7.2 详细核对表）全部闭环；差距项 G-1~G-9 全部实现（G-9 全闭环：lightrag-client 2.0.0 + infra-data-client 0.2.0 发布 2026-08-11）。首轮修复提交 `0f6d3d5`/`1ddcc97`/`1cf5a4d`。

### 9.8 区块链栈 / 平台集成需求（2026-08-06 全量盘点，B 端需求 9/10/11）

> **盘点结论（2026-08-06）**：数据栈已完整；区块链栈 P0 安全缺口（payment/vault 运行期无鉴权、mpc 验证码硬编码）与 P1 功能缺口已全部修复。
> **✅ B-1~B-12 全部完成（2026-08-06~08-16）**：MPC 邮箱验证码/统一鉴权（`148cc42`）、Vault 鉴权 + 多签功能补齐（`a0dbc76`，4 链）、Session Key 上线（`414248c`）、chain-rpc 网关统一广播链路（B-10-6 `e3dd19c`，读/广播双 key 隔离）、dc_tokens 修复、WAAS 伪支付收口 + 订阅购买页、admin 订单页等。
> **✅ 9.8.5~9.8.8（R-1~R-8 / C-1~C-7→DQ / 数据模块需求补充）全部完成（2026-08-07~08-08）**：B 端三问对照（RPC/okxchainos/TEE·MPC·Session）、数据清洗缺口盘点（DQ 系列）、数据模块与其他微服务需求补充规格。
> **✅ MQ-1~MQ-16 全部完成（2026-08-07~08-12）**：MCP 入站鉴权、dc_tokens、payments 通用支付引擎（:9132，五通道 + 能力层 a2a/period/batch/invite/transfer + webhook 多目标）、旧 payment :9106 下线归档（MQ-15，2026-08-11）、MQ-16 对外套餐矩阵（DC/collector 配额真实扣减 + 监控看板）。
> **✅ 9.8.9 MQ-16 套餐矩阵、9.8.10 RPC 切换（RPC-1~RPC-9 全交付：公网 `rpc-gw.0xainet.top` + rx_/bx_ 双 key + 10 链 + 标准 JSON-RPC 兼容 + SLA）、9.8.11 aa-sdk 发布（AASDK-1~4.4 + 独立包 `@0xinfrax/aa-sdk@0.1.1`，与 `Aa` 命名空间双通道并存）全部完成（2026-08-16）**。
> ⚠️ **遗留/部分**：
> - 🟡 **MQ-10 E-1b 多链扩展延后**（2026-08-16 用户裁定暂不进行）：aa-sdk 智能账户合约生产仅 OxaChain 部署，BSC/ETH/BASE/ARB/OP 待按 `AA_{CHAIN}_*` env 逐链部署（env 模板已备）；E-1a paymaster 链上验收待生产（默认用户自充 gas，paymaster 仅 sponsor 场景可选组件）。
> - ⚠️ **MQ-10 E-2b 邮箱恢复真实发信待 SMTP 凭证**：SMTP_HOST/PORT/USER/PASS + MAIL_FROM 用户提供后注入 unit env 即自动切真实发信（实现已就绪，回退日志生效）。
> - ⚠️ **MQ-12 T-9 验收部分**：链上真实 escrow 支付、x402/Stripe 真实支付未覆盖（D-2 决策：B 端实例自配凭证后验收，平台不代配）。
> - ⚠️ **E-3b 遗留**：多租户 `(product, network, sessionId)` 键待按需扩展（现 `network:sessionId` 两维）。

**9.8 盘点明细（2026-08-06 调查结论，时点快照）**

> ⚠️ 时点快照（2026-08-06 调查结论）：表中各服务盘点时缺口（MPC 验证码/鉴权、Vault 无鉴权、Payment 无鉴权、web 套餐硬编码、admin 缺页面等）均已在上方 §9.8 B/C/MQ 系列任务修复，本表仅作历史归档。

**9.9 需求源登记与状态（需求合并索引，2026-08-07）**

> 需求合并索引（源文档 → §9 小节）：`AITRADER_DATA_SERVICE_REQ`→§9.1｜`DATA_MODULE_RAG_PLAN`→§9.2｜`REQUIREMENTS.md`→§9.2｜`MCP_REQUIREMENTS`→§9.6+9.7｜`SESSION_KEY_ENGINE_*`→§9.4｜`MERGE_PLAN_AITRADER`→§9.5｜`PRD.md`→§9.6+9.7（TEE 降级 P3）｜`FEATURE_REQUEST_RPC_SWITCH`→§9.8.10 ✅｜`FEATURE_REQUEST_POCKETX_AASDK`→§9.8.11 ✅｜`FEATURE_REQUEST_MARKET_RPC_DEX_EXEC`→§9.10 A-11 ✅｜`FEATURE_REQUEST_SESSION_KEY_AUTOEXEC`→§9.10 A-15~A-18 ✅｜`PAYMASTER_ONCHAIN_ESCROW_DESIGN`→§9.20 ✅｜`FACTOR_FACTORY_HW_EVOLUTION`→§9.15 ⏸️｜`MOOMOO_DATA_INTEGRATION`→§9.14 ✅。全部需求统一在 §9 登记状态，源文档仅保留契约。

**9.10 微服务定位纠正与体验对齐（2026-08-11 商业评审，对标 OKX OnchainOS）**

> **✅ A-1~A-18 全部完成（2026-08-11~08-16，商业评审对标 OKX OnchainOS）**：定位纠正（waas=类 CEX 托管零链上签名、vault=用户自托管多签、mpc=邮箱验证码 + 真 TSS 2-of-2 Agent 钱包）；vault 增强 A-8（多签 4 链）；A-11 DEX 交易执行（行情 RPC + 交易）；A-12/13/14 行情 RPC + x402 门控；A-15~A-18 SessionKey 自动执行能力全闭环。

**9.11 PocketX → InfraX 交接更新（2026-08-11）**

> **✅ B-1~B-4 全部完成（2026-08-11~08-16）**：PocketX → InfraX 交接确认（B-1）、管理后台迁移（B-2）、apikey 体系（B-3）、自建 paymaster 闭环（B-4：OxaChain escrow + signer :9134 + Alto :4338 生产全链路验收通过，多签由 TSS 真 2-of-2 承接）。

**9.12 服务鉴权审计（2026-08-11，全站 15 服务源码审计）**

> **✅ C-1~C-5 全部完成（2026-08-11）**：全站 15 服务源码审计收口——waas/dc/collector 加鉴权（app_auth），vault/payment 等条件性服务（仅内网 + 网关路由）登记，未鉴权服务全部闭环；审计结论与端口清单归档 DEPLOYMENT.md。

**9.13 SDK 独立包拆分（2026-08-11 用户裁定；§1.1 已写入 SDK_INTEGRATION.md，commit 7a76c17）**

> **✅ D-1~D-3 全部完成（2026-08-11，commit 7a76c17）**：SDK 独立包拆分 10 包全发布（@0xinfrax/aa-sdk 等，见 `docs/SDK_INTEGRATION.md`）；调用方本地相对路径引用 + 发布双通道并存；同步发布 lightrag-client 2.0.0 / infra-data-client 0.2.0。

**9.14 MooMoo 行情强化接入（2026-08-12 需求登记；详细方案：docs/MOOMOO_DATA_INTEGRATION.md）**

> **✅ MM-1~MM-15 全部完成（2026-08-12，见 docs/MOOMOO_DATA_INTEGRATION.md）**：MooMoo 行情强化接入（外汇/美期/全球指数/US stock，~1600 标的符号映射 + 涨跌幅/分钟线/Snapshot 数据栈 + collector 增量拉取 + 前端联动）。

**9.15 因子工厂体系（2026-08-12 需求登记；源：docs/req-04-infrax-mlservice-arch-opt.md / req-05-auto-find-factor.md / req-06-factor-factory.md + docs/FACTOR_FACTORY_HW_EVOLUTION.md + INFRAX_REQ_SUMMARY_ARCH_AUTOFIND_FACTORY.md）**

> **✅ R4/R5/FF 全部完成（2026-08-12，commit f3dfd7b 体系）**：因子工厂体系落地（req-04~06 + FACTOR_FACTORY_HW_EVOLUTION）：因子工厂 / 接口 / 缓存 / 因子入库 / factor-sync / 自动因子搜索（auto-find）/ 因子接入 RAG；图谱性能（GP-1/GP-4）并入 §9.1 表。
> ⏸️ **HW-1（硬件加速换芯）延后**：embeddings/重因子 GPU 加速待硬件到位；R4-2（因子工厂外发 403）跳过（内部因子端点已统一）。

**9.16 数据获取优化：RPC 池 + 多 IP 出口 + 节流（2026-08-13 登记；方案：docs/INFRAX_BACKUP_MULTI_IP.md）**

> **✅ RI-1（数据源 RPC 池化）完成、RI-4（控制脚本 infrax-backup-multi-ip 交付）完成（2026-08-13，见 docs/INFRAX_BACKUP_MULTI_IP.md）**；5 条 egress 隧道（18848~18852）生产上线，infra-data-client 0.2.0 支持 rpc_pool。
> 🔲 **RI-2 父项**（双出口路由 egress1/egress2 隔离 fallback）：子项 RI-2.1~2.3 已完成（脚本参数化），父项整体验收待定。
> 🔲 **RI-3 父项**（访问出口节流限速）：RI-3.1 节流已实现；RI-3.2 基线观察（128 req/min 基线）待持续观测后收口。

**9.17 生产负载诊断与优化：data 服务单核打满（2026-08-13 诊断+修复，生产已部署）**

> **✅ 全部完成（2026-08-13 诊断+修复，生产已部署）**：data 服务单核打满诊断（GC/进程/慢查询/连接池）+ 修复（池复用/缓存/监控）；随后 ml-service 满载也完成定位（见 9.18）。

**9.18 ml-service 性能优化：consensus 复用外层信号缓存，消除 Kronos 重复全量推理（2026-08-14 登记；方案见下）**

> **✅ 全部完成（2026-08-14 登记，方案见下）**：consensus 复用外层信号缓存，消除 Kronos 重复全量推理；43.156.25.197 生产验证 `/ml/cache/stats`（2026-08-14 + 08-15 复核）。

---

**9.19 生产扩容迁移（方案 C：整盘迁移 + ML 服务外迁，2026-08-15 定稿，详见 docs/INFRAX_MIGRATION_SCALE_OUT.md）**

> **✅ M-1~M-5 全部完成（2026-08-16，方案 C：整盘迁移 + ML 服务外迁，见 docs/INFRAX_MIGRATION_SCALE_OUT.md）**：postgres 整盘迁移 43.156.78.59（10 库）、rag/ki 迁新机、ML 外迁 43.156.25.197、172 收口为纯计算节点、DNS/nginx/systemd/备份全量刷新。
> 🔲 **M-6 二期可选**：独立 Gateway 节点 / 更细粒度资源隔离待业务规模增长再评估。

**9.20 平台钱包 EOA → 托管合约 + 计费链上化（2026-08-16 需求登记；源：docs/PAYMASTER_ONCHAIN_ESCROW_DESIGN.md，P1 演进方向）**

> **✅ OE-1/3/4/5/6/7/8 完成（2026-08-17，见 docs/PAYMASTER_ONCHAIN_ESCROW_DESIGN.md）**：InfraXEscrow 合约（proxy 0x8Bf8Ffee…）+ relayer 双轨计费（ESCROW_MODE）+ ledger 对账 + 存量结算对账脚本；私钥作废由用户线下执行。
> 🔲 **OE-2 第三方安全审计**：待排期（审计后合约升级为正式托管）。

**9.21 部署文档三台架构同步 + systemd unit 清单补全（2026-08-16 执行）**

> **✅ U-1~U-4 完成（2026-08-16）**：DEPLOYMENT.md 三台架构同步 + systemd unit 清单补全 + 端口/DB 映射刷新 + 迁移回滚步骤。

**9.9 AgentX 通用支付能力需求（源：docs/FEATURE_REQUEST_AGENTX_ESCROW_PAYPERCALL_20260817.md，2026-08-17 拆分）**

> **✅ AX-1~AX-13 + REQ-1~REQ-5 全部完成（2026-08-17~08-18，见 docs/FEATURE_REQUEST_AGENTX_ESCROW_PAYPERCALL_20260817.md）**：AgentX escrow 链上支付 + pay-per-call 计费（MPC 回调签名 + escrow 发放 + 对账），B 端体验对标 OKX + DexScreener。

**9.22 图谱因子（Graph Factor）统一方案（源：projects/data/AITRADER_GRAPH_FACTOR_REQ.md，2026-08-18 AItrader 提交；扩展 GX 源：docs 图谱因子技术设计）**

> **✅ GF-1~GF-6 + GX-1~GX-3 全部完成（2026-08-18，见 projects/data/AITRADER_GRAPH_FACTOR_REQ.md + 图谱因子技术设计）**：语义图谱因子并入 data-service 统一入口 `GET /factors/graph`（df_* key 消费，内部持 ragservicer default 租户服务 key，lr_* 仅文档读写、因子端点 403）；AA Bundler 迁移新机 :4338；GX-2.4/3.4/3.5 执行（多 hop 传播 / 时序窗口 / LLM 归一化）；AIHunter 前端按 |ρ| 归一化线宽待前端联调。

### 9.9 WAAS 优化任务（源：arb 上传 `prd/arbitrage-waas-design.md` 对照评审，2026-08-19）

> **✅ W-1~W-16 全部完成（2026-08-19，对照 arb 上传 `prd/arbitrage-waas-design.md` 评审，详见 docs/services/waas.md）**：P0 资金安全（原子存款唯一约束 / 确认阈值 / 广播重试 / gas 池熔断）、P1 风控（USD 限额、日限额一致）、系统健壮（幂等键、分布式锁、dry-run、TOTP 2FA、fail-closed 生产校验、会话私钥持久化复用）；生产部署 + 公网 https://infrax.0xainet.top/api/v2/waas/health 验证通过。

### 9.10 AA Session 会话轮换优化任务（源：AgentX 修复文档 `docs/aa-relay-session-rollover-fix-infrax.md`，2026-08-19 对照评审）

> **✅ AA-1~AA-7 全部完成（2026-08-19，见 docs/aa-relay-session-rollover-fix-infrax.md）**：会话轮换优化（relay 禁用链上关闭 + aa-sdk 批量编码/模块检测 + 残留检测后激活）；签名注入修复 AA24 InvalidSignature；会话替换用批量 UserOp（uninstallModule + invalidateNonce + installModule）解决 AA23 InvalidNonce；125 单测全绿，生产部署 commit 801d45e。

### 9.11 AItrader 多语言数据层修复（源：`projects/data/AITRADER_I18N_DATA_REQ.md`，2026-08-20，用户裁定"全部含 P3"）

> **✅ R-I1~R-I4 完成（2026-08-20，见 projects/data/AITRADER_I18N_DATA_REQ.md，用户裁定全部含 P3）**：AItrader 多语言数据层修复（语言覆盖率 / 翻译回填管线 / RAG 多语言检索）。
> ⚠️ **遗留**：① name_en ≥95% 覆盖待 LLM 翻译批量回填；② news collector 按 lang 分 bucket 待排期；③ I6 市场枚举规范化待前端多语言联动。

### 9.12 RAGSERVICER 迁移后租户分片模型（R-TN，源：AIServicer B 端客户反馈，2026-08-20）

> **✅ R-TN 完成（2026-08-20，RAGSERVICER 迁移后租户分片模型）**：default 租户服务 key + 租户隔离 + 图谱缓存分片迁移验证。
> ⚠️ **遗留**：① admin key 安全交付客户（平台侧租户分片 key 签发）；② 共享 key 确认；③ 新 Bot 预创建租户。

### 9.13 DEX 策略数据需求（源：`docs/requirements-infrax-dex-data.md`，AIHunter SaaS 产品方提交，2026-08-21）

> **✅ R1/R1b/R2/R4/R5/R6/R7/R8/R10 完成、R9 跳过（2026-08-21，见 docs/requirements-infrax-dex-data.md）**：DEX 策略数据需求（合约事件 / 新币跟踪 / DexScreener 集成 / 流动性 / K 线）。
> 🟡 **R3 透传 null**：dex 数据链路部分字段透传 null 待修正；**T-4 MEV 源待排期**。
> ⚠️ **验收依赖**：DexScreener 免费层配额（60 req/min）待评估高频刷新策略；双榜单联调待 AIHunter 前端。

### 9.14 web 门户前端界面优化（2026-08-21）

> **✅ W-1~W-8 + W-8b~W-8f 完成（2026-08-21）**：web 门户前端界面优化（landing/套餐/文档导航/移动端适配）；`node --check` 通过，本地 :6100 浏览器实测。
> ⚠️ **遗留**：交易对面板双榜单（OKX + DexScreener）来源联调待 AIHunter 前端。

### 9.15 RAGSERVICER 写锁可用性（RWL，源：`docs/ISSUE_RAGSERVICER_WRITELOCK_20260821.md`，AIServicer 提交，2026-08-21）

> AIServicer 反馈：2026-08-21 上午 SQLite 写锁 10-11s（建租户/上传 500 `database is locked`，health 劣化 5.5s，故障 20+ 分钟）；晚间 21:40 复发——health 稳定 10s ×3、写 20s、GET 20s 超时，客户 bitbyte transaction 知识库 0/7 上传失败。本地已有部分缓解（busy_timeout `30797b3` + last_used_at 节流 `98d2a18`），但晚间复发说明慢任务持锁（LightRAG 分钟级索引）仍阻塞全部写路径。
> **根因定位（2026-08-21）**：晚间 10s 稳定慢响应（含 health）= `audit_log_middleware` after_request 对每个请求同步写 tenants.db + `_get_conn` 固定 busy_timeout=10s → 后台持锁时所有请求被拖 10s。已修复（RWL-1/2/3 落地，22 单测通过，提交待发）。

| 编号 | 需求 | 状态 | 优先级 | 备注 |
|---|---|---|---|---|
| RWL-1 | SQLite 写锁友好化：`busy_timeout` 从配置读取（默认 30s，当前 10s 硬编码于 `tenants/manager.py:31`）；长事务最小化；幂等写短路 | ✅ 已实施 | P0 | `TENANT_BUSY_TIMEOUT_MS` 默认 30000（config.py TenantConfig）；`_get_conn(busy_timeout_ms=)` 支持覆盖 |
| RWL-2 | 锁冲突可重试语义：`database is locked` / `WriteQueueFull` 统一 503 + `Retry-After`（当前 WriteQueueFull 已 503 但无 Retry-After 头；SQLite 错误仍透出 500/HTML） | ✅ 已实施 | P0 | `handle_errors` 映射 locked→503+Retry-After=5s（code DATABASE_BUSY）；WriteQueueFull→503+Retry-After；main.py 全局 500 兜底 |
| RWL-3 | 晚间 10s 稳定慢响应根因排查（health/读 10s、写 20s）——定位慢任务持锁（LightRAG 索引）与 WAL checkpoint 阻塞；写路径超时阈值收紧 | ✅ 已部署 | P0 | 根因=after_request 审计写全量同步 + busy_timeout=10s；审计写改短超时（`TENANT_AUDIT_BUSY_TIMEOUT_MS` 默认 1000）快速降级；last_used 写独立短超时连接。2026-08-21 部署生产（commit 7d6d815），health 14ms 响应、audit.db 独立写入验证通过 |
| RWL-4 | 写锁监控与告警：SQLite busy 次数/等待时长、写队列深度、worker 积压、慢任务清单指标 + 故障告警 | ✅ 已部署 | P1 | shared/metrics 新增 `SQLITE_BUSY_TOTAL`、`SQLITE_BUSY_WAIT_SECONDS`、`WRITE_QUEUE_DEPTH`、`WRITE_QUEUE_FULL_TOTAL`；`write_queue_depth` 生产 /metrics 可见 |
| RWL-5 | 建租户与文档写并发解耦：租户元数据迁移 PostgreSQL（服务已有 PG）或至少 Admin API 与 worker 用不同 SQLite 文件 | ✅ 已部署 | P1 | 审计日志独立 `audit.db`（`TENANT_AUDIT_DB_PATH`），高频 after_request 写与租户元数据写锁解耦；生产验证 audit.db 独立写入 |
| RWL-6 | 连接复用：租户 SQLite 连接级联复用（当前每请求建连/关连） | ✅ 已部署 | P1 | 线程本地 + 按 db_path 缓存连接，`_release_conn` 归还复用（回滚未提交事务）；audit 独立短超时连接 |

### 9.16 RAGSERVICER 去重与列表透明化（RDD，源：`docs/ISSUE_RAGSERVICER_DEDUP_20260821.md`，AIServicer 提交，2026-08-21）

> AIServicer 反馈：上传 201 + task success 但 LightRAG 去重丢弃内容未入索引，调用方无法感知（静默数据丢失）；附带 3 个发现（batch 异步不执行 / 列表全局视图 / 删除时序）。核心去重透出已实现（`2162068`，engine.py `_disposition_from_failed`），列表租户隔离已随 d827e43 workspace 隔离落地，其余待排期。

| 编号 | 需求 | 状态 | 优先级 | 备注 |
|---|---|---|---|---|
| RDD-1 | 去重决策透出：响应/列表标记 `deduplicated` / `dedup_reason`（file_name_dup/content_hash_dup/filename_conflict）/ `matched_doc_id`；`status: "duplicate"` + `chunks: 0` | ✅ 已部署 | P1 | `2162068`：engine.py L121-188 + list_documents L415-430；API.md §4.1-4.3 已文档化 |
| RDD-2 | 任务结果携带处置明细：`GET /tasks/{id}` result 返回每篇 indexed/duplicated/error | ✅ 已部署 | P1 | 处置写入 task result（`_disposition_from_failed`）；SDK 默认同步 `async:false` |
| RDD-3 | batch 接口生产可执行：`/documents/batch` 202+task 后任务真实执行（issue 反馈生产不执行，文档永久卡 indexing） | ✅ 已部署 | P1 | submit 链路存在（engine.py L298-301）；2026-08-21 生产验证：batch→task queued→running→success，结果含每篇处置明细 |
| RDD-4 | 列表接口租户/namespace 过滤：list 按 key 绑定租户隔离，不再全局视图 | ✅ 已部署 | P1 | d827e43 workspace 隔离 + `require_tenant`；响应含 tenant/namespace 字段 |
| RDD-5 | 删除时序：删除走队列，繁忙时短暂窗口已删文档仍可检索 | ✅ 已部署 | P2 | 删除默认同步执行（仅显式 `?async=1` 走队列）；生产验证 46ms 即时生效 |

### 9.17 RAGSERVICER 删除可用性遗留（RDL，源：`docs/ISSUE_RAGSERVICER_WRITELOCK_20260821.md` 第 8 节，AIServicer 修复验证反馈，2026-08-21）

> AIServicer 深夜复测：写锁/慢响应已修复（health 12ms、上传 18ms 入队、索引任务正常执行），但发现 **DELETE 接口不生效**（返回 `deleted:true` 但文档仍可检索、list 仍返回）；另附偶发 query 15s 超时（P2）与 list 状态滞后（P3）。
> **根因定位**：`delete_document` 忽略 `adelete_by_doc_id` 的 `DeletionResult` 返回值——pipeline 忙（索引进行中）时 LightRAG 返回 `not_allowed`（删除未执行、12ms 快速返回），ragservicer 层掩盖为 `deleted:true`。

| 编号 | 需求 | 状态 | 优先级 | 备注 |
|---|---|---|---|---|
| RDL-1 | DELETE 不生效修复：透传 DeletionResult（success→deleted:true；not_found→幂等 deleted:true+found:false；**not_allowed/fail→deleted:false** 不再掩盖），REST 同步删除 not_allowed → **503+Retry-After**（DELETE_NOT_ALLOWED），fail → 500 | ✅ 已部署 | P1 | `api/engine.py` `_delete_coro`/`delete_document` + `api/routes/documents.py` DELETE 同步路径；`tests/test_delete.py` 9 用例（34 passed）。生产验证（commit 5f2683b，租户 bmt1rmh9w7kxa）：hc-1787333621.md 删除 32ms success（此前删不掉），幂等重删 not_found+found:false，list total 0 |
| RDL-2 | 异步删除 task result 携带删除处置（submit_delete_document 后 GET /tasks/{id} 可见 status/message） | ✅ 已部署 | P1 | `_delete_coro` 返回处置 dict → worker 自动写入 task result。生产验证：async DELETE→task success+result `{status:not_found,status_code:404}` |
| RDL-3 | list 状态字段滞后修复：`_map_doc_status` 对 DocStatus 枚举取 `.value`（str(枚举) 得 "DocStatus.PROCESSED" 恒显 indexing）；调用处不再预 `str()` | ✅ 已部署 | P3 | `engine.py` `_map_doc_status` + `_insert_one_locked`/`list_documents` 调用处。生产验证：hc-1787333621.md 状态显示 **indexed**（此前恒显 indexing） |
| RDL-4 | 偶发 query 15s 超时（HTTP 000）：冷查询首次图加载（服务端 `aquery` 300s 超时，客户端/网关 15s 截断）；二次命中缓存 185ms | 🔲 待排期 | P2 | 建议：客户端对首查放宽超时 15s→60s；服务端暂不额外预热（query 需真实参数无法通用预热） |
