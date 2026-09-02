import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { updateStaff } from '../src/routes/attendance-setup.js';
import { paidInMonth, settleLeaving, sweepLeavers } from '../src/lib/leaving.js';

/**
 * Somebody leaves, and one date does the whole of it.
 *
 * The record, the login, the phone, the rota and the payroll used to be five
 * separate things to remember. Now the leaving date is the fact and the rest
 * follows from it: at once for a date already passed, on the morning after
 * for one still ahead.
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

const today = () => new Date().toISOString().slice(0, 10);
const shiftDay = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM users; DELETE FROM audit_log;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Reception', '06:00', '14:00', 0, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on, active)
     VALUES (1, '1', 'Kofi', 'Front', '2020-01-01', 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO users (id, name, role, pin_hash, active, staff_id)
     VALUES (7, 'Kofi', 'staff', 'hash', 1, 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (7, 'https://p/1', 'k', 'a')`,
  ).run();
  raw.prepare('INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 1, 1)').run();
  const t = today();
  for (const n of [-3, -1, 0, 1, 2, 9]) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, set_by, published) VALUES (1, ?, 1, \'seed\', 1)')
      .run(shiftDay(t, n));
  }
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 3, name: 'Kwame', role: 'admin' }, permissions: ['att_setup'] };
const ctx = (db, body) => ({
  db, env: {}, url: new URL('https://x/api/att/staff/1'), session: ADMIN, executionContext: null,
  request: new Request('https://x/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
});

const staff = (raw) => raw.prepare('SELECT active, left_on FROM att_staff WHERE id = 1').get();
const login = (raw) => raw.prepare('SELECT active FROM users WHERE id = 7').get();
const phones = (raw) => raw.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = 7').get().n;
const rosterDays = (raw) => raw.prepare('SELECT day FROM att_roster WHERE staff_id = 1 ORDER BY day').all().map((r) => r.day);
const patterns = (raw) => raw.prepare('SELECT COUNT(*) n FROM att_patterns WHERE staff_id = 1').get().n;

test('a leaving date already passed switches everything off at once', async () => {
  const { raw, db } = setup();
  const t = today();
  const leftOn = shiftDay(t, -1);

  const out = await (await updateStaff(ctx(db, { name: 'Kofi', employeeNo: '1', leftOn }), 1)).json();

  assert.equal(out.left.leftOn, leftOn);
  assert.equal(out.left.gone, true);
  assert.equal(out.left.loginOff, true);
  assert.equal(out.left.cleared, 4, 'today and the three days after it come off the rota');

  assert.equal(staff(raw).active, 0);
  assert.equal(login(raw).active, 0, 'they cannot sign in any more');
  assert.equal(phones(raw), 0, 'and their phone is not told about shifts');
  assert.equal(patterns(raw), 0, 'the standing pattern cannot put them back');
  assert.deepEqual(rosterDays(raw), [shiftDay(t, -3), shiftDay(t, -1)],
    'the days up to and including the last one are history and stay');

  const logged = raw.prepare("SELECT COUNT(*) n FROM att_roster_log WHERE source = 'left' AND staff_id = 1").get().n;
  assert.equal(logged, 4, 'every removed shift is on the rota log with the reason');
});

test('a leaving date still ahead clears the rota beyond it now and leaves the rest for the morning after', async () => {
  const { raw, db } = setup();
  const t = today();
  const leftOn = shiftDay(t, 1);

  const out = await (await updateStaff(ctx(db, { name: 'Kofi', employeeNo: '1', leftOn }), 1)).json();
  assert.equal(out.left.gone, false);
  assert.equal(out.left.cleared, 2, 'the two days after their last one');

  assert.equal(staff(raw).active, 1, 'still working their notice');
  assert.equal(login(raw).active, 1);
  assert.equal(phones(raw), 1);
  assert.deepEqual(rosterDays(raw), [shiftDay(t, -3), shiftDay(t, -1), t, shiftDay(t, 1)]);

  // The nightly run on the day after their last one.
  const notYet = await sweepLeavers(db, { today: leftOn });
  assert.equal(notYet.length, 0, 'their last day is still theirs');
  assert.equal(login(raw).active, 1);

  const done = await sweepLeavers(db, { today: shiftDay(leftOn, 1) });
  assert.equal(done.length, 1);
  assert.equal(done[0].name, 'Kofi');
  assert.equal(staff(raw).active, 0);
  assert.equal(login(raw).active, 0);
  assert.equal(phones(raw), 0);
  assert.equal(patterns(raw), 0);

  // And running it again finds nobody.
  assert.equal((await sweepLeavers(db, { today: shiftDay(leftOn, 2) })).length, 0);
});

test('saving the form again with the same date does not do it twice', async () => {
  const { raw, db } = setup();
  const leftOn = shiftDay(today(), 5);
  await updateStaff(ctx(db, { name: 'Kofi', employeeNo: '1', leftOn }), 1);
  const before = raw.prepare('SELECT COUNT(*) n FROM att_roster_log').get().n;
  const again = await (await updateStaff(ctx(db, { name: 'Kofi', employeeNo: '1', leftOn }), 1)).json();
  assert.equal(again.left, null);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_roster_log').get().n, before);
});

test('the form saying active while the date has passed is overruled by the date', async () => {
  const { raw, db } = setup();
  const leftOn = shiftDay(today(), -10);
  await updateStaff(ctx(db, { name: 'Kofi', employeeNo: '1', leftOn, active: true }), 1);
  assert.equal(staff(raw).active, 0, 'the date is the fact; the tick was left over');
});

test('settleLeaving on its own, without a login to switch off', async () => {
  const { raw, db } = setup();
  raw.exec('DELETE FROM users');
  const out = await settleLeaving(db, { staffId: 1, leftOn: shiftDay(today(), -1), today: today() });
  assert.equal(out.gone, true);
  assert.equal(out.loginOff, false);
  assert.equal(staff(raw).active, 0);
});

test('the month somebody leaves in is still a paid month, and the one after is not', () => {
  const gone = { active: 0, left_on: '2026-08-14' };
  assert.equal(paidInMonth(gone, '2026-07'), true);
  assert.equal(paidInMonth(gone, '2026-08'), true);
  assert.equal(paidInMonth(gone, '2026-09'), false);
  assert.equal(paidInMonth({ active: 1, left_on: null }, '2026-09'), true);
  assert.equal(paidInMonth({ active: 0, left_on: null }, '2026-09'), false, 'switched off by hand with no date: off');
});
