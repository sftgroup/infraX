# 需求单：RPC 基础设施切换 InfraX（chain-rpc 网关全量接入）

> **提出方**：AIHunter SaaS（backend risk-engine / broadcast-service / chain-sync 等全部 RPC 依赖方）
> **日期**：2026-08-12
> **目标版本**：`@0xinfrax/infrax-dk` ≥ 0.6（ChainRpcAPI 已具备）
> **状态**：待评审

## 一、背景与痛点

AIHunter SaaS 决定将全部链上 RPC 基础设施切换到 InfraX chain-rpc 网关（:9130）。现有 RPC 依赖分散在 5 处（见附 A），当前使用公共节点/占位/自建端点，存在可用性与一致性问题：

1. **端点碎片化**：风控链读用公共节点默认值（infura 占位/bsc-dataseed/base.org）、广播兜底用 publicnode、OxaChain 读/写用自建端点——无统一 SLA、无集中密钥管理。
2. **chain-rpc 仅内网**（`:9130`，nginx 未配置 `/v1/*` 公网路由）：**外部调用方无法直连**，这是切换的最大阻塞——需要公网入口或等价接入路径。
3. **链覆盖需确认补齐**：网关当前链集 `sepolia,ethereum,bsc,base,oxa,solana`（PRODUCTION_CREDENTIALS），我方还需 **polygon/arbitrum/optimism**（broadcast 多链执行面）。
4. **读/广播 key 分离**已具备（读 key 无法触达广播端点）——符合安全预期，需要为我方签发双 key。

## 二、需求目标

1. **公网可接入**：提供 chain-rpc 的 HTTPS 公网入口（或等价 VPN/代理路径），我方免内网依赖。
2. **key 签发**：为我方签发**读 key**（`CHAIN_RPC_READ_KEY` / 或 `dx_` scope=`rpc`）与**广播 key**（scope=`rpc_broadcast`），分级校验生效。
3. **覆盖我方全部使用点**：链（ETH/BSC/BASE/POLYGON/ARBITRUM/OPTIMISM/SOL/Oxa 19505）× 方法（eth_call/getBalance/getCode/getLogs/getTransactionReceipt 等读方法 + 广播）。
4. **生产可用**：配额、时延、错误语义明确，不影响线上信号/交易链路。

## 三、需求项

### R1 公网接入路径 — P0

- 为 `/v1/rpc/:chain`、`/v1/broadcast/:chain`、`/v1/status`、`/v1/subscription/*`、`/v1/ws` 提供 **HTTPS 公网入口**（nginx 代理或独立域名，如 `rpc-gw.0xainet.top`），复用平台 key 鉴权（`X-API-Key`/`X-Service-Key`/Bearer 三选一契约不变）。
- 交付物：公网 base URL + TLS 证书有效说明；或明确的 VPN/跳板接入方案。

### R2 双 key 签发 — P0

- 我方接入所需：**读 key**（可读全部读端点，含 `/v1/rpc`、`/v1/status`、`/v1/ws`）+ **广播 key**（仅 `/v1/broadcast/:chain`）。
- 验收：读 key 调广播端点 → 401；广播 key 可读可广播；`X-Json-Rpc: raw` 透传正常。

### R3 链覆盖补齐 — P1

**背景与必要性（为什么需要 polygon/arbitrum/optimism）**:

- 我方**交易/信号面本就是 7 链**：OKX ChainOS 路由表 `"137":POLYGON "42161":ARBITRUM "10":OPTIMISM`（broadcast/wallet-tee okx_client），信号面 `EVM_CHAINS = {ETH, BSC, BASE, POLYGON, ARBITRUM, OPTIMISM}`（signal ws_market_client）——信号可在 POLYGON/ARBITRUM/OPTIMISM 上触发并在 OKX 执行 swap。
- 但现有 RPC 兜底/链读**只覆盖 4 链**：广播兜底 `CHAIN_RPC_FALLBACK` 仅 ETH/BSC/BASE（publicnode），风控链读 `DEFAULT_RPC_URLS` 仅 ETH/BSC/BASE/SOL——**POLYGON/ARBITRUM/OPTIMISM 无任何 RPC 通道**（OKX 广播失败时兜底直接报 `Unsupported chain`，风控无链可读）。
- 因此 R3 是**补齐既有缺口**（非新增能力）：趁 RPC 全量切换一次性对齐交易面 7 链，避免「切了 InfraX 但 3 条链仍无 RPC」的半切状态。

需求：

- 保持现有 `sepolia,ethereum,bsc,base,oxa,solana` 稳定；
- **新增 polygon / arbitrum / optimism**（对齐 OKX ChainOS 多链执行面；链参数建议 `polygon/arbitrum/optimism`，与 OKX ChainOS 命名一致）；
- 链参数与链 ID 映射文档化（`GET /v1/status` 或 plans 返回完整链表）。

### R4 方法白名单确认 — P1

我方读方法清单（须全部放行，非白名单 403 语义保留）：
- `eth_blockNumber` `eth_chainId` `eth_gasPrice` `eth_feeHistory`
- `eth_call` `eth_getBalance` `eth_getCode` `eth_getStorageAt`
- `eth_getTransactionByHash` `eth_getTransactionReceipt` `eth_getBlockByNumber`
- `eth_getLogs` `eth_getBlockNumber`
- solana：`getBalance` `getBlockHeight` `getSignatureStatuses` 等 `get*` 读方法

### R5 生产 SLA 与配额 — P1

- **配额**：免费套餐（rpc_free）单 key 月度配额/并发；生产接入建议套餐（pro/enterprise）与定价；超限 503 的升级路径。
- **时延**：P95 读调用 < 500ms（单链，非 batch）；batch 现并发上限 8、≤100 条/批——确认是否满足我方信号链并发（信号触发同秒多策略并行读）。
- **可用性**：网关无单点（RPC 池多端点负载/故障转移），广播 `wait=true` 回执轮询语义稳定。

### R6 广播语义 — P1

- `POST /v1/broadcast/:chain` body `{rawTransaction, wait, timeoutMs}` → `{txHash, confirmed, receipt}`；确认 `confirmed=false` 时的错误/超时语义、非 2xx 重试建议。
- 广播链覆盖同 R3（含 oxa 19505——我方 OxaChain 写路径 nft/subscription 依赖）。

### R7 WS 订阅面 — P2

- `/v1/ws`（`eth_subscribe`）链覆盖与配额；我方高频链上事件订阅（预留，非当前阻塞）。

## 四、验收标准

1. 公网 HTTPS 入口可达：`GET /v1/health`（或 `GET /v1/status`）→ 200，链表完整。
2. 双 key 分级验证通过（读 key 广播 401）。
3. **我方 6 个使用点全量切换**（见附 A）后 24h 生产无 RPC 错误（用现有监控对账）。
4. 覆盖链（含 polygon/arbitrum/optimism + oxa）与方法白名单逐项 200。
5. 免费配额满足我方当前生产量，或给出 pro/enterprise 报价与切换建议。

## 五、优先级

- **P0**：R1（公网入口）+ R2（双 key）——决定切换可行性。
- **P1**：R3（链补齐）+ R4（方法确认）+ R5（SLA/配额）+ R6（广播语义）。
- **P2**：R7（WS 订阅）。

## 六、对调用方（AIHunter SaaS）的意义

- R1+R2 落地后，我方 risk-engine（已 env 化 `RPC_URL_ETH` 等）**零代码改动**改 env 指向 InfraX 公网入口即完成链读切换；broadcast 兜底、chain-sync/nft/subscription（OxaChain 19505）同步切换。
- 统一：5 处 RPC 依赖收敛为 1 个网关 + 2 个 key，与钱包（MPCAPI）、支付（PaymentAPI）同平台治理。
- 配合已提的两份需求单（行情 RPC + DEX 执行 / Session Key 托管），我方链上依赖全部收敛到 InfraX。

---

## 附 A：我方 RPC 使用点清单（切换范围）

| # | 使用点 | 方法 | 链 | 当前 RPC | 切换目标 |
|---|--------|------|----|----------|:--:|
| 1 | backend risk-engine.ts | eth_call（风控/余额/合约） | ETH/BSC/BASE/SOL | env `RPC_URL_ETH/BSC/BASE/SOL`（默认公共节点/占位） | `/v1/rpc/{chain}` 读 key |
| 2 | broadcast-service okx_client.py | 广播兜底 | ETH/BSC/BASE | CHAIN_RPC_FALLBACK（publicnode） | `/v1/broadcast/{chain}` 广播 key |
| 3 | backend nft-service.ts | 读链 + eth_sendRawTransaction | **OxaChain 19505** | env `RPC_URL`（自建） | `/v1/rpc/oxa` + `/v1/broadcast/oxa` |
| 4 | backend subscription-client.ts | 读链 | OxaChain 19505 | env `RPC_URL` | `/v1/rpc/oxa` |
| 5 | services/chain-sync/ | 链同步（读） | OxaChain 19505 | env `RPC_URL` | `/v1/rpc/oxa` |
| 6 | gateway server.ts | 行情代理（ticker/candles） | —（数据面） | OKX V5 REST | 属行情需求单，不在本单范围 |

> 注：OxaChain（chainId 19505，`rpc.l1.oxachain.io`）为集团公共链，InfraX chain-rpc 已支持（链参数 `oxa`），我方 3/4/5 号使用点可直接切换。
