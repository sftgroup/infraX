#!/usr/bin/env bash
# MM-7.1~7.4: OpenD 生产部署脚本（在开发机/本地执行，驱动生产机安装）。
#
# 前置：
#   - 本机 OpenD 分发包:  /home/ubuntu/opend/moomoo-opend-ubuntu.tar.gz
#   - 本机 SDK 源码:      /home/ubuntu/opend/mmapi-python
#   - 凭证:              /home/ubuntu/opend/.../OpenD.xml（账号 107803923，权限 600，不入 git）
#   - SSH: 生产机 43.163.105.172，用户 ubuntu；SSH_PASS 环境变量（sshpass）或免密
#
# 用法:
#   SSH_PASS='...' bash deploy/opend/deploy-opend.sh [生产机IP]
#
# 产出（生产机）:
#   /opt/opend/                        OpenD 分发包解压目录
#   /opt/opend/venv                    python venv + moomoo SDK
#   /opt/opend/.../OpenD.xml           凭证（chmod 600，仅由本脚本同步，不入 git）
#   /etc/systemd/system/infrax-opend.service
#   /tmp/opend_ctl/opend_in            FIFO stdin（短信验证码 input_phone_verify_code）
set -euo pipefail

HOST="${1:-43.163.105.172}"
USER=ubuntu
SRC_OPEND_TGZ=/home/ubuntu/opend/moomoo-opend-ubuntu.tar.gz
SRC_SDK=/home/ubuntu/opend/mmapi-python
# 凭证路径（本机 OpenD 运行目录下的 OpenD.xml；多个运行目录时取第一个存在的）
SRC_OPEN_D_XML="${OPEND_XML:-}"
if [ -z "${SRC_OPEN_D_XML}" ]; then
  for d in /home/ubuntu/opend/*/; do
    if [ -f "${d}OpenD.xml" ]; then SRC_OPEN_D_XML="${d}OpenD.xml"; break; fi
  done
fi
REMOTE_TMP=/tmp/opend_deploy
OPEN_D_DIR=/opt/opend
OPEN_D_HOME="${OPEN_D_DIR}/moomoo_OpenD_10.9.6918_Ubuntu18.04/moomoo_OpenD_10.9.6918_Ubuntu18.04"

SSH=(ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/kh_opend -o ConnectTimeout=15)
[ -n "${SSH_PASS:-}" ] && SSH=(sshpass -p "${SSH_PASS}" "${SSH[@]}")
# scp 同样需要 sshpass 包装（SSH_PASS 模式）
SCP=(scp -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/kh_opend)
[ -n "${SSH_PASS:-}" ] && SCP=(sshpass -p "${SSH_PASS}" "${SCP[@]}")

echo "==> 1/5 校验本机源文件"
for f in "${SRC_OPEND_TGZ}" "${SRC_SDK}"; do
  [ -e "$f" ] || { echo "缺失: $f"; exit 1; }
done
if [ -f "${SRC_OPEN_D_XML}" ]; then
  echo "    凭证: ${SRC_OPEN_D_XML}"
else
  echo "    WARN: 未找到 OpenD.xml（凭证后补，跳过同步）"
fi

echo "==> 2/5 上传分发包 + SDK + unit"
"${SSH[@]}" "${USER}@${HOST}" "mkdir -p ${REMOTE_TMP}"
"${SCP[@]}" -r "${SRC_OPEND_TGZ}" "${SRC_SDK}" "${USER}@${HOST}:${REMOTE_TMP}/"
"${SCP[@]}" "$(dirname "$0")/infrax-opend.service" "$(dirname "$0")/opend-health.sh" "${USER}@${HOST}:${REMOTE_TMP}/"
if [ -f "${SRC_OPEN_D_XML}" ]; then
  "${SCP[@]}" "${SRC_OPEN_D_XML}" "${USER}@${HOST}:${REMOTE_TMP}/OpenD.xml"
fi

echo "==> 3/5 生产机安装（解压/JRE/venv SDK/凭证）"
"${SSH[@]}" "${USER}@${HOST}" "sudo bash -s" <<REMOTE
set -euo pipefail
# OpenD 分发包解压（tar 顶层含 moomoo_OpenD_10.9.6918_Ubuntu18.04/ 目录）
mkdir -p ${OPEN_D_DIR}
tar -xzf ${REMOTE_TMP}/moomoo-opend-ubuntu.tar.gz -C ${OPEN_D_DIR}
[ -x ${OPEN_D_HOME}/OpenD ] || { echo "OpenD 二进制缺失: ${OPEN_D_HOME}/OpenD"; exit 1; }

# JRE 检查（OpenD 为 Java 应用）
if ! command -v java >/dev/null 2>&1; then
  echo "    安装 JRE..."
  sudo apt-get update -qq && sudo apt-get install -y -qq default-jre-headless
fi

# venv + moomoo SDK（SDK 根目录含 setup.py，自动定位）
if [ ! -x ${OPEN_D_DIR}/venv/bin/python ]; then
  python3 -m venv ${OPEN_D_DIR}/venv
  ${OPEN_D_DIR}/venv/bin/pip install --quiet --upgrade pip
fi
SDK_SETUP_DIR="$(dirname "$(find ${REMOTE_TMP}/mmapi-python -maxdepth 4 -name setup.py | head -1)")"
[ -n "${SDK_SETUP_DIR}" ] || { echo "SDK setup.py 未找到"; exit 1; }
${OPEN_D_DIR}/venv/bin/pip install --quiet "${SDK_SETUP_DIR}"

# 凭证落盘（MM-7.2: 权限 600，不入 git）
if [ -f ${REMOTE_TMP}/OpenD.xml ]; then
  cp ${REMOTE_TMP}/OpenD.xml ${OPEN_D_HOME}/OpenD.xml
  chmod 600 ${OPEN_D_HOME}/OpenD.xml
  chown ${USER}:${USER} ${OPEN_D_HOME}/OpenD.xml
else
  echo "    WARN: 无凭证文件，跳过（后补）"
fi

# systemd unit + 健康探活脚本
sudo cp ${REMOTE_TMP}/infrax-opend.service /etc/systemd/system/infrax-opend.service
sudo cp ${REMOTE_TMP}/opend-health.sh /opt/opend/opend-health.sh
sudo chmod 755 /opt/opend/opend-health.sh
sudo chown ${USER}:${USER} ${OPEN_D_HOME}/OpenD.xml 2>/dev/null || true
sudo systemctl daemon-reload
REMOTE

echo "==> 4/5 启动 infrax-opend"
"${SSH[@]}" "${USER}@${HOST}" "sudo systemctl enable --now infrax-opend && sleep 15 && systemctl is-active infrax-opend"

echo "==> 5/5 健康探活（MM-7.4 需短信验证码登录后最终确认）"
"${SSH[@]}" "${USER}@${HOST}" "sudo /opt/opend/opend-health.sh"

echo "==> 部署完成。若登录态未就绪，在生产机执行："
echo "      sudo bash -c 'echo input_phone_verify_code -code=XXXXXX > /tmp/opend_ctl/opend_in'"
