// Lekhira Writes: the "Allow Lekhira Writing Studio?" page of desktop sign-in.
// The server has already checked the request (app, return address, PKCE) before showing this
// page; Allow asks it for a one-time code and hands the browser back to the app.
'use strict';
(() => {
  const api = window.LekhiraApi;
  const $ = (s) => document.querySelector(s);
  const q = new URLSearchParams(location.search);
  const request = Object.fromEntries(['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'device_name'].map((k) => [k, q.get(k) || '']));
  const error = (m) => { $('#c-error').textContent = m; $('#c-error').classList.remove('hidden'); };

  (async () => {
    try {
      const { user } = await api.get('/api/me');
      const who = $('#c-who');
      const b = document.createElement('b');
      b.textContent = user.name;
      const s = document.createElement('span');
      s.textContent = user.email;
      who.append(b, s);
      if (request.device_name) $('#c-sub').textContent = `Lekhira Writing Studio on “${request.device_name}” is asking to use your Lekhira account.`;
      if (!user.emailVerified) needsVerification();
    } catch (e) {
      error(e.message);
    }
  })();

  function needsVerification() {
    error('Please confirm your email address first: open the link we emailed you, then come back to this page and click Allow.');
    $('#c-resend').classList.remove('hidden');
  }

  async function finish(path, button) {
    button.disabled = true;
    try {
      const r = await api.post(path, request);
      $('#c-actions').classList.add('hidden');
      $('#c-done').textContent = path.endsWith('approve') ? 'Signed in. You can close this tab and go back to Lekhira Writing Studio.' : 'Cancelled. You can close this tab.';
      $('#c-done').classList.remove('hidden');
      // Back to the app's own address on this computer (checked by the server).
      if (/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\/callback\?/.test(r.redirect)) window.location.assign(r.redirect);
    } catch (e) {
      button.disabled = false;
      if (e.data && e.data.needsVerification) needsVerification();
      else error(e.message);
    }
  }
  $('#c-allow').addEventListener('click', (e) => finish('/api/oauth/approve', e.currentTarget));
  $('#c-deny').addEventListener('click', (e) => finish('/api/oauth/deny', e.currentTarget));
  $('#c-resend').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await api.post('/api/me/verify/resend'); $('#c-resend').textContent = 'Sent — check your inbox'; }
    catch (err) { error(err.message); e.currentTarget.disabled = false; }
  });
  $('#c-switch').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await api.post('/api/auth/signout'); } catch { /* signing in again anyway */ }
    window.location.replace(api.page(`/signin?next=${encodeURIComponent(location.pathname + location.search)}`));
  });
})();
