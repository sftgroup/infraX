// ============================================================================
// 真实链上验证：ENABLE-mode enable session → agent（session key）调用成功
// 流程：fresh 账户(owner=deployer) → 注资 → factory 部署 →
//       ENABLE-mode UserOp 上链（V1+C2+U1：validatorData=enable6 + 良性 call + sessionId+agentSig）→
//       校验 isModuleInstalled → agent 调用（DEFAULT-mode nonce 路由 + sessionId+agentSig）→
//       验证调用成功。
// 用法：source /tmp/aa-e2e-env.b64.txt && npx tsx scripts/aa-e2e-enable-agent.ts
// ============================================================================
import { createWalletClient, http, encodeFunctionData, parseAbi, toHex, concatHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  getChainConfig, createKernelAccount, PrivateKeySigner, BundlerClient, buildUserOp, estimateFeesPerGas,
  createAAClient, KernelV3SessionDataBuilder, encodeExecute, signUserOp,
} from '../../aa-sdk/src/index.js';
import { getUserOperationHash } from 'viem/account-abstraction';
import { keccak256, pad, stringToHex, concat } from 'viem';
import { randomBytes } from 'node:crypto';
import { bytesToHex } from 'viem';

const cfg = getChainConfig('oxachain', process.env);
const DEPLOYER_KEY = process.env.OXACHAIN_DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!DEPLOYER_KEY) throw new Error('env OXACHAIN_DEPLOYER_PRIVATE_KEY required');

const chain = { id: cfg.chainId, name: 'Oxa', nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
const publicClient = createAAClient(cfg);
const walletClient = createWalletClient({ chain, transport: http(cfg.rpcUrl) });
const deployer = privateKeyToAccount(DEPLOYER_KEY);
const ownerSigner = new PrivateKeySigner(DEPLOYER_KEY);

const MODULE = cfg.sessionModule!;
const ENABLE_TYPEHASH = '0xb17ab1224aca0d4255ef8161acaf2ac121b8faa32a4b2258c912cc5f8308c505';
const ZERO_ONE_ADDR = '0x0000000000000000000000000000000000000001' as Address; // address(1) 哨兵（无 hook）
const TARGET = '0x3333333333333333333333333333333333333333' as Address; // 白名单 target（无代码）
const FALLBACK_GAS = { callGasLimit: 1_500_000n, verificationGasLimit: 600_000n, preVerificationGas: 60_000n };

const entryPointAbi = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)']);
const EIP712_DOMAIN_TYPEHASH = keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { passed++; console.log(`  ok ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};

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
    pad(vId, { size: 32, dir: 'right' }),              // bytes21 → 32B 左对齐
    toHex(currentNonce, { size: 32 }),                 // uint32 → uint256
    pad(hook, { size: 32 }),
    keccak256(validatorData),
    keccak256(hookData),
    keccak256(selectorData),
  ]));
  return keccak256(concat(['0x1901', domainSeparator(account, chainId), structHash]));
}

function encodeAsNonceKey(mode: number, vType: number, validator: Address, nonceKey: number): bigint {
  const v = BigInt(validator);
  return (BigInt(mode) << 184n) | (BigInt(vType) << 176n) | (v << 16n) | BigInt(nonceKey);
}
const enableNonceKey = (m: Address) => encodeAsNonceKey(0x01, 0x01, m, 0);
const validatorNonceKey = (m: Address) => encodeAsNonceKey(0x00, 0x01, m, 0);

async function getNonce(sender: Address, key: bigint): Promise<bigint> {
  return publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [sender, key] }) as Promise<bigint>;
}

/** 组装带签名 UserOp 并发送（估算失败用兜底 gas） */
async function sendOp(op: any, skipEstimate = false): Promise<any> {
  const bundler = new BundlerClient(cfg);
  if (!skipEstimate) {
    try { const est = await bundler.estimateUserOperationGas(op); op = { ...op, ...est }; }
    catch (e: any) { console.log('  (gas 估算失败，用兜底):', String(e?.message ?? '').slice(0, 120)); op = { ...op, ...FALLBACK_GAS }; }
  } else {
    op = { ...op, ...FALLBACK_GAS };
  }
  try { const fee = await estimateFeesPerGas(cfg); op = { ...op, ...fee }; }
  catch { op = { ...op, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; }
  try {
    return await bundler.sendUserOperation(op, { waitTimeoutMs: 120_000 });
  } catch (e: any) {
    const seen = new Set<any>();
    let queue: any[] = Array.isArray(e?.cause) ? e.cause : [e?.cause];
    let depth = 0;
    while (queue.length && depth < 8) {
      const next: any[] = [];
      for (const c of queue) {
        if (!c || seen.has(c)) continue;
        seen.add(c);
        console.log(`  sendErr cause[${depth}]:`, JSON.stringify({ name: c?.name, code: c?.code, msg: String(c?.message ?? '').slice(0, 300), details: String(c?.details ?? '').slice(0, 300) }));
        if (Array.isArray(c?.cause)) next.push(...c.cause); else if (c?.cause) next.push(c.cause);
      }
      queue = next; depth++;
    }
    // 用 raw fetch 重发，拿完整 JSON-RPC 错误响应
    try {
      const { userOpToRpc } = await import('../../aa-sdk/src/bundler.js');
      const raw = await fetch(cfg.bundlers[0].url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendUserOperation', params: [userOpToRpc(op), cfg.entryPoint] }),
      });
      console.log('  raw send status:', raw.status, '| body:', (await raw.text()).slice(0, 600));
    } catch (e2: any) {
      console.log('  raw send err:', String(e2?.message ?? e2).slice(0, 200));
    }
    throw e;
  }
}

async function main() {
  console.log('== ENABLE-mode enable + agent 调用 链上验证 ==');
  console.log('module:', MODULE, '| entryPoint:', cfg.entryPoint);

  const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  const addr = account.address;
  console.log('\n[1] account:', addr, 'deployed:', account.isDeployed);

  if (!account.isDeployed) {
    const fund = 2n * 10n ** 16n;
    const tx = await walletClient.sendTransaction({ account: deployer, to: addr, value: fund });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log('  注资 tx', tx);
    const dtx = await walletClient.sendTransaction({ account: deployer, to: account.factory!, data: account.factoryData!, value: 0n });
    await publicClient.waitForTransactionReceipt({ hash: dtx });
    const code = await publicClient.getCode({ address: addr });
    console.log('  部署 tx', dtx, '| codeLen', String(code).length);
  }

  const currentNonce = await publicClient.readContract({ address: addr, abi: parseAbi(['function currentNonce() view returns (uint32)']), functionName: 'currentNonce' }) as number;
  const moduleInstalled = await publicClient.readContract({ address: addr, abi: parseAbi(['function isModuleInstalled(uint256,address,bytes) view returns (bool)']), functionName: 'isModuleInstalled', args: [1n, MODULE, '0x'] }) as boolean;
  console.log('  currentNonce =', currentNonce, '| sessionModule installed =', moduleInstalled);

  // session 策略
  const sessionId = bytesToHex(randomBytes(32));
  const agentKey = generatePrivateKey();
  const agentAcct = privateKeyToAccount(agentKey);
  const NOW = Math.floor(Date.now() / 1000);
  const policy = {
    network: 'evm' as const,
    sessionId,
    signer: agentAcct.address,
    validAfter: 0n,
    validUntil: BigInt(NOW + 3600),
    permissions: [{ targets: [TARGET], selectors: ['0x095ea7b3'], valueLimit: 10n ** 18n }],
  };
  console.log('\n[2] sessionId:', sessionId.slice(0, 18), '... | agent:', agentAcct.address);

  const enable6 = KernelV3SessionDataBuilder.enableData(policy as any);
  const approveData = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [ZERO_ONE_ADDR, 0n] });
  const validationId = concatHex(['0x01', MODULE]); // 21B: vType=0x01 + module
  const executeSelector = encodeExecute(TARGET, 0n, '0x').slice(0, 10) as Hex;

  // ============ ① ENABLE-mode enable（V1+C2+U1）============
  console.log('\n[3] ENABLE-mode enable UserOp 上链');
  const enableNonce = await getNonce(addr, enableNonceKey(MODULE));
  let enableOp = buildUserOp({ sender: addr, nonce: enableNonce, call: { target: addr, value: 0n, data: '0x' } });
  enableOp = {
    ...enableOp,
    callData: encodeExecute(TARGET, 0n, approveData), // 良性 call（估算已证明可执行）
    callGasLimit: FALLBACK_GAS.callGasLimit,
    verificationGasLimit: FALLBACK_GAS.verificationGasLimit,
    preVerificationGas: FALLBACK_GAS.preVerificationGas,
  };
  const enableUserOpHash = getUserOperationHash({ chainId: cfg.chainId, entryPointAddress: cfg.entryPoint, entryPointVersion: '0.7', userOperation: { ...enableOp, signature: '0x' } as any });

  const digest = enableDigest(addr, cfg.chainId, validationId, Number(currentNonce), ZERO_ONE_ADDR, enable6, '0xff', executeSelector);
  const enableSig = await deployer.signMessage({ message: { raw: digest } });
  const agentSigEnable = await agentAcct.signMessage({ message: { raw: enableUserOpHash } });
  const userOpSigEnable = concatHex([sessionId, agentSigEnable]);

  const encoded5 = encodeFunctionData({ abi: parseAbi(['function x(bytes,bytes,bytes,bytes,bytes)']), functionName: 'x', args: [enable6, '0xff', executeSelector, enableSig, userOpSigEnable] });
  const packed = concatHex([ZERO_ONE_ADDR, encoded5.slice(10) as Hex]);
  enableOp = { ...enableOp, signature: packed };

  console.log('  enable nonce =', enableNonce.toString(16), '| userOpHash =', enableUserOpHash.slice(0, 18));
  const enableRes = await sendOp(enableOp, true);
  check('enable UserOp 上链 success', enableRes.receipt?.success === true, `userOp ${enableRes.userOpHash} tx ${enableRes.receipt?.txHash}`);

  const installedAfter = await publicClient.readContract({ address: addr, abi: parseAbi(['function isModuleInstalled(uint256,address,bytes) view returns (bool)']), functionName: 'isModuleInstalled', args: [1n, MODULE, '0x'] }) as boolean;
  check('session module 已安装', installedAfter === true, `installed=${installedAfter}`);

  // ============ ② agent 调用（DEFAULT-mode nonce 路由到 session module）============
  console.log('\n[4] agent 调用（nonce 编码路由到 session module）');
  const agentNonceKey = validatorNonceKey(MODULE);
  const agentNonce = await getNonce(addr, agentNonceKey);
  let agentOp = buildUserOp({ sender: addr, nonce: agentNonce, call: { target: addr, value: 0n, data: '0x' } });
  agentOp = { ...agentOp, callData: encodeExecute(TARGET, 0n, approveData), ...FALLBACK_GAS };
  const agentUserOpHash = getUserOperationHash({ chainId: cfg.chainId, entryPointAddress: cfg.entryPoint, entryPointVersion: '0.7', userOperation: { ...agentOp, signature: '0x' } as any });
  const agentSig = await agentAcct.signMessage({ message: { raw: agentUserOpHash } });
  agentOp = { ...agentOp, signature: concatHex([sessionId, agentSig]) };
  console.log('  agent nonce =', agentNonce.toString(16), '| userOpHash =', agentUserOpHash.slice(0, 18));

  const agentRes = await sendOp(agentOp);
  check('agent 调用成功（session validator 放行）', agentRes.receipt?.success === true, `userOp ${agentRes.userOpHash} tx ${agentRes.receipt?.txHash}`);

  console.log('\n=== 结果 ===');
  console.log(`通过 ${passed} / ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e: any) => { console.error('main error:', e?.message || e); console.error(e?.stack?.slice(0, 800)); process.exit(1); });
