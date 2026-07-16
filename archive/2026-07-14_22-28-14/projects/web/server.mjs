// InfraX Web Server — static files + API proxy (zero deps)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 6100;
const WEB_DIR = __dirname;

// API route → backend mapping
const API_ROUTES = {
  '/api/v2/data':   { host: 'localhost', port: 3001 },
  '/api/v2/mpc':    { host: 'localhost', port: 6003 },
  '/api/v2/wallet': { host: 'localhost', port: 6001 },
  '/api/v2/waas':   { host: 'localhost', port: 6001 },
  '/api/v2/saas':   { host: 'localhost', port: 6001 },
  '/api/v2/vault':  { host: 'localhost', port: 6002 },
};

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mjs': 'application/javascript',
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': ext === '.html' ? 'no-store' : 'max-age=3600' });
    res.end(content);
  } catch {
    // SPA fallback — serve index.html
    try {
      const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  }
}

function proxyTo(req, res, target) {
  const url = new URL(req.url, `http://${target.host}:${target.port}`);
  const options = {
    hostname: target.host, port: target.port, path: url.pathname + url.search,
    method: req.method,
    headers: { ...req.headers, host: `${target.host}:${target.port}` },
  };

  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxy.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: -1, message: `Backend unavailable: ${e.message}` }));
  });
  req.pipe(proxy);
}

const server = http.createServer((req, res) => {
  // Check API routes
  for (const [prefix, target] of Object.entries(API_ROUTES)) {
    if (req.url.startsWith(prefix)) {
      return proxyTo(req, res, target);
    }
  }
  // Static file
  const safePath = req.url.split('?')[0].replace(/\.\./g, '');
  const filePath = path.join(WEB_DIR, safePath === '/' ? 'index.html' : safePath);
  serveFile(res, filePath);
});

server.listen(PORT, () => console.log(`InfraX Web + API proxy on :${PORT}`));
