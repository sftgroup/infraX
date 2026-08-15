// InfraX 自建 VerifyingPaymaster 部署（P-1/P-2，OxaChain 19505）
// 用法：node scripts/deploy.mjs [--deposit <OXA>]
// 依赖 .env.deploy（AA_PAYMASTER_DEPLOY_PK / AA_PAYMASTER_SIGNER_PK，权限 600）
// 步骤：部署 VerifyingPaymaster(entryPoint, signer) → EntryPoint.depositTo 充值 → eth_getCode/balanceOf 验证
import { createPublicClient, createWalletClient, custom, http, parseEther, encodeFunctionData, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── 链配置（OxaChain 19505） ──────────────────────────────
const CHAIN = {
  id: 19505,
  name: 'OxaChain',
  nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc-oxa.0xainet.top'] } },
};
const ENTRYPOINT_V07 = '0x97e4cddcffeaf4580bc6315fee512f2b2d82798a';

// EntryPoint v0.7 接口（IStakeManager 子集）
const entryPointAbi = [
  {
    type: 'function', name: 'depositTo', stateMutability: 'payable',
    inputs: [{ name: 'account', type: 'address' }], outputs: [],
  },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
  },
];

// ── 读取 .env.deploy（仅本地，权限 600） ───────────────────
const envFile = resolve(ROOT, '.env.deploy');
if (!existsSync(envFile)) {
  console.error('缺少 .env.deploy（AA_PAYMASTER_DEPLOY_PK / AA_PAYMASTER_SIGNER_PK）');
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('='))
    .map((l) => { const [k, ...v] = l.split('='); return [k, v.join('=').trim()]; }),
);
const deployPk = env.AA_PAYMASTER_DEPLOY_PK;
const signerAddr = privateKeyToAccount(env.AA_PAYMASTER_SIGNER_PK).address;
if (!deployPk || !signerAddr) {
  console.error('.env.deploy 内容不完整');
  process.exit(1);
}

const depositArg = process.argv.find((a) => a.startsWith('--deposit'));
const depositWei = depositArg ? parseEther(depositArg.split('=')[1] ?? '1') : parseEther('1');

const account = privateKeyToAccount(deployPk);
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(CHAIN.rpcUrls.default.http[0]) });
const publicClient = createPublicClient({ chain: CHAIN, transport: http(CHAIN.rpcUrls.default.http[0]) });

// @account-abstraction/contracts@0.7.0 artifact（含 abi + bytecode，无 linkReferences）
const artifact = JSON.parse(
  readFileSync(resolve(ROOT, 'node_modules/@account-abstraction/contracts/artifacts/VerifyingPaymaster.json'), 'utf8'),
);

async function main() {
  const bal = await publicClient.getBalance({ address: account.address });
  console.log(`deployer : ${account.address}  balance=${bal} wei (${Number(bal) / 1e18} OXA)`);
  if (bal < parseEther('0.5')) {
    console.error(`部署余额不足：需向 ${account.address} 转入 OXA（部署+充值预计 ≥2 OXA）`);
    process.exit(2);
  }

  // 1. 部署 VerifyingPaymaster(entryPoint, verifyingSigner)（--paymaster 指定则跳过）
  const given = process.argv.find((a) => a.startsWith('--paymaster'));
  let paymasterAddr = given ? given.split('=')[1] : null;
  if (paymasterAddr) {
    console.log(`复用已部署 paymaster = ${paymasterAddr}`);
  } else {
    console.log('部署 VerifyingPaymaster ...');
    const txHash = await wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [ENTRYPOINT_V07, signerAddr],
    });
    console.log(`   txHash = ${txHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new Error(`部署失败：${receipt.status}`);
    paymasterAddr = receipt.contractAddress;
    console.log(`   ✅ paymaster = ${paymasterAddr}  (signer=${signerAddr})`);
  }

  // 2. EntryPoint.depositTo 充值（避免 AA31 paymasterDepositTooLow）
  const depositData = encodeFunctionData({ abi: entryPointAbi, functionName: 'depositTo', args: [paymasterAddr] });
  const depHash = await wallet.sendTransaction({
    to: ENTRYPOINT_V07,
    value: depositWei,
    data: depositData,
  });
  console.log(`充值 ${Number(depositWei) / 1e18} OXA → EntryPoint.depositTo(paymaster)`);
  await publicClient.waitForTransactionReceipt({ hash: depHash });

  // 3. 验证：eth_getCode + balanceOf
  const code = await publicClient.getCode({ address: paymasterAddr });
  const dep = await publicClient.readContract({
    address: ENTRYPOINT_V07, abi: entryPointAbi, functionName: 'balanceOf', args: [paymasterAddr],
  });
  console.log(`验证 eth_getCode  : ${code && code !== '0x' ? 'OK' : 'FAIL'}`);
  console.log(`验证 balanceOf    : ${dep} wei (${Number(dep) / 1e18} OXA)`);
  if (!code || code === '0x' || dep <= 0n) process.exit(3);

  console.log(`\n✅ 部署完成：PAYMASTER_ADDRESS=${paymasterAddr}  SIGNER=${signerAddr}`);
  console.log(`   接线：AA_OXACHAIN_PAYMASTER_URL=http://127.0.0.1:9134（signer 服务）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
