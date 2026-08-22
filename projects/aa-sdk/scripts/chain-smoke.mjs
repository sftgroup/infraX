#!/usr/bin/env node
// ============================================================================
// P0.2 链上实测（OxaChain 19505，经自建 Alto Bundler 43.159.60.46:4338）
// 流程：RPC/Bundler 连通性 → 地址预计算 → 注资 → activateSmartAccount
//       （create2 懒部署 + 首笔 UserOp 转账）→ 收据/代码/余额验证。
// 零硬编码：全部配置来自仓库根 .env（AA_OXACHAIN_*）。
// 用法：node scripts/chain-smoke.mjs
// ============================================================================

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  getChainConfig,
  PrivateKeySigner,
  createKernelAccount,
  activateSmartAccount,
  BundlerClient,
} from '@0xinfrax/aa-sdk';

// --- 加载仓库根 .env ---------------------------------------------------------
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const DEPLOYER_KEY = env.OXACHAIN_DEPLOYER_PRIVATE_KEY;
if (!DEPLOYER_KEY) throw new Error('.env 缺 OXACHAIN_DEPLOYER_PRIVATE_KEY');

const chainConfig = getChainConfig('oxachain', env);
const deployer = privateKeyToAccount(DEPLOYER_KEY);
const owner = new PrivateKeySigner(DEPLOYER_KEY);

const chain = {
  id: chainConfig.chainId,
  name: 'OxaChain',
  nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 },
  rpcUrls: { default: { http: [chainConfig.rpcUrl] } },
};

const publicClient = createPublicClient({ chain, transport: http(chainConfig.rpcUrl) });
const walletClient = createWalletClient({ chain, transport: http(chainConfig.rpcUrl) });

const toOxa = (wei) => `${Number(wei) / 1e18} OXA`;
const recv = '0x1111111111111111111111111111111111111111'; // 测试收款地址

async function main() {
  console.log('== P0.2 链上实测（OxaChain 19505）==');
  console.log('chainId:', await publicClient.getChainId(), '| block:', await publicClient.getBlockNumber());
  console.log('deployer:', deployer.address, '| balance:', toOxa(await publicClient.getBalance({ address: deployer.address })));

  // ① Bundler 连通性
  const bundler = new BundlerClient(chainConfig);
  console.log('\n[1] Bundler 连通性', chainConfig.bundlers[0].url);
  const epClient = createPublicClient({ chain, transport: http(chainConfig.bundlers[0].url) });
  const epHash = '0x97e4cddcffeaf4580bc6315fee512f2b2d82798a';
  try {
    const supported = await epClient.request({ method: 'eth_supportedEntryPoints', params: [] });
    console.log('  supportedEntryPoints:', supported, '| 匹配:', String(supported).toLowerCase().includes(epHash.toLowerCase()));
    const bc = await epClient.request({ method: 'eth_chainId', params: [] });
    console.log('  bundler chainId:', Number(bc), '| 匹配:', Number(bc) === 19505);
  } catch (e) {
    console.error('  Bundler RPC 失败:', e.message);
    process.exit(1);
  }

  // ② 地址预计算（create2 counterfactual）
  console.log('\n[2] 地址预计算 + 注资');
  const account = await createKernelAccount({ owner, chainConfig });
  const smartAccount = account.address;
  console.log('  predicted smart account:', smartAccount);
  console.log('  isDeployed:', account.isDeployed, '| factory:', account.factory);
  if (!account.isDeployed) {
    const fund = 5n * 10n ** 16n; // 0.05 OXA 作 gas
    const tx = await walletClient.sendTransaction({
      account: deployer,
      to: smartAccount,
      value: fund,
    });
    console.log('  注资 tx:', tx);
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log('  注资后余额:', toOxa(await publicClient.getBalance({ address: smartAccount })));
  }

  // ③ 激活（懒部署 + 首笔转账 0.001 OXA）
  console.log('\n[3] activateSmartAccount（create2 部署 + transfer）');
  const value = 10n ** 15n; // 0.001 OXA
  const result = await activateSmartAccount({
    owner,
    chainConfig,
    call: { target: recv, value, data: '0x' },
  });
  console.log('  deployed:', result.deployed, '| userOpHash:', result.userOpHash);
  console.log('  txHash:', result.txHash, '| bundler:', result.bundlerUrl);

  // ④ 验证
  console.log('\n[4] 链上验证');
  if (result.txHash) {
    const receipt = await publicClient.getTransactionReceipt({ hash: result.txHash });
    console.log('  receipt status:', receipt.status, '| gasUsed:', receipt.gasUsed?.toString());
    if (receipt.status !== 'success') process.exit(1);
  }
  const code = await publicClient.getCode({ address: smartAccount });
  console.log('  smart account code:', code === '0x' ? 'MISSING (失败)' : `已部署 ${code.length / 2 - 1} B`);
  const recvBal = await publicClient.getBalance({ address: recv });
  console.log('  收款地址余额:', toOxa(recvBal), '| ≥ 0.001:', recvBal >= value);
  const finalBal = await publicClient.getBalance({ address: smartAccount });
  console.log('  smart account 剩余:', toOxa(finalBal));

  console.log('\n✅ P0.2 链上实测通过');
}

main().catch((e) => {
  console.error('\n❌ P0.2 链上实测失败:', e);
  process.exit(1);
});
