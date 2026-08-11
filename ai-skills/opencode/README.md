# OpenCode 插件（.opencode）

## 安装

```bash
# 1) 复制插件到 OpenCode 插件目录
cp -r .opencode ~/.config/opencode/plugin/infrax-skills

# 2) MCP 服务器：将 plugin.json "mcp" 段并入 ~/.config/opencode/opencode.json 的 mcp 配置
#    （或直接复用仓库 shared/mcp-config.json）

# 3) 配置鉴权
export INFRAX_MCP_API_KEY="<MCP_API_KEY 或 mx_ 签发 key>"
```

## 命令

- `/skills` — 列出 InfraX 技能
- `/infrax-quickstart` — 快速开始指南

## 说明

- 端口为生产默认值；dev 环境替换为本地端口。
- 技能定义见 `../skills/*/SKILL.md`，OpenCode 的 Agent 通过 MCP 工具描述自动选择调用。
