#!/usr/bin/env bash
# A-15: session-key-engine 生产部署脚本（本地构建 → 上传 → 生产安装 → 启动 → 探活）。
#
# 前置：
#   - 本地: pnpm（monorepo，pnpm-workspace.yaml）
#   - SSH: 生产机 43.163.105.172，用户 ubuntu；SSH_PASS 环境变量（sshpass）或免密
#   - 必填 env（fail-closed，缺一拒绝）：
#       SESSION_KEY_DB_PASSWORD    postgres 密码（建库 session_key_engine）
#       SESSION_KEY_ENCRYPTION_KEY 加密 session key 私钥的 32B key（openssl rand -hex 16）
#       SESSION_KEY_JWT_SECRET     JWT secret（openssl rand -hex 32）
#       SESSION_KEY_API_TOKENS     sdk_ 前缀 Bearer key，逗号分隔（openssl rand -hex 24 加前缀）
#   - 可选 env：SESSION_KEY_DB_USER（默认 postgres）、SESSION_KEY_PORT（默认 3500）、
#       ETH_RPC_URL/BSC_RPC_URL/... 链 RPC（默认按 rpc-pool.json 公共端点）
#
# 用法:
#   SSH_PASS='...' SESSION_KEY_DB_PASSWORD='...' SESSION_KEY_ENCRYPTION_KEY='...' \
#   SESSION_KEY_JWT_SECRET='...' SESSION_KEY_API_TOKENS='sdk_...' \
#   bash deploy/session-key/deploy-session-key.sh [生产机IP]
#
# 产出（生产机）:
#   /opt/infrax/session-key/           源码 + dist（pnpm install + build）
#   /etc/infrax/session-key.env        敏感配置（chmod 600，不入 git）
#   /etc/systemd/system/infrax-session-key.service
set -euo pipefail

HOST="${1:-43.163.105.172}"
USER=ubuntu
SRC_DIR=/home/ubuntu/infraX-1/projects/session-key
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_TMP=/tmp/session_key_deploy
INSTALL_DIR=/opt/infrax/session-key

# ── 必填配置校验（fail-closed） ──
for v in SESSION_KEY_DB_PASSWORD SESSION_KEY_ENCRYPTION_KEY SESSION_KEY_JWT_SECRET SESSION_KEY_API_TOKENS; do
  [ -n "${!v:-}" ] || { echo "缺失必填 env: ${v}"; exit 1; }
done
DB_USER="${SESSION_KEY_DB_USER:-postgres}"
PORT="${SESSION_KEY_PORT:-3500}"

SSH=(ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/kh_sesskey -o ConnectTimeout=15)
[ -n "${SSH_PASS:-}" ] && SSH=(sshpass -p "${SSH_PASS}" "${SSH[@]}")

echo "==> 1/6 本地构建（session-key monorepo）"
command -v pnpm >/dev/null 2>&1 || { echo "本地缺少 pnpm"; exit 1; }
(cd "${SRC_DIR}" && pnpm install --frozen-lockfile=false >/dev/null && pnpm run -r build)

echo "==> 2/6 打包上传（排除 node_modules / dist 缓存 / git）"
TARBALL=/tmp/session-key-src.tar.gz
tar -czf "${TARBALL}" -C "$(dirname "${SRC_DIR}")" \
  --exclude=node_modules --exclude='*.log' --exclude=.git \
  "$(basename "${SRC_DIR}")"
"${SSH[@]}" "${USER}@${HOST}" "mkdir -p ${REMOTE_TMP}"
scp -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/kh_sesskey \
  "${TARBALL}" "${DEPLOY_DIR}/infrax-session-key.service" "${DEPLOY_DIR}/session-key-health.sh" \
  "${USER}@${HOST}:${REMOTE_TMP}/"

echo "==> 3/6 生产机安装（解压/依赖/构建）"
"${SSH[@]}" "${USER}@${HOST}" "sudo bash -s" <<REMOTE
set -euo pipefail
# 解压（tar 顶层为 session-key/）
sudo rm -rf ${INSTALL_DIR}
sudo mkdir -p ${INSTALL_DIR}
sudo tar -xzf ${REMOTE_TMP}/session-key-src.tar.gz -C ${INSTALL_DIR} --strip-components=1
sudo chown -R ${USER}:${USER} ${INSTALL_DIR}

# 生产构建（pnpm 缺失时用 corepack 启用）
if ! command -v pnpm >/dev/null 2>&1; then
  sudo corepack enable pnpm 2>/dev/null || true
  export PATH="\${PATH}:/home/${USER}/.local/bin"
fi
cd ${INSTALL_DIR}
pnpm install --frozen-lockfile=false >/dev/null
pnpm run -r build

# 数据库（存在则跳过，不覆盖数据）
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='session_key_engine'" 2>/dev/null | grep -q 1 \
  || sudo -u postgres createdb session_key_engine
REMOTE

echo "==> 4/6 写入敏感配置（/etc/infrax/session-key.env, chmod 600）"
"${SSH[@]}" "${USER}@${HOST}" "sudo bash -s" <<REMOTE
set -euo pipefail
sudo mkdir -p /etc/infrax
# 链 RPC：优先用显式 env，否则取 rpc-pool.json 各链第一个端点
rpc() { local c=\$1; echo "\${${c}_RPC_URL:-}"; }
RPC_ETH="\$(rpc ETH)"; RPC_BSC="\$(rpc BSC)"; RPC_BASE="\$(rpc BASE)"
RPC_POLYGON="\$(rpc POLYGON)"; RPC_ARBITRUM="\$(rpc ARBITRUM)"; RPC_OPTIMISM="\$(rpc OPTIMISM)"; RPC_XLAYER="\$(rpc XLAYER)"
# 默认公共端点（与 chain-rpc rpc-pool.json 同源，生产可改走网关）
[ -n "\${RPC_ETH}" ] || RPC_ETH="https://eth.drpc.org"
[ -n "\${RPC_BSC}" ] || RPC_BSC="https://bsc-dataseed.binance.org"
[ -n "\${RPC_BASE}" ] || RPC_BASE="https://mainnet.base.org"
[ -n "\${RPC_POLYGON}" ] || RPC_POLYGON="https://polygon-rpc.com"
[ -n "\${RPC_ARBITRUM}" ] || RPC_ARBITRUM="https://arb1.arbitrum.io/rpc"
[ -n "\${RPC_OPTIMISM}" ] || RPC_OPTIMISM="https://mainnet.optimism.io"
[ -n "\${RPC_XLAYER}" ] || RPC_XLAYER="https://rpc.xlayer.tech"
sudo tee /etc/infrax/session-key.env >/dev/null <<ENV
PORT=${PORT}
DB_HOST=localhost
DB_PORT=5432
DB_NAME=session_key_engine
DB_USER=${DB_USER}
DB_PASSWORD=${SESSION_KEY_DB_PASSWORD}
REDIS_HOST=localhost
REDIS_PORT=6379
ENCRYPTION_KEY=${SESSION_KEY_ENCRYPTION_KEY}
JWT_SECRET=${SESSION_KEY_JWT_SECRET}
API_TOKENS=${SESSION_KEY_API_TOKENS}
ETH_RPC_URL=\${RPC_ETH}
BSC_RPC_URL=\${RPC_BSC}
BASE_RPC_URL=\${RPC_BASE}
POLYGON_RPC_URL=\${RPC_POLYGON}
ARBITRUM_RPC_URL=\${RPC_ARBITRUM}
OPTIMISM_RPC_URL=\${RPC_OPTIMISM}
XLAYER_RPC_URL=\${RPC_XLAYER}
ENV
sudo chmod 600 /etc/infrax/session-key.env

# systemd unit + 健康探活
sudo cp ${REMOTE_TMP}/infrax-session-key.service /etc/systemd/system/infrax-session-key.service
sudo cp ${REMOTE_TMP}/session-key-health.sh /opt/infrax/session-key-health.sh
sudo chmod 755 /opt/infrax/session-key-health.sh
sudo systemctl daemon-reload
REMOTE

echo "==> 5/6 启动 infrax-session-key"
"${SSH[@]}" "${USER}@${HOST}" "sudo systemctl enable --now infrax-session-key && sleep 8 && systemctl is-active infrax-session-key"

echo "==> 6/6 健康探活"
"${SSH[@]}" "${USER}@${HOST}" "sudo /opt/infrax/session-key-health.sh"

echo "==> 部署完成。消费端配置："
echo "      SESSION_KEY_ENGINE_URL=http://<公网或内网>:${PORT}  SESSION_KEY_API_KEY=${SESSION_KEY_API_TOKENS%%,*}"
echo "    （公网暴露需挂 nginx：/api/v1 → 127.0.0.1:${PORT}，或走 SSH 隧道测试）"
