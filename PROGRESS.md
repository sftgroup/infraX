# InfraX 进度报告

> 版本 `v0.3.0-20260717` | 服务 12/12 在线

## Phase 0 — Crash Fix

| 修复项 | 文件 | 状态 |
|--------|------|------|
| Vault 路由嵌套 bug — `POST /risk/rules` 缺 `}));` 导致 6 个后续路由被吞 | `projects/vault/server.ts` | ✅ |
| Collector 语法错误 — `infrax123'` 缺前引号 | `projects/collector/src/config.ts` | ✅ |
| Admin revenue 多余解构变量 `dcPayments` | `projects/admin/server/index.ts` | ✅ |

## Phase 1 — 安全加固

| 加固项 | 文件 | 状态 |
|--------|------|------|
| MPC 验证码 `888888` → 6 位加密级随机数 `crypto.randomInt()` | `projects/mpc/server.ts` + `projects/waas/routes/mpcRoutes.ts` | ✅ |
| MPC_ENCRYPTION_SECRET 强制校验，拒绝默认值 | `projects/mpc/server.ts` + `projects/waas/services/mpcService.ts` | ✅ |
| Admin 密码脱敏，硬编码 `admin123` → 环境变量 `ADMIN_PASS` | `projects/admin/server/index.ts` | ✅ |

## Phase 2 — MPC Agent Wallet

| 端点 | 方法 | 描述 | 状态 |
|------|------|------|------|
| `/api/v2/mpc/session/unlock` | POST | 验证码解锁 → 返回 session token (30min TTL) | ✅ |
| `/api/v2/mpc/session/lock` | POST | 销毁 session | ✅ |
| `/api/v2/mpc/session/status` | GET | 查询会话状态 | ✅ |
| `/api/v2/mpc/balance` | POST | 原生 + ERC20 余额 | ✅ |
| `/api/v2/mpc/sign-message` | POST | EIP-191 签名 | ✅ |
| `/api/v2/mpc/sign-typed-data` | POST | EIP-712 签名 | ✅ |
| `/api/v2/mpc/send-transaction` | POST | ETH/ERC20 转账 (限额 0.1 ETH) | ✅ |
| `/api/v2/mpc/contract-read` | POST | 合约只读 (eth_call) | ✅ |
| `/api/v2/mpc/contract-write` | POST | 合约写 (staticCall 模拟 → 签名 → 广播) | ✅ |
| `/api/v2/mpc/gas-estimate` | POST | Gas 估算 | ✅ |
| RPC 配置 (5 链) | — | sepolia/eth/bsc/base/oxa | ✅ |
| 审计日志 `mpc_agent_logs` | — | 自动建表 + 写日志 | ✅ |

## Phase 3 — MCP Tool 暴露

| Tool | 描述 | 状态 |
|------|------|------|
| `mpc_send_code` | 发验证码 | ✅ (已有) |
| `mpc_register` | 注册钱包 | ✅ (已有) |
| `mpc_recover` | 恢复钱包 | ✅ (已有) |
| `mpc_status` | 查询状态 | ✅ (已有) |
| `mpc_create_wallet` | 一键创建 | ✅ (已有) |
| `mpc_session_unlock` | 🔓 解锁 → 返回 token | ✅ (新) |
| `mpc_session_lock` | 🔒 锁定 | ✅ (新) |
| `mpc_session_status` | 📊 会话状态 | ✅ (新) |
| `mpc_balance` | 💰 查余额 | ✅ (新) |
| `mpc_sign_message` | ✍️ EIP-191 | ✅ (新) |
| `mpc_sign_typed_data` | ✍️ EIP-712 | ✅ (新) |
| `mpc_send_transaction` | 📤 转账 | ✅ (新) |
| `mpc_contract_read` | 👁️ 合约只读 | ✅ (新) |
| `mpc_contract_write` | 📝 合约写 | ✅ (新) |
| `mpc_gas_estimate` | ⛽ Gas 估算 | ✅ (新) |

## Phase 4 — Web Proxy 补全

| 改动 | 文件 | 状态 |
|------|------|------|
| 补全 `/api/v2/payment → :6004` | `projects/web/server.js` | ✅ |

## 改动文件总览

| 文件 | 改动类型 |
|------|----------|
| `projects/vault/server.ts` | Bug 修复 |
| `projects/collector/src/config.ts` | Bug 修复 |
| `projects/admin/server/index.ts` | Bug 修复 + 安全加固 |
| `projects/mpc/server.ts` | 安全加固 + 核心改造 (+300 行) |
| `projects/waas/services/mpcService.ts` | 安全加固 |
| `projects/waas/routes/mpcRoutes.ts` | 安全加固 |
| `projects/mcp-server/src/mpc-index.ts` | 功能扩展 (+120 行) |
| `projects/web/server.js` | 代理补全 |

## 服务状态

| 服务 | 端口 | 状态 |
|------|------|------|
| WAAS | 6001 | 🟢 |
| Vault | 6002 | 🟢 |
| DC | 3001 | 🟢 |
| MPC | 6003 | 🟢 Agent Wallet |
| Payment | 6004 | 🟢 |
| Collector | 3008 | 🟢 |
| Admin | 3002 | 🟢 |
| Wallet MCP | 3004 | 🟢 |
| DC MCP | 3005 | 🟢 |
| Vault MCP | 3006 | 🟢 |
| MPC MCP | 3007 | 🟢 15 tools |
| Web | 6100 | 🟢 |
