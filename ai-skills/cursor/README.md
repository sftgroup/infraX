# Cursor 插件（.cursor-plugin）

## 安装

1. 将 [plugin.json](.cursor-plugin/plugin.json) 安装为 Cursor 插件，或将 `mcpServers` 段合并进 `.cursor/mcp.json`：

```json
{
  "mcpServers": { ... 见 plugin.json ... }
}
```

2. 技能规则：将 `skills/*/SKILL.md` 内容映射为 `.cursor/rules/` 规则文件（每 skill 一个 `.mdc`），Cursor 的 Agent 即可按规则调用 MCP 工具。

3. 配置鉴权：环境变量 `INFRAX_MCP_API_KEY`（项目 `.env` 或系统环境）。

## 说明

- 端口为生产默认值；dev 环境把 `localhost:91xx` 换成 `localhost:30xx`。
- 规则内容建议由发布流水线从 SKILL.md 自动生成（见仓库 README 维护约定）。
