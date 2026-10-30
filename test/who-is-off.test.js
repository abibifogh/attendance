import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { awayCalendar } from '../src/routes/attendance.js';

/**
 * Who is off, the calendar on Leave.
 *
 * A fortnight of days, each with the people away on it: leave and days
 * somebody cannot work together, as the limit counts them, with what is only
 * asked for told apart. Whoever may see requests before they are decided sees
 * them; anybody else sees approved days only. Made-up people throughout.
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
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_availability; DELETE FROM users; DELETE FROM app_notices;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Reception', '06:00', '14:00', 0, 5)`,
  ).run();
  raw.exec(`DELETE FROM att_leave;
    INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES
      (1, '1', 'Adjoa Test', 'Kitchen', '2020-01-01'),
      (2, '2', 'Kofi Test', 'Front office', '2020-01-01'),
      (3, '3', 'Esi Test', 'Kitchen', '2020-01-01');
    INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status) VALUES
      (1, 'annual_leave', '2099-09-14', '2099-09-16', 3, 'approved'),
      (2, 'annual_leave', '2099-09-15', '2099-09-15', 1, 'pending'),
      (3, 'annual_leave', '2099-09-15', '2099-09-15', 1, 'rejected');
    INSERT INTO att_availability (staff_id, day, status, decision) VALUES
      (3, '2099-09-16', 'unavailable', 'approved'),
      (2, '2099-09-17', 'unavailable', 'waiting');
    INSERT OR REPLACE INTO settings (key, value) VALUES ('att_away_cap', '2');`);
  return { raw, db: d1(raw) };
}

const MANAGER = { user: { id: 2, name: 'Yaa', role: 'supervisor' }, permissions: ['att_view', 'att_manage'] };
const READER = { user: { id: 4, name: 'Ato', role: 'viewer' }, permissions: ['att_view', 'att_reports'] };

const ctx = (db, query, session = MANAGER) => ({ db, env: {}, url: new URL(`https://x/api/att/away${query}`), session });
const read = async (db, query, session) => (await awayCalendar(ctx(db, query, session))).json();
const on = (data, day) => data.days.find((d) => d.day === day).people;

test('a fortnight from the day asked, each day with who is away and why', async () => {
  const { db } = setup();
  const data = await read(db, '?from=2099-09-14');
  assert.equal(data.from, '2099-09-14');
  assert.equal(data.to, '2099-09-27');
  assert.equal(data.days.length, 14);
  assert.equal(data.cap, 2);
  assert.deepEqual(on(data, '2099-09-14').map((p) => p.name), ['Adjoa Test']);
  // Leave and a day somebody cannot work, counted together.
  assert.deepEqual(on(data, '2099-09-16').map((p) => [p.name, p.why]).sort(),
    [['Adjoa Test', 'leave'], ['Esi Test', 'unavailable']]);
  assert.equal(on(data, '2099-09-16')[0].department, 'Kitchen');
});

test('what is only asked for is told apart, and what was turned down is not there', async () => {
  const { db } = setup();
  const data = await read(db, '?from=2099-09-14');
  const fifteenth = on(data, '2099-09-15');
  assert.deepEqual(fifteenth.map((p) => [p.name, p.asked]).sort(), [['Adjoa Test', false], ['Kofi Test', true]]);
  assert.deepEqual(on(data, '2099-09-17').map((p) => [p.name, p.why, p.asked]), [['Kofi Test', 'unavailable', true]]);
  assert.equal(data.showsAsked, true);
});

test('a reader who never sees requests sees approved days only', async () => {
  const { db } = setup();
  const data = await read(db, '?from=2099-09-14', READER);
  assert.equal(data.showsAsked, false);
  assert.deepEqual(on(data, '2099-09-15').map((p) => p.name), ['Adjoa Test']);
  assert.deepEqual(on(data, '2099-09-17'), []);
});

test('a long window is cut to six weeks, and a backwards one is refused', async () => {
  const { db } = setup();
  const data = await read(db, '?from=2099-09-14&to=2100-03-01');
  assert.equal(data.days.length, 42);
  await assert.rejects(awayCalendar(ctx(db, '?from=2099-09-14&to=2099-09-01')), /before the start/);
});
