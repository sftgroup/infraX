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

> ✅ **已实现+生产验证**（2026-08-14）：套餐含并发限制；P95 实测达标；503 升级路径已生效。

- **配额**：免费套餐（rpc_free）单 key 月度配额/并发；
  - `rpc_free` 10k 次/月 + 并发 10（免费）；`rpc_pro` $79/月 100k 次 + 并发 50；`rpc_enterprise` $299/月 1M 次 + 并发 200（`GET /v1/subscription/plans` 可查）
  - 超限 **503 + 升级路径**：月度配额用尽 或 并发超限 → `{code:503, message:"...upgrade your plan at /v1/subscription/plans", data:{used/limit, quota, plan, upgradeUrl}}`
  - 并发限制实现：per-key in-memory 计数（rpcQuotaEnforce，同步先于异步配额查询，`res.on('finish')` 释放）；**生产实测**：25 并行请求 → 15 个 503 ✓
- **时延**：**P95 读调用 < 500ms**（健康上游，单链）；2026-08-14 生产实测：bsc p50=223ms / **p95=468ms**（达标）；⚠️ 上游免费端点抖动时尾延迟劣化——当日 ankr 全系端点 down，受影响链 p95 尖峰 3~8s（池已自动故障转移至 active 端点，可用性保持；pro/enterprise 建议配付费端点（infura/quicknode）保障严格 SLA）
- **可用性**：RPC 池多端点负载均衡 + 健康检查（15s）+ 故障转移（`/v1/status` 暴露每端点 health）；广播 `wait=true` 回执轮询语义稳定（RPC-6 容错修复后已验证）

### R6 广播语义 — P1

> ✅ **已实现+生产验证**（2026-08-14）：wait 双语义 + 超时容错 + 链覆盖（含 oxa 19505）。

- `POST /v1/broadcast/:chain` body `{rawTransaction, wait, timeoutMs}` → `{chain, txHash, confirmed, receipt}`：
  - `wait=true`（默认 30s/3s 轮询，`timeoutMs` 可覆盖）→ 确认后 `{confirmed:true, receipt}`；轮询至 deadline 未确认 → **HTTP 200** `{confirmed:false, receipt:null, reason:"timeout"}`（不报错）
  - `wait=false` → 立即返回 `{confirmed:false, receipt:null, reason:"wait=false"}`
- **RPC-6 容错修复（2026-08-14）**：waitReceipt 轮询遇上游端点异常不再抛错中断（原行为 → 502），改为**吞错续轮至超时**；生产验证：模拟轮询 404 端点 → 8.8s 后返回 `{confirmed:false, reason:"timeout"}` ✓
- **重试建议**：wait=false 或超时后，先 `eth_getTransactionReceipt` 查 txHash 状态；未上链再重发（广播幂等，重复 nonce 由链裁决）
- 广播链覆盖同 R3（10 链含 **oxa 19505**，`/v1/status` 已验证）

### R7 WS 订阅面 — P2

- `/v1/ws`（`eth_subscribe`）链覆盖与配额；我方高频链上事件订阅（预留，非当前阻塞）。
- ✅ **实现 + 本地验证（2026-08-14）**：
  - **性能瓶颈修复**（原 DC-5 纯透传：1 客户端 = 1 上游 WS 连接 + 1 上游订阅，N 客户端同事件 = N 倍上游负载/带宽/内存放大；且无背压、无订阅清理跟踪）：
    - [wsHub.ts](../projects/chain-rpc/src/services/wsHub.ts)：订阅去重注册表——相同 (chain, method, params) 的客户端共享**一条**上游订阅，事件只拉一份、网关内扇出；最后一位客户端离开才向上游 `eth_unsubscribe`；孤儿订阅（确认前客户端全部离开）由 `confirmUpstream=false` 兜底补发取消。
    - 背压：广播时 `bufferedAmount` 超阈值（默认 1MB）的慢消费者被 `close(4004)` 驱逐并摘除，防高频事件内存放大。
  - **链覆盖与配额**（[ws.ts](../projects/chain-rpc/src/routes/ws.ts) 重写）：每链共享一条上游连接（refcount）；鉴权分级与 HTTP 读端点一致（本地 bridge key / `rx_` 订阅 key / 外部 data key scope=rpc）；`rx_` key 连接数按套餐 `concurrent` 限制（free 10 / pro 50 / enterprise 200，超限 `close 4005`）；每次订阅计入 `rpc_usage`；每客户端订阅数上限（`WS_MAX_SUBS_PER_CLIENT`，默认 32）。
  - **配置**：`WS_MAX_BUFFER_BYTES` / `WS_MAX_SUBS_PER_CLIENT` / `WS_ENABLE_QUOTA`。
  - **单测 21/21 全绿**（`npm test`，node:test + tsx）：订阅去重 isNew 语义 / 共享广播一次事件两客户端收到 / 最后离开释放上游 / 断开补发 `eth_unsubscribe` / 孤儿 confirm=false / 背压 4004 / 配额并发上限 / 4001/4002/4003/-32602 错误码。
  - ✅ 生产部署完成（2026-08-14：scp 4 文件 → restart infrax-chain-rpc → `ws endpoint /v1/ws ready (RPC-7)` → 实测无 key/错 key 4001、newHeads/logs 订阅出本地 subId、非法类型 -32602、取消 true 全过）。

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

> 注：OxaChain（chainId 19505，`rpc-oxa.0xainet.top`；旧域名 `rpc.l1.oxachain.io` DNS 已死）为集团公共链，InfraX chain-rpc 已支持（链参数 `oxa`），我方 3/4/5 号使用点可直接切换。
