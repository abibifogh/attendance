import { all, first, run } from '../lib/db.js';
import { badRequest, notFound, str } from '../lib/http.js';
import { getPepper, sign, timingSafeEqual, b64urlEncode, b64urlDecode } from '../lib/auth.js';

/**
 * Reports somebody made elsewhere, published here behind a PIN.
 *
 * A management report is a finished thing: a page of HTML and a chart library,
 * made by somebody who has already decided what it should say. This does not
 * touch it. It stores the exact bytes it was given and serves them back at a
 * fixed address to anybody who can type a four-digit PIN — and nothing else,
 * because "do not change anything" is a promise best kept by never decoding.
 *
 * Two decisions here are about the PIN rather than the report, and both are
 * about the same fact: four digits is ten thousand possibilities.
 *
 * **The PIN's real protection is the lock, not the hash.** Nothing slows down
 * ten thousand guesses offline. So guesses are counted by address and the door
 * locks after a few of them — and locks for everybody if the group as a whole
 * is being tried, which is what a distributed guess looks like from here.
 * The hash is still peppered, so a copy of the table on its own says nothing.
 *
 * **One PIN per reader.** A PIN is handed to a person and can be taken back
 * from that person without taking it back from everybody else. Two readers
 * may not share a PIN, because then the screen could not say who read what.
 *
 * The files are in the database and not in the repository. The repository is
 * public, and a PIN on a page whose source anybody can read on GitHub would be
 * theatre.
 */

const COOKIE = 'report_reader';
const READER_TTL = 12 * 60 * 60;
/** Wrong guesses from one address in the window before that address waits. */
const LOCK_AFTER = 5;
/** Wrong guesses from everywhere in the window before everybody waits. */
const LOCK_ALL_AFTER = 40;
const LOCK_MINUTES = 15;
/** A generous cap per file; D1 rows have a ceiling and this stays well under it. */
const MAX_FILE_BYTES = 1_500_000;
const RESERVED = new Set(['api', 'index.html', 'assets', 'static', 'favicon.ico']);
const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8', txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  woff: 'font/woff', woff2: 'font/woff2', ico: 'image/x-icon',
};

const now = () => new Date().toISOString();
const encoder = new TextEncoder();

// ------------------------------------------------------------------ reading --

/**
 * Serve a report, or the door in front of it.
 *
 * Called for every request that is not `/api/…` and is not an asset the Worker
 * already serves, before anything else gets a look. Answers null for a path
 * that is not a report, so the ordinary app is unaffected.
 */
export async function serve(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 1 || parts.length > 2 || parts[0] === 'api') return null;

  const slug = parts[0].toLowerCase();
  const report = await first(env.DB, 'SELECT slug, title FROM reports WHERE slug = ?1', slug);
  if (!report) return null;

  const rest = parts[1] ? decodeURIComponent(parts[1]) : '';

  if (request.method === 'POST' && rest === 'pin') return enterPin(request, env, report);
  if (request.method === 'GET' && rest === 'leave') {
    return new Response(null, { status: 303, headers: { Location: `/${slug}`, 'Set-Cookie': clearReader() } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  const reader = await currentReader(request, env);
  if (!reader) {
    // A file asked for without a session is a page asking for one, never the
    // file. But a script tag asking for chart.umd.js does not want a login
    // form back in place of JavaScript, so anything that is not the page
    // itself gets a plain refusal instead.
    if (rest) return new Response('A PIN is needed first', { status: 401, headers: noStore() });
    return pinPage(report, { status: 200 });
  }

  const name = rest || 'index.html';
  const file = await first(env.DB,
    'SELECT content_type, body FROM report_files WHERE slug = ?1 AND name = ?2', slug, name);
  if (!file) return new Response('No such file in this report', { status: 404, headers: noStore() });

  return new Response(request.method === 'HEAD' ? null : asBytes(file.body), {
    status: 200,
    headers: {
      'Content-Type': file.content_type,
      ...noStore(),
      // The page carries its own noindex; the header makes it true for the
      // chart library and anything else served alongside it.
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/** D1 hands a BLOB back as an ArrayBuffer; node:sqlite as a Uint8Array. */
function asBytes(body) {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (Array.isArray(body)) return Uint8Array.from(body);
  return encoder.encode(String(body));
}

const noStore = () => ({ 'Cache-Control': 'private, no-store' });

// --------------------------------------------------------------- the door --

async function enterPin(request, env, report) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const cutoff = new Date(Date.now() - LOCK_MINUTES * 60_000).toISOString();

  // Old guesses are forgotten as a side effect of every new one, so the table
  // never grows past a quarter of an hour of the world's curiosity.
  await run(env.DB, 'DELETE FROM report_pin_attempts WHERE at < ?1', cutoff);
  const mine = await first(env.DB,
    'SELECT COUNT(*) AS n FROM report_pin_attempts WHERE ip = ?1 AND at >= ?2', ip, cutoff);
  const everyone = await first(env.DB,
    'SELECT COUNT(*) AS n FROM report_pin_attempts WHERE at >= ?1', cutoff);

  // Checked before the PIN is even read. A locked door does not open for the
  // right key either — otherwise the lock only slows a guesser down until the
  // guess that happens to be correct.
  if (mine.n >= LOCK_AFTER || everyone.n >= LOCK_ALL_AFTER) {
    return pinPage(report, {
      status: 429,
      locked: true,
      error: `Too many wrong PINs. Wait ${LOCK_MINUTES} minutes and try again.`,
    });
  }

  let pin = '';
  try {
    const form = await request.formData();
    pin = String(form.get('pin') ?? '').trim();
  } catch {
    pin = '';
  }

  const match = /^\d{4}$/.test(pin) ? await pinMatching(env.DB, pin) : null;
  if (!match) {
    await run(env.DB, 'INSERT INTO report_pin_attempts (ip, at) VALUES (?1, ?2)', ip, now());
    const left = LOCK_AFTER - (mine.n + 1);
    return pinPage(report, {
      status: 401,
      error: left > 0
        ? `That is not a PIN that opens this. ${left} more ${left === 1 ? 'try' : 'tries'} before a ${LOCK_MINUTES}-minute wait.`
        : `That is not a PIN that opens this. Wait ${LOCK_MINUTES} minutes before trying again.`,
    });
  }

  await run(env.DB, 'DELETE FROM report_pin_attempts WHERE ip = ?1', ip);
  await run(env.DB,
    'UPDATE report_pins SET last_used_at = ?2, uses = uses + 1 WHERE id = ?1', match.id, now());

  const token = await readerToken(env, match.id);
  return new Response(null, {
    status: 303,
    headers: { Location: `/${report.slug}`, 'Set-Cookie': readerCookie(token), ...noStore() },
  });
}

/**
 * The active PIN this value belongs to, if any.
 *
 * Every active PIN is tried, not just a lookup, because the hashes are
 * peppered and salted and cannot be looked up. There are a handful of readers
 * and this costs a handful of HMACs.
 */
async function pinMatching(db, pin) {
  const pepper = await getPepper(db);
  const active = await all(db, 'SELECT id, salt, pin_hash FROM report_pins WHERE revoked_at IS NULL');
  let found = null;
  for (const row of active) {
    const hash = await hashPin(pin, row.salt, pepper);
    // Every row is checked even after a match, so the time taken does not say
    // which row matched.
    if (timingSafeEqual(hash, row.pin_hash) && !found) found = row;
  }
  return found;
}

async function hashPin(pin, salt, pepper) {
  return sign(`report-pin:${pepper}`, `${salt}:${pin}`);
}

// ------------------------------------------------------------ the session --

async function readerToken(env, pinId) {
  const payload = { pin: pinId, exp: Math.floor(Date.now() / 1000) + READER_TTL };
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await sign(readerSecret(env), body)}`;
}

/**
 * Who is reading, or null.
 *
 * The PIN itself is looked up on every request, so revoking one takes effect
 * on that reader's very next click and not when their cookie happens to run
 * out. That is the whole point of a PIN per person.
 */
async function currentReader(request, env) {
  const secret = readerSecret(env);
  if (!secret) return null;
  const token = cookieValue(request, COOKIE);
  if (!token || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature || !timingSafeEqual(await sign(secret, body), signature)) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (!payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  const pin = await first(env.DB,
    'SELECT id, label FROM report_pins WHERE id = ?1 AND revoked_at IS NULL', Number(payload.pin));
  return pin || null;
}

// Signed with the same secret as the dashboard's own sessions, under its own
// label so a reader token can never be mistaken for a dashboard one and the
// other way round.
const readerSecret = (env) => (env.SESSION_SECRET ? `reader:${env.SESSION_SECRET}` : null);

const readerCookie = (token) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${READER_TTL}`;
const clearReader = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function cookieValue(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

// ------------------------------------------------------------- the page --

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The door: Insight's mark, the report's name, four digits, one button.
 *
 * Drawn with the same tokens as the rest of Insight, in both themes, so the
 * person who was sent a link sees the thing they were told they would see.
 * The first version of this put its dark-mode rule above the rule it was
 * meant to override, so in the dark the card stayed white while the text went
 * pale: a title nobody could read over a black box. Tokens, declared once and
 * swapped once, cannot be ordered wrongly.
 *
 * No script. A page that exists to be simple should not need one.
 */
function pinPage(report, { status = 200, error = '', locked = false } = {}) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>${escape(report.title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --plane: #f9f9f7; --surface: #fcfcfb; --surface-2: #f2f1ed;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --border: rgba(11, 11, 11, .10); --accent: #2a78d6; --accent-ink: #ffffff;
    --critical: #d03b3b; --shadow: 0 10px 30px rgba(11, 11, 11, .06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --plane: #0d0d0d; --surface: #1a1a19; --surface-2: #232322;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --border: rgba(255, 255, 255, .12); --accent: #3987e5;
      --critical: #e66767; --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center;
    padding: 1rem; font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
    background: var(--plane); color: var(--ink);
  }
  .card {
    width: min(23rem, 100%); padding: 1.75rem; border: 1px solid var(--border);
    border-radius: 14px; background: var(--surface); box-shadow: var(--shadow);
  }
  .brand { display: flex; align-items: center; gap: .55rem; margin-bottom: 1.25rem;
           font-size: .78rem; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
  .brand svg { width: 22px; height: 22px; flex: none; }
  h1 { font-size: 1.2rem; line-height: 1.3; font-weight: 650; margin: 0 0 .35rem; color: var(--ink); letter-spacing: -.01em; }
  p.sub { margin: 0 0 1.35rem; color: var(--ink-2); font-size: .92rem; }
  label { display: block; font-size: .78rem; color: var(--ink-2); margin-bottom: .4rem; }
  input {
    width: 100%; font: inherit; font-size: 1.9rem; line-height: 1; font-variant-numeric: tabular-nums;
    letter-spacing: .55em; text-indent: .55em; text-align: center; padding: .7rem .5rem;
    color: var(--ink); background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px;
    outline: none; -webkit-appearance: none; appearance: none;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent); }
  input:disabled { opacity: .5; }
  button {
    width: 100%; margin-top: .9rem; min-height: 46px; font: inherit; font-weight: 600; font-size: .98rem;
    border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-ink); cursor: pointer;
  }
  button:hover:not([disabled]) { filter: brightness(1.06); }
  button[disabled] { opacity: .45; cursor: default; }
  .err { display: flex; gap: .55rem; align-items: flex-start; margin: .9rem 0 0; padding: .6rem .75rem;
         border-left: 3px solid var(--critical); border-radius: 8px; background: var(--surface-2);
         color: var(--ink); font-size: .9rem; }
  .err b { color: var(--critical); flex: none; }
  .foot { margin: 1.25rem 0 0; font-size: .78rem; color: var(--muted); }
</style>
</head>
<body>
<form class="card" method="post" action="/${escape(report.slug)}/pin" autocomplete="off">
  <div class="brand">
    <svg viewBox="0 0 24 24" role="img" aria-label="Insight"><rect x="2.5" y="13.5" width="3.6" height="8" rx="1.4" fill="#2a78d6"/><rect x="8.1" y="9" width="3.6" height="12.5" rx="1.4" fill="#eda100"/><rect x="13.7" y="11.2" width="3.6" height="10.3" rx="1.4" fill="#1baf7a"/><rect x="19.3" y="4.5" width="3.6" height="17" rx="1.4" fill="#eb6834"/></svg>
    <span>Nice Operation · Insight</span>
  </div>
  <h1>${escape(report.title)}</h1>
  <p class="sub">This report is for a small number of people. Enter the PIN you were given.</p>
  <label for="pin">Your PIN</label>
  <input id="pin" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" minlength="4"
         autocomplete="one-time-code" autofocus required ${locked ? 'disabled' : ''}>
  <button type="submit" ${locked ? 'disabled' : ''}>Open the report</button>
  ${error ? `<p class="err" role="alert"><b>!</b><span>${escape(error)}</span></p>` : ''}
  <p class="foot">Four digits, given to you personally. If you don’t have one, ask whoever sent you this link.</p>
</form>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...noStore(), 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

// ------------------------------------------------------------ publishing --

/** Every report and every reader, for the owner's screen. Never the bodies. */
export async function list(env) {
  const reports = await all(env.DB, 'SELECT slug, title, published_at, published_by FROM reports ORDER BY published_at DESC');
  const files = await all(env.DB, 'SELECT slug, name, content_type, bytes FROM report_files ORDER BY slug, name');
  const pins = await all(env.DB,
    'SELECT id, label, created_at, last_used_at, uses, revoked_at FROM report_pins ORDER BY revoked_at IS NOT NULL, label');
  return {
    reports: reports.map((r) => ({
      slug: r.slug, title: r.title, publishedAt: r.published_at,
      files: files.filter((f) => f.slug === r.slug).map((f) => ({ name: f.name, contentType: f.content_type, bytes: f.bytes })),
    })),
    pins: pins.map((p) => ({
      id: p.id, label: p.label, createdAt: p.created_at, lastUsedAt: p.last_used_at,
      uses: p.uses, revokedAt: p.revoked_at,
    })),
  };
}

/**
 * Publish: a title, an address, and the files as they are.
 *
 * Multipart, because the files are files. Whichever of them is called
 * index.html — or, failing that, the first .html — is the page; the rest are
 * served beside it under their own names. Publishing to an address that
 * already exists replaces the files of the same name and leaves the others,
 * so a chart library uploaded once does not have to be uploaded every time
 * the page changes.
 */
export async function publish(env, request, account) {
  let form;
  try {
    form = await request.formData();
  } catch {
    throw badRequest('Expected files in a multipart form');
  }

  const slug = String(form.get('slug') ?? '').trim().toLowerCase();
  if (!SLUG.test(slug)) {
    throw badRequest('The address must be 2–64 characters of letters, digits and hyphens, starting with a letter or digit');
  }
  if (RESERVED.has(slug)) throw badRequest(`"${slug}" is a part of this app and cannot be a report`);

  const title = str(form.get('title'), 'Title', { max: 160, required: true });

  const uploads = form.getAll('files').filter((f) => f && typeof f === 'object' && 'arrayBuffer' in f);
  if (!uploads.length) throw badRequest('Choose at least one file — the report itself');

  const existing = await first(env.DB, 'SELECT slug FROM reports WHERE slug = ?1', slug);
  const hasPage = existing && await first(env.DB,
    "SELECT name FROM report_files WHERE slug = ?1 AND name = 'index.html'", slug);

  // Which upload is the page. Named index.html wins; otherwise the first HTML.
  let page = uploads.find((f) => f.name.toLowerCase() === 'index.html')
    || uploads.find((f) => /\.html?$/i.test(f.name));
  if (!page && !hasPage) throw badRequest('One of the files has to be the page: an .html file');

  const stored = [];
  for (const file of uploads) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw badRequest(`${file.name} is ${Math.round(bytes.byteLength / 1024)} KB; the most a file can be is ${Math.round(MAX_FILE_BYTES / 1024)} KB`);
    }
    if (!bytes.byteLength) throw badRequest(`${file.name} is empty`);
    const name = file === page ? 'index.html' : safeName(file.name);
    const type = contentTypeFor(name, file.type);
    stored.push({ name, type, bytes });
  }

  if (!existing) {
    await run(env.DB, 'INSERT INTO reports (slug, title, published_at, published_by) VALUES (?1, ?2, ?3, ?4)',
      slug, title, now(), account?.id ?? null);
  } else {
    await run(env.DB, 'UPDATE reports SET title = ?2, published_at = ?3, published_by = ?4 WHERE slug = ?1',
      slug, title, now(), account?.id ?? null);
  }
  for (const f of stored) {
    await run(env.DB, `
      INSERT INTO report_files (slug, name, content_type, bytes, body) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (slug, name) DO UPDATE SET content_type = ?3, bytes = ?4, body = ?5`,
      slug, f.name, f.type, f.bytes.byteLength, f.bytes);
  }

  return { ...(await list(env)), published: { slug, files: stored.map((f) => f.name) } };
}

/** A file name a browser could have asked for: no paths, no surprises. */
function safeName(name) {
  const base = String(name).split(/[\\/]/).pop().trim();
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '');
  if (!clean || clean.length > 120) throw badRequest(`"${base}" is not a usable file name`);
  return clean;
}

function contentTypeFor(name, given) {
  const ext = name.split('.').pop().toLowerCase();
  return TYPES[ext] || (given && !given.startsWith('text/html') ? given : 'application/octet-stream');
}

export async function remove(env, slug) {
  const s = String(slug).toLowerCase();
  const existing = await first(env.DB, 'SELECT slug FROM reports WHERE slug = ?1', s);
  if (!existing) throw notFound('No such report');
  await run(env.DB, 'DELETE FROM report_files WHERE slug = ?1', s);
  await run(env.DB, 'DELETE FROM reports WHERE slug = ?1', s);
  return list(env);
}

export async function removeFile(env, slug, name) {
  const s = String(slug).toLowerCase();
  if (name === 'index.html') throw badRequest('The page itself cannot be removed on its own — remove the report');
  const r = await run(env.DB, 'DELETE FROM report_files WHERE slug = ?1 AND name = ?2', s, name);
  if (!r?.meta?.changes) throw notFound('No such file');
  return list(env);
}

// ---------------------------------------------------------------- readers --

/**
 * A PIN for one named person.
 *
 * Shown once, in the answer, and never again: it is stored only as a hash.
 * Given a PIN, that one is used; given none, four random digits. A PIN that
 * another active reader already has is refused, because two people on one
 * PIN is one person as far as this screen can tell.
 */
export async function createPin(env, body, account) {
  const label = str(body?.label, 'Name', { max: 80, required: true });
  let pin = String(body?.pin ?? '').trim();
  if (pin && !/^\d{4}$/.test(pin)) throw badRequest('A PIN is exactly four digits');
  if (!pin) pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');

  if (await pinMatching(env.DB, pin)) {
    throw badRequest(body?.pin
      ? 'Somebody already has that PIN. Choose another, so the two of you can be told apart.'
      : 'Try again — the PIN that was generated is already in use.');
  }

  const salt = b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
  const pepper = await getPepper(env.DB);
  const hash = await hashPin(pin, salt, pepper);
  const row = await first(env.DB, `
    INSERT INTO report_pins (label, salt, pin_hash, created_at, created_by)
    VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`, label, salt, hash, now(), account?.id ?? null);

  return { ...(await list(env)), made: { id: row.id, label, pin } };
}

export async function revokePin(env, id) {
  const r = await run(env.DB,
    'UPDATE report_pins SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL', Number(id), now());
  if (!r?.meta?.changes) throw notFound('No such active PIN');
  return list(env);
}
