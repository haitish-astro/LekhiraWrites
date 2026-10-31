// Lekhira Writes — builds the GitHub Pages preview into _site/.
// GitHub Pages serves files only, so this copies public/, points every link at the site's
// base path (none on writes.lekhira.com), and swaps the server API for pages/preview-api.js.
//   node pages/build.js                 for writes.lekhira.com (served from the domain's root)
//   PAGES_BASE=/LekhiraWrites node pages/build.js   for a github.io sub-path instead
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, '_site');
const BASE = (process.env.PAGES_BASE ?? '').replace(/\/$/, '');
const DOMAIN = process.env.PAGES_DOMAIN ?? 'writes.lekhira.com';
if (BASE && !/^\/[A-Za-z0-9._-]+$/.test(BASE)) throw new Error(`Unexpected PAGES_BASE: ${BASE}`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(PUBLIC, OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
// The custom domain (also set under Settings → Pages); kept here so it's visible in the repo.
if (DOMAIN && !BASE) fs.writeFileSync(path.join(OUT, 'CNAME'), `${DOMAIN}\n`);
fs.copyFileSync(path.join(__dirname, 'preview-api.js'), path.join(OUT, 'js', 'preview-api.js'));
fs.copyFileSync(path.join(__dirname, 'preview.css'), path.join(OUT, 'css', 'preview.css'));
fs.writeFileSync(path.join(OUT, 'js', 'preview.js'), fs.readFileSync(path.join(__dirname, 'preview.js'), 'utf8').replace("'__BASE__'", JSON.stringify(BASE)));

// Root-relative links ("/css/…", "/app") get the base path; protocol-relative ones ("//…") don't.
const rebase = (s) => s.replace(/\b(href|src)="\/(?!\/)/g, `$1="${BASE}/`);

function page(src, dest, kind) {
  let html = rebase(fs.readFileSync(path.join(PUBLIC, src), 'utf8'));
  html = html.replace('<html lang="en">', `<html lang="en" data-page="${kind}">`);
  html = html.replace('</head>', `  <link rel="stylesheet" href="${BASE}/css/preview.css">\n</head>`);
  // preview.js first (it sets the base path), the stand-in API right after api.js.
  html = html.replace(/(\s*)<script /, `$1<script src="${BASE}/js/preview.js" defer></script>$1<script `);
  html = html.replace(/(<script src="[^"]*\/js\/api\.js" defer><\/script>)/, `$1\n  <script src="${BASE}/js/preview-api.js" defer></script>`);
  if (!html.includes('preview.js')) html = html.replace('</head>', `  <script src="${BASE}/js/preview.js" defer></script>\n</head>`);
  const file = path.join(OUT, dest);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

page('index.html', 'index.html', 'home');
page('auth.html', 'signin/index.html', 'auth');
page('auth.html', 'signup/index.html', 'auth');
for (const p of ['forgot', 'reset', 'verify']) page('auth.html', `${p}/index.html`, 'account');
page('legal.html', 'legal/index.html', 'legal');
page('404.html', 'not-found/index.html', 'notfound');
page('app.html', 'app/index.html', 'app');
// Pages shows 404.html for any address it has no file for, such as /app/book/<id>/<chapter>.
// Serving the app there lets those links open; preview.js sends anything else to not-found.
page('app.html', '404.html', 'app');
// Desktop sign-in needs the real server, so the preview leaves its page out.
for (const f of ['auth.html', 'app.html', 'legal.html', 'authorize.html', 'js/authorize.js']) fs.rmSync(path.join(OUT, f));

const css = path.join(OUT, 'css', 'app.css');
fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace(/url\("\/img\//g, `url("${BASE}/img/`));

console.log(`Built the GitHub Pages preview in _site/ for ${BASE || '/'}`);
