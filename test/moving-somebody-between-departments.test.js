import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { computeRange, loadDataset, mayWork, scheduleFor, worksIn } from '../src/lib/attendance.js';

/**
 * Moving somebody to another department.
 *
 * WHAT A DEPARTMENT IS FOR, and what it is not. It decides who may be *put on*
 * a shift: the rota builder will not offer a Reception shift to somebody in
 * Maintenance, and the suggester will not fill one with them. That is a
 * question asked while a rota is being made.
 *
 * It has nothing to do with reading one back. A day that has already been
 * rostered is rostered; a punch that has already landed is theirs. Somebody
 * moved between departments on a Tuesday must still read as having worked the
 * Tuesday, or a reorganisation would rewrite the attendance behind it.
 *
 * This is here because it was asked, and the answer has to keep being true.
 */

function d1(db) {
  const st = (sql, b = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...b) }; },
    async first() { return db.prepare(sql).get(...b) ?? null; },
    async run() {
      const r = db.prepare(sql).run(...b);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return { prepare: (s) => st(s), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

const DAY = '2026-08-12';

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM att_shifts; DELETE FROM att_roster;'
    + ' DELETE FROM att_punches; DELETE FROM att_days;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");

  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, active, department)
     VALUES (1, 'Reception AM', '08:00', '16:00', 0, 1, 'Reception')`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on, on_rota, on_clock, active)
     VALUES (1, 'E1', 'Godfred Donkor', 'Reception', '2020-01-01', 1, 1, 1)`,
  ).run();
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
    .run(DAY);
  for (const [at, direction] of [['07:56', 'in'], ['16:04', 'out']]) {
    raw.prepare(
      `INSERT INTO att_punches
         (device_serial, employee_no, staff_id, day, at_local, at_utc, direction, source, dedupe_key)
       VALUES ('T1', 'E1', 1, ?, ?, ?, ?, 'test', ?)`,
    ).run(DAY, `${DAY}T${at}:00`, `${DAY}T${at}:00Z`, direction, `k-${at}`);
  }
  return { raw, db: d1(raw) };
}

const readBack = async (db) => {
  const ds = await loadDataset(db, { from: DAY, to: DAY });
  const [record] = computeRange(ds, 1, DAY, DAY);
  return { ds, record, schedule: scheduleFor(ds, 1, DAY) };
};

test('a day already worked reads the same after a move', async () => {
  const { raw, db } = setup();

  const before = await readBack(db);
  assert.equal(before.record.status, 'present');
  assert.equal(before.schedule.shift.name, 'Reception AM');

  raw.prepare("UPDATE att_staff SET department = 'Maintenance' WHERE id = 1").run();

  const after = await readBack(db);
  assert.equal(after.record.status, 'present', 'still present');
  assert.equal(after.record.worked_minutes, before.record.worked_minutes);
  assert.equal(after.schedule.shift.name, 'Reception AM',
    'the shift they were rostered on is the shift they were rostered on');
});

test('and the punches stay theirs', async () => {
  const { raw, db } = setup();
  raw.prepare("UPDATE att_staff SET department = 'Maintenance' WHERE id = 1").run();
  const ds = await loadDataset(db, { from: DAY, to: DAY });
  assert.equal((ds.punchesByStaff.get(1) ?? []).length, 2);
});

test('clearing the departments they may work in changes nothing either', async () => {
  const { raw, db } = setup();
  raw.prepare("UPDATE att_staff SET department = 'Maintenance', works_in = NULL WHERE id = 1").run();
  const after = await readBack(db);
  assert.equal(after.record.status, 'present');
});

test('what a department does decide is who may be put on a shift', async () => {
  const { raw, db } = setup();
  const ds = await loadDataset(db, { from: DAY, to: DAY });
  const shift = ds.shiftById.get(1);

  assert.equal(mayWork(ds.staffById.get(1), shift), true, 'Reception may work Reception');

  raw.prepare("UPDATE att_staff SET department = 'Maintenance' WHERE id = 1").run();
  const moved = await loadDataset(db, { from: DAY, to: DAY });
  assert.equal(mayWork(moved.staffById.get(1), shift), false,
    'and Maintenance would not be offered it next time a rota is built');
  assert.deepEqual(worksIn(moved.staffById.get(1)), ['Maintenance']);
});

test('losing the rota entry is what actually changes the reading', async () => {
  const { raw, db } = setup();
  raw.prepare('DELETE FROM att_roster WHERE staff_id = 1').run();

  const after = await readBack(db);
  // The punches are still there and the minutes are still counted. What has
  // gone is the shift they were measured against, so it reads as a day worked
  // that nobody asked for rather than as a day missed.
  assert.equal(after.schedule.shift, null);
  assert.equal(after.record.status, 'unscheduled');
  assert.ok(after.record.worked_minutes > 0, 'the clock is not doubted');
});

test('a day nobody was rostered for is never called absent', async () => {
  const { raw, db } = setup();
  raw.prepare('DELETE FROM att_roster WHERE staff_id = 1').run();
  raw.prepare('DELETE FROM att_punches WHERE staff_id = 1').run();

  const after = await readBack(db);
  assert.notEqual(after.record.status, 'absent');
});
