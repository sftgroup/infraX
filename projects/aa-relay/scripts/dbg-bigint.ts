// 最小复现：用 ENABLE-mode nonce 的 op 调 bundler，对比 viem client 与 raw fetch 的行为
import { createClient, http, toHex } from 'viem';

const url = 'http://43.159.60.46:4338';
const entryPoint = '0x97e4cddcffeaf4580bc6315fee512f2b2d82798a';
const sender = '0x7B9c7bb183210C46227c89DF5401aad9B642050d';
const nonce = 0x101fbbca78d2d7d08c1163aa57a0056973ef4fd8c7400000000000000000000n;

const rpcOp = {
  sender,
  nonce: toHex(nonce),
  callData: '0x1cff79cd0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000600000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a4',
  callGasLimit: '0x16e360',
  verificationGasLimit: '0x927c0',
  preVerificationGas: '0xea60',
  maxFeePerGas: '0x3b9aca00',
  maxPriorityFeePerGas: '0x3b9aca00',
  signature: '0x0000000000000000000000000000000000000001' + '0'.repeat(800),
};

async function main() {
  console.log('=== 1) viem client.request ===');
  const client = createClient({ transport: http(url) });
  try {
    const r = await (client as any).request({
      method: 'eth_estimateUserOperationGas',
      params: [rpcOp, entryPoint],
    });
    console.log('OK', JSON.stringify(r).slice(0, 300));
  } catch (e: any) {
    console.error('ERR name:', e?.name);
    console.error('ERR message:', String(e?.message ?? '').slice(0, 400));
    console.error('ERR stack:', String(e?.stack ?? '').slice(0, 800));
  }

  console.log('\n=== 2) raw fetch ===');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'eth_estimateUserOperationGas', params: [rpcOp, entryPoint] });
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    console.log('status:', r.status);
    console.log('body:', (await r.text()).slice(0, 500));
  } catch (e: any) {
    console.error('fetch ERR:', e?.message);
  }
}

main().catch((e) => console.error('main err', e));
