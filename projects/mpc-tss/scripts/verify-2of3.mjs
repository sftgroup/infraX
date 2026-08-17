// AX-13 HTTP 级 2-of-3 验证：/v1/import 产出 shard1/2/3，
// partner_index=1（片2）与 partner_index=2（片3）分别签名，ethers 复核同一地址。
// 前置：mpc_signer（TSS_SIGNER_URL_1/TSS_SIGNER_URL_2 指向两个 tss_signer 实例）、
//       tss_signer#1（TSS_PARTY_ID=1, :9200）、tss_signer#2（TSS_PARTY_ID=2, :9202）
import { ethers } from '/home/ubuntu/infraX-1/projects/mpc/node_modules/ethers/lib.esm/index.js';

const mpcUrl = process.env.MPC_SIGNER_URL || 'http://127.0.0.1:9201';
const tss1Url = process.env.TSS_SIGNER_URL_1 || 'http://127.0.0.1:9200';
const tss2Url = process.env.TSS_SIGNER_URL_2 || 'http://127.0.0.1:9202';

// 1. 导入存量私钥 → 2-of-3 分片
const privateKey = 'f8356da3003a51c0a2e4dca6ecf7154c8dd44f62d82257a6340f71bd9b34da75';
console.log('[1/4] /v1/import → shard1/2/3');
const impResp = await fetch(`${mpcUrl}/v1/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ private_key: privateKey }),
});
if (!impResp.ok) {
  console.log('import failed:', impResp.status, await impResp.text());
  process.exit(1);
}
const imp = await impResp.json();
console.log('  address:', imp.address);
console.log('  shards:', imp.shard1 ? 1 : 0, imp.shard2 ? 1 : 0, imp.shard3 ? 1 : 0);
if (!imp.shard1 || !imp.shard2 || !imp.shard3) {
  console.log('  ERROR: import 必须返回 shard1/2/3');
  process.exit(1);
}

// 2. 注册片2 → tss_signer#1，片3 → tss_signer#2
console.log('[2/4] 注册 keystore（片2→tss#1，片3→tss#2）');
for (const [url, share] of [[tss1Url, imp.shard2], [tss2Url, imp.shard3]]) {
  const reg = await fetch(`${url}/v1/keystore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: imp.address, share }),
  });
  if (!reg.ok) {
    console.log(`  register failed (${url}):`, reg.status, await reg.text());
    process.exit(1);
  }
}
console.log('  OK');

const message = 'hello infrax 2-of-3';
const msgHash = ethers.hashMessage(message);
console.log('[3/4] msg_hash:', msgHash);

// 3+4. partner_index=1（片2）与 partner_index=2（片3）分别签名并复核
let allOk = true;
for (const partnerIndex of [1, 2]) {
  console.log(`[3/4] /v1/sign partner_index=${partnerIndex}`);
  const sigResp = await fetch(`${mpcUrl}/v1/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      share1: imp.shard1,
      wallet_address: imp.address,
      msg_hash: msgHash.slice(2),
      partner_index: partnerIndex,
    }),
  });
  const sigText = await sigResp.text();
  console.log('  sign status:', sigResp.status);
  if (!sigResp.ok) {
    console.log('  sign error:', sigText);
    allOk = false;
    continue;
  }
  const { signature } = JSON.parse(sigText);
  const r = '0x' + signature.slice(0, 64);
  const s = '0x' + signature.slice(64);
  let recoveredAddr = null;
  for (const v of [27, 28]) {
    const sig = ethers.Signature.from({ r, s, v });
    const addr = ethers.recoverAddress(msgHash, sig);
    console.log(`  recovered v=${v}  :`, addr);
    if (addr.toLowerCase() === imp.address.toLowerCase()) recoveredAddr = addr;
  }
  if (recoveredAddr) {
    console.log(`  ✅ partner_index=${partnerIndex} 签名有效（recover 命中）`);
  } else {
    console.log(`  ❌ partner_index=${partnerIndex} 签名无效`);
    allOk = false;
  }
}

if (allOk) {
  console.log('\nE2E 2-OF-3 VERIFY OK（片1+片2 与 片1+片3 均可签名且地址一致）');
} else {
  console.log('\nE2E 2-OF-3 VERIFY FAILED');
  process.exit(1);
}
