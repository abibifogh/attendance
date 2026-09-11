import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { exportRoster, getRoster, saveRoster } from '../src/routes/attendance.js';

/**
 * Filtering a department brings out the department's rota, not its filing.
 *
 * A rota is the shifts that have to be worked, not a list of who is filed
 * under which heading. A housekeeper covering reception's Tuesday nights is on
 * reception those nights in every sense the screen is for: reception has to
 * know who is on, and whoever is filling the rest of the week has to know he
 * is already spoken for. Filtering by his record left him off, so a fortnight
 * with two receptionists and a visitor read as two people and a hole.
 *
 * The staff-facing department rota has worked this way for a while. This is
 * the planner's grid catching up with it, and the export catching up with the
 * grid, because an export is a printout of the screen.
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
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_leave; DELETE FROM att_holidays; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, department)
     VALUES (1, 'AM Shift', '06:00', '14:00', 0, 'Reception'),
            (2, 'PM Shift', '14:00', '22:00', 0, 'Reception'),
            (3, 'Rooms', '08:00', '16:00', 0, 'Housekeeping')`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Destiny', 'Reception', '2020-01-01'),
            (2, '2', 'Jessica', 'Reception', '2020-01-01'),
            (3, '3', 'Kofi', 'Housekeeping', '2020-01-01'),
            (4, '4', 'Ama', 'Housekeeping', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 9, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };
const FROM = '2026-09-07';
const TO = '2026-09-20';
const on = (n) => {
  const d = new Date(`${FROM}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/roster${query}`),
  session: PLANNER,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const save = (db, entries) => saveRoster(ctx(db, { body: { entries } }));
const look = async (db) => (await getRoster(ctx(db, { query: `?from=${FROM}&to=${TO}` }))).json();

// The grid's own filter, read out of the view so the test cannot drift from it.
const VIEW = readFileSync('public/js/views/att-rota.js', 'utf8');

/** The rule the screen applies, run here against a real payload. */
function shownFor(data, department) {
  const shiftById = new Map(data.shifts.map((s) => [String(s.id), s]));
  const covers = (row) => row.days.some((entry) => {
    if (entry.leave) return false;
    const ids = [entry.shift_id, ...(entry.extra ?? []).map((x) => x.shift_id)];
    return ids.some((id) => id != null
      && (shiftById.get(String(id))?.department || '') === department);
  });
  return data.rows
    .filter((row) => (row.staff.department || '') === department || covers(row))
    .map((row) => row.staff.name);
}

// ---------------------------------------------------------------------------
// Who is on the filtered grid
// ---------------------------------------------------------------------------

test('somebody covering one of the department’s shifts is on its rota', async () => {
  const { db } = setup();
  await save(db, [
    { staffId: 1, day: FROM, shiftId: 1 },
    { staffId: 3, day: on(2), shiftId: 2 },
  ]);

  const shown = shownFor(await look(db), 'Reception');
  assert.deepEqual(shown.sort(), ['Destiny', 'Jessica', 'Kofi'],
    'Kofi is on reception on Wednesday, whatever his record says');
});

test('and somebody who is on none of them is not', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 4, day: FROM, shiftId: 3 }]);

  const shown = shownFor(await look(db), 'Reception');
  assert.equal(shown.includes('Ama'), false, 'Housekeeping all fortnight');
});

test('a second shift on a doubled day counts, because either can be theirs', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 3, day: FROM, shiftId: 3 }]);
  await save(db, [{ staffId: 3, day: FROM, shiftId: 1, add: true }]);

  const data = await look(db);
  const kofi = data.rows.find((r) => r.staff.name === 'Kofi');
  assert.equal(kofi.days.find((d) => d.day === FROM).extra.length, 1, 'a real double');
  assert.ok(shownFor(data, 'Reception').includes('Kofi'));
});

test('a standing pattern on one of its shifts counts too', async () => {
  const { raw, db } = setup();
  // Monday is dow 0 in the app's own numbering.
  raw.prepare('INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (3, 0, 0, 2)').run();

  assert.ok(shownFor(await look(db), 'Reception').includes('Kofi'),
    'the arrangement they agreed to is still a reception shift');
});

test('a day on approved leave is not a day covering anything', async () => {
  const { raw, db } = setup();
  await save(db, [{ staffId: 3, day: on(1), shiftId: 2 }]);
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
     VALUES (3, 'annual_leave', ?, ?, 1, 'approved')`,
  ).run(on(1), on(1));

  assert.equal(shownFor(await look(db), 'Reception').includes('Kofi'), false,
    'he is away, and the shift is not his that day');
});

test('the department’s own people are there whether or not they are on anything', async () => {
  const { db } = setup();
  const shown = shownFor(await look(db), 'Reception');
  assert.deepEqual(shown.sort(), ['Destiny', 'Jessica'], 'an empty fortnight is still their rota');
});

// ---------------------------------------------------------------------------
// The export says the same
// ---------------------------------------------------------------------------

test('the export brings out whoever the grid does', async () => {
  const { db } = setup();
  await save(db, [
    { staffId: 1, day: FROM, shiftId: 1 },
    { staffId: 3, day: on(2), shiftId: 2 },
    { staffId: 4, day: FROM, shiftId: 3 },
  ]);

  const csv = await (await exportRoster(ctx(db, {
    query: `?from=${FROM}&to=${TO}&department=Reception`,
  }))).text();

  assert.ok(csv.includes('Kofi'), 'the man covering the Wednesday');
  assert.ok(csv.includes('Destiny'));
  assert.equal(csv.includes('Ama'), false, 'and not the one who never comes near it');
});

test('unfiltered, the export is still everybody', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 4, day: FROM, shiftId: 3 }]);
  const csv = await (await exportRoster(ctx(db, { query: `?from=${FROM}&to=${TO}` }))).text();
  for (const name of ['Destiny', 'Jessica', 'Kofi', 'Ama']) assert.ok(csv.includes(name), name);
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

test('the grid filters on the shift as well as the record', () => {
  assert.match(VIEW, /const coversFor = \(row, department\)/);
  assert.match(VIEW, /if \(!coversFor\(row, params\.department\)\) return false;/);
  // The old rule, which was the record alone.
  assert.equal(
    /if \(params\.department && \(row\.staff\.department \|\| ''\) !== params\.department\) return false;/
      .test(VIEW),
    false,
  );
});

test('a tag stays a fact about the person', () => {
  // A shift cannot hold a tag, so there is nothing for a tag filter to widen
  // to, and widening it would be inventing a rule nobody asked for.
  assert.match(VIEW, /if \(params\.tag && !\(row\.staff\.tags \?\? \[\]\)\.includes\(params\.tag\)\) return false;/);
});

test('a visitor is marked as one, so the row is not read as a broken filter', () => {
  assert.match(VIEW, /covering\.add\(row\.staff\.id\)/);
  assert.match(VIEW, /rota-covering/);
  assert.match(readFileSync('public/styles.css', 'utf8'), /\.rota-covering \{/);
});

test('clearing a period says plainly that it does not reach a visitor', () => {
  // The server clears by the record, and it must: clearing Kofi's period
  // because he covered one reception night would take his own department's
  // fortnight with it.
  assert.match(VIEW, /Only people whose record says \$\{params\.department\}/);
  const route = readFileSync('src/routes/attendance.js', 'utf8');
  assert.match(route, /if \(department && \(staff\.department \|\| ''\) !== department\) return false;/);
});
