'use strict';
// Lekhira Writes — real pages for the editor, and an undo history that copes with them.
// The same approach as Lekhira Studio's src/pages.js:
//
// The chapter stays one editable document. After each change we measure where every line
// falls; a line that would cross a page's bottom margin is pushed to the top of the next
// sheet, either by padding its block (first line of a paragraph) or by a small invisible
// spacer at the start of that line. Spacers are layout only: the editor's serialize() never
// sees them (they hold no text), so they are never saved.

const PAGE_GAP = 28;               // desk space between sheets, in page pixels
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'LI', 'BLOCKQUOTE', 'HR', 'DIV', 'BR']);
// Page sizes in inches: width, height, margin. "Book" is Studio's default 6 × 9 trim.
const PAGE_SIZES = {
  book: { label: 'Book (6 × 9 in)', w: 6, h: 9, m: 0.75 },
  a5: { label: 'A5', w: 5.83, h: 8.27, m: 0.7 },
  letter: { label: 'US Letter', w: 8.5, h: 11, m: 1 },
  a4: { label: 'A4', w: 8.27, h: 11.69, m: 1 },
};
const MAX_ZOOM = 1.25;             // Studio's default zoom

class PageLayout {
  constructor({ editor, page, scroller, markers, onPages }) {
    this.ed = editor;              // a LekhiraEditor.Editor
    this.root = editor.root;
    this.page = page;
    this.scroller = scroller;
    this.markers = markers;
    this.onPages = onPages || (() => {});
    this.size = PAGE_SIZES.book;
    this.sheetKey = '';
    this.pages = 1;
    this.composing = false;
    this.timer = null;
    this.history = new Map();      // chapter id → { undo, redo }
    this.chapterId = null;
    this.lastKind = ''; this.lastAt = 0; this.groupStart = 0;
    this.wire();
  }

  // ---------- size & zoom ----------
  setSize(key) {
    this.size = PAGE_SIZES[key] || PAGE_SIZES.book;
    const s = this.page.style;
    s.setProperty('--page-w', `${this.size.w * 96}px`);
    s.setProperty('--page-h', `${this.size.h * 96}px`);
    s.setProperty('--page-m', `${this.size.m * 96}px`);
    this.fit();
  }
  // The page is drawn at up to 125 %, smaller when the window is narrow.
  fit() {
    const room = this.scroller.clientWidth - 48;
    const z = room > 0 ? Math.max(0.45, Math.min(MAX_ZOOM, room / (this.size.w * 96))) : MAX_ZOOM;
    this.page.style.setProperty('--zoom', z.toFixed(3));
    document.documentElement.style.setProperty('--page-outer', `${Math.round(this.size.w * 96 * z)}px`);
    this.schedule(0, true);
  }

  // ---------- geometry ----------
  geometry() {
    const H = this.size.h * 96, M = this.size.m * 96, S = H + PAGE_GAP;
    const page = this.page;
    const scale = page.getBoundingClientRect().height / page.offsetHeight || 1;
    // Measured against the page's *current* position: inserting breaks can scroll the view.
    const Y = (v) => (v - page.getBoundingClientRect().top) / scale;
    Y.scale = scale;
    return {
      H, M, S, Y, scale,
      pageOf: (t) => Math.max(0, Math.floor(t / S)),
      bottomOf: (k) => k * S + H - M,
      topOf: (k) => k * S + M,
      range: document.createRange(),
    };
  }

  // ---------- selection as plain positions (survives rebuilding the page) ----------
  pointToIndex(node, offset) {
    const r = document.createRange();
    r.setStart(this.root, 0);
    r.setEnd(node, offset);
    const frag = r.cloneContents();
    let n = frag.textContent.length;
    for (const el of frag.querySelectorAll('*')) if (BLOCK_TAGS.has(el.tagName)) n++;
    return n;
  }
  indexToPoint(idx) {
    let count = 0;
    let found = null;
    const root = this.root;
    (function walk(node) {
      for (const c of node.childNodes) {
        if (found) return;
        if (c.nodeType === 3) {
          const len = c.nodeValue.length;
          if (count + len >= idx) { found = [c, idx - count]; return; }
          count += len;
        } else if (c.nodeType === 1) {
          if (BLOCK_TAGS.has(c.tagName)) {
            count++;
            if (count >= idx) {
              found = (c.tagName === 'BR' || c.tagName === 'HR') ? [node, [...node.childNodes].indexOf(c) + 1] : [c, 0];
              return;
            }
          }
          walk(c);
        }
      }
    })(root);
    if (!found) return [root, root.childNodes.length];
    // At a page break between words, put the caret on the new page, not the end of the old one.
    const [n, o] = found;
    if (n.nodeType === 3 && o === n.nodeValue.length && (o === 0 || /\s/.test(n.nodeValue[o - 1]))
      && n.nextSibling && n.nextSibling.classList && n.nextSibling.classList.contains('pb')) {
      const after = n.nextSibling.nextSibling;
      if (after && after.nodeType === 3) return [after, 0];
    }
    return found;
  }
  saveSelection() {
    const s = getSelection();
    if (!s.rangeCount || !this.root.contains(s.anchorNode) || !this.root.contains(s.focusNode)) return null;
    return { a: this.pointToIndex(s.anchorNode, s.anchorOffset), f: this.pointToIndex(s.focusNode, s.focusOffset) };
  }
  restoreSelection(saved) {
    if (!saved) return;
    const [an, ao] = this.indexToPoint(saved.a);
    const [fn, fo] = saved.f === saved.a ? [an, ao] : this.indexToPoint(saved.f);
    try { getSelection().setBaseAndExtent(an, ao, fn, fo); } catch { /* ignore */ }
  }

  // ---------- pagination ----------
  schedule(delay = 0, full = false) {
    if (full) this.fullNext = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.paginate(), delay);
  }

  blocks() { return [...this.root.children]; }

  textAround(b, sp, range) {
    range.setStart(b, 0);
    range.setEndBefore(sp);
    const before = range.toString();
    range.setStartAfter(sp);
    range.setEnd(b, b.childNodes.length);
    return { before, after: range.toString() };
  }

  // Is this block's layout still right? Every break remembers where it was placed and how
  // much text came before it; if either changed, the block is redone. (The browser also
  // copies these markers onto new paragraphs when you press Enter, which this catches.)
  blockValid(b, g) {
    const { Y, pageOf, bottomOf, range } = g;
    const br = b.getBoundingClientRect();
    const top = Y(br.top), bottom = Y(br.bottom);
    if (b.dataset.pb && Math.abs(top - parseFloat(b.dataset.pb)) > 0.75) return false;
    if (!b.dataset.pb && b.style.paddingTop) return false;
    for (const sp of b.querySelectorAll('.pb')) {
      if (Math.abs(Y(sp.getBoundingClientRect().top) - parseFloat(sp.dataset.t)) > 0.75) return false;
      const { before, after } = this.textAround(b, sp, range);
      if (String(before.length) !== sp.dataset.at) return false;
      if (/\S$/.test(before) && /^\S/.test(after)) return false;   // never break inside a word
    }
    if (bottom <= bottomOf(pageOf(top)) + 0.5) return true;
    if (!b.textContent.trim()) return false;
    const cs = getComputedStyle(b);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    return !this.crossingLine(b, range, Y, lh, pageOf, bottomOf);
  }

  stripBlock(b) {
    for (const sp of [...b.querySelectorAll('.pb')]) {
      const parent = sp.parentNode;
      sp.remove();
      parent.normalize();
    }
    if (b.dataset.pb || b.style.paddingTop) {
      b.removeAttribute('data-pb');
      b.style.removeProperty('padding-top');
      if (!b.getAttribute('style')) b.removeAttribute('style');
    }
  }

  // Checks every paragraph, but only re-lays the ones whose breaks are no longer right, so
  // typing stays quick. (A paste can add paragraphs above the cursor, so unlike Studio this
  // doesn't start from the paragraph being typed in.)
  paginate() {
    clearTimeout(this.timer);
    if (this.composing || !this.root.isConnected || !this.page.offsetHeight) return false;
    const g = this.geometry();
    const blocks = this.blocks();
    const full = this.fullNext;
    this.fullNext = false;
    let saved = null;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!full && this.blockValid(b, g)) continue;
      if (!saved) saved = { sel: this.saveSelection(), focus: document.activeElement === this.root, scroll: this.scroller.scrollTop };
      // A heading held together with this block must be re-decided along with it.
      const prev = blocks[i - 1];
      if (prev && prev.dataset.pb && /^H[234]$/.test(prev.tagName)) { this.stripBlock(prev); this.layout(prev, g); }
      this.stripBlock(b);
      this.layout(b, g);
    }
    if (saved) {
      if (saved.sel) {
        this.restoreSelection(saved.sel);
        if (!saved.focus) this.root.blur();
      }
      this.scroller.scrollTop = saved.scroll;
    }
    this.drawSheets(g);
    return !!saved;
  }

  drawSheets(g) {
    const { H, S, Y, pageOf } = g;
    const eb = Y(this.root.getBoundingClientRect().bottom);
    const n = Math.max(1, pageOf(eb - 1) + 1);
    const key = `${n}|${H}|${S}`;
    if (key !== this.sheetKey) {
      this.sheetKey = key;
      const sheets = [];
      for (let k = 0; k < n; k++) {
        const sheet = document.createElement('div');
        sheet.className = 'sheet';
        sheet.style.top = `${k * S}px`;
        sheet.style.height = `${H}px`;
        const folio = document.createElement('span');
        folio.className = 'folio';
        folio.textContent = String(k + 1);
        sheet.append(folio);
        sheets.push(sheet);
      }
      this.markers.replaceChildren(...sheets);
      this.page.style.minHeight = `${n * S - PAGE_GAP}px`;
    }
    this.pages = n;
    this.onPages(n);
  }

  layout(b, g) {
    const { Y, scale, pageOf, bottomOf, topOf, range } = g;
    const cs = getComputedStyle(b);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    let lastTop = -Infinity;
    for (let guard = 0; guard < 400; guard++) {
      const br = b.getBoundingClientRect();
      const bTop = Y(br.top), bBottom = Y(br.bottom);
      if (bBottom <= bottomOf(pageOf(bTop)) + 0.5) break;      // block fits on its page

      const line = this.crossingLine(b, range, Y, lh, pageOf, bottomOf);
      if (!line && b.textContent.trim()) break;                // already split across pages correctly
      if (!line || line.top <= bTop + 1) {
        // First line of the block doesn't fit: move the whole block. Keep a heading with it.
        const prev = b.previousElementSibling;
        const target = (!b.dataset.pb && prev && /^H[234]$/.test(prev.tagName) && !prev.dataset.pb
          && pageOf(Y(prev.getBoundingClientRect().top)) === pageOf(bTop)) ? prev : b;
        if (target.dataset.pb) break;                           // already moved, still too tall
        const tTop = Y(target.getBoundingClientRect().top);
        target.dataset.pb = tTop.toFixed(2);
        target.style.paddingTop = `${topOf(pageOf(tTop) + 1) - tTop}px`;
        continue;
      }
      // A later line doesn't fit: push it to the next sheet with a spacer, placed after the
      // space so the break always sits between two words. Each spacer must move the layout
      // forward; if the same line is still crossing, or no words are left to move, stop.
      if (line.top <= lastTop + 0.5) break;
      lastTop = line.top;
      const k = pageOf(line.top);
      const v = line.node.nodeValue;
      let off = line.offset;
      while (off < v.length && /\s/.test(v[off])) off++;
      if (off >= v.length) {
        const rest = document.createRange();
        rest.setStartAfter(line.node);
        rest.setEnd(b, b.childNodes.length);
        if (!rest.toString().trim()) break;   // only trailing spaces left: nothing to move
      }
      const sp = document.createElement('span');
      sp.className = 'pb';
      sp.contentEditable = 'false';
      let after = null;
      if (off < v.length) {
        after = off > 0 ? line.node.splitText(off) : line.node;
        after.parentNode.insertBefore(sp, after);
      } else {
        line.node.parentNode.insertBefore(sp, line.node.nextSibling);
      }
      let h = topOf(k + 1) - line.top;
      sp.style.height = `${h}px`;
      // Correct for rounding so the line lands exactly on the margin.
      if (after) {
        range.setStart(after, 0); range.setEnd(after, 1);
        const r = range.getClientRects()[0];
        if (r) {
          const err = topOf(k + 1) - (Y(r.top) - (lh - r.height / scale) / 2);
          if (Math.abs(err) > 0.5 && h + err > 0) { h += err; sp.style.height = `${h}px`; }
        }
      }
      sp.dataset.at = this.textAround(b, sp, range).before.length;
      sp.dataset.t = Y(sp.getBoundingClientRect().top).toFixed(2);
    }
  }

  // The first line in block `b` whose line box runs past its page's bottom margin.
  crossingLine(b, range, Y, lh, pageOf, bottomOf) {
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      if (!len) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (!rect.height) continue;
        const half = (lh - rect.height / Y.scale) / 2;
        const top = Y(rect.top) - Math.max(0, half);
        const bottom = Y(rect.bottom) + Math.max(0, half);
        if (bottom <= bottomOf(pageOf(top)) + 0.5) continue;
        // Binary-search the first character on this line.
        let lo = 0, hi = len - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          range.setStart(node, mid); range.setEnd(node, mid + 1);
          const cr = range.getClientRects();
          const t = cr.length ? cr[cr.length - 1].top : -Infinity;
          if (t >= rect.top - 1) hi = mid; else lo = mid + 1;
        }
        return { node, offset: lo, top };
      }
    }
    return null;
  }

  // ---------- undo history (per chapter, kept in memory) ----------
  // The browser's own undo can't be trusted once spacers are added, so, as in Studio,
  // undo restores snapshots of the chapter.
  setChapter(id) { this.chapterId = id; this.lastKind = ''; }
  hist() {
    if (!this.history.has(this.chapterId)) this.history.set(this.chapterId, { undo: [], redo: [] });
    return this.history.get(this.chapterId);
  }
  pushUndo(kind = 'cmd') {
    if (!this.chapterId) return;
    const now = Date.now();
    const grouped = (kind === 'typing' || kind === 'delete') && kind === this.lastKind && now - this.lastAt < 1200 && now - this.groupStart < 5000;
    this.lastAt = now;
    if (grouped) return;
    this.lastKind = kind; this.groupStart = now;
    const h = this.hist();
    h.undo.push({ doc: this.ed.serialize(), sel: this.saveSelection() });
    if (h.undo.length > 300) h.undo.shift();
    h.redo.length = 0;
  }
  applyHistory(from, to) {
    const state = from.pop();
    if (!state) return;
    to.push({ doc: this.ed.serialize(), sel: this.saveSelection() });
    this.ed.load(state.doc);
    this.root.focus();
    this.paginate();
    this.restoreSelection(state.sel);
    this.lastKind = '';
    this.ed.changed();
  }
  undo() { this.applyHistory(this.hist().undo, this.hist().redo); }
  redo() { this.applyHistory(this.hist().redo, this.hist().undo); }

  // The spacer right before/after a collapsed caret, if any.
  adjacentSpacer(dir) {
    const s = getSelection();
    if (!s.isCollapsed || !s.rangeCount) return null;
    const n = s.anchorNode, o = s.anchorOffset;
    let sib = null;
    if (dir < 0) sib = n.nodeType === 3 ? (o === 0 ? n.previousSibling : null) : n.childNodes[o - 1];
    else sib = n.nodeType === 3 ? (o === n.nodeValue.length ? n.nextSibling : null) : n.childNodes[o];
    return sib && sib.nodeType === 1 && sib.classList.contains('pb') ? sib : null;
  }

  wire() {
    const root = this.root;
    root.addEventListener('compositionstart', () => { this.composing = true; });
    root.addEventListener('compositionend', () => { this.composing = false; this.schedule(200); });
    root.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo') { e.preventDefault(); return this.undo(); }
      if (e.inputType === 'historyRedo') { e.preventDefault(); return this.redo(); }
      const kind = /^insert(Text|CompositionText|ReplacementText)$/.test(e.inputType) ? 'typing'
        : e.inputType.startsWith('delete') ? 'delete' : 'cmd';
      this.pushUndo(kind);
    });
    // Layout after each change is run by the editor's onChange (app.js calls paginate), so the
    // page is correct the first time it's painted.
    root.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && !e.altKey && k === 'z') { e.preventDefault(); return e.shiftKey ? this.redo() : this.undo(); }
      if (ctrl && !e.altKey && k === 'y') { e.preventDefault(); return this.redo(); }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const sp = this.adjacentSpacer(e.key === 'Backspace' ? -1 : 1);
        if (sp) sp.remove();
      }
    });
    new ResizeObserver(() => { clearTimeout(this.fitTimer); this.fitTimer = setTimeout(() => this.fit(), 140); }).observe(this.scroller);
  }
}

window.LekhiraPages = { PageLayout, PAGE_SIZES };
