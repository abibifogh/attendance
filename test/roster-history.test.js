import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  copyRoster, publishRoster, rosterHistory, saveRoster,
} from '../src/routes/attendance.js';
import { updateStaff } from '../src/routes/attendance-setup.js';

/**
 * Who changed this shift, and what it said before.
 *
 * `set_by` only ever answered "who touched this last", which is no use in the
 * argument it is meant to settle: the cell says Dinner, somebody remembers
 * agreeing Breakfast, and the question is who changed it and when. What is
 * pinned down here is that every way of writing the rota leaves an entry, that
 * the entry says what the day held before, and that deleting the row does not
 * delete the record of the deletion.
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
            DELETE FROM att_availability; DELETE FROM users; DELETE FROM audit_log;
            DELETE FROM att_roster_log;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Breakfast', '06:00', '14:00', 0, 5),
            (2, 'Dinner', '14:00', '22:00', 0, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Front', '2020-01-01'),
            (2, '2', 'Ama', 'Front', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 2, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };
const ADMIN = {
  user: { id: 3, name: 'Kwame', role: 'admin' },
  permissions: ['att_setup', 'att_rota'],
};

const ctx = (db, { body = null, query = '', session = PLANNER } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/x${query}`),
  session,
  executionContext: { waitUntil() {} },
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const DAY = '2026-06-02';
const save = (db, entries) => saveRoster(ctx(db, { body: { entries } }));
const trail = async (db, query) => (await rosterHistory(ctx(db, { query }))).json();
const cell = (db, staffId, day = DAY) => trail(db, `?day=${day}&staffId=${staffId}`);

// ---------------------------------------------------------------------------

test('putting somebody on a day is recorded, with who did it', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);

  const { entries } = await cell(db, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'added');
  assert.equal(entries[0].actor, 'Yaa (planner)');
  assert.equal(entries[0].shift.name, 'Breakfast');
  assert.equal(entries[0].wasShift, null);
  assert.match(entries[0].said, /Kofi was put on Breakfast/);
});

test('moving somebody says what the day held before', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: 2 }]);

  const { entries } = await cell(db, 1);
  assert.equal(entries.length, 2, 'newest first');
  assert.equal(entries[0].action, 'changed');
  assert.equal(entries[0].wasShift.name, 'Breakfast');
  assert.equal(entries[0].shift.name, 'Dinner');
  assert.match(entries[0].said, /Kofi moved from Breakfast to Dinner/);
});

test('saving the same shift again records nothing', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);

  const { entries } = await cell(db, 1);
  assert.equal(entries.length, 1, 'a day already saying this did not change');
});

test('the entry outlives the row it is about', async () => {
  const { db, raw } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await save(db, [{ staffId: 1, day: DAY, clear: true }]);

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_roster').get().n, 0);
  const { entries } = await cell(db, 1);
  assert.equal(entries[0].action, 'removed');
  assert.equal(entries[0].wasShift.name, 'Breakfast');
  assert.match(entries[0].said, /Kofi was taken off Breakfast/);
});

test('an empty slot and whoever stands on it are one story', async () => {
  const { db, raw } = setup();
  await save(db, [{ slot: true, day: DAY, shiftId: 2 }]);
  const rowId = raw.prepare('SELECT id FROM att_roster').get().id;
  await save(db, [{ id: rowId, day: DAY, staffId: 2 }]);

  const { entries } = await trail(db, `?day=${DAY}&shiftId=2`);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].action, 'added');
  assert.match(entries[1].said, /empty Dinner card was put on the day/);
  assert.equal(entries[0].action, 'changed');
  assert.match(entries[0].said, /Dinner went from nobody to Ama/);
});

test('a second shift on the day is its own entry', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await save(db, [{ staffId: 1, day: DAY, shiftId: 2, add: true }]);

  const { entries } = await cell(db, 1);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].detail, 'A second shift on the day');
});

test('publishing is recorded against every day it covered', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }, { staffId: 2, day: DAY, shiftId: 2 }]);
  await publishRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-07', notify: 'none' } }));

  const kofi = await cell(db, 1);
  assert.equal(kofi.entries[0].action, 'published');
  assert.equal(kofi.entries[0].source, 'publish');
  assert.equal(kofi.entries[0].detail, 'Published quietly');

  const ama = await cell(db, 2);
  assert.equal(ama.entries[0].action, 'published');
});

test('copying a week says where the day came from', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await copyRoster(ctx(db, { body: { from: '2026-06-01', to: '2026-06-08', weeks: 1 } }));

  const { entries } = await cell(db, 1, '2026-06-09');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'copy');
  assert.equal(entries[0].detail, 'Copied from 2026-06-02');
});

test('taking somebody off the rota is recorded, not silent', async () => {
  const { db, raw } = setup();
  raw.prepare(
    `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published)
     VALUES (1, '2099-01-06', 1, 'seed', 1)`,
  ).run();

  await updateStaff(ctx(db, {
    session: ADMIN,
    body: { name: 'Kofi', employeeNo: '1', onRota: false },
  }), 1);

  const { entries } = await cell(db, 1, '2099-01-06');
  assert.equal(entries[0].action, 'removed');
  assert.equal(entries[0].source, 'off_rota');
  assert.equal(entries[0].detail, 'Taken off the rota');
});

test('the whole window reads newest first', async () => {
  const { db } = setup();
  await save(db, [{ staffId: 1, day: DAY, shiftId: 1 }]);
  await save(db, [{ staffId: 2, day: '2026-06-03', shiftId: 2 }]);

  const { entries } = await trail(db, '?from=2026-06-01&to=2026-06-14');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].staff.name, 'Ama');
  assert.equal(entries[1].staff.name, 'Kofi');
});

test('a window longer than two months is refused', async () => {
  const { db } = setup();
  await assert.rejects(
    trail(db, '?from=2026-01-01&to=2026-12-31'),
    /two months at most/,
  );
});
