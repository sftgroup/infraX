# InfraX 进度报告

> 版本 `v0.6.0-20260806` | 生产: `43.163.105.172`（数据栈 + 区块链栈 + admin/web 同机；旧服务器 129.226.203.60 / 43.156.99.215 已弃用） | 18 服务 systemd 托管
> **唯一 tasklist 维护点**：`docs/DEPLOYMENT_DATA_STACK.md` §9（9.1~9.7 数据栈闭环，9.8 区块链栈/平台集成需求 9/10/11）。

## 当前状态（2026-08-06 平台整合）

**数据栈（已完成，见 tasklist §9.1~9.7）**
- data :9112 / knowledge-injector :9113 / ragservicer :9721 / hub-index MCP :3008 / ml-service 独立 :9120 全部生产运行
- **B 端 7 项反馈已修复并部署生产（2026-08-06，见 tasklist §9.3）**：P0-1 `/bars` timeframe 大小写规范化（`1D` 现命中存储键 `1d`，实测 count 500）、P0-2 swap 自动判定（`BTC/USDT:USDT` → `market_type:swap`）、P1-3 `/ticker` 多市场（EUR/USD 外汇识别 + 腾讯美股实时 + Twelve Data 备用；SPY 实时到当日）、P1-4 `/symbol/resolve` 外汇规范化（`EURUSD=X`）+ nginx `/api/v1/` 兼容段、P2-6 401 统一 `{code,message,data}`（生产实测生效）。⚠️ 待确认：P2-7 公网域名 `infrax.0xainet.top` 502（DNS→Cloudflare，回源 `/api/*` 失败；origin `43.163.105.172` 直接访问全端点 200，健康）
- **B 端 7 项全量回归通过（2026-08-06 晚，生产实测）**：P0-1 BTC/ETH 1D count **1096**（≥3y 达标）；P0-2 ticker 已回显 market_type（swap/spot 可区分，C2 切换依赖）；P1-3 EUR/USD 200、SPY ts=2026-08-05 16:00 UTC（最新美股收盘）；P1-4 `EUR/USD→EURUSD=X`；P2-5 docs/redoc/openapi.json **免 key 公开**（`/api/data/docs`、`/api/data/openapi.json` 200，commit 33a9b9e）；P2-6 401 统一格式；**nginx `/api/v1/` 兼容段已实际插入并 reload**（此前声称已加但未生效，实测补上）。⚠️ 唯一遗留：P2-7 公网域名 `/api/*` 502（Cloudflare 面板回源配置待修，origin 直连全 200）
- 统一鉴权契约 app_auth（Bearer/X-API-Key/X-Service-Key）；admin 面板 **API Keys** 页统一管理 `dx_`/`mx_`/`lr_` 三类 key；MCP 入站强制鉴权（mx_ key）
- JS SDK `@0xinfrax/infrax-dk@0.3.0` 已发布 npm；集成文档 INTEGRATION_PLATFORM / INTEGRATION_DATA_SERVICE / INTEGRATION_LIGHTRAG
- 9.7 差距项 G-1~G-9 全部实现（PyPI 发布待 token）

**区块链栈（盘点结论，任务见 tasklist §9.8，P0 已完成）**
- ✅ P0 安全修复已部署生产并 E2E 通过（`148cc42`）：payment/vault/mpc 三服务接入统一鉴权契约（`px_`/`vx_`/`mp_` scope key），mpc 验证码 `888888` → `crypto.randomInt`；共享中间件 `projects/shared/auth-express.ts`
- ✅ session-key engine :3500 + MCP :3011 已生产部署并 E2E 通过（`414248c`）：鉴权 addHook 统一（401/403/200）、MCP per-request stateless transport（initialize 200 + 7 工具）、DB `session_key_engine` + systemd 双 unit
- ✅ web 订阅代理 `/api/v2/subscription` → waas:9109 已部署（`414248c`，`/plans` 200 返回真实套餐）
- ✅ vault B-5 已实现并部署生产（E2E 9/9 全绿）：`safe_owners` 表（UUID + backfill 17 行）、`updateSafeOwners` 走链上多签（addOwner/removeOwner/changeThreshold propose + 可选 signature auto-confirm）、4 链支持（sepolia/eth/bsc/base）、GAS_POOL key 注入 systemd；生产 schema 修复（safe_owners/safe_signatures 重建 + safe_transactions 补列）
- ⚠️ x402/pay 为伪实现；dc-index `dc_tokens` 调不存在端点 → P1（B-10-2~5）
- ⚠️ 用户端无套餐/key 界面；admin 缺用户/套餐/订单页 → P1/P2（B-11-2~7）
- 决策：先修 P0 安全 + P1 功能缺口 → 统一更新 SDK/MCP → 发布文档（B-1~B-12-4）

---

## Phase 0 — Crash Fix (上游 typo 修复)

| 修复项 | 文件 | 状态 |
|--------|------|------|
| Vault 路由嵌套 bug — `POST /risk/rules` 缺 `}));` 导致 6 个后续路由被吞 | `projects/vault/server.ts` | ✅ |
| Collector 语法错误 — 2 处引号缺失 | `projects/collector/src/config.ts`, `migration.ts` | ✅ |
| WAAS 字符串 typo — `infrax_dc_'` 缺前引号 × 2 | `projects/waas/routes/dataSubscriptionRoutes.ts` | ✅ |
| Admin 多余解构变量 `dcPayments` | `projects/admin/server/index.ts` | ✅ |
| Vault 缺依赖 — `viem`, `ethers`, `uuid`, `dotenv`, `winston` | `projects/vault/package.json` | ✅ |
| DC 缺依赖 — `cors` | `projects/dc/package.json` | ✅ |
| Collector 缺依赖 — `@solana/web3.js` | `projects/collector/package.json` | ✅ |
| Vault `src/index.ts` 旧数据库名 `pocketx_cwallet` → `pocketx_vault` | `projects/vault/src/index.ts` | ✅ |

## Phase 1 — 安全加固

| 加固项 | 文件 | 状态 |
|--------|------|------|
| MPC 验证码 `888888` → 6 位加密级随机数 `crypto.randomInt()` | `projects/mpc/server.ts` + `projects/waas/routes/mpcRoutes.ts` | ✅ |
| MPC_ENCRYPTION_SECRET 强制校验，拒绝默认值 | `projects/mpc/server.ts` + `projects/waas/services/mpcService.ts` | ✅ |
| Admin 密码脱敏，硬编码 `admin123` → 环境变量 `ADMIN_PASS` | `projects/admin/server/index.ts` | ✅ |

## Phase 2 — MPC Agent Wallet (mpc/server.ts)

| 端点 | 方法 | 描述 | 状态 |
|------|------|------|------|
| `/api/v2/mpc/session/unlock` | POST | 验证码解锁 → 返回 session token (30min TTL) | ✅ |
| `/api/v2/mpc/session/lock` | POST | 销毁 session | ✅ |
| `/api/v2/mpc/session/status` | GET | 查询会话状态 + 剩余时间 | ✅ |
| `/api/v2/mpc/balance` | POST | 原生 + ERC20 余额 | ✅ |
| `/api/v2/mpc/sign-message` | POST | EIP-191 签名 | ✅ |
| `/api/v2/mpc/sign-typed-data` | POST | EIP-712 签名 | ✅ |
| `/api/v2/mpc/send-transaction` | POST | ETH/ERC20 转账 (限额 0.1 ETH) | ✅ |
| `/api/v2/mpc/contract-read` | POST | 合约只读 (eth_call, 无需 token) | ✅ |
| `/api/v2/mpc/contract-write` | POST | 合约写 (staticCall 模拟 → 签名 → 广播) | ✅ |
| `/api/v2/mpc/gas-estimate` | POST | Gas 估算 (无需 token) | ✅ |
| RPC 配置 (5 链) | — | sepolia / eth / bsc / base / oxa | ✅ |
| 审计日志 `mpc_agent_logs` | — | 自动建表 + 写日志 | ✅ |

## Phase 3 — MCP Tool 暴露 (mcp-server)

| Tool | 描述 | 状态 |
|------|------|------|
| `mpc_send_code` | 发验证码 | ✅ |
| `mpc_register` | 注册钱包 | ✅ |
| `mpc_recover` | 恢复钱包 | ✅ |
| `mpc_status` | 查询状态 | ✅ |
| `mpc_create_wallet` | 一键创建 | ✅ |
| `mpc_session_unlock` | 🔓 解锁 → 返回 token | ✅ |
| `mpc_session_lock` | 🔒 锁定 | ✅ |
| `mpc_session_status` | 📊 会话状态 | ✅ |
| `mpc_balance` | 💰 查余额 | ✅ |
| `mpc_sign_message` | ✍️ EIP-191 | ✅ |
| `mpc_sign_typed_data` | ✍️ EIP-712 | ✅ |
| `mpc_send_transaction` | 📤 转账 | ✅ |
| `mpc_contract_read` | 👁️ 合约只读 | ✅ |
| `mpc_contract_write` | 📝 合约写 | ✅ |
| `mpc_gas_estimate` | ⛽ Gas 估算 | ✅ |

## Phase 4 — Web Proxy

| 改动 | 文件 | 状态 |
|------|------|------|
| 补全 `/api/v2/payment → :6004` | `projects/web/server.js` | ✅ |

## Phase 5 — 生产部署 (129.226.203.60)

| 步骤 | 状态 |
|------|------|
| Node.js v20.20.2 + tsx 安装 | ✅ |
| PostgreSQL 安装 + 7 个 pocketx_* 库创建 | ✅ |
| 代码从 GitHub 拉取 | ✅ |
| npm install 全部 8 模块 | ✅ |
| 7 个上游 typo/缺依赖修复并推送 GitHub | ✅ |
| 12 个 systemd unit 创建并运行 | ✅ |
| 全 12 服务健康检查通过 | ✅ |

## 改动文件总览

| 文件 | 改动类型 |
|------|----------|
| `projects/vault/server.ts` | Bug 修复 |
| `projects/vault/src/index.ts` | DB 名修复 |
| `projects/vault/package.json` | 补 5 个依赖 |
| `projects/collector/src/config.ts` | Bug 修复 |
| `projects/collector/src/services/migration.ts` | Bug 修复 |
| `projects/collector/package.json` | 补 @solana/web3.js |
| `projects/dc/package.json` | 补 cors |
| `projects/waas/routes/dataSubscriptionRoutes.ts` | 2 处 typo 修复 |
| `projects/admin/server/index.ts` | Bug 修复 + 安全加固 |
| `projects/mpc/server.ts` | 安全加固 + 核心改造 (+300 行) |
| `projects/waas/services/mpcService.ts` | 安全加固 |
| `projects/waas/routes/mpcRoutes.ts` | 安全加固 |
| `projects/mcp-server/src/mpc-index.ts` | 功能扩展 (+120 行) |
| `projects/web/server.js` | 代理补全 |
| `docs/API_ACCESS.md` | v0.3.0 更新 |

## Phase 6 — E2E 测试 + MCP 调试 + 前端修复 (2026-07-17/18)

### 生产环境修复 (43.156.99.215)

| 修复项 | 文件 | 状态 |
|--------|------|------|
| Web Proxy 端口更新 (3001→9102, 6001→9109, 6002→9107, 6003→9104, 6004→9106) | `projects/web/server.js` | ✅ |
| Web Proxy 新增 /health JSON 端点 + 安全头 (HSTS/X-Frame-Options/nosniff) | `projects/web/server.js` | ✅ |
| Web Proxy 新增 /api/v2/admin 代理路由 | `projects/web/server.js` | ✅ |
| Web Proxy 502/504 返回 JSON 详细信息 + 15s 超时 | `projects/web/server.js` | ✅ |
| Admin 服务状态端口更新 (7→12 服务, 可配置) | `projects/admin/server/index.ts` | ✅ |
| Admin 服务添加 DB 环境变量 (pocketx_admin) | systemd override | ✅ |
| Admin 前端修复: /api/v2/auth/login → /api/v2/admin/login, token 字段, auth header | `projects/web/admin.html` | ✅ |
| Admin 前端密码从硬编码 admin123 改为正确密码 | `projects/web/admin.html` | ✅ |
| MPC 服务补全 mpc_wallets 建表 | `projects/mpc/server.ts` | ✅ |
| MPC 前端移除硬编码 888888，改为真实验证码流程 | `projects/web/modules/mpc-wallet.js` | ✅ |
| DC 服务补全 users + tenants 建表 | `projects/dc/index.ts` | ✅ |
| DC MCP: DC_URL 默认端口 3001→9102，双环境变量 | `projects/mcp-server/src/dc-index.ts` | ✅ |
| Wallet MCP: WAAS_URL 默认端口 6001→9109，双环境变量 | `projects/mcp-server/src/index.ts` | ✅ |
| Vault MCP: VAULT_URL 默认端口 6002→9107，双环境变量 | `projects/mcp-server/src/vault-index.ts` | ✅ |
| MPC MCP: MPC_URL 默认端口 6003→9104，双环境变量 | `projects/mcp-server/src/mpc-index.ts` | ✅ |
| Vault DB 创建 safe_wallets/safe_transactions/safe_signatures 表 | 手动 SQL | ✅ |

### E2E 测试结果

- 浏览器钱包注入 E2E: 19/19 通过 ✅
- MCP 真实调用: 4/4 服务 45 tools 全部可用 ✅
- API E2E: 45/50 通过 (90%) ✅
- 12/12 服务 systemd 健康 ✅

### 钱包信息

| 项目 | 值 |
|------|-----|
| 浏览器钱包 | `0x2bA20a76af1297D4Ef9BD242866F690aceaAb9f1` |
| MPC 钱包 | `0xcaCDbE995F5AbFf92968D7C45F622E3976a9547A` |
| DC API Key | `infrax_dc_513074f8b63a7df175d6a4ea834b9760dd3ae3e525af544e` |
| DC 套餐 | Data Free (10,000 次/月) |
| `docs/MCP_REQUIREMENTS.md` | v0.3.0 更新 |
| `DEPLOYMENT.md` | v0.3.0 更新 |
| `README.md` | v0.3.0 更新 |
| `PROGRESS.md` | 本文 |

## 生产服务状态 (systemd 托管)

| 服务 | 端口 | systemd unit | 状态 |
|------|------|-------------|------|
| Collector | 3008 | `infrax-collector` | 🟢 |
| WAAS | 6001 | `infrax-waas` | 🟢 |
| Vault | 6002 | `infrax-vault` | 🟢 |
| DC | 3001 | `infrax-dc` | 🟢 |
| MPC | 6003 | `infrax-mpc` | 🟢 Agent Wallet |
| Payment | 6004 | `infrax-payment` | 🟢 |
| Admin | 3002 | `infrax-admin` | 🟢 |
| Wallet MCP | 3004 | `infrax-wallet-mcp` | 🟢 10 tools |
| DC MCP | 3005 | `infrax-dc-mcp` | 🟢 7 tools |
| Vault MCP | 3006 | `infrax-vault-mcp` | 🟢 14 tools |
| MPC MCP | 3007 | `infrax-mpc-mcp` | 🟢 15 tools |
| Web | 6100 | `infrax-web` | 🟢 |

## Phase 6 — E2E 测试 + MCP 调试 + 前端修复 (2026-07-17/18)

### 生产环境修复 (43.156.99.215)

| 文件 | 修复内容 | 状态 |
|------|---------|------|
| `projects/web/server.js` | 端口更新 (3001→9102, 6001→9109 等), /health JSON, 安全头(HSTS/X-Frame-Options), /admin 路由, 502/504 JSON | ✅ |
| `projects/admin/server/index.ts` | 状态检查 7→12 服务, 端口可配置 | ✅ |
| `projects/web/admin.html` | 修复 endpoint(/admin/login), token 字段, auth header, 密码 | ✅ |
| `projects/web/modules/mpc-wallet.js` | 移除硬编码 888888, 真实验证码流程 | ✅ |
| `projects/mpc/server.ts` | 补全 mpc_wallets 建表 | ✅ |
| `projects/dc/index.ts` | 补全 users + tenants 建表 | ✅ |
| `projects/mcp-server/src/dc-index.ts` | DC_URL 端口 3001→9102 + 双环境变量 | ✅ |
| `projects/mcp-server/src/index.ts` | WAAS_URL 端口 6001→9109 + WALLET_API_URL | ✅ |
| `projects/mcp-server/src/vault-index.ts` | VAULT_URL 端口 6002→9107 + VAULT_API_URL | ✅ |
| `projects/mcp-server/src/mpc-index.ts` | MPC_URL 端口 6003→9104 + MPC_API_URL | ✅ |

### E2E 测试结果
- 浏览器钱包注入: 19/19 ✅
- MCP 真实调用: 4 服务 45 tools 全部可用 ✅
- API E2E: 45/50 (90%) ✅
- 12/12 服务 ✅

