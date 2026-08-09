// 回收固定探针账户（0x7B9c...，owner=deployer）的 entrypoint deposit：
// 构造 root-mode op（execute(entryPoint, withdrawTo(deployer, amt))）→ handleOps 直接交易。
import { createWalletClient, http, parseAbi, encodeFunctionData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getUserOperationHash } from 'viem/account-abstraction';
import {
  getChainConfig, createKernelAccount, PrivateKeySigner, createAAClient, buildUserOp, packUserOpV7,
} from '../../aa-sdk/src/index.js';

const cfg = getChainConfig('oxachain', process.env);
const DEPLOYER_KEY = process.env.OXACHAIN_DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!DEPLOYER_KEY) throw new Error('env required');
const publicClient = createAAClient(cfg);
const walletClient = createWalletClient({ chain: { id: cfg.chainId, name: 'Oxa', nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } }, transport: http(cfg.rpcUrl) });
const deployer = privateKeyToAccount(DEPLOYER_KEY);
const ownerSigner = new PrivateKeySigner(DEPLOYER_KEY);

const HandleOpsAbi = parseAbi(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[],address beneficiary)']);
const GetNonceAbi = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)']);
const BalanceAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);

async function main() {
  const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  const addr = account.address;
  const native = await publicClient.getBalance({ address: addr });
  const epDeposit = await publicClient.readContract({ address: cfg.entryPoint, abi: BalanceAbi, functionName: 'balanceOf', args: [addr] }) as bigint;
  const di = await publicClient.readContract({ address: cfg.entryPoint, abi: parseAbi(['function getDepositInfo(address) view returns (uint256,bool,uint112,uint32,uint48)']), functionName: 'getDepositInfo', args: [addr] }) as readonly [bigint, boolean, bigint, number, bigint];
  console.log('account:', addr);
  console.log('  native balance =', (Number(native) / 1e18).toFixed(6), 'OXA');
  console.log('  ep deposit    =', (Number(epDeposit) / 1e18).toFixed(6), 'OXA');
  console.log('  stake         =', (Number(di[2]) / 1e18).toFixed(6), 'OXA | staked:', di[1], '| withdrawTime:', di[4], '| unstakeDelay:', di[3]);

  const amt = (epDeposit * 9n) / 10n; // 提 90%
  if (amt <= 0n) { console.log('无可提现 deposit'); return; }
  const nonce = await publicClient.readContract({ address: cfg.entryPoint, abi: GetNonceAbi, functionName: 'getNonce', args: [addr, 0n] }) as bigint;
  const withdrawData = encodeFunctionData({ abi: parseAbi(['function withdrawTo(address,uint256)']), functionName: 'withdrawTo', args: [deployer.address, amt] });
  const op = buildUserOp({
    sender: addr, nonce,
    call: { target: cfg.entryPoint, value: 0n, data: withdrawData },
    gas: { callGasLimit: 1_000_000n, verificationGasLimit: 500_000n, preVerificationGas: 60_000n },
  });
  const opSigned = { ...op, maxFeePerGas: 1_100_000_000n, maxPriorityFeePerGas: 1_100_000_000n };
  const hash = getUserOperationHash({ chainId: cfg.chainId, entryPointAddress: cfg.entryPoint, entryPointVersion: '0.7', userOperation: opSigned as any });
  const sig = await deployer.signMessage({ message: { raw: hash } });
  const finalOp = { ...opSigned, signature: sig };
  const packed = packUserOpV7(finalOp);
  const data = encodeFunctionData({ abi: HandleOpsAbi, functionName: 'handleOps', args: [[packed], deployer.address] });
  console.log('  withdraw amount =', (Number(amt) / 1e18).toFixed(6), 'OXA | nonce =', nonce.toString(16));
  try {
    await publicClient.call({ to: cfg.entryPoint, data });
  } catch (e: any) {
    console.log('  eth_call 预演 revert:', String(e?.message ?? e).slice(0, 160));
    return;
  }
  const tx = await walletClient.sendTransaction({ account: deployer, to: cfg.entryPoint, data, value: 0n });
  const rc = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log('  tx:', tx, '| status:', rc.status, '| gasUsed:', rc.gasUsed?.toString());

  // 账户 native 余额直接转回 deployer（execute(deployer, amt, '0x')）
  const nativeNow = await publicClient.getBalance({ address: addr });
  const nativeAmt = nativeNow - 1n * 10n ** 15n; // 留 0.001 OXA
  if (nativeAmt > 0n) {
    console.log('  native 转账 =', (Number(nativeAmt) / 1e18).toFixed(6), 'OXA');
    const nonce2 = await publicClient.readContract({ address: cfg.entryPoint, abi: GetNonceAbi, functionName: 'getNonce', args: [addr, 0n] }) as bigint;
    const op2 = buildUserOp({
      sender: addr, nonce: nonce2,
      call: { target: deployer.address, value: nativeAmt, data: '0x' },
      gas: { callGasLimit: 1_000_000n, verificationGasLimit: 500_000n, preVerificationGas: 60_000n },
    });
    const op2Signed = { ...op2, maxFeePerGas: 1_100_000_000n, maxPriorityFeePerGas: 1_100_000_000n };
    const hash2 = getUserOperationHash({ chainId: cfg.chainId, entryPointAddress: cfg.entryPoint, entryPointVersion: '0.7', userOperation: op2Signed as any });
    const sig2 = await deployer.signMessage({ message: { raw: hash2 } });
    const packed2 = packUserOpV7({ ...op2Signed, signature: sig2 });
    const data2 = encodeFunctionData({ abi: HandleOpsAbi, functionName: 'handleOps', args: [[packed2], deployer.address] });
    try {
      await publicClient.call({ to: cfg.entryPoint, data: data2 });
    } catch (e: any) {
      console.log('  native 转账 eth_call revert:', String(e?.message ?? e).slice(0, 160));
      return;
    }
    const tx2 = await walletClient.sendTransaction({ account: deployer, to: cfg.entryPoint, data: data2, value: 0n });
    const rc2 = await publicClient.waitForTransactionReceipt({ hash: tx2 });
    console.log('  native tx:', tx2, '| status:', rc2.status);
  }

  const bal = await publicClient.getBalance({ address: deployer.address });
  console.log('  deployer bal after =', (Number(bal) / 1e18).toFixed(6), 'OXA');
}

main().catch((e: any) => { console.error('err:', e?.message || e); process.exit(1); });
