import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { requestLeave } from '../src/routes/attendance.js';
import { askForLeave } from '../src/routes/me.js';

/**
 * Half days are gone from a leave request.
 *
 * A property that does not run half days does not want a control offering
 * them: it is a field on every leave form that is wrong every time somebody
 * uses it, and the balance it takes half a day off is the one people argue
 * about at the end of the year.
 *
 * Off both forms, and refused by both routes. Refused rather than ignored,
 * because the only thing that can still send one is a page somebody has had
 * open since before the change, and quietly charging them a whole day for what
 * they asked to be a half is the worse of the two wrongs.
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
  raw.exec(`DELETE FROM att_days; DELETE FROM att_roster; DELETE FROM att_shifts;
            DELETE FROM att_staff; DELETE FROM att_leave; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on, active)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-01', 1)`,
  ).run();
  raw.prepare(
    'INSERT INTO users (id, name, role, active, staff_id) VALUES (9, ?, ?, 1, 1)',
  ).run('Kofi', 'staff');
  for (const day of ['2099-06-01', '2099-06-02', '2099-06-03', '2099-06-04', '2099-06-05']) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, 1)').run(day);
  }
  return { raw, db: d1(raw) };
}

const ctx = (db, session, body) => ({
  db,
  env: {},
  url: new URL('https://x/api/att/leave'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const PLANNER = { user: { id: 7, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };
const KOFI = { user: { id: 9, name: 'Kofi', role: 'staff', staff_id: 1 }, permissions: ['att_me'] };

const SPAN = { from: '2099-06-01', to: '2099-06-05', reason: 'annual_leave' };

test('a planner asking with a half day is refused, and told why', async () => {
  const { db } = setup();
  await assert.rejects(
    () => requestLeave(ctx(db, PLANNER, { ...SPAN, staffId: 1, halfDay: 'start' })),
    /Half days are no longer part of a leave request/,
  );
});

test('and so is a member of staff on a page they have had open since before', async () => {
  const { db } = setup();
  for (const halfDay of ['start', 'end', 'both']) {
    await assert.rejects(
      () => askForLeave(ctx(db, KOFI, { ...SPAN, halfDay })),
      /Half days are no longer part of a leave request/,
      `${halfDay} is refused`,
    );
  }
});

test('the same request without one goes through, at whole days', async () => {
  const { raw, db } = setup();
  const out = await (await requestLeave(ctx(db, PLANNER, { ...SPAN, staffId: 1 }))).json();
  assert.equal(out.days, 5);

  const row = raw.prepare('SELECT * FROM att_leave WHERE id = ?').get(out.id);
  assert.equal(row.half_day, null, 'nothing is written to the column');
});

test('neither form offers one any more', () => {
  for (const view of ['public/js/views/att-me.js', 'public/js/views/att-leave.js']) {
    const text = readFileSync(view, 'utf8');
    assert.equal(/name: 'halfDay'/.test(text), false, `${view} still has the field`);
    assert.equal(/Half day at each end/.test(text), false, `${view} still offers one`);
  }
});
