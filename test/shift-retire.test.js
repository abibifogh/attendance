import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createShift, deleteShift, listShifts, updateShift } from '../src/routes/attendance-setup.js';

/**
 * Retiring a shift rather than deleting it.
 *
 * A shift is not a row in a table. It is what "late" was measured against on
 * every day anybody ever worked it. Delete it and the hours stay, the verdicts
 * stay, and the thing that produced them is gone — so nobody can answer "late
 * compared to what?", which is the only question that matters when somebody
 * disputes a deduction three months later.
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
  raw.exec('DELETE FROM att_days; DELETE FROM att_roster; DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_punches; DELETE FROM att_staff;');
  return { raw, db: d1(raw) };
}

const ADMIN = {
  user: { id: 1, name: 'Kwame', role: 'admin' },
  permissions: ['att_setup', 'att_view'],
};

const ctx = (db, body = {}) => ({
  db,
  env: {},
  url: new URL('https://x/api/att/shifts'),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
});

const SHIFT = {
  name: 'Breakfast', startsAt: '06:00', endsAt: '14:00',
  breakMinutes: 0, graceInMinutes: 5, graceOutMinutes: 5,
  halfDayMinutes: 240, fullDayMinutes: 420, overtimeAfter: 0,
};

async function makeShift(db, over = {}) {
  const res = await createShift(ctx(db, { ...SHIFT, ...over }));
  const out = await res.json();
  return out.id ?? out.shift?.id;
}

test('a shift nothing has used can simply be deleted', async () => {
  const { db, raw } = setup();
  const id = await makeShift(db);

  const listed = await (await listShifts(ctx(db))).json();
  assert.equal(listed.shifts[0].deletable, true, 'the screen is told so before anybody presses');

  await deleteShift(ctx(db), id);
  assert.equal(raw.prepare('SELECT COUNT(*) c FROM att_shifts').get().c, 0);
});

test('a shift with days recorded against it cannot be deleted', async () => {
  const { db, raw } = setup();
  const id = await makeShift(db);
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Henry', '2020-01-01')",
  ).run();
  raw.prepare(
    "INSERT INTO att_days (staff_id, day, shift_id, status) VALUES (1, '2026-06-01', ?, 'present')",
  ).run(id);

  await assert.rejects(deleteShift(ctx(db), id), (err) => {
    assert.match(err.message, /1 day already recorded against it/);
    assert.match(err.message, /Retire it instead/);
    assert.equal(err.detail?.retireInstead, true);
    return true;
  });

  assert.equal(raw.prepare('SELECT COUNT(*) c FROM att_shifts').get().c, 1, 'still there');
  const listed = await (await listShifts(ctx(db))).json();
  assert.equal(listed.shifts[0].deletable, false, 'and the screen offers Retire instead of Delete');
});

test('a shift only on a future rota cannot be deleted either', async () => {
  const { db, raw } = setup();
  const id = await makeShift(db);
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Henry', '2020-01-01')",
  ).run();
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, ?)')
    .run('2026-12-24', id);

  // Nothing has been *recorded* yet, but somebody is down to work it. Deleting
  // it would blank next week's plan without telling anybody.
  await assert.rejects(deleteShift(ctx(db), id), /1 rostered day/);
});

test('retiring takes it off the lists and leaves the history alone', async () => {
  const { db, raw } = setup();
  const id = await makeShift(db);
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Henry', '2020-01-01')",
  ).run();
  raw.prepare(
    "INSERT INTO att_days (staff_id, day, shift_id, status) VALUES (1, '2026-06-01', ?, 'present')",
  ).run(id);

  await updateShift(ctx(db, { ...SHIFT, active: false }), id);

  const listed = await (await listShifts(ctx(db))).json();
  const shift = listed.shifts.find((s) => s.id === id);
  assert.equal(shift.active, 0, 'retired');
  assert.equal(shift.used_days, 1, 'and the day it produced is still counted against it');

  // The day itself is untouched: same shift, same verdict.
  const day = raw.prepare('SELECT shift_id, status FROM att_days WHERE day = ?').get('2026-06-01');
  assert.equal(day.shift_id, id);
  assert.equal(day.status, 'present');
});

test('a retired shift can be brought back', async () => {
  const { db } = setup();
  const id = await makeShift(db);
  await updateShift(ctx(db, { ...SHIFT, active: false }), id);
  await updateShift(ctx(db, { ...SHIFT, active: true }), id);

  const listed = await (await listShifts(ctx(db))).json();
  assert.equal(listed.shifts.find((s) => s.id === id).active, 1);
});
