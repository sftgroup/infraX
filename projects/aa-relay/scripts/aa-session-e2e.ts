// ============================================================================
// E-3a/b 链上 E2E（OxaChain 19505）：Kernel v3 ENABLE-mode session 全流程
// owner=用户 EOA（随机生成）→ 激活 Kernel 账户 → 注资（gas + entrypoint deposit）→
// 创建 session（SDK 本地生成 session key + 策略）→ owner 签 ENABLE digest 上链
// （ENABLE-mode：一次 UserOp 完成模块安装 + 授权）→ agent 用 session key 经
// DEFAULT-mode validator nonce 路由调用成功 → 链下 validate 一致 → owner 签
// disable（root-mode uninstallModule）上链 → agent 再调用被链上拒绝。
//
// 发送路径：EntryPoint.handleOps 直接交易（deployer 发起）。
//   ⚠️ 当前 OxaChain 上 Pimlico bundler（43.159.60.46:4338）协议为 v0.6，
//      与链上 v0.7 EntryPoint 不匹配，eth_sendUserOperation 一律 FailedOp
//      （schema 校验确认：要求 callGasLimit/maxFeePerGas 等 v0.6 字段）。
//      故 E2E 走 handleOps 直接上链，绕过 bundler 前置检查。
//
// 依赖：部署钱包私钥（env OXACHAIN_DEPLOYER_PRIVATE_KEY，gas 来源 + 收件人）。
// 用法：set -a; source /tmp/aa-e2e-env.b64.txt; set +a; npx tsx scripts/aa-session-e2e.ts
// ============================================================================
import { createWalletClient, http, parseAbi, encodeFunctionData, decodeErrorResult, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  getChainConfig,
  createKernelAccount,
  PrivateKeySigner,
  createAAClient,
  buildUserOp,
  signUserOp,
  estimateFeesPerGas,
  encodeDisableSessionCall,
  createSessionKey,
  buildEnableSessionUserOp,
  signEnableUserOp,
  buildSessionUserOp,
  packUserOpV7,
  validateSessionCall,
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
const GetNonceAbi = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)']);
const IsModuleInstalledAbi = parseAbi(['function isModuleInstalled(uint256,address,bytes) view returns (bool)']);
const CurrentNonceAbi = parseAbi(['function currentNonce() view returns (uint32)']);
const ApproveData = encodeFunctionData({ abi: parseAbi(['function approve(address spender, uint256 amount)']), functionName: 'approve', args: [zeroAddress, 0n] });

const FALLBACK_GAS = { callGasLimit: 1_500_000n, verificationGasLimit: 600_000n, preVerificationGas: 60_000n };

let passed = 0, failed = 0;
const results: string[] = [];
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { passed++; results.push(`  ok ${name}`); }
  else { failed++; results.push(`  FAIL ${name} ${extra}`); }
};

async function getNonce(addr: Address, key: bigint): Promise<bigint> {
  return publicClient.readContract({ address: cfg.entryPoint, abi: GetNonceAbi, functionName: 'getNonce', args: [addr, key] }) as Promise<bigint>;
}

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
      if (Array.isArray(c?.cause)) next.push(...c.cause);
      else if (c?.cause) next.push(c.cause);
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

async function main() {
  console.log('== E-3a/b Kernel v3 ENABLE-mode session 链上 E2E（OxaChain）==');
  console.log('deployer:', deployer.address, '| entrypoint:', cfg.entryPoint, '| sessionModule:', cfg.sessionModule);

  // ① 账户预测 + 注资 + 激活（owner EOA）+ entrypoint deposit
  const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  const addr = account.address;
  console.log('\n[1] owner:', owner.address, '→ smart account:', addr, '| deployed:', account.isDeployed);
  const fund = 5n * 10n ** 15n; // 0.005 OXA 账户 native 余额（handleOps 交易由 deployer 付，deposit 用于 op 内部 prefund）
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

  // deposit 覆盖全部 op prefund（3 笔 × ~0.007 OXA）+ 余量
  const depositData = encodeFunctionData({ abi: parseAbi(['function depositTo(address)']), functionName: 'depositTo', args: [addr] });
  const dtx2 = await walletClient.sendTransaction({ account: deployer, to: cfg.entryPoint, data: depositData, value: 3n * 10n ** 16n });
  await publicClient.waitForTransactionReceipt({ hash: dtx2 });
  const epBal = await publicClient.readContract({ address: cfg.entryPoint, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [addr] }) as bigint;
  check('entrypoint deposit 注资成功', epBal >= 3n * 10n ** 16n, `deposit ${Number(epBal) / 1e18} OXA`);

  // ② 创建 session（SDK 本地生成 session key + 策略）
  console.log('\n[2] 创建 session（session key + 策略）');
  const sess = await createSessionKey(
    {
      network: 'evm',
      validAfter: 0n,
      validUntil: BigInt(NOW + 3600),
      permissions: [{ targets: [TARGET], selectors: ['0x095ea7b3'], valueLimit: 10n ** 18n }],
    },
    addr,
  );
  if (!sess.privateKey) throw new Error('session key 生成失败');
  const agentSigner = new PrivateKeySigner(sess.privateKey);
  check('创建 session 成功', !!sess.policy.sessionId && sess.policy.signer === agentSigner.address, `sessionId ${sess.policy.sessionId.slice(0, 18)}…`);

  // fee 必须先于签名确定（userOpHash 依赖 gas/fee 字段；签名后再改 fee 会导致链上 AA24 signature error）
  let FEE;
  try { FEE = await estimateFeesPerGas(cfg); } catch { FEE = { maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; }
  const GAS = { ...FALLBACK_GAS, ...FEE };

  // ③ ENABLE-mode enable：构造 + 签名 + handleOps 直接上链
  console.log('\n[3] owner ENABLE-mode enableSession → handleOps 上链');
  const draft = await buildEnableSessionUserOp({
    client: publicClient,
    chainConfig: cfg,
    account: addr,
    policy: sess.policy,
    benignCall: { target: TARGET, value: 0n, data: ApproveData },
    gas: GAS,
  });
  const enableOp = await signEnableUserOp({ chainConfig: cfg, draft, ownerSigner, agentSigner });
  console.log('  nonce =', enableOp.nonce.toString(16).slice(0, 20), '… | digest =', draft.digest.slice(0, 18), '… | fee =', enableOp.maxFeePerGas.toString());
  const { rc: enableRc, tx: enableTx } = await sendHandleOps(enableOp);
  check('enableSession（ENABLE-mode）上链 success', enableRc.status === 'success', `tx ${enableTx}`);

  const installed = await publicClient.readContract({ address: addr, abi: IsModuleInstalledAbi, functionName: 'isModuleInstalled', args: [1n, cfg.sessionModule!, '0x'] }) as boolean;
  check('session module 已安装', installed === true, `isModuleInstalled=${installed}`);
  const nonceAfter = await publicClient.readContract({ address: addr, abi: CurrentNonceAbi, functionName: 'currentNonce' }) as number;
  // Kernel v3：currentNonce 初始=1；首次 enable（vId 未装过）不递增（_installValidation 仅在同 nonce 重装时递增）
  check('currentNonce 行为正确（首次 enable 不递增）', Number(nonceAfter) === Number(draft.currentNonce), `${draft.currentNonce} → ${nonceAfter}`);

  // ④ agent（session key）调用：nonce 路由到 DEFAULT-mode validator key
  console.log('\n[4] agent（session key）调用白名单 target (approve)');
  const agentOp = await buildSessionUserOp({
    client: publicClient,
    chainConfig: cfg,
    account: addr,
    sessionId: sess.policy.sessionId,
    agentSigner,
    call: { target: TARGET, value: 0n, data: ApproveData },
    gas: GAS,
  });
  console.log('  agent nonce =', agentOp.nonce.toString(16).slice(0, 20), '…');
  const { rc: agentRc, tx: agentTx } = await sendHandleOps(agentOp);
  check('agent 调用成功（session validator 放行）', agentRc.status === 'success', `tx ${agentTx}`);

  // ⑤ 链下预检一致（E-3b）
  const v = validateSessionCall(
    sess.policy,
    { target: TARGET, selector: '0x095ea7b3', value: 0n },
    BigInt(Math.floor(Date.now() / 1000)),
  );
  check('链下 validate 与链上一致（allowed）', v.ok === true, v.reason ?? '');

  // ⑥ disable：owner 签 root-mode op（uninstallModule）上链
  console.log('\n[5] owner disableSession → 链上 uninstallModule');
  const disableCallData = encodeDisableSessionCall({ accountAddress: addr, sessionId: sess.policy.sessionId, chainConfig: cfg });
  const rootNonce = await getNonce(addr, 0n);
  const disBase = buildUserOp({ sender: addr, nonce: rootNonce, call: { target: addr, value: 0n, data: '0x' }, gas: GAS });
  const disOp = await signUserOp({ ...disBase, callData: disableCallData }, cfg.entryPoint, cfg.chainId, ownerSigner);
  const { rc: disRc, tx: disTx } = await sendHandleOps(disOp);
  check('disableSession 上链 success', disRc.status === 'success', `tx ${disTx}`);
  const installed2 = await publicClient.readContract({ address: addr, abi: IsModuleInstalledAbi, functionName: 'isModuleInstalled', args: [1n, cfg.sessionModule!, '0x'] }) as boolean;
  check('session module 已卸载', installed2 === false, `isModuleInstalled=${installed2}`);

  // ⑦ agent 撤销后再调用 → 链上拒绝（validateUserOp revert）
  console.log('\n[6] agent 撤销后再调用 → 应被链上拒绝');
  const deniedOp = await buildSessionUserOp({
    client: publicClient,
    chainConfig: cfg,
    account: addr,
    sessionId: sess.policy.sessionId,
    agentSigner,
    call: { target: TARGET, value: 0n, data: ApproveData },
    gas: GAS,
  });
  const deniedPacked = packUserOpV7(deniedOp);
  try {
    await publicClient.call({
      to: cfg.entryPoint,
      data: encodeFunctionData({ abi: HandleOpsAbi, functionName: 'handleOps', args: [[deniedPacked], deployer.address] }),
    });
    check('agent 撤销后调用被拒', false, 'handleOps 未 revert（意外放行）');
  } catch {
    check('agent 撤销后调用被拒（链上 revert）', true);
  }

  console.log('\n=== E-3a/b Kernel v3 ENABLE-mode 链上 E2E 结果 ===');
  results.forEach((r) => console.log(r));
  console.log(`\n通过 ${passed} / ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e: any) => {
  console.error('main error:', e?.message || e);
  console.error('stack:', String(e?.stack ?? '').slice(0, 800));
  process.exit(1);
});
