import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { alternatesOf, loadDataset, pairGroup, partnersOf } from '../src/lib/attendance.js';
import { suggestRota } from '../src/lib/suggest.js';

/**
 * A service cut in two, and the single shift that replaces the pair.
 *
 * Three rules, in the words they were given in. If Bistro shift 1 is running,
 * Bistro shift 2 must be present. If both of them are running, Bistro must
 * not. If Bistro is running, both of them must be off.
 *
 * The alternates group already said "one of these runs a day", and putting all
 * three in it would have said the wrong thing — it would have made the two
 * halves of the split rule each other out, which is exactly backwards. So a
 * shift can now say who it runs *with* as well as who it runs *instead of*,
 * and alternates deliberately ignores anybody in the same pair.
 */

const BISTRO = { id: 19, name: 'Bistro', alt_group: 'bistro', pair_group: null };
const ONE = { id: 18, name: 'Bistro shift 1', alt_group: 'bistro', pair_group: 'bistro-split' };
const TWO = { id: 20, name: 'Bistro shift 2', alt_group: 'bistro', pair_group: 'bistro-split' };
const ALL = [BISTRO, ONE, TWO];

// ---------------------------------------------------------------------------
// The arrangement itself
// ---------------------------------------------------------------------------

test('the two halves of a split are not alternatives to each other', () => {
  // The whole reason the pair exists. Without it these two would rule each
  // other out and the split service could never run.
  assert.deepEqual(alternatesOf(ONE, ALL).map((s) => s.name), ['Bistro']);
  assert.deepEqual(alternatesOf(TWO, ALL).map((s) => s.name), ['Bistro']);
});

test('the single shift stands in for both halves', () => {
  assert.deepEqual(
    alternatesOf(BISTRO, ALL).map((s) => s.name).sort(),
    ['Bistro shift 1', 'Bistro shift 2'],
  );
});

test('a shift knows who it runs beside', () => {
  assert.deepEqual(partnersOf(ONE, ALL).map((s) => s.name), ['Bistro shift 2']);
  assert.deepEqual(partnersOf(TWO, ALL).map((s) => s.name), ['Bistro shift 1']);
  assert.deepEqual(partnersOf(BISTRO, ALL), [], 'the single shift runs on its own');
});

test('a pair group is a name, and blank is not one', () => {
  assert.equal(pairGroup({ pair_group: 'bistro-split' }), 'bistro-split');
  assert.equal(pairGroup({ pair_group: '  ' }), null);
  assert.equal(pairGroup({ pair_group: null }), null);
  assert.equal(pairGroup({}), null);
});

test('a pair with no alternates group rules nothing out', () => {
  const a = { id: 1, name: 'A', pair_group: 'p' };
  const b = { id: 2, name: 'B', pair_group: 'p' };
  assert.deepEqual(alternatesOf(a, [a, b]), []);
  assert.deepEqual(partnersOf(a, [a, b]).map((s) => s.name), ['B']);
});

// ---------------------------------------------------------------------------
// And what the draft does with it
// ---------------------------------------------------------------------------

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

async function draft({ people = 6 } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");

  // The three, exactly as the migration sets them up.
  raw.prepare(
    `INSERT INTO att_shifts
       (id, name, starts_at, ends_at, break_minutes, grace_in_minutes, department,
        alt_group, alt_scope, pair_group, needed)
     VALUES (18, 'Bistro shift 1', '11:00', '19:00', 0, 5, 'F&B', 'bistro', 'day', 'bistro-split', 1),
            (19, 'Bistro',         '12:30', '22:00', 0, 5, 'F&B', 'bistro', 'day', NULL, 1),
            (20, 'Bistro shift 2', '13:45', '22:00', 0, 5, 'F&B', 'bistro', 'day', 'bistro-split', 1)`,
  ).run();

  for (let i = 1; i <= people; i += 1) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
       VALUES (?, ?, ?, 'F&B', '2020-01-01')`,
    ).run(i, String(i), `Person ${i}`);
  }

  const db = d1(raw);
  const from = '2026-09-07';
  const to = '2026-09-13';
  const ds = await loadDataset(db, { from, to });
  return { raw, plan: suggestRota({ ds, history: [], from, to }) };
}

const onDay = (plan, day, shiftId) => plan.entries
  .filter((e) => e.day === day && Number(e.shiftId) === shiftId);

const DAYS = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10',
  '2026-09-11', '2026-09-12', '2026-09-13'];

test('a day never runs the pair and the single shift at once', async () => {
  const { plan } = await draft();
  for (const day of DAYS) {
    const split = onDay(plan, day, 18).length + onDay(plan, day, 20).length;
    const single = onDay(plan, day, 19).length;
    assert.equal(split > 0 && single > 0, false,
      `${day} ran both the split and the single Bistro`);
  }
});

test('the split runs as a pair rather than as one half', async () => {
  const { plan } = await draft();
  let daysWithTheSplit = 0;
  for (const day of DAYS) {
    const one = onDay(plan, day, 18).length;
    const two = onDay(plan, day, 20).length;
    if (!one && !two) continue;
    daysWithTheSplit += 1;
    // Where one half could not be staffed the draft says so rather than
    // silently running half a service, and the gap names its partner.
    if (one && !two) {
      const gap = plan.gaps.find((g) => g.day === day && Number(g.shiftId) === 20);
      assert.ok(gap, `${day} ran shift 1 with no shift 2 and no gap to say so`);
      assert.equal(gap.goesWith, 'Bistro shift 1');
    }
    if (two && !one) {
      const gap = plan.gaps.find((g) => g.day === day && Number(g.shiftId) === 18);
      assert.ok(gap, `${day} ran shift 2 with no shift 1 and no gap to say so`);
      assert.equal(gap.goesWith, 'Bistro shift 2');
    }
  }
  assert.ok(daysWithTheSplit > 0, 'the split ran at all');
});

test('the single shift is reported as standing in, not as missing', async () => {
  const { plan } = await draft();
  // Whichever way round a day settles, the one that did not run is an
  // "instead of" rather than a gap: the day was covered.
  for (const note of plan.instead) {
    assert.ok([18, 19, 20].includes(Number(note.shiftId)));
    assert.ok(note.ranAs);
  }
  assert.ok(plan.instead.length > 0, 'the alternation had something to say');
});

test('a gap on an unpaired shift says nothing about a partner', async () => {
  const { plan } = await draft({ people: 0 });
  const single = plan.gaps.find((g) => Number(g.shiftId) === 19);
  if (single) assert.equal(single.goesWith, null);
});
