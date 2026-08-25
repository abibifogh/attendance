import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getRoster } from '../src/routes/attendance.js';
import { createStaff, listStaff, updateStaff } from '../src/routes/attendance-setup.js';
import { loadDataset, mayWork, worksIn } from '../src/lib/attendance.js';
import { suggestRota } from '../src/lib/suggest.js';

/**
 * Where somebody may be put on.
 *
 * `department` says where a person belongs. It never said where they may be
 * rostered, so the suggester was free to draft a housekeeper onto Security on
 * the strength of them being off that Tuesday. What is pinned down here is
 * that their own department answers for them until somebody says otherwise,
 * that the draft honours it, and that a planner can still cover a gap by hand.
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
                             department, needed)
     VALUES (1, 'Nights', '18:00', '02:00', 0, 5, 'Security', 2),
            (2, 'Rooms', '08:00', '16:00', 0, 5, 'Housekeeping', 2),
            (3, 'Anybody', '10:00', '16:00', 0, 5, NULL, 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Security', '2020-01-01'),
            (2, '2', 'Ama', 'Housekeeping', '2020-01-01'),
            (3, '3', 'Yaw', 'Housekeeping', '2020-01-01')`,
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

const draft = async (db) => {
  const ds = await loadDataset(db, { from: '2026-06-01', to: '2026-06-03' });
  return suggestRota({ ds, history: [], from: '2026-06-01', to: '2026-06-01' });
};

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

test('their own department answers until somebody says otherwise', () => {
  assert.deepEqual(worksIn({ department: 'Security' }), ['Security']);
  assert.deepEqual(worksIn({ department: 'Security', works_in: '["Bar","Front"]' }),
    ['Bar', 'Front'], 'what is ticked wins over where they sit');
  assert.deepEqual(worksIn({ department: null }), []);
});

test('a shift belonging to no department is anybody’s', () => {
  assert.equal(mayWork({ department: 'Housekeeping' }, { department: null }), true);
});

test('somebody with nothing said about them is refused nothing', () => {
  assert.equal(mayWork({ department: null }, { department: 'Security' }), true);
});

test('a bad works_in is read as nothing said rather than throwing', () => {
  assert.deepEqual(worksIn({ department: 'Bar', works_in: 'not json' }), ['Bar']);
});

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

test('the draft does not put a housekeeper on Security', async () => {
  const { db } = setup();
  const plan = await draft(db);

  const nights = plan.entries.filter((e) => e.shiftId === 1).map((e) => e.staffId);
  assert.deepEqual(nights, [1], 'only the one who works there');

  const rooms = plan.entries.filter((e) => e.shiftId === 2).map((e) => e.staffId);
  assert.ok(rooms.length, 'the housekeeping shift was filled');
  assert.equal(rooms.every((id) => id !== 1), true, 'and not by the guard');
});

test('it says so when nobody is set up for the work', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE att_staff SET department = 'Housekeeping' WHERE id = 1").run();

  const plan = await draft(db);
  const gap = plan.gaps.find((g) => g.shiftId === 1);
  assert.ok(gap, 'the Security shift could not be filled');
  assert.equal(gap.why, 'nobody is set up to work in Security');
});

test('ticking a second department opens it up', async () => {
  const { db, raw } = setup();
  // Nothing else on the day, so being allowed is the only thing deciding it.
  raw.prepare('DELETE FROM att_shifts WHERE id IN (2, 3)').run();
  raw.prepare(
    `UPDATE att_staff SET works_in = '["Housekeeping","Security"]' WHERE id = 2`,
  ).run();

  const plan = await draft(db);
  const nights = plan.entries.filter((e) => e.shiftId === 1);
  assert.deepEqual(nights.map((e) => e.staffId).sort(), [1, 2],
    'both people set up for Security are used, and Yaw is not');
});

test('a shift with no department is still filled from anybody', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (1, 2)').run();

  const plan = await draft(db);
  assert.equal(plan.entries.filter((e) => e.shiftId === 3).length, 1,
    'nobody is set up for it, and that is exactly why anybody may take it');
});

// ---------------------------------------------------------------------------
// Setting it
// ---------------------------------------------------------------------------

test('the departments somebody may work in are saved and read back', async () => {
  const { db } = setup();
  await updateStaff(ctx(db, {
    body: { name: 'Ama', employeeNo: '2', department: 'Housekeeping', worksIn: ['Housekeeping', 'Bar'] },
  }), 2);

  const { staff } = await (await listStaff(ctx(db))).json();
  const ama = staff.find((s) => s.id === 2);
  assert.equal(ama.works_in, '["Housekeeping","Bar"]');
});

test('the same department twice is stored once', async () => {
  const { db } = setup();
  await createStaff(ctx(db, {
    body: { name: 'New', employeeNo: '9', worksIn: ['Bar', 'Bar', ' Bar '] },
  }));
  const { staff } = await (await listStaff(ctx(db))).json();
  assert.equal(staff.find((s) => s.employee_no === '9').works_in, '["Bar"]');
});

test('clearing every tick puts them back on their own department', async () => {
  const { db, raw } = setup();
  raw.prepare(`UPDATE att_staff SET works_in = '["Bar"]' WHERE id = 2`).run();

  await updateStaff(ctx(db, {
    body: { name: 'Ama', employeeNo: '2', department: 'Housekeeping', worksIn: [] },
  }), 2);

  const row = raw.prepare('SELECT works_in FROM att_staff WHERE id = 2').get();
  assert.equal(row.works_in, null, 'nothing ticked is stored as nothing, not as an empty list');
  assert.deepEqual(worksIn({ department: 'Housekeeping', works_in: row.works_in }),
    ['Housekeeping']);
});

test('the rota sends where each person may work', async () => {
  const { db, raw } = setup();
  raw.prepare(`UPDATE att_staff SET works_in = '["Housekeeping","Bar"]' WHERE id = 2`).run();

  const data = await (await getRoster(ctx(db, { query: '?from=2026-06-01&to=2026-06-07' }))).json();
  assert.deepEqual(data.rows.find((r) => r.staff.id === 1).staff.worksIn, ['Security']);
  assert.deepEqual(data.rows.find((r) => r.staff.id === 2).staff.worksIn,
    ['Housekeeping', 'Bar']);
});

// ---------------------------------------------------------------------------
// Named shifts, as against a whole department
// ---------------------------------------------------------------------------

test('a named shift is allowed and its neighbours are not', () => {
  const porter = { department: 'Portering', works_shifts: '[7]' };
  assert.equal(mayWork(porter, { id: 7, department: 'Security' }), true);
  assert.equal(mayWork(porter, { id: 8, department: 'Security' }), false,
    'the other security shift is a different promise');
});

test('naming a shift is the whole answer, not an addition to their department', () => {
  const porter = { department: 'Portering', works_shifts: '[7]' };
  assert.deepEqual(worksIn(porter), [],
    'their department does not widen it back out');
  assert.equal(mayWork(porter, { id: 9, department: 'Portering' }), false);
});

test('a department and a named shift together are both honoured', () => {
  const both = { department: 'Portering', works_in: '["Portering"]', works_shifts: '[7]' };
  assert.equal(mayWork(both, { id: 9, department: 'Portering' }), true);
  assert.equal(mayWork(both, { id: 7, department: 'Security' }), true);
  assert.equal(mayWork(both, { id: 8, department: 'Security' }), false);
});

test('a shift outside every department stays anybody’s', () => {
  const porter = { department: 'Portering', works_shifts: '[7]' };
  assert.equal(mayWork(porter, { id: 20, department: null }), true);
});

test('the draft honours a shift picked out one at a time', async () => {
  const { db, raw } = setup();
  // Yaw does one night on Security and nothing else there.
  raw.prepare("UPDATE att_staff SET works_shifts = '[1]' WHERE id = 3").run();
  raw.prepare('UPDATE att_shifts SET needed = 3 WHERE id = 1').run();
  raw.prepare('DELETE FROM att_shifts WHERE id IN (2, 3)').run();

  const plan = await draft(db);
  const nights = plan.entries.filter((e) => e.shiftId === 1).map((e) => e.staffId).sort();
  assert.deepEqual(nights, [1, 3], 'the guard and the porter, not the housekeeper');
});

test('named shifts are saved, deduplicated and read back', async () => {
  const { db, raw } = setup();
  await updateStaff(ctx(db, {
    body: {
      name: 'Yaw',
      employeeNo: '3',
      department: 'Housekeeping',
      worksIn: [],
      worksShifts: [1, 1, '1', 3],
    },
  }), 3);

  assert.equal(raw.prepare('SELECT works_shifts FROM att_staff WHERE id = 3').get().works_shifts,
    '[1,3]');
});

test('rubbish in the shift list is dropped rather than stored', async () => {
  const { db, raw } = setup();
  await updateStaff(ctx(db, {
    body: { name: 'Yaw', employeeNo: '3', worksShifts: ['x', -2, 0, null, 2] },
  }), 3);

  assert.equal(raw.prepare('SELECT works_shifts FROM att_staff WHERE id = 3').get().works_shifts,
    '[2]');
});

test('the rota sends the named shifts alongside the departments', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE att_staff SET works_shifts = '[1]' WHERE id = 3").run();

  const data = await (await getRoster(ctx(db, { query: '?from=2026-06-01&to=2026-06-07' }))).json();
  const yaw = data.rows.find((r) => r.staff.id === 3).staff;
  assert.deepEqual(yaw.worksIn, [], 'a named shift answers on its own');
  assert.deepEqual(yaw.worksShifts, [1]);
});

test('the staff list carries the shifts to offer', async () => {
  const { db } = setup();
  const out = await (await listStaff(ctx(db))).json();
  assert.equal(out.shifts.length, 3);
  assert.equal(out.shifts[0].name != null, true);
  assert.equal('starts_at' in out.shifts[0], true, 'with the hours, to tell four alike apart');
});
