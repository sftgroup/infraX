// 诊断：OxaChain getSenderAddress 地址预测为何返回零地址
// 用法（生产）：env 就绪后 npx tsx scripts/aa-diag-sender.ts
import { createPublicClient, http, concat, encodeFunctionData, type Chain } from 'viem';
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

  console.log('== 诊断输出 ==');
  console.log('account.address:', account.address);
  console.log('factory:       ', account.factory);
  console.log('factoryData:   ', account.factoryData);

  if (account.factory && account.factoryData) {
    const initCode = concat([account.factory, account.factoryData]);
    const getSenderData = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'getSenderAddress',
          inputs: [{ name: 'initCode', type: 'bytes' }],
          outputs: [],
          stateMutability: 'nonpayable',
        },
      ],
      functionName: 'getSenderAddress',
      args: [initCode],
    });

    // 1) raw eth_call：观察 RPC 返回成功 data 还是 error（revert）
    try {
      const raw = await client.request({
        method: 'eth_call',
        params: [{ to: cfg.entryPoint, data: getSenderData }, 'latest'],
      });
      console.log('\n[eth_call] getSenderAddress 成功返回（未 revert）:');
      console.log('  data =', raw, '| len =', (raw as string).length, '| 前4字节 =', (raw as string).slice(0, 10));
    } catch (e: any) {
      console.log('\n[eth_call] getSenderAddress revert:');
      console.log('  message =', e?.shortMessage || e?.message);
      const dd = e?.data || (e?.cause?.data as string) || '';
      console.log('  revert data =', dd);
      if (dd && dd.length >= 10) {
        const addr = '0x' + dd.slice(dd.length - 40);
        console.log('  revert 中提取地址 =', addr);
      }
    }

    // 2) factory.createAccount 直接 eth_call（Kernel v3 factory 语义：create2 部署）
    try {
      const raw2 = await client.request({
        method: 'eth_call',
        params: [{ to: account.factory, data: account.factoryData }, 'latest'],
      });
      console.log('\n[eth_call] factory.createAccount 直接调用 成功返回:');
      console.log('  data =', raw2);
    } catch (e: any) {
      console.log('\n[eth_call] factory.createAccount revert:');
      const dd = (e?.data as string) || (e?.cause?.data as string) || '';
      console.log('  message =', e?.shortMessage || e?.message);
      console.log('  revert data =', dd);
    }
  }
  console.log('\n== 诊断结束 ==');
}

main().catch((e) => { console.error('diag error:', e?.message || e); process.exit(1); });
