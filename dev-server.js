'use strict';
// Minimal local server: serves /public and runs the /api functions like Vercel does.
// Usage: npm run dev   (reads .env.local if present)   ->  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

try {
  const env = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8');
  env.split(/\r?\n/).forEach((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* no .env.local: fine */ }

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function wrap(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
  return res;
}

const server = http.createServer(async (req, res) => {
  wrap(res);
  const u = url.parse(req.url, true);
  let p = decodeURIComponent(u.pathname);

  if (p.startsWith('/api/')) {
    const name = p.slice(5).replace(/[^a-z0-9_-]/gi, '');
    const file = path.join(__dirname, 'api', name + '.js');
    if (!name || !fs.existsSync(file)) return res.status(404).json({ error: 'No such function' });
    req.query = u.query;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { req.body = {}; }
    try { return await require(file)(req, res); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  }

  if (p === '/') p = '/index.html';
  else if (p === '/admin') p = '/admin.html';
  const full = path.normalize(path.join(PUBLIC, p));
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(full)] || 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log('AI Radio Station running at http://localhost:' + port));
