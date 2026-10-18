import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { owedReports, watchTills } from '../src/lib/till-watch.js';

/**
 * A closing report that never came in, chased every day until it does.
 *
 * The reminders at the end of a shift are said once each. A report still
 * missing after that is said again every morning from eight, in one message
 * listing everything owed, until the last of it is in. A shift somebody did
 * not actually work owes nothing. The clock is pinned so the days are fixed.
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

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_leave; DELETE FROM app_notices; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes, department)
     VALUES (1, 'AM Shift', '06:00', '14:15', 0, 5, 'Reception')`,
  ).run();
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (1, '1', 'Kwame', 'Reception', '2020-01-01')").run();
  raw.prepare("INSERT INTO users (id, name, role, pin_hash, staff_id, active, permissions) VALUES (7, 'Kwame', 'staff', 'x', 1, 1, '[\"att_me\",\"till\"]')").run();
  // The property's first closing report, by somebody else, which is where
  // owing one starts.
  raw.prepare("INSERT INTO till_report (day, slot, user_id, name, float_ok, cash, to_safe) VALUES ('2026-10-12', 'morning', 99, 'Esi', 1, 100, 0)").run();
  return { raw, db: d1(raw) };
}

/** On the rota for the morning shift that day, and clocked in and out of it. */
function worked(raw, day, { punched = true } = {}) {
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)').run(day);
  if (!punched) return;
  for (const [at, direction] of [[`${day} 05:55:00`, 'in'], [`${day} 14:20:00`, 'out']]) {
    raw.prepare(
      `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day, direction, dedupe_key)
       VALUES ('D1', '1', 1, ?1, ?1, ?2, ?3, ?4)`,
    ).run(at, day, direction, `${at}-${direction}`);
  }
}

const closed = (raw, day) => raw.prepare(
  "INSERT INTO till_report (day, slot, user_id, name, float_ok, cash, to_safe) VALUES (?, 'morning', 7, 'Kwame', 1, 100, 0)",
).run(day);

const owedNotices = (raw) => raw.prepare("SELECT * FROM app_notices WHERE kind = 'till.close_owed' ORDER BY id").all();

test('what is owed: shifts worked and not closed, oldest first, and nothing for a day not worked', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T09:00:00Z') });
  const { raw, db } = setup();
  worked(raw, '2026-10-14');
  worked(raw, '2026-10-15', { punched: false });
  worked(raw, '2026-10-16');
  worked(raw, '2026-10-17');
  closed(raw, '2026-10-16');
  // Today's shift is still running, so nothing is owed for it yet.
  worked(raw, '2026-10-18');

  const list = await owedReports(db, { userId: 7, staffId: 1, timezone: 'UTC' });
  // The 14th is before the 15 October cut-off, so it is not asked for.
  assert.deepEqual(list.map((r) => `${r.day} ${r.slot}`), ['2026-10-17 morning']);
});

test('nothing missing from before 15 October is asked for; the 15th itself is', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T09:00:00Z') });
  const { raw, db } = setup();
  worked(raw, '2026-10-13');
  worked(raw, '2026-10-14');
  worked(raw, '2026-10-15');
  const list = await owedReports(db, { userId: 7, staffId: 1, timezone: 'UTC' });
  assert.deepEqual(list.map((r) => r.day), ['2026-10-15']);

  // Nor does it hold up a later report: only the 15th stands in the way.
  closed(raw, '2026-10-15');
  assert.deepEqual(await owedReports(db, { userId: 7, staffId: 1, timezone: 'UTC' }), []);
});

test('nothing is owed before the property’s first closing report', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T09:00:00Z') });
  const { raw, db } = setup();
  worked(raw, '2026-10-10');
  assert.deepEqual(await owedReports(db, { userId: 7, staffId: 1, timezone: 'UTC' }), []);
});

test('reminded every morning from eight, once a day, until it is in', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T07:30:00Z') });
  const { raw, db } = setup();
  worked(raw, '2026-10-17');

  await watchTills(db, { timezone: 'UTC' });
  assert.equal(owedNotices(raw).length, 0, 'not before eight');

  t.mock.timers.setTime(Date.parse('2026-10-18T08:05:00Z'));
  const out = await watchTills(db, { timezone: 'UTC' });
  assert.equal(out.owed, 1);
  const [n] = owedNotices(raw);
  assert.equal(n.user_id, 7);
  assert.equal(n.link, '#/att-my-till');
  assert.match(n.title, /closing report for the morning shift on .*17 October is still not in/);
  assert.match(n.body, /A later shift cannot be closed until it is in/);

  t.mock.timers.setTime(Date.parse('2026-10-18T15:00:00Z'));
  await watchTills(db, { timezone: 'UTC' });
  assert.equal(owedNotices(raw).length, 1, 'once a day');

  t.mock.timers.setTime(Date.parse('2026-10-19T08:10:00Z'));
  await watchTills(db, { timezone: 'UTC' });
  assert.equal(owedNotices(raw).length, 2, 'and again the next day');

  closed(raw, '2026-10-17');
  t.mock.timers.setTime(Date.parse('2026-10-20T08:10:00Z'));
  await watchTills(db, { timezone: 'UTC' });
  assert.equal(owedNotices(raw).length, 2, 'and not once it is in');
});

test('several owed come as one message, oldest first', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T09:00:00Z') });
  const { raw, db } = setup();
  worked(raw, '2026-10-15');
  worked(raw, '2026-10-17');
  await watchTills(db, { timezone: 'UTC' });
  const all = owedNotices(raw);
  assert.equal(all.length, 1);
  assert.match(all[0].title, /^2 closing reports are still not in/);
  assert.match(all[0].body, /Start with the oldest: the morning shift on .*15 October/);
});
