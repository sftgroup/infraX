#!/usr/bin/env node
/**
 * InfraX E2E Test Suite — Production Environment
 * Version: v0.3.1-20260717
 * Target: 43.156.99.215 (ports 9100-9111)
 *
 * Usage:
 *   # On the production server itself:
 *   node e2e-test.js
 *
 *   # Against a remote server:
 *   TARGET_HOST=43.156.99.215 node e2e-test.js
 *
 *   # Custom web proxy port:
 *   WEB_PORT=9111 node e2e-test.js
 *
 * Zero dependencies — uses only Node.js built-in http module.
 */

const http = require('http');
const { hostname } = require('os');

// ─── Configuration ────────────────────────────────────────────────
const TARGET_HOST = process.env.TARGET_HOST || 'localhost';
const WEB_PORT   = parseInt(process.env.WEB_PORT || '9111', 10);
const BASE_URL   = `http://${TARGET_HOST}:${WEB_PORT}`;

// Direct service ports for health checks (used when running on server itself)
const DIRECT_PORTS = {
  admin:    parseInt(process.env.ADMIN_PORT    || '9100', 10),
  collector:parseInt(process.env.COLLECTOR_PORT|| '9101', 10),
  dc:       parseInt(process.env.DC_PORT       || '9102', 10),
  dcMcp:    parseInt(process.env.DC_MCP_PORT   || '9103', 10),
  mpc:      parseInt(process.env.MPC_PORT      || '9104', 10),
  mpcMcp:   parseInt(process.env.MPC_MCP_PORT  || '9105', 10),
  payment:  parseInt(process.env.PAYMENT_PORT  || '9106', 10),
  vault:    parseInt(process.env.VAULT_PORT    || '9107', 10),
  vaultMcp: parseInt(process.env.VAULT_MCP_PORT|| '9108', 10),
  waas:     parseInt(process.env.WAAS_PORT     || '9109', 10),
  walletMcp:parseInt(process.env.WALLET_MCP_PORT||'9110', 10),
  web:      parseInt(process.env.WEB_PORT_VAL  || '9111', 10),
};

const REQUEST_TIMEOUT = 8000;

// Admin credentials (from DEPLOYMENT.md — env vars)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

// ─── Test Framework ────────────────────────────────────────────────
const results = { passed: 0, failed: 0, skipped: 0, errors: [] };
let adminToken = null;

function record(name, ok, detail) {
  if (ok === 'SKIP') { results.skipped++; return; }
  if (ok) { results.passed++; process.stdout.write(`  ✅ ${name}\n`); }
  else    { results.failed++; process.stdout.write(`  ❌ ${name} — ${detail}\n`); results.errors.push({ name, detail }); }
}

function _http(method, host, port, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: host, port, path, method, headers, timeout: REQUEST_TIMEOUT };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, data, json: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, data }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (body) { req.write(JSON.stringify(body)); }
    req.end();
  });
}

function api(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers['x-admin-token'] = adminToken;
  return _http(method, TARGET_HOST, WEB_PORT, path, headers, body);
}

function apiGet(path)  { return api('GET', path); }
function apiPost(path, body) { return api('POST', path, body); }

async function directHealth(serviceName, port) {
  try {
    const r = await _http('GET', TARGET_HOST, port, '/health', {});
    return r.status >= 200 && r.status < 500;
  } catch { return false; }
}

// ─── Test Suites ───────────────────────────────────────────────────

// T1: Health Checks (all 12 services, direct ports)
async function testHealthChecks() {
  console.log('\n═══ T1: Health Checks (12 services) ═══');
  const services = Object.entries(DIRECT_PORTS);
  for (const [name, port] of services) {
    const ok = await directHealth(name, port);
    record(`${name} :${port}/health`, ok, `HTTP ${ok ? 'OK' : 'FAIL'}`);
  }
}

// T2: Web Proxy — route resolution
async function testWebProxy() {
  console.log('\n═══ T2: Web Proxy (:9111) ═══');
  try {
    const r = await apiGet('/');
    record('Web root (/)', r.status === 200, `HTTP ${r.status}`);
  } catch (e) {
    record('Web root (/)', false, e.message);
  }

  // Proxy routes smoke test: check they return JSON (not 502)
  const proxyTests = [
    ['DC Plans',    '/api/v2/data/plans'],
    ['MPC Status',  '/api/v2/mpc/status?email=test@test.com'],
    ['Wallet Bal',  '/api/v2/wallet/balance?address=0x000&chain=sepolia'],
    ['SAAS Tenants','/api/v2/saas/tenants/my'],
    ['Vault Dash',  '/api/vault/dashboard'],
    ['Payment Creat','/api/v2/payment/create'],
  ];
  for (const [name, path] of proxyTests) {
    try {
      const r = await api('GET', path);
      const ok = r.status >= 200 && r.status < 500; // 400+ is ok (missing auth), 502 is bad proxy
      record(`Proxy ${name} ${path}`, ok, `HTTP ${r.status}`);
    } catch (e) {
      record(`Proxy ${name} ${path}`, false, e.message);
    }
  }
}

// T3: Admin Auth Flow
async function testAdminAuth() {
  console.log('\n═══ T3: Admin Auth Flow (:9100) ═══');

  // 3.1 Login
  try {
    const r = await apiPost('/api/v2/admin/login', { username: ADMIN_USER, password: ADMIN_PASS });
    record('POST /api/v2/admin/login', r.status === 200 && r.json?.code === 0,
      `HTTP ${r.status} code=${r.json?.code}`);
    if (r.json?.data?.token) {
      adminToken = r.json.data.token;
      console.log('       token obtained, continuing authenticated tests...');
    }
  } catch (e) {
    record('POST /api/v2/admin/login', false, e.message);
  }

  if (!adminToken) {
    console.log('       ⚠ No admin token — skipping authenticated tests.');
    results.skipped += 8;
    return;
  }

  // 3.2 Dashboard
  try {
    const r = await apiGet('/api/v2/admin/dashboard');
    const ok = r.status === 200 && r.json?.code === 0;
    record('GET /api/v2/admin/dashboard', ok,
      `totalUsers=${r.json?.data?.totalUsers} tenants=${r.json?.data?.activeTenants} events=${r.json?.data?.totalEvents}`);
  } catch (e) { record('GET /api/v2/admin/dashboard', false, e.message); }

  // 3.3 Tenants
  try {
    const r = await apiGet('/api/v2/admin/tenants');
    const ok = r.status === 200 && r.json?.code === 0 && Array.isArray(r.json?.data);
    record('GET /api/v2/admin/tenants', ok,
      ok ? `${r.json.data.length} tenants` : `HTTP ${r.status}`);
  } catch (e) { record('GET /api/v2/admin/tenants', false, e.message); }

  // 3.4 Status
  try {
    const r = await apiGet('/api/v2/admin/status');
    const ok = r.status === 200 && r.json?.code === 0;
    if (ok) {
      const svcs = r.json.data;
      const up = svcs.filter(s => s.status === 'up').length;
      record('GET /api/v2/admin/status', true, `${up}/${svcs.length} services up`);
    } else {
      record('GET /api/v2/admin/status', false, `HTTP ${r.status}`);
    }
  } catch (e) { record('GET /api/v2/admin/status', false, e.message); }

  // 3.5 Transactions
  try {
    const r = await apiGet('/api/v2/admin/transactions');
    record('GET /api/v2/admin/transactions', r.status === 200,
      `HTTP ${r.status} total=${r.json?.data?.total}`);
  } catch (e) { record('GET /api/v2/admin/transactions', false, e.message); }

  // 3.6 Revenue
  try {
    const r = await apiGet('/api/v2/admin/revenue');
    record('GET /api/v2/admin/revenue', r.status === 200,
      `activeTenants=${r.json?.data?.activeTenants} dcSubs=${r.json?.data?.dcSubscribers}`);
  } catch (e) { record('GET /api/v2/admin/revenue', false, e.message); }

  // 3.7 Settings
  try {
    const r = await apiGet('/api/v2/admin/settings');
    record('GET /api/v2/admin/settings', r.status === 200,
      `tokens=${r.json?.data?.tokens?.length} chains=${r.json?.data?.chains?.length}`);
  } catch (e) { record('GET /api/v2/admin/settings', false, e.message); }

  // 3.8 WaaS Stats
  try {
    const r = await apiGet('/api/v2/admin/waas/stats');
    record('GET /api/v2/admin/waas/stats', r.status === 200,
      `users=${r.json?.data?.users} wallets=${r.json?.data?.wallets}`);
  } catch (e) { record('GET /api/v2/admin/waas/stats', false, e.message); }

  // 3.9 Webhooks
  try {
    const r = await apiGet('/api/v2/admin/webhooks');
    record('GET /api/v2/admin/webhooks', r.status === 200,
      `total=${r.json?.data?.total}`);
  } catch (e) { record('GET /api/v2/admin/webhooks', false, e.message); }

  // 3.10 Sweeps
  try {
    const r = await apiGet('/api/v2/admin/sweeps');
    record('GET /api/v2/admin/sweeps', r.status === 200,
      `${r.json?.data?.length} records`);
  } catch (e) { record('GET /api/v2/admin/sweeps', false, e.message); }

  // 3.11 MPC Stats
  try {
    const r = await apiGet('/api/v2/admin/mpc/stats');
    record('GET /api/v2/admin/mpc/stats', r.status === 200,
      `total=${r.json?.data?.total} registered=${r.json?.data?.registered}`);
  } catch (e) { record('GET /api/v2/admin/mpc/stats', false, e.message); }

  // 3.12 Vault Stats
  try {
    const r = await apiGet('/api/v2/admin/vault/stats');
    record('GET /api/v2/admin/vault/stats', r.status === 200,
      `safes=${r.json?.data?.safes} txns=${r.json?.data?.transactions}`);
  } catch (e) { record('GET /api/v2/admin/vault/stats', false, e.message); }

  // 3.13 DC Stats
  try {
    const r = await apiGet('/api/v2/admin/dc/stats');
    record('GET /api/v2/admin/dc/stats', r.status === 200,
      `events=${r.json?.data?.totalEvents} subs=${r.json?.data?.totalSubs}`);
  } catch (e) { record('GET /api/v2/admin/dc/stats', false, e.message); }
}

// T4: DC Data Endpoints (public + authenticated)
async function testDCEndpoints() {
  console.log('\n═══ T4: DC Data Endpoints (:9102) ═══');

  // 4.1 Plans (public)
  try {
    const r = await apiGet('/api/v2/data/plans');
    const ok = r.status === 200 && r.json?.code === 0 && Array.isArray(r.json?.data);
    record('GET /api/v2/data/plans', ok,
      ok ? `${r.json.data.length} plans` : `HTTP ${r.status}`);
  } catch (e) { record('GET /api/v2/data/plans', false, e.message); }

  // 4.2 Docs (public)
  try {
    const r = await apiGet('/api/v2/data/docs');
    record('GET /api/v2/data/docs', r.status === 200, `HTTP ${r.status}`);
  } catch (e) { record('GET /api/v2/data/docs', false, e.message); }

  // 4.3 Balance (public, needs address)
  try {
    const r = await apiGet('/api/v2/data/balance?address=0x0000000000000000000000000000000000000000');
    record('GET /api/v2/data/balance', r.status === 200, `HTTP ${r.status}`);
  } catch (e) { record('GET /api/v2/data/balance', false, e.message); }

  // 4.4 Events (requires x-dc-api-key — expect 401 without key)
  try {
    const r = await apiGet('/api/v2/data/events?chain=sepolia&limit=5');
    record('GET /api/v2/data/events (no auth)', r.status === 401,
      `HTTP ${r.status} (expected 401)`);
  } catch (e) { record('GET /api/v2/data/events', false, e.message); }

  // 4.5 Stats (requires auth)
  try {
    const r = await apiGet('/api/v2/data/stats');
    record('GET /api/v2/data/stats (no auth)', r.status === 401,
      `HTTP ${r.status} (expected 401)`);
  } catch (e) { record('GET /api/v2/data/stats', false, e.message); }

  // 4.6 Subscribe
  try {
    const r = await apiPost('/api/v2/data/subscribe', { planId: 'data_free' });
    record('POST /api/v2/data/subscribe', r.status === 400,
      `HTTP ${r.status} (expected 400, needs wallet header)`);
  } catch (e) { record('POST /api/v2/data/subscribe', false, e.message); }
}

// T5: MPC Endpoints
async function testMpcEndpoints() {
  console.log('\n═══ T5: MPC Endpoints (:9104) ═══');
  const testEmail = 'e2e-test@infrax.io';

  // 5.1 Send code
  try {
    const r = await apiPost('/api/v2/mpc/send-code', { email: testEmail });
    record('POST /api/v2/mpc/send-code', r.status === 200 && r.json?.code === 0,
      `HTTP ${r.status} code=${r.json?.code}`);
  } catch (e) { record('POST /api/v2/mpc/send-code', false, e.message); }

  // 5.2 Status (public)
  try {
    const r = await apiGet(`/api/v2/mpc/status?email=${testEmail}`);
    record('GET /api/v2/mpc/status', r.status === 200,
      `HTTP ${r.status}`);
  } catch (e) { record('GET /api/v2/mpc/status', false, e.message); }

  // 5.3 Contract Read (no auth needed)
  try {
    const r = await apiPost('/api/v2/mpc/contract-read', {
      chain: 'sepolia',
      contractAddress: '0x0000000000000000000000000000000000000000',
      abi: ['function name() view returns (string)'],
      method: 'name',
      args: [],
    });
    record('POST /api/v2/mpc/contract-read', r.status < 500,
      `HTTP ${r.status} (may fail on non-contract addr)`);
  } catch (e) { record('POST /api/v2/mpc/contract-read', false, e.message); }

  // 5.4 Gas Estimate (no auth needed)
  try {
    const r = await apiPost('/api/v2/mpc/gas-estimate', {
      to: '0x0000000000000000000000000000000000000000',
      value: '0',
      chain: 'sepolia',
    });
    record('POST /api/v2/mpc/gas-estimate', r.status === 200,
      `HTTP ${r.status}`);
  } catch (e) { record('POST /api/v2/mpc/gas-estimate', false, e.message); }

  // 5.5 Session Unlock (without valid code)
  try {
    const r = await apiPost('/api/v2/mpc/session/unlock', { email: testEmail, code: '000000' });
    record('POST /api/v2/mpc/session/unlock (bad code)', r.status >= 400,
      `HTTP ${r.status} (expected 400)`);
  } catch (e) { record('POST /api/v2/mpc/session/unlock', false, e.message); }

  // 5.6 Balance without token
  try {
    const r = await apiPost('/api/v2/mpc/balance', { token: 'invalid', chain: 'sepolia' });
    record('POST /api/v2/mpc/balance (no token)', r.status === 401,
      `HTTP ${r.status} (expected 401)`);
  } catch (e) { record('POST /api/v2/mpc/balance', false, e.message); }
}

// T6: WAAS SaaS Endpoints
async function testWaasEndpoints() {
  console.log('\n═══ T6: WAAS SaaS Endpoints (:9109) ═══');

  // 6.1 My tenants (needs wallet header)
  try {
    const r = await apiGet('/api/v2/saas/tenants/my');
    record('GET /api/v2/saas/tenants/my', r.status >= 400,
      `HTTP ${r.status} (expected auth required)`);
  } catch (e) { record('GET /api/v2/saas/tenants/my', false, e.message); }

  // 6.2 Wallet balance
  try {
    const r = await apiGet('/api/v2/wallet/balance?address=0x0000000000000000000000000000000000000000&chain=sepolia');
    record('GET /api/v2/wallet/balance', r.status === 200,
      `HTTP ${r.status}`);
  } catch (e) { record('GET /api/v2/wallet/balance', false, e.message); }
}

// T7: Payment Endpoints
async function testPaymentEndpoints() {
  console.log('\n═══ T7: Payment Endpoints (:9106) ═══');
  try {
    const r = await apiPost('/api/v2/payment/create', { planId: 'test', amount: '0' });
    record('POST /api/v2/payment/create', r.status < 500,
      `HTTP ${r.status}`);
  } catch (e) { record('POST /api/v2/payment/create', false, e.message); }
}

// T8: Vault Endpoints
async function testVaultEndpoints() {
  console.log('\n═══ T8: Vault Endpoints (:9107) ═══');

  // 8.1 Dashboard
  try {
    const r = await apiGet('/api/vault/dashboard');
    record('GET /api/vault/dashboard', r.status < 500,
      `HTTP ${r.status}`);
  } catch (e) { record('GET /api/vault/dashboard', false, e.message); }

  // 8.2 Safe list
  try {
    const r = await apiGet('/api/vault/safe/list');
    record('GET /api/vault/safe/list', r.status < 500,
      `HTTP ${r.status}`);
  } catch (e) { record('GET /api/vault/safe/list', false, e.message); }

  // 8.3 Status
  try {
    const r = await apiGet('/api/vault/safe/status');
    record('GET /api/vault/safe/status', r.status < 500,
      `HTTP ${r.status}`);
  } catch (e) { record('GET /api/vault/safe/status', false, e.message); }
}

// T9: MCP Servers
async function testMcpServers() {
  console.log('\n═══ T9: MCP Servers ═══');
  const mcps = [
    { name: 'Wallet MCP', port: DIRECT_PORTS.walletMcp, path: '/health' },
    { name: 'DC MCP',     port: DIRECT_PORTS.dcMcp,     path: '/health' },
    { name: 'Vault MCP',  port: DIRECT_PORTS.vaultMcp,  path: '/health' },
    { name: 'MPC MCP',    port: DIRECT_PORTS.mpcMcp,    path: '/health' },
  ];
  for (const m of mcps) {
    try {
      const r = await _http('GET', TARGET_HOST, m.port, m.path, {});
      record(`${m.name} :${m.port}${m.path}`, r.status >= 200 && r.status < 500,
        `HTTP ${r.status}`);
    } catch (e) {
      record(`${m.name} :${m.port}${m.path}`, false, e.message);
    }
  }
}

// T10: Rate Limiting & Security Headers
async function testSecurityHeaders() {
  console.log('\n═══ T10: Security & Rate Limiting ═══');

  // Check security headers on WAAS
  try {
    const r = await _http('GET', TARGET_HOST, DIRECT_PORTS.waas, '/health', {});
    const h = r.headers || {};

    const hsts = !!h['strict-transport-security'];
    record('WAAS HSTS header', hsts, hsts ? 'present' : 'missing');

    const xfo = !!h['x-frame-options'];
    record('WAAS X-Frame-Options', xfo, xfo ? `present (${h['x-frame-options']})` : 'missing');

    const ratelimit = !!h['ratelimit-policy'];
    record('WAAS RateLimit-Policy', ratelimit,
      ratelimit ? `present (${h['ratelimit-policy']})` : 'missing');
  } catch (e) {
    record('WAAS security headers', false, e.message);
  }

  // Rate limiting: fire multiple requests
  try {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(_http('GET', TARGET_HOST, DIRECT_PORTS.waas, '/health', {}));
    }
    const responses = await Promise.all(promises);
    const all200 = responses.every(r => r.status === 200);
    record('WAAS burst 5 requests', all200, all200 ? 'all 200 OK' : 'some failed');
  } catch (e) {
    record('WAAS burst test', false, e.message);
  }
}

// T11: Collector
async function testCollector() {
  console.log('\n═══ T11: Collector (:9101) ═══');
  try {
    const r = await _http('GET', TARGET_HOST, DIRECT_PORTS.collector, '/health', {});
    record('Collector /health', r.status === 200, `HTTP ${r.status}`);
  } catch (e) {
    record('Collector /health', false, e.message);
  }
}

// ─── Main ──────────────────────────────────────────────────────────
(async () => {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   InfraX E2E Test Suite — Production        ║');
  console.log('║   Version: v0.3.1-20260717                  ║');
  console.log(`║   Target:  ${TARGET_HOST} (web :${WEB_PORT})     ║`);
  console.log(`║   Time:    ${new Date().toISOString()}          ║`);
  console.log('╚══════════════════════════════════════════════╝');

  const start = Date.now();

  await testHealthChecks();
  await testWebProxy();
  await testAdminAuth();
  await testDCEndpoints();
  await testMpcEndpoints();
  await testWaasEndpoints();
  await testPaymentEndpoints();
  await testVaultEndpoints();
  await testMcpServers();
  await testSecurityHeaders();
  await testCollector();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // ─── Summary ───────────────────────────────────────────────────
  const total = results.passed + results.failed + results.skipped;
  const pct = total > 0 ? ((results.passed / (results.passed + results.failed)) * 100).toFixed(1) : 'N/A';

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║              TEST SUMMARY                    ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Passed:  ${String(results.passed).padStart(4)}                              ║`);
  console.log(`║  Failed:  ${String(results.failed).padStart(4)}                              ║`);
  console.log(`║  Skipped: ${String(results.skipped).padStart(4)}                              ║`);
  console.log(`║  Total:   ${String(total).padStart(4)}                              ║`);
  console.log(`║  Rate:    ${String(pct + '%').padStart(6)}                             ║`);
  console.log(`║  Time:    ${String(elapsed + 's').padStart(6)}                             ║`);
  console.log('╚══════════════════════════════════════════════╝');

  if (results.failed > 0) {
    console.log('\nFailed tests:');
    results.errors.forEach((e, i) => console.log(`  ${i + 1}. ${e.name} — ${e.detail}`));
  }

  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
})();
