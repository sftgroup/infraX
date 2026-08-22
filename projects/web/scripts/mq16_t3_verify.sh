#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# MQ-16 T-3 联调验证 — Chain RPC 对外读套餐（period 授权扣费，rx_ key 与订阅绑定）
#   1) static 子命令：本地 git 代码静态回归（订阅模块/扣减中间件/订阅端点/语法）
#   2) api 子命令：生产服务联调（chain-rpc :9130 配额扣减 + 订阅引擎 rails + 503 限流）
# 用法：
#   本地：bash projects/web/scripts/mq16_t3_verify.sh static
#   生产：BRIDGE_KEY=<read_key> bash /tmp/mq16_t3_verify.sh api
# ═════════════════════════════════════════════════════════════════════════════
set -uo pipefail

REPO=${REPO:-/home/ubuntu/infraX-1}
RPC_BASE=${RPC_BASE:-http://127.0.0.1:9130}
BRIDGE_KEY=${BRIDGE_KEY:-}

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
section() { echo; echo "━━━ $1 ━━━"; }

cd "$REPO" || { echo "REPO not found: $REPO"; exit 1; }

# ═══════════ static：本地 git 代码静态回归 ═══════════
static() {
  section "static [1/9] rpcSubscription.ts — 订阅模块存在"
  [ -f projects/chain-rpc/src/services/rpcSubscription.ts ] && ok "rpcSubscription.ts 存在" || bad "缺少 rpcSubscription.ts"
  for pat in "RPC_PLANS" "initRpcTables" "generateRpcKey" "findRpcKeyByRaw" "activateRpcSubscription" "verifyWebhookSignature" "paymentsApi" "monthStart"; do
    grep -qF "$pat" projects/chain-rpc/src/services/rpcSubscription.ts && ok "rpcSubscription 含: $pat" || bad "rpcSubscription 缺少: $pat"
  done

  section "static [2/9] rpc_keys 表结构（SHA-256 哈希 + 订阅状态机）"
  for pat in "key_hash TEXT NOT NULL UNIQUE" "rpc_plan_id" "rpc_sub_status" "CREATE TABLE IF NOT EXISTS rpc_usage" "rpc_usage_daily"; do
    grep -qF "$pat" projects/chain-rpc/src/services/rpcSubscription.ts && ok "表结构含: $pat" || bad "表结构缺少: $pat"
  done

  section "static [3/9] 扣减中间件 rpcQuotaEnforce"
  [ -f projects/chain-rpc/src/middleware/rpcQuotaEnforce.ts ] && ok "rpcQuotaEnforce.ts 存在" || bad "缺少 rpcQuotaEnforce.ts"
  for pat in "503" "rpc_usage" "monthStart" "rpcQuotaEnforce"; do
    grep -qF "$pat" projects/chain-rpc/src/middleware/rpcQuotaEnforce.ts && ok "rpcQuotaEnforce 含: $pat" || bad "rpcQuotaEnforce 缺少: $pat"
  done

  section "static [4/9] 订阅路由 rpcSubscriptionRoutes"
  for ep in "plans" "issue-key" "checkout" "payment-check" "payment-callback" "verify" "usage"; do
    grep -qF "/$ep" projects/chain-rpc/src/routes/rpcSubscriptionRoutes.ts && ok "订阅路由含: /$ep" || bad "订阅路由缺少: /$ep"
  done

  section "static [5/9] index.ts 挂载 + auth rx_ 校验"
  grep -qF "rpcQuotaEnforce" projects/chain-rpc/src/index.ts && ok "读路由挂扣减中间件" || bad "读路由未挂扣减"
  grep -qF "subscriptionRouter" projects/chain-rpc/src/index.ts && ok "/v1/subscription 路由挂载" || bad "/v1/subscription 未挂载"
  grep -qF "initRpcTables" projects/chain-rpc/src/index.ts && ok "启动时表自举" || bad "表自举未接入"
  grep -qF "findRpcKeyByRaw" projects/chain-rpc/src/middleware/auth.ts && ok "readAuth 支持 rx_ key 校验" || bad "readAuth 缺 rx_ 校验"
  grep -qF "req.rpcKey" projects/chain-rpc/src/middleware/auth.ts && ok "readAuth 注入 rpcKey" || bad "readAuth 未注入 rpcKey"

  section "static [6/9] chain-rpc tsc"
  (cd projects/chain-rpc && npx tsc --noEmit >/dev/null 2>&1) && ok "chain-rpc tsc 通过" || bad "chain-rpc tsc 报错"

  section "static [7/9] 套餐模型一致性（三档 + planId 映射）"
  local n
  n=$(grep -c "name: 'RPC" projects/chain-rpc/src/services/rpcSubscription.ts)
  [ "$n" -ge 3 ] && ok "三档套餐（n=$n）" || bad "套餐数异常: $n"
  grep -q '"rpc_pro":5,"rpc_enterprise":6' projects/chain-rpc/src/services/rpcSubscription.ts && ok "planId 链上映射 5/6" || bad "planId 映射缺失"

  section "static [8/9] .env.example 计费配置"
  for pat in "CHAIN_RPC_DATABASE_URL" "PAYMENTS_URL" "PAYMENTS_WEBHOOK_SECRET" "PAYMENTS_PLAN_ID_MAP"; do
    grep -qF "$pat" projects/chain-rpc/.env.example && ok ".env.example 含: $pat" || bad ".env.example 缺少: $pat"
  done

  section "static [9/9] tasklist 状态"
  grep -q "T-3 Chain RPC 对外读套餐（✅" docs/infrax_tasklist.md && ok "tasklist MQ-16 T-3 已标记 ✅" || bad "tasklist T-3 未标记 ✅（实现完成后同步）"

  summary
}

# ═══════════ api：生产服务联调 ═══════════
api() {
  local DB=${DB:-infrax_chainrpc}
  [ -n "$BRIDGE_KEY" ] || { echo "需要 BRIDGE_KEY（chain-rpc 读 key）"; exit 1; }

  section "api [1/12] chain-rpc 冒烟 + 套餐列表"
  curl -sf "$RPC_BASE/health" >/dev/null 2>&1 && ok "chain-rpc /health" || bad "chain-rpc /health 失败"
  local plans
  plans=$(curl -s "$RPC_BASE/v1/subscription/plans")
  for p in rpc_free rpc_pro rpc_enterprise; do
    echo "$plans" | python3 -c "import json,sys; d=json.load(sys.stdin); ids=[x['id'] for x in (d.get('data') or d)]; sys.exit(0 if '$p' in ids else 1)" && ok "plan: $p" || bad "缺少 plan: $p"
  done

  section "api [2/12] issue-key 签发 rx_ key（bridge key 管理操作）"
  local ISSUE
  ISSUE=$(curl -s -X POST -H "X-Service-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d '{"label":"mq16-t3-test"}' "$RPC_BASE/v1/subscription/issue-key")
  echo "$ISSUE" | python3 -c "import json,sys; d=json.load(sys.stdin); k=(d.get('data') or {}).get('rpcKey'); sys.exit(0 if (k or '').startswith('rx_') else 1)" && ok "issue-key 签发成功" || bad "issue-key 失败: $ISSUE"
  local KEY
  KEY=$(echo "$ISSUE" | python3 -c "import json,sys; print((json.load(sys.stdin).get('data') or {}).get('rpcKey',''))")
  local key_id
  key_id=$(sudo -u postgres psql -d "$DB" -t -A -c "SELECT id FROM rpc_keys WHERE key_prefix='${KEY:0:8}'" 2>/dev/null)

  section "api [3/12] 无 key → 401"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"method":"eth_chainId"}' "$RPC_BASE/v1/rpc/eth")
  [ "$code" = "401" ] && ok "无 key 401" || bad "无 key 返回 $code"

  section "api [4/12] 伪造 rx_ key → 401"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-API-Key: rx_fake1234567890abcdef' -H 'Content-Type: application/json' -d '{"method":"eth_chainId"}' "$RPC_BASE/v1/rpc/eth")
  [ "$code" = "401" ] && ok "伪造 rx_ key 401" || bad "伪造 key 返回 $code"

  section "api [5/12] rx_ key 调用读端点 → 200 + 扣减"
  local used_before used_after
  used_before=$(sudo -u postgres psql -d "$DB" -t -A -c "SELECT COUNT(*) FROM rpc_usage WHERE key_id=$key_id" 2>/dev/null || echo 0)
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"method":"eth_chainId"}' "$RPC_BASE/v1/rpc/eth")
  [ "$code" = "200" ] && ok "rpc/eth 200" || bad "rpc 端点返回 $code"
  sleep 1
  used_after=$(sudo -u postgres psql -d "$DB" -t -A -c "SELECT COUNT(*) FROM rpc_usage WHERE key_id=$key_id" 2>/dev/null || echo 0)
  [ "${used_after:-0}" -eq $((used_before + 1)) ] && ok "扣减生效: $used_before → $used_after" || bad "扣减异常: before=$used_before after=$used_after"

  section "api [6/12] usage 真实用量（plan=rpc_free quota=10000）"
  local r
  r=$(curl -s -H "X-API-Key: $KEY" "$RPC_BASE/v1/subscription/usage")
  [ "$(echo "$r" | jget data.planId)" = "rpc_free" ] && [ "$(echo "$r" | jget data.monthlyQuota)" = "10000" ] && ok "usage: plan=rpc_free quota=10000" || bad "usage 异常: $r"
  echo "  currentUsage=$(echo "$r" | jget data.currentUsage) subStatus=$(echo "$r" | jget data.rpcSubStatus)"

  section "api [7/12] 付费订阅 rpc_pro（chain rail）→ pending + 引擎支付信息"
  r=$(curl -s -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"plan_id":"rpc_pro"}' "$RPC_BASE/v1/subscription/checkout")
  [ "$(echo "$r" | jget data.rpcSubStatus)" = "pending" ] && ok "rpc_pro → pending" || bad "checkout 失败: $r"
  [ "$(echo "$r" | jget data.payment.rail)" = "chain" ] && ok "rail=chain" || bad "rail 异常: $r"
  [ -n "$(echo "$r" | jget data.payment.price)" ] && [ -n "$(echo "$r" | jget data.payment.subscriptionManager)" ] && ok "链上订阅信息（price/manager/chainId=$(echo "$r" | jget data.payment.chainId)）" || bad "支付信息缺失: $r"

  section "api [8/12] payment-check 轮询（无真实链上订阅 → pending）"
  r=$(curl -s -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{}' "$RPC_BASE/v1/subscription/payment-check")
  [ "$(echo "$r" | jget data.status)" = "pending" ] && ok "payment-check → pending（链上未订阅）" || bad "payment-check 异常: $r"

  section "api [9/12] 免费套餐切换（rpc_free 直激活，幂等）"
  r=$(curl -s -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"plan_id":"rpc_free"}' "$RPC_BASE/v1/subscription/checkout")
  [ "$(echo "$r" | jget data.free)" = "True" ] && ok "rpc_free → active" || bad "free 激活异常: $r"

  section "api [10/12] 配额限流 503（直接灌 rpc_usage 至超配额）"
  local quota used ins
  quota=$(curl -s -H "X-API-Key: $KEY" "$RPC_BASE/v1/subscription/usage" | jget data.monthlyQuota)
  used=$(sudo -u postgres psql -d "$DB" -t -A -c "SELECT COUNT(*) FROM rpc_usage WHERE key_id=$key_id" 2>/dev/null || echo "0")
  ins=$((quota - used + 1))
  sudo -u postgres psql -d "$DB" -c "INSERT INTO rpc_usage (key_id, endpoint) SELECT $key_id,'mq16-t3-test' FROM generate_series(1,$ins)" >/dev/null 2>&1
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"method":"eth_chainId"}' "$RPC_BASE/v1/rpc/eth")
  [ "$code" = "503" ] && ok "超配额 → 503（+$ins 行）" || bad "超配额未 503，返回 $code"
  sudo -u postgres psql -d "$DB" -c "DELETE FROM rpc_usage WHERE key_id=$key_id AND endpoint='mq16-t3-test'" >/dev/null 2>&1

  section "api [11/12] payment-callback 负向（无签名 → 401）"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"type":"webhook"}' "$RPC_BASE/v1/subscription/payment-callback")
  [ "$code" = "401" ] && ok "无签名回调 401" || bad "无签名回调返回 $code"

  section "api [12/12] 清理测试数据"
  sudo -u postgres psql -d "$DB" -c "DELETE FROM rpc_usage_daily WHERE key_id=$key_id; DELETE FROM rpc_usage WHERE key_id=$key_id; DELETE FROM rpc_keys WHERE id=$key_id;" >/dev/null 2>&1
  ok "已清理测试 key=$key_id"

  summary
}

summary() {
  echo
  echo "════════ 结果: ✅ $PASS 通过 / ❌ $FAIL 失败 ════════"
  [ "$FAIL" -gt 0 ] && exit 1 || exit 0
}

# JSON 点路径取值：echo "$json" | jget data.plan.id
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
