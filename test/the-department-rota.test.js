import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { myDepartment } from '../src/routes/me.js';

/**
 * The rota for the people you work beside.
 *
 * Staff see their own week and nothing else, which is right for pay, lateness
 * and leave and wrong for one ordinary question: who else is on tomorrow.
 * Answering it meant asking a supervisor to read the grid out.
 *
 * What is pinned down here is the shape of the answer and, more to the point,
 * the shape of what is withheld. Their own department and no other. Nobody who
 * has been kept off it. Nothing that has not been published. No clock times,
 * no lateness, no leave balance, and no reason for a day away: that somebody is
 * away is the question, why is not.
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

// A Monday, so the week the route builds is the week the test wrote.
const MON = '2099-09-07';
const TUE = '2099-09-08';
const SUN = '2099-09-13';

const TEAM = [
  { id: 1, name: 'Ama', department: 'Front Office' },
  { id: 2, name: 'Kofi', department: 'Front Office' },
  { id: 3, name: 'Yaw', department: 'Front Office' },
  { id: 4, name: 'Esi', department: 'Housekeeping' },
];

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_availability; DELETE FROM att_leave; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, colour)
     VALUES (1, 'Breakfast', '06:00', '14:00', 0, 3)`,
  ).run();
  for (const p of TEAM) {
    raw.prepare(
      'INSERT INTO att_staff (id, employee_no, name, hired_on, department) VALUES (?, ?, ?, ?, ?)',
    ).run(p.id, String(p.id), p.name, '2020-01-01', p.department);
    raw.prepare(
      'INSERT INTO users (id, name, role, active, staff_id) VALUES (?, ?, ?, 1, ?)',
    ).run(100 + p.id, p.name, 'staff', p.id);
  }
  // Ama may look. Everybody is on it until a test says otherwise.
  raw.prepare('UPDATE att_staff SET sees_dept_rota = 1 WHERE id = 1').run();
  return { raw, db: d1(raw) };
}

const asStaff = (id) => ({
  user: { id: 100 + id, name: TEAM.find((p) => p.id === id).name, role: 'staff', staff_id: id },
  permissions: ['att_me'],
});

const ctx = (db, id, from = MON) => ({
  db,
  env: {},
  url: new URL(`https://x/api/me/department?from=${from}`),
  session: asStaff(id),
  executionContext: null,
  request: new Request('https://x/'),
});

const ask = async (db, id, from = MON) => (await myDepartment(ctx(db, id, from))).json();

/** A published shift, or a draft one when told to leave it unpublished. */
const rota = (raw, staffId, day, published = 1) => raw.prepare(
  `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published, ever_published)
   VALUES (?, ?, 1, 'test', ?, ?)`,
).run(staffId, day, published, published);

const dayOf = (data, name, day) => data.people
  .find((p) => p.name === name).days.find((d) => d.day === day);

// ---------------------------------------------------------------------------
// Who may look at all
// ---------------------------------------------------------------------------

test('nobody sees it until somebody turns it on for them', async () => {
  const { db } = setup();
  const out = await ask(db, 2);

  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'not_allowed');
  assert.deepEqual(out.people, []);
});

test('a person with no department is told that, not refused', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_staff SET department = NULL, sees_dept_rota = 1 WHERE id = 1').run();

  const out = await ask(db, 1);
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'no_department');
  assert.equal(out.department, null);
});

// ---------------------------------------------------------------------------
// Whose shifts appear on it
// ---------------------------------------------------------------------------

test('their own department and no other', async () => {
  const { db, raw } = setup();
  for (const p of TEAM) rota(raw, p.id, MON);

  const out = await ask(db, 1);
  assert.equal(out.allowed, true);
  assert.equal(out.department, 'Front Office');
  assert.deepEqual(out.people.map((p) => p.name), ['Ama', 'Kofi', 'Yaw']);
  assert.equal(out.days.length, 7);
  assert.equal(out.days[0], MON);
  assert.equal(out.days[6], SUN);
});

test('somebody kept off the list is not on it', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_staff SET on_dept_rota = 0 WHERE id = 3').run();
  for (const p of TEAM) rota(raw, p.id, MON);

  const out = await ask(db, 1);
  assert.deepEqual(out.people.map((p) => p.name), ['Ama', 'Kofi']);
});

test('your own shifts are yours to see, whatever the switch says', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_staff SET on_dept_rota = 0 WHERE id = 1').run();
  rota(raw, 1, MON);

  const out = await ask(db, 1);
  const me = out.people.find((p) => p.isMe);
  assert.equal(me.name, 'Ama');
  assert.equal(me.days[0].shift.name, 'Breakfast');
});

test('somebody taken off the rota altogether does not appear', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_staff SET on_rota = 0 WHERE id = 2').run();

  const out = await ask(db, 1);
  assert.deepEqual(out.people.map((p) => p.name), ['Ama', 'Yaw']);
});

// ---------------------------------------------------------------------------
// What each day says, and what it does not
// ---------------------------------------------------------------------------

test('a draft shift is not on it, a published one is', async () => {
  const { db, raw } = setup();
  rota(raw, 2, MON, 1);
  rota(raw, 2, TUE, 0);

  const out = await ask(db, 1);
  assert.equal(dayOf(out, 'Kofi', MON).shift.name, 'Breakfast');
  assert.equal(dayOf(out, 'Kofi', TUE).shift, null);
});

test('a shift carries its name, hours and colour and nothing else', async () => {
  const { db, raw } = setup();
  rota(raw, 2, MON);

  const cell = dayOf(await ask(db, 1), 'Kofi', MON);
  assert.deepEqual(Object.keys(cell.shift).sort(),
    ['colour', 'ends_at', 'name', 'starts_at']);
  assert.equal(String(cell.shift.colour), '3');
});

test('a day away shows as away and never says why', async () => {
  const { db, raw } = setup();
  rota(raw, 2, MON);
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status, requested_by, reason)
     VALUES (2, 'sick_leave', ?, ?, 1, 'approved', 'test', 'Hospital in Accra')`,
  ).run(MON, MON);

  const out = await ask(db, 1);
  assert.equal(dayOf(out, 'Kofi', MON).away, true);

  const said = JSON.stringify(out);
  assert.equal(said.includes('sick_leave'), false);
  assert.equal(said.includes('Hospital'), false);
});

test('no clock times, no lateness and no pay travel with it', async () => {
  const { db, raw } = setup();
  rota(raw, 2, MON);
  raw.prepare(
    `INSERT INTO att_punches (staff_id, employee_no, device_serial, at_utc, at_local, day, source, dedupe_key)
     VALUES (2, '2', 'T1', ?, ?, ?, 'test', 'k1')`,
  ).run(`${MON}T06:41:00Z`, `${MON}T06:41:00`, MON);

  const out = await ask(db, 1);
  const cell = dayOf(out, 'Kofi', MON);
  assert.deepEqual(Object.keys(cell).sort(), ['away', 'day', 'holiday', 'restDay', 'shift']);

  const said = JSON.stringify(out);
  for (const leak of ['06:41', 'late', 'salary', 'punch']) {
    assert.equal(said.toLowerCase().includes(leak), false, leak);
  }
});

test('the week can be stepped back and forward', async () => {
  const { db } = setup();
  const before = await ask(db, 1, '2099-08-31');
  assert.equal(before.from, '2099-08-31');
  assert.equal(before.to, '2099-09-06');

  // Any day in a week gives that week, not seven days from wherever you asked.
  const midweek = await ask(db, 1, '2099-09-10');
  assert.equal(midweek.from, MON);
});

test('a day nobody has published is not called a rest day', async () => {
  const { db, raw } = setup();
  rota(raw, 2, MON, 1);

  const out = await ask(db, 1);
  // Monday is published for Kofi and Tuesday is not published for anybody.
  // Only one of those is a day off, and the other one is nothing yet.
  assert.equal(dayOf(out, 'Kofi', MON).restDay, false, 'he is on it');
  assert.equal(dayOf(out, 'Ama', MON).restDay, false, 'nothing published for that day');
});

test('a day inside a published week with nothing on it is a rest day', async () => {
  const { db, raw } = setup();
  rota(raw, 2, MON, 1);
  raw.prepare(
    "INSERT INTO rota_publish (from_day, to_day, changes, actor) VALUES (?, ?, 1, 'test')",
  ).run(MON, SUN);

  const out = await ask(db, 1);
  assert.equal(dayOf(out, 'Kofi', MON).restDay, false, 'he is working');
  assert.equal(dayOf(out, 'Kofi', TUE).restDay, true, 'published week, nothing on it');
  assert.equal(dayOf(out, 'Ama', MON).restDay, true);
});
