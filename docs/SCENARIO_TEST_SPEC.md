# InfraX 平台场景测试文档（Scenario Test Specification）

> 版本：2026-08-20 ｜ 适用环境：生产 https://infrax.0xainet.top（43.163.105.172）
> 配套文档：[FEATURE_INVENTORY.md](./FEATURE_INVENTORY.md)（功能清单）
> 用例编号规范：`TC-<模块>-<序号>`，优先级 P0（核心资金/安全）/ P1（重要功能）/ P2（一般）

---

## 一、测试总览

### 1.1 测试目标
1. 验证平台 8 大前端模块 + Admin 控制台 + 10 个后端服务的核心链路可用
2. 覆盖近期上线改进（Safe 审批闭环、Payments 网关、AA 会话、Admin 契约、资金安全）的回归
3. 验证反向代理鉴权注入与统一鉴权契约

### 1.2 环境与前置条件
- 浏览器：Chrome 120+ / MetaMask 插件
- 生产环境：`https://infrax.0xainet.top`
- 测试账户：1 个主钱包（owner）+ 1 个签名钱包（Safe 共签）
- 各服务状态：`systemctl status infrax-web infrax-aa-relay infrax-waas infrax-vault infrax-payments ...` 均为 active
- 数据前置：对应服务 `GET /health` 返回 200

### 1.3 通用校验点（所有用例）
- HTTP 状态码、响应 JSON 结构、错误提示可读
- 前端无 JS 报错（Console 无 `ReferenceError`/`TypeError`）
- 金额数值精度（大数用 string / BigInt 处理）
- 敏感信息不泄露（私钥、完整 API key）

### 1.4 通过准则
- P0 用例 100% 通过；P1 通过率 ≥ 95%；P2 通过率 ≥ 90%

---

## 二、测试矩阵

| 模块 | 核心场景数 | P0 | P1 | P2 |
|---|---|---|---|---|
| A. 认证与连接 | 4 | 3 | 1 | 0 |
| B. 非托管钱包 | 2 | 0 | 1 | 1 |
| C. MPC 钱包 | 5 | 2 | 2 | 1 |
| D. WaaS | 10 | 5 | 4 | 1 |
| E. Safe 多签 | 8 | 5 | 2 | 1 |
| F. 数据中心 | 5 | 1 | 3 | 1 |
| G. AA 会话 | 6 | 4 | 2 | 0 |
| H. Insights | 4 | 0 | 3 | 1 |
| I. Payments 网关 | 8 | 3 | 4 | 1 |
| J. Admin 控制台 | 6 | 1 | 4 | 1 |
| K. 行情采集 | 3 | 0 | 2 | 1 |
| L. 平台/数据服务 | 3 | 0 | 2 | 1 |

---

## 三、A. 认证与连接（connect.html）

### TC-A-001（P0）MetaMask 连接登录
1. 打开 `/connect.html`
2. 点击「Connect MetaMask」→ 授权钱包
3. 弹出签名请求并确认
- **预期**：跳转 `/index.html`；顶部显示钱包地址；`localStorage['px_user']` 已写入；网络请求带 `x-wallet-signature`

### TC-A-002（P0）私钥连接登录
1. 打开 `/connect.html`，点击「Connect with Private Key」
2. 输入测试私钥
- **预期**：签名 `InfraX auth: <ts>` 成功，跳转主应用并显示对应地址

### TC-A-003（P0）未连接访问拦截 / 登出
1. 已登录状态下点击登出（`logout`）
- **预期**：`localStorage` 清空，跳回 `/connect.html`；直接访问 `/index.html` 无数据会话上下文

### TC-A-004（P1）连接失败提示
1. 连接时拒绝签名 / 输入非法私钥
- **预期**：页面展示可读错误信息，按钮恢复原状，无白屏

---

## 四、B. 非托管钱包（index.html → 首屏）

### TC-B-001（P1）服务状态仪表盘
1. 登录后进入首页
- **预期**：各服务（waas/dc/mpc/safe 等）状态卡片渲染，无 JS 报错

### TC-B-002（P2）复制地址
1. 点击复制地址按钮
- **预期**：剪贴板写入，Toast 提示「已复制」

---

## 五、C. MPC 钱包（mpc-wallet.js / :9104）

### TC-C-001（P0）注册激活
1. 切到 MPC 模块 → 注册 Tab → 输入邮箱发送验证码
2. 输入验证码提交
- **预期**：`POST /api/v2/mpc/register` 成功，钱包创建，仪表盘显示地址与余额

### TC-C-002（P0）发送交易
1. 钱包已激活 → 发送 Tab → 输入收款地址与金额 → 提交
- **预期**：`send-transaction` 成功，交易哈希返回；余额正确扣减

### TC-C-003（P1）签名能力（sign-message）
1. 使用 `sign-message` 签名任意消息
- **预期**：返回 65 字节签名，可用 `verifyMessage` 验签通过

### TC-C-004（P1）找回恢复
1. 恢复 Tab → 邮箱验证码 → recover
- **预期**：恢复出同一 MPC 钱包地址，私钥分片重新装配

### TC-C-005（P2）会话锁定
1. `session/lock` 后尝试签名
- **预期**：签名被拒（会话未解锁），`session/unlock` 后恢复

---

## 六、D. WaaS 钱包即服务（waas.js / :9109）

### TC-D-001（P0）订阅激活与 X402 支付
1. WaaS 模块 → 选择计划 → 激活 → 触发 X402 支付 → 轮询
- **预期**：订阅状态 active，`subscription/verify` 通过，概览显示套餐与到期时间

### TC-D-002（P0）地址创建与 Token 列表
1. `waas-dash-addresses` 创建地址；`waas-dash-tokens` 查看/添加 Token
- **预期**：地址生成成功（`/api/v2/saas/address`），Token 列表渲染，自定义 Token 添加生效

### TC-D-003（P0）提现与审批流
1. 发起提现 `POST /api/v2/saas/withdraw`
2. Admin 侧 approve / reject
- **预期**：提现进入 pending → 审批后状态更新；`/api/v2/saas/withdrawals` 可查

### TC-D-004（P0）Sweep 归集
1. 配置归集目标地址（多目标/单地址）→ 保存 → 手动触发
- **预期**：`tx/sweep` 成功，目标地址到账，归集日志记录；定时配置持久化

### TC-D-005（P0）API Key 生命周期
1. 生成 → 列表（不回显完整 key）→ 轮换 → 删除
- **预期**：各步骤状态码 200，旧 key 失效、新 key 可用；列表仅显示掩码

### TC-D-006（P1）TOTP 2FA
1. `totp/setup` 获取二维码 → `enable` → 用验证码登录
- **预期**：2FA 生效后登录需 TOTP；`disable` 后可关闭

### TC-D-007（P1）支付密码
1. 首次设置支付密码 → 状态查询
- **预期**：`set-payment-password` 成功，`payment-password-status` 返回 enabled

### TC-D-008（P1）批量上传执行
1. `batch-upload` 上传批量交易 → `batch-execute` → 查询进度
- **预期**：批量任务创建，`batch/:id/progress` 反映每笔状态

### TC-D-009（P1）风控限额与黑名单
1. `GET /api/v2/risk/limits` 查询；对超限交易发起
- **预期**：限额正确返回（USD 计价）；超限被拒；黑名单地址交易被拦

### TC-D-010（P2）Webhook 事件流
1. 注册 `events/token`，触发事件后 `webhook-events` 查询与重试
- **预期**：事件到达，重试接口幂等（分布式锁防重复）

---

## 七、E. Safe 多签钱包（safe.js / :9107）

### TC-E-001（P0）创建 Safe
1. Safe 模块 → 创建 → 输入 owners（≥2 个，用两个测试钱包）+ threshold=2 → 提交
- **预期**：`POST /api/vault/safe/create` 成功，`owned` 列表出现新 Safe（部署状态正确）

### TC-E-002（P0）提案交易
1. 选定 Safe → 发起提案（收款地址 + 金额）
- **预期**：`safe/propose` 返回 safeTxHash，交易进入 pending，状态「待确认」

### TC-E-003（P0）确认闭环（personal_sign）★回归
1. 交易明细弹窗 → 点击「Confirm」→ MetaMask `personal_sign(safeTxHash)` → 提交
2. 用第二个 owner 再确认一次（达 threshold=2）
- **预期**：
   - 第一次确认：弹窗内 sigCount 1/2，状态更新，无 JS 报错
   - 第二次确认：提示「Threshold met — ready to execute」
   - 确认按钮状态随签名数正确刷新（弹窗不白屏、不丢失）

### TC-E-004（P0）执行交易
1. 达 threshold 后点击「Execute」
- **预期**：`safe/execute` 广播成功，交易 onchain，状态流转 confirmed

### TC-E-005（P0）参与 Safe 列表
1. 用第二个 owner 钱包登录 → Safe 模块
- **预期**：`participating` 列表包含该 Safe，可查看并确认待处理交易

### TC-E-006（P1）明细弹窗数据完整性 ★回归
1. 打开任意交易明细弹窗
- **预期**：owners、签名者列表、金额、状态、safeTxHash 均渲染；`data-safe-addr` 属性存在；关闭后再打开正常

### TC-E-007（P1）Owner 变更
1. `PUT /api/vault/safe/:address/owners` 增删 owner / 调 threshold
- **预期**：变更生效，后续确认按新 threshold 计算

### TC-E-008（P2）同步与重试
1. 调用 `safe/sync` 与 `safe/retry`
- **预期**：链上状态同步，失败交易可重试

---

## 八、F. 数据中心（datacenter.js / :9102）

### TC-F-001（P0）事件订阅支付闭环
1. 订阅计划 → X402 支付 → 轮询 `payment-check` → `verify`
- **预期**：订阅激活，`usage` 配额生效

### TC-F-002（P1）事件查询与分页
1. `GET /api/v2/data/events`（带 pageToken）→ 翻页 → 按分类筛选
- **预期**：事件列表渲染，分页游标正确，`event-stats` 与数据一致

### TC-F-003（P1）我的 API Key 管理 ★回归
1. `my-keys` 创建 → 列表（掩码显示）→ 轮换 → 删除
- **预期**：`POST /api/v2/data/my-keys`（钱包签名鉴权）成功；旧 key 失效

### TC-F-004（P1）用量与余额
1. `GET /api/v2/data/usage`、`/api/v2/data/balance`
- **预期**：数值正确展示，余额随调用扣减

### TC-F-005（P2）文档与链列表
1. `GET /api/v2/data/docs`、`/chains`
- **预期**：返回可用文档与链清单

---

## 九、G. AA 智能账户会话（aa.js / :9131）

### TC-G-001（P0）账户派生 ★回归
1. AA 模块初始化 → `POST /v1/account/derive`
- **预期**：返回 `accountAddress`（counterfactual）+ `isDeployed`，无链上交易

### TC-G-002（P0）会话创建（draft + 签名提交）
1. 选择权限预设 → 生成 draft → 签名 → 提交
- **预期**：会话创建成功，列表出现会话（权限摘要、有效期正确，不回显私钥）

### TC-G-003（P0）会话撤销 ★回归
1. 对已建会话点击撤销 → draft 生成 → 签名 → 广播
- **预期**：`revoke` 成功（签名已注入，无 AA24 InvalidSignature）；会话状态 revoked；链上 nonce 失效

### TC-G-004（P0）会话替换 ★回归
1. 点击「Replace」→ 生成 batch UserOp（uninstall + invalidateNonce + install）→ 签名提交
- **预期**：替换成功，旧会话失效、新会话可用（无 AA23 InvalidNonce）；替换后可复用旧会话密钥链上绑定

### TC-G-005（P1）会话余额与计费
1. `GET /v1/ledger-balance`
- **预期**：余额正确展示，gas 池扣费记录一致

### TC-G-006（P1）链切换
1. 切换链 → 重新派生
- **预期**：按链缓存账户地址（`px_aa_account_<chain>`），切换后加载对应账户

---

## 十、H. Insights 智能洞察（insights.js / :9112 + :9120）

### TC-H-001（P1）图谱可视化
1. Insights → Graph Tab
- **预期**：`/factors/graph` 渲染节点/边（含 name_en 双语），边带符号 rho，无 JS 报错

### TC-H-002（P1）因子目录与当前值
1. Factors Tab
- **预期**：`/factors/catalog` 与 `/factors/current` 渲染表格，数值可读

### TC-H-003（P1）RAG 检索
1. RAG Tab → 输入问题 → 检索
- **预期**：`POST /rag/retrieve` 返回相关片段并渲染

### TC-H-004（P2）历史因子与 ML 预测
1. 选择因子/时间跨度 → 历史曲线；ML 预测 Tab
- **预期**：历史数据渲染；`/ml/sentiment`、`/ml/volatility`、`/ml/consensus` 返回并展示

---

## 十一、I. Payments 支付网关（payments.js / :9132）

### TC-I-001（P0）Overview 能力与信息 ★回归
1. Payments → Overview Tab
- **预期**：`/payments/capabilities` 返回 enabled 能力；`/payments/info` 显示 priceWei/payTo/chain；链信息正常

### TC-I-002（P0）Invite 全流程 ★回归
1. 创建邀请（`POST /payments/invites`）→ 列表可见
2. 支付（`invites/:id/pay`）→ 结算（`invites/:id/settle`）→ 状态流转
3. 再建一个邀请 → 取消（`invites/:id/cancel`）
- **预期**：各状态（pending/paid/settled/cancelled）正确流转，金额 BigInt 换算无精度损失

### TC-I-003（P0）Transfer 全流程 ★回归
1. 创建转账（`POST /payments/transfers`）→ 确认（`transfers/:id/confirm`）
2. 再建一个 → 取消
- **预期**：确认后资金到位，取消后不可再确认；列表状态正确

### TC-I-004（P1）A2A 转账 ★回归
1. `POST /payments/a2a` 创建 → `POST /payments/a2a/settle` 结算
- **预期**：双方账户余额正确变更

### TC-I-005（P1）批量支付
1. `POST /payments/batch` → `batch/settle` → 列表/取消
- **预期**：批量状态正确，逐笔可查

### TC-I-006（P1）MPP 会话
1. `mpp/open` → `mpp/topup` → `mpp/settle` → `mpp/close`；`mpp/session` 查询
- **预期**：会话生命周期状态机正确，余额扣减准确

### TC-I-007（P1）周期订阅计费
1. `POST /payments/period/charge` → `GET /payments/period/authorization`
- **预期**：周期扣费触发，授权记录可查

### TC-I-008（P2）Webhook 与订单查询
1. 触发事件后 `GET /payments/orders`、`GET /payments/balance`（webhook 端点鉴权豁免）
- **预期**：订单列表包含本次记录，余额一致

---

## 十二、J. Admin 控制台（admin.html / :9100）

### TC-J-001（P0）登录与 Dashboard KPI ★回归
1. `/admin-login.html` 登录 → Dashboard
- **预期**：KPI 卡片（租户/交易/地址/收入）有真实数据源；地址 KPI 回退逻辑正确；「View All」跳转对应区块（无死链）

### TC-J-002（P1）租户管理 ★回归
1. Tenants → View All → 详情 → PATCH 编辑
- **预期**：列表/详情渲染，编辑生效；「View All」入口可点击跳转（此前为死链）

### TC-J-003（P1）风控中心
1. Risk Center → 规则与代币黑名单
- **预期**：规则 CRUD、黑名单管理生效

### TC-J-004（P1）交易与 Webhook 事件
1. Transactions 列表与状态修改；Webhook Events 重试
- **预期**：状态变更生效；重试幂等

### TC-J-005（P1）计划管理
1. Plans 增删改
- **预期**：计划变更即时反映到订阅侧

### TC-J-006（P2）审计日志与 API Usage
1. Audit Logs、API Usage
- **预期**：日志与用量图表正确渲染

---

## 十三、K. 行情与事件采集（collector :9101）

### TC-K-001（P1）行情接口
1. `GET /api/v2/data/market/price`、`/candles`、`/trades`（代币示例 BTC/USDT）
- **预期**：返回实时数据，字段完整

### TC-K-002（P1）MemPump 追踪
1. `/api/v2/data/market/mempump/list` → details → devinfo
- **预期**：列表与详情渲染，无 5xx

### TC-K-003（P2）信号与榜单
1. `/signals`、`/leaderboard`、`/cluster-overview`
- **预期**：返回结构化数据

---

## 十四、L. 平台/数据服务

### TC-L-001（P1）K 线与符号解析
1. `GET /bars`、`/symbol/resolve`（data :9112，经代理）
- **预期**：86 个 Kline 符号可用，数据按时间窗返回

### TC-L-002（P1）因子工厂
1. `POST /factor-factory/start` → `status` → `result`
- **预期**：任务状态机（idle→running→done），结果返回

### TC-L-003（P2）ML 模型推理
1. `GET /ml/tree_predictions`、`/ml/bolt` 等
- **预期**：模型响应正常，代理注入 Bearer 鉴权通过

---

## 十五、平台级回归（跨模块）

### TC-X-001（P0）反向代理鉴权注入
1. 直连 vs 经代理访问 `/payments/*`、`/ml/*`、其他 `/api/v2/*`
- **预期**：代理注入对应 key（payments 用独立 key）；未授权直连返回 401 `{"detail":"unauthorized"}`

### TC-X-002（P0）前端零 JS 报错巡检
1. 依次访问全部 8 个模块 + Admin
- **预期**：Console 无 `ReferenceError`/`TypeError`/404 资源加载失败（各模块懒加载正常）

### TC-X-003（P1）静态资源与 SPA 回退
1. 访问 `/admin.html`、`/connect.html`、不存在的路径
- **预期**：页面正确返回；未知路径回退 index.html；`Cache-Control: no-store`

### TC-X-004（P1）幂等与防重
1. 同一入金/提现请求带相同幂等 key 重放
- **预期**：第二次被拒或返回原结果（无重复入账，唯一约束生效）

### TC-X-005（P1）安全头
1. 抓取任意响应头
- **预期**：HSTS/CSP/X-Frame-Options/X-Content-Type-Options 存在

---

## 十六、执行记录模板

| 用例 ID | 模块 | 优先级 | 执行日期 | 结果 | 缺陷单 | 备注 |
|---|---|---|---|---|---|---|
| TC-A-001 | 认证 | P0 | 2026-08-20 | 通过/失败 | — | — |

**统计口径**：按模块汇总通过率，P0 任一失败即阻断发布。

---

## 十七、缺陷跟踪建议（如测试发现）

| 级别 | 定义 | 处理 |
|---|---|---|
| Blocker | 资金损失/安全漏洞 | 立即停线修复 |
| Critical | P0 核心链路不可用 | 当日修复 |
| Major | P1 功能异常 | 3 日内修复 |
| Minor | P2 体验问题 | 排期修复 |
