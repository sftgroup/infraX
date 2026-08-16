# 生产环境凭证（PRODUCTION CREDENTIALS）

> **用途**：记录生产环境访问凭证与服务密钥，供授权运维/开发人员本地查阅。
> **安全提示**：本文件含真实密钥，禁止外泄、禁止推送公开仓库；如需分享请走安全渠道。
> **最后更新**：2026-08-16（§5 aa-relay env 对齐生产：relay key 轮换 + M-3 迁移 DB + drop-in 补录）

---

## 1. 生产机 SSH

| 项 | 值 |
|---|---|
| 主机 | 43.163.105.172 |
| 用户 | ubuntu |
| 密码 | Asdf1234! |
| 连接示例 | `sshpass -p 'Asdf1234!' ssh -o StrictHostKeyChecking=accept-new ubuntu@43.163.105.172` |

> 说明：主栈 43.163.105.172（data/knowledge-injector/ragservicer/hub-index/mpc/chain-rpc/aa-relay 等）；独立 ml-service 43.156.25.197（ml-service）。

---

## 2. 服务端口速查（43.163.105.172）

| 服务 | 端口 | systemd unit | 工作目录 |
|---|---|---|---|
| infrax-mpc（MPC 网关，9104） | 9104 | infrax-mpc.service | /home/ubuntu/infraX-1/projects/mpc |
| MPC TSS party1（片2） | 9200 | infrax-mpc-tss-signer.service | /home/ubuntu/infraX-1/projects/mpc-tss |
| MPC TSS party0（片1 代理） | 9201 | infrax-mpc-signer.service | /home/ubuntu/infraX-1/projects/mpc-tss |
| chain-rpc 网关 | 9130 | infrax-chain-rpc.service | /home/ubuntu/infraX-1/projects/chain-rpc |
| aa-relay（UserOp 转发） | 9131 | infrax-aa-relay.service | /home/ubuntu/infraX-1/projects/aa-relay |
| data | 9112 | — | — |
| knowledge-injector | 9113 | — | — |
| ragservicer | 9721 | — | — |
| hub-index（MCP） | 3008 | — | — |
| mpc-mcp / rpc-mcp | — | infrax-mpc-mcp / infrax-rpc-mcp | — |

---

## 3. infrax-mpc（:9104）env

| 变量 | 值 |
|---|---|
| MPC_API_KEY | infrax-bridge-2fd4fbe0d33805362ac980fde74c86b2 |
| MPC_ENCRYPTION_SECRET | 2cca2225961a0b6e4edf2979f102d2e9de0b5531d4a2443e30a3bf8097b352a4 |
| ADMIN_USER / ADMIN_PASS | admin / a87cefd6e1ce487334a67b0c |
| DATABASE_URL | postgresql://postgres:postgres@localhost:5432/pocketx_mpc |
| PORT | 9104 |
| MPC_SIGNER_URL | http://127.0.0.1:9201 |
| TSS_SIGNER_URL | http://127.0.0.1:9200 |
| CHAIN_RPC_URL | http://127.0.0.1:9130 |
| CHAIN_RPC_READ_KEY | 9ffb2e974089da005e07103271246d3ad3597a71eb50034a326b906797aba4ae |
| CHAIN_RPC_BROADCAST_KEY | 221558134a900f38821328570684b4af4fb9e758e6fc5fa6befe01574a4e5caf |
| DATA_URL / DATA_API_KEY | http://127.0.0.1:9112 / infrax-bridge-2fd4fbe0d33805362ac980fde74c86b2 |

---

## 4. chain-rpc（:9130）env

| 变量 | 值 |
|---|---|
| CHAIN_RPC_READ_KEY | 9ffb2e974089da005e07103271246d3ad3597a71eb50034a326b906797aba4ae |
| CHAIN_RPC_BROADCAST_KEY | 221558134a900f38821328570684b4af4fb9e758e6fc5fa6befe01574a4e5caf |
| PORT | 9130 |
| CHAIN_RPC_CHAINS | sepolia,ethereum,bsc,base,oxa,solana |
| SEPOLIA_RPC_URL | https://ethereum-sepolia-rpc.publicnode.com |
| ETH_RPC_URL | https://ethereum-rpc.publicnode.com |
| BSC_RPC_URL | https://bsc-dataseed.bnbchain.org |
| BASE_RPC_URL | https://mainnet.base.org |
| OXA_RPC_URL | https://rpc-oxa.0xainet.top |
| SOLANA_RPC_URL | https://api.mainnet-beta.solana.com |
| CHAIN_RPC_WAIT_SEC / INTERVAL_MS | 30 / 3000 |
| CHAIN_RPC_HEALTH_INTERVAL_MS | 60000 |

---

## 5. aa-relay（:9131）env（✅ 2026-08-16 对齐生产）

| 变量 | 值 | 来源 |
|---|---|---|
| AA_RELAY_API_KEY | infrax-bridge-2fd4fbe0d33805362ac980fde74c86b2 | 主 unit（2026-08-16 核验；旧值 e0423496… 已废弃） |
| AA_ENABLED_CHAINS | oxachain | 主 unit |
| AA_OXACHAIN_RPC_URL | https://rpc-oxa.0xainet.top | 主 unit |
| AA_OXACHAIN_ENTRYPOINT_V07 | 0x97e4cddcffeaf4580bc6315fee512f2b2d82798a | 主 unit |
| AA_OXACHAIN_IMPLEMENTATION | 0x5131d75af2126eba05edbb6bc24902c42d1b52b4 | 主 unit |
| AA_OXACHAIN_FACTORY | 0xf8abe4510a6810d5ef26aa3222c0f63d32b757d1 | 主 unit |
| AA_OXACHAIN_ECDSA_VALIDATOR | 0xb0d4f548e022b8a9d5b454ffb7f327ee2afeb16c | 主 unit |
| AA_OXACHAIN_SESSION_MODULE | 0xfbbca78d2d7d08c1163aa57a0056973ef4fd8c74 | 主 unit |
| AA_OXACHAIN_BUNDLERS | [{"url":"http://43.159.60.46:4338","priority":0}] | 主 unit |
| PORT | 9131 | 主 unit |
| DATABASE_URL | postgresql://postgres:postgres@10.3.8.6:5432/pocketx_mpc | drop-in `override.conf`（M-3 迁移修正，原 localhost） |
| AA_PAYMENTS_URL | http://127.0.0.1:9132 | drop-in `override.conf` |
| AA_PAYMENTS_API_KEY | e56159786fe107b808c29c3c75cd098a31ba58d97772dea3 | drop-in `override.conf` |
| AA_PLATFORM_ADDRESS | 0x5682e2d55770e46ad24b92e51d6d0a3b629fa0b3 | drop-in `override.conf`（x402 充值收款平台钱包，EOA → 托管合约见 tasklist §9.20） |
| AA_OXACHAIN_PAYMASTER_URL | http://127.0.0.1:9134 | drop-in `paymaster.conf`（自建 verifying paymaster :9134） |

---

## 6. 安全提醒

- **MPC_ENCRYPTION_SECRET 曾泄漏于 git 历史**（建议轮换后再更新本文件）。
- 轮换任一 key 时需同步：对应 systemd unit env + 本文件 + 使用方配置（如 SDK/代理）。
- `CHAIN_RPC_READ_KEY` / `CHAIN_RPC_BROADCAST_KEY` 为 chain-rpc 网关与 mpc 共用，轮换需双端同步。
