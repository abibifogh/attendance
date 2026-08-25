import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { copyRoster, getRoster, saveRoster } from '../src/routes/attendance.js';
import { createStaff, listStaff, updateStaff } from '../src/routes/attendance-setup.js';
import { loadDataset } from '../src/lib/attendance.js';
import { suggestRota } from '../src/lib/suggest.js';
import { workload } from '../src/routes/workload.js';

/**
 * Somebody on the payroll who is never rostered.
 *
 * A director, a consultant, the owner: they have a record, a payslip and a
 * leave balance, and they have no business taking up a column on the grid or a
 * line in the workload list. What is pinned down here is that marking them off
 * the rota is honoured everywhere the rota is read, and that the draft neither
 * proposes them nor quietly loses the shift they would have covered.
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
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Reception', '06:00', '14:00', 0, 5),
            (2, 'Dinner', '14:00', '22:00', 0, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Front', '2020-01-01'),
            (2, '2', 'Ama', 'Front', '2020-01-01'),
            (3, '3', 'Mensah', 'Front', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 2, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };
const ADMIN = {
  user: { id: 3, name: 'Kwame', role: 'admin' },
  permissions: ['att_setup', 'att_rota', 'att_workload'],
};

const ctx = (db, { body = null, query = '', session = PLANNER } = {}) => ({
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

const DAY = '2026-06-02';
const WINDOW = '?from=2026-06-01&to=2026-06-14';

const offRota = (raw, id) => raw.prepare('UPDATE att_staff SET on_rota = 0 WHERE id = ?').run(id);
const look = async (db) => (await getRoster(ctx(db, { query: WINDOW }))).json();

// ---------------------------------------------------------------------------
// The mark itself
// ---------------------------------------------------------------------------

test('everybody is on the rota until somebody says otherwise', async () => {
  const { db } = setup();
  const { staff } = await (await listStaff(ctx(db, { session: ADMIN }))).json();
  assert.equal(staff.every((s) => s.on_rota === 1), true);
});

test('adding somebody who is never rostered keeps them off the grid', async () => {
  const { db } = setup();
  await createStaff(ctx(db, {
    session: ADMIN,
    body: { name: 'Director', employeeNo: '99', onRota: false },
  }));

  const data = await look(db);
  assert.equal(data.rows.some((r) => r.staff.name === 'Director'), false);
  assert.equal(data.rows.length, 3, 'and everybody else is still there');
});

test('taking somebody off the rota clears what was ahead of them', async () => {
  const { db, raw } = setup();
  // One day behind, one ahead. Only the future goes.
  raw.prepare(
    `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published)
     VALUES (1, '2020-01-06', 1, 'seed', 1), (1, '2099-01-06', 1, 'seed', 1)`,
  ).run();
  raw.prepare(
    "INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 1, 1)",
  ).run();

  const out = await (await updateStaff(ctx(db, {
    session: ADMIN,
    body: { name: 'Kofi', employeeNo: '1', onRota: false },
  }), 1)).json();

  assert.equal(out.clearedFromRota, 1, 'the day still ahead of us is taken off');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_roster').get().n, 1,
    'and the one behind us is left as history');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_patterns').get().n, 0,
    'the standing pattern goes with it, or it puts them straight back');
});

test('a stray save cannot put somebody back on the rota', async () => {
  const { db, raw } = setup();
  offRota(raw, 1);
  await assert.rejects(
    saveRoster(ctx(db, { body: { entries: [{ staffId: 1, day: DAY, shiftId: 1 }] } })),
    /Kofi is not on the rota/,
  );
});

test('copying a week does not carry somebody who is off the rota', async () => {
  const { db, raw } = setup();
  raw.prepare(
    `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published)
     VALUES (1, '2026-06-02', 1, 'seed', 1), (2, '2026-06-02', 2, 'seed', 1)`,
  ).run();
  offRota(raw, 1);

  await copyRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-08', weeks: 1 } }));

  const copied = raw.prepare("SELECT staff_id FROM att_roster WHERE day = '2026-06-09'").all();
  assert.deepEqual(copied.map((r) => r.staff_id), [2], 'only the person still on the rota');
});

test('the workload list leaves them out too', async () => {
  const { db, raw } = setup();
  offRota(raw, 1);
  const data = await (await workload(ctx(db, {
    session: ADMIN, query: '?from=2026-06-01&to=2026-06-14',
  }))).json();
  assert.equal(data.rows.some((r) => r.staff.name === 'Kofi'), false);
  assert.equal(data.rows.length, 2);
});

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

const draft = async (db, extra = {}) => {
  const ds = await loadDataset(db, { from: '2026-06-01', to: '2026-06-03' });
  return suggestRota({
    ds, history: [], from: '2026-06-01', to: '2026-06-01', ...extra,
  });
};

test('the draft never proposes somebody who is off the rota', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_shifts SET needed = 3 WHERE id = 1').run();
  offRota(raw, 1);

  const plan = await draft(db);
  assert.equal(plan.entries.some((e) => e.staffId === 1), false);
  assert.equal(plan.entries.length, 2, 'the two who are left are both put on');
});

test('a shift that says what it needs is filled even with no history behind it', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_shifts SET needed = 3 WHERE id = 1').run();

  const plan = await draft(db);
  const reception = plan.entries.filter((e) => e.shiftId === 1);
  assert.equal(reception.length, 3, 'three asked for, three put on');
});

test('a shift with nothing behind it and nothing asked for is left alone', async () => {
  const { db } = setup();
  const plan = await draft(db);
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.gaps.length, 0);
});

test('what it could not fill is said, shift by shift', async () => {
  const { db, raw } = setup();
  raw.prepare('UPDATE att_shifts SET needed = 5 WHERE id = 1').run();

  const plan = await draft(db);
  assert.equal(plan.entries.length, 3, 'everybody there is put on');
  assert.equal(plan.gaps.length, 1);
  assert.equal(plan.gaps[0].shift, 'Reception');
  assert.equal(plan.gaps[0].wanted, 5);
  assert.equal(plan.gaps[0].short, 2, 'and it says how far short it is');
  assert.ok(plan.gaps[0].why, 'with a reason somebody can act on');
});

test('empty slots already on the day are a request the draft answers', async () => {
  const { db, raw } = setup();
  raw.prepare(
    `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published)
     VALUES (NULL, '2026-06-01', 1, 'seed', 0), (NULL, '2026-06-01', 1, 'seed', 0)`,
  ).run();

  const plan = await draft(db);
  const reception = plan.entries.filter((e) => e.shiftId === 1);
  assert.equal(reception.length, 2, 'two cards standing empty, two people found');
  assert.equal(reception.every((e) => e.rowId), true,
    'and each one fills a card rather than adding a third');
});

test('filling a slot leaves the count where it was', async () => {
  const { db, raw } = setup();
  raw.prepare(
    `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published)
     VALUES (NULL, '2026-06-01', 1, 'seed', 0), (NULL, '2026-06-01', 1, 'seed', 0)`,
  ).run();

  const plan = await draft(db);
  await saveRoster(ctx(db, {
    body: {
      entries: plan.entries.map((e) => ({
        id: e.rowId, day: e.day, staffId: e.staffId, shiftId: e.shiftId,
      })),
    },
  }));

  assert.equal(raw.prepare("SELECT COUNT(*) n FROM att_roster WHERE day = '2026-06-01'").get().n, 2,
    'two rows before, two rows after');
  assert.equal(
    raw.prepare("SELECT COUNT(*) n FROM att_roster WHERE day = '2026-06-01' AND staff_id IS NULL").get().n,
    0, 'and neither is empty any more',
  );
});

test('copying a week does not leave a blank row on every empty day', async () => {
  const { db, raw } = setup();
  raw.prepare(
    `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published)
     VALUES (1, '2026-06-02', 1, 'seed', 1)`,
  ).run();

  await copyRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-08', weeks: 1 } }));

  const blanks = raw.prepare(
    "SELECT COUNT(*) n FROM att_roster WHERE day >= '2026-06-08' AND shift_id IS NULL",
  ).get().n;
  assert.equal(blanks, 0, 'a day nobody was on stays a day nobody is on');
  assert.equal(
    raw.prepare("SELECT COUNT(*) n FROM att_roster WHERE day >= '2026-06-08'").get().n,
    1, 'only the one day that was actually rostered comes across',
  );
});
