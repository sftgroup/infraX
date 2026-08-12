# 需求单：行情数据 RPC 覆盖 + DEX 交易执行

> **提出方**：AIHunter SaaS（signal-service / wallet-tee-service 消费端）
> **日期**：2026-08-12
> **目标版本**：`@0xinfrax/infrax-dk` ≥ 0.8
> **状态**：待评审

## 一、背景与痛点

当前 SDK RPC 能力 = 通用链读（`/v1/rpc/{chain}`，`eth_*`/solana `get*` 白名单）+ 交易广播（`/v1/broadcast/{chain}`）；行情数据仅有 **REST** MarketAPI（`/api/v2/data/market/*`，12 组端点）。痛点：

1. **接口形态割裂**：行情（REST）与链读/广播（JSON-RPC）分离，agent 侧需维护两套调用协议与两套鉴权头。
2. **DEX 交易执行完全缺失**：SDK 无聚合报价/swap 构建，止步于「签名 + 广播」，消费端只能依赖 OKX ChainOS。
3. **批量能力缺失**：多 token 行情需逐次调用，延迟与调用数放大。

## 二、需求目标

1. 行情数据可经 **RPC** 访问（覆盖 MarketAPI 现有 12 组端点）。
2. **DEX swap 执行**（聚合报价 → 构建 tx → 广播）作为 RPC 方法提供。
3. 保持安全模型：**RPC 服务只构建、不持有私钥**，签名由调用方（InfraX MPC / 本地钱包）完成。
4. 行情 RPC 与 REST MarketAPI **同源同缓存**，口径一致。

## 三、需求项

### R1 行情数据 RPC（MarketRpc）— P1

| 方法 | 语义 |
|---|---|
| `market.tokenSearch` / `tokenInfo` | token 检索 / 详情 |
| `market.hotTokens` / `leaderboard` / `signals` / `mempump` | 热度 / 排行 / 聪明钱信号 / meme 扫描 |
| `market.candles` / `price` | K线 / 现价（**支持多 token 批量**） |
| `market.balances` / `transactions` | 余额 / 交易历史 |
| `market.trackedTokens` / `customSigs` | 自管理订阅面 |

- 入口：`/v1/market-rpc`（与 `/v1/rpc/{chain}` 并列）；鉴权沿用 `rx_` 读 key；响应信封 `{code, message, data}`。
- 订阅面（P2）：ws 行情推送（price/candles 增量），对齐低延迟场景。

### R2 DEX 交易执行 RPC（DexAPI）— P0

| 方法 | 语义 |
|---|---|
| `dex.quote` | 聚合报价：`{chain, tokenIn, tokenOut, amountIn}` → 最优路由 + 预估输出 + 滑点（500+ 流动性源，对齐 OKX ChainOS 同源能力） |
| `dex.approve` | 构建 ERC20 授权 tx → 返回**待签名** rawTransaction |
| `dex.swap` | 构建 swap tx → 返回**待签名** rawTransaction |
| `dex.broadcast` | 复用现有 `/v1/broadcast/{chain}`（`cr_` 广播 key） |

- **安全约束**：RPC 侧无任何 sign 端点（接口清单不含私钥/签名能力）；rawTransaction 由调用方（InfraX MPC `signDigest`/`signTypedData` 或本地钱包）签名后交广播端点。
- 覆盖链：X Layer / Ethereum / Base / BSC / Arbitrum / Polygon + Solana。

### R3 一致性保障

- 行情 RPC 与 REST MarketAPI 同源同缓存；SDK TS 类型 + Python 客户端同步发布。

## 四、验收标准

1. 行情 RPC 12 组方法可用、信封一致、多 token 批量可用。
2. `dex.quote → approve → swap → broadcast` 端到端通过（模拟 + 真实小额定单）。
3. 签名隔离：RPC 服务无私钥能力（自证：接口清单不含 sign 端点）。
4. 性能：quote P95 < 100ms；行情 RPC P95 < 200ms。

## 五、优先级

- **P0**：R2（`dex.quote` / `dex.swap`）—— 决定消费端交易执行面是否可统一到 SDK。
- **P1**：R1 核心子集（price / candles / token-info / hot-tokens / signals）。
- **P2**：批量、ws 订阅、其余方法。

## 六、对调用方（AIHunter SaaS）的意义

- R2 落地：签名（MPC）+ 构建（InfraX dex）+ 广播（chainRpc）可全走 SDK；执行报价仍可保留 OKX ChainOS 作主源。
- R1 落地：非交易行情查询统一走 RPC（替代 REST 直连），降低多接口维护成本。
