// Smart Account 创建 / 地址预测 / 部署检查 单测（对齐 §5.4 counterfactual + §10.1）
import { describe, expect, it } from 'vitest';
import { custom, encodeAbiParameters, type Address, type Hex } from 'viem';
import { PrivateKeySigner } from '../src/signers/private-key.js';
import { createKernelAccount, isAccountDeployed, predictAccountAddress, resolveKernelVersion } from '../src/smart-account.js';
import type { ChainAAConfig } from '../src/types.js';

const TEST_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const ENTRYPOINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;
const FACTORY = '0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419' as Address;
const IMPL = '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D' as Address;
// Kernel v3.1 + EntryPoint v0.7：SDK 强制 useMetaFactory=false（自建链无 MetaFactory），
// factory 直连 KernelFactory(0xaac5D)，factoryData = createAccount(initData, salt)。
const DEFAULT_ECDSA_VALIDATOR_V31 = '0x845ADb2C711129d4f3966735eD98a9F09fC4cE57' as Address;

const config: ChainAAConfig = {
  chainId: 84532,
  entryPointVersion: '0.7',
  entryPoint: ENTRYPOINT,
  rpcUrl: 'https://mock.invalid',
  kernelFactory: FACTORY,
  kernelImplementation: IMPL,
  bundlers: [],
};

const signer = new PrivateKeySigner(TEST_PRIVATE_KEY);

/** mock transport：按 method 返回固定结果 */
function mockTransport(handlers: Record<string, () => string | Promise<string>>) {
  return custom({
    async request({ method }: { method: string }) {
      if (handlers[method]) return handlers[method]();
      throw new Error(`[mock] unexpected method: ${method}`);
    },
  });
}

describe('resolveKernelVersion', () => {
  it('defaults to 0.3.1 when not set', () => {
    expect(resolveKernelVersion(config)).toBe('0.3.1');
  });
  it('rejects unsupported versions', () => {
    expect(() => resolveKernelVersion({ ...config, kernelVersion: '0.2.2' })).toThrow(/unsupported kernel version/);
  });
});

describe('isAccountDeployed', () => {
  it('false when getCode returns empty', async () => {
    const t = mockTransport({
      eth_getCode: () => '0x',
    });
    expect(await isAccountDeployed(config, signer.address, t)).toBe(false);
  });

  it('true when getCode returns bytecode', async () => {
    const t = mockTransport({
      eth_getCode: () => '0x60006000',
    });
    expect(await isAccountDeployed(config, signer.address, t)).toBe(true);
  });
});

describe('predictAccountAddress (getSenderAddress semantics)', () => {
  const expected = '0x6B175474E89094C44Da98b954EedeAC495271d0F' as Address;

  it('returns the address decoded from eth_call result', async () => {
    const t = mockTransport({
      // getSenderAddress 的 eth_call 返回 ABI 编码的地址（32 字节右对齐）
      eth_call: () => encodeAbiParameters([{ type: 'address' }], [expected]),
    });
    const address = await predictAccountAddress({ owner: signer, chainConfig: config }, t);
    expect(address.toLowerCase()).toBe(expected.toLowerCase());
  });
});

describe('createKernelAccount (counterfactual)', () => {
  it('exposes address, factory/factoryData and isDeployed=false', async () => {
    const expected = '0x6B175474E89094C44Da98b954EedeAC495271d0F' as Address;
    const t = mockTransport({
      eth_call: () => encodeAbiParameters([{ type: 'address' }], [expected]),
      eth_getCode: () => '0x', // 未部署
    });
    const account = await createKernelAccount({ owner: signer, chainConfig: config }, t);
    expect(account.address.toLowerCase()).toBe(expected.toLowerCase());
    expect(account.isDeployed).toBe(false);
    expect(account.factory).toBe(FACTORY);
    expect(account.factoryData).toBeDefined();
    expect(account.factoryData!.startsWith('0x')).toBe(true);
    // 配置的 KernelFactory 直连（useMetaFactory=false），factoryData 内嵌 ECDSA validator 地址（初始化数据）
    expect(account.factoryData!.toLowerCase()).toContain(DEFAULT_ECDSA_VALIDATOR_V31.slice(2).toLowerCase());
  });

  it('reports isDeployed=true when code exists', async () => {
    const expected = '0x6B175474E89094C44Da98b954EedeAC495271d0F' as Address;
    const t = mockTransport({
      eth_call: () => encodeAbiParameters([{ type: 'address' }], [expected]),
      eth_getCode: () => '0x60006000',
    });
    const account = await createKernelAccount({ owner: signer, chainConfig: config }, t);
    expect(account.isDeployed).toBe(true);
  });
});
