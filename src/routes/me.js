import {
  badRequest, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import {
  colourFor, computeRange, labelFor, leaveBalance, leaveDaysIn, loadDataset, scheduleFor,
  summarise, toMinutes,
} from '../lib/attendance.js';
import { createNotice } from '../lib/notices.js';
import {
  addDays, diffDays, isDay, isMonth, monthBounds, monthOf, nowIn, startOfWeek, todayIn,
} from '../util/dates.js';

/** A date, or the fallback. Anything else is a mistake worth naming. */
function readDay(value, fallback) {
  if (value == null || value === '') return fallback;
  const day = String(value);
  if (!isDay(day)) throw badRequest('That date is not valid.');
  return day;
}

/** A clock time, or nothing. */
function readClock(value, field) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (toMinutes(text) == null) throw badRequest(`${field} must be a time like 14:30.`);
  return text.slice(0, 5);
}

/**
 * The half of a rota system a hotel actually notices.
 *
 * Everything above this line is for the people who run the place. This is for
 * the people on the rota, and the alternative to it is a printed sheet on a
 * noticeboard and a photograph of that sheet in a group chat — out of date the
 * moment anybody swaps a shift, and the reason "nobody told me" is a real
 * answer rather than an excuse.
 *
 * THREE RULES HOLD THE WHOLE SCREEN UP.
 *
 *   Who you are comes off the session, never off the request. Every route here
 *   resolves one staff id, from the account, and refuses if there is not one.
 *   No route here takes a staff id as an argument, which means there is no
 *   version of "look at somebody else's" to get wrong.
 *
 *   Only what has been published. A draft is a planner thinking out loud, and
 *   a member of staff who arranges childcare around a dashed cell has been
 *   misled by the app. Anything not published simply is not there.
 *
 *   No overtime figure. What somebody is owed is settled at sign-off by a
 *   person who looked at the month; a running total on a phone is a number to
 *   argue with a manager about, and the app should not be the one starting it.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

/**
 * Which staff record this account belongs to.
 *
 * Refuses rather than guessing. An account with `att_me` and no staff record
 * behind it is a setup that was half finished, and answering it with somebody
 * else's week would be very much worse than answering it with an error.
 */
async function meOf(ctx) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  if (!staffId) {
    throw forbidden(
      'This login is not linked to a staff record yet, so there is nothing of yours to show. '
      + 'Ask whoever set it up to point it at you under Users.',
    );
  }
  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!staff) throw notFound('The staff record this login points at is gone.');
  return staff;
}

/**
 * Seconds between two local wall clocks, as 'YYYY-MM-DD HH:MM'.
 *
 * Wall clock on both sides, in the same place, so no offset comes into it.
 * Ghana does not move its clocks; a property that did would be an hour out
 * twice a year on one countdown, which is the right amount of wrong for a
 * number that only exists to say "soon".
 */
function secondsBetween(from, to) {
  const at = (text) => {
    const [day, clock] = String(text).split(' ');
    const [y, m, d] = day.split('-').map(Number);
    const [hh, mm] = (clock || '00:00').split(':').map(Number);
    return Date.UTC(y, m - 1, d, hh || 0, mm || 0) / 1000;
  };
  return at(to) - at(from);
}

/**
 * The next shift, and how long until it starts.
 *
 * A countdown rather than a date, and only inside a day, because that is the
 * window in which the number changes what somebody does. "In 3 days" is a
 * calendar; "in 6 hours" is a reason to go to bed.
 *
 * A shift somebody has already clocked in for is not counted down to, even
 * when the clock-in was early and the start time has not come round yet.
 * Standing at the terminal watching a clock tick towards a shift you are
 * already at work on is the app arguing with the room.
 */
function countdownTo(days, timezone, onShift = null) {
  const now = nowIn(timezone);
  for (const entry of days) {
    if (!entry.shift?.starts_at) continue;
    if (onShift && onShift.day === entry.day) continue;
    const seconds = secondsBetween(now, `${entry.day} ${entry.shift.starts_at}`);
    // Already begun, or long finished. A shift that started an hour ago is not
    // a countdown, and the day itself already says what it is.
    if (seconds <= 0) continue;
    return {
      day: entry.day,
      title: entry.title ?? null,
      shift: entry.shift,
      seconds,
      // Whether it is close enough to be worth a countdown at all. The screen
      // decides what to draw; the server decides what "soon" means, so both
      // halves of the app cannot disagree about it.
      soon: seconds <= 24 * 3600,
    };
  }
  return null;
}

/**
 * Are they at work right now, and on which shift?
 *
 * Yesterday and today rather than the weeks on screen, for two reasons.
 * Somebody scrolling back to March does not stop being at work while they do
 * it, and a night shift that began yesterday is still the answer to "am I
 * clocked in".
 *
 * "Working" is the app's own word for a clock-in with no clock-out yet, before
 * the shift has finished. After it finishes the same punches mean something
 * else entirely, and that is not this question.
 */
function onShiftNow(ds, staffId, today) {
  const records = computeRange(ds, staffId, addDays(today, -1), today);
  for (const record of records) {
    if (record.status !== 'working') continue;
    const shift = scheduleFor(ds, staffId, record.day).shift;
    const since = record.corrected_in ?? record.first_in ?? null;
    return {
      day: record.day,
      since,
      // Minutes after the start, or before it. A property where people clock
      // in twenty minutes early every day should see that said plainly rather
      // than as a countdown that has quietly stopped.
      lateMinutes: Number(record.late_minutes) || 0,
      earlyIn: shift?.starts_at && since
        ? Math.max(0, Math.round(secondsBetween(`${record.day} ${since}`, `${record.day} ${shift.starts_at}`) / 60))
        : 0,
      shift: shift
        ? {
          id: shift.id,
          name: shift.name,
          starts_at: shift.starts_at,
          ends_at: shift.ends_at,
          department: shift.department ?? null,
          colour: shift.colour ?? null,
        }
        : null,
    };
  }
  return null;
}

/**
 * My weeks: what I am down to work, and how the days behind me came out.
 *
 * Four weeks at a time by default, starting on the Monday of the week asked
 * for. Past days carry the verdict the app reached — on time, late by so many
 * minutes, absent — because "was I marked late on Tuesday" is the question
 * that otherwise gets asked at the end of the month when nobody can remember.
 */
export async function myWeek(ctx) {
  const staff = await meOf(ctx);
  const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first())?.value || 'UTC';
  const today = todayIn(timezone);

  const asked = ctx.url.searchParams.get('from');
  const from = startOfWeek(isDay(asked) ? asked : today);
  const to = addDays(from, 27);

  // The weeks on screen, and always today as well. Somebody scrolling back to
  // March is still either at work or not, and the answer has to be in the
  // dataset for the screen to be able to say so.
  const dsFrom = [addDays(from, -1), addDays(today, -1)].sort()[0];
  const dsTo = [addDays(to, 1), today].sort().pop();

  const [ds, availability, year, requests] = await Promise.all([
    loadDataset(ctx.db, { from: dsFrom, to: dsTo }),
    ctx.db.prepare(
      'SELECT * FROM att_availability WHERE staff_id = ?1 AND day BETWEEN ?2 AND ?3',
    ).bind(staff.id, from, to).all().catch(() => ({ results: [] })),
    ctx.db.prepare(
      'SELECT * FROM att_days WHERE staff_id = ?1 AND day BETWEEN ?2 AND ?3',
    ).bind(staff.id, `${today.slice(0, 4)}-01-01`, today).all().catch(() => ({ results: [] })),
    ctx.db.prepare(
      `SELECT l.*, r.label AS reason_label FROM att_leave l
         LEFT JOIN att_reasons r ON r.code = l.reason_code
        WHERE l.staff_id = ? ORDER BY l.from_day DESC LIMIT 40`,
    ).bind(staff.id).all().catch(() => ({ results: [] })),
  ]);

  const availabilityBy = new Map(
    (availability.results ?? []).map((a) => [a.day, a]),
  );
  const verdicts = new Map(computeRange(ds, staff.id, from, to).map((r) => [r.day, r]));
  const onShift = onShiftNow(ds, staff.id, today);

  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const rostered = ds.rosterBy.get(`${staff.id}|${day}`);
    const schedule = scheduleFor(ds, staff.id, day);
    const leave = ds.leaveBy.get(`${staff.id}|${day}`) ?? null;

    // Published, or from the standing pattern, which is the arrangement they
    // agreed to and has never needed publishing. A hand-set cell nobody has
    // published yet is a plan, and plans are not shown here.
    const settled = schedule.source === 'pattern'
      || (schedule.source === 'roster' && Boolean(rostered?.published));

    const shift = settled ? schedule.shift : null;
    const record = day < today ? verdicts.get(day) : null;
    const avail = availabilityBy.get(day) ?? null;

    days.push({
      day,
      shift: shift
        ? {
          id: shift.id,
          name: shift.name,
          starts_at: shift.starts_at,
          ends_at: shift.ends_at,
          break_minutes: shift.break_minutes ?? 0,
          department: shift.department ?? null,
          colour: shift.colour ?? null,
        }
        : null,
      title: settled ? (rostered?.title ?? null) : null,
      // A day the planner has decided and not yet published shows as pending
      // rather than as nothing, so somebody looking at a blank Thursday knows
      // whether it is a day off or a day still being worked out.
      pending: schedule.source === 'roster' && !rostered?.published,
      restDay: settled && !shift,
      leave: leave ? (ds.reasonBy.get(leave.reason_code)?.label ?? leave.reason_code) : null,
      holiday: ds.holidayBy.get(day)?.name ?? null,
      // The banner the row wears while somebody is at work on it.
      onShift: onShift && onShift.day === day
        ? { since: onShift.since, lateMinutes: onShift.lateMinutes, earlyIn: onShift.earlyIn }
        : null,
      availability: avail
        ? {
          status: avail.status, note: avail.note ?? null,
          from: avail.from_time ?? null, to: avail.to_time ?? null,
        }
        : null,
      // How the day came out, for days behind them only. Deliberately without
      // an overtime figure: what somebody is owed is settled at sign-off.
      was: record
        ? {
          label: labelFor(record, ds.reasonBy),
          // Worked out here rather than read off the row, exactly as every
          // other screen does it. A colour decided twice is a colour that
          // disagrees with itself the first time one of them is changed.
          colour: colourFor(record, ds.reasonBy),
          in: record.corrected_in ?? record.first_in ?? null,
          out: record.corrected_out ?? record.last_out ?? null,
          lateMinutes: Number(record.late_minutes) || 0,
          earlyMinutes: Number(record.early_minutes) || 0,
        }
        : null,
    });
  }

  // Whether the property shows people their own balance. Worked out here and
  // left out of the answer entirely when it is off, rather than hidden by the
  // screen: a figure a browser has been sent is a figure anybody who opens the
  // network tab has read.
  const showBalance = ds.settings.att_show_balance !== '0';
  const balance = showBalance
    ? leaveBalance({
      staff,
      records: year.results ?? [],
      requests: (requests.results ?? []).filter((r) => r.status === 'pending'),
      settings: ds.settings,
      asOf: today,
      reasons: ds.reasonBy,
    })
    : null;

  return json({
    from,
    to,
    today,
    // How long until the next one starts. Only ever the next: a list of
    // countdowns is a list, and the point of this is the one number. Null
    // while they are on the shift it would have been counting down to.
    next: countdownTo(days, timezone, onShift),
    // Whether they are at work right now, and on what.
    onShift,
    me: { id: staff.id, name: staff.name, employee_no: staff.employee_no, department: staff.department },
    days,
    showBalance,
    balance,
    leave: (requests.results ?? []).map((r) => ({
      id: r.id,
      from: r.from_day,
      to: r.to_day,
      days: r.days,
      status: r.status,
      reason: r.reason ?? null,
      label: r.reason_label ?? r.reason_code,
      note: r.decision_note ?? null,
      decidedBy: r.decided_by ?? null,
    })),
    // Only the kinds the property has said somebody may ask for themselves.
    // Whoever manages leave can still record any of them: maternity leave is
    // arranged in an office rather than requested from a dropdown at the end
    // of a shift, and offering it here only invites the same conversation.
    reasons: (ds.reasons ?? [])
      .filter((r) => r.kind === 'leave' && r.active && r.staff_pick)
      .map((r) => ({ code: r.code, label: r.label })),
  });
}

/**
 * My month.
 *
 * The figures somebody actually asks about at the end of a month: how many
 * days they worked, how many hours that came to, how often they were late and
 * by how long, what they were absent for, and what leave it cost them. Their
 * own, for a month they choose, with the day-by-day underneath it.
 *
 * Still no overtime figure, and for the same reason as everywhere else on this
 * side of the app: what somebody is owed is settled at sign-off by a person
 * who looked at the month. A number here that turned out to differ from the
 * one on their payslip would be worse than no number at all.
 *
 * It says plainly whether the month has been signed off, because that is the
 * difference between "this is what happened" and "this is what happened so
 * far, and it can still change".
 */
export async function myReport(ctx) {
  const staff = await meOf(ctx);
  const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first())?.value || 'UTC';
  const today = todayIn(timezone);

  const asked = ctx.url.searchParams.get('month');
  const month = isMonth(asked) ? asked : monthOf(today);
  const { from, to: monthEnd } = monthBounds(month);
  // Never past today: a month in progress is a month in progress, and counting
  // days that have not happened as absences would be a lie with somebody's
  // name on it.
  const to = monthEnd > today ? today : monthEnd;
  if (from > today) {
    return json({
      month, from, to: monthEnd, future: true, me: person(staff), days: [], totals: null,
      settled: false, withHolidays: true,
    });
  }

  const [ds, signed] = await Promise.all([
    loadDataset(ctx.db, { from, to }),
    ctx.db.prepare(
      `SELECT from_day FROM att_period_review
        WHERE staff_id = ?1 AND from_day <= ?3 AND to_day >= ?2`,
    ).bind(staff.id, from, to).all().catch(() => ({ results: [] })),
  ]);

  // Whether a public holiday counts towards what they read here. A property
  // that pays for them wants them in the figure; one that treats them as
  // ordinary rest days does not. Left out of the totals and off the list
  // together, so the day-by-day cannot disagree with the summary above it.
  const withHolidays = ds.settings.att_report_holidays !== '0';
  const all = computeRange(ds, staff.id, from, to);
  const records = withHolidays
    ? all
    : all.filter((r) => (ds.reasonBy.get(r.reason_code)?.kind ?? r.status) !== 'holiday');

  const totals = summarise(records, { shifts: ds.shiftById, reasons: ds.reasonBy });

  return json({
    month,
    from,
    to,
    monthEnd,
    today,
    withHolidays,
    me: person(staff),
    // Only what a person should read about their own month. `summarise`
    // carries more than this; the rest of it is the property's business.
    totals: {
      scheduled: totals.scheduled,
      daysWorked: totals.daysWorked,
      daysAbsent: totals.daysAbsent,
      daysLeave: totals.daysLeave,
      daysHoliday: totals.daysHoliday,
      daysRest: totals.daysRest,
      workedMinutes: totals.workedMinutes,
      lateCount: totals.lateCount,
      lateMinutes: totals.lateMinutes,
      earlyCount: totals.earlyCount,
      earlyMinutes: totals.earlyMinutes,
      leaveDeducted: totals.leaveDeducted,
      byReason: [...totals.byReason.entries()]
        .map(([code, n]) => ({
          code, label: ds.reasonBy.get(code)?.label ?? code, days: n,
        }))
        .sort((a, b) => b.days - a.days),
    },
    // Whether any of it has been closed off. Whether, and not by whom: a
    // member of staff reading their own month needs to know if the figures
    // can still move, and putting a manager's name against their attendance
    // record turns a report into something else.
    settled: (signed.results ?? []).length > 0,
    days: records
      .filter((r) => r.scheduled || Number(r.worked_minutes) || r.status === 'leave')
      .map((r) => ({
        day: r.day,
        shift: r.shift_id ? ds.shiftById.get(r.shift_id)?.name ?? null : null,
        label: labelFor(r, ds.reasonBy),
        colour: colourFor(r, ds.reasonBy),
        in: r.corrected_in ?? r.first_in ?? null,
        out: r.corrected_out ?? r.last_out ?? null,
        minutes: Number(r.worked_minutes) || 0,
        lateMinutes: Number(r.late_minutes) || 0,
        earlyMinutes: Number(r.early_minutes) || 0,
      })),
  });
}

const person = (staff) => ({
  id: staff.id, name: staff.name, employee_no: staff.employee_no, department: staff.department,
});

/**
 * Ask for leave.
 *
 * The same handler the office uses would have done, except for the one thing
 * that matters: nobody may approve their own. This always lands as pending,
 * whatever the account happens to hold.
 */
export async function askForLeave(ctx) {
  const staff = await meOf(ctx);
  const body = await readJson(ctx.request);

  const from = readDay(body.from);
  const to = readDay(body.to, from);
  if (to < from) throw badRequest('The last day is before the first.');
  if (diffDays(from, to) > 180) throw badRequest('That is more than six months. Split it up.');

  const reasonCode = str(body.reason, 'Type of leave', { required: true, max: 40 });
  const reason = await ctx.db.prepare(
    'SELECT * FROM att_reasons WHERE code = ? AND active = 1',
  ).bind(reasonCode).first();
  if (!reason || reason.kind !== 'leave') throw badRequest('That is not a kind of leave.');
  // Checked here as well as left off the list, because a list is a courtesy
  // and this is the rule.
  if (!reason.staff_pick) {
    throw badRequest(`${reason.label} is not something to ask for here. Speak to whoever `
      + 'manages the rota and they can record it for you.');
  }

  const halfDay = ['start', 'end', 'both'].includes(body.halfDay) ? body.halfDay : null;

  const ds = await loadDataset(ctx.db, { from, to });
  const days = leaveDaysIn({ from, to, staffId: staff.id, ds, halfDay });
  if (!days) {
    throw badRequest('You are not rostered on any of those days, so there is no leave to take.');
  }

  const clash = await ctx.db.prepare(
    `SELECT id FROM att_leave
      WHERE staff_id = ? AND status IN ('pending','approved')
        AND from_day <= ? AND to_day >= ?`,
  ).bind(staff.id, to, from).first();
  if (clash) throw badRequest('That overlaps leave you have already asked for.');

  const row = await ctx.db.prepare(
    `INSERT INTO att_leave
       (staff_id, reason_code, from_day, to_day, days, half_day, status, reason,
        requested_by, requested_by_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9) RETURNING id`,
  ).bind(
    staff.id, reasonCode, from, to, days, halfDay,
    str(body.note, 'Reason', { max: 500 }),
    `${staff.name} (staff)`,
    ctx.session.user.id ?? null,
  ).first();

  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
  ).bind(
    actorOf(ctx), 'attendance.leave_request_self', String(row?.id ?? ''),
    JSON.stringify({ from, to, days, reasonCode }),
  ).run().catch(() => {});

  // Whoever can approve it hears about it. Held against the permission rather
  // than a list of people, so it still reaches somebody promoted tomorrow.
  await createNotice(ctx.db, {
    kind: 'attendance.leave_asked',
    level: 'info',
    title: `${staff.name} has asked for leave`,
    body: `${from} to ${to} — ${days} day${days === 1 ? '' : 's'}.`
      + (body.note ? ` ${String(body.note).slice(0, 200)}` : ''),
    link: '#/att-leave',
    actor: staff.name,
    audience: 'att_manage',
  }, ctx);

  return json({ ok: true, id: row?.id ?? null, days, status: 'pending' });
}

/** Take back a request nobody has decided yet. */
export async function withdrawMyLeave(ctx, idParam) {
  const staff = await meOf(ctx);
  const id = int(idParam, 'Request', { required: true, min: 1 });

  const row = await ctx.db.prepare('SELECT * FROM att_leave WHERE id = ?').bind(id).first();
  // Not found rather than forbidden for somebody else's: an error that
  // distinguishes the two tells the reader a request exists.
  if (!row || row.staff_id !== staff.id) throw notFound('No such request of yours.');
  if (row.status !== 'pending') {
    throw badRequest('That has already been decided. Speak to your manager to change it.');
  }

  await ctx.db.prepare(
    `UPDATE att_leave SET status = 'withdrawn', decided_by = ?2, decided_at = datetime('now')
      WHERE id = ?1`,
  ).bind(id, `${staff.name} (withdrawn)`).run();

  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, NULL)',
  ).bind(actorOf(ctx), 'attendance.leave_withdraw_self', String(id)).run().catch(() => {});

  return json({ ok: true });
}

/**
 * Say which days, or which hours of a day, you cannot work.
 *
 * Not leave. Nothing is approved and no entitlement is spent — it is the fact
 * the planner needs in front of them before they pick a shift, put in by the
 * person who actually knows it. Rostering over one stays possible, because
 * some conflicts are deliberate and the grid should show them.
 */
export async function setMyAvailability(ctx) {
  const staff = await meOf(ctx);
  const body = await readJson(ctx.request);

  const days = [...new Set((Array.isArray(body.days) ? body.days : []).map(String))]
    .filter((d) => isDay(d));
  if (!days.length) throw badRequest('Say which days.');
  if (days.length > 62) throw badRequest('Two months of days at most in one go.');

  const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first())?.value || 'UTC';
  const today = todayIn(timezone);
  if (days.some((d) => d < today)) {
    throw badRequest('A day that has already happened cannot be marked. Speak to your manager.');
  }

  if (body.clear) {
    await ctx.db.batch(days.map((day) => ctx.db.prepare(
      'DELETE FROM att_availability WHERE staff_id = ? AND day = ?',
    ).bind(staff.id, day)));
    return json({ ok: true, cleared: days.length });
  }

  const status = body.status === 'preferred' ? 'preferred' : 'unavailable';
  const note = str(body.note, 'Note', { max: 200 });
  const fromTime = readClock(body.fromTime, 'From');
  const toTime = readClock(body.toTime, 'Until');
  if ((fromTime && !toTime) || (!fromTime && toTime)) {
    throw badRequest('Give both times, or neither for the whole day.');
  }
  if (fromTime && toTime && toTime <= fromTime) {
    throw badRequest('The end of the window has to come after its start.');
  }

  await ctx.db.batch(days.map((day) => ctx.db.prepare(
    `INSERT INTO att_availability (staff_id, day, status, note, set_by, from_time, to_time)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (staff_id, day) DO UPDATE SET
       status = excluded.status, note = excluded.note,
       set_by = excluded.set_by, set_at = datetime('now'),
       from_time = excluded.from_time, to_time = excluded.to_time`,
  ).bind(staff.id, day, status, note, `${staff.name} (staff)`, fromTime, toTime)));

  return json({ ok: true, marked: days.length, status });
}

/**
 * Say you are running late.
 *
 * Small, and the thing a hotel wants most. Somebody stuck in traffic presses
 * one button and whoever is on the floor knows before the shift starts,
 * instead of finding out by looking at an empty station. It records nothing
 * against the day: the terminal decides what happened, and this is a message.
 */
export async function tellThemImLate(ctx) {
  const staff = await meOf(ctx);
  const body = await readJson(ctx.request);

  const minutes = int(body.minutes ?? 15, 'How late', { min: 5, max: 480 });
  const note = str(body.note, 'Note', { max: 200 });

  const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first())?.value || 'UTC';
  const today = todayIn(timezone);

  const ds = await loadDataset(ctx.db, { from: today, to: today });
  const shift = scheduleFor(ds, staff.id, today).shift;

  await createNotice(ctx.db, {
    kind: 'attendance.running_late',
    level: 'warn',
    title: `${staff.name} is running about ${minutes} minutes late`,
    body: (shift ? `Down for ${shift.name}, ${shift.starts_at}. ` : 'Not on the rota today. ')
      + (note || 'No reason given.'),
    link: '#/att-today',
    day: today,
    actor: staff.name,
    audience: 'att_view',
    // The whole point of the button. A message that waits for somebody to
    // open the app arrives after they have already noticed the empty station.
    push: true,
  }, ctx);

  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
  ).bind(
    actorOf(ctx), 'attendance.running_late', String(staff.id),
    JSON.stringify({ minutes, day: today }),
  ).run().catch(() => {});

  return json({ ok: true, minutes, day: today });
}
