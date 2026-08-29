import {
  badRequest, csvResponse, forbidden, int, json, notFound, num, readJson, str,
} from '../lib/http.js';
import { readAdvanceSheet, tallyOf } from '../lib/advance-import.js';
import { createNotice } from '../lib/notices.js';
import { readFile, storeFile } from './people.js';
import {
  PURPOSES, accountFor, balanceOf, checkRequest, dueThisMonth, finishesOn, firstMonthFor,
  instalmentFor, isMonthEnd, isOpen, monthsLeft, purposeOf, purposesFor, repaidOf, round2,
  reconcilePlan, scheduleFor, summarise, unansweredMonths,
} from '../lib/advances.js';
import { isAdmin } from '../lib/payroll-access.js';
import { addMonths, isDay, isMonth, monthOf, todayIn } from '../util/dates.js';

/**
 * Salary advances: who owes what, and what came off this month.
 *
 * Two audiences and one ledger. Whoever does the wages sees everybody, agrees
 * the terms and records what was actually deducted; the person paying it back
 * sees their own, and nothing else.
 *
 * THE MONTH-END QUESTION IS THE WHOLE POINT. Everything else here is
 * bookkeeping around one habit: on the last day of the month somebody is asked
 * whether the deduction was taken, person by person, and answers. Without that
 * the ledger drifts from the payslips within two months and is then worse than
 * no ledger at all, because it looks authoritative.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(actorOf(ctx), action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

async function settingsOf(db) {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('timezone','currency')")
    .all().catch(() => ({ results: [] }));
  const map = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  return { timezone: map.timezone || 'UTC', currency: map.currency || 'GHS' };
}

/** Every advance and every movement, indexed. Small tables; read whole. */
async function ledger(db, { staffId = null } = {}) {
  const advances = staffId
    ? await db.prepare('SELECT * FROM hr_advance WHERE staff_id = ? ORDER BY id DESC')
      .bind(staffId).all()
    : await db.prepare('SELECT * FROM hr_advance ORDER BY id DESC').all();

  const rows = advances.results ?? [];
  const ids = rows.map((r) => r.id);
  const entriesBy = new Map(ids.map((id) => [id, []]));

  if (ids.length) {
    const entries = await db.prepare(
      `SELECT * FROM hr_advance_entry WHERE advance_id IN (${ids.map(() => '?').join(',')})
        ORDER BY month, id`,
    ).bind(...ids).all();
    for (const entry of entries.results ?? []) entriesBy.get(entry.advance_id)?.push(entry);
  }

  return { advances: rows, entriesBy };
}

/** One advance, dressed for a screen. */
function shape(advance, entries, { withSchedule = false, asOfMonth = null } = {}) {
  const balance = balanceOf(advance, entries);
  return {
    id: advance.id,
    staffId: advance.staff_id,
    amount: round2(advance.amount),
    months: advance.months,
    monthly: round2(advance.monthly),
    currency: advance.currency,
    reason: advance.reason,
    purpose: advance.purpose ?? null,
    purposeLabel: purposeOf(advance.purpose)?.label ?? null,
    hasPaper: Boolean(advance.document_id),
    status: advance.status,
    takenOn: advance.taken_on,
    startMonth: advance.start_month,
    askedBy: advance.asked_by,
    askedAt: advance.asked_at,
    decidedBy: advance.decided_by,
    decidedAt: advance.decided_at,
    decision: advance.decision,
    repaid: repaidOf(entries),
    balance,
    left: isOpen(advance) ? monthsLeft(balance, advance.monthly) : 0,
    finishes: isOpen(advance) ? finishesOn(advance, entries, { asOfMonth }) : null,
    entries: entries.map((e) => ({
      id: e.id, month: e.month, kind: e.kind, amount: round2(e.amount), note: e.note,
      actor: e.actor, at: e.at,
    })),
    // Months that have been and gone with nothing recorded against them. Not
    // a skip and not a payment: nobody answered.
    unanswered: unansweredMonths(advance, entries, { asOfMonth }),
    ...(withSchedule ? { schedule: scheduleFor(advance, entries, { asOfMonth }) } : {}),
  };
}

// --------------------------------------------------------------------------
// Whoever does the wages
// --------------------------------------------------------------------------

/**
 * Everybody, and the month waiting to be closed.
 *
 * The month asked for defaults to the one just gone rather than the one
 * running: on the last day of August, what somebody is being asked about is
 * August, and defaulting to September would be asking about a month that has
 * not happened.
 */
export async function advances(ctx) {
  const { timezone, currency } = await settingsOf(ctx.db);
  const today = todayIn(timezone);
  const asked = ctx.url.searchParams.get('month');
  const month = isMonth(asked) ? asked : monthOf(today);
  // The month being closed off can be walked back to April; what is left to
  // pay still comes off from now on, so the projection follows the clock
  // rather than the picker.
  const thisMonth = monthOf(today);

  const { advances: rows, entriesBy } = await ledger(ctx.db);
  const staff = await ctx.db.prepare('SELECT id, name, department, employee_no, active FROM att_staff')
    .all();
  const staffById = new Map((staff.results ?? []).map((s) => [s.id, s]));

  const closed = await ctx.db.prepare('SELECT * FROM hr_advance_month WHERE month = ?')
    .bind(month).first().catch(() => null);

  const people = new Map();
  for (const advance of rows) {
    const person = staffById.get(advance.staff_id);
    if (!person) continue;
    if (!people.has(advance.staff_id)) {
      people.set(advance.staff_id, {
        staff: {
          id: person.id, name: person.name, department: person.department ?? null,
          employeeNo: person.employee_no ?? null, active: Boolean(person.active),
        },
        advances: [],
      });
    }
    people.get(advance.staff_id).advances.push(
      shape(advance, entriesBy.get(advance.id) ?? [], { asOfMonth: thisMonth }),
    );
  }

  const list = [...people.values()].map((person) => {
    const raw = rows.filter((r) => r.staff_id === person.staff.id);
    return { ...person, totals: summarise(raw, entriesBy, { asOfMonth: thisMonth }) };
  }).sort((a, b) => b.totals.owed - a.totals.owed
    || a.staff.name.localeCompare(b.staff.name));

  // What is owed for the month being closed: every open advance with a balance
  // and nothing yet recorded against that month.
  const due = [];
  for (const advance of rows) {
    if (!isOpen(advance)) continue;
    const entries = entriesBy.get(advance.id) ?? [];
    const balance = balanceOf(advance, entries);
    if (balance <= 0) continue;
    if ((advance.start_month || '9999-99') > month) continue;
    const already = entries.find((e) => e.month === month && ['repayment', 'skipped'].includes(e.kind));
    due.push({
      advanceId: advance.id,
      staff: staffById.get(advance.staff_id)?.name ?? 'Somebody',
      staffId: advance.staff_id,
      // The same rule the payroll uses, from the same place.
      expected: dueThisMonth(advance, entries, month) || Math.min(round2(advance.monthly), balance),
      balance,
      recorded: already
        ? { id: already.id, kind: already.kind, amount: round2(already.amount) }
        : null,
    });
  }

  due.sort((a, b) => String(a.staff).localeCompare(String(b.staff)));

  return json({
    month,
    today,
    currency,
    // The end of the month is when the asking happens, and a month left
    // unanswered keeps being asked about afterwards.
    monthEnd: isMonthEnd(today),
    // Whether this pair of eyes may correct a record rather than only agree a
    // change to one. The screen asks so it can leave the button off.
    canEdit: isAdmin(ctx.session),
    closed: closed ? { by: closed.closed_by, at: closed.closed_at, note: closed.note } : null,
    due,
    people: list,
    requests: rows.filter((r) => r.status === 'requested').map((r) => ({
      ...shape(r, entriesBy.get(r.id) ?? [], { asOfMonth: thisMonth }),
      staffName: staffById.get(r.staff_id)?.name ?? 'Somebody',
    })),
    totals: {
      owed: round2(list.reduce((n, p) => n + p.totals.owed, 0)),
      monthly: round2(list.reduce((n, p) => n + p.totals.monthly, 0)),
      people: list.filter((p) => p.totals.owed > 0).length,
    },
    staff: (staff.results ?? []).filter((s) => s.active)
      .map((s) => ({ id: s.id, name: s.name, department: s.department ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}

/** One person's advances, with the schedule drawn out. */
export async function staffAdvances(ctx, idParam) {
  const staffId = int(idParam, 'Who', { required: true, min: 1 });
  const { timezone, currency } = await settingsOf(ctx.db);
  const thisMonth = monthOf(todayIn(timezone));
  const person = await ctx.db.prepare('SELECT id, name FROM att_staff WHERE id = ?')
    .bind(staffId).first();
  if (!person) throw notFound('No such member of staff.');

  const { advances: rows, entriesBy } = await ledger(ctx.db, { staffId });
  return json({
    currency,
    canEdit: isAdmin(ctx.session),
    staff: { id: person.id, name: person.name },
    // The same statement the person sees on their own screen, so whoever is
    // being asked about it is reading the page they are being asked about.
    account: accountFor(rows, entriesBy, { asOfMonth: thisMonth }),
    totals: summarise(rows, entriesBy, { asOfMonth: thisMonth }),
    advances: rows.map((r) => shape(r, entriesBy.get(r.id) ?? [], {
      withSchedule: true, asOfMonth: thisMonth,
    })),
  });
}

/**
 * Give somebody an advance, or write down one already handed over.
 *
 * Approved the moment it is recorded, because it is being recorded by the
 * person who would have approved it. The one obligation is telling them: money
 * coming off a payslip that nobody mentioned is how this arrangement loses
 * people's trust.
 */
export async function addAdvance(ctx) {
  const body = await readJson(ctx.request);
  const { timezone, currency } = await settingsOf(ctx.db);

  const staffId = int(body.staffId, 'Who', { required: true, min: 1 });
  const person = await ctx.db.prepare(
    `SELECT s.id, s.name, u.id AS user_id
       FROM att_staff s LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
      WHERE s.id = ? AND s.active = 1`,
  ).bind(staffId).first();
  if (!person) throw notFound('No such member of staff.');

  const { amount, months, monthly, takenOn, startMonth, reason, purpose } = terms(body, timezone);

  const row = await ctx.db.prepare(
    `INSERT INTO hr_advance
       (staff_id, amount, months, monthly, currency, reason, status, taken_on, start_month,
        asked_by, decided_by, decided_at, decision, purpose)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'approved', ?7, ?8, ?9, ?9, datetime('now'), ?10, ?11)
     RETURNING id`,
  ).bind(
    staffId, amount, months, monthly, currency, reason, takenOn, startMonth,
    actorOf(ctx), 'Recorded by the office', purpose,
  ).first();

  await audit(ctx, 'advance.add', row?.id, { staffId, amount, months, monthly, startMonth });

  await tell(ctx, person, {
    kind: 'advance.given',
    title: `A salary advance of ${money(amount, currency)} has been recorded for you`,
    body: `${money(monthly, currency)} a month for ${months} month${months === 1 ? '' : 's'}, `
      + `starting ${startMonth}. If this is not what you agreed, say so before payday.`,
  });

  return json({ ok: true, id: row?.id ?? null, monthly, startMonth });
}

/** The terms, from whatever the form sent. */
function terms(body, timezone) {
  const amount = round2(num(body.amount, 'Amount', { required: true, min: 1, max: 1_000_000 }));
  const months = body.months == null || body.months === ''
    ? (purposeOf(body.purpose)?.months ?? 1)
    : int(body.months, 'Months to repay over', { min: 1, max: 60 });

  const takenOn = body.takenOn && isDay(String(body.takenOn))
    ? String(body.takenOn)
    : todayIn(timezone);

  const startMonth = isMonth(body.startMonth)
    ? String(body.startMonth)
    : firstMonthFor(takenOn) ?? monthOf(takenOn);

  // Whatever was typed, where somebody has set the instalment by hand, and the
  // arithmetic otherwise. Both are the agreement; only one of them was worked
  // out by a machine.
  const monthly = body.monthly != null && body.monthly !== ''
    ? round2(num(body.monthly, 'Monthly deduction', { min: 1, max: 1_000_000 }))
    : instalmentFor(amount, months);

  return {
    amount,
    months,
    monthly,
    takenOn,
    startMonth,
    // The office is not held to the caps or the paper. Those are rules about
    // what somebody may ask for; this is a record of what was handed over,
    // and refusing to write down what has already happened helps nobody.
    purpose: purposeOf(body.purpose)?.key ?? null,
    reason: str(body.reason, 'What it is for', { max: 300 }),
  };
}

/** Approve or turn down what somebody asked for. */
export async function decideAdvance(ctx, idParam) {
  const id = int(idParam, 'Advance', { required: true, min: 1 });
  const body = await readJson(ctx.request);
  const { timezone, currency } = await settingsOf(ctx.db);

  const advance = await ctx.db.prepare('SELECT * FROM hr_advance WHERE id = ?').bind(id).first();
  if (!advance) throw notFound('No such advance.');
  if (advance.status !== 'requested') {
    throw badRequest('That has already been decided.');
  }

  const person = await ctx.db.prepare(
    `SELECT s.id, s.name, u.id AS user_id
       FROM att_staff s LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
      WHERE s.id = ?`,
  ).bind(advance.staff_id).first();

  const note = str(body.note, 'Note', { max: 300 });

  if (body.approve === false) {
    await ctx.db.prepare(
      `UPDATE hr_advance SET status = 'declined', decided_by = ?2, decided_at = datetime('now'),
              decision = ?3 WHERE id = ?1`,
    ).bind(id, actorOf(ctx), note).run();
    await audit(ctx, 'advance.decline', id, { note });

    await tell(ctx, person, {
      kind: 'advance.declined',
      title: 'Your request for a salary advance was turned down',
      body: note || 'Speak to whoever handles the wages if you want to know more.',
    });
    return json({ ok: true, status: 'declined' });
  }

  // Approving is also where the terms are settled: what somebody asked for and
  // what the property can do are often two different numbers, and the answer
  // should be the agreement rather than a refusal followed by a second form.
  const amount = body.amount != null && body.amount !== ''
    ? round2(num(body.amount, 'Amount', { min: 1, max: 1_000_000 }))
    : round2(advance.amount);
  const months = body.months != null && body.months !== ''
    ? int(body.months, 'Months', { min: 1, max: 60 })
    : advance.months;
  const monthly = body.monthly != null && body.monthly !== ''
    ? round2(num(body.monthly, 'Monthly deduction', { min: 1, max: 1_000_000 }))
    : instalmentFor(amount, months);

  const takenOn = isDay(body.takenOn) ? String(body.takenOn) : todayIn(timezone);
  const startMonth = isMonth(body.startMonth)
    ? String(body.startMonth)
    : firstMonthFor(takenOn) ?? monthOf(takenOn);

  await ctx.db.prepare(
    `UPDATE hr_advance
        SET status = 'approved', amount = ?2, months = ?3, monthly = ?4, taken_on = ?5,
            start_month = ?6, decided_by = ?7, decided_at = datetime('now'), decision = ?8
      WHERE id = ?1`,
  ).bind(id, amount, months, monthly, takenOn, startMonth, actorOf(ctx), note).run();

  await audit(ctx, 'advance.approve', id, { amount, months, monthly, startMonth });

  const changed = amount !== round2(advance.amount) || months !== advance.months;
  await tell(ctx, person, {
    kind: 'advance.approved',
    title: `Your salary advance of ${money(amount, currency)} is approved`,
    body: `${money(monthly, currency)} a month for ${months} month${months === 1 ? '' : 's'}, `
      + `from ${startMonth}.${changed ? ' The terms are not quite what you asked for.' : ''}`
      + (note ? ` ${note}` : ''),
  });

  return json({ ok: true, status: 'approved', monthly });
}

/**
 * Change the terms of one that is running.
 *
 * The instalment, the length, or the month it starts. Not the amount: what was
 * handed over is a fact, and correcting it is deleting the advance and
 * recording the right one.
 */
export async function adjustAdvance(ctx, idParam) {
  const id = int(idParam, 'Advance', { required: true, min: 1 });
  const body = await readJson(ctx.request);

  const advance = await ctx.db.prepare('SELECT * FROM hr_advance WHERE id = ?').bind(id).first();
  if (!advance) throw notFound('No such advance.');
  if (!isOpen(advance)) throw badRequest('That advance is not running.');

  const monthly = body.monthly != null && body.monthly !== ''
    ? round2(num(body.monthly, 'Monthly deduction', { min: 1, max: 1_000_000 }))
    : round2(advance.monthly);
  const months = body.months != null && body.months !== ''
    ? int(body.months, 'Months', { min: 1, max: 60 })
    : advance.months;
  const startMonth = isMonth(body.startMonth) ? String(body.startMonth) : advance.start_month;
  const note = str(body.note, 'Why', { max: 300 });

  await ctx.db.prepare(
    'UPDATE hr_advance SET monthly = ?2, months = ?3, start_month = ?4 WHERE id = ?1',
  ).bind(id, monthly, months, startMonth).run();

  await audit(ctx, 'advance.adjust', id, {
    was: { monthly: round2(advance.monthly), months: advance.months },
    now: { monthly, months }, note,
  });

  if (monthly !== round2(advance.monthly)) {
    const person = await ctx.db.prepare(
      `SELECT s.id, s.name, u.id AS user_id
         FROM att_staff s LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
        WHERE s.id = ?`,
    ).bind(advance.staff_id).first();
    await tell(ctx, person, {
      kind: 'advance.changed',
      title: 'What comes off your pay for your advance has changed',
      body: `${money(monthly, advance.currency)} a month from now on.${note ? ` ${note}` : ''}`,
    });
  }

  return json({ ok: true, monthly, months });
}

/**
 * Correct the record itself, not the arrangement.
 *
 * "Change the terms" is an agreement being changed: it is still true that
 * 4,000 was handed over on the 3rd, and what moves is what comes off each
 * month from here. This is the other thing entirely — the record is wrong.
 * Somebody typed 400 for 4,000, or dated it in the wrong month, or put it
 * against the wrong purpose, and until now the only way out was to delete the
 * whole thing and key it again, which loses every movement recorded against
 * it and every note explaining them.
 *
 * Administrator only, and it says so in the log. Editing the amount of an
 * advance moves what somebody owes without anybody agreeing to it, which is
 * exactly the power the rest of this screen is careful not to hand out.
 *
 * Two things it still will not do. The amount cannot go below what has
 * already come back, because that is a balance owed to the member of staff
 * and this screen has nowhere to put one. And it cannot be moved to somebody
 * else once a payment has been recorded, because those payments came off a
 * real payslip belonging to the person it is on now.
 */
export async function editAdvance(ctx, idParam) {
  if (!isAdmin(ctx.session)) {
    throw forbidden('Only an administrator can correct an advance record.');
  }

  const id = int(idParam, 'Advance', { required: true, min: 1 });
  const body = await readJson(ctx.request);
  const { timezone } = await settingsOf(ctx.db);

  const advance = await ctx.db.prepare('SELECT * FROM hr_advance WHERE id = ?').bind(id).first();
  if (!advance) throw notFound('No such advance.');

  const entries = await entriesFor(ctx.db, id);
  const repaid = repaidOf(entries);

  const keep = (value, fallback) => (value == null || value === '' ? fallback : value);

  const amount = round2(num(keep(body.amount, advance.amount), 'Amount',
    { required: true, min: 1, max: 1_000_000 }));
  if (amount < repaid) {
    throw badRequest(`${money(repaid, advance.currency)} has already come back against this `
      + 'advance, so it cannot be worth less than that. Take the movements off first.');
  }

  const months = int(keep(body.months, advance.months), 'Months to repay over',
    { min: 1, max: 60 });
  const monthly = round2(num(keep(body.monthly, advance.monthly), 'Monthly deduction',
    { min: 1, max: 1_000_000 }));

  const takenOn = isDay(String(body.takenOn ?? '')) ? String(body.takenOn) : advance.taken_on;
  const startMonth = isMonth(body.startMonth) ? String(body.startMonth) : advance.start_month;

  // A purpose can be cleared as well as changed, so an empty string means
  // "none of them" rather than "leave it".
  const purpose = body.purpose === undefined
    ? advance.purpose ?? null
    : purposeOf(body.purpose)?.key ?? null;
  const reason = body.reason === undefined
    ? advance.reason
    : str(body.reason, 'What it is for', { max: 300 });

  // Whose it is. Only while nothing has come off, and only to somebody who
  // is still here.
  let staffId = advance.staff_id;
  const asked = body.staffId == null || body.staffId === ''
    ? advance.staff_id
    : int(body.staffId, 'Who', { required: true, min: 1 });
  if (asked !== advance.staff_id) {
    if (entries.length) {
      throw badRequest('There are movements recorded against this advance, so it cannot be '
        + 'moved to somebody else. Take them off first, or write this one off and record a '
        + 'new one.');
    }
    const moving = await ctx.db.prepare('SELECT id FROM att_staff WHERE id = ? AND active = 1')
      .bind(asked).first();
    if (!moving) throw notFound('No such member of staff.');
    staffId = asked;
  }

  const note = str(body.note, 'Why', { max: 300 });

  await ctx.db.prepare(
    `UPDATE hr_advance
        SET staff_id = ?2, amount = ?3, months = ?4, monthly = ?5, taken_on = ?6,
            start_month = ?7, purpose = ?8, reason = ?9
      WHERE id = ?1`,
  ).bind(id, staffId, amount, months, monthly, takenOn, startMonth, purpose, reason).run();

  // A corrected amount can finish something that was still running, or bring
  // back something that was marked paid off. Neither should need a second act.
  let status = advance.status;
  if (['approved', 'settled'].includes(advance.status)) {
    const settled = round2(amount - repaid) <= 0;
    status = settled ? 'settled' : 'approved';
    if (status !== advance.status) {
      await ctx.db.prepare(
        `UPDATE hr_advance
            SET status = ?2, settled_at = CASE WHEN ?2 = 'settled' THEN datetime('now') END
          WHERE id = ?1`,
      ).bind(id, status).run();
    }
  }

  const was = {
    staffId: advance.staff_id,
    amount: round2(advance.amount),
    months: advance.months,
    monthly: round2(advance.monthly),
    takenOn: advance.taken_on,
    startMonth: advance.start_month,
    purpose: advance.purpose ?? null,
    reason: advance.reason,
  };
  const now = { staffId, amount, months, monthly, takenOn, startMonth, purpose, reason };
  const changed = Object.keys(now).filter((k) => now[k] !== was[k]);

  await audit(ctx, 'advance.edit', id, { was, now, changed, note });

  // Only when what they owe or what comes off their pay has moved. A
  // corrected spelling in the reason is not worth a notification.
  if (changed.includes('amount') || changed.includes('monthly')) {
    const person = await ctx.db.prepare(
      `SELECT s.id, s.name, u.id AS user_id
         FROM att_staff s LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
        WHERE s.id = ?`,
    ).bind(staffId).first();
    await tell(ctx, person, {
      kind: 'advance.changed',
      title: 'Your salary advance record has been corrected',
      body: `${money(amount, advance.currency)} in all, `
        + `${money(monthly, advance.currency)} a month.${note ? ` ${note}` : ''}`,
    });
  }

  return json({ ok: true, id, status, changed });
}

/** Record one movement — a deduction taken, a month let go, a correction. */
export async function addEntry(ctx, idParam) {
  const id = int(idParam, 'Advance', { required: true, min: 1 });
  const body = await readJson(ctx.request);

  const advance = await ctx.db.prepare('SELECT * FROM hr_advance WHERE id = ?').bind(id).first();
  if (!advance) throw notFound('No such advance.');

  const month = isMonth(body.month) ? String(body.month) : null;
  if (!month) throw badRequest('Say which month this belongs to.');

  const kind = ['repayment', 'skipped', 'adjustment', 'writeoff'].includes(body.kind)
    ? body.kind : 'repayment';
  const amount = kind === 'skipped'
    ? 0
    : round2(num(body.amount, 'Amount', { required: true, min: -1_000_000, max: 1_000_000 }));
  const note = str(body.note, 'Note', { max: 300 });

  // The same figure, month after month. Somebody catching up a quarter of
  // deductions was doing this four times over, and the fourth one is the one
  // that gets a month wrong or never happens at all.
  const over = body.months == null || body.months === ''
    ? 1
    : int(body.months, 'How many months', { min: 1, max: 60 });

  const written = [];
  const already = [];
  let cleared = null;

  for (let i = 0; i < over; i += 1) {
    const on = addMonths(month, i);

    // A month already answered is not answered again. Two deductions for one
    // month is the mistake this is most likely to make, and it is the one
    // that takes money off somebody twice.
    if (['repayment', 'skipped'].includes(kind)) {
      const said = await ctx.db.prepare(
        `SELECT id FROM hr_advance_entry
          WHERE advance_id = ? AND month = ? AND kind IN ('repayment','skipped')`,
      ).bind(id, on).first();
      if (said) { already.push(on); continue; }
    }

    // And never past the end of it. Three months of seven hundred against
    // fifteen hundred owed is two payments and a short one, exactly as it
    // would be on the payslips.
    let take = amount;
    if (amount > 0) {
      const entries = await entriesFor(ctx.db, id);
      const left = balanceOf(advance, entries);
      if (left <= 0.009) { cleared = on; break; }
      take = round2(Math.min(amount, left));
    }

    await write(ctx, advance, { month: on, kind, amount: take, note });
    written.push({ month: on, amount: take });
  }

  return json({ ok: true, written, already, cleared });
}

/**
 * Catch up the months nobody answered.
 *
 * The month-end question is asked on the last day of the month and again on
 * the 7th and the 14th, and a property that is busy still misses it. Three
 * months later what is on the screen is a balance that is right and a finish
 * date that is wrong, because nothing was ever written for June and July and
 * the projection went on assuming they were paid.
 *
 * This is the way back. The screen works out which months have gone by with
 * nothing recorded, and whoever runs the wages says which of them were let go.
 * A month ticked here is a month deliberately skipped, exactly as if it had
 * been unticked at the time — what is owed does not move, and the finish date
 * goes out by one.
 *
 * A month somebody actually paid in is not this. That is a movement with a
 * figure on it, and it goes in as one.
 */
export async function markSkipped(ctx, idParam) {
  const id = int(idParam, 'Advance', { required: true, min: 1 });
  const body = await readJson(ctx.request);

  const advance = await ctx.db.prepare('SELECT * FROM hr_advance WHERE id = ?').bind(id).first();
  if (!advance) throw notFound('No such advance.');
  if (!isOpen(advance)) throw badRequest('That advance is not running.');

  const { timezone } = await settingsOf(ctx.db);
  const thisMonth = monthOf(todayIn(timezone));

  const asked = (Array.isArray(body.months) ? body.months : [])
    .map((m) => String(m))
    .filter((m) => isMonth(m));
  if (!asked.length) throw badRequest('Say which months were skipped.');

  // Only months this advance is actually behind on. A month in the future, or
  // one already answered, is not somebody catching up — it is a typo, and
  // writing it would put a skip somewhere nobody could explain.
  const entries = await entriesFor(ctx.db, id);
  const behind = new Set(unansweredMonths(advance, entries, { asOfMonth: thisMonth }));
  const months = [...new Set(asked)].filter((m) => behind.has(m)).sort();
  const refused = [...new Set(asked)].filter((m) => !behind.has(m)).sort();

  const note = str(body.note, 'Note', { max: 300 });
  for (const month of months) {
    await write(ctx, advance, { month, kind: 'skipped', amount: 0, note });
  }

  await audit(ctx, 'advance.catch_up', id, { months, refused, note });

  return json({ ok: true, marked: months, refused });
}

/**
 * Type the months that have already gone the way the ledger has them.
 *
 * A property that has been lending money for years does not start with an
 * empty book, and nothing in this app could put the old book into it. The
 * figures for last April are whatever the notebook says: seven hundred came
 * off where the agreement says five, a top-up was handed over in June that
 * nobody wrote down, a month went by with nothing.
 *
 * So the months that have ended can be typed. What is written is ordinary
 * records — a correction against the advance that was running, an advance for
 * a top-up that was never recorded — and everything downstream follows from
 * them on its own. The closing balances and when the last instalment falls are
 * worked out, never stored, so there is nothing else to put right.
 *
 * ADMINISTRATOR ONLY, and every line of it is logged. Retyping what came off
 * somebody's pay last April moves what they owe without them agreeing to it,
 * which is not a thing to leave lying around on a screen.
 *
 * NOTHING IS CREATED QUIETLY. An addition somebody types is an advance, and
 * the answer says which ones it made so the screen can name them.
 */
export async function bringHistoryAcross(ctx, idParam) {
  if (!isAdmin(ctx.session)) {
    throw forbidden('Only an administrator can retype months that have already gone.');
  }

  const staffId = int(idParam, 'Who', { required: true, min: 1 });
  const body = await readJson(ctx.request);
  const { timezone, currency } = await settingsOf(ctx.db);
  const thisMonth = monthOf(todayIn(timezone));

  const person = await ctx.db.prepare(
    `SELECT s.id, s.name, u.id AS user_id
       FROM att_staff s LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
      WHERE s.id = ?`,
  ).bind(staffId).first();
  if (!person) throw notFound('No such member of staff.');

  const { advances: rows, entriesBy } = await ledger(ctx.db, { staffId });
  const wanted = Array.isArray(body.rows) ? body.rows : [];
  if (!wanted.length) throw badRequest('Nothing was typed.');

  const { changes, refused } = reconcilePlan(rows, entriesBy, wanted, { asOfMonth: thisMonth });
  const note = str(body.note, 'Why', { max: 300 })
    || 'Brought into line with what actually happened';

  // What a top-up handed over back then comes off at. The instalment somebody
  // is already used to, unless the form says otherwise, because an advance
  // from last June is not a new arrangement — it is part of the one running.
  const running = rows.find((r) => isOpen(r));
  const monthly = body.monthly != null && body.monthly !== ''
    ? round2(num(body.monthly, 'A month', { min: 1, max: 1_000_000 }))
    : round2(running?.monthly ?? 0);

  const made = [];
  // An advance this run is about to create, by the month it was handed over.
  // A repayment can be spread onto one, and until it exists it is named by
  // its month rather than by a number nothing has yet.
  const madeFor = new Map();
  let corrected = 0;

  for (const change of changes) {
    if (change.kind === 'advance') {
      const taken = `${change.month}-01`;
      const each = monthly > 0 ? Math.min(monthly, change.amount) : change.amount;
      const over = Math.max(1, Math.ceil(change.amount / each));
      const written = await ctx.db.prepare(
        `INSERT INTO hr_advance
           (staff_id, amount, months, monthly, currency, reason, status, taken_on, start_month,
            asked_by, decided_by, decided_at, decision)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'approved', ?7, ?8, ?9, ?9, datetime('now'), ?10)
         RETURNING id`,
      ).bind(
        staffId, change.amount, over, each, currency, note, taken, change.month,
        actorOf(ctx), 'Brought across from the ledger',
      ).first();
      made.push({ id: written?.id ?? null, month: change.month, amount: change.amount });
      if (written?.id) {
        // Read back rather than assembled by hand, because a repayment spread
        // onto it goes through the same write() every other movement does and
        // that wants the whole row.
        const row = await ctx.db.prepare('SELECT * FROM hr_advance WHERE id = ?')
          .bind(written.id).first();
        if (row) madeFor.set(change.month, row);
      }
      continue;
    }

    const wanted_ = typeof change.advanceId === 'string' && change.advanceId.startsWith('new:')
      ? madeFor.get(change.advanceId.slice(4))
      : rows.find((r) => r.id === change.advanceId);
    const advance = wanted_;
    if (!advance) continue;
    await write(ctx, advance, {
      month: change.month,
      kind: change.kind === 'letGo' ? 'skipped' : 'adjustment',
      amount: change.amount,
      note,
    });
    corrected += 1;
  }

  await audit(ctx, 'advance.history', staffId, { changes, refused, made, note });

  // Only where what they owe actually moved. Somebody writing down that
  // nothing came off in June is tidying a record, not changing their money.
  if (made.length || corrected) {
    await tell(ctx, person, {
      kind: 'advance.changed',
      title: 'Your advance record has been brought into line with the office ledger',
      body: 'The months before this one have been retyped from what was actually handed over '
        + `and what actually came off. ${note} Check your account and say so if a month is `
        + 'wrong.',
    });
  }

  return json({ ok: true, changes, refused, made, corrected });
}

/**
 * Put a figure right that is already on the record.
 *
 * Five hundred was typed where seven hundred came off, or a sheet of "already
 * repaid" came in with a column out by a decimal place. Until now the only way
 * back was the ✕ and then adding it again, which loses the note explaining it
 * and, on a month that has since been closed off, is two acts where somebody
 * only meant one.
 *
 * The balance follows the figure, both ways. Putting a payment up can pay an
 * advance off; putting one down can bring back one that was marked finished.
 * Neither should need a second thing doing to it.
 */
export async function editEntry(ctx, idParam, entryParam) {
  const id = int(idParam, 'Advance', { required: true, min: 1 });
  const entryId = int(entryParam, 'Movement', { required: true, min: 1 });
  const body = await readJson(ctx.request);

  const advance = await ctx.db.prepare('SELECT * FROM hr_advance WHERE id = ?').bind(id).first();
  if (!advance) throw notFound('No such advance.');

  const entry = await ctx.db.prepare(
    'SELECT * FROM hr_advance_entry WHERE id = ? AND advance_id = ?',
  ).bind(entryId, id).first();
  if (!entry) throw notFound('No such movement.');

  const kind = ['repayment', 'skipped', 'adjustment', 'writeoff'].includes(body.kind)
    ? body.kind : entry.kind;
  const month = isMonth(body.month) ? String(body.month) : entry.month;

  // A month can only be answered once, so moving one onto a month that is
  // already answered would make two of them.
  if (month !== entry.month && ['repayment', 'skipped'].includes(kind)) {
    const clash = await ctx.db.prepare(
      `SELECT id FROM hr_advance_entry
        WHERE advance_id = ? AND month = ? AND id <> ? AND kind IN ('repayment','skipped')`,
    ).bind(id, month, entryId).first();
    if (clash) {
      throw badRequest(`${month} already has an answer against it. Take that one off first, or `
        + 'put this one right where it is.');
    }
  }

  const amount = kind === 'skipped'
    ? 0
    : round2(
      body.amount == null || body.amount === ''
        ? entry.amount
        : num(body.amount, 'Amount', { required: true, min: -1_000_000, max: 1_000_000 }),
    );
  const note = body.note === undefined
    ? entry.note
    : str(body.note, 'Note', { max: 300 });

  await ctx.db.prepare(
    'UPDATE hr_advance_entry SET month = ?2, kind = ?3, amount = ?4, note = ?5 WHERE id = ?1',
  ).bind(entryId, month, kind, amount, note).run();

  await audit(ctx, 'advance.entry_edit', id, {
    entryId,
    was: { month: entry.month, kind: entry.kind, amount: round2(entry.amount), note: entry.note },
    now: { month, kind, amount, note },
  });

  // What is owed has moved, so whether this is finished may have moved with it.
  const entries = await entriesFor(ctx.db, id);
  const left = balanceOf(advance, entries);
  const settled = left <= 0.009;
  if (settled && advance.status === 'approved') {
    await ctx.db.prepare(
      "UPDATE hr_advance SET status = 'settled', settled_at = datetime('now') WHERE id = ?",
    ).bind(id).run();
  } else if (!settled && advance.status === 'settled') {
    await ctx.db.prepare(
      "UPDATE hr_advance SET status = 'approved', settled_at = NULL WHERE id = ?",
    ).bind(id).run();
  }

  // Only where the figure moved. A corrected note is not news, and this
  // screen already tells people more than most.
  if (amount !== round2(entry.amount)) {
    const person = await ctx.db.prepare(
      `SELECT s.id, s.name, u.id AS user_id
         FROM att_staff s LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
        WHERE s.id = ?`,
    ).bind(advance.staff_id).first();
    await tell(ctx, person, {
      kind: 'advance.changed',
      title: 'A payment against your salary advance has been put right',
      body: `${month}: ${money(amount, advance.currency)} rather than `
        + `${money(round2(entry.amount), advance.currency)}. `
        + `${money(Math.max(0, left), advance.currency)} is left.`,
    });
  }

  return json({ ok: true, amount, month, kind, balance: round2(Math.max(0, left)), settled });
}

/** Take a movement back off the record. */
export async function removeEntry(ctx, idParam, entryParam) {
  const id = int(idParam, 'Advance', { required: true, min: 1 });
  const entryId = int(entryParam, 'Movement', { required: true, min: 1 });

  const entry = await ctx.db.prepare('SELECT * FROM hr_advance_entry WHERE id = ? AND advance_id = ?')
    .bind(entryId, id).first();
  if (!entry) throw notFound('No such movement.');

  await ctx.db.prepare('DELETE FROM hr_advance_entry WHERE id = ?').bind(entryId).run();
  await audit(ctx, 'advance.entry_remove', id, {
    month: entry.month, kind: entry.kind, amount: round2(entry.amount),
  });

  // Taking a payment back off may reopen something that was marked finished.
  await ctx.db.prepare(
    `UPDATE hr_advance SET status = 'approved', settled_at = NULL
      WHERE id = ? AND status = 'settled'`,
  ).bind(id).run().catch(() => {});

  return json({ ok: true });
}

/**
 * Close off a month: what came off, person by person, in one answer.
 *
 * This is the end-of-month question, and it is deliberately one submission
 * rather than a row at a time. Somebody working down a payroll wants to tick,
 * tick, tick and press once; asked to save each line they will do three and
 * come back to the rest never.
 */
export async function closeMonth(ctx) {
  const body = await readJson(ctx.request);
  const month = isMonth(body.month) ? String(body.month) : null;
  if (!month) throw badRequest('Say which month is being closed.');

  const rows = Array.isArray(body.rows) ? body.rows : [];
  let taken = 0;
  let skipped = 0;

  for (const line of rows) {
    const id = int(line.advanceId, 'Advance', { required: true, min: 1 });
    const advance = await ctx.db.prepare('SELECT * FROM hr_advance WHERE id = ?').bind(id).first();
    if (!advance || !isOpen(advance)) continue;

    const already = await ctx.db.prepare(
      `SELECT id FROM hr_advance_entry
        WHERE advance_id = ? AND month = ? AND kind IN ('repayment','skipped')`,
    ).bind(id, month).first();
    if (already) continue;                       // answered already; never twice

    if (line.paid === false) {
      await write(ctx, advance, {
        month, kind: 'skipped', amount: 0, note: str(line.note, 'Note', { max: 300 }),
      });
      skipped += 1;
      continue;
    }

    const entries = await entriesFor(ctx.db, id);
    const balance = balanceOf(advance, entries);
    const asked = line.amount != null && line.amount !== ''
      ? round2(num(line.amount, 'Amount', { min: 0, max: 1_000_000 }))
      : Math.min(round2(advance.monthly), balance);
    if (asked <= 0) continue;

    await write(ctx, advance, {
      month, kind: 'repayment', amount: Math.min(asked, balance),
      note: str(line.note, 'Note', { max: 300 }),
    });
    taken += 1;
  }

  await ctx.db.prepare(
    `INSERT INTO hr_advance_month (month, closed_by, note) VALUES (?1, ?2, ?3)
     ON CONFLICT (month) DO UPDATE SET closed_by = ?2, closed_at = datetime('now'), note = ?3`,
  ).bind(month, actorOf(ctx), str(body.note, 'Note', { max: 300 })).run();

  await audit(ctx, 'advance.close_month', month, { taken, skipped });
  return json({ ok: true, month, taken, skipped });
}

// --------------------------------------------------------------------------
// The person paying it back
// --------------------------------------------------------------------------

/** Mine, with the schedule and when it ends. */
export async function myAdvances(ctx) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  if (!staffId) {
    return json({
      linked: false, currency: 'GHS', advances: [], totals: { owed: 0, monthly: 0, finishes: null },
    });
  }

  const { timezone, currency } = await settingsOf(ctx.db);
  const thisMonth = monthOf(todayIn(timezone));
  const { advances: rows, entriesBy } = await ledger(ctx.db, { staffId });

  const hasOpen = rows.some((r) => isOpen(r) && balanceOf(r, entriesBy.get(r.id) ?? []) > 0);

  return json({
    linked: true,
    currency,
    account: accountFor(rows, entriesBy, { asOfMonth: thisMonth }),
    totals: summarise(rows, entriesBy, { asOfMonth: thisMonth }),
    advances: rows.map((r) => shape(r, entriesBy.get(r.id) ?? [], {
      withSchedule: true, asOfMonth: thisMonth,
    })),
    // The rules, sent rather than repeated in the screen, so the form and the
    // route cannot come to disagree about what may be asked for.
    hasOpen,
    purposes: PURPOSES.map((p) => ({
      key: p.key, label: p.label, cap: p.cap, months: p.months, paper: p.paper,
    })),
    canAsk: purposesFor({ hasOpen, amount: 0 }).map((p) => p.key),
  });
}

/**
 * Ask for one.
 *
 * The amount and how long they think they need. Nothing is agreed until
 * somebody says so, and the screen says as much: an app that reads like a
 * decision when it is only a request is how somebody ends up counting on money
 * that is not coming.
 */
export async function askForAdvance(ctx) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  if (!staffId) throw badRequest('This login is not linked to a staff record yet.');

  const body = await readJson(ctx.request);
  const { currency } = await settingsOf(ctx.db);

  const staff = await ctx.db.prepare('SELECT id, name FROM att_staff WHERE id = ? AND active = 1')
    .bind(staffId).first();
  if (!staff) throw notFound('The staff record this login points at is gone.');

  const amount = round2(num(body.amount, 'How much', { required: true, min: 1, max: 1_000_000 }));
  const reason = str(body.reason, 'What it is for', { max: 300 });

  const waiting = await ctx.db.prepare(
    "SELECT id FROM hr_advance WHERE staff_id = ? AND status = 'requested'",
  ).bind(staffId).first();
  if (waiting) throw badRequest('You have already asked for one and nobody has decided yet.');

  // Somebody still paying one back may only ask for the small emergency. Read
  // here rather than trusted from the screen, which is a thing that can be
  // out of date by the time the form is sent.
  const open = await ctx.db.prepare(
    "SELECT id FROM hr_advance WHERE staff_id = ? AND status = 'approved'",
  ).bind(staffId).all().catch(() => ({ results: [] }));
  const hasOpen = (open.results ?? []).length > 0;

  const check = checkRequest({
    purpose: body.purpose,
    amount,
    hasOpen,
    hasPaper: Boolean(body.paper?.base64),
  });
  if (!check.ok) throw badRequest(check.reason);

  // The period follows from what the money is for. Nothing the form sends
  // about it is read: changing it is a decision, and decisions are made by
  // whoever is answering the request.
  const months = check.months;
  const purpose = body.purpose;

  const documentId = body.paper?.base64
    ? await storeFile(ctx, staffId, {
      kind: 'advance_paper',
      title: `${purposeOf(purpose)?.label ?? 'Advance'} — ${staff.name}`,
      filename: str(body.paper.filename, 'File name', { max: 120 }) || 'paper',
      mime: str(body.paper.mime, 'File type', { max: 80 }) || 'image/jpeg',
      bytes: fromBase64(body.paper.base64),
      expiresOn: null,
      by: `${staff.name} (staff)`,
    })
    : null;

  const row = await ctx.db.prepare(
    `INSERT INTO hr_advance (staff_id, amount, months, monthly, currency, reason, status,
                             asked_by, purpose, document_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'requested', ?7, ?8, ?9) RETURNING id`,
  ).bind(staffId, amount, months, instalmentFor(amount, months), currency, reason,
    `${staff.name} (staff)`, purpose, documentId).first();

  await audit(ctx, 'advance.ask', row?.id, { amount, months, purpose });

  await createNotice(ctx.db, {
    kind: 'advance.asked',
    level: 'info',
    title: `${staff.name} has asked for a salary advance`,
    body: `${money(amount, currency)} for ${(purposeOf(purpose)?.label ?? 'something').toLowerCase()}`
      + `, over ${months} month${months === 1 ? '' : 's'}.`
      + (documentId ? ' The paper is attached.' : '')
      + (reason ? ` ${reason}` : ''),
    link: '#/att-advances',
    actor: staff.name,
    audience: 'hr_pay',
  }, ctx);

  return json({ ok: true, id: row?.id ?? null, status: 'requested', months, purpose });
}

/** Take back a request nobody has decided yet. */
export async function withdrawMyAdvance(ctx, idParam) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  const id = int(idParam, 'Request', { required: true, min: 1 });

  const row = await ctx.db.prepare('SELECT * FROM hr_advance WHERE id = ? AND staff_id = ?')
    .bind(id, staffId).first();
  if (!row) throw notFound('That is not one of yours.');
  if (row.status !== 'requested') throw badRequest('That has already been decided.');

  await ctx.db.prepare("UPDATE hr_advance SET status = 'withdrawn' WHERE id = ?").bind(id).run();
  await audit(ctx, 'advance.withdraw', id, {});
  return json({ ok: true });
}

// --------------------------------------------------------------------------
// The end of the month
// --------------------------------------------------------------------------

/**
 * The nudge, from the daily cron.
 *
 * On the last day of the month, and on any day afterwards while a month is
 * still unanswered. It asks rather than records: what came off somebody's pay
 * is a fact about a payslip, and an app that assumes it happened is an app
 * quietly writing fiction into a ledger people are held to.
 */
export async function askAboutTheMonth(db, { timezone = 'UTC', now = null, ctx = null } = {}) {
  // The day is a parameter so a test can stand on the 30th of September
  // without waiting for it. The cron passes nothing and gets the real one.
  const today = isDay(now) ? String(now) : todayIn(timezone);
  const thisMonth = monthOf(today);
  const month = isMonthEnd(today) ? thisMonth : addMonths(thisMonth, -1);

  const closed = await db.prepare('SELECT month FROM hr_advance_month WHERE month = ?')
    .bind(month).first().catch(() => null);
  if (closed) return { asked: 0, month };

  // Only on the last day, and then once a week while it stays unanswered. A
  // daily reminder about the same month is a notification people learn to
  // dismiss without reading.
  const day = Number(today.slice(8, 10));
  if (!isMonthEnd(today) && day !== 7 && day !== 14) return { asked: 0, month };

  const rows = await db.prepare(
    `SELECT a.id, a.monthly, a.amount, a.start_month
       FROM hr_advance a WHERE a.status = 'approved'`,
  ).all().catch(() => ({ results: [] }));

  const open = [];
  for (const advance of rows.results ?? []) {
    if ((advance.start_month || '9999-99') > month) continue;
    const entries = await entriesFor(db, advance.id);
    if (balanceOf(advance, entries) <= 0) continue;
    if (entries.some((e) => e.month === month && ['repayment', 'skipped'].includes(e.kind))) continue;
    open.push(advance);
  }
  if (!open.length) return { asked: 0, month };

  const owed = round2(open.reduce((n, a) => n + round2(a.monthly), 0));
  const currency = (await db.prepare("SELECT value FROM settings WHERE key = 'currency'")
    .first().catch(() => null))?.value || 'GHS';

  await createNotice(db, {
    kind: 'advance.month_end',
    level: 'info',
    title: `Close off ${month}: ${open.length} advance${open.length === 1 ? '' : 's'} to confirm`,
    body: `${money(owed, currency)} is due to come off this month. Say what was actually `
      + 'deducted, and add anything new that was given out.',
    link: `#/att-advances?month=${month}`,
    day: today,
    slot: `advance-month:${month}`,
    actor: 'HIVE',
    audience: 'hr_pay',
    push: true,
    email: false,
  }, ctx);

  return { asked: open.length, month };
}

// --------------------------------------------------------------------------

async function entriesFor(db, advanceId) {
  const rows = await db.prepare('SELECT * FROM hr_advance_entry WHERE advance_id = ? ORDER BY month, id')
    .bind(advanceId).all().catch(() => ({ results: [] }));
  return rows.results ?? [];
}

/** Write a movement, and settle the advance when nothing is left. */
async function write(ctx, advance, { month, kind, amount, note }) {
  await ctx.db.prepare(
    `INSERT INTO hr_advance_entry (advance_id, month, kind, amount, note, actor)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(advance.id, month, kind, amount, note, actorOf(ctx)).run();

  await audit(ctx, 'advance.entry', advance.id, { month, kind, amount });

  const entries = await entriesFor(ctx.db, advance.id);
  if (balanceOf(advance, entries) > 0.009) return;

  await ctx.db.prepare(
    "UPDATE hr_advance SET status = 'settled', settled_at = datetime('now') WHERE id = ?",
  ).bind(advance.id).run();

  const person = await ctx.db.prepare(
    `SELECT s.id, s.name, u.id AS user_id
       FROM att_staff s LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
      WHERE s.id = ?`,
  ).bind(advance.staff_id).first();

  await tell(ctx, person, {
    kind: 'advance.settled',
    title: 'Your salary advance is paid off',
    body: 'Nothing more will come off your pay for it.',
  });
}

/** Tell the person, if there is an account to tell. */
async function tell(ctx, person, { kind, title, body }) {
  if (!person?.user_id) return;
  await createNotice(ctx.db, {
    kind,
    level: 'info',
    title,
    body,
    link: '#/att-my-advance',
    actor: 'HIVE',
    userId: person.user_id,
    push: true,
    email: false,
  }, ctx);
}

/**
 * The bill or the tenancy agreement, handed back as the file it is.
 *
 * Two people may read it: whoever is deciding the request, and the person
 * whose paper it is. The check is on this row rather than on the menu that led
 * here.
 */
export async function paper(ctx, idParam) {
  const id = int(idParam, 'Advance', { required: true, min: 1 });

  const row = await ctx.db.prepare('SELECT staff_id, document_id FROM hr_advance WHERE id = ?')
    .bind(id).first();
  if (!row?.document_id) throw notFound('Nothing was attached to that request.');

  const mine = Number(ctx.session.user.staff_id) || 0;
  const everybody = (ctx.session.permissions ?? []).includes('hr_pay');
  if (!everybody && mine !== Number(row.staff_id)) {
    throw forbidden('That is not yours to read.');
  }

  const doc = await ctx.db.prepare('SELECT * FROM hr_document WHERE id = ?')
    .bind(row.document_id).first();
  if (!doc) throw notFound('That paper is no longer on file.');

  const content = await readFile(ctx.db, doc);
  return new Response(content, {
    headers: {
      'Content-Type': doc.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${(doc.filename || 'paper').replace(/["\\]/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

/** Bytes out of what the browser sent, data-URI prefix and all. */
function fromBase64(value) {
  const clean = String(value ?? '').replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  if (!clean) return new Uint8Array(0);
  let binary;
  try {
    binary = atob(clean);
  } catch {
    throw badRequest('That file did not arrive in one piece. Try again.');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Money, said the way the screens say it: grouped, and no pesewas on a whole. */
const money = (amount, currency = 'GHS') => {
  const n = round2(amount);
  return `${currency} ${n.toLocaleString('en-GB', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};

// ---------------------------------------------------------------------------
// Advances, out of a spreadsheet
// ---------------------------------------------------------------------------

/** Who the property knows, and what is already on the books. */
async function booksNow(db) {
  const [staff, open] = await Promise.all([
    db.prepare('SELECT id, employee_no, name, active FROM att_staff').all(),
    db.prepare("SELECT staff_id, amount, taken_on FROM hr_advance WHERE status <> 'declined'")
      .all().catch(() => ({ results: [] })),
  ]);
  return { staff: staff.results ?? [], open: open.results ?? [] };
}

/** What the file would do, said before anything is done. */
export async function readAdvanceImport(ctx) {
  const body = await readJson(ctx.request);
  const text = String(body.text ?? '');
  if (!text.trim()) throw badRequest('There is nothing in that file.');

  const { timezone } = await settingsOf(ctx.db);
  const read = readAdvanceSheet(text, { ...(await booksNow(ctx.db)), today: todayIn(timezone) });
  return json({ ...read, tally: tallyOf(read) });
}

/**
 * And then do it.
 *
 * The file is read again here rather than trusting a list posted back from the
 * screen. Somebody may have recorded one of these by hand between the preview
 * and the button, and the second read is what stops it going on twice.
 *
 * NOBODY IS TOLD. Recording an advance by hand sends the person a message,
 * because it is news: money has just been agreed. A sheet of advances that
 * have been running since March is not news to anybody, and eleven of those
 * messages on one afternoon is how people learn to ignore the app. The screen
 * says so before the button is pressed.
 */
export async function applyAdvanceImport(ctx) {
  const body = await readJson(ctx.request);
  const text = String(body.text ?? '');
  if (!text.trim()) throw badRequest('There is nothing in that file.');

  const { timezone, currency } = await settingsOf(ctx.db);
  const read = readAdvanceSheet(text, { ...(await booksNow(ctx.db)), today: todayIn(timezone) });
  if (read.missingColumns.length) {
    throw badRequest(`The sheet needs ${read.missingColumns.join(' and ')}.`);
  }

  const actor = actorOf(ctx);
  let added = 0;
  let opened = 0;
  const failed = [];

  for (const line of read.lines) {
    try {
      const row = await ctx.db.prepare(
        `INSERT INTO hr_advance
           (staff_id, amount, months, monthly, currency, reason, status, taken_on, start_month,
            asked_by, decided_by, decided_at, decision, purpose)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'approved', ?7, ?8, ?9, ?9, datetime('now'), ?10, ?11)
         RETURNING id`,
      ).bind(
        line.staffId, line.amount, line.months, line.monthly, currency, line.reason,
        line.takenOn, line.startMonth, actor, 'Brought in from a spreadsheet', line.purpose,
      ).first();
      added += 1;

      // What has already come off, as one adjustment rather than a month of
      // invented repayments. The property knows the total it has recovered; it
      // does not necessarily know which months it came out of, and writing
      // months nobody can vouch for would put figures in the ledger that
      // nothing supports.
      if (line.repaid > 0) {
        await ctx.db.prepare(
          `INSERT INTO hr_advance_entry (advance_id, month, kind, amount, note, actor, source)
           VALUES (?1, ?2, 'adjustment', ?3, ?4, ?5, 'import')`,
        ).bind(
          row.id,
          line.startMonth ?? monthOf(line.takenOn),
          line.repaid,
          'Already repaid before this was brought into HIVE',
          actor,
        ).run().catch(() => {});
      }

      if (line.outstanding > 0.009) opened += 1;
      else {
        await ctx.db.prepare(
          "UPDATE hr_advance SET status = 'settled', settled_at = datetime('now') WHERE id = ?",
        ).bind(row.id).run().catch(() => {});
      }
    } catch (err) {
      failed.push({ at: line.at, name: line.name, why: String(err.message).slice(0, 200) });
    }
  }

  await audit(ctx, 'advance.import', null, {
    added, opened, skipped: read.skipped.length, failed: failed.length,
  });

  return json({
    ok: true, added, opened, failed, skipped: read.skipped,
  });
}

/**
 * A sheet to fill in, with the property's own running advances already on it.
 *
 * The same shape as everywhere else: what comes down is what is already here,
 * so a correction is a changed cell rather than a file somebody builds. A
 * property with none yet gets one example row.
 */
export async function advanceTemplate(ctx) {
  const { staff } = await booksNow(ctx.db);
  const byId = new Map(staff.map((s) => [s.id, s]));
  const { advances, entriesBy } = await ledger(ctx.db);

  const head = ['Employee no', 'Name', 'Amount', 'Months', 'Monthly', 'Taken on', 'Starts',
    'Purpose', 'What it is for', 'Already repaid'];
  const rows = [head];

  for (const advance of advances) {
    if (!isOpen(advance)) continue;
    const person = byId.get(advance.staff_id);
    if (!person) continue;
    rows.push([
      person.employee_no,
      person.name,
      round2(advance.amount).toFixed(2),
      advance.months,
      round2(advance.monthly).toFixed(2),
      advance.taken_on ?? '',
      advance.start_month ?? '',
      purposeOf(advance.purpose)?.label ?? '',
      advance.reason ?? '',
      round2(repaidOf(entriesBy.get(advance.id) ?? [])).toFixed(2),
    ]);
  }

  if (rows.length === 1) {
    rows.push(['001', 'Kofi Mensah', '1200.00', '6', '200.00', '2026-03-01', '2026-04',
      'Something else', 'An example — change it or delete the line', '400.00']);
  }

  return csvResponse('advances.csv', rows);
}
