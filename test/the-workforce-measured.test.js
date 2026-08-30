import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { analyseCost, analyseRisk, analyseShape, analyseTime, against, previousWindow, share } from '../src/lib/analytics.js';
import { analytics } from '../src/routes/workload.js';
import { setProfiles } from '../src/routes/payroll.js';

/**
 * The workforce, measured four ways.
 *
 * Everything here is a rate rather than a total wherever a rate is possible: a
 * wage bill that went up tells nobody anything, because it goes up when trade
 * goes up. And a denominator of nought is a null rather than a hundred per
 * cent, because a screen full of confident zeroes is worse than one that
 * admits it does not know.
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
  raw.exec('DELETE FROM att_staff; DELETE FROM users; DELETE FROM att_shifts; DELETE FROM att_roster;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec("UPDATE settings SET value = 'GHS' WHERE key = 'currency'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, active, sort_order)
     VALUES (1, 'Day', '08:00', '16:00', 0, 1, 1)`,
  ).run();
  for (const [id, name, dept] of [
    [1, 'Ama Boateng', 'Kitchen'],
    [2, 'Kofi Mensah', 'Kitchen'],
    [3, 'Esi Owusu', 'Reception'],
  ]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
       VALUES (?, ?, ?, ?, '2020-01-01')`,
    ).run(id, String(id), name, dept);
  }
  return { raw, db: d1(raw) };
}

const PLANNER = {
  user: { id: 9, name: 'Yaa', role: 'manager' },
  permissions: ['att_view', 'att_rota'],
};
const BOSS = {
  user: { id: 8, name: 'Kwame', role: 'admin' },
  permissions: ['att_view', 'att_rota', 'att_reports', 'hr_pay'],
};
const ctx = (db, session, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/workload/analytics${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});
const read = async (response) => response.json();
const WINDOW = '?from=2026-08-03&to=2026-08-16';

/** Everybody down for the same fortnight of days. */
function roster(raw, staffIds, days) {
  for (const staffId of staffIds) {
    for (const day of days) {
      raw.prepare(
        'INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (?, ?, 1, 1)',
      ).run(staffId, day);
    }
  }
}

const weekdays = (from, count) => {
  const out = [];
  const at = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    out.push(at.toISOString().slice(0, 10));
    at.setUTCDate(at.getUTCDate() + 1);
  }
  return out;
};

// ---------------------------------------------------------------------------
// The two rules that run through all of it
// ---------------------------------------------------------------------------

test('a share of nothing is nothing known, not nought per cent', () => {
  assert.equal(share(3, 12), 25);
  assert.equal(share(0, 12), 0);
  assert.equal(share(3, 0), null, 'no denominator means no answer');
  assert.equal(share(0, 0), null);
});

test('a figure with nothing to be read against says so', () => {
  assert.deepEqual(against(120, 100), { was: 100, now: 120, change: 20, percent: 20 });
  assert.equal(against(120, null), null);
  assert.equal(against(120, 0).percent, null, 'a rise from nothing is not a per cent');
});

test('the window before this one is the same length, ending the day before', () => {
  assert.deepEqual(previousWindow('2026-08-03', '2026-08-16'),
    { from: '2026-07-20', to: '2026-08-02' });
  assert.deepEqual(previousWindow('2026-08-03', '2026-08-03'),
    { from: '2026-08-02', to: '2026-08-02' });
});

// ---------------------------------------------------------------------------
// What it costs
// ---------------------------------------------------------------------------

const costRow = (id, name, department, over) => ({
  staff: { id, name, department },
  days: 10,
  hours: 80,
  overtimeHours: 0,
  holidayHours: 0,
  cost: { fixed: 1000, variable: 0, premium: 0, total: 1000, perDay: 100, perHour: 12.5 },
  ...over,
});

test('the bill is reported as rates, because a total on its own says nothing', () => {
  const out = analyseCost({
    rows: [costRow(1, 'A', 'Kitchen'), costRow(2, 'B', 'Kitchen'), costRow(3, 'C', 'Reception')],
  });
  assert.equal(out.totals.total, 3000);
  assert.equal(out.totals.hours, 240);
  assert.equal(out.perHour, 12.5);
  assert.equal(out.perDay, 100);
  assert.equal(out.perPerson, 1000);
});

test('the premium share is the part a rota could actually change', () => {
  const out = analyseCost({
    rows: [
      costRow(1, 'A', 'Kitchen', {
        overtimeHours: 10,
        cost: { fixed: 900, variable: 0, premium: 100, total: 1000, perDay: 100, perHour: 12.5 },
      }),
      costRow(2, 'B', 'Kitchen'),
    ],
  });
  assert.equal(out.totals.premium, 100);
  assert.equal(out.premiumShare, 5, '100 of 2,000');
  assert.equal(out.overtimeShare, share(10, 160));
});

test('a department reads as its own rates, not as a slice of the total', () => {
  const out = analyseCost({
    rows: [costRow(1, 'A', 'Kitchen'), costRow(2, 'B', 'Kitchen'), costRow(3, 'C', 'Reception')],
  });
  const kitchen = out.byDepartment.find((d) => d.department === 'Kitchen');
  assert.equal(kitchen.people, 2);
  assert.equal(kitchen.total, 2000);
  assert.equal(kitchen.perHour, 12.5);
  assert.equal(kitchen.shareOfBill, 66.7);
});

test('who the money goes to, with a running share beside them', () => {
  const out = analyseCost({
    rows: [
      costRow(1, 'Big', 'Kitchen', { cost: { fixed: 5000, variable: 0, premium: 0, total: 5000, perDay: 500, perHour: 62.5 } }),
      costRow(2, 'Middle', 'Kitchen', { cost: { fixed: 3000, variable: 0, premium: 0, total: 3000, perDay: 300, perHour: 37.5 } }),
      costRow(3, 'Small', 'Reception', { cost: { fixed: 2000, variable: 0, premium: 0, total: 2000, perDay: 200, perHour: 25 } }),
    ],
  });
  assert.deepEqual(out.drivers.map((d) => d.staff.name), ['Big', 'Middle', 'Small']);
  assert.equal(out.drivers[0].shareOfBill, 50);
  assert.equal(out.drivers[1].runningShare, 80, 'the first two are eight tenths of it');
  assert.equal(out.concentration.people, 1, 'one person carries the first half');
  assert.equal(out.concentration.of, 3);
});

test('this window beside the one before it, rate for rate', () => {
  const before = analyseCost({ rows: [costRow(1, 'A', 'Kitchen')] });
  const out = analyseCost({
    rows: [
      costRow(1, 'A', 'Kitchen', {
        hours: 100,
        cost: { fixed: 1000, variable: 0, premium: 0, total: 1000, perDay: 100, perHour: 10 },
      }),
    ],
    previous: { ...before, people: 1 },
  });
  assert.equal(out.versus.total.percent, 0, 'the same money');
  assert.equal(out.versus.perHour.was, 12.5);
  assert.ok(out.versus.perHour.percent < 0, 'spread over more hours, so cheaper an hour');
});

// ---------------------------------------------------------------------------
// Where the time goes
// ---------------------------------------------------------------------------

const person = (id, name, department, figures) => ({
  staff: { id, name, department },
  figures: { expected: 10, daysOn: 10, hours: 80, leaveDays: 0, ...figures },
});

const dayRow = (over) => ({
  shift_id: 1, scheduled: true, status: 'present', late_minutes: 0, worked_minutes: 480, ...over,
});

test('what the rota asked is told apart from whether they turned up', () => {
  const out = analyseTime({
    people: [person(1, 'A', 'Kitchen', { daysOn: 8, expected: 10, hours: 64 })],
    daysBy: new Map([[1, [
      ...[...Array(6)].map(() => dayRow({})),
      dayRow({ status: 'absent', worked_minutes: 0 }),
      dayRow({ status: 'late', late_minutes: 25, worked_minutes: 455 }),
    ]]]),
  });
  // Two different gaps, and mixing them sends a manager to the wrong person.
  assert.equal(out.scheduledAgainstAgreed, 80, 'the rota asked for 8 of the 10 agreed');
  assert.equal(out.absenceRate, 12.5, 'and one of the 8 it did ask for was missed');
  assert.equal(out.latenessRate, 12.5);
  assert.equal(out.totals.lateMinutes, 25);
  assert.equal(out.daysLost, 1);
});

test('a day nobody rostered is not an absence', () => {
  const out = analyseTime({
    people: [person(1, 'A', 'Kitchen')],
    daysBy: new Map([[1, [
      dayRow({}),
      dayRow({ shift_id: null, status: 'absent', worked_minutes: 0 }),
    ]]]),
  });
  assert.equal(out.totals.dueDays, 1, 'only the day they were down for');
  assert.equal(out.absenceRate, 0);
});

test('nobody scheduled at all is not perfect attendance', () => {
  const out = analyseTime({
    people: [person(1, 'A', 'Kitchen', { daysOn: 0, expected: 0, hours: 0 })],
    daysBy: new Map([[1, []]]),
  });
  assert.equal(out.absenceRate, null);
  assert.equal(out.latenessRate, null);
  assert.equal(out.turnout, null);
});

test('turnout is the hours the clock saw against the hours asked for', () => {
  const out = analyseTime({
    people: [person(1, 'A', 'Kitchen', { hours: 80 })],
    daysBy: new Map([[1, [...Array(10)].map(() => dayRow({ worked_minutes: 432 }))]]),
  });
  assert.equal(out.totals.workedHours, 72);
  assert.equal(out.turnout, 90);
  assert.equal(out.hoursLost, 8);
});

// ---------------------------------------------------------------------------
// Who is at risk
// ---------------------------------------------------------------------------

test('the worst off are ranked, and say what put them there', () => {
  const out = analyseRisk({
    rows: [
      { staff: { id: 1, name: 'A' }, score: 80, figures: { daysOn: 13, hours: 104, longestRun: 9, nights: 4 }, findings: [{ level: 'high', kind: 'consecutive', title: '9 days in a row without one off' }] },
      { staff: { id: 2, name: 'B' }, score: 20, figures: { daysOn: 8 }, findings: [] },
      { staff: { id: 3, name: 'C' }, score: 0, figures: { daysOn: 6 }, findings: [] },
    ],
  });
  assert.deepEqual(out.ranked.map((r) => r.staff.name), ['A', 'B'], 'a score of nought is not a risk');
  assert.deepEqual(out.ranked[0].why, ['9 days in a row without one off']);
  assert.equal(out.strained, 1);
  assert.equal(out.watch, 0);
  assert.equal(out.settled, 2);
});

test('a rule broken by four people is one habit, counted once', () => {
  const found = { level: 'high', kind: 'turnaround', title: '2 turnarounds under 11 hours' };
  const out = analyseRisk({
    rows: [1, 2, 3, 4].map((id) => ({
      staff: { id, name: `P${id}` }, score: 50, figures: {}, findings: [found],
    })),
  });
  assert.equal(out.breaches.length, 1);
  assert.equal(out.breaches[0].people, 4);
});

test('untaken leave is priced at each person own rate', () => {
  const out = analyseRisk({
    rows: [
      { staff: { id: 1, name: 'Manager' }, score: 10, figures: {}, findings: [], leave: { remaining: 10 } },
      { staff: { id: 2, name: 'Porter' }, score: 10, figures: {}, findings: [], leave: { remaining: 10 } },
    ],
    dayRateBy: new Map([[1, 200], [2, 50]]),
  });
  assert.equal(out.leave.days, 20);
  assert.equal(out.leave.liability, 2500, 'not twenty days at an average of 125');
  assert.equal(out.leave.priced, 2);
});

test('leave nobody can price is not a liability of nought', () => {
  const out = analyseRisk({
    rows: [{ staff: { id: 1, name: 'A' }, score: 10, figures: {}, findings: [], leave: { remaining: 12 } }],
  });
  assert.equal(out.leave.days, 12);
  assert.equal(out.leave.liability, null, 'a nought would read as owing nobody anything');
  assert.equal(out.leave.unpriced, 1);
});

// ---------------------------------------------------------------------------
// What shape the cover is
// ---------------------------------------------------------------------------

const shift = (day, start, end) => ({
  day, shift: { id: 1 }, start, end, hours: (end - start) / 60, leave: false,
});

test('cover by hour is the curve a grid of shifts never shows', () => {
  const out = analyseShape({
    from: '2026-08-03',
    to: '2026-08-03',
    worked: new Map([
      [1, [shift('2026-08-03', 8 * 60, 16 * 60)]],
      [2, [shift('2026-08-03', 8 * 60, 16 * 60)]],
      [3, [shift('2026-08-03', 14 * 60, 22 * 60)]],
    ]),
  });
  const at = (hour) => out.byHour.find((h) => h.hour === hour).people;
  assert.equal(at(9), 2, 'two on in the morning');
  assert.equal(at(15), 3, 'three of them overlap mid-afternoon');
  assert.equal(at(21), 1, 'one left at nine at night');
  assert.equal(at(3), 0, 'and nobody at three in the morning');
  assert.equal(out.busiest.people, 3);
  assert.equal(out.spread, 2, 'three at the peak against one at the thinnest staffed hour');
});

test('a night shift lands on the hours it actually covers', () => {
  const out = analyseShape({
    from: '2026-08-03',
    to: '2026-08-03',
    // Ten at night until six, which runs past midnight.
    worked: new Map([[1, [shift('2026-08-03', 22 * 60, 30 * 60)]]]),
  });
  const at = (hour) => out.byHour.find((h) => h.hour === hour).people;
  assert.equal(at(23), 1);
  assert.equal(at(2), 1, 'two in the morning is covered, not off the end of the clock');
  assert.equal(at(12), 0);
});

test('a weekday is read per date, so three Mondays do not read as a busy Monday', () => {
  const out = analyseShape({
    from: '2026-08-03',
    to: '2026-08-16',
    worked: new Map([[1, [
      shift('2026-08-03', 8 * 60, 16 * 60),
      shift('2026-08-10', 8 * 60, 16 * 60),
    ]]]),
  });
  const monday = out.byWeekday.find((d) => d.day === 'Monday');
  assert.equal(monday.dates, 2, 'two Mondays in the fortnight');
  assert.equal(monday.people, 1, 'one person on each of them');
});

// ---------------------------------------------------------------------------
// All of it, over a real window
// ---------------------------------------------------------------------------

test('a planner gets the rota half and no money at all', async () => {
  const { raw, db } = setup();
  roster(raw, [1, 2, 3], weekdays('2026-08-03', 10));
  const data = await read(await analytics(ctx(db, PLANNER, { query: WINDOW })));

  assert.equal(data.seesPay, false);
  assert.equal(data.cost, null, 'not blanked on the screen, simply not sent');
  assert.ok(data.time.totals.people > 0);
  assert.ok(data.shape.byHour.length === 24);
  assert.equal(data.risk.leave.liability, null);
});

test('somebody who may see pay gets the cost, priced from the payroll', async () => {
  const { raw, db } = setup();
  roster(raw, [1, 2, 3], weekdays('2026-08-03', 10));
  await setProfiles(ctx(db, BOSS, {
    body: {
      rows: [1, 2, 3].map((staffId) => ({ staffId, basic: 1500, ssnit: true, allowances: [] })),
    },
  }));

  const data = await read(await analytics(ctx(db, BOSS, { query: WINDOW })));
  assert.equal(data.seesPay, true);
  assert.equal(data.cost.people, 3);
  assert.ok(data.cost.totals.total > 0);
  assert.ok(data.cost.perHour > 0);
  assert.equal(data.cost.byDepartment.length, 2, 'Kitchen and Reception');
  assert.ok(data.cost.versus, 'and it is read against the fortnight before');
  assert.equal(data.cost.versus.from, '2026-07-20');
});

test('one department at a time, and every part of it follows', async () => {
  const { raw, db } = setup();
  roster(raw, [1, 2, 3], weekdays('2026-08-03', 10));
  await setProfiles(ctx(db, BOSS, {
    body: {
      rows: [1, 2, 3].map((staffId) => ({ staffId, basic: 1500, ssnit: true, allowances: [] })),
    },
  }));

  const data = await read(await analytics(ctx(db, BOSS, {
    query: `${WINDOW}&department=Reception`,
  })));
  assert.equal(data.department, 'Reception');
  assert.equal(data.cost.people, 1);
  assert.deepEqual(data.cost.byDepartment.map((d) => d.department), ['Reception']);
  assert.equal(data.time.totals.people, 1);
});

test('an empty property answers with nulls rather than confident noughts', async () => {
  const { db } = setup();
  const data = await read(await analytics(ctx(db, BOSS, { query: WINDOW })));
  assert.equal(data.time.absenceRate, null);
  assert.equal(data.time.turnout, null);
  assert.equal(data.cost.perHour, null);
  assert.equal(data.cost.concentration, null);
  assert.equal(data.shape.busiest, null);
});
