// Lekhira Writes: sign in, create account, forgot / reset password, confirm email.
'use strict';
(() => {
  const api = window.LekhiraApi;
  const path = api.pagePath().replace(/\/$/, '');
  const mode = { '/signup': 'signup', '/forgot': 'forgot', '/reset': 'reset', '/verify': 'verify' }[path] || 'signin';
  const form = document.getElementById(mode);
  form.classList.remove('hidden');
  document.title = {
    signup: 'Create your account', signin: 'Sign in', forgot: 'Forgot your password', reset: 'Choose a new password', verify: 'Confirm your email',
  }[mode] + ' — Lekhira Writes';
  const errorBox = form.querySelector('.form-error');
  const doneBox = form.querySelector('.form-done');

  // Emailed links carry their token in the #fragment, so it never reaches a server log.
  // Read it, then take it out of the address bar.
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  if (token) history.replaceState(null, '', location.pathname + location.search);

  // Where to go after signing in: back to a desktop sign-in request, or the library.
  const nextParam = new URLSearchParams(location.search).get('next');
  const next = nextParam && nextParam.startsWith('/oauth/authorize?') ? nextParam : null;
  const after = () => window.location.replace(next ? api.page(next) : api.page('/app'));
  if (next) {
    for (const a of document.querySelectorAll('a[href$="/signup"], a[href$="/signin"]')) a.href += `?next=${encodeURIComponent(next)}`;
    const sub = form.querySelector('.sub');
    if (sub && (mode === 'signin' || mode === 'signup')) sub.textContent = 'Sign in to connect Lekhira Writing Studio to your account.';
  }

  for (const btn of form.querySelectorAll('.pw-toggle')) {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  }

  function showError(message, field) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
    form.querySelectorAll('.input.invalid').forEach((i) => i.classList.remove('invalid'));
    if (field) {
      const input = form.querySelector(`[name="${field}"]`);
      if (input) { input.classList.add('invalid'); input.focus(); }
    }
  }
  function showDone(message) {
    doneBox.textContent = message;
    doneBox.classList.remove('hidden');
  }

  // A rough strength guide; the server makes the real decision.
  const pw = form.querySelector('input[autocomplete="new-password"]');
  if (pw) {
    const bar = form.querySelector('.meter i');
    const hint = form.querySelector('.meter + .hint');
    pw.addEventListener('input', () => {
      const v = pw.value;
      let score = 0;
      if (v.length >= 10) score++;
      if (v.length >= 14) score++;
      if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
      if (/\d/.test(v) || /[^A-Za-z0-9]/.test(v)) score++;
      if (/\s/.test(v.trim()) && v.length >= 12) score++;
      const pct = Math.min(100, (score / 5) * 100);
      bar.style.width = `${v ? Math.max(8, pct) : 0}%`;
      bar.style.background = score <= 1 ? 'var(--danger)' : score <= 3 ? 'var(--gold)' : 'var(--ok)';
      hint.textContent = v.length && v.length < 10 ? `${10 - v.length} more character${10 - v.length === 1 ? '' : 's'} to go.`
        : score >= 4 ? 'Strong password.' : 'At least 10 characters. A short phrase works well.';
    });
  }

  // ---------- confirm email: runs as soon as the page opens ----------
  if (mode === 'verify') {
    (async () => {
      const h1 = form.querySelector('h1');
      const sub = form.querySelector('.sub');
      if (!token) { h1.textContent = 'This link is incomplete'; sub.textContent = 'Please open the link from your email again, or ask for a new one from your account.'; return; }
      try {
        const r = await api.post('/api/auth/verify', { token });
        h1.textContent = 'Email confirmed';
        sub.textContent = `Thank you. ${r.email} is confirmed for your Lekhira account.`;
        document.getElementById('verify-continue').classList.remove('hidden');
      } catch (err) {
        h1.textContent = 'We couldn’t confirm your email';
        sub.textContent = '';
        showError(err.message);
        const a = document.getElementById('verify-continue');
        a.textContent = 'Go to your account';
        a.classList.remove('hidden');
      }
    })();
    return;
  }
  if (mode === 'reset' && !token) {
    showError('This link is incomplete. Please open the link from your email again, or ask for a new one.');
    form.querySelector('button[type="submit"]').disabled = true;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.add('hidden');
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type="submit"]');
    if (mode === 'signup') {
      if (!data.name.trim()) return showError('Please tell us what to call you.', 'name');
      if (!/^\S+@\S+\.\S+$/.test(data.email.trim())) return showError('Please enter a valid email address.', 'email');
      if (data.password.length < 10) return showError('Use at least 10 characters for your password.', 'password');
      if (!data.agree) return showError('Please agree to the Terms and Privacy Policy.', 'agree');
    } else if (mode === 'signin' && (!data.email || !data.password)) {
      return showError('Please enter your email and password.', !data.email ? 'email' : 'password');
    } else if (mode === 'forgot' && !/^\S+@\S+\.\S+$/.test((data.email || '').trim())) {
      return showError('Please enter a valid email address.', 'email');
    } else if (mode === 'reset' && data.password.length < 10) {
      return showError('Use at least 10 characters for your password.', 'password');
    }
    button.disabled = true;
    const label = button.textContent;
    button.textContent = { signup: 'Creating your account…', signin: 'Signing in…', forgot: 'Sending…', reset: 'Saving…' }[mode];
    try {
      if (mode === 'forgot') {
        const r = await api.post('/api/auth/forgot', { email: data.email });
        showDone(r.message);
        button.textContent = 'Sent';
        return;
      }
      if (mode === 'reset') {
        await api.post('/api/auth/reset', { token, password: data.password });
        window.location.replace(api.page('/app'));
        return;
      }
      const payload = mode === 'signup'
        ? { name: data.name, email: data.email, password: data.password, agree: true }
        : { email: data.email, password: data.password };
      await api.post(`/api/auth/${mode}`, payload);
      after();
    } catch (err) {
      showError(err.message, err.data && err.data.field);
      button.disabled = false;
      button.textContent = label;
    }
  });

  const first = form.querySelector('input');
  if (first) first.focus();
})();
