#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  InfraX Browser Tester — Three-tier testing wrapper         ║
# ║                                                            ║
# ║  Tier 1: playwright-cli   — daily quick tests (low token)   ║
# ║  Tier 2: @playwright/mcp  — MCP agent integration           ║
# ║  Tier 3: chrome-devtools  — performance debugging           ║
# ╚══════════════════════════════════════════════════════════════╝
#
# Usage:
#   ./browser-test.sh <command> [options]
#
# Tier 1 — playwright-cli (fast, low token):
#   login       Test private key login flow
#   modules     Navigate all 5 modules (mpc/waas/safe/dc/pay)
#   admin       Test admin login page
#   console     Open page and show console + network
#   snapshot    Quick page load + snapshot
#   eval "<js>" Run JS on the current page
#
# Tier 2 — @playwright/mcp (MCP integration):
#   mcp-start   Start @playwright/mcp server (headless)
#   mcp-headed  Start @playwright/mcp server (headed, for local)
#   mcp-persist Start with persistent session
#
# Tier 3 — chrome-devtools-mcp (performance):
#   perf-start  Start chrome-devtools-mcp for perf analysis
#   perf-trace  Start with tracing enabled
#
# Management:
#   close-all   Close all browser sessions
#   kill-all    Forcefully kill all browser processes
#   status      Show installed tools and versions
#   help        This help message

set -e
INFRAX_URL="${INFRAX_URL:-http://43.156.99.215:9111}"
TEST_PK="0xb1eb7c5b3ad9ea36d62e744c4bd07dfb99b0605c2675faaaf8f9c4121ecd8644"
ADMIN_PASS="${ADMIN_PASS:-a87cefd6e1ce487334a67b0c}"

snapshot() {
  local name="${1:-page}"
  playwright-cli snapshot --filename="snapshot-${name}-$(date +%H%M%S).yml" 2>/dev/null || echo "(snapshot unavailable, try interactive mode)"
}

# ══════════════════════════════════════════════
# Tier 1: playwright-cli — daily quick testing
# ══════════════════════════════════════════════

case "${1:-help}" in

  # --- Login flow ---
  login)
    echo "=== [Tier 1] Private Key Login ==="
    playwright-cli open "$INFRAX_URL/index.html"
    sleep 3
    snapshot "login-01-connect"
    playwright-cli find "Private Key"
    echo "→ Find 'Private Key' tab in snapshot and click it"
    echo "→ Then: playwright-cli fill <ref> '$TEST_PK' --submit"
    ;;

  # --- Module navigation ---
  modules)
    echo "=== [Tier 1] Module Navigation ==="
    playwright-cli open "$INFRAX_URL/index.html"
    sleep 3
    for mod in mpc waas safe dc pay; do
      echo "  → $mod"
      playwright-cli click "[data-page='$mod']" 2>/dev/null || echo "  (nav element not in current page)"
      sleep 1
      snapshot "module-${mod}"
    done
    playwright-cli close
    ;;

  # --- Admin login ---
  admin)
    echo "=== [Tier 1] Admin Login Page ==="
    playwright-cli open "$INFRAX_URL/admin-login.html"
    sleep 2
    snapshot "admin-login"
    playwright-cli find "Sign in"
    echo "→ Fill form with: playwright-cli fill <user-ref> 'admin'"
    echo "→                  playwright-cli fill <pass-ref> '\$ADMIN_PASS' --submit"
    ;;

  # --- Console + network inspection ---
  console)
    echo "=== [Tier 1] Console + Network ==="
    playwright-cli open "$INFRAX_URL/index.html"
    sleep 3
    echo "--- Console (all) ---"
    playwright-cli console
    echo "--- Console (warnings+) ---"
    playwright-cli console warning
    echo "--- Network Requests ---"
    playwright-cli requests
    playwright-cli close
    ;;

  # --- Quick snapshot ---
  snapshot)
    echo "=== [Tier 1] Quick Snapshot ==="
    playwright-cli open "$INFRAX_URL"
    sleep 3
    snapshot "quick"
    playwright-cli close
    ;;

  # --- Run JS eval ---
  eval)
    shift
    echo "=== [Tier 1] JS Eval ==="
    playwright-cli eval "$@"
    ;;

  # ══════════════════════════════════════════════
  # Tier 2: @playwright/mcp — MCP agent integration
  # ══════════════════════════════════════════════

  mcp-start)
    echo "=== [Tier 2] Starting @playwright/mcp (headless) ==="
    echo "MCP endpoint: stdio. Connect your MCP client to this process."
    echo ""
    npx @playwright/mcp@latest \
      --headless \
      --no-sandbox \
      --viewport-size=1280x720 \
      --browser=chrome \
      --isolated \
      --console-level=warning \
      --timeout-action=10000
    ;;

  mcp-headed)
    echo "=== [Tier 2] Starting @playwright/mcp (headed) ==="
    echo "Browser will be visible. Use for local debugging."
    echo ""
    npx @playwright/mcp@latest \
      --browser=chrome \
      --viewport-size=1280x720
    ;;

  mcp-persist)
    echo "=== [Tier 2] Starting @playwright/mcp (persistent session) ==="
    echo "Session saved to /tmp/infrax-mcp-sessions"
    mkdir -p /tmp/infrax-mcp-sessions
    npx @playwright/mcp@latest \
      --browser=chrome \
      --viewport-size=1280x720 \
      --save-session \
      --output-dir=/tmp/infrax-mcp-sessions
    ;;

  # ══════════════════════════════════════════════
  # Tier 3: chrome-devtools-mcp — performance
  # ══════════════════════════════════════════════

  perf-start)
    echo "=== [Tier 3] Starting chrome-devtools-mcp ==="
    echo "Performance debugging mode. Connect MCP client."
    echo "Log: /tmp/infrax-cdt-mcp.log"
    echo ""
    npx chrome-devtools-mcp@latest \
      --headless \
      --chrome-arg='--no-sandbox' \
      --chrome-arg='--disable-setuid-sandbox' \
      --viewport=1280x720 \
      --isolated \
      --logFile=/tmp/infrax-cdt-mcp.log \
      --screenshot-format=jpeg \
      --screenshot-quality=80
    ;;

  perf-trace)
    echo "=== [Tier 3] Starting chrome-devtools-mcp (with network analysis) ==="
    echo ""
    npx chrome-devtools-mcp@latest \
      --headless \
      --chrome-arg='--no-sandbox' \
      --chrome-arg='--disable-setuid-sandbox' \
      --viewport=1280x720 \
      --isolated \
      --logFile=/tmp/infrax-cdt-mcp.log
    echo ""
    echo "→ After connecting: use performance_start_trace / performance_stop_trace"
    ;;

  # ══════════════════════════════════════════════
  # Management
  # ══════════════════════════════════════════════

  close-all)
    echo "=== Closing all browser sessions ==="
    playwright-cli close-all 2>/dev/null || true
    playwright-cli kill-all 2>/dev/null || true
    pkill -f "chrome-devtools-mcp" 2>/dev/null || true
    echo "Done."
    ;;

  status)
    echo "=== InfraX Browser Tester Status ==="
    echo ""
    echo "Tier 1 — playwright-cli:"
    which playwright-cli 2>/dev/null && playwright-cli --version 2>/dev/null || echo "  NOT INSTALLED"
    echo ""
    echo "Tier 2 — @playwright/mcp:"
    npm list -g @playwright/mcp 2>/dev/null | grep @playwright/mcp || echo "  NOT INSTALLED"
    echo ""
    echo "Tier 3 — chrome-devtools-mcp:"
    npm list -g chrome-devtools-mcp 2>/dev/null | grep chrome-devtools-mcp || echo "  NOT INSTALLED"
    echo ""
    echo "Chromium:"
    ls /root/.cache/ms-playwright/chromium-* 2>/dev/null | head -1 || echo "  NOT INSTALLED"
    echo ""
    echo "Target: $INFRAX_URL"
    ;;

  # --- Help ---
  help|*)
    echo "InfraX Browser Tester — Three-tier Stack"
    echo "========================================"
    echo ""
    echo "Tier 1 — playwright-cli (fast, low token):"
    echo "  login          Test private key login flow"
    echo "  modules        Navigate all 5 modules"
    echo "  admin          Test admin login page"
    echo "  console        Show console + network requests"
    echo "  snapshot       Quick page load + snapshot"
    echo '  eval "<js>"     Run JS on current page'
    echo ""
    echo "Tier 2 — @playwright/mcp (MCP agent integration):"
    echo "  mcp-start      Start MCP server (headless)"
    echo "  mcp-headed     Start MCP server (headed, local debug)"
    echo "  mcp-persist    Start with persistent session"
    echo ""
    echo "Tier 3 — chrome-devtools-mcp (performance):"
    echo "  perf-start     Start for performance analysis"
    echo "  perf-trace     Start with tracing enabled"
    echo ""
    echo "Management:"
    echo "  close-all      Close all browser sessions"
    echo "  status         Show installed tools"
    echo "  help           This help"
    echo ""
    echo "Env vars:"
    echo "  INFRAX_URL=${INFRAX_URL}"
    ;;
esac

echo ""
echo "Done."
