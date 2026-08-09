// ============================================================================
// 探针：从链上字节码提取 KernelSessionWithTokenLimitModule 的 selector 集合，
// 对照候选函数签名（onInstall/enableSession/validateUserOp/…）确定模块接口。
// 用法：source /tmp/aa-e2e-env.b64.txt && npx tsx scripts/aa-diag-module-abi.ts
// ============================================================================
import { createPublicClient, http, type Hex } from 'viem';
import { keccak256, toFunctionSignature, stringToHex } from 'viem';
import { getChainConfig } from '../../aa-sdk/src/index.js';

const cfg = getChainConfig('oxachain', process.env);
const client = createPublicClient({ chain: { id: cfg.chainId, name: 'Oxa', nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } }, transport: http(cfg.rpcUrl) });

function sel(sig: string): string {
  return keccak256(stringToHex(sig)).slice(0, 10) as Hex;
}

// 从字节码提取 4 字节 selector（出现在 PUSH4 指令位置 0x63 之后）
function extractSelectors(code: Hex): Set<string> {
  const s = code.slice(2);
  const out = new Set<string>();
  for (let i = 0; i + 8 <= s.length; i++) {
    if (s.slice(i, i + 2) === '63' && i + 10 <= s.length) {
      out.add('0x' + s.slice(i + 2, i + 10));
    }
  }
  return out;
}

async function main() {
  const module = cfg.sessionModule!;
  console.log('module:', module);
  const code = await client.getCode({ address: module });
  console.log('code length:', (code ?? '0x').length, 'bytes:', ((code ?? '0x').length - 2) / 2);
  const sels = extractSelectors(code ?? '0x');
  console.log('\n=== 字节码中出现的 selector（PUSH4）===');
  for (const s of [...sels].sort()) console.log(' ', s);

  // 候选签名（含旧 ABI 与常见 ERC-7579 接口）
  const candidates: Record<string, string[]> = {
    'onInstall(bytes)': [],
    'onUninstall(bytes)': [],
    'enableSession(bytes32,address,uint48,uint48,tuple[],tuple[])': [],
    'enableSession(bytes32,address,uint48,uint48,tuple[])': [],
    'enableSession(bytes32,address,uint48,uint48,bytes[])': [],
    'disableSession(bytes32)': [],
    'validateUserOp(tuple,bytes32)': [],
    'validateUserOp(tuple,bytes32,uint256)': [],
    'isValidSignatureWithSender(address,bytes32,bytes)': [],
    'isModuleType(uint256)': [],
    'supportsInterface(bytes4)': [],
    'getSession(bytes32)': [],
    'checkSignature(bytes32,address,bytes32,bytes)': [],
    'checkUserOpSignature(bytes32,tuple,bytes32)': [],
    'checkUserOpPolicy(bytes32,tuple)': [],
    'isValidSignature(bytes32,bytes)': [],
    'onInstall(bytes,bytes)': [],
    'installModule(uint256,address,bytes)': [],
    'enable(bytes21,bytes,bytes,bytes,bytes,bytes)': [],
  };
  console.log('\n=== selector 对照 ===');
  const hits: string[] = [];
  for (const sig of Object.keys(candidates)) {
    const s = sel(sig);
    const hit = sels.has(s);
    if (hit) hits.push(sig);
    console.log(`  ${hit ? '✓' : '·'} ${s}  ${sig}`);
  }
  console.log('\n命中签名：', hits);
  console.log('\n未识别 selector（推断签名）：');
  for (const s of [...sels].sort()) {
    const known = Object.keys(candidates).some((sig) => sel(sig) === s);
    if (!known) console.log('  ??', s);
  }
}

main().catch((e) => { console.error('probe error:', e?.message || e); process.exit(1); });
