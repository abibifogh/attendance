import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { isReceptionShift, nextOnReception, reportSlotFor, watchTills } from '../src/lib/till-watch.js';
import { goesOut, KINDS } from '../src/lib/notice-kinds.js';

/**
 * Close your till: twenty minutes before a reception shift ends, and twenty
 * minutes after if the report is still not in.
 *
 * The shifts here are placed around the real clock, because the watcher reads
 * it: one ending in ten minutes, one that ended half an hour ago. A test run at
 * any hour builds the shift it needs, the day the shift began included.
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
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const ymd = (d) => d.toISOString().slice(0, 10);

/** A shift that ends `endsIn` minutes from now (negative: ended that long ago), eight hours long. */
function shiftAround(endsIn) {
  const end = new Date(Date.now() + endsIn * 60_000);
  end.setUTCSeconds(0, 0);
  const start = new Date(end.getTime() - 8 * 3600_000);
  return { day: ymd(start), starts: hhmm(start), ends: hhmm(end) };
}

function setup({ endsIn, department = 'Reception', role = 'staff', permissions = '["att_me","till"]' }) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_leave; DELETE FROM app_notices; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  const s = shiftAround(endsIn);
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes, department)
     VALUES (1, 'Front desk', ?, ?, 0, 5, ?)`,
  ).run(s.starts, s.ends, department);
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (1, '1', 'Kwame', 'Reception', '2020-01-01')").run();
  raw.prepare("INSERT INTO users (id, name, role, pin_hash, staff_id, active, permissions) VALUES (7, 'Kwame', ?, 'x', 1, 1, ?)")
    .run(role, permissions);
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)').run(s.day);
  return { raw, db: d1(raw), shift: s };
}

const told = (raw) => raw.prepare("SELECT * FROM app_notices WHERE kind = 'till.close_due' ORDER BY id").all();

test('twenty minutes before the end of a reception shift, they are told to close the till', async () => {
  const { db, raw } = setup({ endsIn: 10 });
  const out = await watchTills(db, { timezone: 'UTC' });
  assert.equal(out.before, 1);
  const [n] = told(raw);
  assert.equal(n.user_id, 7, 'to them and nobody else');
  assert.match(n.title, /^Close your till: your \w+ shift ends at/);
  assert.equal(n.link, '#/att-my-till');

  await watchTills(db, { timezone: 'UTC' });
  assert.equal(told(raw).length, 1, 'said once, however often the watcher runs');
});

test('not yet: more than twenty minutes before the end is too early', async () => {
  const { db, raw } = setup({ endsIn: 45 });
  await watchTills(db, { timezone: 'UTC' });
  assert.equal(told(raw).length, 0);
});

test('twenty minutes after the end, still no report, they are told again', async () => {
  const { db, raw } = setup({ endsIn: -30 });
  const out = await watchTills(db, { timezone: 'UTC' });
  assert.equal(out.after, 1);
  const [n] = told(raw);
  assert.equal(n.level, 'warn');
  assert.match(n.title, /still not in/);
});

test('once the report is in, nothing more is said', async () => {
  const { db, raw, shift } = setup({ endsIn: -30 });
  const slot = reportSlotFor(shift.day, shift.starts);
  raw.prepare(
    `INSERT INTO till_report (day, slot, user_id, name, float_ok, cash, to_safe)
     VALUES (?, ?, 7, 'Kwame', 1, 45600, 0)`,
  ).run(slot.day, slot.slot);
  await watchTills(db, { timezone: 'UTC' });
  assert.equal(told(raw).length, 0);
});

test('a report reopened from Insight counts as not in', async () => {
  const { db, raw, shift } = setup({ endsIn: -30 });
  const slot = reportSlotFor(shift.day, shift.starts);
  raw.prepare(
    `INSERT INTO till_report (day, slot, user_id, name, float_ok, cash, to_safe, reopened_at)
     VALUES (?, ?, 7, 'Kwame', 1, 45600, 0, datetime('now'))`,
  ).run(slot.day, slot.slot);
  await watchTills(db, { timezone: 'UTC' });
  assert.equal(told(raw).length, 1);
});

test('a housekeeping shift is not a till to close, and nor is somebody who cannot close one', async () => {
  let s = setup({ endsIn: 10, department: 'Housekeeping' });
  await watchTills(s.db, { timezone: 'UTC' });
  assert.equal(told(s.raw).length, 0, 'the shift’s department decides');

  s = setup({ endsIn: 10, permissions: '["att_me"]' });
  await watchTills(s.db, { timezone: 'UTC' });
  assert.equal(told(s.raw).length, 0, 'no till permission, no till');
});

test('reception is the shift’s department first, then its name, then the person’s', () => {
  assert.equal(isReceptionShift({ department: 'Front Office' }, {}), true);
  assert.equal(isReceptionShift({ department: 'Housekeeping', name: 'Reception cover' }, { department: 'Reception' }), false);
  assert.equal(isReceptionShift({ name: 'Front desk morning' }, {}), true);
  assert.equal(isReceptionShift({ name: 'Morning' }, { department: 'Reception' }), true);
  assert.equal(isReceptionShift({ name: 'Morning' }, { department: 'Kitchen' }), false);
});

test('an Admin shift closes no till, even filed under Reception', () => {
  assert.equal(isReceptionShift({ name: 'Admin', department: 'Reception' }, {}), false);
  assert.equal(isReceptionShift({ name: 'Admin 2', department: 'Reception' }, {}), false);
  assert.equal(isReceptionShift({ name: 'AM Shift', department: 'Reception' }, {}), true);
  assert.equal(isReceptionShift({ name: 'Administration cover', department: 'Reception' }, {}), true,
    'only the word Admin itself, not a longer word that starts with it');
});

test('a rota shift is filed under the closing-report shift its start is nearest', () => {
  assert.deepEqual(reportSlotFor('2026-10-10', '06:00'), { day: '2026-10-10', slot: 'morning' });
  assert.deepEqual(reportSlotFor('2026-10-10', '07:30'), { day: '2026-10-10', slot: 'morning' });
  assert.deepEqual(reportSlotFor('2026-10-10', '14:00'), { day: '2026-10-10', slot: 'afternoon' });
  assert.deepEqual(reportSlotFor('2026-10-10', '22:00'), { day: '2026-10-10', slot: 'night' });
  assert.deepEqual(reportSlotFor('2026-10-11', '00:30'), { day: '2026-10-10', slot: 'night' },
    'a night shift starting after midnight belongs to the evening before');
});

test('every notification kind now emails by default', () => {
  // Except the office's copies of the shift reminders, which are a push and
  // nothing else: asked for that way, because they go out every shift.
  const pushOnly = new Set(['attendance.not_clocked_in_office', 'attendance.clock_out_due_office']);
  // And two more that must not email: the weekly handbook nudge, which is a
  // push, and a signing code, which goes by text precisely so that it never
  // travels with the emailed link.
  const notEmail = new Set([...pushOnly, 'handbook.reminder', 'corr.sign_code', 'people.sign_code']);
  for (const k of KINDS.filter((x) => !notEmail.has(x.key))) assert.ok(goesOut({}, k.key, 'email'), `${k.key} emails`);
  assert.equal(goesOut({}, 'corr.sign_code', 'email'), false);
  assert.equal(goesOut({}, 'corr.sign_code', 'text'), true);
  for (const key of pushOnly) {
    assert.equal(goesOut({}, key, 'email'), false, `${key} does not email`);
    assert.equal(goesOut({}, key, 'push'), true, `${key} pushes`);
  }
  assert.ok(KINDS.some((k) => k.key === 'till.close_due'));
});

test('the next reception shift: whoever is rostered on the next one to start', async () => {
  const later = setup({ endsIn: 10 * 60 });
  const [who] = await nextOnReception(later.db, { timezone: 'UTC' });
  assert.deepEqual([who.userId, who.name], [7, 'Kwame']);
  const now = setup({ endsIn: 10 });
  assert.deepEqual(await nextOnReception(now.db, { timezone: 'UTC' }), [], 'already on shift is not the next one');
});
