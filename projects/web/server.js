// InfraX Web Server — static files + API proxy (zero deps, no npm install needed)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 6100;
const WEB_DIR = __dirname;

const API_ROUTES = {
  '/api/v2/data':   { host: 'localhost', port: 3001 },
  '/api/v2/mpc':    { host: 'localhost', port: 6003 },
  '/api/v2/wallet': { host: 'localhost', port: 6001 },
  '/api/v2/waas':   { host: 'localhost', port: 6001 },
  '/api/v2/saas':   { host: 'localhost', port: 6001 },
  '/api/vault':     { host: 'localhost', port: 6002 },
  '/api/v2/vault':  { host: 'localhost', port: 6002 },
  '/api/v2/payment': { host: 'localhost', port: 6004 },
};

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') {
      const index = path.join(WEB_DIR, 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(index));
    } else {
      res.writeHead(500);
      res.end('500 Internal Server Error');
    }
  }
}

function proxyRequest(req, res, target) {
  const opts = {
    hostname: target.host,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: target.host + ':' + target.port }
  };
  const proxy = http.request(opts, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  proxy.on('error', () => {
    res.writeHead(502);
    res.end('502 Bad Gateway');
  });
  req.pipe(proxy);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const urlPath = url.pathname;

  for (const [prefix, target] of Object.entries(API_ROUTES)) {
    if (urlPath.startsWith(prefix)) {
      return proxyRequest(req, res, target);
    }
  }

  let filePath = path.join(WEB_DIR, urlPath === '/' ? 'index.html' : urlPath);
  serveFile(res, filePath);
});

server.listen(PORT, () => {
  console.log('InfraX Web running on :' + PORT);
});
