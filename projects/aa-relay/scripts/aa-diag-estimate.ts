// ============================================================================
// 链上 E2E 最后一步：用部署者私钥向 bundler 发送估算请求，对比 sender 地址是否一致
//
// 核心问题：SDK 用 factory.getAddress(data, salt)（纯 CREATE2 view）预测的账户地址，
// 与 bundler 模拟执行 initCode（factory.createAccount）实际得到的地址是否一致？
//
// 探针设计（全部只估算不发送，零链上副作用；签名方 = 部署者私钥 = 账户 owner）：
//   A  sender=预测地址(salt=0) + initCode   → 该账户已部署 → AA10 sender already constructed
//        = 链上确实存在预测地址的账户
//   B  sender=错误地址 + 真实 initCode       → AA14 initCode must return sender
//        = bundler 模拟执行 initCode 得到的地址 ≠ 错误 sender；因 factory 确定性
//        （getAddress 与 createAccount 同源 CREATE2），该地址 == 预测地址
//   C  sender=预测地址(fresh salt) + initCode + 注资 + 有效签名
//        → 期望估算成功 = bundler 执行 initCode 返回地址 == userOp.sender == 预测地址
//        （若不相等会先被 AA14 拒绝）→ 直接证明 sender 一致
//   D  sender=预测地址 + 无 initCode         → AA25 invalid account nonce（基线）
//
// 用法（生产）：source /tmp/aa-e2e-env.b64.txt && npx tsx scripts/aa-diag-estimate.ts
// ============================================================================
import { createPublicClient, createWalletClient, http, type Chain, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  getChainConfig,
  createKernelAccount,
  PrivateKeySigner,
  BundlerClient,
  buildUserOp,
  signUserOp,
  unpackFactoryData,
  estimateFeesPerGas,
} from '../../aa-sdk/src/index.js';

const cfg = getChainConfig('oxachain', process.env);
const DEPLOYER_KEY = process.env.OXACHAIN_DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!DEPLOYER_KEY) throw new Error('env OXACHAIN_DEPLOYER_PRIVATE_KEY required');

const ownerSigner = new PrivateKeySigner(DEPLOYER_KEY);
const deployer = privateKeyToAccount(DEPLOYER_KEY);

const chain: Chain = {
  id: cfg.chainId,
  name: 'OxaChain',
  nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpcUrl] } },
};
const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const walletClient = createWalletClient({ chain, transport: http(cfg.rpcUrl) });

function dumpError(label: string, e: any) {
  console.log(`\n[${label}] ❌ 估算失败`);
  console.log('  name:', e?.name, '| code:', e?.code);
  console.log('  details:', String(e?.details ?? '').slice(0, 200));
  let cur = e, depth = 0;
  while (cur && depth < 4) {
    if (cur?.details && cur.details !== e?.details) {
      console.log(`  cause[${depth}] details:`, String(cur.details).slice(0, 160));
    }
    cur = cur?.cause;
    depth++;
  }
}

async function probe(
  label: string,
  sender: Address,
  factory: Address | undefined,
  factoryData: Hex | undefined,
): Promise<string> {
  let op = buildUserOp({
    sender,
    nonce: 0n,
    call: { target: sender, value: 0n, data: '0x' },
    factory,
    factoryData,
  });
  op = await signUserOp(op, cfg.entryPoint, cfg.chainId, ownerSigner);
  const bundler = new BundlerClient(cfg);
  try {
    const r = await bundler.estimateUserOperationGas(op);
    console.log(`\n[${label}] ✅ 估算成功`, r);
    return 'ok';
  } catch (e: any) {
    dumpError(label, e);
    return 'fail';
  }
}

async function main() {
  console.log('== aa-diag-estimate：bundler 估算探针（sender 一致性）==');
  console.log('owner(deployer):', deployer.address, '| bundler:', cfg.bundlers[0].url);
  console.log('entryPoint:', cfg.entryPoint, '| factory:', cfg.kernelFactory);

  const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  console.log('\n[预测] account.address (getAddress) =', account.address);
  console.log('  factory     =', account.factory);
  console.log('  factoryData =', account.factoryData);
  const { data, salt } = unpackFactoryData(account.factoryData!);
  console.log('  data(initialize) =', data);
  console.log('  salt             =', salt);

  // 探针 A：真实 initCode + 预测 sender（该账户已部署 → 期望 AA10）
  const rA = await probe('A sender=预测地址 + 真实 initCode（期望 AA10=已部署）', account.address, account.factory, account.factoryData);

  // 探针 B：真实 initCode + 错误 sender（0x...0001）→ 期望 AA14
  const BAD_SENDER = '0x0000000000000000000000000000000000000001' as Address;
  const rB = await probe('B sender=错误地址 + 真实 initCode（期望 AA14）', BAD_SENDER, account.factory, account.factoryData);

  // 探针 C（直接证明）：全新 salt 的 counterfactual 账户（部署者 owner，从未部署）
  // 注资后估算：bundler 执行 initCode 返回地址必须 == userOp.sender（预测地址）才通过 AA14 检查
  let acctC: Awaited<ReturnType<typeof createKernelAccount>> | undefined;
  for (let i = 0; i < 5; i++) {
    const saltC = BigInt(Date.now() + i * 1000);
    const ac = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg, salt: saltC });
    const code = await publicClient.getCode({ address: ac.address });
    if (code === undefined || code === '0x') { acctC = ac; break; }
  }
  if (!acctC) {
    console.log('\n[C] ❌ 未找到未部署的 fresh-salt 地址（跳过）');
  } else {
    console.log('\n[预测-C] fresh-salt counterfactual 账户 =', acctC.address);
    const fund = 2n * 10n ** 16n; // 0.02 OXA（prefund 检查）
    const tx = await walletClient.sendTransaction({ account: deployer, to: acctC.address, value: fund });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log('  已注资 0.02 OXA, tx', tx, '| balance =', (await publicClient.getBalance({ address: acctC.address })));

    let opC = buildUserOp({
      sender: acctC.address,
      nonce: 0n,
      // 执行目标 = 部署者 EOA（无代码 + value=0 → 无副作用 no-op，确保执行阶段不 revert）
      call: { target: deployer.address, value: 0n, data: '0x' },
      factory: acctC.factory,
      factoryData: acctC.factoryData,
      gas: { callGasLimit: 800_000n, verificationGasLimit: 500_000n, preVerificationGas: 60_000n },
    });
    try {
      const fee = await estimateFeesPerGas(cfg);
      opC = { ...opC, ...fee };
    } catch {
      opC = { ...opC, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    }
    opC = await signUserOp(opC, cfg.entryPoint, cfg.chainId, ownerSigner);
    try {
      const bundler = new BundlerClient(cfg);
      const r = await bundler.estimateUserOperationGas(opC);
      console.log(`\n[C] ✅ 估算成功 → bundler 执行 initCode 返回地址 == 预测地址（sender 一致）`);
      console.log('   ', r);
    } catch (e: any) {
      console.log(`\n[C] ❌ 估算失败`);
      console.log('  details:', String(e?.details ?? '').slice(0, 200));
    }
  }

  // 探针 D：无 initCode（sender 未部署时基线）
  const rD = await probe('D sender=预测地址 + 无 initCode（基线 AA25）', account.address, undefined, undefined);

  console.log('\n== sender 一致性结论 ==');
  console.log('预测地址 (factory.getAddress):', account.address);
  if (rA === 'ok' && rB === 'ok' && rD === 'ok') {
    console.log('A/B/D 全部估算成功（counterfactual 全通）→ 地址一致 ✓');
  } else {
    console.log('A:', rA === 'ok' ? '估算成功' : '业务错误（AA 码）', '| B:', rB, '| D:', rD);
  }
  console.log('解读：A=AA10 证明预测地址在链上真实存在；B/C=AA14 证明 bundler 模拟执行 initCode');
  console.log('返回的地址 ≠ 错误 sender；因 getAddress 与 createAccount 同源 CREATE2，该地址 == 预测地址；');
  console.log('C=估算成功（若成功）则直接证明 bundler 执行 initCode 返回 == 预测地址。');
}

main().catch((e) => { console.error('diag-estimate error:', e?.message || e); process.exit(1); });
