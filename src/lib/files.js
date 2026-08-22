// Holding a file in a database that will not take one whole.
//
// D1 refuses a row larger than about two megabytes, and the files this app is
// asked to keep — a scanned five-page contract, a letter photographed on a
// phone — are routinely more. A photograph can be shrunk in the browser before
// it is sent; a PDF cannot, and refusing it would send the paperwork back to a
// filing cabinet.
//
// So a file is stored in pieces. The pure part of that is here, shared by the
// personnel documents and the correspondence files, because splitting and
// rejoining a byte array is exactly the sort of thing that is written twice and
// gets an off-by-one in one of the copies.

/** Small enough to be well inside the row limit with the metadata beside it. */
export const CHUNK = 700_000;

/** Generous enough for a scanned contract, small enough that one upload
 *  cannot fill the database. */
export const MAX_FILE = 12_000_000;

/** How many pieces a file of this size takes. Always at least one. */
export const partsFor = (length) => Math.max(1, Math.ceil(length / CHUNK));

/** The pieces, in order. */
export function splitIntoChunks(bytes) {
  const out = [];
  for (let at = 0; at < bytes.length; at += CHUNK) out.push(bytes.subarray(at, at + CHUNK));
  return out.length ? out : [bytes.subarray(0, 0)];
}

/** The pieces put back together. */
export function joinChunks(chunks) {
  const list = chunks.map(asBytes).filter(Boolean);
  const total = list.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of list) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/**
 * Bytes, out of whatever shape the driver felt like handing back.
 *
 * THIS IS NOT DEFENSIVENESS, IT IS A BUG THAT COST US EVERY STORED FILE. D1's
 * own documentation says a BLOB column comes back as an ArrayBuffer. It does
 * not: it comes back as a plain array of numbers, and has done for years
 * (cloudflare/workers-sdk#8642). Returning null for that shape meant every
 * file this app keeps — a logo, a letterhead, a scanned contract, a receipt —
 * was served as an empty body with the right content type, which a browser
 * draws as a broken image and never explains.
 *
 * It passed every test, because `node:sqlite` hands back a Uint8Array like a
 * reasonable person. The lesson is in the list below rather than in a comment
 * anywhere else: accept all four, and never trust one driver's shape.
 */
export function asBytes(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // Any other view over a buffer — a Buffer under Node, a DataView.
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  // What D1 actually gives you.
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}

/** Bytes out of whatever the browser sent, data-URI prefix and all. */
export function fromBase64(value) {
  const clean = String(value ?? '').replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  if (!clean) return new Uint8Array(0);

  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** The fingerprint of a file, so a swapped one can be told from the filed one. */
export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** How big it is, in the words somebody would use about it. */
export function sizeOf(bytes) {
  const n = typeof bytes === 'number' ? bytes : (bytes?.length ?? 0);
  if (n < 1000) return `${n} bytes`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}
