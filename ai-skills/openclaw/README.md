# OpenClaw 插件（.openclaw / ClawHub 发布物）

## 安装

OpenClaw 插件通过 ClawHub 市场分发，本地开发可直接加载本目录：

```bash
# 本地加载
claw plugin add /path/to/ai-skills/openclaw

# 或发布到 ClawHub 后
claw plugin install infrax-skills
```

## 说明

- `plugin.json` 声明 `skills`（指向 `../skills/*/SKILL.md`），OpenClaw 加载后按名称暴露给 AI。
- MCP 服务器注册见 `../shared/mcp-config.json`（OpenClaw 支持 HTTP Streamable transport）。
- 端口为生产默认值；dev 环境替换为本地端口。

## ClawHub 发布检查清单

- [ ] `plugin.json` 名称/版本/描述完整（本文件）
- [ ] 每个 skill 的 SKILL.md frontmatter（name/description）合法
- [ ] 无敏感信息（API Key 走环境变量 `INFRAX_MCP_API_KEY`）
- [ ] 图标与横幅资源（发布时补充，不入 git）
