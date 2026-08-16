#!/bin/bash
# ============================================================
# OE-5 生产配置变更：payments + aa-relay 指向 Escrow 托管合约
# 2026-08-16，oxachain 19505
#
# 用途：
#   1. 同步 payments / aa-relay 源码（origin/master，含 OE-5/E-1c escrow 逻辑）
#   2. 写 systemd drop-in 配置：
#        payments → X402_ESCROW_ADDRESS（x402 充值目标 AA_PLATFORM_ADDRESS → Escrow）
#        aa-relay → ESCROW_MODE / ESCROW_RPC_URL / ESCROW_ADDRESS /
#                   ESCROW_RELAYER_KEY / ESCROW_CHAIN_ID（双轨计费开关）
#   3. daemon-reload + restart + 验证
#
# 安全策略：
#   - 默认 ESCROW_MODE=false：只完成"指向"，计费仍走 ledger（不产生链上扣款）
#   - 用 --mode true 开启 escrowMode 前，必须先完成 relayer 授权（脚本末尾给出命令）
#   - 全部 drop-in 变更前先备份（*.bak-YYYYMMDD），可一键回滚
#   - 不动平台 EOA 资金（OE-4 另行执行）
#
# 用法：
#   bash oe5-escrow-config.sh --dry-run     # 只打印将要执行的变更（默认）
#   bash oe5-escrow-config.sh --apply       # 应用配置（ESCROW_MODE 保持现状/关闭）
#   bash oe5-escrow-config.sh --apply --mode true   # 应用并开启 escrowMode（需先授权 relayer）
# ============================================================
set -euo pipefail

# ---------- 常量 ----------
REPO=/home/ubuntu/infraX-1
ESCROW_ADDRESS=0x8Bf8Ffee86F1D4a160f0953Eb13BEDcBF99eaF9E
ESCROW_RPC_URL=https://rpc-oxa.0xainet.top      # 与 AA_OXACHAIN_RPC_URL 一致
ESCROW_CHAIN_ID=19505
ESCROW_MODE=false
APPLY=0
STAMP=$(date +%Y%m%d-%H%M%S)

# ---------- 参数 ----------
for arg in "$@"; do
  case "$arg" in
    --apply)    APPLY=1 ;;
    --mode=*)   ESCROW_MODE="${arg#--mode=}" ;;
    --dry-run)  APPLY=0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

[ -d "$REPO" ] || { echo "REPO not found: $REPO" >&2; exit 1; }

echo "== OE-5 escrow 配置变更 (mode=${ESCROW_MODE}, ${APPLY:-dry-run}) =="
echo "   Escrow proxy: $ESCROW_ADDRESS"
echo "   RPC: $ESCROW_RPC_URL  chainId: $ESCROW_CHAIN_ID"

# ---------- 1. 同步源码（仅 payments/aa-relay 相关文件） ----------
echo ""
echo "== [1/4] 同步 payments + aa-relay 源码 (origin/master) =="
if [ "$APPLY" -eq 1 ]; then
  cd "$REPO"
  git fetch origin master --quiet
  git checkout origin/master -- \
    projects/payments/server.ts \
    projects/payments/src/adapters/x402.ts \
    projects/aa-relay/src/billing.ts \
    projects/aa-relay/src/index.ts
  echo "   checked out origin/master 指定文件"
else
  echo "   (dry-run) git fetch + checkout origin/master: payments/server.ts, x402.ts, aa-relay/billing.ts, index.ts"
fi

# ---------- 2. relayer key（专用，非复用既有 key） ----------
# relayer key 落盘 600 权限；供 charge/refund 链上签名。
# 开启 escrowMode 前必须 owner 调 setRelayer(relayerAddr, true) 授权（见末尾）。
RELAYER_KEY_FILE=/etc/infrax/escrow-relayer.key
echo ""
echo "== [2/4] relayer key =="
if [ -f "$RELAYER_KEY_FILE" ]; then
  RELAYER_KEY=$(sudo cat "$RELAYER_KEY_FILE")
  echo "   relayer key 已存在: $RELAYER_KEY_FILE"
elif [ "$APPLY" -eq 1 ]; then
  RELAYER_KEY=$(openssl rand -hex 32)
  sudo mkdir -p /etc/infrax
  echo "$RELAYER_KEY" | sudo tee "$RELAYER_KEY_FILE" >/dev/null
  sudo chmod 600 "$RELAYER_KEY_FILE"
  echo "   生成新 relayer key: $RELAYER_KEY_FILE (600)"
else
  RELAYER_KEY="<redacted-dry-run>"
  echo "   (dry-run) 将生成新 relayer key → $RELAYER_KEY_FILE (600)"
fi
# relayer 地址（不打印私钥；dry-run 未落盘则跳过）
if [ "$RELAYER_KEY" = "<redacted-dry-run>" ]; then
  RELAYER_ADDR="(dry-run 后显示)"
else
  RELAYER_ADDR=$(cd "$REPO/projects/aa-relay" && ESCROW_RELAYER_KEY="0x$RELAYER_KEY" node -e "
  const { privateKeyToAccount } = require('viem/accounts');
  console.log(privateKeyToAccount(process.env.ESCROW_RELAYER_KEY).address);
  " 2>/dev/null || echo "(viem 不可用，跳过地址推导)")
fi
echo "   relayer 地址: $RELAYER_ADDR"

# ---------- 3. 写 systemd drop-in ----------
echo ""
echo "== [3/4] systemd drop-in =="
# payments: X402_ESCROW_ADDRESS
PAY_CONF=/etc/systemd/system/infrax-payments.service.d/escrow.conf
PAY_CONTENT="[Service]
Environment=\"X402_ESCROW_ADDRESS=$ESCROW_ADDRESS\"
"
# aa-relay: ESCROW_*
AA_CONF=/etc/systemd/system/infrax-aa-relay.service.d/escrow.conf
AA_CONTENT="[Service]
Environment=\"ESCROW_MODE=$ESCROW_MODE\"
Environment=\"ESCROW_RPC_URL=$ESCROW_RPC_URL\"
Environment=\"ESCROW_ADDRESS=$ESCROW_ADDRESS\"
Environment=\"ESCROW_CHAIN_ID=$ESCROW_CHAIN_ID\"
Environment=\"ESCROW_RELAYER_KEY=0x$RELAYER_KEY\"
"

write_conf() {
  local conf="$1" content="$2" name="$3"
  if [ "$APPLY" -eq 1 ]; then
    [ -f "$conf" ] && sudo cp "$conf" "$conf.bak-$STAMP"
    echo "$content" | sudo tee "$conf" >/dev/null
    sudo chmod 600 "$conf"   # drop-in 含 relayer 私钥，收紧权限
    echo "   $name: $conf (已写 600；备份 .bak-$STAMP)"
  else
    echo "   (dry-run) $name → $conf"
    echo "$content" | sed 's/^/       /'
  fi
}
write_conf "$PAY_CONF" "$PAY_CONTENT" "payments"
write_conf "$AA_CONF" "$AA_CONTENT" "aa-relay"

# ---------- 4. reload + restart + 验证 ----------
echo ""
echo "== [4/4] systemd reload + restart =="
if [ "$APPLY" -eq 1 ]; then
  sudo systemctl daemon-reload
  sudo systemctl restart infrax-payments
  sudo systemctl restart infrax-aa-relay
  sleep 3
  for svc in infrax-payments infrax-aa-relay; do
    if systemctl is-active --quiet "$svc"; then
      echo "   $svc: active"
    else
      echo "   $svc: FAILED → journalctl -u $svc -n 50" >&2
    fi
  done
else
  echo "   (dry-run) systemctl daemon-reload && restart infrax-payments infrax-aa-relay"
fi

# ---------- 回滚命令 ----------
echo ""
echo "== 回滚（如需要） =="
echo "   sudo systemctl stop infrax-payments infrax-aa-relay"
echo "   sudo mv /etc/systemd/system/infrax-payments.service.d/escrow.conf.bak-$STAMP /etc/systemd/system/infrax-payments.service.d/escrow.conf 2>/dev/null"
echo "   sudo mv /etc/systemd/system/infrax-aa-relay.service.d/escrow.conf.bak-$STAMP /etc/systemd/system/infrax-aa-relay.service.d/escrow.conf 2>/dev/null"
echo "   sudo systemctl daemon-reload && sudo systemctl restart infrax-payments infrax-aa-relay"

# ---------- relayer 授权提示 ----------
echo ""
echo "== relayer 授权（开启 ESCROW_MODE=true 前必须执行一次） =="
echo "   owner($(echo $ESCROW_ADDRESS | head -c 8)… 合约 owner) 调用 setRelayer:"
echo "   relayer 地址: $RELAYER_ADDR"
echo "   命令示例（用 owner 私钥，参考 projects/escrow/scripts/deploy.ts 风格）："
echo "   ESCROW_ADDRESS=$ESCROW_ADDRESS npx hardhat run scripts/set-relayer.ts --network oxachain  # relayer=$RELAYER_ADDR"
echo ""
if [ "$ESCROW_MODE" = "true" ]; then
  echo "   ⚠️ 已设置 ESCROW_MODE=true —— 请先确认 relayer 已授权，否则 charge 将 revert（计费 503）"
fi
echo "完成。"
