'use strict';
// Lekhira Writes — GitHub Pages preview setup. Runs before every other script on the page.
// pages/build.js fills in the base path (e.g. "/LekhiraWrites").
window.LEKHIRA_BASE = '__BASE__';

(() => {
  const base = window.LEKHIRA_BASE;
  const path = location.pathname.slice(base.length).replace(/\/$/, '') || '/';
  let signedIn = false;
  try { signedIn = !!localStorage.getItem('lekhira-preview:session'); } catch { /* ignore */ }

  // The server used to make these decisions; on Pages they happen here.
  const page = document.documentElement.dataset.page;
  if (page === 'app' && !(path === '/app' || path.startsWith('/app/'))) { location.replace(`${base}/not-found/`); return; }
  if (page === 'auth' && signedIn) { location.replace(`${base}/app/`); return; }

  document.addEventListener('DOMContentLoaded', () => {
    let hidden = false;
    try { hidden = sessionStorage.getItem('lekhira-preview:hide-note') === '1'; } catch { /* ignore */ }
    if (hidden) return;
    const note = document.createElement('div');
    note.className = 'preview-note';
    note.setAttribute('role', 'note');
    const b = document.createElement('b');
    b.textContent = 'Preview';
    const t = document.createElement('span');
    t.textContent = ' Accounts and books are kept only in this browser. Nothing is sent anywhere.';
    const x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Hide this note');
    x.textContent = '×';
    x.onclick = () => { note.remove(); try { sessionStorage.setItem('lekhira-preview:hide-note', '1'); } catch { /* ignore */ } };
    note.append(b, t, x);
    document.body.append(note);
  });
})();
