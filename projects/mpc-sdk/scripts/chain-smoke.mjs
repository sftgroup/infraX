// E-5d 链上模块 SDK 封装 smoke 测试（mock server，不碰真实 MPC 服务）
// 验证：7 方法 → 端点路径映射、body 序列化、响应解析、错误路径（401）
import http from 'node:http';
import { MpcClient, MpcApiError } from '../dist/index.js';

// ── mock MPC server ──
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* noop */ }
    seen.push({ method: req.method, path: req.url, body: payload, key: req.headers['x-api-key'] });

    const send = (data) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 0, message: 'ok', data }));
    };
    const bad = (status, code, message) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code, message, data: null }));
    };

    if (!req.headers['x-api-key']) return bad(401, 401, 'unauthorized');
    switch (req.url) {
      case '/api/v2/mpc/balance':
        return send({ address: payload.tokenAddress ? '0xbeef' : '0xabc', chain: payload.chain || 'sepolia', nativeBalance: '1.25', nativeSymbol: 'ETH' });
      case '/api/v2/mpc/sign-message':
        return send({ signature: '0x' + 'ab'.repeat(65), address: '0xabc' });
      case '/api/v2/mpc/sign-typed-data':
        return send({ signature: '0x' + 'cd'.repeat(65), address: '0xabc' });
      case '/api/v2/mpc/send-transaction':
        return send({ txHash: '0x' + 'ef'.repeat(32), from: '0xabc', to: payload.to, amount: payload.amount, chain: payload.chain || 'sepolia', token: 'native', blockNumber: 5, gasUsed: '21000' });
      case '/api/v2/mpc/contract-read':
        return send({ contractAddress: payload.contractAddress, method: payload.method, result: '42' });
      case '/api/v2/mpc/contract-write':
        return send({ txHash: '0x' + '11'.repeat(32), from: '0xabc', contractAddress: payload.contractAddress, method: payload.method, chain: payload.chain || 'sepolia', blockNumber: 6, gasUsed: '52363' });
      case '/api/v2/mpc/gas-estimate':
        return send({ chain: 'sepolia', gasLimit: '21000', gasPrice: '1.5 Gwei', estimatedCost: '0.0000315 ETH', estimatedCostWei: '31500000000000' });
      default:
        return bad(404, 1004, 'not found');
    }
  });
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const mpc = new MpcClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'dev-key' });
const token = 'mpc_mock_token';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// 1. balance（含 tokenAddress 分支）
{
  const r = await mpc.chain.balance({ token, chain: 'sepolia' });
  check('balance 返回 nativeBalance', r.data.nativeBalance === '1.25', r.data.nativeBalance);
  const r2 = await mpc.chain.balance({ token, tokenAddress: '0xbeef' });
  check('balance 透传 tokenAddress', seen.at(-1).body.tokenAddress === '0xbeef');
}

// 2. signMessage
{
  const r = await mpc.chain.signMessage({ token, message: 'hello' });
  check('signMessage 返回 65B 签名', /^0x[0-9a-f]{130}$/.test(r.data.signature));
  check('signMessage body 含 message', seen.at(-1).body.message === 'hello');
}

// 3. signTypedData
{
  const domain = { name: 'Test', version: '1', chainId: 11155111 };
  const types = { Person: [{ name: 'name', type: 'string' }] };
  const value = { name: 'alice' };
  const r = await mpc.chain.signTypedData({ token, domain, types, value });
  check('signTypedData 返回签名', r.data.signature.startsWith('0x'));
  const last = seen.at(-1).body;
  check('signTypedData body 含 domain/types/value', last.domain.name === 'Test' && last.types.Person.length === 1 && last.value.name === 'alice');
}

// 4. sendTransaction
{
  const r = await mpc.chain.sendTransaction({ token, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', amount: '0.01', chain: 'sepolia' });
  check('sendTransaction 返回 txHash', /^0x[0-9a-f]{64}$/.test(r.data.txHash));
  const last = seen.at(-1).body;
  check('sendTransaction body 含 to/amount/chain', last.to && last.amount === '0.01' && last.chain === 'sepolia');
  // ERC20 分支
  await mpc.chain.sendTransaction({ token, to: '0x1111', amount: '5', tokenAddress: '0x2222' });
  check('sendTransaction 透传 tokenAddress', seen.at(-1).body.tokenAddress === '0x2222');
}

// 5. contractRead
{
  const r = await mpc.chain.contractRead({ token, contractAddress: '0xabc', abi: [{ name: 'balanceOf', type: 'function' }], method: 'balanceOf', args: ['0x123'] });
  check('contractRead 返回 result', r.data.result === '42');
  const last = seen.at(-1).body;
  check('contractRead body 含 abi/method/args', Array.isArray(last.abi) && last.method === 'balanceOf' && last.args[0] === '0x123');
}

// 6. contractWrite
{
  const r = await mpc.chain.contractWrite({ token, contractAddress: '0xabc', abi: [{ name: 'transfer', type: 'function' }], method: 'transfer', args: ['0x123', '1000000000000000000'], chain: 'sepolia' });
  check('contractWrite 返回 txHash', /^0x[0-9a-f]{64}$/.test(r.data.txHash));
  check('contractWrite body 含 method', seen.at(-1).body.method === 'transfer');
}

// 7. gasEstimate
{
  const r = await mpc.chain.gasEstimate({ token, to: '0xabc', value: '0.01', chain: 'sepolia' });
  check('gasEstimate 返回 gasLimit/gasPrice', r.data.gasLimit === '21000' && r.data.gasPrice.includes('Gwei'));
  const last = seen.at(-1).body;
  check('gasEstimate body 含 to/value/data 可选', last.to === '0xabc' && last.value === '0.01');
}

// 错误路径：缺 key → 401 MpcApiError.kind=unauthorized
{
  const noKey = new MpcClient({ baseUrl: `http://127.0.0.1:${port}` });
  try {
    await noKey.chain.balance({ token });
    check('缺 key 抛错', false);
  } catch (e) {
    check('缺 key → MpcApiError kind=unauthorized', e instanceof MpcApiError && e.kind === 'unauthorized', `${e.status}`);
  }
}

server.close();
console.log(`\n══ E-5d chain-module smoke: ${pass} passed, ${fail} failed ══`);
process.exit(fail ? 1 : 0);
