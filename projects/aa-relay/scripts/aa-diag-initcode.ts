// 诊断 initcode：抓链上 Kernel implementation 字节码，搜索 initialize selector 是否存在
// 判定链上 implementation 的真实 initialize 签名（v3.0=0x12af322c / v3.1=0x3c3b752b）
// 用法（生产）：env 就绪后 npx tsx scripts/aa-diag-initcode.ts
import { createClient, http, type Hex } from 'viem';
import { getChainConfig } from '../../aa-sdk/src/index.js';

const cfg = getChainConfig('oxachain', process.env);

const SELECTORS: Record<string, string> = {
  'v3.1 initialize(bytes21,address,bytes,bytes,bytes[])': '0x3c3b752b',
  'v3.0 initialize(bytes21,address,bytes,bytes)': '0x12af322c',
  'initialize(bytes32,address,bytes,bytes,tuple[])': '0x1cbc15c9',
  'initialize(bytes32,address,bytes,bytes,bytes[])': '0x2256abad',
  'initialize(bytes32,address,bytes,bytes)': '0xd1c08a20',
  'InvalidSelector() error': '0x7352d91c',
};

async function main() {
  const client = createClient({ transport: http(cfg.rpcUrl) });
  const impl = cfg.kernelImplementation!;
  const factory = cfg.kernelFactory!;

  console.log('== aa-diag-initcode：implementation 字节码 selector 探测 ==');
  console.log('implementation:', impl);
  console.log('factory:       ', factory);

  // ① factory.implementation()（v3 factory 的 view）
  try {
    const r = (await client.request({ method: 'eth_call', params: [{ to: factory, data: '0x5c60da1b' }, 'latest'] })) as Hex;
    console.log('factory.implementation() =', r);
  } catch (e: any) {
    console.log('factory.implementation() 调用失败:', e?.message?.slice(0, 120));
  }

  // ② 抓 implementation 字节码
  const code = (await client.request({ method: 'eth_getCode', params: [impl, 'latest'] })) as Hex;
  console.log('implementation code size:', (code.length - 2) / 2, 'bytes');
  const body = code.slice(2).toLowerCase();
  for (const [name, sel] of Object.entries(SELECTORS)) {
    const needle = sel.slice(2).toLowerCase();
    const idx = body.indexOf(needle);
    console.log(`${idx >= 0 ? '✅' : '❌'} ${name} (${sel}) ${idx >= 0 ? `@0x${idx.toString(16)}` : 'NOT FOUND in code'}`);
  }

  // ③ 字节码头部 PUSH 指令统计（辅助版本判定）
  const head = body.slice(0, 40);
  console.log('\ncode head:', '0x' + head);

  console.log('\n== aa-diag-initcode 结束 ==');
}

main().catch((e) => { console.error('diag-initcode error:', e?.message || e); process.exit(1); });
