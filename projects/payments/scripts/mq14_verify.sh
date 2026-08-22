#!/bin/bash
# MQ-14 生产验证：invite 全流程 + transfer 原子性 + 过期 + 清理
set -e
K=e56159786fe107b808c29c3c75cd098a31ba58d97772dea3
P=0xaaaa00000000000000000000000000000000aaaa
E=0xbbbb00000000000000000000000000000000bbbb
O=0xcccc00000000000000000000000000000000cccc
A=0x0000000000000000000000000000000000000000
H=http://127.0.0.1:9132/payments
export PGPASSWORD=postgres
PSQL() { psql -h localhost -U postgres -d infrax_payments -q -c "$1"; }

PSQL "INSERT INTO payment_balances (address, asset, balance_wei) VALUES ('$P','$A','1000000') ON CONFLICT (address, asset) DO UPDATE SET balance_wei='1000000';"

echo "== 1. 创建邀请 =="
INV=$(curl -s -X POST -H "X-API-Key: $K" -H "Content-Type: application/json" -d "{\"payer\":\"$P\",\"payee\":\"$E\",\"valueWei\":\"100000\",\"memo\":\"agent service fee\"}" $H/invites)
echo "$INV"
IID=$(echo "$INV" | python3 -c "import json,sys; print(json.load(sys.stdin)['inviteId'])")

echo "== 2. 查询 payer 已发 =="
curl -s -H "X-API-Key: $K" "$H/invites?address=$P&role=payer" | python3 -c "import json,sys; d=json.load(sys.stdin); print('count=',len(d['invites']),'first=',d['invites'][0]['inviteId'])"

echo "== 3. payee 待付查询 =="
curl -s -H "X-API-Key: $K" "$H/invites?address=$E&role=payee" | python3 -c "import json,sys; d=json.load(sys.stdin); print('count=',len(d['invites']))"

echo "== 4. 余额支付 =="
curl -s -X POST -H "X-API-Key: $K" -H "Content-Type: application/json" $H/invites/$IID/pay; echo

echo "== 5. 邀请状态 =="
curl -s -H "X-API-Key: $K" $H/invites/$IID | python3 -c "import json,sys; d=json.load(sys.stdin); print('status=',d['status'],'method=',d['settledMethod'],'ref=',d['settledRef'])"

echo "== 6. 余额断言 (payer=900000, payee=100000) =="
PSQL "SELECT address, balance_wei FROM payment_balances WHERE address IN ('$P','$E') AND asset='$A' ORDER BY address;"

echo "== 7. transfer 充足 =="
TF=$(curl -s -X POST -H "X-API-Key: $K" -H "Content-Type: application/json" -d "{\"from\":\"$P\",\"to\":\"$O\",\"valueWei\":\"300000\"}" $H/transfers)
echo "$TF"
TID=$(echo "$TF" | python3 -c "import json,sys; print(json.load(sys.stdin)['transferId'])")
curl -s -X POST -H "X-API-Key: $K" -H "Content-Type: application/json" $H/transfers/$TID/confirm; echo

echo "== 8. transfer 余额不足 (应422) =="
TF2=$(curl -s -X POST -H "X-API-Key: $K" -H "Content-Type: application/json" -d "{\"from\":\"$P\",\"to\":\"$O\",\"valueWei\":\"9000000\"}" $H/transfers)
TID2=$(echo "$TF2" | python3 -c "import json,sys; print(json.load(sys.stdin)['transferId'])")
curl -s -o /dev/null -w "http=%{http_code}\n" -X POST -H "X-API-Key: $K" -H "Content-Type: application/json" $H/transfers/$TID2/confirm

echo "== 9. 重复confirm幂等 (应422, 不双扣) =="
curl -s -o /dev/null -w "http=%{http_code}\n" -X POST -H "X-API-Key: $K" -H "Content-Type: application/json" $H/transfers/$TID/confirm
PSQL "SELECT address, balance_wei FROM payment_balances WHERE address IN ('$P','$O') AND asset='$A' ORDER BY address;"

echo "== 10. 邀请过期 =="
EXP=$(curl -s -X POST -H "X-API-Key: $K" -H "Content-Type: application/json" -d "{\"payer\":\"$P\",\"payee\":\"$E\",\"valueWei\":\"50000\",\"dueAt\":\"2020-01-01T00:00:00Z\"}" $H/invites)
EIID=$(echo "$EXP" | python3 -c "import json,sys; print(json.load(sys.stdin)['inviteId'])")
curl -s -H "X-API-Key: $K" $H/invites/$EIID | python3 -c "import json,sys; d=json.load(sys.stdin); print('expired status=',d['status'])"

echo "== 11. 清理测试数据 =="
PSQL "DELETE FROM payment_invites WHERE invite_id LIKE 'inv_%';"
PSQL "DELETE FROM payment_transfers WHERE from_addr IN ('$P','$O') OR to_addr IN ('$P','$O');"
PSQL "DELETE FROM payment_balances WHERE address IN ('$P','$E','$O');"
echo DONE
