# InfraX 端到端全场景测试文档 — P1: 入驻 + Dashboard

> v0.3.3-20260720 | 生产 `43.156.99.215:9111` | 文档版本 v1.0

## 概述

本文档覆盖 InfraX 新用户从零开始到成功查看 Dashboard 的完整用户路径：

```
Landing Page → 钱包连接 → MPC 注册/恢复 → Dashboard 仪表盘 (4 模块状态)
```

### 测试环境

| 项目 | 值 |
|------|-----|
| 生产服务器 | `43.156.99.215` |
| Web 入口 | `:9111` (Web Proxy) |
| 管理后台入口 | `:9111/admin.html` |
| 浏览器钱包地址 | `0x2bA20a76af1297D4Ef9BD242866F690aceaAb9f1` |
| MPC 钱包地址 | `0xcaCDbE995F5AbFf92968D7C45F622E3976a9547A` |
| 测试邮箱 | `agent@infrax.io` |

### 参考文档

- `README.md` — 架构总览、Dashboard 数据流
- `DEPLOYMENT.md` — systemd 服务、端口表
- `docs/API_ACCESS.md` — REST/MCP/SDK 三合一接入
- `projects/web/modules/core.js` — 前端核心库
- `projects/web/modules/nc-wallet.js` — Dashboard 模块

---

## 场景 1: Landing Page — 产品落地页

### 场景描述
用户首次访问 InfraX，看到产品落地页，了解平台能力。

### 测试步骤

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1.1 | 浏览器打开 `http://43.156.99.215:9111/landing.html` | 加载成功，显示 InfraX 品牌和产品介绍 |
| 1.2 | 检查页面布局 | 包含 Header (Logo + Connect Wallet 按钮)、Hero 区域、功能模块卡片 (WAAS/Vault/DC/MPC) |
| 1.3 | 检查"Connect Wallet"按钮可见 | 按钮存在且可点击 |
| 1.4 | 检查链 Logo 图片加载 | chain-sepolia.svg / chain-ethereum.svg 等 6 个 Logo 正常渲染 |

### API 端点
> Landing Page 为纯静态 HTML，无后端 API 调用。

### 验证点
- [ ] `landing.html` 返回 HTTP 200
- [ ] 所有 `<img>` 标签正常加载
- [ ] 页面无 JS console error
- [ ] 安全头: `HSTS`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`

---

## 场景 2: 钱包连接 — MetaMask 注入

### 场景描述
用户点击 "Connect Wallet"，浏览器注入 Mock MetaMask Provider，完成钱包连接。

### 测试步骤

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 2.1 | 从 Landing → 点击 "Connect Wallet" | 跳转到 `connect.html` |
| 2.2 | 检查 `connect.html` 加载 | 显示 MetaMask 连接引导界面 |
| 2.3 | 浏览器注入 Mock Provider | `window.ethereum` 就绪，`eth_requestAccounts` 返回 `[0x2bA20a76af1297D4Ef9BD242866F690aceaAb9f1]` |
| 2.4 | 页面调用 `connectWallet()` | MetaMask 弹窗出现，用户确认连接 |
| 2.5 | 连接完成 | 钱包地址存入 `localStorage.walletAddress` |
| 2.6 | 自动跳转 | 重定向到 `index.html` (Dashboard) |

### 涉及代码
- `projects/web/connect.html` — Connect 页面
- `projects/web/modules/core.js` — `connectWallet()` 函数

### 预期行为细节
```javascript
// core.js 中的钱包连接流程
// 1. 注入 ethers Mock Provider
// 2. const provider = new ethers.providers.Web3Provider(window.ethereum)
// 3. await provider.send("eth_requestAccounts", [])
// 4. localStorage.setItem('walletAddress', accounts[0])
// 5. window.location.href = 'index.html'
```

### 验证点
- [ ] `window.ethereum` 存在
- [ ] `eth_requestAccounts` 返回钱包地址
- [ ] `localStorage.walletAddress` 已写入
- [ ] 成功跳转到 `index.html`

---

## 场景 3: MPC 钱包注册

### 场景描述
新用户进入 Dashboard 后，需要注册 MPC Agent Wallet。通过邮箱验证码创建密钥分片。

### 预置状态
- 钱包已连接（`localStorage.walletAddress` = `0x2bA20a76af1297D4Ef9BD242866F690aceaAb9f1`）
- MPC 状态查询 `GET /api/v2/mpc/status?address=0x2bA20...` 返回 `{ registered: false }`

### 测试步骤

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 3.1 | 进入 Dashboard，点击 MPC 卡片 "Register" | 弹出 MPC 注册表单 (邮箱输入框 + 发送验证码按钮) |
| 3.2 | 输入邮箱 `agent@infrax.io`，点击 "Send Code" | 调用 `POST /api/v2/mpc/send-code`，等待验证码 |
| 3.3 | 验证码发送成功 | 输入框激活，可输入 6 位验证码 |
| 3.4 | 输入验证码 `123456` (示例)，点击 "Register" | 调用 `POST /api/v2/mpc/register` |
| 3.5 | 注册成功 | 返回 `{ code: 0, data: { address: "0xcaCD...", email: "agent@infrax.io" } }` |
| 3.6 | Dashboard 刷新 | MPC 卡片状态变为 "Active"，显示钱包地址 |

### API 端点

```
POST /api/v2/mpc/send-code
  Body: { "email": "agent@infrax.io" }
  Response: { "code": 0, "message": "Verification code sent" }

POST /api/v2/mpc/register
  Body: { "email": "agent@infrax.io", "code": "123456" }
  Response: { "code": 0, "data": { "address": "0xcaCD...", "email": "agent@infrax.io" } }
```

### 涉及代码
- `projects/web/modules/mpc-wallet.js` — MPC 模块前端
- `projects/mpc/server.ts` — MPC 后端 `POST /send-code`, `POST /register`

### 负面测试

| 测试 | 操作 | 预期 |
|------|------|------|
| 3-N1 | 错误验证码 | `{ code: 400, message: "Invalid verification code" }` |
| 3-N2 | 重复注册同一邮箱 | `{ code: 400, message: "MPC wallet already exists" }` |
| 3-N3 | 空邮箱 | `{ code: 400, message: "Email is required" }` |
| 3-N4 | 验证码过期 | `{ code: 400, message: "Code expired" }` |

### 验证点
- [ ] `POST /api/v2/mpc/send-code` 返回 200
- [ ] 验证码发送到真实邮箱（生产环境不可注入 888888）
- [ ] `POST /api/v2/mpc/register` 返回 `code: 0`
- [ ] DB `pocketx_mpc.mpc_wallets` 新增记录
- [ ] 前端 Dashboard MPC 卡片状态更新为 Active
- [ ] 错误码场景 3-N1 ~ 3-N4 全部验证

---

## 场景 4: MPC 钱包恢复

### 场景描述
已注册用户在新设备/清缓存后，通过邮箱验证码恢复 MPC 钱包。

### 预置状态
- `localStorage.walletAddress` 存在
- MPC 已注册（`registered: true`）

### 测试步骤

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 4.1 | Dashboard → MPC 卡片显示 "Registered" | 显示已注册的 MPC 地址 |
| 4.2 | 清除 `localStorage`，重新连接钱包 | MPC 卡片显示 "Not Registered"（本地状态丢失） |
| 4.3 | 点击 "Recover" | 弹出恢复表单 |
| 4.4 | 输入邮箱 `agent@infrax.io`，发送验证码 | `POST /api/v2/mpc/send-code` |
| 4.5 | 输入验证码，点击 "Recover" | `POST /api/v2/mpc/recover` → 恢复成功 |
| 4.6 | 页面刷新 | MPC 卡片恢复 Active 状态 |

### API 端点

```
POST /api/v2/mpc/recover
  Body: { "email": "agent@infrax.io", "code": "123456" }
  Response: { "code": 0, "data": { "address": "0xcaCD...", "email": "agent@infrax.io" } }
```

### 验证点
- [ ] 恢复后 MPC 地址与注册时相同
- [ ] 错误验证码时拒绝恢复
- [ ] 未注册邮箱恢复返回 `{ code: 400, message: "MPC wallet not found" }`

---

## 场景 5: Dashboard — getMe() 并行查询

### 场景描述
进入 Dashboard 后，`core.js` 的 `getMe()` 函数并行查询 4 个模块状态，渲染仪表盘。

### 测试步骤

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 5.1 | `index.html` 加载 | `checkSession()` 检查 `localStorage.walletAddress` |
| 5.2 | 钱包地址存在 | 调用 `getMe()` |
| 5.3 | 并行请求 4 个 API | MPC Status + WAAS Status + Vault Status + DC Plan |
| 5.4 | 渲染 Dashboard | 4 个卡片显示状态 (Active/Inactive) |

### API 端点

| 请求 | 端点 | 预期响应 |
|------|------|---------|
| `GET` | `/api/v2/mpc/status?address=0x2bA20...` | `{ code: 0, data: { registered: true, mpcAddress: "0xcaCD..." } }` |
| `GET` | `/api/v2/waas/status?address=0x2bA20...` | `{ code: 0, data: { status: "active", planName: "Free" } }` |
| `GET` | `/api/vault/safe/list?address=0x2bA20...` | `{ code: 0, data: { safes: [...] } }` |
| `GET` | `/api/v2/data/usage?address=0x2bA20...` | `{ code: 0, data: { currentUsage: 0, monthlyQuota: 10000, planName: "Data Free" } }` |

### 涉及代码
- `projects/web/modules/core.js` — `getMe()` + `afetch()` + `checkSession()`
- `projects/web/modules/nc-wallet.js` — Dashboard 组件渲染

### Dashboard 4 卡片状态

| 卡片 | KPI | 状态判定 | 数据来源 |
|------|-----|---------|---------|
| **MPC** | 钱包注册状态 | `mpc.registered` → Active / Inactive | `GET /api/v2/mpc/status` |
| **WaaS** | 租户状态 + 计划 | `waas.status === "active"` → Active / Inactive | `GET /api/v2/waas/status` |
| **Vault** | Safe 数量 | `safes.length > 0` → Active / Inactive | `GET /api/vault/safe/list` |
| **Data Center** | 计划 + 用量 | `planName` + `currentUsage/maxQuota` | `GET /api/v2/data/usage` |

### 网络错误处理

| 场景 | 模拟方式 | 预期行为 |
|------|---------|---------|
| 5-E1 | MPC API 超时 | MPC 卡片显示 "Connection Error" |
| 5-E2 | WAAS API 返回 500 | WAAS 卡片显示 "Error" 并 retry 按钮 |
| 5-E3 | 全部 API 不可达 | Dashboard 显示 "Unable to load dashboard" |

### 验证点
- [ ] `getMe()` 发起 4 个并行请求
- [ ] 4 个 API 全部返回 `code: 0`
- [ ] 4 个卡片正确渲染状态
- [ ] `localStorage.walletAddress` 为空时跳转 `connect.html`
- [ ] 网络错误场景 5-E1 ~ 5-E3 正确处理

---

## 场景 6: Dashboard → 各模块导航

### 场景描述
从 Dashboard 点击各模块卡片，导航到对应模块页面。

### 测试步骤

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 6.1 | 点击 MPC 卡片 | 展开 MPC 模块详情（注册/恢复/Agent Wallet） |
| 6.2 | 点击 WaaS 卡片 | 展开 WaaS 模块（租户列表/地址分配/归集） |
| 6.3 | 点击 Vault 卡片 | 展开 Vault 模块（Safe 列表/创建多签） |
| 6.4 | 点击 Data Center 卡片 | 展开 DC 模块（套餐/API Key/事件查询） |

### 涉及代码
- `projects/web/modules/nc-wallet.js` — 卡片点击事件
- `projects/web/modules/mpc-wallet.js` — MPC 展开内容
- `projects/web/modules/waas.js` — WaaS 展开内容
- `projects/web/modules/safe.js` — Vault/Safe 展开内容
- `projects/web/modules/datacenter.js` — DC 展开内容

### 验证点
- [ ] 4 个卡片均可点击展开/收起
- [ ] 展开后调用对应的 API 获取最新数据
- [ ] 收起后不重复请求
- [ ] 模块间切换不丢失状态

---

## 场景 7: 页面刷新 — 会话持久化

### 场景描述
用户刷新页面后，dashboard 状态通过 `localStorage` 恢复，无需重新连接钱包。

### 测试步骤

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 7.1 | Dashboard 已连接 + MPC 已注册 | 当前状态正常 |
| 7.2 | 刷新页面 (F5) | `checkSession()` 检查 localStorage |
| 7.3 | `walletAddress` 存在 | 直接调用 `getMe()` |
| 7.4 | Dashboard 恢复 | 4 卡片状态与刷新前一致 |

### 验证点
- [ ] 刷新后不跳转 `connect.html`
- [ ] `getMe()` 重新调用（非缓存）
- [ ] 4 卡片状态正确
- [ ] 无 JS console error

---

## 场景 8: 会话过期 — 重连流程

### 场景描述
用户关闭浏览器后重新打开，或 `localStorage` 被清除。

### 测试步骤

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 8.1 | 清除 `localStorage` | 所有本地状态丢失 |
| 8.2 | 访问 `index.html` | `checkSession()` 未找到 `walletAddress` |
| 8.3 | 自动跳转 `connect.html` | 引导重新连接钱包 |
| 8.4 | 重新连接钱包 | MetaMask 注入 → 连接成功 |
| 8.5 | 跳转 Dashboard | `getMe()` 调用 → MPC 状态为 "Registered" (后端状态保留) |

### 验证点
- [ ] 无 `localStorage` 时正确跳转 `connect.html`
- [ ] 重新连接后 MPC/Vault/WAAS/DC 状态恢复
- [ ] 重新连接不需要重新注册 MPC

---

## 场景 9: 多浏览器/多设备

### 场景描述
同一钱包地址从不同的浏览器或设备访问。

### 测试步骤

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 9.1 | 浏览器 A 登录钱包 `0x2bA20...` | Dashboard 正常 |
| 9.2 | 浏览器 B 同样连接 `0x2bA20...` | Dashboard 显示同样数据（后端数据一致） |
| 9.3 | 浏览器 A 注册 MPC | 浏览器 B 刷新后也看到 MPC Active |
| 9.4 | 浏览器 A 创建 Safe | 浏览器 B 刷新后 Safe 列表更新 |

### 验证点
- [ ] 同一钱包多设备数据一致
- [ ] 后端为数据唯一真实来源（非 localStorage）

---

## 场景 10: Landing → Dashboard 完整闭环

### 场景描述
从全新用户视角走完整闭环，验证每个步骤的集成。

### 完整流程

```
新用户打开 landing.html
  → 浏览产品介绍
  → 点击 "Connect Wallet"
  → 跳转 connect.html
  → MetaMask Mock Provider 注入
  → 连接钱包成功
  → localStorage 写入 walletAddress
  → 跳转 index.html (Dashboard)
  → checkSession() 检测到 walletAddress
  → getMe() 并行查询 4 个 API
  → Dashboard 渲染 4 张卡片
      ├── MPC: "Not Registered" → 点击 Register → sendCode → register → "Active"
      ├── WaaS: "Inactive" (未创建租户)
      ├── Vault: "Inactive" (无 Safe)
      └── Data Center: "Free Plan, 0/10000"
  → 刷新页面 → Dashboard 状态保持
  → 清除 localStorage → 重连 → MPC 状态恢复 (后端保持)
```

### 涉及端口
| 服务 | 端口 | 作用 |
|------|------|------|
| Web Proxy | 9111 | 静态文件 + API 代理 |
| MPC | 9104 | 验证码/注册/恢复 |
| WAAS | 9109 | 租户/钱包状态 |
| Vault | 9107 | Safe 列表查询 |
| DC | 9102 | 套餐/用量查询 |

### 验证点
- [ ] 全流程 8 步无中断
- [ ] 所有 API 返回 `code: 0`
- [ ] Dashboard 状态正确反映后端数据
- [ ] 无 JS console error
- [ ] 安全头全部设置

---

## 负面 & 边界场景汇总

| 编号 | 场景 | 预期结果 |
|------|------|---------|
| N1 | `landing.html` 不存在 → 404 | Web Proxy 返回静态 404 页面 |
| N2 | `connect.html` 无 `window.ethereum` | 显示 "Please install MetaMask" |
| N3 | 用户拒绝 MetaMask 连接 | 停留在 `connect.html`，显示 "Connection rejected" |
| N4 | MPC send-code 邮箱格式错误 `notanemail` | `{ code: 400, message: "Invalid email format" }` |
| N5 | MPC register 错误验证码 | `{ code: 400, message: "Invalid verification code" }` |
| N6 | MPC register 重复邮箱 | `{ code: 400, message: "Wallet already registered" }` |
| N7 | MPC recover 未注册邮箱 | `{ code: 400, message: "Wallet not found" }` |
| N8 | Dashboard getMe() 任一 API 500 | 该卡片显示 "Error"，其他卡片正常 |
| N9 | Web Proxy 超时 (15s) | 返回 `{ error: "upstream timeout", endpoint: "/api/..." }` |

---

## 测试通过标准

| 类别 | 标准 |
|------|------|
| API 响应 | 所有端点返回 HTTP 200, `code: 0` |
| 前端 UI | Dashboard 4 卡片正确渲染 |
| 安全头 | HSTS / X-Frame-Options / nosniff 到位 |
| 错误处理 | 9 个负面场景全部按预期返回 |
| 会话持久化 | localStorage 恢复流程正常 |
| 多设备 | 同一钱包数据一致 |

---

> **下一文档**: P2 — REST API 全链路测试 (80+ 端点)
