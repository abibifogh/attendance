// Getting the words, and where they sit, out of a PDF.
//
// A schedule printed to PDF is a table, and a table is only readable if you
// know which column a word is in. So this does not return a wall of text: it
// returns every run of characters with the point on the page it was drawn at,
// and leaves the business of turning that back into rows and columns to
// whoever knows what the table means.
//
// Deliberately small. It reads the objects, inflates the streams, walks the
// text operators and stops. There is no rendering, no images, no colour and no
// attempt at anything but the Latin alphabet — a rota is names, dates and
// times, and a general-purpose PDF library to read three columns of those is
// a dependency this app does not need and could not audit.

/**
 * Everything drawn as text, page by page.
 *
 * Throws with something a person can act on. "That file is not a PDF" and "that
 * PDF has no text in it, only a picture of it" are different problems with
 * different fixes, and a single "could not read that" sends somebody to the
 * wrong one.
 */
export async function extractPdfText(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const src = latin1(data);

  if (!src.startsWith('%PDF-') && !src.slice(0, 1024).includes('%PDF-')) {
    throw new Error('That does not look like a PDF.');
  }

  const objects = scanObjects(src, data);
  if (findEncrypt(src, objects)) {
    throw new Error('That PDF is password-protected. Save an unprotected copy and try again.');
  }

  await expandObjectStreams(objects);

  const pages = orderedPages(objects);
  if (!pages.length) throw new Error('That PDF has no pages in it.');

  const out = [];
  for (const page of pages) {
    out.push(await readPage(page, objects));
  }
  return { pages: out };
}

// ---------------------------------------------------------------------------
// Bytes and strings
// ---------------------------------------------------------------------------

/**
 * The file as one character per byte.
 *
 * Every offset in a PDF is a byte offset, so the string used for scanning must
 * agree with the array used for slicing. Decoding as UTF-8 would collapse
 * multi-byte sequences and every offset after the first accented character in
 * the file would be wrong — which shows up as a stream that inflates to
 * nothing, a long way from the cause.
 */
function latin1(data) {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    out += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
  }
  return out;
}

const bytesOf = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/**
 * Every indirect object in the file, found by reading rather than by index.
 *
 * A PDF is supposed to be found through its cross-reference table, and the
 * table is the first thing to go wrong: a file appended to twice, saved by a
 * tool that miscounted, or truncated in transit has a table that points at the
 * wrong bytes. Scanning for "N G obj" finds the objects that are actually
 * there, which is the question being asked.
 */
function scanObjects(src, data) {
  const objects = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m = re.exec(src);

  while (m) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const next = re.exec(src);
    const limit = next ? next.index : src.length;

    const parser = new Parser(src, start, limit);
    let value = null;
    try {
      value = parser.parseObject();
    } catch {
      value = null;
    }

    // A stream's length is often an indirect reference, so it cannot be trusted
    // here. The keyword pair is unambiguous and always right.
    let stream = null;
    const sIdx = src.indexOf('stream', parser.pos);
    if (sIdx >= 0 && sIdx < limit && src.slice(parser.pos, sIdx).trim() === '') {
      let from = sIdx + 'stream'.length;
      if (src[from] === '\r') from += 1;
      if (src[from] === '\n') from += 1;
      const end = src.indexOf('endstream', from);
      if (end >= 0) {
        let to = end;
        if (src[to - 1] === '\n') to -= 1;
        if (src[to - 1] === '\r') to -= 1;
        stream = data.subarray(from, to);
      }
    }

    // A later object with the same number is a later revision of it, so the
    // last one scanned wins.
    objects.set(num, { num, dict: value, stream });
    m = next;
  }

  return objects;
}

const isRef = (v) => v && typeof v === 'object' && v.__ref === true;
const isDict = (v) => v && typeof v === 'object' && v.__dict === true;
const isName = (v) => v && typeof v === 'object' && v.__name !== undefined;

/** Follow a reference, however many hops it takes. */
function deref(value, objects, depth = 0) {
  if (!isRef(value) || depth > 32) return value;
  const found = objects.get(value.num);
  return found ? deref(found.dict, objects, depth + 1) : null;
}

const get = (dict, key, objects) => (isDict(dict) ? deref(dict.map.get(key), objects) : undefined);
const nameOf = (value) => (isName(value) ? value.__name : null);

function findEncrypt(src, objects) {
  if (!/\/Encrypt\b/.test(src)) return false;
  // A trailer mentioning /Encrypt is the real signal; the word can also appear
  // inside a stream that happens to contain it.
  return /trailer[\s\S]{0,2000}?\/Encrypt\b/.test(src) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(src);
}

// ---------------------------------------------------------------------------
// A parser for PDF's own object syntax
// ---------------------------------------------------------------------------

const WHITESPACE = new Set([' ', '\t', '\r', '\n', '\f', '\0']);
const DELIMITER = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

class Parser {
  constructor(src, pos = 0, limit = src.length) {
    this.src = src;
    this.pos = pos;
    this.limit = limit;
  }

  skipWs() {
    while (this.pos < this.limit) {
      const c = this.src[this.pos];
      if (WHITESPACE.has(c)) { this.pos += 1; continue; }
      if (c === '%') {
        while (this.pos < this.limit && this.src[this.pos] !== '\n' && this.src[this.pos] !== '\r') {
          this.pos += 1;
        }
        continue;
      }
      return;
    }
  }

  /** The next object, or `undefined` at the end of what we were given. */
  parseObject() {
    this.skipWs();
    if (this.pos >= this.limit) return undefined;

    const c = this.src[this.pos];

    if (c === '/') return { __name: this.readName() };
    if (c === '(') return this.readLiteralString();
    if (c === '[') return this.readArray();
    if (c === '<') {
      return this.src[this.pos + 1] === '<' ? this.readDict() : this.readHexString();
    }
    if (c === ']' || c === '>' || c === ')' || c === '}') { this.pos += 1; return undefined; }

    const word = this.readWord();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (word === '') { this.pos += 1; return undefined; }

    if (/^[+-]?[\d.]+$/.test(word)) {
      // "12 0 R" is a reference, and it is only a reference when all three
      // parts are there — "12 0" on its own is two numbers in an array.
      const save = this.pos;
      const num = Number(word);
      if (Number.isInteger(num) && num >= 0) {
        this.skipWs();
        const gen = this.readWord();
        if (/^\d+$/.test(gen)) {
          this.skipWs();
          const r = this.readWord();
          if (r === 'R') return { __ref: true, num, gen: Number(gen) };
        }
      }
      this.pos = save;
      return Number.isNaN(num) ? 0 : num;
    }

    return { __op: word };
  }

  readWord() {
    const start = this.pos;
    while (this.pos < this.limit
      && !WHITESPACE.has(this.src[this.pos])
      && !DELIMITER.has(this.src[this.pos])) this.pos += 1;
    return this.src.slice(start, this.pos);
  }

  readName() {
    this.pos += 1; // the slash
    const start = this.pos;
    while (this.pos < this.limit
      && !WHITESPACE.has(this.src[this.pos])
      && !DELIMITER.has(this.src[this.pos])) this.pos += 1;
    // #41 is an escaped character in a name, most often a space or a bracket.
    return this.src.slice(start, this.pos)
      .replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  readArray() {
    this.pos += 1;
    const out = [];
    while (this.pos < this.limit) {
      this.skipWs();
      if (this.src[this.pos] === ']') { this.pos += 1; break; }
      const before = this.pos;
      const value = this.parseObject();
      if (this.pos === before) { this.pos += 1; continue; }
      if (value !== undefined) out.push(value);
    }
    return out;
  }

  readDict() {
    this.pos += 2;
    const map = new Map();
    while (this.pos < this.limit) {
      this.skipWs();
      if (this.src[this.pos] === '>' && this.src[this.pos + 1] === '>') { this.pos += 2; break; }
      if (this.src[this.pos] !== '/') {
        const before = this.pos;
        this.parseObject();
        if (this.pos === before) this.pos += 1;
        continue;
      }
      const key = this.readName();
      const value = this.parseObject();
      map.set(key, value);
    }
    return { __dict: true, map };
  }

  readLiteralString() {
    this.pos += 1;
    let depth = 1;
    let out = '';
    while (this.pos < this.limit) {
      const c = this.src[this.pos];
      if (c === '\\') {
        const next = this.src[this.pos + 1];
        this.pos += 2;
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else if (next === 'b') out += '\b';
        else if (next === 'f') out += '\f';
        else if (next === '\n') { /* a line continuation */ }
        else if (next === '\r') { if (this.src[this.pos] === '\n') this.pos += 1; }
        else if (next >= '0' && next <= '7') {
          let oct = next;
          while (oct.length < 3 && this.src[this.pos] >= '0' && this.src[this.pos] <= '7') {
            oct += this.src[this.pos];
            this.pos += 1;
          }
          out += String.fromCharCode(parseInt(oct, 8));
        } else out += next;
        continue;
      }
      if (c === '(') depth += 1;
      if (c === ')') {
        depth -= 1;
        if (!depth) { this.pos += 1; break; }
      }
      out += c;
      this.pos += 1;
    }
    return { __str: out };
  }

  readHexString() {
    this.pos += 1;
    let hex = '';
    while (this.pos < this.limit && this.src[this.pos] !== '>') {
      const c = this.src[this.pos];
      if (/[0-9a-fA-F]/.test(c)) hex += c;
      this.pos += 1;
    }
    this.pos += 1;
    if (hex.length % 2) hex += '0';
    let out = '';
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return { __str: out };
  }
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/** A stream's bytes, with whatever filters it declares undone. */
async function decodeStream(entry, objects) {
  if (!entry?.stream) return null;

  const filterValue = get(entry.dict, 'Filter', objects);
  const filters = (Array.isArray(filterValue) ? filterValue : [filterValue])
    .map(nameOf).filter(Boolean);

  const parmsValue = get(entry.dict, 'DecodeParms', objects);
  const parms = Array.isArray(parmsValue) ? parmsValue : [parmsValue];

  let out = entry.stream;
  for (let i = 0; i < filters.length; i += 1) {
    const filter = filters[i];
    if (filter === 'FlateDecode') out = await inflate(out);
    else if (filter === 'ASCIIHexDecode') out = asciiHexDecode(out);
    else if (filter === 'ASCII85Decode') out = ascii85Decode(out);
    else return null; // an image codec, or something this has no business reading
    if (!out) return null;

    const parm = deref(parms[i], objects);
    const predictor = Number(get(parm, 'Predictor', objects) ?? 1);
    if (predictor >= 10) {
      out = unpredict(out, {
        colors: Number(get(parm, 'Colors', objects) ?? 1),
        bpc: Number(get(parm, 'BitsPerComponent', objects) ?? 8),
        columns: Number(get(parm, 'Columns', objects) ?? 1),
      });
    }
  }
  return out;
}

/**
 * Undo a deflate stream.
 *
 * Two goes at it. A PDF's FlateDecode is zlib-wrapped, but files written by
 * tools that emit raw deflate exist and are otherwise perfectly readable, so
 * the second attempt costs nothing and buys a whole class of file.
 */
async function inflate(bytes) {
  for (const format of ['deflate', 'deflate-raw']) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // try the other one
    }
  }
  return null;
}

function asciiHexDecode(bytes) {
  const text = latin1(bytes);
  const hex = text.slice(0, text.indexOf('>') >= 0 ? text.indexOf('>') : text.length)
    .replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function ascii85Decode(bytes) {
  const text = latin1(bytes).replace(/\s/g, '').replace(/^<~/, '');
  const end = text.indexOf('~>');
  const body = end >= 0 ? text.slice(0, end) : text;
  const out = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === 'z') { out.push(0, 0, 0, 0); i += 1; continue; }
    const group = body.slice(i, i + 5);
    i += 5;
    const padded = group.padEnd(5, 'u');
    let value = 0;
    for (const ch of padded) value = value * 85 + (ch.charCodeAt(0) - 33);
    const four = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...four.slice(0, group.length - 1));
  }
  return Uint8Array.from(out);
}

/** The PNG predictors, which cross-reference and object streams often use. */
function unpredict(bytes, { colors, bpc, columns }) {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLength = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(bytes.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  let previous = new Uint8Array(rowLength);

  for (let r = 0; r < rows; r += 1) {
    const tag = bytes[r * (rowLength + 1)];
    const row = bytes.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const current = new Uint8Array(rowLength);

    for (let i = 0; i < rowLength; i += 1) {
      const raw = row[i] ?? 0;
      const left = i >= bpp ? current[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;

      if (tag === 0) current[i] = raw;
      else if (tag === 1) current[i] = (raw + left) & 0xff;
      else if (tag === 2) current[i] = (raw + up) & 0xff;
      else if (tag === 3) current[i] = (raw + ((left + up) >> 1)) & 0xff;
      else if (tag === 4) current[i] = (raw + paeth(left, up, upLeft)) & 0xff;
      else current[i] = raw;
    }

    out.set(current, r * rowLength);
    previous = current;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Objects that live inside other objects.
 *
 * Anything written this century packs most of its small objects into compressed
 * object streams, so a reader that only scans for "N G obj" finds the page
 * bodies and none of the dictionaries describing them.
 */
async function expandObjectStreams(objects) {
  for (const entry of [...objects.values()]) {
    if (nameOf(get(entry.dict, 'Type', objects)) !== 'ObjStm') continue;

    const bytes = await decodeStream(entry, objects);
    if (!bytes) continue;

    const text = latin1(bytes);
    const count = Number(get(entry.dict, 'N', objects) ?? 0);
    const first = Number(get(entry.dict, 'First', objects) ?? 0);

    const head = new Parser(text, 0, first);
    const pairs = [];
    for (let i = 0; i < count; i += 1) {
      const num = head.parseObject();
      const offset = head.parseObject();
      if (typeof num !== 'number' || typeof offset !== 'number') break;
      pairs.push([num, offset]);
    }

    for (const [num, offset] of pairs) {
      // A scanned object always wins: it is a later revision of the same
      // number, written after the stream this one came out of.
      if (objects.has(num)) continue;
      const parser = new Parser(text, first + offset, text.length);
      try {
        objects.set(num, { num, dict: parser.parseObject(), stream: null });
      } catch {
        // one unreadable object is not a reason to abandon the rest
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * The pages, in the order somebody reading the file would see them.
 *
 * Through the page tree where there is one, because object numbers carry no
 * promise about order and a rota split across pages read backwards is worse
 * than one not read at all.
 */
function orderedPages(objects) {
  const catalog = [...objects.values()]
    .find((o) => nameOf(get(o.dict, 'Type', objects)) === 'Catalog');

  const pages = [];
  const seen = new Set();

  const walk = (node, depth) => {
    if (!isDict(node) || depth > 64) return;
    const type = nameOf(get(node, 'Type', objects));
    if (type === 'Page') { pages.push(node); return; }
    const kids = get(node, 'Kids', objects);
    if (!Array.isArray(kids)) return;
    for (const kid of kids) {
      if (isRef(kid)) {
        if (seen.has(kid.num)) continue;
        seen.add(kid.num);
      }
      walk(deref(kid, objects), depth + 1);
    }
  };

  walk(get(catalog?.dict ?? catalog, 'Pages', objects), 0);

  if (pages.length) return pages;

  // No usable tree. Object order is a guess, but it is the order files are
  // written in and it beats refusing to read the thing.
  return [...objects.values()]
    .filter((o) => nameOf(get(o.dict, 'Type', objects)) === 'Page')
    .sort((a, b) => a.num - b.num)
    .map((o) => o.dict);
}

/** A value from this page, or from the nearest parent that has one. */
function inherited(page, key, objects, depth = 0) {
  if (!isDict(page) || depth > 32) return undefined;
  const own = get(page, key, objects);
  if (own !== undefined) return own;
  return inherited(get(page, 'Parent', objects), key, objects, depth + 1);
}

async function readPage(page, objects) {
  const box = inherited(page, 'MediaBox', objects);
  const width = Array.isArray(box) ? Number(box[2]) - Number(box[0]) : 595;
  const height = Array.isArray(box) ? Number(box[3]) - Number(box[1]) : 842;

  const resources = inherited(page, 'Resources', objects);
  const fonts = await loadFonts(get(resources, 'Font', objects), objects);

  const contents = page.map.get('Contents');
  const parts = [];
  for (const ref of (Array.isArray(deref(contents, objects)) ? deref(contents, objects) : [contents])) {
    const entry = isRef(ref) ? objects.get(ref.num) : null;
    const bytes = entry ? await decodeStream(entry, objects) : null;
    if (bytes) parts.push(latin1(bytes));
  }

  return { width, height, items: readContent(parts.join('\n'), fonts) };
}

// ---------------------------------------------------------------------------
// Fonts, only as far as turning bytes back into letters
// ---------------------------------------------------------------------------

async function loadFonts(fontDict, objects) {
  const fonts = new Map();
  if (!isDict(fontDict)) return fonts;

  for (const [name, ref] of fontDict.map) {
    const font = deref(ref, objects);
    if (!isDict(font)) continue;

    const subtype = nameOf(get(font, 'Subtype', objects));
    const toUnicodeRef = font.map.get('ToUnicode');
    const entry = isRef(toUnicodeRef) ? objects.get(toUnicodeRef.num) : null;
    const cmapBytes = entry ? await decodeStream(entry, objects) : null;

    const cmap = cmapBytes ? parseToUnicode(latin1(cmapBytes)) : null;

    const measured = subtype === 'Type0'
      ? compositeWidths(font, objects)
      : simpleWidths(font, objects);

    fonts.set(name, {
      // A composite font addresses its glyphs with two bytes; a simple one with
      // one. Getting this wrong turns every word into half as many wrong ones.
      twoByte: subtype === 'Type0' || cmap?.twoByte === true,
      map: cmap?.map ?? null,
      widths: measured.widths,
      defaultWidth: measured.defaultWidth,
    });
  }

  return fonts;
}

function simpleWidths(font, objects) {
  const first = Number(get(font, 'FirstChar', objects) ?? 0);
  const list = get(font, 'Widths', objects);
  const widths = new Map();

  if (Array.isArray(list)) {
    list.forEach((w, i) => {
      const value = deref(w, objects);
      if (typeof value === 'number') widths.set(first + i, value);
    });
  }

  return { widths: widths.size ? widths : null, defaultWidth: 500 };
}

/**
 * How wide each glyph of a composite font is.
 *
 * Not in the place a simple font keeps it. A Type0 font is a shell around a
 * descendant that holds the real metrics, in a run-length array of its own —
 * and getting this wrong does not corrupt a single character, it stretches
 * every measurement on the page by about two, which quietly moves words into
 * the wrong column of a table.
 */
function compositeWidths(font, objects) {
  const descendants = get(font, 'DescendantFonts', objects);
  const child = deref(Array.isArray(descendants) ? descendants[0] : descendants, objects);
  const defaultWidth = Number(get(child, 'DW', objects) ?? 1000) || 1000;

  const list = get(child, 'W', objects);
  const widths = new Map();

  if (Array.isArray(list)) {
    let i = 0;
    while (i < list.length) {
      const first = Number(deref(list[i], objects));
      const second = deref(list[i + 1], objects);

      if (Array.isArray(second)) {
        // c [w1 w2 …] — one width each, counting up from c.
        second.forEach((w, k) => {
          const value = Number(deref(w, objects));
          if (Number.isFinite(value)) widths.set(first + k, value);
        });
        i += 2;
        continue;
      }

      // cFirst cLast w — the same width across a run of codes.
      const last = Number(second);
      const width = Number(deref(list[i + 2], objects));
      if (Number.isFinite(last) && Number.isFinite(width) && last >= first && last - first < 65536) {
        for (let code = first; code <= last; code += 1) widths.set(code, width);
      }
      i += 3;
    }
  }

  return { widths: widths.size ? widths : null, defaultWidth };
}

/**
 * The font's own account of which code means which character.
 *
 * A subset font renumbers its glyphs, so byte 3 may be "e" in one font and "H"
 * in the next. Without this table the extracted text is a convincing-looking
 * anagram, which is worse than no text at all.
 */
function parseToUnicode(text) {
  const map = new Map();
  let twoByte = false;

  const spaceRe = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let m = spaceRe.exec(text);
  while (m) {
    const hexes = m[1].match(/<([0-9a-fA-F]+)>/g) ?? [];
    if (hexes.some((hx) => hx.length - 2 >= 4)) twoByte = true;
    m = spaceRe.exec(text);
  }

  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  m = charRe.exec(text);
  while (m) {
    const pairs = m[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g) ?? [];
    for (const pair of pairs) {
      const [, from, to] = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/.exec(pair);
      if (from.length >= 4) twoByte = true;
      map.set(parseInt(from, 16), utf16BeToString(to));
    }
    m = charRe.exec(text);
  }

  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  m = rangeRe.exec(text);
  while (m) {
    const body = m[1];
    const itemRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let item = itemRe.exec(body);
    while (item) {
      const lo = parseInt(item[1], 16);
      const hi = parseInt(item[2], 16);
      if (item[1].length >= 4) twoByte = true;

      if (item[4] !== undefined) {
        const base = item[4];
        for (let code = lo; code <= hi && code - lo < 65536; code += 1) {
          // The last unit of the destination counts up with the source.
          const head = base.slice(0, -4);
          const tail = (parseInt(base.slice(-4), 16) + (code - lo)) & 0xffff;
          map.set(code, utf16BeToString(head + tail.toString(16).padStart(4, '0')));
        }
      } else {
        const list = (item[5].match(/<([0-9a-fA-F]+)>/g) ?? []).map((hx) => hx.slice(1, -1));
        list.forEach((hex, i) => map.set(lo + i, utf16BeToString(hex)));
      }
      item = itemRe.exec(body);
    }
    m = rangeRe.exec(text);
  }

  return { map, twoByte };
}

function utf16BeToString(hex) {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const unit = parseInt(hex.slice(i, i + 4).padEnd(4, '0'), 16);
    if (Number.isNaN(unit)) break;
    out += String.fromCharCode(unit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The content stream
// ---------------------------------------------------------------------------

const identity = () => [1, 0, 0, 1, 0, 0];

function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/**
 * Every run of text on a page, with where it was drawn.
 *
 * The y is flipped to run down the page, because every question asked of the
 * result — which row is this in, is this above that — is asked the way a person
 * reads, and PDF's own axis runs the other way.
 */
function readContent(content, fonts) {
  const parser = new Parser(content, 0, content.length);
  const items = [];

  let ctm = identity();
  const stack = [];
  let tm = identity();
  let tlm = identity();
  let font = null;
  let size = 12;
  let leading = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontal = 1;

  const operands = [];

  const show = (parts) => {
    if (!parts.length) return;

    let text = '';
    let width = 0; // in thousandths of an em, before the font size is applied

    for (const part of parts) {
      if (typeof part === 'number') {
        // A kern. Only a wide one is a space — the small ones are the reason
        // "Somewhere Nice" is two words and "Ay ima" is not.
        width -= part;
        if (part < -180) text += ' ';
        continue;
      }
      const decoded = decodeText(part, font);
      text += decoded.text;
      width += decoded.width + decoded.count * ((charSpacing * 1000) / (size || 1));
      width += decoded.spaces * ((wordSpacing * 1000) / (size || 1));
    }

    const trm = multiply(tm, ctm);
    const advance = (width / 1000) * size * horizontal;

    if (text.trim()) {
      items.push({
        text,
        x: trm[4],
        y: trm[5],
        size: Math.abs(size * Math.hypot(trm[2], trm[3])) || Math.abs(size),
        // How wide the run is on the page. A table is read by where things sit
        // relative to each other, and half of that is knowing where a word
        // ends — a centred column heading gives away the column's middle only
        // once you know how long the heading is.
        width: Math.abs(advance * (Math.hypot(trm[0], trm[1]) || 1)),
      });
    }

    // Advance, so a second run in the same text object lands beside the first
    // rather than on top of it.
    tm = multiply([1, 0, 0, 1, advance, 0], tm);
  };

  for (;;) {
    const before = parser.pos;
    const token = parser.parseObject();
    if (token === undefined && parser.pos >= parser.limit) break;
    if (parser.pos === before) { parser.pos += 1; continue; }

    if (!token || token.__op === undefined) {
      operands.push(token);
      if (operands.length > 64) operands.shift();
      continue;
    }

    const op = token.__op;
    const num = (i) => {
      const value = operands[operands.length - i];
      return typeof value === 'number' ? value : 0;
    };

    switch (op) {
      case 'q': stack.push(ctm); break;
      case 'Q': ctm = stack.pop() ?? identity(); break;
      case 'cm':
        ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], ctm);
        break;

      case 'BT': tm = identity(); tlm = identity(); break;
      case 'ET': break;

      case 'Tf': {
        size = num(1);
        const name = operands[operands.length - 2];
        font = fonts.get(nameOf(name)) ?? null;
        break;
      }
      case 'TL': leading = num(1); break;
      case 'Tc': charSpacing = num(1); break;
      case 'Tw': wordSpacing = num(1); break;
      case 'Tz': horizontal = num(1) / 100; break;

      case 'Tm':
        tlm = [num(6), num(5), num(4), num(3), num(2), num(1)];
        tm = tlm;
        break;
      case 'Td':
        tlm = multiply([1, 0, 0, 1, num(2), num(1)], tlm);
        tm = tlm;
        break;
      case 'TD':
        leading = -num(1);
        tlm = multiply([1, 0, 0, 1, num(2), num(1)], tlm);
        tm = tlm;
        break;
      case 'T*':
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        break;

      case 'Tj': show([operands[operands.length - 1]]); break;
      case 'TJ': {
        const array = operands[operands.length - 1];
        show(Array.isArray(array) ? array : []);
        break;
      }
      case "'":
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        show([operands[operands.length - 1]]);
        break;
      case '"':
        wordSpacing = num(3);
        charSpacing = num(2);
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        show([operands[operands.length - 1]]);
        break;

      // An inline image's binary body would be read as operators, so skip to
      // the end of it rather than parsing a picture as instructions.
      case 'BI': {
        const end = content.indexOf('EI', parser.pos);
        parser.pos = end >= 0 ? end + 2 : parser.limit;
        break;
      }
      default: break;
    }

    operands.length = 0;
  }

  // Down the page, the way it is read.
  return items.map((item) => ({ ...item, y: -item.y }));
}

/** One string operand, turned back into characters. */
function decodeText(operand, font) {
  const raw = operand && typeof operand === 'object' && operand.__str !== undefined
    ? operand.__str : '';
  if (!raw) return { text: '', width: 0, count: 0, spaces: 0 };

  const step = font?.twoByte ? 2 : 1;
  let text = '';
  let width = 0;
  let count = 0;
  let spaces = 0;

  for (let i = 0; i < raw.length; i += step) {
    const code = step === 2
      ? ((raw.charCodeAt(i) << 8) | (raw.charCodeAt(i + 1) & 0xff))
      : raw.charCodeAt(i) & 0xff;

    const mapped = font?.map?.get(code);
    const chunk = mapped !== undefined ? mapped : String.fromCharCode(code);
    text += chunk;

    width += font?.widths?.get(code) ?? font?.defaultWidth ?? 500;
    count += 1;
    if (step === 1 && code === 32) spaces += 1;
  }

  return { text, width, count, spaces };
}
