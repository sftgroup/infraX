# Understand-Anything 安装与命令参考

> Source: https://github.com/Lum1104/Understand-Anything  |  v2.9.4  
> 安装位置: `/tmp/Understand-Anything`

## 已安装状态

```
Location:   /tmp/Understand-Anything
Version:    2.9.4
Build:      packages/core/dist/ + packages/skill/dist/
Runtime:    node v18.19.1 + pnpm 10.6.2
```

## 8 个 Skills

| Skill | 文件 | 用途 |
|-------|------|------|
| `/understand` | `skills/understand/SKILL.md` | 完整代码分析管道（7阶段） |
| `/understand-chat` | `skills/understand-chat/SKILL.md` | 基于图谱的代码问答 |
| `/understand-dashboard` | `skills/understand-dashboard/SKILL.md` | 交互式可视化面板 |
| `/understand-diff` | `skills/understand-diff/SKILL.md` | Git diff 分析 |
| `/understand-onboard` | `skills/understand-onboard/SKILL.md` | 新成员入职文档 |
| `/understand-explain` | `skills/understand-explain/SKILL.md` | 代码解释 |
| `/understand-domain` | `skills/understand-domain/SKILL.md` | 领域上下文提取 |
| `/understand-knowledge` | `skills/understand-knowledge/SKILL.md` | 知识库解析 |

## 关键脚本

| 脚本 | 位置 | 用途 |
|------|------|------|
| `scan-project.mjs` | `skills/understand/` | 扫描项目文件和语言 |
| `extract-structure.mjs` | `skills/understand/` | tree-sitter 结构提取 |
| `build-fingerprints.mjs` | `skills/understand/` | 构建文件指纹 |
| `extract-import-map.mjs` | `skills/understand/` | 依赖关系提取 |
| `compute-batches.mjs` | `skills/understand/` | 计算分析批次 |
| `merge-batch-graphs.py` | `skills/understand/` | 合并批次图谱 |
| `merge-subdomain-graphs.py` | `skills/understand/` | 合并子域图谱 |
| `generate-ignore.mjs` | `skills/understand/` | 生成忽略模式 |

## Agent 管道（5 个 Agent）

```
project-scanner → file-analyzer (xN batches) → architecture-analyzer → tour-builder → graph-reviewer
```

每个 Agent 将中间结果写入 `.ua/intermediate/` 目录，最终组装为 `knowledge-graph.json`。

## 输出目录

```
项目根/
├── .ua/                        ← 新项目数据目录
│   ├── knowledge-graph.json    ← 最终知识图谱
│   ├── config.json             ← 语言/自动更新配置
│   ├── intermediate/           ← 分析中间文件（临时）
│   └── tmp/                    ← 临时文件
└── .understand-anything/       ← 旧版目录（向后兼容）
```

[旧版兼容] 当 `.understand-anything/` 已存在时优先使用，否则新建 `.ua/`。
