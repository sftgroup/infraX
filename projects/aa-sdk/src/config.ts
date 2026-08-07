import type { Address } from 'viem';
import type { BundlerConfig, ChainAAConfig, PaymasterConfig } from './types.js';

// ============================================================================
// 链配置 + 环境变量加载（对齐 docs/AA_SDK_TECH_DESIGN.md §8，零硬编码）
// 所有地址/URL 均从环境变量读取，禁止在代码中写死。
// ============================================================================

export const DEFAULT_ENTRYPOINT_V07: Address =
  '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

/** 环境变量链别名 → chainId（§8.2 上线链矩阵） */
export const CHAIN_ALIASES: Record<string, number> = {
  'base-sepolia': 84532,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
  ethereum: 1,
  bsc: 56, // 多网络 session：BSC 主网（P0.4 扩展）
  // 目标主网 OxaChain（§8.2 链矩阵；RPC 公网 DNS 待确认，链上实测后补充部署登记）
  oxachain: 19505,
  // XLayer 需单独验证（§12），接入后补充: xlayer: 196
};

/** 解析 AA_ENABLED_CHAINS 逗号分隔列表 */
export function getEnabledChains(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.AA_ENABLED_CHAINS ?? 'base-sepolia';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 按别名解析链配置（缺省时用默认值兜底；关键地址缺失则抛错） */
export function getChainConfig(chainAlias: string, env: NodeJS.ProcessEnv = process.env): ChainAAConfig {
  const chainId = CHAIN_ALIASES[chainAlias];
  if (!chainId) throw new Error(`[aa-sdk] unknown chain alias: ${chainAlias}`);

  const prefix = `AA_${chainAlias.toUpperCase().replace(/-/g, '_')}`;

  const rpcUrl = env[`${prefix}_RPC_URL`];
  if (!rpcUrl) {
    throw new Error(`[aa-sdk] missing ${prefix}_RPC_URL env var (chain RPC for reads)`);
  }

  // factory/implementation 可空：缺省用 permissionless 内置 Kernel v3 默认地址（见 smart-account.ts）
  const factory = env[`${prefix}_FACTORY`];
  const implementation = env[`${prefix}_IMPLEMENTATION`];
  const kernelVersion = env[`${prefix}_KERNEL_VERSION`];
  // session validator 模块可空：enable/disable session 时必需（见 session.ts）
  const sessionModule = env[`${prefix}_SESSION_MODULE`];
  // ECDSA root validator 可空：缺省用 permissionless 内置 v3 默认地址（自建链必须显式配置）
  const validatorAddress = env[`${prefix}_ECDSA_VALIDATOR`];

  const bundlers: BundlerConfig[] = parseBundlers(env[`${prefix}_BUNDLERS`], chainAlias);
  const paymaster = parsePaymaster(env[`${prefix}_PAYMASTER_URL`]);

  // 按链优先取 `${prefix}_ENTRYPOINT_V07`，其次全局 AA_ENTRYPOINT_V07，最后默认
  const entryPoint = (env[`${prefix}_ENTRYPOINT_V07`] ?? env.AA_ENTRYPOINT_V07 ?? DEFAULT_ENTRYPOINT_V07) as Address;

  return {
    network: 'evm', // 当前仅 EVM 链（Solana 网络配置形态见 AA_SDK_TECH_DESIGN §12）
    chainId,
    entryPointVersion: '0.7',
    entryPoint,
    rpcUrl,
    kernelVersion,
    kernelFactory: factory as Address | undefined,
    kernelImplementation: implementation as Address | undefined,
    sessionModule: sessionModule as Address | undefined,
    validatorAddress: validatorAddress as Address | undefined,
    bundlers,
    paymaster,
  };
}

/** 解析 JSON 数组形式的 BUNDLERS 环境变量；纯 URL 字符串自动包装为单端点数组（容错） */
function parseBundlers(raw: string | undefined, chainAlias: string): BundlerConfig[] {
  if (!raw) {
    throw new Error(
      `[aa-sdk] missing AA_${chainAlias.toUpperCase()}_BUNDLERS env var (JSON array or URL)`,
    );
  }
  try {
    const parsed = JSON.parse(raw) as Array<Partial<BundlerConfig>>;
    return parsed.map((b, i) => ({
      url: b.url ?? '',
      priority: b.priority ?? i,
      timeoutMs: b.timeoutMs ?? 30_000,
    }));
  } catch {
    // 纯 URL 容错：http(s):// 开头 → 单端点
    if (/^https?:\/\//.test(raw.trim())) {
      return [{ url: raw.trim(), priority: 0, timeoutMs: 30_000 }];
    }
    throw new Error(`[aa-sdk] invalid AA_${chainAlias.toUpperCase()}_BUNDLERS JSON`);
  }
}

function parsePaymaster(raw: string | undefined): PaymasterConfig | undefined {
  if (!raw) return undefined;
  return {
    type: 'verifying',
    url: raw,
    // Pimlico VP 无 token 扣费；erc20 模式后续按 AA_{CHAIN}_PAYMASTER_TOKEN 扩展
  };
}

/** 获取全部启用链的配置 */
export function getAllChainConfigs(env: NodeJS.ProcessEnv = process.env): ChainAAConfig[] {
  return getEnabledChains(env).map((alias) => getChainConfig(alias, env));
}
