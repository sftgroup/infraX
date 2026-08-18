# 生产环境凭证（PRODUCTION CREDENTIALS）

> **用途**：记录生产环境访问凭证与服务密钥，供授权运维/开发人员本地查阅。
> **安全提示**：本文件含真实密钥，禁止外泄、禁止推送公开仓库；如需分享请走安全渠道。
> **最后更新**：2026-08-19（§7 因子双轨收敛：data-service 统一入口 `/factors/graph` + 旧 key 吊销登记）

---

## 1. 生产机 SSH

| 项 | 值 |
|---|---|
| 主机 | 43.163.105.172 |
| 用户 | ubuntu |
| 密码 | Asdf1234! |
| 连接示例 | `sshpass -p 'Asdf1234!' ssh -o StrictHostKeyChecking=accept-new ubuntu@43.163.105.172` |

> 说明：主栈 43.163.105.172（data/knowledge-injector/ragservicer/hub-index/mpc/chain-rpc/aa-relay 等）；独立 ml-service 43.156.25.197（ml-service）。

---

## 2. 服务端口速查（43.163.105.172）

| 服务 | 端口 | systemd unit | 工作目录 |
|---|---|---|---|
| infrax-mpc（MPC 网关，9104） | 9104 | infrax-mpc.service | /home/ubuntu/infraX-1/projects/mpc |
| MPC TSS party1（片2） | 9200 | infrax-mpc-tss-signer.service | /home/ubuntu/infraX-1/projects/mpc-tss |
| MPC TSS party2（片3/独立签名机，AX-13 已部署） | 9202 | infrax-mpc-tss-signer2.service | /home/ubuntu/infraX-1/projects/mpc-tss |
| MPC TSS party0（片1 代理） | 9201 | infrax-mpc-signer.service | /home/ubuntu/infraX-1/projects/mpc-tss |
| chain-rpc 网关 | 9130 | infrax-chain-rpc.service | /home/ubuntu/infraX-1/projects/chain-rpc |
| aa-relay（UserOp 转发） | 9131 | infrax-aa-relay.service | /home/ubuntu/infraX-1/projects/aa-relay |
| session-key engine（会话密钥授权） | 3500 | infrax-session-key.service | /home/ubuntu/infraX-1/projects/session-key |
| session-key-mcp | 3011 | infrax-session-key-mcp.service | /home/ubuntu/infraX-1/projects/session-key |
| data | 9112 | — | — |
| knowledge-injector | 9113 | — | — |
| ragservicer | 9721 | — | — |
| hub-index（MCP） | 3008 | — | — |
| mpc-mcp / rpc-mcp | — | infrax-mpc-mcp / infrax-rpc-mcp | — |

---

## 3. infrax-mpc（:9104）env

| 变量 | 值 |
|---|---|
| MPC_API_KEY | infrax-bridge-2fd4fbe0d33805362ac980fde74c86b2 |
| MPC_ENCRYPTION_SECRET | 2cca2225961a0b6e4edf2979f102d2e9de0b5531d4a2443e30a3bf8097b352a4 |
| ADMIN_USER / ADMIN_PASS | admin / a87cefd6e1ce487334a67b0c |
| DATABASE_URL | postgresql://postgres:postgres@localhost:5432/pocketx_mpc |
| PORT | 9104 |
| MPC_SIGNER_URL | http://127.0.0.1:9201 |
| TSS_SIGNER_URL | http://127.0.0.1:9200 |
| TSS_SIGNER_URL_1（AX-13，可选） | http://127.0.0.1:9200 |
| TSS_SIGNER_URL_2（AX-13，已部署，drop-in tss2.conf） | http://127.0.0.1:9202 |
| CHAIN_RPC_URL | http://127.0.0.1:9130 |
| CHAIN_RPC_READ_KEY | 9ffb2e974089da005e07103271246d3ad3597a71eb50034a326b906797aba4ae |
| CHAIN_RPC_BROADCAST_KEY | 221558134a900f38821328570684b4af4fb9e758e6fc5fa6befe01574a4e5caf |
| DATA_URL / DATA_API_KEY | http://127.0.0.1:9112 / infrax-bridge-2fd4fbe0d33805362ac980fde74c86b2 |

---

## 4. chain-rpc（:9130）env

| 变量 | 值 |
|---|---|
| CHAIN_RPC_READ_KEY | 9ffb2e974089da005e07103271246d3ad3597a71eb50034a326b906797aba4ae |
| CHAIN_RPC_BROADCAST_KEY | 221558134a900f38821328570684b4af4fb9e758e6fc5fa6befe01574a4e5caf |
| PORT | 9130 |
| CHAIN_RPC_CHAINS | sepolia,ethereum,bsc,base,oxa,solana |
| SEPOLIA_RPC_URL | https://ethereum-sepolia-rpc.publicnode.com |
| ETH_RPC_URL | https://ethereum-rpc.publicnode.com |
| BSC_RPC_URL | https://bsc-dataseed.bnbchain.org |
| BASE_RPC_URL | https://mainnet.base.org |
| OXA_RPC_URL | https://rpc-oxa.0xainet.top |
| SOLANA_RPC_URL | https://api.mainnet-beta.solana.com |
| CHAIN_RPC_WAIT_SEC / INTERVAL_MS | 30 / 3000 |
| CHAIN_RPC_HEALTH_INTERVAL_MS | 60000 |

---

## 5. aa-relay（:9131）env（✅ 2026-08-16 对齐生产）

| 变量 | 值 | 来源 |
|---|---|---|
| AA_RELAY_API_KEY | infrax-bridge-2fd4fbe0d33805362ac980fde74c86b2 | 主 unit（2026-08-16 核验；旧值 e0423496… 已废弃） |
| AA_ENABLED_CHAINS | oxachain | 主 unit |
| AA_OXACHAIN_RPC_URL | https://rpc-oxa.0xainet.top | 主 unit |
| AA_OXACHAIN_ENTRYPOINT_V07 | 0x97e4cddcffeaf4580bc6315fee512f2b2d82798a | 主 unit |
| AA_OXACHAIN_IMPLEMENTATION | 0x5131d75af2126eba05edbb6bc24902c42d1b52b4 | 主 unit |
| AA_OXACHAIN_FACTORY | 0xf8abe4510a6810d5ef26aa3222c0f63d32b757d1 | 主 unit |
| AA_OXACHAIN_ECDSA_VALIDATOR | 0xb0d4f548e022b8a9d5b454ffb7f327ee2afeb16c | 主 unit |
| AA_OXACHAIN_SESSION_MODULE | 0xfbbca78d2d7d08c1163aa57a0056973ef4fd8c74 | 主 unit |
| AA_OXACHAIN_BUNDLERS | [{"url":"http://43.156.78.59:4338","priority":0}] | 主 unit（2026-08-19 迁移：原 43.159.60.46 随 AgentX 系统盘丢失，bundler 迁至 infraX 43.156.78.59:4338，见 tasklist AA Bundler 迁移与恢复） |
| PORT | 9131 | 主 unit |
| DATABASE_URL | postgresql://postgres:postgres@10.3.8.6:5432/pocketx_mpc | drop-in `override.conf`（M-3 迁移修正，原 localhost） |
| AA_PAYMENTS_URL | http://127.0.0.1:9132 | drop-in `override.conf` |
| AA_PAYMENTS_API_KEY | e56159786fe107b808c29c3c75cd098a31ba58d97772dea3 | drop-in `override.conf` |
| AA_PLATFORM_ADDRESS | 0x5682e2d55770e46ad24b92e51d6d0a3b629fa0b3 | drop-in `override.conf`（x402 充值收款平台钱包，EOA → 托管合约见 tasklist §9.20） |
| AA_OXACHAIN_PAYMASTER_URL | http://127.0.0.1:9134 | drop-in `paymaster.conf`（自建 verifying paymaster :9134） |

---

## 6. session-key engine（:3500）env（✅ 2026-08-16 对齐生产）

> 公网入口：`https://sk.0xainet.top`（nginx → 127.0.0.1:3500，SAN 证书存于 rpc-gw certbot 目录）。
> 鉴权：除 `GET /api/v1/health`、`GET /api/v1/nonce` 外一律 `Authorization: Bearer <API_TOKENS 之一>`（401=未携带/格式错，403=不在白名单）。
> 环境文件：`/home/ubuntu/infraX-1/projects/session-key/.env`（systemd `EnvironmentFile`，chmod 600）。

| 变量 | 值 | 说明 |
|---|---|---|
| SESSION_KEY_ENGINE_URL | `https://sk.0xainet.top` | 客户（AIHunter）配置用公网基址 |
| API_TOKENS | `sk-prod-744db48e75166f48cbc047ba09fa47f8` | 原生产主 key（保留，既有调用方在用） |
| API_TOKENS | `sdk_c8e5ab57aa0cf4fdf45c0623413ccb2341746d1eaa747f26` | **AIHunter 客户独立 key（2026-08-16 签发，按客户隔离）** |
| — | `GET /api/v1/health` | 健康检查（公开）：`{"status":"ok","service":"session-key-engine"}` |
| DB | postgres `session_key_engine`（本机 :5432） | Redis 本机 :6379（会话执行锁） |

> 说明：
> - `API_TOKENS` 为逗号分隔白名单；新 key 由 `sdk_$(openssl rand -hex 24)` 生成并追加后 `systemctl restart infrax-session-key` 生效（已实测新旧 key 均 200）。
> - 吊销某客户权限：从 `.env` 的 `API_TOKENS` 移除对应值并重启即可。
> - A-18 审计：execute 记录中 caller 为 key 掩码前缀（`sdk_…`），可区分调用方，不落 key 原文。
> - 支持链：eth(1)/bsc(56)/base(8453)/polygon(137)/arbitrum(42161)/optimism(10)/xlayer(196)/sol(0)。

---

## 7. ragservicer（:9721）DB 租户 API key（GF-6，2026-08-19 签发）

| 项 | 值 |
|---|---|
| 服务 | ragservicer（`127.0.0.1:9721`，生产机 43.156.78.59，`/home/ubuntu/infraX-1/projects/ragservicer`） |
| 租户 | `aitrader`（AItrader B 端接入专用租户） |
| key 名 | `aitrader-main` |
| 明文 key | `lr_a1a683d4b905e9c32ef10d3569b8ef38edad9c3f1eab5af7` |
| 用途 | **AItrader 专用（GF-6，替代借用 aiservicer bridge key）** |
| 签发日期 | 2026-08-19 |
| 有效期 | 永不过期（`expires_days=0`） |
| 签发方式 | 生产机 `tenants/manager.py` `generate_api_key("aitrader","aitrader-main")`（`tenants/tenants.db`） |
| 使用方式 | `Authorization: Bearer <key>` 或 `X-API-Key: <key>`，生产实测 `GET /api/v1/namespaces/market/documents` → 200 |

> 说明：AItrader 此前借用 `RAGSERVICER_API_KEY`（aiservicer bridge key，映射 default 租户）；GF-6 后应迁移至本专用 key，实现租户隔离。旧 aitrader 租户下另有 2026-08-05 初始化的 `prod` key（`lr_db9f5e4c0…`，明文未留存，仅初始化时用过）与已失效 `e2e` key（`lr_d69ce83cb…`，active=0），本次未重复签发。
>
> **AIHunter SaaS 租户 key（2026-08-19 追加签发）**：
> - 租户：`aihunter-saas`（AIHunter SaaS B 端接入专用租户，2026-08-05 已建租户，当时有 `prod` key `lr_db0c2ac4c…` 有效至 2027-08-05）
> - key 名：`aihunter-saas-main` ｜ 明文 key：`lr_09ef21e954fa4af57301df273200a52fc02e1aedcb658e5a` ｜ 永不过期
> - 签发：生产机 78.59 `PYTHONPATH=. .venv/bin/python3 -c "from tenants.manager import create_tenant, generate_api_key; ..."`（需先 `load_config()` + `load_dotenv('.env')`）
> - 验证：`/api/v1/factors/graph?symbol=BTC`（8 因子真实返回）/ `/api/v1/factors/catalog` / `/api/v1/graph/entities` 无 key 401、带 key 200；`/api/v1/namespaces/market/documents` 200
>
> **因子双轨收敛（2026-08-19，统一入口 + key 定位收窄）**：
> - **背景**：语义图谱因子（ragservicer `/api/v1/factors/graph`，`lr_*` key）与 data-service 统一因子通道（`/factors/current`，`dx_*` key）此前双轨并行，B 端需分别持有 lr_*/dx_* 两类 key，调用方（尤其 AItrader）持有多个 key 易混乱。
> - **业务原则（用户裁定 2026-08-19）**：`lr_*` key **属于独立 LightRAG 微服务**（供项目方**上传自己的资料 + 读取资料**：documents 注入/列表、query/retrieve 检索、graph/entities 可视化数据），**与因子/金融数据方案无关**；**今日（2026-08-19）以前发放的 `lr_` key 全部保持有效**。**因子一律走 data-service `dx_*` key**（含语义图谱因子，统一入口 `/factors/graph`）。
> - **统一入口**：data-service `GET /factors/graph`（语义图谱 8 因子）+ `GET /factors/graph/edges`（相关性图，REQ-G1）+ `/factors/current`（gf_* 18 因子），B 端持 dx_* key；data-service 内部经 ragservicer/ml-service 服务 key 透传。
> - **ragservicer 因子端点锁服务间（commit `4e30aa1`）**：`/factors/graph`、`/factors/catalog` 仅允许 `RAGSERVICER_FACTOR_KEYS` 白名单内服务 key（`require_service`，非白名单 403）；`/graph/entities` 归读取信息，B 端 lr_ key 可用。
> - **data-service 内部服务 key（服务间鉴权专用，禁止外发）**：`data-service-internal`（default 租户）｜ `lr_16c4aa5d708348478b7b0365ec6dbd42303f8ca3147ac460`（永不过期；ragservicer 机 .env `RAGSERVICER_FACTOR_KEYS`；data 机 .env `RAGSERVICER_BASE_URL=http://43.156.78.59:9721` + `RAGSERVICER_SERVICE_KEY`）
> - **B 端 lr_ key 状态（lightrag 服务用途，全部有效 active=1）**：
>   - aitrader `prod`：`lr_db9f5e4c04bbffa88b46b98990805f7580d48a8a8dad5e45`（key_3f10effdd05ad073，2026-08-05 发放，08-19 曾吊销后恢复）
>   - aitrader `aitrader-main`：`lr_a1a683d4…`（key_02f482602dec64a1，2026-08-18 发放，08-19 曾吊销后恢复）
>   - aihunter-saas `prod`：`lr_db0c2ac4c…`（key_eff09eb7e0a2d0fe，2026-08-05 发放，08-19 曾吊销后恢复）
>   - aihunter-saas `aihunter-saas-main`：`lr_09ef21e9…`（key_b6292b198082c2c8，2026-08-18 发放，08-19 曾吊销后恢复）
> - **关键澄清（用户裁定，2026-08-19）**：因子消费 B 端仅需 data-service `dx_*` key；`lr_` key 只服务 LightRAG（文档/检索/可视化）。曾短暂吊销的 4 把 lr_ key 已全部恢复（B 端如有误解以本说明为准）。
> - 生产部署与验证：data 机 163.105 `git pull` + `.env` 追加上述两变量 → `systemctl restart infrax-data`（active）；ragservicer 机 78.59 部署 commit `4e30aa1` 三文件 + `.env` 追加 `RAGSERVICER_FACTOR_KEYS` → 重启 active。实测：服务 key → `/factors/graph` 200；B 端 lr_ key → `/factors/graph`/`/factors/catalog` 403；`/graph/entities`/documents → 200；data-service `/factors/graph` 透传 200（8 因子 + catalog）。

---

## 8. B 端 data-service（:9112）dx_* key 登记（2026-08-19 更新）

> 因子/行情消费统一走 data-service `dx_*` key（见 §7 因子双轨收敛）。公网入口 `https://infrax.0xainet.top/api/data/*`，鉴权头三选一：`Authorization: Bearer <key>` / `X-API-Key: <key>` / `X-Service-Key: <key>`。签发/轮换/吊销走 `POST /admin/api-keys`（Bearer ADMIN_API_KEY）。

| label | scope | key（明文，仅 admin 可见一次） | rate_limit | 备注 |
|---|---|---|---|---|
| arbitrage | data | `dx_7ee2af1fc6612bd3bf85a65b12b6492c881d86e8d6699e45` | 600/min | **Arbitrage 套利平台**（PRD arbitrage-data-requirements，2026-08-19 签发；公网实测 external/ml/calendar/bars 全 200） |
| aitrader | data | `dx_…`（既有，历史签发） | — | AItrader B 端 |
| aihunter-saas | data | `dx_…`（既有，历史签发） | — | AIHunter SaaS B 端 |
| aiservicer | data | `dx_9e9f2…586a`（既有） | — | 服务侧 bridge |

> 说明：`dx_*` 完整明文只在签发响应 `data.api_key` 中返回一次，库中仅存 hash；上表仅 arbitrage 为本次新签（明文完整可见），其余请以签发时留存或 `GET /admin/api-keys` 掩码核对。

---

## 9. 安全提醒

- **MPC_ENCRYPTION_SECRET 曾泄漏于 git 历史**（建议轮换后再更新本文件）。
- 轮换任一 key 时需同步：对应 systemd unit env + 本文件 + 使用方配置（如 SDK/代理）。
- `CHAIN_RPC_READ_KEY` / `CHAIN_RPC_BROADCAST_KEY` 为 chain-rpc 网关与 mpc 共用，轮换需双端同步。
