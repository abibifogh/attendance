import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  correctTimes, resolveDay, staffReport, timeEdits, unresolveDay,
} from '../src/routes/attendance.js';
import { computeDay } from '../src/lib/attendance.js';

/**
 * Correcting a clock time, as whoever builds the rota actually does it.
 *
 * Three claims are made for this feature and all three are worth a test,
 * because all three are the kind of thing that quietly stops being true.
 *
 * The punches are never touched. What the terminal saw stays what the terminal
 * saw, for ever, and every report can still show it.
 *
 * The rules still decide the day. Correcting a clock-out is a statement about
 * the clock, not a verdict — so the hours, the lateness and the overtime are
 * all worked out again from the corrected times rather than frozen at whatever
 * the day was called when somebody typed them in. This is the one most at risk:
 * the existing settle-a-day path *does* freeze the verdict, and the two paths
 * share the same two columns.
 *
 * And nothing happens quietly. Every change lands in the register with what
 * stood before it, and the administrators are told.
 */

function d1(db) {
  const statement = (sql, binds = []) => ({
    sql,
    binds,
    bind(...args) { return statement(sql, args); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const result = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(result.changes ?? 0) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
}

/** Builds the rota. Can move a clock time, cannot settle a day. */
const PLANNER = {
  user: { id: 2, name: 'Yaa', role: 'planner' },
  permissions: ['att_view', 'att_rota', 'att_times'],
};

/** Settles days and approves leave. */
const MANAGER = {
  user: { id: 1, name: 'Ama', role: 'manager' },
  permissions: ['att_view', 'att_reports', 'att_manage', 'att_times'],
};

function ctx(db, { body = null, query = '', session = PLANNER } = {}) {
  const url = new URL(`https://staff.example.test/api/att/x${query}`);
  return {
    db,
    env: {},
    url,
    session,
    executionContext: null,
    request: new Request(url, body
      ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '41.66.0.9' },
        body: JSON.stringify(body),
      }
      : { method: 'GET' }),
  };
}

const read = async (response) => response.json();

/**
 * One cook, one morning shift, one week in the past.
 *
 * Monday is clean. Tuesday he forgot to clock out. Wednesday the terminal read
 * him out at 17:02 when the kitchen ran until nine.
 */
async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }

  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec('DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;');
  raw.exec('DELETE FROM att_shifts');
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes,
                             grace_out_minutes, overtime_after)
     VALUES (1, 'Morning', '09:00', '17:00', 0, 5, 5, 0)`,
  ).run();
  raw.exec('DELETE FROM att_staff');
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1001', 'Henry Aryee', 'Kitchen', '2020-01-01')`,
  ).run();

  for (const day of ['2026-06-01', '2026-06-02', '2026-06-03']) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, 1)').run(day);
  }

  const punch = (day, at) => raw.prepare(
    `INSERT INTO att_punches (staff_id, employee_no, device_serial, at_utc, at_local, day, source, dedupe_key)
     VALUES (1, '1001', 'TEST', ?1, ?1, ?2, 'test', ?1)`,
  ).run(at, day);

  punch('2026-06-01', '2026-06-01 09:00:00'); punch('2026-06-01', '2026-06-01 17:00:00');
  punch('2026-06-02', '2026-06-02 09:00:00');
  punch('2026-06-03', '2026-06-03 09:00:00'); punch('2026-06-03', '2026-06-03 17:02:00');

  return { raw, db: d1(raw) };
}

const dayOf = (raw, day) => raw.prepare('SELECT * FROM att_days WHERE staff_id = 1 AND day = ?').get(day);

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test('a corrected time is measured, but does not decide the day on its own', () => {
  // The distinction the whole feature rests on, at the level it is decided.
  // With a reason attached the verdict is the human's; without one it is the
  // rules', worked out from the times they were given.
  const staff = { id: 1 };
  const shift = {
    id: 1, starts_at: '09:00', ends_at: '17:00', break_minutes: 0,
    grace_in_minutes: 5, grace_out_minutes: 5, overtime_after: 0,
  };
  const punches = [{ abs: null }];

  const ruled = computeDay({
    staff,
    day: '2026-06-03',
    schedule: { shift },
    punches: [],
    override: { reason_code: 'present', status: 'present', corrected_in: '09:00', corrected_out: '21:00' },
  });
  assert.equal(ruled.status, 'present', 'a ruling stands whatever the times say');

  const corrected = computeDay({
    staff,
    day: '2026-06-03',
    schedule: { shift },
    punches: [],
    override: { reason_code: null, corrected_in: '10:30', corrected_out: '21:00' },
  });
  assert.equal(corrected.status, 'late', 'the rules read the corrected clock-in and call it late');
  assert.equal(corrected.late_minutes, 90);
  assert.equal(corrected.overtime_minutes, 240);
  assert.equal(corrected.worked_minutes, 630);
  assert.ok(punches.length, 'fixture guard');
});

test('a corrected clock-out on a night shift lands on the far side of midnight', () => {
  const corrected = computeDay({
    staff: { id: 1 },
    day: '2026-06-03',
    schedule: {
      shift: {
        id: 9, starts_at: '22:00', ends_at: '06:00', break_minutes: 0,
        grace_in_minutes: 5, grace_out_minutes: 5,
      },
    },
    punches: [],
    override: { reason_code: null, corrected_in: '22:00', corrected_out: '06:30' },
  });
  assert.equal(corrected.worked_minutes, 510, 'eight and a half hours, not a negative day');
  assert.equal(corrected.status, 'present');
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test('the planner puts a wrong clock-out right and the hours follow', async () => {
  const { raw, db } = await setup();

  const before = dayOf(raw, '2026-06-03');
  assert.equal(before, undefined, 'nothing computed yet');

  const out = await read(await correctTimes(
    ctx(db, { body: { staffId: 1, in: null, out: '21:00', reason: 'The kitchen ran until nine' } }),
    '2026-06-03',
  ));

  assert.equal(out.ok, true);
  assert.equal(out.day.last_out, '21:00');
  assert.equal(out.day.worked_minutes, 720, 'nine until nine');
  assert.equal(out.day.overtime_minutes, 240);
  assert.equal(out.day.status, 'present', 'the rules decided that, not the planner');

  const row = dayOf(raw, '2026-06-03');
  assert.equal(row.corrected_out, '21:00');
  assert.equal(row.corrected_in, null, 'the side nobody touched is left alone');
  assert.notEqual(row.resolution, 'resolved',
    'a corrected time is not a ruling — the day is still the rules\' to decide');
});

test('the punches are never altered', async () => {
  const { raw, db } = await setup();
  const punchesBefore = raw.prepare('SELECT * FROM att_punches ORDER BY id').all();

  await correctTimes(
    ctx(db, { body: { staffId: 1, in: '08:00', out: '21:00', reason: 'Both wrong' } }),
    '2026-06-03',
  );

  const punchesAfter = raw.prepare('SELECT * FROM att_punches ORDER BY id').all();
  assert.deepEqual(punchesAfter, punchesBefore, 'a punch is a fact');
});

test('a later punch does not undo a correction', async () => {
  // The failure this guards against: a night's poller catch-up arrives, the
  // day is recomputed, and the correction somebody typed in yesterday quietly
  // disappears from the figures.
  const { raw, db } = await setup();

  await correctTimes(
    ctx(db, { body: { staffId: 1, out: '21:00', reason: 'The kitchen ran until nine' } }),
    '2026-06-03',
  );

  raw.prepare(
    `INSERT INTO att_punches (staff_id, employee_no, device_serial, at_utc, at_local, day, source, dedupe_key)
     VALUES (1, '1001', 'TEST', ?1, ?1, '2026-06-03', 'test', 'late-arrival')`,
  ).run('2026-06-03 17:05:00');

  const { recompute } = await import('../src/lib/attendance-ingest.js');
  await recompute(db, { staffIds: [1], from: '2026-06-03', to: '2026-06-03' });

  const row = dayOf(raw, '2026-06-03');
  assert.equal(row.corrected_out, '21:00');
  assert.equal(row.last_out, '21:00', 'the correction still decides the hours');
  assert.equal(row.worked_minutes, 720);
});

test('clearing both boxes hands the day back to the terminal', async () => {
  const { raw, db } = await setup();

  await correctTimes(ctx(db, { body: { staffId: 1, out: '21:00', reason: 'Kitchen ran late' } }), '2026-06-03');
  await correctTimes(ctx(db, { body: { staffId: 1, reason: 'Wrong person — that was Kofi' } }), '2026-06-03');

  const row = dayOf(raw, '2026-06-03');
  assert.equal(row.corrected_out, null);
  assert.equal(row.last_out, '17:02', 'back to what the terminal read');

  const trail = raw.prepare('SELECT * FROM att_time_edit ORDER BY id').all();
  assert.equal(trail.length, 2);
  assert.equal(trail[1].was_out, '21:00');
  assert.equal(trail[1].now_out, null);
  assert.equal(trail[1].observed_out, '17:02',
    'the observation is carried forward, because att_days no longer holds it');
});

test('typing the same times again is refused rather than filed', async () => {
  const { db } = await setup();
  await correctTimes(ctx(db, { body: { staffId: 1, out: '21:00', reason: 'Kitchen' } }), '2026-06-03');
  await assert.rejects(
    () => correctTimes(ctx(db, { body: { staffId: 1, out: '21:00', reason: 'Kitchen' } }), '2026-06-03'),
    /already recorded/,
  );
});

test('a reason is not optional', async () => {
  const { db } = await setup();
  await assert.rejects(
    () => correctTimes(ctx(db, { body: { staffId: 1, out: '21:00' } }), '2026-06-03'),
    /Reason/,
  );
});

// ---------------------------------------------------------------------------
// The trail, and the bell
// ---------------------------------------------------------------------------

test('every change is written down with who, why and from where', async () => {
  const { raw, db } = await setup();

  await correctTimes(
    ctx(db, { body: { staffId: 1, out: '21:00', reason: 'The kitchen ran until nine' } }),
    '2026-06-03',
  );

  const [edit] = raw.prepare('SELECT * FROM att_time_edit').all();
  assert.equal(edit.staff_id, 1);
  assert.equal(edit.day, '2026-06-03');
  assert.equal(edit.observed_out, '17:02', 'what the terminal read');
  assert.equal(edit.was_out, null, 'nothing stood before it');
  assert.equal(edit.now_out, '21:00');
  assert.equal(edit.reason, 'The kitchen ran until nine');
  assert.equal(edit.actor, 'Yaa (planner)');
  assert.equal(edit.actor_id, 2);
  assert.equal(edit.ip, '41.66.0.9');

  const [logged] = raw.prepare("SELECT * FROM audit_log WHERE action = 'attendance.times'").all();
  assert.ok(logged, 'and in the audit log the whole app shares');
});

test('the administrators are told every time, and told louder when a reading was overwritten', async () => {
  const { raw, db } = await setup();

  // Tuesday: no clock-out at all. Filling one in is the everyday case.
  await correctTimes(
    ctx(db, { body: { staffId: 1, out: '17:00', reason: 'He forgot to clock out' } }),
    '2026-06-02',
  );
  // Wednesday: the terminal read 17:02 and it was wrong.
  await correctTimes(
    ctx(db, { body: { staffId: 1, out: '21:00', reason: 'The kitchen ran until nine' } }),
    '2026-06-03',
  );

  const notices = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.times' ORDER BY id").all();
  assert.equal(notices.length, 2, 'told every time, as asked');
  assert.ok(notices.every((n) => n.audience === 'att_setup'),
    'addressed to the permission administrators hold and managers do not');

  assert.equal(notices[0].level, 'info', 'filling in a punch the device never saw');
  assert.equal(notices[1].level, 'warn', 'overwriting one it did see');
  assert.match(notices[1].title, /Henry Aryee/);
  assert.match(notices[1].body, /17:02 → 21:00/);
  assert.match(notices[1].body, /The kitchen ran until nine/);
  assert.equal(notices[1].actor, 'Yaa (planner)');
});

test('settling a day files its clock times in the same register', async () => {
  // Otherwise the register is the truth about corrections made through one door
  // and silent about the other, which is worse than having no register.
  const { raw, db } = await setup();

  await resolveDay(
    ctx(db, {
      session: MANAGER,
      body: { staffId: 1, reason: 'present', out: '17:00', note: 'Saw him leave' },
    }),
    '2026-06-02',
  );

  const [edit] = raw.prepare('SELECT * FROM att_time_edit').all();
  assert.equal(edit.now_out, '17:00');
  assert.equal(edit.actor, 'Ama (manager)');
  assert.match(edit.reason, /Saw him leave/);

  // Not announced: it contradicted nothing, and a bell that rang for every
  // morning's missing clock-out would be silenced within the week.
  const notices = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.times'").all();
  assert.equal(notices.length, 0);
});

test('undoing a ruling is itself a change to the clock times', async () => {
  const { raw, db } = await setup();

  await resolveDay(
    ctx(db, { session: MANAGER, body: { staffId: 1, reason: 'present', out: '21:00', note: 'Late close' } }),
    '2026-06-03',
  );
  await unresolveDay(ctx(db, { session: MANAGER, body: { staffId: 1 } }), '2026-06-03');

  const trail = raw.prepare('SELECT * FROM att_time_edit ORDER BY id').all();
  assert.equal(trail.length, 2);
  assert.equal(trail[1].was_out, '21:00');
  assert.equal(trail[1].now_out, null);
  assert.equal(dayOf(raw, '2026-06-03').last_out, '17:02');
});

test('the register can be read back, newest first, and narrowed', async () => {
  const { db } = await setup();
  await correctTimes(ctx(db, { body: { staffId: 1, out: '17:00', reason: 'Forgot' } }), '2026-06-02');
  await correctTimes(ctx(db, { body: { staffId: 1, out: '21:00', reason: 'Kitchen' } }), '2026-06-03');

  const all = await read(await timeEdits(ctx(db, { query: '' })));
  assert.deepEqual(all.edits.map((e) => e.day), ['2026-06-03', '2026-06-02']);
  assert.equal(all.edits[0].staff_name, 'Henry Aryee');

  const narrowed = await read(await timeEdits(ctx(db, { query: '?from=2026-06-03&to=2026-06-03' })));
  assert.deepEqual(narrowed.edits.map((e) => e.day), ['2026-06-03']);
});

test("the trail comes back with the person's own report", async () => {
  // Where it matters most: on the sheet handed to the person whose hours were
  // changed, not only on a screen an administrator has to go looking for.
  const { db } = await setup();
  await correctTimes(ctx(db, { body: { staffId: 1, out: '21:00', reason: 'Kitchen' } }), '2026-06-03');

  const report = await read(await staffReport(
    ctx(db, { session: MANAGER, query: '?from=2026-06-01&to=2026-06-03' }),
    '1',
  ));

  assert.equal(report.timeEdits.length, 1);
  assert.equal(report.timeEdits[0].now_out, '21:00');
  assert.equal(report.timeEdits[0].observed_out, '17:02');
  assert.equal(report.timeEdits[0].actor, 'Yaa (planner)');
});
