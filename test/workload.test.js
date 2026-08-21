import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { loadDataset } from '../src/lib/attendance.js';
import {
  LIMITS, assessPerson, consecutiveRuns, isNightShift, limitsFrom,
  nightFlips, restFindings, shiftsInWindow, strainScore, turnarounds, weeklyRest,
} from '../src/lib/workload.js';

/**
 * Whether a rota is survivable.
 *
 * The figures here end up in front of somebody deciding who works Saturday, so
 * they have to be checkable by hand. Every case below is one anybody could
 * work out on paper in a minute, which is the only kind worth asserting.
 */

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() { db.prepare(sql).run(...binds); return { success: true, meta: { changes: 0 } }; },
  });
  return { prepare: (sql) => st(sql), async batch(l) { for (const s of l) await s.run(); return []; } };
}

/** One cook, a set of shifts, and whatever rota the test wants. */
async function world(rota = {}, shifts = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_leave; DELETE FROM att_holidays;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");

  const all = {
    morning: ['Morning', '06:00', '14:00'],
    evening: ['Evening', '14:00', '22:00'],
    night: ['Night', '22:00', '06:00'],
    long: ['Long', '08:00', '20:00'],
    ...shifts,
  };
  const ids = {};
  let n = 0;
  for (const [key, [name, a, b]] of Object.entries(all)) {
    n += 1;
    ids[key] = n;
    raw.prepare(
      `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes,
                               grace_in_minutes, grace_out_minutes)
       VALUES (?, ?, ?, ?, 0, 5, 5)`,
    ).run(n, name, a, b);
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
  return { raw, db, ds, ids, staff: ds.staffById.get(1) };
}

const week = (start, keys) => Object.fromEntries(keys.map((k, i) => {
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return [d.toISOString().slice(0, 10), k];
}).filter(([, k]) => k));

// ---------------------------------------------------------------------------

test('a night is any shift that runs through the small hours', () => {
  const s = (a, b) => ({ id: 1, name: 'x', starts_at: a, ends_at: b, break_minutes: 0 });
  assert.equal(isNightShift(s('22:00', '06:00')), true, 'the obvious one');
  assert.equal(isNightShift(s('17:30', '06:30')), true, 'a long security night');
  assert.equal(isNightShift(s('04:30', '12:00')), true, 'an early start still costs the sleep');
  assert.equal(isNightShift(s('06:00', '14:00')), false);
  assert.equal(isNightShift(s('14:00', '22:00')), false, 'finishing at ten is not a night');
});

test('a run of days is counted, and one day off breaks it', async () => {
  const { ds, staff } = await world(week('2026-06-01',
    ['morning', 'morning', 'morning', null, 'morning', 'morning', 'morning']));
  const worked = shiftsInWindow(ds, staff.id, '2026-06-01', '2026-06-07');
  const runs = consecutiveRuns(worked.filter((w) => w.day >= '2026-06-01' && w.day <= '2026-06-07'),
    '2026-06-01', '2026-06-07');

  assert.equal(runs.longest, 3, 'three, a day off, three — not seven');
  assert.equal(runs.longestEnd, '2026-06-03');
});

test('closing then opening is measured in hours, not in days', async () => {
  // Off at 22:00 on Monday, back at 06:00 on Tuesday: eight hours.
  const { ds, staff } = await world({ '2026-06-01': 'evening', '2026-06-02': 'morning' });
  const worked = shiftsInWindow(ds, staff.id, '2026-06-01', '2026-06-02');
  const short = turnarounds(worked, 12);

  assert.equal(short.length, 1);
  assert.equal(short[0].hours, 8);
  assert.equal(short[0].after, 'Evening');
  assert.equal(short[0].before, 'Morning');
});

test('a comfortable gap is not reported', async () => {
  // Off at 14:00 Monday, back at 06:00 Tuesday: sixteen hours.
  const { ds, staff } = await world({ '2026-06-01': 'morning', '2026-06-02': 'morning' });
  const worked = shiftsInWindow(ds, staff.id, '2026-06-01', '2026-06-02');
  assert.deepEqual(turnarounds(worked, 12), []);
});

test('the weekly rest is the longest unbroken stretch off duty', async () => {
  // Seven mornings in a row, inside a rota that carries on afterwards — so the
  // only gaps are the sixteen hours between one shift and the next. A fixture
  // that simply stopped on the Sunday would be measuring the end of the data
  // rather than a week of work.
  const { ds, staff } = await world({
    '2026-05-31': 'morning',            // and the day before it, so the run is
    ...week('2026-06-01', Array(7).fill('morning')),   // genuinely unbroken at
    ...week('2026-06-08', Array(7).fill('morning')),   // both ends
  });
  const worked = shiftsInWindow(ds, staff.id, '2026-06-01', '2026-06-07');
  const rest = weeklyRest(worked, '2026-06-01', '2026-06-07');

  assert.equal(rest.length, 1, 'one seven-day stretch fits in seven days');
  assert.equal(rest[0].hours, 16, 'never a 48-hour break, and 16 is the best of it');
});

test('rest at the edge of what is known is not invented, and not clipped either', async () => {
  // An ordinary week inside a continuing rota: Friday 14:00 to Monday 06:00 is
  // 64 hours, and every seven-day stretch that touches it gets the credit.
  // Clipping the weekend at a rolling window boundary used to report 34 hours
  // and accuse the property of breaking the law every week of its life.
  const { ds, staff } = await world({
    ...week('2026-06-01', ['morning', 'morning', 'morning', 'morning', 'morning', null, null]),
    ...week('2026-06-08', ['morning', 'morning', 'morning', 'morning', 'morning', null, null]),
  });
  const worked = shiftsInWindow(ds, staff.id, '2026-06-01', '2026-06-14');
  const rest = weeklyRest(worked, '2026-06-01', '2026-06-14');

  assert.equal(rest.length, 8, 'eight overlapping seven-day stretches in a fortnight');
  for (const w of rest) {
    assert.ok(w.hours >= 48, `the stretch from ${w.from} saw only ${w.hours} h`);
  }
});

test('two days off together give the 48 hours the law asks for', async () => {
  const { ds, staff } = await world(week('2026-06-01',
    ['morning', 'morning', 'morning', 'morning', 'morning', null, null]));
  const worked = shiftsInWindow(ds, staff.id, '2026-06-01', '2026-06-07');
  const rest = weeklyRest(worked, '2026-06-01', '2026-06-07');

  // Off at 14:00 on Friday, and nothing until the window ends on Sunday night.
  assert.ok(rest[0].hours >= 48, `expected at least 48, got ${rest[0].hours}`);
});

test('flipping between nights and days is counted', async () => {
  const { ds, staff } = await world(week('2026-06-01',
    ['night', 'night', 'morning', 'morning', 'night', 'morning', 'morning']));
  const worked = shiftsInWindow(ds, staff.id, '2026-06-01', '2026-06-07');
  // night night | morning morning | night | morning morning  → three changes.
  assert.equal(nightFlips(worked.filter((w) => w.day >= '2026-06-01' && w.day <= '2026-06-07')), 3);
});

test('leave is rest, not work', async () => {
  const { raw, db, staff } = await world({ '2026-06-01': 'morning', '2026-06-02': 'morning' });
  const code = raw.prepare("SELECT code FROM att_reasons WHERE kind = 'leave' LIMIT 1").get()
    ?? raw.prepare('SELECT code FROM att_reasons LIMIT 1').get();
  raw.prepare(
    `INSERT INTO att_leave (staff_id, from_day, to_day, reason_code, status, days)
     VALUES (1, '2026-06-02', '2026-06-02', ?, 'approved', 1)`,
  ).run(code.code);
  const ds = await loadDataset(db, { from: '2026-05-25', to: '2026-06-21' });

  const worked = shiftsInWindow(ds, staff.id, '2026-06-01', '2026-06-02');
  const onDuty = worked.filter((w) => !w.leave && w.shift && w.day >= '2026-06-01');
  assert.equal(onDuty.length, 1, 'the leave day is not a shift');
  const runs = consecutiveRuns(worked.filter((w) => w.day >= '2026-06-01'), '2026-06-01', '2026-06-02');
  assert.equal(runs.longest, 1, 'and it breaks the run');
});

// ---------------------------------------------------------------------------
// The whole reading
// ---------------------------------------------------------------------------

test('a punishing fortnight is named, rule by rule, with the section', async () => {
  const rota = { ...week('2026-06-01', Array(7).fill('long')), ...week('2026-06-08', Array(7).fill('long')) };
  const { ds, staff } = await world(rota);
  const person = assessPerson(ds, staff, '2026-06-01', '2026-06-14');

  const keys = person.findings.map((f) => f.key);
  assert.ok(keys.includes('weekly-rest'), 'fourteen twelve-hour days is never 48 hours off');
  assert.ok(keys.includes('weekly-hours'), 'and well past forty hours a week');
  assert.ok(keys.includes('consecutive'), 'and fourteen days in a row');
  assert.ok(keys.includes('long-days'), 'each of them twelve hours long');

  // The law is cited, so the warning can be acted on rather than argued with.
  const law = person.findings.filter((f) => f.law).map((f) => f.law);
  assert.ok(law.some((l) => l.includes('s.33')), 'hours');
  assert.ok(law.some((l) => l.includes('s.36')), 'weekly rest');

  assert.equal(person.figures.longestRun, 14);
  assert.equal(strainScore(person, limitsFrom({})), 100, 'as bad as the scale goes');
});

test('an ordinary five-day week raises nothing at all', async () => {
  const rota = {
    ...week('2026-06-01', ['morning', 'morning', 'morning', 'morning', 'morning', null, null]),
    ...week('2026-06-08', ['morning', 'morning', 'morning', 'morning', 'morning', null, null]),
  };
  const { ds, staff } = await world(rota);
  const person = assessPerson(ds, staff, '2026-06-01', '2026-06-14');

  assert.deepEqual(person.findings, [], 'nothing to say about a normal fortnight');
  assert.equal(person.figures.daysOn, 10);
  assert.equal(strainScore(person, limitsFrom({})), 0);
});

test('the property can tighten a limit, and the law is the default', () => {
  const strict = limitsFrom({ wl_consecutiveDays: '4' });
  assert.equal(strict.consecutiveDays.value, 4);
  assert.equal(strict.consecutiveDays.changed, true);

  const plain = limitsFrom({});
  assert.equal(plain.dailyRestHours.value, LIMITS.dailyRestHours.value);
  assert.equal(plain.dailyRestHours.law, 'Act 651 s.35');
  assert.equal(plain.dailyRestHours.changed, false);

  // Nonsense is ignored rather than obeyed.
  assert.equal(limitsFrom({ wl_weeklyHours: 'soon' }).weeklyHours.value, 40);
  assert.equal(limitsFrom({ wl_weeklyHours: '-3' }).weeklyHours.value, 40);
});

test('somebody nobody rostered is found, and so is an unfair share', async () => {
  const { ds, staff } = await world({});
  const person = assessPerson(ds, staff, '2026-06-01', '2026-06-14');

  const peers = [
    { staff: { id: 2, department: 'Kitchen' }, figures: { weekends: 4, nights: 4 } },
    { staff: { id: 3, department: 'Kitchen' }, figures: { weekends: 4, nights: 4 } },
  ];
  const resting = restFindings(person, [person, ...peers], limitsFrom({}), null);
  const keys = resting.map((r) => r.key);

  assert.ok(keys.includes('off-the-rota'));
  assert.ok(keys.includes('under-scheduled'));
  assert.ok(keys.includes('few-weekends'), 'the others are covering the Saturdays');
  assert.ok(keys.includes('few-nights'));
});

test('untaken leave is only worth saying once the year is well on', async () => {
  const { ds, staff } = await world({});
  const person = assessPerson(ds, staff, '2026-06-01', '2026-06-14');
  const full = { available: 15, remaining: 15, entitlement: 15 };

  const january = restFindings(person, [person], limitsFrom({}), { ...full, yearElapsed: 0.1 });
  assert.ok(!january.some((f) => f.key === 'leave-unused'),
    'everybody holds their whole entitlement in January');

  const october = restFindings(person, [person], limitsFrom({}), { ...full, yearElapsed: 0.8 });
  assert.ok(october.some((f) => f.key === 'leave-unused'),
    'the same fact in October is somebody nobody can spare');

  const hadTheirHoliday = restFindings(person, [person], limitsFrom({}),
    { available: 15, remaining: 2, entitlement: 15, yearElapsed: 0.8 });
  assert.ok(!hadTheirHoliday.some((f) => f.key === 'leave-unused'));
});
