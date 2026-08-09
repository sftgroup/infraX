// aa-relay 生产回归（E-1c）：health/鉴权/转发/估算/收据 + 错误透传语义
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:9131';
const KEY = process.env.AA_RELAY_API_KEY || execSync(`grep -oP "AA_RELAY_API_KEY=\\K[^\\"]+" /etc/systemd/system/infrax-aa-relay.service`).toString().trim();

let passed = 0, failed = 0;
const results = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; results.push(`  ok ${name}`); }
  else { failed++; results.push(`  FAIL ${name} ${extra}`); }
};

const op = (sender = '0x0000000000000000000000000000000000000001') => ({
  sender, nonce: '0x0', callData: '0x', callGasLimit: '0x186a0',
  verificationGasLimit: '0x186a0', preVerificationGas: '0x5208',
  maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x3b9aca00', signature: '0x',
});

// 1. health 免鉴权
{
  const r = await fetch(`${BASE}/health`);
  const j = await r.json();
  check('health 免鉴权 200', r.status === 200 && j.status === 'ok' && j.chains.includes('oxachain'), JSON.stringify(j));
}

// 2. 鉴权
{
  const r1 = await fetch(`${BASE}/v1/userops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('无 key 401', r1.status === 401);
  const r2 = await fetch(`${BASE}/v1/userops`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'wrong' }, body: '{}' });
  check('错 key 401', r2.status === 401);
  const r3 = await fetch(`${BASE}/v1/userops`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY }, body: JSON.stringify({}) });
  check('对 key 200(缺参 400 语义)', r3.status === 400 && (await r3.json()).code === 1001);
  const r4 = await fetch(`${BASE}/v1/userops`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` }, body: JSON.stringify({}) });
  check('Bearer 鉴权可用', r4.status === 400);
}

// 3. 未知链 400
{
  const r = await fetch(`${BASE}/v1/userops`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY }, body: JSON.stringify({ chain: 'nope', wait: false, op: op() }) });
  const j = await r.json();
  check('未知链 400', r.status === 400 && /unknown or misconfigured/.test(j.message), JSON.stringify(j));
}

// 4. broadcast：无效 op → 400 + bundler 业务错误透传（非 502）
{
  const r = await fetch(`${BASE}/v1/userops`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY }, body: JSON.stringify({ chain: 'oxachain', wait: false, op: op() }) });
  const j = await r.json();
  check('broadcast 业务错误 400 透传', r.status === 400 && /FailedOp|revert|failed/i.test(j.message), `HTTP ${r.status}: ${j.message.slice(0, 100)}`);
}

// 5. estimate → 400 + AA20 透传
{
  const r = await fetch(`${BASE}/v1/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY }, body: JSON.stringify({ chain: 'oxachain', op: op() }) });
  const j = await r.json();
  check('estimate 业务错误 400 透传', r.status === 400 && /AA20|account not deployed|revert|failed/i.test(j.message), `HTTP ${r.status}: ${j.message.slice(0, 100)}`);
}

// 6. wait=true 无效 op → 400 透传
{
  const r = await fetch(`${BASE}/v1/userops`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY }, body: JSON.stringify({ chain: 'oxachain', op: op() }) });
  const j = await r.json();
  check('wait=true 业务错误 400 透传', r.status === 400 && /bundler:/.test(j.message), `HTTP ${r.status}: ${j.message.slice(0, 100)}`);
}

// 7. 收据查询（不存在的 hash → receipt null）
{
  const r = await fetch(`${BASE}/v1/userops/0x0000000000000000000000000000000000000000000000000000000000000000?chain=oxachain`, { headers: { 'X-API-Key': KEY } });
  const j = await r.json();
  check('收据查询 receipt:null', r.status === 200 && j.data.receipt === null, JSON.stringify(j));
}

console.log('\n=== aa-relay 生产回归 ===');
results.forEach(r => console.log(r));
console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
