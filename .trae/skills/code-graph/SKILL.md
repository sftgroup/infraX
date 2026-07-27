---
name: "code-graph"
description: "AI-powered codebase knowledge graph — analyze, visualize, and understand any project. Uses tree-sitter static analysis + LLM multi-agent pipeline from Understand-Anything (v2.9.4). Invoke to map InfraX architecture, onboard new devs, answer code questions, or visualize dependencies."
---

# InfraX Code Graph — 代码图谱分析

基于 [Understand-Anything](https://github.com/Lum1104/Understand-Anything) (v2.9.4) 为 InfraX 项目生成交互式知识图谱。

**已安装**: `/tmp/Understand-Anything` | **核心**: tree-sitter + LLM 多 Agent 管道 | **输出**: `.ua/knowledge-graph.json`

---

## 决策树

```
你要做什么？
│
├─ 首次使用 / 代码库变更后
│  → Step 1: 运行 /understand 生成图谱
│
├─ 基于图谱提问
│  → Step 2: 运行 /understand-chat <问题>
│
├─ 可视化浏览架构
│  → Step 3: 运行 /understand-dashboard
│
└─ 问题排查 / 手动操作
   → Step 4: 直接查询 JSON 或运行脚本
```

---

## Step 1: `/understand` — 完整代码分析

分析 InfraX 代码库，生成 `knowledge-graph.json`。

### 快速开始

```
/understand [--full] [--language zh] [--exclude "patterns"]
```

### 7 阶段管道

```
[Phase 0/7] Pre-flight — 确定增量/完整分析
[Phase 1/7] 扫描项目 — 发现文件、语言、框架
[Phase 2/7] 分析文件 — 树解析 + LLM 摘要（分批并行）
[Phase 3/7] 架构分析 — 层划分、跨文件关系
[Phase 4/7] 合并图谱 — 组装完整知识图谱
[Phase 5/7] 构建导览 — 生成代码导览路径
[Phase 6/7] 验证 — 结构校验 + 可选 LLM 审查
[Phase 7/7] 清理中间文件
```

### 关键选项

| 选项 | 说明 |
|------|------|
| `--full` | 强制完整重建 |
| `--language zh` | 中文内容生成 |
| `--review` | LLM 图形审查 |
| `--exclude "tests/*"` | 排除文件模式 |
| `--auto-update` | 提交时自动更新 |

### 输出示例

```
[Phase 1/7] 扫描项目...
Phase 1 complete. 发现 247 个文件，7 种语言。

[Phase 2/7] 分析文件 (12 批次)...
Analyzing batch 1/12 (files: core.js, nc-wallet.js, mpc-wallet.js...)
...
知识图谱已生成: .ua/knowledge-graph.json
节点: 847, 边: 2341, 层: 5
```

---

## Step 2: `/understand-chat` — 图谱问答

基于知识图谱回答代码库问题。

### 用法

```
/understand-chat 支付模块和WaaS模块之间的关系是什么？
/understand-chat MPC钱包的注册流程涉及哪些文件？
/understand-chat 列出所有使用 afetch 的地方
```

### 查询策略

1. **搜索节点**: `grep -i "keyword" .ua/knowledge-graph.json`
2. **找边**: 在 edges 中追踪依赖关系
3. **读层**: 理解架构分层
4. **跟导览**: 遍历 tour 路径

### 图谱节点类型

```
文件: file:projects/web/server.js
函数: function:projects/web/modules/core.js:afetch
类:   class:projects/vault/src/index.ts:VaultService
模块: module:web
概念: concept:authentication
配置: config:projects/web/package.json
服务: service:mpc-wallet
```

---

## Step 3: `/understand-dashboard` — 交互可视化

启动 React Flow 交互式面板。

### 用法

```
/understand-dashboard
/understand-dashboard /path/to/project
```

### 面板特性

- **左侧导航**: Overview → Tenants → Transactions → Risk Center
- **图表区**: 75% 画布 + 360px 右侧边栏
- **节点信息**: 点击节点查看摘要、标签、复杂度
- **文件浏览**: 右侧 Files 标签页浏览项目树
- **代码查看**: 底部滑出 prism-react-renderer 源码查看器
- **深色主题**: 暖矿物黑 + 金箔金 accent

### 启动方式

```bash
# 使用预构建 viewer (推荐)
npx --yes "https://github.com/Egonex-AI/Understand-Anything/releases/download/v2.9.4/understand-anything-viewer.tgz" .

# 或从本地安装启动
cd /tmp/Understand-Anything && pnpm dev:dashboard
```

---

## Step 4: 直接操作图谱

### 手动查询

```bash
# 搜索所有 MPC 相关节点
grep -i '"mpc"' .ua/knowledge-graph.json

# 搜索所有 import 边
grep '"imports"' .ua/knowledge-graph.json

# 查看项目元数据
head -20 .ua/knowledge-graph.json

# 查看层结构
grep -A 5 '"layers"' .ua/knowledge-graph.json

# 查看导览
grep -A 5 '"tour"' .ua/knowledge-graph.json
```

### 运行独立脚本

```bash
export PLUGIN_ROOT=/tmp/Understand-Anything/understand-anything-plugin

# 扫描项目
node "$PLUGIN_ROOT/skills/understand/scan-project.mjs" .

# 提取结构
node "$PLUGIN_ROOT/skills/understand/extract-structure.mjs" --dir projects/web

# 构建指纹
node "$PLUGIN_ROOT/skills/understand/build-fingerprints.mjs" .
```

---

## InfraX 专用配置

### 排除模式建议

```
--exclude "node_modules/*,.git/*,dist/*,build/*,*.lock,*.map"
```

### 语言检测

InfraX 主要语言会被自动检测:
- TypeScript (`.ts`) — 大部分服务
- JavaScript (`.js`) — Web 前端
- Python (`.py`) — 工具脚本
- HTML (`.html`) — 页面
- CSS — 样式

### 预期图谱规模

基于项目规模估计:
- 节点: ~400-600 (文件、函数、类、模块)
- 边: ~800-1500 (import、调用、依赖)
- 层: 5-8 (前端、API代理、后端服务、数据库、MCP)

---

## 安装与维护

### 重新构建

```bash
cd /tmp/Understand-Anything
export PATH="$HOME/.local/npm-global/bin:$PATH"
pnpm install
pnpm --filter @understand-anything/core build
pnpm --filter @understand-anything/skill build
```

### 更新到最新版

```bash
cd /tmp/Understand-Anything
git pull origin main
pnpm install && pnpm -r build
```

---

## 参考文件

- [references/graph-schema.md](references/graph-schema.md) — 知识图谱 JSON 结构
- [references/install-reference.md](references/install-reference.md) — 完整安装和命令参考
- `/tmp/Understand-Anything/understand-anything-plugin/skills/` — 8 个原始 SKILL.md
- https://github.com/Lum1104/Understand-Anything — 上游仓库
