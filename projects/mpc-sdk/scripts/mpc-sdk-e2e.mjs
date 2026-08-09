#!/usr/bin/env node
/**
 * @0xinfrax/mpc-sdk 生产 E2E — 钱包模块 + 会话模块全流程
 *
 * 仅在生产环境执行（用户硬约束：不在本地跑集成测试）。
 * 前置：
 *   - 生产机已 `npm i @0xinfrax/mpc-sdk`
 *   - env: MPC_BASE_URL（如 http://127.0.0.1:9104）、MPC_API_KEY（生产桥接 key）
 *   - sudo 可无密执行（用于 sudo journalctl 提取验证码）
 * 运行：MPC_BASE_URL=... MPC_API_KEY=... node mpc-sdk-e2e.mjs
 */
import { execSync } from 'node:child_process';
import { MpcClient, MpcApiError, MpcNetworkError } from '@0xinfrax/mpc-sdk';

const BASE_URL = process.env.MPC_BASE_URL || 'http://127.0.0.1:9104';
const API_KEY = process.env.MPC_API_KEY || '';
const EMAIL = `e2e-${Date.now()}@mpc-sdk.infrax.test`;

let passed = 0;
let failed = 0;
function step(name, ok, extra = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}
function expectErr(fn, kind, label) {
  return fn().then(
    () => { step(label, false, '期望抛错但成功'); return undefined; },
    (e) => {
      const ok = e instanceof MpcApiError && e.kind === kind;
      step(label, ok, `kind=${e?.kind ?? e?.name} status=${e?.status} code=${e?.code} msg=${e?.message}`);
      return ok ? e : undefined;
    }
  );
}
function fetchCode(email, after = 8) {
  // 服务端 console.log 下发验证码 → systemd journal（仅生产可读）。
  // 同一邮箱可能多次 sendCode（register/createWallet/unlock/recover），
  // 必须取窗口内【最后一条】（最新）匹配行。
  const out = execSync(
    `sudo journalctl -u infrax-mpc --no-pager --since '${after} seconds ago' 2>/dev/null | grep "Code for ${email}:" | tail -1`,
    { encoding: 'utf8', timeout: 15000 }
  );
  // 取行内最后一个 6 位数字（邮箱含时间戳数字，不能取第一个）
  const matches = out.match(/(\d{6})/g);
  const code = matches && matches[matches.length - 1];
  if (!code) throw new Error(`未从 journal 提取到 ${email} 的验证码: ${out}`);
  return code;
}

console.log(`[MPC SDK E2E] baseUrl=${BASE_URL} email=${EMAIL}\n`);

const mpc = new MpcClient({ baseUrl: BASE_URL, apiKey: API_KEY });

// ── 0. 健康检查 ──
try {
  const r = await fetch(`${BASE_URL}/health`);
  step('GET /health', r.ok, `status=${r.status}`);
} catch { step('GET /health', false, '不可达'); }

// ── 1. 无 key → 401（unauthorized）──
console.log('\n[1] 鉴权分支：无 key 401');
await expectErr(() => new MpcClient({ baseUrl: BASE_URL }).wallet.sendCode({ email: EMAIL }), 'unauthorized', '无 key sendCode → 401');

// ── 2. 钱包模块 ──
console.log('\n[2] 钱包模块（sendCode/register/status/recover/createWallet）');

let reg;
let addr;
// sendCode → 提取验证码
await mpc.wallet.sendCode({ email: EMAIL });
const code1 = fetchCode(EMAIL);
step('sendCode → 收到 6 位验证码', /^\d{6}$/.test(code1), `code=${code1}`);

// 错误分支：错误验证码注册
const badCode = code1 === '000000' ? '111111' : '000000';
await expectErr(() => mpc.wallet.register({ email: EMAIL, code: badCode }), 'bad_request', '错误验证码 register → 400');

// 正确注册
reg = await mpc.wallet.register({ email: EMAIL, code: code1 });
addr = reg.data.walletAddress;
step('register → 返回钱包地址', /^0x[0-9a-fA-F]{40}$/.test(addr || ''), addr);
step('register 返回 id/email', !!(reg.data.id && reg.data.email === EMAIL.toLowerCase()));

// 错误分支：重复注册 → 400/1006
await expectErr(() => mpc.wallet.register({ email: EMAIL, code: code1 }), 'bad_request', '重复 register → 400（邮箱已注册）');

// status：双查询键
const stEmail = await mpc.wallet.status({ email: EMAIL });
step('status(email) → registered:true', stEmail.data.registered === true && stEmail.data.walletAddress?.toLowerCase() === addr.toLowerCase());
const stAddr = await mpc.wallet.status({ walletAddress: addr });
step('status(walletAddress) → registered:true', stAddr.data.registered === true);
const stUnknown = await mpc.wallet.status({ email: 'nobody-' + EMAIL });
step('status(未知邮箱) → registered:false', stUnknown.data.registered === false);

// createWallet（组合入口 = sendCode）
const cw = await mpc.wallet.createWallet({ email: EMAIL });
step('createWallet → sendCode 组合调用成功', cw.code === 0);

// ── 3. 会话模块 ──
console.log('\n[3] 会话模块（unlock/lock/status）');
await mpc.wallet.sendCode({ email: EMAIL });
const code2 = fetchCode(EMAIL);

// 错误分支：错误验证码解锁 → 400
await expectErr(() => mpc.session.unlock({ email: EMAIL, code: badCode }), 'bad_request', '错误验证码 unlock → 400');

const ses = await mpc.session.unlock({ email: EMAIL, code: code2 });
const token = ses.data.token;
step('unlock → 返回 mpc_ 令牌', token.startsWith('mpc_') && ses.data.address?.toLowerCase() === addr.toLowerCase(), token.slice(0, 12) + '…');

const stOk = await mpc.session.status({ token });
step('status(token) → unlocked:true + 剩余秒数', stOk.data.unlocked === true && stOk.data.remainingSeconds > 0, `${stOk.data.remainingSeconds}s`);

// 错误分支：不存在的 token
const stBogus = await mpc.session.status({ token: 'mpc_nonexistent_token' });
step('status(伪造 token) → unlocked:false', stBogus.data.unlocked === false);

const lock = await mpc.session.lock(token);
step('lock(token) → locked:true', lock.data.locked === true);

const stLocked = await mpc.session.status({ token });
step('status(已锁定 token) → unlocked:false', stLocked.data.unlocked === false);

// 已锁定 token 再做解锁操作前的幂等性：lock 不存在会话
const lock2 = await mpc.session.lock('mpc_nonexistent_token');
step('lock(不存在 token) → locked:false', lock2.data.locked === false);

// ── 4. 恢复流程封装（E-5e：验证码 → 分片重建 → 地址校验）──
console.log('\n[4] 恢复流程（recover + 地址校验）');
await mpc.wallet.sendCode({ email: EMAIL });
const code3 = fetchCode(EMAIL);

// 错误分支：错误验证码恢复 → 400
await expectErr(() => mpc.wallet.recover({ email: EMAIL, code: badCode }), 'bad_request', '错误验证码 recover → 400');

// 正确恢复 + expectedAddress 校验一致
const rec = await mpc.wallet.recover({ email: EMAIL, code: code3, expectedAddress: addr });
step('recover → 地址重建一致（客户端二次校验通过）', rec.data.walletAddress.toLowerCase() === addr.toLowerCase(), rec.data.walletAddress);

// 错误分支：expectedAddress 不一致 → SDK 409 conflict（40900）
// 注意：需新验证码（上一次 recover 已消耗 code3）
await mpc.wallet.sendCode({ email: EMAIL });
const code3b = fetchCode(EMAIL);
await expectErr(() => mpc.wallet.recover({ email: EMAIL, code: code3b, expectedAddress: '0x' + '1'.repeat(40) }), 'conflict', 'recover expectedAddress 不一致 → 409');

// 未注册邮箱恢复 → 404/1004（需先发码，verifyCode 先于钱包查询）
const unknownEmail = 'nobody-' + EMAIL;
await mpc.wallet.sendCode({ email: unknownEmail });
const code3c = fetchCode(unknownEmail);
await expectErr(() => mpc.wallet.recover({ email: unknownEmail, code: code3c }), 'not_found', '未注册邮箱 recover → 404');

// ── 汇总 ──
console.log(`\n[汇总] ${passed} 通过 / ${failed} 失败`);
if (failed > 0) { process.exit(1); }
console.log('ALL PASS');
