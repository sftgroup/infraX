// 探针：eth_call 直接测试 entryPoint.addStake 的最小 stake 要求
import { parseAbi, encodeFunctionData, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getChainConfig, createKernelAccount, PrivateKeySigner, createAAClient } from '/home/ubuntu/infraX-1/projects/aa-sdk/src/index.js';

const cfg = getChainConfig('oxachain', process.env);
const DEPLOYER_KEY = process.env.OXACHAIN_DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!DEPLOYER_KEY) throw new Error('env required');
const publicClient = createAAClient(cfg);
const deployer = privateKeyToAccount(DEPLOYER_KEY);
const ownerSigner = new PrivateKeySigner(DEPLOYER_KEY);

const entryPointAbi = parseAbi([
  'function addStake(uint32 unstakeDelaySec) payable',
  'function getDepositInfo(address account) view returns (uint256 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec, uint48 withdrawTime)',
]);

async function main() {
  const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  const addr = account.address;
  console.log('account:', addr);

  // 先确认 eth_call 可用（readContract 同路径）
  try {
    const info = await publicClient.readContract({ address: cfg.entryPoint, abi: entryPointAbi, functionName: 'getDepositInfo', args: [addr] }) as any;
    console.log('getDepositInfo:', JSON.stringify(info, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
  } catch (e: any) { console.log('getDepositInfo err:', e?.message?.slice(0, 120)); }

  const addStakeData = encodeFunctionData({ abi: entryPointAbi, functionName: 'addStake', args: [1] });
  for (const amt of ['0.5', '1', '2']) {
    const value = BigInt(Math.floor(Number(amt) * 1e18));
    try {
      const res = await publicClient.request({
        method: 'eth_call',
        params: [{ from: addr, to: cfg.entryPoint, data: addStakeData, value: toHex(value) }, 'latest'],
      }) as string;
      console.log(`addStake(${amt} OXA) eth_call OK:`, String(res));
    } catch (e: any) {
      const raw = (e as any)?.cause ?? e;
      console.log(`addStake(${amt} OXA) revert:`, String(raw?.data ?? raw?.message ?? raw).slice(0, 200));
    }
  }
}
main().catch((e) => { console.error('err:', e?.message || e); process.exit(1); });
