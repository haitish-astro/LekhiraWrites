// Lekhira Writes — serves _site/ the way GitHub Pages does, to check the preview locally.
// Folder addresses get index.html, "/signin" redirects to "/signin/", and missing files get
// 404.html with a 404 status.   node pages/serve.js   → http://localhost:4320/LekhiraWrites/
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', '_site');
const BASE = (process.env.PAGES_BASE ?? '/LekhiraWrites').replace(/\/$/, '');
const PORT = Number(process.env.PORT) || 4320;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.txt': 'text/plain' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith(BASE + '/')) { res.writeHead(302, { Location: BASE + '/' }); return res.end(); }
  const rel = decodeURIComponent(url.pathname.slice(BASE.length));
  let file = path.join(OUT, rel);
  if (!file.startsWith(OUT)) { res.writeHead(400); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: url.pathname + '/' + url.search }); return res.end(); }
    file = path.join(file, 'index.html');
  }
  let status = 200;
  if (!fs.existsSync(file)) { status = 404; file = path.join(OUT, '404.html'); }
  res.writeHead(status, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`GitHub Pages preview: http://localhost:${PORT}${BASE}/`));
