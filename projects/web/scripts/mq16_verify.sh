#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# MQ-16 T-1 联调验证 — DC 套餐配额真实扣减 + 付费订阅走支付引擎
#   1) static 子命令：本地 git 代码静态回归（新端点/新表/前端支付流程/语法）
#   2) api 子命令：生产服务联调（dc :9102 配额扣减 + 付费订阅引擎 rails + 429 限流）
# 用法：
#   本地：bash projects/web/scripts/mq16_verify.sh static
#   生产：scp 后 bash /tmp/mq16_verify.sh api
# ═════════════════════════════════════════════════════════════════════════════
set -uo pipefail

REPO=${REPO:-/home/ubuntu/infraX-1}
DC_BASE=${DC_BASE:-http://127.0.0.1:9102}

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
section() { echo; echo "━━━ $1 ━━━"; }

cd "$REPO" || { echo "REPO not found: $REPO"; exit 1; }

# ═══════════ static：本地 git 代码静态回归 ═══════════
static() {
  section "static [1/6] dc/index.ts — MQ-16 新能力存在"
  for pat in "CREATE TABLE IF NOT EXISTS api_usage " "CREATE TABLE IF NOT EXISTS api_usage_daily" "dc_sub_status" "dcQuotaEnforce" "activateDcSubscription" "api/v2/data/payment-check" "api/v2/data/payment-callback" "api/v2/data/verify"; do
    grep -qF "$pat" projects/dc/index.ts && ok "dc 含: $pat" || bad "dc 缺少: $pat"
  done
  local n
  n=$(grep -c "requireDcApiKey, dcQuotaEnforce" projects/dc/index.ts)
  [ "$n" -ge 6 ] && ok "6 个 B 端端点挂载配额中间件（n=$n）" || bad "配额中间件挂载数异常: $n"

  section "static [2/6] 前端 — 付费支付流程适配"
  grep -q "dcPollSubscription" projects/web/modules/datacenter.js && ok "datacenter.js 含 dcPollSubscription（chain 轮询）" || bad "缺少 dcPollSubscription"
  grep -q "dcSubmitX402" projects/web/modules/datacenter.js && ok "datacenter.js 含 dcSubmitX402（x402 verify）" || bad "缺少 dcSubmitX402"
  grep -q "payment-check" projects/web/modules/datacenter.js && ok "datacenter.js 引用 payment-check" || bad "缺少 payment-check 引用"
  grep -q 'id="dc-sub-status"' projects/web/index.html && ok "index.html 含 dc-sub-status 元素" || bad "index.html 缺少 dc-sub-status"
  grep -q 'pay.sessionUrl' projects/web/modules/datacenter.js && ok "datacenter.js fiat 跳转 sessionUrl" || bad "缺少 fiat 跳转"

  section "static [3/6] dc/index.ts 语法（tsc）"
  (cd projects/dc && npx tsc --noEmit --skipLibCheck --esModuleInterop --module nodenext --moduleResolution nodenext index.ts >/dev/null 2>&1) && ok "dc tsc 通过" || bad "dc tsc 报错"

  section "static [4/6] web js 语法"
  node --check projects/web/modules/datacenter.js && node --check projects/web/modules/core.js && node --check projects/web/server.js && ok "web js 语法 OK" || bad "web js 语法错误"

  section "static [5/6] tasklist 状态"
  grep -q "T-1 DC 套餐配额真实扣减（✅ 2026-08-11" docs/infrax_tasklist.md && ok "tasklist MQ-16 T-1 已标记 ✅" || bad "tasklist T-1 未标记 ✅"

  section "static [6/6] 无 :9106 残留（MQ-15 回归）"
  local h
  h=$(grep -rn "9106" projects/web projects/dc --include='*.js' --include='*.html' --include='*.ts' 2>/dev/null | grep -v node_modules | grep -vE 'admin.html' | head -3)
  [ -z "$h" ] && ok "web/dc 无 :9106 残留" || bad "残留 :9106: $h"

  summary
}

# ═══════════ api：生产服务联调 ═══════════
api() {
  ETHERS=${ETHERS:-$REPO/projects/waas/node_modules/ethers}

  section "api [1/11] DC 冒烟 + 套餐列表"
  curl -sf "$DC_BASE/health" >/dev/null 2>&1 && ok "dc /health" || bad "dc /health 失败"
  local plans
  plans=$(curl -s "$DC_BASE/api/v2/data/plans")
  for p in data_free data_pro data_enterprise; do
    echo "$plans" | python3 -c "import json,sys; d=json.load(sys.stdin); ids=[x['id'] for x in (d.get('data') or d)]; sys.exit(0 if '$p' in ids else 1)" && ok "plan: $p" || bad "缺少 plan: $p"
  done

  section "api [2/11] 测试钱包（ethers 随机生成）"
  local auth
  auth=$(node -e "
    const { Wallet } = require('$ETHERS');
    const w = Wallet.createRandom();
    console.log(w.address.toLowerCase());
  ")
  local ADDR=$auth
  echo "  测试钱包: $ADDR"
  [ -n "$ADDR" ] && ok "测试钱包生成" || bad "钱包生成失败"
  HDRS=(-H "x-wallet-address: $ADDR")

  section "api [3/11] free 订阅 → active + dcApiKey"
  local r tid
  r=$(curl -s -X POST "${HDRS[@]}" -H 'Content-Type: application/json' -d '{"planId":"data_free"}' "$DC_BASE/api/v2/data/subscribe")
  [ "$(echo "$r" | jget data.dcSubStatus)" = "active" ] && [ -n "$(echo "$r" | jget data.dcApiKey)" ] && ok "free 订阅 → active + dcApiKey" || bad "free 订阅失败: $r"
  tid=$(echo "$r" | jget data.tenantId)

  section "api [4/11] usage 真实用量（初始 0 / quota 10000）"
  r=$(curl -s "${HDRS[@]}" "$DC_BASE/api/v2/data/usage?walletAddress=$ADDR")
  [ "$(echo "$r" | jget data.planId)" = "data_free" ] && [ "$(echo "$r" | jget data.monthlyQuota)" = "10000" ] && ok "usage: plan=data_free quota=10000" || bad "usage 异常: $r"
  echo "  currentUsage=$(echo "$r" | jget data.currentUsage) dcSubStatus=$(echo "$r" | jget data.dcSubStatus)"

  section "api [5/11] B 端请求扣减（events 计数 +1）"
  local key used_before used_after
  key=$(echo "$r" | jget data.dcApiKey)
  used_before=$(echo "$r" | jget data.currentUsage)
  curl -sf -H "x-dc-api-key: $key" "$DC_BASE/api/v2/data/events?chain=sepolia&page_size=1" >/dev/null 2>&1 && ok "events 200（带 key）" || bad "events 请求失败"
  r=$(curl -s "${HDRS[@]}" "$DC_BASE/api/v2/data/usage?walletAddress=$ADDR")
  used_after=$(echo "$r" | jget data.currentUsage)
  [ "${used_after:-0}" -eq $((used_before + 1)) ] && ok "扣减生效: $used_before → $used_after" || bad "扣减异常: before=$used_before after=$used_after"

  section "api [6/11] 无 key → 401"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$DC_BASE/api/v2/data/events")
  [ "$code" = "401" ] && ok "无 key 401" || bad "无 key 返回 $code"

  section "api [7/11] 付费订阅 data_pro（chain rail）→ pending + 引擎支付信息"
  r=$(curl -s -X POST "${HDRS[@]}" -H 'Content-Type: application/json' -d '{"planId":"data_pro"}' "$DC_BASE/api/v2/data/subscribe")
  [ "$(echo "$r" | jget data.dcSubStatus)" = "pending" ] && ok "data_pro → pending" || bad "data_pro 订阅失败: $r"
  [ "$(echo "$r" | jget data.payment.rail)" = "chain" ] && ok "rail=chain" || bad "rail 异常: $r"
  [ -n "$(echo "$r" | jget data.payment.price)" ] && [ -n "$(echo "$r" | jget data.payment.subscriptionManager)" ] && ok "链上订阅信息（price/manager/chainId=$(echo "$r" | jget data.payment.chainId)）" || bad "支付信息缺失: $r"

  section "api [8/11] payment-check 轮询（无真实链上订阅 → pending）"
  r=$(curl -s -X POST "${HDRS[@]}" -H 'Content-Type: application/json' "$DC_BASE/api/v2/data/payment-check")
  [ "$(echo "$r" | jget data.status)" = "pending" ] && ok "payment-check → pending（链上未订阅）" || bad "payment-check 异常: $r"

  section "api [9/11] 配额限流 429（直接灌 api_usage 至超配额）"
  local quota used ins
  quota=$(curl -s "${HDRS[@]}" "$DC_BASE/api/v2/data/usage?walletAddress=$ADDR" | jget data.monthlyQuota)
  used=$(sudo -u postgres psql -d infrax_dc -t -A -c "SELECT COUNT(*) FROM api_usage WHERE tenant_id='$tid'" 2>/dev/null || echo "0")
  ins=$((quota - used + 1))
  sudo -u postgres psql -d infrax_dc -c "INSERT INTO api_usage (tenant_id, endpoint) SELECT '$tid','mq16-test' FROM generate_series(1,$ins)" >/dev/null 2>&1
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "x-dc-api-key: $key" "$DC_BASE/api/v2/data/events?chain=sepolia&page_size=1")
  [ "$code" = "429" ] && ok "超配额 → 429（+$ins 行）" || bad "超配额未 429，返回 $code"
  sudo -u postgres psql -d infrax_dc -c "DELETE FROM api_usage WHERE tenant_id='$tid' AND endpoint='mq16-test'" >/dev/null 2>&1

  section "api [10/11] payment-callback 负向（无签名/伪造签名 → 401）"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"type":"webhook"}' "$DC_BASE/api/v2/data/payment-callback")
  [ "$code" = "401" ] && ok "无签名回调 401" || bad "无签名回调返回 $code"

  section "api [11/11] 回归 free + 清理测试数据"
  r=$(curl -s -X POST "${HDRS[@]}" -H 'Content-Type: application/json' -d '{"planId":"data_free"}' "$DC_BASE/api/v2/data/subscribe")
  [ "$(echo "$r" | jget data.dcSubStatus)" = "active" ] && ok "回归：再次订阅 free → active" || bad "回归失败: $r"
  local uid
  uid=$(sudo -u postgres psql -d infrax_dc -t -A -c "SELECT id FROM users WHERE wallet_address='$ADDR'" 2>/dev/null || echo "")
  if [ -n "$uid" ]; then
    sudo -u postgres psql -d infrax_dc -c "DELETE FROM api_usage_daily WHERE tenant_id IN (SELECT id FROM tenants WHERE owner_user_id='$uid'); DELETE FROM api_usage WHERE tenant_id IN (SELECT id FROM tenants WHERE owner_user_id='$uid'); DELETE FROM tenants WHERE owner_user_id='$uid'; DELETE FROM users WHERE id='$uid';" >/dev/null 2>&1
    ok "已清理测试数据（user=$uid）"
  else
    ok "无测试数据残留"
  fi

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
