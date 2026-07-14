// InfraX Web Server — static files + API proxy (zero deps, no npm install needed)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 6100;
const WEB_DIR = __dirname;

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
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
    res.end(content);
  } catch {
    try {
      const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(404); res.end('Not Found');
    }
  }
}

function proxyTo(req, res, target) {
  const opts = {
    hostname: target.host, port: target.port,
    path: req.url, method: req.method,
    headers: Object.assign({}, req.headers, { host: target.host + ':' + target.port }),
  };
  const proxy = http.request(opts, (pRes) => {
    res.writeHead(pRes.statusCode, pRes.headers);
    pRes.pipe(res);
  });
  proxy.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: -1, message: 'Backend unavailable' }));
  });
  req.pipe(proxy);
}

const server = http.createServer((req, res) => {
  for (const [prefix, target] of Object.entries(API_ROUTES)) {
    if (req.url.startsWith(prefix)) return proxyTo(req, res, target);
  }
  const safe = req.url.split('?')[0].replace(/\.\./g, '');
  serveFile(res, path.join(WEB_DIR, safe === '/' ? 'index.html' : safe));
});

server.listen(PORT, () => console.log('InfraX Web + Proxy on :' + PORT));
