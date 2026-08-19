import {
  encodeFunctionData,
  isHex,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { ChainAAConfig, SessionPermission, SessionPolicy, TokenLimit } from './types.js';
import { ConfigError } from './errors.js';
import { encodeExecute, encodeExecuteBatch } from './userop.js';

// ============================================================================
// Session validator 模块的链上 enable/disable 编码（ERC-7579 validator 模块管理）
// 零硬编码：session validator 模块地址来自 chainConfig.sessionModule
//           （env AA_{CHAIN}_SESSION_MODULE），缺失抛 ConfigError。
// ============================================================================

/** ERC-7579 MODULE_TYPE_VALIDATOR */
export const MODULE_TYPE_VALIDATOR = 1n;

/** 任意地址转账哨兵（P0.12 §7.6）：enableSession calls 中 target=哨兵地址表示原生币任意转账授权 */
export const ANY_TRANSFER_SENTINEL = '0x0000000000000000000000000000000000000001' as Address;

/**
 * 单条 CallPermission（对齐链上 KernelSessionWithTokenLimitModule.CallPermission 结构）：
 * 由 enableSession 的 calls 数组元素直接编码，不再预编码为 bytes。
 */
export interface CallPermission {
  target: Address;
  selectors: Hex[];
  valueLimit: bigint;
  countLimit: bigint;
}

/** CallPermission tuple 定义（SessionModuleAbi 与 EnhancedSessionModuleAbi 共用） */
const CallPermissionTuple = [
  { name: 'target', type: 'address' },
  { name: 'selectors', type: 'bytes4[]' },
  { name: 'valueLimit', type: 'uint256' },
  { name: 'countLimit', type: 'uint256' },
] as const;

/** 由 SessionPermission 展开为链上 CallPermission（§7.3：selectors 空 = 全部方法） */
function toCallPermission(target: Address, p: SessionPermission): CallPermission {
  return {
    target,
    selectors: [...(p.selectors ?? [])],
    valueLimit: p.valueLimit ?? 0n,
    countLimit: BigInt(p.countLimit ?? 0),
  };
}

/**
 * Kernel v3 session validator 模块 ABI（对齐 ZeroDev KernelSessionModule / 链上 P0.12 模块
 * enableSession(bytes32,address,uint48,uint48,CallPermission[]) 真实签名，selector 0x7d993787）。
 */
const SessionModuleAbi = [
  {
    type: 'function',
    name: 'enableSession',
    inputs: [
      { name: 'sessionId', type: 'bytes32' },
      { name: 'sessionKey', type: 'address' },
      { name: 'validUntil', type: 'uint48' },
      { name: 'validAfter', type: 'uint48' },
      {
        name: 'calls',
        type: 'tuple[]',
        components: CallPermissionTuple,
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'disableSession',
    inputs: [{ name: 'sessionId', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/** ERC-7579 标准模块安装/卸载接口 */
const ERC7579ModuleManagerAbi = [
  {
    type: 'function',
    name: 'installModule',
    inputs: [
      { name: 'moduleTypeId', type: 'uint256' },
      { name: 'module', type: 'address' },
      { name: 'initData', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'uninstallModule',
    inputs: [
      { name: 'moduleTypeId', type: 'uint256' },
      { name: 'module', type: 'address' },
      { name: 'deInitData', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/**
 * session 模块数据序列化器：把策略/撤销请求编码为模块 enable/disable 数据。
 * 接口化以便部署阶段按真实模块契约校准（默认实现见 KernelV3SessionDataBuilder）。
 */
export interface SessionModuleDataBuilder {
  enableData(policy: SessionPolicy): Hex;
  disableData(sessionId: string): Hex;
}

/** bytes32 归一化（已是 0x+64 hex 直接用，否则左对齐补零） */
export function toBytes32(id: string): Hex {
  return (isHex(id) && id.length === 66 ? id : toHex(id, { size: 32 })) as Hex;
}

/**
 * 增强 session 模块 ABI（P0.12 §7.5）：KernelSessionWithTokenLimitModule 的
 * enableSession 增加 tokenLimits 参数（per-token 单笔/日限额）。
 * calls 为 CallPermission[] tuple（与链上真实签名一致，selector 0xc620957b）。
 */
const EnhancedSessionModuleAbi = [
  {
    type: 'function',
    name: 'enableSession',
    inputs: [
      { name: 'sessionId', type: 'bytes32' },
      { name: 'sessionKey', type: 'address' },
      { name: 'validUntil', type: 'uint48' },
      { name: 'validAfter', type: 'uint48' },
      {
        name: 'tokenLimits',
        type: 'tuple[]',
        components: [
          { name: 'token', type: 'address' },
          { name: 'maxPerTx', type: 'uint256' },
          { name: 'maxDaily', type: 'uint256' },
        ],
      },
      {
        name: 'calls',
        type: 'tuple[]',
        components: CallPermissionTuple,
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/**
 * 默认序列化器（P0.12 扩展）：permission.targets 逐一展开为 call 条目；
 * 含 tokenLimits / allowAnyTransfer 时切换增强模块 6 参数编码（§7.5-§7.6）：
 *  - tokenLimits = 各 permission.tokenLimits + allowAnyTransfer 哨兵条目（token=ANY_TRANSFER_SENTINEL）
 *  - calls 追加哨兵 target 条目（valueLimit = maxPerTx）
 */
export const KernelV3SessionDataBuilder: SessionModuleDataBuilder = {
  enableData(policy: SessionPolicy): Hex {
    const hasTokenLimits = policy.permissions.some((p) => (p.tokenLimits?.length ?? 0) > 0);
    const hasAnyTransfer = policy.permissions.some((p) => p.allowAnyTransfer !== undefined);
    if (!hasTokenLimits && !hasAnyTransfer) {
      // 原 5 参数编码（兼容 ZeroDev KernelSessionModule / 链上 5 参数重载，selector 0x7d993787）
      const calls = policy.permissions.flatMap((p) => p.targets.map((t) => toCallPermission(t, p)));
      return encodeFunctionData({
        abi: SessionModuleAbi,
        functionName: 'enableSession',
        args: [toBytes32(policy.sessionId), policy.signer, Number(policy.validUntil), Number(policy.validAfter), calls],
      });
    }
    // 增强 6 参数编码（KernelSessionWithTokenLimitModule，selector 0xc620957b）
    const tokenLimits: TokenLimit[] = policy.permissions.flatMap((p) => {
      const own = p.tokenLimits ?? [];
      const sentinel = p.allowAnyTransfer
        ? [{ token: ANY_TRANSFER_SENTINEL, maxPerTx: p.allowAnyTransfer.maxPerTx, maxDaily: p.allowAnyTransfer.maxDaily }]
        : [];
      return [...own, ...sentinel];
    });
    const calls = policy.permissions.flatMap((p) => {
      const base = p.targets.map((t) => toCallPermission(t, p));
      const sentinelCall = p.allowAnyTransfer
        ? [{
            target: ANY_TRANSFER_SENTINEL,
            selectors: [],
            valueLimit: p.allowAnyTransfer.maxPerTx,
            countLimit: 0n,
          } satisfies CallPermission]
        : [];
      return [...base, ...sentinelCall];
    });
    return encodeFunctionData({
      abi: EnhancedSessionModuleAbi,
      functionName: 'enableSession',
      args: [
        toBytes32(policy.sessionId),
        policy.signer,
        Number(policy.validUntil),
        Number(policy.validAfter),
        tokenLimits, // tuple[] 直接传对象数组，由 viem 编码
        calls,
      ],
    });
  },
  disableData(sessionId: string): Hex {
    return encodeFunctionData({
      abi: SessionModuleAbi,
      functionName: 'disableSession',
      args: [toBytes32(sessionId)],
    });
  },
};

/** 解析 session validator 模块地址（缺省抛 ConfigError） */
export function resolveSessionModule(chainConfig: ChainAAConfig): Address {
  if (!chainConfig.sessionModule) {
    throw new ConfigError(
      `[aa-sdk] missing sessionModule for chain ${chainConfig.chainId} (set AA_${chainConfig.chainId}_SESSION_MODULE)`,
    );
  }
  return chainConfig.sessionModule;
}

export interface EnableSessionCallParams {
  accountAddress: Address;
  policy: SessionPolicy;
  chainConfig: ChainAAConfig;
  dataBuilder?: SessionModuleDataBuilder;
}

/**
 * 编码安装 session validator 的 UserOp callData（Kernel execute → ERC-7579
 * installModule(VALIDATOR, sessionModule, enableData)）。调用方据此组装 UserOp 并签名。
 */
export function encodeEnableSessionCall(params: EnableSessionCallParams): Hex {
  const module = resolveSessionModule(params.chainConfig);
  const builder = params.dataBuilder ?? KernelV3SessionDataBuilder;
  const installCalldata = encodeFunctionData({
    abi: ERC7579ModuleManagerAbi,
    functionName: 'installModule',
    args: [MODULE_TYPE_VALIDATOR, module, builder.enableData(params.policy)],
  });
  return encodeExecute(params.accountAddress, 0n, installCalldata);
}

export interface DisableSessionCallParams {
  accountAddress: Address;
  sessionId: string;
  chainConfig: ChainAAConfig;
  dataBuilder?: SessionModuleDataBuilder;
}

/** 编码卸载 session validator 的 UserOp callData（uninstallModule → disableSession） */
export function encodeDisableSessionCall(params: DisableSessionCallParams): Hex {
  const module = resolveSessionModule(params.chainConfig);
  const builder = params.dataBuilder ?? KernelV3SessionDataBuilder;
  const uninstallCalldata = encodeFunctionData({
    abi: ERC7579ModuleManagerAbi,
    functionName: 'uninstallModule',
    args: [MODULE_TYPE_VALIDATOR, module, builder.disableData(params.sessionId)],
  });
  return encodeExecute(params.accountAddress, 0n, uninstallCalldata);
}

// ============================================================================
// AA-1/AA-2：disable 上链闭环（批量撤销）
// 单纯 uninstallModule 后紧接着 enable 会因 Kernel ValidationManager 的
// validationConfig[vId].nonce 残留而 revert InvalidNonce（AA23，0x756688fe）。
// 修复：批量 execute [uninstallModule, invalidateNonce(cur+1)] 推进账户 nonce，
// 后续 enable 读到推进后的 currentNonce，不再触发 InvalidNonce。
// （实证见 docs/aa-relay-session-rollover-fix-infrax.md §2.4）
// ============================================================================

/** Kernel invalidateNonce(uint32) ABI（KernelStorage，推进 currentNonce/validNonceFrom） */
const KernelInvalidateNonceAbi = parseAbi(['function invalidateNonce(uint32 newNonce)']);

export interface EncodeDisableSessionBatchParams {
  accountAddress: Address;
  sessionId: string;
  chainConfig: ChainAAConfig;
  /** 账户 currentNonce()（uint32）；invalidate 目标 = currentNonce + 1 */
  currentNonce: number;
  dataBuilder?: SessionModuleDataBuilder;
}

/**
 * 编码"撤销 + 推进 nonce"批量 execute callData（Kernel v3 无 executeBatch，
 * 批量走 execute(BATCH, abi.encode(Execution[]))，AA-2 encodeExecuteBatch）：
 *   execute(BATCH, [uninstallModule(VALIDATOR, module, disableData),
 *                   invalidateNonce(currentNonce + 1)])
 */
export function encodeDisableSessionBatch(params: EncodeDisableSessionBatchParams): Hex {
  const module = resolveSessionModule(params.chainConfig);
  const builder = params.dataBuilder ?? KernelV3SessionDataBuilder;
  const uninstallCalldata = encodeFunctionData({
    abi: ERC7579ModuleManagerAbi,
    functionName: 'uninstallModule',
    args: [MODULE_TYPE_VALIDATOR, module, builder.disableData(params.sessionId)],
  });
  const invalidateCalldata = encodeFunctionData({
    abi: KernelInvalidateNonceAbi,
    functionName: 'invalidateNonce',
    args: [params.currentNonce + 1],
  });
  return encodeExecuteBatch([
    { target: params.accountAddress, value: 0n, data: uninstallCalldata },
    { target: params.accountAddress, value: 0n, data: invalidateCalldata },
  ]);
}

export interface EncodeReplaceSessionBatchParams {
  accountAddress: Address;
  /** 当前链上绑定的旧 sessionId（uninstall 目标） */
  oldSessionId: string;
  /** 新 session 策略（install + enableSession 目标） */
  policy: SessionPolicy;
  chainConfig: ChainAAConfig;
  /** 账户 currentNonce()（uint32）；invalidate 目标 = currentNonce + 1 */
  currentNonce: number;
  dataBuilder?: SessionModuleDataBuilder;
}

/**
 * AA-7：编码"单笔轮换"批量 execute callData —— 一次 UserOp 完成 撤销旧 session +
 * 推进 nonce + 安装新 session（C1 幂等覆盖的 SDK 层等价实现，不改合约）：
 *   execute(BATCH, [uninstallModule(VALIDATOR, module, disableData(old)),
 *                   invalidateNonce(currentNonce + 1),
 *                   installModule(VALIDATOR, module, enableData(new))])
 * owner 仅签一次；uninstall+install 同模块地址（先卸清 config，再装新 config）。
 */
export function encodeReplaceSessionBatch(params: EncodeReplaceSessionBatchParams): Hex {
  const module = resolveSessionModule(params.chainConfig);
  const builder = params.dataBuilder ?? KernelV3SessionDataBuilder;
  const uninstallCalldata = encodeFunctionData({
    abi: ERC7579ModuleManagerAbi,
    functionName: 'uninstallModule',
    args: [MODULE_TYPE_VALIDATOR, module, builder.disableData(params.oldSessionId)],
  });
  const invalidateCalldata = encodeFunctionData({
    abi: KernelInvalidateNonceAbi,
    functionName: 'invalidateNonce',
    args: [params.currentNonce + 1],
  });
  const installCalldata = encodeFunctionData({
    abi: ERC7579ModuleManagerAbi,
    functionName: 'installModule',
    args: [MODULE_TYPE_VALIDATOR, module, builder.enableData(params.policy)],
  });
  return encodeExecuteBatch([
    { target: params.accountAddress, value: 0n, data: uninstallCalldata },
    { target: params.accountAddress, value: 0n, data: invalidateCalldata },
    { target: params.accountAddress, value: 0n, data: installCalldata },
  ]);
}

// ============================================================================
// AA-3：链上探测账户是否已绑定 session validator（ERC-7579 视图）
// 正确判定 = isModuleInstalled(1 VALIDATOR, sessionModule, 0x) 针对 session 模块
// 调用；勿用 storage slot 判残留（存的是常驻 ECDSA root validator 绑定，恒非零，
// 卸载 session 后不变 → 误报，见 docs/aa-relay-session-rollover-fix-infrax.md §2.1）。
// ============================================================================

export interface IsSessionModuleInstalledParams {
  /** viem PublicClient（链上读，aa-sdk createAAClient 构造） */
  client: PublicClient;
  chainConfig: ChainAAConfig;
  account: Address;
}

/**
 * 探测账户是否已绑定 session validator（ERC-7579 isModuleInstalled 视图）。
 * 账户未部署（无 code）→ 返回 false（未绑定）；链上读失败抛错由调用方决定。
 */
export async function isSessionModuleInstalled(p: IsSessionModuleInstalledParams): Promise<boolean> {
  const module = resolveSessionModule(p.chainConfig);
  const code = await p.client.getCode({ address: p.account });
  if (code === undefined || code === '0x') return false;
  const installed = (await p.client.readContract({
    address: p.account,
    abi: parseAbi([
      'function isModuleInstalled(uint256 moduleTypeId, address module, bytes extraData) view returns (bool)',
    ]),
    functionName: 'isModuleInstalled',
    args: [MODULE_TYPE_VALIDATOR, module, '0x'],
  })) as boolean;
  return installed;
}
