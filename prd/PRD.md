# InfraX — 品牌化 MCP & Skill 产品需求文档 v1.1

> 版本: v1.1 | 日期: 2026-07-30 | 状态: 待审阅 | 作者: Wayne (team1)
>
> **v1.1 更新**: 对齐现有代码库 — MCP 48 tools / SDK `infrax-dk` v0.1.0 / 12 systemd 服务

---

## 0. 现有资产盘点（不复读造轮子）

### 0.1 MCP Server（4个，48 tools）

| MCP | 端口 | 文件 | Tools | 实现方式 |
|------|:---:|------|:---:|------|
| **Wallet MCP** | 9110 | `mcp-server/src/index.ts` | 10 | 手写 JSON-RPC handler |
| **DC MCP** | 9103 | `mcp-server/src/dc-index.ts` | 7 | **官方 MCP SDK** (`@modelcontextprotocol/sdk`) |
| **MPC MCP** | 9105 | `mcp-server/src/mpc-index.ts` | 15 | 手写 JSON-RPC handler |
| **Vault MCP** | 9108 | `mcp-server/src/vault-index.ts` | 13 | 手写 JSON-RPC handler |

> ⚠️ **技术债**: 3/4 用同一套手写 handler 模版，仅 DC 用官方 SDK。新增 hub-index.ts 应统一用官方 SDK。

### 0.2 SDK（已发布 npm）

- 包名: `infrax-dk` v0.1.0
- 位置: `projects/sdk/src/index.ts`（~750 行）
- 7 个模块: Wallet/Safe/Payment/SaaS/DC/Vault/MPC
- 使用方式: `new InfraX({ baseUrl, apiKey })`

### 0.3 后端服务（12个 systemd）

| 服务 | 端口 | DB |
|------|:---:|-----|
| infrax-waas | 9109 | pocketx_waas (17表) |
| infrax-vault | 9107 | pocketx_vault (4表) |
| infrax-dc | 9102 | pocketx_dc + pocketx_collector |
| infrax-mpc | 9104 | pocketx_mpc (2表) |
| infrax-payment | 9106 | pocketx_payment (3表) |
| infrax-collector | 9101 | pocketx_collector (10+表) |
| infrax-admin | 9100 | pocketx_admin + 跨7DB |
| infrax-web | 9111 | — (SPA + proxy) |
| infrax-dc-mcp | 9103 | — |
| infrax-mpc-mcp | 9105 | — |
| infrax-vault-mcp | 9108 | — |
| infrax-wallet-mcp | 9110 | — |

---

## 1. 产品概述

### 1.1 产品背景

InfraX v0.3.2，12 微服务，5 链覆盖，REST/MCP/SDK 三接入。48 个 MCP tools + `infrax-dk` npm 包 + ClawHub Skill 已有雏形。

**当前瓶颈**:
1. MCP 散落 4 端口，无法作为统一品牌发布
2. DC 数据无分类标签，Agent 查不到 "Uniswap Sepolia 最近的 Swap"
3. MPC 钱包基于邮件验证码，不符合 TEE 安全标准

### 1.2 产品目标

| # | 目标 | 优先级 | 基于现有 |
|:---:|------|:---:|------|
| 1 | **MCP Hub 统一入口** — 新增 `hub-index.ts`，聚合成单一品牌 MCP Server | P0 | `mcp-server/` 已有 4 个 index |
| 2 | **DC 数据分类升级** — `dc-index.ts` 扩展 → v2，支持 category/label 过滤 | P0 | `dc-index.ts` 已有 7 tools |
| 3 | **MPC → TEE 钱包** — `mpc-index.ts` 重构，签名切 TEE Enclave | P0 | `mpc-index.ts` 已有 15 tools |
| 4 | **SkillHub 发布** — SKILL.md + MCP config，引用 `infrax-dk` | P0 | SDK 已发布 npm |
| 5 | **OpenAPI 3.1** — 自动生成 spec，提交 MCP 市场 | P1 | 现有 REST API |
| 6 | **去中心化 MCP 节点** — 第三方可部署 InfraX MCP node | P2 | systemd 部署已有 |

---

## 2. MCP Hub 统一入口设计（P0）

### 2.1 策略：新增 hub-index.ts，不改现有 4 个

```
mcp-server/src/
├── index.ts           ← Wallet MCP (不改)
├── dc-index.ts        ← DC MCP v2 (扩展)
├── mpc-index.ts       ← MPC MCP → TEE MCP (重构)
├── vault-index.ts     ← Vault MCP (不改)
└── hub-index.ts       ← 🆕 品牌统一入口，聚合 48 tools
```

**hub-index.ts 架构**:
```
hub-index.ts (:9120)
    │
    ├── 启动时 import 4 个模块的 tool 定义
    ├── 统一 MCP Server (官方 SDK)
    ├── /mcp/message → JSON-RPC（聚合所有 tools）
    ├── /mcp/sse → SSE 流式
    ├── /openapi.json → 自动生成 OpenAPI 3.1
    ├── /mcp/.well-known → MCP 市场注册端点
    └── /health → 健康检查（含 4 子 MCP 状态）
```

### 2.2 技术实现

```typescript
// hub-index.ts 伪代码
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({
  name: "infrax",
  version: "1.0.0",
  description: "InfraX Web3 Infrastructure MCP — 48+ tools for blockchain data, wallets, multisig, and TEE signing"
});

// 聚合所有 modules
await server.registerModule("./dc-index.ts", { prefix: "dc" });
await server.registerModule("./mpc-index.ts", { prefix: "tee" });  // 改名体现 TEE
await server.registerModule("./vault-index.ts", { prefix: "vault" });
await server.registerModule("./index.ts", { prefix: "wallet" });
```

### 2.3 统一 Tools 列表（48 → 统一前缀）

| 域 | 现有 tools | 统一后前缀 |
|------|:---:|------|
| Wallet | 10 | `wallet_*` |
| DC | 7 → 9（v2 扩展） | `dc_*` |
| MPC → TEE | 15 | `tee_*` |
| Vault | 13 | `vault_*` |
| **合计** | **48** | |

---

## 3. DC 数据强化（P0）

### 3.1 现状 vs 目标

| 维度 | 现有 `dc-index.ts` (7 tools) | v2 目标 (9 tools) |
|------|------|------|
| 事件查询 | `dc_events`（chain/address/event_type） | **`dc_events`**（新增 category/label 参数） |
| 统计 | `dc_stats` | **`dc_stats`**（新增分类维度） |
| 检查点 | `dc_checkpoints` | 保留 |
| 套餐 | `dc_plans` | 保留 |
| 代币 | `dc_tokens` | 保留 |
| 链 | `dc_chains` | 保留 |
| 价格 | `dc_price` (Binance) | 保留 |
| 🆕 | — | **`dc_categories`** — 列出所有分类/标签 |
| 🆕 | — | **`dc_event_detail`** — 单笔交易解码详情 |

### 3.2 事件分类体系

#### 一级分类（category_id）

`dex` | `lending` | `nft` | `bridge` | `staking` | `governance` | `transfer` | `contract` | `deploy` | `other`

#### 二级标签（label_id，按协议）

| 协议 | Category | 链 |
|------|------|------|
| Uniswap V2/V3 | dex | ETH/BSC/Base/Sepolia |
| PancakeSwap | dex | BSC |
| Aave V3 | lending | ETH/Base |
| Compound | lending | ETH |
| OpenSea/Blur | nft | ETH/Base |
| Lido | staking | ETH |
| OxaBridge | bridge | OxaChain/ETH |

### 3.3 DC MCP v2 新增 tool 示例

```json
// dc_categories
{
  "categories": [
    { "category_id": "dex", "name": "DEX 交易", "labels": ["uniswap_v3", "pancakeswap"] },
    { "category_id": "lending", "name": "借贷", "labels": ["aave_v3", "compound"] }
  ]
}

// dc_events（新参数）
// Agent 调用: dc_events(chain="ethereum", category="dex", label="uniswap_v3", from="2026-07-29")
```

### 3.4 数据层改动

| 改动 | 文件 | 说明 |
|------|------|------|
| 新增 event_categories 表 | DC migration | 分类+标签静态数据 |
| events 表加 category_id/label_id 列 | DC migration | 索引加速 |
| collector 加事件分类逻辑 | `projects/collector/` | 匹配已知合约地址 → 分类 |
| dc-index.ts 扩展 | `mcp-server/src/dc-index.ts` | +2 tools，事件查询加参数 |

---

## 4. MPC → TEE 钱包升级（P0）

### 4.1 现状 `mpc-index.ts`（15 tools）

| tool | 说明 |
|------|------|
| `mpc_send_code` | 发邮件验证码 |
| `mpc_register` | 注册钱包（需验证码） |
| `mpc_recover` | 恢复钱包 |
| `mpc_status` | 查钱包状态 |
| `mpc_create_wallet` | 一键创建 |
| `mpc_session_unlock` | 解锁 → 返回 session token |
| `mpc_session_lock` | 锁定 |
| `mpc_session_status` | 查会话状态 |
| `mpc_balance` | 查余额 |
| `mpc_sign_message` | EIP-191 签名 |
| `mpc_sign_typed_data` | EIP-712 签名 |
| `mpc_send_transaction` | 转账（0.1 ETH 限额） |
| `mpc_contract_read` | 合约只读 |
| `mpc_contract_write` | 合约写（staticCall 模拟→签名→广播） |
| `mpc_gas_estimate` | Gas 估算 |

> ⚠️ 这 15 个 tool 的功能逻辑**全部保留**，只改底层签名实现。

### 4.2 升级策略：底层切 TEE，接口不变

```
现有 mpc-index.ts
    │
    │  mpmpc_sign_message / mpc_send_transaction / mpc_contract_write
    │  当前: POST → MPC API (:9104) → 服务端内存签名
    │
    ▼ 重构
改后 mpc-index.ts → 改名 tee-index.ts
    │
    │  tee_sign_message / tee_send_transaction / tee_contract_write
    │  改后: POST → TEE API (:9104) → TEE Enclave 内签名
    │
    ▼
TEE Enclave (Intel SGX / AWS Nitro)
    │ 密钥生成 + 签名 + attestation 全部在 Enclave 内
    │ 私钥永不离 Enclave
```

### 4.3 改动清单

| 改动 | 文件 | 说明 |
|------|------|------|
| **MPC API 底层切换** | `projects/mpc/server.ts` | 签名逻辑从 Node.js crypto → 转发 TEE Enclave |
| **新增 TEE Service** | `projects/mpc/services/tee.ts` | TEE Enclave 客户端（attestation 验证+签名请求） |
| **MCP 改名** | `mcp-server/src/mpc-index.ts` → `tee-index.ts` | tool 前缀 `mpc_` → `tee_` |
| **新增 swap tool** | `tee-index.ts` | `tee_swap` — DEX 代币兑换 |
| **新增 approve tool** | `tee-index.ts` | `tee_approve` — ERC20 授权 |
| **限额强化** | `tee-index.ts` + `mpc/server.ts` | 单笔限额可配置，单日累计限额，白名单 DEX 路由 |
| **环境搭建** | `deploy/` | SGX/Nitro Enclave Docker + systemd unit |

### 4.4 TEE 钱包 vs 现有 MPC（对比）

| 维度 | 现有 | TEE 后 |
|------|------|------|
| 密钥生成 | 服务端 Node.js | TEE Enclave 内 |
| 签名 | 服务端内存 | TEE Enclave 内 |
| 私钥保护 | ❌ 服务端可访问内存 | ✅ 硬件隔离 |
| 远程证明 | ❌ | ✅ SGX Quote / Nitro Attestation |
| tools 数量 | 15 | **17**（+tee_swap +tee_approve） |
| 接口兼容 | — | ✅ 17 tools 参数不变，仅前缀改名 |

> ⚠️ **2026-08-08 架构决策更新（MQ-10 补充 E）**：TEE 升级**降级为可选（P3）**——PRD 明示 SGX/Nitro 硬件不支持当前服务器。MPC 钱包的可用性目标改为**「分片加密 + 邮箱恢复」**（替代 TEE 达成"用户无需备份私钥/助记词"），签名授权由 Session Key Engine + aa-sdk Kernel v3 链上 session validator 承担（见 tasklist MQ-10 补充 E-1~E-4）。

### 4.5 MPC 独立 SDK（需求新增，2026-08-08）

**需求背景**：MPC 是独立微服务（场景一：Agent 托管钱包——用户不可直接控制、Agent 全权、邮箱恢复）。调用方（AI Agent / 业务系统）不应依赖整包 `infrax-dk`，需要**独立、轻量的 MPC SDK**。

**需求内容**：
1. **独立发布**：`@0xinfrax/mpc-sdk`（或 `infrax-dk` 子路径导出 `infrax-dk/mpc`），仅依赖 MPC 服务契约，不引入其余模块；版本与 `infrax-dk` 解耦、独立演进。
2. **能力覆盖（对齐 MPC MCP 15 tools）**：
   - 钱包：`sendCode / register / recover / status / createWallet`
   - 会话：`unlockSession / lockSession / sessionStatus`
   - 链上：`balance / signMessage / signTypedData / sendTransaction / contractRead / contractWrite / gasEstimate`
3. **恢复流程一等公民**：`recover` 显式封装「邮箱验证码 → 分片重建 → 地址校验」完整流程（对应 tasklist E-2b）。
4. **类型安全**：与 `infrax-dk` 一致的 TS 类型导出（`MPCWalletResult / MPCSessionStatus / MPCBalanceResult` 等），错误码对齐 MPC API（401/403/409/429）。
5. **鉴权对齐**：出站沿用 `x-api-key` / 签名头契约；入站（经 MCP 调用时）沿用 `inboundAuth`（`MCP_API_KEY`）。

**验收**：`npm i @0xinfrax/mpc-sdk` 后仅用该包完成「注册 → 解锁 → 转账」全流程；SDK 测试覆盖恢复失败分支（验证码错误/过期/重复使用）。

---

## 5. SkillHub 品牌 Skill（P0）

### 5.1 Skill 包结构

```
infrax-skill/
├── SKILL.md          ← 品牌 Skill 定义（触发词 + 描述 + 使用示例）
├── mcp-config.json   ← MCP Server 连接配置
└── README.md
```

### 5.2 SKILL.md 核心内容

```markdown
---
name: infrax
description: InfraX Web3 Infrastructure — 区块链数据、TEE 安全钱包、多签保险库、支付引擎
---

# InfraX Skill

Install: `openclaw skills install infrax`

## Quick Start
1. Sign up at https://infrax.ai → Get API Key
2. `openclaw skills install infrax`
3. Say "查 Sepolia 上 Uniswap 最近的 swap" or "用 InfraX 向 0x... 发 0.01 ETH"
```

### 5.3 mcp-config.json

```json
{
  "mcpServers": {
    "infrax": {
      "url": "https://api.infrax.ai/mcp/message",
      "transport": "streamable-http",
      "env": {
        "INFRAX_API_KEY": "${INFRAX_API_KEY}"
      }
    }
  }
}
```

### 5.4 SDK 集成（引用现有 `infrax-dk`）

Skill 安装后，Agent 可通过 `infrax-dk` npm 包直接调用：
```typescript
import InfraX from 'infrax-dk';
const infrax = new InfraX({ apiKey: process.env.INFRAX_API_KEY });
```

---

## 6. MCP 市场发布计划

### 6.1 市场列表

| 市场 | 发布物 | 优先级 |
|------|------|:---:|
| **ClawHub** | SKILL.md + mcp-config.json | P0 |
| **MCP Hub** (mcp.so) | `hub-index.ts` URL + OpenAPI spec | P0 |
| **OpenAI GPT Store** | OpenAPI 3.1 spec → GPT Action | P1 |
| **Cursor MCP** | mcp-config.json | P1 |
| **Claude MCP** | mcp-config.json | P1 |
| **GitHub** | 公开 `hub-index.ts` + 文档 | P1 |

### 6.2 开放端点

| 端点 | 用途 |
|------|------|
| `https://api.infrax.ai/mcp/message` | MCP JSON-RPC 统一入口 |
| `https://api.infrax.ai/mcp/sse` | MCP SSE 流式 |
| `https://api.infrax.ai/mcp/.well-known` | MCP 服务发现 |
| `https://api.infrax.ai/openapi.json` | OpenAPI 3.1 规范 |
| `https://api.infrax.ai/health` | 健康检查 |

---

## 7. 实施计划

### Phase 1: DC 数据强化（1 周）

| # | 任务 | 文件 | 估计 |
|:---:|------|------|:---:|
| 1.1 | event_categories 表 + 分类数据 | DC migration | 1d |
| 1.2 | events 表加 category_id/label_id 列 | DC migration | 0.5d |
| 1.3 | collector 事件分类逻辑 | `projects/collector/` | 2d |
| 1.4 | dc-index.ts 扩展 → v2 (+2 tools) | `mcp-server/src/dc-index.ts` | 2d |
| 1.5 | DC API v3（/api/v3/data/*） | `projects/dc/` | 2d |

### Phase 2: TEE 钱包 + 品牌 MCP Hub（2 周）

| # | 任务 | 文件 | 估计 |
|:---:|------|------|:---:|
| 2.1 | TEE Enclave 环境搭建（SGX/Nitro） | `deploy/` | 2d |
| 2.2 | MPC API 底层切 TEE | `projects/mpc/server.ts` + `services/tee.ts` | 3d |
| 2.3 | mpc-index.ts → tee-index.ts（改名+swap+approve） | `mcp-server/src/tee-index.ts` | 2d |
| 2.4 | 新增 hub-index.ts 统一入口 | `mcp-server/src/hub-index.ts` | 2d |
| 2.5 | hub-index systemd unit | `deploy/systemd/infrax-hub-mcp.service` | 0.5d |

### Phase 3: SkillHub + 多市场发布（1 周）

| # | 任务 | 文件 | 估计 |
|:---:|------|------|:---:|
| 3.1 | SKILL.md + mcp-config.json 编写 | `infrax-skill/` | 1d |
| 3.2 | OpenAPI 3.1 自动生成（从 hub-index.ts） | `mcp-server/src/hub-index.ts` | 1d |
| 3.3 | ClawHub 发布 | — | 0.5d |
| 3.4 | MCP Hub (mcp.so) 注册 | — | 0.5d |
| 3.5 | 其他市场适配 | — | 1d |

---

## 8. 非功能需求

| 指标 | 目标 |
|------|------|
| hub-index 启动延迟 | < 5s |
| MCP tool 响应 | P95 < 2s（查询），P95 < 10s（交易广播） |
| TEE 签名延迟 | P95 < 500ms |
| 并发 MCP 连接 | 100+ |
| 向后兼容 | 现有 4 个 MCP 端口继续运行 30 天过渡期 |

---

## 9. 风险与约束

| 风险 | 缓解 |
|------|------|
| SGX/Nitro 硬件不支持当前服务器 | 先用软件模拟模式（TEE mock），后迁移真机 |
| MPC → TEE tool 改名破坏兼容 | 旧名 `mpc_*` 保留 30 天 → 弃用通知 → 移除 |
| DC 分类覆盖不足 | 初始 10 分类 + 8 协议标签，按需扩展 |

---

## 附录 A: 现有代码文件路径总览

```
sftgroup/infrax/
├── projects/
│   ├── mcp-server/src/
│   │   ├── index.ts          ← Wallet MCP (10 tools, 手写 JSON-RPC)
│   │   ├── dc-index.ts       ← DC MCP (7 tools, 官方 MCP SDK)
│   │   ├── mpc-index.ts      ← MPC MCP (15 tools, 手写 JSON-RPC) → 重构为 tee-index.ts
│   │   ├── vault-index.ts    ← Vault MCP (13 tools, 手写 JSON-RPC)
│   │   └── hub-index.ts      ← 🆕 统一品牌入口
│   ├── sdk/src/index.ts      ← infrax-dk v0.1.0 (750行, 7模块)
│   ├── dc/                   ← DC API :9102
│   ├── mpc/server.ts         ← MPC API :9104 → 核心改动文件
│   ├── mpc/services/         ← MPC 业务逻辑 + 🆕 tee.ts
│   ├── collector/            ← 链上采集 :9101 → 加事件分类
│   └── ...
├── deploy/systemd/           ← systemd unit files (+ 🆕 infrax-hub-mcp.service)
└── docs/
    ├── API_ACCESS.md
    └── MCP_REQUIREMENTS.md
```
