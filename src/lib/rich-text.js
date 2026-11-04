// Formatted contract text: a small, fixed subset of HTML.
//
// A template or contract whose words are formatted carries RICH at the start
// of its formatted part. Everything before it (the plain EMPLOYEE PARTICULARS
// block, where there is one) stays plain text, and every place that copies,
// hashes or signs the words carries the formatting along without knowing it
// is there: the formatting is part of what is signed, like the words.
//
// What is allowed, and nothing else, so the same text renders the same on a
// phone, in print and in the signed PDF:
//   blocks  p, h1, h2, h3, ul, ol, li, hr (a page break), br
//   inline  strong, em, u, span
//   style   text-align, margin-left (em), color (#hex), font-family (one of
//           three), font-size (pt), font-weight, font-style, text-decoration
// Fields stay as {{key}} in the text and are filled when the contract is
// issued, with the value escaped.

export const RICH = '<!--rich-->';

export const FONTS = {
  serif: { css: "'Times New Roman', Tinos, Times, serif", label: 'Times' },
  sans: { css: 'Arial, Arimo, Helvetica, sans-serif', label: 'Arial' },
  mono: { css: "'Courier New', Cousine, Courier, monospace", label: 'Courier' },
};

export const isRich = (s) => String(s ?? '').includes(RICH);

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li']);
const INLINE = new Set(['strong', 'em', 'u', 'span']);
const RENAME = { b: 'strong', i: 'em', div: 'p', blockquote: 'p', h4: 'h3', h5: 'h3', h6: 'h3', font: 'span', ins: 'u' };

/** A hex colour from whatever the browser wrote, or null. */
export function cleanColor(v) {
  const s = String(v ?? '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return `#${m[1].split('').map((c) => c + c).join('')}`;
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return `#${m[1]}`;
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
  return null;
}

/** Which of the three fonts a font-family names. */
export function fontKey(v) {
  const s = String(v ?? '').toLowerCase();
  if (/courier|cousine|mono/.test(s)) return 'mono';
  if (/arial|arimo|helvetica|sans|inter|verdana|calibri/.test(s)) return 'sans';
  if (/times|tinos|serif|georgia|garamond|cambria/.test(s)) return 'serif';
  return null;
}

/** A size in points, from pt, px, or the legacy 1–7 a browser can produce. */
export function sizePt(v) {
  const s = String(v ?? '').trim().toLowerCase();
  const legacy = { 'x-small': 8, small: 10, medium: 11, large: 14, 'x-large': 18, 'xx-large': 24 };
  if (legacy[s]) return legacy[s];
  let m = /^([\d.]+)pt$/.exec(s);
  let pt = m ? Number(m[1]) : null;
  m = /^([\d.]+)px$/.exec(s);
  if (m) pt = Number(m[1]) * 0.75;
  if (pt == null || !Number.isFinite(pt)) return null;
  return Math.min(36, Math.max(7, Math.round(pt * 2) / 2));
}

function cleanStyle(raw, tag) {
  const out = [];
  for (const decl of String(raw ?? '').split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const val = decl.slice(at + 1).trim().replace(/!important/i, '').trim();
    if (prop === 'text-align' && BLOCKS.has(tag) && /^(left|center|right|justify)$/i.test(val)) out.push(`text-align: ${val.toLowerCase()}`);
    else if (prop === 'margin-left' && BLOCKS.has(tag)) {
      const m = /^([\d.]+)(em|px|pt)?$/.exec(val);
      if (m) {
        const em = m[2] === 'px' ? Number(m[1]) / 16 : m[2] === 'pt' ? Number(m[1]) / 12 : Number(m[1]);
        if (em > 0) out.push(`margin-left: ${Math.min(8, Math.round(em * 2) / 2)}em`);
      }
    } else if (prop === 'color') { const c = cleanColor(val); if (c) out.push(`color: ${c}`); }
    else if (prop === 'font-family') { const k = fontKey(val); if (k) out.push(`font-family: ${FONTS[k].css}`); }
    else if (prop === 'font-size') { const pt = sizePt(val); if (pt) out.push(`font-size: ${pt}pt`); }
    else if (prop === 'font-weight' && tag === 'span') { if (/^(bold|[6-9]00)$/.test(val)) out.push('font-weight: bold'); }
    else if (prop === 'font-style' && tag === 'span') { if (/^italic$/.test(val)) out.push('font-style: italic'); }
    else if ((prop === 'text-decoration' || prop === 'text-decoration-line') && tag === 'span') { if (/underline/.test(val)) out.push('text-decoration: underline'); }
  }
  return out.join('; ');
}

function attrsOf(raw) {
  const out = {};
  for (const m of String(raw ?? '').matchAll(/([a-zA-Z-:]+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
    const v = m[2] ?? '';
    out[m[1].toLowerCase()] = decodeEntities(v.replace(/^["']|["']$/g, ''));
  }
  return out;
}

/**
 * Make formatted text safe and canonical. Takes the HTML after the RICH mark
 * (or with it) and returns RICH + the clean HTML. Anything not allowed is
 * dropped and its text kept; text is escaped; every open tag is closed.
 */
export function sanitizeRich(input) {
  const src = String(input ?? '').replace(RICH, '');
  const out = [];
  const stack = [];
  let skip = 0; // inside <script>, <style> and the like
  const open = (tag, style = '') => { out.push(style ? `<${tag} style="${escapeHtml(style)}">` : `<${tag}>`); stack.push(tag); };
  const close = (tag) => {
    const at = stack.lastIndexOf(tag);
    if (at < 0) return;
    while (stack.length > at) out.push(`</${stack.pop()}>`);
  };
  const inBlock = () => stack.some((t) => BLOCKS.has(t) && t !== 'ul' && t !== 'ol');
  for (const m of src.matchAll(/<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g)) {
    const token = m[0];
    if (token.startsWith('<!--')) continue;
    const name = m[1]?.toLowerCase();
    if (!name) {
      if (skip) continue;
      const text = decodeEntities(token === '<' ? '<' : token);
      if (!text) continue;
      // Text straight under the root, or a list, goes in a paragraph.
      if (!inBlock() && !text.trim()) continue;
      if (!inBlock()) open('p');
      out.push(escapeHtml(text).replace(/ /g, '&nbsp;'));
      continue;
    }
    const closing = token[1] === '/';
    if (['script', 'style', 'head', 'title', 'template', 'iframe', 'object', 'svg', 'math', 'xml'].includes(name)) {
      if (closing) skip = Math.max(0, skip - 1); else if (!/\/>$/.test(token)) skip += 1;
      continue;
    }
    if (skip) continue;
    const tag = RENAME[name] ?? name;
    if (tag === 'br') { if (!inBlock()) open('p'); out.push('<br>'); continue; }
    if (tag === 'hr') {
      while (stack.length) out.push(`</${stack.pop()}>`);
      out.push('<hr class="page-break">');
      continue;
    }
    if (!BLOCKS.has(tag) && !INLINE.has(tag)) continue;
    if (closing) { close(tag); continue; }
    const a = attrsOf(m[2]);
    let style = a.style ?? '';
    if (name === 'font') {
      if (a.color) style += `;color:${a.color}`;
      if (a.face) style += `;font-family:${a.face}`;
      if (a.size) style += `;font-size:${({ 1: '8pt', 2: '10pt', 3: '11pt', 4: '14pt', 5: '18pt', 6: '24pt', 7: '32pt' })[a.size] ?? ''}`;
    }
    if (a.align && BLOCKS.has(tag)) style += `;text-align:${a.align}`;
    const clean = cleanStyle(style, tag);
    if (BLOCKS.has(tag)) {
      if (tag === 'li') {
        // A list item belongs in a list; one that is not gets one.
        if (!stack.includes('ul') && !stack.includes('ol')) open('ul');
        const listAt = Math.max(stack.lastIndexOf('ul'), stack.lastIndexOf('ol'));
        while (stack.length > listAt + 1) out.push(`</${stack.pop()}>`);
      } else if (tag === 'ul' || tag === 'ol') {
        while (stack.length && !['li'].includes(stack[stack.length - 1])) out.push(`</${stack.pop()}>`);
      } else {
        // A paragraph or heading never sits inside another; close back out.
        while (stack.length && stack[stack.length - 1] !== 'li') out.push(`</${stack.pop()}>`);
      }
      open(tag, clean);
    } else {
      if (!inBlock()) open('p');
      if (tag === 'span' && !clean) { stack.push('span'); out.push('<span>'); continue; }
      open(tag, clean);
    }
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  const html = out.join('').replace(/<span>([\s\S]*?)<\/span>/g, '$1').replace(/<(p|h1|h2|h3|li)( style="[^"]*")?><\/\1>/g, '<$1$2><br></$1>');
  return RICH + html;
}

// ---------------------------------------------------------------------------
// From today's plain text, once
// ---------------------------------------------------------------------------

const CLAUSE = /^\s*(\d+(\.\d+)*\.?|\([a-z]{1,4}\)|[a-z]\)|[A-Z]\.\d+|[-•*])\s/;
const RULE_LINE = /^[._\s\-─—]{4,}$/;
const CAPS = /^[A-Z0-9 ,.'"&()\-—–:/]{3,}$/;
const standsAlone = (line) => CAPS.test(line) || /:$/.test(line) || RULE_LINE.test(line);

function flow(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((para) => {
    const out = [];
    let lastLen = 0;
    for (const raw of para.split('\n')) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;
      const before = out.length ? out[out.length - 1] : null;
      // A line carries on the one before only where that one was a full,
      // hard-wrapped line; short lines (signature blocks, exhibit entries)
      // stand on their own.
      const carries = before && lastLen >= 55 && !CLAUSE.test(raw) && !standsAlone(before.last)
        && !RULE_LINE.test(line.trim());
      if (carries) {
        before.text = `${before.text} ${line.trim()}`;
        before.last = line.trim();
      } else {
        const sub = /^\s*\([a-z]{1,4}\)\s/.test(raw);
        const lone = /^\s{2,}/.test(raw) && !CLAUSE.test(raw);
        out.push({ text: line.trim(), last: line.trim(), indent: sub || lone ? 2 : 0 });
      }
      lastLen = line.length;
    }
    return out;
  }).filter((p) => p.length);
}

const LEADS = /^(WHEREAS,|NOW, THEREFORE,|IN WITNESS WHEREOF,|IT IS AGREED|BETWEEN|AND)(?=\s|$)/;

/** Today's plain words, laid out: title, headings, clauses, the leading words bold. */
export function plainToRich(text) {
  const out = [];
  let first = true;
  for (const para of flow(text)) {
    for (const line of para) {
      const t = line.text;
      const esc = escapeHtml(t);
      const indent = line.indent ? `margin-left: ${line.indent}em` : '';
      if (RULE_LINE.test(t) && /[─—_-]{8,}/.test(t) && !/\.{8,}/.test(t)) { out.push('<p><br></p>'); continue; }
      if (CAPS.test(t) && !/^\d+\.\d/.test(t) && t.replace(/[^A-Z]/g, '').length >= 2) {
        if (first) out.push(`<h1 style="text-align: center">${esc}</h1>`);
        else if (/^(BETWEEN|AND)$/.test(t)) out.push(`<p style="text-align: center"><strong>${esc}</strong></p>`);
        else out.push(`<h2>${esc}</h2>`);
      } else {
        const m = LEADS.exec(t);
        const body = m ? `<strong>${escapeHtml(m[1])}</strong>${escapeHtml(t.slice(m[1].length))}` : esc;
        out.push(indent ? `<p style="${indent}">${body}</p>` : `<p>${body}</p>`);
      }
      first = false;
    }
  }
  return sanitizeRich(out.join(''));
}

// ---------------------------------------------------------------------------
// Reading it back: plain text, and blocks for drawing
// ---------------------------------------------------------------------------

/**
 * The formatted part as blocks of styled runs, for drawing on a page. Expects
 * sanitized input (sanitizeRich's output), so it only has to follow the tags
 * that function writes.
 */
export function richBlocks(input) {
  const src = sanitizeRich(input).slice(RICH.length);
  const blocks = [];
  const style = [{}];
  let block = null;
  const lists = [];
  const start = (tag, st) => {
    const align = /text-align: (\w+)/.exec(st)?.[1] ?? null;
    const indent = Number(/margin-left: ([\d.]+)em/.exec(st)?.[1] ?? 0);
    block = { tag, align, indent: indent + (tag === 'li' ? lists.length * 1.5 : 0), runs: [], marker: null };
    if (tag === 'li' && lists.length) {
      const list = lists[lists.length - 1];
      list.n += 1;
      block.marker = list.tag === 'ol' ? `${list.n}.` : '•';
    }
    blocks.push(block);
  };
  for (const m of src.matchAll(/<(\/?)([a-z0-9]+)(?: style="([^"]*)")?(?: class="[^"]*")?>|[^<]+/g)) {
    if (!m[2]) {
      if (!block) start('p', '');
      block.runs.push({ text: decodeEntities(m[0]), ...style[style.length - 1] });
      continue;
    }
    const [, slash, tag, st = ''] = m;
    const s = decodeEntities(st);
    if (tag === 'hr') { blocks.push({ tag: 'hr', pageBreak: true, runs: [] }); block = null; continue; }
    if (tag === 'br') { if (!block) start('p', ''); block.runs.push({ text: '\n', ...style[style.length - 1] }); continue; }
    if (tag === 'ul' || tag === 'ol') { if (slash) lists.pop(); else lists.push({ tag, n: 0 }); continue; }
    if (['p', 'h1', 'h2', 'h3', 'li'].includes(tag)) {
      if (slash) { block = null; style.length = 1; continue; }
      start(tag, s);
      const base = { ...style[0] };
      if (tag !== 'p' && tag !== 'li') base.bold = true;
      Object.assign(base, inlineStyle(s));
      style.length = 1;
      style.push(base);
      continue;
    }
    if (slash) { if (style.length > 1) style.pop(); continue; }
    const now = { ...style[style.length - 1] };
    if (tag === 'strong') now.bold = true;
    if (tag === 'em') now.italic = true;
    if (tag === 'u') now.underline = true;
    Object.assign(now, inlineStyle(s));
    style.push(now);
  }
  return blocks;
}

function inlineStyle(s) {
  const out = {};
  const c = /color: (#[0-9a-f]{6})/.exec(s);
  if (c) out.color = c[1];
  const f = /font-family: ([^;]+)/.exec(s);
  if (f) out.font = fontKey(f[1]);
  const z = /font-size: ([\d.]+)pt/.exec(s);
  if (z) out.size = Number(z[1]);
  if (/font-weight: bold/.test(s)) out.bold = true;
  if (/font-style: italic/.test(s)) out.italic = true;
  if (/text-decoration: underline/.test(s)) out.underline = true;
  return out;
}

/** The words without the formatting: for searching, emails and counting. */
export function richToPlain(input) {
  if (!isRich(input)) return String(input ?? '');
  const at = String(input).indexOf(RICH);
  const before = String(input).slice(0, at);
  return before + richBlocks(String(input).slice(at)).map((b) => {
    if (b.pageBreak) return '';
    const text = b.runs.map((r) => r.text).join('');
    return `${b.marker ? `${b.marker} ` : ''}${b.indent ? '    ' : ''}${text}`;
  }).join('\n\n');
}
