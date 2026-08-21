import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { suggestRoster } from '../src/routes/suggest.js';
import { overlaps, readHistory, usualCover } from '../src/lib/suggest.js';

/**
 * A first draft of a rota, and everything it refuses to do.
 *
 * The promise the whole feature rests on is that it writes nothing and
 * publishes nothing. Everything else it does is a convenience; that part is a
 * guarantee, and it is the first thing tested here.
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

const MON = '2026-06-01';   // the week under test
const shiftDay = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_leave; DELETE FROM att_availability; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");

  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, department)
     VALUES (1, 'Early', '06:00', '14:00', 0, 'Kitchen')`,
  ).run();
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, department)
     VALUES (2, 'Night', '22:00', '06:00', 0, 'Security')`,
  ).run();

  for (const [id, name] of [[1, 'Kofi'], [2, 'Ama'], [3, 'Yaw']]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
       VALUES (?, ?, ?, 'Kitchen', '2020-01-01')`,
    ).run(id, String(id), name);
  }
  return { raw, db: d1(raw) };
}

/** Four weeks of history: Kofi on the Early, Monday to Friday. */
function seedHabit(raw, { staffId = 1, shiftId = 1, weeks = 4, days = [0, 1, 2, 3, 4] } = {}) {
  for (let w = 1; w <= weeks; w += 1) {
    for (const d of days) {
      raw.prepare(
        'INSERT OR IGNORE INTO att_roster (staff_id, day, shift_id, published) VALUES (?, ?, ?, 1)',
      ).run(staffId, shiftDay(MON, -(w * 7) + d), shiftId);
    }
  }
}

const ctx = (db, query = `?from=${MON}`) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/roster/suggest${query}`),
  session: { user: { id: 9, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] },
  executionContext: null,
  request: new Request('https://x/'),
});

const run = async (db, query) => (await suggestRoster(ctx(db, query))).json();

test('it writes nothing at all', async () => {
  const { db, raw } = setup();
  seedHabit(raw);
  const before = raw.prepare('SELECT count(*) AS n FROM att_roster').get().n;

  const out = await run(db);
  assert.ok(out.entries.length > 0, 'it did have something to say');
  assert.equal(out.applied, false);
  assert.equal(out.publishes, false);

  assert.equal(raw.prepare('SELECT count(*) AS n FROM att_roster').get().n, before,
    'not one row was written');
  assert.equal(raw.prepare('SELECT count(*) AS n FROM rota_publish').get().n, 0);
});

test('it proposes what somebody usually works, on the days they usually work it', async () => {
  const { db, raw } = setup();
  seedHabit(raw);

  const out = await run(db);
  const mine = out.entries.filter((e) => e.staffId === 1);
  assert.equal(mine.length, 5, 'Monday to Friday, as the four weeks behind it say');
  assert.deepEqual([...new Set(mine.map((e) => e.shift))], ['Early']);
  assert.deepEqual(mine.map((e) => e.day), [0, 1, 2, 3, 4].map((d) => shiftDay(MON, d)));
  assert.match(mine[0].why, /Usually works Early/);
});

test('a decided cell is never touched, whichever way it was decided', async () => {
  const { db, raw } = setup();
  seedHabit(raw);

  // One day set by hand, one day covered by a standing pattern.
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, NULL)')
    .run(shiftDay(MON, 1));
  raw.prepare('INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 2, NULL)')
    .run();

  const out = await run(db);
  const days = out.entries.filter((e) => e.staffId === 1).map((e) => e.day);
  assert.ok(!days.includes(shiftDay(MON, 1)), 'a rostered rest day is a decision');
  assert.ok(!days.includes(shiftDay(MON, 2)), 'so is a standing pattern');
});

test('approved leave is never rostered over', async () => {
  const { db, raw } = setup();
  seedHabit(raw);
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
     VALUES (1, 'annual_leave', ?, ?, 3, 'approved')`,
  ).run(shiftDay(MON, 0), shiftDay(MON, 2));

  const out = await run(db);
  const days = out.entries.filter((e) => e.staffId === 1).map((e) => e.day);
  assert.deepEqual(days, [shiftDay(MON, 3), shiftDay(MON, 4)]);
});

test('a whole day somebody cannot work is left alone; part of one is not', async () => {
  const { db, raw } = setup();
  seedHabit(raw);

  raw.prepare(
    "INSERT INTO att_availability (staff_id, day, status) VALUES (1, ?, 'unavailable')",
  ).run(shiftDay(MON, 0));
  // An appointment until nine. The Early runs 06:00 to 14:00, so it clashes.
  raw.prepare(
    `INSERT INTO att_availability (staff_id, day, status, from_time, to_time)
     VALUES (1, ?, 'unavailable', '07:00', '09:00')`,
  ).run(shiftDay(MON, 1));
  // An evening class. The Early is finished by then, so it does not.
  raw.prepare(
    `INSERT INTO att_availability (staff_id, day, status, from_time, to_time)
     VALUES (1, ?, 'unavailable', '18:00', '21:00')`,
  ).run(shiftDay(MON, 2));

  const out = await run(db);
  const days = out.entries.filter((e) => e.staffId === 1).map((e) => e.day);
  assert.ok(!days.includes(shiftDay(MON, 0)), 'the whole day is out');
  assert.ok(!days.includes(shiftDay(MON, 1)), 'the morning appointment clashes');
  assert.ok(days.includes(shiftDay(MON, 2)), 'an evening class does not stop a breakfast shift');
});

test('it will not propose a run longer than the property allows', async () => {
  const { db, raw } = setup();
  // Somebody who has worked every single day for four weeks.
  seedHabit(raw, { days: [0, 1, 2, 3, 4, 5, 6] });

  const out = await run(db);
  const days = out.entries.filter((e) => e.staffId === 1).map((e) => e.day).sort();
  assert.ok(days.length <= 6, `six days in a row is the limit, got ${days.length}`);
});

test('it will not propose a week over the hours limit', async () => {
  const { db, raw } = setup();
  // Forty hours is the limit and the Early is eight, so five days is the most
  // anybody can be given however often they have worked six.
  seedHabit(raw, { days: [0, 1, 2, 3, 4, 5] });

  const out = await run(db);
  const hours = out.entries.filter((e) => e.staffId === 1).length * 8;
  assert.ok(hours <= 40, `forty hours is the limit, proposed ${hours}`);
});

test('a gap it cannot fill is reported with the reason, not silently dropped', async () => {
  const { db, raw } = setup();
  // The place usually runs three on the Early each weekday, and two of the
  // three who used to do it have left.
  seedHabit(raw, { staffId: 1 });
  seedHabit(raw, { staffId: 2 });
  seedHabit(raw, { staffId: 3 });
  raw.prepare('UPDATE att_staff SET active = 0 WHERE id IN (2, 3)').run();

  const out = await run(db);
  assert.ok(out.gaps.length > 0, 'it said so');
  assert.ok(out.gaps.every((g) => g.why && g.short > 0));
  assert.ok(out.gaps.some((g) => /already has that day|days in a row|hours/.test(g.why)),
    'and said why in words a planner would use');
});

test('history is read in weeks, and the usual cover is the middle week', () => {
  const rows = [];
  // Three weeks with one person on, one week with four. The median is one.
  for (let w = 0; w < 3; w += 1) {
    rows.push({ staff_id: 1, day: shiftDay('2026-05-04', w * 7), shift_id: 1 });
  }
  for (const person of [1, 2, 3, 4]) {
    rows.push({ staff_id: person, day: shiftDay('2026-05-04', 21), shift_id: 1 });
  }

  const history = readHistory(rows);
  assert.equal(history.length, 4, 'four weeks');
  const cover = usualCover(history, [{ id: 1 }]);
  assert.equal(cover.get('1|0'), 1, 'one busy Monday does not raise every Monday');
});

test('an overnight shift overlaps a window in the evening and in the small hours', () => {
  const night = { starts_at: '22:00', ends_at: '06:00' };
  assert.equal(overlaps(night, '23:00', '23:30'), true);
  assert.equal(overlaps(night, '02:00', '03:00'), true);
  assert.equal(overlaps(night, '09:00', '11:00'), false);

  const early = { starts_at: '06:00', ends_at: '14:00' };
  assert.equal(overlaps(early, '07:00', '09:00'), true);
  assert.equal(overlaps(early, '18:00', '21:00'), false);
  assert.equal(overlaps(early, '14:00', '15:00'), false, 'touching the end is not overlapping');
});
