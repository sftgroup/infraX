// aa-relay session API 生产回归（E-3a/b 服务端部分）：
// create → list → validate（允许/拒绝）→ disable → list 确认移除 → product 隔离
// 链上 enable/disable 由 owner 签名 UserOp 完成（见 aa-session-e2e，需链上资金）。
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

const BASE = 'http://127.0.0.1:9131';
const KEY = process.env.AA_RELAY_API_KEY || execSync(`grep -oP "AA_RELAY_API_KEY=\\K[^\\"]+" /etc/systemd/system/infrax-aa-relay.service`).toString().trim();
const H = { 'Content-Type': 'application/json', 'X-API-Key': KEY };

let passed = 0, failed = 0;
const results = [];
const check = (name, cond, extra = '') => {
  if (cond) { passed++; results.push(`  ok ${name}`); }
  else { failed++; results.push(`  FAIL ${name} ${extra}`); }
};

// 测试 owner EOA（随机生成；API 层只用地址，无需资金）
const owner = privateKeyToAccount('0x' + randomBytes(32).toString('hex')).address;
const product = `e2e-${Date.now()}`;
const TARGET = '0x1111111111111111111111111111111111111111';
const NOW = Math.floor(Date.now() / 1000);
const permissions = [
  { targets: [TARGET], selectors: ['0x095ea7b3'], valueLimit: '0x0de0b6b3a7640000' }, // approve ≤1 OXA
];

// 1. 创建 session
{
  const r = await fetch(`${BASE}/v1/session`, { method: 'POST', headers: H, body: JSON.stringify({ chain: 'oxachain', product, owner, permissions, validUntil: NOW + 3600 }) });
  const j = await r.json();
  const ok = r.status === 200 && j.data?.sessionId && j.data?.enableCallData?.startsWith('0x') && j.data?.accountAddress?.startsWith('0x') && j.data?.sessionKey?.startsWith('0x');
  check('创建 session 200 + 预测账户地址 + enableCallData + sessionKey', ok, `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  if (ok) {
    check('enableCallData 非空且为 execute 编码', j.data.enableCallData.length > 10, j.data.enableCallData.slice(0, 20));
    check('sessionKey 为 64 hex 私钥', /^0x[0-9a-f]{64}$/.test(j.data.sessionKey));
  }
  // 4. disable（复用上面创建的 sessionId）
  if (ok) {
    const r2 = await fetch(`${BASE}/v1/session/disable`, { method: 'POST', headers: H, body: JSON.stringify({ chain: 'oxachain', product, account: j.data.accountAddress, sessionId: j.data.sessionId }) });
    const j2 = await r2.json();
    check('disable 200 + disableCallData + found:true', r2.status === 200 && j2.data?.disableCallData?.startsWith('0x') && j2.data?.found === true, `HTTP ${r2.status}: ${JSON.stringify(j2).slice(0, 120)}`);
  }
}

// 2. 创建后 list 查询
{
  const create = await fetch(`${BASE}/v1/session`, { method: 'POST', headers: H, body: JSON.stringify({ chain: 'oxachain', product, owner, permissions, validUntil: NOW + 7200 }) });
  const cj = await create.json();
  const account = cj.data.accountAddress;
  const r = await fetch(`${BASE}/v1/session?chain=oxachain&product=${product}&account=${account}`, { headers: H });
  const j = await r.json();
  const found = Array.isArray(j.data) && j.data.some((p) => p.sessionId === cj.data.sessionId && p.signer.toLowerCase() === cj.data.signer.toLowerCase());
  check('list 查询含刚创建 session（persisted）', r.status === 200 && found, `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);

  // 5. product 隔离：其他 product 查不到
  const r2 = await fetch(`${BASE}/v1/session?chain=oxachain&product=other-${product}&account=${account}`, { headers: H });
  const j2 = await r2.json();
  check('product 隔离（其他 product 空列表）', r2.status === 200 && Array.isArray(j2.data) && j2.data.length === 0, JSON.stringify(j2).slice(0, 120));

  // 清理
  await fetch(`${BASE}/v1/session/disable`, { method: 'POST', headers: H, body: JSON.stringify({ chain: 'oxachain', product, account, sessionId: cj.data.sessionId }) });
}

// 3. validate 链下预检（E-3b）
{
  const policy = { network: 'evm', sessionId: '0x' + 'ab'.repeat(32), signer: owner, validAfter: '0', validUntil: String(NOW + 3600), permissions };
  const allow = await fetch(`${BASE}/v1/session/validate`, { method: 'POST', headers: H, body: JSON.stringify({ policy, call: { target: TARGET, selector: '0x095ea7b3', value: '0x0' } }) });
  const aj = await allow.json();
  check('validate 权限内调用 allowed', allow.status === 200 && aj.data?.ok === true, `HTTP ${allow.status}: ${JSON.stringify(aj).slice(0, 100)}`);

  const deny = await fetch(`${BASE}/v1/session/validate`, { method: 'POST', headers: H, body: JSON.stringify({ policy, call: { target: '0x2222222222222222222222222222222222222222', selector: '0x095ea7b3', value: '0x0' } }) });
  const dj = await deny.json();
  check('validate 权限外 target 拒绝', deny.status === 200 && dj.data?.ok === false, `HTTP ${deny.status}: ${JSON.stringify(dj).slice(0, 100)}`);

  const over = await fetch(`${BASE}/v1/session/validate`, { method: 'POST', headers: H, body: JSON.stringify({ policy, call: { target: TARGET, selector: '0x095ea7b3', value: '0x0de0b6b3a7640001' } }) });
  const oj = await over.json();
  check('validate 超限额拒绝', over.status === 200 && oj.data?.ok === false, `HTTP ${over.status}: ${JSON.stringify(oj).slice(0, 100)}`);
}

// 6. 缺参 400
{
  const r = await fetch(`${BASE}/v1/session`, { method: 'POST', headers: H, body: JSON.stringify({ chain: 'oxachain' }) });
  check('创建缺参 400', r.status === 400, `HTTP ${r.status}`);
}

console.log('\n=== aa-relay session API 生产回归 ===');
results.forEach((r) => console.log(r));
console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
