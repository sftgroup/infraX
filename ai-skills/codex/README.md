# Codex 插件（.codex-plugin）

## 安装

```bash
# 1) 复制插件
cp -r .codex-plugin ~/.codex/plugins/infrax-skills

# 2) MCP：将 plugin.json "mcp" 段并入 ~/.codex/config.toml 或插件配置
#    （Codex 支持从 mcpServers 配置接入 Streamable HTTP server）

# 3) 配置鉴权
export INFRAX_MCP_API_KEY="<MCP_API_KEY 或 mx_ 签发 key>"
```

## 命令与技能

- `/skills` — 列出 InfraX 技能
- 技能定义见 `../skills/*/SKILL.md`（frontmatter 中 `metadata.infrax.tools` 供 Codex agent 识别覆盖范围）。

## 说明

- 端口为生产默认值；dev 环境替换为本地端口。
- Codex 插件 manifest 兼容 Claude 风格 `plugin.json`（name/version/description/commands）。
