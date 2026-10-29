// Lekhira Writes: sign in and create account.
'use strict';
(() => {
  const api = window.LekhiraApi;
  const mode = api.pagePath().replace(/\/$/, '') === '/signup' ? 'signup' : 'signin';
  const form = document.getElementById(mode);
  form.classList.remove('hidden');
  document.title = mode === 'signup' ? 'Create your account — Lekhira Writes' : 'Sign in — Lekhira Writes';
  const errorBox = form.querySelector('.form-error');

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

  // A rough strength guide; the server makes the real decision.
  const pw = form.querySelector('input[autocomplete="new-password"]');
  if (pw) {
    const bar = form.querySelector('.meter i');
    const hint = document.getElementById('pw-hint');
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
    } else if (!data.email || !data.password) {
      return showError('Please enter your email and password.', !data.email ? 'email' : 'password');
    }
    button.disabled = true;
    const label = button.textContent;
    button.textContent = mode === 'signup' ? 'Creating your account…' : 'Signing in…';
    try {
      const payload = mode === 'signup'
        ? { name: data.name, email: data.email, password: data.password, agree: true }
        : { email: data.email, password: data.password };
      await api.post(`/api/auth/${mode}`, payload);
      window.location.replace(api.page('/app'));
    } catch (err) {
      showError(err.message, err.data && err.data.field);
      button.disabled = false;
      button.textContent = label;
    }
  });

  form.querySelector('input').focus();
})();
