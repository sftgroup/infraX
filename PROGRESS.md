# InfraX 进度报告

> 版本 `v0.3.0-20260717` | 生产: `129.226.203.60` | 12 服务 systemd 托管

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
