import { FIRST, HELVETICA, HELVETICA_BOLD } from './helvetica.js';

/**
 * A small PDF writer: A4 pages of text, lines and filled boxes, in the two
 * faces every PDF reader has built in (Helvetica and Helvetica-Bold), so
 * nothing is embedded and nothing is installed.
 *
 * It exists because a phone that opens Insight from its home screen cannot
 * print a web page: the browser's print does nothing there. A PDF opens in
 * the phone's own viewer, which shares, saves and prints it.
 *
 * Positions are in points from the top-left of the page (the PDF's own origin
 * is the bottom-left; that is turned round here). Text is Latin-1: anything
 * else is put in plain letters by `plain`.
 */

export const A4 = { w: 595.28, h: 841.89 };

/** Text the built-in faces can draw: the cedi sign and typographic marks in plain letters. */
export function plain(text) {
  return String(text ?? '')
    .replace(/GH₵\s?/g, 'GHS ').replace(/₵/g, 'GHS ')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/•/g, '·')
    .replace(/✓/g, '').replace(/[✕×]/g, 'x').replace(/→/g, '->')
    .replace(/[  ]/g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
    .trim();
}

const widths = (bold) => (bold ? HELVETICA_BOLD : HELVETICA);

/** How wide `text` is, in points, at `size`. */
export function widthOf(text, size, bold = false) {
  const table = widths(bold);
  let w = 0;
  for (const ch of plain(text)) w += table[ch.charCodeAt(0) - FIRST] || 556;
  return (w / 1000) * size;
}

/** `text` broken into lines no wider than `width`; a word too long for a line is cut. */
export function wrap(text, size, width, bold = false) {
  const out = [];
  for (const para of plain(text).split('\n')) {
    let line = '';
    for (const word of para.split(/ +/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size, bold) <= width) { line = next; continue; }
      if (line) out.push(line);
      line = word;
      while (widthOf(line, size, bold) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && widthOf(line.slice(0, cut), size, bold) > width) cut -= 1;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const colour = (c) => (c || [0, 0, 0]).map((v) => num(v)).join(' ');
/** A PDF string: brackets and backslashes escaped, Latin-1 above 127 as octal. */
const str = (text) => `(${[...plain(text)].map((ch) => {
  const c = ch.charCodeAt(0);
  if (ch === '(' || ch === ')' || ch === '\\') return `\\${ch}`;
  return c > 126 ? `\\${c.toString(8).padStart(3, '0')}` : ch;
}).join('')})`;

export function pdf({ title = '' } = {}) {
  const pages = [];
  let ops = null;
  const y = (top) => num(A4.h - top);
  const doc = {
    pages,
    /** A new page; everything drawn goes on it until the next. */
    page() { ops = []; pages.push(ops); return doc; },
    /** Text with its baseline at `top`, from `x`; `align: 'right'` ends it at `x`. */
    text(x, top, text, { size = 10, bold = false, color = null, align = 'left' } = {}) {
      const t = plain(text);
      if (!t) return doc;
      const left = align === 'right' ? x - widthOf(t, size, bold) : align === 'center' ? x - widthOf(t, size, bold) / 2 : x;
      ops.push(`BT ${colour(color)} rg /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(left)} ${y(top)} Td ${str(t)} Tj ET`);
      return doc;
    },
    line(x1, top1, x2, top2, { width = 0.5, color = null } = {}) {
      ops.push(`${colour(color)} RG ${num(width)} w ${num(x1)} ${y(top1)} m ${num(x2)} ${y(top2)} l S`);
      return doc;
    },
    /** A box from its top-left corner; filled, outlined, or both. */
    box(x, top, w, h, { fill = null, stroke = null, width = 0.5 } = {}) {
      const r = `${num(x)} ${y(top + h)} ${num(w)} ${num(h)} re`;
      if (fill && stroke) ops.push(`${colour(fill)} rg ${colour(stroke)} RG ${num(width)} w ${r} B`);
      else if (fill) ops.push(`${colour(fill)} rg ${r} f`);
      else ops.push(`${colour(stroke)} RG ${num(width)} w ${r} S`);
      return doc;
    },
    /** The file, as bytes. */
    bytes() {
      const objects = [];
      const add = (body) => { objects.push(body); return objects.length; };
      const catalog = add(null);
      const tree = add(null);
      const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      const info = add(`<< /Title ${str(title)} /Producer (Insight) >>`);
      const kids = pages.map((p) => {
        const stream = p.join('\n');
        const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
        return add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${num(A4.w)} ${num(A4.h)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`);
      });
      objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
      objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
      let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
      const offsets = [];
      objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
      const xref = out.length;
      out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
      out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      const bytes = new Uint8Array(out.length);
      for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i) & 0xff;
      return bytes;
    },
  };
  return doc;
}
