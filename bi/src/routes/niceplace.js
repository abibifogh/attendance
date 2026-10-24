import { all, first, run, setSetting, getSettings } from '../lib/db.js';
import { badRequest, HttpError, str } from '../lib/http.js';
import { addDays, isDay, todayIn, daysBetween } from '../lib/dates.js';

/**
 * Nice Place, the public washroom.
 *
 * Four door counters: GB gents bath, GT gents toilet, LB ladies bath, LT
 * ladies toilet. Each counts a movement, so a person going in and out is 2.
 * They keep adding up. At the end of each shift (day and night) a member of
 * staff opens an open link, chooses their name, takes a picture of the
 * counters and types the four numbers. Once a month the income workbook is
 * uploaded: per date and shift, adults and children in GH₵, for the toilets
 * and for the showers apart, and who was on.
 *
 * A visitor pays for each: the toilet once, the shower once. So the toilet
 * counters (GT + LT) are held against the toilet's money and the bath
 * counters (GB + LB) against the shower's. Between two readings, half the
 * movements are people; staff and cleaners walk through too (an allowance per
 * counter per shift). Every paying person paid at least the child's price and
 * at most the adult's: the money has to fall in between, and the people the
 * workbook says paid (adults' money ÷ the adult price, plus children's money
 * ÷ the child price) should come close to the people counted.
 */

export const SHIFTS = ['day', 'night'];
export const COUNTERS = ['gb', 'gt', 'lb', 'lt'];
export const FACILITIES = { toilet: ['gt', 'lt'], shower: ['gb', 'lb'] };
const KEY = 'np_settings';
const DEFAULTS = { token: null, allowance: 10, adult: 300, child: 100, layout: '' };
/** Cloudflare Workers AI's model for reading the counters off a picture. */
export const READ_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
/** How long after sending a reading the same person may send it again. */
const RESEND_MINUTES = 60;
/** The largest picture taken, base64 (the page shrinks it first). */
const PHOTO_MAX = 2_000_000;

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const order = (day, shift) => `${day}|${shift === 'day' ? 0 : 1}`;
const nextShift = (day, shift) => (shift === 'day' ? { day, shift: 'night' } : { day: addDays(day, 1), shift: 'day' });

export async function settingsOf(env) {
  const row = (await getSettings(env.DB))[KEY];
  let saved = {};
  try { saved = JSON.parse(row || '{}'); } catch { saved = {}; }
  return { ...DEFAULTS, ...saved };
}

/** Same length and same characters, without stopping at the first difference. */
function same(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

async function linkSettings(env, token) {
  const s = await settingsOf(env);
  if (!s.token || !token || !same(token, s.token)) throw new HttpError(404, 'This link is no longer in use. Ask the manager for the new one.');
  return s;
}

const staffNames = async (env) => (await all(env.DB, 'SELECT name FROM np_staff WHERE active = 1 ORDER BY name')).map((r) => r.name);

/** The shift to suggest: the one after the last reading sent, or by the time of day. */
export function suggest(last, at = new Date()) {
  const today = at.toISOString().slice(0, 10);
  if (last) {
    const next = nextShift(last.day, last.shift);
    if (next.day >= addDays(today, -1) && next.day <= today) return next;
  }
  const hour = at.getUTCHours();
  if (hour < 6) return { day: addDays(today, -1), shift: 'night' };
  return { day: today, shift: hour < 18 ? 'day' : 'night' };
}

// ------------------------------------------------------------ the open link --

/** What the page on the open link needs: the names and the shift to suggest. */
export async function linkForm(env, query) {
  await linkSettings(env, query?.t);
  const last = await first(env.DB, "SELECT day, shift, name, sent_at FROM np_reading ORDER BY day DESC, CASE shift WHEN 'night' THEN 1 ELSE 0 END DESC LIMIT 1");
  return { staff: await staffNames(env), suggest: suggest(last), today: todayIn('UTC') };
}

const count = (value, label) => {
  const text = String(value ?? '').replace(/[\s,]/g, '');
  const n = text === '' ? NaN : Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 99_999_999) throw badRequest(`${label}: type the number on the counter, whole, with no letters.`);
  return n;
};

/** A reading sent from the open link, with its picture. */
export async function sendReading(env, body) {
  await linkSettings(env, body?.t);
  const name = str(body?.name, 'Your name', { required: true, max: 80 });
  if (!(await staffNames(env)).includes(name)) throw badRequest('Choose your name from the list.');
  const day = String(body?.day || '');
  const shift = String(body?.shift || '');
  const today = todayIn('UTC');
  if (!isDay(day) || day < addDays(today, -2) || day > today) throw badRequest('Choose the date of the shift: today, or the day before.');
  if (!SHIFTS.includes(shift)) throw badRequest('Choose the shift: day or night.');
  const photo = String(body?.photo || '');
  const m = photo.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw badRequest('Take a picture of the counters first.');
  if (m[2].length > PHOTO_MAX) throw badRequest('That picture is too large. Take it again.');
  // The numbers come from the picture only, never typed. A counter the page
  // could not read is read once more now; one still not read is left empty
  // for an admin or a supervisor to read off the picture.
  const s = await settingsOf(env);
  const read = await readAgain(env, m[2], photo, s.layout);
  const values = Object.fromEntries(COUNTERS.map((c) => [c, read?.[c] ?? null]));
  const pending = COUNTERS.filter((c) => values[c] == null);

  const was = await first(env.DB, 'SELECT * FROM np_reading WHERE day = ?1 AND shift = ?2', day, shift);
  if (was) {
    if (was.edited_by) throw new HttpError(409, 'The manager has already corrected this shift’s numbers. Ask them to change it.');
    const minutes = (Date.parse(`${now().replace(' ', 'T')}Z`) - Date.parse(`${was.sent_at.replace(' ', 'T')}Z`)) / 60000;
    if (minutes > RESEND_MINUTES) throw new HttpError(409, `This shift was sent at ${was.sent_at.slice(11, 16)}. To change it now, ask the manager.`);
  }
  const at = now();
  const photoId = (await first(env.DB, 'INSERT INTO np_photo (type, data, at) VALUES (?1, ?2, ?3) RETURNING id', m[1], m[2], at)).id;
  if (was?.photo_id) await run(env.DB, 'DELETE FROM np_photo WHERE id = ?1', was.photo_id);
  await run(env.DB, `INSERT INTO np_reading (day, shift, name, gb, gt, lb, lt, photo_id, sent_at, at, read_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)
    ON CONFLICT (day, shift) DO UPDATE SET name = ?3, gb = ?4, gt = ?5, lb = ?6, lt = ?7, photo_id = ?8, at = ?9, checked_by = NULL, checked_at = NULL, read_json = ?10`,
  day, shift, name, values.gb, values.gt, values.lb, values.lt, photoId, at, JSON.stringify(read || { unavailable: true }));
  return { ok: true, sentAt: was?.sent_at || at, resendUntil: RESEND_MINUTES, replaced: Boolean(was), values, pending };
}

/** A reading still missing a counter: what the reader could not see. */
const COMPLETE = 'gb IS NOT NULL AND gt IS NOT NULL AND lb IS NOT NULL AND lt IS NOT NULL';
const isComplete = (r) => COUNTERS.every((c) => r[c] != null);

// ----------------------------------------------- reading the picture itself --

/** A reading against what its picture was read as: which typed numbers differ, which were not read. */
function readCompare(reading) {
  let read = null;
  try { read = reading.read_json ? JSON.parse(reading.read_json) : null; } catch { read = null; }
  if (!read || reading.edited_by) return { read: null, differs: [], unread: [], typed: false };
  // Sent, before readings could wait for review, when the picture could not be
  // read automatically: the numbers were typed.
  if (read.unavailable) return { read: null, differs: [], unread: [], typed: isComplete(reading) };
  return {
    read,
    typed: false,
    differs: COUNTERS.filter((c) => read[c] != null && read[c] !== reading[c]),
    unread: COUNTERS.filter((c) => read[c] == null),
  };
}

const LABEL = { gb: 'GB', gt: 'GT', lb: 'LB', lt: 'LT' };

async function fingerprint(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readPrompt(layout, again = null) {
  return [
    again?.length ? `${again.map((c) => LABEL[c]).join(' and ')} could not be read the first time. Look again, closely, at ${again.length === 1 ? 'that counter' : 'those counters'}: zoom in on each digit.` : null,
    'This photo should show four people counters at a public washroom: GB (gents bath), GT (gents toilet), LB (ladies bath) and LT (ladies toilet).',
    layout ? `How they are laid out: ${layout}` : 'Each counter has its label (GB, GT, LB or LT) on it or beside it.',
    'Read the number each counter shows, digit by digit, exactly as displayed.',
    'Leading zeros are part of the number (00001 is 1). Give a counter as "" (empty) if it is not in the photo, you cannot tell which counter it is, or any of its digits is blurred, cut off, covered, reflected, too small or uncertain. Never guess a digit: empty is the right answer whenever you are not sure.',
    'Answer with JSON only, no other words: {"GB": "digits", "GT": "digits", "LB": "digits", "LT": "digits", "problem": "..."}.',
    'In "problem", say in a few plain words what made any counter unreadable (for example "GB is cut off at the left", "glare on LT"), or "" if all four are clear.',
  ].filter(Boolean).join('\n');
}

/** The reader's answer as four counters (null where it could not read one) and what was wrong. */
export function parseRead(result) {
  let raw = result?.response ?? result;
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/);
    try { raw = m ? JSON.parse(m[0]) : null; } catch { raw = null; }
  }
  if (!raw || typeof raw !== 'object') return null;
  const pick = (k) => {
    const v = raw[LABEL[k]] ?? raw[k];
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/[\s,]/g, ''));
    return Number.isInteger(n) && n >= 0 && n <= 99_999_999 ? n : null;
  };
  return { gb: pick('gb'), gt: pick('gt'), lb: pick('lb'), lt: pick('lt'), problem: String(raw.problem || '').slice(0, 300) };
}

/**
 * Ask the reader about a picture: first for an answer in a fixed JSON shape,
 * then, if that is refused, for plain text holding the same JSON. Every
 * failure is kept, word for word, so an admin can see why a picture was not
 * read. Returns the counters (null where not read) or null.
 */
async function askReader(env, photo, layout, again = null) {
  const messages = [
    { role: 'system', content: 'You read numbers off photos of counters for a washroom manager. You never guess: an unclear digit leaves that counter empty.' },
    { role: 'user', content: [{ type: 'text', text: readPrompt(layout, again) }, { type: 'image_url', image_url: { url: photo } }] },
  ];
  const attempts = [
    // Digits as text: a schema every JSON mode accepts, and "" says not read.
    { response_format: { type: 'json_schema', json_schema: {
      type: 'object',
      properties: { GB: { type: 'string' }, GT: { type: 'string' }, LB: { type: 'string' }, LT: { type: 'string' }, problem: { type: 'string' } },
      required: ['GB', 'GT', 'LB', 'LT', 'problem'],
    } } },
    {},
  ];
  const errors = [];
  let raw = null;
  for (const extra of attempts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await env.AI.run(READ_MODEL, { messages, max_tokens: 300, temperature: 0, ...extra });
      raw = typeof result?.response === 'string' ? result.response : JSON.stringify(result?.response ?? result);
      const read = parseRead(result);
      if (read) return { read, errors, raw };
      errors.push(`Answer not understood: ${String(raw).slice(0, 200)}`);
    } catch (err) {
      errors.push(String(err?.message || err).slice(0, 300));
    }
  }
  return { read: null, errors, raw };
}

/** The last time a picture was read, or not, and why: for the manager. */
async function noteRead(env, outcome) {
  try { await setSetting(env.DB, 'np_read_last', JSON.stringify({ at: now(), ...outcome })); } catch { /* the reading stands either way */ }
}

/**
 * Read the four counters off a picture from the open link, so the numbers
 * fill in by themselves. A counter not read for certain comes back null: the
 * page offers a new picture, or sending this one as it is. The same picture
 * is read once here; sending it reads what was missed once more.
 */
export async function readCounters(env, body) {
  const s = await linkSettings(env, body?.t);
  const photo = String(body?.photo || '');
  const m = photo.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw badRequest('Take a picture of the counters first.');
  if (m[2].length > PHOTO_MAX) throw badRequest('That picture is too large. Take it again.');
  if (!env.AI) { await noteRead(env, { ok: false, errors: ['The reader (Workers AI) is not bound to this Worker.'] }); return { available: false }; }
  const hash = await fingerprint(m[2]);
  let row = await first(env.DB, 'SELECT * FROM np_read WHERE hash = ?1', hash).catch(() => null);
  if (!row) {
    const { read, errors, raw } = await askReader(env, photo, s.layout);
    await noteRead(env, { ok: Boolean(read), errors, raw: raw ? String(raw).slice(0, 500) : null });
    if (errors.length) console.error('Nice Place: reading a picture', errors);
    // Not answering, or not in a shape that can be trusted: the numbers are typed instead.
    if (!read) return { available: false };
    row = { hash, ...read, model: READ_MODEL, at: now() };
    await run(env.DB, `INSERT INTO np_read (hash, gb, gt, lb, lt, problem, model, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT (hash) DO NOTHING`, hash, row.gb, row.gt, row.lb, row.lt, row.problem, row.model, row.at).catch(() => null);
  }
  const values = Object.fromEntries(COUNTERS.map((c) => [c, row[c] ?? null]));
  // Lower than the last reading: a misread, or a counter reset. Said, not refused.
  const last = await first(env.DB, `SELECT * FROM np_reading WHERE ${COMPLETE} ORDER BY day DESC, CASE shift WHEN 'night' THEN 1 ELSE 0 END DESC LIMIT 1`).catch(() => null);
  return {
    available: true,
    values,
    unreadable: COUNTERS.filter((c) => values[c] == null),
    problem: row.problem || '',
    lower: last ? COUNTERS.filter((c) => values[c] != null && values[c] < last[c]).map((c) => ({ counter: c, was: last[c], now: values[c] })) : [],
  };
}

/** An admin tries the reader on a picture: what it read, or exactly why not. Nothing is kept but the note. */
export async function readTest(env, body) {
  const photo = String(body?.photo || '');
  if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) throw badRequest('Choose a picture.');
  if (photo.length > PHOTO_MAX + 40) throw badRequest('That picture is too large.');
  if (!env.AI) return { ok: false, errors: ['The reader (Workers AI) is not bound to this Worker.'], raw: null };
  const s = await settingsOf(env);
  const { read, errors, raw } = await askReader(env, photo, s.layout);
  await noteRead(env, { ok: Boolean(read), errors, raw: raw ? String(raw).slice(0, 500) : null, test: true });
  return { ok: Boolean(read), read, errors, raw: raw ? String(raw).slice(0, 1000) : null, model: READ_MODEL };
}

/**
 * What a picture is read as, asking the reader again for any counter not read
 * before (or for all four, if it was never read). What is read now fills only
 * what was missing, and is kept for the picture. Null when the reader cannot
 * be reached and the picture was never read.
 */
async function readAgain(env, data, photo, layout) {
  const hash = await fingerprint(data);
  const row = await first(env.DB, 'SELECT * FROM np_read WHERE hash = ?1', hash).catch(() => null);
  const had = row ? Object.fromEntries(COUNTERS.map((c) => [c, row[c] ?? null])) : null;
  const missing = COUNTERS.filter((c) => had?.[c] == null);
  if (!missing.length || !env.AI) return had;
  const { read, errors, raw } = await askReader(env, photo, layout, had ? missing : null);
  await noteRead(env, { ok: Boolean(read), errors, raw: raw ? String(raw).slice(0, 500) : null, again: Boolean(had) });
  if (errors.length) console.error('Nice Place: reading a picture again', errors);
  if (!read) return had;
  const values = Object.fromEntries(COUNTERS.map((c) => [c, had?.[c] ?? read[c] ?? null]));
  const problem = COUNTERS.some((c) => values[c] == null) ? (read.problem || row?.problem || '') : '';
  await run(env.DB, `INSERT INTO np_read (hash, gb, gt, lb, lt, problem, model, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT (hash) DO UPDATE SET gb = ?2, gt = ?3, lb = ?4, lt = ?5, problem = ?6, model = ?7, at = ?8`,
  hash, values.gb, values.gt, values.lb, values.lt, problem, READ_MODEL, now()).catch(() => null);
  return values;
}

/** What made a picture hard to read, in the reader's words, if it said. */
async function problemOf(env, data) {
  const row = await first(env.DB, 'SELECT problem FROM np_read WHERE hash = ?1', await fingerprint(data)).catch(() => null);
  return row?.problem || '';
}

// ------------------------------------------------- readings waiting for review --

/** Which shift, and its reading with its picture: for reading the counters off it here. */
async function pendingOne(env, body) {
  const day = String(body?.day || '');
  const shift = String(body?.shift || '');
  if (!isDay(day) || !SHIFTS.includes(shift)) throw badRequest('Which shift?');
  const was = await first(env.DB, 'SELECT * FROM np_reading WHERE day = ?1 AND shift = ?2', day, shift);
  if (!was) throw new HttpError(404, 'No reading for this shift.');
  return was;
}

/**
 * Readings sent with a counter that could not be read: for an admin, or a
 * supervisor given Nice Place, to read off the picture. With the reading
 * before, so a number far off it stands out.
 */
export async function pendingReadings(env) {
  const rows = await all(env.DB, `SELECT * FROM np_reading WHERE NOT (${COMPLETE}) ORDER BY day, CASE shift WHEN 'night' THEN 1 ELSE 0 END`);
  const out = [];
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const before = await first(env.DB, `SELECT day, shift, gb, gt, lb, lt FROM np_reading WHERE ${COMPLETE}
      AND (day < ?1 OR (day = ?1 AND ?2 = 'night' AND shift = 'day')) ORDER BY day DESC, CASE shift WHEN 'night' THEN 1 ELSE 0 END DESC LIMIT 1`, r.day, r.shift);
    // eslint-disable-next-line no-await-in-loop
    const pic = r.photo_id ? await first(env.DB, 'SELECT data FROM np_photo WHERE id = ?1', r.photo_id) : null;
    out.push({
      day: r.day, shift: r.shift, key: `${r.day}|${r.shift}`, name: r.name, sentAt: r.sent_at, photoId: r.photo_id || null,
      values: Object.fromEntries(COUNTERS.map((c) => [c, r[c] ?? null])),
      pending: COUNTERS.filter((c) => r[c] == null),
      // eslint-disable-next-line no-await-in-loop
      problem: pic ? await problemOf(env, pic.data) : '',
      before: before || null,
    });
  }
  return { items: out };
}

/**
 * The counters read off the picture by a person: an admin, or a supervisor
 * given Nice Place. A supervisor fills in only a reading still waiting; an
 * admin may correct any. All four are saved, so a misread one is put right too.
 */
export async function reviewReading(env, body, account, { admin = false } = {}) {
  const was = await pendingOne(env, body);
  if (!admin && isComplete(was)) throw new HttpError(409, 'This shift’s counters are already in. To change them, ask an admin.');
  const v = Object.fromEntries(COUNTERS.map((c) => [c, count(body?.[c], LABEL[c])]));
  const at = now();
  // Read off the picture by this person: both edited and checked by them.
  await run(env.DB, `UPDATE np_reading SET gb = ?3, gt = ?4, lb = ?5, lt = ?6, at = ?7, edited_by = ?8, checked_by = ?8, checked_at = ?7
    WHERE day = ?1 AND shift = ?2`, was.day, was.shift, v.gb, v.gt, v.lb, v.lt, at, who(account));
  return { ok: true };
}

/** Ask the reader once more about a reading's picture; what it reads fills only the counters still empty. */
export async function rereadReading(env, body) {
  const was = await pendingOne(env, body);
  if (isComplete(was)) return { ok: true, values: Object.fromEntries(COUNTERS.map((c) => [c, was[c]])), pending: [] };
  if (!env.AI) throw new HttpError(503, 'The reader is not available. Read the counters off the picture and type them.');
  const pic = was.photo_id ? await first(env.DB, 'SELECT type, data FROM np_photo WHERE id = ?1', was.photo_id) : null;
  if (!pic) throw badRequest('This reading has no picture to read.');
  const s = await settingsOf(env);
  // Asked fresh about the counters still empty, whatever was kept for the picture.
  const { read, errors } = await askReader(env, `data:${pic.type};base64,${pic.data}`, s.layout, COUNTERS.filter((c) => was[c] == null));
  await noteRead(env, { ok: Boolean(read), errors, again: true });
  const values = Object.fromEntries(COUNTERS.map((c) => [c, was[c] ?? read?.[c] ?? null]));
  const pending = COUNTERS.filter((c) => values[c] == null);
  if (read && COUNTERS.some((c) => values[c] !== (was[c] ?? null))) {
    let kept = {};
    try { kept = JSON.parse(was.read_json || '{}'); } catch { kept = {}; }
    const readJson = { ...(kept.unavailable ? {} : kept), ...Object.fromEntries(COUNTERS.map((c) => [c, values[c]])) };
    await run(env.DB, 'UPDATE np_reading SET gb = ?3, gt = ?4, lb = ?5, lt = ?6, at = ?7, read_json = ?8 WHERE day = ?1 AND shift = ?2',
      was.day, was.shift, values.gb, values.gt, values.lb, values.lt, now(), JSON.stringify(readJson));
  }
  return { ok: true, values, pending, problem: read?.problem || '', error: read ? null : (errors[0] || 'The reader did not answer.') };
}

// ------------------------------------------------------------- the workbook --

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "SEP 26", "Sep 2026", "Nice_Place_Income_Sep_26": the month it is for. */
export function monthOf(text) {
  const m = String(text || '').toLowerCase().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s_-]*(\d{4}|\d{2})\b/);
  if (!m) return null;
  const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return `${year}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}`;
}

const cell = (v) => String(v ?? '').trim().toLowerCase();
const cedis = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 100));

/** The day a row is for: a day of the month, an Excel date or a typed one. */
function dayOfRow(v, month) {
  if (typeof v === 'number') {
    if (v >= 1 && v <= 31 && Number.isInteger(v) && month) return `${month}-${String(v).padStart(2, '0')}`;
    if (v > 40000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
    return null;
  }
  const s = String(v ?? '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (dmy) return `${dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  if (/^\d{1,2}$/.test(s) && month) return `${month}-${s.padStart(2, '0')}`;
  return null;
}

/**
 * The income workbook, as rows of cells: a row naming Toilet and Shower, one
 * naming Day and Night under each, one with Adult, Child and Revenue, then a
 * row per date until Total. "Shifts" with Day and Night under it holds who
 * was on. The month comes from the sheet's name unless given.
 */
export function parseIncome(rows, { sheetName = '', fileName = '', month = null } = {}) {
  const forMonth = month || monthOf(sheetName) || monthOf(fileName);
  const head = rows.slice(0, 8);
  const fieldAt = head.findIndex((r) => (r || []).some((v) => cell(v) === 'adult') && (r || []).some((v) => cell(v) === 'revenue'));
  if (fieldAt < 2) throw badRequest('This is not the Nice Place income workbook: no row with Adult, Child and Revenue under Toilet/Shower and Day/Night.');
  const facilityRow = rows[fieldAt - 2] || [];
  const shiftRow = rows[fieldAt - 1] || [];
  const leftOf = (row, c, test) => { for (let i = c; i >= 0; i -= 1) if (test(cell(row[i]))) return cell(row[i]); return ''; };
  const cols = [];
  for (const [c, v] of (rows[fieldAt] || []).entries()) {
    const field = cell(v);
    const facility = leftOf(facilityRow, c, (x) => /toilet|shower/.test(x));
    const over = leftOf(shiftRow, c, (x) => /^(day|night|shifts?|staff)$/.test(x));
    if (['adult', 'child', 'revenue'].includes(field) && /toilet|shower/.test(facility) && /^(day|night)$/.test(over)) {
      cols.push({ c, kind: 'money', facility: facility.includes('toilet') ? 'toilet' : 'shower', shift: over, field: field === 'revenue' ? 'total' : field });
    } else if (['day', 'night'].includes(field) && /^(shifts?|staff)$/.test(over)) {
      cols.push({ c, kind: 'staff', shift: field });
    }
  }
  if (!cols.some((x) => x.kind === 'money')) throw badRequest('Could not find the Toilet and Shower columns for Day and Night.');
  const out = new Map();
  const problems = [];
  for (const r of rows.slice(fieldAt + 1)) {
    const first = (r || [])[0];
    if (/^total/i.test(String(first ?? '').trim())) break;
    const day = dayOfRow(first, forMonth);
    if (!day) {
      if ((r || []).some((v) => v != null && v !== '')) problems.push(`A row starting “${String(first ?? '').slice(0, 20)}” has no date I can read.`);
      continue;
    }
    for (const shift of SHIFTS) {
      const row = { day, shift, toilet: { adult: null, child: null, total: null }, shower: { adult: null, child: null, total: null }, staff: null };
      for (const col of cols.filter((x) => x.shift === shift)) {
        if (col.kind === 'staff') row.staff = str(r[col.c], 'Staff', { max: 80 }) || null;
        else row[col.facility][col.field] = cedis(r[col.c]);
      }
      const any = ['toilet', 'shower'].some((f) => Object.values(row[f]).some((v) => v != null));
      if (any) out.set(`${day}|${shift}`, row);
    }
  }
  if (!forMonth && !out.size) throw badRequest('Say which month this workbook is for.');
  return { month: forMonth, rows: [...out.values()], problems };
}

/** Save what was read: each date and shift replaces what was there for it. */
export async function saveIncome(env, body, account) {
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows || !rows.length || rows.length > 2000) throw badRequest('Choose the income workbook.');
  const month = body?.month && /^\d{4}-\d{2}$/.test(body.month) ? body.month : null;
  const parsed = parseIncome(rows, { sheetName: body?.sheetName, fileName: body?.fileName, month });
  const at = now();
  const statements = parsed.rows.map((x) => env.DB.prepare(`INSERT INTO np_revenue (day, shift, toilet_adult, toilet_child, toilet_total, shower_adult, shower_child, shower_total, staff, uploaded_by, uploaded_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    ON CONFLICT (day, shift) DO UPDATE SET toilet_adult = ?3, toilet_child = ?4, toilet_total = ?5, shower_adult = ?6, shower_child = ?7, shower_total = ?8, staff = ?9, uploaded_by = ?10, uploaded_at = ?11`)
    .bind(x.day, x.shift, x.toilet.adult, x.toilet.child, x.toilet.total, x.shower.adult, x.shower.child, x.shower.total, x.staff, who(account), at));
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50)); // eslint-disable-line no-await-in-loop
  const days = parsed.rows.map((x) => x.day).sort();
  return { ok: true, month: parsed.month, saved: parsed.rows.length, from: days[0] || null, to: days[days.length - 1] || null, problems: parsed.problems };
}

// -------------------------------------------------------------- the sums --

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Every shift from `from` to `to`, with what its counters and its money say.
 *
 * `readings` and `revenue` are rows as stored, and may reach before `from`:
 * the reading before the first shift is where its counting starts. A gap in
 * the readings makes the next one cover several shifts, held against the money
 * of all of them. A counter lower than before was reset: it counts from zero.
 */
export function analyse({ readings, revenue, settings, from, to }) {
  const s = { ...DEFAULTS, ...settings };
  const sorted = [...readings].sort((a, b) => order(a.day, a.shift).localeCompare(order(b.day, b.shift)));
  const money = new Map(revenue.map((r) => [`${r.day}|${r.shift}`, r]));
  const at = new Map(sorted.map((r, i) => [`${r.day}|${r.shift}`, i]));
  const usual = { toilet: [], shower: [] };
  const rows = [];

  for (const day of daysBetween(from, to)) {
    for (const shift of SHIFTS) {
      const key = `${day}|${shift}`;
      const i = at.get(key);
      const reading = i == null ? null : sorted[i];
      const prev = i ? sorted[i - 1] : null;
      // The shifts these counts cover: from the one after the reading before.
      const span = [];
      if (reading) {
        let cur = prev ? nextShift(prev.day, prev.shift) : { day, shift };
        while (order(cur.day, cur.shift) <= order(day, shift) && span.length < 62) { span.push(cur); cur = nextShift(cur.day, cur.shift); }
      }
      const resets = [];
      const moved = {};
      if (reading) {
        for (const c of COUNTERS) {
          const before = prev ? prev[c] : 0;
          if (reading[c] < before) { resets.push(c); moved[c] = reading[c]; } else moved[c] = reading[c] - before;
        }
      }
      const sheet = span.map((x) => money.get(`${x.day}|${x.shift}`));
      const own = money.get(key) || null;
      const facilities = {};
      for (const [f, counters] of Object.entries(FACILITIES)) {
        const out = { status: 'waiting' };
        if (reading) {
          out.movements = counters.reduce((t, c) => t + moved[c], 0);
          out.people = Math.floor(out.movements / 2);
          out.odd = out.movements % 2 === 1;
          out.allowance = s.allowance * counters.length * span.length;
          out.paying = Math.max(0, out.people - out.allowance);
        }
        const hasRevenue = reading ? sheet.length && sheet.every((r) => r && r[`${f}_total`] != null) : own && own[`${f}_total`] != null;
        if (hasRevenue) {
          const rows_ = reading ? sheet : [own];
          out.revenue = rows_.reduce((t, r) => t + (r[`${f}_total`] || 0), 0);
          const split = rows_.every((r) => r[`${f}_adult`] != null && r[`${f}_child`] != null);
          if (split) {
            out.adultMoney = rows_.reduce((t, r) => t + r[`${f}_adult`], 0);
            out.childMoney = rows_.reduce((t, r) => t + r[`${f}_child`], 0);
            out.adults = out.adultMoney / s.adult;
            out.children = out.childMoney / s.child;
            out.reportedPeople = Math.round(out.adults + out.children);
            if (out.adultMoney + out.childMoney !== out.revenue) out.sheetGap = out.revenue - out.adultMoney - out.childMoney;
            if (out.reportedPeople) usual[f].push(out.adults / out.reportedPeople);
          }
        }
        if (reading && out.revenue != null) {
          out.minRevenue = out.paying * s.child;
          out.maxRevenue = out.people * s.adult;
          out.gap = out.reportedPeople != null ? out.paying - out.reportedPeople : null;
        }
        facilities[f] = out;
      }
      rows.push({
        day, shift, key,
        reading: reading ? { name: reading.name, gb: reading.gb, gt: reading.gt, lb: reading.lb, lt: reading.lt, photoId: reading.photo_id || null,
          sentAt: reading.sent_at, at: reading.at, editedBy: reading.edited_by || null, checkedBy: reading.checked_by || null, checkedAt: reading.checked_at || null,
          movedFrom: reading.moved_from || null, movedBy: reading.moved_by || null, movedAt: reading.moved_at || null,
          // What the picture was read as, and where the typed numbers differ or it could not be read.
          ...readCompare(reading) } : null,
        before: prev ? { day: prev.day, shift: prev.shift, gb: prev.gb, gt: prev.gt, lb: prev.lb, lt: prev.lt } : null,
        moved: reading ? moved : null,
        first: Boolean(reading && !prev),
        span: span.length > 1 ? span : null,
        resets,
        staff: own?.staff || null,
        facilities,
      });
    }
  }

  // The usual share of adults, from every shift the workbook splits.
  const usualShare = { toilet: median(usual.toilet), shower: median(usual.shower) };
  for (const r of rows) {
    for (const [f, x] of Object.entries(r.facilities)) {
      if (!r.reading) { x.status = x.revenue != null ? 'no-reading' : 'waiting'; continue; }
      if (x.revenue == null) { x.status = 'no-revenue'; continue; }
      const share = usualShare[f];
      if (share != null) x.usualRevenue = Math.round(x.paying * (share * s.adult + (1 - share) * s.child));
      // Not even every visitor a child (and the staff allowance off) could
      // bring in so little: it does not add up.
      const unpaid = x.gap != null ? x.gap : null;
      const tolerance = Math.max(5, Math.round(x.people * 0.1));
      if (x.revenue < x.minRevenue) x.status = 'bad';
      else if (unpaid != null && unpaid > tolerance) x.status = 'warn';
      else if (x.revenue > x.maxRevenue + s.adult * 5) x.status = 'over';
      else if (x.reportedPeople == null && x.usualRevenue != null && x.revenue < x.usualRevenue * 0.75) x.status = 'warn';
      else x.status = 'good';
    }
    const order_ = ['bad', 'warn', 'over', 'no-revenue', 'no-reading', 'waiting', 'good'];
    r.status = order_.find((st) => Object.values(r.facilities).some((x) => x.status === st)) || 'waiting';
  }
  return { rows, usualShare, settings: { allowance: s.allowance, adult: s.adult, child: s.child, layout: s.layout || '' } };
}

// ---------------------------------------------------------- your page --

/** The page: the shifts of the days asked for, and the settings. */
export async function npView(env, query, account, { admin = false } = {}) {
  const today = todayIn('UTC');
  const to = isDay(query?.to) ? query.to : today;
  const from = isDay(query?.from) ? query.from : addDays(to, -13);
  const s = await settingsOf(env);
  // The reading before the first shift, and the money of every shift a gap may cover.
  const before = await first(env.DB, `SELECT * FROM np_reading WHERE day < ?1 AND ${COMPLETE} ORDER BY day DESC, CASE shift WHEN 'night' THEN 1 ELSE 0 END DESC LIMIT 1`, from);
  const sent = await all(env.DB, 'SELECT * FROM np_reading WHERE day BETWEEN ?1 AND ?2', from, to);
  // A reading still missing a counter is not counted until it is read: it waits for review.
  const readings = sent.filter(isComplete);
  const waiting = new Map(sent.filter((r) => !isComplete(r)).map((r) => [`${r.day}|${r.shift}`, r]));
  const lo = before?.day || from;
  const revenue = await all(env.DB, 'SELECT * FROM np_revenue WHERE day BETWEEN ?1 AND ?2', lo, to);
  const answers = await all(env.DB, 'SELECT * FROM np_answer WHERE day BETWEEN ?1 AND ?2', from, to);
  const out = analyse({ readings: before ? [before, ...readings] : readings, revenue, settings: s, from, to });
  const answerOf = new Map(answers.map((a) => [`${a.day}|${a.shift}`, { answer: a.answer, note: a.note, by: a.by_name, at: a.at }]));
  for (const r of out.rows) {
    r.answer = answerOf.get(r.key) || null;
    const w = waiting.get(r.key);
    if (!w) { r.pending = null; continue; }
    const prev = [before, ...readings].filter((x) => x && order(x.day, x.shift) < order(r.day, r.shift))
      .sort((a, b) => order(b.day, b.shift).localeCompare(order(a.day, a.shift)))[0];
    // eslint-disable-next-line no-await-in-loop
    const pic = w.photo_id ? await first(env.DB, 'SELECT data FROM np_photo WHERE id = ?1', w.photo_id) : null;
    r.pending = {
      name: w.name, sentAt: w.sent_at, photoId: w.photo_id || null, movedFrom: w.moved_from || null, movedBy: w.moved_by || null,
      values: Object.fromEntries(COUNTERS.map((c) => [c, w[c] ?? null])), pending: COUNTERS.filter((c) => w[c] == null),
      // eslint-disable-next-line no-await-in-loop
      problem: pic ? await problemOf(env, pic.data) : '',
    };
    r.before = prev ? { day: prev.day, shift: prev.shift, gb: prev.gb, gt: prev.gt, lb: prev.lb, lt: prev.lt } : null;
    r.status = 'review';
  }
  // Shifts with nothing yet are shown only once readings have started, up to now.
  const started = out.rows.filter((r) => r.reading || r.pending || Object.values(r.facilities).some((x) => x.revenue != null)).map((r) => order(r.day, r.shift)).sort()[0];
  out.rows = out.rows.filter((r) => r.reading || r.pending || r.status !== 'waiting' || (started && order(r.day, r.shift) > started));
  const staff = await all(env.DB, 'SELECT id, name, active FROM np_staff ORDER BY active DESC, name');
  const lastUpload = await first(env.DB, 'SELECT MAX(uploaded_at) AS at, MAX(day) AS day FROM np_revenue');
  let readLast = null;
  try { readLast = JSON.parse((await getSettings(env.DB)).np_read_last || 'null'); } catch { readLast = null; }
  return {
    from, to, ...out, rows: out.rows.reverse(),
    staff, admin,
    // How the last picture went with the reader, for the manager.
    readLast: admin ? readLast : null,
    link: admin ? (s.token ? { token: s.token } : null) : (s.token ? {} : null),
    revenueThrough: lastUpload?.day || null, revenueAt: lastUpload?.at || null,
  };
}

/** The picture as it was sent. */
export async function photo(env, id) {
  const row = await first(env.DB, 'SELECT type, data FROM np_photo WHERE id = ?1', Number(id));
  if (!row) throw new HttpError(404, 'No such picture.');
  const bytes = Uint8Array.from(atob(row.data), (ch) => ch.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': row.type, 'Cache-Control': 'private, max-age=86400' } });
}

/** Names, the staff allowance, the prices, and a new link (the old one stops working). */
export async function saveSettings(env, body) {
  const s = await settingsOf(env);
  if (body?.newLink) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    s.token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  if (body?.allowance != null) {
    const n = Number(body.allowance);
    if (!Number.isInteger(n) || n < 0 || n > 500) throw badRequest('Walk-throughs by staff: a whole number, per counter per shift.');
    s.allowance = n;
  }
  for (const k of ['adult', 'child']) {
    if (body?.[k] == null) continue;
    const v = Math.round(Number(body[k]) * 100);
    if (!Number.isFinite(v) || v <= 0 || v > 100000) throw badRequest(`The ${k === 'adult' ? 'adult' : 'child'} price in GH₵.`);
    s[k] = v;
  }
  if (s.child > s.adult) throw badRequest('A child pays less than an adult.');
  // How the counters sit, for reading them off a picture when they carry no labels.
  if (body?.layout != null) s.layout = str(body.layout, 'How the counters are laid out', { max: 300 }) || '';
  await setSetting(env.DB, KEY, JSON.stringify(s));
  if (body?.addName) {
    const name = str(body.addName, 'Name', { required: true, max: 80 });
    await run(env.DB, 'INSERT INTO np_staff (name, active) VALUES (?1, 1) ON CONFLICT (name) DO UPDATE SET active = 1', name);
  }
  if (body?.removeId != null) await run(env.DB, 'UPDATE np_staff SET active = 0 WHERE id = ?1', Number(body.removeId));
  return { ok: true };
}

/**
 * A picture of the counters added here, for a shift that has none: no
 * reading at all, or numbers typed without one. It is read like one sent
 * from the link. With no reading, its numbers become the reading (a counter
 * not read waits, as one from the link would); with typed numbers, they are
 * kept and the picture is held against them.
 */
export async function uploadPhoto(env, body, account) {
  const day = String(body?.day || '');
  const shift = String(body?.shift || '');
  if (!isDay(day) || !SHIFTS.includes(shift)) throw badRequest('Which shift?');
  const photo = String(body?.photo || '');
  const m = photo.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw badRequest('Choose a picture of the counters.');
  if (m[2].length > PHOTO_MAX) throw badRequest('That picture is too large.');
  const was = await first(env.DB, 'SELECT * FROM np_reading WHERE day = ?1 AND shift = ?2', day, shift);
  if (was?.photo_id) throw new HttpError(409, 'This shift has a picture already.');
  const s = await settingsOf(env);
  const read = await readAgain(env, m[2], photo, s.layout);
  const values = Object.fromEntries(COUNTERS.map((c) => [c, read?.[c] ?? null]));
  const at = now();
  const photoId = (await first(env.DB, 'INSERT INTO np_photo (type, data, at) VALUES (?1, ?2, ?3) RETURNING id', m[1], m[2], at)).id;
  const readJson = JSON.stringify(read || { unavailable: true });
  if (was) {
    // Typed already: the numbers stay; the picture, and what it reads, go with them.
    await run(env.DB, 'UPDATE np_reading SET photo_id = ?3, read_json = ?4, at = ?5 WHERE day = ?1 AND shift = ?2', day, shift, photoId, readJson, at);
    return {
      ok: true, kept: true, values,
      differs: COUNTERS.filter((c) => values[c] != null && was[c] != null && values[c] !== was[c]).map((c) => ({ counter: c, typed: was[c], read: values[c] })),
    };
  }
  await run(env.DB, `INSERT INTO np_reading (day, shift, name, gb, gt, lb, lt, photo_id, sent_at, at, read_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)`,
    day, shift, who(account), values.gb, values.gt, values.lb, values.lt, photoId, at, readJson);
  return { ok: true, kept: false, values, pending: COUNTERS.filter((c) => values[c] == null) };
}

/** A reading typed or corrected here: a fix, or a shift with no picture. */
export async function editReading(env, body, account) {
  const day = String(body?.day || '');
  const shift = String(body?.shift || '');
  if (!isDay(day) || !SHIFTS.includes(shift)) throw badRequest('Which shift?');
  const v = Object.fromEntries(COUNTERS.map((c) => [c, count(body?.[c], c.toUpperCase())]));
  const at = now();
  await run(env.DB, `INSERT INTO np_reading (day, shift, name, gb, gt, lb, lt, photo_id, sent_at, at, edited_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8, ?9)
    ON CONFLICT (day, shift) DO UPDATE SET gb = ?4, gt = ?5, lb = ?6, lt = ?7, at = ?8, edited_by = ?9`,
  day, shift, str(body?.name, 'Name', { max: 80 }), v.gb, v.gt, v.lb, v.lt, at, who(account));
  return { ok: true };
}

/**
 * A reading, with its picture, sent for the wrong day or shift: moved to the
 * right one. When that shift has a reading of its own, the two are swapped,
 * and only when asked to (each was probably sent for the other). Each keeps
 * where it came from, who moved it and when. An answer stays with its shift.
 */
export async function moveReading(env, body, account) {
  const was = await pendingOne(env, body);
  const day = String(body?.toDay || '');
  const shift = String(body?.toShift || '');
  if (!isDay(day) || !SHIFTS.includes(shift)) throw badRequest('Move it to which day and shift?');
  if (day > todayIn('UTC')) throw badRequest('That shift has not happened yet.');
  if (day === was.day && shift === was.shift) throw badRequest('It is on that shift already.');
  const there = await first(env.DB, 'SELECT * FROM np_reading WHERE day = ?1 AND shift = ?2', day, shift);
  if (there && !body?.swap) {
    throw new HttpError(409, 'That shift has a reading of its own. Swap the two, or move that one first.');
  }
  const at = now();
  const by = who(account);
  const from = (r) => `${r.day}|${r.shift}`;
  const put = (r, d, sh) => env.DB.prepare('UPDATE np_reading SET day = ?3, shift = ?4, moved_from = ?5, moved_by = ?6, moved_at = ?7 WHERE day = ?1 AND shift = ?2')
    .bind(r.day, r.shift, d, sh, from(r), by, at);
  // A swap goes through a day no shift has, so neither shift is ever two readings.
  const statements = there
    ? [env.DB.prepare("UPDATE np_reading SET day = '0000-00-00' WHERE day = ?1 AND shift = ?2").bind(there.day, there.shift),
      put(was, day, shift),
      env.DB.prepare('UPDATE np_reading SET day = ?2, shift = ?3, moved_from = ?4, moved_by = ?5, moved_at = ?6 WHERE day = ?7 AND shift = ?1')
        .bind(there.shift, was.day, was.shift, from(there), by, at, '0000-00-00')]
    : [put(was, day, shift)];
  await env.DB.batch(statements);
  return { ok: true, swapped: Boolean(there), to: { day, shift } };
}

/** Somebody looked: the numbers typed match the picture (or take that back). */
export async function checkReading(env, body, account) {
  const ok = body?.ok !== false;
  await run(env.DB, 'UPDATE np_reading SET checked_by = ?3, checked_at = ?4 WHERE day = ?1 AND shift = ?2',
    String(body?.day || ''), String(body?.shift || ''), ok ? who(account) : null, ok ? now() : null);
  return { ok: true };
}

/** What happened on a shift that does not add up; empty takes it back. */
export async function answer(env, body, account) {
  const day = String(body?.day || '');
  const shift = String(body?.shift || '');
  if (!isDay(day) || !SHIFTS.includes(shift)) throw badRequest('Which shift?');
  const text = str(body?.answer, 'Answer', { max: 60 });
  if (!text) { await run(env.DB, 'DELETE FROM np_answer WHERE day = ?1 AND shift = ?2', day, shift); return { ok: true }; }
  await run(env.DB, `INSERT INTO np_answer (day, shift, answer, note, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (day, shift) DO UPDATE SET answer = ?3, note = ?4, by_name = ?5, at = ?6`,
  day, shift, text, str(body?.note, 'Note', { max: 600 }), who(account), now());
  return { ok: true };
}
