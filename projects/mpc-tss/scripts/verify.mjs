import { ethers } from '/home/ubuntu/infraX-1/projects/mpc/node_modules/ethers/lib.esm/index.js';
import { readFileSync } from 'node:fs';

const mpcUrl = 'http://127.0.0.1:9201';
const tssUrl = 'http://127.0.0.1:9200';
const imp = JSON.parse(readFileSync('/tmp/m3test/import.json', 'utf8'));

const message = 'hello infrax m3';
const msgHash = ethers.hashMessage(message); // EIP-191 digest（Node 侧算好）
console.log('msg_hash:', msgHash);

// 1. 注册片2 到 tss_signer（RecoveryKey 侧）
const reg = await fetch(`${tssUrl}/v1/keystore`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ wallet_address: imp.address, share: imp.shard2 }),
});
console.log('keystore register:', reg.status, await reg.text());

// 2. 调 mpc_signer /v1/sign（持片1）
const sigResp = await fetch(`${mpcUrl}/v1/sign`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    share1: imp.shard1,
    wallet_address: imp.address,
    msg_hash: msgHash.slice(2),
  }),
});
const sigText = await sigResp.text();
console.log('sign status:', sigResp.status);
if (!sigResp.ok) {
  console.log('sign error:', sigText);
  process.exit(1);
}
const { signature } = JSON.parse(sigText);
console.log('signature:', signature);

// 3. ethers 复核：64B r||s → Signature.from → recoverAddress
const r = '0x' + signature.slice(0, 64);
const s = '0x' + signature.slice(64);
let recoveredAddr = null;
for (const v of [27, 28]) {
  const sig = ethers.Signature.from({ r, s, v });
  const addr = ethers.recoverAddress(msgHash, sig);
  console.log(`recovered v=${v}  :`, addr);
  if (addr.toLowerCase() === imp.address.toLowerCase()) recoveredAddr = addr;
}
console.log('expected address:', imp.address);
if (recoveredAddr) {
  console.log('E2E VERIFY OK');
} else {
  console.log('E2E VERIFY FAILED');
  process.exit(1);
}
