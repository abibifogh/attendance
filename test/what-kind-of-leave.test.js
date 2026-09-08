import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getRoster } from '../src/routes/attendance.js';
import {
  LOOKS, lookOf, markFor, nameOf, sayTheLeave, sayTheStretch, sayTheStretchShort,
} from '../public/js/leave-looks.js';

/**
 * Which leave it is, on the rota.
 *
 * The grid printed the word "Leave" on every day somebody was off, flat grey,
 * whatever the leave was for. Four of them in a row told a planner that four
 * cells were gone and nothing else. Annual leave booked in March and a week off
 * sick from this morning are not the same news, and this is the screen where
 * the difference is worth seeing.
 *
 * Two halves. The roster now carries the leave's own name and where the day
 * falls in the run; the cell reads that and wears it.
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
            DELETE FROM att_availability; DELETE FROM att_leave; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Destiny', 'Reception', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const WINDOW = '?from=2026-09-07&to=2026-09-13';

const planner = (db, query = WINDOW) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/roster${query}`),
  session: { user: { id: 4, name: 'Efua', role: 'manager' }, permissions: ['att_rota', 'att_view'] },
  executionContext: null,
  request: new Request('https://x/'),
});

const bookLeave = (raw, code, from, to) => raw.prepare(
  `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
   VALUES (1, ?, ?, ?, 1, 'approved')`,
).run(code, from, to);

const cellOn = async (db, day) => {
  const out = await (await getRoster(planner(db))).json();
  return out.rows[0].days.find((d) => d.day === day);
};

// ---------------------------------------------------------------------------
// What the rota is handed
// ---------------------------------------------------------------------------

test('the day carries the name of the leave, not just its code', async () => {
  const { raw, db } = setup();
  bookLeave(raw, 'sick_leave', '2026-09-09', '2026-09-09');

  const cell = await cellOn(db, '2026-09-09');
  assert.equal(cell.leave.code, 'sick_leave');
  assert.equal(cell.leave.label, 'Sick leave');
  assert.equal(cell.leave.kind, 'leave');
});

test('and where the day falls in the run', async () => {
  const { raw, db } = setup();
  bookLeave(raw, 'annual_leave', '2026-09-08', '2026-09-11');

  for (const [day, nth] of [['2026-09-08', 1], ['2026-09-09', 2], ['2026-09-11', 4]]) {
    const cell = await cellOn(db, day);
    assert.equal(cell.leave.nth, nth, day);
    assert.equal(cell.leave.outOf, 4, day);
  }
});

test('counted over the whole booking, not the week on screen', async () => {
  const { raw, db } = setup();
  // A fortnight that started the week before the one being read.
  bookLeave(raw, 'annual_leave', '2026-09-01', '2026-09-14');

  const cell = await cellOn(db, '2026-09-07');
  assert.equal(cell.leave.nth, 7, 'the seventh day of the fortnight, not the first of the week');
  assert.equal(cell.leave.outOf, 14);
  assert.equal(cell.leave.from, '2026-09-01');
  assert.equal(cell.leave.to, '2026-09-14');
});

test('a day with no leave on it stays empty', async () => {
  const { db } = setup();
  const cell = await cellOn(db, '2026-09-09');
  assert.equal(cell.leave, null);
});

test('leave nobody has approved yet is not on the grid at all', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
     VALUES (1, 'annual_leave', '2026-09-09', '2026-09-09', 1, 'pending')`,
  ).run();
  const cell = await cellOn(db, '2026-09-09');
  assert.equal(cell.leave, null, 'a request is not a decision');
});

test('a reason somebody renamed goes out under its new name', async () => {
  const { raw, db } = setup();
  raw.prepare("UPDATE att_reasons SET label = 'Annual holiday' WHERE code = 'annual_leave'").run();
  bookLeave(raw, 'annual_leave', '2026-09-09', '2026-09-09');

  const cell = await cellOn(db, '2026-09-09');
  assert.equal(cell.leave.label, 'Annual holiday');
});

// ---------------------------------------------------------------------------
// What the cell makes of it
// ---------------------------------------------------------------------------

test('each seeded leave gets a look of its own', () => {
  assert.equal(lookOf({ code: 'annual_leave' }), 'annual');
  assert.equal(lookOf({ code: 'sick_leave' }), 'sick');
  assert.equal(lookOf({ code: 'compassionate' }), 'compassionate');
  assert.equal(lookOf({ code: 'maternity' }), 'parental');
  assert.equal(lookOf({ code: 'unpaid_leave' }), 'unpaid');
  // No two of them share one, or the colour would be saying nothing.
  const looks = ['annual_leave', 'sick_leave', 'compassionate', 'maternity', 'unpaid_leave']
    .map((code) => lookOf({ code }));
  assert.equal(new Set(looks).size, looks.length);
});

test('a reason the property added itself is read off its label', () => {
  // Nothing insists on the seeded codes: a property can invent its own.
  assert.equal(lookOf({ code: 'study', label: 'Study leave' }), 'study');
  assert.equal(lookOf({ code: 'x1', label: 'Bereavement' }), 'compassionate');
  assert.equal(lookOf({ code: 'x2', label: 'Paternity leave' }), 'parental');
  assert.equal(lookOf({ code: 'x3', label: 'Annual holiday' }), 'annual');
});

test('and one nobody can place still gets a cell that says its name', () => {
  const odd = { code: 'sabbatical', label: 'Sabbatical' };
  assert.equal(lookOf(odd), 'away');
  assert.ok(LOOKS.includes(lookOf(odd)));
  assert.equal(nameOf(odd), 'Sabbatical');
  assert.ok(markFor(odd), 'a mark all the same');
});

test('a leave with no label at all falls back to the plain word', () => {
  assert.equal(nameOf({ code: null, label: null }), 'Leave');
  assert.equal(nameOf({}), 'Leave');
  assert.equal(lookOf(null), 'away');
});

test('the run is said the way somebody covering it would say it', () => {
  assert.equal(sayTheStretch({ nth: 1, outOf: 1 }), 'One day');
  assert.equal(sayTheStretch({ nth: 1, outOf: 5 }), 'First of 5');
  assert.equal(sayTheStretch({ nth: 3, outOf: 5 }), 'Day 3 of 5');
  assert.equal(sayTheStretch({ nth: 5, outOf: 5 }), 'Last of 5');
  assert.equal(sayTheStretch({}), '', 'and says nothing when it does not know');
});

test('the whole sentence sits behind the cell', () => {
  const said = sayTheLeave({
    label: 'Sick leave', nth: 2, outOf: 3, from: '2026-09-08', to: '2026-09-10',
  });
  assert.match(said, /Sick leave/);
  assert.match(said, /day 2 of 3/);
  assert.match(said, /2026-09-08 to 2026-09-10/);
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

test('both the grid and the read-only grid draw the same cell', () => {
  const view = readFileSync('public/js/views/att-rota.js', 'utf8');
  assert.equal((view.match(/return leaveCell\(entry\);/g) ?? []).length, 2);
  // The flat grey word is gone from both.
  assert.equal(/rota-locked/.test(view), false);
  assert.equal(/'Approved leave'/.test(view), false);
});

test('the cell names the leave and marks it', () => {
  const view = readFileSync('public/js/views/att-rota.js', 'utf8');
  assert.match(view, /'data-leave': lookOf\(leave\)/);
  assert.match(view, /rota-away-mark'.*markFor\(leave\)/s);
  assert.match(view, /leaveName\(leave\)/);
});

test('and the rest of the screen says which leave too', () => {
  const view = readFileSync('public/js/views/att-rota.js', 'utf8');
  // The cover picker and the unavailability dialog both used to say the bare
  // word, beside a cell that now names it.
  assert.equal(/'on leave'/.test(view), false);
  assert.equal(/\(on leave\)/.test(view), false);
  assert.match(view, /on \$\{leaveName\(entry\.leave\)\.toLowerCase\(\)\}/);
});

test('the run has a short form for a column a seventh of a phone wide', () => {
  assert.equal(sayTheStretchShort({ nth: 2, outOf: 4 }), '2/4');
  assert.equal(sayTheStretchShort({ nth: 4, outOf: 4 }), '4/4');
  assert.equal(sayTheStretchShort({ nth: 1, outOf: 1 }), '', 'one day needs no counting');
  assert.equal(sayTheStretchShort({}), '');
});

test('nothing in the cell wears .rota-cell, which a phone turns invisible', () => {
  // On a phone .rota-cell is the dropdown covering the whole cell at zero
  // opacity. A leave day has nothing to open, and the name went invisible with
  // it the first time round.
  const view = readFileSync('public/js/views/att-rota.js', 'utf8');
  const cell = view.slice(view.indexOf('const leaveCell'), view.indexOf('The same cell with nothing'));
  assert.equal(/rota-cell'/.test(cell), false);
  assert.equal(/rota-cell\./.test(cell), false);
  assert.equal(/rota-hours/.test(cell), false, 'nor the hours, which a phone rewrites');
  assert.match(cell, /rota-away-name/);
  assert.match(cell, /rota-away-when/);
});

test('the name is dropped on a phone and the count is not', () => {
  const css = readFileSync('public/styles.css', 'utf8');
  assert.match(css, /\.rota-away-what,\n\s*\.rota-away-when-long,/);
  assert.match(css, /\.rota-away-when-short \{ display: block; \}/);
  // And the short one is what the fortnight uses too.
  assert.match(css, /\.rota-table\.rota-tight \.rota-away-when-short \{ display: inline; \}/);
});

test('the shift name and the leave name are two different functions', () => {
  // att-rota.js has its own nameOf for the thing being dragged. Importing the
  // leave one under the same name shadowed it, and every leave cell on the
  // grid read "That shift".
  const view = readFileSync('public/js/views/att-rota.js', 'utf8');
  assert.match(view, /nameOf as leaveName/);
  assert.equal(/\bnameOf\(leave\)/.test(view), false);
});

test('the away cell is hatched, and every look has a colour', () => {
  const css = readFileSync('public/styles.css', 'utf8');
  assert.match(css, /\.rota-away \{/);
  assert.match(css, /repeating-linear-gradient/);
  for (const look of LOOKS) {
    assert.ok(
      css.includes(`.rota-away[data-leave="${look}"]`),
      `${look} has no colour of its own`,
    );
  }
  // The style the word used to wear went with it.
  assert.equal(/\.rota-locked/.test(css), false);
});
