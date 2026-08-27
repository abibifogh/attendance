import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { clearRoster, getRoster, rosterHistory } from '../src/routes/attendance.js';

/**
 * Taking a period back off the rota.
 *
 * The dangerous operation on this screen, so what is pinned down here is
 * mostly what it must *not* do: touch approved leave, touch a published day
 * nobody asked it to, reach outside the dates it was given, or reach past the
 * filter the planner was looking through. And the difference between the two
 * kinds of clear, which is the whole reason it asks: taking the decisions off
 * lets the standing pattern show through again, while clearing to nothing
 * writes a day off on every day.
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
            DELETE FROM att_leave; DELETE FROM users; DELETE FROM audit_log;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Reception', '06:00', '14:00', 0, 5),
            (2, 'Dinner', '14:00', '22:00', 0, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, tags, hired_on)
     VALUES (1, '1', 'Adjoa', 'Front', '["keyholder"]', '2020-01-01'),
            (2, '2', 'Kwesi', 'Kitchen', NULL, '2020-01-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 2, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };

const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/x${query}`),
  session: PLANNER,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const WEEK = '?from=2026-09-07&to=2026-09-13';
const look = async (db) => (await getRoster(ctx(db, { query: WEEK }))).json();
const clear = async (db, body) => (await clearRoster(ctx(db, { body }))).json();

const rows = (raw) => raw.prepare('SELECT * FROM att_roster ORDER BY day, id').all();

const roster = (raw, staffId, days, shiftId = 1, published = 0) => {
  for (const day of days) {
    raw.prepare(
      'INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (?, ?, ?, ?)',
    ).run(staffId, day, shiftId, published);
  }
};

const cellOn = (data, name, day) => data.rows
  .find((r) => r.staff.name === name).days.find((d) => d.day === day);

const DAYS = ['2026-09-07', '2026-09-08', '2026-09-09'];

// ---------------------------------------------------------------------------
// The two kinds of clear
// ---------------------------------------------------------------------------

test('clearing back to the pattern takes the decisions off and lets it show', async () => {
  const { db, raw } = setup();
  raw.prepare(
    'INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 0, 2)',
  ).run();
  roster(raw, 1, DAYS);

  const done = await clear(db, { from: '2026-09-07', to: '2026-09-09' });
  assert.equal(done.cleared, 3);
  assert.equal(rows(raw).length, 0, 'the rows are gone');

  // Monday is dow 0, and the pattern says Dinner. It shows again.
  const monday = cellOn(await look(db), 'Adjoa', '2026-09-07');
  assert.equal(monday.shift_id, 2);
  assert.equal(monday.source, 'pattern', 'the standing pattern is answering again');
});

test('clearing to nothing writes a day off on every day', async () => {
  const { db, raw } = setup();
  raw.prepare(
    'INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 0, 2)',
  ).run();
  roster(raw, 1, DAYS);

  const done = await clear(db, { from: '2026-09-07', to: '2026-09-09', mode: 'off' });
  assert.equal(done.cleared, 3);

  const monday = cellOn(await look(db), 'Adjoa', '2026-09-07');
  assert.equal(monday.shift_id, null, 'the pattern does not show through');
  assert.equal(monday.explicit, true, 'because a day off is a decision');
});

test('clearing to nothing skips a day that is already empty', async () => {
  const { db, raw } = setup();
  // One rostered day off, and one person with nothing at all on the day.
  // Neither needs a row written to say the day is empty.
  raw.prepare("INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, '2026-09-07', NULL)").run();

  const done = await clear(db, { from: '2026-09-07', to: '2026-09-07', mode: 'off' });
  assert.equal(done.cleared, 0);
  assert.equal(rows(raw).length, 1, 'and nothing was written for the second person');
});

test('clearing to nothing does write over a day the pattern would fill', async () => {
  const { db, raw } = setup();
  raw.prepare(
    'INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (2, 0, 0, 1)',
  ).run();

  const done = await clear(db, { from: '2026-09-07', to: '2026-09-07', mode: 'off' });
  assert.equal(done.cleared, 1, 'Kwesi normally works Mondays, so the day has to be said');
  assert.equal(cellOn(await look(db), 'Kwesi', '2026-09-07').shift_id, null);
});

// ---------------------------------------------------------------------------
// What it must not touch
// ---------------------------------------------------------------------------

test('approved leave is never cleared', async () => {
  const { db, raw } = setup();
  roster(raw, 1, DAYS);
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
     VALUES (1, 'annual_leave', '2026-09-08', '2026-09-08', 1, 'approved')`,
  ).run();

  const done = await clear(db, { from: '2026-09-07', to: '2026-09-09' });
  assert.equal(done.cleared, 2);
  assert.equal(done.keptLeave, 1);
  assert.deepEqual(rows(raw).map((r) => r.day), ['2026-09-08'], 'the leave day is untouched');
});

test('a published day is left alone until somebody says otherwise', async () => {
  const { db, raw } = setup();
  roster(raw, 1, ['2026-09-07'], 1, 1);
  roster(raw, 1, ['2026-09-08'], 1, 0);

  let done = await clear(db, { from: '2026-09-07', to: '2026-09-09' });
  assert.equal(done.cleared, 1);
  assert.equal(done.keptPublished, 1);
  assert.deepEqual(rows(raw).map((r) => r.day), ['2026-09-07']);

  // Asked for, it goes.
  done = await clear(db, { from: '2026-09-07', to: '2026-09-09', includePublished: true });
  assert.equal(done.cleared, 1);
  assert.equal(rows(raw).length, 0);
});

test('it reaches exactly the days it was given and not one either side', async () => {
  const { db, raw } = setup();
  roster(raw, 1, ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09']);

  await clear(db, { from: '2026-09-07', to: '2026-09-08' });
  assert.deepEqual(rows(raw).map((r) => r.day), ['2026-09-06', '2026-09-09']);
});

test('a filtered grid clears what it was showing and nobody else', async () => {
  const { db, raw } = setup();
  roster(raw, 1, DAYS);
  roster(raw, 2, DAYS);

  const done = await clear(db, { from: '2026-09-07', to: '2026-09-09', department: 'Front' });
  assert.equal(done.cleared, 3);
  assert.deepEqual([...new Set(rows(raw).map((r) => r.staff_id))], [2],
    'the kitchen was not on screen and was not cleared');
});

test('a tag filter narrows it the same way', async () => {
  const { db, raw } = setup();
  roster(raw, 1, DAYS);
  roster(raw, 2, DAYS);

  await clear(db, { from: '2026-09-07', to: '2026-09-09', tag: 'keyholder' });
  assert.deepEqual([...new Set(rows(raw).map((r) => r.staff_id))], [2]);
});

test('a shift standing on a day with nobody on it goes too', async () => {
  const { db, raw } = setup();
  raw.prepare(
    "INSERT INTO att_roster (staff_id, day, shift_id) VALUES (NULL, '2026-09-07', 1)",
  ).run();

  const done = await clear(db, { from: '2026-09-07', to: '2026-09-09' });
  assert.equal(done.slots, 1);
  assert.equal(rows(raw).length, 0);
});

test('but not when the grid is filtered, because a slot belongs to nobody', async () => {
  const { db, raw } = setup();
  raw.prepare(
    "INSERT INTO att_roster (staff_id, day, shift_id) VALUES (NULL, '2026-09-07', 1)",
  ).run();

  const done = await clear(db, { from: '2026-09-07', to: '2026-09-09', department: 'Front' });
  assert.equal(done.slots, 0);
  assert.equal(rows(raw).length, 1, 'a department filter says nothing about an unfilled shift');
});

// ---------------------------------------------------------------------------
// It leaves a trail, and it refuses the impossible
// ---------------------------------------------------------------------------

test('every day cleared leaves its own entry in what changed', async () => {
  const { db, raw } = setup();
  roster(raw, 1, DAYS);
  await clear(db, { from: '2026-09-07', to: '2026-09-09' });

  const trail = await (await rosterHistory(ctx(db, { query: WEEK }))).json();
  const mine = trail.entries.filter((e) => e.source === 'clear');
  assert.equal(mine.length, 3);
  assert.equal(mine.every((e) => e.action === 'removed'), true);
  assert.match(mine[0].detail, /Cleared 2026-09-07 to 2026-09-09/);
});

test('a period the wrong way round, or too long, is refused', async () => {
  const { db } = setup();
  await assert.rejects(
    () => clearRoster(ctx(db, { body: { from: '2026-09-09', to: '2026-09-07' } })),
    /before its start/,
  );
  await assert.rejects(
    () => clearRoster(ctx(db, { body: { from: '2026-01-01', to: '2026-12-31' } })),
    /three months/,
  );
  await assert.rejects(
    () => clearRoster(ctx(db, { body: { from: '2026-09-07' } })),
    /both a start and an end/,
  );
});

test('somebody off the rota is not touched by a clear', async () => {
  const { db, raw } = setup();
  roster(raw, 1, DAYS);
  raw.prepare('UPDATE att_staff SET on_rota = 0 WHERE id = 1').run();

  const done = await clear(db, { from: '2026-09-07', to: '2026-09-09' });
  assert.equal(done.cleared, 0);
  assert.equal(rows(raw).length, 3, 'they are not on the grid, so the grid does not clear them');
});
