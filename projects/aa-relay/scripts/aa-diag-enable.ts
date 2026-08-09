// ============================================================================
// 探针：完整 ENABLE-mode enable UserOp 构造 + bundler 估算验证。
// 流程：创建 fresh 账户(owner=deployer) → 注资 → factory 直接部署 →
//       读取 currentNonce → 构造 ENABLE-mode UserOp（digest 用 viem typedData 同款）→
//       bundler 估算（暴露 enable 流程每一环的 revert）。
// 矩阵：
//   validatorData:  V1=enableSession6 calldata  V0=0x
//   callData:       C1=execute(module, enableSession6)  C2=execute(TARGET, approve)
//   userOpSig:      U1=sessionId+sessionKeySig  U2=owner 裸签名
// 用法：source /tmp/aa-e2e-env.b64.txt && npx tsx scripts/aa-diag-enable.ts
// ============================================================================
import { createWalletClient, http, encodeFunctionData, parseAbi, toHex, concatHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  getChainConfig, createKernelAccount, PrivateKeySigner, BundlerClient, buildUserOp, estimateFeesPerGas,
  createAAClient, KernelV3SessionDataBuilder, encodeExecute,
} from '../../aa-sdk/src/index.js';
import { signMessage } from 'viem/accounts';
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

/** 与 Kernel solady EIP712 一致的 domain separator（name=Kernel, version=0.3.0-beta） */
function domainSeparator(account: Address, chainId: number): Hex {
  return keccak256(concat([
    EIP712_DOMAIN_TYPEHASH,
    keccak256(stringToHex('Kernel')),
    keccak256(stringToHex('0.3.0-beta')),
    toHex(chainId, { size: 32 }),
    pad(account, { size: 32 }),
  ]));
}

/** enable digest = keccak256(0x1901 ‖ domainSeparator ‖ structHash)；structHash 对齐 _enableDigest */
function enableDigest(account: Address, chainId: number, vId: Hex, currentNonce: number, hook: Address, validatorData: Hex, hookData: Hex, selectorData: Hex): Hex {
  const structHash = keccak256(concat([
    ENABLE_TYPEHASH as Hex,
    pad(vId, { size: 32, dir: 'right' }),              // bytes21 → 32B 左对齐（高字节位）
    toHex(currentNonce, { size: 32 }),                 // uint32 → uint256
    pad(hook, { size: 32 }),                           // address → 32B 左补零
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

/** ENABLE-mode 路由 nonce：vMode=0x01(ENABLE) + vType=0x01(VALIDATOR) + module 地址 */
function enableNonceKey(module: Address): bigint {
  return encodeAsNonceKey(0x01, 0x01, module, 0);
}

/** DEFAULT-mode 路由 nonce：vMode=0x00 + vType=0x01(VALIDATOR) + module 地址（agent 调用用） */
function validatorNonceKey(module: Address): bigint {
  return encodeAsNonceKey(0x00, 0x01, module, 0);
}

async function estimate(label: string, op: any) {
  const bundler = new BundlerClient(cfg);
  try {
    const r = await bundler.estimateUserOperationGas(op);
    console.log(`✅ [${label}] 估算成功`, JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    return true;
  } catch (e: any) {
    console.log(`❌ [${label}] 估算失败`);
    console.log('  raw name:', e?.name, '| msg:', String(e?.message ?? '').slice(0, 200));
    console.log('  details:', String(e?.details ?? '').slice(0, 300));
    let cur: any = e, depth = 0;
    const seen = new Set<any>();
    let queue: any[] = Array.isArray(e?.cause) ? e.cause : [e?.cause];
    while (queue.length && depth < 6) {
      const next: any[] = [];
      for (const c of queue) {
        if (!c || seen.has(c)) continue;
        seen.add(c);
        console.log(`  cause[${depth}]:`, JSON.stringify({ name: c?.name, code: c?.code, msg: String(c?.message ?? '').slice(0, 200), details: String(c?.details ?? '').slice(0, 300) }));
        if (Array.isArray(c?.cause)) next.push(...c.cause); else if (c?.cause) next.push(c.cause);
      }
      queue = next; depth++;
    }
    return false;
  }
}

async function main() {
  console.log('== ENABLE-mode enable UserOp 估算探针 ==');
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

  const currentNonce = await publicClient.readContract({ address: addr, abi: parseAbi(['function currentNonce() view returns (uint32)']), functionName: 'currentNonce' });
  const moduleInstalled = await publicClient.readContract({ address: addr, abi: parseAbi(['function isModuleInstalled(uint256,address,bytes) view returns (bool)']), functionName: 'isModuleInstalled', args: [1n, MODULE, '0x'] });
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
  console.log('\n[2] sessionId:', sessionId, '| agent:', agentAcct.address);

  // callData 候选
  const enable6 = KernelV3SessionDataBuilder.enableData(policy as any);
  const callC1 = encodeExecute(MODULE, 0n, enable6); // execute(module, enableSession6)
  const approveData = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [ZERO_ONE_ADDR, 0n] });
  const callC2 = encodeExecute(TARGET, 0n, approveData); // execute(TARGET, approve)

  // validatorData 候选
  const vIds: Record<string, Hex> = { V0: '0x', V1: enable6 };
  const validationId = concatHex(['0x01', MODULE]); // 21B: vType=0x01 + module

  const combos: Array<[string, Hex, Hex, 'U1' | 'U2']> = [
    ['V1+C2+U1', vIds.V1, callC2, 'U1'],
    ['V1+C2+U2', vIds.V1, callC2, 'U2'],
    ['V1+C1+U2', vIds.V1, callC1, 'U2'],
    ['V0+C1+U2', vIds.V0, callC1, 'U2'],
    ['V0+C2+U2', vIds.V0, callC2, 'U2'],
  ];

  for (const [label, validatorData, callData, uMode] of combos) {
    const nonceKey = enableNonceKey(MODULE);
    const nonce = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [addr, nonceKey] }) as bigint;
    const hookData = '0xff';
    // selectorData = execute.selector（4B）。encodeExecute 输出前 4B 即 selector
    const executeSelector = encodeExecute(TARGET, 0n, '0x').slice(0, 10) as Hex;

    let op = buildUserOp({ sender: addr, nonce, call: { target: addr, value: 0n, data: '0x' } });
    op = {
      ...op,
      callData,
      callGasLimit: FALLBACK_GAS.callGasLimit,
      verificationGasLimit: FALLBACK_GAS.verificationGasLimit,
      preVerificationGas: FALLBACK_GAS.preVerificationGas,
    };
    try { const fee = await estimateFeesPerGas(cfg); op = { ...op, ...fee }; } catch { op = { ...op, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; }
    const userOpHash = getUserOperationHash({ chainId: cfg.chainId, entryPointAddress: cfg.entryPoint, entryPointVersion: '0.7', userOperation: { ...op, signature: '0x' } as any });

    // enableSig：owner 对 enable digest 签名（signMessage raw = ethSignedMessageHash(digest)，与测试一致）
    const digest = enableDigest(addr, cfg.chainId, validationId, Number(currentNonce), ZERO_ONE_ADDR, validatorData, hookData, executeSelector);
    const enableSig = await deployer.signMessage({ message: { raw: digest } });

    // userOpSig
    let userOpSig: Hex;
    if (uMode === 'U1') {
      const agentSig = await agentAcct.signMessage({ message: { raw: userOpHash } });
      userOpSig = concatHex([sessionId, agentSig]);
    } else {
      userOpSig = await deployer.signMessage({ message: { raw: userOpHash } });
    }

    // packedData = abi.encodePacked(hook 20B, abi.encode(validatorData, hookData, selectorData, enableSig, userOpSig))
    // abi.encode(5 bytes) = encodeFunctionData(selector 4B + args)；去 selector 取 body
    const encoded5 = encodeFunctionData({ abi: parseAbi(['function x(bytes,bytes,bytes,bytes,bytes)']), functionName: 'x', args: [validatorData, hookData, executeSelector, enableSig, userOpSig] });
    const packed = concatHex([ZERO_ONE_ADDR, encoded5.slice(10) as Hex]);
    op = { ...op, signature: packed };

    console.log(`\n--- 组合 [${label}] nonce=${nonce.toString(16)} userOpHash=${userOpHash.slice(0, 18)} ---`);
    await estimate(label, op);
  }

  console.log('\n== 探针结束 ==');
}

main().catch((e) => { console.error('probe error:', e?.message || e); console.error(e?.stack?.slice(0, 1000)); process.exit(1); });
