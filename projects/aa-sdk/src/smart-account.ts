import {
  createPublicClient,
  concatHex,
  encodeFunctionData,
  http,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  zeroAddress,
} from 'viem';
import type { ChainAAConfig, Signer } from './types.js';

// ============================================================================
// Kernel v3 Smart Account：创建 / 地址预计算 / 部署检查（对齐 §5.4，M2 实现）
//
// 2026-08-09 重写：完全绕开 permissionless 的地址预测与 initCode 生成。
// 原因（OxaChain 生产实测）：
//   1. permissionless 走 EntryPoint.getSenderAddress（revert 语义），OxaChain 节点
//      拒绝 eth_call 中 CREATE2 模拟 → 预测退化为零地址或返回已存在合约地址；
//   2. viem toSmartAccount 包装的 getFactoryArgs() 在 isDeployed()=true 时返回空
//      （若 getSenderAddress 恰好返回已部署地址）→ initCode 丢失；
//   3. 链上 implementation 实测为 Kernel v3.0-beta（initialize 4 参数，
//      selector 0x12af322c），与 permissionless 默认 v3.1（5 参数，0x3c3b752b）
//      不匹配 → 走 fallback revert InvalidSelector() → AA13。
// 本实现直接编码 Kernel v3 factory initCode 并用 factory.getAddress(data, salt)
// view（纯 CREATE2 计算）预测地址，与 bundler 执行路径一致。
// 零硬编码：factory/implementation/validator/sessionModule 均来自 env。
// ============================================================================

/** 默认 Kernel 版本（v3.1 稳定；0.3.0-beta 的 initialize 签名不同） */
export const DEFAULT_KERNEL_VERSION = '0.3.1' as const;

const SUPPORTED_KERNEL_VERSIONS = ['0.3.0-beta', '0.3.1', '0.3.2', '0.3.3'] as const;

/** ValidationId 前缀：VALIDATOR 类型（0x01，permissionless Kernel constants） */
const VALIDATOR_TYPE_VALIDATOR = '0x01' as Hex;

export interface KernelAccount {
  address: Address;
  owner: Signer;
  chainConfig: ChainAAConfig;
  /** 是否已部署（false = 首次 UserOp 时顺带部署，counterfactual 懒部署） */
  isDeployed: boolean;
  /** 首次部署用 factory（create2），未部署时可用 */
  factory?: Address;
  /** 首次部署用 factoryData（initCode），未部署时可用 */
  factoryData?: Hex;
}

export interface CreateAccountParams {
  owner: Signer;
  chainConfig: ChainAAConfig;
  /** create2 salt（默认 = 0） */
  salt?: bigint;
  /** 可选：vault 地址等自定义部署参数（暂不支持，保留接口） */
  factoryData?: Hex;
}

/** 构造链上 client（transport 可注入，供测试 mock） */
export function createAAClient(chainConfig: ChainAAConfig, transport?: Transport): PublicClient {
  const chain: Chain = {
    id: chainConfig.chainId,
    name: `Chain-${chainConfig.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [chainConfig.rpcUrl] } },
  };
  return createPublicClient({ chain, transport: transport ?? http(chainConfig.rpcUrl) });
}

/** KernelFactory.createAccount(bytes data, bytes32 salt) ABI（zerodev Kernel v3 factory） */
const KernelV3FactoryAbi = [
  {
    type: 'function',
    name: 'createAccount',
    inputs: [
      { name: 'data', type: 'bytes' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'payable',
  },
] as const;

/** KernelFactory.getAddress(bytes data, bytes32 salt) view ABI（纯 CREATE2 计算） */
const KernelFactoryGetAddressAbi = [
  {
    type: 'function',
    name: 'getAddress',
    inputs: [
      { name: 'data', type: 'bytes' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const;

/** Kernel v3.0-beta：initialize(bytes21 _rootValidator, address hook, bytes validatorData, bytes hookData) */
const KernelV3Init4Abi = [
  {
    type: 'function',
    name: 'initialize',
    inputs: [
      { name: '_rootValidator', type: 'bytes21', internalType: 'ValidationId' },
      { name: 'hook', type: 'address', internalType: 'contract IHook' },
      { name: 'validatorData', type: 'bytes', internalType: 'bytes' },
      { name: 'hookData', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/** Kernel v3.1+：initialize(bytes21, address, bytes, bytes, bytes[] initConfig) */
const KernelV3Init5Abi = [
  {
    type: 'function',
    name: 'initialize',
    inputs: [
      { name: '_rootValidator', type: 'bytes21', internalType: 'ValidationId' },
      { name: 'hook', type: 'address', internalType: 'contract IHook' },
      { name: 'validatorData', type: 'bytes', internalType: 'bytes' },
      { name: 'hookData', type: 'bytes', internalType: 'bytes' },
      { name: 'initConfig', type: 'bytes[]', internalType: 'bytes[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/** 解析 Kernel 版本（env 优先，校验在支持列表内） */
export function resolveKernelVersion(chainConfig: ChainAAConfig): string {
  const version = chainConfig.kernelVersion ?? DEFAULT_KERNEL_VERSION;
  if (!SUPPORTED_KERNEL_VERSIONS.includes(version as (typeof SUPPORTED_KERNEL_VERSIONS)[number])) {
    throw new Error(`[aa-sdk] unsupported kernel version: ${version} (supported: ${SUPPORTED_KERNEL_VERSIONS.join(', ')})`);
  }
  return version;
}

/**
 * 编码 Kernel initialize calldata（版本分支）：
 *  - 0.3.0-beta：4 参数（selector 0x12af322c）
 *  - v3.1+：5 参数（selector 0x3c3b752b）
 * validatorData = owner 地址（20 字节），rootValidator = 0x01 + ECDSA validator 地址（21 字节）。
 */
export function encodeKernelInitialize(
  chainConfig: ChainAAConfig,
  ownerAddress: Address,
  version: string,
): Hex {
  const validator = chainConfig.validatorAddress;
  if (!validator) {
    throw new Error(`[aa-sdk] missing ECDSA validator for chain ${chainConfig.chainId} (set AA_*_ECDSA_VALIDATOR)`);
  }
  const rootValidator = concatHex([VALIDATOR_TYPE_VALIDATOR, validator]); // 1 + 20 = 21B
  if (version === '0.3.0-beta') {
    return encodeFunctionData({
      abi: KernelV3Init4Abi,
      functionName: 'initialize',
      args: [rootValidator, zeroAddress, ownerAddress, '0x'],
    });
  }
  return encodeFunctionData({
    abi: KernelV3Init5Abi,
    functionName: 'initialize',
    args: [rootValidator, zeroAddress, ownerAddress, '0x', []],
  });
}

/**
 * 构建 Kernel v3 factory initCode（factoryData = createAccount(initializeData, salt)）。
 * 与 permissionless 生成的数据一致，但不依赖 permissionless 的地址预测路径。
 */
export function encodeKernelFactoryData(
  chainConfig: ChainAAConfig,
  ownerAddress: Address,
  salt: bigint,
  version?: string,
): { factory: Address; factoryData: Hex } {
  const factory = chainConfig.kernelFactory;
  if (!factory) {
    throw new Error(`[aa-sdk] missing kernel factory for chain ${chainConfig.chainId} (set AA_*_FACTORY)`);
  }
  const initializeData = encodeKernelInitialize(chainConfig, ownerAddress, version ?? resolveKernelVersion(chainConfig));
  const factoryData = encodeFunctionData({
    abi: KernelV3FactoryAbi,
    functionName: 'createAccount',
    args: [initializeData, toHex(salt, { size: 32 })],
  });
  return { factory, factoryData };
}

/**
 * 从 factoryData（createAccount(data, salt) 编码）解包 (data, salt) 参数。
 * calldata = selector(4B) + data.offset(32B) + salt(32B) + data.len(32B) + data(...)；
 * body 为 hex 字符串（去掉 selector 后），以下偏移均以 hex 字符计（1B = 2 chars）：
 *   offset = body[0:64]（仅作 ABI 校验参考）、salt = body[64:128]、
 *   dataLen = body[128:192]、data = body[192:192+dataLen*2]
 */
export function unpackFactoryData(factoryData: Hex): { data: Hex; salt: Hex } {
  const body = factoryData.slice(10); // 去 selector（4B = 8 chars）
  const salt = ('0x' + body.slice(64, 128)) as Hex;
  const dataLen = parseInt(body.slice(128, 192), 16);
  const data = ('0x' + body.slice(192, 192 + dataLen * 2)) as Hex;
  return { data, salt };
}

/**
 * factory.getAddress view 预测（纯 CREATE2 计算，无合约创建；OxaChain 等
 * 节点拒绝 eth_call 中 CREATE2 模拟时 getSenderAddress 不可用）。失败返回 undefined。
 */
export async function predictWithFactoryGetAddress(
  chainConfig: ChainAAConfig,
  factoryData: Hex,
  transport?: Transport,
): Promise<Address | undefined> {
  const factory = chainConfig.kernelFactory;
  if (!factory) return undefined;
  const { data, salt } = unpackFactoryData(factoryData);
  const client = createAAClient(chainConfig, transport);
  try {
    const addr = await client.readContract({
      address: factory,
      abi: KernelFactoryGetAddressAbi,
      functionName: 'getAddress',
      args: [data, salt],
    });
    return addr && addr !== zeroAddress ? addr : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 地址预计算（counterfactual，无需上链部署）：
 * 用 factory.getAddress(data, salt) view（纯 CREATE2 计算）预测，
 * 与 bundler 执行 initCode 的 create2 地址一致（同一合约内逻辑相同）。
 */
export async function predictAccountAddress(
  params: CreateAccountParams,
  transport?: Transport,
): Promise<Address> {
  const version = resolveKernelVersion(params.chainConfig);
  const { factoryData } = encodeKernelFactoryData(
    params.chainConfig,
    params.owner.address,
    params.salt ?? 0n,
    version,
  );
  const address = await predictWithFactoryGetAddress(params.chainConfig, factoryData, transport);
  if (!address) {
    throw new Error(`[aa-sdk] cannot predict account address for chain ${params.chainConfig.chainId} (factory.getAddress failed)`);
  }
  return address;
}

/** 检查账户是否已部署（eth_getCode(address) !== 空） */
export async function isAccountDeployed(
  chainConfig: ChainAAConfig,
  address: Address,
  transport?: Transport,
): Promise<boolean> {
  const client = createAAClient(chainConfig, transport);
  const code = await client.getCode({ address });
  return code !== undefined && code !== '0x';
}

/**
 * 创建账户（若未部署）：返回 KernelAccount。
 * 部署本身不产生交易 —— 首次 UserOp 携带 factory/factoryData 顺带完成（§5.4 counterfactual）。
 * 地址预测 / initCode 均自建（不依赖 permissionless，见文件头注释）。
 */
export async function createKernelAccount(
  params: CreateAccountParams,
  transport?: Transport,
): Promise<KernelAccount> {
  const version = resolveKernelVersion(params.chainConfig);
  const { factory, factoryData } = encodeKernelFactoryData(
    params.chainConfig,
    params.owner.address,
    params.salt ?? 0n,
    version,
  );
  const address =
    (await predictWithFactoryGetAddress(params.chainConfig, factoryData, transport)) ?? params.owner.address;
  const isDeployed = await isAccountDeployed(params.chainConfig, address, transport);
  return {
    address,
    owner: params.owner,
    chainConfig: params.chainConfig,
    isDeployed,
    factory,
    factoryData,
  };
}
