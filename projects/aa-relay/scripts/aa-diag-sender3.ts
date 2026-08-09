// 诊断3：factory.implementation() + 已部署地址的 createAccount eth_call + 离线 CREATE2 公式验证
// 用法（生产）：env 就绪后 npx tsx scripts/aa-diag-sender3.ts
import { createPublicClient, http, encodeFunctionData, concat, encodeAbiParameters, type Chain, type Address, type Hex, keccak256, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getChainConfig, createKernelAccount, PrivateKeySigner } from '../../aa-sdk/src/index.js';

const DEPLOYER_KEY = process.env.OXACHAIN_DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!DEPLOYER_KEY) throw new Error('env OXACHAIN_DEPLOYER_PRIVATE_KEY required');

async function main() {
  const cfg = getChainConfig('oxachain', process.env);
  const chain: Chain = {
    id: cfg.chainId,
    name: 'OxaChain',
    nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  };
  const client = createPublicClient({ chain, transport: http(cfg.rpcUrl) });

  // 1) factory.implementation()
  const implData = encodeFunctionData({
    abi: [{ type: 'function', name: 'implementation', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' }],
    functionName: 'implementation',
    args: [],
  });
  try {
    const impl = await client.request({ method: 'eth_call', params: [{ to: cfg.kernelFactory, data: implData }, 'latest'] });
    console.log('[1] factory.implementation() =', impl);
  } catch (e: any) {
    console.log('[1] implementation() err:', e?.shortMessage || e?.message);
  }

  // 2) owner=deployer（chain-smoke 用过的 owner，账户已部署）→ createKernelAccount → createAccount eth_call
  const deployer = privateKeyToAccount(DEPLOYER_KEY);
  const account = await createKernelAccount({ owner: new PrivateKeySigner(DEPLOYER_KEY), chainConfig: cfg });
  console.log('\n[2] owner=deployer');
  console.log('   predicted(account.address):', account.address);
  console.log('   factoryData:', account.factoryData);
  if (account.factory && account.factoryData) {
    try {
      const r = await client.request({ method: 'eth_call', params: [{ to: account.factory, data: account.factoryData }, 'latest'] });
      console.log('   factory.createAccount eth_call 成功: data =', r);
      if ((r as string).length >= 42) console.log('   返回地址 =', '0x' + (r as string).slice(-40));
    } catch (e: any) {
      const dd = (e?.data as string) || (e?.cause?.data as string) || '';
      console.log('   factory.createAccount eth_call revert:', e?.shortMessage || e?.message, '| data:', dd);
    }
  }

  // 3) 离线 CREATE2（solady KernelFactory v3.1）验证
  //    proxy runtime code = 0x3d602d80600a3d3981f3 ++ implementation
  //    codeHash = keccak256(proxyCode)；salt = keccak256(abi.encodePacked(data, salt_arg))
  //    addr = last20(keccak256(0xff ++ factory ++ salt ++ codeHash))
  console.log('\n[3] 离线 CREATE2 公式验证');
  const PROXY_PREFIX = '0x3d602d80600a3d3981f3';
  const impl = (cfg.kernelImplementation ?? '0x') as Address;
  const proxyCode = concat([PROXY_PREFIX as Hex, impl]);
  const codeHash = keccak256(proxyCode);
  const saltArg = '0x' + (0n).toString(16).padStart(64, '0') as Hex;
  // data 参数 = factoryData 的第二个参数（initData），需解包：encodeFunctionData 后是 selector + offset + salt + data
  // 直接用 abi 解码太麻烦；手动从 factoryData 提取：ea6d13ac | offset(32) | salt(32) | data
  if (account.factoryData) {
    const body = account.factoryData.slice(10); // 去 selector
    const offset = parseInt(body.slice(0, 64), 16);
    const saltFromCall = body.slice(64, 128);
    const dataArg = '0x' + body.slice(128, 128 + offset * 2);
    console.log('   dataArg len:', (dataArg.length - 2) / 2, 'B | saltFromCall =', saltFromCall);
    const salt = keccak256(concat([dataArg as Hex, saltFromCall as Hex]));
    const pre = concat(['0xff' as Hex, account.factory as Address, salt, codeHash]);
    const hash = keccak256(pre);
    const addr = getAddress('0x' + hash.slice(-40));
    console.log('   codeHash =', codeHash);
    console.log('   salt =', salt);
    console.log('   CREATE2 地址 =', addr);
  }
  console.log('\n== 诊断3 结束 ==');
}

main().catch((e) => { console.error('diag3 error:', e?.message || e); process.exit(1); });
