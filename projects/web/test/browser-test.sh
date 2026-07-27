#!/bin/bash
# InfraX Browser Testing Wrapper
# ================================
# Usage:
#   ./browser-test.sh login       — Test private key login flow
#   ./browser-test.sh modules     — Navigate all modules
#   ./browser-test.sh admin       — Test admin login
#   ./browser-test.sh console     — Open page and show console
#   ./browser-test.sh devtools    — Launch chrome-devtools-mcp
#   ./browser-test.sh snapshot    — Quick page snapshot

set -e
INFRAX_URL="${INFRAX_URL:-http://43.156.99.215:9111}"
TEST_PK="0xb1eb7c5b3ad9ea36d62e744c4bd07dfb99b0605c2675faaaf8f9c4121ecd8644"
ADMIN_PASS="${ADMIN_PASS:-a87cefd6e1ce487334a67b0c}"

snapshot() {
  local name="${1:-page}"
  playwright-cli snapshot --filename="snapshot-${name}-$(date +%H%M%S).yml"
}

case "${1:-help}" in
  login)
    echo "=== Testing Private Key Login ==="
    playwright-cli open "$INFRAX_URL/index.html"
    sleep 3
    snapshot "login-01-connect"
    # Find and click Private Key tab, then fill key
    playwright-cli find "Private Key"
    snapshot "login-02-dashboard"
    ;;

  modules)
    echo "=== Testing Module Navigation ==="
    playwright-cli open "$INFRAX_URL/index.html"
    sleep 3
    for mod in mpc waas safe dc pay; do
      echo "  -> $mod"
      playwright-cli click "[data-page='$mod']"
      sleep 1
      snapshot "module-${mod}"
    done
    ;;

  admin)
    echo "=== Testing Admin Login ==="
    playwright-cli open "$INFRAX_URL/admin-login.html"
    sleep 2
    snapshot "admin-01-login"
    playwright-cli find "Sign in"
    ;;

  console)
    echo "=== Console Inspection ==="
    playwright-cli open "$INFRAX_URL/index.html"
    sleep 3
    playwright-cli console
    playwright-cli console warning
    playwright-cli requests
    ;;

  devtools)
    echo "=== Launching Chrome DevTools MCP ==="
    echo "This starts an MCP server. Connect your AI agent to it."
    npx chrome-devtools-mcp@latest \
      --headless \
      --chrome-arg='--no-sandbox' \
      --chrome-arg='--disable-setuid-sandbox' \
      --viewport=1280x720 \
      --isolated
    ;;

  snapshot)
    playwright-cli open "$INFRAX_URL"
    sleep 3
    snapshot "quick"
    playwright-cli close
    ;;

  close-all)
    playwright-cli close-all
    ;;

  help|*)
    echo "InfraX Browser Tester"
    echo "===================="
    echo ""
    echo "Commands:"
    echo "  login      Test private key login flow"
    echo "  modules    Navigate all 5 modules (mpc/waas/safe/dc/pay)"
    echo "  admin      Test admin login page"
    echo "  console    Inspect browser console & network"
    echo "  devtools   Launch chrome-devtools-mcp server"
    echo "  snapshot   Quick page load + snapshot"
    echo "  close-all  Close all browser sessions"
    echo ""
    echo "Env vars:"
    echo "  INFRAX_URL    Target URL (default: $INFRAX_URL)"
    echo "  ADMIN_PASS    Admin password"
    ;;
esac

echo ""
echo "Done."
