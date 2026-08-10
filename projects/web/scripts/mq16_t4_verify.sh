#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# MQ-16 T-4 联调验证 — MPC Agent Wallet 按量套餐（签名/转账按次从引擎 ledger 余额扣费）
#   1) static 子命令：本地 git 代码静态回归（费用表/计费中间件/端点/语法冒烟）
#   2) api 子命令：生产服务联调（mpc :9104 注册→解锁→按量扣费→余额不足 402）
# 用法：
#   本地：bash projects/web/scripts/mq16_t4_verify.sh static
#   生产：BRIDGE_KEY=<mpc bridge key> bash /tmp/mq16_t4_verify.sh api
# ═════════════════════════════════════════════════════════════════════════════
set -uo pipefail

REPO=${REPO:-/home/ubuntu/infraX-1}
MPC_BASE=${MPC_BASE:-http://127.0.0.1:9104}
BRIDGE_KEY=${BRIDGE_KEY:-}
MPC_DB=${MPC_DB:-pocketx_mpc}
PAY_DB=${PAY_DB:-pocketx_payments}

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
section() { echo; echo "━━━ $1 ━━━"; }

cd "$REPO" || { echo "REPO not found: $REPO"; exit 1; }

# ═══════════ static：本地 git 代码静态回归 ═══════════
static() {
  section "static [1/9] mpcPlans.ts — 按量套餐模块存在"
  [ -f projects/mpc/src/mpcPlans.ts ] && ok "mpcPlans.ts 存在" || bad "缺少 mpcPlans.ts"
  for pat in "chargeMpcCall" "mpcFees" "mpcLedgerBalance" "topupHint" "mpcPaymentsApi" "payments/transfers" "payments/balance" "MpcChargeError"; do
    grep -qF "$pat" projects/mpc/src/mpcPlans.ts && ok "mpcPlans 含: $pat" || bad "mpcPlans 缺少: $pat"
  done

  section "static [2/9] 按次单价（sign=0.0001 / tx=0.001，env 可覆盖）"
  grep -qF "MPC_SIGN_FEE_WEI" projects/mpc/src/mpcPlans.ts && ok "sign 单价 env 可配" || bad "缺 MPC_SIGN_FEE_WEI"
  grep -qF "MPC_TX_FEE_WEI" projects/mpc/src/mpcPlans.ts && ok "tx 单价 env 可配" || bad "缺 MPC_TX_FEE_WEI"
  local n
  n=$(grep -c "operation:" projects/mpc/src/mpcPlans.ts)
  [ "$n" -ge 5 ] && ok "5 类收费操作（n=$n）" || bad "收费操作数异常: $n"

  section "static [3/9] server.ts 计费中间件 mpcMeter"
  grep -qF "function mpcMeter" projects/mpc/server.ts && ok "mpcMeter 定义" || bad "缺 mpcMeter"
  for op in sign_message sign_typed_data sign_digest send_transaction contract_write; do
    grep -qF "mpcMeter('$op')" projects/mpc/server.ts && ok "挂载: $op" || bad "未挂载: $op"
  done
  grep -qF "chargeMpcCall" projects/mpc/server.ts && ok "中间件调用 chargeMpcCall" || bad "未调用 chargeMpcCall"
  grep -qF "err.status === 402" projects/mpc/server.ts && ok "402 错误信封处理" || bad "缺 402 处理"

  section "static [4/9] plans / ledger-balance 端点 + auth 豁免"
  grep -qF "api/v2/mpc/plans" projects/mpc/server.ts && ok "GET /api/v2/mpc/plans" || bad "缺 plans 端点"
  grep -qF "api/v2/mpc/ledger-balance" projects/mpc/server.ts && ok "POST /api/v2/mpc/ledger-balance" || bad "缺 ledger-balance 端点"
  grep -qF "exempt: ['/api/v2/mpc/plans']" projects/mpc/server.ts && ok "plans 公开豁免" || bad "plans 未豁免"

  section "static [5/9] .env.example 计费配置"
  for pat in "MPC_PAYMENTS_URL" "MPC_PAYMENTS_API_KEY" "MPC_PLATFORM_ADDRESS" "MPC_SIGN_FEE_WEI" "MPC_TX_FEE_WEI"; do
    grep -qF "$pat" projects/mpc/.env.example && ok ".env.example 含: $pat" || bad ".env.example 缺少: $pat"
  done

  section "static [6/9] mpc 语法/导入冒烟（tsx 起服务 + /health）"
  local smoke_port=6399 hc
  (cd projects/mpc && PORT=$smoke_port MPC_ENCRYPTION_SECRET=test-smoke npx tsx server.ts >/tmp/mq16t4_smoke.log 2>&1) &
  local spid=$!
  sleep 4
  hc=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$smoke_port/health" 2>/dev/null || echo 000)
  kill "$spid" 2>/dev/null
  [ "$hc" = "200" ] && ok "server.ts 启动 + /health 200" || bad "server.ts 启动失败（hc=$hc，log: $(tail -2 /tmp/mq16t4_smoke.log | tr '\n' ' ')）"

  section "static [7/9] 读操作豁免（balance/contract-read/gas-estimate 不计费）"
  grep -qF "/api/v2/mpc/balance" projects/mpc/server.ts && ok "balance 端点存在" || bad "缺 balance"
  grep -qF "mpcMeter(" projects/mpc/server.ts || bad "无任何 mpcMeter 挂载"
  local n2
  n2=$(grep -c "mpcMeter(" projects/mpc/server.ts)
  [ "$n2" -ge 5 ] && ok "收费端点数=$n2（读操作不计费）" || bad "收费端点数异常: $n2"

  section "static [8/9] 引擎能力前置（transfer rail 契约）"
  grep -qF "transfers" projects/payments/src/router.ts && ok "引擎 /payments/transfers 端点" || bad "引擎缺 transfers 端点"
  grep -qF "payment_balances" projects/payments/src/store.ts && ok "ledger 表 payment_balances" || bad "引擎缺 ledger 表"

  section "static [9/9] tasklist 状态"
  grep -q "T-4 MPC Agent Wallet 按量套餐（✅" docs/infrax_tasklist.md && ok "tasklist MQ-16 T-4 已标记 ✅" || bad "tasklist T-4 未标记 ✅（实现部署完成后同步）"

  summary
}

# ═══════════ api：生产服务联调 ═══════════
api() {
  [ -n "$BRIDGE_KEY" ] || { echo "需要 BRIDGE_KEY（mpc bridge key）"; exit 1; }

  section "api [1/13] mpc 冒烟 + 套餐列表（公开）"
  curl -sf "$MPC_BASE/health" >/dev/null 2>&1 && ok "mpc /health" || bad "mpc /health 失败"
  local plans
  plans=$(curl -s "$MPC_BASE/api/v2/mpc/plans")
  echo "$plans" | python3 -c "import json,sys; d=json.load(sys.stdin); f=d['data']['fees']; ids=[x['operation'] for x in f]; ok=all(x in ids for x in ['sign_message','sign_typed_data','sign_digest','send_transaction','contract_write']); sys.exit(0 if ok and d['data']['mode']=='pay_per_use' else 1)" && ok "plans: 5 类收费操作 + pay_per_use" || bad "plans 异常: $plans"

  section "api [2/13] 注册测试钱包（send-code → journal 取码 → register）"
  local email ts
  ts=$(date +%s)
  email="mq16t4+${ts}@test.infrax.dev"
  curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"email\":\"$email\"}" "$MPC_BASE/api/v2/mpc/send-code" >/dev/null
  sleep 1
  local code
  code=$(sudo journalctl -u infrax-mpc --since "-3 min" 2>/dev/null | grep "Code for ${email}:" | tail -1 | grep -oE '[0-9]{6}' | tail -1)
  [ -n "$code" ] && ok "验证码提取（journal）" || bad "验证码提取失败"
  local reg
  reg=$(curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"code\":\"$code\"}" "$MPC_BASE/api/v2/mpc/register")
  local waddr
  waddr=$(echo "$reg" | jget data.walletAddress)
  [ -n "$waddr" ] && [ "$(echo "$reg" | jget code)" = "0" ] && ok "register → wallet=$waddr" || bad "register 失败: $reg"

  section "api [3/13] 解锁会话（新验证码 → token）"
  curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"email\":\"$email\"}" "$MPC_BASE/api/v2/mpc/send-code" >/dev/null
  sleep 1
  local code2
  code2=$(sudo journalctl -u infrax-mpc --since "-3 min" 2>/dev/null | grep "Code for ${email}:" | tail -1 | grep -oE '[0-9]{6}' | tail -1)
  local unlock
  unlock=$(curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"code\":\"$code2\"}" "$MPC_BASE/api/v2/mpc/session/unlock")
  local token
  token=$(echo "$unlock" | jget data.token)
  [ -n "$token" ] && ok "session token 获取" || bad "unlock 失败: $unlock"

  section "api [4/13] ledger-balance（0 余额）"
  local lb
  lb=$(curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"token\":\"$token\"}" "$MPC_BASE/api/v2/mpc/ledger-balance")
  [ "$(echo "$lb" | jget data.balanceWei)" = "0" ] && ok "ledger 余额=0" || bad "ledger 余额异常: $lb"
  [ -n "$(echo "$lb" | jget data.topupHint)" ] && ok "充值提示存在" || bad "缺充值提示"

  section "api [5/13] 0 余额 sign-message → 402（按量计费生效）"
  local code402
  code402=$(curl -s -o /tmp/mq16t4_402.json -w '%{http_code}' -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"token\":\"$token\",\"message\":\"mq16-t4-no-balance\"}" "$MPC_BASE/api/v2/mpc/sign-message")
  [ "$code402" = "402" ] && ok "余额不足 → 402" || bad "期望 402 实得 $code402"
  grep -q "充值路径" /tmp/mq16t4_402.json && ok "402 含充值提示" || bad "402 缺充值提示"

  section "api [6/13] 灌 ledger 余额（0.001 → 10 次 sign 可用）"
  sudo -u postgres psql -d "$PAY_DB" -c "INSERT INTO payment_balances (address, asset, balance_wei) VALUES ('$waddr', '0x0000000000000000000000000000000000000000', '1000000000000000') ON CONFLICT (address, asset) DO UPDATE SET balance_wei = payment_balances.balance_wei::numeric + 1000000000000000::numeric;" >/dev/null 2>&1
  lb=$(curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"token\":\"$token\"}" "$MPC_BASE/api/v2/mpc/ledger-balance")
  [ "$(echo "$lb" | jget data.balanceWei)" = "1000000000000000" ] && ok "ledger 余额=0.001" || bad "灌余额失败: $lb"

  section "api [7/13] sign-message → 200 + 签名（TSS）"
  local sm
  sm=$(curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"token\":\"$token\",\"message\":\"mq16-t4-metered\"}" "$MPC_BASE/api/v2/mpc/sign-message")
  [ "$(echo "$sm" | jget code)" = "0" ] && [ -n "$(echo "$sm" | jget data.signature)" ] && ok "sign 成功" || bad "sign 失败: $sm"

  section "api [8/13] 扣费生效（余额 0.001 → 0.0009；transfer 落库 executed）"
  lb=$(curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"token\":\"$token\"}" "$MPC_BASE/api/v2/mpc/ledger-balance")
  [ "$(echo "$lb" | jget data.balanceWei)" = "900000000000000" ] && ok "扣减 0.0001：0.001→0.0009" || bad "扣减异常: $lb"
  local trow
  trow=$(sudo -u postgres psql -d "$PAY_DB" -t -A -c "SELECT status FROM payment_transfers WHERE from_addr='$waddr' ORDER BY created_at DESC LIMIT 1" 2>/dev/null)
  [ "$trow" = "executed" ] && ok "引擎 transfer executed" || bad "transfer 状态异常: $trow"

  section "api [9/13] 重复调用幂等扣费（每次独立 reference，逐次扣减）"
  local b0 b1
  sm=$(curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"token\":\"$token\",\"message\":\"mq16-t4-metered-2\"}" "$MPC_BASE/api/v2/mpc/sign-message")
  [ "$(echo "$sm" | jget code)" = "0" ] && ok "第二次 sign 成功" || bad "第二次 sign 失败: $sm"
  b1=$(curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"token\":\"$token\"}" "$MPC_BASE/api/v2/mpc/ledger-balance" | jget data.balanceWei)
  [ "$b1" = "800000000000000" ] && ok "再次扣减 → 0.0008" || bad "二次扣减异常: $b1"

  section "api [10/13] 读端点豁免（contract-read / gas-estimate 不计费）"
  local lb_before lb_after
  lb_before=$(curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"token\":\"$token\"}" "$MPC_BASE/api/v2/mpc/ledger-balance" | jget data.balanceWei)
  curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"token\":\"$token\",\"to\":\"0x0000000000000000000000000000000000000001\",\"value\":\"0\",\"chain\":\"sepolia\"}" "$MPC_BASE/api/v2/mpc/gas-estimate" >/dev/null
  lb_after=$(curl -s -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"token\":\"$token\"}" "$MPC_BASE/api/v2/mpc/ledger-balance" | jget data.balanceWei)
  [ "$lb_before" = "$lb_after" ] && ok "gas-estimate 不计费（$lb_before）" || bad "读端点误扣费: $lb_before → $lb_after"

  section "api [11/13] 消耗至不足 → 402（余额清零后）"
  local fee=100000000000000
  local deplete=$((800000000000000 / fee))
  local i
  for i in $(seq 1 $((deplete + 1))); do
    code402=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"token\":\"$token\",\"message\":\"mq16-t4-deplete-$i\"}" "$MPC_BASE/api/v2/mpc/sign-message")
    [ "$code402" = "402" ] && break
  done
  [ "$code402" = "402" ] && ok "余额耗尽 → 402（$i 次后）" || bad "耗尽后未 402"

  section "api [12/13] 无 key → 401 / 伪造 token → 401"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "{\"token\":\"mpc_fake\",\"message\":\"x\"}" "$MPC_BASE/api/v2/mpc/sign-message")
  [ "$code" = "401" ] && ok "无 key 401" || bad "无 key 返回 $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-API-Key: $BRIDGE_KEY" -H 'Content-Type: application/json' -d "{\"token\":\"mpc_fake\",\"message\":\"x\"}" "$MPC_BASE/api/v2/mpc/sign-message")
  [ "$code" = "401" ] && ok "伪造 token 401" || bad "伪造 token 返回 $code"

  section "api [13/13] 清理测试数据"
  sudo -u postgres psql -d "$MPC_DB" -c "DELETE FROM mpc_sessions WHERE email='$email'; DELETE FROM mpc_verification_codes WHERE email='$email'; DELETE FROM mpc_wallets WHERE email='$email';" >/dev/null 2>&1
  sudo -u postgres psql -d "$PAY_DB" -c "DELETE FROM payment_transfers WHERE from_addr='$waddr'; DELETE FROM payment_balances WHERE address='$waddr';" >/dev/null 2>&1
  ok "已清理 email=$email wallet=$waddr"

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
