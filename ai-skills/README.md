# InfraX AI Skills

对齐 OKX onchainos-skills 的官方 AI 生态 Skills 插件仓库（需求 9.6-6.0）。为 Claude Code / Cursor / OpenCode / Codex / OpenClaw 提供 wallet / dc / vault / mpc / data / payment / session-key 全能力技能，底层复用 InfraX 既有的 MCP 服务器工具。

## 技能矩阵

| Skill | MCP server | 生产端口 | 覆盖工具 |
|-------|-----------|:---:|------|
| [wallet](skills/wallet/SKILL.md) | `infrax-wallet-mcp` | :9110 | wallet_* 7（余额/发送/模拟/RPC/归集/状态/健康） |
| [payment](skills/payment/SKILL.md) | `infrax-wallet-mcp` | :9110 | payment_*/mpp_* 27（fiat/x402/批量/邀请/转账/MPP 通道） |
| [vault](skills/vault/SKILL.md) | `infrax-vault-mcp` | :9108 | vault_* 13（多签全生命周期 + 风险检查） |
| [mpc](skills/mpc/SKILL.md) | `infrax-mpc-mcp` | :9105 | mpc_* 17（注册/会话/签名/交易/合约/gas/计费） |
| [data](skills/data/SKILL.md) | `infrax-hub-index` | :3008 | data_*/ml_*/injector_*/rag_* 13（行情/因子/ML/注入/RAG） |
| [dc](skills/dc/SKILL.md) | `infrax-dc-mcp` | :9103 | dc_* 11（事件/统计/套餐/订阅/价格） |
| [session-key](skills/session-key/SKILL.md) | `infrax-session-key-mcp` | :3011 | sk_* 7（会话密钥授权/执行/吊销，含零签名模式） |

> 各 MCP 服务器工具清单由 `projects/mcp-server/src/*-index.ts` 生成，新增工具后需同步更新对应 SKILL.md 的 `metadata.infrax.tools`。

## 快速接入

### 1. 启动 MCP 服务器（生产已有 systemd unit）

```bash
# 本机开发（mcp-server 目录）
npm run dev         # wallet+payment  (:3004)
npm run dev:vault   # :3006   npm run dev:mpc   # :3007
npm run dev:dc      # :3005   npm run dev:hub   # :3008
npm run dev:sk      # session-key :3011
```

生产端口见上表（systemd unit：`infrax-wallet-mcp.service` / `infrax-vault-mcp.service` / `infrax-mpc-mcp.service` / `infrax-dc-mcp.service` / `infrax-hub-index.service`）。

### 2. 注入 MCP 配置

公共配置片段见 [shared/mcp-config.json](shared/mcp-config.json)，按 IDE 复制到对应位置：

| IDE | 安装方式 |
|-----|----------|
| Claude Code | `claude mcp add` 或 `.mcp.json`；skills 放 `~/.claude/skills/` |
| Cursor | `.cursor/mcp.json` + `.cursor/rules/`（或 [cursor/.cursor-plugin](cursor) 插件） |
| OpenCode | `~/.config/opencode/plugin`（或 [opencode](opencode) 插件） |
| Codex | `~/.codex/plugins`（或 [codex](codex) 插件） |
| OpenClaw | [openclaw](openclaw) 插件（ClawHub 发布物） |

### 3. 配置鉴权

- 环境变量 `INFRAX_MCP_API_KEY`：MCP 服务器 `MCP_API_KEY`（逗号分隔白名单）或 `mx_` 前缀 scope=mcp 的签发 key。
- MPC / vault / payments / DC 引擎侧各自的 API Key 通过 systemd drop-in 注入，不随仓库提交。

## 发布物

- [.claude-plugin](.claude-plugin) — Claude Code 插件（plugin.json）
- [cursor](cursor) / [opencode](opencode) / [codex](codex) / [openclaw](openclaw) — 其余四市场配置
- [docs/QUICKSTART.md](docs/QUICKSTART.md) — 文档与示例（vault MPC 确认 / session-key 零签名模式）

## 目录结构

```
ai-skills/
├── SKILL.md.template        # 新建 skill 的模板
├── shared/mcp-config.json   # 统一 MCP 注册片段
├── skills/<name>/SKILL.md   # 7 组技能定义
├── .claude-plugin/ cursor/ opencode/ codex/ openclaw/   # 五市场发布物
└── docs/QUICKSTART.md       # 示例与最佳实践
```

## 维护约定

- 新增 MCP 工具 → 同步更新 `shared/mcp-config.json`（如新增 server）+ 对应 SKILL.md 工具表与 `metadata.infrax.tools`。
- 各 IDE 插件 manifest 与 `shared/mcp-config.json` 由发布流水线生成（待 9.6 Phase 3 CI 化）。
- 敏感配置（API Key）一律走环境变量，不入库。
