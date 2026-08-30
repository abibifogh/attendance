import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { staffReport } from '../src/routes/attendance.js';

/**
 * What the terminal actually sent, under the figures worked out from it.
 *
 * Every other reading on a person's page is what a day was decided to be.
 * None of them said what the clock recorded, so "he clocked in and it says he
 * did not" had no answer anywhere in the app: a punch that never arrived and a
 * punch that arrived and was not counted looked identical, and they want
 * completely different things done about them.
 *
 * The case that matters is a punch under somebody's number that is joined to
 * nobody. Punches attach by employee number and nothing else, so one of those
 * is invisible in every figure on the page while sitting in the database under
 * their own number. A query filtered by staff_id can never show it.
 */

function d1(db) {
  const st = (sql, b = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...b) }; },
    async first() { return db.prepare(sql).get(...b) ?? null; },
    async run() {
      const r = db.prepare(sql).run(...b);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return { prepare: (s) => st(s), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

const DAY = '2026-08-30';

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM att_shifts; DELETE FROM att_roster;'
    + ' DELETE FROM att_punches; DELETE FROM att_days;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, active)
     VALUES (1, 'Admin', '08:00', '17:00', 0, 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on, on_rota, on_clock, active)
     VALUES (1, 'Adm001', 'Godfred Donkor', 'Admin', '2020-01-01', 1, 1, 1)`,
  ).run();
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
    .run(DAY);
  return { raw, db: d1(raw) };
}

const punch = (raw, { no, at, direction, staffId }) => raw.prepare(
  `INSERT INTO att_punches
     (device_serial, employee_no, staff_id, day, at_local, at_utc, direction, source, dedupe_key)
   VALUES ('DS-K1T', ?, ?, ?, ?, ?, ?, 'poller', ?)`,
).run(no, staffId, DAY, `${DAY}T${at}:00`, `${DAY}T${at}:00Z`, direction, `k-${no}-${at}`);

const BOSS = {
  user: { id: 9, name: 'Michael', role: 'admin' },
  permissions: ['att_view', 'att_reports', 'att_signoff'],
};
const ctx = (db, query) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/staff/1/report${query}`),
  session: BOSS,
  executionContext: null,
  request: new Request('https://x/'),
});
const read = async (r) => r.json();
const RANGE = `?from=${DAY}&to=${DAY}`;

test('a day the terminal recorded nothing for says exactly that', async () => {
  const { db } = setup();
  const data = await read(await staffReport(ctx(db, RANGE), 1));
  assert.deepEqual(data.punches, [], 'nothing came in, and nothing is invented');
  assert.equal(data.days[0].status, 'absent');
});

test('the punches behind a day are shown as the terminal sent them', async () => {
  const { raw, db } = setup();
  punch(raw, { no: 'Adm001', at: '07:58', direction: 'in', staffId: 1 });
  punch(raw, { no: 'Adm001', at: '17:03', direction: 'out', staffId: 1 });

  const data = await read(await staffReport(ctx(db, RANGE), 1));
  assert.equal(data.punches.length, 2);
  assert.deepEqual(data.punches.map((p) => p.direction), ['in', 'out']);
  assert.equal(data.punches[0].device, 'DS-K1T');
  assert.ok(data.punches.every((p) => p.attached));
  assert.equal(data.days[0].status, 'present', 'and the day agrees with them');
});

test('a punch under their number that joined to nobody is shown, and marked', async () => {
  const { raw, db } = setup();
  // What a number that no longer matches looks like: the reading is kept, it
  // is attached to nobody, and every figure on the page ignores it.
  punch(raw, { no: 'Adm001', at: '07:58', direction: 'in', staffId: null });

  const data = await read(await staffReport(ctx(db, RANGE), 1));
  assert.equal(data.punches.length, 1, 'found by number, not by person');
  assert.equal(data.punches[0].attached, false);
  assert.equal(data.punches[0].employeeNo, 'Adm001');
  assert.equal(data.days[0].status, 'absent', 'which is why the day still reads absent');
});

test('a punch under somebody else number is not dragged in', async () => {
  const { raw, db } = setup();
  punch(raw, { no: 'Rec004', at: '07:58', direction: 'in', staffId: null });
  const data = await read(await staffReport(ctx(db, RANGE), 1));
  assert.deepEqual(data.punches, []);
});

test('the day either side comes too, so a night shift is whole', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_punches
       (device_serial, employee_no, staff_id, day, at_local, at_utc, direction, source, dedupe_key)
     VALUES ('DS-K1T', 'Adm001', 1, '2026-08-31', '2026-08-31T02:10:00', '2026-08-31T02:10:00Z',
             'out', 'poller', 'k-night')`,
  ).run();
  const data = await read(await staffReport(ctx(db, RANGE), 1));
  assert.equal(data.punches.length, 1, 'the small hours of the next morning belong to this night');
  assert.equal(data.punches[0].day, '2026-08-31');
});
