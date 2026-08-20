import {
  badRequest, csvResponse, int, json, notFound, readJson, str,
} from '../lib/http.js';
import {
  colourFor, computeRange, hours, isOpen, labelFor, leaveBalance, leaveDaysIn,
  calendarFor, dayCredit, dayLedger, daysPerWeekFor, loadDataset, overUnder, rotationWeekOf, scheduleFor, streakOf, summarise, toMinutes,
  weekCountOf,
} from '../lib/attendance.js';
import {
  clockDriftNote, clockOffset, deviceForPushToken, deviceForToken, exceptionNotice,
  ingestPunches, recompute, recomputeTouched,
} from '../lib/attendance-ingest.js';
import { readNotification } from '../lib/push-events.js';
import { inferShifts, mergeCandidates, parseStatusRules, shiftsFromRules } from '../lib/device-shifts.js';
import { getPepper } from '../lib/auth.js';
import { allows } from '../lib/permissions.js';
import { createNotice } from '../lib/notices.js';
import { daysBetween, parseDays } from '../lib/signoff.js';
import { refuseUnsettled } from './signoff.js';
import { emailExceptions, pingExceptions } from '../lib/notify.js';
import {
  addDays, diffDays, dow, isDay, isMonth, monthBounds, nowIn, rangeDays, startOfWeek, todayIn,
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

/** Who did it, in the form every trail in the app records. */
const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

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

/** [0, 1, … n-1] — the weeks of a rotation. */
function rangeOf(n) {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Is this a plain one-week pattern, or a whole cycle keyed by week?
 *
 * The old screen sent `{0: shiftId, 1: shiftId, …}` keyed by weekday. The new
 * one sends `{0: {0: shiftId, …}, 1: {…}}` keyed by week and then weekday. Both
 * are accepted: an app that breaks when a saved bookmark posts last month's
 * shape is an app that has to be updated everywhere at once.
 */
function looksFlat(pattern) {
  return Object.values(pattern).every((value) => value == null || typeof value !== 'object');
}

/**
 * Months already signed off, per person, in days.
 *
 * Read wherever a leave balance is worked out, because a shortfall charged in
 * March has to be in the figure a manager reads in August. Kept in one place so
 * the person's own report, the balances list and the monthly screen cannot
 * quietly disagree about how much leave somebody has left.
 */
async function signedMonths(db, staffId = null) {
  const rows = await (staffId
    ? db.prepare('SELECT staff_id, from_day, days_applied FROM att_period_review WHERE staff_id = ?').bind(staffId)
    : db.prepare('SELECT staff_id, from_day, days_applied FROM att_period_review')
  ).all().catch(() => ({ results: [] }));

  const by = new Map();
  for (const row of rows.results ?? []) {
    if (!by.has(row.staff_id)) by.set(row.staff_id, []);
    by.get(row.staff_id).push(row);
  }
  return by;
}

async function timezoneOf(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first().catch(() => null);
  return row?.value || 'UTC';
}

/**
 * Terminals whose clock has wandered far enough to be worth interrupting
 * somebody about.
 *
 * Measured on every pushed punch and stored on the device row; this only reads
 * it back. Surfaced on the morning screen rather than buried in setup, because
 * the person who notices the reports look wrong is not the person who goes
 * looking at terminal settings — and a wrong clock is one of the few faults
 * here that corrupts the record silently instead of leaving a gap.
 */
async function clockWarnings(db) {
  const [setting, rows] = await Promise.all([
    db.prepare("SELECT value FROM settings WHERE key = 'att_clock_drift_seconds'")
      .first().catch(() => null),
    db.prepare(
      `SELECT name, serial, clock_offset_seconds AS offset_seconds, clock_checked_at
       FROM att_devices WHERE active = 1 AND clock_offset_seconds IS NOT NULL`,
    ).all().catch(() => ({ results: [] })),
  ]);

  // Floored, so that a threshold somebody typed as 0 does not turn every
  // second of network delay into a warning nobody can clear.
  const threshold = Math.max(30, Number(setting?.value) || 180);

  return (rows.results ?? [])
    .filter((row) => Math.abs(Number(row.offset_seconds)) >= threshold)
    .map((row) => ({
      device: row.name,
      serial: row.serial,
      offsetSeconds: Number(row.offset_seconds),
      checkedAt: row.clock_checked_at,
      note: clockDriftNote(row.offset_seconds, row.name),
    }));
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

  // Read the device's clock while we have it. The event was stamped by the
  // terminal a second or two ago, so the gap between that stamp and now is its
  // drift — measured on every tap, at no cost, and stored rather than acted on.
  // Keep the *best* reading of the day, not the latest one.
  //
  // Delay only ever runs one way. A terminal draining a backlog, or posting
  // over a slow link, sends events that look older than they are — never
  // newer. So a low reading may be drift or may be delay, but a high one can
  // only be drift, and the highest reading in a window is the honest estimate.
  //
  // Taking the latest reading instead is what put "66 days slow" on a terminal
  // whose clock was correct to the minute: it had months of stored events to
  // upload, and each old one overwrote the good reading from the live tap.
  //
  // The window resets after twelve hours so a clock that genuinely drifts is
  // still caught, rather than being masked forever by one good morning.
  const offset = clockOffset(events);
  if (offset !== null) {
    await ctx.db.prepare(
      `UPDATE att_devices
          SET clock_offset_seconds = ?1, clock_checked_at = datetime('now')
        WHERE id = ?2
          AND (clock_offset_seconds IS NULL
               OR clock_checked_at IS NULL
               OR ?1 > clock_offset_seconds
               OR clock_checked_at < datetime('now', '-12 hours'))`,
    ).bind(offset, device.id).run().catch(() => {});
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
    // Everything the screens read, and nothing else. The property's own name
    // and address were missing from this list, which is why the header has
    // been showing the fallback name and why a contract had no employer
    // address to print.
    settings: Object.fromEntries(
      Object.entries(ds.settings).filter(([key]) => key.startsWith('att_')
        || ['timezone', 'property_name', 'property_address', 'hr_link_days'].includes(key)),
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

  const [ds, clocks] = await Promise.all([
    loadDataset(ctx.db, {
      from: addDays(target, -7),
      to: addDays(target, 1),
      // Only today needs the clock, and only to stop a shift that has not
      // started being called an absence. Any other day is already over.
      now: target === today ? nowIn(timezone) : null,
    }),
    clockWarnings(ctx.db),
  ]);
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
    clockWarnings: clocks,
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

  // Periods already signed off that touch this range.
  //
  // Sign-off is per span, not per day, so a day cannot carry the fact on its
  // own row — the spans come back instead and the screen marks the days inside
  // them. Without this a settled month looks identical to one nobody has
  // touched, and the same days get gone through twice.
  const spans = await ctx.db.prepare(
    `SELECT kind, from_day, to_day, decision, days_applied, decided_by, decided_at, note,
            excluded_days
       FROM att_period_review
      WHERE staff_id = ?1 AND from_day <= ?3 AND to_day >= ?2
      ORDER BY from_day`,
  ).bind(staffId, from, to).all().catch(() => ({ results: [] }));

  // Every clock time anybody moved inside this range. Returned with the report
  // rather than fetched on demand because the whole value of the register is
  // that it is visible where the figures are read — a trail you have to go
  // looking for is a trail nobody checks.
  const edits = await ctx.db.prepare(
    `SELECT id, day, observed_in, observed_out, was_in, was_out, now_in, now_out,
            reason, actor, at_utc, status, decided_by, decided_at, decision_note
       FROM att_time_edit
      WHERE staff_id = ?1 AND day BETWEEN ?2 AND ?3
      ORDER BY day, id`,
  ).bind(staffId, from, to).all().catch(() => ({ results: [] }));

  return json({
    staff,
    from,
    to,
    days: records.map((r) => present(ds, r)),
    // Split on purpose. What has happened belongs at the foot of the report;
    // what is still waiting belongs on the day itself, where somebody about to
    // sign the period will see it.
    timeEdits: (edits.results ?? []).filter((e) => e.status !== 'pending'),
    pendingTimes: (edits.results ?? []).filter((e) => e.status === 'pending'),
    canFixTimes: allows('att_times', ctx.session.permissions),
    canApproveTimes: allows('att_setup', ctx.session.permissions),
    totals: summarise(records, { shifts: ds.shiftById, reasons: ds.reasonBy }),
    signedSpans: (spans.results ?? []).map((r) => ({
      kind: r.kind,
      from: r.from_day,
      to: r.to_day,
      decision: r.decision,
      daysApplied: r.days_applied,
      by: r.decided_by,
      at: r.decided_at,
      note: r.note,
      // The days inside the span that were deliberately left out. Without
      // these the screen has no way to tell a day that was signed from a day
      // that merely sits between two that were, and marks the whole range as
      // settled — which is the opposite of what leaving it out meant.
      excluded: parseDays(r.excluded_days),
    })),
    // Stripped for anybody who can sign a period off but may not see balances.
    //
    // Done here rather than in the screen, because the screen is a courtesy and
    // this is the gate: a planner opening this endpoint directly must not be
    // handed the number the whole role exists to withhold.
    leave: allows('att_reports', ctx.session.permissions)
      ? leaveBalance({
        staff,
        records: yearRecords,
        requests: ds.requestsByStaff.get(staffId) ?? [],
        settings: ds.settings,
        asOf: to,
        reasons: ds.reasonBy,
        adjustments: (await signedMonths(ctx.db, staffId)).get(staffId) ?? [],
      })
      : null,
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

  // Whoever builds the rota can read this month — they need to know who has
  // been absent and who is over their hours before they build the next one —
  // but not how much leave anybody has left. A rota built around who is
  // running out of days is a rota built around the wrong thing, and that has
  // been the point of the role since it existed.
  //
  // Stripped here rather than on the screen. The screen hiding a column is a
  // courtesy; this is the gate, and a planner opening the endpoint directly
  // must not be handed the number the whole role exists to withhold.
  const showsLeave = allows('att_reports', ctx.session.permissions);

  const [ds, yearByStaff, signedBy] = await Promise.all([
    loadDataset(ctx.db, { from: addDays(from, -1), to: addDays(to, 1) }),
    showsLeave ? yearToDateAll(ctx.db, `${to.slice(0, 4)}-01-01`, to) : new Map(),
    showsLeave ? signedMonths(ctx.db) : new Map(),
  ]);
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
      leave: showsLeave
        ? leaveBalance({
          staff,
          adjustments: signedBy.get(staff.id) ?? [],
          records: yearRecords,
          requests: ds.requestsByStaff.get(staff.id) ?? [],
          settings: ds.settings,
          asOf: to,
          reasons: ds.reasonBy,
        })
        : null,
    });
  }

  rows.sort((a, b) => a.staff.name.localeCompare(b.staff.name));
  return json({ from, to, month: from.slice(0, 7), rows, showsLeave });
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

/**
 * Just the ones that need somebody, as a file.
 *
 * The morning screen's own list, downloaded. A supervisor going round the
 * building wants the eight names with something wrong against them and not the
 * ninety who turned up; the full export is the payroll extract and answers a
 * different question at the wrong length.
 *
 * Reachable with the permission that opens the morning screen rather than the
 * one that opens the reports. There is nothing in here that is not already on
 * that screen — no wages, no leave balances, no rates — so gating it behind
 * the reports permission would only mean the person actually doing the chasing
 * has to ask somebody else for a copy of what they are looking at.
 *
 * A day by default, because that is the screen it is offered from, and any
 * range on request: the same person on a Monday wants everything still
 * outstanding since Friday, and that is one file rather than three.
 */
export async function exportIssues(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const single = readDay(ctx.url.searchParams.get('day'), null);
  const { from, to } = single
    ? { from: single, to: single }
    : readRange(ctx.url, timezone, { days: 7, maxDays: 62 });

  const ds = await loadDataset(ctx.db, { from: addDays(from, -1), to: addDays(to, 1) });

  const rows = [[
    'Date', 'Needs', 'Employee no', 'Name', 'Department', 'Shift',
    'Scheduled start', 'Scheduled end', 'Clock in', 'Clock out', 'Hours',
    'Late (min)', 'Early (min)', 'Status', 'Reason', 'What it means',
    'Settled by', 'Settled note',
  ]];

  for (const staff of ds.staff) {
    for (const record of daysFor(ds, staff.id, from, to)) {
      if (!activeOn(staff, record.day)) continue;

      // The same three groups the screen shows, decided the same way, so the
      // file and the page can never disagree about what counts as a problem.
      const colour = colourFor(record, ds.reasonBy);
      const needs = isOpen(record)
        ? 'Waiting on a decision'
        : colour === 'red' ? 'Absent'
          : colour === 'amber' ? 'Late or left early' : null;
      if (!needs) continue;

      const shift = record.shift_id ? ds.shiftById.get(record.shift_id) : null;
      const reason = ds.reasonBy.get(record.reason_code);
      rows.push([
        record.day, needs, staff.employee_no, staff.name, staff.department ?? '',
        shift?.name ?? '', shift?.starts_at ?? '', shift?.ends_at ?? '',
        record.first_in ?? '', record.last_out ?? '', hours(record.worked_minutes),
        record.late_minutes, record.early_minutes,
        labelFor(record, ds.reasonBy), reason?.label ?? record.reason_code ?? '',
        record.note ?? '',
        record.resolved_by ?? '', record.resolved_note ?? '',
      ]);
    }
  }

  // Worst first, then by name, so the file opens on what matters rather than
  // on whoever happens to be first alphabetically. Sorted here and not left to
  // the spreadsheet, because most people never sort it.
  const order = { 'Waiting on a decision': 0, Absent: 1, 'Late or left early': 2 };
  const body = rows.slice(1).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1
    : (order[a[1]] - order[b[1]]) || String(a[3]).localeCompare(String(b[3]))));

  return csvResponse(
    from === to ? `attendance-issues-${from}.csv` : `attendance-issues-${from}-to-${to}.csv`,
    [rows[0], ...body],
  );
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

  // Read before the write, because settling a day supplies clock times too and
  // those belong in the same register as the ones supplied on their own.
  const before = await timesBefore(ctx, staffId, target);

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

  if (before.wasIn !== correctedIn || before.wasOut !== correctedOut) {
    await recordTimeEdit(ctx, {
      staff, day: target, ...before, nowIn: correctedIn, nowOut: correctedOut,
      reason: note ? `${reason.label} — ${note}` : reason.label,
    });
  }

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

  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!staff) throw notFound('No such member of staff.');
  const before = await timesBefore(ctx, staffId, target);

  await ctx.db.prepare(
    `UPDATE att_days SET resolution = 'open', resolved_by = NULL, resolved_at = NULL,
                         resolved_note = NULL, corrected_in = NULL, corrected_out = NULL
     WHERE staff_id = ? AND day = ?`,
  ).bind(staffId, target).run();

  await recompute(ctx.db, { staffIds: [staffId], from: target, to: target });
  await audit(ctx, 'attendance.unresolve', `${staffId}|${target}`, null);

  // Taking a correction off is a change to the clock times as much as putting
  // one on, and a register that recorded only the additions would show times
  // still standing that nobody can find on the record.
  if (before.wasIn || before.wasOut) {
    await recordTimeEdit(ctx, {
      staff, day: target, ...before, nowIn: null, nowOut: null,
      reason: 'The ruling was undone — back to what the terminal saw',
    });
  }

  const ds = await loadDataset(ctx.db, { from: addDays(target, -1), to: addDays(target, 1) });
  const [record] = daysFor(ds, staffId, target, target);
  return json({ ok: true, day: present(ds, record) });
}

/**
 * Putting a clock time right, without ruling on the day.
 *
 * The correction whoever builds the rota actually needs to make. They are the
 * person who knows the kitchen closed at nine, so they are the person who
 * notices that the terminal read Kofi out at 17:02 — and until this existed
 * they had to find somebody with the permission that also approves leave and
 * ask them to type it in. Corrections that need a second person are
 * corrections that do not get made.
 *
 * Three things hold it in place, and all three are the point rather than
 * decoration.
 *
 * The punches are never touched. `att_punches` is what the terminal saw and
 * stays what the terminal saw; this writes an opinion beside it.
 *
 * No reason is asked for and no status is set. Saying "they left at 21:00" is
 * not the same as saying "this day is present" — the rules work the verdict out
 * from the corrected times, so the hours, the lateness and the overtime all
 * follow on their own. Whoever holds the larger permission can still settle the
 * day outright; this is deliberately the smaller act.
 *
 * And every change is written down and the administrators are told. That is
 * what makes it safe to hand out: not that the edit is restricted, but that it
 * is impossible to make one quietly.
 */
export async function correctTimes(ctx, dayParam) {
  const target = readDay(dayParam);
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });
  const reason = str(body.reason, 'Reason', { required: true, max: 400 });

  const correctedIn = readClock(body.in, 'Clock-in');
  const correctedOut = readClock(body.out, 'Clock-out');

  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!staff) throw notFound('No such member of staff.');

  const before = await timesBefore(ctx, staffId, target);
  const pending = await pendingFor(ctx, staffId, target);

  // Compared against whatever is currently standing — the pending request if
  // there is one, otherwise what is on the day. Otherwise somebody who typed
  // 21:00 twice raises the same request twice and the queue fills with copies.
  const standingIn = pending ? pending.now_in : before.wasIn;
  const standingOut = pending ? pending.now_out : before.wasOut;
  if (standingIn === correctedIn && standingOut === correctedOut) {
    throw badRequest(pending
      ? 'That change is already waiting for an administrator.'
      : 'Those are the times already recorded — nothing to change.');
  }

  // Whoever can approve does not queue behind themselves. A queue with one name
  // in it teaches everybody to press the button without reading it.
  const approves = allows('att_setup', ctx.session.permissions);

  // A second thought replaces the first rather than joining it in the queue.
  // Two contradictory requests on one day is a question nobody can answer.
  if (pending) {
    await ctx.db.prepare(
      `UPDATE att_time_edit SET status = 'superseded', decided_by = ?1,
                                decided_at = datetime('now')
        WHERE id = ?2`,
    ).bind(actorOf(ctx), pending.id).run();
  }

  const editId = await recordTimeEdit(ctx, {
    staff,
    day: target,
    ...before,
    nowIn: correctedIn,
    nowOut: correctedOut,
    reason,
    status: approves ? 'approved' : 'pending',
    // Told every time, as asked — and when it is waiting on them, told as
    // something to do rather than something that happened.
    always: true,
    level: approves ? undefined : 'high',
  });

  if (!approves) {
    return json({
      ok: true,
      pending: true,
      requestId: editId,
      message: 'Sent to an administrator. Nothing has changed on the day yet.',
    });
  }

  await applyTimes(ctx, {
    staff, day: target, correctedIn, correctedOut, note: reason, by: actorOf(ctx),
  });

  const ds = await loadDataset(ctx.db, { from: addDays(target, -1), to: addDays(target, 1) });
  const [record] = daysFor(ds, staffId, target, target);
  return json({ ok: true, pending: false, day: present(ds, record) });
}

/** The change already waiting on this day, if there is one. */
async function pendingFor(ctx, staffId, day) {
  return ctx.db.prepare(
    `SELECT * FROM att_time_edit
      WHERE staff_id = ? AND day = ? AND status = 'pending'
      ORDER BY id DESC LIMIT 1`,
  ).bind(staffId, day).first().catch(() => null);
}

/**
 * Put the times on the day, and close it.
 *
 * The order is the argument. The corrected times go on first and the day is
 * recomputed from them, so the verdict — present, late, absent — is worked out
 * by the rules rather than chosen by whoever pressed approve. Only then is that
 * verdict written down as settled.
 *
 * Settling it here is deliberate. A day two people have now looked at should
 * not still be sitting on somebody's list of things to deal with, and the
 * approval is exactly the second look. It can still be undone: "Undo" on the
 * day puts it back to what the terminal saw, and that too is recorded.
 */
async function applyTimes(ctx, { staff, day, correctedIn, correctedOut, note, by }) {
  const prior = await ctx.db.prepare(
    'SELECT status, reason_code, resolution, resolved_note FROM att_days WHERE staff_id = ? AND day = ?',
  ).bind(staff.id, day).first();

  // A day this feature closed last time, as opposed to one a supervisor ruled
  // on. The two are told apart by the note, because they must be treated
  // differently: our own ruling is reopened so the verdict follows the new
  // times, and somebody else's is left exactly where they put it. A supervisor
  // who decided a Tuesday was sick leave does not have that overturned by a
  // clock correction, and the doctrine that a human ruling survives
  // recomputation would mean nothing if this route quietly ignored it.
  const ours = prior?.resolution === 'resolved'
    && String(prior.resolved_note ?? '').startsWith(SETTLED_BY_CORRECTION);

  // A day nobody has ruled on and nobody has corrected may not exist as a row
  // yet — an untouched future day, or one the recompute has not reached.
  await ctx.db.prepare(
    `INSERT INTO att_days (staff_id, day, corrected_in, corrected_out)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (staff_id, day) DO UPDATE SET
       corrected_in = excluded.corrected_in,
       corrected_out = excluded.corrected_out`,
  ).bind(staff.id, day, correctedIn, correctedOut).run();

  if (ours) {
    await ctx.db.prepare(
      `UPDATE att_days SET resolution = 'settled', resolved_by = NULL, resolved_at = NULL,
                           resolved_note = NULL
        WHERE staff_id = ? AND day = ?`,
    ).bind(staff.id, day).run();
  }

  await recompute(ctx.db, { staffIds: [staff.id], from: day, to: day });

  // Clearing both boxes is a correction withdrawn, not a day settled. There is
  // nothing to close: the day goes back to what the terminal saw and to
  // whatever the rules make of it.
  if (!correctedIn && !correctedOut) return;

  // And somebody else's ruling stands. The times went on — they still decide
  // the hours — but the verdict stays theirs.
  if (prior?.resolution === 'resolved' && !ours) return;

  const settled = await ctx.db.prepare(
    'SELECT status, reason_code FROM att_days WHERE staff_id = ? AND day = ?',
  ).bind(staff.id, day).first();

  await ctx.db.prepare(
    `UPDATE att_days
        SET status = ?3, reason_code = ?4, resolution = 'resolved',
            resolved_by = ?5, resolved_at = datetime('now'), resolved_note = ?6
      WHERE staff_id = ?1 AND day = ?2`,
  ).bind(
    staff.id, day,
    settled?.status ?? 'present',
    settled?.reason_code ?? 'present',
    by,
    `${SETTLED_BY_CORRECTION}${note ? `: ${note}` : ''}`.slice(0, 500),
  ).run();

  await recompute(ctx.db, { staffIds: [staff.id], from: day, to: day });
}

/**
 * How a day settled by an approved correction announces itself.
 *
 * Read back later to tell our own ruling from a supervisor's, so the second
 * kind is never overwritten. Changing this string orphans the days already
 * carrying it — they become somebody else's ruling and stop being reopened.
 */
const SETTLED_BY_CORRECTION = 'Clock times corrected';

/**
 * An administrator's answer to a correction somebody asked for.
 *
 * Approving applies the times and closes the day. Sending it back changes
 * nothing — the day stays exactly as the terminal left it — and says why, so
 * whoever asked knows what to do instead rather than only that the answer was
 * no.
 */
export async function decideTimeEdit(ctx, idParam) {
  const id = int(idParam, 'Request', { required: true, min: 1 });
  const body = await readJson(ctx.request);
  const decision = str(body.decision, 'Decision', { required: true, max: 20 });
  if (!['approve', 'reject'].includes(decision)) {
    throw badRequest('A request is either approved or sent back.');
  }
  const note = str(body.note, 'Note', { max: 500 });
  if (decision === 'reject' && !note) {
    throw badRequest('Say why, so whoever asked knows what to do instead.');
  }

  const request = await ctx.db.prepare(
    'SELECT * FROM att_time_edit WHERE id = ?',
  ).bind(id).first();
  if (!request) throw notFound('No such request.');
  if (request.status !== 'pending') {
    throw badRequest(`That was already ${request.status} — by ${request.decided_by ?? 'somebody'}.`);
  }

  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?')
    .bind(request.staff_id).first();
  if (!staff) throw notFound('No such member of staff.');

  await ctx.db.prepare(
    `UPDATE att_time_edit
        SET status = ?2, decided_by = ?3, decided_at = datetime('now'), decision_note = ?4
      WHERE id = ?1`,
  ).bind(id, decision === 'approve' ? 'approved' : 'rejected', actorOf(ctx), note || null).run();

  if (decision === 'approve') {
    await applyTimes(ctx, {
      staff,
      day: request.day,
      correctedIn: request.now_in,
      correctedOut: request.now_out,
      note: request.reason,
      by: `${request.actor}, approved by ${actorOf(ctx)}`,
    });
  }

  await audit(ctx, `attendance.times.${decision}`, `${request.staff_id}|${request.day}`, {
    request: id, in: request.now_in, out: request.now_out, note,
  });

  // Back to whoever asked. There is no way to address one person — a notice is
  // held against a permission so it still reaches somebody promoted tomorrow —
  // so it goes to everybody who can make a correction, named in the title.
  await createNotice(ctx.db, {
    kind: 'attendance.times',
    level: decision === 'approve' ? 'info' : 'warn',
    title: decision === 'approve'
      ? `Approved: ${staff.name}'s clock times on ${request.day}`
      : `Sent back: ${staff.name}'s clock times on ${request.day}`,
    body: decision === 'approve'
      ? `${request.actor} asked, ${actorOf(ctx)} approved. The day has been settled.`
        + `${note ? ` — ${note}` : ''}`
      : `${request.actor} asked. ${actorOf(ctx)} sent it back: ${note}`,
    link: `#/att-staff?id=${staff.id}&day=${request.day}&period=day`,
    day: request.day,
    actor: actorOf(ctx),
    audience: 'att_times',
  }, ctx);

  return json({ ok: true, decision });
}

/**
 * What the clock said before somebody touched it.
 *
 * Two different questions, and the second one is the reason this is not one
 * line. `was_in`/`was_out` is the correction that stood; `observed_in`/
 * `observed_out` is what the terminal itself read. The second cannot be taken
 * from `att_days` once a correction is in place, because a correction rewrites
 * `first_in` and `last_out` — that is what makes the hours come out right. So
 * the observation is carried forward from the last entry in the register,
 * which is exactly why the register stores it.
 */
async function timesBefore(ctx, staffId, day) {
  const load = () => ctx.db.prepare(
    'SELECT corrected_in, corrected_out, first_in, last_out FROM att_days WHERE staff_id = ? AND day = ?',
  ).bind(staffId, day).first();

  let existing = await load();
  // A day nobody has looked at may not have been computed yet — a punch that
  // arrived while the recompute was failing, or a day whose row was cleared.
  // Working it out now costs one day for one person, and the alternative is a
  // register that says the terminal saw nothing when it plainly did.
  if (!existing) {
    await recompute(ctx.db, { staffIds: [staffId], from: day, to: day });
    existing = await load();
  }

  const wasIn = existing?.corrected_in ?? null;
  const wasOut = existing?.corrected_out ?? null;

  const previous = (wasIn || wasOut)
    ? await ctx.db.prepare(
      `SELECT observed_in, observed_out FROM att_time_edit
        WHERE staff_id = ? AND day = ? ORDER BY id DESC LIMIT 1`,
    ).bind(staffId, day).first().catch(() => null)
    : null;

  return {
    wasIn,
    wasOut,
    observedIn: previous ? previous.observed_in : existing?.first_in ?? null,
    observedOut: previous ? previous.observed_out : existing?.last_out ?? null,
  };
}

/**
 * Write one change down, and tell the administrators.
 *
 * Shared by both routes that can move a clock time, so the trail is the whole
 * truth rather than the part of it that came through the new door. Settling a
 * day supplies times too, and a register of time changes that quietly omitted
 * those would be worse than no register at all.
 *
 * Who hears about it differs, and deliberately. A correction made on its own is
 * announced every time — that is what was asked for, and it is the whole reason
 * the permission is safe to hand out. Settling a day announces itself only when
 * the time it supplies contradicts something the terminal actually recorded:
 * filling in a clock-out the device never saw is the ordinary morning's work,
 * happens several times a day, and a bell that rang for all of it would be
 * silenced within the week.
 */
async function recordTimeEdit(ctx, {
  staff, day, observedIn, observedOut, wasIn, wasOut, nowIn, nowOut, reason,
  always = false, status = 'approved', level = undefined,
}) {
  const written = await ctx.db.prepare(
    `INSERT INTO att_time_edit
       (staff_id, day, observed_in, observed_out, was_in, was_out, now_in, now_out,
        reason, actor, actor_id, ip, status, decided_by, decided_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     RETURNING id`,
  ).bind(
    staff.id, day, observedIn, observedOut, wasIn, wasOut, nowIn, nowOut,
    reason || 'No reason given', actorOf(ctx), ctx.session.user.id ?? null,
    ctx.request.headers.get('CF-Connecting-IP') || null,
    status,
    // An approver's own change is decided the moment it is made, and saying so
    // keeps the register honest: every applied row names who stood behind it.
    status === 'approved' ? actorOf(ctx) : null,
    status === 'approved' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
  ).first().catch(() => null);

  await audit(ctx, 'attendance.times', `${staff.id}|${day}`, {
    was: { in: wasIn, out: wasOut },
    now: { in: nowIn, out: nowOut },
    observed: { in: observedIn, out: observedOut },
    reason,
  });

  const contradicts = Boolean((nowIn && observedIn && nowIn !== observedIn)
    || (nowOut && observedOut && nowOut !== observedOut)
    || (!nowIn && wasIn) || (!nowOut && wasOut));
  if (!always && !contradicts) return written?.id ?? null;

  // Addressed to the setup permission because that is the one administrators
  // hold and managers do not. A notice that reached everybody who can settle a
  // day would be read by nobody.
  const waiting = status === 'pending';
  await createNotice(ctx.db, {
    kind: 'attendance.times',
    level: level ?? (contradicts ? 'warn' : 'info'),
    title: waiting
      ? `Approve: ${staff.name}'s clock times on ${day}`
      : `${staff.name}: clock times changed on ${day}`,
    body: `${describeChange('In', observedIn, wasIn, nowIn)}. `
      + `${describeChange('Out', observedOut, wasOut, nowOut)}.${reason ? ` — ${reason}` : ''}`
      + `${waiting ? ' Nothing has changed on the day until you approve it.' : ''}`.slice(0, 400),
    link: waiting
      ? '#/signoff?tab=times'
      : `#/att-staff?id=${staff.id}&day=${day}&period=day`,
    day,
    actor: actorOf(ctx),
    audience: 'att_setup',
  }, ctx);

  return written?.id ?? null;
}

/** One line of the trail, in the words somebody reading the bell would use. */
function describeChange(side, observed, was, now) {
  const from = was ?? observed;
  if (!now && from) return `${side} ${from} → back to what the terminal saw`;
  if (!now) return `${side} unchanged`;
  if (!from) return `${side} set to ${now} (terminal saw nothing)`;
  if (from === now) return `${side} unchanged at ${now}`;
  return `${side} ${from} → ${now}`;
}

/**
 * Every clock time anybody has changed.
 *
 * The administrator's side of the bell: the notice says one thing happened, and
 * this says what has been happening. Filterable by person and by date because
 * the two questions ever asked of it are "what did this person's week look
 * like before somebody touched it" and "what changed last month".
 */
export async function timeEdits(ctx) {
  const staffId = ctx.url.searchParams.get('staffId');
  const from = readDay(ctx.url.searchParams.get('from'), null);
  const to = readDay(ctx.url.searchParams.get('to'), null);
  const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 200, 500);

  const where = ['1 = 1'];
  const binds = [];
  if (staffId) { where.push(`e.staff_id = ?${binds.length + 1}`); binds.push(Number(staffId)); }
  if (from) { where.push(`e.day >= ?${binds.length + 1}`); binds.push(from); }
  if (to) { where.push(`e.day <= ?${binds.length + 1}`); binds.push(to); }
  binds.push(limit);

  const rows = await ctx.db.prepare(
    `SELECT e.*, s.name AS staff_name, s.employee_no, s.department
       FROM att_time_edit e JOIN att_staff s ON s.id = e.staff_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.id DESC LIMIT ?${binds.length}`,
  ).bind(...binds).all();

  // Waiting requests are never windowed by the dates on screen. A change asked
  // for on a day outside the period somebody happens to be looking at is still
  // waiting on them, and a queue that hides depending on where you are stood is
  // a queue that grows quietly.
  const waiting = await ctx.db.prepare(
    `SELECT e.*, s.name AS staff_name, s.employee_no, s.department
       FROM att_time_edit e JOIN att_staff s ON s.id = e.staff_id
      WHERE e.status = 'pending'
      ORDER BY e.id DESC LIMIT 200`,
  ).bind().all().catch(() => ({ results: [] }));

  return json({
    edits: (rows.results ?? []).filter((e) => e.status !== 'pending'),
    pending: waiting.results ?? [],
    canApprove: allows('att_setup', ctx.session.permissions),
  });
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
  const shifts = ds.shifts.filter((s) => s.active);

  // How many people each shift has on each day. The number a rota is actually
  // built to answer — "is anybody on nights on Sunday" — and the one a grid of
  // dropdowns hides in plain sight until somebody does not turn up.
  const coverage = days.map((day) => {
    const counts = Object.fromEntries(shifts.map((shift) => [shift.id, 0]));
    let off = 0;
    let onLeave = 0;

    for (const staff of ds.staff) {
      if (!staff.active) continue;
      if (ds.leaveBy.has(`${staff.id}|${day}`)) { onLeave += 1; continue; }
      const shift = scheduleFor(ds, staff.id, day).shift;
      if (shift && counts[shift.id] != null) counts[shift.id] += 1;
      else off += 1;
    }

    return { day, counts, off, onLeave, holiday: ds.holidayBy.get(day)?.name ?? null };
  });

  return json({
    from,
    to,
    days,
    coverage,
    shifts,
    rows: ds.staff.filter((s) => s.active).map((staff) => ({
      staff: { id: staff.id, name: staff.name, employee_no: staff.employee_no, department: staff.department },
      // The whole cycle, one entry per week, so the dialog can show a rotation
      // without asking for it a week at a time.
      rotationWeeks: Math.max(1, Number(staff.rotation_weeks) || 1),
      pattern: Object.fromEntries(
        rangeOf(Math.max(1, Number(staff.rotation_weeks) || 1)).map((w) => [
          w,
          Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [
            d, ds.patternBy.get(`${staff.id}|${w}|${d}`)?.shift_id ?? null,
          ])),
        ]),
      ),
      hasPattern: rangeOf(Math.max(1, Number(staff.rotation_weeks) || 1))
        .some((w) => [0, 1, 2, 3, 4, 5, 6].some((d) => ds.patternBy.has(`${staff.id}|${w}|${d}`))),
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
 * Copy one week's rota onto another.
 *
 * The single action that decides whether maintaining a rota here is a chore or
 * a habit. Most weeks are last week with two changes, and typing the other
 * hundred cells again is the reason people go back to a spreadsheet.
 *
 * Two rules keep it from being destructive in ways nobody expects:
 *
 *  - **Approved leave is never overwritten.** Somebody booked off next Tuesday
 *    stays booked off, whatever last Tuesday said.
 *  - **A day that matches the standing pattern anyway is left alone** rather
 *    than written as an override. Otherwise one press would turn the whole grid
 *    from "following the pattern" to "set by hand", and the distinction the
 *    screen is built around would be gone by Wednesday.
 */
export async function copyRoster(ctx) {
  const body = await readJson(ctx.request);
  const fromWeek = startOfWeek(readDay(body.from));
  const toWeek = startOfWeek(readDay(body.to));
  if (fromWeek === toWeek) throw badRequest('That is the same week.');

  const span = Math.max(1, Math.min(int(body.weeks ?? 1, 'Weeks', { min: 1, max: 8 }), 8));
  const dayCount = span * 7;

  // Both weeks in one load, plus a day either side for the overnight case.
  const lo = fromWeek < toWeek ? fromWeek : toWeek;
  const hi = addDays(fromWeek < toWeek ? toWeek : fromWeek, dayCount);
  const ds = await loadDataset(ctx.db, { from: addDays(lo, -1), to: hi });

  const actor = `${ctx.session.user.name} (${ctx.session.user.role})`;
  const statements = [];
  const touched = new Map();
  let copied = 0;
  let skippedLeave = 0;

  for (const staff of ds.staff) {
    if (!staff.active) continue;

    for (let offset = 0; offset < dayCount; offset++) {
      const sourceDay = addDays(fromWeek, offset);
      const targetDay = addDays(toWeek, offset);

      // Somebody who had not started, or has since left, is not rostered by
      // copying a week they were never part of.
      if (staff.hired_on && targetDay < staff.hired_on) continue;
      if (staff.left_on && targetDay > staff.left_on) continue;

      if (ds.leaveBy.has(`${staff.id}|${targetDay}`)) { skippedLeave += 1; continue; }

      const source = scheduleFor(ds, staff.id, sourceDay);
      const patternHere = ds.patternBy.get(
        `${staff.id}|${rotationWeekOf(targetDay, staff.rotation_weeks, ds.rotationAnchor)}|${dow(targetDay)}`,
      );
      const patternShift = patternHere ? patternHere.shift_id : undefined;
      const wanted = source.shift?.id ?? null;

      if (patternShift === wanted) {
        // The pattern already says this. Drop any override so the cell goes
        // back to being pattern-driven rather than pinned.
        statements.push(ctx.db.prepare(
          'DELETE FROM att_roster WHERE staff_id = ? AND day = ?',
        ).bind(staff.id, targetDay));
      } else {
        statements.push(ctx.db.prepare(
          `INSERT INTO att_roster (staff_id, day, shift_id, set_by, set_at)
           VALUES (?1, ?2, ?3, ?4, datetime('now'))
           ON CONFLICT (staff_id, day) DO UPDATE SET
             shift_id = excluded.shift_id, set_by = excluded.set_by, set_at = excluded.set_at`,
        ).bind(staff.id, targetDay, wanted, actor));
        copied += 1;
      }

      const range = touched.get(staff.id) ?? { from: targetDay, to: targetDay };
      if (targetDay < range.from) range.from = targetDay;
      if (targetDay > range.to) range.to = targetDay;
      touched.set(staff.id, range);
    }
  }

  for (let i = 0; i < statements.length; i += 100) {
    await ctx.db.batch(statements.slice(i, i + 100));
  }
  await recomputeTouched(ctx.db, touched);
  await audit(ctx, 'attendance.roster_copy', null, {
    from: fromWeek, to: toWeek, weeks: span, copied, skippedLeave,
  });

  return json({
    ok: true, from: fromWeek, to: toWeek, weeks: span, copied, skippedLeave,
  });
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

  // How long the cycle is. One week is somebody who works the same days every
  // week — the common case, and the shape the old one-week pattern had.
  const weeks = int(body.rotationWeeks ?? 1, 'Weeks in the cycle', { min: 1, max: 12 });

  // Two shapes accepted, because one of them is what the old screen sent and
  // history should not have to be rewritten to change a rota: a flat
  // `{dow: shift}` is read as week zero of a one-week cycle.
  const byWeek = looksFlat(pattern) ? { 0: pattern } : pattern;

  const statements = [
    ctx.db.prepare('UPDATE att_staff SET rotation_weeks = ?1 WHERE id = ?2').bind(weeks, staffId),
    ctx.db.prepare('DELETE FROM att_patterns WHERE staff_id = ?').bind(staffId),
  ];

  for (let week = 0; week < weeks; week += 1) {
    const forWeek = byWeek[week] ?? byWeek[String(week)] ?? null;
    if (!forWeek || typeof forWeek !== 'object') continue;

    for (const dowKey of [0, 1, 2, 3, 4, 5, 6]) {
      const value = forWeek[dowKey] ?? forWeek[String(dowKey)];
      // Undefined means "say nothing about this weekday"; null means a rest day.
      if (value === undefined) continue;
      statements.push(ctx.db.prepare(
        'INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (?, ?, ?, ?)',
      ).bind(staffId, week, dowKey, value == null ? null : int(value, 'Shift', { min: 1 })));
    }
  }

  await ctx.db.batch(statements);

  // The pattern only shows where no override exists, so recomputing the weeks
  // around today is enough to make the change visible without rebuilding a year.
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  await recompute(ctx.db, { staffIds: [staffId], from: addDays(today, -90), to: addDays(today, 90) });
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
  const [ds, yearByStaff, signedBy] = await Promise.all([
    loadDataset(ctx.db, { from: asOf, to: asOf }),
    yearToDateAll(ctx.db, `${asOf.slice(0, 4)}-01-01`, asOf),
    signedMonths(ctx.db),
  ]);

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
        adjustments: signedBy.get(staff.id) ?? [],
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
    // Bell only, and deliberately. The digest below carries exactly this
    // information by mail already; sending the notice as well would put two
    // emails about the same morning in the same inbox, which is how people
    // learn to ignore both.
    await createNotice(db, notice);
    await Promise.allSettled([
      pingExceptions(db, payload),
      emailExceptions(db, env, payload),
    ]);
  }

  return { open, absent, escalated: escalated.length };
}

// ---------------------------------------------------------------------------
// The reckoning: a day, a week or a month
// ---------------------------------------------------------------------------

/** The window being reckoned up, from either a month or an explicit range. */
function reviewWindow(url, timezone) {
  const month = url.searchParams.get('month');
  if (month) {
    if (!isMonth(month)) throw badRequest('That is not a month like 2026-08.');
    return { ...monthBounds(month), kind: 'month' };
  }

  const to = readDay(url.searchParams.get('to'), todayIn(timezone));
  const from = readDay(url.searchParams.get('from'), to);
  if (from > to) throw badRequest('The start date is after the end date.');
  if (diffDays(from, to) > 400) throw badRequest('That is more than a year. Choose a shorter period.');
  return { from, to, kind: kindOf(from, to) };
}

/** A label for the span. Only ever a label — every rule below works on dates. */
function kindOf(from, to) {
  if (from === to) return 'day';
  const { from: mFrom, to: mTo } = monthBounds(from.slice(0, 7));
  if (from === mFrom && to === mTo) return 'month';
  if (diffDays(from, to) === 6) return 'week';
  return 'period';
}

/**
 * Days owed against days worked, for a span, for everybody in it.
 *
 * The two numbers come from the same rules every other screen uses and are
 * never stored, so a shift corrected this morning or a supervisor's ruling from
 * yesterday changes them — right up until somebody signs the span off. What is
 * stored is only the decision.
 */
export async function periodReview(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const { from, to, kind } = reviewWindow(ctx.url, timezone);

  // One person, when a screen is already looking at one person. The whole
  // property is a lot to load to answer a question about a single row.
  const only = ctx.url.searchParams.get('staffId');
  const onlyId = only ? int(only, 'Staff', { min: 1 }) : null;

  const [ds, signed] = await Promise.all([
    loadDataset(ctx.db, { from, to }),
    ctx.db.prepare(
      `SELECT * FROM att_period_review
        WHERE from_day <= ?2 AND to_day >= ?1
        ORDER BY from_day`,
    ).bind(from, to).all().catch(() => ({ results: [] })),
  ]);

  const signedBy = new Map();
  for (const row of signed.results ?? []) {
    if (!signedBy.has(row.staff_id)) signedBy.set(row.staff_id, []);
    signedBy.get(row.staff_id).push(row);
  }

  const overMinutes = Math.max(0, Number(ds.settings.att_over_minutes) || 360);
  const rows = [];

  for (const staff of ds.staff) {
    if (onlyId && staff.id !== onlyId) continue;
    if (!activeOn(staff, to) && !activeOn(staff, from)) continue;

    const days = daysFor(ds, staff.id, from, to);
    const totals = summarise(days, { shifts: ds.shiftById, reasons: ds.reasonBy });
    const overlapping = signedBy.get(staff.id) ?? [];

    // The one that is this span exactly, as opposed to one that merely touches
    // it. Only an exact match can be reopened from here.
    const exact = overlapping.find((r) => r.from_day === from && r.to_day === to) ?? null;

    if (!onlyId && !totals.scheduled && !totals.daysWorked && !overlapping.length) continue;

    const oc = overUnder(days, {
      holidays: ds.holidayBy,
      expected: totals.scheduled > 0,
      perWeek: daysPerWeekFor(staff, ds.settings),
      calendar: calendarFor(ds, staff.id),
    });
    const counted = new Map([
      ...oc.overs.map((o) => [o.day, 'over']),
      ...oc.unders.map((u) => [u.day, 'under']),
    ]);

    // Every day behind the figures, so each of them can be opened rather than
    // merely believed. Sent once and filtered in the screen.
    const detail = days.map((r) => ({
      day: r.day,
      shift: r.shift_id ? ds.shiftById.get(r.shift_id)?.name ?? null : null,
      scheduled: Boolean(r.scheduled),
      in: r.first_in,
      out: r.last_out,
      minutes: r.worked_minutes,
      credit: dayCredit(r, {
        shift: r.shift_id ? ds.shiftById.get(r.shift_id) ?? null : null,
        reason: r.reason_code ? ds.reasonBy.get(r.reason_code) ?? null : null,
      }),
      status: r.status,
      scheduled: Boolean(r.scheduled),
      label: labelFor(r, ds.reasonBy),
      resolvedBy: r.resolved_by ?? null,
      counts: counted.get(r.day) ?? null,
      // The two sides of the ledger, per day, so any subset of them adds up to
      // the same answer as the whole month.
      ...dayLedger(r, {
        holidays: ds.holidayBy,
        perWeek: daysPerWeekFor(staff, ds.settings),
        calendar: calendarFor(ds, staff.id),
      }),
      // `credit` above is the half-a-day-for-a-short-shift figure the reports
      // use, and stays what it was.
      credit: dayCredit(r, {
        shift: r.shift_id ? ds.shiftById.get(r.shift_id) ?? null : null,
        reason: r.reason_code ? ds.reasonBy.get(r.reason_code) ?? null : null,
      }),
    }));

    rows.push({
      staff: {
        id: staff.id, name: staff.name, employee_no: staff.employee_no, department: staff.department,
      },
      // The five figures the month is read across, and they reconcile:
      // over/under is worked plus leave, less the working days expected.
      calendarDays: oc.quota,
      daysPerWeek: daysPerWeekFor(staff, ds.settings),
      // Whether somebody typed this month's figure, and what they said about
      // it. A figure that was set by hand and a figure the rule worked out
      // look identical on screen otherwise, and only one of them is anybody's
      // decision.
      calendarSet: calendarSetFor(ds, staff.id, from, to),
      scheduledDays: totals.scheduled,
      // Days actually clocked in and out of. Not the credited figure the rest
      // of the app uses — no halves for a short day, no crediting a reason
      // that counts as worked — because this column answers "did they turn up
      // and finish" and nothing else.
      workedDays: detail.filter((d) => d.worked).length,
      // Kept under its old name for the reports and the export, which are
      // about hours delivered rather than days owed.
      creditedDays: totals.daysWorked,
      overDays: oc.overDays,
      underDays: oc.underDays,
      difference: oc.difference,
      daysAbsent: totals.daysAbsent,
      daysLeave: detail.filter((d) => d.onLeave).length,
      openCount: totals.openCount,

      // Still waiting on a supervisor. It no longer changes the arithmetic —
      // a missed working day counts whether or not anybody has been round to
      // rule on it — but it is what somebody would go and do about the number.
      // Rostered, not delivered, and nobody has said why. The same days the
      // "missed" list holds, minus the ones somebody has been round to.
      unsettledAbsences: detail.filter((d) => !d.owed && d.scheduled && !d.resolvedBy).length,

      days: detail,
      decision: exact && presentDecision(exact),
      // Sign-offs that touch this span without being it. These are why a month
      // may refuse to be signed, so the screen has to be able to name them.
      overlapping: overlapping
        .filter((r) => r !== exact)
        .map((r) => ({ kind: r.kind, from: r.from_day, to: r.to_day, daysApplied: r.days_applied })),
    });
  }

  rows.sort((a, b) => a.staff.name.localeCompare(b.staff.name));

  return json({
    from,
    to,
    kind,
    month: kind === 'month' ? from.slice(0, 7) : null,
    rows,
    unsettled: rows.reduce((n, r) => n + r.openCount, 0),
    reviewed: rows.filter((r) => r.decision).length,
  });
}

/**
 * Tell a month what it expected of somebody.
 *
 * One person, one month. Set on the screen the figure is read on, because a
 * settings page somewhere else is a settings page nobody finds on the morning
 * they need it — and because the thing that prompts somebody to change it is
 * looking at a row and knowing the number is wrong.
 *
 * Clearing it hands the month back to the ordinary rule rather than storing a
 * zero, which would be an entirely different statement.
 */
export async function setCalendar(ctx) {
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });
  const month = str(body.month, 'Month', { required: true, max: 7 });
  if (!isMonth(month)) throw badRequest('That is not a month.');

  const staff = await ctx.db.prepare('SELECT id, name FROM att_staff WHERE id = ?')
    .bind(staffId).first();
  if (!staff) throw notFound('No such member of staff.');

  const clearing = body.days == null || body.days === '';
  if (clearing) {
    await ctx.db.prepare('DELETE FROM att_calendar WHERE staff_id = ? AND month = ?')
      .bind(staffId, month).run();
    await audit(ctx, 'attendance.calendar_clear', staffId, { month });
    return json({ ok: true, days: null });
  }

  const held = Number(body.days);
  if (!Number.isFinite(held) || held < 0 || held > 31) {
    throw badRequest('A month expects somewhere between none and thirty-one days.');
  }

  await ctx.db.prepare(
    `INSERT INTO att_calendar (staff_id, month, days, note, set_by)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (staff_id, month) DO UPDATE SET
       days = excluded.days, note = excluded.note,
       set_by = excluded.set_by, set_at = datetime('now')`,
  ).bind(staffId, month, held, str(body.note, 'Note', { max: 300 }), actorOf(ctx)).run();

  await audit(ctx, 'attendance.calendar_set', staffId, { month, days: held });
  return json({ ok: true, days: held });
}

/**
 * The figure somebody typed for this month, if the period is one month and
 * they typed one.
 *
 * Only offered for a whole month, because that is the unit it is set in. A
 * report across a fortnight or across two months has no single month's figure
 * to show or to change, and pretending otherwise would let somebody set
 * February from a screen showing half of March.
 */
function calendarSetFor(ds, staffId, from, to) {
  const month = from.slice(0, 7);
  if (to.slice(0, 7) !== month) return null;
  const bounds = monthBounds(month);
  if (from !== bounds.from || to !== bounds.to) return null;

  const held = ds.calendarBy?.get(staffId)?.get(month);
  return { month, days: held == null ? null : Number(held) };
}

function presentDecision(row) {
  return {
    decision: row.decision,
    daysApplied: row.days_applied,
    note: row.note,
    by: row.decided_by,
    at: row.decided_at,
    kind: row.kind,
    from: row.from_day,
    to: row.to_day,
    asSigned: {
      scheduledDays: row.scheduled_days,
      workedDays: row.worked_days,
      difference: row.difference,
    },
  };
}

/**
 * Sign a span off.
 *
 * `daysApplied` is what actually moves against their leave, signed and chosen
 * by whoever is deciding — not the raw difference. A manager looking at three
 * days short may charge one, or none, and the record keeps both what the
 * figures said and what was decided.
 */
export async function decidePeriod(ctx) {
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });

  const timezone = await timezoneOf(ctx.db);
  const { from, to, kind } = reviewWindow(
    new URL(`https://x/?${new URLSearchParams({
      ...(body.month ? { month: String(body.month) } : {}),
      ...(body.from ? { from: String(body.from) } : {}),
      ...(body.to ? { to: String(body.to) } : {}),
    })}`),
    timezone,
  );

  const decision = ['approved', 'waived'].includes(body.decision) ? body.decision : 'approved';
  // Whole days only, matching the rule that produced the figure.
  const daysApplied = decision === 'waived' ? 0 : Math.round(Number(body.daysApplied ?? 0));
  if (!Number.isFinite(daysApplied) || Math.abs(daysApplied) > 60) {
    throw badRequest('That is not a sensible number of days.');
  }

  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!staff) throw notFound('No such member of staff.');

  // No two signed spans for one person may share a day. Charging the same
  // absence through a week and again through its month is a wrong number that
  // nothing downstream would ever notice.
  const clash = await ctx.db.prepare(
    `SELECT * FROM att_period_review
      WHERE staff_id = ?1 AND from_day <= ?3 AND to_day >= ?2
        AND NOT (from_day = ?2 AND to_day = ?3)
      ORDER BY from_day LIMIT 1`,
  ).bind(staffId, from, to).first();

  if (clash) {
    throw badRequest(
      `${staff.name} already has ${clash.from_day} to ${clash.to_day} signed off, which overlaps `
      + 'this one. Reopen that first — otherwise the same days would be charged twice.',
    );
  }

  // The same two rules the day-at-a-time screen keeps: a period covering a day
  // somebody has asked about, or a day whose clock times are waiting on an
  // administrator, is a period settled against figures that are not settled.
  // Enforced here as well because this route signs a whole month at once, and a
  // rule with a way round it is a suggestion.
  await refuseUnsettled(ctx, {
    staff, from, to, wanted: new Set(daysBetween(from, to)),
  });

  // Recomputed here rather than trusted from the browser: the figures a
  // decision is recorded against have to be the ones this app stands behind.
  const ds = await loadDataset(ctx.db, { from, to });
  const days = daysFor(ds, staffId, from, to);
  const totals = summarise(days, { shifts: ds.shiftById, reasons: ds.reasonBy });
  const oc = overUnder(days, {
    holidays: ds.holidayBy,
    expected: totals.scheduled > 0,
    perWeek: daysPerWeekFor(ds.staffById.get(staffId), ds.settings),
    calendar: calendarFor(ds, staffId),
  });

  await ctx.db.prepare(
    `INSERT INTO att_period_review
       (staff_id, kind, from_day, to_day, scheduled_days, worked_days, difference,
        decision, days_applied, note, decided_by, decided_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))
     ON CONFLICT (staff_id, from_day, to_day) DO UPDATE SET
       kind = excluded.kind,
       scheduled_days = excluded.scheduled_days, worked_days = excluded.worked_days,
       difference = excluded.difference, decision = excluded.decision,
       days_applied = excluded.days_applied, note = excluded.note,
       decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
  ).bind(
    staffId, kind, from, to,
    totals.scheduled, totals.daysWorked, oc.difference,
    decision, daysApplied,
    str(body.note, 'Note', { max: 300 }),
    `${ctx.session.user.name} (${ctx.session.user.role})`,
  ).run();

  await audit(ctx, 'attendance.period_review', staffId, { from, to, kind, decision, daysApplied });
  return json({ ok: true, from, to, kind, daysApplied, decision });
}

/** Undo a sign-off, so the span goes back to waiting. */
export async function undoPeriod(ctx) {
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Staff', { required: true, min: 1 });
  const timezone = await timezoneOf(ctx.db);
  const { from, to } = reviewWindow(
    new URL(`https://x/?${new URLSearchParams({
      ...(body.month ? { month: String(body.month) } : {}),
      ...(body.from ? { from: String(body.from) } : {}),
      ...(body.to ? { to: String(body.to) } : {}),
    })}`),
    timezone,
  );

  await ctx.db.prepare(
    'DELETE FROM att_period_review WHERE staff_id = ? AND from_day = ? AND to_day = ?',
  ).bind(staffId, from, to).run();

  await audit(ctx, 'attendance.period_review_undo', staffId, { from, to });
  return json({ ok: true });
}
