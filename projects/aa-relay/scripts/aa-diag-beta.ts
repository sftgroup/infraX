// 诊断 beta：0.3.0-beta 版本下 getFactoryArgs 为何返回空
// 直接调用 permissionless toKernelSmartAccount，打印内部状态
// 用法（生产）：env 就绪后 npx tsx scripts/aa-diag-beta.ts
import { createPublicClient, http } from 'viem';
import { KernelSmartAccount } from 'permissionless/accounts/kernel';
import {
  getChainConfig,
  PrivateKeySigner,
  signerToOwner,
  unpackFactoryData,
} from '../../aa-sdk/src/index.js';

const cfg = getChainConfig('oxachain', process.env);
const DEPLOYER_KEY = process.env.OXACHAIN_DEPLOYER_PRIVATE_KEY as string | undefined;
if (!DEPLOYER_KEY) throw new Error('env OXACHAIN_DEPLOYER_PRIVATE_KEY required');

async function main() {
  const owner = new PrivateKeySigner(DEPLOYER_KEY);
  const chain = {
    id: cfg.chainId,
    name: 'OxaChain',
    nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  };
  const client = createPublicClient({ chain, transport: http(cfg.rpcUrl) });

  console.log('== aa-diag-beta：0.3.0-beta getFactoryArgs 探针 ==');
  console.log('kernelVersion env:', process.env.AA_OXACHAIN_KERNEL_VERSION, '| resolve:', '0.3.0-beta');
  console.log('factory(env):', cfg.kernelFactory, '| impl:', cfg.kernelImplementation, '| validator:', cfg.validatorAddress);

  const acct = await KernelSmartAccount.toKernelSmartAccount({
    client,
    version: '0.3.0-beta',
    entryPoint: { address: cfg.entryPoint, version: '0.7' },
    owners: [signerToOwner(owner)],
    index: 0n,
    useMetaFactory: false,
    factoryAddress: cfg.kernelFactory,
    accountLogicAddress: cfg.kernelImplementation,
    validatorAddress: cfg.validatorAddress,
  });

  console.log('\naccount.getAddress() =', await acct.getAddress());
  const addr = (await acct.getAddress()) as string;
  const code = (await client.request({ method: 'eth_getCode', params: [addr, 'latest'] })) as string;
  console.log('getCode(accountAddress) size:', code && code !== '0x' ? (code.length - 2) / 2 : 'EMPTY', '| code:', (code || '').slice(0, 60));
  const nonce = (await client.request({ method: 'eth_getTransactionCount', params: [addr, 'latest'] })) as string;
  console.log('txCount(accountAddress):', nonce);
  const args = await acct.getFactoryArgs();
  console.log('getFactoryArgs():');
  console.log('  factory     =', args.factory);
  console.log('  factoryData =', args.factoryData);
  if (args.factoryData) {
    const { data, salt } = unpackFactoryData(args.factoryData as any);
    console.log('  解包 data selector =', (data as string).slice(0, 10));
    console.log('  解包 salt =', salt);
  }
  if ((acct as any).isDeployed !== undefined) {
    console.log('isDeployed =', await (acct as any).isDeployed());
  }
  console.log('\n== aa-diag-beta 结束 ==');
}

main().catch((e) => { console.error('diag-beta error:', e?.message || e); process.exit(1); });
