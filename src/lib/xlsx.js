/**
 * A spreadsheet, written by hand.
 *
 * An .xlsx is a zip of XML parts, and there is no zip in a Worker: no
 * node:zlib, and no CompressionStream that gives the raw deflate a zip entry
 * wants without more bookkeeping than the compression saves. So the entries go
 * in stored, uncompressed, which the format has always allowed and every
 * spreadsheet program opens. A month's payroll is a few hundred rows of text;
 * the file is small either way.
 *
 * The alternative was a CSV for each table, and a CSV cannot hold three
 * tables, or a column width, or tell 1,200.50 apart from a piece of text.
 */

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (s) => new TextEncoder().encode(s);

/** Everything a spreadsheet would otherwise read back as markup. */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not valid in XML at all, and one of them in a
    // name field makes the whole workbook unopenable rather than showing a
    // funny character.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** A1, B1 ... Z1, AA1. */
export function cellRef(col, row) {
  let name = '';
  let n = col;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return `${name}${row + 1}`;
}

/** The letters on their own, for a merge range or a column width. */
export const colName = (col) => cellRef(col, 0).replace(/\d+$/, '');

// The styles a payroll uses most, by name, so a caller never types a bare
// index. The order is fixed: these are the first styles in every workbook.
const BASE = [
  {},
  { b: true },
  { fmt: '#,##0.00' },
  { b: true, fmt: '#,##0.00', border: { t: 'thin', b: 'thin' } },
  { b: true, fill: 'FFEFEFEF', border: { t: 'thin', b: 'thin' }, wrap: true, v: 'center' },
  { b: true, sz: 12 },
  { b: true, border: { t: 'thin', b: 'thin' } },
];

/** What each named style is, as an index into the list above. */
export const S = {
  plain: 0, bold: 1, money: 2, moneyTotal: 3, head: 4, title: 5, total: 6,
};

/**
 * Every style a workbook uses, gathered as the cells are written.
 *
 * A cell can name one of the styles above by number, or describe its own:
 * `{ font, sz, b, color, fill, border: { l, r, t, b }, h, v, wrap, fmt }`.
 * A form copied from somebody else's paper (the GRA's, say) needs its own
 * boxes and shading, and a fixed list of seven would never have them.
 */
function styleBook() {
  const fonts = [];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const fmts = [];
  const xfs = [];
  const seen = new Map();
  const slot = (list, xml) => {
    const at = list.indexOf(xml);
    if (at >= 0) return at;
    list.push(xml);
    return list.length - 1;
  };

  const add = (style = {}) => {
    const key = JSON.stringify(style);
    if (seen.has(key)) return seen.get(key);
    const font = slot(fonts, `<font>${style.b ? '<b/>' : ''}${style.i ? '<i/>' : ''}<sz val="${style.sz ?? 10}"/>`
      + `${style.color ? `<color rgb="${style.color}"/>` : ''}<name val="${esc(style.font ?? 'Calibri')}"/></font>`);
    const fill = style.fill
      ? slot(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${style.fill}"/><bgColor indexed="64"/></patternFill></fill>`)
      : 0;
    const side = (name, value) => (value ? `<${name} style="${value}"><color auto="1"/></${name}>` : `<${name}/>`);
    const bd = style.border ?? {};
    const border = style.border
      ? slot(borders, `<border>${side('left', bd.l)}${side('right', bd.r)}${side('top', bd.t)}${side('bottom', bd.b)}<diagonal/></border>`)
      : 0;
    let numFmt = 0;
    if (style.fmt === '@') numFmt = 49;
    else if (style.fmt) numFmt = 164 + slot(fmts, style.fmt);
    const align = style.h || style.v || style.wrap
      ? `<alignment${style.h ? ` horizontal="${style.h}"` : ''}${style.v ? ` vertical="${style.v}"` : ''}${style.wrap ? ' wrapText="1"' : ''}/>`
      : '';
    xfs.push(`<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"`
      + `${numFmt ? ' applyNumberFormat="1"' : ''}${fill ? ' applyFill="1"' : ''}${border ? ' applyBorder="1"' : ''}`
      + `${align ? ` applyAlignment="1">${align}</xf>` : '/>'}`);
    seen.set(key, xfs.length - 1);
    return xfs.length - 1;
  };
  for (const style of BASE) add(style);

  return {
    id: (s) => (typeof s === 'number' ? s : add(s)),
    xml: () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${fmts.length ? `<numFmts count="${fmts.length}">${fmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join('')}</numFmts>` : ''}
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
  };
}

/**
 * One cell.
 *
 * A bare number, string or null is the common case and is read as such. An
 * object says more: `{ v, s }` to give it a style, and `{ v, text: true }` to
 * keep something that looks like a number as text, which is what a TIN and an
 * employee number need or the leading zero goes. `{ f, v }` is a formula, with
 * `v` the figure it comes to today.
 */
function cellXml(value, col, row, styles) {
  const at = cellRef(col, row);
  const cell = value != null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { v: value };
  const id = cell.s != null ? styles.id(cell.s) : 0;
  const style = id ? ` s="${id}"` : '';
  const v = cell.v;

  // A formula, with the value it comes to written beside it so the sheet
  // shows the right figure before anything has recalculated it.
  if (cell.f) {
    const cached = typeof v === 'number' && Number.isFinite(v) ? `<v>${v}</v>` : '';
    return `<c r="${at}"${style}><f>${esc(cell.f)}</f>${cached}</c>`;
  }

  if (v == null || v === '') return style ? `<c r="${at}"${style}/>` : '';
  if (typeof v === 'number' && Number.isFinite(v) && !cell.text) {
    return `<c r="${at}"${style}><v>${v}</v></c>`;
  }
  return `<c r="${at}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

/**
 * One sheet. Beyond the rows: `widths`, `merges`, `freeze` (rows held at the
 * top), `freezeCols` (columns held at the left), `hidden` (column indexes
 * nobody needs to see), `heights` ({ row index: points }), `gridLines: false`
 * and `landscape: true`, which also fits the sheet to one page wide.
 */
function sheetXml({
  rows = [], widths = [], merges = [], freeze = 0, freezeCols = 0, hidden = [], heights = {},
  gridLines = true, landscape = false,
}, styles) {
  const count = Math.max(widths.length, ...hidden.map((i) => i + 1), 0);
  const colXml = [];
  for (let i = 0; i < count; i += 1) {
    const w = widths[i];
    const hide = hidden.includes(i);
    if (w == null && !hide) continue;
    colXml.push(`<col min="${i + 1}" max="${i + 1}" width="${w ?? 9}"${w != null ? ' customWidth="1"' : ''}${hide ? ' hidden="1"' : ''}/>`);
  }
  const cols = colXml.length ? `<cols>${colXml.join('')}</cols>` : '';
  const body = rows.map((cells, r) => {
    const inner = (cells ?? []).map((cell, c) => cellXml(cell, c, r, styles)).join('');
    const ht = heights[r] ? ` ht="${heights[r]}" customHeight="1"` : '';
    return inner ? `<row r="${r + 1}"${ht}>${inner}</row>` : `<row r="${r + 1}"${ht}/>`;
  }).join('');
  const grid = gridLines ? '' : ' showGridLines="0"';
  let pane = '';
  if (freeze || freezeCols) {
    const top = `${colName(freezeCols)}${freeze + 1}`;
    const which = freeze && freezeCols ? 'bottomRight' : freeze ? 'bottomLeft' : 'topRight';
    pane = `<pane${freezeCols ? ` xSplit="${freezeCols}"` : ''}${freeze ? ` ySplit="${freeze}"` : ''} topLeftCell="${top}" activePane="${which}" state="frozen"/>`;
  }
  const view = `<sheetView workbookViewId="0"${grid}>${pane}</sheetView>`;
  const merged = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
    : '';
  const fit = landscape ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '';
  const page = landscape ? '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${fit}<sheetViews>${view}</sheetViews>${cols}<sheetData>${body}</sheetData>${merged}
<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>${page}
</worksheet>`;
}

/** A sheet name Excel will take: 31 characters, and none of \ / ? * [ ] : */
const sheetName = (name, i) => (String(name || '')
  .replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || `Sheet${i + 1}`);

/**
 * A workbook, as bytes.
 *
 * Each sheet is `{ name, rows, widths, merges, freeze }`, where rows is an
 * array of arrays of cells.
 */
export function workbook(sheets = []) {
  const list = sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }];
  const parts = [];
  const add = (name, text) => parts.push({ name, bytes: utf8(text) });

  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`);

  add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

  add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${list.map((s, i) => `<sheet name="${esc(sheetName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`);

  add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);

  // The sheets first, because the styles are whatever the sheets turned out
  // to use.
  const styles = styleBook();
  const sheetsXml = list.map((s) => sheetXml(s, styles));
  add('xl/styles.xml', styles.xml());
  sheetsXml.forEach((xml, i) => add(`xl/worksheets/sheet${i + 1}.xml`, xml));

  return zip(parts);
}

/** The parts, stored rather than deflated, in one archive. */
export function zip(parts) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

  // A fixed timestamp. A workbook built twice from the same month should be
  // the same file, and nobody reads the modified time inside a zip.
  const time = 0;
  const date = 0x2821; // 1 January 2000

  for (const part of parts) {
    const name = utf8(part.name);
    const crc = crc32(part.bytes);
    const size = part.bytes.length;

    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0),
      ...u16(time), ...u16(date), ...u32(crc), ...u32(size), ...u32(size),
      ...u16(name.length), ...u16(0),
    ]);
    chunks.push(local, name, part.bytes);

    central.push(new Uint8Array([
      0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(time), ...u16(date), ...u32(crc), ...u32(size), ...u32(size),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
    ]), name);

    offset += local.length + name.length + size;
  }

  const dirStart = offset;
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0),
    ...u16(parts.length), ...u16(parts.length), ...u32(dirSize), ...u32(dirStart), ...u16(0),
  ]);

  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}
