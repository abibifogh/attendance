import { createNotice } from './notices.js';
import { absMinutes, fromAbs, loadDataset, scheduleFor, shiftWindow } from './attendance.js';
import { addDays, nowIn } from '../util/dates.js';

/**
 * Whether the terminal is still talking to us.
 *
 * Everything in attendance rests on one fact: that a shift with no punch
 * against it is a shift nobody turned up for. That is only true while the
 * terminal is being heard. The moment it is not, every rostered person reads
 * as absent, the nightly recompute writes that down, and the first anybody
 * learns of it is a payroll query a month later.
 *
 * THE POLLER IS ONE SCRIPT ON ONE MACHINE THAT NOBODY MAINTAINS, so the case
 * is not hypothetical. This watcher runs with the shift watcher every five
 * minutes and asks two questions.
 *
 *   Has the terminal said anything lately? `last_seen_at` moves on every
 *   batch and every heartbeat, from either feed.
 *
 *   And, if not, was anybody due? A terminal that is quiet at three in the
 *   morning with nobody on the rota is a terminal that is quiet. One that is
 *   quiet at seven with four people due at six and not a punch between them
 *   is the alarm. Asking the second question is what stops a quiet Sunday
 *   ringing the bell.
 *
 * When both are true a spell of silence is opened in `att_device_quiet`, the
 * people who can manage attendance are told (bell, push and email, because
 * this is the one thing that makes every other screen wrong), and the days
 * whose shifts began inside the spell are held for a decision instead of
 * being marked absent — see `computeDay`. When the terminal speaks again the
 * spell is closed and they are told that too. The held days stay held: the
 * punches the terminal lost are not coming.
 */

/** Minutes between a UTC stamp of SQLite's making and now. */
function minutesSince(utcStamp) {
  if (!utcStamp) return null;
  const at = Date.parse(`${String(utcStamp).replace(' ', 'T')}Z`);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((Date.now() - at) / 60000));
}

function describe(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 48) return `${Math.floor(hours / 24)} days`;
  const hh = hours === 1 ? 'an hour' : `${hours} hours`;
  if (rest < 8) return hh;
  if (rest > 52) return `nearly ${hours + 1} hours`;
  return `${hh} and ${rest} minutes`;
}

/** 'YYYY-MM-DD HH:MM' so many minutes before a local stamp of the same form. */
function minutesBefore(localStamp, minutes) {
  const [day, clock] = localStamp.split(' ');
  const at = fromAbs(absMinutes(day, clock) - minutes);
  return `${at.day} ${at.time}`;
}

/**
 * Who was due to start inside the silence, and has nothing recorded.
 *
 * Only people the clock is about, only shifts that began after the terminal
 * was last heard, and only once the shift's own grace and a quarter of an
 * hour on top have gone by — the same patience the late-arrival nudge shows.
 */
async function dueSince(db, { sinceAbs, nowAbs, today, yesterday }) {
  const ds = await loadDataset(db, { from: yesterday, to: today });
  let due = 0;
  for (const staff of ds.staff) {
    if (!staff.active) continue;
    for (const day of [yesterday, today]) {
      const { shift } = scheduleFor(ds, staff.id, day);
      if (!shift) continue;
      const window = shiftWindow(shift, day);
      if (!window) continue;
      const expectedBy = window.start + (shift.grace_in_minutes ?? 0) + 15;
      if (window.start < sinceAbs || expectedBy > nowAbs) continue;
      const punched = (ds.punchesByStaff.get(staff.id) ?? [])
        .some((p) => p.day === day || p.day === addDays(day, 1));
      if (!punched) due += 1;
    }
  }
  return due;
}

const REMIND_EVERY_MINUTES = 6 * 60;

export async function watchTerminals(db, { timezone = 'UTC', ctx = null } = {}) {
  const setting = await db.prepare(
    "SELECT value FROM settings WHERE key = 'att_terminal_quiet_minutes'",
  ).first().catch(() => null);
  const threshold = Number(setting?.value ?? 60);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { checked: 0, quiet: 0, back: 0, reason: 'switched off' };
  }

  const devices = await db.prepare(
    'SELECT id, name, serial, last_seen_at, created_at FROM att_devices WHERE active = 1',
  ).all().catch(() => ({ results: [] }));

  const now = nowIn(timezone);
  const [today, clock] = now.split(' ');
  const nowAbs = absMinutes(today, clock);
  const yesterday = addDays(today, -1);

  let checked = 0;
  let quiet = 0;
  let back = 0;

  for (const device of devices.results ?? []) {
    checked += 1;
    const open = await db.prepare(
      'SELECT id, from_at, told_at FROM att_device_quiet WHERE device_id = ? AND to_at IS NULL',
    ).bind(device.id).first().catch(() => null);

    // A terminal that has never spoken is counted from when it was registered,
    // so a token pasted into a poller that was never started still gets
    // noticed the first morning somebody was due.
    const silent = minutesSince(device.last_seen_at ?? device.created_at);
    const isQuiet = silent != null && silent >= threshold;

    if (!isQuiet) {
      if (!open) continue;
      // Back. Close the spell where it actually ended, which is the moment the
      // terminal spoke rather than the moment we noticed.
      const endedAt = minutesBefore(now, silent ?? 0);
      await db.prepare('UPDATE att_device_quiet SET to_at = ?2 WHERE id = ?1')
        .bind(open.id, endedAt).run();
      back += 1;
      await createNotice(db, {
        kind: 'attendance.terminal_back',
        level: 'info',
        title: `${device.name} is back`,
        body: `It was heard from again at ${endedAt.slice(11)}, after being quiet since `
          + `${open.from_at.slice(11)} on ${open.from_at.slice(0, 10)}. The shifts that began while `
          + 'it was quiet are still on the to-confirm list, because any punch it lost while it was '
          + 'down is not coming back. Settle them from Today when you know what happened.',
        link: '#/att-today',
        day: today,
        audience: 'att_manage',
        email: true,
        push: false,
      }, ctx);
      continue;
    }

    const sinceAbs = nowAbs - silent;

    if (open) {
      // Still quiet. Say so again every few hours, not every five minutes.
      const toldAgo = minutesSince(open.told_at);
      if (toldAgo != null && toldAgo < REMIND_EVERY_MINUTES) { quiet += 1; continue; }
      const due = await dueSince(db, { sinceAbs, nowAbs, today, yesterday });
      await db.prepare(
        "UPDATE att_device_quiet SET told_at = datetime('now'), due = ?2 WHERE id = ?1",
      ).bind(open.id, due).run();
      quiet += 1;
      await createNotice(db, {
        kind: 'attendance.terminal_quiet',
        level: 'high',
        title: `${device.name} is still quiet`,
        body: `Nothing has been heard from it for ${describe(silent)}. ${dueLine(due)} `
          + 'Their days are being held for a decision rather than marked absent. Check the '
          + 'terminal, and the machine that polls it.',
        link: '#/att-today',
        day: today,
        audience: 'att_manage',
        email: true,
        push: true,
      }, ctx);
      continue;
    }

    // Quiet, and nobody has been told. Only worth telling if somebody was due.
    const due = await dueSince(db, { sinceAbs, nowAbs, today, yesterday });
    if (!due) continue;

    const fromAt = minutesBefore(now, silent);
    await db.prepare(
      "INSERT INTO att_device_quiet (device_id, from_at, told_at, due) VALUES (?1, ?2, datetime('now'), ?3)",
    ).bind(device.id, fromAt, due).run();
    quiet += 1;
    await createNotice(db, {
      kind: 'attendance.terminal_quiet',
      level: 'high',
      title: `${device.name} has gone quiet`,
      body: `Nothing has been heard from it since ${fromAt.slice(11)}, ${describe(silent)} ago. `
        + `${dueLine(due)} Until it is back their days are held for a decision rather than `
        + 'marked absent, so nothing is wrongly written down. Check the terminal is on and '
        + 'the machine that polls it is running.',
      link: '#/att-today',
      day: today,
      audience: 'att_manage',
      email: true,
      push: true,
    }, ctx);
  }

  return { checked, quiet, back };
}

function dueLine(due) {
  if (due === 1) return 'One person was due to start since then and has no punch.';
  return `${due} people were due to start since then and none of them has a punch.`;
}

/** What Today shows while a terminal is quiet: the open spells, by name. */
export async function terminalWarnings(db) {
  const rows = await db.prepare(
    `SELECT d.name, d.serial, q.from_at, q.due, d.last_seen_at
       FROM att_device_quiet q JOIN att_devices d ON d.id = q.device_id
      WHERE q.to_at IS NULL
      ORDER BY q.from_at`,
  ).all().catch(() => ({ results: [] }));
  return (rows.results ?? []).map((row) => ({
    device: row.name,
    serial: row.serial,
    since: row.from_at,
    minutes: minutesSince(row.last_seen_at) ?? null,
    due: Number(row.due ?? 0),
  }));
}
