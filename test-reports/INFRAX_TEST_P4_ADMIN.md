# InfraX 端到端全场景测试文档 — P4: Admin 管理后台

> v0.3.3-20260720 | 生产 `43.156.99.215` | 文档版本 v1.0

## 概述

以**平台管理员**视角验证 InfraX Admin 管理后台全链路：
```
Admin 登录 → 12 服务监控 → 租户管理 → 交易审计 → 收益报表
```
覆盖 **Admin 面板全部功能模块**。

### 参考文档
- `README.md` §6 Dashboard — Admin 面板架构
- `DEPLOYMENT.md` — 12 服务端口、systemd 管理、管理员登录
- `projects/web/admin.html` — Admin 面板入口
- `projects/web/modules/admin.js` — Admin JS 模块

---

## 场景 1: Admin 登录

### 1.1 访问 Admin 面板
| 步骤 | 操作 | 预期 |
|------|------|------|
| 1.1a | 浏览器打开 `http://43.156.99.215:9111/admin.html` | 显示 Admin 登录界面 |
| 1.1b | 检查登录表单 | 包含用户名/密码输入框 + Login 按钮 |
| 1.1c | 直接访问 `admin.html` → 无 token | 重定向到登录表单 |

### 1.2 登录认证
| 步骤 | 操作 | 预期 |
|------|------|------|
| 1.2a | 输入错误密码 | `401 { message: "Invalid credentials" }` |
| 1.2b | 输入正确凭据 `admin / admin123` | `200 { token: "jwt-admin-...", role: "admin" }` |
| 1.2c | JWT 存入 `localStorage.adminToken` | 自动跳转 Admin Dashboard |
| 1.2d | Token 过期后访问 | 401 → 重定向登录页 |

### 1.3 会话管理
| 步骤 | 操作 | 预期 |
|------|------|------|
| 1.3a | 刷新页面 | token 有效 → 停留在 Dashboard |
| 1.3b | 清除 `localStorage.adminToken` | 重定向登录页 |
| 1.3c | 会话 12h 后过期 | `401 { message: "Session expired, please login again" }` |

### 常见问题定位
| 问题 | 排查 | 解决 |
|------|------|------|
| 数据库密码丢失 | 检查 `DEPLOYMENT.md` §环境变量 | 替换 `.env` 对应 key→重启 systemd |
| nginx 配置错误 | `nginx -t` 检测语法 | 修复后 `systemctl reload nginx` |
| wallet balance 不更新 | systemd status 检查进程 | `systemctl restart infrax-waas` |

### 验证点
- [ ] `admin.html` 正常加载
- [ ] 正确凭据 → JWT → Dashboard
- [ ] 错误凭据 → 清晰错误提示
- [ ] Token 过期重定向正确

---

## 场景 2: Dashboard — 12 服务监控

### 2.1 服务状态面板

Admin Dashboard 展示 12 个 systemd 服务的运行状态。

| # | 服务 | systemd unit | 端口 | 卡片内容 |
|---|------|------|:---:|------|
| 1 | Web Proxy | `infrax-web` | 9111 | 在线用户数, QPS |
| 2 | DC (Data Center) | `infrax-dc` | 9102 | 扫描链数, 事件总量 |
| 3 | Scanner | `infrax-scanner` | 9103 | 最新区块, 落后 |
| 4 | MPC | `infrax-mpc` | 9104 | 注册量, 签名量/天 |
| 5 | Account | `infrax-account` | 9105 | 用户总量 |
| 6 | Security | `infrax-security` | 9106 | 审计量, 风险告警 |
| 7 | Vault | `infrax-vault` | 9107 | Safe 数量, TVL |
| 8 | Notification | `infrax-notification` | 9108 | 通知量/天 |
| 9 | WAAS | `infrax-waas` | 9109 | 租户数, 托管地址数 |
| 10 | Payment | `infrax-payment` | 9110 | 订单量, 日流水 |
| 11 | Collector | `infrax-collector` | 31210 | 采集速率 (events/s) |
| 12 | Collector (DEPRECATED) | — | 30201 | (DEPRECATED, 已下线) |

### 测试验证

| 步骤 | 操作 | 预期 |
|------|------|------|
| 2.1a | Dashboard 加载 | 12 张服务卡片全部渲染 |
| 2.1b | 绿色状态 (Running) | 所有服务 status = "running" |
| 2.1c | 点击任意卡片 | 展开详情 (端口/CPU/内存/日志) |
| 2.1d | 模拟 MPC 宕机 `systemctl stop infrax-mpc` | MPC 卡片变红 "stopped" |
| 2.1e | `systemctl start infrax-mpc` | 恢复绿色 "running" |
| 2.1f | 点击 Restart | `POST /api/admin/services/mpc/restart` → 服务重启 |

### API 端点

```
GET  /api/admin/dashboard              → 12 服务状态汇总
GET  /api/admin/services/:name         → 单服务详情 (CPU/内存/uptime)
POST /api/admin/services/:name/restart → 重启服务
GET  /api/admin/services/:name/logs?lines=100 → 服务日志
```

### 验证点
- [ ] 12 张卡片状态正确 (11 running + 0 stopped)
- [ ] 服务停止/恢复 → 卡片状态实时更新
- [ ] 展开详情所有字段正确
- [ ] 服务日志可查看（可复制）
- [ ] `DEPRECATED` Collector 服务不在仪表盘显示

---

## 场景 3: 租户管理

### 3.1 租户列表

| 步骤 | 操作 | 预期 |
|------|------|------|
| 3.1a | 导航到 "Tenants" 页面 | 租户列表表格 |
| 3.1b | 查看列 | ID / Name / Owner / Plan / Status / Created |
| 3.1c | 搜索 "MyApp" | 过滤结果 |
| 3.1d | 分页 (page=2) | 正确翻页 |

### 3.2 租户详情

| 步骤 | 操作 | 预期 |
|------|------|------|
| 3.2a | 点击租户 ID | 跳转详情页 |
| 3.2b | 基本信息 | Name, Owner Address, Plan, Created |
| 3.2c | 托管钱包列表 | 所有 depositAddress + 余额 |
| 3.2d | API Key 列表 | prefix + createdAt + lastUsed |
| 3.2e | 操作日志 | 创建/激活/归集/Key 轮换 |
| 3.2f | 冻结租户 → Confirm | `PUT /api/admin/tenants/:id` `{ status: "frozen" }` |
| 3.2g | 解冻租户 | `{ status: "active" }` |

### 3.3 API Key 管理

| 步骤 | 操作 | 预期 |
|------|------|------|
| 3.3a | Revoke API Key | `DELETE /api/admin/tenants/:id/apikeys/:key` → Key 立即失效 |
| 3.3b | 失效 Key 的请求 | `401 { message: "API key revoked" }` |

### 验证点
- [ ] 租户列表分页正确
- [ ] 搜索过滤生效
- [ ] 冻结/解冻生效
- [ ] API Key 吊销实时生效
- [ ] 操作日志完整

---

## 场景 4: MPC 钱包管理

### 4.1 MPC 钱包列表

| 步骤 | 操作 | 预期 |
|------|------|------|
| 4.1a | 导航到 "MPC Wallets" | 表格: Address / Email / Status / Transactions |
| 4.1b | 搜索地址 `0xcaCD...` | 精确匹配 |

### 4.2 MPC 钱包详情

| 步骤 | 操作 | 预期 |
|------|------|------|
| 4.2a | 点击地址 | 详情: 余额 + ERC20 holdings + 每日限额 + 已用限额 |
| 4.2b | 交易历史 (page=1) | `{ total, txs: [...] }` |
| 4.2c | 修改限额 | `PUT /api/admin/mpc/:address/limit` `{ dailyLimit: "..." }` |

### 4.3 安全事件

| 步骤 | 操作 | 预期 |
|------|------|------|
| 4.3a | 导航 "Security Events" | 超额转账/签名/合约交互的安全日志 |
| 4.3b | 按时间/地址/事件类型过滤 | 筛选正确 |

### API 端点

```
GET  /api/admin/mpc/wallets?page=1&size=20
GET  /api/admin/mpc/wallets/:address
PUT  /api/admin/mpc/wallets/:address/limit
GET  /api/admin/mpc/events?type=failed&page=1
```

### 验证点
- [ ] MPC 钱包列表正确
- [ ] 单钱包详情的余额/限额正确
- [ ] 限额修改生效
- [ ] 安全事件日志完整

---

## 场景 5: Vault 多签管理

| 步骤 | 操作 | 预期 |
|------|------|------|
| 5.1a | Safe 列表 | Safe Address / Owners / Threshold / TVL / Chain |
| 5.1b | Safe 详情 | 所有提案 (pending/confirmed/executed) + 签名记录 |
| 5.1c | 搜索 Safe `0xSAFE...` | 精确匹配 |
| 5.1d | Pending TX 列表 | 所有待签名/待执行的交易 |

---

## 场景 6: 交易审计

### 6.1 交易列表

| 步骤 | 操作 | 预期 |
|------|------|------|
| 6.1a | 导航 "Transactions" | 全平台交易列表 |
| 6.1b | 筛选: 模块=MPC, 链=sepolia | 只显示 MPC 的 Sepolia 交易 |
| 6.1c | 筛选: 状态=failed | 显示失败交易 |
| 6.1d | 按时间排序 | 最新在前 |

### 6.2 单笔交易详情

| 步骤 | 操作 | 预期 |
|------|------|------|
| 6.2a | 点击 txHash | From / To / Amount / Gas / Status / 模块来源 |

### API 端点

```
GET /api/admin/txs?module=mpc&chain=sepolia&page=1&size=50
GET /api/admin/txs/:txHash
```

---

## 场景 7: Payment 收益报表

### 7.1 收益 Dashboard

| 步骤 | 操作 | 预期 |
|------|------|------|
| 7.1a | 导航 "Revenue" | 今日 / 本周 / 本月 收益卡片 |
| 7.1b | 收益折线图 | 近 30 天趋势 |
| 7.1c | 按套餐分类 | Free / Pro / Enterprise 占比 |

### 7.2 订单列表

| 步骤 | 操作 | 预期 |
|------|------|------|
| 7.2a | 订单表格 | OrderID / Tenant / Plan / Amount / Status / Time |
| 7.2b | 筛选 paid 状态 | 过滤已支付 |
| 7.2c | 导出 CSV | `GET /api/admin/revenue/export?format=csv` |

### 验证点
- [ ] 收益数字与 DB 聚合一致
- [ ] 折线图数据正确
- [ ] CSV 导出格式正确

---

## 场景 8: 系统配置

| 步骤 | 操作 | 预期 |
|------|------|------|
| 8.1a | 导航 "Settings" | 系统配置编辑页 |
| 8.1b | 编辑限流参数 | `{ mpc: { rateLimit: 100/min } }` |
| 8.1c | 编辑 MPC 全局限额 | `{ mpc: { globalDailyLimit: "10 ETH" } }` |
| 8.1d | 编辑 DC 套餐价格 | `{ plans: [{ id: "pro", price: "0.1 ETH/month" }] }` |
| 8.1e | Save + 确认 | `200 updated` → 立即生效 |

### API 端点

```
GET  /api/admin/settings
PUT  /api/admin/settings
     Body: { mpc: { rateLimit: 100, globalDailyLimit: "10" }, ... }
```

---

## 场景 9: 操作日志 (Audit Trail)

| 步骤 | 操作 | 预期 |
|------|------|------|
| 9.1a | 导航 "Audit Log" | 管理员操作日志 |
| 9.1b | 看到自己的操作 | tenant freeze/restart service/settings change 全部记录 |
| 9.1c | 筛选操作类型 | restart / freeze / updateSettings |
| 9.1d | 按时间/操作者过滤 | 正确 |

### 验证点
- [ ] 本次测试所有管理员操作全部被记录
- [ ] IP 地址 / 时间戳 / 操作类型 / 详情 字段完整
- [ ] 不可删除（audit trail 完整性）

---

## 场景 10: Admin 完整闭环

```
Admin 登录 admin.html
  → 输入凭据 admin / admin123
  → 获取 JWT → Dashboard
  → 12 服务状态 全部 green ✓
  → MPC 服务: 注册量/签名量/限额 OK
  → WAAS 服务: 租户数/托管地址 OK
  → Vault 服务: Safe 数量/TVL OK
  → DC 服务: 扫描链/事件/checkpoint OK
  → 租户管理: 查看列表 → 详情 → 冻结/解冻
  → 交易审计: 筛选 → 查看详情
  → Payment 收益: 查看仪表盘
  → 系统配置: 修改 → 保存 → 验证生效
  → 操作日志: 确认所有操作已记录
```

### 验证点
- [ ] 全流程无断点
- [ ] 所有状态实时反映后端数据
- [ ] 权限：非 admin 无法访问
- [ ] Audit trail 完整

---

## 负面与边界场景

| # | 场景 | 预期 |
|---|------|------|
| N1 | 未登录访问 admin.html | 重定向登录页 |
| N2 | 过期 token | 401 → 登录页 |
| N3 | 普通用户 token 访问 admin API | `403 { message: "Admin only" }` |
| N4 | 重启不存在的服务 | `404` |
| N5 | 冻结已冻结的租户 | `400 { message: "Already frozen" }` |
| N6 | 修改配置无效值 (负限额) | `400 { message: "Invalid value" }` |
| N7 | 长时间不操作 → token 12h 过期 | 自动登出 |
| N8 | systemd 服务崩溃 | 卡片变红 → 可手动 Restart |

### 测试通过标准

| 类别 | 标准 |
|------|------|
| 认证 | Admin 登录 + JWT 过期机制正确 |
| 服务监控 | 12 服务状态实时同步 |
| 租户管理 | CRUD + 冻结/解冻全生命周期 |
| 交易审计 | 全量查询 + 筛选正确 |
| 收益 | 折线图数据与 DB 一致 |
| 配置 | 修改→保存→生效闭环 |
| 审计 | 所有管理员操作被记录且不可删除 |
| 权限 | 非 admin 无法访问 |

---

> **下一文档**: P5 — MPC Agent Wallet 深度测试
