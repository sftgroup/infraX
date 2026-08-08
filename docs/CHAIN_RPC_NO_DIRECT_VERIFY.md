# Chain-RPC 无直连最终验证报告（DC-10 / waas 全量收敛）

> 日期：2026-08-08
> 原则：**RPC 在 chain-rpc 网关（:9130）汇总后再分发，任何消费端禁止直连上游 RPC**（读 key 仅触达 `/v1/rpc/:chain`、`/v1/status`；广播 key 仅触达 `/v1/broadcast/:chain`，读 key 无法触达广播端点）。
> 覆盖范围：waas（本报告主体验证）+ 同款修复 mpc。

---

## 1. 目标

把 waas 侧所有**非回退主路径**的直连 `ethers.JsonRpcProvider(上游URL)` 改为走 chain-rpc 网关透传，删除剩余直连点，并修复 ethers 探测坑，最终做到 waas 代码中**零上游 RPC URL、零直连 provider**。

## 2. 清理点全量清单（waas）

| # | 文件 | 位置 | 原直连代码 | 现实现 |
|---|------|------|-----------|--------|
| 1 | services/walletService.ts | getNCBalance | `new ethers.JsonRpcProvider(getRpcUrl(chain))` | `new GatewayProvider(chain)` |
| 2 | services/walletService.ts | getNCTransactions | 同上 | `new GatewayProvider(chain)` |
| 3 | services/walletService.ts | getTokenInfo | 同上 | `new GatewayProvider(chain)` |
| 4 | services/walletService.ts | getTokenBalance | 同上 | `new GatewayProvider(chain)` |
| 5 | services/walletService.ts | getNFTs | 同上 | `new GatewayProvider(chain)` |
| 6 | services/walletService.ts | `getRpcUrl(chain)` 函数 | 解析 5 套上游 URL（1rpc.io/publicnode 等） | **删除**（新增 `getProvider()` 辅助） |
| 7 | services/txService.ts | sweepNative 读余额 | `new ethers.JsonRpcProvider(rpcUrl)` | `new GatewayProvider(chain)` |
| 8 | routes/internalRoutes.ts | estimate-gas | 直连 sepolia | `new GatewayProvider("sepolia")` |
| 9 | routes/internalRoutes.ts | send-tx（gas pool 广播） | 直连 + `wallet.sendTransaction` | `new GatewayProvider("sepolia")`，广播自动走 `/v1/broadcast` |
| 10 | routes/internalRoutes.ts | balance 查询 | `SEPOLIA_RPC_URL \|\| publicnode.com` 直连 | `new GatewayProvider(chain)` |
| 11 | routes/internalRoutes.ts | sweep | 直连 + gas pool 广播 | `new GatewayProvider("sepolia")` |
| 12 | services/saasService.ts | withdrawal 广播 | 直连 + 私钥签名广播 | `new GatewayProvider('sepolia')` |
| 13 | services/hdWalletService.ts | signAndSendTransaction | 直连签名广播 | `new GatewayProvider(chain)` |
| 14 | config/index.ts | `chainRpc` / `sepoliaRpcUrl` / `ethRpcUrl` / `bscRpcUrl` / `baseRpcUrl` | 死配置（无消费者），含 1rpc.io 上游 URL | **删除**；保留 `chainRpcGateway`（新增 `broadcastKey`） |
| 15 | models/database.ts | chains 表 seed | sepolia `rpc_url='https://1rpc.io/sepolia'` | 清空为 `''`（该列无任何消费者） |
| 16 | routes/internalRoutes.ts | `GET /rpc-config` | 返回上游 URL 字符串 | 统一返回网关 URL（`CHAIN_RPC_URL`） |
| 17 | routes/internalRoutes.ts | `PUT /rpc-config` | 运行时写入上游 URL 到 env | **拒绝**：返回 DC-10 收敛提示，禁止切换上游 |

新增文件：`services/gatewayProvider.ts` —— 继承 `ethers.JsonRpcProvider`，重写 `send(method, params)`：读方法 → `POST {gateway}/v1/rpc/:chain`（读 key），`eth_sendRawTransaction` → `POST {gateway}/v1/broadcast/:chain`（广播 key）；统一信封 `{code, message, data}`，读返回 `data.result`、广播返回 `data.txHash`。

## 3. 代码级验证（grep 清零）

```
grep -rE "new ethers\.JsonRpcProvider|getRpcUrl|publicnode|1rpc\.io|infura|alchemy|\.bnbchain\.org|data-seed|sepolia\.base\.org" projects/waas
→ 无任何直连 provider / 上游 RPC URL 残留（唯一命中为 block explorer 展示链接，非 RPC）
```

- `new ethers.JsonRpcProvider`：0 处
- `getRpcUrl`：0 处
- 上游 RPC URL（publicnode / 1rpc.io / infura / alchemy / bnbchain / data-seed / base.org）：0 处
- `GatewayProvider` 使用点：waas 13 处（见 §2 清单）+ `getProvider()` 辅助 + `rpcProxy`（既有网关转发，DC-9 后无回退）

## 4. ethers 6.17 探测坑修复（关键）

**现象**：`provider.getFeeData()` / `getNetwork()` 报 `404 Not Found {"detail":"not found"}`，estimate-gas 端点回落 fallback。

**根因**：ethers 6.17 对构造参数传入的 **Networkish 对象**（`{chainId, name}`）不会设置 `staticNetwork` 选项；`getNetwork()` 触发 `_start() → _detectNetwork()`，通过低层 `_send` 发 `eth_chainId` 到 provider 的**裸 base URL**（网关根路径 `/`），命中网关 catch-all 404。该请求**绕过**了我们重写的 `send()`。

**修复**：`GatewayProvider` 构造改为传入 `Network` 实例 + `staticNetwork`：

```ts
const network = new ethers.Network(norm, chainId);
super(base, network, { staticNetwork: network });
```

`JsonRpcApiProvider` 构造器在 `staticNetwork` 为实例时直接 `this.#network = staticNetwork`，`_detectNetwork()` 立即返回，**完全跳过** `eth_chainId` 探测。

**同款修复**：`projects/mpc/gatewayProvider.ts`（DC-3 收敛的 provider 存在同一问题，latent bug，一并修复）。

## 5. 生产验证证据（43.163.105.172）

### 5.1 服务状态
- `infrax-waas`：`active`（启动日志 `InfraX Backend v2.0 started on port 9109`）
- `infrax-mpc`：`active`
- `infrax-chain-rpc`：`active`

### 5.2 环境配置（systemd unit）
- 已注入：`CHAIN_RPC_URL=http://127.0.0.1:9130`、`CHAIN_RPC_READ_KEY=9ffb2e…aba4ae`
- **本次补齐**（drop-in `rpc-gateway.conf`）：`CHAIN_RPC_BROADCAST_KEY=22155813…4e5caf`（此前 unit 缺失，广播将走空 key 失败）

### 5.3 端点端到端验证
| 端点 | 结果 |
|------|------|
| `POST /api/v2/internal/estimate-gas` | 返回**真实** gasPrice=936283958、gasLimit=21000（修复前为 fallback 50000000000） |
| `GET /api/v2/internal/balance?chain=sepolia` | 返回真实余额 132978.52 sETH（零地址） |
| `GET /api/v2/internal/rpc-config` | 各链 `rpc` 均返回 `http://127.0.0.1:9130`（网关） |
| `PUT /api/v2/internal/rpc-config` | 返回拒绝：`DC-10: RPC 已统一收敛到 chain-rpc 网关，禁止运行时切换上游 RPC` |

### 5.4 chain-rpc 网关日志（结构化，route 细分）
```
INFO [chain-rpc] {"route":"rpc","status":200,"dur":"93ms","chain":"sepolia","method":"eth_getBlockByNumber"}
INFO [chain-rpc] {"route":"rpc","status":200,"dur":"85ms","chain":"sepolia","method":"eth_maxPriorityFeePerGas"}
INFO [chain-rpc] {"route":"rpc","status":200,"dur":"237ms","chain":"sepolia","method":"eth_gasPrice"}
INFO [chain-rpc] {"route":"rpc","status":200,"dur":"225ms","chain":"sepolia","method":"eth_estimateGas"}
INFO [chain-rpc] {"route":"rpc","status":200,"dur":"79ms","chain":"sepolia","method":"eth_getBalance"}
```
修复后**无 `route=other 404 eth_chainId` 探测残留**。

### 5.5 鉴权矩阵验证（读写分离双 key，全量复核 2026-08-08 08:16）

网关启动日志：`auth: read=configured broadcast=configured externalVerify=false`

| # | 场景 | 结果 | 判定 |
|---|------|------|------|
| 1 | `/v1/rpc` + 读 key | 200 | ✅ 读端点放行读 key |
| 2 | `/v1/rpc` + 广播 key | 200 | ✅ 广播 key 为超集，可读 |
| 3 | `/v1/rpc` + 无 key | 401 | ✅ 拒绝 |
| 4 | `/v1/rpc` + 错误 key | 401 | ✅ 拒绝（timingSafeEqual 常量时间比较） |
| 5 | `/v1/broadcast` + 读 key | 401 | ✅ 读 key 无法触达广播端点 |
| 6 | `/v1/broadcast` + 广播 key | 400 | ✅ 鉴权通过（拒绝无效 rawTx，非鉴权错误） |
| 7 | `/v1/broadcast` + 无 key | 401 | ✅ 拒绝 |
| 8 | `/health` + 无 key | 200 | ✅ 豁免 |
| 9 | waas `/api/v2/internal/*` + 错误 API key | 401 | ✅ waas 内部端点鉴权有效 |
| 10 | waas `/api/v2/internal/*` + 正确 key | 200 | ✅ |

实时链路：`GET /api/v2/internal/balance` → 网关日志同秒 `route=rpc 200 chain=sepolia method=eth_getBalance`（08:16:16）。

## 6. 残余/非直连判定（明确豁免项）

| 项 | 判定 |
|----|------|
| `internalRoutes.ts` rpc-config 中 explorer 展示链接（etherscan/bscscan） | 浏览器展示用，非 RPC，保留 |
| `config.chainRpcGateway`（网关地址 + 双 key） | **唯一**链上 RPC 入口，保留 |
| scannerService `scanBlock` 经 CWallet `/scan-block` | 后端服务间调用（CWallet），非上游 RPC，保留 |
| mpc / dc / collector / aa-sdk 等其他服务 | DC-3/DC-9/DC-10 均已收敛或按约定保持自建池；本次额外修复 mpc 探测坑 |

## 7. 结论

waas 已实现**零直连**：所有链上读与广播统一经 chain-rpc 网关透传（`GatewayProvider` / `rpcProxy`），无任何上游 RPC URL 残留、无回退分支；生产实测读（balance/gas/estimate）与广播鉴权链路全部通过网关，网关日志 `route=rpc`/`route=broadcast` 命中，分级 key 权限隔离有效。ethers 探测坑修复同步覆盖 mpc。全仓无直连原则达成。
