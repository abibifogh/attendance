import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createShift, listShifts, updateShift, updateStaff } from '../src/routes/attendance-setup.js';
import { getRoster } from '../src/routes/attendance.js';
import {
  alternatesOf, altScope, alwaysOff, everyDays, loadDataset, maxDaysPerWeekFor, mayWork,
  offDays, runsOn, runsOnDay,
} from '../src/lib/attendance.js';
import { canTake, suggestRota } from '../src/lib/suggest.js';
import { limitsFrom } from '../src/lib/workload.js';

/**
 * Three things a shift can say about when it is wanted.
 *
 * Which weekdays it runs at all, which other shifts stand in for it, and
 * whether it is worth pulling anybody off anything for. All three were held in
 * somebody's head, and the draft — which has no head — put the craft shop on
 * Sunday, ran two of the five breakfasts on one Tuesday, and treated the extra
 * porter as a shift that had to be covered.
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
            DELETE FROM att_availability; DELETE FROM users; DELETE FROM audit_log;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes,
                             sort_order, needed)
     VALUES (1, 'Breakfast early', '06:00', '14:00', 0, 5, 1, 1),
            (2, 'Breakfast late',  '06:00', '15:00', 0, 5, 2, 1),
            (3, 'Craft',           '09:00', '17:00', 0, 5, 3, 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on)
     VALUES (1, '1', 'Kofi', '2020-01-01'),
            (2, '2', 'Ama', '2020-01-01'),
            (3, '3', 'Yaw', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const ADMIN = {
  user: { id: 3, name: 'Kwame', role: 'admin' },
  permissions: ['att_setup', 'att_rota'],
};

const ctx = (db, { body = null, query = '', session = ADMIN } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/x${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

// 2026-06-01 is a Monday; 2026-06-07 is the Sunday.
const MONDAY = '2026-06-01';
const SUNDAY = '2026-06-07';

const draft = async (db, from = MONDAY, to = MONDAY) => {
  const ds = await loadDataset(db, { from, to: '2026-06-08' });
  return suggestRota({ ds, history: [], from, to });
};

// ---------------------------------------------------------------------------
// Which days it runs
// ---------------------------------------------------------------------------

test('nothing said means every day', () => {
  assert.equal(runsOn({}), null);
  assert.equal(runsOnDay({}, SUNDAY), true);
});

test('a shift shut on Sunday says so', () => {
  const craft = { runs_on: '[0,1,2,3,4]' };
  assert.equal(runsOnDay(craft, MONDAY), true);
  assert.equal(runsOnDay(craft, SUNDAY), false);
});

test('the draft leaves a shut day alone, and does not call it a gap', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE att_shifts SET runs_on = '[0,1,2,3,4]' WHERE id = 3").run();

  const sunday = await draft(db, SUNDAY, SUNDAY);
  assert.equal(sunday.entries.some((e) => e.shiftId === 3), false, 'the craft shop is shut');
  assert.equal(sunday.gaps.some((g) => g.shiftId === 3), false,
    'and a shut day is not something it failed to fill');

  const monday = await draft(db);
  assert.equal(monday.entries.some((e) => e.shiftId === 3), true, 'open on a Monday');
});

test('a full week is stored as nothing, not as seven days', async () => {
  const { db, raw } = setup();
  await updateShift(ctx(db, {
    body: {
      name: 'Craft', startsAt: '09:00', endsAt: '17:00', runsOn: [0, 1, 2, 3, 4, 5, 6],
    },
  }), 3);
  assert.equal(raw.prepare('SELECT runs_on FROM att_shifts WHERE id = 3').get().runs_on, null);
});

test('a weekday out of range is dropped rather than stored', async () => {
  const { db, raw } = setup();
  await updateShift(ctx(db, {
    body: { name: 'Craft', startsAt: '09:00', endsAt: '17:00', runsOn: [0, 9, -1, 'x', 4] },
  }), 3);
  assert.equal(raw.prepare('SELECT runs_on FROM att_shifts WHERE id = 3').get().runs_on, '[0,4]');
});

// ---------------------------------------------------------------------------
// One of these, not both
// ---------------------------------------------------------------------------

test('shifts sharing a group stand in for each other', () => {
  const all = [
    { id: 1, alt_group: 'Breakfast' },
    { id: 2, alt_group: 'Breakfast' },
    { id: 3, alt_group: null },
  ];
  assert.deepEqual(alternatesOf(all[0], all).map((s) => s.id), [2]);
  assert.deepEqual(alternatesOf(all[2], all), [], 'a shift in no group clashes with nothing');
});

test('once the day has one breakfast the other is left alone', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE att_shifts SET alt_group = 'Breakfast' WHERE id IN (1, 2)").run();

  const plan = await draft(db);
  const breakfasts = plan.entries.filter((e) => e.shiftId === 1 || e.shiftId === 2);
  assert.equal(breakfasts.length, 1, 'one morning, written one way');
  assert.equal(plan.gaps.some((g) => g.shiftId === 2), false, 'the other is not a gap');
  assert.equal(plan.instead.length, 1);
  assert.equal(plan.instead[0].shift, 'Breakfast late');
  assert.equal(plan.instead[0].ranAs, 'Breakfast early');
});

test('a day already holding one of them keeps it', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE att_shifts SET alt_group = 'Breakfast' WHERE id IN (1, 2)").run();
  raw.prepare(
    `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published)
     VALUES (1, '2026-06-01', 2, 'seed', 1)`,
  ).run();

  const plan = await draft(db);
  assert.equal(plan.entries.some((e) => e.shiftId === 1), false,
    'the late breakfast is already on, so the early one is not wanted');
});

test('an empty card is the day saying which one it wants', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE att_shifts SET alt_group = 'Breakfast' WHERE id IN (1, 2)").run();
  raw.prepare(
    `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published)
     VALUES (NULL, '2026-06-01', 2, 'seed', 0)`,
  ).run();

  const plan = await draft(db);
  assert.equal(plan.entries.some((e) => e.shiftId === 1), false);
  assert.equal(plan.entries.some((e) => e.shiftId === 2), true, 'the card that is there is filled');
});

// ---------------------------------------------------------------------------
// Only if somebody is spare
// ---------------------------------------------------------------------------

test('an optional shift is filled last, never at the cost of one that is not', async () => {
  const { db, raw } = setup();
  // Two people, and an optional shift listed first so order alone cannot pass this.
  raw.prepare('DELETE FROM att_staff WHERE id = 3').run();
  raw.prepare('UPDATE att_shifts SET optional = 1, sort_order = 0 WHERE id = 1').run();

  const plan = await draft(db);
  const optional = plan.entries.filter((e) => e.shiftId === 1);
  const musts = plan.entries.filter((e) => e.shiftId !== 1);
  assert.equal(musts.length, 2, 'both shifts that had to be covered are');
  assert.equal(optional.length, 0, 'and nobody was left for the optional one');
});

test('an optional shift nobody was spare for is not reported as a failure', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_staff WHERE id = 3').run();
  raw.prepare('UPDATE att_shifts SET optional = 1 WHERE id = 1').run();

  const plan = await draft(db);
  const gap = plan.gaps.find((g) => g.shiftId === 1);
  assert.ok(gap, 'it is still reported');
  assert.equal(gap.optional, true, 'but marked as the rule working rather than a problem');
  assert.equal(plan.gaps.filter((g) => !g.optional).length, 0, 'nothing real went unfilled');
});

test('an optional shift is filled when somebody is spare', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_shifts SET optional = 1 WHERE id = 1').run();

  const plan = await draft(db);
  assert.equal(plan.entries.filter((e) => e.shiftId === 1).length, 1,
    'three people, three shifts, so the optional one gets the third');
});

test('the optional pass does not rob a later day of somebody it needs', async () => {
  const { db, raw } = setup();
  // The whole point of two passes over the window rather than two per day.
  // One person, an optional shift on the Monday and one that has to be
  // covered on the Tuesday, and a rest rule wide enough that he cannot have
  // both. Finishing Monday before starting Tuesday would spend him on the
  // shift that did not matter.
  raw.prepare('DELETE FROM att_staff WHERE id IN (2, 3)').run();
  raw.prepare('DELETE FROM att_shifts WHERE id = 3').run();
  raw.prepare("UPDATE att_shifts SET optional = 1, runs_on = '[0]' WHERE id = 1").run();
  raw.prepare("UPDATE att_shifts SET runs_on = '[1]' WHERE id = 2").run();

  const ds = await loadDataset(db, { from: MONDAY, to: '2026-06-08' });
  const plan = suggestRota({
    ds,
    history: [],
    from: MONDAY,
    to: '2026-06-02',
    limits: {
      ...limitsFrom({}),
      // Monday finishes at 14:00 and Tuesday starts at 06:00: sixteen hours
      // apart, so a twenty-hour rest rule rules one of the two out.
      dailyRestHours: { value: 20 },
    },
  });

  assert.deepEqual(plan.entries.map((e) => [e.day, e.shiftId]), [['2026-06-02', 2]],
    'the Tuesday that had to be covered wins over the optional Monday');
});

// ---------------------------------------------------------------------------
// Setting them
// ---------------------------------------------------------------------------

test('all three are saved and read back', async () => {
  const { db } = setup();
  await createShift(ctx(db, {
    body: {
      name: 'Extra porter',
      startsAt: '10:00',
      endsAt: '18:00',
      runsOn: [4, 5],
      altGroup: 'Porters',
      optional: true,
    },
  }));

  const { shifts } = await (await listShifts(ctx(db))).json();
  const made = shifts.find((s) => s.name === 'Extra porter');
  assert.equal(made.runs_on, '[4,5]');
  assert.equal(made.alt_group, 'Porters');
  assert.equal(made.optional, 1);
});

test('retiring a shift does not quietly wipe its rules', async () => {
  const { db, raw } = setup();
  raw.prepare(
    "UPDATE att_shifts SET runs_on = '[0,1]', alt_group = 'Breakfast', optional = 1 WHERE id = 1",
  ).run();

  // What the Retire button sends: the row as it stands, with active flipped.
  const row = raw.prepare('SELECT * FROM att_shifts WHERE id = 1').get();
  await updateShift(ctx(db, {
    body: {
      name: row.name,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      runsOn: [0, 1],
      altGroup: row.alt_group,
      optional: Boolean(row.optional),
      active: false,
    },
  }), 1);

  const after = raw.prepare('SELECT * FROM att_shifts WHERE id = 1').get();
  assert.equal(after.runs_on, '[0,1]');
  assert.equal(after.alt_group, 'Breakfast');
  assert.equal(after.optional, 1);
  assert.equal(after.active, 0);
});

// ---------------------------------------------------------------------------
// Weekdays somebody never works
// ---------------------------------------------------------------------------

test('nothing said means they can work any day', () => {
  assert.equal(offDays({}), null);
  assert.equal(alwaysOff({}, SUNDAY), false);
});

test('a standing Sunday off is a fact about every Sunday', () => {
  const churchgoer = { off_days: '[6]' };
  assert.equal(alwaysOff(churchgoer, SUNDAY), true);
  assert.equal(alwaysOff(churchgoer, MONDAY), false);
});

test('the draft never puts somebody on a weekday they never work', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_staff WHERE id IN (2, 3)').run();
  raw.prepare("UPDATE att_staff SET off_days = '[6]' WHERE id = 1").run();

  const sunday = await draft(db, SUNDAY, SUNDAY);
  assert.equal(sunday.entries.length, 0);
  assert.equal(sunday.gaps[0].why, '1 never works this weekday');

  const monday = await draft(db);
  assert.ok(monday.entries.length, 'and Monday is untouched');
});

test('every day off is refused rather than stored', async () => {
  const { db } = setup();
  await assert.rejects(
    updateStaff(ctx(db, {
      body: { name: 'Kofi', employeeNo: '1', offDays: [0, 1, 2, 3, 4, 5, 6] },
    }), 1),
    /no day they can work/,
  );
});

test('the days somebody never works are saved and reach the grid', async () => {
  const { db, raw } = setup();
  await updateStaff(ctx(db, {
    body: { name: 'Kofi', employeeNo: '1', offDays: [6, 6, '2'] },
  }), 1);
  assert.equal(raw.prepare('SELECT off_days FROM att_staff WHERE id = 1').get().off_days, '[2,6]');

  const data = await (await getRoster(ctx(db, { query: `?from=${MONDAY}&to=${SUNDAY}` }))).json();
  const kofi = data.rows.find((r) => r.staff.id === 1);
  assert.deepEqual(kofi.staff.offDays, [2, 6]);
  assert.equal(kofi.days.find((d) => d.day === SUNDAY).alwaysOff, true);
  assert.equal(kofi.days.find((d) => d.day === MONDAY).alwaysOff, false);
});

// ---------------------------------------------------------------------------
// A shift that belongs to one person
// ---------------------------------------------------------------------------

test('a one-person shift is theirs and nobody else’s', () => {
  const shift = { id: 9, department: 'Reception', only_staff_id: 1 };
  assert.equal(mayWork({ id: 1, department: 'Housekeeping' }, shift), true,
    'theirs whatever department they sit in');
  assert.equal(mayWork({ id: 2, department: 'Reception' }, shift), false,
    'and not the reception team’s, however well they fit');
});

test('the draft gives a one-person shift to that person', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_shifts SET only_staff_id = 2 WHERE id = 3').run();

  const plan = await draft(db);
  assert.deepEqual(plan.entries.filter((e) => e.shiftId === 3).map((e) => e.staffId), [2]);
});

test('a one-person shift does not run on a day they are off', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_shifts SET only_staff_id = 2 WHERE id = 3').run();
  raw.prepare("UPDATE att_staff SET off_days = '[0]' WHERE id = 2").run();

  const plan = await draft(db);
  assert.equal(plan.entries.some((e) => e.shiftId === 3), false);

  const gap = plan.gaps.find((g) => g.shiftId === 3);
  assert.ok(gap, 'still reported');
  assert.equal(gap.onlyPerson, 'Ama', 'and it names whose day off it is');
  assert.equal(plan.gaps.filter((g) => !g.optional && !g.onlyPerson).length, 0,
    'nothing a planner could actually fix went unfilled');
});

test('nobody else is drafted onto it to cover the day', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (1, 2)').run();
  raw.prepare('UPDATE att_shifts SET only_staff_id = 2, needed = 2 WHERE id = 3').run();

  const plan = await draft(db);
  assert.deepEqual(plan.entries.map((e) => e.staffId), [2],
    'two wanted, one person who may work it, and no substitute found');
});

test('whose shift it is survives a save and reaches the picker', async () => {
  const { db } = setup();
  await updateShift(ctx(db, {
    body: { name: 'Craft', startsAt: '09:00', endsAt: '17:00', onlyStaffId: 3 },
  }), 3);

  const out = await (await listShifts(ctx(db))).json();
  assert.equal(out.shifts.find((s) => s.id === 3).only_staff_id, 3);
  assert.equal(out.staff.length, 3, 'and the form has names to offer');
  assert.equal(out.staff[0].name, 'Ama', 'in alphabetical order');
});

test('a one-person shift is asked before the ones anybody can take', async () => {
  const { db, raw } = setup();
  // Ama is the only one who can work Craft, and she is also the first name the
  // ranking would reach for on the breakfasts. Asked last she would already be
  // spoken for, and Craft would read as unfillable when it was merely late.
  raw.prepare('UPDATE att_shifts SET only_staff_id = 2 WHERE id = 3').run();

  const plan = await draft(db);
  assert.deepEqual(plan.entries.filter((e) => e.shiftId === 3).map((e) => e.staffId), [2]);
  assert.equal(plan.gaps.length, 0, 'and the other two shifts still got somebody');
});

// ---------------------------------------------------------------------------
// A day's break in between
// ---------------------------------------------------------------------------

test('no rule means it can run any day', () => {
  assert.equal(everyDays({}), 1);
  assert.equal(everyDays({ every_days: 1 }), 1);
  assert.equal(everyDays({ every_days: 2 }), 2);
});

test('an absurd gap is capped rather than believed', () => {
  assert.equal(everyDays({ every_days: 900 }), 30);
});

test('every other day comes out as every other day', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (1, 2)').run();
  raw.prepare('UPDATE att_shifts SET every_days = 2 WHERE id = 3').run();

  const plan = await draft(db, MONDAY, SUNDAY);
  const days = plan.entries.filter((e) => e.shiftId === 3).map((e) => e.day).sort();
  assert.deepEqual(days, ['2026-06-01', '2026-06-03', '2026-06-05', '2026-06-07'],
    'Monday, Wednesday, Friday, Sunday');
});

test('a day it is already down for keeps the next day clear', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (1, 2)').run();
  raw.prepare('UPDATE att_shifts SET every_days = 2 WHERE id = 3').run();
  // Somebody put it on the Tuesday by hand.
  raw.prepare(
    `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published)
     VALUES (1, '2026-06-02', 3, 'seed', 1)`,
  ).run();

  const plan = await draft(db, MONDAY, SUNDAY);
  const days = plan.entries.filter((e) => e.shiftId === 3).map((e) => e.day).sort();
  assert.equal(days.includes('2026-06-01'), false, 'the Monday before it is left clear');
  assert.equal(days.includes('2026-06-03'), false, 'and so is the Wednesday after');
  assert.deepEqual(days, ['2026-06-04', '2026-06-06'], 'it picks up again from there');
});

test('a run just before the window still counts', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (1, 2)').run();
  raw.prepare('UPDATE att_shifts SET every_days = 3 WHERE id = 3').run();
  raw.prepare(
    `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published)
     VALUES (1, '2026-05-31', 3, 'seed', 1)`,
  ).run();

  const ds = await loadDataset(db, { from: '2026-05-25', to: '2026-06-08' });
  const plan = suggestRota({ ds, history: [], from: MONDAY, to: '2026-06-04' });
  const days = plan.entries.filter((e) => e.shiftId === 3).map((e) => e.day).sort();
  assert.deepEqual(days, ['2026-06-03'],
    'the Sunday before rules out Monday and Tuesday, so it resumes on Wednesday');
});

test('an empty card counts as the shift having run', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (1, 2)').run();
  raw.prepare('UPDATE att_shifts SET every_days = 2 WHERE id = 3').run();
  raw.prepare(
    `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published)
     VALUES (NULL, '2026-06-02', 3, 'seed', 0)`,
  ).run();

  const plan = await draft(db, MONDAY, '2026-06-03');
  const days = plan.entries.filter((e) => e.shiftId === 3).map((e) => e.day);
  assert.equal(days.includes('2026-06-01'), false);
  assert.equal(days.includes('2026-06-03'), false, 'the card standing on Tuesday spaces it');
});

test('the gap is saved, and one day in between is stored as no rule', async () => {
  const { db, raw } = setup();
  await updateShift(ctx(db, {
    body: { name: 'Deep clean', startsAt: '09:00', endsAt: '17:00', everyDays: 2 },
  }), 3);
  assert.equal(raw.prepare('SELECT every_days FROM att_shifts WHERE id = 3').get().every_days, 2);

  await updateShift(ctx(db, {
    body: { name: 'Deep clean', startsAt: '09:00', endsAt: '17:00', everyDays: 1 },
  }), 3);
  assert.equal(raw.prepare('SELECT every_days FROM att_shifts WHERE id = 3').get().every_days, null);
});

// ---------------------------------------------------------------------------
// Everything not marked optional gets created
// ---------------------------------------------------------------------------

test('a shift nobody has said anything about still reaches the draft', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_shifts SET needed = NULL').run();

  const plan = await draft(db);
  assert.deepEqual(plan.entries.map((e) => e.shiftId).sort(), [1, 2, 3],
    'all three, with nothing asked for and no history behind any of them');
});

test('and it appears on every day it is allowed to run', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (2, 3)').run();
  raw.prepare('UPDATE att_shifts SET needed = NULL').run();

  const plan = await draft(db, MONDAY, '2026-06-03');
  assert.deepEqual(plan.entries.map((e) => e.day).sort(),
    ['2026-06-01', '2026-06-02', '2026-06-03']);
});

test('optional is the only thing that opts a shift out of that', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_shifts SET needed = NULL').run();
  raw.prepare('UPDATE att_shifts SET optional = 1 WHERE id = 2').run();

  const plan = await draft(db);
  assert.equal(plan.entries.some((e) => e.shiftId === 2), true,
    'three people and three shifts, so the optional one does get the spare');

  // With nobody spare it is the one that goes without.
  raw.prepare('DELETE FROM att_staff WHERE id = 3').run();
  const tighter = await draft(db);
  assert.equal(tighter.entries.some((e) => e.shiftId === 2), false);
  assert.equal(tighter.entries.filter((e) => e.shiftId === 1 || e.shiftId === 3).length, 2);
});

// ---------------------------------------------------------------------------
// Alternatives that clash for a whole week
// ---------------------------------------------------------------------------

test('a group can clash for the day or for the week', () => {
  assert.equal(altScope({}), 'day');
  assert.equal(altScope({ alt_scope: 'week' }), 'week');
  assert.equal(altScope({ alt_scope: 'nonsense' }), 'day', 'anything odd reads as the day');
});

test('two weekly shifts in one group leave each other alone all week', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id = 3').run();
  raw.prepare(
    "UPDATE att_shifts SET alt_group = 'Deep clean', alt_scope = 'week', every_days = 7",
  ).run();

  const plan = await draft(db, MONDAY, SUNDAY);
  const which = [...new Set(plan.entries.map((e) => e.shiftId))];
  assert.deepEqual(which, [1], 'one of the pair, once, for the whole week');
  assert.equal(plan.entries.length, 1);
});

test('the same pair scoped to the day may both run in one week', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id = 3').run();
  raw.prepare(
    "UPDATE att_shifts SET alt_group = 'Deep clean', alt_scope = 'day', every_days = 7",
  ).run();

  const plan = await draft(db, MONDAY, SUNDAY);
  const which = [...new Set(plan.entries.map((e) => e.shiftId))].sort();
  assert.deepEqual(which, [1, 2], 'both, on the same Monday being the only clash they have');
});

test('a week-scoped clash starts fresh the following Monday', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id = 3').run();
  raw.prepare(
    "UPDATE att_shifts SET alt_group = 'Deep clean', alt_scope = 'week', every_days = 7",
  ).run();

  const plan = await draft(db, MONDAY, '2026-06-14');
  assert.deepEqual(plan.entries.map((e) => e.day), ['2026-06-01', '2026-06-08'],
    'once in each of the two weeks');
});

test('the clash scope is saved', async () => {
  const { db, raw } = setup();
  await updateShift(ctx(db, {
    body: {
      name: 'Craft', startsAt: '09:00', endsAt: '17:00', altGroup: 'Deep clean', altScope: 'week',
    },
  }), 3);
  const row = raw.prepare('SELECT alt_group, alt_scope FROM att_shifts WHERE id = 3').get();
  assert.equal(row.alt_group, 'Deep clean');
  assert.equal(row.alt_scope, 'week');
});

// ---------------------------------------------------------------------------
// Filling everything, and saying what it cost
// ---------------------------------------------------------------------------

test('a refusal says which rule it was, not only how it reads', () => {
  const { db } = setup();
  void db;
  const verdict = canTake(
    { leaveBy: new Map() },
    new Map(),
    { id: 1, off_days: '[0]' },
    MONDAY,
    { id: 1, department: null },
    limitsFrom({}),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, 'weekday');
});

test('somebody is moved off another shift rather than leaving one empty', async () => {
  const { db, raw } = setup();
  // Two shifts, two people, and only Kofi may work the second. Asked in order,
  // the first shift takes Kofi and the second finds nobody.
  raw.prepare('DELETE FROM att_shifts WHERE id = 3').run();
  raw.prepare('DELETE FROM att_staff WHERE id = 3').run();
  raw.prepare('UPDATE att_shifts SET only_staff_id = 1 WHERE id = 2').run();

  const plan = await draft(db);
  const covered = plan.entries.map((e) => e.shiftId).sort();
  assert.deepEqual(covered, [1, 2], 'both are covered');
  assert.equal(plan.entries.find((e) => e.shiftId === 2).staffId, 1);
  assert.equal(plan.entries.find((e) => e.shiftId === 1).staffId, 2,
    'and Ama took the one anybody could do');
  assert.equal(plan.entries.every((e) => !e.breach), true, 'no rule was bent to do it');
});

test('a shift nobody is left for is covered by going past a limit, and says which', async () => {
  const { db, raw } = setup();
  // One person on a seven-day week, so the days rule is out of the way and
  // the hours and consecutive-days rules are what have to give.
  raw.prepare('DELETE FROM att_shifts WHERE id IN (2, 3)').run();
  raw.prepare('DELETE FROM att_staff WHERE id IN (2, 3)').run();
  raw.prepare('UPDATE att_staff SET days_per_week = 7 WHERE id = 1').run();

  const plan = await draft(db, MONDAY, SUNDAY);
  assert.equal(plan.entries.length, 7, 'every day of the week is covered');
  assert.equal(plan.gaps.length, 0);

  const bent = plan.entries.filter((e) => e.breach);
  assert.ok(bent.length, 'the days past the limits are marked');
  assert.equal(bent.every((e) => e.breach.law), true, 'and every one names its section');
  assert.deepEqual(plan.stretched, bent);
});

test('nobody is given a second shift in one day, whatever it costs', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_staff WHERE id IN (2, 3)').run();

  const plan = await draft(db);
  const onTheDay = plan.entries.filter((e) => e.day === MONDAY && e.staffId === 1);
  assert.equal(onTheDay.length, 1, 'one shift a person a day, full stop');
  assert.equal(plan.entries.every((e) => !e.second), true);
  assert.equal(plan.gaps.length, 2, 'the other two shifts are reported empty rather than doubled');
  assert.equal(plan.gaps.every((g) => /already has that day/.test(g.why)), true);
});

test('leave, a day off and the wrong department are never stretched', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (2, 3)').run();
  raw.prepare('DELETE FROM att_staff WHERE id IN (2, 3)').run();
  raw.prepare("UPDATE att_staff SET off_days = '[0]' WHERE id = 1").run();

  const plan = await draft(db);
  assert.equal(plan.entries.length, 0, 'a weekday they never work is a fact, not a limit');
  assert.equal(plan.gaps.length, 1);
});

test('an optional shift is never filled by bending a rule', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id = 3').run();
  raw.prepare('DELETE FROM att_staff WHERE id IN (2, 3)').run();
  raw.prepare('UPDATE att_shifts SET optional = 1 WHERE id = 2').run();

  const plan = await draft(db);
  assert.equal(plan.entries.length, 1, 'the one that had to be covered, and no more');
  assert.equal(plan.entries[0].shiftId, 1);
  assert.equal(plan.gaps.find((g) => g.shiftId === 2).optional, true);
});

// ---------------------------------------------------------------------------
// The most days a week
// ---------------------------------------------------------------------------

test('the cap is their contracted week, the one field and no other', () => {
  assert.equal(maxDaysPerWeekFor({}, {}), 5, 'the property default');
  assert.equal(maxDaysPerWeekFor({ days_per_week: 4 }, {}), 4, 'their own contract');
  assert.equal(maxDaysPerWeekFor({ days_per_week: 6 }, {}), 6, 'six for somebody on six');
  assert.equal(maxDaysPerWeekFor({ days_per_week: 4, max_days_per_week: 6 }, {}), 4,
    'the old separate figure is read by nothing');
  assert.equal(maxDaysPerWeekFor({}, { att_days_per_week: 9 }), 7, 'a week has seven days');
});

// Six hours, so five days is thirty and the forty-hour rule cannot be what
// stops a sixth day. Otherwise the two rules bind at the same moment and this
// would pass whether the days rule existed or not.
const shortShift = (raw) => raw
  .prepare("UPDATE att_shifts SET ends_at = '12:00' WHERE id = 1").run();

test('nobody is drafted for a sixth day in a week', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (2, 3)').run();
  raw.prepare('DELETE FROM att_staff WHERE id IN (2, 3)').run();
  shortShift(raw);

  const plan = await draft(db, MONDAY, SUNDAY);
  const clean = plan.entries.filter((e) => !e.breach);
  assert.equal(clean.length, 5, 'five days, and the sixth and seventh are not free ones');
});

test('a sixth day is never taken, whatever it costs the rota', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (2, 3)').run();
  raw.prepare('DELETE FROM att_staff WHERE id IN (2, 3)').run();
  shortShift(raw);

  const plan = await draft(db, MONDAY, SUNDAY);
  assert.equal(plan.entries.length, 5, 'five days, and the week stops there');
  assert.equal(plan.entries.every((e) => !e.breach), true, 'none of them bent anything');
  assert.equal(plan.gaps.length, 2, 'the sixth and seventh days are reported empty instead');
  assert.equal(plan.gaps.every((g) => /days that week/.test(g.why)), true,
    'saying exactly why nobody could take them');
});

test('somebody marked as the exception takes the extra days cleanly', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (2, 3)').run();
  raw.prepare('DELETE FROM att_staff WHERE id IN (2, 3)').run();
  raw.prepare('UPDATE att_staff SET days_per_week = 7 WHERE id = 1').run();
  shortShift(raw);

  const plan = await draft(db, MONDAY, SUNDAY);
  const onDays = plan.entries.filter((e) => e.breach?.rule === 'daysPerWeek');
  assert.equal(onDays.length, 0, 'no days-in-a-week breach for the person exempted');
  assert.equal(plan.entries.length, 7, 'and the whole week is covered');
});

test('two shifts on one day count as one day worked', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id = 3').run();
  raw.prepare('DELETE FROM att_staff WHERE id = 3').run();
  shortShift(raw);

  // Two people, two shifts, so Monday holds both without anybody doubling up.
  const plan = await draft(db, MONDAY, '2026-06-05');
  const monday = plan.entries.filter((e) => e.day === MONDAY);
  assert.equal(monday.length, 2, 'both Monday shifts covered');
  assert.equal(new Set(monday.map((e) => e.staffId)).size, 2, 'by two different people');
  assert.equal(plan.entries.filter((e) => e.breach?.rule === 'daysPerWeek').length, 0,
    'and neither week is six days');
});

test('the exception is set by the migration for the two named people', async () => {
  const { raw } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on)
     VALUES (90, '90', 'Dorcas Sarpei', '2020-01-01'),
            (91, '91', 'Henry Nii Aryee', '2020-01-01'),
            (92, '92', 'Somebody Else', '2020-01-01')`,
  ).run();
  // Re-running the migration is what a deploy does; it must be safe and exact.
  raw.exec(readFileSync('migrations/0065_max_days_per_week.sql', 'utf8')
    .split('\n').filter((l) => !l.startsWith('ALTER')).join('\n'));

  const rows = raw.prepare(
    'SELECT name, max_days_per_week FROM att_staff WHERE id IN (90, 91, 92) ORDER BY id',
  ).all();
  assert.deepEqual(rows.map((r) => r.max_days_per_week), [7, 7, null]);
});

test('the two named as the exception still take a full week', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (2, 3)').run();
  raw.prepare('DELETE FROM att_staff WHERE id IN (2, 3)').run();
  raw.prepare('UPDATE att_staff SET days_per_week = 7 WHERE id = 1').run();
  shortShift(raw);

  const plan = await draft(db, MONDAY, SUNDAY);
  assert.equal(plan.entries.length, 7, 'seven days for somebody set to seven');
  assert.equal(plan.entries.filter((e) => e.breach?.rule === 'daysPerWeek').length, 0);
});

test('a week already half worked by hand still stops at five', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (2, 3)').run();
  raw.prepare('DELETE FROM att_staff WHERE id IN (2, 3)').run();
  shortShift(raw);
  // Three days put on by hand before the draft runs.
  raw.prepare(
    `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published)
     VALUES (1, '2026-06-01', 1, 'seed', 1),
            (1, '2026-06-02', 1, 'seed', 1),
            (1, '2026-06-03', 1, 'seed', 1)`,
  ).run();

  const plan = await draft(db, MONDAY, SUNDAY);
  assert.equal(plan.entries.length, 2, 'two more days, not four');
  assert.equal(plan.entries.every((e) => !e.breach), true);
});

test('somebody on a six-day week gets six, and no seventh', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (2, 3)').run();
  raw.prepare('DELETE FROM att_staff WHERE id IN (2, 3)').run();
  raw.prepare('UPDATE att_staff SET days_per_week = 6 WHERE id = 1').run();
  shortShift(raw);

  const plan = await draft(db, MONDAY, SUNDAY);
  assert.equal(plan.entries.length, 6, 'six days, and the Sunday stays clear');
  assert.equal(plan.entries.every((e) => !e.breach), true, 'none of them bent anything');
  assert.equal(plan.entries.some((e) => e.day === SUNDAY), false);
  assert.equal(plan.gaps.length, 1);
});

test('the migration puts the two named on six, and leaves anybody else alone', () => {
  const { raw } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, days_per_week, hired_on)
     VALUES (90, '90', 'Dorcas Sarpei', 7, '2020-01-01'),
            (91, '91', 'Henry Nii Aryee', 7, '2020-01-01'),
            (92, '92', 'Somebody Else', 7, '2020-01-01'),
            (93, '93', 'Ama Sarpei', 5, '2020-01-01')`,
  ).run();
  raw.exec(readFileSync('migrations/0067_six_days_for_the_two.sql', 'utf8'));

  const rows = raw.prepare(
    'SELECT name, days_per_week FROM att_staff WHERE id BETWEEN 90 AND 93 ORDER BY id',
  ).all();
  assert.deepEqual(rows.map((r) => r.days_per_week), [6, 6, 7, 5],
    'the two named come down, a seven nobody named stays, and a five is untouched');
});
