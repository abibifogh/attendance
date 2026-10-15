import {
  badRequest, forbidden, HttpError, json, notFound, readJson, str,
} from '../lib/http.js';
import { getPepper, hashPin, verifyPasswordKey } from '../lib/auth.js';
import { createNotice } from '../lib/notices.js';
import { callLink, verifyLink } from '../lib/till-link.js';
import { addDays, nowIn, todayIn } from '../util/dates.js';
import { firstMonthFor } from '../lib/advances.js';
import { nextOnReception } from '../lib/till-watch.js';
import { firstUsableEmail, isEmail, sendEmail, senderWithName } from '../lib/notify.js';
import { firstName, sayDate, sayHours, sayMonth, sayShortDate } from '../lib/email-design.js';

/**
 * My till: closing a front-desk shift, and answering for it.
 *
 * Replaces the Google Form. The form asked eighteen things; half were figures
 * copied off ASSD, which Insight reads straight from the journal. What is
 * left is what only the person at the desk can say, and it is signed with
 * their own PIN, the way a letter is signed for the property.
 *
 * Insight does the checking. It holds the Odoo connection that says whether a
 * PO is real, and the journal that says what the shift took and moved; HIVE
 * asks it over the till link (lib/till-link.js) and keeps what staff wrote.
 * The other way, Insight asks HIVE to put a shortage on somebody's pay, to
 * reopen a report, and to tell people things.
 *
 * Money is in pesewas, as Insight keeps it.
 */

const SLOTS = ['morning', 'afternoon', 'night'];
const SLOT_LABEL = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' };
// Where each shift starts, in minutes after midnight: as Insight places them.
const SLOT_START = { morning: 6 * 60, afternoon: 14 * 60, night: 22 * 60 };

/** If Insight cannot be reached, the form still asks the questions it always asks. */
const FALLBACK_SETUP = {
  checks: [{ id: 1, label: 'Scale' }, { id: 2, label: 'Hair dryer' }],
  rentals: [{ id: 'padlock', label: 'Padlocks', unit: 'padlock' }],
};

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;
const nowUtc = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

async function timezoneOf(db) {
  return (await db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first().catch(() => null))?.value || 'UTC';
}

/** Ask Insight something. Its refusal comes back as this app's own. */
async function insight(env, path, body) {
  try {
    return await callLink({ binding: env.INSIGHT, secret: env.INSIGHT_SSO_SECRET, path, body, what: 'Insight' });
  } catch (err) {
    throw new HttpError(err.status && err.status < 600 ? err.status : 502, err.message);
  }
}

/** Insight, or nothing: for the parts that must not stop a shift being closed. */
async function insightOrNull(env, path, body) {
  try { return await insight(env, path, body); } catch { return null; }
}

// ------------------------------------------------------------ the shift --

/**
 * The shift somebody is most likely closing, from the clock.
 *
 * An hour back from now, so somebody closing at five past ten is closing the
 * afternoon, and somebody closing at ten to six in the morning the night
 * before. Before six in the morning is the previous day's night.
 */
export function shiftAt(localNow) {
  const [day, clock] = String(localNow).split(' ');
  const [h, m] = clock.split(':').map(Number);
  let minute = h * 60 + m - 60;
  let d = day;
  if (minute < 0) { minute += 1440; d = addDays(day, -1); }
  if (minute < SLOT_START.morning) return { day: addDays(d, -1), slot: 'night' };
  if (minute < SLOT_START.afternoon) return { day: d, slot: 'morning' };
  if (minute < SLOT_START.night) return { day: d, slot: 'afternoon' };
  return { day: d, slot: 'night' };
}

/** The shift before this one. */
export function previousShift({ day, slot }) {
  const i = SLOTS.indexOf(slot);
  return i > 0 ? { day, slot: SLOTS[i - 1] } : { day: addDays(day, -1), slot: 'night' };
}

const labelOf = ({ day, slot }) => `${SLOT_LABEL[slot]} · ${day}`;

/** The shifts somebody may close: this one and the three before it. */
function choicesFrom(current) {
  const out = [current];
  while (out.length < 4) out.push(previousShift(out[out.length - 1]));
  return out.map((s) => ({ ...s, label: labelOf(s) }));
}

// ----------------------------------------------------------- read helpers --

function readReport(row) {
  if (!row) return null;
  const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
  return {
    id: row.id, day: row.day, slot: row.slot, name: row.name,
    floatOk: Boolean(row.float_ok), floatDiff: row.float_diff, floatNote: row.float_note,
    cash: row.cash, toSafe: Boolean(row.to_safe),
    envelopes: parse(row.envelopes, []), expenses: parse(row.expenses, []),
    rentals: parse(row.rentals, {}), checks: parse(row.checks, []),
    note: row.note, signedAt: row.signed_at, device: row.device,
    reopenedAt: row.reopened_at, reopenedBy: row.reopened_by, reopenReason: row.reopen_reason,
  };
}

/** Pesewas from what somebody typed in cedis. */
function pesewas(value, field, { required = true, min = 0, allowNegative = false } = {}) {
  if (value == null || value === '') {
    if (required) throw badRequest(`${field} is needed.`);
    return null;
  }
  const n = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw badRequest(`${field} must be an amount, like 1083.50.`);
  const p = Math.round(n * 100);
  if (!allowNegative && p < min) throw badRequest(`${field} cannot be less than ${min / 100}.`);
  return p;
}

function wholeCount(value, field) {
  const n = Number(value);
  if (value === '' || value == null || !Number.isInteger(n) || n < 0 || n > 999) throw badRequest(`${field} must be a whole number.`);
  return n;
}

const cedis = (minor) => `GH₵ ${(Math.abs(minor) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ----------------------------------------------------------------- reading --

/** Everything the Close shift screen needs. */
export async function myTill(ctx) {
  const tz = await timezoneOf(ctx.db);
  const current = shiftAt(nowIn(tz));
  const choices = choicesFrom(current);
  const userId = Number(ctx.session.user.id);

  const setup = await insightOrNull(ctx.env, '/api/link/till/setup', {});
  const mine = await ctx.db.prepare(
    `SELECT * FROM till_report WHERE user_id = ?1 AND reopened_at IS NULL AND day >= ?2 ORDER BY signed_at DESC`,
  ).bind(userId, choices[choices.length - 1].day).all();
  const reports = (mine.results ?? []).map(readReport);

  // The count the last person left, so the start of this shift can be checked
  // against it as it is typed.
  const last = await ctx.db.prepare(
    'SELECT name, rentals, day, slot FROM till_report WHERE reopened_at IS NULL ORDER BY day DESC, signed_at DESC LIMIT 1',
  ).first().catch(() => null);
  let handedOver = null;
  if (last) {
    try { handedOver = { name: last.name, day: last.day, slot: last.slot, rentals: JSON.parse(last.rentals || '{}') }; } catch { handedOver = null; }
  }

  return json({
    linked: Boolean(setup),
    setup: setup || FALLBACK_SETUP,
    shift: { ...current, label: labelOf(current) },
    choices: choices.map((c) => ({ ...c, done: reports.some((r) => r.day === c.day && r.slot === c.slot) })),
    reports,
    handedOver,
    today: todayIn(tz),
  });
}

// ----------------------------------------------------------------- the POs --

/** A requisition: cash may go out against it before the purchase, as an advance. */
const REQUISITION = new Set(['draft', 'sent', 'to approve']);
/** Reported on the expense form, or the form is not connected yet so nothing waits for it. */
const reportedOk = (found) => !found?.formLive || Boolean(found?.reported);

/**
 * Why a PO on a closing report stops it being signed, or null when it does
 * not. A requisition does not: it goes in as an advance. One approved in Odoo
 * has to be on the expense form too.
 */
const BLOCKED = { report: 'approved but not on the expense form yet', cancel: 'cancelled in Odoo' };
export function notApproved(found) {
  if (!found?.name || found.counted || ['claimed', 'missing', 'unchecked', 'confirmed'].includes(found.state)) return null;
  return BLOCKED[found.state] || 'not approved in Odoo';
}

/**
 * What has been paid from drawers against a PO so far: its first payment
 * (who, when) and the sum of every row, top-ups added and change taken off.
 */
async function paidAgainst(db, name) {
  const rows = (await db.prepare(
    'SELECT t.*, r.name AS who FROM till_po t LEFT JOIN till_report r ON r.id = t.report_id WHERE t.po = ?1 ORDER BY t.id',
  ).bind(String(name).toUpperCase()).all()).results || [];
  if (!rows.length) return null;
  const first = rows.find((r) => (r.kind || 'claim') === 'claim') || rows[0];
  return {
    paid: rows.reduce((t, r) => t + (Number(r.paid) || 0), 0),
    advance: Number(first.advance) === 1,
    first: { day: first.day, slot: first.slot, by: first.who || null, paid: Number(first.paid) || 0 },
  };
}

/** Ask Insight about POs: Odoo, the expense form, any admin decision. */
async function askInsight(env, names) {
  const answer = await insight(env, '/api/link/till/po', { names });
  return (answer?.found || []).map((f) => ({ ...f, formLive: Boolean(answer?.formLive) }));
}

/**
 * Whether a PO can go on a closing report, and as what.
 *
 * Approved in Odoo and on the expense form: counted, at its total. Still a
 * requisition: counted as an advance, at what the requisition says. One
 * already paid from a drawer whose total has changed in Odoo since is not
 * "claimed": the difference is a top-up (more to pay) or change back (money
 * due back), and counts on the shift where it moves.
 */
async function checkPo(ctx, typed) {
  const found = (await askInsight(ctx.env, [typed]))[0] || { typed, name: null };
  if (!found.name) return { ...found, state: 'missing', counted: false };
  await rememberOdoo(ctx.db, found);
  // Paid from the safe already: Insight says so, and it is not the drawer's.
  if (found.safe) return { ...found, state: 'claimed', counted: false, claimed: { day: found.safe.day, slot: null, by: 'the safe' } };
  const before = await paidAgainst(ctx.db, found.name);
  if (before) {
    const diff = (Number(found.total) || 0) - before.paid;
    if (found.confirmed && reportedOk(found) && diff !== 0 && !found.decision?.closed) {
      return {
        ...found, state: diff > 0 ? 'topup' : 'change', counted: true, amount: diff,
        paidSoFar: before.paid, claimed: before.first,
      };
    }
    return { ...found, state: 'claimed', counted: false, paidSoFar: before.paid, claimed: before.first, advance: before.advance };
  }
  if (found.confirmed) return reportedOk(found) ? { ...found, state: 'confirmed', counted: true } : { ...found, state: 'report', counted: false };
  if (REQUISITION.has(found.state)) return { ...found, odoo: found.state, state: 'advance', counted: true, advance: true };
  return { ...found, state: found.state || 'unconfirmed', counted: false };
}

/** The kind of till_po row a looked-up PO makes. */
const kindOf = (found) => (found.state === 'topup' ? 'topup' : found.state === 'change' ? 'change' : 'claim');
/** What it counts on this shift: the difference for a top-up or change, else the PO's total. */
const amountOf = (found) => (found.amount != null ? Number(found.amount) : Number(found.total) || 0);

const SLOT_INDEX = { morning: 0, afternoon: 1, night: 2 };
const earlierThan = (a, b) => a.day < b.day || (a.day === b.day && SLOT_INDEX[a.slot] < SLOT_INDEX[b.slot]);

/**
 * What earlier shifts left for the shift being closed.
 *
 * ADVANCES not settled yet: the PO is still waiting for approval in Odoo, or
 * approved and not on the expense form. Each holds up every later shift
 * until it is settled, or an admin gives it more time or closes it.
 *
 * DIFFERENCES on a PO paid within the last five days whose final total is
 * not what left the drawers: a refund (money back in the drawer) or a deficit
 * (more paid out). Older ones are for the admins, not the desk.
 *
 * Cheap on purpose: one query for what was paid, and Insight asked only about
 * POs it has not been asked about in the last ten minutes, twenty at a time
 * and all at once. Signing asks afresh (`fresh`), so a remembered answer never
 * decides what may be signed.
 */
export async function fromEarlier(ctx, { day, slot, userId, fresh = false }) {
  const tz = await timezoneOf(ctx.db);
  const today = todayIn(tz);
  const recent = addDays(today, -PO_CHANGE_DAYS);
  const rows = (await ctx.db.prepare(
    `SELECT t.*, COALESCE(r.name, u.name) AS who FROM till_po t
       LEFT JOIN till_report r ON r.id = t.report_id LEFT JOIN users u ON u.id = t.user_id
      WHERE t.po IN (SELECT po FROM till_po WHERE kind = 'claim' AND (day >= ?1 OR (advance = 1 AND day >= ?2)))
      ORDER BY t.id`,
  ).bind(recent, addDays(today, -ADVANCE_DAYS)).all()).results || [];
  const byPo = new Map();
  for (const r of rows) {
    if (!byPo.has(r.po)) byPo.set(r.po, []);
    byPo.get(r.po).push(r);
  }
  if (!byPo.size) return { advances: [], changes: [] };

  // What Insight said in the last ten minutes, and what it has to be asked.
  const known = new Map();
  if (!fresh) {
    for (const r of (await ctx.db.prepare("SELECT po, data FROM till_po_odoo WHERE checked_at >= datetime('now', ?1)")
      .bind(`-${PO_ODOO_MINUTES} minutes`).all().catch(() => ({ results: [] }))).results || []) {
      try { known.set(r.po, JSON.parse(r.data)); } catch { /* asked again */ }
    }
  }
  const ask = [...byPo.keys()].filter((po) => !known.has(po));
  const chunks = [];
  for (let i = 0; i < ask.length; i += 20) chunks.push(ask.slice(i, i + 20));
  let answers;
  try { answers = await Promise.all(chunks.map((names) => askInsight(ctx.env, names))); } catch { return { advances: [], changes: [], unchecked: true }; }
  for (const found of answers.flat()) {
    if (!found.name) continue;
    known.set(String(found.name).toUpperCase(), found);
    // eslint-disable-next-line no-await-in-loop
    await rememberOdoo(ctx.db, found);
  }
  const skipped = new Set(((await ctx.db.prepare('SELECT po, total FROM till_po_skip WHERE user_id = ?1')
    .bind(userId).all().catch(() => ({ results: [] }))).results || []).map((r) => `${r.po}|${r.total}`));

  const advances = [];
  const changes = [];
  for (const [po, list] of byPo) {
    const found = known.get(po);
    if (!found || found.safe || found.decision?.closed) continue;
    const claim = list.find((r) => (r.kind || 'claim') === 'claim') || list[0];
    const first = { day: claim.day, slot: claim.slot, by: claim.who || null, paid: Number(claim.paid) || 0 };
    const settled = found.confirmed && reportedOk(found);
    if (Number(claim.advance) === 1 && !settled) {
      const moreTime = found.decision?.until && found.decision.until >= today;
      if (!moreTime && earlierThan(claim, { day, slot })) {
        advances.push({
          name: found.name, vendor: found.vendor ?? null, total: found.total, paid: first.paid, first,
          status: found.state === 'cancel' ? 'cancel' : found.confirmed ? 'report' : 'approve',
        });
      }
      continue;
    }
    if (!settled || claim.day < recent) continue;
    const paid = list.reduce((t, r) => t + (Number(r.paid) || 0), 0);
    const diff = (Number(found.total) || 0) - paid;
    if (diff === 0) continue;
    changes.push({
      name: found.name, vendor: found.vendor ?? null, total: found.total, paidSoFar: paid,
      amount: diff, state: diff > 0 ? 'topup' : 'change', first, advance: Number(claim.advance) === 1,
      reported: found.reported || null, notMine: diff > 0 && skipped.has(`${po}|${found.total}`),
    });
  }
  return { advances, changes };
}

/** The Close shift screen's "From the last shift", for the shift it is on. */
export async function poChanges(ctx) {
  const tz = await timezoneOf(ctx.db);
  const shift = shiftAt(nowIn(tz));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(ctx.url.searchParams.get('day') || '') ? ctx.url.searchParams.get('day') : shift.day;
  const slot = SLOTS.includes(ctx.url.searchParams.get('slot')) ? ctx.url.searchParams.get('slot') : shift.slot;
  const out = await fromEarlier(ctx, { day, slot, userId: Number(ctx.session.user.id), fresh: ctx.url.searchParams.get('fresh') === '1' });
  return json({ ...out, changes: out.changes.filter((c) => !c.notMine) });
}

/** How long after its shift a refund or deficit is still the desk's to record. */
const PO_CHANGE_DAYS = 5;
/** How far back an unsettled advance is followed. */
const ADVANCE_DAYS = 60;
const PO_ODOO_MINUTES = 10;

/** Keep what Insight said about a PO for the next few minutes. */
async function rememberOdoo(db, found) {
  if (!found?.name) return;
  await db.prepare(
    `INSERT INTO till_po_odoo (po, data, checked_at) VALUES (?1, ?2, datetime('now'))
     ON CONFLICT (po) DO UPDATE SET data = ?2, checked_at = datetime('now')`,
  ).bind(String(found.name).toUpperCase(), JSON.stringify(found)).run().catch(() => {});
}

/** What stops a shift being signed, from earlier shifts, in words; empty when nothing does. */
export function earlierBlocks(earlier, expenses, notMine = []) {
  const out = [];
  const when = (f) => `${SLOT_LABEL[f.slot] || ''} ${f.day || ''}${f.by ? `, ${f.by}` : ''}`.trim();
  for (const a of earlier.advances || []) {
    const what = { approve: 'approve it in Odoo', report: 'report it on the expense form', cancel: 'cancelled in Odoo: an admin has to close it' }[a.status];
    out.push(`${a.name} advance of ${cedis(a.paid)} (${when(a.first)}): ${what}`);
  }
  const onReport = new Set(expenses.filter((e) => e.counted && e.kind !== 'claim').map((e) => e.name));
  for (const c of earlier.changes || []) {
    if (onReport.has(c.name) || c.notMine || (c.amount > 0 && notMine.includes(c.name))) continue;
    out.push(c.amount < 0
      ? `${c.name}: put the ${cedis(c.amount)} refund in the drawer and tap Done`
      : `${c.name}: ${cedis(c.amount)} more was paid. Tap Done if it was from your drawer, or Not on my shift`);
  }
  return out;
}

/** Look a PO up while somebody types it. Read-only all the way to Odoo. */
export async function lookUpPo(ctx) {
  const body = await readJson(ctx.request);
  // Several at once: each looked up the same way, in the order typed.
  if (Array.isArray(body.pos)) {
    const typed = [...new Set(body.pos.map((p) => String(p ?? '').trim()).filter(Boolean))];
    if (!typed.length) throw badRequest('Type at least one PO number.');
    if (typed.length > 20) throw badRequest('Twenty POs at most at once.');
    if (typed.some((p) => p.length > 30)) throw badRequest('That is not a PO number.');
    const found = [];
    // eslint-disable-next-line no-await-in-loop
    for (const po of typed) found.push({ po, ...(await checkPo(ctx, po)) });
    return json({ found });
  }
  const typed = str(body.po, 'PO number', { required: true, max: 30 });
  return json(await checkPo(ctx, typed));
}

// ---------------------------------------------------------------- signing --

/** Their own PIN, or their own password, checked at the moment of signing. */
async function reauthenticate(ctx, body) {
  const pepper = await getPepper(ctx.db);
  const user = await ctx.db.prepare('SELECT pin_hash, password_hash FROM users WHERE id = ?')
    .bind(ctx.session.user.id).first();
  if (!user) throw forbidden('That login no longer exists.');
  if (body.passwordKey && user.password_hash) {
    if (await verifyPasswordKey(body.passwordKey, user.password_hash, pepper)) return;
    throw forbidden('That password is not right.');
  }
  if (body.pin && user.pin_hash) {
    if (await hashPin(String(body.pin), pepper) === user.pin_hash) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
    throw forbidden('That PIN is not right.');
  }
  throw forbidden('Sign it with your own PIN.');
}

/**
 * Close a shift.
 *
 * Every figure is checked here rather than trusted from the screen, and every
 * PO is looked up again: what the screen showed a minute ago is a courtesy,
 * and a PO confirmed then may have been claimed by somebody else since.
 */
export async function closeShift(ctx) {
  const body = await readJson(ctx.request);
  const userId = Number(ctx.session.user.id);
  const tz = await timezoneOf(ctx.db);
  const choices = choicesFrom(shiftAt(nowIn(tz)));

  const day = String(body.day || '');
  const slot = String(body.slot || '');
  if (!choices.some((c) => c.day === day && c.slot === slot)) {
    throw badRequest('That shift cannot be closed from here: only this shift and the three before it.');
  }
  const already = await ctx.db.prepare('SELECT id FROM till_report WHERE day = ?1 AND slot = ?2 AND user_id = ?3 AND reopened_at IS NULL')
    .bind(day, slot, userId).first();
  if (already) throw new HttpError(409, 'You have already closed that shift. Ask a supervisor to reopen it if something was wrong.');

  if (typeof body.floatOk !== 'boolean') throw badRequest('Say whether your opening float was correct.');
  const floatDiff = body.floatOk ? null : pesewas(body.floatDiff, 'The float difference', { allowNegative: true });
  if (!body.floatOk && !floatDiff) throw badRequest('Say how much the float was out by.');
  const floatNote = body.floatOk ? null : str(body.floatNote, 'Explanation', { max: 600 });
  const cash = pesewas(body.cash, 'The cash in the drawer');

  if (typeof body.toSafe !== 'boolean') throw badRequest('Say whether you moved cash to the safe.');
  const envelopes = [];
  if (body.toSafe) {
    const list = Array.isArray(body.envelopes) ? body.envelopes : [];
    if (!list.length) throw badRequest('Give the envelope number and the amount in it.');
    if (list.length > 12) throw badRequest('Twelve envelopes at most on one report.');
    for (const e of list) {
      const no = String(e?.no ?? '').trim();
      if (!/^\d{1,8}$/.test(no)) throw badRequest('Envelope numbers are digits only, as written on the envelope.');
      if (envelopes.some((x) => x.no === no)) throw badRequest(`Envelope ${no} is there twice.`);
      const amount = pesewas(e?.amount, `The amount in envelope ${no}`, { min: 1 });
      envelopes.push({ no, amount });
    }
  }

  const setup = (await insightOrNull(ctx.env, '/api/link/till/setup', {})) || FALLBACK_SETUP;
  const rentals = {};
  for (const r of setup.rentals) {
    const v = body.rentals?.[r.id] || {};
    rentals[r.id] = { start: wholeCount(v.start, `${r.label} at the start`), end: wholeCount(v.end, `${r.label} at the end`) };
  }
  const checks = [];
  for (const c of setup.checks) {
    const v = (Array.isArray(body.checks) ? body.checks : []).find((x) => String(x?.id) === String(c.id)) || {};
    if (typeof v.ok !== 'boolean') throw badRequest(`Say whether the ${c.label.toLowerCase()} is at the front desk.`);
    const guest = v.ok ? null : str(v.guest, 'Guest', { max: 120 });
    const why = v.ok ? null : str(v.why, 'Explanation', { max: 400 });
    if (!v.ok && !guest && !why) throw badRequest(`The ${c.label.toLowerCase()} is not at the desk: say which guest has it, or explain.`);
    checks.push({ id: c.id, label: c.label, ok: v.ok, guest, why });
  }

  // Each expense is a PO number and nothing else. The amount is the PO's own
  // total in Odoo: what somebody types about what they paid is not evidence,
  // the confirmed order is. A PO Odoo cannot find counts for nothing.
  const lines = (Array.isArray(body.expenses) ? body.expenses : []).filter((e) => String(e?.po ?? '').trim());
  if (lines.length > 20) throw badRequest('Twenty expenses at most on one report.');
  const expenses = [];
  for (const line of lines) {
    const po = str(line.po, 'PO number', { required: true, max: 30 });
    let found;
    try { found = await checkPo(ctx, po); } catch { found = { typed: po, name: null, state: 'unchecked', counted: false }; }
    if (found.counted && expenses.some((x) => x.counted && x.name === found.name)) {
      found = { ...found, state: 'claimed', counted: false, claimed: { day, slot, by: ctx.session.user.name } };
    }
    expenses.push({
      po, paid: amountOf(found), name: found.name, state: found.state, vendor: found.vendor ?? null, total: found.total ?? null,
      counted: found.counted, claimed: found.claimed ?? null, kind: kindOf(found),
      ...(found.paidSoFar != null ? { paidSoFar: found.paidSoFar } : {}),
      ...(found.state === 'advance' ? { advance: true, odoo: found.odoo } : {}),
    });
  }

  // A cancelled PO is not spending anybody agreed to, and an approved one has
  // to be on the expense form first. A requisition goes in as an advance.
  const unapproved = expenses.filter((x) => notApproved(x));
  if (unapproved.length) {
    const list = unapproved.map((x) => `${x.name} (${notApproved(x)})`).join(', ');
    const fix = unapproved.every((x) => x.state === 'report') ? 'Report it on the expense form first, then close your shift.'
      : 'Sort it out first, then close your shift.';
    throw badRequest(`${unapproved.length === 1 ? 'This PO cannot go on the report' : 'These POs cannot go on the report'}: ${list}. `
      + `${fix} Or remove it from the report.`);
  }

  // What earlier shifts left: unsettled advances, and refunds or deficits.
  // Asked afresh. If Insight cannot be reached, nothing is held up by it.
  const notMine = (Array.isArray(body.notMine) ? body.notMine : []).map((n) => String(n).toUpperCase()).slice(0, 40);
  const earlier = await fromEarlier(ctx, { day, slot, userId, fresh: true }).catch(() => null);
  const blocks = earlier ? earlierBlocks(earlier, expenses, notMine) : [];
  if (blocks.length) throw badRequest(`To close: ${blocks.join('; ')}.`);

  await reauthenticate(ctx, body);
  for (const c of (earlier?.changes || []).filter((x) => x.amount > 0 && notMine.includes(String(x.name).toUpperCase()))) {
    // eslint-disable-next-line no-await-in-loop
    await ctx.db.prepare('INSERT OR IGNORE INTO till_po_skip (po, total, user_id) VALUES (?1, ?2, ?3)')
      .bind(String(c.name).toUpperCase(), c.total, userId).run().catch(() => {});
  }
  const note = str(body.note, 'Note', { max: 1000 });
  const device = ['phone', 'pc'].includes(body.device) ? body.device : null;

  const row = await ctx.db.prepare(
    `INSERT INTO till_report (day, slot, user_id, name, float_ok, float_diff, float_note, cash, to_safe,
       envelopes, expenses, rentals, checks, note, device, signed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16) RETURNING id`,
  ).bind(day, slot, userId, ctx.session.user.name, body.floatOk ? 1 : 0, floatDiff, floatNote, cash, body.toSafe ? 1 : 0,
    JSON.stringify(envelopes), JSON.stringify(expenses), JSON.stringify(rentals), JSON.stringify(checks), note, device, nowUtc()).first();
  const reportId = row.id;

  for (const e of expenses.filter((x) => x.counted)) {
    try {
      // A top-up or change back is the difference left now: if another shift
      // settled it in the last few seconds, there is nothing left to count.
      if (e.kind !== 'claim') {
        const now = await paidAgainst(ctx.db, e.name);
        if ((Number(e.total) || 0) - (now?.paid ?? 0) !== e.paid) throw new Error('settled elsewhere');
      }
      await ctx.db.prepare(
        `INSERT INTO till_po (po, kind, report_id, user_id, day, slot, paid, total, vendor, state, via, advance)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'report', ?11)`,
      ).bind(String(e.name).toUpperCase(), e.kind, reportId, userId, day, slot, e.paid, e.total, e.vendor, e.odoo || e.state, e.advance ? 1 : 0).run();
    } catch {
      // Claimed by somebody else in the last few seconds. It stays on the
      // report, uncounted, and shows up on their list like any other.
      e.counted = false;
      e.state = 'claimed';
    }
  }
  await ctx.db.prepare('UPDATE till_report SET expenses = ?2 WHERE id = ?1').bind(reportId, JSON.stringify(expenses)).run();

  await ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)')
    .bind(actorOf(ctx), 'till.closed', String(reportId), JSON.stringify({ day, slot })).run().catch(() => {});

  const report = { day, slot, cash, envelopes, expenses, rentals, checks, floatOk: body.floatOk, floatDiff, toSafe: body.toSafe };
  // Told the moment it is signed, by phone and email, to whoever Insight says
  // follows closed shifts. The morning summary is a separate choice there.
  const look = { name: ctx.session.user.name, device, rentalLabels: setup.rentals };
  await tell(ctx, 'closed', {
    title: `${labelOf({ day, slot })} closed · ${ctx.session.user.name}`,
    withAmounts: closedSummary(report, true),
    withoutAmounts: closedSummary(report, false),
    mailWith: safeMail(() => closedMail(report, true, look)),
    mailWithout: safeMail(() => closedMail(report, false, look)),
  });

  return json({ ok: true, id: reportId, report });
}

/** What a closed shift says in a notification, with or without the amounts. */
export function closedSummary(r, amounts) {
  const parts = [];
  parts.push(amounts ? `Drawer ${cedis(r.cash)}` : 'Drawer counted');
  if (r.toSafe) {
    const total = r.envelopes.reduce((t, e) => t + e.amount, 0);
    parts.push(`safe ${amounts ? `${cedis(total)} ` : ''}in envelope${r.envelopes.length > 1 ? 's' : ''} ${r.envelopes.map((e) => e.no).join(', ')}`);
  } else parts.push('nothing to the safe');
  const uncounted = r.expenses.filter((e) => !e.counted);
  if (uncounted.length) {
    const sum = uncounted.reduce((t, e) => t + e.paid, 0);
    parts.push(amounts ? `${cedis(sum)} of expenses with no confirmed PO` : 'an expense with no confirmed PO');
  }
  if (!r.floatOk) parts.push(amounts && r.floatDiff ? `float out by ${cedis(r.floatDiff)}` : 'float not right');
  const away = r.checks.filter((c) => !c.ok);
  for (const c of away) parts.push(`${c.label.toLowerCase()} not at the desk${c.guest ? ` (${c.guest})` : ''}`);
  for (const [id, v] of Object.entries(r.rentals || {})) if (v.start !== v.end) parts.push(`${id}s ${v.start} → ${v.end}`);
  return `${parts.join(' · ')}.`;
}

/** A mail layout, or none: an email must never stop the thing it is about. */
function safeMail(build) {
  try { return build() || undefined; } catch { return undefined; }
}

const slotWord = (slot) => (SLOT_LABEL[slot] ? SLOT_LABEL[slot].toLowerCase() : null);
const DEVICE_WORDS = { phone: 'From a phone', pc: 'From the desk computer' };

/** "2 pm to 10 pm" for a shift slot, as Insight places them. */
function slotHours(slot) {
  const i = SLOTS.indexOf(slot);
  if (i < 0) return null;
  const clock = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return sayHours(clock(SLOT_START[slot]), clock(SLOT_START[SLOTS[(i + 1) % SLOTS.length]]));
}

/**
 * The email for a closed shift. Without amounts it says what was done and
 * what is off, never how much: the same line closedSummary() draws.
 */
export function closedMail(r, amounts, { name, device, rentalLabels } = {}) {
  const who = name || 'Somebody';
  const slot = slotWord(r.slot);
  const envelopes = Array.isArray(r.envelopes) ? r.envelopes : [];
  const expenses = Array.isArray(r.expenses) ? r.expenses : [];
  const checks = Array.isArray(r.checks) ? r.checks : [];
  const uncounted = expenses.filter((e) => !e.counted);
  const counted = expenses.filter((e) => e.counted);
  const away = checks.filter((c) => !c.ok);
  const floatOff = !r.floatOk;
  const off = floatOff || uncounted.length > 0 || away.length > 0;

  const facts = [];
  facts.push(['Cash in the drawer', amounts ? cedis(r.cash ?? 0) : 'Counted', amounts ? { big: true, strong: true } : {}]);
  const safeTotal = envelopes.reduce((t, e) => t + (Number(e.amount) || 0), 0);
  facts.push(['To the safe', r.toSafe ? (amounts ? cedis(safeTotal) : 'Yes') : 'Nothing']);
  if (r.toSafe && envelopes.length) facts.push(['Envelopes', envelopes.map((e) => e.no).join(', ')]);
  const count = (n) => (n === 1 ? 'One' : String(n));
  if (uncounted.length) {
    const sum = uncounted.reduce((t, e) => t + (Number(e.paid) || 0), 0);
    facts.push(['Expenses with no confirmed PO', amounts && sum ? cedis(sum) : count(uncounted.length), { tone: 'warn' }]);
  }
  if (counted.length) {
    const sum = counted.reduce((t, e) => t + (Number(e.paid) || 0), 0);
    facts.push([uncounted.length ? 'Expenses with a confirmed PO' : 'Expenses', amounts && sum ? cedis(sum) : count(counted.length)]);
  } else if (!uncounted.length) facts.push(['Expenses', 'None']);
  let floatWords = null;
  if (floatOff) {
    const diff = Number(r.floatDiff) || 0;
    floatWords = amounts && diff ? `${cedis(diff)} ${diff < 0 ? 'short' : 'over'}` : (diff < 0 ? 'Short' : diff > 0 ? 'Over' : 'Not right');
    facts.push(['Float', floatWords, { tone: 'bad', strong: true }]);
  } else facts.push(['Float', 'Correct', { tone: 'good' }]);
  const labels = Object.fromEntries((Array.isArray(rentalLabels) ? rentalLabels : []).map((x) => [x.id, x.label]));
  for (const [id, v] of Object.entries(r.rentals || {})) {
    const label = labels[id] || `${id.charAt(0).toUpperCase()}${id.slice(1)}s`;
    facts.push([`${label} rented`, `${v?.start ?? '?'} → ${v?.end ?? '?'}`]);
  }

  const callout = away.length ? {
    tone: 'warn',
    text: away.map((c) => [
      `${c.label || 'Something'} not at the desk.`,
      c.guest ? `${c.guest} has it.` : null,
      c.why || null,
    ].filter(Boolean).join(' ')).join('\n'),
  } : null;

  const problem = floatOff ? `float ${floatWords.replace(/^[A-Z][a-z]/, (w) => w.toLowerCase())}`
    : uncounted.length ? 'an expense with no confirmed PO'
      : away.length ? `${(away[0].label || 'something').toLowerCase()} not at the desk` : null;

  return {
    tone: off ? 'warn' : 'good',
    status: off ? 'Closed · check' : 'Closed',
    eyebrow: 'Till',
    headline: slot ? `${who} closed the ${slot} shift` : `${who} closed a shift`,
    sub: [sayDate(r.day), slotHours(r.slot), DEVICE_WORDS[device]].filter(Boolean).join(' · '),
    facts,
    callout: callout || undefined,
    subject: `${slot ? `${SLOT_LABEL[r.slot]} shift` : 'A shift'} closed by ${firstName(who)} · ${problem || sayShortDate(r.day)}`,
    preheader: safeMail(() => closedSummary(r, amounts)),
    why: 'You get this because you follow till closings in Insight.',
  };
}

/**
 * Tell whoever Insight says to tell about `event`. Never fails the action that
 * caused it: a closed shift is closed whether or not a phone buzzed.
 */
/**
 * THE ADDRESS ON THEIR RECORD as well as the one on their login. A login
 * needs a PIN and nothing else, so most carry no address, and a person chosen
 * in Insight to hear about the till would otherwise get the bell and never the
 * email. Null when the login has an address of its own.
 */
async function recordEmail(db, userId) {
  const known = await db.prepare(
    `SELECT u.email AS login_email, hp.personal_email
       FROM users u LEFT JOIN hr_profile hp ON hp.staff_id = u.staff_id
      WHERE u.id = ?`,
  ).bind(Number(userId)).first().catch(() => null);
  return known && !isEmail(String(known.login_email || '').trim()) ? firstUsableEmail(known.personal_email) : null;
}

async function tell(ctx, event, { title, withAmounts, withoutAmounts, mailWith, mailWithout }) {
  const plan = await insightOrNull(ctx.env, '/api/link/till/recipients', { event });
  if (!plan) {
    // Insight did not answer, so nobody can be named. Said where the email log
    // is read, rather than nothing happening without a trace.
    await ctx.db.prepare('INSERT INTO email_log (kind, day, recipients, status, detail) VALUES (?, ?, ?, ?, ?)')
      .bind('notice', null, null, 'skipped', `till.${event}: Insight did not say who to tell`).run().catch(() => {});
    return;
  }
  for (const r of plan.to || []) {
    // eslint-disable-next-line no-await-in-loop
    const emailTo = r.email ? await recordEmail(ctx.db, r.userId) : null;
    // eslint-disable-next-line no-await-in-loop
    await createNotice(ctx.db, {
      kind: `till.${event}`, level: 'info', title, body: r.amounts ? withAmounts : withoutAmounts,
      actor: ctx.session?.user?.name ?? null, userId: r.userId, push: r.push, email: r.email, text: false,
      emailTo, mail: r.amounts ? mailWith : mailWithout,
    }, ctx);
  }
}

// ------------------------------------------------------------ To sort out --

/** Their own list, as Insight works it out. */
export async function myIssues(ctx) {
  const answer = await insight(ctx.env, '/api/link/till/issues', { userId: Number(ctx.session.user.id) });
  return json(answer);
}

/**
 * Answer something on their own list: explain it, offer to pay it back, or
 * give the PO that covers it.
 *
 * A PO is checked like one on a closing report, and once it is in, the
 * difference it covers is gone from the list by itself.
 */
export async function answer(ctx) {
  const body = await readJson(ctx.request);
  const userId = Number(ctx.session.user.id);
  const key = str(body.key, 'Which one', { required: true, max: 200 });
  const how = String(body.how || '');
  if (!['explain', 'repay', 'po'].includes(how)) throw badRequest('Explain it, pay it back, or give the PO.');

  // Only something actually on their list, so nobody answers for somebody else.
  const list = await insight(ctx.env, '/api/link/till/issues', { userId });
  const issue = (list.issues || []).find((i) => i.key === key);
  if (!issue) throw notFound('That is not on your list any more.');

  if (how === 'po') {
    if (issue.kind !== 'unexplained') throw badRequest('A PO only answers cash that left the drawer.');
    const typed = str(body.po, 'PO number', { required: true, max: 30 });
    const found = await checkPo(ctx, typed);
    if (found.state === 'change') throw badRequest(`${found.name} came down in price: money is due back on it, which does not explain cash leaving the drawer.`);
    // An advance belongs on the shift that gave it out, where the next shift
    // can see it. Afterwards, only an approved PO answers.
    if (found.state === 'advance') throw badRequest(`${found.name} is not approved in Odoo yet: it is still a requisition. Get it approved, then add it here.`);
    if (!found.counted) {
      const why = { missing: 'is not in Odoo', claimed: 'has already been claimed', unconfirmed: 'is not approved in Odoo yet', report: 'is approved but not on the expense form yet: report it there first' }[found.state]
        || `is ${found.state} in Odoo, not approved`;
      throw badRequest(`${found.name || typed} ${why}.`);
    }
    // The PO's own total (or, for a top-up, what is left of it), never a typed amount.
    const paid = amountOf(found);
    const report = await ctx.db.prepare('SELECT id FROM till_report WHERE day = ?1 AND slot = ?2 AND user_id = ?3 AND reopened_at IS NULL')
      .bind(issue.day, issue.slot, userId).first();
    await ctx.db.prepare(
      `INSERT INTO till_po (po, kind, report_id, user_id, day, slot, paid, total, vendor, state, via, advance)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'answer', ?11)`,
    ).bind(String(found.name).toUpperCase(), kindOf(found), report?.id ?? null, userId, issue.day, issue.slot, paid, found.total, found.vendor,
      found.odoo || found.state, found.advance ? 1 : 0).run();
    await ctx.db.prepare('INSERT INTO till_answer (key, user_id, how, text, po, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(key, userId, 'po', `${found.name}, ${found.vendor || 'Odoo'}, ${cedis(Math.min(paid, found.total))}`, found.name, nowUtc()).run();
    return json({ ok: true, found });
  }

  const text = str(body.text, how === 'repay' ? 'How you will pay it back' : 'Your explanation', { required: true, max: 1000 });
  await ctx.db.prepare('INSERT INTO till_answer (key, user_id, how, text, at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(key, userId, how, text, nowUtc()).run();
  const what = `${SLOT_LABEL[issue.slot]} · ${issue.day}`;
  const answerMail = (amounts) => {
    const who = ctx.session.user.name;
    const slot = slotWord(issue.slot);
    const shift = slot ? `the ${slot} shift` : 'a shift';
    return {
      tone: 'info', status: 'Answered', eyebrow: 'Till',
      headline: `${who} answered for ${shift} till`,
      sub: issue.day ? sayDate(issue.day) : undefined,
      facts: [
        ['Shift', [SLOT_LABEL[issue.slot], issue.day ? sayShortDate(issue.day) : null].filter(Boolean).join(', ')],
        ['Issue', issue.label],
        amounts && issue.amount ? ['Amount', cedis(issue.amount), { tone: 'bad' }] : null,
        how === 'repay' ? ['Will pay it back', 'Yes'] : null,
      ].filter(Boolean),
      quote: { by: `${firstName(who)} says`, text },
      subject: `${firstName(who)} answered for ${shift}${issue.day ? ` on ${sayShortDate(issue.day)}` : ''}`,
      preheader: `${issue.label || 'A till issue'}${amounts && issue.amount ? ` ${cedis(issue.amount)}` : ''}.${how === 'repay' ? ' Will pay it back.' : ''}`,
      why: 'You get this because you follow till issues in Insight.',
    };
  };
  await tell(ctx, 'answer', {
    title: `${ctx.session.user.name} answered for ${what}`,
    withAmounts: `${issue.label}${issue.amount ? ` (${cedis(issue.amount)})` : ''}. ${how === 'repay' ? 'Will pay it back: ' : ''}${text}`,
    withoutAmounts: `${issue.label}. ${how === 'repay' ? 'Will pay it back: ' : ''}${text}`,
    mailWith: safeMail(() => answerMail(true)),
    mailWithout: safeMail(() => answerMail(false)),
  });
  return json({ ok: true });
}

// ------------------------------------------------------ Insight, asking us --

/** Check a request came from Insight, and read its body. */
async function fromInsight(ctx) {
  const text = await ctx.request.text();
  const ok = await verifyLink(ctx.env.INSIGHT_SSO_SECRET, {
    at: ctx.request.headers.get('X-Till-At'), sig: ctx.request.headers.get('X-Till-Sig'), path: ctx.url.pathname, bodyText: text,
  });
  if (!ok) throw new HttpError(401, 'That request did not come from Insight.');
  try { return JSON.parse(text || '{}'); } catch { throw badRequest('That was not JSON.'); }
}

/**
 * Take a shortage from somebody's pay.
 *
 * As an advance: money they owe, agreed and approved, one month, coming off
 * the next payslip the way any advance does. The payroll already knows how to
 * take an advance back and how to show it on a payslip, and a second way of
 * taking money off pay would be a second thing to get wrong.
 */
export async function linkRecover(ctx) {
  const body = await fromInsight(ctx);
  const userId = Number(body.userId);
  const amount = Number(body.amount);
  if (!Number.isInteger(userId) || !Number.isInteger(amount) || amount <= 0) throw badRequest('Whose pay, and how much?');
  const user = await ctx.db.prepare('SELECT id, name, staff_id FROM users WHERE id = ?1').bind(userId).first();
  if (!user) throw notFound('That HIVE login no longer exists.');
  if (!user.staff_id) throw badRequest(`${user.name}'s login is not linked to a staff record in HIVE, so there is no pay to take it from.`);
  const tz = await timezoneOf(ctx.db);
  const today = todayIn(tz);
  const cedi = amount / 100;
  const reason = str(body.reason, 'Reason', { max: 300 }) || 'Till shortage';
  const by = str(body.by, 'By', { max: 120 }) || 'Insight';
  const currency = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'currency'").first().catch(() => null))?.value || 'GHS';
  const startMonth = firstMonthFor(today);
  const row = await ctx.db.prepare(
    `INSERT INTO hr_advance (staff_id, amount, months, monthly, currency, reason, status, taken_on, start_month,
       asked_by, decided_by, decided_at, decision, purpose)
     VALUES (?1, ?2, 1, ?2, ?3, ?4, 'approved', ?5, ?6, ?7, ?7, datetime('now'), ?8, 'other') RETURNING id`,
  ).bind(user.staff_id, cedi, currency, reason, today, startMonth, `${by} (Insight)`,
    'A till shortage, recovered from pay as agreed under My till').first();

  await createNotice(ctx.db, {
    kind: 'till.recovered', level: 'warn', title: `${cedis(amount)} till shortage to come off ${user.name}'s pay`,
    body: `${reason}. Recorded as an advance coming off ${startMonth}, decided by ${by}.`,
    link: '#/att-advances', audience: 'hr_pay', text: false,
    mail: safeMail(() => ({
      tone: 'warn', status: 'Off their pay', eyebrow: 'Till',
      headline: `${cedis(amount)} till shortage will come off ${user.name}'s pay`,
      facts: [
        ['Amount', cedis(amount), { big: true, strong: true }],
        ['Comes off', startMonth ? `${sayMonth(startMonth)} pay` : 'The next pay'],
        ['Reason', reason],
        ['Decided by', by],
      ],
      note: 'It is recorded as an advance, so it comes off the payslip the way any advance does.',
      button: 'See the advances',
      subject: `${cedis(amount)} till shortage to come off ${user.name}'s pay`,
      preheader: `${reason}. Decided by ${by}.`,
      why: 'You get this because you handle pay.',
    })),
  }, ctx);
  await createNotice(ctx.db, {
    kind: 'till.recovered', level: 'info', title: `${cedis(amount)} will come off your next pay`,
    body: `${reason}. You can see it under My pay → My advance.`, userId, text: false,
    mail: safeMail(() => ({
      tone: 'warn', status: 'Off your pay', eyebrow: 'Till',
      headline: `${cedis(amount)} will come off your next pay`,
      facts: [
        ['Amount', cedis(amount), { strong: true }],
        ['Comes off', startMonth ? `${sayMonth(startMonth)} pay` : 'Your next pay'],
        ['Reason', reason],
        ['Decided by', by],
      ],
      note: 'You can see it under My pay, then My advance.',
      subject: `${cedis(amount)} will come off your next pay`,
      preheader: `${reason}.`,
      why: 'You get this because it affects your pay.',
    })),
  }, ctx);
  return json({ ok: true, advanceId: row?.id ?? null });
}

/** Reopen a signed report so its person can send it again. */
export async function linkReopen(ctx) {
  const body = await fromInsight(ctx);
  const id = Number(body.reportId);
  const report = await ctx.db.prepare('SELECT * FROM till_report WHERE id = ?1 AND reopened_at IS NULL').bind(id).first();
  if (!report) throw notFound('That report is not open to reopen.');
  const reason = str(body.reason, 'Reason', { required: true, max: 400 });
  const by = str(body.by, 'By', { max: 120 }) || 'Insight';
  await ctx.db.prepare('UPDATE till_report SET reopened_at = ?2, reopened_by = ?3, reopen_reason = ?4 WHERE id = ?1')
    .bind(id, nowUtc(), by, reason).run();
  await ctx.db.prepare("DELETE FROM till_po WHERE report_id = ?1 AND via = 'report'").bind(id).run();
  await createNotice(ctx.db, {
    kind: 'till.reopened', level: 'warn', title: `Your closing report for ${labelOf(report)} was reopened`,
    body: `${by}: ${reason}. Close it again under My till.`, link: '#/att-my-till', userId: report.user_id, text: false,
    mail: safeMail(() => ({
      tone: 'warn', status: 'Action needed', eyebrow: 'Till',
      headline: 'Your closing report was reopened',
      sub: [SLOT_LABEL[report.slot] ? `${SLOT_LABEL[report.slot]} shift` : null, sayDate(report.day)].filter(Boolean).join(' · '),
      quote: { by: `${by} says`, text: reason },
      note: 'Correct it and close it again under My till.',
      button: 'Close it again',
      subject: `Your ${slotWord(report.slot) ? `${slotWord(report.slot)} shift ` : ''}report for ${sayShortDate(report.day)} was reopened`,
      preheader: `${by}: ${reason}`,
      why: 'You get this because this is your closing report.',
    })),
  }, ctx);
  return json({ ok: true });
}

/**
 * Move a closing report to the shift it belongs to, for Insight.
 *
 * A report filed on the shift beside the one ASSD has its writer on (closed
 * after eleven, so the clock offered the night) is the same report on the
 * wrong row. Its POs move with it. Refused if its writer already has a report
 * on that shift.
 */
export async function linkMove(ctx) {
  const body = await fromInsight(ctx);
  const id = Number(body.reportId);
  const report = await ctx.db.prepare('SELECT * FROM till_report WHERE id = ?1 AND reopened_at IS NULL').bind(id).first();
  if (!report) throw notFound('That report is not open to move.');
  const day = String(body.day || '');
  const slot = String(body.slot || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !SLOTS.includes(slot)) throw badRequest('Which shift?');
  if (day === report.day && slot === report.slot) return json({ ok: true, moved: false });
  const taken = await ctx.db.prepare('SELECT id FROM till_report WHERE day = ?1 AND slot = ?2 AND user_id = ?3 AND reopened_at IS NULL')
    .bind(day, slot, report.user_id).first();
  if (taken) throw badRequest(`${report.name} already has a report for ${labelOf({ day, slot })}.`);
  const by = str(body.by, 'By', { max: 120 }) || 'Insight';
  await ctx.db.prepare('UPDATE till_report SET day = ?2, slot = ?3 WHERE id = ?1').bind(id, day, slot).run();
  await ctx.db.prepare('UPDATE till_po SET day = ?2, slot = ?3 WHERE report_id = ?1').bind(id, day, slot).run();
  await createNotice(ctx.db, {
    kind: 'till.reopened', level: 'info', title: `Your closing report was moved to ${labelOf({ day, slot })}`,
    body: `${by} moved it from ${labelOf(report)}, the shift ASSD has you on. Nothing else in it changed.`,
    link: '#/att-my-till', userId: report.user_id, push: false, email: true, text: false,
    mail: safeMail(() => {
      const shift = (s) => [SLOT_LABEL[s.slot] ? `${SLOT_LABEL[s.slot]} shift` : null, sayShortDate(s.day)].filter(Boolean).join(', ');
      return {
        tone: 'info', status: 'Moved', eyebrow: 'Till',
        headline: 'Your closing report was moved to another shift',
        sub: [SLOT_LABEL[slot] ? `${SLOT_LABEL[slot]} shift` : null, sayDate(day)].filter(Boolean).join(' · '),
        facts: [['Was on', shift(report)], ['Now on', shift({ day, slot })], ['Moved by', by]],
        note: 'It now sits on the shift ASSD has you on. Nothing else in it changed.',
        button: 'See My till',
        subject: `Your closing report was moved to ${slotWord(slot) ? `the ${slotWord(slot)} shift` : 'another shift'} on ${sayShortDate(day)}`,
        preheader: `${by} moved it from the ${shift(report)}. Nothing else changed.`,
        why: 'You get this because this is your closing report.',
      };
    }),
  }, ctx);
  return json({ ok: true, moved: true, from: { day: report.day, slot: report.slot }, to: { day, slot } });
}

/** Insight's own words, in the design, with the label that fits. */
function tellMail(kind, title, text) {
  if (kind === 'till.moved') {
    return {
      tone: 'warn', status: 'On your account', eyebrow: 'Till',
      headline: title, intro: text || undefined,
      button: 'See my till list',
      subject: title, preheader: text || undefined,
      why: 'You get this because an admin put a till difference on your account, or took it off.',
    };
  }
  if (kind === 'till.approval') {
    return {
      tone: 'warn', status: 'Needs your answer', eyebrow: 'Till',
      headline: title, intro: text || undefined,
      subject: title, preheader: text || undefined,
      why: 'You get this because you approve till corrections.',
    };
  }
  const sentBack = /sent back|returned|not accepted|rejected|refused/i.test(`${title} ${text || ''}`);
  return {
    tone: sentBack ? 'warn' : 'good', status: sentBack ? 'Sent back' : 'Settled', eyebrow: 'Till',
    headline: title, intro: text || undefined,
    button: 'See my till list',
    subject: title, preheader: text || undefined,
    why: 'You get this because it is about your till.',
  };
}

/**
 * A refund is coming back to a drawer: tell whoever is on the rota for the
 * next reception shift to expect that much more cash than ASSD shows, and
 * why. Nobody rostered: the people Insight tells about closed shifts instead.
 * Deficits are never sent here.
 */
export async function linkExpect(ctx) {
  const body = await fromInsight(ctx);
  const po = str(body.po, 'PO', { required: true, max: 30 });
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('How much is coming back?');
  const tz = await timezoneOf(ctx.db);
  const vendor = str(body.vendor, 'Vendor', { max: 120 });
  const by = str(body.by, 'By', { max: 120 });
  const paid = Number(body.paid) || 0;
  const total = Number(body.total) || 0;
  const tnt = Number(body.reported?.tnt) || 0;
  const shift = SLOT_LABEL[body.slot] && /^\d{4}-\d{2}-\d{2}$/.test(String(body.day || ''))
    ? `${SLOT_LABEL[body.slot].toLowerCase()} shift of ${sayShortDate(body.day)}` : 'an earlier shift';
  const bought = tnt ? `${cedis(total)} (${cedis(total - tnt)} + ${cedis(tnt)} TnT)` : cedis(total);
  const title = `Your next shift: expect ${cedis(amount)} more than ASSD`;
  const text = `${po}${vendor ? `, ${vendor}` : ''}: ${cedis(paid)} was advanced from the drawer on the ${shift}${by ? ` by ${by}` : ''}, `
    + `and it was bought for ${bought}. The ${cedis(amount)} change comes back into the drawer. Put it in, and tap Done for it under Close shift.`;
  const mail = safeMail(() => ({
    tone: 'info', status: 'Expect cash', eyebrow: 'Till',
    headline: title, sub: `${po}${vendor ? ` · ${vendor}` : ''}`,
    facts: [
      ['PO', `${po}${vendor ? `, ${vendor}` : ''}`],
      ['Advanced', `${cedis(paid)}, ${shift}${by ? `, ${by}` : ''}`],
      ['Bought for', bought],
      ['Coming back', cedis(amount), { tone: 'good', strong: true }],
    ],
    note: 'ASSD will show it as a surplus on the shift it comes in. Put it in the drawer and tap Done for it under Close shift.',
    button: 'Close shift',
    subject: title, preheader: text,
    why: 'You get this because you are on the next reception shift.',
  }));

  const people = await nextOnReception(ctx.db, { timezone: tz }).catch(() => []);
  let to = people.map((p) => ({ userId: p.userId, name: p.name, push: true, email: true, emailTo: p.emailTo }));
  if (!to.length) {
    const plan = await insightOrNull(ctx.env, '/api/link/till/recipients', { event: 'closed' });
    to = (plan?.to || []).map((r) => ({ userId: r.userId, name: r.name, push: r.push, email: r.email, emailTo: null }));
  }
  for (const p of to.slice(0, 20)) {
    // eslint-disable-next-line no-await-in-loop
    await createNotice(ctx.db, {
      kind: 'till.expect', level: 'info', title, body: text, link: '#/att-my-till', actor: 'HIVE',
      userId: Number(p.userId), push: p.push !== false, email: Boolean(p.email), emailTo: p.emailTo || null, text: false, mail,
    }, ctx);
  }
  return json({ ok: true, sentTo: to.length ? to.map((p) => p.name).filter(Boolean).join(', ') || `${to.length} people` : 'nobody' });
}

/**
 * The daily till summary, sent by Insight each morning: yesterday's shifts and
 * what waits for an admin, to whoever Insight says gets it, with or without
 * the amounts.
 */
export async function linkSummary(ctx) {
  const body = await fromInsight(ctx);
  const title = str(body.title, 'Title', { required: true, max: 200 });
  const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 6);
  const needs = (Array.isArray(body.needs) ? body.needs : []).slice(0, 12);
  const insightUrl = (() => { try { return new URL(ctx.env.INSIGHT_SSO_URL).origin; } catch { return null; } })();
  let sent = 0;
  for (const p of (Array.isArray(body.recipients) ? body.recipients : []).slice(0, 50)) {
    const userId = Number(p.userId);
    if (!Number.isInteger(userId)) continue;
    const amounts = Boolean(p.amounts);
    const sub = String((amounts ? body.subWith : body.sub) || '').slice(0, 300);
    // eslint-disable-next-line no-await-in-loop
    const emailTo = p.email ? await recordEmail(ctx.db, userId) : null;
    const toneOf = { good: 'good', warn: 'warn', bad: 'bad' };
    const facts = [
      ...lines.map((l) => [String(l.label || '').slice(0, 80), String((amounts ? l.with : l.without) || '').slice(0, 80), toneOf[l.tone] ? { tone: toneOf[l.tone], strong: l.tone !== 'good' } : undefined]),
      ...(needs.length ? needs.map(([label, value]) => [String(label || '').slice(0, 120), String(value || '').slice(0, 40), { tone: 'warn' }]) : [['Needs you', 'Nothing', { tone: 'good' }]]),
    ];
    // eslint-disable-next-line no-await-in-loop
    await createNotice(ctx.db, {
      kind: 'till.summary', level: 'info', title, body: sub, link: insightUrl ? `${insightUrl}/#/shifts` : null, actor: 'Insight',
      userId, push: p.push !== false, email: Boolean(p.email), emailTo, text: false,
      mail: safeMail(() => ({
        tone: needs.length ? 'warn' : 'good', status: 'Daily summary', eyebrow: 'Till',
        headline: title, sub, facts,
        note: needs.length ? 'Open the Inbox in Insight to deal with what is waiting.' : 'Nothing is waiting for you.',
        button: insightUrl ? 'Open the Inbox' : undefined,
        subject: title, preheader: sub,
        why: 'You get this because you follow the till in Insight.',
      })),
    }, ctx);
    sent += 1;
  }
  return json({ ok: true, sent });
}

/** Tell people something Insight decided. */
export async function linkTell(ctx) {
  const body = await fromInsight(ctx);
  const kind = ['till.settled', 'till.approval', 'till.moved'].includes(body.kind) ? body.kind : 'till.settled';
  const title = str(body.title, 'Title', { required: true, max: 200 });
  const text = str(body.body, 'Body', { max: 800 });
  const people = Array.isArray(body.recipients)
    ? body.recipients
    : (Array.isArray(body.userIds) ? body.userIds : []).map((userId) => ({ userId, push: true, email: kind !== 'till.settled' }));
  for (const p of people.slice(0, 50)) {
    if (!Number.isInteger(Number(p.userId))) continue;
    // eslint-disable-next-line no-await-in-loop
    await createNotice(ctx.db, {
      kind, level: 'info', title, body: text, link: kind === 'till.approval' ? null : '#/att-my-till-issues',
      userId: Number(p.userId), push: p.push !== false, email: Boolean(p.email), text: false,
      mail: safeMail(() => tellMail(kind, title, text)),
    }, ctx);
  }
  return json({ ok: true });
}

/**
 * Send one email for Insight: an invitation, or word that somebody joined.
 *
 * Insight has no mail provider of its own and should not grow one. HIVE
 * already holds the key, the sending address and a log of what went, so
 * Insight asks it over the same signed link and the mail comes from the
 * address staff already know. One recipient per call, and nothing is ever
 * addressed from what the body says: the sender is HIVE's own.
 */
export async function linkMail(ctx) {
  const body = await fromInsight(ctx);
  const to = String(body.to ?? '').trim();
  if (!isEmail(to)) throw badRequest('That is not an email address.');
  const subject = str(body.subject, 'Subject', { required: true, max: 200 });
  const html = str(body.html, 'Message', { required: true, max: 60000 });
  const text = str(body.text, 'Plain text', { max: 20000 }) || undefined;
  const kind = /^[a-z_.]{1,40}$/.test(String(body.kind ?? '')) ? body.kind : 'insight';
  // A list Insight attaches (a month's prepaid stays): a CSV, by name, small.
  const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 2).map((a) => {
    const filename = String(a?.filename ?? '');
    const content = String(a?.content ?? '');
    if (!/^[A-Za-z0-9._-]{1,80}\.csv$/.test(filename)) throw badRequest('Only a CSV can be attached.');
    if (!/^[A-Za-z0-9+/=]+$/.test(content) || content.length > 1_400_000) throw badRequest('That attachment is not a small CSV.');
    return { filename, content };
  });

  const rows = await ctx.db.prepare('SELECT key, value FROM settings WHERE key IN (\'email_from\', \'email_reply_to\')').all();
  const settings = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  const log = (status, detail) => ctx.db.prepare(
    'INSERT INTO email_log (kind, day, recipients, status, detail) VALUES (?, ?, ?, ?, ?)',
  ).bind(kind, todayIn(), to, status, detail ? String(detail).slice(0, 500) : null).run().catch(() => {});

  const missing = !ctx.env.RESEND_API_KEY ? 'HIVE has no email provider key set'
    : !settings.email_from ? 'HIVE has no "from" address set (Setup → Email)' : null;
  if (missing) {
    await log('skipped', missing);
    throw new HttpError(503, `Could not email: ${missing}.`);
  }
  try {
    await sendEmail({
      apiKey: ctx.env.RESEND_API_KEY,
      from: senderWithName(settings.email_from, str(body.senderName, 'Sender', { max: 60 }) || 'Insight'),
      to,
      subject,
      html,
      text,
      replyTo: isEmail(body.replyTo) ? body.replyTo : ((settings.email_reply_to || '').trim() || null),
      attachments,
    });
  } catch (err) {
    await log('failed', err.message);
    throw new HttpError(502, `The email provider refused it: ${err.message}`);
  }
  await log('sent');
  return json({ ok: true });
}
