#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# MQ-16 T-5 联调验证 — Agent 专属能力开放（invite 自动收费邀请 / transfer 账本内转账 / batch 批量收款）
#   1) static 子命令：本地 git 代码静态回归（scope 对齐/端点/文档/语法）
#   2) api 子命令：生产服务联调（data 签发 px_ key → 引擎 invite/transfer/batch 全流程）
# 用法：
#   本地：bash projects/web/scripts/mq16_t5_verify.sh static
#   生产：ADMIN_KEY=<data admin key> PAY_KEY=<引擎 bridge key> bash /tmp/mq16_t5_verify.sh api
# ═════════════════════════════════════════════════════════════════════════════
set -uo pipefail

REPO=${REPO:-/home/ubuntu/infraX-1}
PAY_BASE=${PAY_BASE:-http://127.0.0.1:9132/payments}
DATA_BASE=${DATA_BASE:-http://127.0.0.1:9112}
PAY_KEY=${PAY_KEY:-}
ADMIN_KEY=${ADMIN_KEY:-}
PAY_DB=${PAY_DB:-pocketx_payments}
TEST_A=0x1111111111111111111111111111111111111111
TEST_B=0x2222222222222222222222222222222222222222
TEST_C=0x3333333333333333333333333333333333333333

PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
section() { echo; echo "━━━ $1 ━━━"; }

cd "$REPO" || { echo "REPO not found: $REPO"; exit 1; }

# ═══════════ static：本地 git 代码静态回归 ═══════════
static() {
  section "static [1/7] 引擎 scope 对齐 data PREFIX_BY_SCOPE（payment/px_）"
  grep -qF "scope: 'payment'" projects/payments/server.ts && ok "server.ts scope='payment'" || bad "server.ts scope 未对齐（期望 'payment'）"
  grep -qF '"payment": "px_"' projects/data/app/api_keys.py && ok "data PREFIX_BY_SCOPE 含 payment→px_" || bad "data 缺 payment/px_ scope"

  section "static [2/7] 引擎 invite/transfer/batch 端点（router.ts）"
  for pat in "POST /invites" "POST /transfers" "POST /batch" "/batch/settle" "/transfers/:transferId/confirm" "/invites/:inviteId/pay" "cap(caps.invite" "cap(caps.transfer" "cap(caps.batch"; do
    grep -qF "$pat" projects/payments/src/router.ts && ok "router 含: $pat" || bad "router 缺: $pat"
  done

  section "static [3/7] x402/batch 依赖契约（batch 需 x402）"
  grep -qF "!!this.opts.batch && !!this.x402" projects/payments/src/service.ts && ok "batch enabled 依赖 x402" || bad "batch 依赖声明缺失"

  section "static [4/7] CALLER_SETUP.md Agent 三场景文档"
  grep -qF "Agent 专属能力调用（invite / transfer / batch）" projects/payments/CALLER_SETUP.md && ok "文档 §6 章节存在" || bad "缺 §6 Agent 章节"
  for kw in "自动收费邀请（invite）" "账本内转账（transfer）" "批量收款（batch）" "px_ key（scope=payment）" "错误码速查"; do
    grep -qF "$kw" projects/payments/CALLER_SETUP.md && ok "文档含: $kw" || bad "文档缺: $kw"
  done

  section "static [5/7] 引擎类型/语法检查（tsc + transpile）"
  (cd projects/payments && npx tsc --noEmit) && ok "payments tsc --noEmit 通过" || bad "payments tsc 失败"
  (cd projects/payments && npx tsx -e "const ts=require('typescript');const fs=require('fs');let bad=false;for(const f of ['server.ts']){const src=fs.readFileSync(f,'utf8');const r=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},reportDiagnostics:true});const diag=(r.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);if(diag.length){bad=true;console.error(f+' ERR: '+diag.map(d=>d.messageText).join('; '));}}process.exit(bad?1:0)") \
    && ok "server.ts 语法 OK" || bad "server.ts 语法错误"

  section "static [6/7] data key 签发链路（scope=payment）"
  grep -qF "scope not in api_keys.PREFIX_BY_SCOPE" projects/data/main.py && ok "data 签发 scope 校验存在" || bad "data 签发缺 scope 校验"
  grep -qF "row[\"api_key\"] = raw" projects/data/main.py && ok "签发仅返回一次明文 key" || bad "签发响应格式异常"

  section "static [7/7] tasklist 状态"
  grep -q "T-5 Agent 专属能力开放（✅" docs/infrax_tasklist.md && ok "tasklist MQ-16 T-5 已标记 ✅" || bad "tasklist T-5 未标记 ✅（实现部署完成后同步）"

  summary
}

# ═══════════ api：生产服务联调 ═══════════
api() {
  [ -n "$PAY_KEY" ] && [ -n "$ADMIN_KEY" ] || { echo "需要 PAY_KEY（引擎 bridge key）与 ADMIN_KEY（data admin key）"; exit 1; }

  local PX_KEY="" PX_ID=""
  local A="$TEST_A" B="$TEST_B" C="$TEST_C"

  section "api [1/17] 引擎冒烟 + capabilities（invite/transfer/batch enabled）"
  curl -sf "${PAY_BASE%/payments}/health" >/dev/null 2>&1 && ok "引擎 /health" || bad "引擎 /health 失败"
  local caps
  caps=$(curl -s -H "X-API-Key: $PAY_KEY" "$PAY_BASE/capabilities")
  for cap in invite transfer batch; do
    echo "$caps" | python3 -c "import json,sys; d=json.load(sys.stdin)['capabilities']; sys.exit(0 if d.get('$cap',{}).get('enabled') else 1)" \
      && ok "capabilities: $cap enabled" || bad "capabilities: $cap disabled（$caps）"
  done

  section "api [2/17] 无 key 401"
  local code401
  code401=$(curl -s -o /dev/null -w '%{http_code}' "$PAY_BASE/capabilities")
  [ "$code401" = "401" ] && ok "无 key → 401" || bad "无 key 应 401 实得 $code401"

  section "api [3/17] data 签发 px_ key（scope=payment）"
  local issue
  issue=$(curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' -d "{\"label\":\"mq16-t5-$(date +%s)\",\"scope\":\"payment\"}" "$DATA_BASE/admin/api-keys")
  PX_KEY=$(echo "$issue" | jget data.api_key)
  PX_ID=$(echo "$issue" | jget data.id)
  case "$PX_KEY" in
    px_*) ok "px_ key 签发（id=$PX_ID）" ;;
    *) bad "px_ key 签发失败: $issue"; PX_KEY="$PAY_KEY" ;;
  esac

  section "api [4/17] 外部 px_ key 调引擎 → 200（对外开放链路打通）"
  local code_px
  code_px=$(curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: $PX_KEY" "$PAY_BASE/capabilities")
  [ "$code_px" = "200" ] && ok "px_ key → capabilities 200" || bad "px_ key 调用失败: $code_px"

  section "api [5/17] invite 创建（payee=B 向 payer=A 收 0.001）"
  local inv
  inv=$(curl -s -X POST -H "X-API-Key: $PX_KEY" -H 'Content-Type: application/json' \
    -d "{\"payer\":\"$A\",\"payee\":\"$B\",\"valueWei\":\"1000000000000000\",\"memo\":\"mq16-t5 invite\"}" "$PAY_BASE/invites")
  local invid
  invid=$(echo "$inv" | jget inviteId)
  [ -n "$invid" ] && ok "inviteId=$invid" || bad "invite 创建失败: $inv"

  section "api [6/17] invite 账本内支付（payer 余额不足 → 失败）"
  local pay_fail
  pay_fail=$(curl -s -X POST -H "X-API-Key: $PX_KEY" "$PAY_BASE/invites/$invid/pay")
  echo "$pay_fail" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('settled') in (False,None) else 1)" \
    && ok "余额不足结算失败（幂等安全）" || bad "余额不足应失败: $pay_fail"

  section "api [7/17] 灌 ledger 余额 + invite 支付成功"
  sudo -u postgres psql -d "$PAY_DB" -c "INSERT INTO payment_balances (address, asset, balance_wei) VALUES ('$A', '0x0000000000000000000000000000000000000000', '2000000000000000') ON CONFLICT (address, asset) DO UPDATE SET balance_wei = payment_balances.balance_wei::numeric + 2000000000000000::numeric;" >/dev/null 2>&1
  local pay_ok
  pay_ok=$(curl -s -X POST -H "X-API-Key: $PX_KEY" "$PAY_BASE/invites/$invid/pay")
  [ "$(echo "$pay_ok" | jget settled)" = "true" ] && ok "invite 结算成功（settled）" || bad "invite 结算失败: $pay_ok"
  local bal_a
  bal_a=$(curl -s -H "X-API-Key: $PX_KEY" "$PAY_BASE/balance?address=$A" | jget balanceWei)
  [ "$bal_a" = "1000000000000000" ] && ok "payer 余额 2→1（扣 0.001）" || bad "payer 余额异常: $bal_a"

  section "api [8/17] invite 重复 pay 幂等（不双扣）"
  local pay_again
  pay_again=$(curl -s -X POST -H "X-API-Key: $PX_KEY" "$PAY_BASE/invites/$invid/pay")
  local bal_a2
  bal_a2=$(curl -s -H "X-API-Key: $PX_KEY" "$PAY_BASE/balance?address=$A" | jget balanceWei)
  [ "$bal_a2" = "1000000000000000" ] && ok "重复 pay 不双扣（幂等）" || bad "幂等破坏: $bal_a2"

  section "api [9/17] invite 查询（payer 视角 status=settled）"
  local invlist
  invlist=$(curl -s -H "X-API-Key: $PX_KEY" "$PAY_BASE/invites?address=$A&role=payer")
  echo "$invlist" | python3 -c "import json,sys; d=json.load(sys.stdin); invites=d.get('invites') or []; sys.exit(0 if any(i.get('inviteId')=='$invid' and i.get('status')=='settled' for i in invites) else 1)" \
    && ok "invite 列表含 settled 记录" || bad "invite 列表异常: $invlist"

  section "api [10/17] transfer 创建（A→C，reference 幂等）"
  local ref="mq16-t5-tf-$(date +%s)"
  local tf1 tf2
  tf1=$(curl -s -X POST -H "X-API-Key: $PX_KEY" -H 'Content-Type: application/json' \
    -d "{\"from\":\"$A\",\"to\":\"$C\",\"valueWei\":\"500000000000000\",\"reference\":\"$ref\"}" "$PAY_BASE/transfers")
  local tfid
  tfid=$(echo "$tf1" | jget transferId)
  [ -n "$tfid" ] && ok "transferId=$tfid" || bad "transfer 创建失败: $tf1"
  tf2=$(curl -s -X POST -H "X-API-Key: $PX_KEY" -H 'Content-Type: application/json' \
    -d "{\"from\":\"$A\",\"to\":\"$C\",\"valueWei\":\"500000000000000\",\"reference\":\"$ref\"}" "$PAY_BASE/transfers")
  [ "$(echo "$tf2" | jget transferId)" = "$tfid" ] && ok "同 reference 幂等返回同笔" || bad "reference 幂等失效: $tf2"

  section "api [11/17] transfer confirm 原子执行（A→C）"
  local conf
  conf=$(curl -s -X POST -H "X-API-Key: $PX_KEY" "$PAY_BASE/transfers/$tfid/confirm")
  [ "$(echo "$conf" | jget executed)" = "true" ] && ok "confirm executed" || bad "confirm 失败: $conf"
  local bal_c
  bal_c=$(curl -s -H "X-API-Key: $PX_KEY" "$PAY_BASE/balance?address=$C" | jget balanceWei)
  [ "$bal_c" = "500000000000000" ] && ok "C 收到 0.0005" || bad "C 余额异常: $bal_c"

  section "api [12/17] transfer 余额不足 → 422（整笔不动）"
  local tf_fail conf_fail
  tf_fail=$(curl -s -X POST -H "X-API-Key: $PX_KEY" -H 'Content-Type: application/json' \
    -d "{\"from\":\"$A\",\"to\":\"$C\",\"valueWei\":\"1000000000000000\"}" "$PAY_BASE/transfers")
  local tf_fail_id
  tf_fail_id=$(echo "$tf_fail" | jget transferId)
  conf_fail=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-API-Key: $PX_KEY" "$PAY_BASE/transfers/$tf_fail_id/confirm")
  [ "$conf_fail" = "422" ] && ok "余额不足 confirm → 422" || bad "应 422 实得 $conf_fail"

  section "api [13/17] batch 创建（subscriber=A，2 个 payee）"
  local batch
  batch=$(curl -s -X POST -H "X-API-Key: $PX_KEY" -H 'Content-Type: application/json' \
    -d "{\"subscriber\":\"$A\",\"items\":[{\"payee\":\"$B\",\"amountWei\":\"100000000000000\"},{\"payee\":\"$C\",\"amountWei\":\"200000000000000\"}]}" "$PAY_BASE/batch")
  local batchid
  batchid=$(echo "$batch" | jget batchId)
  local nitems
  nitems=$(echo "$batch" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('items') or []))")
  [ -n "$batchid" ] && [ "$nitems" = "2" ] && ok "batchId=$batchid items=2" || bad "batch 创建失败: $batch"

  section "api [14/17] GET batch 状态（created + 2 items）"
  local bg
  bg=$(curl -s -H "X-API-Key: $PX_KEY" "$PAY_BASE/batch?batchId=$batchid")
  echo "$bg" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('batchId')=='$batchid' and len(d.get('items') or [])==2 and d.get('status') in ('created','pending') else 1)" \
    && ok "batch 状态查询 OK" || bad "batch 查询异常: $bg"

  section "api [15/17] batch cancel（未支付取消）"
  local bcan
  bcan=$(curl -s -X POST -H "X-API-Key: $PX_KEY" -H 'Content-Type: application/json' -d "{\"batchId\":\"$batchid\"}" "$PAY_BASE/batch/cancel")
  [ "$(echo "$bcan" | jget cancelled)" = "true" ] && ok "batch cancelled" || bad "batch cancel 失败: $bcan"

  section "api [16/17] 错误 key 401（伪造 key）"
  local bad401
  bad401=$(curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: px_fake00000000000000000000000000000000000000000000000000" "$PAY_BASE/invites")
  [ "$bad401" = "401" ] && ok "伪造 px_ key → 401" || bad "伪造 key 应 401 实得 $bad401"

  section "api [17/17] 清理（删 px_ key + 测试账本数据）"
  curl -s -X DELETE -H "Authorization: Bearer $ADMIN_KEY" "$DATA_BASE/admin/api-keys/$PX_ID" >/dev/null 2>&1 \
    && ok "px_ key 已删除（id=$PX_ID）" || bad "px_ key 删除失败"
  sudo -u postgres psql -d "$PAY_DB" -c "DELETE FROM payment_balances WHERE address IN ('$A','$B','$C'); DELETE FROM payment_transfers WHERE from_addr IN ('$A','$B','$C') OR to_addr IN ('$A','$B','$C'); DELETE FROM payment_invites WHERE payer IN ('$A','$B','$C') OR payee IN ('$A','$B','$C'); DELETE FROM payment_batches WHERE payer IN ('$A','$B','$C'); DELETE FROM payment_intents WHERE subscriber IN ('$A','$B','$C');" >/dev/null 2>&1 \
    && ok "测试账本数据已清理" || bad "清理失败"

  summary
}

summary() {
  echo; echo "════════════════════════════════════════════"
  echo "  PASS=$PASS  FAIL=$FAIL"
  [ "$FAIL" = "0" ] && echo "  ✅ ALL CHECKS PASSED" || echo "  ❌ SOME CHECKS FAILED"
  exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
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
  api)    api ;;
  *) echo "用法: $0 {static|api}"; exit 1 ;;
esac
