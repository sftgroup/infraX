// 探针：EntryPoint v0.7 stake 常量 + 账户 deposit/stake 状态 + bundler 行为对照
import { parseAbi, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  getChainConfig, createKernelAccount, PrivateKeySigner, createAAClient,
} from '/home/ubuntu/infraX-1/projects/aa-sdk/src/index.js';

const cfg = getChainConfig('oxachain', process.env);
const DEPLOYER_KEY = process.env.OXACHAIN_DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!DEPLOYER_KEY) throw new Error('env required');
const publicClient = createAAClient(cfg);
const deployer = privateKeyToAccount(DEPLOYER_KEY);
const ownerSigner = new PrivateKeySigner(DEPLOYER_KEY);

const abi = parseAbi([
  'function getDepositInfo(address account) view returns (uint256 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec, uint48 withdrawTime)',
  'function MIN_STAKE_VALUE() view returns (uint256)',
  'function MIN_UNSTAKE_DELAY() view returns (uint32)',
  'function stakeAmount(address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

async function main() {
  const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  const addr = account.address;
  console.log('account:', addr, 'deployed:', account.isDeployed);

  for (const f of ['MIN_STAKE_VALUE', 'MIN_UNSTAKE_DELAY']) {
    try {
      const v = await publicClient.readContract({ address: cfg.entryPoint, abi, functionName: f }) as bigint | number;
      console.log(f, '=', v.toString());
    } catch (e: any) { console.log(f, 'not found:', e?.message?.slice(0, 80)); }
  }
  try {
    const info = await publicClient.readContract({ address: cfg.entryPoint, abi, functionName: 'getDepositInfo', args: [addr] }) as any;
    console.log('depositInfo:', JSON.stringify(info, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
  } catch (e: any) { console.log('getDepositInfo err:', e?.message?.slice(0, 100)); }

  // bundler 是否暴露 stake 规则信息
  try {
    const r = await fetch(cfg.bundlers[0].url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_supportedEntryPoints', params: [] }) });
    console.log('eth_supportedEntryPoints:', await r.text());
  } catch (e: any) { console.log('ep err:', e?.message); }
}
main().catch((e) => { console.error('err:', e?.message || e); process.exit(1); });
