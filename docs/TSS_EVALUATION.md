# E-4①（=E-2e）真 TSS 分片签名技术评估与排期

> 编制：2026-08-09 | 状态：✅ 评估完成（选型结论已出，排期见 §5）
> 关联：`docs/infrax_tasklist.md` E-4① / E-2e；`projects/mpc/server.ts`（E-2a 分片实现）
> 目标：MPC 托管钱包签名全程**无完整私钥重建**，任一片泄露无法签名；签名输出为标准 ECDSA，可被 ethers 验证。

---

## 1. 现状：SSS 拆分存储 ≠ 真 TSS

当前 E-2a 实现（`projects/mpc/server.ts` L99-123）是 **Shamir 2-of-2 秘密共享（SSS）拆分存储**：

- 注册：`new ethers.Wallet(随机私钥)` → `sssSplit` 拆成片1（`f(1)`）/片2（`f(2)`），分别 AES 加密存储（片1 服务端 secret、片2 RecoveryKey 上下文）。
- 签名：`getSession()`（L295-311）`decryptShard(片1)` + `decryptRecoveryShard(片2)` → **`sssMerge(shard1, shard2)` 重建完整私钥** → `new ethers.Wallet(privateKey)` → `signer.signMessage(...)`。

**安全边界**：任一片泄露无法签名（拆分存储达成）；但每次解锁/签名瞬间**完整私钥在进程内存中重建**（`sssMerge` 输出即 64 位 hex 私钥）——若服务端进程内存被 dump，私钥即泄露。这是「拆分存储」而非「真 TSS 分布式签名」。

**真 TSS 的定义**：密钥以分片形式分布在各参与方，签名时各方**各自本地计算**，经协议交换中间值（如 CGGMP21 的 Paillier 密文 + ZK 证明），最终一方组装出标准 ECDSA 签名；**完整私钥在任何时刻、任何一方都不出现**。任一片泄露（含签名方内存被读）都无法恢复私钥或伪造签名。

---

## 2. 候选方案横向对比

| 库 | 协议 | 语言/集成 | 阈值模型 | 维护状态 | 现有密钥导入 | 备注 |
|---|---|---|---|---|---|---|
| **cggmp21 / cggmp24**（LFDT-Lockness） | CGGMP21（n-of-n）/ CGGMP24（t-of-n） | Rust + **WASM/no_std**（Node 可嵌） | t-of-n | ✅ 活跃（2026-07 仍有提交）；TUM CBDC 论文点名「production code, not PoC」 | ✅ **Key Import（SPOF code）** | UC 安全、可识别中止、presigning（离线 3 轮 + 在线 1 轮）、**HD 钱包支持**、secp256k1/secp256r1 |
| **zenroom**（dyne.org） | 2-party ECDSA（DYAD/REBORNE） | Lua VM + **WASM**（zenroom.js） | **仅 2-party**（无 t-of-n） | ✅ v4 稳定线持续维护（2026-07 提交） | ❌ | 零依赖 WASM、Zencode DSL 防错；但协议只支持 2 方、无 HD/导入，性能一般；与现有「服务端生成私钥再拆分」模型需改造 |
| **tss-lib**（Binance, Go）+ **tsslib**（Rust 移植） | GG18/GG20（Paillier+MtA）/ tsslib 另含 **DKLs23** | Go 侧车 / Rust | t-of-n | GG 系成熟但为旧协议 | ⚠️ GG18 有导入（1-of-1） | GG18/GG20 历史上有 **TSSHOCK / Alpha-Rays** 实现级缺陷；需新增 Go 部署组件 |
| **multi-party-ecdsa**（ZenGo-X） | GG20 | Rust + wasm（thresh-sig-js） | t-of-n | ❌ 停更（2023-08 后） | ❌ | 曾经的行业参考实现，现已不活跃 |
| **kryptology**（Coinbase, Go） | Threshold ECDSA + DKG | Go | t-of-n | ⚠️ 更新放缓 | — | 综合密码库，公司战略重点转移 |

> 说明：tasklist 中原「zenroom/mpc-sdk」中的 `mpc-sdk` 在本语境指 TSS 类 SDK（ZenGo multi-party-ecdsa / thresh-sig-js 即此类，已停更）；经核查，**生产级、活跃维护、支持密钥导入**的唯一候选是 **cggmp21/cggmp24**。

---

## 3. 选型结论：cggmp21（Rust，走 WASM/独立签名服务）

**推荐 cggmp21（LFDT-Lockness）**，理由：

1. **协议与实现均为生产级**：CGGMP21 为 UC 安全、可识别中止（协议层面识别恶意方）；TUM/G+D CBDC 研究论文（arXiv:2506.23294）在候选库横向评估中明确「cggmp21 是 production code，而非 PoC」，并用于实际 CBDC 方案。
2. **支持现有密钥导入（Key Import / SPOF code）**：E-2 已存在的钱包（完整私钥已知）可一次性转换为 TSS 分片，**无需重建钱包、地址不变**——迁移成本最低的关键特性。
3. **阈值模型灵活**：CGGMP21 n-of-n / CGGMP24 t-of-n；我们的场景 **2-of-2**（服务端片1 + 恢复片2），未来可加片3（独立签名机/HSM）变 2-of-3。
4. **presigning**：可离线预计算签名轮，在线仅 1 轮，满足 Agent 高频交易延迟要求。
5. **HD 钱包支持**：与 E-4④ 1:N 子钱包体系可对齐（按需）。
6. **集成路径明确**：WASM 特性（README 已含 wasm/no_std 文档）或封装 napi-rs / 独立 Rust 签名微服务，均可从 Node/TS 服务端调用。

---

## 4. 目标架构（2-of-2，兼容邮箱恢复模型）

```
                 mpc server（Node/TS，持有片1）
   sign-message / sign-typed-data / send-transaction / contract-write
                              │  签名请求 + 中间消息（CGGMP21 协议）
                              ▼
               TSS 签名进程（Rust wasm/napi 或独立侧车，持有片2）
                 │  片2 = 现有 RecoveryKey 派生（email+secret 上下文）
                 ▼
           标准 ECDSA 签名（ethers 可验证，链上行为不变）
```

- **片1**：沿用现有 `encrypted_shard`（服务端 `MPC_ENCRYPTION_SECRET` AES 存储）。
- **片2**：沿用现有 `recovery_shard`（RecoveryKey，`email+secret+':mpc-recovery'` 上下文派生），恢复/签名时经邮箱验证码二次解密后进入 TSS 进程作为第二参与方。
- **协议交换**：同一主机内（wasm 单进程两角色）或跨进程（独立签名服务）完成 CGGMP21 2-of-2 轮次；完整私钥永不重建、永不落内存明文。
- **API 兼容**：现有 `sign-message/sign-typed-data/send-transaction/contract-write` 端点签名逻辑替换为「TSS 签名器」，响应结构不变；`getSession()` 不再 `sssMerge` 重建 `ethers.Wallet`，改持分片句柄。
- **诚实安全边界（对齐 MQ-10 补充 E 决策）**：邮箱恢复场景下片2 可由服务端派生，双片均在服务端掌控 → 真 TSS 在本场景的收益是① 杜绝「签名瞬间完整私钥内存重建」② 任一片泄露无法签名（含进程内存 dump）；**不承诺**「防服务端作恶」（如需，加片3 独立签名机/HSM，2-of-3）。
- **验收标准**：TSS 签名可被标准 ECDSA 验证；仅持片1（或仅片2）无法生成有效签名；签名路径全端点生产 E2E 通过。

---

## 5. 排期（P3，工作量中-大）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 集成验证 | cggmp21 wasm 本地 demo：2-of-2 keygen → presign → sign → 标准 verify | ✅ 完成：本地 demo 签名可被 ethers `verifyMessage` 验证 |
| M2 存量迁移 | 用 Key Import（SPOF code）把 E-2 现有钱包完整私钥转为 TSS 分片，地址不变 | ✅ 完成：`mpc_signer /v1/import` 按现有私钥 trusted_dealer 分片，地址不变 |
| M3 服务端替换 | mpc server 引入 TSS 签名器，替换 sign-message/sign-typed-data/send-transaction/contract-write 四端点签名路径；`getSession` 改持分片 | ✅ 完成：本地四端点 E2E 13/13 通过（签名可被 ethers 复核，链上广播 + 余额变动确认）；见 §6 实现记录 |
| M4 生产部署 | 分片进程/侧车部署（systemd）+ 现有 mpc-sdk/合约调用方零改动回归 | 🟡 部署产物就绪：`deploy/systemd/infrax-mpc-tss-signer.service` / `infrax-mpc-signer.service` + `infrax-mpc.service` 已加 `MPC_SIGNER_URL`/`TSS_SIGNER_URL`/`CHAIN_RPC_*` env 与依赖；🔲 生产机安装 + mpc-sdk 生产回归（SDK E2E 用户约束仅生产执行） |

---

## 6. M3 实现记录（2026-08-09）

**架构落地（跨进程 2-of-2）**：Node `mpc server` 持片1，Rust `mpc_signer`（party0，9201）与 `tss_signer`（party1，9200，持片2）同步交替完成 CGGMP24 presign+sign，最终本地 combine 出 64B `r||s`。

- **身份摘要（core_api 模式）**：`CoreWrapper<IdentityCore>` 将 Node/ethers 已算好的 32B 摘要（EIP-191 hashMessage / EIP-712 TypedDataEncoder.hash / `Transaction.from(tx).unsignedHash`）作为 z，免二次哈希。
- **存量导入**：`mpc_signer /v1/import {private_key}` → `builder::<Secp256k1,_>(2).set_threshold(Some(2)).set_shared_secret_key(...)` 按现有私钥分片（trusted_dealer）；素数生成 ≈2.5min（`set_pregenerated_primes` 可加速）。
- **分片契约**：注册/恢复均把片1 存 `encrypted_shard`、片2 存 `recovery_shard`（JSON 分片，以 `{` 开头与遗留 64-hex Shamir 分片区分）；`server.ts` 由 `shard1Str.trim().startsWith('{')` 走 TSS 路径，遗留路径保留 `sssSplit/sssMerge` 向后兼容。
- **签名端点**：`sign-message` Node 侧 `hashMessage`、`sign-typed-data` Node 侧 `TypedDataEncoder.hash` → `tssSign` → `ethersSignatureFromRs`（v 逐试 27/28 恢复地址匹配）；`send-transaction`/`contract-write` Node 侧组装 unsigned tx + calldata → `broadcastTxn` → `GatewayProvider` 广播。
- **网关收敛（DC-3）**：所有链上访问经 chain-rpc 网关；广播端点契约 `{rawTransaction, wait}`，读端点 `{method, params}`；读 key 不可广播。
- **E2E 修过的问题**：`/v1/init` msg_hash `0x` 前缀剥离；tss_signer 重启丢片2（unlock 幂等重注册）；gateway 广播 body contract mismatch；chain-rpc rpcPool 多端点 round-robin 混入真实 sepolia（本地 E2E 用 `INFRAX_RPC_POOL` 覆盖为仅本地 anvil）；contract-write `staticCall` 缺 `from`（默认零地址模拟余额为 0 回退）。
- **验收证据**：`/tmp/m3test/e2e-mpc.mjs` 四端点 13/13 断言通过（sign-message / sign-typed-data 经 `ethers.recoverAddress` 复核；send-transaction 链上 receipt status=1 且接收方 +0.01 ETH；contract-write ERC20 transfer 链上余额 -1 TST）。

**前置依赖**：无硬依赖；建议在 E-1（aa-sdk 三缺口）与 E-4④ 稳定后启动（本轮 E-4④ 已先行完成）。
