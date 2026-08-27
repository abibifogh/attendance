import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  correctTimes, decideTimeEdit, resolveDay, staffReport, timeEdits, unresolveDay,
} from '../src/routes/attendance.js';
import { computeDay } from '../src/lib/attendance.js';
import { b64urlEncode } from '../src/lib/push.js';

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

/** Settles days and approves leave. Cannot approve a correction. */
const MANAGER = {
  user: { id: 1, name: 'Ama', role: 'manager' },
  permissions: ['att_view', 'att_reports', 'att_manage', 'att_times'],
};

/** The only person who can approve a correction. */
const ADMIN = {
  user: { id: 3, name: 'Kwame', role: 'admin' },
  permissions: ['att_view', 'att_reports', 'att_manage', 'att_setup', 'att_times'],
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
const requests = (raw) => raw.prepare("SELECT * FROM att_time_edit WHERE status = 'pending' ORDER BY id").all();

/** The planner asks; an administrator answers. The ordinary path. */
async function ask(db, day, body) {
  return read(await correctTimes(ctx(db, { body: { staffId: 1, ...body } }), day));
}
async function answer(db, id, body) {
  return read(await decideTimeEdit(ctx(db, { session: ADMIN, body }), String(id)));
}

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

test('the planner asks, and nothing moves until somebody answers', async () => {
  const { raw, db } = await setup();

  const out = await ask(db, '2026-06-03', { out: '21:00', reason: 'The kitchen ran until nine' });
  assert.equal(out.pending, true);
  assert.ok(out.requestId);

  const row = dayOf(raw, '2026-06-03');
  assert.equal(row.corrected_out, null, 'the day is untouched while it waits');
  assert.equal(row.last_out, '17:02', 'and still reads what the terminal read');

  const [waiting] = requests(raw);
  assert.equal(waiting.now_out, '21:00');
  assert.equal(waiting.actor, 'Yaa (planner)');
  assert.equal(waiting.decided_by, null);
});

test('approving applies the times, and the day settles on the verdict the rules reach', async () => {
  const { raw, db } = await setup();

  const { requestId } = await ask(db, '2026-06-03', { out: '21:00', reason: 'The kitchen ran until nine' });
  const done = await answer(db, requestId, { decision: 'approve' });
  assert.equal(done.decision, 'approve');

  const row = dayOf(raw, '2026-06-03');
  assert.equal(row.corrected_out, '21:00');
  assert.equal(row.corrected_in, null, 'the side nobody touched is left alone');
  assert.equal(row.last_out, '21:00');
  assert.equal(row.worked_minutes, 720, 'nine until nine');
  assert.equal(row.overtime_minutes, 240);

  assert.equal(row.resolution, 'resolved', 'settled automatically, as asked');
  assert.equal(row.status, 'present', 'and on the verdict the rules reached, not one anybody typed');
  assert.match(row.resolved_by, /Kwame \(admin\)/);
  assert.match(row.resolved_by, /Yaa \(planner\)/, 'both names, because two people stand behind it');

  const [edit] = raw.prepare('SELECT * FROM att_time_edit').all();
  assert.equal(edit.status, 'approved');
  assert.equal(edit.decided_by, 'Kwame (admin)');
  assert.ok(edit.decided_at);
});

test('an approved correction that leaves somebody late is settled as late', async () => {
  // The point of deriving the verdict rather than asking for one: approving
  // two clock times must not quietly excuse the day they describe.
  const { raw, db } = await setup();
  const { requestId } = await ask(db, '2026-06-03', { in: '10:30', reason: 'He was at the clinic first' });
  await answer(db, requestId, { decision: 'approve' });

  const row = dayOf(raw, '2026-06-03');
  assert.equal(row.status, 'late');
  assert.equal(row.late_minutes, 90);
  assert.equal(row.resolution, 'resolved');
});

test('sending it back changes nothing, and has to say why', async () => {
  const { raw, db } = await setup();
  const { requestId } = await ask(db, '2026-06-03', { out: '21:00', reason: 'Kitchen ran late' });

  await assert.rejects(
    () => answer(db, requestId, { decision: 'reject' }),
    /Say why/,
  );

  await answer(db, requestId, { decision: 'reject', note: 'That was Kofi on the late shift, not Henry' });

  const row = dayOf(raw, '2026-06-03');
  assert.equal(row.corrected_out, null);
  assert.equal(row.last_out, '17:02');
  assert.notEqual(row.resolution, 'resolved');

  const [edit] = raw.prepare('SELECT * FROM att_time_edit').all();
  assert.equal(edit.status, 'rejected');
  assert.match(edit.decision_note, /Kofi/);
});

test('an answer cannot be given twice', async () => {
  const { db } = await setup();
  const { requestId } = await ask(db, '2026-06-03', { out: '21:00', reason: 'Kitchen' });
  await answer(db, requestId, { decision: 'approve' });
  await assert.rejects(() => answer(db, requestId, { decision: 'reject', note: 'changed my mind' }),
    /already approved/);
});

test("an administrator's own correction applies and settles at once", async () => {
  // A queue with one name in it teaches everybody to press the button without
  // reading it.
  const { raw, db } = await setup();

  const out = await read(await correctTimes(
    ctx(db, { session: ADMIN, body: { staffId: 1, out: '21:00', reason: 'Kitchen ran late' } }),
    '2026-06-03',
  ));
  assert.equal(out.pending, false);
  assert.equal(out.day.last_out, '21:00');
  assert.equal(dayOf(raw, '2026-06-03').resolution, 'resolved');
  assert.equal(requests(raw).length, 0);
});

test('a second thought replaces the first rather than joining the queue', async () => {
  const { raw, db } = await setup();
  await ask(db, '2026-06-03', { out: '21:00', reason: 'Kitchen' });
  await ask(db, '2026-06-03', { out: '20:00', reason: 'Sorry — eight, not nine' });

  const waiting = requests(raw);
  assert.equal(waiting.length, 1, 'two contradictory requests is a question nobody can answer');
  assert.equal(waiting[0].now_out, '20:00');

  const superseded = raw.prepare("SELECT * FROM att_time_edit WHERE status = 'superseded'").all();
  assert.equal(superseded.length, 1, 'and the first is kept, not deleted');
});

test('the punches are never altered', async () => {
  const { raw, db } = await setup();
  const punchesBefore = raw.prepare('SELECT * FROM att_punches ORDER BY id').all();

  const { requestId } = await ask(db, '2026-06-03', { in: '08:00', out: '21:00', reason: 'Both wrong' });
  await answer(db, requestId, { decision: 'approve' });

  const punchesAfter = raw.prepare('SELECT * FROM att_punches ORDER BY id').all();
  assert.deepEqual(punchesAfter, punchesBefore, 'a punch is a fact');
});

test('a later punch does not undo an approved correction', async () => {
  // The failure this guards against: a night's poller catch-up arrives, the
  // day is recomputed, and the correction two people agreed to quietly
  // disappears from the figures.
  const { raw, db } = await setup();

  const { requestId } = await ask(db, '2026-06-03', { out: '21:00', reason: 'Kitchen ran until nine' });
  await answer(db, requestId, { decision: 'approve' });

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

test('clearing both boxes hands the day back to the terminal, and reopens it', async () => {
  const { raw, db } = await setup();

  const first = await ask(db, '2026-06-03', { out: '21:00', reason: 'Kitchen ran late' });
  await answer(db, first.requestId, { decision: 'approve' });
  assert.equal(dayOf(raw, '2026-06-03').resolution, 'resolved');

  const second = await ask(db, '2026-06-03', { reason: 'Wrong person — that was Kofi' });
  await answer(db, second.requestId, { decision: 'approve' });

  const row = dayOf(raw, '2026-06-03');
  assert.equal(row.corrected_out, null);
  assert.equal(row.last_out, '17:02', 'back to what the terminal read');
  assert.notEqual(row.resolution, 'resolved', 'a correction withdrawn is not a day settled');

  const trail = raw.prepare("SELECT * FROM att_time_edit WHERE status = 'approved' ORDER BY id").all();
  assert.equal(trail.length, 2);
  assert.equal(trail[1].was_out, '21:00');
  assert.equal(trail[1].now_out, null);
  assert.equal(trail[1].observed_out, '17:02',
    'the observation is carried forward, because att_days no longer holds it');
});

test("a supervisor's ruling is not overturned by an approved correction", async () => {
  // The doctrine the whole file rests on. Approving two clock times says when
  // somebody arrived and left; it does not say a Tuesday was not sick leave.
  const { raw, db } = await setup();

  await resolveDay(
    ctx(db, { session: MANAGER, body: { staffId: 1, reason: 'sick_leave', note: 'Clinic note seen' } }),
    '2026-06-03',
  );
  const ruled = dayOf(raw, '2026-06-03');
  assert.equal(ruled.reason_code, 'sick_leave');

  const { requestId } = await ask(db, '2026-06-03', { out: '21:00', reason: 'He came in later anyway' });
  await answer(db, requestId, { decision: 'approve' });

  const row = dayOf(raw, '2026-06-03');
  assert.equal(row.corrected_out, '21:00', 'the times went on');
  assert.equal(row.reason_code, 'sick_leave', 'and the ruling stayed where the supervisor put it');
  assert.equal(row.resolved_by, 'Ama (manager)');
});

test('typing the same times again is refused rather than filed', async () => {
  const { db } = await setup();
  await ask(db, '2026-06-03', { out: '21:00', reason: 'Kitchen' });
  await assert.rejects(
    () => ask(db, '2026-06-03', { out: '21:00', reason: 'Kitchen' }),
    /already waiting/,
  );
});

test('a reason is not optional', async () => {
  const { db } = await setup();
  await assert.rejects(
    () => ask(db, '2026-06-03', { out: '21:00' }),
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

test('the administrators are asked every time, and told when it is theirs to answer', async () => {
  const { raw, db } = await setup();

  // Tuesday: no clock-out at all. Wednesday: the terminal read 17:02 and was
  // wrong. Both wait, because both change what somebody is paid.
  await ask(db, '2026-06-02', { out: '17:00', reason: 'He forgot to clock out' });
  await ask(db, '2026-06-03', { out: '21:00', reason: 'The kitchen ran until nine' });

  const notices = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.times' ORDER BY id").all();
  assert.equal(notices.length, 2, 'told every time, as asked');
  assert.ok(notices.every((n) => n.audience === 'att_setup'),
    'addressed to the permission administrators hold and managers do not');
  assert.ok(notices.every((n) => n.level === 'high'),
    'something to do, not something that happened');
  assert.ok(notices.every((n) => n.link === '#/signoff?tab=times'), 'and it points at the queue');
  assert.match(notices[1].title, /Approve: Henry Aryee/);
  assert.match(notices[1].body, /17:02 → 21:00/);
  assert.match(notices[1].body, /The kitchen ran until nine/);
  assert.match(notices[1].body, /Nothing has changed on the day/);
});

test('the answer goes back to whoever asked', async () => {
  const { raw, db } = await setup();
  const { requestId } = await ask(db, '2026-06-03', { out: '21:00', reason: 'Kitchen ran late' });
  await answer(db, requestId, { decision: 'reject', note: 'That was Kofi' });

  const notices = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.times' ORDER BY id").all();
  const last = notices[notices.length - 1];
  assert.match(last.title, /Sent back/);
  assert.match(last.body, /That was Kofi/);
  assert.equal(last.audience, 'att_times', 'reaches everybody who can make a correction');
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
  const a = await ask(db, '2026-06-02', { out: '17:00', reason: 'Forgot' });
  const b = await ask(db, '2026-06-03', { out: '21:00', reason: 'Kitchen' });
  await answer(db, a.requestId, { decision: 'approve' });
  await answer(db, b.requestId, { decision: 'approve' });

  const all = await read(await timeEdits(ctx(db, { query: '' })));
  assert.deepEqual(all.edits.map((e) => e.day), ['2026-06-03', '2026-06-02']);
  assert.equal(all.edits[0].staff_name, 'Henry Aryee');
  assert.equal(all.canApprove, false, 'a planner reads it, and cannot answer it');

  const narrowed = await read(await timeEdits(ctx(db, { query: '?from=2026-06-03&to=2026-06-03' })));
  assert.deepEqual(narrowed.edits.map((e) => e.day), ['2026-06-03']);
});

test('what is waiting is never hidden by the dates on screen', async () => {
  // A change asked for outside the period somebody happens to be looking at is
  // still waiting on them. A queue that hides depending on where you are stood
  // is a queue that grows quietly.
  const { db } = await setup();
  await ask(db, '2026-06-02', { out: '17:00', reason: 'Forgot' });

  const far = await read(await timeEdits(ctx(db, {
    session: ADMIN, query: '?from=2026-07-01&to=2026-07-31',
  })));
  assert.equal(far.edits.length, 0);
  assert.equal(far.pending.length, 1);
  assert.equal(far.pending[0].day, '2026-06-02');
  assert.equal(far.canApprove, true);
});

test("the trail comes back with the person's own report", async () => {
  // Where it matters most: on the sheet handed to the person whose hours were
  // changed, not only on a screen an administrator has to go looking for.
  const { db } = await setup();
  const { requestId } = await ask(db, '2026-06-03', { out: '21:00', reason: 'Kitchen' });

  const waiting = await read(await staffReport(
    ctx(db, { session: MANAGER, query: '?from=2026-06-01&to=2026-06-03' }),
    '1',
  ));
  assert.equal(waiting.timeEdits.length, 0, 'nothing applied yet');
  assert.equal(waiting.pendingTimes.length, 1, 'but the day says a change is coming');
  assert.equal(waiting.pendingTimes[0].day, '2026-06-03');
  assert.equal(waiting.canApproveTimes, false, 'and a manager cannot answer it');

  await answer(db, requestId, { decision: 'approve' });

  const report = await read(await staffReport(
    ctx(db, { session: MANAGER, query: '?from=2026-06-01&to=2026-06-03' }),
    '1',
  ));
  assert.equal(report.pendingTimes.length, 0);
  assert.equal(report.timeEdits.length, 1);
  assert.equal(report.timeEdits[0].now_out, '21:00');
  assert.equal(report.timeEdits[0].observed_out, '17:02');
  assert.equal(report.timeEdits[0].actor, 'Yaa (planner)');
  assert.equal(report.timeEdits[0].decided_by, 'Kwame (admin)');
});

// ---------------------------------------------------------------------------
// Which rows carry a button
// ---------------------------------------------------------------------------

test('buttons are offered against days with something wrong, and held back otherwise', async () => {
  // A column of buttons against twenty-eight ordinary days is a column nobody
  // reads, and the four that matter are lost in it.
  const { needsAttention } = await import('../public/js/views/att-shared.js');

  assert.equal(needsAttention({ colour: 'red', status: 'absent' }), true, 'absent');
  assert.equal(needsAttention({ colour: 'amber', status: 'late' }), true, 'late');
  assert.equal(needsAttention({ colour: 'amber', status: 'early_leave' }), true, 'left early');
  assert.equal(needsAttention({ colour: 'red', status: 'missing_out', open: true }), true,
    'and a clock-out the terminal never saw');

  assert.equal(needsAttention({ colour: 'green', status: 'present' }), false, 'an ordinary day');
  assert.equal(needsAttention({ colour: 'grey', status: 'rest' }), false, 'a rest day');
  assert.equal(needsAttention({ colour: 'grey', status: 'upcoming' }), false, 'a shift not due yet');
  assert.equal(needsAttention(null), false);

  // A day already ruled on keeps its buttons, because that is how the ruling
  // is undone. A decision nobody can reverse is a decision nobody will make.
  assert.equal(needsAttention({ colour: 'green', status: 'present', resolution: 'resolved' }), true);
  assert.equal(needsAttention({ colour: 'green', status: 'missing_out', resolution: 'auto' }), true);
});

// ---------------------------------------------------------------------------
// Which way the administrator is told
// ---------------------------------------------------------------------------

/**
 * Everything the app would have to reach the outside world, recorded rather
 * than sent.
 *
 * One stub catches both channels: the email goes to Resend over HTTPS and the
 * push goes to the browser's own endpoint, so which arrived is a question
 * about where the request was addressed.
 */
async function watchSending(raw) {
  raw.prepare("INSERT INTO users (id, name, email, role, active) VALUES (3, 'Kwame', 'kwame@example.test', 'admin', 1)")
    .run();
  raw.prepare("UPDATE settings SET value = 'rota@example.test' WHERE key = 'email_from'").run();
  raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('email_from', 'rota@example.test')")
    .run();

  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const key = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  raw.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label)
     VALUES (3, 'https://push.example.test/kwame', ?, ?, 'Phone')`,
  ).run(b64urlEncode(key), b64urlEncode(crypto.getRandomValues(new Uint8Array(16))));

  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(String(url));
    return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  return {
    sent,
    emails: () => sent.filter((u) => /resend/i.test(u)).length,
    pushes: () => sent.filter((u) => /push\.example\.test/.test(u)).length,
    stop: () => { globalThis.fetch = real; },
  };
}

const withEnv = (base) => ({ ...base, env: { RESEND_API_KEY: 'test-key' } });

test('a change the planner sends up buzzes the phone and writes no email', async () => {
  const { raw, db } = await setup();
  const watch = await watchSending(raw);
  try {
    await correctTimes(withEnv(ctx(db, {
      body: { staffId: 1, out: '21:00', reason: 'The kitchen ran until nine' },
    })), '2026-06-03');
  } finally {
    watch.stop();
  }

  assert.equal(watch.emails(), 0, 'nothing goes to the inbox');
  assert.equal(watch.pushes(), 1, 'and the phone is buzzed once');

  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.times' ORDER BY id DESC").get();
  assert.match(notice.title, /^Approve: /, 'it is still the request it always was');
  assert.equal(notice.audience, 'att_setup');
});

test('a change an administrator makes themselves is a record, and still writes', async () => {
  const { raw, db } = await setup();
  const watch = await watchSending(raw);
  try {
    await correctTimes(withEnv(ctx(db, {
      session: ADMIN,
      body: { staffId: 1, out: '21:00', reason: 'Signed off with the head chef' },
    })), '2026-06-03');
  } finally {
    watch.stop();
  }

  assert.equal(watch.emails(), 1, 'a change already made is worth an inbox');
  assert.equal(watch.pushes(), 0, 'and is not worth a buzz');

  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.times' ORDER BY id DESC").get();
  assert.doesNotMatch(notice.title, /^Approve: /, 'nothing is waiting on anybody');
});
