// Lekhira Writes: the chapter document model.
// A chapter is stored as structured blocks, never as HTML:
//   { v: 1, blocks: [ { id, t, r: [ { x: "text", m: marks } ] } ] }
// t is the block style and m is a bitmask (1 bold, 2 italic, 4 underline). The browser
// builds the page from this with text nodes only, so stored writing can never carry markup
// or script. Stable block ids are there for future sync and merging.
'use strict';
const crypto = require('node:crypto');
const { HttpError } = require('./security');

const DOC_VERSION = 1;
// Same styles as Lekhira Studio: Body text, Heading, Subheading, Subtitle, Quote, scene break.
const BLOCK_TYPES = new Set(['p', 'h1', 'h2', 'h3', 'quote', 'break']);
const MAX_BLOCKS = 20000;
const MAX_CHARS = 1_500_000;
const MAX_RUNS = 400;
const BLOCK_ID = /^[A-Za-z0-9_-]{4,24}$/;
// Control characters other than tab, and the bidi overrides that can disguise text.
const STRIP = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩﻿]/g;

function blockId() { return crypto.randomBytes(6).toString('base64url'); }

function emptyDoc() { return { v: DOC_VERSION, blocks: [{ id: blockId(), t: 'p', r: [] }] }; }

function docFromParagraphs(paras) {
  const blocks = paras.map((text) => ({ id: blockId(), t: 'p', r: text ? [{ x: text }] : [] }));
  return { v: DOC_VERSION, blocks: blocks.length ? blocks : emptyDoc().blocks };
}

// Checks and normalises a document sent by the browser. Returns { doc, words, chars }.
function cleanDoc(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.blocks)) throw new HttpError(400, 'The chapter could not be read.');
  if (input.blocks.length > MAX_BLOCKS) throw new HttpError(413, 'This chapter is very long. Please split it into two chapters.');
  const seen = new Set();
  const blocks = [];
  let chars = 0;
  for (const b of input.blocks) {
    if (!b || typeof b !== 'object') throw new HttpError(400, 'The chapter could not be read.');
    const t = BLOCK_TYPES.has(b.t) ? b.t : 'p';
    let id = typeof b.id === 'string' && BLOCK_ID.test(b.id) && !seen.has(b.id) ? b.id : blockId();
    while (seen.has(id)) id = blockId();
    seen.add(id);
    const runs = [];
    if (t !== 'break') {
      const rs = Array.isArray(b.r) ? b.r : [];
      if (rs.length > MAX_RUNS) throw new HttpError(400, 'A paragraph has too much formatting to save.');
      for (const run of rs) {
        if (!run || typeof run.x !== 'string') continue;
        const x = run.x.replace(/\r\n?|\n/g, ' ').replace(STRIP, '');
        if (!x) continue;
        const m = Number.isInteger(run.m) ? run.m & 7 : 0;
        const prev = runs[runs.length - 1];
        if (prev && (prev.m || 0) === m) prev.x += x;
        else runs.push(m ? { x, m } : { x });
        chars += x.length;
      }
    }
    if (chars > MAX_CHARS) throw new HttpError(413, 'This chapter is very long. Please split it into two chapters.');
    blocks.push({ id, t, r: runs });
  }
  if (!blocks.length) blocks.push({ id: blockId(), t: 'p', r: [] });
  const doc = { v: DOC_VERSION, blocks };
  return { doc, words: countWords(doc), chars };
}

function blockText(b) { return b.r.map((r) => r.x).join(''); }

function countWords(doc) {
  let n = 0;
  for (const b of doc.blocks) {
    const m = blockText(b).match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
    if (m) n += m.length;
  }
  return n;
}

// ---------- plain exports ----------
function runToMarkdown(r) {
  const esc = r.x.replace(/([\\`*_[\]#<>])/g, '\\$1');
  const m = r.m || 0;
  if (!m || !esc.trim()) return esc;
  const lead = esc.match(/^\s*/)[0];
  const trail = esc.match(/\s*$/)[0];
  let core = esc.trim();
  if (m & 2) core = `*${core}*`;
  if (m & 1) core = `**${core}**`;
  if (m & 4) core = `<u>${core}</u>`;
  return lead + core + trail;
}

function chapterToMarkdown(title, doc) {
  const out = [`# ${title.replace(/\n/g, ' ')}`, ''];
  for (const b of doc.blocks) {
    const text = b.r.map(runToMarkdown).join('');
    if (b.t === 'break') out.push('* * *');
    else if (b.t === 'h1') out.push(`## ${text}`);
    else if (b.t === 'h2') out.push(`### ${text}`);
    else if (b.t === 'h3') out.push(text.trim() ? `*${runToMarkdown({ x: blockText(b) })}*` : '');
    else if (b.t === 'quote') out.push(`> ${text}`);
    else out.push(text);
    out.push('');
  }
  return out.join('\n');
}

function chapterToText(title, doc) {
  const out = [title.toUpperCase(), ''];
  for (const b of doc.blocks) {
    out.push(b.t === 'break' ? '                *' : blockText(b));
    out.push('');
  }
  return out.join('\n');
}

module.exports = { cleanDoc, emptyDoc, docFromParagraphs, countWords, chapterToMarkdown, chapterToText, blockText, DOC_VERSION };
