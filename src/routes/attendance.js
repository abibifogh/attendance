import {
  badRequest, csvResponse, int, json, notFound, readJson, str,
} from '../lib/http.js';
import {
  colourFor, computeRange, hours, isOpen, labelFor, leaveBalance, leaveDaysIn,
  loadDataset, scheduleFor, streakOf, summarise, toMinutes, weekCountOf,
} from '../lib/attendance.js';
import {
  deviceForPushToken, deviceForToken, exceptionNotice, ingestPunches, recompute, recomputeTouched,
} from '../lib/attendance-ingest.js';
import { readNotification } from '../lib/push-events.js';
import { inferShifts, mergeCandidates, parseStatusRules, shiftsFromRules } from '../lib/device-shifts.js';
import { getPepper } from '../lib/auth.js';
import { createNotice } from '../lib/notices.js';
import { emailExceptions, pingExceptions } from '../lib/notify.js';
import {
  addDays, diffDays, isDay, isMonth, monthBounds, rangeDays, startOfWeek, todayIn,
} from '../util/dates.js';

/**
 * Attendance: the API over what the terminal saw.
 *
 * Two audiences with very different needs, and the split runs through the whole
 * file. A supervisor opens this once a morning wanting a list of what needs
 * dealing with today and nothing else. A manager opens it once a month wanting
 * days worked and leave left, per person, in a form they can hand to whoever
 * does the wages. Every endpoint here serves one or the other.
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

function readDay(value, fallback) {
  if (value == null || value === '') return fallback;
  const day = String(value);
  if (!isDay(day)) throw badRequest('That date is not valid.');
  return day;
}

/**
 * A date range, bounded.
 *
 * The ceiling is not arbitrary politeness — a report asking for five years
 * loads five years of punches into a Worker, and the honest answer is to say so
 * rather than time out halfway.
 */
function readRange(url, timezone, { days = 31, maxDays = 400 } = {}) {
  const today = todayIn(timezone);
  const to = readDay(url.searchParams.get('to'), today);
  const from = readDay(url.searchParams.get('from'), addDays(to, -(days - 1)));
  if (from > to) throw badRequest('The start date is after the end date.');
  if (diffDays(from, to) > maxDays) {
    throw badRequest(`That is more than ${maxDays} days. Choose a shorter period.`);
  }
  return { from, to, today };
}

async function timezoneOf(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first().catch(() => null);
  return row?.value || 'UTC';
}

/**
 * One person's days, computed rather than read.
 *
 * Reports run the same function the ingest runs rather than trusting the stored
 * `att_days` rows. It costs a little and buys a guarantee worth much more: a
 * rota corrected this morning shows in this morning's report, and the day
 * table can never quietly disagree with the rules.
 */
function daysFor(ds, staffId, from, to) {
  return computeRange(ds, staffId, from, to);
}

/** The report row shape every screen renders. */
function present(ds, record) {
  const shift = record.shift_id ? ds.shiftById.get(record.shift_id) ?? null : null;
  return {
    ...record,
    shift: shift ? { id: shift.id, name: shift.name, starts_at: shift.starts_at, ends_at: shift.ends_at } : null,
    label: labelFor(record, ds.reasonBy),
    colour: colourFor(record, ds.reasonBy),
    open: isOpen(record),
    hours: hours(record.worked_minutes),
  };
}

function activeOn(staff, day) {
  if (!staff.active && (!staff.left_on || staff.left_on < day)) return false;
  if (staff.left_on && day > staff.left_on) return false;
  if (staff.hired_on && day < staff.hired_on) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

/**
 * Punches arriving from a terminal.
 *
 * Deliberately outside the session system: the caller is a script on a cupboard
 * PC that has to keep working at three in the morning. It presents a device
 * serial and a token, and the only thing it can do is add punches to its own
 * serial.
 *
 * Source-agnostic on purpose. The on-site ISAPI poller is one feed; the
 * terminal's own HTTP push is another; a Hik-Connect adapter would be a third.
 * They all post the same normalised batch here, so what a punch means is
 * decided in one place rather than three.
 */
export async function ingest(ctx) {
  const body = await readJson(ctx.request);
  const serial = str(body.serial, 'Device serial', { required: true, max: 120 });
  const token = str(
    body.token ?? ctx.request.headers.get('X-Device-Token'),
    'Device token',
    { required: true, max: 200 },
  );

  const pepper = await getPepper(ctx.db);
  const device = await deviceForToken(ctx.db, serial, token, pepper);
  const timezone = await timezoneOf(ctx.db);

  const source = ['poller', 'push', 'cloud', 'import'].includes(body.source) ? body.source : 'poller';
  const result = await ingestPunches(ctx.db, {
    device, events: body.events ?? [], timezone, source,
  });

  // Recomputing is the expensive half and the poller does not need to wait for
  // it — the punches are safely stored either way.
  const work = recomputeTouched(ctx.db, result.touched);
  if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(work);
  else await work;

  return json({
    ok: true,
    received: result.received,
    stored: result.stored,
    duplicates: result.duplicates,
    unusable: result.unusable,
    // Told plainly, because it is the one thing that silently loses data: a
    // person enrolled on the terminal and never added here.
    unknownEmployees: result.unknownEmployees,
  });
}

/**
 * Punches the terminal posts to us, unprompted.
 *
 * The mode that needs nothing running on site. The device is given this URL
 * once, and from then on it makes its own outbound request every time somebody
 * taps. No computer in a cupboard, nothing to restart after a power cut.
 *
 * The token lives in the path because that is all a terminal's listening-host
 * configuration can carry — there is nowhere to put a header. It identifies the
 * device and authorises exactly one thing: adding punches under that device's
 * own serial.
 *
 * Always answers 200, even to something it could make no sense of. A device
 * that gets an error back may disable its listening host and stop reporting
 * altogether, which would be a far worse outcome than quietly ignoring a
 * heartbeat we did not want. What was and was not understood goes in the
 * response body for anybody debugging, and the terminal ignores it.
 */
export async function pushEvents(ctx, tokenParam) {
  const token = str(tokenParam, 'Token', { required: true, max: 200 });
  const pepper = await getPepper(ctx.db);

  let device;
  try {
    device = await deviceForPushToken(ctx.db, token, pepper);
  } catch {
    // The one case worth refusing outright: somebody guessing tokens. No
    // detail, because there is nothing here for them to learn.
    return json({ ok: false }, { status: 403 });
  }

  const events = await readNotification(ctx.request);
  const timezone = await timezoneOf(ctx.db);

  // Heartbeats, door alarms and tamper events come down the same pipe. Nothing
  // to store, but the device has just proved it is alive and reachable, and the
  // Terminals screen exists to show exactly that.
  if (!events.length) {
    await ctx.db.prepare("UPDATE att_devices SET last_seen_at = datetime('now') WHERE id = ?")
      .bind(device.id).run().catch(() => {});
    return json({ ok: true, stored: 0, note: 'nothing attendance-related in that' });
  }

  const result = await ingestPunches(ctx.db, {
    device, events, timezone, source: 'push',
  });

  // The device is waiting on this response and will not wait long. Working out
  // what the punches mean can happen after it has hung up.
  const work = recomputeTouched(ctx.db, result.touched);
  if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(work);
  else await work;

  return json({
    ok: true,
    stored: result.stored,
    duplicates: result.duplicates,
    unknownEmployees: result.unknownEmployees,
  });
}

/**
 * What the terminal says about its own attendance configuration.
 *
 * Posted by the poller alongside the punches, under the same device token. The
 * point is narrow and worth stating: somebody who has already built their
 * shifts in Hik-Connect should not have to build them again here, and the bands
 * the device carries are an echo of those shifts.
 *
 * Stored verbatim. Nothing is applied automatically — see `shiftSuggestions`.
 */
export async function deviceConfig(ctx) {
  const body = await readJson(ctx.request);
  const serial = str(body.serial, 'Device serial', { required: true, max: 120 });
  const token = str(
    body.token ?? ctx.request.headers.get('X-Device-Token'),
    'Device token',
    { required: true, max: 200 },
  );

  const pepper = await getPepper(ctx.db);
  const device = await deviceForToken(ctx.db, serial, token, pepper);

  const entries = Array.isArray(body.config) ? body.config.slice(0, 20) : [];
  if (!entries.length) return json({ ok: true, stored: 0 });

  await ctx.db.batch(entries.map((entry) => ctx.db.prepare(
    `INSERT INTO att_device_config (device_serial, kind, path, raw, status, fetched_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
     ON CONFLICT (device_serial, kind) DO UPDATE SET
       path = excluded.path, raw = excluded.raw,
       status = excluded.status, fetched_at = excluded.fetched_at`,
  ).bind(
    device.serial,
    str(entry.kind, 'Kind', { required: true, max: 60 }),
    str(entry.path, 'Path', { max: 200 }),
    entry.raw == null ? null : String(JSON.stringify(entry.raw)).slice(0, 20000),
    ['ok', 'unsupported', 'failed'].includes(entry.status) ? entry.status : 'ok',
  )));

  return json({ ok: true, stored: entries.length });
}

/**
 * The shifts this property appears to run, without anybody typing them in.
 *
 * Two sources, merged. The terminal's own attendance bands say how many shifts
 * there are and roughly when; the punches already recorded say precisely when,
 * because a few hundred people have been clocking in for them. Where both agree
 * the observed times win and the band is kept as corroboration.
 *
 * Nothing is written. A shift decides whether somebody is recorded as late, so
 * it takes a person pressing a button — but the button is next to a filled-in
 * form rather than an empty one.
 */
export async function shiftSuggestions(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  const from = addDays(today, -Number(ctx.url.searchParams.get('days') ?? 60));

  const [configRows, punchRows, existing] = await Promise.all([
    ctx.db.prepare("SELECT * FROM att_device_config WHERE status = 'ok'").all()
      .catch(() => ({ results: [] })),
    // Every punch in the window, by person and day. Enough to see the pattern
    // and small enough not to matter.
    ctx.db.prepare(
      `SELECT employee_no, day, MIN(at_local) AS first_at, MAX(at_local) AS last_at, COUNT(*) AS n
       FROM att_punches WHERE day BETWEEN ?1 AND ?2
       GROUP BY employee_no, day HAVING n > 1`,
    ).bind(from, today).all().catch(() => ({ results: [] })),
    ctx.db.prepare('SELECT * FROM att_shifts').all(),
  ]);

  // What the device reported, whatever shape it chose to report it in.
  const rules = [];
  for (const row of configRows.results ?? []) {
    if (!row.raw) continue;
    try {
      rules.push(...parseStatusRules(JSON.parse(row.raw)));
    } catch {
      // A body that is not JSON tells us the endpoint exists and the parse
      // needs work. Neither is a reason to fail the screen.
    }
  }

  const pairs = (punchRows.results ?? []).map((row) => ({
    in: String(row.first_at).slice(11, 16),
    out: String(row.last_at).slice(11, 16),
  }));

  const suggestions = mergeCandidates({
    fromDevice: shiftsFromRules(rules),
    fromPunches: inferShifts(pairs, { minSupport: Math.max(3, Math.round(pairs.length / 40)) }),
  });

  // A suggestion that matches a shift already set up is marked rather than
  // hidden, so re-running this does not look like it found nothing.
  const shifts = existing.results ?? [];
  const withMatches = suggestions.map((s) => ({
    ...s,
    existing: shifts.find((x) => x.starts_at === s.starts_at && x.ends_at === s.ends_at)?.name ?? null,
  }));

  return json({
    suggestions: withMatches,
    bands: rules,
    // Said plainly on the screen, because "no suggestions" has several causes
    // and only one of them is a fault.
    evidence: {
      daysOfPunches: pairs.length,
      deviceReported: (configRows.results ?? []).length,
      deviceBands: rules.length,
      since: from,
    },
  });
}

/**
 * Turn chosen suggestions into shifts.
 *
 * Keyed by the times, so running the sync again after the terminal is
 * reconfigured updates the shift it created rather than adding a second one
 * beside it. A shift somebody typed in themselves has no source and is never
 * touched by this.
 */
export async function importShifts(ctx) {
  const body = await readJson(ctx.request);
  const wanted = Array.isArray(body.shifts) ? body.shifts.slice(0, 20) : [];
  if (!wanted.length) throw badRequest('Nothing chosen to import.');

  const actor = `${ctx.session.user.name} (${ctx.session.user.role})`;
  const applied = [];

  for (const entry of wanted) {
    const name = str(entry.name, 'Name', { required: true, max: 60 });
    const startsAt = str(entry.startsAt, 'Start', { required: true, max: 8 }).slice(0, 5);
    const endsAt = str(entry.endsAt, 'End', { required: true, max: 8 }).slice(0, 5);
    if (toMinutes(startsAt) == null || toMinutes(endsAt) == null) {
      throw badRequest(`${name}: those are not valid times.`);
    }
    if (startsAt === endsAt) throw badRequest(`${name}: a shift cannot start and end at the same time.`);

    const ref = `${startsAt}-${endsAt}`;
    const existing = await ctx.db.prepare(
      'SELECT * FROM att_shifts WHERE source_ref = ?1 OR (starts_at = ?2 AND ends_at = ?3)',
    ).bind(ref, startsAt, endsAt).first();

    if (existing) {
      // Only the times and the name, and only for a shift this sync created.
      // Grace periods and day thresholds are policy somebody set here, and a
      // re-sync must not quietly reset them.
      if (existing.source === 'device') {
        await ctx.db.prepare(
          'UPDATE att_shifts SET name = ?1, starts_at = ?2, ends_at = ?3 WHERE id = ?4',
        ).bind(name, startsAt, endsAt, existing.id).run();
        applied.push({ name, action: 'updated' });
      } else {
        applied.push({ name: existing.name, action: 'left alone', reason: 'set up by hand' });
      }
      continue;
    }

    await ctx.db.prepare(
      `INSERT INTO att_shifts
         (name, starts_at, ends_at, break_minutes, grace_in_minutes, grace_out_minutes,
          half_day_minutes, full_day_minutes, overtime_after, sort_order, active, source, source_ref)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, 1, 'device', ?10)`,
    ).bind(
      name, startsAt, endsAt,
      int(entry.breakMinutes ?? 0, 'Break', { min: 0, max: 480 }),
      int(entry.graceIn ?? 5, 'Grace in', { min: 0, max: 120 }),
      int(entry.graceOut ?? 5, 'Grace out', { min: 0, max: 120 }),
      int(entry.halfDayMinutes ?? 240, 'Half day', { min: 0, max: 1440 }),
      int(entry.fullDayMinutes ?? 420, 'Full day', { min: 0, max: 1440 }),
      int(entry.sortOrder ?? 100, 'Order', { min: 0, max: 9999 }),
      ref,
    ).run().catch(async (err) => {
      if (!String(err).includes('UNIQUE')) throw err;
      // Two suggestions with the same name — rare, and not worth failing over.
      await ctx.db.prepare(
        `INSERT INTO att_shifts (name, starts_at, ends_at, source, source_ref)
         VALUES (?1, ?2, ?3, 'device', ?4)`,
      ).bind(`${name} (${startsAt})`, startsAt, endsAt, ref).run();
    });

    applied.push({ name, action: 'added' });
  }

  await audit(ctx, 'attendance.shifts_import', null, { applied });
  return json({ ok: true, applied });
}

// ---------------------------------------------------------------------------
// Everyday
// ---------------------------------------------------------------------------

/** Everything the attendance screens need to draw themselves, in one call. */
export async function bootstrap(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  const ds = await loadDataset(ctx.db, { from: addDays(today, -7), to: today });

  const [open, unknown] = await Promise.all([
    ctx.db.prepare(
      "SELECT COUNT(*) AS n FROM att_days WHERE resolution = 'open' AND day <= ?",
    ).bind(today).first().catch(() => ({ n: 0 })),
    ctx.db.prepare(
      'SELECT COUNT(DISTINCT employee_no) AS n FROM att_punches WHERE staff_id IS NULL',
    ).first().catch(() => ({ n: 0 })),
  ]);

  return json({
    today,
    timezone,
    staff: ds.staff.map((s) => ({
      id: s.id,
      employee_no: s.employee_no,
      name: s.name,
      department: s.department,
      job_title: s.job_title,
      hired_on: s.hired_on,
      left_on: s.left_on,
      active: s.active,
    })),
    shifts: ds.shifts,
    reasons: ds.reasons,
    settings: Object.fromEntries(
      Object.entries(ds.settings).filter(([key]) => key.startsWith('att_') || key === 'timezone'),
    ),
    open: Number(open?.n ?? 0),
    unknownEmployees: Number(unknown?.n ?? 0),
  });
}

/**
 * One day, everybody.
 *
 * The roll call. Ordered so the page reads top-down in the order a supervisor
 * would deal with it: what needs a decision, then what went wrong, then
 * everybody who simply turned up and did their job.
 */
export async function day(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  const target = readDay(ctx.url.searchParams.get('day'), today);

  const ds = await loadDataset(ctx.db, { from: addDays(target, -7), to: addDays(target, 1) });
  const rows = [];

  for (const staff of ds.staff) {
    if (!activeOn(staff, target)) continue;
    const window = daysFor(ds, staff.id, addDays(target, -6), target);
    const record = window[window.length - 1];
    if (!record) continue;

    const isAbsent = (r) => r && (r.status === 'absent' || r.reason_code === 'absent');
    const isLate = (r) => r && (r.status === 'late' || r.status === 'late_early');

    rows.push({
      staff: { id: staff.id, name: staff.name, employee_no: staff.employee_no, department: staff.department },
      ...present(ds, record),
      streak: isAbsent(record) ? streakOf(window, window.length - 1, isAbsent) : 0,
      weekCount: isLate(record) ? weekCountOf(window, window.length - 1, isLate) : 0,
    });
  }

  const order = { red: 0, amber: 1, green: 2, grey: 3 };
  rows.sort((a, b) => (a.open === b.open ? 0 : a.open ? -1 : 1)
    || (order[a.colour] ?? 9) - (order[b.colour] ?? 9)
    || a.staff.name.localeCompare(b.staff.name));

  return json({
    day: target,
    today,
    totals: summarise(rows, { shifts: ds.shiftById, reasons: ds.reasonBy }),
    rows,
  });
}

/**
 * One person, one day — the report that gets handed to them.
 *
 * Carries the raw punches alongside the verdict. A supervisor being asked to
 * confirm what time somebody left should be looking at what the terminal
 * actually recorded, not only at this system's opinion of it.
 */
export async function staffDay(ctx, id) {
  const timezone = await timezoneOf(ctx.db);
  const target = readDay(ctx.url.searchParams.get('day'), todayIn(timezone));
  const staffId = Number(id);

  const ds = await loadDataset(ctx.db, { from: addDays(target, -14), to: addDays(target, 1) });
  const staff = ds.staffById.get(staffId);
  if (!staff) throw notFound('No such member of staff.');

  const window = daysFor(ds, staffId, addDays(target, -13), target);
  const record = window[window.length - 1];

  const punches = (ds.punchesByStaff.get(staffId) ?? [])
    .filter((p) => p.day === target || p.day === addDays(target, 1) || p.day === addDays(target, -1))
    .map((p) => ({
      at: p.at_local, day: p.day, direction: p.direction,
      device_status: p.device_status, source: p.source, door: p.door,
    }));

  return json({
    staff,
    day: target,
    ...present(ds, record),
    punches,
    reasons: ds.reasons.filter((r) => r.selectable && r.active),
    recent: window.slice(-7).map((r) => present(ds, r)),
  });
}

/**
 * A week, per person, day by day.
 *
 * The shape a manager actually reads: names down the side, Monday to Sunday
 * across, and the totals that matter at the end of the row.
 */
export async function week(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  const from = startOfWeek(readDay(ctx.url.searchParams.get('from'), today));
  const to = addDays(from, 6);

  const ds = await loadDataset(ctx.db, { from: addDays(from, -1), to: addDays(to, 1) });
  const days = rangeDays(from, to);
  const rows = [];

  for (const staff of ds.staff) {
    if (!days.some((d) => activeOn(staff, d))) continue;
    const records = daysFor(ds, staff.id, from, to);
    rows.push({
      staff: { id: staff.id, name: staff.name, employee_no: staff.employee_no, department: staff.department },
      days: records.map((r) => present(ds, r)),
      totals: summarise(records, { shifts: ds.shiftById, reasons: ds.reasonBy }),
    });
  }

  rows.sort((a, b) => a.staff.name.localeCompare(b.staff.name));

  return json({
    from,
    to,
    days,
    rows,
    totals: summarise(rows.flatMap((r) => r.days), { shifts: ds.shiftById, reasons: ds.reasonBy }),
  });
}

/**
 * One person over a period, with what it adds up to and what leave is left.
 *
 * The per-staff report, whether that period is a day, a week or a month — the
 * screen chooses the range, not this endpoint.
 */
export async function staffReport(ctx, id) {
  const timezone = await timezoneOf(ctx.db);
  const { from, to } = readRange(ctx.url, timezone);
  const staffId = Number(id);

  const ds = await loadDataset(ctx.db, { from: addDays(from, -1), to: addDays(to, 1) });
  const staff = ds.staffById.get(staffId);
  if (!staff) throw notFound('No such member of staff.');

  const records = daysFor(ds, staffId, from, to);
  const yearFrom = `${to.slice(0, 4)}-01-01`;
  const yearRecords = await yearToDate(ctx.db, staffId, yearFrom, to);

  return json({
    staff,
    from,
    to,
    days: records.map((r) => present(ds, r)),
    totals: summarise(records, { shifts: ds.shiftById, reasons: ds.reasonBy }),
    leave: leaveBalance({
      staff,
      records: yearRecords,
      requests: ds.requestsByStaff.get(staffId) ?? [],
      settings: ds.settings,
      asOf: to,
      reasons: ds.reasonBy,
    }),
  });
}

/**
 * The leave-relevant days of the year so far.
 *
 * Read from the stored table rather than recomputed: a balance needs a whole
 * year and recomputing a year of punches to count fourteen days of leave would
 * be an absurd amount of work for the answer.
 */
async function yearToDate(db, staffId, from, to) {
  const rows = await db.prepare(
    'SELECT day, reason_code FROM att_days WHERE staff_id = ? AND day BETWEEN ? AND ?',
  ).bind(staffId, from, to).all().catch(() => ({ results: [] }));
  return rows.results ?? [];
}

/**
 * The same thing for everybody, in one query.
 *
 * The per-person version above is right for one report. Calling it in a loop
 * over a hundred staff is a hundred round trips for a page that should be one,
 * so the screens that show the whole property use this instead.
 */
async function yearToDateAll(db, from, to) {
  const rows = await db.prepare(
    'SELECT staff_id, day, reason_code FROM att_days WHERE day BETWEEN ? AND ?',
  ).bind(from, to).all().catch(() => ({ results: [] }));

  const byStaff = new Map();
  for (const row of rows.results ?? []) {
    if (!byStaff.has(row.staff_id)) byStaff.set(row.staff_id, []);
    byStaff.get(row.staff_id).push(row);
  }
  return byStaff;
}

/**
 * Everybody, over a month — the sheet that goes to whoever does the wages.
 *
 * Days worked, days absent, leave taken and hours, per person, with the leave
 * balance beside it so the same page answers "can she take next Friday off".
 */
export async function overview(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const month = ctx.url.searchParams.get('month');
  if (month && !isMonth(month)) throw badRequest('That month is not valid.');
  const bounds = month ? monthBounds(month) : null;
  const today = todayIn(timezone);
  const from = bounds?.from ?? `${today.slice(0, 7)}-01`;
  const to = bounds?.to ?? today;

  const ds = await loadDataset(ctx.db, { from: addDays(from, -1), to: addDays(to, 1) });
  const yearByStaff = await yearToDateAll(ctx.db, `${to.slice(0, 4)}-01-01`, to);
  const span = rangeDays(from, to);
  const rows = [];

  for (const staff of ds.staff) {
    if (!span.some((d) => activeOn(staff, d))) continue;
    const records = daysFor(ds, staff.id, from, to);
    const yearRecords = yearByStaff.get(staff.id) ?? [];

    rows.push({
      staff: {
        id: staff.id, name: staff.name, employee_no: staff.employee_no, department: staff.department,
      },
      totals: summarise(records, { shifts: ds.shiftById, reasons: ds.reasonBy }),
      leave: leaveBalance({
        staff,
        records: yearRecords,
        requests: ds.requestsByStaff.get(staff.id) ?? [],
        settings: ds.settings,
        asOf: to,
        reasons: ds.reasonBy,
      }),
    });
  }

  rows.sort((a, b) => a.staff.name.localeCompare(b.staff.name));
  return json({ from, to, month: from.slice(0, 7), rows });
}

/** The same figures, as a file, for whoever wants them in a spreadsheet. */
export async function exportCsv(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const { from, to } = readRange(ctx.url, timezone, { days: 31, maxDays: 400 });
  const ds = await loadDataset(ctx.db, { from: addDays(from, -1), to: addDays(to, 1) });

  const rows = [[
    'Date', 'Employee no', 'Name', 'Department', 'Shift', 'Scheduled start', 'Scheduled end',
    'Clock in', 'Clock out', 'Hours', 'Late (min)', 'Early (min)', 'Overtime (min)',
    'Status', 'Reason', 'Paid', 'Counts as worked', 'Resolved by', 'Note',
  ]];

  for (const staff of ds.staff) {
    for (const record of daysFor(ds, staff.id, from, to)) {
      if (!activeOn(staff, record.day)) continue;
      const shift = record.shift_id ? ds.shiftById.get(record.shift_id) : null;
      const reason = ds.reasonBy.get(record.reason_code);
      rows.push([
        record.day, staff.employee_no, staff.name, staff.department ?? '',
        shift?.name ?? '', shift?.starts_at ?? '', shift?.ends_at ?? '',
        record.first_in ?? '', record.last_out ?? '', hours(record.worked_minutes),
        record.late_minutes, record.early_minutes, record.overtime_minutes,
        labelFor(record, ds.reasonBy), reason?.label ?? record.reason_code ?? '',
        reason?.paid ? 'yes' : 'no', reason?.counts_as_worked ? 'yes' : 'no',
        record.resolved_by ?? '', record.note ?? '',
      ]);
    }
  }

  return csvResponse(`attendance-${from}-to-${to}.csv`, rows);
}

// ---------------------------------------------------------------------------
// Settling a day
// ---------------------------------------------------------------------------

/**
 * A supervisor says what actually happened.
 *
 * The endpoint the whole "incomplete rather than absent" decision rests on. It
 * records three things and records who recorded them: what the day should be
 * charged to, the clock times the terminal never saw, and why.
 *
 * A resolved day survives every later recomputation. Punches that arrive
 * afterwards refresh the times on the record but never overturn the ruling —
 * somebody has put their name to this.
 */
export async function resolveDay(ctx, dayParam) {
  const target = readDay(dayParam);
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });
  const reasonCode = str(body.reason, 'Reason', { required: true, max: 40 });

  const [staff, reason] = await Promise.all([
    ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first(),
    ctx.db.prepare('SELECT * FROM att_reasons WHERE code = ? AND active = 1').bind(reasonCode).first(),
  ]);
  if (!staff) throw notFound('No such member of staff.');
  if (!reason) throw badRequest('That is not a reason this property uses.');
  if (!reason.selectable) throw badRequest(`"${reason.label}" is decided by the system, not chosen.`);

  const correctedIn = readClock(body.in, 'Clock-in');
  const correctedOut = readClock(body.out, 'Clock-out');
  const note = str(body.note, 'Note', { max: 500 });
  if (reason.requires_note && !note) throw badRequest(`"${reason.label}" needs a note saying why.`);

  const status = reason.kind === 'leave' ? 'leave'
    : reason.kind === 'holiday' ? 'holiday'
      : reason.kind === 'rest' ? 'rest'
        : reason.kind === 'absent' ? 'absent'
          : 'present';

  await ctx.db.prepare(
    `INSERT INTO att_days (staff_id, day, status, reason_code, resolution,
                           resolved_by, resolved_at, resolved_note, corrected_in, corrected_out)
     VALUES (?1, ?2, ?3, ?4, 'resolved', ?5, datetime('now'), ?6, ?7, ?8)
     ON CONFLICT (staff_id, day) DO UPDATE SET
       status = excluded.status,
       reason_code = excluded.reason_code,
       resolution = 'resolved',
       resolved_by = excluded.resolved_by,
       resolved_at = excluded.resolved_at,
       resolved_note = excluded.resolved_note,
       corrected_in = excluded.corrected_in,
       corrected_out = excluded.corrected_out`,
  ).bind(
    staffId, target, status, reasonCode,
    `${ctx.session.user.name} (${ctx.session.user.role})`,
    note, correctedIn, correctedOut,
  ).run();

  await recompute(ctx.db, { staffIds: [staffId], from: target, to: target });
  await audit(ctx, 'attendance.resolve', `${staffId}|${target}`, {
    reason: reasonCode, in: correctedIn, out: correctedOut, note,
  });

  const ds = await loadDataset(ctx.db, { from: addDays(target, -1), to: addDays(target, 1) });
  const [record] = daysFor(ds, staffId, target, target);
  return json({ ok: true, day: present(ds, record) });
}

/**
 * Undo a ruling, putting the day back to whatever the punches say.
 *
 * Needed more often than it sounds: the commonest correction to a correction is
 * somebody having picked the wrong person off a list.
 */
export async function unresolveDay(ctx, dayParam) {
  const target = readDay(dayParam);
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });

  await ctx.db.prepare(
    `UPDATE att_days SET resolution = 'open', resolved_by = NULL, resolved_at = NULL,
                         resolved_note = NULL, corrected_in = NULL, corrected_out = NULL
     WHERE staff_id = ? AND day = ?`,
  ).bind(staffId, target).run();

  await recompute(ctx.db, { staffIds: [staffId], from: target, to: target });
  await audit(ctx, 'attendance.unresolve', `${staffId}|${target}`, null);

  const ds = await loadDataset(ctx.db, { from: addDays(target, -1), to: addDays(target, 1) });
  const [record] = daysFor(ds, staffId, target, target);
  return json({ ok: true, day: present(ds, record) });
}

function readClock(value, field) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (toMinutes(text) == null) throw badRequest(`${field} must be a time like 14:30.`);
  return text.slice(0, 5);
}

/**
 * A punch typed in by hand.
 *
 * For the day the terminal was unplugged, or the person whose face it would not
 * read. Marked `manual` and attributed, so it is never mistaken for something
 * the device observed.
 */
export async function addPunch(ctx) {
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });
  const target = readDay(body.day);
  const time = readClock(body.time, 'Time');
  if (!time) throw badRequest('A time is required.');
  const direction = body.direction === 'in' || body.direction === 'out' ? body.direction : null;

  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!staff) throw notFound('No such member of staff.');

  const stamp = `${target} ${time}:00`;
  const actor = `${ctx.session.user.name} (${ctx.session.user.role})`;

  await ctx.db.prepare(
    `INSERT OR IGNORE INTO att_punches
       (device_serial, employee_no, staff_id, at_utc, at_local, day, direction,
        device_status, source, dedupe_key, raw)
     VALUES ('manual', ?1, ?2, ?3, ?3, ?4, ?5, 'manual', 'manual', ?6, ?7)`,
  ).bind(
    staff.employee_no, staffId, stamp, target, direction,
    `m:${staffId}:${stamp}:${direction ?? ''}`,
    JSON.stringify({ addedBy: actor }),
  ).run();

  await recompute(ctx.db, { staffIds: [staffId], from: addDays(target, -1), to: addDays(target, 1) });
  await audit(ctx, 'attendance.punch_added', `${staffId}|${target}`, { time, direction });

  const ds = await loadDataset(ctx.db, { from: addDays(target, -1), to: addDays(target, 1) });
  const [record] = daysFor(ds, staffId, target, target);
  return json({ ok: true, day: present(ds, record) });
}

// ---------------------------------------------------------------------------
// The rota
// ---------------------------------------------------------------------------

/** The rota as a grid: people down the side, days across, plus the standing pattern. */
export async function getRoster(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const from = startOfWeek(readDay(ctx.url.searchParams.get('from'), todayIn(timezone)));
  const to = readDay(ctx.url.searchParams.get('to'), addDays(from, 13));
  if (diffDays(from, to) > 62) throw badRequest('Choose a shorter period — two months at most.');

  const ds = await loadDataset(ctx.db, { from, to });
  const days = rangeDays(from, to);

  return json({
    from,
    to,
    days,
    shifts: ds.shifts.filter((s) => s.active),
    rows: ds.staff.filter((s) => s.active).map((staff) => ({
      staff: { id: staff.id, name: staff.name, employee_no: staff.employee_no, department: staff.department },
      pattern: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [
        d, ds.patternBy.get(`${staff.id}|${d}`)?.shift_id ?? null,
      ])),
      hasPattern: [0, 1, 2, 3, 4, 5, 6].some((d) => ds.patternBy.has(`${staff.id}|${d}`)),
      days: days.map((day) => {
        const schedule = scheduleFor(ds, staff.id, day);
        return {
          day,
          shift_id: schedule.shift?.id ?? null,
          source: schedule.source,
          explicit: schedule.explicit,
          leave: ds.leaveBy.get(`${staff.id}|${day}`)?.reason_code ?? null,
          holiday: ds.holidayBy.get(day)?.name ?? null,
        };
      }),
    })),
  });
}

/**
 * Set the rota for a batch of cells.
 *
 * Batched because that is how a rota is filled in — a fortnight of one person,
 * or one day of everybody — and a request per cell would make a slow job on a
 * phone slower.
 *
 * `shiftId: null` is a rostered day off, which is a decision. Passing `clear`
 * removes the override entirely and hands the day back to the standing pattern.
 */
export async function saveRoster(ctx) {
  const body = await readJson(ctx.request);
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) throw badRequest('Nothing to save.');
  if (entries.length > 500) throw badRequest('Too many changes in one go.');

  const actor = `${ctx.session.user.name} (${ctx.session.user.role})`;
  const statements = [];
  const touched = new Map();

  for (const entry of entries) {
    const staffId = int(entry.staffId, 'Staff', { required: true, min: 1 });
    const day = readDay(entry.day);
    const shiftId = entry.shiftId == null ? null : int(entry.shiftId, 'Shift', { min: 1 });

    if (entry.clear) {
      statements.push(ctx.db.prepare('DELETE FROM att_roster WHERE staff_id = ? AND day = ?')
        .bind(staffId, day));
    } else {
      statements.push(ctx.db.prepare(
        `INSERT INTO att_roster (staff_id, day, shift_id, note, set_by, set_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
         ON CONFLICT (staff_id, day) DO UPDATE SET
           shift_id = excluded.shift_id, note = excluded.note,
           set_by = excluded.set_by, set_at = excluded.set_at`,
      ).bind(staffId, day, shiftId, str(entry.note, 'Note', { max: 200 }), actor));
    }

    const range = touched.get(staffId) ?? { from: day, to: day };
    if (day < range.from) range.from = day;
    if (day > range.to) range.to = day;
    touched.set(staffId, range);
  }

  for (let i = 0; i < statements.length; i += 100) {
    await ctx.db.batch(statements.slice(i, i + 100));
  }
  await recomputeTouched(ctx.db, touched);
  await audit(ctx, 'attendance.roster', null, { changes: entries.length });

  return json({ ok: true, changed: entries.length });
}

/**
 * The standing weekly pattern for one person.
 *
 * What fills the rota in when nobody has said otherwise. Most staff have one
 * and never need a per-day override at all.
 */
export async function savePattern(ctx) {
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });
  const pattern = body.pattern && typeof body.pattern === 'object' ? body.pattern : null;
  if (!pattern) throw badRequest('A pattern is required.');

  const statements = [ctx.db.prepare('DELETE FROM att_patterns WHERE staff_id = ?').bind(staffId)];
  for (const dowKey of [0, 1, 2, 3, 4, 5, 6]) {
    const value = pattern[dowKey] ?? pattern[String(dowKey)];
    // Undefined means "say nothing about this weekday"; null means a rest day.
    if (value === undefined) continue;
    statements.push(ctx.db.prepare(
      'INSERT INTO att_patterns (staff_id, dow, shift_id) VALUES (?, ?, ?)',
    ).bind(staffId, dowKey, value == null ? null : int(value, 'Shift', { min: 1 })));
  }

  await ctx.db.batch(statements);

  // The pattern only shows where no override exists, so recomputing the weeks
  // around today is enough to make the change visible without rebuilding a year.
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  await recompute(ctx.db, { staffIds: [staffId], from: addDays(today, -30), to: addDays(today, 30) });
  await audit(ctx, 'attendance.pattern', staffId, pattern);

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export async function listLeave(ctx) {
  const status = ctx.url.searchParams.get('status');
  const staffId = ctx.url.searchParams.get('staffId');

  const clauses = [];
  const binds = [];
  if (status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
    clauses.push('l.status = ?');
    binds.push(status);
  }
  if (staffId) {
    clauses.push('l.staff_id = ?');
    binds.push(Number(staffId));
  }

  const rows = await ctx.db.prepare(
    `SELECT l.*, s.name AS staff_name, s.employee_no, r.label AS reason_label, r.paid, r.deducts_leave
     FROM att_leave l
     JOIN att_staff s ON s.id = l.staff_id
     LEFT JOIN att_reasons r ON r.code = l.reason_code
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.from_day DESC
     LIMIT 400`,
  ).bind(...binds).all();

  return json({ leave: rows.results ?? [] });
}

/**
 * Ask for leave, or record leave already agreed.
 *
 * The cost in days is worked out here against the rota and then frozen onto the
 * request. Recomputing it later would let a rota edit in September silently
 * change what a fortnight in March cost somebody.
 */
export async function requestLeave(ctx) {
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });
  const reasonCode = str(body.reason, 'Type of leave', { required: true, max: 40 });
  const from = readDay(body.from);
  const to = readDay(body.to, from);
  if (to < from) throw badRequest('The last day is before the first.');
  if (diffDays(from, to) > 180) throw badRequest('That is more than six months. Split it up.');

  const halfDay = ['start', 'end', 'both'].includes(body.halfDay) ? body.halfDay : null;

  const [staff, reason] = await Promise.all([
    ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first(),
    ctx.db.prepare('SELECT * FROM att_reasons WHERE code = ? AND active = 1').bind(reasonCode).first(),
  ]);
  if (!staff) throw notFound('No such member of staff.');
  if (!reason || reason.kind !== 'leave') throw badRequest('That is not a kind of leave.');

  const ds = await loadDataset(ctx.db, { from, to });
  const days = leaveDaysIn({ from, to, staffId, ds, halfDay });
  if (!days) {
    throw badRequest('That period has no rostered days in it, so there is no leave to take.');
  }

  const clash = await ctx.db.prepare(
    `SELECT id FROM att_leave
     WHERE staff_id = ? AND status IN ('pending','approved')
       AND from_day <= ? AND to_day >= ?`,
  ).bind(staffId, to, from).first();
  if (clash) throw badRequest('That overlaps leave already booked for this person.');

  // Approved outright when the person recording it can approve leave anyway;
  // making a manager approve their own entry is ceremony, not control.
  const canApprove = ctx.session.permissions.includes('att_manage');
  const actor = `${ctx.session.user.name} (${ctx.session.user.role})`;

  const row = await ctx.db.prepare(
    `INSERT INTO att_leave
       (staff_id, reason_code, from_day, to_day, days, half_day, status, reason,
        requested_by, decided_by, decided_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING id`,
  ).bind(
    staffId, reasonCode, from, to, days, halfDay,
    canApprove ? 'approved' : 'pending',
    str(body.note, 'Reason', { max: 500 }),
    actor,
    canApprove ? actor : null,
    canApprove ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
  ).first();

  if (canApprove) await recompute(ctx.db, { staffIds: [staffId], from, to });
  await audit(ctx, 'attendance.leave_request', row?.id, { staffId, reasonCode, from, to, days });

  return json({ ok: true, id: row?.id ?? null, days, status: canApprove ? 'approved' : 'pending' });
}

export async function decideLeave(ctx, id) {
  const body = await readJson(ctx.request);
  const decision = body.decision === 'approved' ? 'approved'
    : body.decision === 'rejected' ? 'rejected' : null;
  if (!decision) throw badRequest('Say approved or rejected.');

  const request = await ctx.db.prepare('SELECT * FROM att_leave WHERE id = ?').bind(Number(id)).first();
  if (!request) throw notFound('No such leave request.');
  if (request.status !== 'pending') throw badRequest('That request has already been decided.');

  await ctx.db.prepare(
    `UPDATE att_leave SET status = ?1, decided_by = ?2, decided_at = datetime('now'), decision_note = ?3
     WHERE id = ?4`,
  ).bind(
    decision,
    `${ctx.session.user.name} (${ctx.session.user.role})`,
    str(body.note, 'Note', { max: 500 }),
    request.id,
  ).run();

  if (decision === 'approved') {
    await recompute(ctx.db, { staffIds: [request.staff_id], from: request.from_day, to: request.to_day });
  }
  await audit(ctx, 'attendance.leave_decide', request.id, { decision });

  return json({ ok: true, status: decision });
}

/**
 * Cancel leave, and rub it off the days it had claimed.
 *
 * The days go back to whatever the punches say, which for a future date is an
 * ordinary rostered day and for a past one is usually an absence somebody now
 * has to explain — correctly, because that is what it was.
 */
export async function cancelLeave(ctx, id) {
  const request = await ctx.db.prepare('SELECT * FROM att_leave WHERE id = ?').bind(Number(id)).first();
  if (!request) throw notFound('No such leave request.');

  await ctx.db.batch([
    ctx.db.prepare(
      `UPDATE att_leave SET status = 'cancelled', decided_by = ?1, decided_at = datetime('now')
       WHERE id = ?2`,
    ).bind(`${ctx.session.user.name} (${ctx.session.user.role})`, request.id),
    // Days this request created and nobody has ruled on since.
    ctx.db.prepare(
      "UPDATE att_days SET leave_id = NULL WHERE leave_id = ? AND resolution != 'resolved'",
    ).bind(request.id),
  ]);

  await recompute(ctx.db, {
    staffIds: [request.staff_id], from: request.from_day, to: request.to_day,
  });
  await audit(ctx, 'attendance.leave_cancel', request.id, null);

  return json({ ok: true });
}

/** Leave balances for everybody, which is the screen that answers most questions. */
export async function balances(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const asOf = readDay(ctx.url.searchParams.get('asOf'), todayIn(timezone));
  const ds = await loadDataset(ctx.db, { from: asOf, to: asOf });
  const yearByStaff = await yearToDateAll(ctx.db, `${asOf.slice(0, 4)}-01-01`, asOf);

  const rows = [];
  for (const staff of ds.staff) {
    if (!staff.active) continue;
    const records = yearByStaff.get(staff.id) ?? [];
    rows.push({
      staff: { id: staff.id, name: staff.name, employee_no: staff.employee_no, department: staff.department },
      balance: leaveBalance({
        staff,
        records,
        requests: ds.requestsByStaff.get(staff.id) ?? [],
        settings: ds.settings,
        asOf,
        reasons: ds.reasonBy,
      }),
    });
  }

  rows.sort((a, b) => a.staff.name.localeCompare(b.staff.name));
  return json({ asOf, rows });
}

// ---------------------------------------------------------------------------
// The daily tick
// ---------------------------------------------------------------------------

/**
 * Close off yesterday, and tell somebody what is waiting.
 *
 * Called from the Worker's cron. Two jobs: recompute the last few days so that
 * a punch which arrived late is reflected, and ring the bell once for whatever
 * still needs a person. Once — a notification per exception would be a dozen a
 * morning and everybody would learn to swipe them away.
 */
export async function dailyTick(db, env, today) {
  const from = addDays(today, -3);
  await recompute(db, { from, to: today });

  const yesterday = addDays(today, -1);
  const rows = await db.prepare(
    `SELECT d.status, d.resolution, d.reason_code, s.name
     FROM att_days d JOIN att_staff s ON s.id = d.staff_id
     WHERE d.day = ? AND s.active = 1`,
  ).bind(yesterday).all().catch(() => ({ results: [] }));

  const days = rows.results ?? [];
  const open = days.filter((d) => d.resolution === 'open').length;
  const absent = days.filter((d) => d.status === 'absent').length;

  // Who is on a run long enough to stop being an oversight.
  const escalateAfter = Number(
    (await db.prepare("SELECT value FROM settings WHERE key = 'att_escalate_after'").first()
      .catch(() => null))?.value ?? 3,
  );
  const runs = await db.prepare(
    `SELECT s.name, COUNT(*) AS n
     FROM att_days d JOIN att_staff s ON s.id = d.staff_id
     WHERE d.day BETWEEN ? AND ? AND d.status = 'absent' AND s.active = 1
     GROUP BY s.id HAVING n >= ?`,
  ).bind(addDays(yesterday, -(escalateAfter - 1)), yesterday, escalateAfter)
    .all().catch(() => ({ results: [] }));

  const escalated = (runs.results ?? []).map((r) => r.name);
  const notice = exceptionNotice({ day: yesterday, open, absent, escalated });

  // Three ways of saying the same thing, and none of them is allowed to stop
  // the others. The bell is the one that always works; email needs a key and a
  // recipient, and push needs somebody to have allowed it in their browser.
  if (notice) {
    const payload = {
      day: yesterday, open, absent, escalated, rows: days,
    };
    await createNotice(db, notice);
    await Promise.allSettled([
      pingExceptions(db, payload),
      emailExceptions(db, env, payload),
    ]);
  }

  return { open, absent, escalated: escalated.length };
}
