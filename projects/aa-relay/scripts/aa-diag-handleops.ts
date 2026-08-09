// 直接 eth_call EntryPoint.handleOps 模拟 enable UserOp，解码 FailedOp 真实 revert 原因
import { createClient, http, encodeFunctionData, parseAbi, toHex, type Address, type Hex } from 'viem';
import { keccak256, pad, stringToHex, concat, concatHex } from 'viem';
import { decodeErrorResult, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  getChainConfig, createKernelAccount, PrivateKeySigner, buildUserOp, estimateFeesPerGas,
  createAAClient, KernelV3SessionDataBuilder, encodeExecute,
} from '/home/ubuntu/infraX-1/projects/aa-sdk/src/index.js';
import { getUserOperationHash } from 'viem/account-abstraction';
import { randomBytes } from 'node:crypto';
import { bytesToHex } from 'viem';

const cfg = getChainConfig('oxachain', process.env);
const DEPLOYER_KEY = process.env.OXACHAIN_DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!DEPLOYER_KEY) throw new Error('env OXACHAIN_DEPLOYER_PRIVATE_KEY required');

const publicClient = createAAClient(cfg);
const deployer = privateKeyToAccount(DEPLOYER_KEY);
const ownerSigner = new PrivateKeySigner(DEPLOYER_KEY);

const MODULE = cfg.sessionModule!;
const ENABLE_TYPEHASH = '0xb17ab1224aca0d4255ef8161acaf2ac121b8faa32a4b2258c912cc5f8308c505';
const ZERO_ONE_ADDR = '0x0000000000000000000000000000000000000001' as Address;
const TARGET = '0x3333333333333333333333333333333333333333' as Address;
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
  const v = BigInt(validator);
  return (BigInt(mode) << 184n) | (BigInt(vType) << 176n) | (v << 16n) | BigInt(nonceKey);
}
const enableNonceKey = (m: Address) => encodeAsNonceKey(0x01, 0x01, m, 0);

async function main() {
  const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  const addr = account.address;
  console.log('account:', addr, 'deployed:', account.isDeployed);

  const sessionId = bytesToHex(randomBytes(32));
  const agentKey = randomBytes(32);
  const agentAcct = privateKeyToAccount(toHex(agentKey));
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

  const currentNonce = await publicClient.readContract({ address: addr, abi: parseAbi(['function currentNonce() view returns (uint32)']), functionName: 'currentNonce' }) as number;
  const nonce = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [addr, enableNonceKey(MODULE)] }) as bigint;

  let op = buildUserOp({ sender: addr, nonce, call: { target: addr, value: 0n, data: '0x' } });
  op = {
    ...op,
    callData: encodeExecute(TARGET, 0n, approveData),
    callGasLimit: 1_500_000n,
    verificationGasLimit: 600_000n,
    preVerificationGas: 60_000n,
  };
  try { const fee = await estimateFeesPerGas(cfg); op = { ...op, ...fee }; }
  catch { op = { ...op, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; }
  const userOpHash = getUserOperationHash({ chainId: cfg.chainId, entryPointAddress: cfg.entryPoint, entryPointVersion: '0.7', userOperation: { ...op, signature: '0x' } as any });

  const digest = enableDigest(addr, cfg.chainId, validationId, Number(currentNonce), ZERO_ONE_ADDR, enable6, '0xff', executeSelector);
  const enableSig = await deployer.signMessage({ message: { raw: digest } });
  const agentSig = await agentAcct.signMessage({ message: { raw: userOpHash } });
  const userOpSig = concatHex([sessionId, agentSig]);
  const encoded5 = encodeFunctionData({ abi: parseAbi(['function x(bytes,bytes,bytes,bytes,bytes)']), functionName: 'x', args: [enable6, '0xff', executeSelector, enableSig, userOpSig] });
  op = { ...op, signature: concatHex([ZERO_ONE_ADDR, encoded5.slice(10) as Hex]) };

  // 组装 v0.7 PackedUserOperation（handleOps 参数）
  const accountGasLimits = concatHex([toHex(op.verificationGasLimit, { size: 16 }), toHex(op.callGasLimit, { size: 16 })]);
  const gasFees = concatHex([toHex(op.maxPriorityFeePerGas, { size: 16 }), toHex(op.maxFeePerGas, { size: 16 })]);
  const packedOp = {
    sender: op.sender,
    nonce: toHex(op.nonce),
    initCode: '0x' as Hex,
    callData: op.callData,
    accountGasLimits,
    preVerificationGas: toHex(op.preVerificationGas),
    gasFees,
    paymasterAndData: '0x' as Hex,
    signature: op.signature,
  };

  const handleOpsAbi = [{
    type: 'function',
    name: 'handleOps',
    inputs: [
      {
        name: 'ops', type: 'tuple[]',
        components: [
          { name: 'sender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'initCode', type: 'bytes' },
          { name: 'callData', type: 'bytes' },
          { name: 'accountGasLimits', type: 'bytes32' },
          { name: 'preVerificationGas', type: 'uint256' },
          { name: 'gasFees', type: 'bytes32' },
          { name: 'paymasterAndData', type: 'bytes' },
          { name: 'signature', type: 'bytes' },
        ],
      },
      { name: 'beneficiary', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  }] as const;
  const calldata = encodeFunctionData({ abi: handleOpsAbi, functionName: 'handleOps', args: [[packedOp], deployer.address] });

  console.log('simulating handleOps...');
  try {
    const res = await publicClient.request({
      method: 'eth_call',
      params: [{ from: deployer.address, to: cfg.entryPoint, data: calldata }, 'latest'],
    });
    console.log('eth_call OK:', String(res).slice(0, 200));
  } catch (e: any) {
    console.log('eth_call revert data:', String(e?.data ?? '').slice(0, 200));
    const data = e?.data as Hex | undefined;
    if (data && data.startsWith('0x')) {
      // 尝试解码 FailedOp(uint256 opIndex, string reason)
      try {
        const dec = decodeErrorResult({
          abi: [parseAbiItem('error FailedOp(uint256 opIndex, string reason)')],
          data,
        });
        console.log('FailedOp:', JSON.stringify(dec.args));
      } catch {
        try {
          const dec2 = decodeErrorResult({
            abi: [parseAbiItem('error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)')],
            data,
          });
          console.log('FailedOpWithRevert:', JSON.stringify(dec2.args).slice(0, 600));
        } catch (e2: any) {
          console.log('decode err:', e2?.message.slice(0, 120));
          // 原始 revert 字节（Kernel 侧自定义错误，如 EnableNotApproved）
          console.log('raw selector:', data.slice(0, 10));
        }
      }
    }
  }
}

main().catch((e: any) => { console.error('main error:', e?.message || e); process.exit(1); });
