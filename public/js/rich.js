import { h, toast } from './util.js';

/**
 * Formatted contract text in the browser: showing it, and editing it.
 *
 * The same small set of tags as the server's src/lib/rich-text.js, which
 * cleans everything again when a template is saved. This side cleans too,
 * before anything is put on a page, so a contract can never carry a script
 * whatever happened to it on the way.
 */

export const RICH = '<!--rich-->';
export const isRich = (s) => String(s ?? '').includes(RICH);

const FONTS = {
  serif: "'Times New Roman', Tinos, Times, serif",
  sans: 'Arial, Arimo, Helvetica, sans-serif',
  mono: "'Courier New', Cousine, Courier, monospace",
};
const fontKey = (v) => {
  const s = String(v ?? '').toLowerCase();
  if (/courier|cousine|mono/.test(s)) return 'mono';
  if (/arial|arimo|helvetica|sans|inter|verdana|calibri/.test(s)) return 'sans';
  if (/times|tinos|serif|georgia|garamond|cambria/.test(s)) return 'serif';
  return null;
};
const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI']);
const INLINE = new Set(['STRONG', 'EM', 'U', 'SPAN']);
const RENAME = { B: 'STRONG', I: 'EM', DIV: 'P', BLOCKQUOTE: 'P', H4: 'H3', H5: 'H3', H6: 'H3', FONT: 'SPAN', INS: 'U' };
const DROP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'FORM', 'META', 'LINK']);

/** A hex colour from whatever the browser wrote, or null. */
export function cleanColor(v) {
  const s = String(v ?? '').trim().toLowerCase();
  let m = /^#?([0-9a-f]{3})$/.exec(s);
  if (m) return `#${m[1].split('').map((c) => c + c).join('')}`;
  m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) return `#${m[1]}`;
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
  return null;
}

function sizePt(v) {
  const s = String(v ?? '').trim().toLowerCase();
  const named = { 'x-small': 8, small: 10, medium: 11, large: 14, 'x-large': 18, 'xx-large': 24 };
  if (named[s]) return named[s];
  let m = /^([\d.]+)pt$/.exec(s);
  let pt = m ? Number(m[1]) : null;
  m = /^([\d.]+)px$/.exec(s);
  if (m) pt = Number(m[1]) * 0.75;
  if (pt == null || !Number.isFinite(pt)) return null;
  return Math.min(36, Math.max(7, Math.round(pt * 2) / 2));
}

/** The allowed styles of one element, as a style string. */
function styleOf(el, tag) {
  const st = el.style;
  const out = [];
  if (BLOCKS.has(tag)) {
    const a = (st.textAlign || el.getAttribute('align') || '').toLowerCase();
    if (/^(left|center|right|justify)$/.test(a)) out.push(`text-align: ${a}`);
    const ml = /^([\d.]+)(em|px|pt)$/.exec(st.marginLeft || '');
    if (ml) {
      const em = ml[2] === 'px' ? Number(ml[1]) / 16 : ml[2] === 'pt' ? Number(ml[1]) / 12 : Number(ml[1]);
      if (em > 0) out.push(`margin-left: ${Math.min(8, Math.round(em * 2) / 2)}em`);
    }
  }
  const color = cleanColor(st.color || el.getAttribute('color'));
  if (color) out.push(`color: ${color}`);
  const face = fontKey(st.fontFamily || el.getAttribute('face'));
  if (face) out.push(`font-family: ${FONTS[face]}`);
  const legacy = { 1: '8pt', 2: '10pt', 3: '11pt', 4: '14pt', 5: '18pt', 6: '24pt', 7: '32pt' }[el.getAttribute('size')];
  const pt = sizePt(st.fontSize || legacy);
  if (pt) out.push(`font-size: ${pt}pt`);
  if (tag === 'SPAN') {
    if (/^(bold|[6-9]00)$/.test(st.fontWeight)) out.push('font-weight: bold');
    if (st.fontStyle === 'italic') out.push('font-style: italic');
    if (/underline/.test(st.textDecoration || st.textDecorationLine || '')) out.push('text-decoration: underline');
  }
  return out.join('; ');
}

/**
 * Clean HTML into a fragment of allowed elements only. Fields in the editor
 * (span.rt-field) are kept as their {{key}} text.
 */
export function cleanFragment(html) {
  const doc = new DOMParser().parseFromString(`<body>${String(html ?? '').replace(RICH, '')}</body>`, 'text/html');
  const out = document.createDocumentFragment();
  const walk = (from, into) => {
    for (const node of [...from.childNodes]) {
      if (node.nodeType === 3) { into.append(node.data); continue; }
      if (node.nodeType !== 1) continue;
      if (node.classList?.contains('rt-field') && node.dataset.field) { into.append(`{{${node.dataset.field}}}`); continue; }
      const raw = node.tagName;
      if (DROP.has(raw)) continue;
      const tag = RENAME[raw] ?? raw;
      if (tag === 'BR') { into.append(document.createElement('br')); continue; }
      if (tag === 'HR') { const hr = document.createElement('hr'); hr.className = 'page-break'; into.append(hr); continue; }
      if (!BLOCKS.has(tag) && !INLINE.has(tag)) { walk(node, into); continue; }
      const el = document.createElement(tag);
      const style = styleOf(node, tag);
      if (style) el.setAttribute('style', style);
      walk(node, el);
      if (tag === 'SPAN' && !style) { while (el.firstChild) into.append(el.firstChild); continue; }
      into.append(el);
    }
  };
  walk(doc.body, out);
  return out;
}

const cleanHtml = (html) => { const box = document.createElement('div'); box.append(cleanFragment(html)); return box.innerHTML; };

/** Formatted words for reading. */
export function richView(html, { className = '' } = {}) {
  const el = h(`div.rt-doc${className ? `.${className}` : ''}`);
  el.append(cleanFragment(html));
  return el;
}

/** Plain text laid out as paragraphs, for a template that starts from plain words. */
export function plainAsHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).filter((p) => p.trim())
    .map((p) => `<p>${p.split('\n').map((l) => esc(l.trim())).join(' ')}</p>`).join('');
}

const SWATCHES = [['#10131a', 'Black'], ['#1e3a8a', 'Navy'], ['#9f1239', 'Deep red'], ['#4b5563', 'Grey'], ['#166534', 'Green']];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24];

/**
 * The editor: a toolbar and the page, edited in place. `placeholders` are the
 * fields that can be inserted ({ key, label, ask }). Returns the element and
 * `read()`, which gives the formatted words to save.
 */
export function richEditor({ html = '', placeholders = [] }) {
  const labelOf = new Map(placeholders.map((p) => [p.key, p.label]));
  const page = h('div.rt-doc.rt-page', { contenteditable: 'true', spellcheck: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'The words' });

  // Fields shown as labels that cannot be typed into.
  const chip = (key) => h('span.rt-field', { contenteditable: 'false', 'data-field': key, title: `{{${key}}}` }, labelOf.get(key) || key);
  const chipify = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) if (/\{\{\s*[a-z_]+\s*\}\}/i.test(walker.currentNode.data)) texts.push(walker.currentNode);
    for (const t of texts) {
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of t.data.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)) {
        frag.append(t.data.slice(last, m.index), chip(m[1].toLowerCase()));
        last = m.index + m[0].length;
      }
      frag.append(t.data.slice(last));
      t.replaceWith(frag);
    }
  };
  page.append(cleanFragment(isRich(html) ? html : plainAsHtml(html)));
  if (!page.firstChild) page.append(h('p', h('br')));
  chipify(page);

  // The selection, kept while a menu or box on the toolbar has the focus.
  let saved = null;
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (sel?.rangeCount && page.contains(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange();
  });
  const restore = () => {
    page.focus({ preventScroll: true });
    if (saved) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(saved); }
  };
  const run = (cmd, value = null) => {
    restore();
    try { document.execCommand('styleWithCSS', false, true); } catch { /* older browsers */ }
    document.execCommand(cmd, false, value);
    page.dispatchEvent(new Event('input'));
  };
  // Size: the browser only knows 1–7, so mark with 7 and replace with points.
  const setSize = (pt) => {
    run('fontSize', '7');
    for (const el of page.querySelectorAll('font[size="7"], span[style*="xxx-large"], span[style*="-webkit-xxx-large"]')) {
      const span = document.createElement('span');
      span.style.fontSize = `${pt}pt`;
      for (const k of ['color', 'fontFamily']) if (el.style?.[k]) span.style[k] = el.style[k];
      while (el.firstChild) span.append(el.firstChild);
      el.replaceWith(span);
    }
  };
  const blockAt = () => {
    restore();
    let n = window.getSelection()?.anchorNode;
    while (n && n !== page && !(n.nodeType === 1 && /^(P|H1|H2|H3|LI)$/.test(n.tagName))) n = n.parentNode;
    return n && n !== page ? n : null;
  };
  const indent = (by) => {
    const b = blockAt();
    if (!b) return;
    const now = parseFloat(b.style.marginLeft) || 0;
    const next = Math.max(0, Math.min(8, now + by));
    b.style.marginLeft = next ? `${next}em` : '';
  };
  const insertNode = (node) => {
    restore();
    const sel = window.getSelection();
    if (!sel.rangeCount) { page.append(node); return; }
    const r = sel.getRangeAt(0);
    r.deleteContents();
    r.insertNode(node);
    r.setStartAfter(node);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    saved = r.cloneRange();
  };

  // Pasted from Word or a web page: kept to what a contract can carry.
  page.addEventListener('paste', (e) => {
    const html = e.clipboardData?.getData('text/html');
    const text = e.clipboardData?.getData('text/plain');
    if (!html && !text) return;
    e.preventDefault();
    const clean = html ? cleanHtml(html.replace(/<!--\[if[\s\S]*?endif\]-->/g, '')) : plainAsHtml(text);
    const box = document.createElement('div');
    box.innerHTML = clean;
    chipify(box);
    document.execCommand('insertHTML', false, box.innerHTML);
  });

  const press = (label, title, fn, extra = {}) => h('button.rt-btn', {
    type: 'button', title, 'aria-label': title, ...extra,
    onmousedown: (e) => e.preventDefault(),
    onclick: fn,
  }, label);
  const icon = (d) => h('span', { innerHTML: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="${d}"/></svg>` });

  const styleSel = h('select.rt-sel', {
    'aria-label': 'Paragraph style',
    onchange: (e) => { run('formatBlock', `<${e.target.value}>`); e.target.value = ''; },
  }, h('option', { value: '' }, 'Style'), h('option', { value: 'p' }, 'Normal'), h('option', { value: 'h1' }, 'Title'),
  h('option', { value: 'h2' }, 'Heading'), h('option', { value: 'h3' }, 'Subheading'));
  const fontSel = h('select.rt-sel', {
    'aria-label': 'Font',
    onchange: (e) => { if (e.target.value) run('fontName', e.target.value); e.target.value = ''; },
  }, h('option', { value: '' }, 'Font'), h('option', { value: 'Times New Roman' }, 'Times'),
  h('option', { value: 'Arial' }, 'Arial'), h('option', { value: 'Courier New' }, 'Courier'));
  const sizeSel = h('select.rt-sel', {
    'aria-label': 'Size',
    onchange: (e) => { if (e.target.value) setSize(Number(e.target.value)); e.target.value = ''; },
  }, h('option', { value: '' }, 'Size'), SIZES.map((s) => h('option', { value: s }, `${s} pt`)));

  // Colour: the house swatches, a picker, and any code typed in.
  const hex = h('input.rt-hex', {
    type: 'text', maxlength: 7, placeholder: '#1E3A8A', 'aria-label': 'Colour code', spellcheck: 'false',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); applyHex(); } },
  });
  const picker = h('input.rt-pick', {
    type: 'color', value: '#1e3a8a', 'aria-label': 'Pick a colour',
    onchange: (e) => { hex.value = e.target.value.toUpperCase(); run('foreColor', e.target.value); },
  });
  const applyHex = () => {
    const c = cleanColor(hex.value);
    if (!c) { toast('A colour code is # and six letters or numbers, like #1E3A8A.', 'bad'); return; }
    hex.value = c.toUpperCase();
    picker.value = c;
    run('foreColor', c);
  };

  const fieldsMenu = h('div.rt-menu', { hidden: true },
    placeholders.map((p) => h('button.rt-menu-item', {
      type: 'button',
      onmousedown: (e) => e.preventDefault(),
      onclick: () => { fieldsMenu.hidden = true; insertNode(chip(p.key)); insertNode(document.createTextNode(' ')); },
    }, h('span', p.label), h('small', p.ask ? 'typed in when issued' : 'from their record'))));

  const toolbar = h('div.rt-toolbar', { role: 'toolbar', 'aria-label': 'Formatting' },
    styleSel, fontSel, sizeSel,
    h('span.rt-sep'),
    press(h('b', 'B'), 'Bold', () => run('bold')),
    press(h('i', { style: { fontFamily: 'Georgia, serif' } }, 'I'), 'Italic', () => run('italic')),
    press(h('u', 'U'), 'Underline', () => run('underline')),
    h('span.rt-sep'),
    SWATCHES.map(([c, name]) => press(h('span.rt-swatch', { style: { background: c } }), `${name} text`, () => { hex.value = c.toUpperCase(); picker.value = c; run('foreColor', c); })),
    picker, hex,
    press('Apply', 'Use this colour code', applyHex, { class: 'rt-btn rt-apply' }),
    h('span.rt-sep'),
    press(icon('M4 6h16M4 12h10M4 18h14'), 'Align left', () => run('justifyLeft')),
    press(icon('M4 6h16M7 12h10M5 18h14'), 'Centre', () => run('justifyCenter')),
    press(icon('M4 6h16M10 12h10M6 18h14'), 'Align right', () => run('justifyRight')),
    press(icon('M4 6h16M4 12h16M4 18h16'), 'Justify', () => run('justifyFull')),
    h('span.rt-sep'),
    press(icon('M10 6h10M10 12h10M10 18h10M4 5h1v3M4 11h2l-2 3h2M4 17h2v3H4'), 'Numbered list', () => run('insertOrderedList')),
    press(icon('M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01'), 'Bulleted list', () => run('insertUnorderedList')),
    press(icon('M4 6h16M10 12h10M10 18h10M4 10l3 2-3 2'), 'Indent', () => indent(2)),
    press(icon('M4 6h16M10 12h10M10 18h10M7 10l-3 2 3 2'), 'Outdent', () => indent(-2)),
    h('span.rt-sep'),
    h('span.rt-field-wrap',
      press('+ Insert field ▾', 'Insert a field', () => { fieldsMenu.hidden = !fieldsMenu.hidden; }, { class: 'rt-btn rt-insert' }),
      fieldsMenu),
    press('Page break', 'Start a new page here', () => { insertNode(document.createElement('hr')); page.querySelectorAll('hr').forEach((x) => { x.className = 'page-break'; }); }, { class: 'rt-btn rt-text' }),
    press('Clear', 'Remove the formatting from the selection', () => run('removeFormat'), { class: 'rt-btn rt-text' }),
    h('span.rt-sep'),
    press(icon('M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3'), 'Undo', () => run('undo')),
    press(icon('m15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3'), 'Redo', () => run('redo')));

  document.addEventListener('mousedown', (e) => { if (!fieldsMenu.hidden && !fieldsMenu.parentNode.contains(e.target)) fieldsMenu.hidden = true; });

  const element = h('div.rt-editor', toolbar, h('div.rt-scroll', page));
  return {
    element,
    /** The formatted words, fields as {{key}}, ready to save. */
    read: () => RICH + cleanHtml(page.innerHTML),
  };
}
