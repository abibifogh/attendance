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
  { id: 5, name: 'Kojo', department: 'Housekeeping' },
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
  // One shift per department, so a shift can say which department it belongs
  // to and somebody can be put on one that is not their own.
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, colour, department)
     VALUES (1, 'Breakfast', '06:00', '14:00', 0, 3, 'Front Office')`,
  ).run();
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, department)
     VALUES (2, 'Turndown', '14:00', '22:00', 0, 'Housekeeping')`,
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

const ctx = (db, id, from = MON, department = null) => ({
  db,
  env: {},
  url: new URL(`https://x/api/me/department?from=${from}`
    + (department ? `&department=${encodeURIComponent(department)}` : '')),
  session: asStaff(id),
  executionContext: null,
  request: new Request('https://x/'),
});

const ask = async (db, id, from = MON, department = null) =>
  (await myDepartment(ctx(db, id, from, department))).json();

/** Name the other departments somebody may look at. */
const alsoSees = (raw, id, names) => raw.prepare(
  'UPDATE att_staff SET dept_rota_extra = ? WHERE id = ?',
).run(JSON.stringify(names), id);

/** A published shift, or a draft one when told to leave it unpublished. */
/** Which shift belongs to which department, for the fixture's two. */
const SHIFT_OF = { 'Front Office': 1, Housekeeping: 2 };

/** Everybody on a shift of their own department, which is the ordinary week. */
const everybodyAtHome = (raw, day) => {
  for (const p of TEAM) rota(raw, p.id, day, 1, SHIFT_OF[p.department]);
};

const rota = (raw, staffId, day, published = 1, shiftId = 1) => raw.prepare(
  `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published, ever_published)
   VALUES (?, ?, ?, 'test', ?, ?)`,
).run(staffId, day, shiftId, published, published);

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
  everybodyAtHome(raw, MON);

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
  everybodyAtHome(raw, MON);

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
  assert.deepEqual(Object.keys(cell).sort(),
    ['away', 'day', 'elsewhere', 'holiday', 'restDay', 'shift']);

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

// ---------------------------------------------------------------------------
// The other departments they may look at
// ---------------------------------------------------------------------------

test('their own is the only one until somebody names another', async () => {
  const { db } = setup();
  const out = await ask(db, 1);
  assert.deepEqual(out.departments, ['Front Office']);
  assert.equal(out.mine, 'Front Office');
});

test('a named department is offered and can be opened', async () => {
  const { db, raw } = setup();
  alsoSees(raw, 1, ['Housekeeping']);
  for (const p of TEAM) rota(raw, p.id, MON);

  const out = await ask(db, 1);
  assert.deepEqual(out.departments, ['Front Office', 'Housekeeping']);
  assert.equal(out.department, 'Front Office', 'their own to begin with');

  const theirs = await ask(db, 1, MON, 'Housekeeping');
  assert.equal(theirs.department, 'Housekeeping');
  assert.deepEqual(theirs.people.map((p) => p.name), ['Esi', 'Kojo']);
  assert.ok(!theirs.people.some((p) => p.isMe), 'she is not in that one');
});

test('a department nobody named for them is not opened by asking for it', async () => {
  const { db, raw } = setup();
  everybodyAtHome(raw, MON);

  const out = await ask(db, 1, MON, 'Housekeeping');
  assert.equal(out.department, 'Front Office', 'their own, rather than what was asked for');
  assert.ok(!out.people.some((p) => p.name === 'Esi'));
});

test('somebody kept off the list is kept off the other departments too', async () => {
  const { db, raw } = setup();
  alsoSees(raw, 1, ['Housekeeping']);
  raw.prepare('UPDATE att_staff SET on_dept_rota = 0 WHERE id = 5').run();
  for (const p of TEAM) rota(raw, p.id, MON);

  const out = await ask(db, 1, MON, 'Housekeeping');
  assert.deepEqual(out.people.map((p) => p.name), ['Esi']);
});

test('the always-see-yourself exception is about your own department', async () => {
  const { db, raw } = setup();
  // She is kept off the list and given somebody else's department to read.
  raw.prepare("UPDATE att_staff SET on_dept_rota = 0, department = 'Housekeeping' WHERE id = 1").run();
  alsoSees(raw, 1, ['Front Office']);
  for (const p of TEAM) rota(raw, p.id, MON);

  // On her own she is still there, because her shifts are hers to see.
  const home = await ask(db, 1, MON, 'Housekeeping');
  assert.ok(home.people.some((p) => p.isMe));

  // Reading the other one she is a visitor, and the switch holds.
  const away = await ask(db, 1, MON, 'Front Office');
  assert.ok(!away.people.some((p) => p.isMe));
});

test('somebody with no department of their own can still be given one to read', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_staff SET department = NULL WHERE id = 1').run();
  alsoSees(raw, 1, ['Housekeeping']);
  for (const p of TEAM) rota(raw, p.id, MON);

  const out = await ask(db, 1);
  assert.equal(out.allowed, true);
  assert.deepEqual(out.departments, ['Housekeeping']);
  assert.equal(out.mine, null);
});

test('a broken list means their own department and no other', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE att_staff SET dept_rota_extra = 'not json' WHERE id = 1").run();
  for (const p of TEAM) rota(raw, p.id, MON);

  const out = await ask(db, 1);
  assert.deepEqual(out.departments, ['Front Office']);
  const asked = await ask(db, 1, MON, 'Housekeeping');
  assert.equal(asked.department, 'Front Office');
});

test('the switch above it still decides whether any of it shows', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_staff SET sees_dept_rota = 0 WHERE id = 1').run();
  alsoSees(raw, 1, ['Housekeeping']);

  const out = await ask(db, 1);
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'not_allowed');
  assert.deepEqual(out.departments, []);
});

// ---------------------------------------------------------------------------
// Whoever is actually on the shifts
// ---------------------------------------------------------------------------

test('somebody covering one of the department’s shifts is on its rota', async () => {
  const { db, raw } = setup();
  // Esi is Housekeeping and is down for a Front Office shift on Monday.
  rota(raw, 4, MON, 1, 1);
  rota(raw, 2, MON, 1, 1);

  const out = await ask(db, 1);
  const esi = out.people.find((p) => p.name === 'Esi');
  assert.ok(esi, 'she is working here, so she is on the page');
  assert.equal(esi.visiting, true);
  assert.equal(esi.homeDepartment, 'Housekeeping');
  assert.equal(dayOf(out, 'Esi', MON).shift.name, 'Breakfast');
});

test('a visitor’s other days are not this department’s business', async () => {
  const { db, raw } = setup();
  rota(raw, 4, MON, 1, 1);
  // And her own department's shift on the Tuesday, which reception must not
  // learn about from a page that is supposed to be about reception.
  rota(raw, 4, TUE, 1, 2);
  raw.prepare(
    "INSERT INTO rota_publish (from_day, to_day, changes, actor) VALUES (?, ?, 2, 'test')",
  ).run(MON, SUN);

  const out = await ask(db, 1);
  assert.equal(dayOf(out, 'Esi', MON).shift.name, 'Breakfast');

  const tuesday = dayOf(out, 'Esi', TUE);
  assert.equal(tuesday.shift, null, 'her Housekeeping shift is not shown here');
  assert.equal(tuesday.elsewhere, true);
  // And it is not dressed up as a day off, which would be a lie about a day
  // she is working.
  assert.equal(tuesday.restDay, false);

  assert.equal(JSON.stringify(out).includes('Turndown'), false);
});

test('a visitor away on a day they were coming says so, and not otherwise', async () => {
  const { db, raw } = setup();
  rota(raw, 4, MON, 1, 1);
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status, requested_by)
     VALUES (4, 'annual_leave', ?, ?, 2, 'approved', 'test')`,
  ).run(MON, TUE);

  const out = await ask(db, 1);
  assert.equal(dayOf(out, 'Esi', MON).away, true, 'reception needs to know their cover is off');
  assert.equal(dayOf(out, 'Esi', TUE).away, false, 'a day she was never coming here');
});

test('the department’s own people keep their whole week', async () => {
  const { db, raw } = setup();
  // Kofi is Front Office and covers a Housekeeping shift on Tuesday. On his
  // own department's page that is still his week, and his colleagues see it
  // exactly as they always did.
  rota(raw, 2, MON, 1, 1);
  rota(raw, 2, TUE, 1, 2);

  const out = await ask(db, 1);
  const kofi = out.people.find((p) => p.name === 'Kofi');
  assert.equal(kofi.visiting, false);
  assert.equal(dayOf(out, 'Kofi', TUE).shift.name, 'Turndown');
});

test('cover is looked for across the whole week, not just one day', async () => {
  const { db, raw } = setup();
  // Nothing on Monday, one Front Office shift on the Sunday.
  rota(raw, 4, SUN, 1, 1);

  const out = await ask(db, 1);
  assert.ok(out.people.some((p) => p.name === 'Esi'));
  assert.equal(dayOf(out, 'Esi', SUN).shift.name, 'Breakfast');
  assert.equal(dayOf(out, 'Esi', MON).elsewhere, true);
});

test('a draft shift does not put somebody on another department’s rota', async () => {
  const { db, raw } = setup();
  rota(raw, 4, MON, 0, 1);

  const out = await ask(db, 1);
  assert.ok(!out.people.some((p) => p.name === 'Esi'),
    'a plan is not a reason to appear on somebody else’s page');
});

test('somebody kept off the list stays off it when covering', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_staff SET on_dept_rota = 0 WHERE id = 4').run();
  rota(raw, 4, MON, 1, 1);

  const out = await ask(db, 1);
  assert.ok(!out.people.some((p) => p.name === 'Esi'));
});

test('the same holds on a department they were given to read', async () => {
  const { db, raw } = setup();
  alsoSees(raw, 1, ['Housekeeping']);
  // Kofi from Front Office covers a Housekeeping shift.
  rota(raw, 2, MON, 1, 2);
  rota(raw, 4, MON, 1, 2);

  const out = await ask(db, 1, MON, 'Housekeeping');
  const kofi = out.people.find((p) => p.name === 'Kofi');
  assert.ok(kofi, 'he is on their shifts that week');
  assert.equal(kofi.visiting, true);
  assert.equal(kofi.homeDepartment, 'Front Office');
  assert.equal(dayOf(out, 'Kofi', MON).shift.name, 'Turndown');
});

test('a shift belonging to no department pulls nobody onto anything', async () => {
  const { db, raw } = setup();
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes)
     VALUES (3, 'Stock take', '09:00', '13:00', 0)`,
  ).run();
  rota(raw, 4, MON, 1, 3);

  const out = await ask(db, 1);
  assert.ok(!out.people.some((p) => p.name === 'Esi'),
    'a shift that belongs to nobody belongs to no rota');
});
