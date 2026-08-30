import { siteOrigin } from '../lib/site.js';
import {
  badRequest, bool, csvResponse, int, json, notFound, num, readJson, rethrowConstraint, str,
} from '../lib/http.js';
import { readStaffSheet, tallyOf } from '../lib/staff-import.js';
import { ratesFrom } from '../lib/tax.js';
import { tiersFrom } from '../lib/statutory.js';
import { EARLIEST } from '../lib/tax-tables.js';
import { ghanaHolidays, toMinutes } from '../lib/attendance.js';
import { listeningHostSettings } from '../lib/push-events.js';
import { claimOrphans, hashDeviceToken, recompute } from '../lib/attendance-ingest.js';
import { getPepper } from '../lib/auth.js';
import { asBytes, fromBase64 } from '../lib/files.js';
import { addDays, isDay, todayIn } from '../util/dates.js';

/**
 * Attendance setup: the things that are decided once and then left alone.
 *
 * Kept apart from the daily API because the audiences do not overlap. A
 * supervisor uses the other file every morning and should never see a screen
 * that can delete a shift; whoever sets the property up uses this one twice a
 * year.
 */

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(
    `${ctx.session.user.name} (${ctx.session.user.role})`,
    action,
    entity == null ? null : String(entity),
    detail ? JSON.stringify(detail) : null,
  ).run().catch(() => {});
}

function readDayOrNull(value, field) {
  if (value == null || value === '') return null;
  const day = String(value);
  if (!isDay(day)) throw badRequest(`${field} is not a valid date.`);
  return day;
}

function readTime(value, field) {
  const text = str(value, field, { required: true, max: 8 });
  if (toMinutes(text) == null) throw badRequest(`${field} must be a time like 06:00.`);
  return text.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

/**
 * Every department worth offering: the configured list, plus every one already
 * in use on a person or a shift.
 *
 * Assembled here rather than in each screen so the staff form and the shift
 * form can never offer different lists — and so a department taken off the
 * configured list cannot disappear from the dropdown while something is still
 * filed under it, which would silently reassign it the next time that record
 * was edited for any other reason.
 */
export async function departmentOptions(db) {
  const [setting, staff, shifts] = await Promise.all([
    db.prepare("SELECT value FROM settings WHERE key = 'att_departments'")
      .first().catch(() => null),
    db.prepare('SELECT DISTINCT department FROM att_staff WHERE department IS NOT NULL')
      .all().catch(() => ({ results: [] })),
    db.prepare('SELECT DISTINCT department FROM att_shifts WHERE department IS NOT NULL')
      .all().catch(() => ({ results: [] })),
  ]);

  return cleanDepartments([
    setting?.value ?? '',
    ...(staff.results ?? []).map((r) => r.department),
    ...(shifts.results ?? []).map((r) => r.department),
  ].join('\n'));
}

/**
 * How many days a week this person is expected, where it differs.
 *
 * Blank means "whatever the property says", which is what almost everybody
 * will stay. Half days are allowed because a five-and-a-half-day week is a
 * real contract and rounding it to six would quietly cost somebody
 * twenty-six days a year.
 */
function readDaysPerWeek(value) {
  if (value == null || value === '') return null;
  return num(value, 'Days a week', { min: 0.5, max: 7 });
}

export async function listStaff(ctx) {
  const [rows, departments] = await Promise.all([
    ctx.db.prepare(
      `SELECT s.*, u.name AS user_name,
              (SELECT COUNT(*) FROM att_punches p WHERE p.staff_id = s.id) AS punch_count,
              (SELECT MAX(p.day) FROM att_punches p WHERE p.staff_id = s.id) AS last_seen
       FROM att_staff s LEFT JOIN users u ON u.id = s.user_id
       ORDER BY s.active DESC, s.name`,
    ).all(),
    departmentOptions(ctx.db),
  ]);

  // Every shift, so the "they can work in" picker can offer them by name
  // rather than only by department. Retired ones come too, because somebody
  // already picked out for one should see why they are.
  const shifts = await ctx.db.prepare(
    `SELECT id, name, department, starts_at, ends_at, active
       FROM att_shifts ORDER BY sort_order, starts_at, name`,
  ).all().catch(() => ({ results: [] }));

  return json({ staff: rows.results ?? [], departments, shifts: shifts.results ?? [] });
}

/**
 * Add somebody.
 *
 * The employee number is the one field that has to be right: it is what joins a
 * face on the terminal to a name here, and a typo produces a person who is
 * absent every day while their punches pile up unclaimed. So any punches
 * already held under that number are attached on the spot, and the count is
 * reported back — which is also the quickest way to notice the typo.
 */
/**
 * The departments somebody may be rostered in, as they arrive from a form.
 *
 * An empty list is stored as null rather than "[]", because the two mean the
 * same thing here and one of them reads as a decision somebody made.
 */
function readWorksIn(value) {
  if (value == null) return null;
  const list = (Array.isArray(value) ? value : [value])
    .map((v) => String(v).trim())
    .filter(Boolean);
  const unique = [...new Set(list)];
  if (unique.length > 20) throw badRequest('That is more departments than a property has.');
  return unique.length ? JSON.stringify(unique) : null;
}

/** The weekdays somebody never works, as they arrive from a form. */
function readOffDays(value) {
  if (value == null) return null;
  const list = (Array.isArray(value) ? value : [value])
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const unique = [...new Set(list)].sort((a, b) => a - b);
  if (unique.length === 7) throw badRequest('That leaves them no day they can work.');
  return unique.length ? JSON.stringify(unique) : null;
}

/** The same, for shifts picked out one at a time. */
function readWorksShifts(value) {
  if (value == null) return null;
  const list = (Array.isArray(value) ? value : [value])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  const unique = [...new Set(list)];
  if (unique.length > 200) throw badRequest('That is more shifts than a property has.');
  return unique.length ? JSON.stringify(unique) : null;
}

export async function createStaff(ctx) {
  const body = await readJson(ctx.request);
  const employeeNo = str(body.employeeNo, 'Employee number', { required: true, max: 40 });
  const name = str(body.name, 'Name', { required: true, max: 120 });

  // Somebody the clock is not about is never on the rota either. The rota is
  // a plan for who is coming in, and there is no version of it that means
  // anything for a director who is only here to be paid.
  const onClock = bool(body.onClock, true);
  const onRota = onClock && bool(body.onRota, true);

  let row;
  try {
    row = await ctx.db.prepare(
      `INSERT INTO att_staff (employee_no, name, department, job_title, hired_on, leave_days,
                              days_per_week, user_id, note, on_rota, works_in, works_shifts,
                              off_days, on_clock)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) RETURNING id`,
    ).bind(
      employeeNo, name,
      str(body.department, 'Department', { max: 80 }),
      str(body.jobTitle, 'Job title', { max: 80 }),
      readDayOrNull(body.hiredOn, 'Start date'),
      body.leaveDays == null || body.leaveDays === '' ? null : num(body.leaveDays, 'Leave days', { min: 0, max: 365 }),
      readDaysPerWeek(body.daysPerWeek),
      body.userId == null || body.userId === '' ? null : int(body.userId, 'Login', { min: 1 }),
      str(body.note, 'Note', { max: 300 }),
      onRota ? 1 : 0,
      readWorksIn(body.worksIn),
      readWorksShifts(body.worksShifts),
      readOffDays(body.offDays),
      onClock ? 1 : 0,
    ).first();
  } catch (err) {
    rethrowConstraint(err, {
      unique: `Employee number ${employeeNo} is already used by somebody else.`,
      foreignKey: 'That login no longer exists.',
    });
  }

  // Punches held under that number are theirs, unless the number was invented
  // to give somebody a payslip — in which case it belongs to whoever really
  // holds that card, and handing them a stranger's punches is the one mistake
  // this would be hardest to notice.
  const claimed = onClock
    ? await claimOrphans(ctx.db, row.id, employeeNo)
    : { claimed: 0 };
  if (claimed.claimed) {
    await recompute(ctx.db, { staffIds: [row.id], from: claimed.from, to: claimed.to });
  }
  await audit(ctx, 'attendance.staff_create', row.id, { employeeNo, name, onClock });

  return json({ ok: true, id: row.id, claimedPunches: claimed.claimed });
}

export async function updateStaff(ctx, id) {
  const staffId = Number(id);
  const body = await readJson(ctx.request);
  const existing = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!existing) throw notFound('No such member of staff.');

  const employeeNo = str(body.employeeNo, 'Employee number', { required: true, max: 40 });
  const onClock = bool(body.onClock, existing.on_clock !== 0);
  const onRota = onClock && bool(body.onRota, true);

  try {
    await ctx.db.prepare(
      `UPDATE att_staff SET employee_no = ?1, name = ?2, department = ?3, job_title = ?4,
                            hired_on = ?5, left_on = ?6, leave_days = ?7, user_id = ?8,
                            active = ?9, note = ?10, days_per_week = ?12, on_rota = ?13,
                            works_in = ?14, works_shifts = ?15, off_days = ?16,
                            on_clock = ?17
       WHERE id = ?11`,
    ).bind(
      employeeNo,
      str(body.name, 'Name', { required: true, max: 120 }),
      str(body.department, 'Department', { max: 80 }),
      str(body.jobTitle, 'Job title', { max: 80 }),
      readDayOrNull(body.hiredOn, 'Start date'),
      readDayOrNull(body.leftOn, 'Leaving date'),
      body.leaveDays == null || body.leaveDays === '' ? null : num(body.leaveDays, 'Leave days', { min: 0, max: 365 }),
      body.userId == null || body.userId === '' ? null : int(body.userId, 'Login', { min: 1 }),
      bool(body.active, true) ? 1 : 0,
      str(body.note, 'Note', { max: 300 }),
      staffId,
      readDaysPerWeek(body.daysPerWeek),
      onRota ? 1 : 0,
      readWorksIn(body.worksIn),
      readWorksShifts(body.worksShifts),
      readOffDays(body.offDays),
      onClock ? 1 : 0,
    ).run();
  } catch (err) {
    rethrowConstraint(err, {
      unique: `Employee number ${employeeNo} is already used by somebody else.`,
      foreignKey: 'That login no longer exists.',
    });
  }

  // A changed employee number means the punches under the old one are theirs no
  // longer and the ones under the new one are.
  if (employeeNo !== existing.employee_no) {
    await ctx.db.prepare(
      'UPDATE att_punches SET staff_id = NULL WHERE staff_id = ? AND employee_no != ?',
    ).bind(staffId, employeeNo).run();
    await claimOrphans(ctx.db, staffId, employeeNo);
  }

  const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first())?.value || 'UTC';
  const today = todayIn(timezone);

  // TAKEN OFF THE ROTA, AND OFF IT PROPERLY. Their standing pattern and any
  // day they were down for from today onwards go with them, so nothing is left
  // acting on a rota nobody can see: no cell in a cover count, no shift alert
  // at six in the morning, nothing on their own My shifts. What is behind them
  // stays untouched — a report for March must still show the March they
  // worked.
  let cleared = 0;
  if (existing.on_rota && !onRota) {
    await ctx.db.prepare(
      `INSERT INTO att_roster_log
         (day, staff_id, shift_id, was_staff_id, was_shift_id, action, source, actor, detail)
       SELECT day, staff_id, NULL, staff_id, shift_id, 'removed', 'off_rota', ?3,
              'Taken off the rota'
         FROM att_roster WHERE staff_id = ?1 AND day >= ?2`,
    ).bind(staffId, today, `${ctx.session.user.name} (${ctx.session.user.role})`)
      .run().catch(() => {});
    const gone = await ctx.db.prepare(
      'DELETE FROM att_roster WHERE staff_id = ?1 AND day >= ?2',
    ).bind(staffId, today).run().catch(() => null);
    cleared = Number(gone?.meta?.changes ?? 0);
    await ctx.db.prepare('DELETE FROM att_patterns WHERE staff_id = ?').bind(staffId)
      .run().catch(() => {});
  }

  // Taken off the clock, nothing is recomputed for them ever again, and every
  // screen stops carrying them. What was already worked out is left where it
  // is rather than deleted: it is what a report on last March was run against,
  // and putting them back on the clock should give them their history back
  // rather than an empty year.
  if (onClock) {
    await recompute(ctx.db, { staffIds: [staffId], from: addDays(today, -60), to: today });
  }
  await audit(ctx, 'attendance.staff_update', staffId, {
    employeeNo,
    offRota: existing.on_rota && !onRota ? { cleared } : undefined,
    offClock: existing.on_clock !== 0 && !onClock ? true : undefined,
  });

  return json({ ok: true, clearedFromRota: cleared, offClock: !onClock });
}

/**
 * Remove somebody.
 *
 * Refused once they have any history, because deleting them would take the
 * history with it — including months a report has already been run on. Marking
 * them as having left is what is wanted in every real case; the delete is for
 * the row somebody created by mistake ten seconds ago.
 */
export async function deleteStaff(ctx, id) {
  const staffId = Number(id);
  const count = await ctx.db.prepare(
    'SELECT (SELECT COUNT(*) FROM att_punches WHERE staff_id = ?1) AS punches, '
    + '(SELECT COUNT(*) FROM att_days WHERE staff_id = ?1) AS days',
  ).bind(staffId).first();

  if (Number(count?.punches ?? 0) || Number(count?.days ?? 0)) {
    throw badRequest(
      'This person has attendance history, which deleting them would destroy. '
      + 'Set a leaving date instead — they drop off the rota and today\'s lists, and their records stay.',
    );
  }

  await ctx.db.prepare('DELETE FROM att_staff WHERE id = ?').bind(staffId).run();
  await audit(ctx, 'attendance.staff_delete', staffId, null);
  return json({ ok: true });
}

/**
 * Employee numbers the terminal has sent that nobody here recognises.
 *
 * The single most useful diagnostic in the whole feature. Somebody enrolled on
 * the device and never added here is invisible in every report, and this is
 * what makes them visible.
 */
export async function unknownEmployees(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT employee_no, COUNT(*) AS punches, MIN(day) AS first_seen, MAX(day) AS last_seen
     FROM att_punches WHERE staff_id IS NULL
     GROUP BY employee_no ORDER BY last_seen DESC LIMIT 100`,
  ).all();
  return json({ unknown: rows.results ?? [] });
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export async function listShifts(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM att_days   d WHERE d.shift_id = s.id) AS used_days,
            (SELECT COUNT(*) FROM att_roster r WHERE r.shift_id = s.id) AS used_rota
       FROM att_shifts s ORDER BY s.sort_order, s.name`,
  ).all();

  // Retired ones come back too — the setup screen is where somebody brings one
  // back, and it cannot offer what it cannot see. Every other screen filters
  // on `active`, and now has a straight answer on whether Delete is even
  // possible rather than having to find out by pressing it.
  const shifts = (rows.results ?? []).map((s) => ({
    ...s, deletable: !s.used_days && !s.used_rota,
  }));

  // Who a shift can be given to outright. Only people still on the rota: a
  // shift belonging to somebody who has left is a shift nobody can work.
  const staff = await ctx.db.prepare(
    'SELECT id, name, department FROM att_staff WHERE active = 1 AND on_rota = 1 ORDER BY name',
  ).all().catch(() => ({ results: [] }));

  return json({
    shifts,
    staff: staff.results ?? [],
    departments: await departmentOptions(ctx.db),
    // Every position already in use, so the picker offers what exists before
    // asking anybody to type it again. Two spellings of one job is exactly
    // what a free-text field invites and exactly what this feature is for.
    positions: [...new Set(shifts.map((s) => s.position).filter(Boolean))].sort(),
  });
}

/**
 * Put a handful of shifts under one position.
 *
 * The direct answer to what this is for. Three breakfast shifts that differ
 * only in when they finish get grouped in one action, rather than by opening
 * each of them and typing the same word.
 *
 * Clearing is the same action with an empty name, so a grouping made in error
 * is undone the way it was made.
 */
export async function groupShifts(ctx) {
  const body = await readJson(ctx.request);
  const ids = [...new Set((Array.isArray(body.shiftIds) ? body.shiftIds : [])
    .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw badRequest('Tick at least one shift.');

  const position = str(body.position, 'Position', { max: 80 }) || null;

  await ctx.db.batch(ids.map((id) => ctx.db.prepare(
    'UPDATE att_shifts SET position = ?2 WHERE id = ?1',
  ).bind(id, position)));

  await audit(ctx, 'attendance.shift_position', null, { shifts: ids.length, position });
  return json({ ok: true, changed: ids.length, position });
}

function shiftFields(body) {
  const starts = readTime(body.startsAt, 'Start time');
  const ends = readTime(body.endsAt, 'End time');
  if (starts === ends) throw badRequest('A shift cannot start and end at the same time.');

  return [
    str(body.name, 'Name', { required: true, max: 60 }),
    starts,
    ends,
    int(body.breakMinutes ?? 0, 'Break', { min: 0, max: 480 }),
    int(body.graceIn ?? 5, 'Grace before late', { min: 0, max: 120 }),
    int(body.graceOut ?? 5, 'Grace before early', { min: 0, max: 120 }),
    int(body.halfDayMinutes ?? 240, 'Half day', { min: 0, max: 1440 }),
    int(body.fullDayMinutes ?? 420, 'Full day', { min: 0, max: 1440 }),
    int(body.overtimeAfter ?? 0, 'Overtime after', { min: 0, max: 480 }),
    str(body.colour, 'Colour', { max: 20 }),
    int(body.sortOrder ?? 100, 'Order', { min: 0, max: 9999 }),
    bool(body.active, true) ? 1 : 0,
    str(body.department, 'Department', { max: 80 }),
    // The job, as against the hours. Several shifts may name the same one, and
    // the rota's position view groups by it. Blank means the shift is its own
    // position, which is the truth for most of them.
    str(body.position, 'Position', { max: 80 }),
    // How many people this shift wants on a normal day. Left blank the
    // suggester reads the last few weeks and copies whatever the rota has
    // usually done, which is right until the day a new shift has no history
    // and quietly gets nobody.
    body.needed == null || body.needed === ''
      ? null
      : int(body.needed, 'People needed', { min: 0, max: 99 }),
    // The weekdays it runs, Monday as 0. A full week is stored as nothing,
    // because "every day" is what nothing already meant and two ways of
    // saying it is two things to keep in step.
    readRunsOn(body.runsOn),
    // Shifts sharing this name are alternatives: one of them runs on a day.
    str(body.altGroup, 'Alternatives group', { max: 60 }),
    body.altScope === 'week' ? 'week' : 'day',
    // And shifts sharing this one run together: a service cut in two is two
    // shifts and one decision. The opposite arrangement to the group above,
    // and deliberately usable alongside it — a pair sits in an alternates
    // group against the single shift that replaces it.
    str(body.pairGroup, 'Runs-together group', { max: 60 }),
    // Worth running when somebody is spare, not worth pulling anybody off
    // anything for.
    bool(body.optional, false) ? 1 : 0,
    // Whose shift it is, first choice first, where it belongs to named
    // people rather than to a department.
    readOnlyStaff(body.onlyStaff ?? body.onlyStaffId),
    // Days from one running of it to the next. Two is every other day, and
    // one is the ordinary case, stored as nothing.
    body.everyDays == null || body.everyDays === '' || Number(body.everyDays) <= 1
      ? null
      : int(body.everyDays, 'Days in between', { min: 2, max: 30 }),
  ];
}

/** The people a shift belongs to, in the order they should be asked. */
function readOnlyStaff(value) {
  if (value == null || value === '') return null;
  const list = (Array.isArray(value) ? value : [value])
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  // Order matters, so this keeps the first mention of a name rather than
  // sorting or taking the last.
  const seen = [];
  for (const id of list) if (!seen.includes(id)) seen.push(id);
  if (seen.length > 10) throw badRequest('That is more people than a shift needs named.');
  return seen.length ? JSON.stringify(seen) : null;
}

/** The weekdays a shift runs, as they arrive from a form. */
function readRunsOn(value) {
  if (value == null) return null;
  const list = (Array.isArray(value) ? value : [value])
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const unique = [...new Set(list)].sort((a, b) => a - b);
  if (!unique.length || unique.length === 7) return null;
  return JSON.stringify(unique);
}

export async function createShift(ctx) {
  const body = await readJson(ctx.request);
  let row;
  try {
    row = await ctx.db.prepare(
      `INSERT INTO att_shifts (name, starts_at, ends_at, break_minutes, grace_in_minutes,
                               grace_out_minutes, half_day_minutes, full_day_minutes,
                               overtime_after, colour, sort_order, active, department,
                               position, needed, runs_on, alt_group, alt_scope, pair_group,
                               optional, only_staff, every_days)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)
       RETURNING id`,
    ).bind(...shiftFields(body)).first();
  } catch (err) {
    rethrowConstraint(err, { unique: 'A shift with that name already exists.' });
  }
  await audit(ctx, 'attendance.shift_create', row.id, { name: body.name });
  return json({ ok: true, id: row.id });
}

/**
 * Change a shift.
 *
 * Editing the times rewrites history: every day already computed against this
 * shift is recomputed, and somebody who was on time last Tuesday may be late
 * afterwards. That is the correct behaviour — the alternative is a report that
 * disagrees with the rules — but it is worth knowing, so the count of days
 * touched comes back with the response.
 */
export async function updateShift(ctx, id) {
  const shiftId = Number(id);
  const body = await readJson(ctx.request);
  const existing = await ctx.db.prepare('SELECT * FROM att_shifts WHERE id = ?').bind(shiftId).first();
  if (!existing) throw notFound('No such shift.');

  try {
    await ctx.db.prepare(
      `UPDATE att_shifts SET name=?1, starts_at=?2, ends_at=?3, break_minutes=?4,
                             grace_in_minutes=?5, grace_out_minutes=?6, half_day_minutes=?7,
                             full_day_minutes=?8, overtime_after=?9, colour=?10,
                             sort_order=?11, active=?12, department=?13, position=?14,
                             needed=?15, runs_on=?16, alt_group=?17, alt_scope=?18,
                             pair_group=?19, optional=?20, only_staff=?21, every_days=?22
       WHERE id = ?23`,
    ).bind(...shiftFields(body), shiftId).run();
  } catch (err) {
    rethrowConstraint(err, { unique: 'A shift with that name already exists.' });
  }

  const changedTimes = existing.starts_at !== body.startsAt || existing.ends_at !== body.endsAt
    || existing.break_minutes !== Number(body.breakMinutes ?? 0);

  let touched = { days: 0 };
  if (changedTimes) {
    const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first())?.value || 'UTC';
    const today = todayIn(timezone);
    touched = await recompute(ctx.db, { from: addDays(today, -60), to: today });
  }

  await audit(ctx, 'attendance.shift_update', shiftId, { name: body.name, recomputed: touched.days });
  return json({ ok: true, recomputed: touched.days });
}

/**
 * Delete a shift, but only one nothing has ever used.
 *
 * A shift is not a row in a table, it is what "late" was measured against on
 * every day anybody ever worked it. Delete it and every one of those days is
 * left pointing at nothing: the hours stay, the verdicts stay, and the thing
 * that produced them is gone. Nobody can then answer "late compared to what?",
 * which is the only question that matters when somebody disputes a deduction.
 *
 * So a shift with any history behind it, or any rota in front of it, can only
 * be retired. Retiring takes it off every list a person picks from and leaves
 * every record that mentions it exactly as it was.
 */
export async function deleteShift(ctx, id) {
  const shiftId = Number(id);
  // Slots nobody is on are not counted. They exist because the shift does, so
  // deleting the shift is exactly the thing that is allowed to take them, and
  // the foreign key does it. What stops a delete is a person rostered on it.
  const used = await ctx.db.prepare(
    'SELECT (SELECT COUNT(*) FROM att_roster WHERE shift_id = ?1 AND staff_id IS NOT NULL) AS rota, '
    + '(SELECT COUNT(*) FROM att_days WHERE shift_id = ?1) AS days, '
    + '(SELECT COUNT(*) FROM att_patterns WHERE shift_id = ?1) AS patterns',
  ).bind(shiftId).first().catch(() => null);

  const days = Number(used?.days ?? 0);
  const rota = Number(used?.rota ?? 0);
  const patterns = Number(used?.patterns ?? 0);

  if (days || rota || patterns) {
    const what = [
      days ? `${days} day${days === 1 ? '' : 's'} already recorded against it` : null,
      rota ? `${rota} rostered day${rota === 1 ? '' : 's'}` : null,
      patterns ? `${patterns} standing pattern${patterns === 1 ? '' : 's'}` : null,
    ].filter(Boolean);

    throw badRequest(
      `This shift has ${what.join(', ')}. Deleting it would leave every one of them pointing at `
      + 'nothing — the hours would stay and what they were measured against would be gone. '
      + 'Retire it instead: it comes off every list anybody picks from, and every record that '
      + 'mentions it keeps its meaning.',
      { retireInstead: true },
    );
  }

  await ctx.db.prepare('DELETE FROM att_shifts WHERE id = ?').bind(shiftId).run();
  await audit(ctx, 'attendance.shift_delete', shiftId, null);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// What absences mean
// ---------------------------------------------------------------------------

export async function listReasons(ctx) {
  const rows = await ctx.db.prepare('SELECT * FROM att_reasons ORDER BY sort_order, label').all();
  return json({ reasons: rows.results ?? [] });
}

const KINDS = ['worked', 'leave', 'absent', 'holiday', 'rest', 'incomplete'];
const COLOURS = ['green', 'amber', 'red', 'grey'];

function reasonFields(body, { code = null } = {}) {
  const kind = str(body.kind, 'Kind', { required: true, max: 20 });
  if (!KINDS.includes(kind)) throw badRequest(`Kind must be one of: ${KINDS.join(', ')}.`);
  const colour = str(body.colour, 'Colour', { max: 20, fallback: 'grey' });
  if (!COLOURS.includes(colour)) throw badRequest(`Colour must be one of: ${COLOURS.join(', ')}.`);

  return {
    code: code ?? str(body.code, 'Code', { required: true, max: 40 }).toLowerCase().replace(/[^a-z0-9_]/g, '_'),
    label: str(body.label, 'Label', { required: true, max: 80 }),
    kind,
    paid: bool(body.paid, false) ? 1 : 0,
    counts_as_worked: bool(body.countsAsWorked, false) ? 1 : 0,
    deducts_leave: bool(body.deductsLeave, false) ? 1 : 0,
    selectable: bool(body.selectable, true) ? 1 : 0,
    // Whether a member of staff may ask for it themselves. A different
    // question from `selectable`, which is whether a supervisor may charge a
    // day to it afterwards, and only ever asked of a kind of leave.
    staff_pick: bool(body.staffPick, true) ? 1 : 0,
    requires_note: bool(body.requiresNote, false) ? 1 : 0,
    colour,
    sort_order: int(body.sortOrder ?? 100, 'Order', { min: 0, max: 9999 }),
    active: bool(body.active, true) ? 1 : 0,
  };
}

export async function createReason(ctx) {
  const body = await readJson(ctx.request);
  const f = reasonFields(body);
  try {
    await ctx.db.prepare(
      `INSERT INTO att_reasons (code, label, kind, paid, counts_as_worked, deducts_leave,
                                selectable, requires_note, colour, sort_order, system, active,
                                staff_pick)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11,?12)`,
    ).bind(
      f.code, f.label, f.kind, f.paid, f.counts_as_worked, f.deducts_leave,
      f.selectable, f.requires_note, f.colour, f.sort_order, f.active, f.staff_pick,
    ).run();
  } catch (err) {
    rethrowConstraint(err, { unique: `There is already a reason with the code "${f.code}".` });
  }
  await audit(ctx, 'attendance.reason_create', f.code, f);
  return json({ ok: true, code: f.code });
}

/**
 * Change what a kind of day costs.
 *
 * This is the endpoint behind "update what each absent should mean". Changing
 * whether a reason is paid, counts as worked, or comes off the leave balance
 * changes every report that has ever used it — which is the point, and is why
 * the change is written to the audit log with the old values beside the new.
 *
 * The built-in codes can be relabelled and re-costed but not renamed or
 * deleted: something in the status machine points at each of them by name.
 */
export async function updateReason(ctx, code) {
  const existing = await ctx.db.prepare('SELECT * FROM att_reasons WHERE code = ?').bind(code).first();
  if (!existing) throw notFound('No such reason.');

  const body = await readJson(ctx.request);
  const f = reasonFields(body, { code: existing.code });

  if (existing.system && f.kind !== existing.kind) {
    throw badRequest(
      `"${existing.label}" is one the system decides for itself, so its kind cannot change. `
      + 'Its label, colour and what it costs can all be changed.',
    );
  }

  await ctx.db.prepare(
    `UPDATE att_reasons SET label=?1, kind=?2, paid=?3, counts_as_worked=?4, deducts_leave=?5,
                            selectable=?6, requires_note=?7, colour=?8, sort_order=?9, active=?10,
                            staff_pick=?12
     WHERE code = ?11`,
  ).bind(
    f.label, f.kind, f.paid, f.counts_as_worked, f.deducts_leave,
    f.selectable, f.requires_note, f.colour, f.sort_order,
    // A built-in cannot be switched off — the status machine would have nothing
    // to charge a day to.
    existing.system ? 1 : f.active,
    existing.code,
    f.staff_pick,
  ).run();

  await audit(ctx, 'attendance.reason_update', existing.code, {
    before: {
      paid: existing.paid, counts_as_worked: existing.counts_as_worked, deducts_leave: existing.deducts_leave,
    },
    after: { paid: f.paid, counts_as_worked: f.counts_as_worked, deducts_leave: f.deducts_leave },
    staffPick: f.staff_pick !== existing.staff_pick ? f.staff_pick : undefined,
  });

  return json({ ok: true });
}

export async function deleteReason(ctx, code) {
  const existing = await ctx.db.prepare('SELECT * FROM att_reasons WHERE code = ?').bind(code).first();
  if (!existing) throw notFound('No such reason.');
  if (existing.system) {
    throw badRequest(`"${existing.label}" is built in and cannot be deleted. It can be relabelled.`);
  }

  const used = await ctx.db.prepare(
    'SELECT (SELECT COUNT(*) FROM att_days WHERE reason_code = ?1) AS days, '
    + '(SELECT COUNT(*) FROM att_leave WHERE reason_code = ?1) AS leave',
  ).bind(code).first();

  if (Number(used?.days ?? 0) || Number(used?.leave ?? 0)) {
    throw badRequest('Days have been recorded against this reason. Switch it off instead of deleting it.');
  }

  await ctx.db.prepare('DELETE FROM att_reasons WHERE code = ?').bind(code).run();
  await audit(ctx, 'attendance.reason_delete', code, null);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Public holidays
// ---------------------------------------------------------------------------

export async function listHolidays(ctx) {
  const year = ctx.url.searchParams.get('year');
  const rows = year
    ? await ctx.db.prepare('SELECT * FROM att_holidays WHERE day LIKE ? ORDER BY day')
      .bind(`${year}-%`).all()
    : await ctx.db.prepare('SELECT * FROM att_holidays ORDER BY day DESC LIMIT 200').all();
  return json({ holidays: rows.results ?? [] });
}

export async function createHoliday(ctx) {
  const body = await readJson(ctx.request);
  const day = readDayOrNull(body.day, 'Date');
  if (!day) throw badRequest('A date is required.');

  try {
    await ctx.db.prepare(
      'INSERT INTO att_holidays (day, name, observed_on, paid) VALUES (?1, ?2, ?3, ?4)',
    ).bind(
      day,
      str(body.name, 'Name', { required: true, max: 120 }),
      readDayOrNull(body.observedOn, 'Observed on'),
      bool(body.paid, true) ? 1 : 0,
    ).run();
  } catch (err) {
    rethrowConstraint(err, { unique: 'There is already a holiday on that date.' });
  }

  await recompute(ctx.db, { from: day, to: body.observedOn || day });
  await audit(ctx, 'attendance.holiday_create', day, { name: body.name });
  return json({ ok: true });
}

/**
 * Fill in a year's public holidays in one go.
 *
 * Everything Ghana's calendar can calculate: the fixed dates, Good Friday and
 * Easter Monday from the computus, Farmers' Day as the first Friday in
 * December, and the weekend-to-Monday rule applied across the lot.
 *
 * The two Eids are not generated. They follow the lunar calendar and are
 * confirmed locally a few days ahead, and a computed guess that lands in a
 * payroll is worse than a blank somebody has to fill in.
 */
export async function generateHolidays(ctx) {
  const body = await readJson(ctx.request);
  const year = int(body.year, 'Year', { required: true, min: 2000, max: 2100 });

  const statements = ghanaHolidays(year).map((holiday) => ctx.db.prepare(
    `INSERT INTO att_holidays (day, name, observed_on, paid) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT (day) DO NOTHING`,
  ).bind(holiday.day, holiday.name, holiday.observed_on));

  await ctx.db.batch(statements);
  await recompute(ctx.db, { from: `${year}-01-01`, to: `${year}-12-31` });
  await audit(ctx, 'attendance.holidays_generate', year, { added: statements.length });

  return json({
    ok: true,
    added: statements.length,
    missing: ['Eid al-Fitr', 'Eid al-Adha'],
  });
}

export async function deleteHoliday(ctx, id) {
  const row = await ctx.db.prepare('SELECT * FROM att_holidays WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('No such holiday.');

  await ctx.db.prepare('DELETE FROM att_holidays WHERE id = ?').bind(row.id).run();
  await recompute(ctx.db, { from: row.day, to: row.observed_on || row.day });
  await audit(ctx, 'attendance.holiday_delete', row.day, null);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

export async function listDevices(ctx) {
  const [rows, setting] = await Promise.all([
    ctx.db.prepare(
      `SELECT d.id, d.serial, d.name, d.location, d.model, d.mode, d.last_seen_at, d.last_event_at,
              d.active, d.note, d.clock_offset_seconds, d.clock_checked_at,
              d.token_hash IS NOT NULL AS has_token,
              (SELECT COUNT(*) FROM att_punches p WHERE p.device_serial = d.serial) AS punches
       FROM att_devices d ORDER BY d.name`,
    ).all(),
    ctx.db.prepare("SELECT value FROM settings WHERE key = 'att_clock_drift_seconds'")
      .first().catch(() => null),
  ]);

  return json({
    devices: (rows.results ?? []).map((d) => ({ ...d, has_token: Boolean(d.has_token) })),
    // Sent rather than repeated in the screen, so "how wrong is too wrong" has
    // one home and the Terminals screen cannot disagree with the morning one.
    clockThresholdSeconds: Math.max(30, Number(setting?.value) || 180),
  });
}

/**
 * Where this app can be reached from outside.
 *
 * Preferred from the setting, because that is the address somebody chose; the
 * request's own origin is the fallback, which is right often enough that a
 * property who never filled the setting in still gets a working URL rather than
 * a placeholder they would have to notice and correct.
 */

/** A token the poller will carry. Shown once, stored only as a hash. */
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createDevice(ctx) {
  const body = await readJson(ctx.request);
  const serial = str(body.serial, 'Serial number', { required: true, max: 120 });
  const mode = body.mode === 'poll' ? 'poll' : 'push';
  const token = newToken();
  const pepper = await getPepper(ctx.db);

  let row;
  try {
    row = await ctx.db.prepare(
      `INSERT INTO att_devices (serial, name, location, model, mode, token_hash, note)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
    ).bind(
      serial,
      str(body.name, 'Name', { required: true, max: 80 }),
      str(body.location, 'Location', { max: 120 }),
      str(body.model, 'Model', { max: 80 }),
      mode,
      await hashDeviceToken(token, pepper),
      str(body.note, 'Note', { max: 300 }),
    ).first();
  } catch (err) {
    rethrowConstraint(err, { unique: 'A terminal with that serial number is already registered.' });
  }

  await audit(ctx, 'attendance.device_create', row.id, { serial, mode });
  // The only time this token is ever readable. Returned with the settings it
  // has to be typed into, so nobody has to assemble a URL by hand.
  return json({
    ok: true,
    id: row.id,
    serial,
    token,
    mode,
    listening: listeningHostSettings({ siteUrl: await siteOrigin(ctx.db, ctx.url.origin), token }),
  });
}

export async function rotateToken(ctx, id) {
  const deviceId = Number(id);
  const device = await ctx.db.prepare('SELECT * FROM att_devices WHERE id = ?').bind(deviceId).first();
  if (!device) throw notFound('No such terminal.');

  const token = newToken();
  await ctx.db.prepare('UPDATE att_devices SET token_hash = ? WHERE id = ?')
    .bind(await hashDeviceToken(token, await getPepper(ctx.db)), deviceId).run();

  await audit(ctx, 'attendance.device_token', deviceId, { serial: device.serial });
  return json({
    ok: true,
    serial: device.serial,
    token,
    mode: device.mode,
    listening: listeningHostSettings({ siteUrl: await siteOrigin(ctx.db, ctx.url.origin), token }),
  });
}

export async function updateDevice(ctx, id) {
  const deviceId = Number(id);
  const body = await readJson(ctx.request);
  const device = await ctx.db.prepare('SELECT * FROM att_devices WHERE id = ?').bind(deviceId).first();
  if (!device) throw notFound('No such terminal.');

  await ctx.db.prepare(
    `UPDATE att_devices SET name = ?1, location = ?2, model = ?3, mode = ?4,
                            active = ?5, note = ?6 WHERE id = ?7`,
  ).bind(
    str(body.name, 'Name', { required: true, max: 80 }),
    str(body.location, 'Location', { max: 120 }),
    str(body.model, 'Model', { max: 80 }),
    body.mode === 'poll' ? 'poll' : 'push',
    bool(body.active, true) ? 1 : 0,
    str(body.note, 'Note', { max: 300 }),
    deviceId,
  ).run();

  await audit(ctx, 'attendance.device_update', deviceId, null);
  return json({ ok: true });
}

export async function deleteDevice(ctx, id) {
  const deviceId = Number(id);
  const device = await ctx.db.prepare('SELECT * FROM att_devices WHERE id = ?').bind(deviceId).first();
  if (!device) throw notFound('No such terminal.');

  const count = await ctx.db.prepare('SELECT COUNT(*) AS n FROM att_punches WHERE device_serial = ?')
    .bind(device.serial).first();
  if (Number(count?.n ?? 0)) {
    throw badRequest(
      'This terminal has punches recorded against it, which are the record of who was at work. '
      + 'Switch it off instead — it stops accepting new punches and the history stays.',
    );
  }

  await ctx.db.prepare('DELETE FROM att_devices WHERE id = ?').bind(deviceId).run();
  await audit(ctx, 'attendance.device_delete', deviceId, { serial: device.serial });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * The settings that may be emptied as well as filled in.
 *
 * Everywhere else a blank field means the form did not carry that setting, and
 * saving one screen would wipe another. These are optional particulars on one
 * screen, and there has to be a way to take one back off a payslip.
 */
const CLEARABLE = new Set([
  'property_address', 'company_legal_name', 'company_phone', 'company_email',
  'company_website', 'company_tin', 'company_ssnit',
]);

const SETTINGS = new Map([
  ['att_missing_punch', (v) => {
    if (!['incomplete', 'absent', 'auto_close'].includes(v)) {
      throw badRequest('Missing-punch handling must be: incomplete, absent or auto_close.');
    }
    return v;
  }],
  ['att_leave_days', (v) => String(num(v, 'Annual leave days', { min: 0, max: 365 }))],
  // What a working week comes to, for everybody who has no figure of their
  // own. It sets what the over-or-under is measured against, so it is the one
  // setting on this screen that changes a number somebody may argue about.
  ['att_days_per_week', (v) => String(num(v, 'Days a week', { min: 0.5, max: 7 }))],
  ['att_leave_qualify_months', (v) => String(int(v, 'Qualifying months', { min: 0, max: 60 }))],
  ['att_leave_carryover_days', (v) => String(num(v, 'Carry-over days', { min: 0, max: 365 }))],
  ['att_leave_year_starts', (v) => {
    if (!/^\d{2}-\d{2}$/.test(String(v))) throw badRequest('The leave year must start on a date like 01-01.');
    return String(v);
  }],
  ['att_min_gap_minutes', (v) => String(int(v, 'Minimum gap', { min: 0, max: 120 }))],
  ['att_window_before', (v) => String(int(v, 'Window before', { min: 0, max: 720 }))],
  ['att_window_after', (v) => String(int(v, 'Window after', { min: 0, max: 720 }))],
  ['att_escalate_after', (v) => String(int(v, 'Escalate after', { min: 1, max: 30 }))],
  ['att_departments', (v) => cleanDepartments(v).join('\n')],
  // Who this property is, in its own words. Both go on every contract issued
  // and on the top of every printed report, so they belong on a screen rather
  // than in whatever the first migration happened to seed.
  ['property_name', (v) => str(v, 'Property name', { required: true, max: 120 })],
  ['property_address', (v) => str(v, 'Property address', { max: 300 })],

  // The rest of what a payslip has to carry. The trading name above is what
  // everybody calls the place; the registered name is what is on the
  // certificate, and the two are often not the same. Both numbers are quoted
  // back at the property by whoever is checking a deduction, so a slip that
  // does not carry them sends people to the office to ask.
  ['company_legal_name', (v) => str(v, 'Registered name', { max: 160, fallback: '' })],
  ['company_phone', (v) => str(v, 'Telephone', { max: 60, fallback: '' })],
  ['company_email', (v) => str(v, 'Email', { max: 120, fallback: '' })],
  ['company_website', (v) => str(v, 'Website', { max: 120, fallback: '' })],
  ['company_tin', (v) => str(v, 'TIN', { max: 40, fallback: '' })],
  ['company_ssnit', (v) => str(v, 'SSNIT employer number', { max: 40, fallback: '' })],
  ['hr_link_days', (v) => String(int(v, 'How long a link lasts', { min: 1, max: 90 }))],

  // Whether a member of staff sees how much leave they have left on their own
  // screen. Their own figure, so there is no confidentiality argument either
  // way — but a balance in front of somebody is a balance they will ask about,
  // and a property whose figures are still being tidied up after an import may
  // reasonably want to settle them before publishing them to twenty-four
  // people. Shown unless somebody turns it off.
  ['att_show_balance', (v) => (v === '0' || v === 'false' ? '0' : '1')],

  // Whether the app tells somebody their shift has started and nothing has
  // been recorded against it.
  ['att_late_nudge', (v) => (v === '0' || v === 'false' ? '0' : '1')],
  ['att_clockout_nudge', (v) => (v === '0' || v === 'false' ? '0' : '1')],

  // Whether somebody's own phone tells them their clock-in and clock-out
  // landed, and at what time. To them and nobody else.
  ['att_clock_push', (v) => (v === '0' || v === 'false' ? '0' : '1')],

  // Birthdays. The wording is the point of these being here: it is the one
  // message this app sends that is not about hours or money, and it should
  // sound like the property rather than like a system.
  ['att_bd_wish', (v) => (v === '0' || v === 'false' ? '0' : '1')],
  ['att_bd_push', (v) => (v === '0' || v === 'false' ? '0' : '1')],
  ['att_bd_prompt', (v) => (v === '0' || v === 'false' ? '0' : '1')],
  ['att_bd_title', (v) => str(v, 'What the birthday message is headed', { max: 120 })],
  ['att_bd_line', (v) => str(v, 'What the birthday message says', { max: 300 })],
  ['att_bd_prompt_body', (v) => str(v, 'What the prompt says', { max: 300 })],
  ['att_bd_ahead', (v) => String(int(v, 'How far ahead to look', { min: 0, max: 365 }))],

  // Whether a public holiday counts towards what a member of staff reads on
  // their own monthly report. A property that pays for them wants them in the
  // figure; one that treats them as ordinary rest days does not, and a day
  // that shows in one place and not another is a question somebody has to
  // answer twice a month.
  ['att_report_holidays', (v) => (v === '0' || v === 'false' ? '0' : '1')],

  // What this property considers a sustainable rota. The first four are
  // Act 651 and are seeded at the statutory figure; a property may tighten
  // them, and the app cites the section wherever it reports one. The rest are
  // this trade's rules of thumb and genuinely arguable.
  //
  // Nothing here blocks a rota. A hotel has nights when somebody simply has to
  // cover, and an app that refuses to record what happened gets worked around
  // on paper.
  ['wl_dailyRestHours', (v) => String(num(v, 'Rest between shifts', { min: 1, max: 24 }))],
  ['wl_weeklyRestHours', (v) => String(num(v, 'Unbroken rest each week', { min: 1, max: 96 }))],
  ['wl_weeklyHours', (v) => String(num(v, 'Hours in a week', { min: 1, max: 90 }))],
  ['wl_dailyHours', (v) => String(num(v, 'Hours in a day', { min: 1, max: 24 }))],
  ['wl_consecutiveDays', (v) => String(int(v, 'Days in a row', { min: 1, max: 30 }))],
  ['wl_nightsPerFortnight', (v) => String(int(v, 'Nights in a fortnight', { min: 1, max: 14 }))],
  ['wl_flipsPerFortnight', (v) => String(int(v, 'Swaps between nights and days', { min: 1, max: 14 }))],
  ['wl_weekendsPerMonth', (v) => String(int(v, 'Weekends in a month', { min: 1, max: 5 }))],
  // Zero here means the property does not count Sundays, which is a real
  // answer rather than an empty box.
  ['wl_sundaysOffPerMonth', (v) => String(int(v, 'Sundays off in a month', { min: 0, max: 5 }))],

  // The tax figures. Data rather than code, because they change with the
  // budget and an app whose tax table only a developer can change is an app
  // that is wrong for the first three months of every year.
  ['pay_ssnit_employee', (v) => String(num(v, 'Worker SSNIT', { min: 0, max: 0.5 }))],
  ['pay_ssnit_employer', (v) => String(num(v, 'Employer SSNIT', { min: 0, max: 0.5 }))],
  ['pay_bonus_rate', (v) => String(num(v, 'Bonus rate', { min: 0, max: 0.5 }))],
  ['pay_bonus_share', (v) => String(num(v, 'Share of basic at the bonus rate', { min: 0, max: 1 }))],
  ['pay_bands_label', (v) => str(v, 'What the bands are called', { max: 80 }) ?? ''],
  ['pay_bands', (v) => readBands(v)],
]);

/**
 * A band table, checked before it is stored.
 *
 * Everything else in this list is one number. This is the tax itself, and a
 * table somebody has half-typed would put a wrong figure on every payslip in
 * the property — so it is parsed, checked and refused rather than trusted.
 */
function readBands(value) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw badRequest('The tax bands are not readable. Each band needs a width and a rate.');
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw badRequest('There has to be at least one tax band.');
  }

  const bands = parsed.map((band, i) => {
    const rate = num(band.rate, `Band ${i + 1} rate`, { required: true, min: 0, max: 1 });
    const last = i === parsed.length - 1;
    // Only the last band runs to infinity. A width missing in the middle would
    // silently swallow every band under it.
    if (band.width == null || band.width === '') {
      if (!last) throw badRequest(`Band ${i + 1} needs a width. Only the last one can be open.`);
      return { width: null, rate };
    }
    return { width: num(band.width, `Band ${i + 1}`, { min: 0.01, max: 10_000_000 }), rate };
  });

  return JSON.stringify(bands);
}

/**
 * One department per line, tidied.
 *
 * Deduplicated without regard to case, because "Kitchen" and "kitchen" are the
 * thing this list exists to prevent — letting both into the list would defeat
 * the point of having one. The first spelling wins, so whoever typed it decides
 * how it is capitalised.
 */
export function cleanDepartments(value) {
  const seen = new Set();
  const out = [];

  for (const line of String(value ?? '').split(/[\n,]/)) {
    const name = line.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 60) break;
  }

  return out;
}

/**
 * Change the rules, then make the reports agree with them.
 *
 * Every one of these changes what a past day means, so the last sixty days are
 * recomputed and the number of days affected is reported back. Silently
 * changing three thousand records is not something a settings form should do
 * without saying so.
 */
export async function updateSettings(ctx) {
  const body = await readJson(ctx.request);
  const statements = [];
  const changed = [];

  for (const [key, validate] of SETTINGS) {
    const short = key.replace(/^att_/, '');
    const value = body[key] ?? body[short];
    // Blank usually means "not on this form", so it is skipped. For the
    // handful of particulars that are genuinely optional, blank means blank:
    // a property that types a website in and then stops having one has to be
    // able to take it off the payslip again.
    if (value === '' && CLEARABLE.has(key)) {
      statements.push(ctx.db.prepare(
        "INSERT INTO settings (key, value) VALUES (?1, '') ON CONFLICT(key) DO UPDATE SET value = ''",
      ).bind(key));
      changed.push(key);
      continue;
    }
    if (value == null || value === '') continue;
    statements.push(ctx.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2',
    ).bind(key, validate(String(value))));
    changed.push(key);
  }

  if (!statements.length) return json({ ok: true, changed: [], recomputed: 0 });
  await ctx.db.batch(statements);

  const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first())?.value || 'UTC';
  const today = todayIn(timezone);
  const result = await recompute(ctx.db, { from: addDays(today, -60), to: today });

  await audit(ctx, 'attendance.settings', null, { changed });
  return json({ ok: true, changed, recomputed: result.days });
}

/**
 * Rebuild the derived days for a period, by hand.
 *
 * Should never be necessary — everything that changes a verdict recomputes what
 * it touched. It exists for the case where something was necessary anyway, and
 * for the first run after importing a year of history.
 */
export async function recomputeRange(ctx) {
  const body = await readJson(ctx.request);
  const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first())?.value || 'UTC';
  const today = todayIn(timezone);
  const to = readDayOrNull(body.to, 'End date') ?? today;
  const from = readDayOrNull(body.from, 'Start date') ?? addDays(to, -30);
  if (from > to) throw badRequest('The start date is after the end date.');

  const result = await recompute(ctx.db, { from, to });
  await audit(ctx, 'attendance.recompute', null, { from, to, days: result.days });
  return json({ ok: true, from, to, ...result });
}

// ---------------------------------------------------------------------------
// The company logo
// ---------------------------------------------------------------------------

/** Rather more than a logo ever is, and small enough not to matter. */
const LOGO_LIMIT = 600_000;

/**
 * Put the property's mark on file.
 *
 * One image, one row, replaced rather than versioned. Nothing here needs a
 * history: a property changes its logo once a decade, and a payslip printed
 * last March is a piece of paper somebody already has.
 */
export async function setCompanyLogo(ctx) {
  const body = await readJson(ctx.request);

  const mime = str(body.mime, 'File type', { max: 80 }) || 'image/png';
  if (!mime.startsWith('image/')) {
    throw badRequest('A logo has to be a picture. A PNG with a transparent background '
      + 'sits best on a payslip.');
  }

  let bytes;
  try {
    bytes = fromBase64(body.content);
  } catch {
    throw badRequest('That picture did not arrive in one piece. Try again.');
  }
  if (!bytes.length) throw badRequest('There was nothing in that picture.');
  if (bytes.length > LOGO_LIMIT) {
    throw badRequest(`That picture is ${Math.round(bytes.length / 1000)} KB and the limit is `
      + `${Math.round(LOGO_LIMIT / 1000)} KB. Export it about 600 pixels across.`);
  }

  const stamp = new Date().toISOString();
  await ctx.db.batch([
    ctx.db.prepare(
      `INSERT INTO company_logo (id, mime, bytes, content, uploaded_by)
       VALUES (1, ?1, ?2, ?3, ?4)
       ON CONFLICT (id) DO UPDATE SET
         mime = ?1, bytes = ?2, content = ?3, uploaded_by = ?4,
         uploaded_at = datetime('now')`,
    ).bind(mime, bytes.length, bytes, `${ctx.session.user.name} (${ctx.session.user.role})`),
    // The stamp is what a browser holding yesterday's logo asks against.
    ctx.db.prepare(
      "INSERT INTO settings (key, value) VALUES ('company_logo_at', ?1) "
      + 'ON CONFLICT (key) DO UPDATE SET value = ?1',
    ).bind(stamp),
  ]);

  await audit(ctx, 'company.logo', null, { bytes: bytes.length, mime });
  return json({ ok: true, at: stamp, bytes: bytes.length });
}

/** Take it off again. Payslips fall back to the name alone. */
export async function removeCompanyLogo(ctx) {
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM company_logo WHERE id = 1'),
    ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('company_logo_at', '') "
      + "ON CONFLICT (key) DO UPDATE SET value = ''"),
  ]);
  await audit(ctx, 'company.logo_remove', null, {});
  return json({ ok: true });
}

/**
 * The picture itself.
 *
 * Readable by anybody signed in, because it heads a payslip and a report and
 * neither is worth a permission of its own. It is the mark the property prints
 * on paper that leaves the building.
 */
export async function companyLogo(ctx) {
  const row = await ctx.db.prepare('SELECT mime, content FROM company_logo WHERE id = 1')
    .first().catch(() => null);
  if (!row) throw notFound('No logo has been uploaded.');

  return new Response(asBytes(row.content), {
    headers: {
      'Content-Type': row.mime || 'image/png',
      // The address carries the stamp it was uploaded at, so a year is safe
      // and a new logo appears at once.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}

// ---------------------------------------------------------------------------
// The register, out of a spreadsheet
// ---------------------------------------------------------------------------

/** Who the property already knows, in the shape the reader wants them. */
async function registerNow(db) {
  const [staff, profiles, pay, allowances] = await Promise.all([
    db.prepare('SELECT * FROM att_staff').all(),
    db.prepare('SELECT staff_id, personal_phone, personal_email FROM hr_profile').all()
      .catch(() => ({ results: [] })),
    db.prepare('SELECT staff_id, basic, ssnit FROM pay_profile').all()
      .catch(() => ({ results: [] })),
    db.prepare('SELECT staff_id, name, amount, taxable FROM pay_allowance WHERE active = 1').all()
      .catch(() => ({ results: [] })),
  ]);

  const allowanceBy = new Map();
  for (const row of allowances.results ?? []) {
    if (!allowanceBy.has(row.staff_id)) allowanceBy.set(row.staff_id, []);
    allowanceBy.get(row.staff_id).push(row);
  }

  return {
    staff: staff.results ?? [],
    profiles: new Map((profiles.results ?? []).map((r) => [r.staff_id, r])),
    pay: new Map((pay.results ?? []).map((r) => [r.staff_id, r])),
    allowanceBy,
  };
}

/** What the file would do, said before anything is done. */
export async function readStaffImport(ctx) {
  const body = await readJson(ctx.request);
  const text = String(body.text ?? '');
  if (!text.trim()) throw badRequest('There is nothing in that file.');

  const read = readStaffSheet(text, await registerNow(ctx.db));
  return json({ ...read, tally: tallyOf(read) });
}

/**
 * And then do it.
 *
 * The file is read again here rather than trusting a list of changes posted
 * back from a screen. Somebody may have been added by hand between the preview
 * and the button, and the second read is the one that counts: it is what stops
 * the same person arriving twice under two numbers.
 */
export async function applyStaffImport(ctx) {
  const body = await readJson(ctx.request);
  const text = String(body.text ?? '');
  if (!text.trim()) throw badRequest('There is nothing in that file.');

  const read = readStaffSheet(text, await registerNow(ctx.db));
  if (read.missingColumns.length) {
    throw badRequest(`The sheet needs ${read.missingColumns.join(' and ')}.`);
  }

  const actor = `${ctx.session.user.name} (${ctx.session.user.role})`;
  let added = 0;
  let changed = 0;
  const failed = [];

  for (const line of read.lines) {
    // Allowances are a list, one per column, so they cannot share the map the
    // single-value columns use: keyed on kind, a second Transport column would
    // overwrite the first.
    const allowanceChanges = line.changes.filter((c) => c.kind === 'allowance');
    const set = new Map(line.changes
      .filter((c) => c.kind !== 'allowance')
      .map((c) => [c.kind, c.value]));

    // The three fields that are one decision between them. A sheet saying
    // payroll only must not leave somebody on the rota, and a sheet saying
    // nothing must not quietly move anybody.
    const tracking = set.get('tracking') ?? null;
    const flags = tracking === 'payroll' ? { onClock: 0, onRota: 0 }
      : tracking === 'no-rota' ? { onClock: 1, onRota: 0 }
        : tracking === 'full' ? { onClock: 1, onRota: 1 }
          : null;

    try {
      let staffId = line.staffId;

      if (line.adding) {
        const row = await ctx.db.prepare(
          `INSERT INTO att_staff (employee_no, name, department, job_title, hired_on, left_on,
                                  leave_days, days_per_week, note, on_rota, on_clock)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING id`,
        ).bind(
          line.employeeNo,
          set.get('name') ?? line.name,
          set.get('department') ?? null,
          set.get('jobTitle') ?? null,
          set.get('hiredOn') ?? null,
          set.get('leftOn') ?? null,
          set.get('leaveDays') ?? null,
          set.get('daysPerWeek') ?? null,
          set.get('note') ?? null,
          flags ? flags.onRota : 1,
          flags ? flags.onClock : 1,
        ).first();
        staffId = row.id;
        added += 1;

        // Punches already held under that number are theirs, the same as when
        // somebody is added by hand — unless they are only ever to be paid, in
        // which case the number belongs to whoever really holds that card.
        if (!flags || flags.onClock) {
          const claimed = await claimOrphans(ctx.db, staffId, line.employeeNo);
          if (claimed.claimed) {
            await recompute(ctx.db, {
              staffIds: [staffId], from: claimed.from, to: claimed.to,
            });
          }
        }
      } else {
        const fields = [];
        const binds = [];
        const put = (column, value) => {
          binds.push(value);
          fields.push(`${column} = ?${binds.length}`);
        };

        if (set.has('name')) put('name', set.get('name'));
        if (set.has('department')) put('department', set.get('department'));
        if (set.has('jobTitle')) put('job_title', set.get('jobTitle'));
        if (set.has('hiredOn')) put('hired_on', set.get('hiredOn'));
        if (set.has('leftOn')) put('left_on', set.get('leftOn'));
        if (set.has('leaveDays')) put('leave_days', set.get('leaveDays'));
        if (set.has('daysPerWeek')) put('days_per_week', set.get('daysPerWeek'));
        if (set.has('note')) put('note', set.get('note'));
        if (flags) {
          put('on_rota', flags.onRota);
          put('on_clock', flags.onClock);
        }

        if (fields.length) {
          binds.push(staffId);
          await ctx.db.prepare(
            `UPDATE att_staff SET ${fields.join(', ')} WHERE id = ?${binds.length}`,
          ).bind(...binds).run();
        }

        // Counted per person, not per table. A sheet that only moved somebody's
        // salary and allowances touched no column on their record, and the
        // screen said "1 added" about a run that changed three figures.
        if (line.changes.length) changed += 1;

        // Off the rota is off it properly, the same as the staff form does it:
        // what they were down for from today onwards goes, or the grid keeps
        // showing somebody the sheet just took off it.
        if (flags && !flags.onRota) {
          const timezone = (await ctx.db.prepare(
            "SELECT value FROM settings WHERE key = 'timezone'",
          ).first())?.value || 'UTC';
          const today = todayIn(timezone);
          await ctx.db.prepare(
            'DELETE FROM att_roster WHERE staff_id = ?1 AND day >= ?2',
          ).bind(staffId, today).run().catch(() => {});
          await ctx.db.prepare('DELETE FROM att_patterns WHERE staff_id = ?')
            .bind(staffId).run().catch(() => {});
        }
      }

      // The two contact details, which live beside the record rather than in
      // it. Written one column at a time so a sheet with only phone numbers on
      // it cannot wipe an email address.
      if (set.has('phone') || set.has('email')) {
        await ctx.db.prepare(
          'INSERT OR IGNORE INTO hr_profile (staff_id) VALUES (?)',
        ).bind(staffId).run().catch(() => {});
        if (set.has('phone')) {
          await ctx.db.prepare('UPDATE hr_profile SET personal_phone = ?2 WHERE staff_id = ?1')
            .bind(staffId, set.get('phone')).run().catch(() => {});
        }
        if (set.has('email')) {
          await ctx.db.prepare('UPDATE hr_profile SET personal_email = ?2 WHERE staff_id = ?1')
            .bind(staffId, set.get('email')).run().catch(() => {});
        }
      }

      // The allowances, a line each because a payslip has to say what the
      // money was for. One row per name, so a sheet run twice does not leave
      // two Transports on somebody's payslip.
      for (const change of allowanceChanges) {
        await ctx.db.prepare('DELETE FROM pay_allowance WHERE staff_id = ?1 AND name = ?2')
          .bind(staffId, change.name).run().catch(() => {});
        if (change.value.amount > 0) {
          await ctx.db.prepare(
            'INSERT INTO pay_allowance (staff_id, name, amount, taxable) VALUES (?1, ?2, ?3, ?4)',
          ).bind(staffId, change.name, change.value.amount, change.value.taxable ? 1 : 0)
            .run().catch(() => {});
        }
      }

      // And the payroll. A basic in a staff sheet is what puts somebody on the
      // payroll, which is the whole reason half these sheets exist.
      if (set.has('basic') || set.has('ssnit')) {
        await ctx.db.prepare(
          `INSERT INTO pay_profile (staff_id, basic, ssnit, set_by)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (staff_id) DO UPDATE SET
             basic = COALESCE(?5, pay_profile.basic),
             ssnit = COALESCE(?6, pay_profile.ssnit),
             set_by = ?4, set_at = datetime('now')`,
        ).bind(
          staffId,
          set.get('basic') ?? 0,
          set.get('ssnit') === false ? 0 : 1,
          actor,
          set.has('basic') ? set.get('basic') : null,
          set.has('ssnit') ? (set.get('ssnit') ? 1 : 0) : null,
        ).run().catch(() => {});
      }
    } catch (err) {
      failed.push({ at: line.at, name: line.name, why: String(err.message).slice(0, 200) });
    }
  }

  await audit(ctx, 'attendance.staff_import', null, {
    added, changed, skipped: read.skipped.length, failed: failed.length,
  });

  return json({
    ok: true, added, changed, failed, skipped: read.skipped,
  });
}

/**
 * The register as it stands, to change and send back.
 *
 * A blank template with headings and nothing under them is a form somebody has
 * to work out; this is the property's own people with their own figures in it,
 * which is both less typing and far less to get wrong. A property with nobody
 * on it yet gets one example row, so the columns are shown rather than
 * described.
 */
export async function staffTemplate(ctx) {
  const { staff, profiles, pay, allowanceBy } = await registerNow(ctx.db);

  // A column for each allowance the property actually uses, written the way
  // the payroll sheet writes them. A property with none yet gets one named
  // example, because a column somebody can see is easier than a paragraph
  // explaining that the heading has to start with "Allowance:".
  const inUse = new Map();
  for (const rows of allowanceBy.values()) {
    for (const row of rows) {
      if (!inUse.has(row.name)) inUse.set(row.name, row.taxable !== 0);
    }
  }
  const allowances = [...inUse.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const columns = allowances.length
    ? allowances.map(([name, taxable]) => `Allowance: ${name}${taxable ? '' : ' (not taxable)'}`)
    : ['Allowance: Transport'];

  const head = ['Employee no', 'Name', 'Department', 'Job title', 'Started', 'Left',
    'Annual leave days', 'Days a week', 'Here for', 'Phone', 'Email', 'Basic salary',
    'SSNIT', ...columns, 'Note'];

  const rows = [head];
  const alive = staff.filter((s) => s.active).sort((a, b) => a.name.localeCompare(b.name));

  for (const person of alive) {
    const profile = profiles.get(person.id);
    const money = pay.get(person.id);
    const mine = allowanceBy.get(person.id) ?? [];
    rows.push([
      person.employee_no,
      person.name,
      person.department ?? '',
      person.job_title ?? '',
      person.hired_on ?? '',
      person.left_on ?? '',
      person.leave_days ?? '',
      person.days_per_week ?? '',
      person.on_clock === 0 ? 'Payroll only' : person.on_rota === 0 ? 'Never rostered' : 'Rota',
      profile?.personal_phone ?? '',
      profile?.personal_email ?? '',
      money ? Number(money.basic).toFixed(2) : '',
      money ? (money.ssnit ? 'Yes' : 'No') : '',
      ...allowances.map(([name]) => {
        const held = mine.find((a) => a.name === name);
        return held ? Number(held.amount).toFixed(2) : '';
      }),
      ...(allowances.length ? [] : ['']),
      person.note ?? '',
    ]);
  }

  if (!alive.length) {
    rows.push(['001', 'Kofi Mensah', 'Kitchen', 'Cook', '2024-03-01', '', '', '', 'Rota',
      '024 123 4567', '', '1800.00', 'Yes', '200.00',
      'An example — change it or delete the line']);
  }

  return csvResponse('staff.csv', rows);
}

// ---------------------------------------------------------------------------
// Tax tables, and the month each one starts
// ---------------------------------------------------------------------------

/** Every dated table, newest first, with the live figures alongside. */
export async function listTaxTables(ctx) {
  const [rows, settings] = await Promise.all([
    ctx.db.prepare('SELECT * FROM pay_rates ORDER BY from_month DESC').all()
      .catch(() => ({ results: [] })),
    ctx.db.prepare('SELECT key, value FROM settings').all(),
  ]);
  const map = Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value]));

  return json({
    tables: (rows.results ?? []).map((row) => ({
      id: row.id,
      fromMonth: row.from_month,
      label: row.label,
      bands: (() => { try { return JSON.parse(row.bands); } catch { return []; } })(),
      ssnitEmployee: row.ssnit_employee,
      ssnitEmployer: row.ssnit_employer,
      tier1: row.tier1,
      tier2: row.tier2,
      bonusRate: row.bonus_rate,
      bonusShare: row.bonus_share,
      setBy: row.set_by,
      setAt: row.set_at,
    })),
    // What is in force right now, which is what the form opens on.
    current: { ...ratesFrom(map), ...tiersFrom(map) },
  });
}

/**
 * Store a set of figures, and say which month they start in.
 *
 * The first time a property dates a table, whatever it was using until then is
 * captured as its own row stamped before every real month. Without that, every
 * month behind the change would fall through to the new figures — which is the
 * whole thing this was built to stop.
 */
export async function saveTaxTable(ctx) {
  const body = await readJson(ctx.request);
  const fromMonth = String(body.fromMonth ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(fromMonth)) {
    throw badRequest('Say which month these figures start in, as YYYY-MM.');
  }
  if (Number(fromMonth.slice(5)) < 1 || Number(fromMonth.slice(5)) > 12) {
    throw badRequest('That is not a month.');
  }

  // Already JSON: readBands hands back the stored form, which is what goes
  // into the column. Stringifying it again would store a string of a string,
  // and the month would read back no bands at all and fall through to the
  // published table without a word.
  const bands = readBands(body.bands);
  const label = str(body.label, 'What the table is called', { max: 80 }) || 'Tax table';
  const rate = (value, what, fallback) => (value == null || value === ''
    ? fallback
    : num(value, what, { min: 0, max: 1 }));

  const rows = await ctx.db.prepare('SELECT key, value FROM settings').all();
  const map = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  const now = { ...ratesFrom(map), ...tiersFrom(map) };

  const figures = {
    ssnitEmployee: rate(body.ssnitEmployee, 'Worker SSNIT', now.ssnitEmployee),
    ssnitEmployer: rate(body.ssnitEmployer, 'Employer SSNIT', now.ssnitEmployer),
    tier1: rate(body.tier1, 'Tier 1', now.tier1),
    tier2: rate(body.tier2, 'Tier 2', now.tier2),
    bonusRate: rate(body.bonusRate, 'Bonus rate', now.bonusFinalRate),
    bonusShare: rate(body.bonusShare, 'Share of basic at the bonus rate', now.bonusShareOfBasic),
  };

  // The capture. Only ever written once, and only when there is nothing dated
  // yet: after this the property's history is complete and everything before
  // the first dated change answers from here.
  const held = await ctx.db.prepare('SELECT COUNT(*) AS n FROM pay_rates').first()
    .catch(() => ({ n: 0 }));
  if (!Number(held?.n ?? 0)) {
    await ctx.db.prepare(
      `INSERT INTO pay_rates (from_month, label, bands, ssnit_employee, ssnit_employer,
                              tier1, tier2, bonus_rate, bonus_share, set_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(
      EARLIEST,
      now.label || 'The table before this one',
      JSON.stringify(now.bands),
      now.ssnitEmployee, now.ssnitEmployer, now.tier1, now.tier2,
      now.bonusFinalRate, now.bonusShareOfBasic,
      `${ctx.session.user.name} (${ctx.session.user.role})`,
    ).run().catch(() => {});
  }

  await ctx.db.prepare(
    `INSERT INTO pay_rates (from_month, label, bands, ssnit_employee, ssnit_employer,
                            tier1, tier2, bonus_rate, bonus_share, set_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT (from_month) DO UPDATE SET
       label = ?2, bands = ?3, ssnit_employee = ?4, ssnit_employer = ?5,
       tier1 = ?6, tier2 = ?7, bonus_rate = ?8, bonus_share = ?9,
       set_by = ?10, set_at = datetime('now')`,
  ).bind(
    fromMonth, label, bands,
    figures.ssnitEmployee, figures.ssnitEmployer, figures.tier1, figures.tier2,
    figures.bonusRate, figures.bonusShare,
    `${ctx.session.user.name} (${ctx.session.user.role})`,
  ).run();

  await syncLiveRates(ctx.db);
  await audit(ctx, 'payroll.tax_table', fromMonth, { label });
  return listTaxTables(ctx);
}

/** Take a dated table off again. The captured one stays: it is the history. */
export async function removeTaxTable(ctx, id) {
  const row = await ctx.db.prepare('SELECT * FROM pay_rates WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('No such tax table.');
  if (row.from_month === EARLIEST) {
    throw badRequest('That one is what the property used before it started dating them. '
      + 'Removing it would leave every earlier month with no figures at all.');
  }

  await ctx.db.prepare('DELETE FROM pay_rates WHERE id = ?').bind(Number(id)).run();
  await syncLiveRates(ctx.db);
  await audit(ctx, 'payroll.tax_table_remove', row.from_month, { label: row.label });
  return listTaxTables(ctx);
}

/**
 * Keep the settings in step with the newest dated table.
 *
 * Every screen that shows "the figures" reads the settings, and so does a
 * property that has never dated anything. Rather than teaching all of them
 * about dates, the newest table is copied back here whenever the list changes.
 */
async function syncLiveRates(db) {
  const newest = await db.prepare(
    'SELECT * FROM pay_rates ORDER BY from_month DESC LIMIT 1',
  ).first().catch(() => null);
  if (!newest) return;

  const put = (key, value) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2',
  ).bind(key, String(value));

  await db.batch([
    put('pay_bands', newest.bands),
    put('pay_bands_label', newest.label),
    put('pay_ssnit_employee', newest.ssnit_employee),
    put('pay_ssnit_employer', newest.ssnit_employer),
    put('pay_tier1', newest.tier1),
    put('pay_tier2', newest.tier2),
    put('pay_bonus_rate', newest.bonus_rate),
    put('pay_bonus_share', newest.bonus_share),
  ]);
}
