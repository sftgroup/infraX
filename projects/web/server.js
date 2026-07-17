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
const PAYMENT_HOST  = process.env.PAYMENT_HOST || 'localhost';
const PAYMENT_PORT  = parseInt(process.env.PAYMENT_PORT || '9106', 10);
const ADMIN_HOST    = process.env.ADMIN_HOST || 'localhost';
const ADMIN_PORT    = parseInt(process.env.ADMIN_PORT || '9100', 10);

const API_ROUTES = {
  '/api/v2/admin':   { host: ADMIN_HOST,   port: ADMIN_PORT },
  '/api/v2/data':    { host: DC_HOST,      port: DC_PORT },
  '/api/v2/mpc':     { host: MPC_HOST,     port: MPC_PORT },
  '/api/v2/wallet':  { host: WAAS_HOST,    port: WAAS_PORT },
  '/api/v2/waas':    { host: WAAS_HOST,    port: WAAS_PORT },
  '/api/v2/saas':    { host: WAAS_HOST,    port: WAAS_PORT },
  '/api/vault':      { host: VAULT_HOST,   port: VAULT_PORT },
  '/api/v2/vault':   { host: VAULT_HOST,   port: VAULT_PORT },
  '/api/v2/payment': { host: PAYMENT_HOST, port: PAYMENT_PORT },
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
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') {
      const index = path.join(WEB_DIR, 'index.html');
      applySecurityHeaders(res);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(index));
    } else {
      res.writeHead(500);
      res.end('500 Internal Server Error');
    }
  }
}

// ─── Proxy API requests to backends ──────────────────────────────
function proxyRequest(req, res, target) {
  const opts = {
    hostname: target.host,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: target.host + ':' + target.port },
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
