import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { myDepartment } from '../src/routes/me.js';

/**
 * The note the planner wrote on a shift goes with the shift.
 *
 * A cell on the grid can carry a line of its own: "Breakfast helper" with
 * "+ lunch" written on it is a different day from plain Breakfast helper, and
 * the planner writes that note precisely because the shift's own name does not
 * say the whole job. The person it belongs to has always seen it on their own
 * week. Nobody else did, so the colleague reading the department rota to find
 * out who is doing lunch saw a name that told them the opposite.
 *
 * So the note travels wherever the shift does and no further. A day nobody has
 * published carries neither. A visitor's day somewhere else carries neither,
 * because this department was never told about that day at all.
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

const MON = '2099-09-07';
const TUE = '2099-09-08';
const SUN = '2099-09-13';

const TEAM = [
  { id: 1, name: 'Ama', department: 'Kitchen' },
  { id: 2, name: 'Kofi', department: 'Kitchen' },
  { id: 3, name: 'Esi', department: 'Housekeeping' },
];

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_patterns; DELETE FROM att_leave; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, department)
     VALUES (1, 'Breakfast helper', '06:00', '14:00', 0, 'Kitchen'),
            (2, 'Turndown', '14:00', '22:00', 0, 'Housekeeping')`,
  ).run();
  for (const p of TEAM) {
    raw.prepare(
      'INSERT INTO att_staff (id, employee_no, name, hired_on, department) VALUES (?, ?, ?, ?, ?)',
    ).run(p.id, String(p.id), p.name, '2020-01-01', p.department);
    raw.prepare(
      'INSERT INTO users (id, name, role, active, staff_id) VALUES (?, ?, ?, 1, ?)',
    ).run(100 + p.id, p.name, 'staff', p.id);
  }
  raw.prepare('UPDATE att_staff SET sees_dept_rota = 1 WHERE id = 1').run();
  return { raw, db: d1(raw) };
}

const ctx = (db, id, department = null) => ({
  db,
  env: {},
  url: new URL(`https://x/api/me/department?from=${MON}`
    + (department ? `&department=${encodeURIComponent(department)}` : '')),
  session: {
    user: { id: 100 + id, name: TEAM.find((p) => p.id === id).name, role: 'staff', staff_id: id },
    permissions: ['att_me'],
  },
  executionContext: null,
  request: new Request('https://x/'),
});

const ask = async (db, id, department = null) =>
  (await myDepartment(ctx(db, id, department))).json();

/** A rostered day, with or without a note on it. */
const rota = (raw, staffId, day, {
  shiftId = 1, published = 1, title = null,
} = {}) => raw.prepare(
  `INSERT INTO att_roster (staff_id, day, shift_id, title, set_by, published, ever_published)
   VALUES (?, ?, ?, ?, 'test', ?, ?)`,
).run(staffId, day, shiftId, title, published, published);

const dayOf = (data, name, day) => data.people
  .find((p) => p.name === name).days.find((d) => d.day === day);

// ---------------------------------------------------------------------------
// What a colleague is handed
// ---------------------------------------------------------------------------

test('a colleague sees the note on the shift', async () => {
  const { db, raw } = setup();
  rota(raw, 2, MON, { title: '+ lunch' });

  const cell = dayOf(await ask(db, 1), 'Kofi', MON);
  assert.equal(cell.shift.name, 'Breakfast helper');
  assert.equal(cell.title, '+ lunch');
});

test('a shift with nothing written on it says nothing', async () => {
  const { db, raw } = setup();
  rota(raw, 2, MON);

  assert.equal(dayOf(await ask(db, 1), 'Kofi', MON).title, null);
});

test('your own note is on your own row too', async () => {
  const { db, raw } = setup();
  rota(raw, 1, MON, { title: '+ lunch' });

  assert.equal(dayOf(await ask(db, 1), 'Ama', MON).title, '+ lunch');
});

test('an empty note is nothing, not an empty line', async () => {
  const { db, raw } = setup();
  rota(raw, 2, MON, { title: '' });

  assert.equal(dayOf(await ask(db, 1), 'Kofi', MON).title, null);
});

// ---------------------------------------------------------------------------
// And where it stops
// ---------------------------------------------------------------------------

test('a draft carries neither the shift nor the note', async () => {
  const { db, raw } = setup();
  rota(raw, 2, MON, { published: 0, title: '+ lunch' });

  const cell = dayOf(await ask(db, 1), 'Kofi', MON);
  assert.equal(cell.shift, null);
  assert.equal(cell.title, null);
  assert.equal(JSON.stringify(await ask(db, 1)).includes('+ lunch'), false,
    'a plan is not a promise, and its notes are not either');
});

test('a visitor brings the note for the day they are here', async () => {
  const { db, raw } = setup();
  rota(raw, 3, MON, { title: '+ lunch' });

  const out = await ask(db, 1);
  const esi = out.people.find((p) => p.name === 'Esi');
  assert.equal(esi.visiting, true);
  assert.equal(dayOf(out, 'Esi', MON).title, '+ lunch');
});

test('a visitor’s note from somewhere else stays there', async () => {
  const { db, raw } = setup();
  rota(raw, 3, MON, { title: '+ lunch' });
  rota(raw, 3, TUE, { shiftId: 2, title: 'top floor only' });
  raw.prepare(
    "INSERT INTO rota_publish (from_day, to_day, changes, actor) VALUES (?, ?, 2, 'test')",
  ).run(MON, SUN);

  const out = await ask(db, 1);
  const tuesday = dayOf(out, 'Esi', TUE);
  assert.equal(tuesday.shift, null);
  assert.equal(tuesday.title, null);
  assert.equal(JSON.stringify(out).includes('top floor'), false);
});

test('a day away says nothing about a note', async () => {
  const { db, raw } = setup();
  rota(raw, 2, MON, { title: '+ lunch' });
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status, requested_by)
     VALUES (2, 'annual_leave', ?, ?, 1, 'approved', 'test')`,
  ).run(MON, MON);

  // The cell still carries it, because the screen draws Away over the top of
  // it and the day after the leave is cancelled is the day it is wanted again.
  const cell = dayOf(await ask(db, 1), 'Kofi', MON);
  assert.equal(cell.away, true);
  assert.equal(cell.title, '+ lunch');
});

// ---------------------------------------------------------------------------
// And what the screen does with it
// ---------------------------------------------------------------------------

test('both shapes of the department rota draw it', () => {
  const view = readFileSync('public/js/views/att-me.js', 'utf8');

  assert.ok(view.includes("h('span.dept-shift-title', entry.title)"),
    'the week table on a desk');
  assert.ok(view.includes("h('span.dept-on-title', row.title)"),
    'the day list on a phone');
  assert.ok(view.includes('title: entry.title ?? null'),
    'the phone list has to carry it off the day before it can draw it');
});

test('the note is styled apart from the shift’s own name', () => {
  const css = readFileSync('public/styles.css', 'utf8');
  for (const cls of ['.dept-shift-title', '.dept-on-title']) {
    assert.ok(css.includes(cls), cls);
  }
});
