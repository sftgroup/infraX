# Claude Code 插件（.claude-plugin）

## 安装

```bash
# 1) 安装插件
claude plugin install /path/to/ai-skills/.claude-plugin

# 2) 注入 MCP 服务器（或用 claude mcp add 逐个添加）
#    server 列表见 plugin.json "mcp" 段，或复用仓库 shared/mcp-config.json

# 3) 配置鉴权
export INFRAX_MCP_API_KEY="<MCP_API_KEY 或 mx_ 签发 key>"
```

## 技能加载

将 skills 目录链接到 Claude Code 技能目录，AI 即可按描述自动选择：

```bash
ln -s /path/to/ai-skills/skills/* ~/.claude/skills/
```

## 命令

- `/skills` — 列出 InfraX 技能与覆盖工具
- `/infrax-quickstart` — 快速开始指南

## 说明

- 端口为生产默认值（wallet :9110 / vault :9108 / mpc :9105 / dc :9103 / hub :3008 / session-key :3011）；dev 环境替换为本地端口。
- 所有 server 共用一个 `INFRAX_MCP_API_KEY`；引擎侧业务 key 走 systemd drop-in，不在插件内。
