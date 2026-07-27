#!/bin/bash
# InfraX Code Graph — quick commands
# ====================================
# Usage:
#   ./code-graph.sh scan        — 扫描 InfraX 项目文件
#   ./code-graph.sh structure   — 提取代码结构
#   ./code-graph.sh fingerprints — 构建文件指纹
#   ./code-graph.sh imports     — 提取导入关系
#   ./code-graph.sh query <kw>  — 查询知识图谱
#   ./code-graph.sh dashboard   — 启动可视化面板
#   ./code-graph.sh rebuild     — 重新构建 core + skill
#   ./code-graph.sh status      — 显示状态

set -e
PLUGIN_ROOT="${PLUGIN_ROOT:-/tmp/Understand-Anything/understand-anything-plugin}"
SKILL_DIR="$PLUGIN_ROOT/skills/understand"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
UA_DIR="$PROJECT_DIR/.ua"

case "${1:-help}" in
  scan)
    echo "=== 扫描 InfraX 项目 ==="
    node "$SKILL_DIR/scan-project.mjs" "$PROJECT_DIR" 2>/dev/null || echo "脚本需要完整分析管道，请用 /understand"
    ;;

  query)
    shift
    KW="${1:-}"
    if [ -z "$KW" ]; then echo "Usage: $0 query <keyword>"; exit 1; fi
    if [ -f "$UA_DIR/knowledge-graph.json" ]; then
      echo "=== 搜索: $KW ==="
      grep -i "$KW" "$UA_DIR/knowledge-graph.json" | head -20
    else
      echo "图谱未生成。请先运行 /understand"
    fi
    ;;

  dashboard)
    echo "=== 启动可视化面板 ==="
    cd /tmp/Understand-Anything
    export PATH="$HOME/.local/npm-global/bin:$PATH"
    GRAPH_DIR="$PROJECT_DIR" pnpm --filter @understand-anything/dashboard dev 2>/dev/null || \
      npx --yes "https://github.com/Egonex-AI/Understand-Anything/releases/download/v2.9.4/understand-anything-viewer.tgz" "$PROJECT_DIR"
    ;;

  rebuild)
    echo "=== 重新构建 ==="
    cd /tmp/Understand-Anything
    export PATH="$HOME/.local/npm-global/bin:$PATH"
    pnpm --filter @understand-anything/core build
    pnpm --filter @understand-anything/skill build
    echo "构建完成"
    ;;

  status)
    echo "=== Code Graph Status ==="
    echo "Plugin root:  $PLUGIN_ROOT"
    echo "Project dir:  $PROJECT_DIR"
    echo "Data dir:     $UA_DIR"
    echo ""
    if [ -f "$UA_DIR/knowledge-graph.json" ]; then
      echo "✓ knowledge-graph.json exists"
      echo "  Size: $(du -h "$UA_DIR/knowledge-graph.json" | cut -f1)"
      NODES=$(grep -c '"id":' "$UA_DIR/knowledge-graph.json" 2>/dev/null || echo "?")
      echo "  Nodes: ~$NODES"
    else
      echo "✗ No knowledge graph yet. Run /understand first."
    fi
    echo ""
    echo "Core dist:  $(ls "$PLUGIN_ROOT/packages/core/dist/" 2>/dev/null | wc -l) files"
    echo "Skill dist: $(ls "$PLUGIN_ROOT/dist/" 2>/dev/null | wc -l) files"
    ;;

  help|*)
    echo "InfraX Code Graph"
    echo "================="
    echo "  scan           扫描项目文件"
    echo "  query <kw>     查询知识图谱"
    echo "  dashboard      启动可视化面板"
    echo "  rebuild        重新构建"
    echo "  status         显示状态"
    echo ""
    echo "Main commands (via AI agent):"
    echo "  /understand    完整代码分析（7 阶段管道）"
    echo "  /understand-chat <q>  图谱问答"
    echo "  /understand-dashboard 交互可视化"
    ;;
esac
