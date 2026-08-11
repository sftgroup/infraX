# InfraX AI Skills — 文档与示例（Quick Start）

本文档是各 skill 的使用示例合集，覆盖典型端到端流程，并重点说明两个特殊场景：**vault MPC 验证码确认** 与 **session-key 零签名模式**。

## 0. 前置条件

- MCP 服务器已启动（生产 systemd unit，端口见 [README](../README.md) 技能矩阵）。
- 环境变量 `INFRAX_MCP_API_KEY` 已配置（MCP_API_KEY 白名单或 mx_ 签发 key）。
- 各引擎侧业务 key（MPC_API_KEY / VAULT_API_KEY / PAYMENTS_API_KEY / DC_API_KEY / DATA_API_KEY）由部署环境注入。

## 1. Wallet：余额 → 模拟 → 发送 → 状态

```
1. wallet_balance  { "address": "0xAbC...", "chain": "sepolia" }
2. wallet_simulate { "from": "0xAbC...", "to": "0xDef...", "amount": "0.01", "chain": "sepolia" }
3. wallet_send     { "to": "0xDef...", "amount": "0.01", "chain": "sepolia" }
4. wallet_status   { "txHash": "<返回的 txHash>", "chain": "sepolia" }
```

## 2. Payment：链上支付 → 校验入账

```
1. payment_create  { "subscriber": "0xPayer", "planId": 3, "metadata": { "agentId": 1 } }
   # 法币 → 返回 Stripe sessionUrl；链上 → 返回付款指引
2. payment_verify  { "txHash": "0x...", "chain": "oxachain" }
   # verified: true = 幂等入账成功
3. payment_balance { "address": "0xPayer" }
```

## 3. Vault：创建多签 → 确认 → 执行

```
1. vault_create_safe { "name": "Treasury", "signers": ["0xA","0xB","0xC"], "threshold": 2, "chain": "base" }
2. vault_create_tx   { "safeId": "<safeId>", "to": "0xPayee", "amount": "0.5" }
3. vault_confirm_tx  { "safeId": "<safeId>", "txId": "<txId>", "signature": "0xSigA" }
4. vault_confirm_tx  { "safeId": "<safeId>", "txId": "<txId>", "signature": "0xSigB" }
5. vault_risk_check  { "safeId": "<safeId>", "txId": "<txId>" }
6. vault_execute_tx  { "safeId": "<safeId>", "txId": "<txId>" }
```

### 3A. vault MPC 验证码确认（A-8）

MCP 层当前**未暴露** confirm-mpc 工具，需走 SDK（`@0xinfrax/vault-sdk`）或 HTTP。流程：MPC 邮箱验证码解锁 → 取 session token → 调 vault 确认。

```ts
// SDK 方式（推荐）
import { createMpcClient } from "@0xinfrax/mpc-sdk";     // 或 mcp-server 内建
import { createVaultClient } from "@0xinfrax/vault-sdk";

const mpc = createMpcClient({ baseUrl: "http://localhost:9104", apiKey: process.env.MPC_API_KEY });
// 1. 发验证码 → 用户提供 6 位码（生产走 SMTP 邮件）
// await mpc.mpc.sendCode({ email });
// 2. 解锁会话取得 token
const { token } = await mpc.mpc.sessionUnlock({ email: "user@example.com", code: "123456" });

const vault = createVaultClient({ baseUrl: "http://localhost:9107", apiKey: process.env.VAULT_API_KEY });
// 3. 用 MPC 会话 token 确认 vault 交易（MPC 完成多方签名中的一方）
await vault.vault.confirmMpc({ safeId: "<safeId>", txId: "<txId>", token });
// 4. 阈值达成后执行
await vault.vault.executeTx({ safeId: "<safeId>", txId: "<txId>" });
```

> 备注：MCP 工具 `vault_confirm_tx` 仅支持普通签名确认；MPC 会话确认请走 SDK/HTTP。若需在 MCP 层暴露，属后续排期（9.6 Phase 3 hub 增强）。

## 4. MPC：注册 → 解锁 → 签名 → 合约写

```
1. mpc_send_code      { "email": "user@example.com" }
2. mpc_register       { "email": "user@example.com", "code": "123456" }        # → address
3. mpc_session_unlock { "email": "user@example.com", "code": "123456" }        # → token
4. mpc_sign_message   { "token": "<token>", "message": "Hello InfraX" }        # → signature
5. mpc_contract_write { "token": "<token>", "contractAddress": "0x...", "abi": [...],
                        "method": "approve", "args": ["0xSpender","1000000000000000000"] }
6. mpc_session_lock   { "token": "<token>" }    # 操作完成后主动吊销会话
```

## 5. Data：行情 → 因子 → ML 预测 → RAG

```
1. data_symbol_resolve { "keyword": "BTC" }                      # → BTCUSDT
2. data_ticker         { "symbol": "BTCUSDT" }
3. data_factors        { "symbol": "BTCUSDT" }
4. ml_predictions      { "symbol": "BTC", "date": "2026-08-13" }
5. rag_query           { "query": "InfraX DC 事件分类规则", "mode": "mix" }
```

## 6. DC：事件查询 → 订阅（免费/付费）

```
# 免费计划（立即激活）
1. dc_subscription_subscribe { "planId": "data_free", "walletAddress": "0xUser" }   # → dcApiKey
2. dc_events { "chain": "ethereum", "event_type": "Swap", "limit": "100" }

# 付费计划（x402 确认）
1. dc_subscription_subscribe { "planId": "data_pro", "rail": "x402", "walletAddress": "0xUser" }
2. dc_subscription_verify    { "txHash": "0x...", "walletAddress": "0xUser" }        # activated: true
3. dc_subscription_usage     { "walletAddress": "0xUser" }
```

## 7. Session Key：授权 → 执行 → 吊销

### 7A. 标准签名模式

```
1. sk_nonce { "user": "0xOwner" }                                   # → nonce（一次性）
2. 用户 EIP-712 签名授权（含 nonce/权限/限额）→ signature
3. sk_create_session { "userAddress": "0xOwner", "nonce": "<nonce>", "signature": "0x...",
                       "chain": "base", "contracts": "0xSwapRouter",
                       "functions": "0x095ea7b3", "validDays": "30",
                       "maxPerTx": "1000", "maxTotal": "10000" }    # → sessionId
4. sk_execute { "sessionId": "<sessionId>", "chain": "base", "to": "0xSwapRouter",
                "data": "0x..." }                                   # 白名单内无需再签名
5. sk_revoke_session { "sessionId": "<sessionId>" }                 # 用毕即吊销
```

### 7B. 零签名模式（无人值守 Agent）

适用场景：AI 代理需要**全程无用户签名交互**地执行链上操作（自动策略、批量空投、定时结算）。

| 步骤 | 动作 | 签名需求 |
|:---:|------|:---:|
| 1 | 用户一次性预授权（后台完成 EIP-712，或由 MPC/vault 托管代签创建 session） | 仅 1 次 |
| 2 | Agent 运行期间直接调 `sk_execute` 执行白名单合约操作 | 无 |
| 3 | 限额耗尽 / 到期 / 泄露 → 自动或手动 `sk_revoke_session` | 无 |

安全边界（即使零签名也必须生效）：

- 合约白名单 `contracts` 逐字匹配；
- 函数选择器白名单 `functions`（为空 = 放行全部，禁止用于生产）；
- 单笔 `maxPerTx`（默认 1000 USDC）与累计 `maxTotal`（默认 10000 USDC）双限额；
- 会话可随时吊销；状态可用 `sk_list_sessions` / `sk_get_session` 审计。

```
# Agent 侧每日流程
sk_execute { "sessionId": "<sessionId>", "chain": "base", "to": "0xLimitOrder", "data": "0x..." }
sk_list_sessions { "user": "0xOwner", "status": "active" }
```

## 通用注意事项

- **金额单位**：`valueWei`/`depositWei`/`amountWei` 一律 wei 字符串；`amount`（wallet_send / mpc_send_transaction）为原生币小数。
- **幂等**：`payment_verify` / `dc_subscription_verify` 同一 txHash 只入账一次，可安全重试。
- **鉴权分层**：MCP 入站 `INFRAX_MCP_API_KEY`；引擎侧业务 key 各自独立；DC 订阅面用 `x-wallet-address`。
- **会话安全**：MPC session token 短期有效，敏感操作后 `mpc_session_lock`；session-key 用毕 `sk_revoke_session`。
