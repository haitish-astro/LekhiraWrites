// Lekhira Writes — the chapter editor.
// The page is a contenteditable element, but what we save is a list of blocks read back
// from it (see server/doc.js). Loading always rebuilds the page from those blocks using
// text nodes, so nothing pasted, dropped or stored can turn into live markup.
'use strict';
window.LekhiraEditor = (() => {
  // The same page elements as Lekhira Studio: Heading h2, Subheading h3, Subtitle h4.
  const TAG = { p: 'P', h1: 'H2', h2: 'H3', h3: 'H4', quote: 'BLOCKQUOTE', break: 'HR' };
  const TYPE_OF = { P: 'p', DIV: 'p', H1: 'h1', H2: 'h1', H3: 'h2', H4: 'h3', H5: 'h3', H6: 'h3', BLOCKQUOTE: 'quote', HR: 'break' };
  const MARK = { B: 1, STRONG: 1, I: 2, EM: 2, U: 4 };
  const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

  const rid = () => {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const countWords = (s) => (s.match(WORD) || []).length;

  class Editor {
    constructor(root, { onChange, onSelection, beforeCommand, prefs }) {
      this.root = root;
      this.onChange = onChange || (() => {});
      // Called before a change the browser doesn't announce with beforeinput (formatting,
      // paste, scene breaks), so the page layout can take an undo snapshot first.
      this.beforeCommand = beforeCommand || (() => {});
      this.onSelection = onSelection || (() => {});
      this.prefs = prefs || {};
      this.loading = false;
      document.execCommand('defaultParagraphSeparator', false, 'p');
      document.execCommand('styleWithCSS', false, false);

      root.addEventListener('input', () => this.changed());
      root.addEventListener('beforeinput', (e) => this.beforeInput(e));
      root.addEventListener('keydown', (e) => this.keydown(e));
      root.addEventListener('paste', (e) => this.paste(e));
      root.addEventListener('drop', (e) => this.drop(e));
      root.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
      document.addEventListener('selectionchange', () => { if (this.hasFocus()) this.onSelection(this.state()); });
    }

    hasFocus() {
      const sel = window.getSelection();
      return sel.rangeCount > 0 && this.root.contains(sel.anchorNode);
    }

    changed() {
      if (this.loading) return;
      if (!this.root.firstChild) this.root.append(this.block('p'));
      this.markEmpty();
      this.onChange();
      if (this.prefs.typewriter) this.centerCaret();
    }

    // ---------- loading ----------
    load(doc) {
      this.loading = true;
      const frag = document.createDocumentFragment();
      for (const b of (doc && doc.blocks) || []) frag.append(this.renderBlock(b));
      if (!frag.childNodes.length) frag.append(this.block('p'));
      this.root.replaceChildren(frag);
      this.loading = false;
      this.markEmpty();
    }

    // Shows the "Begin here…" placeholder on an empty page, as Studio does.
    markEmpty() {
      const kids = this.root.children;
      this.root.classList.toggle('empty', !this.root.textContent.trim() && kids.length <= 1 && (!kids[0] || kids[0].tagName === 'P'));
    }

    block(type, id) {
      const el = document.createElement(TAG[type] || 'P');
      el.dataset.id = id || rid();
      if (type !== 'break') el.append(document.createElement('br'));
      return el;
    }

    renderBlock(b) {
      const el = document.createElement(TAG[b.t] || 'P');
      el.dataset.id = b.id || rid();
      if (b.t === 'break') return el;
      for (const r of b.r || []) {
        let node = document.createTextNode(r.x);
        const m = r.m || 0;
        if (m & 4) { const u = document.createElement('u'); u.append(node); node = u; }
        if (m & 2) { const i = document.createElement('i'); i.append(node); node = i; }
        if (m & 1) { const s = document.createElement('b'); s.append(node); node = s; }
        el.append(node);
      }
      if (!el.firstChild) el.append(document.createElement('br'));
      return el;
    }

    // ---------- reading back ----------
    serialize() {
      const blocks = [];
      const seen = new Set();
      const push = (type, el, runs) => {
        let id = el && el.dataset ? el.dataset.id : '';
        if (!id || seen.has(id) || !/^[A-Za-z0-9_-]{4,24}$/.test(id)) {
          id = rid();
          if (el && el.dataset) el.dataset.id = id;
        }
        seen.add(id);
        blocks.push({ id, t: type, r: type === 'break' ? [] : runs });
      };
      for (const node of [...this.root.childNodes]) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (node.data.trim()) push('p', null, [{ x: node.data }]);
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const type = TYPE_OF[node.tagName];
        if (type === 'break') { push('break', node); continue; }
        if (type && !node.querySelector('p,div,h1,h2,h3,h4,h5,h6,blockquote,li,hr')) {
          push(type, node, this.runs(node));
          continue;
        }
        // Anything unexpected (lists, nested blocks): keep its text as paragraphs.
        const parts = node.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,blockquote,li');
        if (!parts.length) { push(type || 'p', node, this.runs(node)); continue; }
        for (const part of parts) {
          if (part.querySelector('p,div,h1,h2,h3,h4,h5,h6,blockquote,li')) continue;
          push(TYPE_OF[part.tagName] || 'p', part, this.runs(part));
        }
      }
      if (!blocks.length) blocks.push({ id: rid(), t: 'p', r: [] });
      return { v: 1, blocks };
    }

    runs(el) {
      const out = [];
      const walk = (node, m) => {
        for (const c of node.childNodes) {
          if (c.nodeType === Node.TEXT_NODE) {
            const x = c.data.replace(/\n/g, ' ');
            if (!x) continue;
            const last = out[out.length - 1];
            if (last && (last.m || 0) === m) last.x += x;
            else out.push(m ? { x, m } : { x });
          } else if (c.nodeType === Node.ELEMENT_NODE && c.tagName !== 'BR') {
            let mm = m | (MARK[c.tagName] || 0);
            if (c.tagName === 'SPAN' && c.style) {
              if (/^(bold|[6-9]00)$/.test(c.style.fontWeight)) mm |= 1;
              if (c.style.fontStyle === 'italic') mm |= 2;
              if (/underline/.test(c.style.textDecoration)) mm |= 4;
            }
            walk(c, mm);
          }
        }
      };
      walk(el, 0);
      return out;
    }

    text() { return this.root.innerText || ''; }
    words() { return countWords(this.root.textContent || ''); }
    selectionWords() {
      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed || !this.hasFocus()) return 0;
      return countWords(sel.toString());
    }

    // ---------- commands ----------
    topBlock(node) {
      while (node && node.parentNode !== this.root) node = node.parentNode;
      return node && node.nodeType === Node.ELEMENT_NODE ? node : null;
    }

    selectedBlocks() {
      const sel = window.getSelection();
      if (!sel.rangeCount) return [];
      const r = sel.getRangeAt(0);
      const a = this.topBlock(r.startContainer === this.root ? this.root.childNodes[r.startOffset] || this.root.lastChild : r.startContainer);
      const b = this.topBlock(r.endContainer === this.root ? this.root.childNodes[Math.max(0, r.endOffset - 1)] || this.root.lastChild : r.endContainer);
      if (!a) return [];
      const out = [];
      for (let n = a; n; n = n.nextSibling) {
        if (n.nodeType === Node.ELEMENT_NODE) out.push(n);
        if (n === b) break;
      }
      return out;
    }

    setBlock(type) {
      const sel = window.getSelection();
      if (!this.hasFocus()) return;
      this.beforeCommand();
      const r = sel.getRangeAt(0);
      const saved = [r.startContainer, r.startOffset, r.endContainer, r.endOffset];
      const swapped = new Map();
      for (const el of this.selectedBlocks()) {
        if (el.tagName === 'HR' || el.tagName === TAG[type]) continue;
        const next = document.createElement(TAG[type]);
        next.dataset.id = el.dataset.id || rid();
        while (el.firstChild) next.append(el.firstChild);
        if (!next.firstChild) next.append(document.createElement('br'));
        el.replaceWith(next);
        swapped.set(el, next);
      }
      const fix = (n) => swapped.get(n) || n;
      try {
        const nr = document.createRange();
        nr.setStart(fix(saved[0]), saved[1]);
        nr.setEnd(fix(saved[2]), saved[3]);
        sel.removeAllRanges();
        sel.addRange(nr);
      } catch { /* selection could not be kept */ }
      this.changed();
      this.onSelection(this.state());
    }

    mark(cmd) {
      this.root.focus();
      this.beforeCommand();
      document.execCommand(cmd, false, null);
      this.onSelection(this.state());
    }

    history(cmd) {
      this.root.focus();
      document.execCommand(cmd, false, null);
    }

    insertBreak() {
      const sel = window.getSelection();
      if (!this.hasFocus()) { this.root.focus(); }
      this.beforeCommand();
      const blocks = this.selectedBlocks();
      const at = blocks[blocks.length - 1] || this.root.lastChild;
      const hr = this.block('break');
      const p = this.block('p');
      if (at) at.after(hr, p); else this.root.append(hr, p);
      const r = document.createRange();
      r.setStart(p, 0);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      this.changed();
      p.scrollIntoView({ block: 'nearest' });
    }

    state() {
      const blocks = this.selectedBlocks();
      const first = blocks[0];
      return {
        block: first ? TYPE_OF[first.tagName] || 'p' : 'p',
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        selectionWords: this.selectionWords(),
      };
    }

    // ---------- typing ----------
    keydown(e) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'Enter') { e.preventDefault(); this.insertBreak(); return; }
      if (mod && !e.shiftKey && !e.altKey && /^[0-4]$/.test(e.key)) {
        e.preventDefault();
        this.setBlock(['p', 'h1', 'h2', 'h3', 'quote'][Number(e.key)]);
        return;
      }
      if (e.key === 'Enter' && e.shiftKey) {
        // Soft line breaks aren't part of the book model; make a new paragraph instead.
        e.preventDefault();
        this.beforeCommand();
        document.execCommand('insertParagraph');
        return;
      }
      if (e.key === 'Enter' && !mod) {
        // At the end of a heading or quote, the next line is ordinary body text.
        const sel = window.getSelection();
        const blk = this.topBlock(sel.anchorNode);
        if (blk && /^(H2|H3|H4|BLOCKQUOTE)$/.test(blk.tagName) && sel.isCollapsed && this.atEnd(blk, sel.getRangeAt(0))) {
          e.preventDefault();
          this.beforeCommand();
          const p = this.block('p');
          blk.after(p);
          const r = document.createRange();
          r.setStart(p, 0);
          sel.removeAllRanges();
          sel.addRange(r);
          this.changed();
        }
      }
    }

    atEnd(block, range) {
      const r = document.createRange();
      r.selectNodeContents(block);
      r.setStart(range.endContainer, range.endOffset);
      return r.toString().length === 0;
    }

    // Smart punctuation, as in Studio: curly quotes as you type, -- to an em dash, ... to an ellipsis.
    beforeInput(e) {
      if (this.prefs.smartPunct === false || e.inputType !== 'insertText' || !e.data || e.data.length !== 1) return;
      const sel = window.getSelection();
      if (!sel.isCollapsed || !sel.rangeCount) return;
      const n = sel.anchorNode, o = sel.anchorOffset;
      const before = n.nodeType === 3 ? n.nodeValue.slice(Math.max(0, o - 2), o) : '';
      const prev = before.slice(-1);
      let out = null, back = 0;
      if (e.data === '"') out = !prev || /[\s([{—–“‘-]/.test(prev) ? '“' : '”';
      else if (e.data === "'") out = !prev || /[\s([{—–“-]/.test(prev) ? '‘' : '’';
      else if (e.data === '-' && prev === '-') { out = '—'; back = 1; }
      else if (e.data === '.' && before === '..') { out = '…'; back = 2; }
      if (!out) return;
      e.preventDefault();
      for (let i = 0; i < back; i++) document.execCommand('delete');
      document.execCommand('insertText', false, out);
    }

    paste(e) {
      e.preventDefault();
      const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      this.insertPlainText(text);
    }

    drop(e) {
      e.preventDefault();
      const text = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
      if (!text) return;
      const pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY)
        : (document.caretPositionFromPoint && (() => {
          const p = document.caretPositionFromPoint(e.clientX, e.clientY);
          if (!p) return null;
          const r = document.createRange();
          r.setStart(p.offsetNode, p.offset);
          return r;
        })());
      if (pos && this.root.contains(pos.startContainer)) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(pos);
      }
      this.insertPlainText(text);
    }

    // Pasted or dropped text always arrives as plain paragraphs.
    insertPlainText(raw) {
      const text = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩﻿]/g, '');
      if (!text) return;
      this.beforeCommand();
      const lines = text.split(/\n+/);
      if (lines.length === 1) { document.execCommand('insertText', false, lines[0]); return; }
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      if (!sel.isCollapsed) document.execCommand('delete');
      const range = sel.getRangeAt(0);
      let block = this.topBlock(range.startContainer);
      if (!block || block.tagName === 'HR') {
        block = this.block('p');
        if (range.startContainer === this.root) this.root.insertBefore(block, this.root.childNodes[range.startOffset] || null);
        else this.root.append(block);
        range.setStart(block, 0);
        range.collapse(true);
      }
      const tail = document.createRange();
      tail.setStart(range.startContainer, range.startOffset);
      tail.setEnd(block, block.childNodes.length);
      const rest = tail.extractContents();
      block.querySelectorAll('br').forEach((br) => br.remove());
      if (lines[0]) block.append(document.createTextNode(lines[0]));
      if (!block.firstChild) block.append(document.createElement('br'));
      let after = block;
      for (const line of lines.slice(1, -1)) {
        const p = this.block('p');
        p.replaceChildren(document.createTextNode(line));
        after.after(p);
        after = p;
      }
      const last = this.block('p');
      last.replaceChildren();
      const lastText = document.createTextNode(lines[lines.length - 1]);
      last.append(lastText, rest);
      last.querySelectorAll('br').forEach((br) => br.remove());
      if (!last.textContent) last.append(document.createElement('br'));
      after.after(last);
      const r = document.createRange();
      r.setStart(lastText, lastText.length);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      this.changed();
      this.scrollToCaret();
    }

    scrollToCaret() {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    }

    centerCaret() {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (!rect.top && !rect.bottom)) return;
      const scroller = this.root.closest('.scroller');
      if (!scroller) return;
      const box = scroller.getBoundingClientRect();
      const target = box.top + box.height * 0.45;
      const delta = rect.top - target;
      if (Math.abs(delta) > 4) scroller.scrollBy({ top: delta, behavior: 'smooth' });
    }

    focusStart() {
      this.root.focus();
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(this.root.firstChild || this.root, 0);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  // Builds read-only DOM for a document (history previews, printing).
  function renderStatic(doc, into) {
    const ed = Object.create(Editor.prototype);
    for (const b of (doc && doc.blocks) || []) into.append(ed.renderBlock(b));
  }

  return { Editor, renderStatic, countWords };
})();
