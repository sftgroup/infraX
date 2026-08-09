// ============================================================================
// 探针：探测 KernelSessionWithTokenLimitModule.onInstall 可接受的数据格式。
// 方法：eth_call 模拟 kernel 账户调用 module.onInstall(候选数据)，
//       观察哪些候选不 revert（即 onInstall 接受该格式）。
// 候选：空 / enableSession 5 参 calldata / enableSession 6 参 calldata /
//       abi.encode 变体。
// 用法：source /tmp/aa-e2e-env.b64.txt && npx tsx scripts/aa-diag-module-oninstall.ts
// ============================================================================
import { createPublicClient, http, encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem';
import { randomBytes } from 'node:crypto';
import { getChainConfig, KernelV3SessionDataBuilder, createKernelAccount, PrivateKeySigner, createAAClient } from '../../aa-sdk/src/index.js';
import { toBytes, bytesToHex, toHex, pad } from 'viem';

const cfg = getChainConfig('oxachain', process.env);
const DEPLOYER_KEY = process.env.OXACHAIN_DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!DEPLOYER_KEY) throw new Error('env OXACHAIN_DEPLOYER_PRIVATE_KEY required');

const client = createPublicClient({ chain: { id: cfg.chainId, name: 'Oxa', nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } }, transport: http(cfg.rpcUrl) });
const moduleAddr = cfg.sessionModule!;

const onInstallAbi = parseAbiParameters('bytes') as never;

function sessionPolicyFixture() {
  const sessionId = bytesToHex(randomBytes(32));
  const sessionKey = '0x1111111111111111111111111111111111111111' as Address;
  const NOW = Math.floor(Date.now() / 1000);
  const permissions = [
    {
      targets: ['0x2222222222222222222222222222222222222222' as Address],
      selectors: ['0x095ea7b3'],
      valueLimit: 1000n,
    },
  ];
  return {
    policy: {
      network: 'evm' as const,
      sessionId,
      signer: sessionKey,
      validAfter: 0n,
      validUntil: BigInt(NOW + 3600),
      permissions,
    },
  };
}

async function main() {
  console.log('module:', moduleAddr);
  const ownerSigner = new PrivateKeySigner(DEPLOYER_KEY);
  const account = await createKernelAccount({ owner: ownerSigner, chainConfig: cfg });
  const kernelAddr = account.address;
  console.log('kernel (caller simulation):', kernelAddr);

  const { policy } = sessionPolicyFixture();
  console.log('fixture sessionId:', policy.sessionId, 'signer:', policy.signer);

  // 候选 onInstall 数据（惰性构造，逐个 try/catch 隔离失败）
  const candidates: Array<[string, () => Hex]> = [
    ['empty(0x)', () => '0x'],
    ['enable5 calldata', () => KernelV3SessionDataBuilder.enableData({ ...policy, permissions: [] as any } as any)],
    ['enable6 calldata', () => KernelV3SessionDataBuilder.enableData(policy as any)],
    ['abi(sessionId,sessionKey,validUntil,validAfter)', () =>
      encodeAbiParameters(
        parseAbiParameters('bytes32,address,uint48,uint48'),
        [policy.sessionId as Hex, policy.signer, Number(policy.validUntil), Number(policy.validAfter)],
      )],
    ['abi(sessionId,sessionKey,validUntil,validAfter,calls[])', () =>
      encodeAbiParameters(
        parseAbiParameters('bytes32,address,uint48,uint48,(address,bytes4[],uint256,uint256)[]'),
        [policy.sessionId as Hex, policy.signer, Number(policy.validUntil), Number(policy.validAfter),
          [{ target: '0x2222222222222222222222222222222222222222', selectors: ['0x095ea7b3'], valueLimit: 1000n, countLimit: 0n }]],
      )],
  ];

  for (const [name, make] of candidates) {
    let data: Hex;
    try {
      data = make();
    } catch (e: any) {
      console.log(`⚠️  构造失败 ${name}: ${String(e?.message ?? e).slice(0, 120)}`);
      continue;
    }
    const calldata = `0x6d61fe70${data.slice(2)}`;
    try {
      // 用 from=kernel 模拟账户调用（若是 kernel-only 访问控制则模拟通过）
      const r = await client.call({ account: kernelAddr, to: moduleAddr, data: calldata });
      console.log(`✅ onInstall(${name}) len=${data.length} → 无 revert  ret=${(r.data ?? '0x').slice(0, 80)}`);
    } catch (e: any) {
      const msg = String(e?.shortMessage ?? e?.message ?? e).slice(0, 200);
      console.log(`❌ onInstall(${name}) len=${data.length} → revert: ${msg}`);
    }
  }
}

main().catch((e) => { console.error('probe error:', e?.message || e); console.error(e?.stack?.slice(0, 1200)); process.exit(1); });
