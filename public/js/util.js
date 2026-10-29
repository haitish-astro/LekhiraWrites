'use strict';
// Shared helpers: icons, fonts, formatting, dialogs, menus, toasts.
// The names and behaviour follow Lekhira Studio's src/util.js, so the two apps read alike.
// One difference: Studio builds dialogs from HTML strings; on the web, anything that can hold
// a writer's text is built with el() and text nodes instead, never innerHTML.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  focus: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  export: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6V14M12 17h.01"/>',
  outline: '<rect x="3.5" y="4" width="7" height="7" rx="1.5"/><rect x="13.5" y="4" width="7" height="7" rx="1.5"/><rect x="3.5" y="14" width="7" height="7" rx="1.5"/><rect x="13.5" y="14" width="7" height="7" rx="1.5"/>',
  atlas: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  bookOpen: '<path d="M2 4.5h6a4 4 0 0 1 4 4V21a3 3 0 0 0-3-3H2z"/><path d="M22 4.5h-6a4 4 0 0 0-4 4V21a3 3 0 0 1 3-3h7z"/>',
  sparkle: '<path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z"/><path d="M19 3v4M17 5h4"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  pages: '<rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/>',
  compare: '<path d="M8 3v18M16 3v18M3 8h5M16 16h5M3 16h5M16 8h5"/>',
  offline: '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 3"/><path d="M17 3l4 4M21 3l-4 4"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
function paintIcons(root = document) {
  for (const el of $$('[data-icon]', root)) {
    if (!el.dataset.painted) {
      // Icon-only buttons get an accessible name from their tooltip text.
      if (el.tagName === 'BUTTON' && !el.textContent.trim() && el.title && !el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.title);
      el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
      el.dataset.painted = '1';
    }
  }
}

// ---------- fonts (installed on this computer, as in Studio) ----------
const FONT_GROUPS = [
  ['Book serif', [
    ['Georgia', 'Georgia, serif'],
    ['Times New Roman', '"Times New Roman", Times, serif'],
    ['Sitka Text', '"Sitka Text", Georgia, serif'],
    ['Palatino Linotype', '"Palatino Linotype", "Book Antiqua", Palatino, serif'],
    ['Book Antiqua', '"Book Antiqua", Palatino, serif'],
    ['Garamond', 'Garamond, Georgia, serif'],
    ['Baskerville Old Face', '"Baskerville Old Face", Baskerville, Georgia, serif'],
    ['Cambria', 'Cambria, Georgia, serif'],
    ['Constantia', 'Constantia, Georgia, serif'],
    ['Bookman Old Style', '"Bookman Old Style", Georgia, serif'],
    ['Century Schoolbook', '"Century Schoolbook", Georgia, serif'],
    ['Lucida Bright', '"Lucida Bright", Georgia, serif'],
  ]],
  ['Clean sans', [
    ['Segoe UI', '"Segoe UI", system-ui, sans-serif'],
    ['Calibri', 'Calibri, "Segoe UI", sans-serif'],
    ['Candara', 'Candara, "Segoe UI", sans-serif'],
    ['Verdana', 'Verdana, sans-serif'],
    ['Trebuchet MS', '"Trebuchet MS", sans-serif'],
    ['Gill Sans MT', '"Gill Sans MT", "Segoe UI", sans-serif'],
  ]],
  ['Handwritten', [
    ['Comic Sans MS', '"Comic Sans MS", cursive'],
    ['Segoe Print', '"Segoe Print", "Comic Sans MS", cursive'],
    ['Segoe Script', '"Segoe Script", cursive'],
    ['Ink Free', '"Ink Free", "Comic Sans MS", cursive'],
  ]],
  ['Typewriter', [
    ['Courier New', '"Courier New", Courier, monospace'],
    ['Consolas', 'Consolas, monospace'],
    ['Cascadia Mono', '"Cascadia Mono", Consolas, monospace'],
  ]],
];
const FONT_CSS = {};
for (const [, list] of FONT_GROUPS) for (const [n, css] of list) FONT_CSS[n] = css;
const fontCSS = (name) => FONT_CSS[name] || 'Georgia, serif';

function fontInstalled(name) {
  const ctx = fontInstalled.ctx || (fontInstalled.ctx = document.createElement('canvas').getContext('2d'));
  const sample = 'mmmmmmmmmmlliWWQ@#ő';
  return ['monospace', 'serif', 'sans-serif'].some((base) => {
    ctx.font = `72px ${base}`;
    const w = ctx.measureText(sample).width;
    ctx.font = `72px "${name}", ${base}`;
    return ctx.measureText(sample).width !== w;
  });
}
function fillFontSelect(sel) {
  sel.replaceChildren();
  for (const [group, list] of FONT_GROUPS) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const [n] of list) {
      if (n !== 'Georgia' && !fontInstalled(n)) continue;
      const o = document.createElement('option');
      o.value = n; o.textContent = n; o.style.fontFamily = fontCSS(n);
      og.appendChild(o);
    }
    if (og.children.length) sel.appendChild(og);
  }
}

// ---------- formatting ----------
const fmt = (n) => Number(n || 0).toLocaleString();
const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;
function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// "Chapter One", as Studio labels chapters.
const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function numWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  return String(n);
}
const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); return d; };

// Builds an element; text always goes in as text, never as markup.
function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'icon') node.insertAdjacentHTML('afterbegin', icon(v));
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return node;
}

// ---------- UI primitives ----------
function toast(msg, action) {
  const t = $('#toast');
  t.textContent = msg;
  if (action) {
    const a = document.createElement('a');
    a.textContent = action.label;
    a.onclick = () => { t.classList.remove('show'); action.run(); };
    t.appendChild(a);
  }
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2400);
}

// Generic modal, as in Studio. `body` is a Node; an action may have `run` (async), whose
// error message is shown in the dialog and whose result closes it.
function modal({ title, sub, body, actions = [], wide = false, onOpen }) {
  return new Promise((resolve) => {
    const wrap = el('div', { class: 'modal-wrap' });
    const box = el('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      title ? el('h3', { text: title }) : null, sub ? el('p', { class: 'm-sub', text: sub }) : null,
      el('div', { class: 'm-body' }, body || null));
    const err = el('div', { class: 'm-error hidden', role: 'alert' });
    const acts = el('div', { class: 'modal-actions' });
    box.append(err, acts);
    wrap.append(box);
    const close = (v) => {
      if (wrap.classList.contains('closing')) return;
      wrap.classList.add('closing');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => wrap.remove(), 170);
      resolve(v);
    };
    const choose = async (a, btn) => {
      if (!a.run) return close(a.value !== undefined ? a.value : (a.get ? a.get(box) : true));
      err.classList.add('hidden');
      if (btn) btn.disabled = true;
      try { const v = await a.run(box); if (v !== undefined) close(v); }
      catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
      finally { if (btn) btn.disabled = false; }
    };
    for (const a of actions) {
      const b = el('button', { class: `btn ${a.kind || 'ghost'}`, text: a.label });
      b.onclick = () => choose(a, b);
      acts.appendChild(b);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        e.preventDefault(); e.stopPropagation();
        const i = actions.findIndex((a) => a.kind === 'primary' || a.kind === 'danger');
        if (i >= 0) choose(actions[i], acts.children[i]);
      }
    }
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(null); });
    $('#modalRoot').appendChild(wrap);
    if (onOpen) onOpen(box);
    const first = $('input,select,textarea', box);
    if (first) { first.focus(); if (first.select) first.select(); }
    else if (acts.lastChild) acts.lastChild.focus();
  });
}
const confirmDialog = (title, sub, okLabel = 'OK', danger = false) => modal({
  title, sub,
  actions: [{ label: 'Cancel', value: false }, { label: okLabel, kind: danger ? 'danger' : 'primary', value: true }],
});
const promptDialog = (title, label, value = '', okLabel = 'Save') => modal({
  title,
  body: el('div', { class: 'field' }, el('label', { class: 'field-label', text: label }), el('input', { id: 'pdIn', value, maxlength: '200' })),
  actions: [{ label: 'Cancel', value: null }, { label: okLabel, kind: 'primary', get: (b) => $('#pdIn', b).value.trim() }],
});

function showMenu(x, y, items) {
  closeMenu();
  const m = el('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
    if (it.node) { m.appendChild(it.node); continue; }
    const b = el('button', { role: 'menuitem', text: it.label });
    if (it.danger) b.className = 'danger';
    if (it.on) b.classList.add('on');
    b.onclick = () => { closeMenu(); it.run(); };
    m.appendChild(b);
  }
  $('#menuRoot').appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  setTimeout(() => document.addEventListener('mousedown', closeMenuOutside, true));
}
function closeMenuOutside(e) { if (!e.target.closest('.menu')) closeMenu(); }
function closeMenu() { $('#menuRoot').replaceChildren(); document.removeEventListener('mousedown', closeMenuOutside, true); }
