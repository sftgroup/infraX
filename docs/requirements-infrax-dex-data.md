# DEX 策略数据需求清单（提交 infrax）

> **提交方**: AIHunter SaaS（产品方）
> **背景**: 产品定位 DEX-only（用户可选 DEX 代币交易对已上线，hyperliquid 为唯一实盘通道）。现有 infrax 数据（宏观因子 / CEX 衍生品 funding-OI / 经纪商矩阵）为传统 CEX 视角，**不覆盖链上微观结构**（流动性/滑点/社交热度/资金流/风险）。
> **本文档**: 列出 DEX 策略所需的数据需求，每条标注**字段定义、更新频率、候选数据源**。最终数据源选型与实现由 infrax 评估决策。
> **联系**: 数据交付后经 gateway 透传（`/api/dex/*`）供前端与 python-backend 消费，infrax 决定交付形态（新端点 or 扩展 `_complex`）。

---

## 需求总览

| # | 需求 | 优先级 | 候选数据源 |
|---|---|---|---|
| R1 | 热门代币列表（含社交热度排行） | **P0** | OKX OnchainOS `token/hot-tokens` |
| R1b | **主流 DEX 原生热门榜**（按链真实成交量/TVL） | **P0** | DexScreener（聚合全部主流 swap） |
| R2 | 单币行情与基本面（每个热门币） | **P0** | OKX `price-info` / DexScreener |
| R3 | 社交热度（逐币） | **P0** | OKX hot-tokens / LunarCrush |
| R4 | 安全与风险评分 | **P0** | OKX security / `cluster-overview` |
| R5 | 巨鲸动向 / 聪明钱 | **P1** | OKX Signal API / 链上索引器 |
| R6 | 持有者结构 | **P1** | OKX `holders` / `advanced-info` / `cluster-overview` |
| R7 | 流动性池 / 深度 | **P1** | OKX `token/liquidity` / DexScreener |
| R8 | 顶级交易者 / 交易历史 | **P1** | OKX `top-trader` / `trades` |
| R9 | 永续衍生品（hyperliquid funding/OI/深度） | P1 | hyperliquid `/info`（python-backend 已直连，可选） |
| R10 | 池龄 / 新币生命周期 | P2 | DexScreener / OKX advanced-info |

---

## 需求明细

### R1 热门代币列表（含社交热度排行）— P0

**说明**: 用户可选交易对的**核心榜单**。当前我们仅消费 okx_hot_tokens 的 trending 榜子集（5 个字段），需要扩展为**双排行**（Trending + X 提及）并补齐字段。

| 字段 | 类型 | 说明 |
|---|---|---|
| `symbol` | string | 代币符号（如 PEPE） |
| `chain` | string | 链名（ETH/BSC/BASE/SOL） |
| `tokenAddress` | string | 合约地址 |
| `price` | number | 当前价格（USD） |
| `volume24h` | number | 24h 交易量（USD） |
| `marketCap` | number | 市值（USD） |
| `liquidity` | number | 流动性（USD） |
| `change24h` | number | 24h 价格变化 % |
| `trendingScore` | number | 趋势评分（排行榜 rank 依据） |
| `xMentions` | number | X（推特）24h 提及次数（**社交热度**） |
| `rankType` | string | 榜单类型：`trending` / `x_mentions` |

**频率**: 60s~5min（榜单缓存）
**候选数据源**: OKX OnchainOS `GET /token/hot-tokens`，`ranking-type=4`（Trending）与 `ranking-type=5`（X-mentioned）各取一份
**交付建议**: 扩展现有 `_complex.okx_hot_tokens`，每项含上述全字段

### R1b 主流 DEX 原生热门榜（按链真实成交量/TVL）— P0

**说明**: 热门代币的**另一来源**——直接从各链**主流 swap 协议**的池子数据按真实链上成交量/TVL 排序。与 R1 的 OKX 热度榜**互补**：OKX 榜单偏社交热度/趋势，DEX 原生榜偏真实链上流动性（过滤假量/低流动性）。

**主流 swap 覆盖**:
- ETH: Uniswap V3/V2、Balancer
- BSC: PancakeSwap V3/V2
- BASE: Aerodrome、Uniswap V3、BaseSwap
- SOL: Raydium、Orca、Jupiter（聚合）、Meteora

| 字段 | 类型 | 说明 |
|---|---|---|
| `chainId` | string | 链（eth/bsc/base/solana，前端映射为 ETH/BSC/BASE/SOL） |
| `dexName` | string | DEX 协议（uniswap/pancakeswap/aerodrome/raydium/orca/...） |
| `symbol` / `name` | string | 代币符号/名称 |
| `tokenAddress` | string | 合约地址 |
| `pairAddress` | string | 池子地址 |
| `volume24h` | number | 池 24h 成交量（USD） |
| `liquidity` | number | 池流动性（USD） |
| `priceUsd` | number | 价格 |
| `priceChange24h` | number | 24h 涨跌幅 % |
| `txns24h` | object | 买卖笔数 `{buys, sells}` |
| `createdAt` | number | 池创建时间（新币识别） |

**频率**: 5min（榜单）/ 60s（单池）
**候选数据源（2026-08-21 实测结论）**:

| 源 | 端点 | 实测 |
|---|---|---|
| **DexScreener（推荐，一个源聚合全部主流 swap）** | `GET /latest/dex/search?q=`、`/latest/dex/pairs/{chain}/{addr}`、`/token-profiles/latest/v1`、`/token-boosts/latest/v1` | ✅ 200 免费免 key |
| GeckoTerminal（CoinGecko 旗下，按链 top_pools/trending_pools） | `api.geckoterminal.com/api/v2/networks/{net}/top_pools` | ❌ 429 免费层限流、base 端点 404，**不推荐** |
| Uniswap 官方 API | `api.uniswap.org/v1/tokens` | ❌ 409 需 API key |
| PancakeSwap 旧版 API | `api.pancakeswap.info/api/v2/tokens` | ❌ 502 已废弃 |
| Raydium 原生 | `api.raydium.io/v2/main/pairs` | ❌ 500 不稳定 |
| 各 DEX 官方 subgraph（备选） | The Graph / Goldsky（uniswap-v3 / pancakeswap / aerodrome） | 需 key，索引延迟 |

**主流 DEX 热门榜能力（2026-08 调研）**: Uniswap/PancakeSwap/Raydium 官方有榜单但需 key 或已废弃；**唯一推荐的每链免费热门榜来源是 DexScreener**——一个 API 覆盖四条链全部主流 DEX（Uniswap/PancakeSwap/Aerodrome/Raydium/Orca/Meteora），按链过滤 + 按 `volume24h` 排序即可生成该链主流 swap 热门榜。

**结论建议**: **不建议 infrax 直连各 DEX 协议 API**（实测多处失效/需 key）；**推荐用 DexScreener 单源聚合**——`search` 端点返回 pairs[] 含 dexId/volume/liquidity/txns/createdAt，可按「链 + DEX 协议」过滤后按 `volume24h` 排序生成该链主流 swap 热门榜；`token-boosts`（有推广资金的热门币）与 `token-profiles`（新币发现）可作补充榜单。
**交付建议**: 与 R1 合并为统一「热门代币」端点，每项带 `source: okx | dexscreener` 与 `dexName`，前端可切换来源

### R2 单币行情与基本面（每个热门币）— P0

**说明**: 热门榜中**每个代币的完整行情画像**，用于交易对详情、策略信号。

| 字段 | 类型 | 说明 |
|---|---|---|
| `price` / `priceUsd` | number | 价格（USD / 原生币计价可选） |
| `volume24h` | number | 24h 交易量 |
| `marketCap` | number | 市值 |
| `liquidity` | number | 总流动性 |
| `liquidityDetail` | object | 按 DEX/池拆分流动性 |
| `change1h/6h/24h/7d` | number | 多时间窗涨跌幅 |
| `ath` / `atl` | number | 历史高低 |
| `holders` | number | 总持有地址数 |
| `chain` / `tokenAddress` | string | 链与地址 |

**频率**: 60s
**候选数据源**: OKX OnchainOS `token/price-info`（含 `rankingType` 扩展）、DexScreener `GET /token/{chain}/{address}`
**交付建议**: 与 R1 合并为单币详情端点

### R3 社交热度（逐币）— P0

**说明**: **社交媒体热度指标**，DEX 策略领先信号（用户明确关注）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `xMentions24h` | number | X 24h 提及次数 |
| `xMentionChange` | number | 提及次数环比变化（增长爆发） |
| `trendingScore` | number | 趋势评分 |
| `sentiment` | string | 情绪标签（positive/neutral/negative，可选） |
| `socialVolume` | number | 全网社媒声量（备选） |

**频率**: 5~10min
**候选数据源**: OKX OnchainOS hot-tokens（X-mentioned 榜）；**备选**: LunarCrush（社媒聚合）
**注意**: 若 hot-tokens 仅返回榜单不含逐币数值，需 infrax 用 additional 端点补齐，或评估 LunarCrush

### R4 安全与风险评分 — P0

**说明**: **上币/交易前安全检查**（DEX 特有风险，CEX 无此概念）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `riskLevel` | string | 风险等级（low/mid/high/unsafe） |
| `isHoneypot` | boolean | 蜜罐合约 |
| `isScam` | boolean | 钓鱼/诈骗标签 |
| `rugRiskPct` | number | rug pull 风险概率 % |
| `newAddressPct` | number | 新地址占比（冷启动指标） |
| `ownerInfo` | object | 合约创建者/owner 信息 |
| `devStats` | object | 开发者交易行为统计 |
| `lockInfo` | object | 流动性锁仓信息（可选） |

**频率**: 5min（低波动）
**候选数据源**: OKX OnchainOS security 模块、`token/advanced-info`（risk level/owner/dev stats）、`token/cluster-overview`（rug pull %/new address %）
**交付建议**: 聚合为单币「风险画像」对象

### R5 巨鲸动向 / 聪明钱 — P1（用户重点）

**说明**: **大额资金与聪明钱链上动向**，DEX 策略核心资金面信号。

| 字段 | 类型 | 说明 |
|---|---|---|
| `smartMoneyNetFlow` | number | 聪明钱净流入（USD，24h） |
| `smartMoneyInflow` / `outflow` | number | 聪明钱流入/流出拆分 |
| `whaleTransfers` | array | 大额转账列表（>阈值 USD）：`{from,to,amountUsd,token,ts}` |
| `whaleTransferCount` | number | 大额转账次数（24h） |
| `kolHoldings` | array | KOL 持仓变动 `{kol, action, token, amountUsd, ts}` |
| `exchangeFlow` | number | 进出交易所/池子净流（可选） |

**频率**: 5min（实时流可选 1min）
**候选数据源**: OKX OnchainOS **Signal API**（smart money/KOL/whale 信号）；**备选**: 链上索引器（The Graph/Shadow/Goldsky）自建解析
**交付建议**: 独立端点（数据量大），或按 token 聚合摘要

### R6 持有者结构 — P1

| 字段 | 类型 | 说明 |
|---|---|---|
| `topHolders` | array | Top 100 持有者 `{address,balance,label}`（label: KOL/whale/smart money） |
| `top10Share` | number | Top10 持有占比 % |
| `hhi` | number | 持有集中度指数 |
| `holderCount` | number | 持有地址总数 |
| `clusterInfo` | object | 聚类集中度/关联地址（可选） |

**频率**: 1h
**候选数据源**: OKX OnchainOS `token/holders`（含标签）、`advanced-info`（集中度）、`cluster-overview`（聚类）

### R7 流动性池 / 深度 — P1

| 字段 | 类型 | 说明 |
|---|---|---|
| `pools` | array | Top 5 池 `{dexName, poolAddress, liquidityUsd, volume24h, share}` |
| `depth` | object | 在价附近 buy/sell 深度（可选） |
| `poolTvl` | number | 总池 TVL |

**频率**: 5min
**候选数据源**: OKX `token/liquidity`（Top 池）；DexScreener `data.pairs[]`（pool 明细）

### R8 顶级交易者 / 交易历史 — P1

| 字段 | 类型 | 说明 |
|---|---|---|
| `topTraders` | array | 盈利地址 `{address, pnlUsd, winRate, trades}` |
| `recentTrades` | array | 近期 DEX 交易 `{from,to,amountUsd,dex,ts}` |

**频率**: 10min
**候选数据源**: OKX `token/top-trader`、`token/trades`

### R9 永续衍生品（hyperliquid）— P1

| 字段 | 类型 | 说明 |
|---|---|---|
| `fundingRate` | number | 资金费率（逐币） |
| `openInterest` | number | 未平仓量（USD） |
| `l2Depth` | object | 盘口深度（可选） |

**频率**: 60s（funding）/ 90s（OI）
**候选数据源**: **hyperliquid `POST /info`**（funding / openInterest / l2Book）——python-backend 已直连封装，**此项 infrax 不必实现**，仅标注：若 infrax 统一提供亦可替换现有 binance fapi fallback
**交付建议**: 可跳过；建议 infrax 端保持 funding/OI 透传 hyperliquid 语义

### R10 池龄 / 新币生命周期 — P2

| 字段 | 类型 | 说明 |
|---|---|---|
| `poolCreatedAt` | string | 首个池创建时间 |
| `tokenAgeDays` | number | 代币上线天数 |
| `liquidityLocked` | number | 锁仓流动性（可选） |

**频率**: 1h
**候选数据源**: DexScreener `pair.createdAt` / OKX advanced-info

---

## 架构决策：数据层与交易层解耦（评审结论）

**适配 DEX 只解决数据层，不替代 OKX 交易端口。** 两层职责独立，来源可自由组合：

| 层 | 职责 | 建议来源 | 是否可换 |
|---|---|---|---|
| **数据层** | 热门代币榜、池子、流动性/深度 | DexScreener（免费聚合全部主流 DEX）替代 OKX hot-tokens | ✅ 可换 |
| **交易层** | quote / swap / approve / broadcast（**执行 + 跨 DEX 最优路由**） | **OKX OnchainOS aggregator（保留）** | ❌ 不建议换 |

**不替换 OKX aggregator 的原因**:
1. **聚合器已路由所有主流 DEX**——OKX OnchainOS aggregator 内部连通 Uniswap/PancakeSwap/Aerodrome/Raydium/Orca 等池子做最优对价，一条 API 完成跨池拆分、滑点保护、approve、gas
2. **直连单 DEX 交易成本高**——需自行实现每个 DEX 的路由器合约/报价/多池拆分/滑点保护/跨链 gas，且单 DEX 流动性分散，价格劣于聚合器
3. **生产已验证**——[dex-dispatcher.ts](../backend/services/dex-dispatcher.ts) 交易链路已运行，paper_engine 估价与实盘执行同一来源

**落地流程**: DexScreener（或 OKX hot-tokens）**找币/看池** → OKX aggregator **下单执行** → hyperliquid **永续对冲/持仓**。

---

## 字段规范（统一约定）

- **金额**: 一律 USD；缺失/无流动性用 `null`（前端显示 —），不要用 0 或负数
- **时间窗**: `24h` 为滚动 24h；`change24h` 为价格变化百分比
- **链名**: 枚举 `ETH / BSC / BASE / SOL`（其余链可忽略；DEX-only 收敛后 polygon/arb/op 不纳入）；DexScreener 侧原始值 `eth/bsc/base/solana` 需映射
- **地址**: `tokenAddress` 为小写 hex（EVM）或 base58（SOL）
- **命名**: 以驼峰字段名透传，前端/i18n 直接消费

## 优先级说明（给 infrax 排期参考）

- **P0（R1-R4，含 R1b）**: 热门榜单（OKX 热度 + **DexScreener 主流 swap 原生榜**）+ 单币行情 + **社交热度** + **安全风险** —— 直接支撑当前用户可选交易对面板与 DEX 策略风控，建议**首批交付**
- **P1（R5-R8）**: 巨鲸/聪明钱、持有者、流动性池、顶级交易者 —— 支撑资金面策略与池子评估
- **P2（R10 + MEV）**: 新币生命周期、MEV 风险（EigenPhi 等专项源）—— 后续迭代

---

*生成于 2026-08-21，提交 infrax 评审。*
