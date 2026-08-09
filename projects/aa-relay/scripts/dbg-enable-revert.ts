// ============================================================================
// 临时调试：抓 ENABLE-mode enable UserOp 在 EntryPoint.handleOps 的真实 revert
// 复用 aa-e2e-enable-agent.ts 的 enable 构造 → 手工 pack v0.7 PackedUserOperation
// → eth_call 模拟 handleOps → 解码 revert（FailedOp reason / 自定义错误串）。
// ============================================================================
import { createWalletClient, http, encodeFunctionData, parseAbi, toHex, concatHex, encodeAbiParameters, decodeErrorResult, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  getChainConfig, createKernelAccount, PrivateKeySigner, estimateFeesPerGas,
  createAAClient, KernelV3SessionDataBuilder, encodeExecute,
} from '../../aa-sdk/src/index.js';
import { getUserOperationHash } from 'viem/account-abstraction';
import { keccak256, pad, stringToHex, concat } from 'viem';
import { randomBytes } from 'node:crypto';
import { bytesToHex } from 'viem';
import { userOpToRpc } from '../../aa-sdk/src/bundler.js';

const cfg = getChainConfig('oxachain', process.env);
const DEPLOYER_KEY = process.env.OXACHAIN_DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!DEPLOYER_KEY) throw new Error('env OXACHAIN_DEPLOYER_PRIVATE_KEY required');

const publicClient = createAAClient(cfg);
const deployer = privateKeyToAccount(DEPLOYER_KEY);
const ownerKey = generatePrivateKey(); // 每次全新 owner → 全新账户（零污染）
const ownerAcct = privateKeyToAccount(ownerKey);
const ownerSigner = new PrivateKeySigner(ownerKey);

const MODULE = cfg.sessionModule!;
const ENABLE_TYPEHASH = '0xb17ab1224aca0d4255ef8161acaf2ac121b8faa32a4b2258c912cc5f8308c505';
const ZERO_ONE_ADDR = '0x0000000000000000000000000000000000000001' as Address;
const TARGET = '0x3333333333333333333333333333333333333333' as Address;
const FALLBACK_GAS = { callGasLimit: 1_500_000n, verificationGasLimit: 600_000n, preVerificationGas: 60_000n };

const entryPointAbi = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)']);
const EIP712_DOMAIN_TYPEHASH = keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));

function domainSeparator(account: Address, chainId: number): Hex {
  return keccak256(concat([
    EIP712_DOMAIN_TYPEHASH,
    keccak256(stringToHex('Kernel')),
    keccak256(stringToHex('0.3.0-beta')),
    toHex(chainId, { size: 32 }),
    pad(account, { size: 32 }),
  ]));
}

function enableDigest(account: Address, chainId: number, vId: Hex, currentNonce: number, hook: Address, validatorData: Hex, hookData: Hex, selectorData: Hex): Hex {
  const structHash = keccak256(concat([
    ENABLE_TYPEHASH as Hex,
    pad(vId, { size: 32, dir: 'right' }),
    toHex(currentNonce, { size: 32 }),
    pad(hook, { size: 32 }),
    keccak256(validatorData),
    keccak256(hookData),
    keccak256(selectorData),
  ]));
  return keccak256(concat(['0x1901', domainSeparator(account, chainId), structHash]));
}

function encodeAsNonceKey(mode: number, vType: number, validator: Address, nonceKey: number): bigint {
  return (BigInt(mode) << 184n) | (BigInt(vType) << 176n) | (BigInt(validator) << 16n) | BigInt(nonceKey);
}

function decodeRevert(e: any): void {
  console.log('  revert name:', e?.shortMessage ?? e?.name, '| msg:', String(e?.message ?? '').slice(0, 400));
  const data: Hex | undefined = e?.data ?? e?.cause?.data;
  if (data && data !== '0x') {
    console.log('  revert data:', data.slice(0, 200));
    for (const sig of [
      'FailedOp(uint256,string)',
      'FailedOp(uint256)',
      'Error(string)',
    ]) {
      try {
        const d = decodeErrorResult({ abi: parseAbi([`error ${sig}`]), data });
        console.log(`  decoded ${sig}:`, JSON.stringify(d.args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      } catch { /* try next */ }
    }
  }
  // BFS cause 链
  const seen = new Set<any>();
  let queue: any[] = Array.isArray(e?.cause) ? e.cause : [e?.cause];
  let depth = 0;
  while (queue.length && depth < 8) {
    const next: any[] = [];
    for (const c of queue) {
      if (!c || seen.has(c)) continue;
      seen.add(c);
      if (c?.data && c.data !== '0x') {
        console.log(`  cause[${depth}] data:`, c.data.slice(0, 200));
        for (const sig of ['FailedOp(uint256,string)', 'Error(string)']) {
          try { const d = decodeErrorResult({ abi: parseAbi([`error ${sig}`]), data: c.data }); console.log(`   → decoded ${sig}:`, JSON.stringify(d.args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); } catch { /* noop */ }
        }
      }
      if (Array.isArray(c?.cause)) next.push(...c.cause); else if (c?.cause) next.push(c.cause);
    }
    queue = next; depth++;
  }
}

async function main() {
  console.log('== dbg: ENABLE-mode handleOps revert ==');
  const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  const addr = account.address;
  const wc = createWalletClient({ chain: { id: cfg.chainId, name: 'Oxa', nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } }, transport: http(cfg.rpcUrl) });

  // 注资 + factory 部署（全新账户）
  console.log('[0] owner:', ownerAcct.address, '| account:', addr, 'deployed:', account.isDeployed);
  if (!account.isDeployed) {
    const fund = 5n * 10n ** 16n;
    const ftx = await wc.sendTransaction({ account: deployer, to: addr, value: fund });
    await publicClient.waitForTransactionReceipt({ hash: ftx });
    const dtx = await wc.sendTransaction({ account: deployer, to: account.factory as Address, data: account.factoryData as Hex, value: 0n });
    await publicClient.waitForTransactionReceipt({ hash: dtx });
    console.log('  fund tx:', ftx, '| deploy tx:', dtx);
  }
  // 账户 entrypoint deposit 注资（支付 handleOps 的 op gas）
  const depositData = encodeFunctionData({ abi: parseAbi(['function depositTo(address)']), functionName: 'depositTo', args: [addr] });
  const dtx2 = await wc.sendTransaction({ account: deployer, to: cfg.entryPoint, data: depositData, value: 2n * 10n ** 17n });
  await publicClient.waitForTransactionReceipt({ hash: dtx2 });
  console.log('  depositTo tx:', dtx2);

  // ===== 尝试给账户 stake（Pimlico v0.7 可能要求 sender 有 stake）=====
  console.log('\n[stake 账户]');
  const MIN_STAKE = 3n * 10n ** 17n; // 0.3 OXA
  const STAKE_DELAY = 86400; // 1 day
  const stakeFund = await wc.sendTransaction({ account: deployer, to: addr, value: 5n * 10n ** 17n });
  await publicClient.waitForTransactionReceipt({ hash: stakeFund });
  const rootNonce0 = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [addr, 0n] }) as bigint;
  const stakeCallData = encodeExecute(cfg.entryPoint, MIN_STAKE, encodeFunctionData({ abi: parseAbi(['function addStake(uint32)']), functionName: 'addStake', args: [STAKE_DELAY] }));
  const stakeOpBase = {
    sender: addr, nonce: rootNonce0, callData: stakeCallData,
    callGasLimit: 1_500_000n, verificationGasLimit: 500_000n, preVerificationGas: 60_000n,
    maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, signature: '0x' as Hex,
  };
  const stakeHash = getUserOperationHash({ chainId: cfg.chainId, entryPointAddress: cfg.entryPoint, entryPointVersion: '0.7', userOperation: stakeOpBase as any });
  const stakeSig = await ownerAcct.signMessage({ message: { raw: stakeHash } });
  const stakeOp = { ...stakeOpBase, signature: stakeSig };
  const stakePacked = {
    sender: stakeOp.sender, nonce: stakeOp.nonce, initCode: '0x', callData: stakeOp.callData,
    accountGasLimits: concatHex([toHex(stakeOp.verificationGasLimit, { size: 16 }), toHex(stakeOp.callGasLimit, { size: 16 })]),
    preVerificationGas: stakeOp.preVerificationGas,
    gasFees: concatHex([toHex(stakeOp.maxPriorityFeePerGas, { size: 16 }), toHex(stakeOp.maxFeePerGas, { size: 16 })]),
    paymasterAndData: '0x', signature: stakeOp.signature,
  };
  const stakeHandleOps = encodeFunctionData({
    abi: parseAbi(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[],address)']),
    functionName: 'handleOps',
    args: [[stakePacked], '0x000000000000000000000000000000000000dEaD'],
  });
  try {
    const stx = await wc.sendTransaction({ account: deployer, to: cfg.entryPoint, data: stakeHandleOps, value: 0n });
    const src = await publicClient.waitForTransactionReceipt({ hash: stx });
    console.log('  stake handleOps tx:', stx, '| status:', src.status, '| gasUsed:', src.gasUsed?.toString());
  } catch (e: any) { console.log('  stake handleOps fail:', String(e?.message ?? e).slice(0, 150)); }
  const diStake = await publicClient.readContract({ address: cfg.entryPoint, abi: parseAbi(['function getDepositInfo(address) view returns (uint256,bool,uint112,uint32,uint48)']), functionName: 'getDepositInfo', args: [addr] }) as readonly [bigint, boolean, bigint, number, bigint];
  console.log('  account after stake:', JSON.stringify({ deposit: diStake[0].toString(), staked: diStake[1], stake: diStake[2].toString(), unstakeDelaySec: diStake[3] }));

  const currentNonce = await publicClient.readContract({ address: addr, abi: parseAbi(['function currentNonce() view returns (uint32)']), functionName: 'currentNonce' }) as number;

  const eKey = encodeAsNonceKey(0x01, 0x01, MODULE, 0);
  const vKey = encodeAsNonceKey(0x00, 0x01, MODULE, 0);
  const enableNonceNow = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [addr, eKey] }) as bigint;
  const validatorNonceNow = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [addr, vKey] }) as bigint;
  const rootNonceNow = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [addr, 0n] }) as bigint;
  console.log('[state] currentNonce=', currentNonce, '| enableKey nonce=', enableNonceNow.toString(16), '| validatorKey nonce=', validatorNonceNow.toString(16), '| rootKey nonce=', rootNonceNow.toString(16));
  console.log('        moduleInstalled=', await publicClient.readContract({ address: addr, abi: parseAbi(['function isModuleInstalled(uint256,address,bytes) view returns (bool)']), functionName: 'isModuleInstalled', args: [1n, MODULE, '0x'] }));

  // ERC-7562 排查：session module / factory 是否在 entrypoint 有 stake
  const stakeAbi = parseAbi(['function getDepositInfo(address) view returns (uint256,bool,uint112,uint32,uint48)']);
  for (const [name, a] of [['sessionModule', MODULE], ['factory', cfg.kernelFactory], ['account', addr]] as const) {
    try {
      const di = await publicClient.readContract({ address: cfg.entryPoint, abi: stakeAbi, functionName: 'getDepositInfo', args: [a] }) as readonly [bigint, boolean, bigint, number, bigint];
      console.log(`  stake[${name}]`, JSON.stringify({ deposit: di[0].toString(), staked: di[1], stake: di[2].toString(), unstakeDelaySec: di[3] }));
    } catch (e: any) { console.log(`  stake[${name}] query fail:`, String(e?.shortMessage ?? e?.message ?? e).slice(0, 120)); }
  }

  const sessionId = bytesToHex(randomBytes(32));
  const agentAcct = privateKeyToAccount(generatePrivateKey());
  const NOW = Math.floor(Date.now() / 1000);
  const policy = {
    network: 'evm' as const,
    sessionId,
    signer: agentAcct.address,
    validAfter: 0n,
    validUntil: BigInt(NOW + 3600),
    permissions: [{ targets: [TARGET], selectors: ['0x095ea7b3'], valueLimit: 10n ** 18n }],
  };
  const enable6 = KernelV3SessionDataBuilder.enableData(policy as any);
  const approveData = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [ZERO_ONE_ADDR, 0n] });
  const validationId = concatHex(['0x01', MODULE]);
  const executeSelector = encodeExecute(TARGET, 0n, '0x').slice(0, 10) as Hex;

  const enableNonce = enableNonceNow;
  const callData = encodeExecute(TARGET, 0n, approveData);
  const opBase = {
    sender: addr, nonce: enableNonce, callData,
    callGasLimit: FALLBACK_GAS.callGasLimit, verificationGasLimit: FALLBACK_GAS.verificationGasLimit, preVerificationGas: FALLBACK_GAS.preVerificationGas,
    maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, signature: '0x' as Hex,
  };
  const userOpHash = getUserOperationHash({ chainId: cfg.chainId, entryPointAddress: cfg.entryPoint, entryPointVersion: '0.7', userOperation: opBase as any });
  const digest = enableDigest(addr, cfg.chainId, validationId, currentNonce, ZERO_ONE_ADDR, enable6, '0xff', executeSelector);
  const enableSig = await ownerAcct.signMessage({ message: { raw: digest } });
  const agentSig = await agentAcct.signMessage({ message: { raw: userOpHash } });
  const userOpSig = concatHex([sessionId, agentSig]);
  const encoded5 = encodeFunctionData({ abi: parseAbi(['function x(bytes,bytes,bytes,bytes,bytes)']), functionName: 'x', args: [enable6, '0xff', executeSelector, enableSig, userOpSig] });
  const signature = concatHex([ZERO_ONE_ADDR, encoded5.slice(10) as Hex]);
  const op = { ...opBase, signature };

  console.log('[op] sender=', op.sender, 'nonce=', enableNonce.toString(16), '| userOpHash=', userOpHash.slice(0, 18), '| sigLen=', signature.length);

  // v0.7 PackedUserOperation 单 tuple 结构化编码（避免手工数组错位）
  const packedOp = {
    sender: op.sender,
    nonce: op.nonce,
    initCode: '0x',
    callData: op.callData,
    accountGasLimits: concatHex([toHex(op.verificationGasLimit, { size: 16 }), toHex(op.callGasLimit, { size: 16 })]),
    preVerificationGas: op.preVerificationGas,
    gasFees: concatHex([toHex(op.maxPriorityFeePerGas, { size: 16 }), toHex(op.maxFeePerGas, { size: 16 })]),
    paymasterAndData: '0x',
    signature: op.signature,
  };
  const handleOpsData = encodeFunctionData({
    abi: parseAbi([
      'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[],address beneficiary)',
    ]),
    functionName: 'handleOps',
    args: [[packedOp], '0x000000000000000000000000000000000000dEaD'],
  });

  try {
    const r = await publicClient.call({ to: cfg.entryPoint, data: handleOpsData });
    console.log('handleOps eth_call 未 revert，return:', r.data);
  } catch (e: any) {
    console.log('handleOps eth_call revert:');
    decodeRevert(e);
  }

  // ===== 抓 bundler 发送前检查的真实 revert：eth_call 调 entrypoint.simulateValidation =====
  console.log('\n[entrypoint.simulateValidation（eth_call）]');
  const simValData = encodeFunctionData({
    abi: parseAbi([
      'function simulateValidation((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature))',
    ]),
    functionName: 'simulateValidation',
    args: [packedOp],
  });
  try {
    const r = await publicClient.call({ to: cfg.entryPoint, data: simValData });
    console.log('  simulateValidation 未 revert（异常，应 revert SimulationResult）:', r.data?.slice(0, 100));
  } catch (e: any) {
    const data: Hex | undefined = e?.data ?? e?.cause?.data;
    console.log('  simulateValidation revert data:', data ? data.slice(0, 120) : '(无 data)');
    if (data && data !== '0x') {
      for (const sig of ['FailedOp(uint256,string)', 'FailedOp(uint256)', 'Error(string)', 'SimulationResult(bytes)', 'SimulationResultWithAggregator(bytes,address)']) {
        try { const d = decodeErrorResult({ abi: parseAbi([`error ${sig}`]), data }); console.log(`   decoded ${sig}:`, JSON.stringify(d.args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 300)); } catch { /* try next */ }
      }
      // FailedOp reason 常在 returnData 里，尝试二级解码
      if (data.startsWith('0xee398dcd')) { // FailedOp selector 可能不同，跳过
      }
    }
    console.log('  full msg:', String(e?.shortMessage ?? e?.message ?? '').slice(0, 200));
  }

  // bundler 发送前路径：eth_simulateValidation（v0.7，成功时 revert SimulationResult；失败时 FailedOp revert 带 data）
  console.log('\n[eth_simulateValidation]');
  const packedRpc = {
    sender: packedOp.sender,
    nonce: toHex(packedOp.nonce),
    initCode: packedOp.initCode,
    callData: packedOp.callData,
    accountGasLimits: packedOp.accountGasLimits,
    preVerificationGas: toHex(packedOp.preVerificationGas),
    gasFees: packedOp.gasFees,
    paymasterAndData: packedOp.paymasterAndData,
    signature: packedOp.signature,
  };
  const simResp = await fetch(cfg.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_simulateValidation',
      params: [[packedRpc], cfg.entryPoint],
    }),
  });
  const simText = await simResp.text();
  console.log('  http status:', simResp.status, '| body:', simText.slice(0, 700));
  try {
    const simJ = JSON.parse(simText);
    if (simJ?.error?.data) {
      console.log('  error.data =', simJ.error.data.slice(0, 200));
      for (const sig of ['FailedOp(uint256,string)', 'FailedOp(uint256)', 'Error(string)']) {
        try {
          const d = decodeErrorResult({ abi: parseAbi([`error ${sig}`]), data: simJ.error.data });
          console.log(`   decoded ${sig}:`, JSON.stringify(d.args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
        } catch { /* try next */ }
      }
    }
  } catch { /* non-JSON */ }

  // 对照：同样的 op 交给 bundler 估算（此前通过），再对比发送失败
  try {
    const { BundlerClient } = await import('../../aa-sdk/src/index.js');
    const bundler = new BundlerClient(cfg);
    const est = await bundler.estimateUserOperationGas(op as any);
    console.log('[bundler estimate] ok', JSON.stringify(est, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch (e: any) {
    console.log('[bundler estimate] FAIL');
    decodeRevert(e);
  }

  // ===== 排查 prefund：deposit 是否足够覆盖 (verificationGasLimit+callGasLimit+preVerificationGas)*maxFeePerGas =====
  console.log('\n[prefund 排查]');
  const nativeBal = await publicClient.getBalance({ address: addr });
  const epBal = await publicClient.readContract({ address: cfg.entryPoint, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [addr] }) as bigint;
  const prefund = (op.verificationGasLimit + op.callGasLimit + op.preVerificationGas) * op.maxFeePerGas;
  console.log('  account native balance =', (Number(nativeBal) / 1e18).toFixed(6), 'OXA | entrypoint balanceOf =', (Number(epBal) / 1e18).toFixed(6), 'OXA');
  console.log('  required prefund =', (Number(prefund) / 1e18).toFixed(6), 'OXA | maxFeePerGas =', op.maxFeePerGas.toString());

  // ===== 决定性实验：deployer 直接发交易调 entrypoint.handleOps（绕过 bundler 检查）=====
  console.log('\n[直接 handleOps 交易]');
  try {
    const htx = await wc.sendTransaction({ account: deployer, to: cfg.entryPoint, data: handleOpsData, value: 0n });
    console.log('  handleOps tx:', htx);
    const rc = await publicClient.waitForTransactionReceipt({ hash: htx });
    console.log('  status:', rc.status, '| gasUsed:', rc.gasUsed?.toString());
    if (rc.status === 'reverted') {
      // 尝试解码 revert 原因
      try {
        const trace = await publicClient.call({ to: cfg.entryPoint, data: handleOpsData });
        console.log('  replay eth_call 未 revert（交易可能是 gas 或时序问题）', trace);
      } catch (e2: any) { console.log('  replay revert:'); decodeRevert(e2); }
    } else {
      console.log('  ✅ handleOps 直接交易成功！session module 已安装？');
    }
  } catch (e: any) {
    console.log('  handleOps tx fail:', String(e?.message ?? e).slice(0, 200));
    const data: Hex | undefined = e?.data;
    if (data && data !== '0x') {
      console.log('  revert data:', data.slice(0, 200));
      for (const sig of ['FailedOp(uint256,string)', 'FailedOp(uint256)', 'Error(string)']) {
        try { const d = decodeErrorResult({ abi: parseAbi([`error ${sig}`]), data }); console.log(`   decoded ${sig}:`, JSON.stringify(d.args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); } catch { /* noop */ }
      }
    }
  }

  const installedAfter = await publicClient.readContract({ address: addr, abi: parseAbi(['function isModuleInstalled(uint256,address,bytes) view returns (bool)']), functionName: 'isModuleInstalled', args: [1n, MODULE, '0x'] }) as boolean;
  console.log('  isModuleInstalled after =', installedAfter);

  // ===== 对照组：ROOT-mode op（owner 签名，无 module 参与）经 bundler 发送 =====
  console.log('\n[对照组 root-mode op 经 bundler 发送]');
  try {
    const rootNonce = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [addr, 0n] }) as bigint;
    const rootOpBase = {
      sender: addr, nonce: rootNonce, callData,
      callGasLimit: 1_500_000n, verificationGasLimit: 500_000n, preVerificationGas: 60_000n,
      maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, signature: '0x' as Hex,
    };
    const rootHash = getUserOperationHash({ chainId: cfg.chainId, entryPointAddress: cfg.entryPoint, entryPointVersion: '0.7', userOperation: rootOpBase as any });
    const rootSig = await ownerAcct.signMessage({ message: { raw: rootHash } });
    const rootOp = { ...rootOpBase, signature: rootSig };
    console.log('  root nonce =', rootNonce.toString(16), '| userOpHash =', rootHash.slice(0, 18));
    const { BundlerClient } = await import('../../aa-sdk/src/index.js');
    const bundler = new BundlerClient(cfg);
    const rootEst = await bundler.estimateUserOperationGas(rootOp as any);
    console.log('  ✅ root 估算成功', JSON.stringify(rootEst, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const rootEstOp = { ...rootOp, ...rootEst };
    for (const [label, method, extra] of [
      ['eth_sendUserOperation', 'eth_sendUserOperation', null],
      ['boost_sendUserOperation(fee=0)', 'boost_sendUserOperation', { ...userOpToRpc(rootEstOp), maxFeePerGas: '0x0', maxPriorityFeePerGas: '0x0' }],
    ] as const) {
      const params = extra ?? userOpToRpc(rootEstOp);
      const resp = await fetch(cfg.bundlers[0].url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method, params: [params, cfg.entryPoint] }),
      });
      const body = await resp.text();
      console.log(`  [${label}] status:`, resp.status, '| body:', body.slice(0, 200));
      if (resp.ok) {
        const j = JSON.parse(body);
        if (j.result) {
          console.log(`  ✅ ${label} userOpHash:`, j.result);
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const rc = await fetch(cfg.bundlers[0].url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'eth_getUserOperationReceipt', params: [j.result] }),
            });
            const rj = JSON.parse(await rc.text());
            if (rj.result) { console.log(`  ✅ ${label} 收据 success =`, rj.result.success, '| tx =', rj.result.receipt?.transactionHash ?? rj.result.transactionHash); break; }
            if (i === 59) console.log(`  ⚠️ ${label} 收据超时`);
          }
        }
      }
    }
  } catch (e: any) { console.log('  ❌ root 估算/发送失败:', String(e?.message ?? e).slice(0, 200)); }

  // ===== agent 调用测试（若 enable 已上链）：DEFAULT-mode validator nonce → bundler 估算 + raw 发送 =====
  if (installedAfter) {
    console.log('\n[agent 调用测试（bundler 路径）]');
    const agentNonceKey = encodeAsNonceKey(0x00, 0x01, MODULE, 0);
    const agentNonce = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [addr, agentNonceKey] }) as bigint;
    const agentOpBase = {
      sender: addr, nonce: agentNonce, callData,
      callGasLimit: FALLBACK_GAS.callGasLimit, verificationGasLimit: FALLBACK_GAS.verificationGasLimit, preVerificationGas: FALLBACK_GAS.preVerificationGas,
      maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, signature: '0x' as Hex,
    };
    const agentHash = getUserOperationHash({ chainId: cfg.chainId, entryPointAddress: cfg.entryPoint, entryPointVersion: '0.7', userOperation: agentOpBase as any });
    const agentSig2 = await agentAcct.signMessage({ message: { raw: agentHash } });
    const agentOp = { ...agentOpBase, signature: concatHex([sessionId, agentSig2]) };
    console.log('  agent nonce =', agentNonce.toString(16), '| userOpHash =', agentHash.slice(0, 18));
    try {
      const { BundlerClient } = await import('../../aa-sdk/src/index.js');
      const bundler = new BundlerClient(cfg);
      const est = await bundler.estimateUserOperationGas(agentOp as any);
      console.log('  ✅ agent 估算成功', JSON.stringify(est, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      const agentEst = { ...agentOp, ...est };
      const resp = await fetch(cfg.bundlers[0].url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_sendUserOperation', params: [userOpToRpc(agentEst), cfg.entryPoint] }),
      });
      const body = await resp.text();
      console.log('  agent send status:', resp.status, '| body:', body.slice(0, 300));
      if (resp.ok) {
        const j = JSON.parse(body);
        if (j.result) {
          console.log('  agent userOpHash:', j.result);
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const rc = await fetch(cfg.bundlers[0].url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'eth_getUserOperationReceipt', params: [j.result] }),
            });
            const rj = JSON.parse(await rc.text());
            if (rj.result) { console.log('  ✅ agent 收据 success =', rj.result.success, '| tx =', rj.result.receipt?.transactionHash ?? rj.result.transactionHash); break; }
            if (i === 59) console.log('  ⚠️ agent 收据超时');
          }
        }
      }
    } catch (e: any) { console.log('  ❌ agent 估算失败'); decodeRevert(e); }
  } else {
    console.log('\n[agent 调用测试] 跳过：enable 未成功上链');
  }
}

main().catch((e: any) => { console.error('dbg error:', e?.message || e); console.error(e?.stack?.slice(0, 600)); process.exit(1); });
