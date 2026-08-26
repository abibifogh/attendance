import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createShift, listShifts, updateShift, updateStaff } from '../src/routes/attendance-setup.js';
import { getRoster } from '../src/routes/attendance.js';
import {
  alternatesOf, alwaysOff, loadDataset, mayWork, offDays, runsOn, runsOnDay,
} from '../src/lib/attendance.js';
import { suggestRota } from '../src/lib/suggest.js';
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
