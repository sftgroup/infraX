// ============================================================================
// aa-sdk barrel export（单一事实源：依赖 @0xinfrax/aa-sdk 包，消除内嵌手工副本）
// 2026-08-20 重构：原内嵌 aa/ 目录（session/userop/smart-account/bundler/...）
// 是 aa-sdk 的手工拷贝，已漂移一次（AA-1/AA-2/AA-7 编码修复需手动同步）。
// 现统一改为 re-export，AA 能力以 aa-sdk 为唯一事实源，杜绝双代码库漂移。
// 用法：import { Aa } from '@0xinfrax/session-key-core';
//   Aa.UserOperationV7 / Aa.buildUserOp / Aa.encodeDisableSessionBatch / ...
// ============================================================================
export * from '@0xinfrax/aa-sdk';
