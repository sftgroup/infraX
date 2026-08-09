// M3 服务端集成 E2E：四端点 TSS 签名路径 + ethers 复核
import { ethers } from '/home/ubuntu/infraX-1/projects/mpc/node_modules/ethers/lib.esm/index.js';

const BASE = 'http://127.0.0.1:6003';
const TOKEN = process.env.MPC_TOKEN;
const WALLET = process.env.MPC_WALLET;
const KEY = { 'Content-Type': 'application/json', 'x-api-key': 'dev-mpc-key' };

async function call(path, body, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, { method: 'POST', headers: KEY, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path} ${r.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

// ── 1. sign-message (EIP-191) ──
console.log('\n[1] sign-message');
{
  const message = 'hello infrax m3 e2e';
  const { data } = await call('/api/v2/mpc/sign-message', { token: TOKEN, message });
  const digest = ethers.hashMessage(message);
  const recovered = ethers.recoverAddress(digest, data.signature);
  check('signature 65B', /^0x[0-9a-fA-F]{130}$/.test(data.signature));
  check('recoverAddress 匹配', recovered.toLowerCase() === WALLET.toLowerCase(), `${recovered} vs ${WALLET}`);
  check('返回 address', data.address.toLowerCase() === WALLET.toLowerCase());
}

// ── 2. sign-typed-data (EIP-712) ──
console.log('\n[2] sign-typed-data');
{
  const domain = { name: 'InfraX MPC', version: '1', chainId: 11155111 };
  const types = {
    Transfer: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  };
  const value = { to: '0x0000000000000000000000000000000000000001', amount: '1000' };
  const { data } = await call('/api/v2/mpc/sign-typed-data', { token: TOKEN, domain, types, value });
  const digest = ethers.TypedDataEncoder.hash(domain, types, value);
  const recovered = ethers.recoverAddress(digest, data.signature);
  check('signature 65B', /^0x[0-9a-fA-F]{130}$/.test(data.signature));
  check('recoverAddress 匹配', recovered.toLowerCase() === WALLET.toLowerCase(), `${recovered} vs ${WALLET}`);
}

// ── 3. send-transaction (native ETH 转账，TSS 签名 + gateway 广播) ──
console.log('\n[3] send-transaction');
{
  const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
  const before = await provider.getBalance(to);
  const { data } = await call('/api/v2/mpc/send-transaction', {
    token: TOKEN, to, amount: '0.01', chain: 'sepolia',
  }, 120000);
  check('txHash 返回', /^0x[0-9a-fA-F]{64}$/.test(data.txHash), data.txHash);
  check('from 为 TSS 钱包', data.from.toLowerCase() === WALLET.toLowerCase());
  const rc = await provider.getTransactionReceipt(data.txHash);
  check('receipt 确认 status=1', rc && rc.status === 1);
  const after = await provider.getBalance(to);
  check('接收方余额 +0.01', after - before === ethers.parseEther('0.01'), `${after - before}`);
}

// ── 4. contract-write (ERC20 transfer，staticCall 模拟 + TSS 签名广播) ──
console.log('\n[4] contract-write');
{
  const erc20 = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
  const to = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
  const abi = [
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address,uint256) returns (bool)',
  ];
  const contract = new ethers.Contract(erc20, abi, new ethers.JsonRpcProvider('http://127.0.0.1:8545'));
  const before = await contract.balanceOf(WALLET);
  const amount = ethers.parseEther('1');
  const { data } = await call('/api/v2/mpc/contract-write', {
    token: TOKEN, contractAddress: erc20, abi, method: 'transfer',
    args: [to, amount.toString()], chain: 'sepolia',
  }, 120000);
  check('txHash 返回', /^0x[0-9a-fA-F]{64}$/.test(data.txHash), data.txHash);
  check('method=transfer', data.method === 'transfer');
  const rc = await new ethers.JsonRpcProvider('http://127.0.0.1:8545').getTransactionReceipt(data.txHash);
  check('receipt 确认 status=1', rc && rc.status === 1);
  const after = await contract.balanceOf(WALLET);
  check('TSS 余额 -1 TST', before - after === amount, `${before - after}`);
}

console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
process.exit(fail ? 1 : 0);
