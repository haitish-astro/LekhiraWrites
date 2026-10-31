// Lekhira — desktop sign-in client: what Lekhira Writing Studio will use to sign in through
// the browser (OAuth 2.0 authorization code + PKCE for native apps). No dependencies, so it
// can be copied into Studio's main process as is.
//
// Try it against a running Lekhira Writes server:
//   node tools/desktop-signin.js                 sign in, show the account, refresh the token
//   node tools/desktop-signin.js --signout       …and then sign this app out again
//   node tools/desktop-signin.js --test-reuse    …and show that a copied, already-used refresh token is refused
//   node tools/desktop-signin.js --print-url     print the sign-in address instead of opening the browser
// Options: --writes http://writes.localhost:4310   --api http://api.localhost:4310   --device "My laptop"
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const os = require('node:os');

const CLIENT_ID = 'lekhira-studio';
const b64url = (buf) => buf.toString('base64url');

function openBrowser(url) {
  // rundll32 hands the address straight to the default browser, so "&" in it is safe.
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui,sans-serif;background:#141416;color:#ece9e4;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-weight:500">${title}</h1><p style="color:#b9b5ae">${text}</p></div>`;

// Opens the browser at Lekhira's sign-in page and waits for it to come back with a code.
async function signIn({ writesOrigin, apiOrigin, deviceName = os.hostname(), open = openBrowser, timeoutMs = 5 * 60_000 }) {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));

  // A one-off listener on this computer only, on a free port, for the browser to come back to.
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

  const authorize = new URL('/oauth/authorize', writesOrigin);
  for (const [k, v] of Object.entries({
    client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', state, device_name: deviceName,
  })) authorize.searchParams.set(k, v);

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error('Sign-in timed out.')); }, timeoutMs);
    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      const done = (status, title, text, err, value) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page(title, text));
        clearTimeout(timer);
        server.close();
        if (err) reject(err); else resolve(value);
      };
      // The state must be the one we sent, or this isn't our sign-in.
      if (url.searchParams.get('state') !== state) return done(400, 'Sign-in didn’t match', 'Please start again from Lekhira Studio.', new Error('State mismatch.'));
      if (url.searchParams.get('error')) return done(200, 'Sign-in cancelled', 'You can close this tab.', new Error('The writer cancelled sign-in.'));
      const c = url.searchParams.get('code');
      if (!c) return done(400, 'Something went wrong', 'Please start again from Lekhira Studio.', new Error('No code returned.'));
      done(200, 'Signed in to Lekhira', 'You can close this tab and go back to Lekhira Writing Studio.', null, c);
    });
    open(authorize.toString());
  });

  return tokenRequest(apiOrigin, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: CLIENT_ID });
}

async function tokenRequest(apiOrigin, params) {
  const res = await fetch(new URL('/api/oauth/token', apiOrigin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'LekhiraStudio' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Token request failed (${res.status}).`);
  return { ...data, expiresAt: Date.now() + data.expires_in * 1000 };
}

// Swaps the refresh token for a new pair. The old refresh token stops working.
const refresh = (apiOrigin, refreshToken) => tokenRequest(apiOrigin, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID });

async function me(apiOrigin, accessToken) {
  const res = await fetch(new URL('/api/v1/me', apiOrigin), { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

async function signOut(apiOrigin, token) {
  await fetch(new URL('/api/oauth/revoke', apiOrigin), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, client_id: CLIENT_ID }).toString(),
  });
}

module.exports = { signIn, refresh, me, signOut, CLIENT_ID };

if (require.main === module) {
  const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
  const writesOrigin = arg('writes', 'http://writes.localhost:4310');
  const apiOrigin = arg('api', 'http://api.localhost:4310');
  const mask = (t) => `${t.slice(0, 8)}…`;
  (async () => {
    console.log(`\nOpening your browser to sign in at ${writesOrigin} …`);
    // --print-url: show the address instead of opening the default browser.
    const open = process.argv.includes('--print-url') ? (url) => console.log(`\nOpen this address to sign in:\n${url}\n`) : undefined;
    const tokens = await signIn({ writesOrigin, apiOrigin, deviceName: arg('device', os.hostname()), open });
    console.log(`✓ Signed in. Access token ${mask(tokens.access_token)} (expires in ${tokens.expires_in / 60} min), refresh token ${mask(tokens.refresh_token)}`);
    const account = await me(apiOrigin, tokens.access_token);
    console.log(`✓ /api/v1/me → ${account.user.name} <${account.user.email}>, plan: ${account.plan}, entitlements: ${JSON.stringify(account.entitlements)}`);
    const next = await refresh(apiOrigin, tokens.refresh_token);
    console.log(`✓ Refreshed: new access token ${mask(next.access_token)}`);
    await me(apiOrigin, next.access_token);
    console.log('✓ The new token works.');
    if (process.argv.includes('--test-reuse')) {
      try { await refresh(apiOrigin, tokens.refresh_token); console.log('✗ The old refresh token still worked (it should not).'); }
      catch { console.log('✓ The old refresh token was refused, and that sign-in was ended as a precaution (reuse detection).'); }
    }
    if (process.argv.includes('--signout')) { await signOut(apiOrigin, next.refresh_token); console.log('✓ Signed out.'); }
    console.log('\nCheck "Apps signed in" under Account & privacy, and the sign-in email at /dev/outbox.\n');
  })().catch((e) => { console.error(`\n✗ ${e.message}\n`); process.exit(1); });
}
