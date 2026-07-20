# InfraX 项目当前状态总结

> 编写日期: 2026-07-21 | 当前版本: `v0.3.4` | GitHub: https://github.com/sftgroup/infraX

---

## 一、项目概述

InfraX 是一个 **Web3 基础设施平台**，提供钱包管理、多签保险库、链上数据查询、支付引擎等模块，通过 Monorepo 架构组织，10 个子项目。

**生产地址**: `http://43.156.99.215:9111`  
**SSH**: `ssh ubuntu@43.156.99.215`（直连，不需要跳板机）  
**密码**: 由运维管理

---

## 二、生产环境

### 服务器规格

| 项目 | 配置 |
|------|------|
| CPU | 4 核 |
| 内存 | 8 GB（当前使用 ~4.5G，可用 ~2.3G） |
| 系统盘 | 80 GB (`/dev/vda2`，已用 49G / 65%） |
| 数据盘 | 200 GB (`/dev/vdb` → `/mnt/pgdata`，已用 11G / 6%） |
| 系统 | Ubuntu |

### 运行服务（12 个 systemd + 1 个 timer）

| 服务 | 端口 | 数据库 | 语言 | 状态 |
|------|------|--------|------|:--:|
| Admin | 9100 | 跨 7 DB | TypeScript (tsx) | 🟢 |
| Collector | 9101 | `pocketx_collector` | TypeScript | 🟢 |
| DC | 9102 | `pocketx_dc` | TypeScript | 🟢 |
| DC MCP | 9103 | — | TypeScript | 🟢 |
| MPC | 9104 | `pocketx_mpc` | TypeScript | 🟢 |
| MPC MCP | 9105 | — | TypeScript | 🟢 |
| Payment | 9106 | `pocketx_payment` | TypeScript | 🟢 |
| Vault | 9107 | `pocketx_vault` | TypeScript (tsx) | 🟢 |
| Vault MCP | 9108 | — | TypeScript | 🟢 |
| WAAS | 9109 | `pocketx_waas` | TypeScript | 🟢 |
| Wallet MCP | 9110 | — | TypeScript | 🟢 |
| Web | 9111 | — | JavaScript (纯 Node) | 🟢 |
| Cleanup Timer | — | `pocketx_collector` | Shell | 🟢 (每日 03:00) |

### 数据库（7 个 PostgreSQL）

| 数据库 | 用途 |
|--------|------|
| `pocketx_collector` | 链上事件 + checkpoint + OKX/Binance 价格 |
| `pocketx_waas` | 钱包/用户/交易/SaaS 租户 (17 表) |
| `pocketx_vault` | Safe 多签 (4 表) |
| `pocketx_dc` | 数据订阅 |
| `pocketx_mpc` | MPC 钱包 |
| `pocketx_payment` | 支付订单 |
| `pocketx_admin` | 管理后台 |

**数据保留**: 5 天自动清理（`infrax-cleanup.timer` 每日凌晨执行）

---

## 三、代码库统计

| 项目 | 类型 | 运行方式 |
|------|------|----------|
| `web/` | 前端 SPA + API 代理 | 纯 Node.js HTTP server（零依赖），端口 9111 |
| `admin/` | 管理后台 | Express 5 + tsx |
| `mpc/` | MPC 多方计算钱包 | Express + tsx |
| `waas/` | 钱包即服务 | Express + tsx |
| `vault/` | Safe 多签保险库 | Express + tsx |
| `dc/` | 数据中心 | Express + tsx |
| `collector/` | 5 链区块扫描器 | tsx |
| `payment/` | 支付引擎 | Express + tsx |
| `mcp-server/` | 4 个 MCP 协议服务 | tsx |
| `sdk/` | TypeScript SDK (infrax-dk) | npm 包 |

**文件统计**: 90 个 `.ts` 文件 + 10 个 `.js` 文件 + 6 个 `.html` 文件

### 前端模块（`web/modules/`）

| 文件 | 模块 |
|------|------|
| `core.js` | 核心库：`afetch`、`user`、`setupNav`、`showToast` |
| `nc-wallet.js` | Dashboard 仪表盘 |
| `mpc-wallet.js` | MPC 多方计算钱包 |
| `waas.js` | WaaS 钱包即服务（B2B） |
| `safe.js` | Safe/Vault 多签 |
| `datacenter.js` | Data Center 数据查询 |
| `payment.js` | Payment 支付 |
| `waas-extras.js` | WaaS 辅助函数 |
| `exports.js` | 导出功能 |

### 前端页面

| 文件 | 用途 |
|------|------|
| `index.html` | 主应用 (SPA) |
| `landing.html` | 产品落地页 |
| `connect.html` | 钱包连接页（MetaMask + Private Key） |
| `admin.html` | 管理后台入口 |
| `admin-login.html` | 管理后台登录页 |

---

## 四、支持的公链

| 链 | chain 参数 | Chain ID |
|---|-----------|----------|
| Sepolia | `sepolia` | 11155111 |
| Ethereum | `eth` | 1 |
| BSC | `bsc` | 56 |
| Base | `base` | 8453 |
| OxaChain | `oxa` | 19505 |

---

## 五、Web Proxy 路由

```
/api/v2/data    → :9102 (DC)
/api/v2/mpc     → :9104
/api/v2/wallet  → :9109
/api/v2/waas    → :9109
/api/v2/saas    → :9109
/api/vault      → :9107
/api/v2/vault   → :9107
/api/v2/payment → :9106
/api/v2/admin   → :9100
```

---

## 六、v0.3.4 本轮修复（2026-07-21）

通过真实浏览器操作（Playwright + Chromium）完成的端到端测试中发现并修复 6 个 Bug：

| # | 问题 | 根因 | 文件 |
|---|------|------|------|
| 1 | nc-wallet.js 浏览器加载失败 `ERR_INCOMPLETE_CHUNKED_ENCODING` | `writeHead()` 未设 `Content-Length`，chunked 传输 + keep-alive 导致中断 | `web/server.js` |
| 2 | 登录后 Dashboard 空白骨架 | `ncDash` 仅绑定 nav click 事件，初始加载不触发 | `web/modules/core.js` |
| 3 | 已激活 MPC 用户看到 Register 注册表单 | HTML 默认 active 子标签是 `mpc-reg` | `web/modules/mpc-wallet.js` |
| 4 | Safe Vault 列表 `userId required` | `/safe/owned` 不接受 `x-wallet-address` header | `vault/server.ts` |
| 5 | Payment 创建订单无响应 | 前端 `paymentMethod` vs 后端 `method` 字段名不匹配 | `web/modules/payment.js` |
| 6 | WaaS 地址分配无响应 | 请求体缺少 `tenantId` | `web/modules/waas.js` |

---

## 七、测试覆盖

### 测试文档（7 份，共 67 场景 + 160+ 端点）

| # | 文档 | 视角 | 场景 |
|---|------|------|:--:|
| P1 | `INFRAX_TEST_P1_ONBOARDING.md` | 新用户入驻 | 10 |
| P2 | `INFRAX_TEST_P2_REST_API.md` | 后端 API 全链路 | 10 |
| P3 | `INFRAX_TEST_P3_MCP.md` | AI Agent MCP 接入 | 8 |
| P4 | `INFRAX_TEST_P4_ADMIN.md` | 平台管理员 | 10 |
| P5 | `INFRAX_TEST_P5_MPC_DEEP.md` | MPC 深度测试 | 9 |
| P6 | `INFRAX_TEST_P6_MODULES.md` | 业务模块深度 | 20 |
| P7 | `INFRAX_TEST_P7_USER_JOURNEYS.md` | 浏览器 E2E 用户路径 | — |

### 已验证通过的功能路径

| 路径 | 状态 |
|------|:--:|
| Landing 页面展示 | ✅ |
| Connect 私钥注入登录 | ✅ |
| Dashboard KPI/服务表/Usage 渲染 | ✅ |
| MPC 钱包 Dashboard 自动激活 | ✅ |
| WaaS 租户 + Token + 地址分配 | ✅ |
| Safe Vault 列表查询（7 个已有 Safe） | ✅ |
| Data Center Explorer 查询 | ✅ |
| Payment 创建订单 + 历史查询 | ✅ |
| Admin Dashboard（1 租户/1 用户） | ✅ |

---

## 八、当前已知问题

| 优先级 | 问题 | 说明 |
|:---:|------|------|
| 中 | Collector BSC 部分端点限流 | 12 端点 pool，部分会被限速 |
| 低 | Collector OKX ChainOS API 404 | 遗留问题，暂不影响 |
| 低 | MPC 验证码固定为 888888 | 无邮件发送机制，开发模式 |
| 低 | Safe Vault 部署需要区块链签名 | 浏览器自动化无法完成 MetaMask 弹窗确认（非 Bug，环境限制） |
| 低 | Admin 登录密码为加密串 `a87cefd6e1ce487334a67b0c` | 通过 systemd 环境变量注入，前端 `admin123` 已失效 |

---

## 九、部署流程

```
本地修改 → git commit → git push origin master
                ↓
生产环境: cd /opt/infraX && git pull && systemctl restart <service>
```

**注意**:
- 前端 JS/CSS/HTML 文件修改只需 `scp` 到 `/opt/infraX/projects/web/`，无需重启服务
- TypeScript 服务（tsx 运行）修改 `.ts` 后需 `systemctl restart`
- 无编译步骤（tsx 即时运行 TypeScript）

---

## 十、后续开发建议

### 短期（1-2 周）

1. **MPC 邮件验证码**: 对接真实邮件服务（如 SendGrid），发送随机验证码替代固定 888888
2. **Safe Vault 端到端**: 补充 Safe 创建→充值→提案→多签→执行的完整流程测试（需多钱包签名环境）
3. **Admin 密码管理**: 提供明文密码或重置接口，文档化 `ADMIN_PASS` 环境变量
4. **前端错误提示增强**: Payment/WaaS 操作失败时给出明确的 toast 错误提示

### 中期（2-4 周）

5. **x402 HTTP Payment**: 完善 HTTP 402 支付协议集成
6. **Webhook 推送验证**: 测试 DC 事件订阅 → Collector 推送的闭环
7. **Collector 稳定性**: 解决 BSC 端点限流，增加更多 RPC 源
8. **性能测试**: 按 P6 基线标准压测各 API 端点

### 长期

9. **前端重构**: 将 10 个独立 `.js` 模块合并为构建工具（Vite/Webpack）管理的 SPA
10. **TypeScript 迁移**: Web 模块的 `.js` 文件逐步迁移到 TypeScript
11. **CI/CD**: 自动化测试 + 部署流水线
12. **监控告警**: 服务健康检查 + 数据库磁盘使用告警

---

## 十一、代码库三地一致性确认

**2026-07-21 确认**:

| 位置 | Commit | 状态 |
|------|--------|:--:|
| GitHub | `893f3e3` | ✅ |
| 本地 | `893f3e3` | ✅ |
| 生产 | 14 核心文件 MD5 全部匹配 | ✅ |

---

> **项目仓库**: https://github.com/sftgroup/infraX  
> **部署文档**: `DEPLOYMENT.md`  
> **测试报告**: `test-reports/` 目录（P1-P7 + E2E + Code Review）
