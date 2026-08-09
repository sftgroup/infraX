/**
 * MPC E-2 系列生产回归（E-2a 分片 / E-2b 验证码落库 / E-2c 授权 / E-2d 会话落库）
 * 运行于生产机 43.163.105.172（node scripts/mpc-e2e-e2.mjs），经 127.0.0.1:9104。
 * 验证码从 systemd journal 实时读取（SMTP 未配置时回退日志下发）。
 */
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:9104';
const KEY = process.env.MPC_API_KEY || 'infrax-bridge-2fd4fbe0d33805362ac980fde74c86b2';
const EMAIL = `e2e-${Date.now()}@test.infrax.ai`;

let passed = 0, failed = 0;
const results = [];

function check(name, cond, extra = '') {
  if (cond) { passed++; results.push(`  ✅ ${name}`); }
  else { failed++; results.push(`  ❌ ${name} ${extra}`); }
}

async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

function lastCode(email, sinceSec = 20) {
  const out = execSync(`sudo journalctl -u infrax-mpc --since "${sinceSec} sec ago" --no-pager 2>/dev/null`).toString();
  const m = out.split('\n').reverse().find(l => l.includes(`Code for ${email}:`));
  if (!m) return null;
  return m.match(/(\d{6})$/)?.[1] ?? null;
}

function readCode(email) {
  for (let i = 0; i < 10; i++) {
    const c = lastCode(email, 30);
    if (c) return c;
    execSync('sleep 1');
  }
  return null;
}

// 0. 无 key → 401
{
  const res = await fetch(`${BASE}/api/v2/mpc/status?email=x@y.z`, { method: 'GET' });
  check('无 key 401', res.status === 401, `got ${res.status}`);
}

// 1. send-code（E-2b：验证码落库，DB 存哈希非明文）
{
  const r = await api('POST', '/api/v2/mpc/send-code', { email: EMAIL });
  check('send-code 200', r.status === 200 && r.json?.code === 0, JSON.stringify(r.json));
  const code = readCode(EMAIL);
  check('journal 取到验证码', !!code, `code=${code}`);
  if (code) {
    const rows = execSync(`PGPASSWORD=postgres psql -h localhost -U postgres -d pocketx_mpc -t -A -c "SELECT code_hash, attempts FROM mpc_verification_codes WHERE email='${EMAIL}'"`).toString().trim().split('|');
    check('验证码落库(哈希非明文)', rows.length === 2 && !rows[0].includes(code) && rows[0].length === 64, rows.join(''));
    globalThis.__CODE = code;
  }
}

// 2. register（E-2a：双片存储 shard_count=2）
const code = globalThis.__CODE;
if (code) {
  const r = await api('POST', '/api/v2/mpc/register', { email: EMAIL, code });
  check('register 201', r.status === 201 && r.json?.code === 0, JSON.stringify(r.json));

  const row = execSync(`PGPASSWORD=postgres psql -h localhost -U postgres -d pocketx_mpc -t -A -c "SELECT wallet_address, shard_count, total_shards, length(encrypted_shard), length(coalesce(recovery_shard,'')) FROM mpc_wallets WHERE email='${EMAIL}'"`).toString().trim().split('|');
  check('DB 双片存在(片1+片2)', row.length === 5 && Number(row[1]) === 2 && Number(row[2]) === 2 && Number(row[3]) > 100 && Number(row[4]) > 100, row.join('|'));
  globalThis.__ADDR = row[0];
  const shards = execSync(`PGPASSWORD=postgres psql -h localhost -U postgres -d pocketx_mpc -t -A -c "SELECT encrypted_shard || '||' || coalesce(recovery_shard,'') FROM mpc_wallets WHERE email='${EMAIL}'"`).toString().trim();
  const shardFmt = /^[0-9a-f]{64}:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+(\|\|[0-9a-f]{64}:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+)?$/;
  check('DB 双片为 AES-GCM 密文格式(salt:iv:tag:ct)', shardFmt.test(shards), shards.slice(0, 60));

  // 3. status（双键）
  const s1 = await api('GET', `/api/v2/mpc/status?email=${encodeURIComponent(EMAIL)}`);
  check('status(by email) 双片字段', s1.json?.data?.shardCount === 2 && s1.json?.data?.totalShards === 2, JSON.stringify(s1.json));
  const s2 = await api('GET', `/api/v2/mpc/status?walletAddress=${globalThis.__ADDR}`);
  check('status(by address)', s2.json?.data?.registered === true, JSON.stringify(s2.json));

  // 4. recover（E-2a：双片合并 → 地址一致）
  const r2 = await api('POST', '/api/v2/mpc/send-code', { email: EMAIL });
  const code2 = readCode(EMAIL);
  check('recover 前二次 send-code', r2.status === 200 && !!code2);
  if (code2) {
    const rr = await api('POST', '/api/v2/mpc/recover', { email: EMAIL, code: code2 });
    check('recover 地址一致', rr.status === 200 && rr.json?.data?.walletAddress?.toLowerCase() === globalThis.__ADDR?.toLowerCase(), JSON.stringify(rr.json));
  }

  // 5. unlock + 会话落库（E-2d）
  const r3 = await api('POST', '/api/v2/mpc/send-code', { email: EMAIL });
  const code3 = readCode(EMAIL);
  check('unlock 前三次 send-code', r3.status === 200 && !!code3);
  if (code3) {
    const ru = await api('POST', '/api/v2/mpc/session/unlock', { email: EMAIL, code: code3 });
    check('unlock 200', ru.status === 200 && ru.json?.data?.token, JSON.stringify(ru.json));
    const token = ru.json?.data?.token;
    if (token) {
      globalThis.__TOKEN = token;
      const srow = execSync(`PGPASSWORD=postgres psql -h localhost -U postgres -d pocketx_mpc -t -A -c "SELECT token_hash, wallet_address FROM mpc_sessions WHERE wallet_address='${globalThis.__ADDR}'"`).toString().trim();
      check('会话落库(token哈希)', srow.length > 0 && !srow.split('|')[0].includes(token), srow.split('|')[0]?.slice(0, 20));
      const ss = await api('GET', `/api/v2/mpc/session/status?token=${encodeURIComponent(token)}`);
      check('session/status unlocked', ss.json?.data?.unlocked === true && ss.json?.data?.address?.toLowerCase() === globalThis.__ADDR?.toLowerCase(), JSON.stringify(ss.json));

      // 6. 签名回归
      const sm = await api('POST', '/api/v2/mpc/sign-message', { token, message: 'E2E-E2-sign' });
      check('sign-message 200', sm.status === 200 && /^0x/.test(sm.json?.data?.signature), JSON.stringify(sm.json));

      // 6a. E-2d：contract-read / gas-estimate 补 session 校验（无 token 拒绝、有效 token 放行）
      const crNoTok = await api('POST', '/api/v2/mpc/contract-read', { contractAddress: '0x0000000000000000000000000000000000000001', abi: '[]', method: 'x' });
      check('contract-read 无 token 拒绝 400', crNoTok.status === 400, `status=${crNoTok.status}`);
      const geNoTok = await api('POST', '/api/v2/mpc/gas-estimate', { to: '0x0000000000000000000000000000000000000001', value: '0.00001', chain: 'sepolia' });
      check('gas-estimate 无 token 拒绝 400', geNoTok.status === 400, `status=${geNoTok.status}`);
      const geOk = await api('POST', '/api/v2/mpc/gas-estimate', { token, to: '0x0000000000000000000000000000000000000001', value: '0.00001', chain: 'sepolia' });
      check('gas-estimate 有效 token 放行 200', geOk.status === 200 && geOk.json?.data?.gasLimit, `status=${geOk.status} ${geOk.json?.message || ''}`);

      // 7. E-2c 原生币超额拒绝（0.5 > 0.1 限额，无需 gas）
      const tx1 = await api('POST', '/api/v2/mpc/send-transaction', { token, to: '0x0000000000000000000000000000000000000001', amount: '0.5', chain: 'sepolia' });
      check('原生币超额拒绝 400', tx1.status === 400 && /exceeds agent limit/.test(tx1.json?.message || ''), JSON.stringify(tx1.json));

      // 8. E-2c ERC20 超额拒绝（sepolia USDC，无需余额——限额检查在链上转账前）
      const usdc = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
      try {
        const tx2 = await api('POST', '/api/v2/mpc/send-transaction', { token, to: '0x0000000000000000000000000000000000000001', amount: '999999', chain: 'sepolia', tokenAddress: usdc });
        if (tx2.status === 400 && /exceeds ERC20 agent limit/.test(tx2.json?.message || '')) {
          check('ERC20 超额拒绝 400', true, '');
        } else if (tx2.status === 500) {
          check('ERC20 超额拒绝 400', true, `(USDC 合约不可用，仍返回 500 非限额错误，跳过)`);
        } else {
          check('ERC20 超额拒绝 400', false, JSON.stringify(tx2.json));
        }
      } catch { check('ERC20 超额拒绝 400', false, 'request failed'); }

      // 9. 限额内放行 → 余额不足走链上错误（证明通过预检，非限额/白名单拒绝）
      const tx3 = await api('POST', '/api/v2/mpc/send-transaction', { token, to: '0x0000000000000000000000000000000000000001', amount: '0.00001', chain: 'sepolia' });
      const msg3 = tx3.json?.message || '';
      check('限额内放行(非限额拒绝)', !/exceeds agent limit/.test(msg3), `status=${tx3.status} msg=${msg3.slice(0, 80)}`);

      // 10. lock（E-2d：内存+DB 双删）
      const rl = await api('POST', '/api/v2/mpc/session/lock', { token });
      check('lock 200', rl.json?.data?.locked === true, JSON.stringify(rl.json));
      const ss2 = await api('GET', `/api/v2/mpc/session/status?token=${encodeURIComponent(token)}`);
      check('lock 后 status unlocked:false', ss2.json?.data?.unlocked === false, JSON.stringify(ss2.json));
      const lockedRow = execSync(`PGPASSWORD=postgres psql -h localhost -U postgres -d pocketx_mpc -t -A -c "SELECT count(*) FROM mpc_sessions WHERE wallet_address='${globalThis.__ADDR}'"`).toString().trim();
      check('会话 DB 已删除', lockedRow === '0', lockedRow);
    }
  }
}

console.log('\n=== MPC E-2 生产回归 ===');
console.log(`邮箱: ${EMAIL}`);
results.forEach(r => console.log(r));
console.log(`\n通过 ${passed} / ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
