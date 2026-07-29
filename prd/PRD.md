# InfraX — 品牌化 MCP & Skill 产品需求文档

> 版本: v1.0-draft | 日期: 2026-07-30 | 状态: 待审阅 | 作者: Wayne (team1)

---

## 1. 产品概述

### 1.1 产品背景

InfraX 是一个 Web3 基础设施平台（当前 v0.3.2，sftgroup/infrax），已覆盖 5 条链（Sepolia/Ethereum/BSC/Base/OxaChain），提供 12 个微服务模块，包括 WAAS（钱包即服务）、Vault（Safe 多签）、DC（数据中心）、MPC（多方计算钱包）、Payment（x402 支付引擎）等。已具备 REST API / MCP / JS SDK 三种接入方式，4 个 MCP Server 提供 45 个 Agent tools。

当前痛点：
- 品牌化不足，InfraX 在市场层面缺乏独立的身份标识
- MCP tools 散落在 4 个 Server 中，AI Agent 调用不够直观
- 数据中心事件查询粒度粗，Agent 难以精确获取细分数据
- MPC 钱包基于邮件验证码，安全性不足，缺少 Agent/API 直接链上操作能力

### 1.2 产品目标

| 目标 | 描述 | 优先级 |
|------|------|:---:|
| **品牌 MCP 发布** | 将 InfraX 作为独立品牌 MCP 提交到主流 MCP 市场，同时发布配套 SkillHub Skill | P0 |
| **数据强化与细分** | DC 数据中心从粗粒度事件查询升级为细分类别/标签化数据，Agent 可一行调用拿到精确结果 | P0 |
| **MPC TEE 钱包** | MPC 钱包升级为 TEE（Trusted Execution Environment）安全架构，支持 Agent/API 调用执行链上操作（转账/Swap/合约） | P0 |
| **统一 OpenAPI 规范** | 发布标准 OpenAPI 3.1 文档，支撑 MCP 市场和开发者集成 | P1 |
| **去中心化 MCP 节点** | 支持第三方运行 InfraX MCP 节点，形成去中心化 MCP 网络 | P2 |

### 1.3 系统范围

#### 新增组件

| 组件 | 说明 | 技术选型 |
|------|------|----------|
| **InfraX MCP Hub** | 统一品牌 MCP Server，聚合 4 个现有 MCP 的能力为单一入口 | Node.js + MCP SDK |
| **InfraX Skill** | ClawHub/SkillHub 上的可安装 Skill 包，一键接入 InfraX MCP | SkillHub 规范 |
| **Data API v3** | 细分事件查询 API，支持分类/标签/聚合/时序/分页 | Express TS + PostgreSQL |
| **DC MCP v2** | 重新设计 DC MCP tools，每个 tool 对应一个细分数据维度 | MCP SDK |
| **TEE Wallet Service** | TEE 环境下的密钥生成/签名/交易服务 | Intel SGX / AWS Nitro Enclave |
| **TEE MCP** | TEE 钱包的 MCP 接口，Agent 可调用链上操作 | MCP + TEE attestation |

#### 修改组件

| 组件 | 改动 |
|------|------|
| DC | 新增事件分类表、标签表、聚合查询视图 |
| MPC | 废弃邮件验证码，迁移到 TEE 架构 |
| Web Proxy | 新增 /api/v3/data/* 路由，新增 OpenAPI spec 静态文件 |
| Admin | 新增 MCP 市场发布管理、TEE 钱包配置管理 |

---

## 2. UML 用例模型

### 2.1 系统用例图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          InfraX MCP & Skill 系统                          │
└──────────────────────────────────────────────────────────────────────────┘

        ┌─────────┐                          ┌───────────┐
        │ AI Agent │                          │ 开发者     │
        └────┬─────┘                          └─────┬─────┘
             │                                      │
    ┌────────┼──────────────────────────────────────┼────────┐
    │        │            InfraX 系统                │         │
    │  ┌─────▼──────────────────┐                   │         │
    │  │ UC-01 通过MCP查询链上数据│                   │         │
    │  └────────────────────────┘                   │         │
    │  ┌────────────────────────┐                   │         │
    │  │ UC-02 通过MCP执行链上操作│                   │         │
    │  └────────────────────────┘                   │         │
    │  ┌────────────────────────┐    ┌──────────────▼───────┐ │
    │  │ UC-03 安装Skill一键接入 │    │ UC-06 查看OpenAPI文档│ │
    │  └────────────────────────┘    └──────────────────────┘ │
    │  ┌────────────────────────┐    ┌──────────────────────┐ │
    │  │ UC-04 创建TEE钱包并操作 │    │ UC-07 浏览MCP市场     │ │
    │  └────────────────────────┘    └──────────────────────┘ │
    │  ┌────────────────────────┐                              │
    │  │ UC-05 数据订阅与通知    │                              │
    │  └────────────────────────┘                              │
    │                                                           │
    │                            ┌──────────────────────┐       │
    │                            │ UC-08 管理TEE钱包    │       │
    │                            └──────────────────────┘       │
    │                            ┌──────────────────────┐       │
    │         ┌──────────┐       │ UC-09 管理MCP市场发布 │       │
    │         │ 管理员   ├──────►└──────────────────────┘       │
    │         └──────────┘       ┌──────────────────────┐       │
    │                            │ UC-10 运维去中心化节点│       │
    │                            └──────────────────────┘       │
    └───────────────────────────────────────────────────────────┘
```

### 2.2 参与者定义

| 参与者 | 描述 |
|--------|------|
| **AI Agent** | 通过 MCP 协议调用 InfraX 的 AI 代理（如 Claude、GPT、DeepSeek 等） |
| **开发者** | 通过 REST API / JS SDK 接入 InfraX 的应用开发者 |
| **管理员** | InfraX 平台运维人员 |

### 2.3 用例列表

| 编号 | 用例名称 | 参与者 | 优先级 |
|------|----------|--------|:---:|
| UC-01 | 通过 MCP 查询链上数据 | AI Agent | P0 |
| UC-02 | 通过 MCP 执行链上操作 | AI Agent | P0 |
| UC-03 | 安装 Skill 一键接入 InfraX | AI Agent / 开发者 | P0 |
| UC-04 | 创建 TEE 钱包并操作 | AI Agent / 开发者 | P0 |
| UC-05 | 数据订阅与实时通知 | AI Agent / 开发者 | P1 |
| UC-06 | 查看标准 OpenAPI 文档 | 开发者 | P1 |
| UC-07 | 浏览 MCP 市场发现 InfraX | AI Agent / 开发者 | P1 |
| UC-08 | 管理 TEE 钱包配置 | 管理员 | P1 |
| UC-09 | 管理 MCP 市场发布 | 管理员 | P1 |
| UC-10 | 运维去中心化 MCP 节点 | 管理员 | P2 |

---

## 3. 详细用例规格说明

### UC-01 通过 MCP 查询链上数据

| 项目 | 内容 |
|------|------|
| **用例编号** | UC-01 |
| **用例名称** | 通过 MCP 查询链上数据 |
| **参与者** | AI Agent |
| **前置条件** | 1. AI Agent 已安装 InfraX MCP 或 Skill<br>2. AI Agent 持有有效的 API Key<br>3. MCP Server 运行中 |
| **后置条件** | Agent 获取到精确的链上数据查询结果 |
| **优先级** | P0 |

#### 基本事件流

1. AI Agent 通过 MCP 调用 `list_datatools` 了解可用数据维度
2. AI Agent 选择需要的 tool（如 `dc_events_by_category`、`dc_token_balance`、`dc_transaction_history`）
3. AI Agent 传入参数（chain、category、address、time_range 等）
4. MCP Server 解析参数，调用 DC API v3
5. DC 从 PostgreSQL 查询细分事件数据
6. DC 返回结构化 JSON
7. MCP Server 封装为 MCP 协议响应
8. AI Agent 接收数据并用于对话/分析

#### 备选事件流

- 2a. Agent 未提供必要参数 → MCP 返回参数错误提示及示例
- 2b. API Key 无效/过期 → MCP 返回 401 Unauthorized
- 5a. 查询超时 (>5s) → 返回分页提示，建议缩小时间范围

#### 业务规则

- BR-01: 每条 MCP 调用计为 1 次 API 配额消耗
- BR-02: Free 套餐仅限 Sepolia 数据；Pro/Enterprise 支持全链
- BR-03: 历史数据保留 90 天（Free）、180 天（Pro）、永久（Enterprise）

#### DC MCP v2 Tools（数据强化后）

| Tool | 描述 | 参数 |
|------|------|------|
| `dc_list_categories` | 列出可用数据分类和标签 | — |
| `dc_events` | 按分类+链+地址查询事件 | chain, category, address, from, to, page |
| `dc_event_detail` | 单笔交易解码详情 | tx_hash |
| `dc_balance` | 多链多代币余额查询 | chain, address, tokens |
| `dc_token_info` | 代币详情（价格/lp/holders） | token_address, chain |
| `dc_stats` | 24h 聚合统计 | chain, stat_type |
| `dc_subscribe` | 创建事件订阅 | chain, category, filters, webhook |
| `dc_my_subscriptions` | 查看我的订阅 | — |
| `dc_unsubscribe` | 取消订阅 | subscription_id |

---

### UC-02 通过 MCP 执行链上操作

| 项目 | 内容 |
|------|------|
| **用例编号** | UC-02 |
| **用例名称** | 通过 MCP 执行链上操作 |
| **参与者** | AI Agent |
| **前置条件** | 1. AI Agent 已安装 InfraX MCP 或 Skill<br>2. AI Agent 关联的 TEE 钱包已创建并充值<br>3. 用户已授权 Agent 操作权限 |
| **后置条件** | 链上操作被执行，Agent 收到交易 hash |
| **优先级** | P0 |

#### 基本事件流

1. AI Agent 调用 `tee_wallet_balance` 查询钱包余额
2. AI Agent 确认余额充足后调用具体操作 tool：
   - `tee_wallet_transfer` — 原生代币转账
   - `tee_wallet_swap` — DEX 代币兑换
   - `tee_wallet_contract_write` — 合约调用
   - `tee_wallet_approve` — ERC20 授权
3. MCP Server 解析参数，调用 TEE Wallet Service
4. TEE Wallet Service 验证权限（session token + 限额）
5. TEE 环境内构建交易并签名
6. TEE Wallet Service 广播交易到链上
7. 返回 txHash 给 MCP Server
8. MCP Server 返回结果给 AI Agent

#### 备选事件流

- 4a. session token 过期 → 引导用户重新解锁 TEE 钱包
- 4b. 超过单笔限额 → 返回限额错误，提示当前限额
- 5a. Gas 不足 → 返回 Gas 估算值，提示充值
- 6a. 交易回滚 → 返回回滚原因

#### 业务规则

- BR-01: 单笔转账默认限额 0.1 ETH/USDC，Pro 可自定义，Enterprise 可解除
- BR-02: 单日累计限额 1 ETH/USDC（可配置）
- BR-03: Session token 有效期 30 分钟，超时需重新解锁
- BR-04: swap 仅支持已列入白名单的 DEX 路由（Uniswap/PancakeSwap 等）

#### TEE 钱包 MCP Tools

| Tool Name | 操作 | 需要Token | 计费 |
|------|------|:---:|:---:|
| `tee_create_wallet` | 创建 TEE 钱包 | ❌ | ❌ |
| `tee_register` | 注册钱包分片 | ❌ | ❌ |
| `tee_recover` | 恢复钱包 | ❌ | ❌ |
| `tee_unlock` | 解锁（设置 session） | ❌ | ❌ |
| `tee_lock` | 锁定钱包 | ✅ | ❌ |
| `tee_status` | 查询钱包/会话状态 | ✅ | ❌ |
| `tee_balance` | 查余额（原生+ERC20） | ✅ | ❌ |
| `tee_transfer` | 转账（ETH/ERC20） | ✅ | ✅ |
| `tee_swap` | DEX 兑换 | ✅ | ✅ |
| `tee_approve` | ERC20 授权 | ✅ | ✅ |
| `tee_contract_read` | 合约只读 | ❌ | ❌ |
| `tee_contract_write` | 合约写 | ✅ | ✅ |
| `tee_sign_message` | EIP-191 签名 | ✅ | ❌ |
| `tee_sign_typed_data` | EIP-712 签名 | ✅ | ❌ |
| `tee_gas_estimate` | Gas 估算 | ❌ | ❌ |
| `tee_get_transaction` | 查询交易状态 | ❌ | ❌ |

---

### UC-03 安装 Skill 一键接入 InfraX

| 项目 | 内容 |
|------|------|
| **用例编号** | UC-03 |
| **用例名称** | 安装 Skill 一键接入 InfraX |
| **参与者** | AI Agent / 开发者 |
| **前置条件** | 1. 用户运行支持 SkillHub 的 AI Agent 框架（如 OpenClaw）<br>2. Agent 可访问互联网 |
| **后置条件** | Agent 拥有 InfraX MCP 的全部 tools 可用 |
| **优先级** | P0 |

#### 基本事件流

1. 用户对 Agent 说 "install infraX skill" 或 "接入 InfraX"
2. Agent 调用 `openclaw skills install infrax`
3. SkillHub 下载 infrax 的 SKILL.md + MCP server config
4. Agent 配置中自动注册 InfraX MCP Server URL 和认证
5. Agent 自动调用 `list_tools` 验证 16+ 个 tools 可用
6. Agent 回复 "InfraX 已接入，可用功能：..."

#### 业务规则

- BR-01: Free 套餐需要在 InfraX 官网注册 API Key（Skill 内引导）
- BR-02: 自动配置 MCP server URL 为生产环境（可配置自定义节点）

---

### UC-04 创建 TEE 钱包并操作

| 项目 | 内容 |
|------|------|
| **用例编号** | UC-04 |
| **用例名称** | 创建 TEE 钱包并操作 |
| **参与者** | AI Agent / 开发者 |
| **前置条件** | 用户已通过 InfraX MCP 或 REST API 认证 |
| **后置条件** | TEE 钱包创建成功，可以进行链上操作 |
| **优先级** | P0 |

#### 基本事件流

1. 用户/AI Agent 调用 `tee_create_wallet`
2. TEE Wallet Service 验证环境 attestation
3. TEE 内生成 ECDSA 密钥对
4. 密钥分片通过 MPC 协议分散存储
5. 返回钱包地址（无完整私钥导出）
6. 用户向地址充值
7. 调用 `tee_unlock` 设置 session token
8. 调用 `tee_balance` 确认余额
9. 调用 `tee_transfer` / `tee_swap` / `tee_contract_write` 执行操作

#### 业务规则

- BR-01: 私钥永不明文导出，只在 TEE 环境内使用
- BR-02: TEE attestation 每 24 小时自动刷新
- BR-03: 密钥分片至少 3 个节点，阈值 2/3

---

### UC-05 数据订阅与实时通知

| 项目 | 内容 |
|------|------|
| **用例编号** | UC-05 |
| **用例名称** | 数据订阅与实时通知 |
| **参与者** | AI Agent / 开发者 |
| **前置条件** | 1. 用户已订阅 DC Pro/Enterprise 套餐<br>2. 已配置 webhook URL |
| **后置条件** | 满足条件的链上事件发生时，用户收到实时通知 |
| **优先级** | P1 |

#### 基本事件流

1. Agent 调用 `dc_subscribe` 创建订阅
2. 传入参数：chain、event_category、filters
3. DC 记录订阅到 PostgreSQL
4. Collector 扫描到匹配事件时触发通知
5. DC 向 webhook URL POST 事件 data
6. AI Agent 通过回调收到实时数据

#### 业务规则

- BR-01: 单个用户最多 10 个活跃订阅
- BR-02: 重试 3 次，间隔 1min/5min/15min
- BR-03: 订阅支持按 category 过滤

---

## 4. 数据强化与细分设计

### 4.1 事件分类体系

#### 一级分类

| Category ID | 名称 | 描述 |
|------|------|------|
| `dex` | DEX 交易 | Swap/AddLiquidity/RemoveLiquidity |
| `lending` | 借贷 | Borrow/Repay/Supply/Withdraw/Liquidate |
| `nft` | NFT 交易 | Mint/Transfer/Sale/Bid |
| `bridge` | 跨链桥 | Deposit/Withdraw/Relay |
| `staking` | 质押 | Stake/Unstake/ClaimReward |
| `governance` | 治理 | Propose/Vote/Execute |
| `transfer` | 转账 | ETH/ERC20 原生转账 |
| `contract` | 合约交互 | 通用合约调用 |
| `deploy` | 合约部署 | 新合约创建 |
| `other` | 其他 | 未分类事件 |

#### 二级标签（按协议）

| 协议 | Category | 链支持 |
|------|------|------|
| Uniswap V2/V3 | dex | ETH/BSC/Base/Sepolia |
| PancakeSwap | dex | BSC |
| Aave V3 | lending | ETH/Base |
| Compound | lending | ETH |
| OpenSea | nft | ETH/Base |
| Blur | nft | ETH |
| Lido | staking | ETH |
| OxaBridge | bridge | OxaChain/ETH |

### 4.2 Data API v3 端点设计

| 端点 | 方法 | 描述 |
|------|:---:|------|
| `/api/v3/data/events` | GET | 按分类/标签/地址/时间查询事件 |
| `/api/v3/data/events/:txHash` | GET | 单笔交易详情（含解码后的参数） |
| `/api/v3/data/balance` | GET | 多链/多代币聚合余额查询 |
| `/api/v3/data/token/:address` | GET | 代币详情（价格/流动性/holders） |
| `/api/v3/data/stats` | GET | 聚合统计（24h 交易量/活跃地址等） |
| `/api/v3/data/categories` | GET | 列出所有可用分类和标签 |
| `/api/v3/data/subscribe` | POST | 创建事件订阅 |
| `/api/v3/data/unsubscribe` | DELETE | 取消订阅 |
| `/api/v3/data/subscriptions` | GET | 列出当前订阅 |

### 4.3 数据字典

#### 事件分类表 (event_categories)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL PK | 自增主键 |
| category_id | VARCHAR(50) | 分类标识（dex/lending/nft/...） |
| category_name | VARCHAR(100) | 分类名称 |
| label_id | VARCHAR(50) | 标签标识（uniswap_v3/aave_v3/...） |
| label_name | VARCHAR(100) | 标签/协议名称 |
| chain | VARCHAR(20) | 链标识 |

#### 细分事件表 (events_v3) — 继承现有 events，新增字段

| 字段 | 类型 | 说明 |
|------|------|------|
| event_id | UUID PK | 事件唯一 ID |
| category_id | VARCHAR(50) | FK → event_categories |
| label_id | VARCHAR(50) | FK → event_categories |
| token_address | VARCHAR(42) | 代币地址 |
| usd_value | DECIMAL(38,6) | USD 估值 |
| decoded_params | JSONB | 解码后的合约参数 |
| raw_log | JSONB | 原始 event log |

---

## 5. TEE 钱包安全架构

### 5.1 安全架构图

```
┌──────────────────────────────────────────────────────┐
│           TEE Enclave (Intel SGX / AWS Nitro)        │
│                                                      │
│  ┌────────────┐  ┌───────────┐  ┌───────────────┐   │
│  │ KeyGen     │  │ Signer    │  │ Attestation   │   │
│  │ (ECDSA)    │  │ (EIP-191/ │  │ Service       │   │
│  │            │  │  EIP-712) │  │               │   │
│  └────────────┘  └───────────┘  └───────────────┘   │
│                                                      │
│  私钥永不离 Enclave │ 签名在 Enclave 内完成           │
└──────────────────────────────────────────────────────┘
       ▲                              ▲
       │ 分片存储                      │ session token
  ┌────┴────┐                   ┌─────┴─────────┐
  │ 节点A-C │                   │ MCP/API 层     │
  │ (SGX×3) │                   │ (:9120)        │
  └─────────┘                   └───────────────┘
```

### 5.2 安全机制

| 层级 | 机制 | 描述 |
|------|------|------|
| **硬件层** | TEE Enclave | Intel SGX 或 AWS Nitro，私钥在安全区生成和使用 |
| **密钥层** | MPC 分片 | 密钥分 3 片，2/3 阈值重构 |
| **会话层** | Session Token | 30min TTL，JWT + HMAC-SHA256 |
| **认证层** | Attestation | 每 24h quote 验证，确保 Enclave 未被篡改 |
| **风控层** | 限额 + 白名单 | 单笔/单日限额，仅白名单 DEX |
| **审计层** | 全操作日志 | Enclave 操作记录到不可变日志 |

### 5.3 现有 MPC vs TEE 钱包对比

| 维度 | 现有 MPC | TEE 钱包 |
|------|------|------|
| 密钥存储 | 分片，服务端存储 | 分片 + TEE Enclave 硬件保护 |
| 签名环境 | 服务端内存 | TEE Enclave 安全区 |
| 验证方式 | 邮件验证码（6位） | Session token + Attestation |
| Agent 调用 | 需用户手动验证码 | Session token 自动签名 |
| 私钥导出 | ❌ | ❌（更强保证） |
| 安全假设 | 信任服务器运维 | 信任硬件 + 数学（MPC） |

---

## 6. 品牌 MCP 市场发布计划

### 6.1 市场列表

| 市场 | 分发方式 | 优先级 |
|------|------|:---:|
| **ClawHub** | `openclaw skills install infrax` | P0 |
| **MCP Hub** (mcp.so) | HTTPS endpoint 注册 | P0 |
| **OpenAI GPT Store** | OpenAPI spec 导入 | P1 |
| **Cursor MCP** | JSON config 分发 | P1 |
| **Claude MCP** | JSON config 分发 | P1 |
| **GitHub MCP Registry** | 公开 repo + 文档 | P1 |

### 6.2 统一品牌入口

```
                    ┌─────────────────────┐
                    │ InfraX Hub MCP :9120 │
                    │ 45+ tools 统一入口    │
                    └──────┬──────┬───────┘
                           │      │
              ┌────────────┼──────┼────────────┐
              ▼            ▼      ▼            ▼
         DC MCP v2    TEE MCP  Vault MCP   Wallet MCP
         (9 tools)  (16 tools) (13 tools) (10 tools)
```

合并现有 4 个 MCP Server 为品牌统一入口：
- 新端口 **9120**（保留旧端口 9103/9105/9108/9110 兼容过渡）
- `/mcp/message` — MCP JSON-RPC
- `/openapi.json` — OpenAPI 3.1 规范

---

## 7. 非功能需求

| 指标 | 目标 |
|------|------|
| MCP tool 响应 | P95 < 2s（查询），P95 < 10s（交易广播） |
| Data API v3 查询 | P95 < 500ms（索引命中） |
| TEE 签名延迟 | P95 < 500ms |
| 并发 MCP 连接 | 100+ |
| 事件索引入库延迟 | < 3 个区块 |
| API Key 加密 | bcrypt hash |
| MCP 通信 | HTTPS only |
| 审计日志保留 | ≥ 1 年 |

---

## 8. 实施计划

### Phase 1: 数据强化（2 周）

- 创建 event_categories + 迁移 events_v3
- Data API v3（9 端点）
- DC MCP v2（9 tools）
- 测试 + 文档

### Phase 2: TEE 钱包（3 周）

- TEE Enclave 环境搭建
- 密钥生成/分片/签名/交易广播
- Session token 机制
- 16 个 MCP tools
- 安全审计

### Phase 3: 品牌 MCP 发布（1 周）

- InfraX Hub MCP Server (:9120)
- OpenAPI 3.1 spec
- SkillHub Skill 编写 + 发布
- ClawHub + MCP Hub 注册

---

## 9. 附录

### 术语表

| 术语 | 说明 |
|------|------|
| **MCP** | Model Context Protocol，AI Agent 与外部工具标准协议 |
| **TEE** | Trusted Execution Environment，硬件安全执行环境 |
| **MPC** | Multi-Party Computation，多方安全计算 |
| **Attestation** | TEE 远程证明，验证 Enclave 身份和完整性 |
| **DC** | Data Center，InfraX 链上数据中心 |

### 参考资料

- InfraX: https://github.com/sftgroup/infrax
- MCP: https://modelcontextprotocol.io
- ClawHub: https://clawhub.ai
