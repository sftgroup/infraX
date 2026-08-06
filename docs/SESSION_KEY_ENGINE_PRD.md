# PRD - Session Key Engine 独立模块

> **版本**: v1.0 | **日期**: 2026-07-31 | **状态**: Released
> **作者**: Wayne (team1) | **受众**: Steven + 开发团队

---

## 1. 产品概述

### 1.1 产品背景

当前 sftgroup 旗下多个区块链项目（AItrader、AIHunter SaaS、Contra AI、PredX、BitByte V4）均涉及链上自动交易场景。用户需要在各项目中分别进行钱包授权，操作繁琐、安全审计重复、维护成本高。

OKX Wallet 支持 Session Key 机制——用户一次钱包签名授权后，系统可在指定周期内（如 30 天）自动执行交易，无需用户重复确认。但当前各项目各自实现或未实现该能力，缺乏统一、安全、可复用的基础设施。

### 1.2 产品目标

| 目标 | 描述 | 衡量标准 |
|------|------|----------|
| 统一授权 | 一个独立模块，所有项目共享 Session Key 能力 | 跨项目 Session 互通 |
| 安全隔离 | 合约白名单 + 函数白名单 + 额度限制 | 单 Session 泄露不影响资产安全 |
| 一键集成 | 前端 3 行代码 + 后端 1 行 API 调用 | 集成工时 ≤ 0.5 天 |
| 多链支持 | EVM + Solana + OKX Agentic Wallet | 3 链适配 |

### 1.3 系统范围

| 组件 | 说明 | 交付形式 |
|------|------|----------|
| `@sftgroup/session-key-core` | 核心逻辑（链无关） | npm 包 |
| `@sftgroup/session-key-evm` | EVM 链适配器 | npm 包 |
| `@sftgroup/session-key-solana` | Solana 适配器 | npm 包 |
| `@sftgroup/session-key-react` | 前端 React 组件库 | npm 包 |
| `session-key-server` | REST API 微服务 | Docker 镜像 |
| `session-key-db` | PostgreSQL 数据库 | Migration SQL |

---

## 2. UML 用例模型

### 2.1 系统用例图

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Session Key Engine                               │
│                                                                       │
│  ┌─────────┐      ┌─────────────────────┐                           │
│  │         │◄─────│ 创建 Session Key     │                           │
│  │  用户    │      │ (UC-01)             │                           │
│  │         │─────►│                     │                           │
│  │         │      └─────────────────────┘                           │
│  │         │      ┌─────────────────────┐                           │
│  │         │◄─────│ 查看 Session 列表   │                           │
│  │         │─────►│ (UC-02)             │                           │
│  │         │      └─────────────────────┘                           │
│  │         │      ┌─────────────────────┐                           │
│  │         │◄─────│ 撤销 Session Key    │                           │
│  │         │─────►│ (UC-03)             │                           │
│  │         │      └─────────────────────┘                           │
│  └─────────┘                                                         │
│                                                                       │
│  ┌─────────┐      ┌─────────────────────┐                           │
│  │ 接入项目 │─────►│ Session Key 执行交易  │                           │
│  │         │      │ (UC-04)             │                           │
│  │         │      └─────────┬───────────┘                           │
│  │         │                │ «include»                              │
│  │         │      ┌─────────▼───────────┐                           │
│  │         │      │ 权限校验             │                           │
│  │         │      │ (UC-05)             │                           │
│  │         │      └─────────┬───────────┘                           │
│  │         │                │ «include»                              │
│  │         │      ┌─────────▼───────────┐                           │
│  │         │      │ 链上广播交易         │                           │
│  │         │      │ (UC-06)             │                           │
│  │         │      └─────────────────────┘                           │
│  └─────────┘                                                         │
│                                                                       │
│  ┌─────────┐      ┌─────────────────────┐                           │
│  │ 系统定时 │─────►│ 过期 Session 清理    │                           │
│  │  任务    │      │ (UC-07)             │                           │
│  └─────────┘      └─────────────────────┘                           │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 参与者定义

| 参与者 | 类型 | 说明 |
|--------|------|------|
| 用户 | 人类 | 持有链上钱包的最终用户，通过前端 UI 与模块交互 |
| 接入项目 | 系统 | 调用 Session Key Engine 的后端服务（如 AItrader 策略引擎） |
| 系统定时任务 | 系统 | 自动化清理过期 Session、审计日志轮转 |

### 2.3 用例列表

| 编号 | 用例名称 | 参与者 | 优先级 |
|------|----------|--------|--------|
| UC-01 | 创建 Session Key | 用户 | P0 |
| UC-02 | 查看 Session 列表 | 用户 | P0 |
| UC-03 | 撤销 Session Key | 用户 | P0 |
| UC-04 | Session Key 执行交易 | 接入项目 | P0 |
| UC-05 | 权限校验 | 系统（include） | P0 |
| UC-06 | 链上广播交易 | 系统（include） | P0 |
| UC-07 | 过期 Session 清理 | 系统定时任务 | P1 |
| UC-08 | Session 执行记录查询 | 用户、接入项目 | P1 |
| UC-09 | 额度用尽自动撤销 | 系统 | P2 |

---

## 3. 详细用例规格说明

### UC-01 创建 Session Key

| 项目 | 内容 |
|------|------|
| **用例编号** | UC-01 |
| **用例名称** | 创建 Session Key |
| **参与者** | 用户 |
| **优先级** | P0 |
| **前置条件** | 1. 用户已连接钱包（MetaMask / OKX Wallet / Phantom）<br>2. 服务端已生成一次性 Nonce |
| **后置条件** | 1. 服务器生成一个 Session Key 公私钥对<br>2. 用户主钱包签名授权该 Session Key<br>3. Session 记录持久化到数据库，状态为 `active` |
| **基本事件流** | 1. 用户进入「交易授权」页面<br>2. 用户选择：有效期（7/14/30/90天）、授权合约白名单、单笔/累计额度<br>3. 系统生成 Nonce，展示待签名消息<br>4. 用户钱包签名确认<br>5. 系统验证签名 → 创建 Session Key → 加密存储私钥<br>6. 系统返回 Session 创建成功（含 session_id 和有效期） |
| **备选事件流** | 3a. 用户拒绝签名：系统提示"已取消"，不创建 Session<br>5a. 签名验证失败：返回错误 "Invalid signature"，不创建 Session<br>5b. 用户已有该合约的活跃 Session：提示"该合约已有授权，是否覆盖？" |
| **业务规则** | BR-01: 同一用户+同一链+同一合约白名单组合只允许一个活跃 Session<br>BR-02: 单笔上限默认 1000 USDC，累计上限默认 10000 USDC<br>BR-03: Session Key 私钥使用 AES-256-GCM 加密存储，密钥从环境变量读取 |

#### 数据说明表

**session_keys（session_keys）**

| 字段名 | 字段中文名 | 数据类型 | 取值范围 | 是否必填 | 备注说明 |
|--------|------------|----------|----------|----------|----------|
| id | 会话ID | UUID | UUID v4 | 是 | 主键 |
| user_id | 用户ID | VARCHAR(64) | 钱包地址 | 是 | 索引 |
| chain | 区块链 | VARCHAR(16) | eth/bsc/base/sol/xlayer | 是 | 索引 |
| session_address | Session地址 | VARCHAR(44) | 链地址格式 | 是 | 公钥 |
| session_pk_enc | 加密私钥 | TEXT | AES-256-GCM密文 | 是 | 仅服务端解密 |
| valid_from | 生效时间 | TIMESTAMP | ISO 8601 | 是 | |
| valid_until | 过期时间 | TIMESTAMP | ISO 8601 | 是 | |
| permissions | 权限配置 | JSONB | 见下表 | 是 | |
| max_per_tx | 单笔上限 | DECIMAL(36,18) | >0 | 是 | USDC 单位 |
| max_total | 累计上限 | DECIMAL(36,18) | >0 | 是 | USDC 单位 |
| total_spent | 已用额度 | DECIMAL(36,18) | ≥0 | 是 | 默认 0 |
| status | 状态 | VARCHAR(16) | active/revoked/expired/quota_exhausted | 是 | 默认 active |
| created_at | 创建时间 | TIMESTAMP | | 是 | DEFAULT NOW() |
| revoked_at | 撤销时间 | TIMESTAMP | | 否 | |

**permissions JSON 结构**

| 字段名 | 字段中文名 | 数据类型 | 取值范围 | 是否必填 | 备注说明 |
|--------|------------|----------|----------|----------|----------|
| contracts | 合约白名单 | STRING[] | 合约地址数组 | 是 | 允许交互的合约 |
| functions | 函数白名单 | STRING[] | 4-byte selector | 否 | 空=允许全部 |
| max_per_tx_usd | 单笔USD上限 | NUMBER | >0 | 否 | 覆盖 max_per_tx |

### UC-04 Session Key 执行交易

| 项目 | 内容 |
|------|------|
| **用例编号** | UC-04 |
| **用例名称** | Session Key 执行交易 |
| **参与者** | 接入项目（后端服务） |
| **优先级** | P0 |
| **前置条件** | 1. 调用方持有有效的 API Key<br>2. 目标 Session 状态为 active |
| **后置条件** | 1. 交易在链上广播<br>2. 执行记录写入 session_executions 表<br>3. total_spent 累加 |
| **基本事件流** | 1. 接入项目调用 `POST /api/v1/execute`，传入 session_id + 交易参数<br>2. 系统查 session_keys 表，校验状态为 active<br>3. 系统校验：合约地址 ∈ permissions.contracts<br>4. 系统校验：函数 selector ∈ permissions.functions（如配置）<br>5. 系统校验：交易金额 ≤ max_per_tx 且 total_spent + 本次 ≤ max_total<br>6. 系统用 session_pk_enc 解密私钥 → 签名交易 → 广播上链<br>7. 系统写执行日志，更新 total_spent<br>8. 返回 { tx_hash, success } |
| **备选事件流** | 2a. Session 已过期：返回 403 "Session expired"，状态改为 expired<br>3a. 合约不在白名单：返回 403 "Contract not whitelisted"<br>5a. 超单笔上限：返回 403 "Exceeds per-tx limit"<br>5b. 超累计上限：返回 403 "Quota exhausted"，状态改为 quota_exhausted<br>6a. 链上交易失败：记录日志，返回 { tx_hash, success: false, reason } |
| **业务规则** | BR-04: 执行接口需要 Bearer Token 认证（接入项目的 API Key）<br>BR-05: total_spent 用执行时的 USDC 价格换算<br>BR-06: 同一 Session 的执行请求串行处理（防并发重复扣费） |

#### 接口说明

**POST /api/v1/execute**

```json
// Request
{
  "session_id": "uuid",
  "chain": "eth",
  "to": "0xUniswapRouter",
  "data": "0x38ed1739...",     // 编码后的函数调用
  "value": "0",                // ETH value in wei
  "gas_limit": "300000"        // 可选，默认自动估算
}

// Response 200
{
  "code": 200,
  "data": {
    "execution_id": "uuid",
    "tx_hash": "0x...",
    "status": "success",
    "gas_used": "185000"
  }
}

// Response 403
{
  "code": 403,
  "message": "Contract not whitelisted"
}
```

---

## 4. 详细交互设计

### 4.1 页面整体交互流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                        用户操作流程                                   │
└─────────────────────────────────────────────────────────────────────┘

  [进入授权页面] ──► [连接钱包] ──► [配置授权参数] ──► [签名确认] ──► [完成]
                                                                       │
                                                    ┌──────────────────┘
                                                    ▼
                                              [查看授权列表]
                                                    │
                                              ┌─────┴─────┐
                                              ▼           ▼
                                         [撤销授权]   [查看执行记录]
```

### 4.2 时序图：创建 Session Key

```
┌──────────────────────────────────────────────────────────────────┐
│                  创建 Session Key 时序图                          │
└──────────────────────────────────────────────────────────────────┘

  用户      前端UI      钱包          SessionEngine        DB       链
   │         │           │                │                │        │
   │ 打开页面│           │                │                │        │
   │────────►│           │                │                │        │
   │         │ GET /api/v1/nonce         │                │        │
   │         │──────────────────────────►│                │        │
   │         │      {nonce, message}     │                │        │
   │         │◄──────────────────────────│                │        │
   │         │                           │                │        │
   │ 配置参数│           │                │                │        │
   │────────►│           │                │                │        │
   │         │ eth_signTypedData         │                │        │
   │         │──────────►│                │                │        │
   │         │      确认签名              │                │        │
   │         │◄──────────│                │                │        │
   │         │                           │                │        │
   │         │ POST /api/v1/sessions     │                │        │
   │         │ {signature, params}       │                │        │
   │         │──────────────────────────►│                │        │
   │         │                           │ 验证签名       │        │
   │         │                           │ 生成SessionKey │        │
   │         │                           │ INSERT         │        │
   │         │                           │───────────────►│        │
   │         │                           │     OK         │        │
   │         │                           │◄───────────────│        │
   │         │      {session_id, status} │                │        │
   │         │◄──────────────────────────│                │        │
   │         │                           │                │        │
   │ 展示成功│                           │                │        │
   │◄────────│                           │                │        │
```

### 4.3 时序图：执行交易

```
┌──────────────────────────────────────────────────────────────────┐
│                   Session Key 执行交易时序图                       │
└──────────────────────────────────────────────────────────────────┘

  接入项目     SessionEngine        DB           链上RPC
     │              │                │                │
     │ POST /execute│                │                │
     │─────────────►│                │                │
     │              │ SELECT session │                │
     │              │───────────────►│                │
     │              │  session data  │                │
     │              │◄───────────────│                │
     │              │                │                │
     │              │ 校验 status / 合约白名单 / 函数 / 额度  │
     │              │                │                │
     │              │ 解密私钥 → 签名交易                  │
     │              │                │                │
     │              │ eth_sendRawTransaction              │
     │              │──────────────────────────────────►│
     │              │           tx_hash                  │
     │              │◄──────────────────────────────────│
     │              │                │                │
     │              │ INSERT session_executions + UPDATE total_spent │
     │              │───────────────►│                │
     │              │     OK         │                │
     │              │◄───────────────│                │
     │              │                │                │
     │  {tx_hash, success}           │                │
     │◄─────────────│                │                │
```

### 4.4 状态机：Session 生命周期

```
                    ┌─────────┐
                    │  active  │
                    └────┬────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
    [用户撤销]      [到期/定时]     [额度用尽]
         │               │               │
         ▼               ▼               ▼
   ┌─────────┐    ┌───────────┐   ┌───────────────┐
   │ revoked │    │  expired   │   │quota_exhausted│
   └─────────┘    └───────────┘   └───────────────┘
```

---

## 5. UI 设计规范

### 5.1 页面整体布局

```
┌──────────────────────────────────────────────────────────────┐
│  [Logo]  Session Key Engine                    [钱包地址]     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─ 创建新授权 ──────────────────────────────────────────┐  │
│  │                                                       │  │
│  │  有效期:  [7天] [14天] [30天 ✓] [90天]                │  │
│  │                                                       │  │
│  │  授权合约:                                            │  │
│  │  ┌─────────────────────────────────────────────┐     │  │
│  │  │ ✓ Uniswap V3 Router  0xE592...              │     │  │
│  │  │ ✓ 1inch Router       0x1111...              │     │  │
│  │  │ + 添加合约                                   │     │  │
│  │  └─────────────────────────────────────────────┘     │  │
│  │                                                       │  │
│  │  单笔上限: [____1000____] USDC                        │  │
│  │  累计上限: [___10000____] USDC                        │  │
│  │                                                       │  │
│  │  ┌──────────────────────────────────────────┐        │  │
│  │  │  待签名消息:                              │        │  │
│  │  │  I authorize Session Key 0xABCD... to    │        │  │
│  │  │  interact with [Uniswap,1inch] for 30    │        │  │
│  │  │  days. Max per tx: 1000 USDC.            │        │  │
│  │  │  Total max: 10000 USDC.                  │        │  │
│  │  │  Nonce: abc123                            │        │  │
│  │  └──────────────────────────────────────────┘        │  │
│  │                                                       │  │
│  │  [🔐 钱包签名授权]                                    │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ 我的授权 ────────────────────────────────────────────┐  │
│  │                                                       │  │
│  │  Chain │ 合约白名单     │ 额度      │ 有效至    │ 操作 │  │
│  │  ──────┼────────────────┼───────────┼───────────┼──── │  │
│  │  ETH   │ Uniswap,1inch  │ 850/10000 │ 08-30     │ 撤销 │  │
│  │  BASE  │ Uniswap        │ 200/5000  │ 08-15     │ 撤销 │  │
│  │  SOL*  │ Jupiter        │ 50/1000   │ 09-01     │ 撤销 │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 核心组件设计

```
┌─ ExpirySelector ──────────────────────────────────────┐
│                                                        │
│  [7 Days]   [14 Days]   [30 Days ●]   [90 Days]       │
│                                                        │
│  选中的高亮，未选中的灰底                                │
└────────────────────────────────────────────────────────┘

┌─ ContractSelector ────────────────────────────────────┐
│                                                        │
│  [Uniswap V3 Router                           ✕]      │
│  [1inch Router                                ✕]      │
│  [+ Add Contract]                                      │
│                                                        │
│  每个标签可删除，点击+弹出地址输入框                      │
└────────────────────────────────────────────────────────┘

┌─ PermissionSummary ───────────────────────────────────┐
│                                                        │
│  📋 Authorization Preview                              │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Session Key 0xABCD...EF01 will be authorized to: │ │
│  │ • Valid for: 30 days (until 2026-08-30)         │ │
│  │ • Contracts: Uniswap V3, 1inch V5               │ │
│  │ • Max per tx: 1,000 USDC                        │ │
│  │ • Max total: 10,000 USDC                         │ │
│  │ • Chain: Ethereum                                │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  [Sign with Wallet]                                    │
└────────────────────────────────────────────────────────┘
```

### 5.3 色彩规范

| 用途 | 色值 | 说明 |
|------|------|------|
| 主色 | `#1677FF` | 按钮、链接、选中态 |
| 成功 | `#52C41A` | active 状态、成功提示 |
| 警告 | `#FAAD14` | 即将过期（<3天） |
| 危险 | `#FF4D4F` | 撤销按钮、过期/用尽状态 |
| 背景 | `#F5F5F5` | 页面背景 |
| 卡片 | `#FFFFFF` | 卡片、面板背景 |
| 文字主 | `#1F1F1F` | 标题、正文 |
| 文字辅 | `#8C8C8C` | 辅助信息、占位符 |
| 边框 | `#E8E8E8` | 分割线、边框 |

### 5.4 字体规范

| 层级 | 字号 | 字重 | 用途 |
|------|------|------|------|
| H1 | 24px | 600 | 页面标题 |
| H2 | 18px | 600 | 区块标题 |
| H3 | 16px | 500 | 卡片标题 |
| Body | 14px | 400 | 正文、表单 |
| Caption | 12px | 400 | 辅助文字、地址 |
| Code | 13px | 400 | 合约地址、签名消息 |

### 5.5 间距规范

| 级别 | 值 | 用途 |
|------|-----|------|
| xs | 4px | 紧凑内边距 |
| sm | 8px | 元素间距 |
| md | 16px | 组件间距 |
| lg | 24px | 区块间距 |
| xl | 32px | 页面内边距 |

---

## 6. 非功能需求

### 6.1 性能需求

| 指标 | 目标值 |
|------|--------|
| 创建 Session 接口响应 | ≤ 2s |
| 执行交易接口响应 | ≤ 5s（含链上广播等待） |
| Session 列表查询 | ≤ 500ms |
| 并发执行请求 | ≥ 50 TPS |
| 签名生成 | ≤ 100ms |

### 6.2 安全需求

| 需求 | 说明 |
|------|------|
| S-01 | Session Key 私钥 AES-256-GCM 加密存储，加密密钥通过环境变量注入 |
| S-02 | 执行接口强制 Bearer Token 认证 |
| S-03 | 所有接口全量请求日志 |
| S-04 | 私钥解密仅在内存中，不落盘 |
| S-05 | 合约白名单 + 函数白名单 + 额度三重校验 |
| S-06 | 单 Session 执行串行化，防重放攻击 |
| S-07 | Nonce 30 分钟内有效，一次性使用 |

### 6.3 兼容性需求

| 维度 | 要求 |
|------|------|
| 钱包 | MetaMask、OKX Wallet、Phantom、WalletConnect |
| 链 | Ethereum、BSC、Base、Polygon、Arbitrum、Optimism、X Layer、Solana |
| 前端框架 | React ≥ 18（`@sftgroup/session-key-react`） |
| 后端框架 | Node.js ≥ 18（Express/Fastify） |
| 浏览器 | Chrome 90+, Firefox 90+, Safari 15+ |

### 6.4 可靠性需求

| 指标 | 目标 |
|------|------|
| 可用性 | 99.9%（月度） |
| 数据备份 | 每日自动备份 |
| 私钥恢复 | 不支持（丢失即永久丢失，按需重新创建 Session） |
| 交易重试 | 失败自动重试 1 次（仅 gas 不足/网络波动类错误） |

---

## 7. 技术架构

### 7.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    接入项目层                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │AItrader  │  │AIHunter  │  │ PredX    │  │ BitByte V4 │ │
│  │(Python)  │  │(Node.js) │  │(Python)  │  │(TypeScript)│ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘ │
│       │              │              │              │         │
│       └──────────────┴──────────────┴──────────────┘         │
│                          │                                    │
│              REST API + npm SDK                              │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                Session Key Engine Server                      │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ REST API    │  │ Auth Module │  │ Permission Engine    │ │
│  │ (Express)   │  │ (JWT+Nonce) │  │ (白名单/额度校验)    │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ Chain       │  │ Crypto      │  │ Job Scheduler        │ │
│  │ Adapters    │  │ (AES/ECDSA) │  │ (过期清理)           │ │
│  │ EVM/SOL/OKX │  │             │  │                      │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐                           │
│  │ PostgreSQL  │  │ Redis       │                           │
│  │ (Session+Log)│  │ (Nonce/锁)  │                           │
│  └─────────────┘  └─────────────┘                           │
└──────────────────────────────────────────────────────────────┘
```

### 7.2 模块划分

| 模块 | 语言 | 说明 |
|------|------|------|
| `@sftgroup/session-key-core` | TypeScript | 核心类型定义、加解密工具、权限校验逻辑 |
| `@sftgroup/session-key-evm` | TypeScript | EVM 适配器：ethers.js/viem 签名+广播 |
| `@sftgroup/session-key-solana` | TypeScript | Solana 适配器：@solana/web3.js |
| `@sftgroup/session-key-react` | TypeScript/React | SessionKeyAuth、SessionKeyList、SessionKeyDetail 组件 |
| `session-key-server` | TypeScript/Fastify | REST API 微服务 |
| `session-key-db` | SQL | Migration 脚本 |

### 7.3 部署拓扑

```
测试服 129.226.202.72
├── session-key-server:3500   (Docker)
├── PostgreSQL (复用已有)
└── Redis (复用已有 :6379)

→ 各项目通过 http://129.226.202.72:3500 调用
```

### 7.4 项目接入示例（代码片段）

**后端调用（AItrader Python → REST API）**:

```python
import requests

resp = requests.post(
    "http://129.226.202.72:3500/api/v1/execute",
    json={
        "session_id": "abc-123",
        "chain": "eth",
        "to": "0xUniswapRouter",
        "data": "0x38ed1739...",
        "value": "0"
    },
    headers={"Authorization": "Bearer {API_KEY}"}
)
print(resp.json())  # {"code": 200, "data": {"tx_hash": "0x...", "status": "success"}}
```

**后端调用（AIHunter SaaS Node.js → npm SDK）**:

```typescript
import { SessionKeyClient } from '@sftgroup/session-key-core';

const client = new SessionKeyClient({
  baseUrl: 'http://129.226.202.72:3500',
  apiKey: process.env.SESSION_KEY_API_KEY
});

const result = await client.execute({
  sessionId: 'abc-123',
  chain: 'eth',
  to: '0xUniswapRouter',
  data: swapCallData,
  value: '0'
});
// { txHash: '0x...', status: 'success' }
```

**前端接入**:

```tsx
import { SessionKeyAuth, SessionKeyList } from '@sftgroup/session-key-react';

function MyApp() {
  return (
    <div>
      <SessionKeyAuth
        chain="eth"
        walletProvider={provider}
        engineUrl="http://129.226.202.72:3500"
        presetContracts={['0xUniswapRouter', '0x1inchRouter']}
        onCreated={(session) => console.log('Session created', session)}
      />
      <SessionKeyList
        chain="eth"
        userAddress={address}
        engineUrl="http://129.226.202.72:3500"
      />
    </div>
  );
}
```

---

## 8. 附录

### 8.1 术语表

| 术语 | 说明 |
|------|------|
| Session Key | 用户主钱包授权的一个临时密钥对，在有效期内可代签交易 |
| TEE | Trusted Execution Environment，可信执行环境 |
| EOA | Externally Owned Account，外部拥有账户（普通钱包地址） |
| ERC-4337 | 账户抽象标准，支持 Session Key 等高级钱包功能 |
| EIP-712 | 类型化数据签名标准，用于展示可读的签名消息 |
| Nonce | 一次性随机数，防重放攻击 |

### 8.2 Git 仓库

| 仓库 | 地址 |
|------|------|
| 主仓库 | `https://github.com/sftgroup/session-key-engine` |

### 8.3 参考资料

- [OKX OnchainOS Agentic Wallet](https://web3.okx.com/zh-hans/onchainos/dev-docs/wallet/agentic-wallet)
- [ERC-4337: Account Abstraction](https://eips.ethereum.org/EIPS/eip-4337)
- [EIP-712: Typed structured data hashing and signing](https://eips.ethereum.org/EIPS/eip-712)
- [Session Keys in Safe{Core}](https://docs.safe.global/core-api/supported-networks)

---

## 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-07-31 | 初稿：PRD 完整版 |
| v1.0 | 2026-08-07 | 定稿 Released（MQ-5）：执行/额度/过期 三重校验落地并补集成测试 `packages/server/src/services/execution-service.test.ts`（11 用例全绿） |
