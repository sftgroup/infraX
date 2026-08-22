#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# MQ-16 T-2 联调验证 — Market 行情 API 按量套餐（~40 端点接引擎计费，超配额 503）
#   1) static 子命令：本地 git 代码静态回归（新表/中间件/订阅端点/语法）
#   2) api 子命令：生产服务联调（collector :9101 配额扣减 + 订阅引擎 rails + 503 限流）
# 用法：
#   本地：bash projects/web/scripts/mq16_t2_verify.sh static
#   生产：scp 后 bash /tmp/mq16_t2_verify.sh api
# ═════════════════════════════════════════════════════════════════════════════
set -uo pipefail

REPO=${REPO:-/home/ubuntu/infraX-1}
COL_BASE=${COL_BASE:-http://127.0.0.1:9101}

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
section() { echo; echo "━━━ $1 ━━━"; }

cd "$REPO" || { echo "REPO not found: $REPO"; exit 1; }

# ═══════════ static：本地 git 代码静态回归 ═══════════
static() {
  section "static [1/7] collector migration — MQ-16 T-2 新表/新列"
  for pat in "market_plan_id" "CREATE TABLE IF NOT EXISTS market_usage (" "CREATE TABLE IF NOT EXISTS market_usage_daily" "idx_market_usage_key_ts"; do
    grep -qF "$pat" projects/collector/src/services/migration.ts && ok "migration 含: $pat" || bad "migration 缺少: $pat"
  done

  section "static [2/7] marketPlans.ts — 套餐/引擎客户端/激活"
  [ -f projects/collector/src/marketPlans.ts ] && ok "marketPlans.ts 存在" || bad "缺少 marketPlans.ts"
  for pat in "MARKET_PLANS" "activateMarketSubscription" "verifyWebhookSignature" "paymentsApi" "hasActiveSubscription"; do
    grep -qF "$pat" projects/collector/src/marketPlans.ts && ok "marketPlans 含: $pat" || bad "marketPlans 缺少: $pat"
  done

  section "static [3/7] 扣减中间件 + 订阅路由"
  for pat in "marketQuotaEnforce" "503" "market_usage" "monthStart"; do
    grep -qF "$pat" projects/collector/src/middleware/marketQuotaEnforce.ts && ok "marketQuotaEnforce 含: $pat" || bad "marketQuotaEnforce 缺少: $pat"
  done
  for ep in "plans" "checkout" "payment-check" "payment-callback" "verify" "usage"; do
    grep -qF "/$ep" projects/collector/src/routes/marketSubscriptionRoutes.ts && ok "订阅路由含: /$ep" || bad "订阅路由缺少: /$ep"
  done

  section "static [4/7] index.ts 挂载 + apiKeyAuth 携带套餐"
  grep -qF "marketQuotaEnforce, marketRoutes" projects/collector/src/index.ts && ok "market 路由挂载扣减中间件" || bad "market 路由未挂扣减"
  grep -qF "marketSubscriptionRoutes" projects/collector/src/index.ts && ok "/api/v2/market 路由挂载" || bad "/api/v2/market 未挂载"
  grep -qF "market_plan_id" projects/collector/src/middleware/apiKeyAuth.ts && ok "apiKeyAuth 携带 market_plan_id" || bad "apiKeyAuth 缺少套餐字段"

  section "static [5/7] collector tsc"
  (cd projects/collector && npx tsc --noEmit >/dev/null 2>&1) && ok "collector tsc 通过" || bad "collector tsc 报错"

  section "static [6/7] 套餐模型一致性（三档）"
  local n
  n=$(grep -c "name: 'Market" projects/collector/src/marketPlans.ts)
  [ "$n" -ge 3 ] && ok "三档套餐（n=$n）" || bad "套餐数异常: $n"

  section "static [7/7] tasklist 状态"
  grep -q "T-2 Market/行情 API 按量套餐（✅" docs/infrax_tasklist.md && ok "tasklist MQ-16 T-2 已标记 ✅" || bad "tasklist T-2 未标记 ✅（实现完成后同步）"

  summary
}

# ═══════════ api：生产服务联调 ═══════════
api() {
  local DB=${DB:-infrax_collector}

  section "api [1/10] collector 冒烟 + 套餐列表"
  curl -sf "$COL_BASE/health" >/dev/null 2>&1 && ok "collector /health" || bad "collector /health 失败"
  local plans
  plans=$(curl -s "$COL_BASE/api/v2/market/plans")
  for p in market_free market_pro market_enterprise; do
    echo "$plans" | python3 -c "import json,sys; d=json.load(sys.stdin); ids=[x['id'] for x in (d.get('data') or d)]; sys.exit(0 if '$p' in ids else 1)" && ok "plan: $p" || bad "缺少 plan: $p"
  done

  section "api [2/10] 测试 key（DB 直插 pkx_*）"
  local KEY
  KEY="pkx_$(openssl rand -hex 12)"
  sudo -u postgres psql -d "$DB" -c "INSERT INTO api_keys (label, api_key, rate_limit) VALUES ('mq16-t2-test', '$KEY', 1000) RETURNING id" >/dev/null 2>&1 \
    && ok "测试 key 已建: ${KEY:0:8}…" || { bad "测试 key 创建失败"; summary; return; }
  local key_id
  key_id=$(sudo -u postgres psql -d "$DB" -t -A -c "SELECT id FROM api_keys WHERE api_key='$KEY'" 2>/dev/null)

  section "api [3/10] market 端点调用（带 key）→ 200 + 扣减"
  local code used_before used_after
  used_before=$(sudo -u postgres psql -d "$DB" -t -A -c "SELECT COUNT(*) FROM market_usage WHERE key_id=$key_id" 2>/dev/null || echo 0)
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: $KEY" "$COL_BASE/api/v2/data/market/supported-chains")
  [ "$code" = "200" ] && ok "market/supported-chains 200" || bad "market 端点返回 $code"
  sleep 1
  used_after=$(sudo -u postgres psql -d "$DB" -t -A -c "SELECT COUNT(*) FROM market_usage WHERE key_id=$key_id" 2>/dev/null || echo 0)
  [ "${used_after:-0}" -eq $((used_before + 1)) ] && ok "扣减生效: $used_before → $used_after" || bad "扣减异常: before=$used_before after=$used_after"

  section "api [4/10] usage 真实用量（plan=market_free quota=10000）"
  local r
  r=$(curl -s -H "X-API-Key: $KEY" "$COL_BASE/api/v2/market/usage")
  [ "$(echo "$r" | jget data.planId)" = "market_free" ] && [ "$(echo "$r" | jget data.monthlyQuota)" = "10000" ] && ok "usage: plan=market_free quota=10000" || bad "usage 异常: $r"
  echo "  currentUsage=$(echo "$r" | jget data.currentUsage) subStatus=$(echo "$r" | jget data.marketSubStatus)"

  section "api [5/10] 无 key → 401"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$COL_BASE/api/v2/data/market/supported-chains")
  [ "$code" = "401" ] && ok "无 key 401" || bad "无 key 返回 $code"

  section "api [6/10] 付费订阅 market_pro（chain rail）→ pending + 引擎支付信息"
  r=$(curl -s -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"plan_id":"market_pro"}' "$COL_BASE/api/v2/market/checkout")
  [ "$(echo "$r" | jget data.marketSubStatus)" = "pending" ] && ok "market_pro → pending" || bad "checkout 失败: $r"
  [ "$(echo "$r" | jget data.payment.rail)" = "chain" ] && ok "rail=chain" || bad "rail 异常: $r"
  [ -n "$(echo "$r" | jget data.payment.price)" ] && [ -n "$(echo "$r" | jget data.payment.subscriptionManager)" ] && ok "链上订阅信息（price/manager/chainId=$(echo "$r" | jget data.payment.chainId)）" || bad "支付信息缺失: $r"

  section "api [7/10] payment-check 轮询（无真实链上订阅 → pending）"
  r=$(curl -s -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{}' "$COL_BASE/api/v2/market/payment-check")
  [ "$(echo "$r" | jget data.status)" = "pending" ] && ok "payment-check → pending（链上未订阅）" || bad "payment-check 异常: $r"

  section "api [8/10] 配额限流 503（直接灌 market_usage 至超配额）"
  local quota used ins
  quota=$(curl -s -H "X-API-Key: $KEY" "$COL_BASE/api/v2/market/usage" | jget data.monthlyQuota)
  used=$(sudo -u postgres psql -d "$DB" -t -A -c "SELECT COUNT(*) FROM market_usage WHERE key_id=$key_id" 2>/dev/null || echo "0")
  ins=$((quota - used + 1))
  sudo -u postgres psql -d "$DB" -c "INSERT INTO market_usage (key_id, endpoint) SELECT $key_id,'mq16-t2-test' FROM generate_series(1,$ins)" >/dev/null 2>&1
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: $KEY" "$COL_BASE/api/v2/data/market/supported-chains")
  [ "$code" = "503" ] && ok "超配额 → 503（+$ins 行）" || bad "超配额未 503，返回 $code"
  sudo -u postgres psql -d "$DB" -c "DELETE FROM market_usage WHERE key_id=$key_id AND endpoint='mq16-t2-test'" >/dev/null 2>&1

  section "api [9/10] payment-callback 负向（无签名/伪造签名 → 401）"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"type":"webhook"}' "$COL_BASE/api/v2/market/payment-callback")
  [ "$code" = "401" ] && ok "无签名回调 401" || bad "无签名回调返回 $code"

  section "api [10/10] 清理测试数据"
  sudo -u postgres psql -d "$DB" -c "DELETE FROM market_usage_daily WHERE key_id=$key_id; DELETE FROM market_usage WHERE key_id=$key_id; DELETE FROM api_keys WHERE id=$key_id;" >/dev/null 2>&1
  ok "已清理测试 key=$key_id"

  summary
}

summary() {
  echo
  echo "════════ 结果: ✅ $PASS 通过 / ❌ $FAIL 失败 ════════"
  [ "$FAIL" -gt 0 ] && exit 1 || exit 0
}

# JSON 点路径取值（支持 list[int]）：echo "$json" | jget data.plan.id
jget() { python3 -c "
import json,sys
d=json.load(sys.stdin)
for k in '$1'.split('.'):
    d = d[int(k)] if isinstance(d, list) else (d.get(k) if isinstance(d, dict) else None)
    if d is None: break
print('' if d is None else d)
"; }

case "${1:-}" in
  static) static ;;
  api) api ;;
  *) echo "用法: $0 <static|api>"; exit 1 ;;
esac
