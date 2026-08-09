// 诊断5：getAddress 预测 vs 真实 CREATE2 一致性（固定 owner 复现 E2E 激活路径）
// 用法（生产）：env 就绪后 npx tsx scripts/aa-diag-sender5.ts
import {
  createPublicClient, http, concat, keccak256, type Chain, type Hex, type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  getChainConfig, createKernelAccount, PrivateKeySigner, buildUserOp, userOpToRpc,
  unpackFactoryData,
} from '../../aa-sdk/src/index.js';

const TRACE_CODE_HASH = '0xa87712c59c2b43f4fd35165afd029207f9d5d4eca8321e2866168426618567aa4';

async function main() {
  const cfg = getChainConfig('oxachain', process.env);
  const chain: Chain = {
    id: cfg.chainId,
    name: 'OxaChain',
    nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  };
  const client = createPublicClient({ chain, transport: http(cfg.rpcUrl) });

  const ownerKey = '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex; // 固定 owner
  const owner = privateKeyToAccount(ownerKey);
  const account = await createKernelAccount({ owner: new PrivateKeySigner(ownerKey), chainConfig: cfg });

  console.log('owner:        ', owner.address);
  console.log('account.addr (getAddress 预测):', account.address);
  console.log('factory:      ', account.factory);
  console.log('factoryData:  ', account.factoryData);

  const { data, salt } = unpackFactoryData(account.factoryData!);
  console.log('\n解包 factoryData:');
  console.log('  data =', data);
  console.log('  salt =', salt);

  const actualSalt = keccak256(concat([data, salt]));
  console.log('  actualSalt(keccak(data,salt)) =', actualSalt);

  // 手工 create2（用 Alto trace 中真实发生的 codeHash）
  if (account.factory) {
    const pre = concat(['0xff' as Hex, account.factory, actualSalt, TRACE_CODE_HASH]);
    const manualAddr = '0x' + keccak256(pre).slice(-40);
    console.log('\n手工 create2（trace codeHash）:', manualAddr);
    console.log('  与 getAddress 一致:', manualAddr.toLowerCase() === account.address.toLowerCase());
  }

  // buildUserOp 序列化检查（激活路径）
  const op = buildUserOp({
    sender: account.address,
    nonce: 0n,
    call: { target: account.address, value: 0n, data: '0x' },
    factory: account.factory,
    factoryData: account.factoryData,
  });
  const rpc = userOpToRpc(op);
  console.log('\n序列化 UserOp（userOpToRpc）:');
  console.log('  sender:', rpc.sender);
  console.log('  factory:', rpc.factory);
  console.log('  factoryData 同 factoryData?', rpc.factoryData === account.factoryData);
  console.log('  initCode = concat(factory, factoryData) 长度:', ((rpc.factory?.length ?? 0) + (rpc.factoryData?.length ?? 0)) - 4);

  // 读取链上实际 sendUserOperation 时 Alto 收到的 initCode？无法直接拿；用 bundler eth_estimateUserOperationGas 做模拟探针
  console.log('\n== 诊断5 结束 ==');
}

main().catch((e) => { console.error('diag5 error:', e?.message || e); process.exit(1); });
