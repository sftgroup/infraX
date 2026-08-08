#!/usr/bin/env bash
# =============================================================================
# @0xinfrax/payments — 解耦性验证（standalone / version-A shape）
#
# 与 run.sh（验证宿主内嵌形态）不同，本脚本验证「通用模块独立可运行」：
#   - 只启动基础 Infra（Postgres + anvil）并部署 SubscriptionManager；
#   - 创建独立的 agentx_payments 数据库，只应用 payments/ 自己的迁移
#     （payment_* 表，绝不出现 fiat_subscriptions / x402_* / chain_*）；
#   - 跑 decouple-test.mjs —— 该脚本只 import @0xinfrax/payments 及其自有依赖
#     （pg / viem），以「调用方自持 store」形态跑通 链上 / 法币 / x402 三轨，
#     并断言模块无任何 AgentX 业务耦合。
#
# 前置：docker（含 docker compose）。无需 Stripe 账号、无需真实链。
# 合约：测试合约（IdentityRegistry / SubscriptionManager）来自 AgentX 仓库
#       `contracts/`，通过 CONTRACTS_DIR 指定（默认 /home/ubuntu/Agentx/contracts）。
# 用法：
#   ./run-decouple.sh          # 完整运行
#   ./run-decouple.sh --stop   # 停止本次启动的服务（mock-stripe / 容器）
# =============================================================================
set -euo pipefail

PAYMENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="${CONTRACTS_DIR:-/home/ubuntu/Agentx/contracts}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$DIR/logs"
mkdir -p "$LOG"

ANVIL_PORT=8545
MOCK_STRIPE_PORT=8777
PG_PORT=5433
DB_NAME=agentx_payments

PK0="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"   # 订阅者 (anvil #0)
PK1="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"   # 平台钱包 (anvil #1)
PAY_TO="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
PLAN_PRICE_WEI="1000000000000000000"   # 1 native → fiat 自动定价 $1=100¢

# ── 停止模式 ─────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--stop" ]]; then
  echo "[stop] 停止 mock-stripe / 本地容器 ..."
  [[ -f "$LOG/decouple-mock-stripe.pid" ]] && kill "$(cat "$LOG/decouple-mock-stripe.pid")" 2>/dev/null || true
  [[ -f "$LOG/mock-stripe.pid" ]] && kill "$(cat "$LOG/mock-stripe.pid")" 2>/dev/null || true
  sudo docker compose -f "$DIR/docker-compose.yml" down --remove-orphans 2>/dev/null || \
    docker compose -f "$DIR/docker-compose.yml" down --remove-orphans 2>/dev/null || true
  echo "[stop] 完成。"
  exit 0
fi

command -v docker >/dev/null || { echo "需要安装 docker"; exit 1; }
if docker info >/dev/null 2>&1; then DOCKER="docker"; else DOCKER="sudo docker"; echo "[sudo] 使用 sudo 访问 docker daemon"; fi
DC() { $DOCKER compose -f "$DIR/docker-compose.yml" "$@"; }

echo "==> [1/7] 启动本地基础设施 (postgres + anvil)"
DC up -d db anvil
until $DOCKER inspect -f '{{.State.Health.Status}}' agentx-local-db 2>/dev/null | grep -q healthy; do sleep 1; done
until $DOCKER inspect -f '{{.State.Health.Status}}' agentx-local-anvil 2>/dev/null | grep -q healthy; do sleep 1; done
echo "    db + anvil healthy"

echo "==> [2/7] 编译并部署合约（IdentityRegistry + SubscriptionManager + plan#1）"
if [ ! -f "$CONTRACTS_DIR/lib/forge-std/src/Script.sol" ]; then
  git clone --depth 1 --branch v1.9.6 https://github.com/foundry-rs/forge-std.git "$CONTRACTS_DIR/lib/forge-std"
  git clone --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts.git "$CONTRACTS_DIR/lib/openzeppelin-contracts"
fi
FORGE_IMAGE="ghcr.io/foundry-rs/foundry:stable"
DEPLOY_OUT="$LOG/decouple-deploy.txt"
if ! $DOCKER image inspect "$FORGE_IMAGE" >/dev/null 2>&1; then
  echo "    拉取 foundry 镜像（首次较慢）..."
  $DOCKER pull "$FORGE_IMAGE"
fi
set +e
$DOCKER run --rm \
  --entrypoint forge \
  -v "$CONTRACTS_DIR:/work" -w /work --network host \
  -e PRIVATE_KEY="$PK0" \
  -e PLAN_PRICE_WEI="$PLAN_PRICE_WEI" \
  "$FORGE_IMAGE" \
  script script/DeployLocal.s.sol --rpc-url "http://127.0.0.1:$ANVIL_PORT" --broadcast --legacy \
  > "$DEPLOY_OUT" 2>&1
DEPLOY_RC=$?
set -e
if [ "$DEPLOY_RC" -ne 0 ]; then echo "    部署失败，日志尾部："; tail -40 "$DEPLOY_OUT"; exit 1; fi
SM_ADDR="$(grep -oE 'SubscriptionManager: 0x[0-9a-fA-F]{40}' "$DEPLOY_OUT" | head -1 | awk '{print $2}')"
IR_ADDR="$(grep -oE 'IdentityRegistry: 0x[0-9a-fA-F]{40}' "$DEPLOY_OUT" | head -1 | awk '{print $2}')"
[[ -n "$SM_ADDR" ]] || { echo "无法从部署输出解析 SubscriptionManager 地址"; tail -40 "$DEPLOY_OUT"; exit 1; }
echo "    SubscriptionManager = $SM_ADDR"
echo "    IdentityRegistry    = $IR_ADDR"

echo "==> [3/7] 独立数据库 $DB_NAME + 只应用模块迁移（payment_*）"
$DOCKER exec agentx-local-db psql -U agentx -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" \
  -c "CREATE DATABASE $DB_NAME OWNER agentx;" >/dev/null
for f in "$PAYMENTS_DIR"/db/migrations/*.sql; do
  $DOCKER exec -i agentx-local-db psql -U agentx -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$f" >/dev/null
done
echo "    migrations applied (payment_intents / payment_credits / payment_sessions)"

echo "==> [4/7] 静态解耦扫描（payments/src + db + dist 无 AgentX 业务 token）"
FORBIDDEN='fiat_subscriptions|x402_payments|x402_balances|chain_subscriptions|@agentxv2/sdk|agentx_local|gateway/'
if grep -rnE "$FORBIDDEN" "$PAYMENTS_DIR/src" "$PAYMENTS_DIR/db" "$PAYMENTS_DIR/dist" 2>/dev/null; then
  echo "    ✗ 发现 AgentX 业务耦合，解耦失败"
  exit 1
fi
echo "    clean — 无 fiat_subscriptions / x402_* / chain_* / sdk / gateway 引用"

echo "==> [5/7] mock Stripe（已监听则复用）"
if (echo > /dev/tcp/127.0.0.1/$MOCK_STRIPE_PORT) 2>/dev/null; then
  echo "    端口 $MOCK_STRIPE_PORT 已有 mock-stripe 在跑，直接复用"
else
  MOCK_STRIPE_PORT="$MOCK_STRIPE_PORT" node "$DIR/mock-stripe.mjs" > "$LOG/decouple-mock-stripe.log" 2>&1 &
  echo $! > "$LOG/decouple-mock-stripe.pid"
  echo "    mock-stripe.pid=$(cat "$LOG/decouple-mock-stripe.pid") (日志: $LOG/decouple-mock-stripe.log)"
  sleep 1
fi

echo "==> [6/7] 跑解耦性验证（只 import @0xinfrax/payments + 自有依赖）"
(
  cd "$DIR"
  DATABASE_URL="postgresql://agentx:agentx@127.0.0.1:$PG_PORT/$DB_NAME" \
  ANVIL_RPC="http://127.0.0.1:$ANVIL_PORT" \
  SUBSCRIPTION_MANAGER="$SM_ADDR" \
  PAY_TO="$PAY_TO" \
  STRIPE_WEBHOOK_SECRET="whsec_localmocktest" \
  MOCK_STRIPE_BASE="http://127.0.0.1:$MOCK_STRIPE_PORT/v1" \
  node decouple-test.mjs
)
RC=$?

echo ""
echo "=============================================================================="
echo " 解耦验证完成 (RC=$RC)。可用："
echo "   anvil RPC    : http://127.0.0.1:$ANVIL_PORT"
echo "   Postgres     : localhost:$PG_PORT (agentx/agentx, db=$DB_NAME)"
echo "   Mock Stripe  : http://127.0.0.1:$MOCK_STRIPE_PORT"
echo " 停止：$0 --stop"
echo "=============================================================================="
exit $RC
