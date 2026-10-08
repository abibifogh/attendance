import {
  badRequest, forbidden, HttpError, json, notFound, readJson, str,
} from '../lib/http.js';
import { getPepper, hashPin, verifyPasswordKey } from '../lib/auth.js';
import { createNotice } from '../lib/notices.js';
import { callLink, verifyLink } from '../lib/till-link.js';
import { addDays, nowIn, todayIn } from '../util/dates.js';
import { firstMonthFor } from '../lib/advances.js';
import { isEmail, sendEmail, senderWithName } from '../lib/notify.js';

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

/** Whether a PO is in Odoo, confirmed, and not already claimed here. */
async function checkPo(ctx, typed) {
  const answer = await insight(ctx.env, '/api/link/till/po', { names: [typed] });
  const found = answer?.found?.[0] || { typed, name: null };
  if (!found.name) return { ...found, state: 'missing', counted: false };
  const claimed = await ctx.db.prepare('SELECT t.*, r.name AS who FROM till_po t LEFT JOIN till_report r ON r.id = t.report_id WHERE t.po = ?1')
    .bind(String(found.name).toUpperCase()).first();
  if (claimed) {
    return {
      ...found, state: 'claimed', counted: false,
      claimed: { day: claimed.day, slot: claimed.slot, by: claimed.who || null },
    };
  }
  return { ...found, state: found.confirmed ? 'confirmed' : found.state || 'unconfirmed', counted: Boolean(found.confirmed) };
}

/** Look a PO up while somebody types it. Read-only all the way to Odoo. */
export async function lookUpPo(ctx) {
  const body = await readJson(ctx.request);
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

  const lines = (Array.isArray(body.expenses) ? body.expenses : []).filter((e) => String(e?.po ?? '').trim() || String(e?.paid ?? '').trim());
  if (lines.length > 20) throw badRequest('Twenty expenses at most on one report.');
  const expenses = [];
  for (const line of lines) {
    const po = str(line.po, 'PO number', { max: 30 });
    const paid = pesewas(line.paid, `What you paid${po ? ` on ${po}` : ''}`, { min: 1 });
    if (!po) { expenses.push({ po: null, paid, state: 'no-po', counted: false }); continue; }
    let found;
    try { found = await checkPo(ctx, po); } catch { found = { typed: po, name: null, state: 'unchecked', counted: false }; }
    if (found.counted && expenses.some((x) => x.counted && x.name === found.name)) {
      found = { ...found, state: 'claimed', counted: false, claimed: { day, slot, by: ctx.session.user.name } };
    }
    expenses.push({
      po, paid, name: found.name, state: found.state, vendor: found.vendor ?? null, total: found.total ?? null,
      counted: found.counted, claimed: found.claimed ?? null,
    });
  }

  await reauthenticate(ctx, body);
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
      await ctx.db.prepare(
        `INSERT INTO till_po (po, report_id, user_id, day, slot, paid, total, vendor, state, via)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'report')`,
      ).bind(String(e.name).toUpperCase(), reportId, userId, day, slot, e.paid, e.total, e.vendor, e.state).run();
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
  await tell(ctx, 'closed', {
    title: `${labelOf({ day, slot })} closed · ${ctx.session.user.name}`,
    withAmounts: closedSummary(report, true),
    withoutAmounts: closedSummary(report, false),
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

/**
 * Tell whoever Insight says to tell about `event`. Never fails the action that
 * caused it: a closed shift is closed whether or not a phone buzzed.
 */
async function tell(ctx, event, { title, withAmounts, withoutAmounts }) {
  const plan = await insightOrNull(ctx.env, '/api/link/till/recipients', { event });
  for (const r of plan?.to || []) {
    // eslint-disable-next-line no-await-in-loop
    await createNotice(ctx.db, {
      kind: `till.${event}`, level: 'info', title, body: r.amounts ? withAmounts : withoutAmounts,
      actor: ctx.session?.user?.name ?? null, userId: r.userId, push: r.push, email: r.email, text: false,
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
    if (!found.counted) {
      const why = { missing: 'is not in Odoo', claimed: 'has already been claimed', unconfirmed: 'is not confirmed in Odoo yet' }[found.state]
        || `is ${found.state} in Odoo, not confirmed`;
      throw badRequest(`${found.name || typed} ${why}.`);
    }
    const paid = pesewas(body.paid, 'What you paid', { required: false, min: 1 }) ?? found.total;
    const report = await ctx.db.prepare('SELECT id FROM till_report WHERE day = ?1 AND slot = ?2 AND user_id = ?3 AND reopened_at IS NULL')
      .bind(issue.day, issue.slot, userId).first();
    await ctx.db.prepare(
      `INSERT INTO till_po (po, report_id, user_id, day, slot, paid, total, vendor, state, via)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'answer')`,
    ).bind(String(found.name).toUpperCase(), report?.id ?? null, userId, issue.day, issue.slot, paid, found.total, found.vendor, found.state).run();
    await ctx.db.prepare('INSERT INTO till_answer (key, user_id, how, text, po, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(key, userId, 'po', `${found.name}, ${found.vendor || 'Odoo'}, ${cedis(Math.min(paid, found.total))}`, found.name, nowUtc()).run();
    return json({ ok: true, found });
  }

  const text = str(body.text, how === 'repay' ? 'How you will pay it back' : 'Your explanation', { required: true, max: 1000 });
  await ctx.db.prepare('INSERT INTO till_answer (key, user_id, how, text, at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(key, userId, how, text, nowUtc()).run();
  const what = `${SLOT_LABEL[issue.slot]} · ${issue.day}`;
  await tell(ctx, 'answer', {
    title: `${ctx.session.user.name} answered for ${what}`,
    withAmounts: `${issue.label}${issue.amount ? ` (${cedis(issue.amount)})` : ''}. ${how === 'repay' ? 'Will pay it back: ' : ''}${text}`,
    withoutAmounts: `${issue.label}. ${how === 'repay' ? 'Will pay it back: ' : ''}${text}`,
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
  }, ctx);
  await createNotice(ctx.db, {
    kind: 'till.recovered', level: 'info', title: `${cedis(amount)} will come off your next pay`,
    body: `${reason}. You can see it under My pay → My advance.`, userId, text: false,
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
  }, ctx);
  return json({ ok: true });
}

/** Tell people something Insight decided. */
export async function linkTell(ctx) {
  const body = await fromInsight(ctx);
  const kind = ['till.settled', 'till.approval'].includes(body.kind) ? body.kind : 'till.settled';
  const title = str(body.title, 'Title', { required: true, max: 200 });
  const text = str(body.body, 'Body', { max: 800 });
  const people = Array.isArray(body.recipients)
    ? body.recipients
    : (Array.isArray(body.userIds) ? body.userIds : []).map((userId) => ({ userId, push: true, email: kind !== 'till.settled' }));
  for (const p of people.slice(0, 50)) {
    if (!Number.isInteger(Number(p.userId))) continue;
    // eslint-disable-next-line no-await-in-loop
    await createNotice(ctx.db, {
      kind, level: 'info', title, body: text, link: kind === 'till.settled' ? '#/att-my-till-issues' : null,
      userId: Number(p.userId), push: p.push !== false, email: Boolean(p.email), text: false,
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
    });
  } catch (err) {
    await log('failed', err.message);
    throw new HttpError(502, `The email provider refused it: ${err.message}`);
  }
  await log('sent');
  return json({ ok: true });
}
