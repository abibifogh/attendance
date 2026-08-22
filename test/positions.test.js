import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createShift, groupShifts, listShifts, updateShift } from '../src/routes/attendance-setup.js';

/**
 * The job, as against the hours.
 *
 * This property runs "Breakfast 06:00–14:00", "Breakfast 06:00–14:30" and
 * "Breakfast 06:00–15:00". Those are one job that finishes at three different
 * times, and they are three shifts because a shift is what lateness is
 * measured against.
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
  raw.exec('DELETE FROM att_shifts; DELETE FROM att_staff; DELETE FROM users;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");

  let id = 0;
  const shift = (name, starts, ends, position = null) => {
    id += 1;
    raw.prepare(
      `INSERT INTO att_shifts (id, name, starts_at, ends_at, department, position)
       VALUES (?, ?, ?, ?, 'F&B', ?)`,
    ).run(id, name, starts, ends, position);
    return id;
  };
  return { raw, db: d1(raw), shift };
}

const ADMIN = { user: { id: 2, name: 'Ama', role: 'admin' }, permissions: ['att_setup'] };
const ctx = (db, body = null) => ({
  db,
  env: {},
  url: new URL('https://x/api/att/shifts'),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

test('three shifts go under one position in one action', async () => {
  const { db, raw, shift } = setup();
  const a = shift('Breakfast 06:00–14:00', '06:00', '14:00');
  const b = shift('Breakfast 06:00–14:30', '06:00', '14:30');
  const c = shift('Breakfast 06:00–15:00', '06:00', '15:00');
  shift('Night', '22:00', '06:00');

  const out = await (await groupShifts(ctx(db, {
    shiftIds: [a, b, c], position: 'Breakfast',
  }))).json();
  assert.equal(out.changed, 3);
  assert.equal(out.position, 'Breakfast');

  const rows = raw.prepare('SELECT name, position FROM att_shifts ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.position), ['Breakfast', 'Breakfast', 'Breakfast', null]);
});

test('grouping with no name puts them back on their own', async () => {
  const { db, raw, shift } = setup();
  const a = shift('Early', '06:00', '14:00', 'Breakfast');
  const b = shift('Late', '06:00', '15:00', 'Breakfast');

  await groupShifts(ctx(db, { shiftIds: [a, b], position: '' }));
  const rows = raw.prepare('SELECT position FROM att_shifts').all();
  assert.deepEqual(rows.map((r) => r.position), [null, null]);
});

test('nothing ticked is refused rather than treated as everything', async () => {
  const { db, shift } = setup();
  shift('Early', '06:00', '14:00', 'Breakfast');
  await assert.rejects(() => groupShifts(ctx(db, { shiftIds: [] })), /Tick at least one/);
});

test('the list offers every position already in use', async () => {
  const { db, shift } = setup();
  shift('A', '06:00', '14:00', 'Breakfast');
  shift('B', '06:00', '15:00', 'Breakfast');
  shift('C', '14:00', '22:00', 'Dinner');
  shift('D', '22:00', '06:00');

  const out = await (await listShifts(ctx(db))).json();
  assert.deepEqual(out.positions, ['Breakfast', 'Dinner']);
});

test('a position survives being saved through the shift editor', async () => {
  const { db, raw } = setup();
  await createShift(ctx(db, {
    name: 'Breakfast long', startsAt: '06:00', endsAt: '15:00',
    department: 'F&B', position: 'Breakfast',
  }));
  const row = raw.prepare("SELECT * FROM att_shifts WHERE name = 'Breakfast long'").get();
  assert.equal(row.position, 'Breakfast');

  await updateShift(ctx(db, {
    name: 'Breakfast long', startsAt: '06:00', endsAt: '15:00',
    department: 'F&B', position: 'Breakfast', active: true,
  }), row.id);
  assert.equal(
    raw.prepare('SELECT position FROM att_shifts WHERE id = ?').get(row.id).position,
    'Breakfast',
    'editing a shift must not quietly ungroup it',
  );
});
