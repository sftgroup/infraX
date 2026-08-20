// InfraX Web Server — static files + API proxy (zero deps, no npm install needed)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 6100;
const WEB_DIR = __dirname;

// Backend service ports — configurable via env vars for multi-env deployment
const DC_HOST       = process.env.DC_HOST   || 'localhost';
const DC_PORT       = parseInt(process.env.DC_PORT   || '9102', 10);
const MPC_HOST      = process.env.MPC_HOST  || 'localhost';
const MPC_PORT      = parseInt(process.env.MPC_PORT  || '9104', 10);
const WAAS_HOST     = process.env.WAAS_HOST || 'localhost';
const WAAS_PORT     = parseInt(process.env.WAAS_PORT || '9109', 10);
const VAULT_HOST    = process.env.VAULT_HOST|| 'localhost';
const VAULT_PORT    = parseInt(process.env.VAULT_PORT|| '9107', 10);
const ADMIN_HOST    = process.env.ADMIN_HOST || 'localhost';
const ADMIN_PORT    = parseInt(process.env.ADMIN_PORT || '9100', 10);
const COLLECTOR_HOST = process.env.COLLECTOR_HOST || 'localhost';
const COLLECTOR_PORT = parseInt(process.env.COLLECTOR_PORT || '9101', 10);
const RPC_HOST = process.env.RPC_HOST || 'localhost';
const RPC_PORT = parseInt(process.env.RPC_PORT || '9130', 10);
const DATA_HOST = process.env.DATA_HOST || 'localhost';
const DATA_PORT = parseInt(process.env.DATA_PORT || '9112', 10);
const AA_HOST = process.env.AA_HOST || 'localhost';
const AA_PORT = parseInt(process.env.AA_PORT || '9131', 10);
const ML_HOST = process.env.ML_HOST || 'localhost';
const ML_PORT = parseInt(process.env.ML_PORT || '9120', 10);
const ML_API_KEY = process.env.ML_API_KEY || '';
const PAYMENTS_HOST = process.env.PAYMENTS_HOST || 'localhost';
const PAYMENTS_PORT = parseInt(process.env.PAYMENTS_PORT || '9132', 10);

const API_ROUTES = {
  '/api/v2/admin':   { host: ADMIN_HOST,   port: ADMIN_PORT },
  // collector 行情数据面（/api/v2/data/market/*）必须位于 /api/v2/data 之前，否则被 DC 前缀吞掉
  '/api/v2/data/market': { host: COLLECTOR_HOST, port: COLLECTOR_PORT },
  // B-11-3 用户级 key（data 服务 :9112 钱包签名鉴权）— 必须先于 /api/v2/data（DC :9102）
  '/api/v2/data/my-keys': { host: DATA_HOST, port: DATA_PORT },
  // Chain RPC 只读状态（/api/v2/rpc/health → chain-rpc :9130 /health）— 面板服务状态用（strip 前缀）
  '/api/v2/rpc':     { host: RPC_HOST,      port: RPC_PORT, strip: '/api/v2/rpc' },
  '/api/v2/data':    { host: DC_HOST,      port: DC_PORT },
  '/api/v2/market':  { host: COLLECTOR_HOST, port: COLLECTOR_PORT },
  '/api/v2/mpc':     { host: MPC_HOST,     port: MPC_PORT },
  '/api/v2/wallet':  { host: WAAS_HOST,    port: WAAS_PORT },
  '/api/v2/waas':    { host: WAAS_HOST,    port: WAAS_PORT },
  '/api/v2/saas':    { host: WAAS_HOST,    port: WAAS_PORT },
  '/api/vault':      { host: VAULT_HOST,   port: VAULT_PORT },
  '/api/v2/vault':   { host: VAULT_HOST,   port: VAULT_PORT },
  '/api/v2/subscription': { host: WAAS_HOST, port: WAAS_PORT },
  // A-9: AA/session 线（aa-relay :9131）— plans / ledger-balance / userops
  '/v1':             { host: AA_HOST,      port: AA_PORT },
  // 图谱因子数据面（data-service :9112）— REQ-G8/G9：/factors/*、/graph/*、/rag/*
  '/factors':        { host: DATA_HOST,    port: DATA_PORT },
  '/graph':          { host: DATA_HOST,    port: DATA_PORT },
  '/rag':            { host: DATA_HOST,    port: DATA_PORT },
  // ML 模型推理面（ml-service :9120）— 注入 Authorization Bearer
  '/ml':             { host: ML_HOST,      port: ML_PORT },
  // 通用支付网关（infrax-payments :9132）— invites / transfers / a2a / mpp
  '/payments':       { host: PAYMENTS_HOST, port: PAYMENTS_PORT },
};

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

// Security headers applied to all responses
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '0',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https:; font-src 'self'",
};

function applySecurityHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
}

// ─── Serve static files ─────────────────────────────────────────
function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    applySecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') {
      const index = path.join(WEB_DIR, 'index.html');
      const indexData = fs.readFileSync(index);
      applySecurityHeaders(res);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': indexData.length });
      res.end(indexData);
    } else {
      res.writeHead(500);
      res.end('500 Internal Server Error');
    }
  }
}

// ─── Proxy API requests to backends ──────────────────────────────
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || '';
// infrax-payments 独立鉴权 key（其 PAYMENTS_API_KEY 与平台 bridge key 不同源）
const PAYMENTS_API_KEY = process.env.PAYMENTS_API_KEY || '';
function proxyRequest(req, res, target) {
  const headers = { ...req.headers, host: target.host + ':' + target.port };
  // 后端已接入统一鉴权契约：代理统一注入 X-Service-Key（平台 bridge key），
  // 前端无需携带 key；直接访问后端的调用方需自带 Bearer/X-API-Key/X-Service-Key
  if (SERVICE_API_KEY) headers['x-service-key'] = SERVICE_API_KEY;
  // ml-service 仅认 Authorization: Bearer <ML_API_KEY>（app_auth），特判注入
  if (req.url.startsWith('/ml') && ML_API_KEY && !headers.authorization) {
    headers['authorization'] = 'Bearer ' + ML_API_KEY;
  }
  // payments 引擎使用独立 key（非平台 bridge key），特判覆盖注入
  if (req.url.startsWith('/payments') && PAYMENTS_API_KEY) {
    headers['x-service-key'] = PAYMENTS_API_KEY;
  }
  const opts = {
    hostname: target.host,
    port: target.port,
    // 支持 strip 前缀的代理（如 /api/v2/rpc → chain-rpc 的 /health），默认透传完整路径
    path: target.strip && req.url.startsWith(target.strip) ? (req.url.slice(target.strip.length) || '/') : req.url,
    method: req.method,
    headers,
    timeout: 15000,
  };
  const proxy = http.request(opts, (pres) => {
    // Forward status and headers from backend
    const headers = { ...pres.headers };
    applySecurityHeaders(res);
    res.writeHead(pres.statusCode, headers);
    pres.pipe(res);
  });
  proxy.on('timeout', () => {
    proxy.destroy();
    res.writeHead(504);
    res.end(JSON.stringify({ error: 'backend timeout', service: target.host + ':' + target.port }));
  });
  proxy.on('error', (err) => {
    console.error(`[proxy] ${target.host}:${target.port} ${req.url} — ${err.message}`);
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'backend unreachable', service: target.host + ':' + target.port }));
  });
  req.pipe(proxy);
}

// ─── Server ──────────────────────────────────────────────────────
const serverStartTime = Date.now();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const urlPath = url.pathname;

  // Health check endpoint (must be before API proxy and static file serving)
  if (urlPath === '/health') {
    applySecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'infrax-web',
      uptime: Math.floor((Date.now() - serverStartTime) / 1000),
      version: '2.1.0',
      backends: Object.fromEntries(
        Object.entries(API_ROUTES).map(([prefix, t]) => [prefix, `${t.host}:${t.port}`])
      ),
    }));
    return;
  }

  // API proxy routes
  for (const [prefix, target] of Object.entries(API_ROUTES)) {
    if (urlPath.startsWith(prefix)) {
      return proxyRequest(req, res, target);
    }
  }

  // Static file serving
  let filePath = path.join(WEB_DIR, urlPath === '/' ? 'index.html' : urlPath);
  serveFile(res, filePath);
});

server.listen(PORT, () => {
  console.log('InfraX Web running on :' + PORT);
  console.log('Backend routes:', Object.entries(API_ROUTES).map(([p, t]) => `${p} → ${t.host}:${t.port}`).join(', '));
});
