/**
 * A small PDF writer: A4 pages, text, lines, boxes and photographs.
 *
 * Written here rather than pulled in, because the Worker has no dependencies
 * and a voucher with a table and a few receipt photos needs very little of
 * what a PDF can do. What it does:
 *
 *   text in Helvetica and Helvetica Bold, the two faces every PDF reader has
 *   built in, so nothing is embedded and the file stays small;
 *   lines and filled rectangles;
 *   JPEG photographs as they are, and PNGs re-packed (with any transparency
 *   laid onto white), fitted inside a box without stretching.
 *
 * Coordinates are in points from the TOP LEFT of the page, the way a layout is
 * thought about, and turned round to PDF's bottom-left origin when written.
 *
 * TEXT IS WINDOWS-1252, which is what the built-in faces can show. Common
 * punctuation (the middle dot, dashes, curly quotes) is mapped across; the
 * cedi sign is not in it and is written "GHS"; anything else unknown becomes
 * a question mark rather than breaking the file.
 */

export const A4 = { width: 595.28, height: 841.89 };

// Advance widths per 1000 units for characters 32 to 126, from the standard
// Helvetica and Helvetica-Bold metrics. Used to measure text for alignment.
const W_REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const CP1252 = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94,
  '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99,
};

/** Text as the bytes the built-in faces understand. */
export function winAnsi(text) {
  const s = String(text ?? '').replace(/₵/g, 'S').replace(/GH\s*S/g, 'GHS')
    .replace(/→/g, '->').replace(/ /g, ' ');
  const out = [];
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) out.push(code);
    else if (CP1252[ch]) out.push(CP1252[ch]);
    else if (code >= 0xa0 && code <= 0xff) out.push(code);
    else if (code === 10 || code === 9) out.push(32);
    else out.push(63);
  }
  return out;
}

/** How wide a string is at a size, in points. */
export function textWidth(text, size, bold = false) {
  const table = bold ? W_BOLD : W_REGULAR;
  let units = 0;
  for (const b of winAnsi(text)) units += b >= 32 && b <= 126 ? table[b - 32] : 556;
  return (units * size) / 1000;
}

/** Break a string into lines no wider than `width`. */
export function wrap(text, width, size, bold = false) {
  const lines = [];
  for (const para of String(text ?? '').split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width || !line) line = next;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (hex) => {
  const h = String(hex || '#000000').replace('#', '');
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return v.map((x) => num(Number.isFinite(x) ? x : 0)).join(' ');
};
const pdfString = (bytes) => {
  let s = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) s += `\\${b.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(b);
  }
  return `${s})`;
};

class Page {
  constructor(doc) {
    this.doc = doc;
    this.ops = [];
    this.images = new Set();
  }

  /** Text with its baseline at y. align: left | right | center (x is that edge or the middle). */
  text(x, y, value, { size = 10, bold = false, color = '#15191f', align = 'left' } = {}) {
    const w = textWidth(value, size, bold);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    const font = bold ? 'F2' : 'F1';
    this.ops.push(`BT /${font} ${num(size)} Tf ${rgb(color)} rg ${num(left)} ${num(A4.height - y)} Td `
      + `${pdfString(winAnsi(value))} Tj ET`);
    return w;
  }

  /** Wrapped text from the top of a box; returns the y below the last line. */
  paragraph(x, y, width, value, { size = 10, bold = false, color = '#15191f', leading = 1.35 } = {}) {
    let at = y;
    for (const line of wrap(value, width, size, bold)) {
      at += size * leading;
      this.text(x, at - size * (leading - 1), line, { size, bold, color });
    }
    return at;
  }

  line(x1, y1, x2, y2, { width = 0.75, color = '#c9ced6' } = {}) {
    this.ops.push(`${num(width)} w ${rgb(color)} RG ${num(x1)} ${num(A4.height - y1)} m `
      + `${num(x2)} ${num(A4.height - y2)} l S`);
  }

  rect(x, y, w, h, { fill = null, stroke = null, width = 0.75 } = {}) {
    const box = `${num(x)} ${num(A4.height - y - h)} ${num(w)} ${num(h)} re`;
    if (fill && stroke) this.ops.push(`${rgb(fill)} rg ${rgb(stroke)} RG ${num(width)} w ${box} B`);
    else if (fill) this.ops.push(`${rgb(fill)} rg ${box} f`);
    else if (stroke) this.ops.push(`${rgb(stroke)} RG ${num(width)} w ${box} S`);
  }

  /** A picture fitted inside the box, centred, never stretched. */
  image(img, x, y, w, h) {
    const scale = Math.min(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh) / 2;
    this.images.add(img.name);
    this.ops.push(`q ${num(dw)} 0 0 ${num(dh)} ${num(dx)} ${num(A4.height - dy - dh)} cm /${img.name} Do Q`);
  }
}

export class PdfDoc {
  constructor({ title = '', author = 'HIVE' } = {}) {
    this.pages = [];
    this.imgs = [];
    this.title = title;
    this.author = author;
  }

  addPage() {
    const page = new Page(this);
    this.pages.push(page);
    return page;
  }

  /**
   * A photograph, from its bytes. JPEG goes in as it is; PNG is re-packed.
   * Returns null for anything that cannot be placed (a HEIC photo, a broken
   * file), so the caller can say so on the page rather than fail the document.
   */
  async addImage(bytes, mime = '') {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    try {
      if (isJpeg(b)) return this.register(jpegImage(b));
      if (isPng(b)) return this.register(await pngImage(b));
    } catch {
      return null;
    }
    void mime;
    return null;
  }

  register(img) {
    if (!img) return null;
    img.name = `Im${this.imgs.length + 1}`;
    this.imgs.push(img);
    return img;
  }

  /** The finished file. */
  build() {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = (part) => {
      const bytes = typeof part === 'string' ? enc.encode(part) : part;
      chunks.push(bytes);
      length += bytes.length;
    };
    const object = (id, body, stream = null) => {
      offsets[id] = length;
      push(`${id} 0 obj\n${body}\n`);
      if (stream) {
        push('stream\n');
        push(stream);
        push('\nendstream\n');
      }
      push('endobj\n');
    };

    // 1 catalog, 2 pages, 3 regular font, 4 bold font, 5 info, then images,
    // then each page and its content.
    const imageIds = new Map();
    let next = 6;
    for (const img of this.imgs) imageIds.set(img.name, next++);
    const pageIds = this.pages.map(() => {
      const ids = { page: next, content: next + 1 };
      next += 2;
      return ids;
    });

    push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, `<< /Type /Pages /Count ${this.pages.length} /Kids [${pageIds.map((p) => `${p.page} 0 R`).join(' ')}] >>`);
    object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    object(5, `<< /Title ${pdfString(winAnsi(this.title))} /Author ${pdfString(winAnsi(this.author))} /Producer (HIVE) >>`);

    for (const img of this.imgs) {
      const dict = [
        '/Type /XObject /Subtype /Image',
        `/Width ${img.width} /Height ${img.height}`,
        `/ColorSpace ${img.colorSpace}`,
        `/BitsPerComponent ${img.bits}`,
        `/Filter /${img.filter}`,
        img.decodeParms ? `/DecodeParms ${img.decodeParms}` : '',
        img.decode ? `/Decode ${img.decode}` : '',
        `/Length ${img.data.length}`,
      ].filter(Boolean).join(' ');
      object(imageIds.get(img.name), `<< ${dict} >>`, img.data);
    }

    this.pages.forEach((page, i) => {
      const { page: pid, content } = pageIds[i];
      const xobjects = [...page.images].map((n) => `/${n} ${imageIds.get(n)} 0 R`).join(' ');
      object(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] `
        + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> `
        + `/Contents ${content} 0 R >>`);
      const stream = enc.encode(page.ops.join('\n'));
      object(content, `<< /Length ${stream.length} >>`, stream);
    });

    const xref = length;
    const count = next;
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let id = 1; id < count; id += 1) table += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** Size and colour model from a JPEG's frame header; the bytes go in untouched. */
function jpegImage(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    // Any start-of-frame except the arithmetic-coded and the lossless ones,
    // which no reader expects to find in a PDF.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      const comps = b[i + 9];
      if (!width || !height) return null;
      return {
        width, height, bits: 8, filter: 'DCTDecode', data: b,
        colorSpace: comps === 1 ? '/DeviceGray' : comps === 4 ? '/DeviceCMYK' : '/DeviceRGB',
        // Adobe CMYK JPEGs are stored inverted.
        decode: comps === 4 ? '[1 0 1 0 1 0 1 0]' : null,
      };
    }
    i += 2 + len;
  }
  return null;
}

async function pngImage(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 8;
  let width = 0; let height = 0; let depth = 0; let type = 0; let interlace = 0;
  let palette = null;
  const idat = [];
  while (i + 8 <= b.length) {
    const len = view.getUint32(i);
    const name = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const data = b.subarray(i + 8, i + 8 + len);
    if (name === 'IHDR') {
      width = view.getUint32(i + 8); height = view.getUint32(i + 12);
      depth = b[i + 16]; type = b[i + 17]; interlace = b[i + 20];
    } else if (name === 'PLTE') palette = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    i += 12 + len;
  }
  if (!width || !height || !idat.length || interlace) return null;
  const packed = concat(idat);

  // The common cases go straight in: PDF reads PNG's own compressed rows.
  const colors = { 0: 1, 2: 3, 3: 1 }[type];
  if (colors && depth === 8) {
    return {
      width, height, bits: 8, filter: 'FlateDecode', data: packed,
      decodeParms: `<< /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${width} >>`,
      colorSpace: type === 3 && palette
        ? `[/Indexed /DeviceRGB ${palette.length / 3 - 1} <${hex(palette)}>]`
        : (type === 0 ? '/DeviceGray' : '/DeviceRGB'),
    };
  }

  // With transparency (or 16 bits): unpack, lay onto white, pack again.
  if (![4, 6].includes(type) && !(depth === 16 && [0, 2].includes(type))) return null;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  const bpp = channels * (depth / 8);
  const raw = await inflate(packed);
  const stride = width * bpp;
  const rows = unfilter(raw, height, stride, bpp);
  const outChannels = type === 0 || type === 4 ? 1 : 3;
  const out = new Uint8Array(width * height * outChannels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = rows.subarray(y * stride + x * bpp, y * stride + (x + 1) * bpp);
      const sample = (c) => px[c * (depth / 8)];
      const alpha = type === 4 ? sample(1) : type === 6 ? sample(3) : 255;
      for (let c = 0; c < outChannels; c += 1) {
        const v = sample(c);
        out[(y * width + x) * outChannels + c] = Math.round((v * alpha + 255 * (255 - alpha)) / 255);
      }
    }
  }
  return {
    width, height, bits: 8, filter: 'FlateDecode', data: await deflate(out),
    colorSpace: outChannels === 1 ? '/DeviceGray' : '/DeviceRGB',
  };
}

function unfilter(raw, height, stride, bpp) {
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const kind = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const up = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= bpp ? up[x - bpp] : 0;
      let v = src[x];
      if (kind === 1) v += a;
      else if (kind === 2) v += b;
      else if (kind === 3) v += (a + b) >> 1;
      else if (kind === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = v & 0xff;
    }
  }
  return out;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const hex = (bytes) => [...bytes].map((v) => v.toString(16).padStart(2, '0')).join('');
