// ============================================================================
// 真实链上验证：自建 VerifyingPaymaster 代付（P-5，OxaChain 19505）
// 流程：生成 owner → 部署智能账户（deployer 直接 sendTransaction 调 factory，
//       注：bundler 模拟 initCode 在本环境 AA13，绕开）→
//       PaymasterClient(stub→estimate→data) 填充 paymasterAndData →
//       owner 签名 → bundler 广播 → 验证 receipt success +
//       sender 余额不变（未扣 gas）+ EntryPoint balanceOf(paymaster) 减少。
// 用法：cd projects/aa-relay && npx tsx scripts/aa-e2e-paymaster.ts
// env 需含 AA_OXACHAIN_* + PAYMASTER_ADDRESS + AA_PAYMASTER_DEPLOY_PK
// ============================================================================
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  getChainConfig, createKernelAccount, PrivateKeySigner, BundlerClient, buildUserOp, estimateFeesPerGas,
  encodeExecute, PaymasterClient, signUserOp,
} from '../../aa-sdk/src/index.js';

const cfg = getChainConfig('oxachain', process.env);
const chain = { id: cfg.chainId, name: 'Oxa', nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const bundler = new BundlerClient(cfg);

// 直连 signer 服务（内网，Pimlico 协议）；relay 代理链路已单独验证（aa-relay /v1/paymaster）
const paymaster = new PaymasterClient(
  { type: 'pimlico', url: process.env.PAYMASTER_DIRECT_URL || 'http://127.0.0.1:9134' },
);
const pmCtx = { chain: 'oxachain', entryPoint: cfg.entryPoint as Address, chainId: cfg.chainId };

const TARGET = '0x3333333333333333333333333333333333333333' as Address; // 白名单 target（无代码）
const FALLBACK_GAS = { callGasLimit: 1_500_000n, verificationGasLimit: 3_000_000n, preVerificationGas: 60_000n };

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { passed++; console.log(`  ok ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};

const entryPointAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const kernelAbi = parseAbi(['function currentNonce() view returns (uint32)']);

async function main() {
  console.log('== 自建 VerifyingPaymaster 代付 链上验证 ==');
  console.log('paymaster url  :', paymaster.endpoint);
  console.log('entryPoint     :', cfg.entryPoint);

  const ownerKey = generatePrivateKey();
  const owner = new PrivateKeySigner(ownerKey);
  const account = await createKernelAccount({ owner: new PrivateKeySigner(ownerKey), chainConfig: cfg });
  const addr = account.address;
  console.log('\n[1] smart account:', addr, '| deployed:', account.isDeployed, '| owner:', owner.address);

  // 未部署 → deployer 直接调 factory 部署（bundler initCode 模拟本环境 AA13，走已验证的直部署路径）
  const walletClient = createWalletClient({ chain, transport: http(cfg.rpcUrl) });
  if (!account.isDeployed) {
    if (!process.env.AA_PAYMASTER_DEPLOY_PK) throw new Error('env AA_PAYMASTER_DEPLOY_PK required（部署智能账户）');
    const deployer = privateKeyToAccount(process.env.AA_PAYMASTER_DEPLOY_PK as Address);
    const dtx = await walletClient.sendTransaction({ account: deployer, to: account.factory!, data: account.factoryData!, value: 0n });
    await publicClient.waitForTransactionReceipt({ hash: dtx });
    const code = await publicClient.getCode({ address: addr });
    console.log('  部署 tx', dtx, '| codeLen', String(code).length);
  }

  // 部署前 sender 余额 = 0（paymaster 全程代付，sender 无需任何 OXA）
  const balBefore = await publicClient.getBalance({ address: addr });
  const entryBalBefore = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'balanceOf', args: [process.env.PAYMASTER_ADDRESS as Address] });

  // [2] 构造 UserOp：0 值 approve 到 TARGET（无资金需求）
  console.log('\n[2] 构造 UserOp（0 值 approve → TARGET）');
  const nonce = account.isDeployed
    ? await publicClient.readContract({ address: addr, abi: kernelAbi, functionName: 'currentNonce' }) as number
    : 0n;
  let op: any = buildUserOp({
    sender: addr,
    nonce: typeof nonce === 'number' ? BigInt(nonce) : nonce,
    call: { target: addr, value: 0n, data: '0x' },
    // 账户已由 deployer 直部署，UserOp 无需 initCode（paymaster 只代付 UserOp 本身）
  });
  op = {
    ...op,
    callData: encodeExecute(TARGET, 0n, encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [addr, 0n] })),
    callGasLimit: FALLBACK_GAS.callGasLimit,
    verificationGasLimit: FALLBACK_GAS.verificationGasLimit,
    preVerificationGas: FALLBACK_GAS.preVerificationGas,
  };

  // [3] stub → 填充 paymaster 字段 → 估算 → 正式 data → 签名 → 广播
  console.log('\n[3] PaymasterClient 链路（stub → estimate → data）');
  const stub = await paymaster.getPaymasterStubData(op, pmCtx);
  op = { ...op, ...stub.op };
  console.log('  stub: paymaster =', op.paymaster, '| data len =', String(op.paymasterData).length, '| verificationGas =', op.paymasterVerificationGasLimit?.toString());

  try {
    const est = await bundler.estimateUserOperationGas(op);
    op = { ...op, ...est };
    console.log('  estimate OK:', JSON.stringify({ call: est.callGasLimit?.toString(), verify: est.verificationGasLimit?.toString(), pre: est.preVerificationGas?.toString() }));
  } catch (e: any) {
    console.log('  (estimate 失败，用兜底):', String(e?.message ?? '').slice(0, 500));
    if (e?.cause) console.log('  estimate cause:', JSON.stringify(e.cause, null, 2)?.slice(0, 800));
    op = { ...op, ...FALLBACK_GAS };
  }
  try { op = { ...op, ...await estimateFeesPerGas(cfg) }; }
  catch { op = { ...op, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; }

  const dataRes = await paymaster.getPaymasterData(op, pmCtx);
  op = { ...op, ...dataRes.op };
  console.log('  data: len =', String(op.paymasterData).length, '(期望 260 = 64B 时间戳 + 65B 签名 + 0x)');

  op = await signUserOp(op, cfg.entryPoint as Address, cfg.chainId, owner);
  check('paymaster 字段已填充', op.paymaster === process.env.PAYMASTER_ADDRESS, `got ${op.paymaster}`);
  check('paymasterData 长度 260', String(op.paymasterData).length === 260, `len ${String(op.paymasterData).length}`);

  // [4] 广播
  console.log('\n[4] 广播 UserOp → bundler');
  const res = await bundler.sendUserOperation(op, { waitTimeoutMs: 180_000 });
  check('receipt success（paymaster 代付上链）', res.receipt?.success === true, `userOp ${res.userOpHash} tx ${res.receipt?.txHash}`);
  console.log('  tx:', res.receipt?.txHash);

  // [5] 验证：sender 未扣 gas + paymaster 存款减少
  console.log('\n[5] 资金归属验证');
  const balAfter = await publicClient.getBalance({ address: addr });
  const entryBalAfter = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'balanceOf', args: [process.env.PAYMASTER_ADDRESS as Address] });
  check('sender 余额未变（gas 由 paymaster 承担）', balAfter === balBefore, `${balBefore} → ${balAfter}`);
  check('EntryPoint balanceOf(paymaster) 减少', entryBalAfter < entryBalBefore, `${entryBalBefore} → ${entryBalAfter}`);

  console.log('\n=== 结果 ===');
  console.log(`通过 ${passed} / ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e: any) => { console.error('main error:', e?.message || e); if (e?.cause) console.error('main cause:', JSON.stringify(e.cause, null, 2)?.slice(0, 1200)); console.error(e?.stack?.slice(0, 800)); process.exit(1); });
