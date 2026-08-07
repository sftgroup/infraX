import {
  createPublicClient,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';
import { KernelSmartAccount } from 'permissionless/accounts/kernel';
import type { ChainAAConfig, Signer } from './types.js';
import { signerToOwner } from './utils/to-owner.js';

// ============================================================================
// Kernel v3 Smart Account：创建 / 地址预计算 / 部署检查（对齐 §5.4，M2 实现）
// 底层：permissionless toKernelSmartAccount（EntryPoint v0.7 + ERC-7579 Kernel v3）
// 零硬编码：factory/implementation 不传时使用 permissionless 内置 v3.x 默认地址
// （ZeroDev 跨链统一部署），环境变量 AA_{CHAIN}_FACTORY/IMPLEMENTATION 可覆盖。
// ============================================================================

/** 默认 Kernel 版本（v3.1 稳定；0.3.0-beta 的 initialize 签名不同） */
export const DEFAULT_KERNEL_VERSION = '0.3.1' as const;

const SUPPORTED_KERNEL_VERSIONS = ['0.3.0-beta', '0.3.1', '0.3.2', '0.3.3'] as const;

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
  /** 可选：vault 地址等自定义部署参数 */
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

/** 解析 Kernel 版本（env 优先，校验在支持列表内） */
export function resolveKernelVersion(chainConfig: ChainAAConfig): string {
  const version = chainConfig.kernelVersion ?? DEFAULT_KERNEL_VERSION;
  if (!SUPPORTED_KERNEL_VERSIONS.includes(version as (typeof SUPPORTED_KERNEL_VERSIONS)[number])) {
    throw new Error(`[aa-sdk] unsupported kernel version: ${version} (supported: ${SUPPORTED_KERNEL_VERSIONS.join(', ')})`);
  }
  return version;
}

/** 构建 permissionless Kernel 账户（内部：initCode 组装 + getSenderAddress 地址预测） */
async function toKernelAccount(params: CreateAccountParams, transport?: Transport) {
  const version = resolveKernelVersion(params.chainConfig);
  return KernelSmartAccount.toKernelSmartAccount({
    client: createAAClient(params.chainConfig, transport),
    version: version as (typeof SUPPORTED_KERNEL_VERSIONS)[number],
    entryPoint: { address: params.chainConfig.entryPoint, version: '0.7' },
    owners: [signerToOwner(params.owner)],
    index: params.salt ?? 0n,
    // 自建 KernelFactory（createAccount(bytes, bytes32)）直连，不走 ZeroDev MetaFactory：
    // MetaFactory 仅部署在主流链，自建链（如 OxaChain）上不存在 → 预测地址会退化为零地址
    useMetaFactory: false,
    // factory/accountLogic/validator 缺省不传 → permissionless 内置 v3 默认地址（零硬编码）；
    // 自建链必须通过 env（AA_{CHAIN}_FACTORY / _IMPLEMENTATION / _ECDSA_VALIDATOR）显式配置
    factoryAddress: params.chainConfig.kernelFactory,
    accountLogicAddress: params.chainConfig.kernelImplementation,
    validatorAddress: params.chainConfig.validatorAddress,
  });
}

/**
 * 地址预计算（counterfactual，无需上链部署）：
 * 走 EntryPoint.getSenderAddress 语义（Kernel v3 factory 无 getAddress view）。
 */
export async function predictAccountAddress(
  params: CreateAccountParams,
  transport?: Transport,
): Promise<Address> {
  const account = await toKernelAccount(params, transport);
  return account.getAddress();
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
 */
export async function createKernelAccount(
  params: CreateAccountParams,
  transport?: Transport,
): Promise<KernelAccount> {
  const account = await toKernelAccount(params, transport);
  const address = await account.getAddress();
  const factoryArgs = await account.getFactoryArgs();
  const isDeployed = await isAccountDeployed(params.chainConfig, address, transport);
  return {
    address,
    owner: params.owner,
    chainConfig: params.chainConfig,
    isDeployed,
    factory: factoryArgs.factory,
    factoryData: factoryArgs.factoryData,
  };
}
