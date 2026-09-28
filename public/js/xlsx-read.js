/**
 * Reading an .xlsx, the way it comes out of Excel or Google Sheets.
 *
 * The writer beside the server (src/lib/xlsx.js) only ever makes files. This
 * is the other direction, for the screens where somebody has a spreadsheet
 * already and should not have to save it as a CSV first: that is a step people
 * get wrong, and a CSV from a sheet with a comma in a name is a different
 * sheet.
 *
 * An .xlsx is a zip of XML parts. The browser has the inflate a zip entry
 * needs (DecompressionStream, 'deflate-raw'), so there is nothing to ship. The
 * XML is read with patterns rather than a DOM parser, because the parts are
 * machine-written and regular, and because the same code then runs in the
 * tests, which have no DOM.
 *
 * What comes back is the value each cell shows. A formula gives the result the
 * spreadsheet saved with it, not the formula: `=400+120.5` reads as 520.5,
 * which is what the person looking at the sheet sees.
 */

/** Every sheet in the workbook, in order: `[{ name, rows }]`, rows as arrays of cell values. */
export async function readXlsx(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const files = await unzip(bytes);
  const text = (path) => (files.has(path) ? new TextDecoder().decode(files.get(path)) : null);

  const book = text('xl/workbook.xml');
  if (!book) throw new Error('That is not a spreadsheet HIVE can read. Save it as .xlsx and try again.');

  const rels = new Map();
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const shared = [];
  for (const m of (text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(runsOf(m[1]));
  }

  const sheets = [];
  for (const m of book.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = unescape(attr(m[1], 'name') ?? '');
    const path = rels.get(attr(m[1], 'r:id'));
    const xml = path ? text(path) : null;
    if (xml) sheets.push({ name, rows: rowsOf(xml, shared) });
  }
  return sheets;
}

function rowsOf(xml, shared) {
  const rows = [];
  for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const at = Number(attr(row[1], 'r')) - 1;
    const cells = [];
    for (const c of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r') ?? '';
      const col = columnOf(ref.replace(/\d+$/, ''));
      const value = valueOf(attr(c[1], 't'), c[2] ?? '', shared);
      if (value !== null && col >= 0) cells[col] = value;
    }
    for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = null;
    rows[at >= 0 ? at : rows.length] = cells;
  }
  for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
  return rows;
}

function valueOf(type, inner, shared) {
  const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
  if (type === 's') return v == null ? null : (shared[Number(v)] ?? null);
  if (type === 'inlineStr') return runsOf(inner.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? '');
  if (type === 'str') return v == null ? null : unescape(v);
  if (type === 'b') return v === '1';
  if (type === 'e') return null;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : unescape(v);
}

/** The text of a string item, including one written as several formatted runs. */
function runsOf(xml) {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescape(t[1])).join('');
}

function columnOf(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const attr = (attrs, name) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] ?? null;

const unescape = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
  .replace(/&amp;/g, '&');

/** The zip's entries, by name. Read from the central directory, which has the true sizes. */
async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('That is not a spreadsheet HIVE can read. Save it as .xlsx and try again.');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    // Only the parts a value can come from. The pictures and the theme are
    // most of a file's size and none of its figures.
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;

    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflate(data));
  }
  return files;
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
