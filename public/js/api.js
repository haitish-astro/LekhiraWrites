// Lekhira Writes: talking to the server. Every call is same-origin JSON and carries the
// X-Lekhira header the server requires for anything that changes data.
'use strict';
window.LekhiraApi = (() => {
  // Where the site lives: "" on our own server, "/LekhiraWrites" in the GitHub Pages preview.
  const base = window.LEKHIRA_BASE || '';
  const page = (p) => base + p;
  const pagePath = () => (window.location.pathname.startsWith(base) ? window.location.pathname.slice(base.length) : window.location.pathname) || '/';

  class ApiError extends Error {
    constructor(status, data) {
      super((data && data.error) || (status === 0 ? 'You seem to be offline.' : 'Something went wrong.'));
      this.status = status;
      this.data = data || {};
    }
  }

  async function request(method, path, body, { timeout = 20000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const opts = {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Lekhira': '1', Accept: 'application/json' },
      signal: ctrl.signal,
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      throw new ApiError(0, null);
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/api/auth/') && pagePath().startsWith('/app')) {
        window.dispatchEvent(new CustomEvent('lekhira:signed-out'));
      }
      throw new ApiError(res.status, data);
    }
    return data;
  }

  // Downloads a file from the API without putting anything in the URL but the format.
  async function download(path, fallbackName) {
    const res = await fetch(path, { credentials: 'same-origin', headers: { 'X-Lekhira': '1' }, cache: 'no-store' });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* ignore */ }
      throw new ApiError(res.status, data);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/);
    const name = m ? decodeURIComponent(m[1]) : fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  return {
    ApiError, base, page, pagePath,
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b, o) => request('POST', p, b || {}, o),
    put: (p, b, o) => request('PUT', p, b || {}, o),
    patch: (p, b, o) => request('PATCH', p, b || {}, o),
    del: (p, o) => request('DELETE', p, undefined, o),
    download,
  };
})();
