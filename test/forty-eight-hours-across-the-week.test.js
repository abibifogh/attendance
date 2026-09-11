import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { loadDataset } from '../src/lib/attendance.js';
import {
  CLEAR_DAY_MINUTES, LIMITS, assessPerson, shiftsInWindow, weeklyRest,
} from '../src/lib/workload.js';

/**
 * Forty-eight hours off in the week, and not necessarily in one run.
 *
 * The check measured the longest unbroken stretch, which is what Act 651 s.36
 * asks for and is not how this property rosters. Somebody off on the Wednesday
 * and off again on the Saturday has had two days off; the rota said they had
 * had forty hours and flagged a week that keeps the house rule.
 *
 * So the loud finding is now the property's own rule — the days off added up —
 * and the law's stricter reading is still measured and still said, one step
 * quieter, because a clean rota under the house rule is not the same thing as
 * a rota a labour officer would pass and nobody should be able to confuse the
 * two by reading this screen.
 *
 * What does not count is a nightly turnaround. Adding up the twelve hours
 * between a late and an early would give everybody ninety hours off a week
 * they never left, and the check would never fire again. A break has to be a
 * clear day before it is a day off.
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

async function world(rota = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_leave; DELETE FROM att_holidays;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  const ids = { morning: 1, evening: 2, night: 3 };
  for (const [key, [name, a, b]] of Object.entries({
    morning: ['Morning', '06:00', '14:00'],
    evening: ['Evening', '14:00', '22:00'],
    night: ['Night', '22:00', '06:00'],
  })) {
    raw.prepare(
      `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes,
                               grace_in_minutes, grace_out_minutes)
       VALUES (?, ?, ?, ?, 0, 5, 5)`,
    ).run(ids[key], name, a, b);
  }
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (1,'1','Kofi','Kitchen','2020-01-01')",
  ).run();
  for (const [day, key] of Object.entries(rota)) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, ?)')
      .run(day, key === null ? null : ids[key]);
  }
  const db = d1(raw);
  const ds = await loadDataset(db, { from: '2026-05-25', to: '2026-06-21' });
  return { ds, staff: ds.staffById.get(1) };
}

const week = (start, keys) => Object.fromEntries(keys.map((k, i) => {
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return [d.toISOString().slice(0, 10), k];
}).filter(([, k]) => k));

const MON = '2026-06-01';
const SUN = '2026-06-07';

const restFor = async (rota, from = MON, to = SUN) => {
  const { ds, staff } = await world(rota);
  return weeklyRest(shiftsInWindow(ds, staff.id, from, to), from, to);
};

const keysFor = async (rota, from = MON, to = SUN) => {
  const { ds, staff } = await world(rota);
  return assessPerson(ds, staff, from, to, LIMITS).findings.map((f) => f.key);
};

// ---------------------------------------------------------------------------
// The property's rule
// ---------------------------------------------------------------------------

test('two days off in the week count, whether or not they are next to each other', async () => {
  // Off on the Wednesday and off on the Saturday. Two days off is two days
  // off, and this is the rota that was being reported.
  const rest = await restFor(week(MON, [
    'morning', 'morning', null, 'morning', 'morning', null, 'morning',
  ]));

  assert.ok(rest[0].hours >= 48, `expected 48 across the week, got ${rest[0].hours}`);
  assert.ok(rest[0].longest < 48, 'and no single run of 48, which is the whole point');
  assert.equal((await keysFor(week(MON, [
    'morning', 'morning', null, 'morning', 'morning', null, 'morning',
  ]))).includes('weekly-rest'), false, 'so nothing is raised about it');
});

test('a week with one day off is still short, and says by how much', async () => {
  const rota = week(MON, ['morning', 'morning', 'morning', 'morning', 'morning', 'morning', null]);
  const rest = await restFor(rota);
  assert.ok(rest[0].hours < 48, `one day off is not two: ${rest[0].hours}`);
  assert.ok((await keysFor(rota)).includes('weekly-rest'));
});

test('nightly turnarounds are not hours off', async () => {
  // Seven mornings in a row inside a continuing rota. Sixteen hours between
  // one and the next, seven times over, is 112 hours of nothing.
  const rest = await restFor({
    '2026-05-31': 'morning',
    ...week(MON, Array(7).fill('morning')),
    ...week('2026-06-08', Array(7).fill('morning')),
  });
  assert.equal(rest[0].hours, 0, 'not one clear day');
  assert.equal(rest[0].longest, 16);
});

test('the floor is a clear day, said once and in one place', () => {
  assert.equal(CLEAR_DAY_MINUTES, 24 * 60);
});

test('a break of less than a day is not counted even beside a real one', async () => {
  // Off Tuesday 14:00 to Thursday 06:00 is 40 hours, a real break. The rest of
  // the week is nightly turnarounds, and 40 plus four of those is not 48.
  const rota = week(MON, [
    'morning', 'morning', null, 'morning', 'morning', 'morning', 'morning',
  ]);
  const rest = await restFor(rota);
  assert.ok(rest[0].hours < 48, `40 hours and some overnights: ${rest[0].hours}`);
  assert.ok((await keysFor(rota)).includes('weekly-rest'));
});

// ---------------------------------------------------------------------------
// And the law's, one step quieter
// ---------------------------------------------------------------------------

test('a week that takes its 48 in pieces is still said, as a warning', async () => {
  const rota = week(MON, ['morning', 'morning', null, 'morning', 'morning', null, 'morning']);
  const found = (await keysFor(rota));
  assert.equal(found.includes('weekly-rest'), false, 'the house rule is kept');
  assert.ok(found.includes('weekly-rest-split'), 'and the law is not, so it is mentioned');
});

test('a proper weekend raises neither', async () => {
  const rota = week(MON, ['morning', 'morning', 'morning', 'morning', 'morning', null, null]);
  const found = await keysFor(rota);
  assert.equal(found.includes('weekly-rest'), false);
  assert.equal(found.includes('weekly-rest-split'), false, 'Friday to Monday is one run of 48');
});

test('the two are never both raised about the same week', async () => {
  // The quiet one is only for weeks the loud one has passed. Saying both would
  // be one rota reported twice.
  for (const rota of [
    week(MON, Array(7).fill('morning')),
    week(MON, ['morning', 'morning', null, 'morning', 'morning', null, 'morning']),
    week(MON, ['morning', 'morning', 'morning', 'morning', 'morning', null, null]),
    week(MON, [null, null, null, null, null, null, null]),
  ]) {
    const found = await keysFor(rota);
    assert.equal(found.filter((k) => k.startsWith('weekly-rest')).length <= 1, true,
      `two findings about one week: ${found.join(', ')}`);
  }
});

test('the warning carries the law and the finding carries the house rule', async () => {
  const { ds, staff } = await world(
    week(MON, ['morning', 'morning', null, 'morning', 'morning', null, 'morning']),
  );
  const split = assessPerson(ds, staff, MON, SUN, LIMITS).findings
    .find((f) => f.key === 'weekly-rest-split');
  assert.equal(split.level, 'warn', 'they got the time, so it is not urgent');
  assert.match(split.law ?? '', /Act 651 s\.36/);
  assert.match(split.detail, /in one run/);
});

// ---------------------------------------------------------------------------
// What the property is told it is setting
// ---------------------------------------------------------------------------

test('the setting no longer promises one unbroken stretch', () => {
  const lib = readFileSync('src/lib/workload.js', 'utf8');
  assert.match(lib, /weeklyRestHours: \{ value: 48, law: 'Act 651 s\.36', label: 'Rest each week' \}/);

  const screen = readFileSync('public/js/views/att-setup.js', 'utf8');
  assert.equal(/One stretch, not two days added together/.test(screen), false,
    'that is exactly what it now is');
});
