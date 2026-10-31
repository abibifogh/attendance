import { all, first, getSettings, setSetting } from '../lib/db.js';
import { HttpError, badRequest, str } from '../lib/http.js';
import { addDays, isDay, todayIn } from '../lib/dates.js';

/**
 * Locked dates: an admin closes the shifts up to a day, and from then on
 * nobody changes them. That includes admins until an admin moves the date
 * back. Answers, reconciliations, corrections to cash movements, counts,
 * POs linked, payments moved, differences put on staff accounts, checks,
 * closing reports reopened or moved, Nice Place readings: all refused for a
 * locked day. Notes and to-dos are not changes to a shift and stay open.
 *
 * A journal, card machine file or bank statement loaded later leaves a
 * locked day as it was: its lines for locked days are not loaded (see
 * keepLocked). Bank credits for locked days' card payments that arrive
 * after the lock still load. They settle what was taken; they do not change
 * a shift.
 *
 * One setting holds it: the last locked day, who locked it, when, why, the
 * last ASSD transaction of that day's last shift (so a night that runs past
 * midnight is locked whole), and the history of changes.
 */

const KEY = 'shift_lock';
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const sayDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Where the lock stands: `through` is null when nothing is locked. */
export async function lockOf(env) {
  let s = null;
  try { s = JSON.parse((await getSettings(env.DB))[KEY] || 'null'); } catch { s = null; }
  return { through: s?.through || null, seqThrough: s?.seqThrough ?? null, by: s?.by || null, at: s?.at || null, note: s?.note || null, history: s?.history || [] };
}

/** Is this day locked? */
export const isLocked = (lock, day) => Boolean(lock?.through && day && day <= lock.through);

/**
 * Lock up to a day, move the lock, or take it off (`through` empty): an
 * admin's. `seqThrough` is the last ASSD transaction of that day's last
 * shift, found by the caller, so a night past midnight is locked whole.
 */
export async function setLock(env, body, account, { seqThrough = null } = {}) {
  const was = await lockOf(env);
  const through = body?.through ? String(body.through) : null;
  if (through && !isDay(through)) throw badRequest('Choose the last day to lock.');
  if (through && through >= todayIn('UTC')) throw badRequest('Only days that are over can be locked: choose yesterday or before.');
  const note = str(body?.note, 'Why', { max: 300 }) || null;
  if (was.through && (!through || through < was.through) && !note) throw badRequest('Say why the lock is being moved back: it is kept in the history.');
  const at = now();
  const entry = { through, from: was.through, by: who(account), at, note };
  const next = { through, seqThrough: through ? seqThrough : null, by: who(account), at, note, history: [entry, ...was.history].slice(0, 50) };
  await setSetting(env.DB, KEY, JSON.stringify(next));
  return { ok: true, lock: await lockOf(env) };
}

/** Refused, saying which day and who locked it. */
export function lockedError(lock, day) {
  return new HttpError(423, `${sayDay(day)} is locked: everything up to ${sayDay(lock.through)} was locked by ${lock.by || 'an admin'}. An admin can move the lock back under Settings › Rules › Locked dates.`);
}

/** Every day the request touches: days named, the days of keys named, of ASSD numbers, of links and moves and reports by id. */
export async function daysOf(env, body, { dayOfKey, ids = {} } = {}) {
  const days = new Set();
  const b = body || {};
  for (const f of ['day', 'toDay', 'fromDay']) if (isDay(b[f])) days.add(b[f]);
  const keys = [];
  // Several at once (form matches): each item's day and key.
  for (const it of Array.isArray(b.items) ? b.items : []) {
    if (isDay(it?.day)) days.add(it.day);
    if (it?.key) keys.push(String(it.key));
  }
  if (b.key) keys.push(String(b.key));
  if (Array.isArray(b.keys)) keys.push(...b.keys.map(String));
  // In an approval, `answer` is the key answered; elsewhere it is the answer's words.
  if (typeof b.answer === 'string' && b.answer.includes(':')) keys.push(b.answer);
  for (const k of keys) {
    if (k.startsWith('notpair:')) { keys.push(...k.slice(8).split('|')); continue; }
    // eslint-disable-next-line no-await-in-loop
    const d = dayOfKey ? await dayOfKey(env, k).catch(() => null) : null;
    if (d) days.add(d);
  }
  if (b.seq != null && Number.isFinite(Number(b.seq))) {
    const row = await first(env.DB, 'SELECT day FROM assd_entry WHERE seq = ?1', Number(b.seq)).catch(() => null);
    if (row?.day) days.add(row.day);
  }
  // A reconciliation by its id: the days of the keys it holds.
  const linkId = ids.link ? b[ids.link] : null;
  if (linkId != null) {
    const row = await first(env.DB, 'SELECT keys FROM shift_link WHERE id = ?1', Number(linkId)).catch(() => null);
    let held = [];
    try { held = JSON.parse(row?.keys || '[]'); } catch { held = []; }
    for (const k of held) {
      // eslint-disable-next-line no-await-in-loop
      const d = dayOfKey ? await dayOfKey(env, String(k)).catch(() => null) : null;
      if (d) days.add(d);
    }
  }
  // A difference put on staff accounts, by its id.
  if (ids.move && b[ids.move] != null) {
    const row = await first(env.DB, 'SELECT day FROM till_move WHERE id = ?1', Number(b[ids.move])).catch(() => null);
    if (row?.day) days.add(row.day);
  }
  // A closing report in HIVE, by its id.
  if (ids.report && b[ids.report] != null && env.ATT_DB) {
    const row = await env.ATT_DB.prepare('SELECT day FROM till_report WHERE id = ?1').bind(Number(b[ids.report])).first().catch(() => null);
    if (row?.day) days.add(row.day);
  }
  return [...days];
}

/**
 * A checked shift is locked on its own: the shifts the request touches, by
 * day and slot (named, or in a key such as drawer:2026-10-01:morning), by an
 * ASSD line (within a checked shift's lines) or by a payment's time. Refused
 * while any of them is checked; unchecking opens it again.
 */
export async function assertShiftsOpen(env, body, { whereIs = null, ids = {} } = {}) {
  const checks = await all(env.DB, 'SELECT day, slot, by_name, at, start_seq, end_seq FROM shift_check').catch(() => []);
  if (!checks.length) return;
  const b = body || {};
  const places = new Set();
  const seqs = new Set();
  const SLOT = /^(morning|afternoon|night)$/;
  for (const [d, s] of [['day', 'slot'], ['toDay', 'toSlot'], ['fromDay', 'fromSlot']]) if (isDay(b[d]) && SLOT.test(String(b[s]))) places.add(`${b[d]}|${b[s]}`);
  for (const it of Array.isArray(b.items) ? b.items : []) if (isDay(it?.day) && SLOT.test(String(it?.slot))) places.add(`${it.day}|${it.slot}`);
  const keys = [];
  for (const it of Array.isArray(b.items) ? b.items : []) if (it?.key) keys.push(String(it.key));
  if (b.key) keys.push(String(b.key));
  if (Array.isArray(b.keys)) keys.push(...b.keys.map(String));
  if (typeof b.answer === 'string' && b.answer.includes(':')) keys.push(b.answer);
  const linkId = ids.link ? b[ids.link] : null;
  if (linkId != null) {
    const row = await first(env.DB, 'SELECT keys FROM shift_link WHERE id = ?1', Number(linkId)).catch(() => null);
    try { keys.push(...JSON.parse(row?.keys || '[]').map(String)); } catch { /* none */ }
  }
  if (b.seq != null && Number.isFinite(Number(b.seq))) seqs.add(Number(b.seq));
  for (const k of keys) {
    if (k.startsWith('notpair:')) { keys.push(...k.slice(8).split('|')); continue; }
    const named = /(\d{4}-\d{2}-\d{2}):(morning|afternoon|night)\b/.exec(k);
    if (named) { places.add(`${named[1]}|${named[2]}`); continue; }
    const seq = /:(\d{5,})(?::|$)/.exec(k);
    if (seq) { seqs.add(Number(seq[1])); continue; }
    if (whereIs && /(?:^|:)(t|b):[^:]+$/.test(k)) {
      // eslint-disable-next-line no-await-in-loop
      const w = await whereIs(env, { key: k }).catch(() => null);
      if (w?.day && w?.slot) places.add(`${w.day}|${w.slot}`);
    }
  }
  const hit = checks.find((c) => places.has(`${c.day}|${c.slot}`)
    || (c.start_seq != null && c.end_seq != null && [...seqs].some((q) => q >= c.start_seq && q <= c.end_seq)));
  if (hit) {
    throw new HttpError(423, `The ${hit.slot} shift of ${sayDay(hit.day)} is checked${hit.by_name ? ` (${hit.by_name})` : ''}, so it is locked. Uncheck it first to change anything on it.`);
  }
}

/** Refuse if any day the request touches is locked. */
export async function assertOpen(env, days) {
  const lock = await lockOf(env);
  if (!lock.through) return;
  const shut = days.filter((d) => isLocked(lock, d)).sort();
  if (shut.length) throw lockedError(lock, shut[0]);
}

/**
 * What of an upload may load: lines for locked days are left out, so a
 * locked day stays as it was. ASSD lines by their number (a night past
 * midnight goes with its shift) or, before any shift was locked whole, by
 * their date. Card machine rows by their time, a locked day's night running
 * to 06:00 the next morning. Bank rows by their day.
 */
export function keepLocked(lock, kind, rows) {
  if (!lock?.through) return { rows, left: 0 };
  const nightEnds = `${addDays(lock.through, 1)} 06:00:00`;
  const shut = (r) => {
    if (kind === 'journal') return (lock.seqThrough != null && r.seq <= lock.seqThrough) || (r.date && r.date <= lock.through);
    if (kind === 'terminal') return String(r.at || r.day || '') < nightEnds;
    return r.day && r.day <= lock.through;
  };
  const kept = rows.filter((r) => !shut(r));
  return { rows: kept, left: rows.length - kept.length };
}

/** For HIVE: the last locked day, so it can say so and refuse answers there. */
export async function linkLock(env) {
  const lock = await lockOf(env);
  return { through: lock.through, by: lock.by };
}

/** The last ASSD transaction of a day's shifts, as far as the journal goes. */
export async function lastSeqOf(env, day, shiftsOf) {
  try {
    const out = await shiftsOf(env, { from: day, to: day }, { isOwner: true });
    const ends = (out.days || []).flatMap((d) => d.shifts).filter((s) => s.day === day).map((s) => s.endSeq).filter((n) => n != null);
    if (ends.length) return Math.max(...ends);
  } catch { /* by date below */ }
  const row = await first(env.DB, 'SELECT MAX(seq) AS seq FROM assd_entry WHERE day <= ?1', day).catch(() => null);
  return row?.seq ?? null;
}

