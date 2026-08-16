import {
  concat,
  concatHex,
  encodeFunctionData,
  keccak256,
  pad,
  parseAbi,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { ChainAAConfig, SessionPolicy, Signer, UserOperationV7 } from './types.js';
import { encodeExecute, buildUserOp, getUserOpHash } from './userop.js';
import { enableNonceKey, validatorNonceKey } from './nonce.js';
import {
  KernelV3SessionDataBuilder,
  resolveSessionModule,
  toBytes32,
  type SessionModuleDataBuilder,
} from './session-module.js';

// ============================================================================
// Kernel v3 ENABLE-mode enable（nonce 路由 + EIP-712 digest）+ agent 调用 UserOp
// 与 encodeEnableSessionCall（DEFAULT-mode installModule）互补：ENABLE-mode 一次
// UserOp 完成"模块安装 + 用户授权"——op 的 callData 是任意良性执行，enable 数据
// 经 EIP-712 digest 由 owner 签名后装在 signature 里，模块安装在验证阶段完成。
// 已链上验证：direct handleOps 交易成功安装 session module（scripts/dbg-enable-revert.ts）。
// ============================================================================

/** ENABLE_TYPEHASH（Kernel v3 0.3.0-beta，types/Constants.sol） */
export const ENABLE_TYPEHASH =
  '0xb17ab1224aca0d4255ef8161acaf2ac121b8faa32a4b2258c912cc5f8308c505' as Hex;

/** EIP-712 domain 固定值（对齐链上 Kernel v3 0.3.0-beta 部署） */
export const KERNEL_EIP712_NAME = 'Kernel';
export const KERNEL_EIP712_VERSION = '0.3.0-beta';

/** address(1) = 不启用 hook（Kernel v3 ValidationConfig 约定） */
export const HOOK_NONE = '0x0000000000000000000000000000000000000001' as Address;

/** 无 hook 时的 hookData 占位（'0xff'，与链上验证路径一致；任意非空字节即可） */
export const NO_HOOK_DATA = '0xff' as Hex;

/** ValidationId 前缀：VALIDATOR 类型（0x01，对齐 smart-account VALIDATOR_TYPE_VALIDATOR） */
export const VALIDATOR_TYPE = '0x01' as Hex;

const EIP712_DOMAIN_TYPEHASH = keccak256(
  stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);

function enableDomainSeparator(account: Address, chainId: number): Hex {
  return keccak256(
    concat([
      EIP712_DOMAIN_TYPEHASH,
      keccak256(stringToHex(KERNEL_EIP712_NAME)),
      keccak256(stringToHex(KERNEL_EIP712_VERSION)),
      toHex(chainId, { size: 32 }),
      pad(account, { size: 32 }),
    ]),
  );
}

export interface EnableDigestParams {
  /** 账户地址（EIP-712 verifyingContract） */
  account: Address;
  chainId: number;
  /** vId（bytes21）= 0x01 ‖ validator 地址 */
  validationId: Hex;
  /** 账户 currentNonce()（uint32） */
  currentNonce: number;
  /** hook 地址（缺省 address(1) = 无 hook） */
  hook?: Address;
  /** enableData（模块 onInstall 数据，如 enableSession 编码） */
  validatorData: Hex;
  /** hook 安装数据（无 hook 时任意，缺省 '0xff' 与链上验证路径一致） */
  hookData?: Hex;
  /** 允许的 execute selector（Kernel.execute = 0x1cff79cd） */
  selectorData: Hex;
}

/**
 * Kernel v3 ENABLE digest（EIP-712）：
 *   keccak256(0x1901 ‖ domainSeparator(account, chainId) ‖ structHash)
 *   structHash = keccak256(ENABLE_TYPEHASH, vId(bytes21 右补零), currentNonce(uint32→uint256),
 *                          hook, keccak(validatorData), keccak(hookData), keccak(selectorData))
 * owner 对该 digest 签名 = 授权安装模块 + 授权本次 enable UserOp。
 */
export function enableDigest(p: EnableDigestParams): Hex {
  const structHash = keccak256(
    concat([
      ENABLE_TYPEHASH,
      pad(p.validationId, { size: 32, dir: 'right' }),
      toHex(p.currentNonce, { size: 32 }),
      pad(p.hook ?? HOOK_NONE, { size: 32 }),
      keccak256(p.validatorData),
      keccak256(p.hookData ?? NO_HOOK_DATA),
      keccak256(p.selectorData),
    ]),
  );
  return keccak256(concat(['0x1901', enableDomainSeparator(p.account, p.chainId), structHash]));
}

export interface PackEnableSignatureParams {
  hook?: Address;
  validatorData: Hex;
  hookData?: Hex;
  executeSelector: Hex;
  /** owner 对 enable digest 的签名 */
  enableSig: Hex;
  /** userOpSig：ENABLE-mode 下 = sessionId(32B) ‖ agent 对 userOpHash 的签名 */
  userOpSig: Hex;
}

/**
 * ENABLE-mode signature 打包（ValidationManager._enableMode 的分割依据）：
 *   signature = hook(20B) ‖ abi.encode((bytes,bytes,bytes,bytes,bytes)) 的 body
 *   5 元组 = (validatorData, hookData, executeSelector, enableSig, userOpSig)
 */
export function packEnableSignature(p: PackEnableSignatureParams): Hex {
  const encoded5 = encodeFunctionData({
    abi: parseAbi(['function x(bytes,bytes,bytes,bytes,bytes)']),
    functionName: 'x',
    args: [p.validatorData, p.hookData ?? NO_HOOK_DATA, p.executeSelector, p.enableSig, p.userOpSig],
  });
  return concatHex([p.hook ?? HOOK_NONE, encoded5.slice(10) as Hex]);
}

/** ENABLE-mode enable UserOp 构造产物（未签名；签名由 signEnableUserOp 完成） */
export interface EnableSessionDraft {
  op: UserOperationV7;
  /** owner 需签名的 enable digest（EIP-712） */
  digest: Hex;
  validationId: Hex;
  hook: Address;
  validatorData: Hex;
  hookData: Hex;
  executeSelector: Hex;
  /** sessionId（bytes32） */
  sessionIdBytes: Hex;
  currentNonce: number;
}

export interface BuildEnableSessionUserOpParams {
  /** viem PublicClient（链上读 nonce） */
  client: PublicClient;
  chainConfig: ChainAAConfig;
  account: Address;
  policy: SessionPolicy;
  /** enable 期间的良性执行调用（任意；缺省空调用） */
  benignCall?: { target: Address; value?: bigint; data: Hex };
  gas?: Partial<
    Pick<
      UserOperationV7,
      'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas' | 'maxFeePerGas' | 'maxPriorityFeePerGas'
    >
  >;
  dataBuilder?: SessionModuleDataBuilder;
}

/**
 * 构造 ENABLE-mode enable UserOp（Kernel v3）：
 *   op.nonce = EntryPoint.getNonce(account, enableNonceKey(module))
 *   op.callData = execute(benignCall)
 *   digest = enableDigest(...)（owner 签名授权安装 + 授权 op）
 */
export async function buildEnableSessionUserOp(p: BuildEnableSessionUserOpParams): Promise<EnableSessionDraft> {
  const module = resolveSessionModule(p.chainConfig);
  const builder = p.dataBuilder ?? KernelV3SessionDataBuilder;
  const validatorData = builder.enableData(p.policy);
  const validationId = concatHex([VALIDATOR_TYPE, module]);
  // Kernel.execute selector（enable 后允许该 selector 的 validateUserOp 进入）
  const executeSelector = encodeExecute(HOOK_NONE, 0n, '0x').slice(0, 10) as Hex;
  const currentNonce = (await p.client.readContract({
    address: p.account,
    abi: parseAbi(['function currentNonce() view returns (uint32)']),
    functionName: 'currentNonce',
  })) as number;
  const nonce = (await p.client.readContract({
    address: p.chainConfig.entryPoint,
    abi: parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)']),
    functionName: 'getNonce',
    args: [p.account, enableNonceKey(module)],
  })) as bigint;
  const op = buildUserOp({
    sender: p.account,
    nonce,
    call: p.benignCall ?? { target: p.account, value: 0n, data: '0x' },
    gas: p.gas,
  });
  const digest = enableDigest({
    account: p.account,
    chainId: p.chainConfig.chainId,
    validationId,
    currentNonce,
    validatorData,
    hookData: NO_HOOK_DATA,
    selectorData: executeSelector,
  });
  return {
    op,
    digest,
    validationId,
    hook: HOOK_NONE,
    validatorData,
    hookData: NO_HOOK_DATA,
    executeSelector,
    sessionIdBytes: toBytes32(p.policy.sessionId),
    currentNonce,
  };
}

export interface SignEnableUserOpParams {
  chainConfig: ChainAAConfig;
  draft: EnableSessionDraft;
  /** owner（授权安装 + 授权本次 enable op） */
  ownerSigner: Signer;
  /** agent（session key，签 userOpHash；与后续 session 调用签名一致） */
  agentSigner: Signer;
}

/** 对 ENABLE-mode draft 签名：enableSig = owner(digest)，userOpSig = sessionId ‖ agent(userOpHash) */
export async function signEnableUserOp(p: SignEnableUserOpParams): Promise<UserOperationV7> {
  const userOpHash = getUserOpHash(p.draft.op, p.chainConfig.entryPoint, p.chainConfig.chainId);
  const enableSig = await p.ownerSigner.signUserOp(p.draft.digest);
  const agentSig = await p.agentSigner.signUserOp(userOpHash);
  const userOpSig = concatHex([p.draft.sessionIdBytes, agentSig]);
  const signature = packEnableSignature({
    hook: p.draft.hook,
    validatorData: p.draft.validatorData,
    hookData: p.draft.hookData,
    executeSelector: p.draft.executeSelector,
    enableSig,
    userOpSig,
  });
  return { ...p.draft.op, signature };
}

export interface BuildSessionUserOpParams {
  client: PublicClient;
  chainConfig: ChainAAConfig;
  account: Address;
  sessionId: string;
  agentSigner: Signer;
  call: { target: Address; value?: bigint; data: Hex };
  gas?: Partial<
    Pick<
      UserOperationV7,
      'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas' | 'maxFeePerGas' | 'maxPriorityFeePerGas'
    >
  >;
}

/**
 * agent（session key）调用 UserOp：nonce 路由到 DEFAULT-mode validator key
 * （validatorNonceKey(module)），signature = sessionId(32B) ‖ agent(userOpHash)。
 */
export async function buildSessionUserOp(p: BuildSessionUserOpParams): Promise<UserOperationV7> {
  const module = resolveSessionModule(p.chainConfig);
  const nonce = (await p.client.readContract({
    address: p.chainConfig.entryPoint,
    abi: parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)']),
    functionName: 'getNonce',
    args: [p.account, validatorNonceKey(module)],
  })) as bigint;
  const op = buildUserOp({ sender: p.account, nonce, call: p.call, gas: p.gas });
  const userOpHash = getUserOpHash(op, p.chainConfig.entryPoint, p.chainConfig.chainId);
  const agentSig = await p.agentSigner.signUserOp(userOpHash);
  return { ...op, signature: concatHex([toBytes32(p.sessionId), agentSig]) };
}
