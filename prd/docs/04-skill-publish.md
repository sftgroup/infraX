# 模块 4: SkillHub 品牌发布

> 关联: PRD §5、§6、架构图 1 `prd/assets/01-system-overview.png`

---

## 1. 目标

将 InfraX 作为品牌 Skill 发布到 ClawHub/SkillHub 及主流 MCP 市场，让 AI Agent 通过 `openclaw skills install infrax` 一键接入。

**复用现有资产**: `infrax-dk` npm 包 (v0.1.0) + Hub MCP :9120。

---

## 2. Skill 包结构

```
projects/infrax-skill/              ← 🆕 新建目录
├── SKILL.md                        ← 品牌 Skill 定义（触发词、描述、使用示例）
├── mcp-config.json                 ← MCP Server 连接配置
├── README.md                       ← 开发者文档
└── examples/
    ├── query-balance.md            ← 查询余额示例
    ├── send-transaction.md         ← 转账示例
    └── query-events.md             ← 数据查询示例
```

---

## 3. SKILL.md 设计

**文件**: `projects/infrax-skill/SKILL.md`

```markdown
---
name: infrax
description: |
  InfraX Web3 基础设施平台。提供区块链数据查询（DC）、TEE 安全钱包、多签保险库（Vault）、
  x402 支付引擎等 48 个 MCP tools。支持 Ethereum/BSC/Base/Sepolia/OxaChain 5 条链。
  当用户需要查询链上数据、发送交易、管理多签钱包、处理加密货币支付时触发。
  NOT for: 非 Web3 场景、DEX 交易分析（非 InfraX 范围）、合约开发。
version: 1.0.0
author: InfraX Team
---

# InfraX Skill

[InfraX](https://infrax.ai) 是 Web3 基础设施平台，提供 48 个 AI Agent 可调用的 MCP tools。

## Quick Start

```bash
# 1. 注册获取 API Key
open https://infrax.ai/dashboard

# 2. 安装 Skill
openclaw skills install infrax

# 3. 设置环境变量
export INFRAX_API_KEY="your-api-key"
```

## Use Cases

| 场景 | 示例指令 |
|------|------|
| 查链上数据 | "查 Sepolia 上 Uniswap 最近的 swap" |
| 转账 | "用 InfraX 向 0x... 发 0.01 ETH" |
| 查余额 | "查我的钱包余额" |
| 合约交互 | "调用合约 0x... 的 balanceOf 方法" |
| 多签安全 | "创建 2/3 多签 Safe" |
| 代币兑换 | "用 InfraX 把 ETH 换成 USDC" |

## Available Tools

### DC — 数据中心 (9 tools)
`dc_categories` `dc_events` `dc_event_detail` `dc_stats` `dc_checkpoints` `dc_plans` `dc_tokens` `dc_chains` `dc_price`

### TEE — 安全钱包 (17 tools)
`tee_create_wallet` `tee_balance` `tee_transfer` `tee_swap` `tee_approve` `tee_sign_message` `tee_sign_typed_data` `tee_contract_read` `tee_contract_write` `tee_gas_estimate` `tee_session_unlock` `tee_session_lock` `tee_session_status` `tee_register` `tee_recover` `tee_status` `tee_send_code`

### Vault — 多签保险库 (13 tools)
`vault_dashboard` `vault_safes` `vault_safe_info` `vault_create_safe` `vault_update_owners` `vault_create_tx` `vault_confirm_tx` `vault_execute_tx` `vault_retry` `vault_execute_ready` `vault_sync` `vault_status` `vault_risk_check`

### Wallet — 钱包服务 (10 tools)
`wallet_balance` `wallet_send` `wallet_simulate` `wallet_rpc` `wallet_health` `wallet_sweep` `wallet_status` `payment_create` `payment_status` `x402_pay`

## SDK

```bash
npm install infrax-dk
```

```typescript
import InfraX from 'infrax-dk';
const infrax = new InfraX({ apiKey: process.env.INFRAX_API_KEY });
const balance = await infrax.wallet.balance({ address: "0x...", chain: "sepolia" });
```

## 注意

- 转账操作需先创建 TEE 钱包并解锁 session
- Free 套餐仅限 Sepolia 测试网数据
- 生产环境使用前请确认 API Key 权限
```

---

## 4. mcp-config.json 设计

**文件**: `projects/infrax-skill/mcp-config.json`

```json
{
  "mcpServers": {
    "infrax": {
      "name": "InfraX Hub",
      "version": "1.0.0",
      "description": "InfraX Web3 Infrastructure — 48+ MCP tools for blockchain data, wallets, multisig, and payments",
      "endpoint": {
        "url": "https://api.infrax.ai/mcp/message",
        "transport": "streamable-http"
      },
      "authentication": {
        "type": "api-key",
        "header": "x-api-key",
        "env": "INFRAX_API_KEY"
      },
      "wellKnown": "https://api.infrax.ai/.well-known",
      "openApiSpec": "https://api.infrax.ai/openapi.json",
      "categories": ["web3", "blockchain", "wallet", "defi"],
      "tags": ["infrax", "web3", "ethereum", "multisig", "wallet", "payment"],
      "links": {
        "website": "https://infrax.ai",
        "docs": "https://docs.infrax.ai",
        "github": "https://github.com/sftgroup/infrax",
        "sdk": "https://www.npmjs.com/package/infrax-dk"
      },
      "pricing": {
        "free": { "chains": ["sepolia"], "rateLimit": "100/day" },
        "pro": { "chains": ["ethereum","bsc","base","sepolia"], "rateLimit": "10,000/day" },
        "enterprise": { "chains": "all", "rateLimit": "unlimited" }
      }
    }
  }
}
```

---

## 5. 发布流程

### 5.1 ClawHub 发布

```bash
cd projects/infrax-skill
openclaw skills publish .
```

### 5.2 MCP Hub (mcp.so) 注册

将 `mcp-config.json` 提交到 MCP Hub registry：

```bash
# 通过 MCP Hub API 注册
curl -X POST https://mcp.so/api/registry/servers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MCP_HUB_TOKEN}" \
  -d @mcp-config.json
```

### 5.3 其他市场

| 市场 | 发布方式 | 文件 |
|------|------|------|
| OpenAI GPT Store | OpenAPI spec → GPT Action | `https://api.infrax.ai/openapi.json` |
| Cursor | `.cursor/mcp.json` 配置 | 分发 mcp-config.json |
| Claude | Claude Desktop config | 分发 mcp-config.json |
| GitHub | 公开 Repo + README | `sftgroup/infrax` |

---

## 6. 用户安装流程

```
用户 → "install infrax skill"
  → openclaw skills install infrax
    → 下载 SKILL.md + mcp-config.json
      → 自动注册 MCP Server
        → 自动测试 tools/list 验证可用
          → ✅ "InfraX 已接入！可用工具：48 tools"
```

---

## 7. 前置依赖

| 依赖 | 状态 | 说明 |
|------|:---:|------|
| Hub MCP :9120 部署 | ⬜ 待开发 | 模块 1 完成后 |
| DC MCP v2 完成 | ⬜ 待开发 | 模块 2 完成后 |
| TEE index 完成 | ⬜ 待开发 | 模块 3 完成后 |
| `infrax-dk` npm 包 | ✅ 已发布 v0.1.0 | 无需改动 |
| 生产域名 `api.infrax.ai` | ⬜ 待配置 | DNS + Nginx |

---

## 8. 测试要点

1. `openclaw skills install infrax` 安装成功
2. 安装后 `tools/list` 返回 48 tools
3. 未设置 API Key 时提示注册链接
4. API Key 设置正确后 tool 调用成功
5. SKILL.md 触发词测试（"查链上数据"、"转账"等）
