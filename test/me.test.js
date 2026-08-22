import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  askForLeave, myReport, myWeek, setMyAvailability, tellThemImLate, withdrawMyLeave,
} from '../src/routes/me.js';
import { publishRoster, saveRoster } from '../src/routes/attendance.js';
import { effectivePermissions } from '../src/lib/permissions.js';

/**
 * A member of staff looking at their own.
 *
 * Three promises, and they are the whole reason the screen is safe to give
 * somebody: who you are comes off the session and never off the request, only
 * published shifts are shown, and no overtime figure is anywhere near it.
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

const MON = '2026-06-01';
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
            DELETE FROM att_leave; DELETE FROM att_availability; DELETE FROM app_notices;
            DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes)
     VALUES (1, 'Early', '06:00', '14:00', 0)`,
  ).run();
  for (const [id, name] of [[1, 'Kofi'], [2, 'Ama']]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
       VALUES (?, ?, ?, 'Kitchen', '2020-01-01')`,
    ).run(id, String(id), name);
  }
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (7, 'Kofi', 'staff', 'x', 1, 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const KOFI = { user: { id: 7, name: 'Kofi', role: 'staff', staff_id: 1 } };
const PLANNER = { user: { id: 3, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };

const ctx = (db, session, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/me/week${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const week = async (db) => (await myWeek(ctx(db, KOFI, { query: `?from=${MON}` }))).json();

test('the staff role holds one thing, and it is not the attendance screen', () => {
  const list = effectivePermissions({ role: 'staff', permissions: null });
  assert.deepEqual(list, ['att_me']);
  assert.ok(!list.includes('att_view'), 'my shifts must not drag in everybody else’s');
});

test('an unpublished shift is not shown, and a published one is', async () => {
  const { db } = setup();
  await saveRoster(ctx(db, PLANNER, {
    body: { entries: [{ staffId: 1, day: shiftDay(MON, 1), shiftId: 1 }] },
  }));

  let out = await week(db);
  let day = out.days.find((d) => d.day === shiftDay(MON, 1));
  assert.equal(day.shift, null, 'a draft is a planner thinking out loud');
  assert.equal(day.pending, true, 'and it says so rather than looking like a day off');

  await publishRoster(ctx(db, PLANNER, { body: { from: MON, to: shiftDay(MON, 6) } }));

  out = await week(db);
  day = out.days.find((d) => d.day === shiftDay(MON, 1));
  assert.equal(day.shift.name, 'Early');
  assert.equal(day.pending, false);
});

test('a standing pattern shows without ever being published', async () => {
  const { db, raw } = setup();
  raw.prepare('INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 0, 1)').run();

  const out = await week(db);
  assert.equal(out.days.find((d) => d.day === MON).shift.name, 'Early',
    'the arrangement they agreed to has never needed publishing');
});

test('it shows one person and never takes a staff id', async () => {
  const { db, raw } = setup();
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (2, ?, 1, 1)')
    .run(MON);
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
    .run(shiftDay(MON, 1));

  // The query string carries somebody else's id, and it changes nothing.
  const out = await (await myWeek(ctx(db, KOFI, { query: `?from=${MON}&staffId=2` }))).json();
  assert.equal(out.me.id, 1);
  assert.equal(out.days.find((d) => d.day === MON).shift, null, "Ama's Monday is not Kofi's");
  assert.equal(out.days.find((d) => d.day === shiftDay(MON, 1)).shift.name, 'Early');
});

test('a login pointed at nobody is refused rather than answered', async () => {
  const { db } = setup();
  await assert.rejects(
    () => myWeek(ctx(db, { user: { id: 9, name: 'Nobody', role: 'staff' } }, { query: '' })),
    /not linked to a staff record/,
  );
});

test('asking for leave always lands as pending, and rings the right bell', async () => {
  const { db, raw } = setup();
  for (const d of [0, 1, 2]) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
      .run(shiftDay(MON, d));
  }

  const out = await (await askForLeave(ctx(db, KOFI, {
    body: {
      reason: 'annual_leave', from: MON, to: shiftDay(MON, 2), note: 'My sister is marrying',
    },
  }))).json();
  assert.equal(out.status, 'pending');
  assert.equal(out.days, 3);

  const row = raw.prepare('SELECT * FROM att_leave WHERE id = ?').get(out.id);
  assert.equal(row.status, 'pending', 'nobody approves their own');
  assert.equal(row.requested_by_id, 7);

  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.leave_asked'").get();
  assert.equal(notice.audience, 'att_manage');
  assert.match(notice.title, /Kofi/);
});

test('a request can be taken back while it waits, and not after', async () => {
  const { db, raw } = setup();
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
    .run(MON);
  const out = await (await askForLeave(ctx(db, KOFI, {
    body: { reason: 'annual_leave', from: MON, to: MON },
  }))).json();

  await withdrawMyLeave(ctx(db, KOFI), out.id);
  assert.equal(raw.prepare('SELECT status FROM att_leave WHERE id = ?').get(out.id).status,
    'withdrawn');

  await assert.rejects(() => withdrawMyLeave(ctx(db, KOFI), out.id), /already been decided/);
});

test('somebody else’s request is not theirs to take back', async () => {
  const { db, raw } = setup();
  raw.prepare(
    `INSERT INTO att_leave (id, staff_id, reason_code, from_day, to_day, days, status)
     VALUES (55, 2, 'annual_leave', ?, ?, 1, 'pending')`,
  ).run(MON, MON);

  await assert.rejects(() => withdrawMyLeave(ctx(db, KOFI), 55), /No such request of yours/);
  assert.equal(raw.prepare('SELECT status FROM att_leave WHERE id = 55').get().status, 'pending');
});

test('they can mark their own days, ahead of time only', async () => {
  const { db, raw } = setup();
  const soon = shiftDay(new Date().toISOString().slice(0, 10), 3);

  await setMyAvailability(ctx(db, KOFI, {
    body: { days: [soon], status: 'unavailable', fromTime: '07:00', toTime: '09:00' },
  }));

  const row = raw.prepare('SELECT * FROM att_availability WHERE staff_id = 1').get();
  assert.equal(row.day, soon);
  assert.equal(row.from_time, '07:00');
  assert.match(row.set_by, /Kofi/);

  await assert.rejects(
    () => setMyAvailability(ctx(db, KOFI, { body: { days: ['2020-01-01'] } })),
    /already happened/,
  );
});

test('running late is a message, and touches no record', async () => {
  const { db, raw } = setup();
  await tellThemImLate(ctx(db, KOFI, { body: { minutes: 30, note: 'The Spintex road' } }));

  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.running_late'").get();
  assert.match(notice.title, /Kofi is running about 30 minutes late/);
  assert.equal(notice.audience, 'att_view');
  assert.equal(raw.prepare('SELECT count(*) AS n FROM att_days').get().n, 0);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM att_punches').get().n, 0);
});

test('no overtime figure reaches the screen', async () => {
  const { db, raw } = setup();
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
    .run(MON);

  const out = await week(db);
  const text = JSON.stringify(out);
  assert.ok(!/overtime/i.test(text), 'what somebody is owed is settled at sign-off');
});

test('my report counts the late arrivals and what they cost in minutes', async () => {
  const { db, raw } = setup();
  // Three rostered days: one on time, one forty minutes late, one nobody
  // turned up to.
  for (const [d, punches] of [
    ['2026-06-01', [['06:00', 'in'], ['14:00', 'out']]],
    ['2026-06-02', [['06:40', 'in'], ['14:00', 'out']]],
    ['2026-06-03', []],
  ]) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
      .run(d);
    for (const [at, dir] of punches) {
      raw.prepare(
        `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day,
                                  direction, dedupe_key)
         VALUES ('D1', '1', 1, ?, ?, ?, ?, ?)`,
      ).run(`${d} ${at}:00`, `${d} ${at}:00`, d, dir, `${d}-${at}-${dir}`);
    }
  }

  const url = new URL('https://x/api/me/report?month=2026-06');
  const out = await (await myReport({ ...ctx(db, KOFI), url })).json();

  assert.equal(out.totals.scheduled, 3);
  assert.equal(out.totals.lateCount, 1);
  assert.equal(out.totals.lateMinutes, 40);
  assert.equal(out.totals.daysAbsent, 1);
  assert.equal(out.days.length, 3, 'every day with something on it');
});

test('my report reads the month asked for, and only mine', async () => {
  const { db, raw } = setup();
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
    .run('2026-06-01');
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (2, ?, 1, 1)')
    .run('2026-06-01');
  for (const [at, dir] of [['06:00', 'in'], ['14:00', 'out']]) {
    raw.prepare(
      `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day,
                                direction, dedupe_key)
       VALUES ('D1', '1', 1, ?, ?, '2026-06-01', ?, ?)`,
    ).run(`2026-06-01 ${at}:00`, `2026-06-01 ${at}:00`, dir, `a-${at}`);
  }

  const withMonth = {
    ...ctx(db, KOFI),
    url: new URL('https://x/api/me/report?month=2026-06'),
  };
  const out = await (await myReport(withMonth)).json();

  assert.equal(out.month, '2026-06');
  assert.equal(out.me.id, 1);
  assert.equal(out.totals.scheduled, 1);
  assert.equal(out.totals.workedMinutes, 480);
  assert.equal(out.days.length, 1);
  assert.equal(out.days[0].day, '2026-06-01');
  assert.ok(!/overtime/i.test(JSON.stringify(out)), 'settled at sign-off, not read off a screen');
});

test('a month says whether it can still change, and never who closed it', async () => {
  const { db, raw } = setup();
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
    .run('2026-06-01');

  const url = new URL('https://x/api/me/report?month=2026-06');
  let out = await (await myReport({ ...ctx(db, KOFI), url })).json();
  assert.equal(out.settled, false);

  raw.prepare(
    `INSERT INTO att_period_review
       (staff_id, kind, from_day, to_day, scheduled_days, worked_days, difference,
        decision, days_applied, decided_by)
     VALUES (1, 'month', '2026-06-01', '2026-06-30', 1, 1, 0, 'approved', -1, 'Ama (manager)')`,
  ).run();

  out = await (await myReport({ ...ctx(db, KOFI), url })).json();
  assert.equal(out.settled, true);
  // Whether, and not by whom: a manager's name against somebody's attendance
  // record turns a report into something else.
  assert.ok(!/Ama/.test(JSON.stringify(out)), 'nobody is named');
});

test('public holidays count unless the property says otherwise', async () => {
  const { db, raw } = setup();
  raw.prepare("INSERT INTO att_holidays (day, name, active) VALUES ('2026-06-02', 'Republic Day', 1)")
    .run();
  for (const d of ['2026-06-01', '2026-06-02']) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
      .run(d);
  }

  const url = new URL('https://x/api/me/report?month=2026-06');
  let out = await (await myReport({ ...ctx(db, KOFI), url })).json();
  assert.equal(out.withHolidays, true);
  assert.equal(out.totals.daysHoliday, 1);
  assert.ok(out.days.some((d) => d.day === '2026-06-02'));

  raw.prepare(
    "INSERT INTO settings (key, value) VALUES ('att_report_holidays','0') "
    + "ON CONFLICT(key) DO UPDATE SET value = '0'",
  ).run();

  out = await (await myReport({ ...ctx(db, KOFI), url })).json();
  assert.equal(out.withHolidays, false);
  assert.equal(out.totals.daysHoliday, 0, 'gone from the totals');
  assert.ok(!out.days.some((d) => d.day === '2026-06-02'),
    'and from the day-by-day, so the two halves cannot disagree');
});

test('a month that has not started yet says so rather than counting absences', async () => {
  const { db } = setup();
  const url = new URL('https://x/api/me/report?month=2099-01');
  const out = await (await myReport({ ...ctx(db, KOFI), url })).json();
  assert.equal(out.future, true);
  assert.equal(out.totals, null);
});
