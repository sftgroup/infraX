// 诊断4：factory.getAddress(data, salt) view —— 离线地址预测正解
// 用法（生产）：env 就绪后 npx tsx scripts/aa-diag-sender4.ts
import { createPublicClient, http, type Chain, type Hex, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { getChainConfig, createKernelAccount, PrivateKeySigner } from '../../aa-sdk/src/index.js';

const getAddressAbi = [
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

async function main() {
  const cfg = getChainConfig('oxachain', process.env);
  const chain: Chain = {
    id: cfg.chainId,
    name: 'OxaChain',
    nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  };
  const client = createPublicClient({ chain, transport: http(cfg.rpcUrl) });

  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const account = await createKernelAccount({ owner: new PrivateKeySigner(ownerKey), chainConfig: cfg });

  console.log('owner:          ', owner.address);
  console.log('account.address:', account.address);
  console.log('factory:        ', account.factory);

  // 从 factoryData 解包 data 参数（第二个 calldata 参数）和 salt（第三个）
  // factoryData = selector(4) + offset(32) + salt(32) + data(...)
  const fd = account.factoryData!;
  const body = fd.slice(10);
  const offset = parseInt(body.slice(0, 64), 16);
  const salt = '0x' + body.slice(64, 128) as Hex;
  const data = '0x' + body.slice(128) as Hex;
  console.log('data len:', (data.length - 2) / 2, 'B | salt:', salt);

  if (!cfg.kernelFactory) { console.log('no factory'); process.exit(1); }

  // 用 factory.getAddress view 预测
  try {
    const addr = await client.readContract({
      address: cfg.kernelFactory,
      abi: getAddressAbi,
      functionName: 'getAddress',
      args: [data, salt],
    });
    console.log('\nfactory.getAddress() =', addr);
    console.log('与 permissionless 预测一致:', addr.toLowerCase() === account.address.toLowerCase());
  } catch (e: any) {
    console.log('getAddress err:', e?.shortMessage || e?.message, '| data:', e?.data || e?.cause?.data || '');
  }
  console.log('\n== 诊断4 结束 ==');
}

main().catch((e) => { console.error('diag4 error:', e?.message || e); process.exit(1); });
