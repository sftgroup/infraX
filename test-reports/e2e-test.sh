#!/bin/bash
# InfraX E2E Test Suite — Production Environment
# Version: v0.3.1-20260717
# Target: 43.156.99.215 (ports 9100-9111)
#
# Usage:
#   # On the production server itself:
#   bash e2e-test.sh
#
#   # Against a remote server:
#   TARGET_HOST=43.156.99.215 WEB_PORT=9111 bash e2e-test.sh
#
#   # With admin credentials:
#   ADMIN_USER=admin ADMIN_PASS=mypass TARGET_HOST=43.156.99.215 bash e2e-test.sh

# Do NOT set -e; we handle errors per test

TARGET_HOST="${TARGET_HOST:-localhost}"
WEB_PORT="${WEB_PORT:-9111}"
BASE_URL="http://${TARGET_HOST}:${WEB_PORT}"

PASSED=0
FAILED=0
SKIPPED=0
FAILED_TESTS=""
ADMIN_TOKEN=""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ─── Helpers ─────────────────────────────────────────────────────

record() {
  local name="$1"
  local ok="$2"
  local detail="$3"
  if [ "$ok" = "SKIP" ]; then
    ((SKIPPED++))
    echo -e "  ⬜ ${name}"
  elif [ "$ok" = "0" ]; then
    ((PASSED++))
    echo -e "  ${GREEN}✅${NC} ${name}"
  else
    ((FAILED++))
    echo -e "  ${RED}❌${NC} ${name} — ${detail}"
    FAILED_TESTS="${FAILED_TESTS}\n    ${name} — ${detail}"
  fi
}

# Basic HTTP GET. Returns HTTP status code as exit code (0=2xx, 1=4xx, 2=5xx, 3=error)
_curl() {
  local method="${1:-GET}"
  local url="$2"
  local data="${3:-}"
  local extra_hdrs="${4:-}"
  local tmpfile
  tmpfile=$(mktemp)

  local hdrs=(-s -o "$tmpfile" -w '%{http_code}' --max-time 8)
  [ "$method" != "GET" ] && hdrs+=(-X "$method")
  [ -n "$data" ] && hdrs+=(-d "$data")
  [ -n "$extra_hdrs" ] && hdrs+=(-H "$extra_hdrs")

  local code
  code=$(curl "${hdrs[@]}" "$url" 2>/dev/null)
  local ret=$?
  if [ $ret -ne 0 ]; then
    rm -f "$tmpfile"
    echo "0"
    return 3
  fi
  echo "$code"
  cat "$tmpfile"
  rm -f "$tmpfile"
}

# GET request, returns JSON body
api_get() {
  local path="$1"
  local hdrs="Content-Type: application/json"
  [ -n "$ADMIN_TOKEN" ] && hdrs="$hdrs"$'\n'"x-admin-token: $ADMIN_TOKEN"
  curl -s --max-time 8 -H "Content-Type: application/json" ${ADMIN_TOKEN:+-H "x-admin-token: $ADMIN_TOKEN"} "${BASE_URL}${path}"
}

# POST request, returns JSON body
api_post() {
  local path="$1"
  local data="$2"
  curl -s --max-time 8 -X POST -H "Content-Type: application/json" \
    ${ADMIN_TOKEN:+-H "x-admin-token: $ADMIN_TOKEN"} \
    -d "$data" "${BASE_URL}${path}"
}

# Direct health check (no proxy)
direct_health() {
  local port="$1"
  curl -s --max-time 3 -o /dev/null -w '%{http_code}' "http://${TARGET_HOST}:${port}/health" 2>/dev/null || echo "000"
}

# JSON field extractor using grep + sed (no jq dependency)
json_field() {
  local json="$1"
  local field="$2"
  echo "$json" | grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//'
}

json_field_num() {
  local json="$1"
  local field="$2"
  echo "$json" | grep -o "\"${field}\"[[:space:]]*:[[:space:]]*[0-9.-]*" | head -1 | sed 's/.*:[[:space:]]*//'
}

json_code() {
  local json="$1"
  json_field_num "$json" "code"
}

# ─── Test Suites ─────────────────────────────────────────────────

test_health_checks() {
  echo ""
  echo "═══ T1: Health Checks (12 services) ═══"

  # Test public-facing ports directly (9102/DC is also accessible)
  local public_services=("web:9111" "dc:9102")
  for svc in "${public_services[@]}"; do
    local name="${svc%%:*}"
    local port="${svc##*:}"
    local code
    code=$(direct_health "$port")
    if [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 500 ] 2>/dev/null; then
      record "$name :${port}/health" 0 "HTTP $code"
    else
      record "$name :${port}/health" 1 "HTTP $code (FAIL)"
    fi
  done

  # Admin port (may be blocked by firewall)
  local admin_code
  admin_code=$(direct_health "9100")
  if [ "$admin_code" -ge 200 ] 2>/dev/null && [ "$admin_code" -lt 500 ] 2>/dev/null; then
    record "admin :9100/health" 0 "HTTP $admin_code"
  else
    record "admin :9100/health" 1 "HTTP $admin_code (firewall/internal)"
  fi

  # Internal-only services — cannot test externally
  local internal_svcs=("collector:9101" "dc-mcp:9103" "mpc:9104" "mpc-mcp:9105" "payment:9106" "vault:9107" "vault-mcp:9108" "waas:9109" "wallet-mcp:9110")
  for svc in "${internal_svcs[@]}"; do
    local name="${svc%%:*}"
    record "$name (internal)" "SKIP" "not exposed externally"
  done
}

test_web_proxy() {
  echo ""
  echo "═══ T2: Web Proxy (:9111) ═══"

  # Root page
  local code
  code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "${BASE_URL}/" 2>/dev/null)
  if [ "$code" = "200" ]; then
    record "Web root (/)" 0 "landing page loads"
  else
    record "Web root (/)" 1 "HTTP $code"
  fi

  # Check if /health is real or just serves HTML (proxy has no health endpoint)
  local health_type
  health_type=$(curl -sI --max-time 5 "${BASE_URL}/health" 2>/dev/null | grep -i 'content-type' | head -1)
  if echo "$health_type" | grep -qi 'application/json'; then
    record "Web /health is JSON" 0 "real health endpoint"
  else
    record "Web /health" 1 "returns HTML (no health endpoint)"
  fi

  # Proxy route tests — check if they reach backend or return 502
  local proxy_tests=(
    "DC (via proxy):/api/v2/data/plans"
    "MPC (via proxy):/api/v2/mpc/send-code"
    "WAAS (via proxy):/api/v2/wallet/balance?address=0x000&chain=sepolia"
  )
  for test in "${proxy_tests[@]}"; do
    local name="${test%%:*}"
    local path="${test##*:}"
    code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "${BASE_URL}${path}" 2>/dev/null)
    if [ "$code" = "502" ]; then
      record "${name}" 1 "HTTP 502 (backend down)"
    elif [ -n "$code" ] && [ "$code" != "000" ]; then
      record "${name}" 0 "HTTP $code"
    else
      record "${name}" 1 "HTTP $code (timeout)"
    fi
  done
}

test_admin_auth() {
  echo ""
  echo "═══ T3: Admin Auth Flow (:9100) ═══"
  local ADMIN_USER="${ADMIN_USER:-admin}"
  local ADMIN_PASS="${ADMIN_PASS:-}"

  if [ -z "$ADMIN_PASS" ]; then
    echo -e "  ${YELLOW}⚠ No ADMIN_PASS set — skipping admin tests${NC}"
    record "Admin login" "SKIP" ""
    return
  fi

  # 3.1 Login
  local login_resp
  login_resp=$(api_post "/api/v2/admin/login" "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}")
  local login_code
  login_code=$(json_code "$login_resp")
  ADMIN_TOKEN=$(echo "$login_resp" | grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//')

  if [ "$login_code" = "0" ] && [ -n "$ADMIN_TOKEN" ]; then
    record "POST /api/v2/admin/login" 0 "token obtained"
  else
    record "POST /api/v2/admin/login" 1 "login_code=$login_code"
    record "Admin authenticated endpoints" "SKIP" ""
    return
  fi

  # Helper for authed GET
  authed_get() {
    curl -s --max-time 8 -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE_URL}$1"
  }

  # 3.2 Dashboard
  local resp code
  resp=$(authed_get "/api/v2/admin/dashboard")
  code=$(json_code "$resp")
  if [ "$code" = "0" ]; then
    local users tenants events
    users=$(json_field_num "$resp" "totalUsers")
    tenants=$(json_field_num "$resp" "activeTenants")
    events=$(json_field_num "$resp" "totalEvents")
    record "GET /api/v2/admin/dashboard" 0 "users=$users tenants=$tenants events=$events"
  else
    record "GET /api/v2/admin/dashboard" 1 "HTTP code=$code"
  fi

  # 3.3 Tenants
  resp=$(authed_get "/api/v2/admin/tenants")
  code=$(json_code "$resp")
  if [ "$code" = "0" ]; then
    local cnt
    cnt=$(echo "$resp" | grep -o '"id"' | wc -l)
    record "GET /api/v2/admin/tenants" 0 "$cnt tenants"
  else
    record "GET /api/v2/admin/tenants" 1 "code=$code"
  fi

  # 3.4 Status
  resp=$(authed_get "/api/v2/admin/status")
  code=$(json_code "$resp")
  if [ "$code" = "0" ]; then
    local up
    up=$(echo "$resp" | grep -o '"status":"up"' | wc -l)
    record "GET /api/v2/admin/status" 0 "${up} services up"
  else
    record "GET /api/v2/admin/status" 1 "code=$code"
  fi

  # 3.5 Transactions
  local http_code
  http_code=$(curl -s --max-time 8 -o /dev/null -w '%{http_code}' -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE_URL}/api/v2/admin/transactions" 2>/dev/null)
  record "GET /api/v2/admin/transactions" $([ "$http_code" = "200" ] && echo 0 || echo 1) "HTTP $http_code"

  # 3.6 Revenue
  resp=$(authed_get "/api/v2/admin/revenue")
  code=$(json_code "$resp")
  record "GET /api/v2/admin/revenue" $([ "$code" = "0" ] && echo 0 || echo 1) "code=$code"

  # 3.7 Settings
  resp=$(authed_get "/api/v2/admin/settings")
  code=$(json_code "$resp")
  local token_cnt chain_cnt
  token_cnt=$(echo "$resp" | grep -o '"symbol"' | wc -l)
  chain_cnt=$(echo "$resp" | grep -o '"chain_id"' | wc -l)
  record "GET /api/v2/admin/settings" $([ "$code" = "0" ] && echo 0 || echo 1) "tokens=$token_cnt chains=$chain_cnt"

  # 3.8 WaaS Stats
  resp=$(authed_get "/api/v2/admin/waas/stats")
  code=$(json_code "$resp")
  record "GET /api/v2/admin/waas/stats" $([ "$code" = "0" ] && echo 0 || echo 1) "code=$code"

  # 3.9 Webhooks
  http_code=$(curl -s --max-time 8 -o /dev/null -w '%{http_code}' -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE_URL}/api/v2/admin/webhooks" 2>/dev/null)
  record "GET /api/v2/admin/webhooks" $([ "$http_code" = "200" ] && echo 0 || echo 1) "HTTP $http_code"

  # 3.10 Sweeps
  http_code=$(curl -s --max-time 8 -o /dev/null -w '%{http_code}' -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE_URL}/api/v2/admin/sweeps" 2>/dev/null)
  record "GET /api/v2/admin/sweeps" $([ "$http_code" = "200" ] && echo 0 || echo 1) "HTTP $http_code"

  # 3.11 MPC Stats
  resp=$(authed_get "/api/v2/admin/mpc/stats")
  code=$(json_code "$resp")
  record "GET /api/v2/admin/mpc/stats" $([ "$code" = "0" ] && echo 0 || echo 1) "code=$code"

  # 3.12 Vault Stats
  resp=$(authed_get "/api/v2/admin/vault/stats")
  code=$(json_code "$resp")
  record "GET /api/v2/admin/vault/stats" $([ "$code" = "0" ] && echo 0 || echo 1) "code=$code"

  # 3.13 DC Stats
  resp=$(authed_get "/api/v2/admin/dc/stats")
  code=$(json_code "$resp")
  record "GET /api/v2/admin/dc/stats" $([ "$code" = "0" ] && echo 0 || echo 1) "code=$code"
}

test_dc_endpoints() {
  echo ""
  echo "═══ T4: DC Data Endpoints (direct :9102 + proxy :9111) ═══"
  local DC_URL="http://${TARGET_HOST}:9102"

  # 4.1 Plans (direct + proxy)
  local resp code
  resp=$(curl -s --max-time 5 "${DC_URL}/api/v2/data/plans" 2>/dev/null)
  code=$(json_code "$resp")
  local plan_cnt
  plan_cnt=$(echo "$resp" | grep -o '"id":"data_' | wc -l)
  record "DC direct /api/v2/data/plans" $([ "$code" = "0" ] && echo 0 || echo 1) "${plan_cnt} plans (3 = Free/Pro/Enterprise)"

  local proxy_code
  proxy_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v2/data/plans" 2>/dev/null)
  record "DC via proxy /api/v2/data/plans" $([ "$proxy_code" = "200" ] && echo 0 || echo 1) "HTTP $proxy_code (expected 200)"

  # 4.2 Docs
  resp=$(curl -s --max-time 5 "${DC_URL}/api/v2/data/docs" 2>/dev/null)
  code=$(json_code "$resp")
  record "DC direct /api/v2/data/docs" $([ "$code" = "0" ] && echo 0 || echo 1) "code=$code"

  # 4.3 Balance
  resp=$(curl -s --max-time 8 "${DC_URL}/api/v2/data/balance?address=0x0000000000000000000000000000000000000000" 2>/dev/null)
  code=$(json_code "$resp")
  local chain_count
  chain_count=$(echo "$resp" | grep -o '"chain":"' | wc -l)
  record "DC direct /api/v2/data/balance" $([ "$code" = "0" ] && echo 0 || echo 1) "${chain_count} chains queried"

  # 4.4 Events (expect 401 without key)
  local http_code
  http_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "${DC_URL}/api/v2/data/events?chain=sepolia&limit=5" 2>/dev/null)
  record "DC /api/v2/data/events (no auth)" $([ "$http_code" = "401" ] && echo 0 || echo 1) "HTTP $http_code (expected 401)"

  # 4.5 Stats (expect 401)
  http_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "${DC_URL}/api/v2/data/stats" 2>/dev/null)
  record "DC /api/v2/data/stats (no auth)" $([ "$http_code" = "401" ] && echo 0 || echo 1) "HTTP $http_code (expected 401)"

  # 4.6 Subscribe
  http_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -X POST -H "Content-Type: application/json" -d '{"planId":"data_free"}' "${DC_URL}/api/v2/data/subscribe" 2>/dev/null)
  record "DC POST /api/v2/data/subscribe" $([ "$http_code" = "400" ] && echo 0 || echo 1) "HTTP $http_code (expected 400)"
}

test_mpc_endpoints() {
  echo ""
  echo "═══ T5: MPC Endpoints (:9104) ═══"
  local email="e2e-test@infrax.io"

  # 5.1 Send code
  local resp code
  resp=$(api_post "/api/v2/mpc/send-code" "{\"email\":\"${email}\"}")
  code=$(json_code "$resp")
  record "POST /api/v2/mpc/send-code" $([ "$code" = "0" ] && echo 0 || echo 1) "code=$code"

  # 5.2 Status
  local http_code
  http_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v2/mpc/status?email=${email}" 2>/dev/null)
  record "GET /api/v2/mpc/status" $([ "$http_code" = "200" ] && echo 0 || echo 1) "HTTP $http_code"

  # 5.3 Contract Read
  http_code=$(curl -s --max-time 8 -o /dev/null -w '%{http_code}' -X POST \
    -H "Content-Type: application/json" \
    -d '{"chain":"sepolia","contractAddress":"0x0000000000000000000000000000000000000000","abi":["function name() view returns (string)"],"method":"name","args":[]}' \
    "${BASE_URL}/api/v2/mpc/contract-read" 2>/dev/null)
  record "POST /api/v2/mpc/contract-read" $([ "$http_code" != "000" ] && [ "$http_code" != "502" ] && echo 0 || echo 1) "HTTP $http_code"

  # 5.4 Gas Estimate
  http_code=$(curl -s --max-time 8 -o /dev/null -w '%{http_code}' -X POST \
    -H "Content-Type: application/json" \
    -d '{"to":"0x0000000000000000000000000000000000000000","value":"0","chain":"sepolia"}' \
    "${BASE_URL}/api/v2/mpc/gas-estimate" 2>/dev/null)
  record "POST /api/v2/mpc/gas-estimate" $([ "$http_code" = "200" ] && echo 0 || echo 1) "HTTP $http_code"

  # 5.5 Session Unlock (bad code)
  http_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -X POST \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${email}\",\"code\":\"000000\"}" \
    "${BASE_URL}/api/v2/mpc/session/unlock" 2>/dev/null)
  record "POST /api/v2/mpc/session/unlock (bad code)" $([ "$http_code" -ge 400 ] 2>/dev/null && echo 0 || echo 1) "HTTP $http_code (expected 4xx)"

  # 5.6 Balance without token
  http_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -X POST \
    -H "Content-Type: application/json" \
    -d '{"token":"invalid","chain":"sepolia"}' \
    "${BASE_URL}/api/v2/mpc/balance" 2>/dev/null)
  record "POST /api/v2/mpc/balance (no token)" $([ "$http_code" = "401" ] && echo 0 || echo 1) "HTTP $http_code (expected 401)"
}

test_waas_endpoints() {
  echo ""
  echo "═══ T6: WAAS SaaS Endpoints (:9109) ═══"

  # 6.1 My tenants
  local http_code
  http_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v2/saas/tenants/my" 2>/dev/null)
  record "GET /api/v2/saas/tenants/my" $([ "$http_code" -ge 400 ] 2>/dev/null && echo 0 || echo 1) "HTTP $http_code (expected auth req)"

  # 6.2 Wallet balance
  http_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v2/wallet/balance?address=0x0000000000000000000000000000000000000000&chain=sepolia" 2>/dev/null)
  record "GET /api/v2/wallet/balance" $([ "$http_code" = "200" ] && echo 0 || echo 1) "HTTP $http_code"
}

test_payment_endpoints() {
  echo ""
  echo "═══ T7: Payment Endpoints (:9106) ═══"
  local http_code
  http_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -X POST \
    -H "Content-Type: application/json" \
    -d '{"planId":"test","amount":"0"}' \
    "${BASE_URL}/api/v2/payment/create" 2>/dev/null)
  record "POST /api/v2/payment/create" $([ "$http_code" != "502" ] && [ "$http_code" != "000" ] && echo 0 || echo 1) "HTTP $http_code"
}

test_vault_endpoints() {
  echo ""
  echo "═══ T8: Vault Endpoints (:9107) ═══"

  local http_code
  http_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "${BASE_URL}/api/vault/dashboard" 2>/dev/null)
  record "GET /api/vault/dashboard" $([ "$http_code" != "502" ] && [ "$http_code" != "000" ] && echo 0 || echo 1) "HTTP $http_code"

  http_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "${BASE_URL}/api/vault/safe/list" 2>/dev/null)
  record "GET /api/vault/safe/list" $([ "$http_code" != "502" ] && [ "$http_code" != "000" ] && echo 0 || echo 1) "HTTP $http_code"

  http_code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "${BASE_URL}/api/vault/safe/status" 2>/dev/null)
  record "GET /api/vault/safe/status" $([ "$http_code" != "502" ] && [ "$http_code" != "000" ] && echo 0 || echo 1) "HTTP $http_code"
}

test_mcp_servers() {
  echo ""
  echo "═══ T9: MCP Servers ═══"
  # MCP servers use internal ports only — not accessible from outside
  # Verify via admin status API instead
  if [ -n "$ADMIN_TOKEN" ]; then
    local resp status_data up
    resp=$(curl -s --max-time 8 -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE_URL}/api/v2/admin/status" 2>/dev/null)
    local code
    code=$(json_code "$resp")
    if [ "$code" = "0" ]; then
      # Check MCP services in status
      local mcp_names=("dc-mcp" "mpc-mcp" "vault-mcp" "wallet-mcp")
      for name in "${mcp_names[@]}"; do
        up=$(echo "$resp" | grep -o "\"name\":\"${name}\"[^}]*\"status\":\"up\"" | wc -l)
        if [ "$up" -gt 0 ]; then
          record "${name} (via admin)" 0 "up"
        else
          record "${name} (via admin)" 1 "down or unknown"
        fi
      done
    else
      record "MCP servers (via admin)" 1 "admin status API failed"
    fi
  else
    local mcps=("Wallet MCP:9110" "DC MCP:9103" "Vault MCP:9108" "MPC MCP:9105")
    for m in "${mcps[@]}"; do
      local name="${m%%:*}"
      record "${name} (internal)" "SKIP" ""
    done
  fi
}

test_security() {
  echo ""
  echo "═══ T10: Security & Rate Limiting ═══"

  # Check security headers via web proxy (WAAS is behind proxy)
  local headers
  headers=$(curl -sI --max-time 5 "${BASE_URL}/health" 2>/dev/null)

  local hsts
  hsts=$(echo "$headers" | grep -i 'strict-transport-security' | head -1)
  record "Web HSTS header" $( [ -n "$hsts" ] && echo 0 || echo 1) "$([ -n "$hsts" ] && echo "present" || echo "missing")"

  local xfo
  xfo=$(echo "$headers" | grep -i 'x-frame-options' | head -1)
  record "Web X-Frame-Options" $( [ -n "$xfo" ] && echo 0 || echo 1) "$([ -n "$xfo" ] && echo "present" || echo "missing")"

  local rl
  rl=$(echo "$headers" | grep -i 'ratelimit-policy' | head -1)
  record "Web RateLimit-Policy" $( [ -n "$rl" ] && echo 0 || echo 1) "$([ -n "$rl" ] && echo "present" || echo "missing")"

  # Also check on admin port (which is public)
  local admin_headers
  admin_headers=$(curl -sI --max-time 5 "http://${TARGET_HOST}:9100/health" 2>/dev/null)
  local admin_hsts
  admin_hsts=$(echo "$admin_headers" | grep -i 'strict-transport-security' | head -1)
  record "Admin HSTS header" $( [ -n "$admin_hsts" ] && echo 0 || echo 1) "$([ -n "$admin_hsts" ] && echo "present" || echo "missing")"

  # Burst test via web proxy
  local ok=0
  for i in $(seq 1 5); do
    local c
    c=$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' "${BASE_URL}/health" 2>/dev/null)
    [ "$c" != "200" ] && ok=1
  done
  record "Web burst 5 requests" "$ok" "$([ "$ok" = "0" ] && echo "all 200 OK" || echo "rate limited")"
}

test_collector() {
  echo ""
  echo "═══ T11: Collector (:9101) ═══"
  # Collector is internal-only (port 9101 not exposed)
  # Verify via admin status API
  if [ -n "$ADMIN_TOKEN" ]; then
    local resp
    resp=$(curl -s --max-time 8 -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE_URL}/api/v2/admin/status" 2>/dev/null)
    local up
    up=$(echo "$resp" | grep -o '"name":"collector"[^}]*"status":"up"' | wc -l)
    record "Collector (via admin)" $([ "$up" -gt 0 ] && echo 0 || echo 1) "$([ "$up" -gt 0 ] && echo "up" || echo "down")"
  else
    record "Collector (internal)" "SKIP" ""
  fi
}

# ─── Main ─────────────────────────────────────────────────────────

main() {
  echo "╔══════════════════════════════════════════════╗"
  echo "║   InfraX E2E Test Suite — Production        ║"
  echo "║   Version: v0.3.1-20260717                  ║"
  echo "║   Target:  ${TARGET_HOST} (web :${WEB_PORT})     ║"
  echo "║   Time:    $(date -u '+%Y-%m-%dT%H:%M:%SZ')     ║"
  echo "╚══════════════════════════════════════════════╝"

  local start_time
  start_time=$(date +%s)

  test_health_checks
  test_web_proxy
  test_admin_auth
  test_dc_endpoints
  test_mpc_endpoints
  test_waas_endpoints
  test_payment_endpoints
  test_vault_endpoints
  test_mcp_servers
  test_security
  test_collector

  local elapsed
  elapsed=$(($(date +%s) - start_time))
  local total=$((PASSED + FAILED + SKIPPED))

  echo ""
  echo "╔══════════════════════════════════════════════╗"
  echo "║              TEST SUMMARY                    ║"
  echo "╠══════════════════════════════════════════════╣"
  printf "║  Passed:  %4d                              ║\n" $PASSED
  printf "║  Failed:  %4d                              ║\n" $FAILED
  printf "║  Skipped: %4d                              ║\n" $SKIPPED
  printf "║  Total:   %4d                              ║\n" $total
  printf "║  Time:    %4ds                              ║\n" $elapsed
  echo "╚══════════════════════════════════════════════╝"

  if [ "$FAILED" -gt 0 ]; then
    echo ""
    echo -e "Failed tests:${FAILED_TESTS}"
  fi

  return $FAILED
}

main "$@"
