# InfraX 端到端全场景测试文档 — P7: 用户操作端到端（Browser E2E）

> v0.3.3-20260720 | 生产 `43.156.99.215:9111` | 文档版本 v1.0

## 概述

**用真实的浏览器自动化操作**完成完整的用户旅程测试。所有步骤通过 `browser_user_flow` 工具自动执行，模拟用户在浏览器中的实际行为：点击、输入、等待、观察。

区别于 P1-P6（API 视角），P7 是 **User Journey** 视角——用户看到什么、点到什么、页面跳转到哪里。

---

## Journey 1: 全新用户入驻 — Landing → Wallet → MPC → Dashboard

### 用户身份
- 全新用户，无任何 InfraX 记录
- 浏览器已安装 MetaMask
- 目标：5 分钟内完成入驻

### 自动化测试步骤

```
步骤 1: 打开 Landing Page
  操作: navigate to http://43.156.99.215:9111/landing.html
  等待: 页面完整加载 (< 5s)
  验证:
    ✅ 标题包含 "InfraX"
    ✅ 可见 Hero 区域 + 4 功能卡片 (WAAS/Vault/DC/MPC)
    ✅ "Connect Wallet" 按钮可见且可点击
    ✅ 无 console error

步骤 2: 点击 "Connect Wallet"
  操作: click "Connect Wallet" 按钮
  等待: 页面跳转 (< 3s)
  验证:
    ✅ URL 变为 /connect.html
    ✅ 页面显示钱包连接引导
    ✅ 无 JS error

步骤 3: MetaMask 连接
  操作: 注入 Mock window.ethereum → click "MetaMask" → 确认连接
  等待: 钱包连接完成 (< 5s)
  验证:
    ✅ 显示钱包地址 "0x2bA20..."
    ✅ 自动跳转到 /index.html (Dashboard)
    ✅ localStorage 写入 walletAddress

步骤 4: Dashboard 加载
  操作: 等待 Dashboard 渲染
  验证:
    ✅ 4 张模块卡片全部可见 (MPC / WaaS / Vault / Data Center)
    ✅ MPC 卡片显示 "Not Registered"
    ✅ WaaS 卡片显示 "No Tenants"
    ✅ 无任何 API 报错 (F12 Network 200)

步骤 5: 注册 MPC 钱包
  操作: click MPC 卡片 → 展开详情
  验证: 展开区域显示 "Register" 按钮 + 说明文案
  操作: click "Register" 按钮
  验证: 弹出模态框 → 邮箱输入框 + "Send Code" 按钮
  操作: type email "agent@infrax.io" → click "Send Code"
  等待: 按钮变为 "Resend (60s)" 倒计时
  验证:
    ✅ 验证码输入框出现
    ✅ 控制台无 network error
  操作: type code "123456" → click "Register"
  等待: 注册完成 (< 3s)
  验证:
    ✅ 模态框关闭
    ✅ MPC 卡片变为 "Active" + 显示 MPC 地址
    ✅ 地址格式 0x... (42 字符)

步骤 6: 查看 MPC 余额
  操作: click MPC 卡片 → 查看余额
  验证:
    ✅ 显示 Sepolia ETH 余额
    ✅ 显示 ERC20 token 列表（如有）

步骤 7: 刷新页面 — 会话持久化
  操作: navigate (reload) /index.html
  等待: Dashboard 重新加载
  验证:
    ✅ 不跳转 connect.html（localStorage 有效）
    ✅ MPC 卡片仍显示 "Active" + 相同地址
    ✅ getMe() API 调用返回 200

步骤 8: 清除 localStorage — 过期重连
  操作: 清除 localStorage.walletAddress → reload
  验证:
    ✅ 自动跳转到 connect.html
  操作: 重新连接钱包
  验证:
    ✅ 跳转 Dashboard
    ✅ MPC 状态恢复 "Active"（后端数据不丢）
```

### user_flow JSON
```json
{
  "url": "http://43.156.99.215:9111/landing.html",
  "steps": [
    {"action": "navigate", "url": "http://43.156.99.215:9111/landing.html"},
    {"action": "wait", "ms": 3000},
    {"action": "check", "text": "InfraX"},
    {"action": "check", "text": "Connect Wallet"},
    {"action": "screenshot", "name": "01-landing"},

    {"action": "click", "selector": "[data-action='connect-wallet'], button:has-text('Connect Wallet')"},
    {"action": "wait", "ms": 2000},
    {"action": "check", "text": "connect"},
    {"action": "screenshot", "name": "02-connect"},

    {"action": "click", "selector": "button:has-text('MetaMask')"},
    {"action": "wait", "ms": 3000},
    {"action": "check", "text": "Dashboard"},
    {"action": "screenshot", "name": "03-dashboard"},

    {"action": "click", "selector": "[data-card='mpc'], .card:has-text('MPC')"},
    {"action": "wait", "ms": 1000},
    {"action": "screenshot", "name": "04-mpc-expanded"},

    {"action": "click", "selector": "button:has-text('Register')"},
    {"action": "wait", "ms": 500},
    {"action": "type", "selector": "input[type='email']", "text": "agent@infrax.io"},
    {"action": "click", "selector": "button:has-text('Send Code')"},
    {"action": "wait", "ms": 2000},
    {"action": "type", "selector": "input[placeholder*='code'], input[placeholder*='验证码']", "text": "123456"},
    {"action": "click", "selector": "button:has-text('Register')"},
    {"action": "wait", "ms": 3000},
    {"action": "check", "text": "Active"},
    {"action": "screenshot", "name": "05-mpc-registered"},

    {"action": "navigate", "url": "http://43.156.99.215:9111/index.html"},
    {"action": "wait", "ms": 3000},
    {"action": "check", "text": "Active"},
    {"action": "screenshot", "name": "06-after-reload"}
  ]
}
```

---

## Journey 2: 开发者创建 WaaS 租户 → 分配地址 → 归集

### 用户身份
- 已入驻开发者（钱包已连接）
- 目标：为 DApp 接入 WaaS 托管

### 自动化测试步骤

```
步骤 1: 进入 Dashboard → 展开 WaaS 卡片
  操作: click "WaaS" 卡片
  验证:
    ✅ 显示 "No Tenants" 或已有租户列表
    ✅ 显示 "Create Tenant" 按钮

步骤 2: 创建租户
  操作: click "Create Tenant"
  验证: 弹出模态框 → Name 输入框
  操作: type "MyDApp" → click "Create"
  等待: 创建完成 (< 2s)
  验证:
    ✅ 租户列表出现 "MyDApp"
    ✅ Status 显示 "inactive"

步骤 3: 激活租户
  操作: click "MyDApp" 行 → 展开详情 → click "Activate"
  等待: 激活完成
  验证:
    ✅ Status 变为 "active"
    ✅ 出现 "Allocate Address" 按钮

步骤 4: 分配存款地址
  操作: click "Allocate Address"
  验证: 弹窗 → Chain 下拉 → Count 输入
  操作: select chain "sepolia" → type count "3"
  操作: click "Allocate"
  等待: 分配完成
  验证:
    ✅ 分配成功提示
    ✅ 地址列表增加 3 个新地址
    ✅ 每个地址格式 0x... (42 字符)

步骤 5: 生成 API Key
  操作: click "Generate API Key"
  验证: 弹窗 → API Key 显示 (sk-...)
  操作: click "Copy" → 验证剪贴板
  操作: click "Close"

步骤 6: 查看详情确认
  操作: 返回租户列表 → 确认 MyDApp 各项数据:
    ✅ Tenants: 1
    ✅ Addresses: 3 (sepolia)
    ✅ API Keys: 1
    ✅ Status: active

步骤 7: 归集资金
  前提: 需要先给某个地址充值（手动或通过 Payment J3 完成）
  操作: click "Sweep" → select chain "sepolia" → confirm
  等待: 归集交易确认
  验证:
    ✅ 显示 txHash
    ✅ 地址余额归零
    ✅ 热钱包余额增加
```

### user_flow JSON
```json
{
  "url": "http://43.156.99.215:9111/index.html",
  "steps": [
    {"action": "navigate", "url": "http://43.156.99.215:9111/index.html"},
    {"action": "wait", "ms": 3000},
    {"action": "click", "selector": "[data-card='waas'], .card:has-text('WaaS')"},
    {"action": "wait", "ms": 1000},
    {"action": "screenshot", "name": "waas-initial"},

    {"action": "click", "selector": "button:has-text('Create Tenant')"},
    {"action": "wait", "ms": 500},
    {"action": "type", "selector": "input[name='name'], input[placeholder*='name']", "text": "MyDApp"},
    {"action": "click", "selector": "button:has-text('Create')"},
    {"action": "wait", "ms": 2000},
    {"action": "check", "text": "MyDApp"},
    {"action": "screenshot", "name": "waas-tenant-created"},

    {"action": "click", "selector": "button:has-text('Activate')"},
    {"action": "wait", "ms": 2000},
    {"action": "check", "text": "active"},
    {"action": "screenshot", "name": "waas-tenant-active"},

    {"action": "click", "selector": "button:has-text('Allocate')"},
    {"action": "wait", "ms": 500},
    {"action": "type", "selector": "input[name='count']", "text": "3"},
    {"action": "click", "selector": "button:has-text('Allocate')"},
    {"action": "wait", "ms": 3000},
    {"action": "check", "text": "0x"},
    {"action": "screenshot", "name": "waas-addresses"},

    {"action": "click", "selector": "button:has-text('Generate API Key')"},
    {"action": "wait", "ms": 1000},
    {"action": "check", "text": "sk-"},
    {"action": "click", "selector": "button:has-text('Close')"},
    {"action": "screenshot", "name": "waas-final"}
  ]
}
```

---

## Journey 3: 开发者接入 Payment → 完成充值

### 用户身份
- 已有 WaaS 租户的开发者
- 目标：为 Pro 套餐完成充值

### 自动化测试步骤

```
步骤 1: 进入 Data Center → 套餐页面
  操作: click "Data Center" 卡片 → click "Plans"
  验证:
    ✅ 显示 Free / Pro / Enterprise 三个套餐
    ✅ Pro 显示价格 "0.1 ETH/month"

步骤 2: 选择 Pro 套餐
  操作: click "Upgrade" on Pro 卡片
  验证:
    ✅ 弹出支付确认框 → orderId + paymentAddress
    ✅ 提示 "Send 0.1 ETH to 0x..."

步骤 3: 支付 (模拟 — 通过 MPC 转账)
  操作: (切换到 MPC tab) → click "Send" → type amount "0.1" → type to "paymentAddress"
  操作: click "Send Transaction" → 等待确认
  验证:
    ✅ txHash 显示
    ✅ 返回 Payment 页面 → status 刷新为 "paid"

步骤 4: 验证升级
  操作: click "My Plan"
  验证:
    ✅ 当前套餐: Pro
    ✅ 月配额: 100,000（或 Pro 对应配额）
    ✅ Usage 显示用量
```

---

## Journey 4: 用户创建多签 Safe → 签名 → 执行 (2/3 多签)

### 用户身份
- 已注册 MPC 的用户（Owner A, B, C 分别连接）
- 目标：创建 2/3 Safe 并发起一笔多签转账

### 自动化测试步骤

```
步骤 1: Owner A 创建 Safe
  用户: Owner A (MPC 钱包 0x2bA20...)
  操作: click "Vault" 卡片 → click "Create Safe"
  操作: type owners "0xAAA, 0xBBB, 0xCCC"
  操作: select threshold "2"
  操作: select chain "sepolia"
  操作: click "Create"
  等待: Safe 部署确认 (< 15s)
  验证:
    ✅ 显示 Safe 地址 0xSAFE...
    ✅ owners count = 3, threshold = 2
    ✅ balance = 0

步骤 2: 向 Safe 充值
  操作: MPC → send 0.1 ETH to 0xSAFE...
  验证:
    ✅ txHash 显示
    ✅ Vault Safe 详情 balance = 0.1 ETH

步骤 3: Owner A 创建转账提案
  操作: click "Propose" → type to "0xRECIPIENT" → type amount "0.05"
  操作: click "Submit Proposal"
  验证:
    ✅ safeTxHash 显示
    ✅ 签名人数: 0/2

步骤 4: Owner A 签名
  操作: click "Confirm" (当前用户签名)
  验证:
    ✅ 签名人数: 1/2
    ✅ 提示 "Needs 1 more confirmation"

步骤 5: Owner B 连接并签名
  操作: (模拟切换用户) → 清除 localStorage → 连接 Owner B 钱包
  操作: navigate to Vault Safe 页面
  操作: 看到同一条 pending proposal → click "Confirm"
  验证:
    ✅ 签名人数: 2/2
    ✅ 出现 "Execute" 按钮变绿

步骤 6: Owner A (或 B) 执行
  操作: click "Execute"
  等待: 交易确认
  验证:
    ✅ 显示 chainTxHash
    ✅ status: "executed"
    ✅ Safe balance: 0.05 ETH
```

### user_flow JSON (Owner A 部分)
```json
{
  "url": "http://43.156.99.215:9111/index.html",
  "steps": [
    {"action": "navigate", "url": "http://43.156.99.215:9111/index.html"},
    {"action": "wait", "ms": 3000},
    {"action": "click", "selector": "[data-card='vault'], .card:has-text('Vault')"},
    {"action": "wait", "ms": 1000},
    {"action": "screenshot", "name": "vault-before"},

    {"action": "click", "selector": "button:has-text('Create Safe')"},
    {"action": "wait", "ms": 500},
    {"action": "type", "selector": "input[name='owners'], textarea[name='owners']", "text": "0xAAA,0xBBB,0xCCC"},
    {"action": "type", "selector": "input[name='threshold']", "text": "2"},
    {"action": "click", "selector": "button:has-text('Create')"},
    {"action": "wait", "ms": 15000},
    {"action": "check", "text": "0x"},
    {"action": "screenshot", "name": "vault-safe-created"},

    {"action": "click", "selector": "button:has-text('Propose')"},
    {"action": "wait", "ms": 500},
    {"action": "type", "selector": "input[name='to']", "text": "0xRECIPIENT"},
    {"action": "type", "selector": "input[name='amount']", "text": "0.05"},
    {"action": "click", "selector": "button:has-text('Submit')"},
    {"action": "wait", "ms": 3000},
    {"action": "check", "text": "safeTxHash"},
    {"action": "screenshot", "name": "vault-proposal-submitted"},

    {"action": "click", "selector": "button:has-text('Confirm')"},
    {"action": "wait", "ms": 2000},
    {"action": "check", "text": "1/2"},
    {"action": "screenshot", "name": "vault-signed-1of2"},

    {"action": "click", "selector": "button:has-text('Execute')"},
    {"action": "wait", "ms": 10000},
    {"action": "check", "text": "executed"},
    {"action": "screenshot", "name": "vault-executed"}
  ]
}
```

---

## Journey 5: Admin 全平台管理

### 用户身份
- 平台管理员（admin / admin123）
- 目标：监控 12 服务 → 管理租户 → 审计

### 自动化测试步骤

```
步骤 1: Admin 登录
  操作: navigate to http://43.156.99.215:9111/admin.html
  验证: 显示登录表单 → username + password 输入框
  操作: type username "admin" → type password "admin123" → click "Login"
  等待: 登录成功
  验证:
    ✅ 跳转 Admin Dashboard
    ✅ 12 张服务卡片全部显示

步骤 2: Dashboard 检查
  操作: 等待所有卡片渲染
  验证:
    ✅ Web Proxy / DC / Scanner / MPC / Account / Security
    ✅ Vault / Notification / WAAS / Payment / Collector
    ✅ 每个卡片 status = "running" (绿色)
    ✅ 卡片显示关键指标 (QPS/区块号/用户数/交易量)

步骤 3: 租户管理 — 搜索 + 冻结
  操作: click "Tenants" 导航
  操作: type search "MyDApp"
  验证: 列表过滤只显示 "MyDApp"
  操作: click "Freeze" → confirm
  验证: Status 变为 "frozen"
  操作: 尝试用该租户 API Key 调 API
  验证: 401 返回

步骤 4: 查看交易
  操作: click "Transactions" 导航
  操作: 筛选 module=MPC, chain=sepolia
  验证:
    ✅ 列表显示所有 MPC 交易
    ✅ 包含刚才 J1 MPC 注册、J2 Sweep、J4 Safe 转账

步骤 5: 操作日志
  操作: click "Audit Log"
  验证:
    ✅ 本次 Admin 操作被记录: login / freeze tenant / view txs
    ✅ 每条含 IP / 时间 / 操作 / 详情

步骤 6: 登出
  操作: click "Logout"
  验证:
    ✅ 跳转登录页
    ✅ adminToken 从 localStorage 清除
    ✅ 直接访问 admin.html → 跳转登录页
```

### user_flow JSON
```json
{
  "url": "http://43.156.99.215:9111/admin.html",
  "steps": [
    {"action": "navigate", "url": "http://43.156.99.215:9111/admin.html"},
    {"action": "wait", "ms": 2000},
    {"action": "check", "text": "Login"},
    {"action": "type", "selector": "input[name='username']", "text": "admin"},
    {"action": "type", "selector": "input[name='password']", "text": "admin123"},
    {"action": "click", "selector": "button[type='submit'], button:has-text('Login')"},
    {"action": "wait", "ms": 3000},
    {"action": "check", "text": "Dashboard"},
    {"action": "screenshot", "name": "admin-login"},
    {"action": "screenshot", "name": "admin-dashboard"},

    {"action": "click", "selector": "a:has-text('Tenants'), [data-nav='tenants']"},
    {"action": "wait", "ms": 1000},
    {"action": "type", "selector": "input[placeholder*='search'], input[name='search']", "text": "MyDApp"},
    {"action": "wait", "ms": 500},
    {"action": "check", "text": "MyDApp"},
    {"action": "screenshot", "name": "admin-tenants"},

    {"action": "click", "selector": "a:has-text('Transactions'), [data-nav='transactions']"},
    {"action": "wait", "ms": 1000},
    {"action": "screenshot", "name": "admin-transactions"},

    {"action": "click", "selector": "a:has-text('Audit Log'), [data-nav='audit']"},
    {"action": "wait", "ms": 1000},
    {"action": "screenshot", "name": "admin-audit"},

    {"action": "click", "selector": "button:has-text('Logout')"},
    {"action": "wait", "ms": 1000},
    {"action": "check", "text": "Login"},
    {"action": "screenshot", "name": "admin-logout"}
  ]
}
```

---

## Journey 6: 完整用户日 (端到端闭环)

### 用户身份
- **同一个 MPC 钱包身份**贯穿全天
- 目标：从 0 到完成所有 InfraX 核心操作

### 自动化测试步骤（一条链跑到底）

```
═══════════ 上午 9:00 — 入驻 ═══════════

1. landing.html → 阅读产品介绍
2. Connect Wallet → MetaMask 连接
3. Dashboard → 看到全部功能
4. MPC Register → 输入邮箱 → 验证码 → 注册成功
5. 查看 MPC 余额 → 0 ETH（新钱包）
6. 充值 0.5 ETH (手动 faucet 或链上转账)

═══════════ 上午 10:00 — WaaS + Payment ═══════════

7. WaaS → Create Tenant "MyDApp" → Activate
8. Allocate 3 addresses (sepolia)
9. Generate API Key → 复制保存
10. Payment → 选择 Pro Plan → 用 MPC 转账 0.1 ETH → 支付成功
11. DC → 查看套餐已升级为 Pro

═══════════ 下午 2:00 — Vault 多签 ═══════════

12. Vault → Create Safe (2/3, Owners: MPC + 2 测试地址)
13. Safe 部署完成 → 查看详情
14. MPC → 向 Safe 转 0.2 ETH
15. Safe balance: 0.2 ETH ✓
16. Propose 转账 0.1 ETH → 提案创建
17. Confirm (Owner A: MPC 签名)
18. Confirm (Owner B: 切换钱包签名)
19. Execute → 0.1 ETH 转账上链

═══════════ 下午 4:00 — 数据订阅 ═══════════

20. DC → 创建事件订阅 (sepolia Transfer)
21. 用 MPC 发起一笔测试转账 (触发 Transfer 事件)
22. DC → webhook 收到推送 → Usage +1

═══════════ 下午 5:00 — 锁定 ═══════════

23. MPC → Unlock → Lock（测试 session token 生命周期）
24. Safe → 同步链上状态 → balance 更新
25. WaaS → 查看所有地址余额
26. Dashboard → 刷新 → 确认所有状态持久化

═══════════ 结束 ═══════════

验证:
  ✅ 所有操作在同一个钱包地址下完成
  ✅ 无 401/500 错误
  ✅ 每步截图可追溯
  ✅ Admin 端可看到完整操作日志
  ✅ 链上交易可验证
```

### 成功判定

| 阶段 | 判定标准 |
|------|------|
| 入驻 | Landing → Connect → MPC Register → Dashboard 无报错 |
| WaaS | Tenant create → Address allocate → API Key → 全部可操作 |
| Payment | Create order → MPC pay → status paid |
| Vault | Safe create → propose → confirm x2 → execute 上链 |
| DC | Subscribe → event push webhook → usage count |
| Session | Unlock → 操作 → Lock → 过期不可用 |
| 全局 | Admin 可查看所有用户操作日志 |

---

## 各 Journey 比对

| Journey | 时长(估) | 用户身份 | 核心操作 |
|------|:---:|------|------|
| J1 入驻 | 5 min | 全新用户 | Landing → Wallet → MPC → Dashboard |
| J2 WaaS | 5 min | 开发者 | Tenant → Address → API Key |
| J3 Payment | 3 min | 开发者 | Plans → Order → Pay → Upgrade |
| J4 Vault | 8 min | 用户 | Safe → Propose → Double Sign → Execute |
| J5 Admin | 5 min | 管理员 | Login → Monitor → Tenant → Audit |
| J6 全天 | 25 min | 同一用户 | 入驻→WaaS→Vault→DC→Session 全链路 |

---

## 与 P1-P6 的关系

| P# | 视角 | P7 覆盖 |
|------|------|------|
| P1 入驻+Dashboard | 新用户 API | ✅ J1 完整浏览器操作 |
| P2 REST API | 后端开发者 | J2/J3/J4 对应的前端互动 |
| P3 MCP | AI Agent | （MCP 无 GUI, 不需 P7） |
| P4 Admin | 管理员 API | ✅ J5 完整 Admin 面板操作 |
| P5 MPC 深度 | MPC API | ✅ J1 Step 5 + J6 Session 生命周期 |
| P6 业务模块 | 集成 API | ✅ J2/J3/J4 对应 WaaS/Payment/Vault |

**P7 是 P1-P6 的"用户界面执行层"** — 把 API 调用翻译成真实的浏览器点击/输入/等待/观察。

---

> 📋 **InfraX 7 份测试文档总索引**
>
> | # | 视角 | 场景 | 类型 |
> |---|------|:--:|------|
> | P1 | 新用户入驻 | 10 | API + 操作 |
> | P2 | REST API 全链路 | 10 | 纯 API |
> | P3 | MCP 接入 | 8 | 协议 |
> | P4 | Admin 管理 | 10 | API + 操作 |
> | P5 | MPC 深度 | 9 | API + 操作 |
> | P6 | 业务模块 | 20 | API |
> | **P7** | **真实用户操作** | **6 Journeys** | **纯 Browser E2E** |
> | **合计** | — | **73** | — |
