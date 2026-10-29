'use strict';
// Lekhira Writes — the writing room on the web.
// Laid out like Lekhira Writing Studio (src/app.js): the same library, sidebar, toolbar,
// page, status bar, writing room and shortcuts, so a writer can move between them freely.

const api = window.LekhiraApi;

const DEFAULT_PREFS = { theme: 'charcoal', font: 'Georgia', size: 12, lineHeight: 1.7, paragraph: 'indent', align: 'left', smartPunct: true, typewriter: false };
const THEMES = [
  ['charcoal', 'Charcoal'],
  ['ink', 'Ink'],
  ['sepia', 'Sepia'],
  ['paper', 'Paper'],
  ['warm', 'Warm'],
];
const COVERS = ['gold', 'ink', 'sage', 'rose', 'dusk', 'paper'];
const SIZES = [10, 10.5, 11, 11.5, 12, 13, 14, 16, 18, 20];
const STATUS_NAMES = { idea: 'Idea', draft: 'Drafting', revise: 'Revising', done: 'Done' };
const LINES = [[1.3, 'Tight'], [1.5, 'Snug'], [1.7, 'Comfortable'], [2, 'Double']];
const ZOOM = 1.25;   // Studio's default page zoom; sizes are in points, as in Studio

let user = null;
let book = null;          // the open book (server row)
let chapters = [];        // chapter list for the open book
let current = null;       // the open chapter, with its doc
let editor = null;
let todayWords = 0;
let stats = null;
const titleEl = () => $('#chapterTitle');

// ---------- writing room ----------
const prefs = () => ({ ...DEFAULT_PREFS, ...(user && user.prefs) });
function applyPrefs() {
  const p = prefs();
  const page = $('#page');
  page.className = `theme-${p.theme} para-${p.paragraph} align-${p.align}`;
  page.style.setProperty('--font', fontCSS(p.font));
  page.style.setProperty('--size', `${p.size * ZOOM}pt`);
  page.style.setProperty('--lh', p.lineHeight);
  document.body.classList.toggle('typewriter', !!p.typewriter);
  if (editor) editor.prefs = p;
  $('#fontSelect').value = $('#bkFont').value = p.font;
  $('#sizeSelect').value = $('#bkSize').value = String(p.size);
  $('#bkLine').value = String(p.lineHeight);
  $$('#bkTheme .swatch').forEach((s) => s.classList.toggle('on', s.dataset.v === p.theme));
  $$('#bkPara button').forEach((b) => b.classList.toggle('on', b.dataset.v === p.paragraph));
  $$('#bkAlign button').forEach((b) => b.classList.toggle('on', b.dataset.v === p.align));
  $('#optPunct').checked = p.smartPunct !== false;
  $('#optTypewriter').checked = !!p.typewriter;
}
const savePrefs = debounce(async () => {
  try { user = (await api.patch('/api/me', { prefs: user.prefs })).user; } catch (e) { toast(e.message); }
}, 600);
function setPref(key, value) { user.prefs = { ...prefs(), [key]: value }; applyPrefs(); savePrefs(); }

function wireRoom() {
  fillFontSelect($('#fontSelect'));
  fillFontSelect($('#bkFont'));
  $('#sizeSelect').replaceChildren(...SIZES.map((s) => el('option', { value: String(s), text: `${s} pt` })));
  $('#bkSize').replaceChildren(...SIZES.map((s) => el('option', { value: String(s), text: `${s} pt` })));
  $('#bkLine').replaceChildren(...LINES.map(([v, l]) => el('option', { value: String(v), text: l })));
  $('#bkTheme').replaceChildren(...THEMES.map(([k, l]) => el('button', { class: 'swatch', dataset: { v: k }, onclick: () => setPref('theme', k) }, el('i', { text: 'Aa' }), l)));
  $('#fontSelect').onchange = $('#bkFont').onchange = (e) => setPref('font', e.target.value);
  $('#sizeSelect').onchange = $('#bkSize').onchange = (e) => setPref('size', Number(e.target.value));
  $('#bkLine').onchange = (e) => setPref('lineHeight', Number(e.target.value));
  for (const b of $$('#bkPara button')) b.onclick = () => setPref('paragraph', b.dataset.v);
  for (const b of $$('#bkAlign button')) b.onclick = () => setPref('align', b.dataset.v);
  $('#optPunct').onchange = (e) => setPref('smartPunct', e.target.checked);
  $('#optTypewriter').onchange = (e) => setPref('typewriter', e.target.checked);
  $('#roomBtn').onclick = () => toggleRoom();
  document.addEventListener('mousedown', (e) => {
    if (!$('#roomPop').classList.contains('hidden') && !e.target.closest('#roomPop, #roomBtn')) toggleRoom(false);
  });
}
function toggleRoom(show) {
  const pop = $('#roomPop');
  const open = show ?? pop.classList.contains('hidden');
  pop.classList.toggle('hidden', !open);
  $('#roomBtn').classList.toggle('on', open);
  if (open) {
    const r = $('#roomBtn').getBoundingClientRect();
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.left = `${Math.max(8, Math.min(r.right - 340, innerWidth - 348))}px`;
  }
}

// ---------- saving ----------
// Saves about a second after typing stops. A save that fails for network reasons is kept
// on this device and retried; a save that would overwrite newer text asks the writer first.
const BACKUP = () => `lw:backup:${user.id}:`;
const saver = {
  dirty: false, inFlight: null, timer: null, retry: 0, seq: 0, savedWords: 0, conflict: false,

  state(kind, text) {
    const s = $('#saveState');
    s.className = `save-state ${kind}`;
    s.textContent = text;
    if (kind === 'saved') setTimeout(() => { if (s.classList.contains('saved')) s.classList.add('quiet'); }, 2500);
  },

  changed() {
    if (!current || this.conflict) return;
    this.dirty = true;
    this.seq++;
    this.state('dirty', 'Editing…');
    this.backup();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 1000);
  },

  backup: debounce(() => {
    if (!current) return;
    try { localStorage.setItem(BACKUP() + current.id, JSON.stringify({ at: Date.now(), doc: editor.serialize() })); }
    catch { /* storage full or blocked: the server copy still saves */ }
  }, 1500),

  clearBackup(id) { try { localStorage.removeItem(BACKUP() + id); } catch { /* ignore */ } },

  async save({ force = false } = {}) {
    clearTimeout(this.timer);
    if (this.inFlight) { await this.inFlight; if (this.dirty) return this.save({ force }); return; }
    if (!this.dirty || !current) return;
    const ch = current;
    const seq = this.seq;
    const doc = editor.serialize();
    this.state('saving', 'Saving…');
    let conflicted = false;
    this.inFlight = (async () => {
      try {
        const r = await api.put(`/api/chapters/${ch.id}`, { doc, baseVersion: ch.version, day: dayKey(), force: force || undefined }, { timeout: 30000 });
        ch.version = r.version;
        todayWords += Math.max(0, r.words - this.savedWords);
        this.savedWords = ch.words = r.words;
        const meta = chapters.find((c) => c.id === ch.id);
        if (meta) { meta.words = r.words; meta.version = r.version; }
        this.retry = 0;
        if (this.seq === seq) {
          this.dirty = false;
          this.backup.cancel();
          this.clearBackup(ch.id);
          this.state('saved', 'Saved');
        } else {
          this.timer = setTimeout(() => this.save(), 600);
        }
        renderSidebar();
        updateCounts();
      } catch (e) {
        if (e.status === 409) { conflicted = true; this.conflict = true; return; }
        if (e.status === 401) { this.state('offline', 'Signed out — kept on this device'); return; }
        if (e.status === 0 || e.status >= 500 || e.status === 429) {
          this.retry = Math.min(this.retry + 1, 6);
          this.state('offline', e.status === 0 ? 'Offline — kept on this device' : 'Couldn’t save — retrying');
          this.backup();
          this.timer = setTimeout(() => this.save(), [2, 4, 8, 15, 30, 60][this.retry - 1] * 1000);
          return;
        }
        this.state('error', 'Not saved');
        toast(e.message);
      }
    })();
    try { await this.inFlight; } finally { this.inFlight = null; }
    // Asked only once this save has finished, so resolving it can save again.
    if (conflicted) await this.onConflict(ch);
  },

  async flush() {
    clearTimeout(this.timer);
    if (this.dirty && !this.conflict) await this.save();
    else if (this.inFlight) await this.inFlight;
  },

  async onConflict(ch) {
    this.conflict = true;
    this.state('error', 'Changed elsewhere');
    const choice = await modal({
      title: 'This chapter changed somewhere else',
      sub: 'It was edited in another tab or on another device since you opened it. Which version do you want to keep? The other one stays in Version history.',
      actions: [{ label: 'Load the other version', value: 'theirs' }, { label: 'Keep what’s on my screen', kind: 'primary', value: 'mine' }],
    });
    this.conflict = false;
    if (choice === 'theirs') {
      // Save what's on screen first (the other version goes into history), then restore
      // the other version, which puts this one into history. Nothing is lost either way.
      try {
        this.dirty = true;
        await this.save({ force: true });
        const { revisions } = await api.get(`/api/chapters/${ch.id}/revisions`);
        if (revisions[0]) await api.post(`/api/chapters/${ch.id}/restore`, { revisionId: revisions[0].id });
        await loadChapter(ch.id, { skipFlush: true });
        toast('Loaded the other version. Yours is in Version history.');
      } catch (e) { toast(e.message); }
    } else {
      this.dirty = true;
      await this.save({ force: true });
      toast('Your version was saved. The other one is in Version history.');
    }
  },
};

addEventListener('beforeunload', (e) => {
  if (saver.dirty || saver.inFlight) { saver.backup(); e.preventDefault(); e.returnValue = ''; }
});
addEventListener('online', () => { if (saver.dirty) saver.save(); });
addEventListener('blur', () => { if (saver.dirty) saver.save(); });
addEventListener('lekhira:signed-out', () => signedOut());

async function signedOut() {
  if (signedOut.shown) return;
  signedOut.shown = true;
  saver.backup();
  await modal({
    title: 'Please sign in again',
    sub: 'Your session ended. Anything you hadn’t saved is kept on this device and will be offered back to you after you sign in.',
    actions: [{ label: 'Sign in', kind: 'primary', value: true }],
  });
  location.href = api.page('/signin');
}

// ---------- routing ----------
function showView(name) {
  for (const v of ['library', 'trash', 'studio']) $(`#${v}`).classList.toggle('hidden', v !== name);
  if (name !== 'studio') {
    document.body.classList.remove('focus', 'panel-open');
    $('#saveState').className = 'save-state';
    $('#saveState').textContent = '';
    $('#docTitle').textContent = '';
    document.title = name === 'trash' ? 'Trash — Lekhira Writes' : 'Your library — Lekhira Writes';
  }
}

async function route() {
  closeMenu();
  toggleRoom(false);
  const p = api.pagePath().replace(/(.)\/$/, '$1');
  const m = p.match(/^\/app\/book\/([A-Za-z0-9_-]{8,32})(?:\/([A-Za-z0-9_-]{8,32}))?\/?$/);
  try {
    if (m) return await openBook(m[1], m[2]);
    await saver.flush();
    book = null;
    current = null;
    if (p === '/app/trash') await showTrash();
    else await showLibrary();
  } catch (e) {
    if (e.status === 404) { toast(e.message); go('/app', { replace: true }); }
    else if (e.status !== 401) toast(e.message);
  }
}
// Paths here are the app's own ("/app/…"); the site's base path is added for the address bar.
function go(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', api.page(path)); else history.pushState(null, '', api.page(path));
  return route();
}
addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  go(href.startsWith(api.base + '/') ? href.slice(api.base.length) : href);
});

// ---------- library ----------
function coverEl(b) {
  return el('div', { class: 'book-cover', dataset: { cover: b.cover || 'gold' } },
    el('div', { class: 'cover-title', text: b.title }),
    el('div', { class: 'cover-rule' }),
    b.subtitle ? el('div', { class: 'cover-sub', text: b.subtitle }) : null,
    el('div', { class: 'cover-author', text: b.author || '' }));
}

async function showLibrary() {
  showView('library');
  const [list, s] = await Promise.all([api.get('/api/books'), api.get(`/api/stats?day=${dayKey()}`)]);
  stats = s;
  todayWords = s.today;
  renderLibrary(list.books);
}

function renderLibrary(books) {
  const total = books.reduce((n, b) => n + b.words, 0);
  $('#libSub').textContent = books.length ? `${plural(books.length, 'book')} · ${plural(total, 'word')} written` : 'A quiet place to write.';
  const goal = user.dailyGoal;
  const spark = el('div', { class: 'spark', 'aria-label': 'Words written each day for the last four weeks' });
  const max = Math.max(goal || 1, ...stats.days.map((d) => d.words));
  stats.days.forEach((d, i) => {
    const bar = el('i', { class: `${d.words ? 'on' : ''}${i === stats.days.length - 1 ? ' today' : ''}`, title: `${new Date(d.day + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}: ${plural(d.words, 'word')}` });
    bar.style.height = `${Math.max(7, (d.words / max) * 100)}%`;
    spark.append(bar);
  });
  $('#todayCard').replaceChildren(el('div', { class: 'today-row' },
    el('div', { class: 'grow' },
      el('span', { class: 'kicker', text: 'Today' }),
      el('b', { text: goal ? `${fmt(todayWords)} of ${fmt(goal)} words` : `${plural(todayWords, 'word')}` }),
      el('p', {}, todayWords ? (goal && todayWords >= goal ? 'Daily goal reached. Lovely work. ' : 'Keep going — every line counts. ') : 'Nothing yet today — open a book and write a line. ',
        el('button', { class: 'linkish', text: 'Change goal', onclick: changeGoal }))),
    spark));
  $('#streakCard').replaceChildren(el('div', { class: 'sc-num', text: String(stats.streak) }),
    el('div', {}, el('b', { text: `${stats.streak === 1 ? 'day' : 'days'} in a row` }), el('p', { text: `${fmt(stats.totalWords)} words across your books.` })));

  const grid = $('#bookGrid');
  if (!books.length) {
    grid.replaceChildren(el('div', { class: 'lib-empty' },
      el('h2', { text: 'Every book begins with a blank page.' }),
      el('p', { text: 'Create your first book. It saves to your account as you write, and keeps earlier versions you can return to.' }),
      el('button', { class: 'btn primary', text: 'Start a new book', onclick: newBookFlow })));
    return;
  }
  grid.replaceChildren(...books.map((b) => {
    const card = el('div', { class: 'book-card', role: 'link', tabindex: '0', 'aria-label': `Open ${b.title}`,
      onclick: () => go(`/app/book/${b.id}`),
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === card) go(`/app/book/${b.id}`); } },
    coverEl(b),
    el('div', { class: 'book-meta' }, el('span', { text: plural(b.words, 'word') }), el('span', { text: timeAgo(b.updatedAt) })),
    el('button', { class: 'icon-btn sm card-del', 'data-icon': 'more', title: 'More', onclick: (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        { label: 'Open', run: () => go(`/app/book/${b.id}`) },
        { label: 'Download as Markdown', run: () => exportBook(b, 'md') },
        '-',
        { label: 'Move to trash', danger: true, run: () => trashBook(b) },
      ]);
    } }));
    return card;
  }));
  paintIcons(grid);
}

async function newBookFlow() {
  let cover = COVERS[Math.floor(Math.random() * COVERS.length)];
  const sw = el('div', { class: 'swatches' }, COVERS.map((c) => el('button', {
    class: `swatch${c === cover ? ' on' : ''}`, type: 'button', dataset: { cover: c }, 'aria-label': `${c} cover`,
    onclick: (e) => { cover = c; $$('.swatch', sw).forEach((x) => x.classList.toggle('on', x === e.currentTarget)); },
  }, el('i'))));
  const b = await modal({
    title: 'New book',
    body: el('div', {},
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: 'Title' }), el('input', { id: 'nbTitle', maxlength: '200', placeholder: 'Untitled' })),
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: 'Cover' }), sw)),
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Create book', kind: 'primary',
      run: async (box) => (await api.post('/api/books', { title: $('#nbTitle', box).value.trim() || 'Untitled', cover })).book,
    }],
  });
  if (b) go(`/app/book/${b.id}`);
}

async function trashBook(b) {
  await saver.flush();
  await api.del(`/api/books/${b.id}`);
  toast(`“${b.title}” moved to the trash`, { label: 'Undo', run: async () => { await api.post(`/api/books/${b.id}/restore`); if (!book) showLibrary(); } });
  if (book && book.id === b.id) go('/app'); else showLibrary();
}

async function showTrash() {
  showView('trash');
  const { books } = await api.get('/api/trash');
  const list = $('#trashList');
  if (!books.length) { list.replaceChildren(el('li', { class: 'draft-empty' }, 'The trash is empty.')); return; }
  list.replaceChildren(...books.map((b) => el('li', {},
    el('div', { class: 't-text' }, el('div', { class: 't-name', text: b.title }), el('div', { class: 't-meta', text: `${plural(b.words, 'word')} · moved to trash ${timeAgo(b.deletedAt)}` })),
    el('button', { class: 'btn sm', text: 'Restore', onclick: async () => { await api.post(`/api/books/${b.id}/restore`); toast(`“${b.title}” is back in your library`); showTrash(); } }),
    el('button', { class: 'btn sm danger-ghost', text: 'Delete forever', onclick: () => destroyBook(b) }))));
}

async function destroyBook(b) {
  const ok = await modal({
    title: 'Delete forever?',
    sub: `This permanently deletes “${b.title}” and every version of its chapters. It can’t be undone. Type the title to confirm.`,
    body: el('div', { class: 'field' }, el('input', { id: 'dfIn', autocomplete: 'off', 'aria-label': 'Book title' })),
    actions: [{ label: 'Cancel', value: false }, { label: 'Delete forever', kind: 'danger', run: async (box) => { await api.post(`/api/books/${b.id}/destroy`, { confirm: $('#dfIn', box).value.trim() }); return true; } }],
  });
  if (ok) { toast('Book deleted'); showTrash(); }
}

// ---------- the book ----------
async function openBook(id, chapterId) {
  if (!book || book.id !== id) {
    await saver.flush();
    const r = await api.get(`/api/books/${id}`);
    book = r.book;
    chapters = r.chapters;
    current = null;
    if (!stats) {
      try { stats = await api.get(`/api/stats?day=${dayKey()}`); todayWords = stats.today; } catch { /* optional */ }
    }
  }
  showView('studio');
  let cid = chapterId;
  if (!cid || !chapters.some((c) => c.id === cid)) {
    let last = null;
    try { last = localStorage.getItem(`lw:last:${id}`); } catch { /* ignore */ }
    cid = chapters.some((c) => c.id === last) ? last : chapters[0].id;
  }
  if (!current || current.id !== cid) await loadChapter(cid);
  else renderSidebar();
}

function chapterNumber(i) { return `Chapter ${numWords(i + 1)}`; }

function renderSidebar() {
  if (!book) return;
  $('#sideBookTitle').textContent = book.title;
  const total = bookWords();
  $('#sideBookMeta').textContent = `${book.author ? book.author + ' · ' : ''}${plural(chapters.length, 'chapter')} · ${fmt(total)} words`;
  $('#sideGoal').classList.toggle('hidden', !book.wordGoal);
  if (book.wordGoal) { $('#sideGoal i').style.width = `${Math.min(100, (total / book.wordGoal) * 100)}%`; $('#sideGoal').title = `${fmt(total)} of ${fmt(book.wordGoal)} words`; }
  const list = $('#chapterList');
  list.replaceChildren(...chapters.map((ch, i) => {
    const li = el('li', { class: `chapter-item${current && current.id === ch.id ? ' active' : ''}`, draggable: 'true', tabindex: '0', dataset: { id: ch.id },
      onclick: () => selectChapter(ch.id),
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === li) selectChapter(ch.id); } },
    el('span', { class: 'ch-num', text: String(i + 1) }),
    el('div', { class: 'ch-text' },
      el('div', { class: 'ch-title', text: ch.title }),
      el('div', { class: 'ch-words' }, el('i', { class: `sdot st-${ch.status}`, title: STATUS_NAMES[ch.status] }), plural(ch.words || 0, 'word'))),
    el('button', { class: 'icon-btn sm', 'data-icon': 'more', title: 'Chapter options', onclick: (e) => { e.stopPropagation(); chapterMenu(e.currentTarget, ch); } }));
    li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-lekhira-chapter', ch.id); e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { li.classList.remove('dragging'); $$('.drag-over, .drag-under', list).forEach((x) => x.classList.remove('drag-over', 'drag-under')); });
    li.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('text/x-lekhira-chapter')) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      li.classList.toggle('drag-over', before);
      li.classList.toggle('drag-under', !before);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over', 'drag-under'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = e.dataTransfer.getData('text/x-lekhira-chapter');
      const before = li.classList.contains('drag-over');
      li.classList.remove('drag-over', 'drag-under');
      if (!from || from === ch.id) return;
      const ids = chapters.map((x) => x.id).filter((x) => x !== from);
      ids.splice(ids.indexOf(ch.id) + (before ? 0 : 1), 0, from);
      reorder(ids);
    });
    return li;
  }));
  paintIcons(list);
  const idx = chapters.findIndex((c) => current && c.id === current.id);
  $('#chapterLabel').textContent = idx >= 0 ? chapterNumber(idx) : '';
  const next = chapters[idx + 1];
  $('#nextChapter').textContent = next ? `Next: ${next.title} →` : '+ Add the next chapter';
  $('#nextChapter').onclick = () => (next ? selectChapter(next.id) : addChapter());
  renderDocTitle();
  updateCounts();
}

function renderDocTitle() {
  const d = $('#docTitle');
  d.replaceChildren(el('b', { text: book.title }), current ? ` — ${current.title}` : '');
  document.title = `${book.title} — Lekhira Writes`;
}

async function reorder(ids) {
  const old = chapters;
  chapters = ids.map((id) => old.find((c) => c.id === id));
  renderSidebar();
  try { chapters = (await api.put(`/api/books/${book.id}/order`, { ids })).chapters; renderSidebar(); }
  catch (e) { chapters = old; renderSidebar(); toast(e.message); }
}

function chapterMenu(anchor, ch) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [
    { label: 'Rename…', run: async () => { const t = await promptDialog('Rename chapter', 'Chapter title', ch.title); if (t) patchChapter(ch.id, { title: t }); } },
    { label: 'New chapter after this', run: () => addChapter(ch.id) },
    '-',
    ...Object.entries(STATUS_NAMES).map(([k, label]) => ({ label, on: ch.status === k, run: () => patchChapter(ch.id, { status: k }) })),
    '-',
    { label: 'Delete chapter…', danger: true, run: () => deleteChapter(ch) },
  ]);
}

async function patchChapter(id, body) {
  try {
    const r = await api.patch(`/api/chapters/${id}`, body);
    const i = chapters.findIndex((c) => c.id === id);
    if (i >= 0) chapters[i] = { ...chapters[i], title: r.chapter.title, status: r.chapter.status };
    if (current && current.id === id) {
      current.title = r.chapter.title;
      if (body.title && document.activeElement !== titleEl()) titleEl().textContent = r.chapter.title;
    }
    renderSidebar();
  } catch (e) { toast(e.message); }
}

async function addChapter(after) {
  if (!book) return;
  await saver.flush();
  try {
    const r = await api.post(`/api/books/${book.id}/chapters`, { after: after || (current && current.id) });
    chapters = r.chapters;
    await loadChapter(r.chapter.id);
    const t = titleEl();
    t.focus();
    getSelection().selectAllChildren(t);
  } catch (e) { toast(e.message); }
}

async function deleteChapter(ch) {
  const ok = await confirmDialog(`Delete “${ch.title}”?`, `This removes the chapter and its ${plural(ch.words, 'word')} from the book. It can’t be undone — you might want to export the book first.`, 'Delete chapter', true);
  if (!ok) return;
  try {
    const wasCurrent = current && current.id === ch.id;
    if (wasCurrent) { saver.dirty = false; clearTimeout(saver.timer); }
    const idx = chapters.findIndex((x) => x.id === ch.id);
    const r = await api.del(`/api/chapters/${ch.id}`);
    saver.clearBackup(ch.id);
    chapters = r.chapters;
    if (wasCurrent) await loadChapter(chapters[Math.max(0, idx - 1)].id, { skipFlush: true });
    else renderSidebar();
    toast('Chapter deleted');
  } catch (e) { toast(e.message); }
}

async function selectChapter(id) {
  document.body.classList.remove('sidebar-open');
  if (current && current.id === id) return;
  await loadChapter(id);
}

async function loadChapter(id, { skipFlush = false } = {}) {
  if (!skipFlush) await saver.flush();
  const { chapter } = await api.get(`/api/chapters/${id}`);
  current = chapter;
  saver.dirty = false;
  saver.savedWords = chapter.words;
  editor.load(chapter.doc);
  titleEl().textContent = chapter.title;
  $('#scroller').scrollTop = 0;
  try { localStorage.setItem(`lw:last:${book.id}`, id); } catch { /* ignore */ }
  history.replaceState(null, '', api.page(`/app/book/${book.id}/${id}`));
  saver.state('saved quiet', `Saved ${timeAgo(chapter.updatedAt)}`);
  renderSidebar();
  offerBackup(chapter);
}

// If this device holds unsaved text for the chapter (offline, closed tab), offer it back.
async function offerBackup(chapter) {
  let backup = null;
  try { backup = JSON.parse(localStorage.getItem(BACKUP() + chapter.id) || 'null'); } catch { backup = null; }
  if (!backup || !backup.doc) return;
  if (JSON.stringify(backup.doc.blocks) === JSON.stringify(chapter.doc.blocks)) { saver.clearBackup(chapter.id); return; }
  const choice = await modal({
    title: 'Unsaved writing found',
    sub: `This device kept changes to “${chapter.title}” from ${timeAgo(backup.at)} that didn’t reach your account. Restore them?`,
    actions: [{ label: 'Discard', value: 'discard' }, { label: 'Restore my changes', kind: 'primary', value: 'restore' }],
  });
  if (choice === 'restore' && current && current.id === chapter.id) {
    editor.load(backup.doc);
    saver.changed();
    await saver.save({ force: true });
    toast('Your changes were restored and saved');
  } else if (choice === 'discard') saver.clearBackup(chapter.id);
}

// ---------- counts ----------
function bookWords() {
  const live = current && editor ? editor.words() : 0;
  return chapters.reduce((n, c) => n + (current && c.id === current.id ? 0 : c.words), 0) + live;
}
const updateCounts = debounce(() => {
  if (!book || !editor) return;
  const live = current ? editor.words() : 0;
  $('#sbChapterWords').textContent = `Chapter · ${plural(live, 'word')}`;
  $('#sbBookWords').textContent = `Book · ${plural(bookWords(), 'word')}`;
  const written = todayWords + Math.max(0, live - saver.savedWords);
  const goal = user.dailyGoal;
  $('#goalText').textContent = goal ? `${fmt(written)} / ${fmt(goal)} today` : `${fmt(written)} today`;
  $('#goalRing').style.strokeDashoffset = String(50.27 * (1 - (goal ? Math.min(1, written / goal) : 0)));
  const done = goal && written >= goal;
  if (done && !$('#goalBtn').classList.contains('done') && updateCounts.ready) toast('Daily goal reached. Lovely work.');
  $('#goalBtn').classList.toggle('done', !!done);
  updateCounts.ready = true;
}, 250);

function reflectSelection(s) {
  $('#blockSelect').value = s.block === 'break' ? 'p' : s.block;
  for (const k of ['bold', 'italic', 'underline']) $(`#toolbar [data-cmd="${k}"]`).classList.toggle('on', !!s[k]);
  $('#sbSelection').textContent = s.selectionWords ? `${plural(s.selectionWords, 'word')} selected` : '';
  $('#sbSelDot').classList.toggle('hidden', !s.selectionWords);
}

function command(cmd) {
  if (cmd === 'sceneBreak') editor.insertBreak();
  else if (cmd === 'undo' || cmd === 'redo') editor.history(cmd);
  else editor.mark(cmd);
}

async function changeGoal() {
  const v = await promptDialog('Daily word goal', 'Words a day (0 turns the goal off)', String(user.dailyGoal));
  if (v === null) return;
  const n = Math.min(20000, Number(String(v).replace(/[^\d]/g, '')) || 0);
  try {
    user = (await api.patch('/api/me', { dailyGoal: n })).user;
    updateCounts.ready = false;
    if (!$('#library').classList.contains('hidden')) showLibrary(); else updateCounts();
  } catch (e) { toast(e.message); }
}

// ---------- word count (as Studio's) ----------
function textStats(text) {
  const t = text.replace(/\n+$/, '');
  return {
    words: window.LekhiraEditor.countWords(t),
    chars: t.replace(/\n/g, '').length,
    noSpace: t.replace(/\s/g, '').length,
    paras: t.split(/\n+/).filter((l) => l.trim()).length,
  };
}
const docText = (doc) => doc.blocks.filter((b) => b.t !== 'break').map((b) => b.r.map((r) => r.x).join('')).join('\n');
async function wordCountDialog() {
  if (!book) return;
  const sel = getSelection();
  const picked = sel.rangeCount && !sel.isCollapsed && $('#editor').contains(sel.anchorNode) ? sel.toString() : '';
  await saver.flush();
  const data = await api.get(`/api/books/${book.id}/export?format=json`);
  const chapter = textStats(docText(editor.serialize()));
  const whole = textStats(data.chapters.map((c) => (c.id === current.id ? docText(editor.serialize()) : docText(c.doc))).join('\n'));
  const cols = [['This chapter', chapter], ['Whole book', whole], ...(picked ? [['Selected', textStats(picked)]] : [])];
  const row = (label, key) => el('tr', {}, el('th', { text: label }), cols.map(([, s]) => el('td', { text: fmt(s[key]) })));
  modal({
    title: 'Word count',
    body: el('table', { class: 'wc-table' },
      el('thead', {}, el('tr', {}, el('th'), cols.map(([l]) => el('th', { text: l })))),
      el('tbody', {}, row('Words', 'words'), row('Characters', 'chars'), row('Characters without spaces', 'noSpace'), row('Paragraphs', 'paras'),
        el('tr', {}, el('th', { text: 'Pages' }), el('td', { text: `about ${fmt(Math.max(1, Math.round(chapter.words / 250)))}` }), el('td', { text: `about ${fmt(Math.max(1, Math.round(whole.words / 250)))} in print` }), picked ? el('td') : null))),
    actions: [{ label: 'Close', kind: 'primary', value: true }],
  });
}

function shortcutsDialog() {
  const keys = [
    ['Save now', 'Ctrl S'], ['Word count', 'Ctrl Shift C'], ['New chapter', 'Ctrl Alt N'],
    ['Previous / next chapter', 'Alt PgUp / PgDn'],
    ['Body text', 'Ctrl 0'], ['Heading / Subheading / Subtitle', 'Ctrl 1 / 2 / 3'], ['Quote', 'Ctrl 4'],
    ['Bold / Italic / Underline', 'Ctrl B / I / U'], ['Scene break', 'Ctrl Enter'],
    ['Find in the page', 'Ctrl F'], ['Focus mode', 'F11'], ['Toggle sidebar', 'Ctrl \\'],
    ['Version history', 'Ctrl Shift H'], ['Export', 'Ctrl E'], ['This list', 'Ctrl /'],
  ];
  modal({
    title: 'Keyboard shortcuts',
    sub: 'The same keys as Lekhira Studio. A browser keeps Ctrl N and Ctrl PgUp / PgDn for itself, so Writes adds Alt.',
    body: el('div', { class: 'keys' }, keys.flatMap(([a, k]) => [el('span', { text: a }), el('span', {}, k.split(' ').map((x) => (x === '/' ? ' / ' : el('kbd', { text: x }))))])),
    actions: [{ label: 'Close', kind: 'primary', value: true }],
  });
}

// ---------- side panel ----------
function openPanel(title, build) {
  closeMenu();
  toggleRoom(false);
  if (openPanel.cleanup) openPanel.cleanup();
  $('#panelTitle').textContent = title;
  const body = $('#panelBody');
  body.replaceChildren();
  body.scrollTop = 0;
  openPanel.cleanup = build(body) || null;
  paintIcons(body);
  document.body.classList.add('panel-open');
}
function closePanel() {
  if (openPanel.cleanup) { openPanel.cleanup(); openPanel.cleanup = null; }
  document.body.classList.remove('panel-open');
}

function openHistory() {
  if (!current) return;
  const ch = current;
  openPanel('Version history', (body) => {
    body.append(el('p', { class: 'hint', text: `Earlier versions of “${ch.title}”. A version is kept about every ten minutes while you write (the last 30), and before every restore.` }));
    const list = el('ul', { class: 'draft-list' }, el('li', { class: 'draft-empty', text: 'Loading…' }));
    body.append(list);
    (async () => {
      await saver.flush();
      const { revisions } = await api.get(`/api/chapters/${ch.id}/revisions`);
      if (!revisions.length) { list.replaceChildren(el('li', { class: 'draft-empty', text: 'No earlier versions yet. Keep writing.' })); return; }
      list.replaceChildren(...revisions.map((v) => {
        const item = el('li', { class: 'draft-item' },
          el('div', { class: 'd-name', text: new Date(v.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }),
          el('div', { class: 'd-meta', text: `${timeAgo(v.savedAt)} · ${plural(v.words, 'word')}` }));
        item.onclick = async () => {
          if (item.classList.contains('on')) return;
          $$('.draft-item', list).forEach((x) => { x.classList.remove('on'); $$('.d-actions, .rev-preview', x).forEach((n) => n.remove()); });
          item.classList.add('on');
          const { revision } = await api.get(`/api/chapters/${ch.id}/revisions/${v.id}`);
          const pv = el('div', { class: `rev-preview ${$('#page').className}` });
          pv.style.setProperty('--font', fontCSS(prefs().font));
          window.LekhiraEditor.renderStatic(revision.doc, pv);
          item.append(el('div', { class: 'd-actions' }, el('button', { class: 'btn sm primary', text: 'Restore this version', onclick: (e) => { e.stopPropagation(); restoreRevision(ch, v); } })), pv);
        };
        return item;
      }));
    })().catch((e) => list.replaceChildren(el('li', { class: 'draft-empty', text: e.message })));
  });
}

async function restoreRevision(ch, v) {
  const ok = await confirmDialog('Restore this version?', 'The chapter goes back to this version. What’s there now is kept in history, so you can switch back.', 'Restore');
  if (!ok) return;
  try {
    await saver.flush();
    const r = await api.post(`/api/chapters/${ch.id}/restore`, { revisionId: v.id });
    closePanel();
    if (current && current.id === ch.id) {
      current.version = r.chapter.version;
      saver.savedWords = current.words = r.chapter.words;
      editor.load(r.chapter.doc);
      const meta = chapters.find((c) => c.id === ch.id);
      if (meta) { meta.words = r.chapter.words; meta.version = r.chapter.version; }
      renderSidebar();
    }
    toast('Version restored');
  } catch (e) { toast(e.message); }
}

function openDetails() {
  const b = book;
  openPanel('Book details', (body) => {
    const field = (label, id, value, extra = {}) => el('div', { class: 'field' }, el('label', { class: 'field-label', for: id, text: label }), el('input', { id, value: value || '', ...extra }));
    let cover = b.cover;
    const sw = el('div', { class: 'swatches' }, COVERS.map((c) => el('button', {
      class: `swatch${c === cover ? ' on' : ''}`, type: 'button', dataset: { cover: c }, 'aria-label': `${c} cover`,
      onclick: (e) => { cover = c; $$('.swatch', sw).forEach((x) => x.classList.toggle('on', x === e.currentTarget)); },
    }, el('i'))));
    body.append(
      field('Title', 'bdTitle', b.title, { maxlength: '200' }),
      field('Subtitle', 'bdSub', b.subtitle, { maxlength: '300', placeholder: 'Optional' }),
      field('Author', 'bdAuthor', b.author, { maxlength: '120' }),
      field('Word goal for the book', 'bdGoal', b.wordGoal ? String(b.wordGoal) : '', { inputmode: 'numeric', placeholder: 'e.g. 80000', maxlength: '8' }),
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: 'Cover' }), sw),
      el('button', { class: 'btn primary block', text: 'Save details', onclick: async () => {
        try {
          const r = await api.patch(`/api/books/${b.id}`, {
            title: $('#bdTitle').value, subtitle: $('#bdSub').value, author: $('#bdAuthor').value, cover,
            wordGoal: Math.min(2000000, Number($('#bdGoal').value.replace(/[^\d]/g, '')) || 0),
          });
          book = { ...book, ...r.book };
          renderSidebar();
          toast('Book details saved');
        } catch (e) { toast(e.message); }
      } }));
    body.append(el('div', { class: 'pane-h', text: 'Export' }),
      el('p', { class: 'hint', text: 'Your words are always yours. Download the whole book whenever you like.' }),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn sm', text: 'Markdown', onclick: () => exportBook(b, 'md') }),
        el('button', { class: 'btn sm', text: 'Plain text', onclick: () => exportBook(b, 'txt') }),
        el('button', { class: 'btn sm', text: 'Print or save PDF', onclick: () => printBook(b) })),
      el('div', { class: 'note-card', icon: 'sparkle' }, el('span', { text: 'Markdown opens in Lekhira Studio (Import) with your chapters intact — ready for typeset pages, EPUB and paperback PDF.' })));
    body.append(el('div', { class: 'pane-h', text: 'Remove' }),
      el('button', { class: 'btn sm danger-ghost', text: 'Move book to trash', onclick: () => { closePanel(); trashBook(b); } }));
  });
}

async function exportBook(b, format) {
  try {
    if (book && book.id === b.id) await saver.flush();
    await api.download(`/api/books/${b.id}/export?format=${format}`, `${b.title}.${format}`);
  } catch (e) { toast(e.message); }
}

async function printBook(b) {
  try {
    await saver.flush();
    const data = await api.get(`/api/books/${b.id}/export?format=json`);
    const root = $('#printRoot');
    root.replaceChildren(el('div', { class: 'p-title' }, el('h1', { text: data.book.title }),
      data.book.subtitle ? el('h2', { text: data.book.subtitle }) : null, data.book.author ? el('div', { class: 'by', text: data.book.author }) : null));
    data.chapters.forEach((c, i) => {
      const sec = el('section', {}, el('div', { class: 'p-label', text: chapterNumber(i) }), el('h1', { text: c.title }));
      window.LekhiraEditor.renderStatic(c.doc, sec);
      root.append(sec);
    });
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); root.replaceChildren(); removeEventListener('afterprint', done); };
    addEventListener('afterprint', done);
    setTimeout(() => print(), 50);
  } catch (e) { toast(e.message); }
}

function openStudio() {
  openPanel('Lekhira Studio', (body) => {
    body.append(el('p', { class: 'hint', text: 'Lekhira Writes has what you need to write. Lekhira Studio, our desktop app, is where a manuscript becomes a book. It looks and works like Writes, plus:' }));
    const items = [
      ['pages', 'Real book pages', 'Write straight onto typeset pages at your book’s own trim size.'],
      ['sparkle', 'Craft coach & Writing DNA', 'Readability, rhythm and habits, learned from your own style. Never generated.'],
      ['atlas', 'Story Atlas & Outline', 'Characters, places and threads, with every chapter they appear in.'],
      ['bookOpen', 'Publish', 'Paperback-ready PDF, EPUB 3 and manuscript DOCX, with a live preview.'],
      ['compare', 'Drafts & compare', 'Snapshots of the whole book, compared word by word.'],
      ['offline', 'Local & private', 'Works with no internet. Keep a book only on your computer, or sync it.'],
    ];
    body.append(el('div', { class: 'studio-list' }, items.map(([ic, t, d]) => el('div', { class: 'studio-item' }, el('div', { class: 'ic', icon: ic }), el('div', {}, el('b', { text: t }), el('span', { text: d }))))));
    body.append(el('div', { class: 'note-card', icon: 'heart' }, el('span', { text: 'Writing, saving and exporting in Lekhira Writes stay free. We never put your own words behind a paywall.' })));
    body.append(el('p', { class: 'hint', text: 'Lekhira Studio is in testing now. Ask us at lekhira.com to join the next group of testers.' }));
    body.lastChild.style.marginTop = '16px';
  });
}

function openAccount() {
  openPanel('Account & privacy', (body) => {
    const row = (label, input) => el('div', { class: 'field' }, el('label', { class: 'field-label', text: label }), input);
    const name = el('input', { value: user.name, maxlength: '80' });
    body.append(el('div', { class: 'pane-h', text: 'Profile' }), row('Name', name), row('Email', el('input', { value: user.email, disabled: true })),
      el('button', { class: 'btn sm primary', text: 'Save', onclick: async () => {
        try { user = (await api.patch('/api/me', { name: name.value })).user; paintAvatar(); toast('Saved'); } catch (e) { toast(e.message); }
      } }));

    const cur = el('input', { type: 'password', autocomplete: 'current-password', maxlength: '200' });
    const next = el('input', { type: 'password', autocomplete: 'new-password', maxlength: '200' });
    body.append(el('div', { class: 'pane-h', text: 'Password' }), row('Current password', cur), row('New password', next),
      el('p', { class: 'hint', text: 'At least 10 characters. Changing it signs out your other devices.' }),
      el('button', { class: 'btn sm primary', text: 'Change password', onclick: async () => {
        try { await api.post('/api/me/password', { current: cur.value, next: next.value }); cur.value = next.value = ''; toast('Password changed. Other devices were signed out.'); loadSessions(); }
        catch (e) { toast(e.message); }
      } }));

    const sessions = el('div');
    async function loadSessions() {
      try {
        const r = await api.get('/api/me/sessions');
        sessions.replaceChildren(...r.sessions.map((s) => el('div', { class: 'session-row' }, el('span', { text: describeAgent(s.agent) }),
          s.current ? el('span', { class: 'cur', text: 'This device' }) : el('span', { text: `Active ${timeAgo(s.lastSeen)}` }))));
      } catch { /* optional */ }
    }
    loadSessions();
    body.append(el('div', { class: 'pane-h', text: 'Where you’re signed in' }), sessions,
      el('button', { class: 'btn sm block', text: 'Sign out all other devices', onclick: async () => {
        try { await api.post('/api/me/signout-others'); toast('Other devices signed out'); loadSessions(); } catch (e) { toast(e.message); }
      } }));

    body.append(el('div', { class: 'pane-h', text: 'Your data' }),
      el('p', { class: 'hint', text: 'Download everything Lekhira holds for you: your account, every book and chapter, and your writing log.' }),
      el('button', { class: 'btn sm', text: 'Download all my data', onclick: async () => {
        try { await saver.flush(); await api.download('/api/me/export', 'Lekhira Writes export.json'); } catch (e) { toast(e.message); }
      } }));

    body.append(el('div', { class: 'pane-h', text: 'Delete account' }), el('div', { class: 'danger-zone' },
      el('p', { class: 'hint', text: 'Deletes your account and all your books straight away. Download your data first if you want to keep it.' }),
      el('button', { class: 'btn sm danger', text: 'Delete my account…', onclick: deleteAccount })));
  });
}

function describeAgent(a) {
  const s = String(a || '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'A browser';
  const os = /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'macOS' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

async function deleteAccount() {
  const ok = await modal({
    title: 'Delete your account?',
    sub: 'Your account, books, versions and settings will be deleted permanently. This can’t be undone.',
    body: el('div', {},
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: 'Password' }), el('input', { id: 'daPw', type: 'password', autocomplete: 'current-password' })),
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: 'Type DELETE to confirm' }), el('input', { id: 'daConfirm', autocomplete: 'off', placeholder: 'DELETE' }))),
    actions: [{ label: 'Cancel', value: false }, { label: 'Delete everything', kind: 'danger', run: async (box) => {
      await api.post('/api/me/delete', { password: $('#daPw', box).value, confirm: $('#daConfirm', box).value.trim() });
      return true;
    } }],
  });
  if (ok) { clearLocal(); location.replace(api.page('/')); }
}

function clearLocal() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('lw:')) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}

async function signOut() {
  await saver.flush();
  if (saver.dirty && !(await confirmDialog('Sign out with unsaved changes?', 'Some changes haven’t reached your account yet. If you sign out now they’ll be lost.', 'Sign out anyway', true))) return;
  try { await api.post('/api/auth/signout'); } catch { /* signing out locally anyway */ }
  saver.dirty = false;
  clearLocal();
  location.replace(api.page('/'));
}

function paintAvatar() {
  $('#accountBtn').textContent = user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '·';
  $('#accountBtn').title = `${user.name} — account`;
}

function accountMenu() {
  const r = $('#accountBtn').getBoundingClientRect();
  showMenu(r.right - 200, r.bottom + 6, [
    { node: el('div', { class: 'who' }, el('b', { text: user.name }), el('span', { text: user.email })) },
    '-',
    { label: 'Your library', run: () => go('/app') },
    { label: 'Account & privacy', run: openAccount },
    { label: 'Lekhira Studio', run: openStudio },
    { label: 'Keyboard shortcuts', run: shortcutsDialog },
    '-',
    { label: 'Sign out', run: signOut },
  ]);
}

// ---------- focus mode ----------
function toggleFocus() {
  if (!book) return;
  const on = document.body.classList.toggle('focus');
  if (on) {
    closePanel();
    toggleRoom(false);
    const hint = $('#focusHint');
    hint.classList.add('show');
    clearTimeout(toggleFocus.t);
    toggleFocus.t = setTimeout(() => hint.classList.remove('show'), 2200);
    editor.root.focus();
  }
}
const exitFocus = () => document.body.classList.remove('focus');

// ---------- keys (the same map as Studio's onGlobalKey) ----------
function onGlobalKey(e) {
  if ($('#modalRoot').children.length) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') {
    if ($('#menuRoot').children.length) return closeMenu();
    if (!$('#roomPop').classList.contains('hidden')) return toggleRoom(false);
    if (document.body.classList.contains('panel-open')) return closePanel();
    if (document.body.classList.contains('focus')) return exitFocus();
    return;
  }
  if (!book) {
    if (ctrl && e.altKey && k === 'n') { e.preventDefault(); newBookFlow(); }
    if (ctrl && k === '/') { e.preventDefault(); shortcutsDialog(); }
    return;
  }
  if (e.key === 'F11') { e.preventDefault(); return toggleFocus(); }
  if (e.altKey && !ctrl && e.key === 'PageUp') { e.preventDefault(); return stepChapter(-1); }
  if (e.altKey && !ctrl && e.key === 'PageDown') { e.preventDefault(); return stepChapter(1); }
  if (!ctrl) return;
  if (k === 's') { e.preventDefault(); saver.dirty = saver.dirty || !!current; saver.save().then(() => toast('Saved')); return; }
  if (k === 'c' && e.shiftKey) { e.preventDefault(); return wordCountDialog(); }
  if (k === 'n' && (e.altKey || e.shiftKey)) { e.preventDefault(); return addChapter(); }
  if (k === 'f' && e.shiftKey) { e.preventDefault(); return toggleFocus(); }
  if (k === 'h' && e.shiftKey) { e.preventDefault(); return openHistory(); }
  if (k === 'e') { e.preventDefault(); return openDetails(); }
  if (k === '/') { e.preventDefault(); return shortcutsDialog(); }
  if (k === '\\') { e.preventDefault(); return toggleSidebar(); }
}
function stepChapter(d) {
  const i = chapters.findIndex((c) => current && c.id === current.id) + d;
  if (chapters[i]) loadChapter(chapters[i].id);
}
function toggleSidebar() {
  if (innerWidth <= 900) document.body.classList.toggle('sidebar-open');
  else document.body.classList.toggle('no-sidebar');
}

// ---------- start ----------
function wire() {
  paintIcons();
  wireRoom();
  for (const b of $$('#toolbar [data-cmd]')) {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.onclick = () => command(b.dataset.cmd);
  }
  let lastRange = null;
  document.addEventListener('selectionchange', () => {
    const sel = getSelection();
    if (sel.rangeCount && $('#editor').contains(sel.anchorNode)) lastRange = sel.getRangeAt(0).cloneRange();
  });
  $('#blockSelect').onchange = (e) => {
    $('#editor').focus();
    if (lastRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(lastRange); }
    editor.setBlock(e.target.value);
  };

  const saveTitle = debounce((id, t) => { if (t.trim()) patchChapter(id, { title: t.trim() }); }, 700);
  titleEl().addEventListener('input', () => {
    if (!current) return;
    const t = titleEl().textContent.replace(/\s+/g, ' ');
    const meta = chapters.find((c) => c.id === current.id);
    if (meta && t.trim()) { meta.title = t.trim(); const n = $(`#chapterList [data-id="${meta.id}"] .ch-title`); if (n) n.textContent = meta.title; }
    saveTitle(current.id, t);
  });
  titleEl().addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); editor.focusStart(); }
  });

  $('#addChapterBtn').onclick = () => addChapter(chapters[chapters.length - 1].id);
  $('#sideBook').onclick = openDetails;
  $('#exportLink').onclick = openDetails;
  $('#historyLink').onclick = openHistory;
  $('#historyBtn').onclick = openHistory;
  $('#sideHelp').onclick = shortcutsDialog;
  $('#shortcutsBtn').onclick = shortcutsDialog;
  $('#focusBtn').onclick = toggleFocus;
  $('#toggleSidebar').onclick = toggleSidebar;
  $('#closePanel').onclick = closePanel;
  $('#studioBtn').onclick = openStudio;
  $('#accountBtn').onclick = accountMenu;
  $('#newBookBtn').onclick = newBookFlow;
  $('#trashBtn').onclick = () => go('/app/trash');
  $('#goalBtn').onclick = changeGoal;
  $('#sbChapterWords').onclick = wordCountDialog;
  document.addEventListener('keydown', onGlobalKey);
}

async function boot() {
  try { user = (await api.get('/api/me')).user; }
  catch { location.replace(api.page('/signin')); return; }
  wire();
  paintAvatar();
  editor = new window.LekhiraEditor.Editor($('#editor'), {
    prefs: prefs(),
    onChange: () => { saver.changed(); updateCounts(); },
    onSelection: reflectSelection,
  });
  applyPrefs();
  await route();
  document.body.classList.remove('booting');
}

boot().catch(() => { document.body.classList.remove('booting'); toast('Something went wrong while opening. Your books are safe in your account.'); });
