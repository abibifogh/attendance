/**
 * An email, as Cloudflare hands it over, taken apart: who it is from, its
 * subject, its plain text, and its attachments (base64, as Odoo and the
 * reader want them).
 *
 * Only what receipts need: nested multiparts, base64 and quoted-printable,
 * encoded subjects and file names. Nothing here throws on an odd email: what
 * cannot be read is left out.
 */

const latin1 = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
};
const bytesOf = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
const utf8 = (bytes, charset = 'utf-8') => {
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
};
export const toBase64 = (bytes) => btoa(latin1(bytes));

/** Quoted-printable to bytes. */
function fromQp(text) {
  const clean = text.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(clean.slice(i + 1, i + 3))) { out.push(parseInt(clean.slice(i + 1, i + 3), 16)); i += 2; } else out.push(clean.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
}

/** "=?utf-8?B?...?=" and "=?utf-8?Q?...?=" in a header, as text. */
export function decodeWords(value) {
  const text = String(value || '').replace(/\?=\s+=\?/g, '?==?');
  return text.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, data) => {
    try {
      const bytes = enc.toUpperCase() === 'B' ? bytesOf(atob(data)) : fromQp(data.replace(/_/g, ' '));
      return utf8(bytes, charset.toLowerCase());
    } catch { return data; }
  });
}

/** Headers as a map of lower-case names to their (unfolded) values; the first of each. */
function readHeaders(block) {
  const out = new Map();
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(at + 1).trim());
  }
  return out;
}

/** `text/plain; charset="utf-8"; name*=utf-8''r%C3%A9.pdf` → { value, params }. */
export function parseParams(value) {
  const parts = String(value || '').split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params = {};
  for (const p of parts.slice(1)) {
    const at = p.indexOf('=');
    if (at < 0) continue;
    let key = p.slice(0, at).trim().toLowerCase();
    let v = p.slice(at + 1).trim().replace(/^"(.*)"$/s, '$1');
    if (key.endsWith('*')) {
      key = key.replace(/\*\d*\*?$/, '');
      const m = v.match(/^([^']*)'[^']*'(.*)$/);
      try { v = m ? utf8(bytesOf(unescape(m[2])), m[1].toLowerCase() || 'utf-8') : decodeURIComponent(v); } catch { /* as it is */ }
      params[key] = (params[key] && !m ? params[key] : '') + v;
    } else if (/\*\d+$/.test(key)) {
      key = key.replace(/\*\d+$/, '');
      params[key] = (params[key] || '') + v;
    } else params[key] = decodeWords(v);
  }
  return { value: parts[0].trim().toLowerCase(), params };
}

/** An address out of "Michael <michael@example.com>", lower case. */
export function addressOf(value) {
  const text = String(value || '');
  const m = text.match(/<([^>]+)>/) || text.match(/([^\s<>"',;]+@[^\s<>"',;]+)/);
  return m ? m[1].trim().toLowerCase() : '';
}

/** A part's body, decoded to bytes. */
function bodyBytes(raw, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') {
    try { return bytesOf(atob(raw.replace(/[^A-Za-z0-9+/=]/g, ''))); } catch { return new Uint8Array(); }
  }
  if (enc === 'quoted-printable') return fromQp(raw);
  return bytesOf(raw);
}

function walk(raw, out, depth = 0) {
  if (depth > 8) return;
  const split = raw.search(/\r?\n\r?\n/);
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers = readHeaders(head);
  const type = parseParams(headers.get('content-type') || 'text/plain');
  if (type.value.startsWith('multipart/') && type.params.boundary) {
    const marker = `--${type.params.boundary}`;
    const pieces = body.split(marker);
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith('--')) break;
      walk(piece.replace(/^\r?\n/, ''), out, depth + 1);
    }
    return;
  }
  if (type.value === 'message/rfc822') { walk(body, out, depth + 1); return; }
  const disposition = parseParams(headers.get('content-disposition') || '');
  const name = disposition.params.filename || type.params.name || '';
  const encoding = headers.get('content-transfer-encoding');
  if (type.value === 'text/plain' && disposition.value !== 'attachment' && !name) {
    out.text.push(utf8(bodyBytes(body, encoding), type.params.charset));
    return;
  }
  if (type.value === 'text/html' && disposition.value !== 'attachment' && !name) {
    out.html.push(utf8(bodyBytes(body, encoding), type.params.charset));
    return;
  }
  const bytes = bodyBytes(body, encoding);
  out.files.push({
    name: decodeWords(name) || '', type: type.value === 'application/octet-stream' ? guessType(name) : type.value,
    inline: disposition.value === 'inline' || (!disposition.value && Boolean(headers.get('content-id'))),
    size: bytes.length, data: toBase64(bytes),
  });
}

/** What an attachment sent as "octet-stream" is, from its name. */
function guessType(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' }[ext] || 'application/octet-stream';
}

/**
 * The email, read. `raw` is its bytes (an ArrayBuffer or Uint8Array) or text.
 * Returns { from, subject, text, files: [{ name, type, inline, size, data }] }.
 */
export function readEmail(raw) {
  const text = typeof raw === 'string' ? raw : latin1(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
  const out = { text: [], html: [], files: [] };
  const split = text.search(/\r?\n\r?\n/);
  const headers = readHeaders(split < 0 ? text : text.slice(0, split));
  walk(text, out);
  const plain = out.text.join('\n').trim()
    || out.html.join('\n').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();
  return {
    from: addressOf(headers.get('from')),
    fromName: decodeWords(String(headers.get('from') || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim()),
    subject: decodeWords(headers.get('subject') || '').trim(),
    authentication: [headers.get('authentication-results'), headers.get('arc-authentication-results')].filter(Boolean).join(' ; '),
    text: plain,
    files: out.files,
  };
}
