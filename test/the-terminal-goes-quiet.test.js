import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { computeRange, loadDataset, makeDataset } from '../src/lib/attendance.js';
import { watchTerminals, terminalWarnings } from '../src/lib/terminal-watch.js';
import { day as todayScreen } from '../src/routes/attendance.js';

/**
 * The terminal stops talking, and the property is told rather than left
 * with a page of absences that mean nothing.
 *
 * Two halves. The watcher: silence plus somebody due is an alarm, silence on
 * its own is a quiet night. And the hold: a shift that began inside the
 * silence is a day for a person to settle, not an absence for the payroll to
 * believe.
 */

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const r = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare: (sql) => st(sql),
    async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; },
  };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  // The property's clock is UTC for these, so "two hours ago" is the same
  // on the rota as it is on the wall.
  raw.prepare("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'").run();
  return { raw, db: d1(raw) };
}

const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
const sqlite = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/** Shift 1 on today's rota for staff 1, having started so many minutes ago. */
function rosterStartedAgo(raw, minutes, staffId = 1) {
  const at = new Date(Date.now() - minutes * 60000);
  const ends = new Date(at.getTime() + 8 * 3600000);
  raw.prepare('UPDATE att_shifts SET starts_at = ?, ends_at = ?, grace_in_minutes = 5 WHERE id = 1')
    .run(hhmm(at), hhmm(ends));
  raw.prepare('INSERT OR REPLACE INTO att_roster (staff_id, day, shift_id, published) VALUES (?, ?, 1, 1)')
    .run(staffId, at.toISOString().slice(0, 10));
  return { day: at.toISOString().slice(0, 10), starts_at: hhmm(at) };
}

const heardAgo = (raw, minutes) => raw
  .prepare('UPDATE att_devices SET last_seen_at = ? WHERE id = 1')
  .run(sqlite(new Date(Date.now() - minutes * 60000)));

const notices = (raw) => raw.prepare('SELECT kind, level, audience, title FROM app_notices ORDER BY id').all();
const spells = (raw) => raw.prepare('SELECT device_id, from_at, to_at, due FROM att_device_quiet ORDER BY id').all();

// ---------------------------------------------------------------------------
// The hold
// ---------------------------------------------------------------------------

const staff = [{ id: 1, name: 'Ama', employee_no: '1', active: 1, on_clock: 1 }];
const shift = { id: 1, name: 'Early', starts_at: '06:00', ends_at: '14:00', grace_in_minutes: 5, break_minutes: 0 };
const roster = [{ id: 1, staff_id: 1, day: '2026-09-01', shift_id: 1, published: 1 }];

function dayWith(quiet) {
  const ds = makeDataset({
    now: '2026-09-02 12:00', staff, shifts: [shift], roster, punches: [], days: [],
    reasons: [], holidays: [], leave: [], settings: [{ key: 'timezone', value: 'UTC' }],
    patterns: [], calendars: [], quiet,
  });
  return computeRange(ds, 1, '2026-09-01', '2026-09-01')[0];
}

test('a shift that began while the terminal was quiet is held, not marked absent', () => {
  const held = dayWith([{ device_id: 1, from_at: '2026-09-01 04:30', to_at: null }]);
  assert.equal(held.status, 'missing_in');
  assert.equal(held.reason_code, 'incomplete');
  assert.equal(held.resolution, 'open');
  assert.equal(held.held, 'terminal');
  assert.match(held.note, /terminal was not being heard/);
});

test('the same shift with the terminal working is an absence, as it always was', () => {
  const plain = dayWith([]);
  assert.equal(plain.status, 'absent');
  assert.equal(plain.reason_code, 'absent');
});

test('a silence that ended well before the shift began does not hold it', () => {
  // Quiet overnight, back at 02:00, four hours before a 06:00 start. The
  // terminal was there to hear them arrive and heard nothing.
  const plain = dayWith([{ device_id: 1, from_at: '2026-08-31 22:00', to_at: '2026-09-01 02:00' }]);
  assert.equal(plain.status, 'absent');
});

test('a silence that began after the arrival window had passed does not hold it either', () => {
  // The terminal died at two in the afternoon. It says nothing about six.
  const plain = dayWith([{ device_id: 1, from_at: '2026-09-01 14:00', to_at: null }]);
  assert.equal(plain.status, 'absent');
});

test('a silence that ran through the start holds it even once it has ended', () => {
  // Down from four to seven. The 06:00 punch it would have heard is lost.
  const held = dayWith([{ device_id: 1, from_at: '2026-09-01 04:00', to_at: '2026-09-01 07:00' }]);
  assert.equal(held.held, 'terminal');
});

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

test('silence with somebody due raises the alarm once, then again hours later, then says it is back', async () => {
  const { raw, db } = setup();
  rosterStartedAgo(raw, 120);
  heardAgo(raw, 180);

  const first = await watchTerminals(db, { timezone: 'UTC' });
  assert.equal(first.quiet, 1);

  let open = spells(raw);
  assert.equal(open.length, 1);
  assert.equal(open[0].to_at, null);
  assert.equal(open[0].due, 1);

  let told = notices(raw);
  assert.equal(told.length, 1);
  assert.equal(told[0].kind, 'attendance.terminal_quiet');
  assert.equal(told[0].level, 'high');
  assert.equal(told[0].audience, 'att_manage');
  assert.match(told[0].title, /Staff entrance has gone quiet/);

  // Five minutes later: still quiet, nothing new said.
  const again = await watchTerminals(db, { timezone: 'UTC' });
  assert.equal(again.quiet, 1);
  assert.equal(notices(raw).length, 1, 'one alarm, not one every five minutes');

  // Seven hours later: still quiet, said again.
  raw.prepare("UPDATE att_device_quiet SET told_at = datetime('now', '-7 hours')").run();
  await watchTerminals(db, { timezone: 'UTC' });
  told = notices(raw);
  assert.equal(told.length, 2);
  assert.match(told[1].title, /still quiet/);

  // And then it speaks.
  heardAgo(raw, 0);
  const back = await watchTerminals(db, { timezone: 'UTC' });
  assert.equal(back.back, 1);
  open = spells(raw);
  assert.ok(open[0].to_at, 'the spell is closed');
  told = notices(raw);
  assert.equal(told.length, 3);
  assert.equal(told[2].kind, 'attendance.terminal_back');
  assert.equal(told[2].level, 'info');

  // Nothing more to say now it is back.
  await watchTerminals(db, { timezone: 'UTC' });
  assert.equal(notices(raw).length, 3);
  assert.equal(spells(raw).length, 1);
});

test('silence with nobody due is a quiet night, not an alarm', async () => {
  const { raw, db } = setup();
  heardAgo(raw, 600);
  const out = await watchTerminals(db, { timezone: 'UTC' });
  assert.equal(out.checked, 1);
  assert.equal(out.quiet, 0);
  assert.equal(notices(raw).length, 0);
  assert.equal(spells(raw).length, 0);
});

test('somebody due who did punch on another terminal does not count as missing', async () => {
  const { raw, db } = setup();
  const at = rosterStartedAgo(raw, 120);
  heardAgo(raw, 180);
  raw.prepare(
    `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day, dedupe_key)
     VALUES ('OTHER', '1', 1, ?1, ?2, ?3, 'x1')`,
  ).run(`${at.day}T${at.starts_at}:00Z`, `${at.day} ${at.starts_at}`, at.day);
  const out = await watchTerminals(db, { timezone: 'UTC' });
  assert.equal(out.quiet, 0);
  assert.equal(notices(raw).length, 0);
});

test('a shift that started inside the threshold is given the grace the nudge gives it', async () => {
  const { raw, db } = setup();
  // Due ten minutes ago, grace five: not yet a missing person.
  rosterStartedAgo(raw, 10);
  heardAgo(raw, 90);
  const out = await watchTerminals(db, { timezone: 'UTC' });
  assert.equal(out.quiet, 0);
});

test('a terminal that has never spoken is counted from when it was registered', async () => {
  const { raw, db } = setup();
  rosterStartedAgo(raw, 120);
  raw.prepare("UPDATE att_devices SET last_seen_at = NULL, created_at = datetime('now', '-3 hours')").run();
  const out = await watchTerminals(db, { timezone: 'UTC' });
  assert.equal(out.quiet, 1);
});

test('zero minutes switches the watch off', async () => {
  const { raw, db } = setup();
  rosterStartedAgo(raw, 120);
  heardAgo(raw, 180);
  raw.prepare("UPDATE settings SET value = '0' WHERE key = 'att_terminal_quiet_minutes'").run();
  const out = await watchTerminals(db, { timezone: 'UTC' });
  assert.equal(out.reason, 'switched off');
  assert.equal(notices(raw).length, 0);
});

test('the held day is what the dataset computes, and it stays held after the terminal is back', async () => {
  const { raw, db } = setup();
  const at = rosterStartedAgo(raw, 120);
  heardAgo(raw, 180);
  await watchTerminals(db, { timezone: 'UTC' });

  let ds = await loadDataset(db, { from: at.day, to: at.day });
  let [record] = computeRange(ds, 1, at.day, at.day);
  assert.equal(record.held, 'terminal');
  assert.equal(record.status, 'missing_in');

  heardAgo(raw, 0);
  await watchTerminals(db, { timezone: 'UTC' });
  ds = await loadDataset(db, { from: at.day, to: at.day });
  [record] = computeRange(ds, 1, at.day, at.day);
  assert.equal(record.held, 'terminal', 'the punch it lost is not coming back');
});

test('Today carries the open spell so the screen can say the list cannot be trusted', async () => {
  const { raw, db } = setup();
  // The day the fixture actually put the shift on, asked for by name. A shift
  // that started two hours ago is on yesterday's date for the first two hours
  // after midnight, and this used to ask the screen for today and then wonder
  // where the shift had gone: green all day and red between midnight and two,
  // which is how a suite teaches people to ignore it.
  const at = rosterStartedAgo(raw, 120);
  heardAgo(raw, 180);
  await watchTerminals(db, { timezone: 'UTC' });

  const warnings = await terminalWarnings(db);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].device, 'Staff entrance');
  assert.equal(warnings[0].due, 1);

  const res = await todayScreen({
    db, env: {}, url: new URL(`https://x/api/att/day?day=${at.day}`),
    session: { user: { id: 1, name: 'K', role: 'admin' } },
  });
  const body = await res.json();
  assert.equal(body.terminals.length, 1);
  assert.equal(body.terminals[0].device, 'Staff entrance');
  const ama = body.rows.find((r) => r.staff.id === 1);
  assert.equal(ama.held, 'terminal');
  assert.equal(ama.label, 'Terminal was quiet, to check');
  assert.equal(ama.open, true);

  heardAgo(raw, 0);
  await watchTerminals(db, { timezone: 'UTC' });
  assert.equal((await terminalWarnings(db)).length, 0);
});
