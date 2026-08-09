// 诊断2：读 EP.senderCreator() + 用 from=senderCreator 模拟 factory.createAccount
// 用法（生产）：env 就绪后 npx tsx scripts/aa-diag-sender2.ts
import { createPublicClient, http, concat, encodeFunctionData, type Chain, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { getChainConfig, createKernelAccount, PrivateKeySigner } from '../../aa-sdk/src/index.js';

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

  console.log('factory:   ', account.factory);
  console.log('factoryData:', account.factoryData);
  console.log('entryPoint:', cfg.entryPoint);

  // 1) 读 EP.senderCreator()
  const scData = encodeFunctionData({
    abi: [{ type: 'function', name: 'senderCreator', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' }],
    functionName: 'senderCreator',
    args: [],
  });
  console.log('senderCreator() selector =', scData);
  try {
    const sc2 = await client.request({ method: 'eth_call', params: [{ to: cfg.entryPoint, data: scData }, 'latest'] });
    console.log('senderCreator() =', sc2);
  } catch (e: any) {
    console.log('senderCreator() view err:', e?.shortMessage || e?.message);
  }

  if (!account.factory || !account.factoryData) { console.log('no factory'); process.exit(1); }

  // 2) 用不同 from 直接调 factory.createAccount
  const candidates: Array<{ label: string; from?: Address }> = [
    { label: 'from=默认(0x0)' },
    { label: 'from=entryPoint', from: cfg.entryPoint },
  ];
  const initCode = concat([account.factory, account.factoryData]);
  for (const c of candidates) {
    try {
      const r = await client.request({
        method: 'eth_call',
        params: [{ from: c.from, to: account.factory, data: account.factoryData }, 'latest'],
      });
      console.log(`\n[factory.createAccount ${c.label}] 成功:`, r);
      if ((r as string).length >= 42) console.log('  地址 =', '0x' + (r as string).slice(-40));
    } catch (e: any) {
      const dd = (e?.data as string) || (e?.cause?.data as string) || '';
      console.log(`\n[factory.createAccount ${c.label}] revert:`, e?.shortMessage || e?.message, '| data:', dd);
    }
  }

  // 3) eth_call factory.createAccount from=senderCreator（若上面拿到）
  console.log('\n== 诊断2 结束 ==');
}

main().catch((e) => { console.error('diag2 error:', e?.message || e); process.exit(1); });
