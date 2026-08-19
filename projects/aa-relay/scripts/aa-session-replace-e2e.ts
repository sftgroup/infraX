// ============================================================================
// AA-7 链上 E2E（OxaChain 19505）：验证"单笔轮换 batch"彻底解决 AA23
// （Kernel v3 单 Session 结构下重复 enable 自动续订失败）问题。
//
// 流程：
//   [1] 随机 owner → 激活 Kernel 账户 → 注资（gas + entrypoint deposit）
//   [2] enable session A（ENABLE-mode 一次 UserOp 安装 + 授权）→ 成功
//   [3] 复现 AA23：不卸载 A 直接第二次 enable session B → 链上 revert
//       （InvalidNonce / 模块已安装 —— 即"重复 enable 失败"的根因）
//   [4] AA-7 replace 轮换：buildReplaceSessionUserOp（一次 UserOp =
//       uninstall A + invalidateNonce(cur+1) + install B）→ owner 签 root-mode → 成功
//   [5] agent B（新 session key）调用白名单 target → 成功（B 已生效）
//   [6] agent A（旧 session key）调用 → 被拒（A 已彻底撤销）
//
// 发送路径：EntryPoint.handleOps 直接交易（deployer 发起，绕过 bundler v0.6 协议限制）。
// 依赖：env AA_OXACHAIN_*（链配置）+ OXACHAIN_DEPLOYER_PRIVATE_KEY（gas 来源）。
// 用法：set -a; source /tmp/aa-e2e.env; set +a; export OXACHAIN_DEPLOYER_PRIVATE_KEY=<deployer pk>;
//       npx tsx scripts/aa-session-replace-e2e.ts
// ============================================================================
import { createWalletClient, http, parseAbi, encodeFunctionData, decodeErrorResult, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  getChainConfig,
  createKernelAccount,
  PrivateKeySigner,
  createAAClient,
  signUserOp,
  estimateFeesPerGas,
  createSessionKey,
  buildEnableSessionUserOp,
  signEnableUserOp,
  buildSessionUserOp,
  buildReplaceSessionUserOp,
  packUserOpV7,
  type UserOperationV7,
} from '../../aa-sdk/src/index.js';

const cfg = getChainConfig('oxachain', process.env);
const DEPLOYER_KEY = process.env.OXACHAIN_DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!DEPLOYER_KEY) throw new Error('env OXACHAIN_DEPLOYER_PRIVATE_KEY required (funding source)');

const chain = {
  id: cfg.chainId,
  name: 'OxaChain',
  nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpcUrl] } },
};
const publicClient = createAAClient(cfg);
const walletClient = createWalletClient({ chain, transport: http(cfg.rpcUrl) });

const deployer = privateKeyToAccount(DEPLOYER_KEY);
const ownerKey = generatePrivateKey(); // 测试 owner EOA（每次新建账户，零残留）
const owner = privateKeyToAccount(ownerKey);
const ownerSigner = new PrivateKeySigner(ownerKey);

const TARGET = '0x1111111111111111111111111111111111111111' as Address; // 白名单 target（无代码，approve 空调用无副作用）
const NOW = Math.floor(Date.now() / 1000);

const HandleOpsAbi = parseAbi([
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[],address beneficiary)',
]);
const IsModuleInstalledAbi = parseAbi(['function isModuleInstalled(uint256,address,bytes) view returns (bool)']);
const ApproveData = encodeFunctionData({ abi: parseAbi(['function approve(address spender, uint256 amount)']), functionName: 'approve', args: [zeroAddress, 0n] });

// replace 为 3 段批量 execute（uninstall + invalidateNonce + install），callGas 需更大
const FALLBACK_GAS = { callGasLimit: 3_000_000n, verificationGasLimit: 600_000n, preVerificationGas: 60_000n };
const AGENT_GAS = { callGasLimit: 1_500_000n, verificationGasLimit: 600_000n, preVerificationGas: 60_000n };

let passed = 0, failed = 0;
const results: string[] = [];
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { passed++; results.push(`  ok ${name}`); }
  else { failed++; results.push(`  FAIL ${name} ${extra}`); }
};

/** BFS 打印错误 cause 链并解码 FailedOp/Error revert（viem 错误结构：cause 可能是数组） */
function decodeRevert(e: any): void {
  const seen = new Set<any>();
  let queue: any[] = Array.isArray(e?.cause) ? e.cause : [e?.cause];
  let depth = 0;
  const tryDecode = (data: unknown, tag: string) => {
    if (typeof data !== 'string' || !data.startsWith('0x') || data === '0x') return;
    console.log(`  ${tag} data:`, data.slice(0, 160));
    for (const sig of ['FailedOp(uint256,string)', 'FailedOp(uint256)', 'Error(string)']) {
      try {
        const d = decodeErrorResult({ abi: parseAbi([`error ${sig}`]), data: data as Hex });
        console.log(`  ${tag} decoded ${sig}:`, JSON.stringify(d.args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 300));
      } catch { /* try next */ }
    }
  };
  tryDecode(e?.data ?? e?.cause?.data, 'revert');
  while (queue.length && depth < 10) {
    const next: any[] = [];
    for (const c of queue) {
      if (!c || seen.has(c)) continue;
      seen.add(c);
      tryDecode(c?.data, `cause[${depth}]`);
      if (Array.isArray(c?.cause)) next.push(...c.cause); else if (c?.cause) next.push(c.cause);
    }
    queue = next;
    depth++;
  }
}

/** UserOp → EntryPoint.handleOps 直接交易（deployer 发起，beneficiary=deployer 闭环 gas） */
async function sendHandleOps(op: UserOperationV7) {
  const packed = packUserOpV7(op);
  const data = encodeFunctionData({
    abi: HandleOpsAbi,
    functionName: 'handleOps',
    args: [[packed], deployer.address],
  });
  // eth_call 预演：失败时立即暴露 FailedOp 真实原因（不消耗 gas）
  try {
    await publicClient.call({ to: cfg.entryPoint, data });
  } catch (e: any) {
    console.log('  ⚠️ eth_call 预演 revert:');
    decodeRevert(e);
    throw e;
  }
  const tx = await walletClient.sendTransaction({ account: deployer, to: cfg.entryPoint, data, value: 0n });
  const rc = await publicClient.waitForTransactionReceipt({ hash: tx });
  return { tx, rc };
}

/** 仅 eth_call 预演（预期 revert 的路径用）：返回是否 revert + revert 详情 */
async function dryRunHandleOps(op: UserOperationV7): Promise<{ reverted: boolean; error?: any }> {
  const packed = packUserOpV7(op);
  const data = encodeFunctionData({
    abi: HandleOpsAbi,
    functionName: 'handleOps',
    args: [[packed], deployer.address],
  });
  try {
    await publicClient.call({ to: cfg.entryPoint, data });
    return { reverted: false };
  } catch (e: any) {
    return { reverted: true, error: e };
  }
}

async function isModuleInstalled(addr: Address): Promise<boolean> {
  return publicClient.readContract({
    address: addr,
    abi: IsModuleInstalledAbi,
    functionName: 'isModuleInstalled',
    args: [1n, cfg.sessionModule!, '0x'],
  }) as Promise<boolean>;
}

async function main() {
  console.log('== AA-7 单笔轮换 batch 链上 E2E（OxaChain）==');
  console.log('deployer:', deployer.address, '| entrypoint:', cfg.entryPoint, '| sessionModule:', cfg.sessionModule);

  // [1] 账户预测 + 注资 + 激活 + entrypoint deposit
  const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  const addr = account.address;
  console.log('\n[1] owner:', owner.address, '→ smart account:', addr, '| deployed:', account.isDeployed);
  const fund = 2n * 10n ** 16n; // 0.02 OXA 账户 native 余额
  const ftx = await walletClient.sendTransaction({ account: deployer, to: addr, value: fund });
  await publicClient.waitForTransactionReceipt({ hash: ftx });
  check('注资成功（deployer → 账户）', (await publicClient.getBalance({ address: addr })) >= fund, `tx ${ftx}`);

  if (!account.isDeployed) {
    const dtx = await walletClient.sendTransaction({ account: deployer, to: account.factory as Address, data: account.factoryData as Hex, value: 0n });
    await publicClient.waitForTransactionReceipt({ hash: dtx });
    console.log('  deploy tx:', dtx);
  }
  const codeAfter = await publicClient.getCode({ address: addr });
  check('激活（factory 直接部署）成功', codeAfter !== undefined && codeAfter !== '0x');

  // deposit 覆盖全部 op prefund（3 笔 × 大 gas）+ 余量
  const depositData = encodeFunctionData({ abi: parseAbi(['function depositTo(address)']), functionName: 'depositTo', args: [addr] });
  const dtx2 = await walletClient.sendTransaction({ account: deployer, to: cfg.entryPoint, data: depositData, value: 15n * 10n ** 16n });
  await publicClient.waitForTransactionReceipt({ hash: dtx2 });
  const epBal = await publicClient.readContract({ address: cfg.entryPoint, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [addr] }) as bigint;
  check('entrypoint deposit 注资成功', epBal >= 15n * 10n ** 16n, `deposit ${Number(epBal) / 1e18} OXA`);

  // fee 必须先于签名确定（userOpHash 依赖 gas/fee 字段；签名后再改 fee 会导致链上 AA24 signature error）
  let FEE;
  try { FEE = await estimateFeesPerGas(cfg); } catch { FEE = { maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; }

  // [2] session A：创建 + ENABLE-mode enable
  console.log('\n[2] enable session A（ENABLE-mode）→ handleOps 上链');
  const sessA = await createSessionKey(
    {
      network: 'evm',
      validAfter: 0n,
      validUntil: BigInt(NOW + 3600),
      permissions: [{ targets: [TARGET], selectors: ['0x095ea7b3'], valueLimit: 10n ** 18n }],
    },
    addr,
  );
  if (!sessA.privateKey) throw new Error('session A key 生成失败');
  const agentASigner = new PrivateKeySigner(sessA.privateKey);
  const draftA = await buildEnableSessionUserOp({
    client: publicClient,
    chainConfig: cfg,
    account: addr,
    policy: sessA.policy,
    benignCall: { target: TARGET, value: 0n, data: ApproveData },
    gas: { ...AGENT_GAS, ...FEE },
  });
  const enableA = await signEnableUserOp({ chainConfig: cfg, draft: draftA, ownerSigner, agentSigner: agentASigner });
  console.log('  sessionA:', sessA.policy.sessionId.slice(0, 18), '… | agentA:', agentASigner.address);
  const { rc: rcA, tx: txA } = await sendHandleOps(enableA);
  check('enable A 上链 success', rcA.status === 'success', `tx ${txA}`);
  check('session module 已安装（A 生效）', await isModuleInstalled(addr) === true);

  // [3] 复现 AA23：不卸载 A 直接第二次 enable session B → 应被链上拒绝
  console.log('\n[3] 复现 AA23：不卸载 A 直接第二次 enable session B → 应 revert');
  const sessB = await createSessionKey(
    {
      network: 'evm',
      validAfter: 0n,
      validUntil: BigInt(NOW + 3600),
      permissions: [{ targets: [TARGET], selectors: ['0x095ea7b3'], valueLimit: 10n ** 18n }],
    },
    addr,
  );
  if (!sessB.privateKey) throw new Error('session B key 生成失败');
  const agentBSigner = new PrivateKeySigner(sessB.privateKey);
  const draftB = await buildEnableSessionUserOp({
    client: publicClient,
    chainConfig: cfg,
    account: addr,
    policy: sessB.policy,
    benignCall: { target: TARGET, value: 0n, data: ApproveData },
    gas: { ...AGENT_GAS, ...FEE },
  });
  const enableB = await signEnableUserOp({ chainConfig: cfg, draft: draftB, ownerSigner, agentSigner: agentBSigner });
  console.log('  sessionB:', sessB.policy.sessionId.slice(0, 18), '… | agentB:', agentBSigner.address);
  const dryB = await dryRunHandleOps(enableB);
  if (dryB.reverted) {
    decodeRevert(dryB.error);
    check('重复 enable 被链上拒绝（AA23 复现）', true);
  } else {
    check('重复 enable 被链上拒绝（AA23 复现）', false, 'handleOps 未 revert（意外放行）');
  }

  // [4] AA-7 replace 轮换：uninstall A + invalidateNonce(cur+1) + install B，一次 UserOp
  console.log('\n[4] AA-7 replace 轮换（uninstall A + invalidateNonce + install B）→ handleOps 上链');
  const replaceDraft = await buildReplaceSessionUserOp({
    client: publicClient,
    chainConfig: cfg,
    account: addr,
    oldSessionId: sessA.policy.sessionId,
    policy: sessB.policy,
    gas: { ...FALLBACK_GAS, ...FEE },
  });
  console.log('  replace nonce =', replaceDraft.op.nonce.toString(16).slice(0, 20), '… | currentNonce =', replaceDraft.currentNonce);
  const replaceOp = await signUserOp(replaceDraft.op, cfg.entryPoint, cfg.chainId, ownerSigner);
  const { rc: rcR, tx: txR } = await sendHandleOps(replaceOp);
  check('replace 轮换上链 success', rcR.status === 'success', `tx ${txR}`);
  check('replace 后 session module 仍已安装（B 生效）', await isModuleInstalled(addr) === true);

  // [5] agent B（新 session key）调用 → 成功
  console.log('\n[5] agent B（新 session key）调用白名单 target → 应成功');
  const agentBOp = await buildSessionUserOp({
    client: publicClient,
    chainConfig: cfg,
    account: addr,
    sessionId: sessB.policy.sessionId,
    agentSigner: agentBSigner,
    call: { target: TARGET, value: 0n, data: ApproveData },
    gas: { ...AGENT_GAS, ...FEE },
  });
  const { rc: rcB, tx: txB } = await sendHandleOps(agentBOp);
  check('agent B 调用成功（新 session 已生效）', rcB.status === 'success', `tx ${txB}`);

  // [6] agent A（旧 session key）调用 → 被拒（A 已 uninstall）
  console.log('\n[6] agent A（旧 session key）调用 → 应被链上拒绝');
  const agentAOp = await buildSessionUserOp({
    client: publicClient,
    chainConfig: cfg,
    account: addr,
    sessionId: sessA.policy.sessionId,
    agentSigner: agentASigner,
    call: { target: TARGET, value: 0n, data: ApproveData },
    gas: { ...AGENT_GAS, ...FEE },
  });
  const dryA = await dryRunHandleOps(agentAOp);
  if (dryA.reverted) {
    decodeRevert(dryA.error);
    check('agent A 调用被拒（旧 session 已彻底撤销）', true);
  } else {
    check('agent A 调用被拒（旧 session 已彻底撤销）', false, 'handleOps 未 revert（意外放行）');
  }

  console.log('\n=== AA-7 单笔轮换 batch 链上 E2E 结果 ===');
  results.forEach((r) => console.log(r));
  console.log(`\n通过 ${passed} / ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e: any) => {
  console.error('main error:', e?.message || e);
  console.error('stack:', String(e?.stack ?? '').slice(0, 800));
  process.exit(1);
});
