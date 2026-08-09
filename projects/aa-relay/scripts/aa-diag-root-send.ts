// 快速对照：root-nonce 普通 UserOp 发送（owner 签名）是否仍被 bundler 接受
import { createWalletClient, http, toHex, type Hex, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  getChainConfig, createKernelAccount, PrivateKeySigner, BundlerClient, buildUserOp, signUserOp, estimateFeesPerGas, createAAClient,
} from '/home/ubuntu/infraX-1/projects/aa-sdk/src/index.js';

const cfg = getChainConfig('oxachain', process.env);
const DEPLOYER_KEY = process.env.OXACHAIN_DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!DEPLOYER_KEY) throw new Error('env required');
const chain = { id: cfg.chainId, name: 'Oxa', nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
const publicClient = createAAClient(cfg);
const walletClient = createWalletClient({ chain, transport: http(cfg.rpcUrl) });
const deployer = privateKeyToAccount(DEPLOYER_KEY);
const ownerKey = generatePrivateKey();
const ownerSigner = new PrivateKeySigner(ownerKey);
const entryPointAbi = [{ type: 'function', name: 'getNonce', inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'uint192' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' }] as const;

async function main() {
  const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  const addr = account.address;
  console.log('account:', addr, 'deployed:', account.isDeployed);
  if (!account.isDeployed) {
    const fund = 2n * 10n ** 16n;
    let tx = await walletClient.sendTransaction({ account: deployer, to: addr, value: fund });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    tx = await walletClient.sendTransaction({ account: deployer, to: account.factory!, data: account.factoryData!, value: 0n });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log('deployed');
  }
  const nonceKey = process.env.TEST_NONCE_KEY ? BigInt(process.env.TEST_NONCE_KEY) : 0n;
  const nonce = await publicClient.readContract({ address: cfg.entryPoint as Address, abi: entryPointAbi, functionName: 'getNonce', args: [addr, nonceKey] }) as bigint;
  const bundler = new BundlerClient(cfg);
  let op = buildUserOp({ sender: addr, nonce, call: { target: addr, value: 0n, data: '0x' } });
  op = { ...op, callGasLimit: 1_500_000n, verificationGasLimit: 600_000n, preVerificationGas: 60_000n };
  try { const fee = await estimateFeesPerGas(cfg); op = { ...op, ...fee }; } catch { op = { ...op, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; }
  op = await signUserOp(op, cfg.entryPoint, cfg.chainId, ownerSigner);

  console.log('sending root-nonce op nonce=', nonce.toString(16));
  try {
    const r = await bundler.sendUserOperation(op, { waitTimeoutMs: 120_000 });
    console.log('SEND OK', JSON.stringify({ hash: r.userOpHash, success: r.receipt?.success, tx: r.receipt?.txHash }));
  } catch (e: any) {
    console.log('SEND FAIL:', e?.name, '|', String(e?.message ?? '').slice(0, 200));
    const q: any[] = [e];
    let d = 0;
    while (q.length && d < 6) {
      const c = q.shift(); d++;
      if (!c) continue;
      console.log(`  cause[${d}]:`, JSON.stringify({ name: c.name, code: c.code, msg: String(c.message ?? '').slice(0, 200), details: String(c.details ?? '').slice(0, 200) }));
      if (Array.isArray(c.cause)) q.push(...c.cause); else if (c.cause) q.push(c.cause);
    }
    // raw fetch
    try {
      const { userOpToRpc } = await import('/home/ubuntu/infraX-1/projects/aa-sdk/src/bundler.js');
      const raw = await fetch(cfg.bundlers[0].url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendUserOperation', params: [userOpToRpc(op), cfg.entryPoint] }) });
      console.log('raw:', await raw.text());
    } catch (e2) { console.log('raw err:', String(e2)); }
  }
}
main().catch((e) => { console.error('main err:', e?.message || e); process.exit(1); });
