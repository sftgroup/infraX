export * from './types/index.js';
export * from './utils/index.js';
export * from './config/index.js';
export * from './interfaces/index.js';

// ERC-4337 智能账户能力（aa-sdk 并入，v0.1.0 → v0.2.0）：
// 命名空间聚合避免与 core 现有导出（Chain/ChainId/Signer 等）命名冲突。
// 用法：import { Aa } from '@0xinfrax/session-key-core';
//   Aa.UserOperationV7 / Aa.buildUserOp / Aa.getUserOperationHash /
//   Aa.BundlerClient / Aa.PaymasterClient / Aa.KernelAccount / Aa.MpcSigner ...
import * as Aa from './aa/index.js';
export { Aa };
