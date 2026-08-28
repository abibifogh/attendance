import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getRoster, saveRoster, setAvailability } from '../src/routes/attendance.js';
import { allows, effectivePermissions } from '../src/lib/permissions.js';

/**
 * Reading the rota without being able to touch it.
 *
 * A head of department, an owner, whoever answers the phone on a Saturday:
 * there are people who need to know who is on and have no business moving
 * anybody. What is pinned down here is that they get the rota — the same days,
 * the same shifts, the same names — and none of the things a planner reads
 * while deciding. The screen hides those anyway; this is the gate underneath
 * it, because a permission that only hides is a curtain.
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
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Reception', '06:00', '14:00', 0, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Adjoa', 'Front', '2020-01-01'),
            (2, '2', 'Kwesi', 'Front', '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const WINDOW = '?from=2026-09-07&to=2026-09-13';

const asWho = (db, permissions, { body = null, query = WINDOW } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/roster${query}`),
  session: { user: { id: 4, name: 'Efua', role: 'rota_reader' }, permissions },
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const reader = (db, opts) => asWho(db, ['att_rota_view'], opts);
const planner = (db, opts) => asWho(db, ['att_rota', 'att_view'], opts);

test('a reader gets the rota: the same days, shifts and names', async () => {
  const { db } = setup();
  await saveRoster(planner(db, { body: { entries: [
    { staffId: 1, day: '2026-09-08', shiftId: 1 },
  ] } }));

  const seen = await (await getRoster(reader(db))).json();
  const built = await (await getRoster(planner(db))).json();

  assert.deepEqual(seen.days, built.days);
  assert.deepEqual(seen.rows.map((r) => r.staff.name), built.rows.map((r) => r.staff.name));

  const day = (out) => out.rows.find((r) => r.staff.name === 'Adjoa')
    .days.find((d) => d.day === '2026-09-08');
  assert.equal(day(seen).shift_id, 1);
  assert.equal(day(seen).shift_id, day(built).shift_id);
  assert.equal(day(seen).published, false, 'and can tell a draft from a promise');
});

test('what a planner reads while deciding does not go out with it', async () => {
  const { db } = setup();
  await setAvailability(planner(db, { body: {
    staffId: 1,
    days: ['2026-09-09'],
    status: 'unavailable',
    note: 'Hospital appointment',
  } }));
  await saveRoster(planner(db, { body: { entries: [
    { staffId: 1, day: '2026-09-08', shiftId: 1 },
  ] } }));

  const seen = await (await getRoster(reader(db))).json();
  const built = await (await getRoster(planner(db))).json();

  const cell = (out, day) => out.rows.find((r) => r.staff.name === 'Adjoa')
    .days.find((d) => d.day === day);

  assert.ok(cell(built, '2026-09-09').availability, 'the planner sees why she cannot');
  assert.equal(cell(seen, '2026-09-09').availability, null, 'the reader does not');
  assert.equal(JSON.stringify(seen).includes('Hospital appointment'), false,
    'and her reason never left the building');

  assert.equal(cell(seen, '2026-09-13').sundays, null, 'no Sunday count');
  assert.equal(seen.asked, 0, 'nothing about what anybody has asked for');
  assert.deepEqual(seen.publish, { fresh: 0, again: 0 }, 'and nothing waiting to be published');
});

test('a reader cannot save, and the gate is the route rather than the screen', async () => {
  const held = effectivePermissions({ role: 'rota_reader', permissions: null });

  assert.deepEqual(held, ['att_rota_view'], 'and it drags nothing else along with it');
  assert.equal(allows(['att_rota', 'att_rota_view', 'att_reports'], held), true,
    'the rota is theirs to read');

  for (const shut of ['att_rota', 'att_view', 'att_reports', 'att_manage', 'att_signoff']) {
    assert.equal(allows(shut, held), false, `${shut} is not`);
  }
});

test('building the rota carries reading it, so no route has to name both', () => {
  const held = effectivePermissions({ role: 'planner', permissions: null });
  assert.equal(allows('att_rota_view', held), true);
});
