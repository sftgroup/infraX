# AA 新链部署规范（B-3，2026-08-11）

> 依据：§9.11 PocketX 交接（vendor/aa-contracts，commit 47568ca / e95564e）。基准脚本 `vendor/aa-contracts/scripts/deploy-oxachain.mjs`（仅存在于生产机 `/home/ubuntu/infraX-1/vendor/`，本地仓库未收录），已可复现 OxaChain（chainId 19505）部署（dry-run 3/3，EntryPoint runtime 17,690 B 与链上一致）。

## 适用范围

BSC（56）/ ETH（1）/ BASE（8453）等 EVM 链的 ERC-4337 合约栈部署。产物：EntryPoint v0.7.0 / Kernel v3.1 / KernelFactory / ECDSAValidator / 其余辅助合约。

## 前置条件（每链）

| 项 | 说明 |
|---|---|
| RPC | 目标链稳定 RPC（部署用，随后统一收敛 chain-rpc 网关读路径） |
| 部署私钥 | 仅部署签名用，不入 git；资金仅覆盖部署 gas |
| chainId | BSC 56 / ETH 1 / BASE 8453（写入 aa-sdk `CHAIN_ALIASES`） |
| Safe 合约 | 目标链 Safe v1.4.1 Singleton + ProxyFactory（vault 多签部署依赖，若链上无则一并部署） |

## 部署流程（以 vendor 脚本为基准，参数化）

1. **脚本参数化**：在 `vendor/aa-contracts/scripts/` 复制 `deploy-oxachain.mjs` 为 `deploy-<chain>.mjs`，替换：
   - RPC URL / chainId / 链名别名
   - EntryPoint / Kernel / Factory 构造参数（`deploy-oxachain.mjs` 的"尾部替换构造参数法"模式，Kernel/Factory 均需与 OxaChain 部署一致——同源码同参数保证 bytecode 可复现）
2. **dry-run 3/3**：`node deploy-<chain>.mjs --dry-run` 三次，确认 bytecode runtime 与 OxaChain 一致、地址可预测（CREATE2 或确定性部署）。
3. **正式部署**：执行脚本，记录部署地址（EntryPoint / KernelImplementation / KernelFactory / ECDSAValidator）到链上验证 + 写入 aa-sdk 链配置。
4. **验证清单**：
   - EntryPoint `getSenderAddress` 可用；`depositTo` / `balanceOf` 正常
   - Kernel v3.1 可创建账户（E2E 走 `createKernelAccount`）
   - ECDSAValidator 校验签名通过
   - Bundler（Alto 实例）指向新链 RPC + EntryPoint，E2E `aa-session-e2e.ts` 全绿（若 bundler 为 v0.6 协议则不匹配 v0.7 EntryPoint，参照 OxaChain 用 `handleOps` 直连交易绕过——见项目记忆 E-3 根因）
5. **aa-relay 接入**：`AA_<CHAIN>_RPC` / `AA_<CHAIN>_ENTRYPOINT` / `AA_<CHAIN>_KERNEL_*` 环境变量注入 aa-relay unit，重启后 `GET /v1/chains` 可见。

## 注意

- **禁止**在生产裸跑未 dry-run 的部署；部署私钥隔离（仅部署用）。
- 部署完成后将脚本与地址回填到 infraX 仓库（`vendor/aa-contracts/scripts/deploy-<chain>.mjs` + docs），保持可复现。
- BSC/ETH/BASE 实际执行需在生产机 vendor 目录操作（本地仓库无 vendor），执行人：infraX 链上维护角色。

## 状态

- BSC/ETH/BASE：🔲 待部署（生产机执行）
