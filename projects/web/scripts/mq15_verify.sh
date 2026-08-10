#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# MQ-15 T-5 联调验证 — 旧 payment (:9106) 下线迁移
#   1) static 子命令：本地 git 代码静态回归（无 :9106 / 旧 payment 引用）
#   2) api 子命令：生产服务联调（waas 订阅全流程无回归 + payments 引擎 :9132 + admin）
# 用法：
#   本地：bash projects/web/scripts/mq15_verify.sh static
#   生产：scp 后 bash /tmp/mq15_verify.sh api
# ═════════════════════════════════════════════════════════════════════════════
set -uo pipefail

REPO=${REPO:-/home/ubuntu/infraX-1}
PAY_BASE=${PAY_BASE:-http://127.0.0.1:9132}
WAAS_BASE=${WAAS_BASE:-http://127.0.0.1:9109}
ADMIN_BASE=${ADMIN_BASE:-http://127.0.0.1:9100}
PAY_KEY=$(sudo grep -rhoP 'PAYMENTS_API_KEY=\K[^"]*' \
  /etc/systemd/system/infrax-payments.service.d/*.conf \
  /etc/systemd/system/infrax-waas.service.d/*.conf 2>/dev/null | head -1)

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
section() { echo; echo "━━━ $1 ━━━"; }

cd "$REPO" || { echo "REPO not found: $REPO"; exit 1; }

# ═══════════ static：本地 git 代码静态回归 ═══════════
static() {
  section "static [1/4] web — 无 :9106 / 旧 payment 引用"
  local h
  h=$(grep -rn "9106" projects/web --include='*.js' --include='*.html' 2>/dev/null | grep -v node_modules | grep -vE 'admin.html' | head -5)
  [ -z "$h" ] && ok "web 无 :9106（admin.html 仅 i18n 字典，已确认）" || bad "web 残留 :9106: $h"
  [ -f projects/web/modules/payment.js ] && bad "payment.js 仍存在" || ok "payment.js 已删除"
  h=$(grep -c "id=\"page-payment\"\|data-page=\"payment\"" projects/web/index.html 2>/dev/null)
  [ "$h" = "0" ] && ok "index.html 无 page-payment / 导航项" || bad "index.html 残留 payment 页面/导航"

  section "static [2/4] web proxy — 无 /api/v2/payment 路由"
  h=$(grep -n "api/v2/payment\|PAYMENT_HOST\|PAYMENT_PORT" projects/web/server.js 2>/dev/null)
  [ -z "$h" ] && ok "server.js 无旧代理路由/常量" || bad "server.js 残留: $h"

  section "static [3/4] admin — 无旧库/端口引用"
  h=$(grep -rn "pocketx_payment\b\|pools\.payment\b\|total_usd\|:9106" projects/admin/server projects/admin/src 2>/dev/null | grep -v node_modules | head -5)
  [ -z "$h" ] && ok "admin 代码无旧库/旧字段/旧端口" || bad "admin 残留: $h"

  section "static [4/4] sdk — 无旧支付端点"
  h=$(grep -n "api/v2/payment\|x402Pay\|X402Pay" projects/sdk/src/index.ts 2>/dev/null | grep -vE '^\s*[0-9]+://')
  [ -z "$h" ] && ok "sdk 无旧端点/假支付方法（仅注释提及已下线）" || bad "sdk 残留: $h"

  section "static 语法检查"
  node --check projects/web/modules/core.js && node --check projects/web/server.js && ok "web js 语法 OK" || bad "web js 语法错误"

  summary
}

# ═══════════ api：生产服务联调 ═══════════
api() {
  [ -z "$PAY_KEY" ] && { echo "未找到 PAYMENTS_API_KEY"; exit 1; }
  ETHERS=${ETHERS:-$REPO/projects/waas/node_modules/ethers}

  section "api [1/6] payments 引擎 :9132 冒烟"
  curl -sf "$PAY_BASE/health" >/dev/null 2>&1 && ok "payments /health" || bad "payments /health 失败"
  local caps
  caps=$(curl -s -H "X-API-Key: $PAY_KEY" "$PAY_BASE/payments/capabilities")
  echo "  启用能力: $(echo "$caps" | python3 -c 'import json,sys; d=json.load(sys.stdin).get("capabilities",{}); print(", ".join(k for k,v in d.items() if v.get("enabled")) or "(none)")' 2>/dev/null)"
  local n_caps
  n_caps=$(echo "$caps" | python3 -c 'import json,sys; print(len([k for k,v in json.load(sys.stdin).get("capabilities",{}).items() if v.get("enabled")]))' 2>/dev/null)
  [ "${n_caps:-0}" -gt 0 ] && ok "capabilities 可读（enabled=$n_caps）" || bad "capabilities 异常"
  local price
  price=$(curl -s -H "X-API-Key: $PAY_KEY" "$PAY_BASE/payments/price?planId=1")
  [ -n "$(echo "$price" | jget price)" ] && ok "price(planId=1): $(echo "$price" | jget price)" || bad "price 异常: $price"
  local bal
  bal=$(curl -s -H "X-API-Key: $PAY_KEY" "$PAY_BASE/payments/balance?address=0x0000000000000000000000000000000000000001")
  [ -n "$(echo "$bal" | jget balanceWei)" ] && ok "balance 可读（balanceWei=$(echo "$bal" | jget balanceWei)）" || bad "balance 异常: $bal"

  section "api [2/6] waas 订阅 /plans（公开）"
  local plans
  plans=$(curl -s "$WAAS_BASE/api/v2/subscription/plans")
  for p in free pro enterprise; do
    echo "$plans" | python3 -c "import json,sys; d=json.load(sys.stdin); ids=[x['id'] for x in (d.get('data') or d)]; sys.exit(0 if '$p' in ids else 1)" && ok "plan: $p" || bad "缺少 plan: $p"
  done

  section "api [3/6] waas 订阅全流程（测试钱包签名，EIP-191）"
  local auth
  auth=$(node -e "
    (async () => {
      const { Wallet } = require('$ETHERS');
      const w = Wallet.createRandom();
      const ts = String(Date.now());
      const sig = await w.signMessage('InfraX auth: ' + ts);
      console.log(JSON.stringify({ address: w.address.toLowerCase(), ts, sig }));
    })();
  ")
  local ADDR TS SIG
  ADDR=$(echo "$auth" | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])')
  TS=$(echo "$auth" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ts"])')
  SIG=$(echo "$auth" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sig"])')
  AUTH_HDRS=(-H "x-wallet-address: $ADDR" -H "x-wallet-signature: $SIG" -H "x-wallet-timestamp: $TS")
  echo "  测试钱包: $ADDR"

  section "api [4/6] 订阅 free → active"
  local r
  r=$(curl -s -X POST "${AUTH_HDRS[@]}" -H 'Content-Type: application/json' -d '{"planId":"free"}' "$WAAS_BASE/api/v2/subscription/subscribe")
  [ "$(echo "$r" | jget data.subscription.status)" = "active" ] && ok "free 订阅 → active" || bad "free 订阅失败: $r"
  r=$(curl -s "${AUTH_HDRS[@]}" "$WAAS_BASE/api/v2/subscription/me")
  [ "$(echo "$r" | jget data.plan.id)" = "free" ] && ok "/me → free" || bad "/me 异常: $r"

  section "api [5/6] 付费订阅（chain rail + fiat rail）"
  r=$(curl -s -X POST "${AUTH_HDRS[@]}" -H 'Content-Type: application/json' -d '{"planId":"pro"}' "$WAAS_BASE/api/v2/subscription/subscribe")
  [ "$(echo "$r" | jget data.payment.rail)" = "chain" ] && ok "pro chain rail → payment 信息（price=$(echo "$r" | jget data.payment.price)）" || bad "pro chain rail 失败: $r"
  r=$(curl -s -X POST "${AUTH_HDRS[@]}" -H 'Content-Type: application/json' -d '{"planId":"pro","rail":"fiat"}' "$WAAS_BASE/api/v2/subscription/subscribe")
  local fiat_on
  fiat_on=$(echo "$caps" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("capabilities",{}).get("fiat",{}).get("enabled", False))' 2>/dev/null)
  if [ "$fiat_on" = "True" ]; then
    [ -n "$(echo "$r" | jget data.payment.sessionUrl)" ] && ok "pro fiat rail → Stripe sessionUrl" || bad "pro fiat rail 失败: $r"
  else
    echo "  ⏭  fiat 未启用（capabilities.fiat.enabled=false），跳过 fiat 断言"
    ok "fiat rail（按能力开关跳过，不阻塞）"
  fi

  section "api [6/6] 回归 free + admin 冒烟"
  r=$(curl -s -X POST "${AUTH_HDRS[@]}" -H 'Content-Type: application/json' -d '{"planId":"free"}' "$WAAS_BASE/api/v2/subscription/subscribe")
  [ "$(echo "$r" | jget data.subscription.status)" = "active" ] && ok "回归：再次订阅 free → active" || bad "回归失败: $r"
  curl -sf "$ADMIN_BASE/health" >/dev/null 2>&1 && ok "admin /health" || bad "admin /health 失败"

  section "api 日志残留（自服务重启后）"
  local n_web n_adm since_web since_adm
  since_web=$(systemctl show -p ActiveEnterTimestamp --value infrax-web 2>/dev/null)
  since_adm=$(systemctl show -p ActiveEnterTimestamp --value infrax-admin 2>/dev/null)
  n_web=$(journalctl -u infrax-web --since "$since_web" 2>/dev/null | grep -c ":9106" || true)
  n_adm=$(journalctl -u infrax-admin --since "$since_adm" 2>/dev/null | grep -c ":9106" || true)
  [ "$n_web" = "0" ] && ok "web 日志自重启后 :9106 命中 0" || bad "web 日志自重启后 :9106 命中 $n_web（应恒为 0）"
  [ "$n_adm" = "0" ] && ok "admin 日志自重启后 :9106 命中 0" || bad "admin 日志自重启后 :9106 命中 $n_adm（应恒为 0）"

  section "api 清理测试数据"
  local uid
  uid=$(sudo -u postgres psql -d pocketx_waas -t -A -c "SELECT id FROM users WHERE wallet_address='$ADDR'" 2>/dev/null || echo "")
  if [ -n "$uid" ]; then
    sudo -u postgres psql -d pocketx_waas -c "DELETE FROM subscriptions WHERE user_id='$uid'; DELETE FROM users WHERE id='$uid';" >/dev/null 2>&1
    ok "已清理测试钱包数据（user=$uid）"
  else
    ok "无测试数据残留（用户未落库）"
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
