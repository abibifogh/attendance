// Getting punches in, and keeping the derived days honest afterwards.
//
// Split from `attendance.js` on a simple line: that file decides what a day
// means and can be reasoned about on paper, this one talks to the database and
// to whatever is feeding it. The rules are worth testing in isolation; the
// INSERT statements are not.

import { hashPin } from './auth.js';
import { badRequest, forbidden } from './http.js';
import { computeRange, loadDataset } from './attendance.js';
import { addDays } from '../util/dates.js';

// ---------------------------------------------------------------------------
// Devices and their tokens
// ---------------------------------------------------------------------------

/**
 * The token a feed presents, hashed for storage.
 *
 * Same HMAC and same pepper as a PIN, with its own prefix so a token can never
 * be a valid PIN or the reverse. Held hashed for the ordinary reason: a leaked
 * copy of this database should not let anybody post fabricated punches.
 */
export function hashDeviceToken(token, pepper) {
  return hashPin(`att-device:${token}`, pepper);
}

/**
 * Find the device a request is claiming to be, and check it is telling the
 * truth.
 *
 * Deliberately not a session. The thing on the other end is a script on a
 * cupboard PC that must keep working at three in the morning without anybody
 * signing in, so it carries a long-lived token scoped to exactly one ability:
 * adding punches to its own serial.
 */
export async function deviceForToken(db, serial, token, pepper) {
  if (!serial || !token) throw forbidden('This feed needs a device serial and its token.');
  const device = await db.prepare('SELECT * FROM att_devices WHERE serial = ?').bind(serial).first();
  if (!device || !device.active) throw forbidden('That terminal is not registered here.');
  if (!device.token_hash) throw forbidden('That terminal has no token set. Issue one in Attendance setup.');
  if (await hashDeviceToken(token, pepper) !== device.token_hash) {
    throw forbidden('That token is not right for this terminal.');
  }
  return device;
}

/**
 * Find the device from a token alone.
 *
 * The poller can present a serial and a token, because it is a config file
 * somebody filled in. A terminal posting its own events cannot: its listening
 * host is one URL and nothing else, so the token in that URL has to identify
 * the device by itself.
 *
 * Compared against every registered terminal rather than looked up by index —
 * the hash is salted, so there is nothing to index on, and a property has a
 * handful of doors rather than a million.
 */
export async function deviceForPushToken(db, token, pepper) {
  if (!token) throw forbidden('This feed needs a token.');
  const hash = await hashDeviceToken(token, pepper);

  const rows = await db.prepare(
    'SELECT * FROM att_devices WHERE token_hash IS NOT NULL AND active = 1',
  ).all();

  const device = (rows.results ?? []).find((row) => row.token_hash === hash);
  if (!device) throw forbidden('That token does not belong to a terminal here.');
  return device;
}

// ---------------------------------------------------------------------------
// Normalising what arrives
// ---------------------------------------------------------------------------

/**
 * Local wall-clock time in the property's timezone, as 'YYYY-MM-DD HH:MM:SS'.
 *
 * Everything is stored in UTC and shown in local time, and this is the one
 * place the conversion happens. `en-CA` is used because it formats as
 * ISO-ordered date, which is the only reason to prefer any locale here.
 */
export function localStamp(date, timezone = 'UTC') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(date).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    // Some runtimes render midnight as hour 24.
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
  } catch {
    return date.toISOString().slice(0, 19).replace('T', ' ');
  }
}

/** UTC, as 'YYYY-MM-DD HH:MM:SS'. */
export function utcStamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * What the device calls a direction, and what we call it.
 *
 * A terminal with attendance mode configured labels every event; one without it
 * sends 'undefined' or nothing at all, and the day computation infers direction
 * from the shift instead. Both are normal, and the raw value is kept either way
 * so that turning attendance mode on later does not make the old records lie.
 */
const DIRECTIONS = new Map([
  ['checkin', 'in'],
  ['checkout', 'out'],
  // Hikvision spells the break pair 'breakOff' and 'breakIn' — going off for
  // lunch and coming back.
  ['breakoff', 'out'],
  ['breakin', 'in'],
  ['overtimein', 'in'],
  ['overtimeout', 'out'],
]);

export function directionOf(status) {
  if (!status) return null;
  return DIRECTIONS.get(String(status).toLowerCase().replace(/[^a-z]/g, '')) ?? null;
}

/**
 * One event from a feed, turned into a row.
 *
 * The feed is trusted to say what the device said and nothing more: it may not
 * choose a staff id, a status, or a day. Those are decided here so that a
 * second feed — the device's own HTTP push, or a Hik-Connect adapter — cannot
 * disagree with the first about what a punch means.
 *
 * Returns null for anything without the two fields that make an event useful.
 */
export function normaliseEvent(event, { deviceSerial, timezone = 'UTC', source = 'poller' }) {
  const employeeNo = String(
    event.employeeNoString ?? event.employeeNo ?? event.employee_no ?? '',
  ).trim();
  if (!employeeNo) return null;

  const raw = event.time ?? event.at ?? event.dateTime;
  if (!raw) return null;
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return null;

  const local = localStamp(when, timezone);
  const serial = event.serialNo ?? event.serial_no ?? null;

  return {
    device_serial: deviceSerial,
    employee_no: employeeNo,
    at_utc: utcStamp(when),
    at_local: local,
    day: local.slice(0, 10),
    direction: directionOf(event.attendanceStatus ?? event.direction),
    device_status: event.attendanceStatus == null ? null : String(event.attendanceStatus),
    major: numberOr(event.major, null),
    minor: numberOr(event.minor, null),
    door: event.doorNo == null ? null : String(event.doorNo),
    verify_mode: event.currentVerifyMode == null ? null : String(event.currentVerifyMode),
    source,
    // The device's own event serial when it has one. Failing that, the fields
    // that together identify the event — which is enough, because a terminal
    // cannot produce two different events for one person at one second on one
    // door.
    dedupe_key: serial != null && serial !== ''
      ? `s:${serial}`
      : `t:${employeeNo}:${utcStamp(when)}:${event.minor ?? ''}:${event.doorNo ?? ''}`,
    raw: JSON.stringify(event).slice(0, 2000),
  };
}

// ---------------------------------------------------------------------------
// The terminal's own clock
// ---------------------------------------------------------------------------

/**
 * How far the device's clock is from ours, in seconds, from a pushed batch.
 *
 * Positive means the terminal is running fast. The measurement is free: a
 * pushing terminal stamps the event and posts it within a second or two, so the
 * gap between that stamp and the moment the request lands is the drift plus a
 * little network delay. Nothing extra is asked of the device, which matters,
 * because the alternative is a config endpoint the firmware may not answer.
 *
 * The newest event in the batch is used, not the first. A terminal that has
 * been off the internet posts its backlog on reconnect, and the oldest of those
 * would read as an enormous "behind" that says nothing about the clock.
 *
 * Only ever called for pushed events — see the migration for why a poller
 * cannot answer this question.
 */
export function clockOffset(events, receivedAt = new Date()) {
  let newest = null;

  for (const event of events ?? []) {
    const raw = event?.time ?? event?.at ?? event?.dateTime;
    if (!raw) continue;
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) continue;
    if (newest === null || when.getTime() > newest) newest = when.getTime();
  }

  if (newest === null) return null;
  return Math.round((newest - receivedAt.getTime()) / 1000);
}

/**
 * The drift, said the way somebody standing in a corridor would say it.
 *
 * Deliberately names the consequence rather than the number alone. "The clock
 * is 11 minutes fast" invites a shrug; "everybody looks 11 minutes later than
 * they were" is the sentence that gets it fixed.
 */
export function clockDriftNote(offsetSeconds, deviceName = 'The terminal') {
  const offset = Number(offsetSeconds) || 0;
  const seconds = Math.abs(Math.round(offset));
  const fast = offset > 0;

  const amount = seconds < 90
    ? `${seconds} seconds`
    : seconds < 5400
      ? `${Math.round(seconds / 60)} minutes`
      : seconds < 172800
        ? `${round1(seconds / 3600)} hours`
        : `${Math.round(seconds / 86400)} days`;

  return `${deviceName}’s clock is ${amount} ${fast ? 'fast' : 'slow'}. Arrivals are being written `
    + `down ${amount} ${fast ? 'later' : 'earlier'} than they happen, so everybody looks `
    + `${fast ? 'later' : 'earlier'} than they were.`;
}

function round1(n) {
  return String(Math.round(n * 10) / 10);
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Writing them down
// ---------------------------------------------------------------------------

const MAX_BATCH = 500;

/**
 * Store a batch of punches, ignoring the ones already held.
 *
 * Overlap is expected, not exceptional. A poller that asks only for the minutes
 * since its last run loses any punch that lands while it is running, so it is
 * built to ask for a window that overlaps the last one — which means most of
 * every batch after the first is already here. `INSERT OR IGNORE` against the
 * unique dedupe key is what makes that cheap and safe.
 */
export async function ingestPunches(db, { device, events, timezone, source = 'poller' }) {
  if (!Array.isArray(events)) throw badRequest('Expected a list of events.');
  if (events.length > MAX_BATCH) {
    throw badRequest(`Too many events in one batch — send at most ${MAX_BATCH}.`);
  }

  const rows = [];
  let skipped = 0;
  for (const event of events) {
    const row = normaliseEvent(event, { deviceSerial: device.serial, timezone, source });
    if (row) rows.push(row);
    else skipped += 1;
  }

  const staff = await db.prepare('SELECT id, employee_no FROM att_staff').all();
  const staffByNo = new Map((staff.results ?? []).map((s) => [String(s.employee_no), s.id]));

  const statements = rows.map((row) => db.prepare(
    `INSERT OR IGNORE INTO att_punches
       (device_serial, employee_no, staff_id, at_utc, at_local, day, direction,
        device_status, major, minor, door, verify_mode, source, dedupe_key, raw)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
  ).bind(
    row.device_serial, row.employee_no, staffByNo.get(row.employee_no) ?? null,
    row.at_utc, row.at_local, row.day, row.direction, row.device_status,
    row.major, row.minor, row.door, row.verify_mode, row.source, row.dedupe_key, row.raw,
  ));

  const before = await countPunches(db, device.serial);
  if (statements.length) await db.batch(statements);
  const after = await countPunches(db, device.serial);

  // Which people and which days now need recomputing. A punch for somebody the
  // roster has never heard of is kept but touches nobody's days until they are
  // added — see `claimOrphans`.
  const touched = new Map();
  const unknown = new Set();
  for (const row of rows) {
    const staffId = staffByNo.get(row.employee_no);
    if (!staffId) { unknown.add(row.employee_no); continue; }
    const range = touched.get(staffId) ?? { from: row.day, to: row.day };
    if (row.day < range.from) range.from = row.day;
    if (row.day > range.to) range.to = row.day;
    touched.set(staffId, range);
  }

  await db.prepare(
    "UPDATE att_devices SET last_seen_at = datetime('now')"
    + `${rows.length ? ", last_event_at = datetime('now')" : ''} WHERE id = ?`,
  ).bind(device.id).run().catch(() => {});

  return {
    received: events.length,
    stored: after - before,
    duplicates: rows.length - (after - before),
    unusable: skipped,
    unknownEmployees: [...unknown],
    touched,
  };
}

async function countPunches(db, serial) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM att_punches WHERE device_serial = ?')
    .bind(serial).first();
  return Number(row?.n ?? 0);
}

/**
 * Attach punches that arrived before the person existed.
 *
 * Somebody is enrolled on the terminal on Monday and added to this system on
 * Wednesday, and Monday and Tuesday are already in `att_punches` with no owner.
 * Called whenever a staff member is created or their employee number changes,
 * so that their first week is not silently missing.
 */
export async function claimOrphans(db, staffId, employeeNo) {
  const result = await db.prepare(
    'UPDATE att_punches SET staff_id = ?1 WHERE employee_no = ?2 AND staff_id IS NULL',
  ).bind(staffId, String(employeeNo)).run();

  const claimed = result?.meta?.changes ?? 0;
  if (!claimed) return { claimed: 0, from: null, to: null };

  const span = await db.prepare(
    'SELECT MIN(day) AS from_day, MAX(day) AS to_day FROM att_punches WHERE staff_id = ?',
  ).bind(staffId).first();

  return { claimed, from: span?.from_day ?? null, to: span?.to_day ?? null };
}

// ---------------------------------------------------------------------------
// Keeping the derived days in step
// ---------------------------------------------------------------------------

/**
 * Recompute and store days for a set of people over a range.
 *
 * Everything that can change a verdict funnels through here: new punches, an
 * edited rota, approved leave, a changed grace period, a new public holiday.
 * That is on purpose — a second path that wrote `att_days` would eventually
 * write it differently.
 */
export async function recompute(db, { staffIds = null, from, to }) {
  if (!from || !to) return { days: 0, staff: 0 };

  // One day either side so an overnight shift at the edge of the range sees the
  // punches that belong to it.
  const ds = await loadDataset(db, { from: addDays(from, -1), to: addDays(to, 1) });
  const ids = staffIds && staffIds.length
    ? staffIds.filter((id) => ds.staffById.has(id))
    : ds.staff.filter((s) => s.active).map((s) => s.id);

  const statements = [];
  let count = 0;

  for (const staffId of ids) {
    for (const record of computeRange(ds, staffId, from, to)) {
      count += 1;
      statements.push(db.prepare(
        `INSERT INTO att_days
           (staff_id, day, shift_id, scheduled, expected_minutes, first_in, last_out,
            punches, worked_minutes, late_minutes, early_minutes, overtime_minutes,
            status, reason_code, leave_id, resolution, note, computed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, datetime('now'))
         ON CONFLICT (staff_id, day) DO UPDATE SET
           shift_id = excluded.shift_id,
           scheduled = excluded.scheduled,
           expected_minutes = excluded.expected_minutes,
           first_in = excluded.first_in,
           last_out = excluded.last_out,
           punches = excluded.punches,
           worked_minutes = excluded.worked_minutes,
           late_minutes = excluded.late_minutes,
           early_minutes = excluded.early_minutes,
           overtime_minutes = excluded.overtime_minutes,
           note = excluded.note,
           computed_at = excluded.computed_at,
           -- A resolved day keeps the verdict a person gave it. Only the
           -- arithmetic above is refreshed, so a late-arriving punch updates
           -- the times on the record without overturning the ruling.
           status = CASE WHEN att_days.resolution = 'resolved' THEN att_days.status ELSE excluded.status END,
           reason_code = CASE WHEN att_days.resolution = 'resolved' THEN att_days.reason_code ELSE excluded.reason_code END,
           leave_id = CASE WHEN att_days.resolution = 'resolved' THEN att_days.leave_id ELSE excluded.leave_id END,
           resolution = CASE WHEN att_days.resolution = 'resolved' THEN 'resolved' ELSE excluded.resolution END`,
      ).bind(
        record.staff_id, record.day, record.shift_id, record.scheduled, record.expected_minutes,
        record.first_in, record.last_out, record.punches, record.worked_minutes,
        record.late_minutes, record.early_minutes, record.overtime_minutes,
        record.status, record.reason_code, record.leave_id, record.resolution, record.note,
      ));
    }
  }

  // D1 has a ceiling on statements per batch, and a month-wide recompute for a
  // hundred staff clears it comfortably.
  for (let i = 0; i < statements.length; i += 100) {
    await db.batch(statements.slice(i, i + 100));
  }

  return { days: count, staff: ids.length };
}

/**
 * Recompute exactly the people and days a punch batch disturbed.
 *
 * `touched` comes back from `ingestPunches` as one range per person, which is
 * usually one day for a handful of people. Widened by a day at each end for the
 * overnight case.
 */
export async function recomputeTouched(db, touched) {
  if (!touched?.size) return { days: 0, staff: 0 };

  let from = null;
  let to = null;
  for (const range of touched.values()) {
    if (!from || range.from < from) from = range.from;
    if (!to || range.to > to) to = range.to;
  }

  return recompute(db, {
    staffIds: [...touched.keys()],
    from: addDays(from, -1),
    to: addDays(to, 1),
  });
}

// ---------------------------------------------------------------------------
// Telling somebody
// ---------------------------------------------------------------------------

/**
 * The bell, for the things that need a person today.
 *
 * Only two things qualify: days that cannot be settled without a decision, and
 * an absence that has now run long enough to stop being an oversight. Anything
 * else — a late arrival, a short day — is on the report, and putting it in a
 * notification as well would train everybody to ignore the notifications.
 */
export function exceptionNotice({ day, open, absent, escalated }) {
  const parts = [];
  if (open) parts.push(`${open} day${open === 1 ? '' : 's'} to confirm`);
  if (absent) parts.push(`${absent} absent`);
  if (!parts.length) return null;

  return {
    kind: 'att_exceptions',
    level: escalated?.length ? 'high' : open ? 'warn' : 'info',
    title: escalated?.length
      ? `${escalated.length} on a run of absences`
      : `Attendance: ${parts.join(', ')}`,
    body: escalated?.length
      ? `${escalated.join(', ')} — ${parts.join(', ')} on ${day}.`
      : `${parts.join(', ')} on ${day}.`,
    link: `#/att-today?day=${day}`,
    day,
    audience: 'att_manage',
  };
}
