import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  answerQuery, listQueries, outstanding, raiseQuery, reopenDays, signDays, withdrawQuery,
} from '../src/routes/signoff.js';

/**
 * Signing off as the rota planner actually does it, against a real database.
 *
 * The seams are the whole feature. A sign-off that leaves days out has to leave
 * them genuinely outstanding; the overlap rule has to let those days be settled
 * later; a question raised has to reach somebody and come back; and none of
 * that can be tested without the tables.
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

/** Builds the rota and settles up. Cannot see leave balances. */
const PLANNER = {
  user: { id: 2, name: 'Yaa', role: 'planner' },
  permissions: ['att_view', 'att_rota', 'att_signoff'],
};

/** Settles days and approves leave. The one questions go to. */
const MANAGER = {
  user: { id: 1, name: 'Ama', role: 'manager' },
  permissions: ['att_view', 'att_reports', 'att_manage', 'att_signoff'],
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
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'GET' }),
  };
}

const read = async (response) => response.json();

/**
 * A fortnight in the past, so nothing is "today" and everything is settled
 * enough to be signed. One cook, one shift, and four days worth arguing about.
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
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes, grace_out_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0, 5, 5)`,
  ).run();
  raw.exec('DELETE FROM att_staff');
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (1, '1001', 'Henry Aryee', 'Kitchen', '2020-01-01')",
  ).run();

  // Monday 1 June 2026 to Friday 5 June. Rostered every day.
  const days = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'];
  for (const day of days) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, 1)').run(day);
  }

  // Worked Monday and Tuesday properly. Late on Wednesday. Absent Thursday.
  // Friday worked.
  // The property runs on UTC in this fixture, so local time is the same
  // string. Both columns are stored because every report reads the local one.
  const punch = (day, at) => raw.prepare(
    `INSERT INTO att_punches (staff_id, employee_no, device_serial, at_utc, at_local, day, source, dedupe_key)
     VALUES (1, '1001', 'TEST', ?1, ?1, ?2, 'test', ?1)`,
  ).run(at, day);

  punch('2026-06-01', '2026-06-01 06:00:00'); punch('2026-06-01', '2026-06-01 14:02:00');
  punch('2026-06-02', '2026-06-02 05:58:00'); punch('2026-06-02', '2026-06-02 14:01:00');
  punch('2026-06-03', '2026-06-03 06:47:00'); punch('2026-06-03', '2026-06-03 14:00:00');
  // Thursday: nothing at all.
  punch('2026-06-05', '2026-06-05 06:01:00'); punch('2026-06-05', '2026-06-05 14:00:00');

  return { raw, db: d1(raw) };
}

const WEEK = '?from=2026-06-01&to=2026-06-05';

// ---------------------------------------------------------------------------
// What is outstanding
// ---------------------------------------------------------------------------

test('a week nobody has signed shows every day of it, with what is wrong', async () => {
  const { db } = await setup();
  const out = await read(await outstanding(ctx(db, { query: WEEK })));

  assert.equal(out.rows.length, 1);
  const row = out.rows[0];
  assert.equal(row.unsignedCount, 5);
  assert.deepEqual(row.days.map((d) => d.day), [
    '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05',
  ]);

  // Wednesday late, Thursday absent.
  assert.equal(row.issues.counts.late, 1);
  assert.equal(row.issues.counts.absent, 1);
  assert.equal(row.issues.blocking, true, 'an unexplained absence is worth stopping for');
  assert.match(row.summary, /Henry Aryee — 5 days/);
});

test('a day still running is never offered for sign-off', async () => {
  // Charging an absence against somebody who is upstairs making a bed is the
  // failure this prevents.
  const { db } = await setup();
  const today = new Date().toISOString().slice(0, 10);
  const out = await read(await outstanding(ctx(db, { query: `?from=2026-06-01&to=${today}` })));

  assert.ok(out.limit < today, 'the window stops before today');
  assert.ok(out.rows.every((r) => r.days.every((d) => d.day < today)));
});

test('the list can be narrowed to the ones with something wrong', async () => {
  const { raw, db } = await setup();
  // A second person whose week is clean.
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (2, '1002', 'Clean Sheet', 'Kitchen', '2020-01-01')").run();
  raw.prepare("INSERT INTO att_roster (staff_id, day, shift_id) VALUES (2, '2026-06-01', 1)").run();
  for (const at of ['2026-06-01 06:00:00', '2026-06-01 14:00:00']) {
    raw.prepare(
      `INSERT INTO att_punches (staff_id, employee_no, device_serial, at_utc, at_local, day, source, dedupe_key)
       VALUES (2, '1002', 'TEST', ?1, ?1, '2026-06-01', 'test', ?2)`,
    ).run(at, `clean-${at}`);
  }

  const all = await read(await outstanding(ctx(db, { query: WEEK })));
  assert.equal(all.rows.length, 2);

  const flagged = await read(await outstanding(ctx(db, { query: `${WEEK}&issues=1` })));
  assert.deepEqual(flagged.rows.map((r) => r.staff.name), ['Henry Aryee']);
});

test('a rest day nobody worked is not something to sign off', async () => {
  const { db } = await setup();
  // Saturday and Sunday are neither rostered nor worked.
  const out = await read(await outstanding(ctx(db, { query: '?from=2026-06-01&to=2026-06-07' })));
  assert.deepEqual(out.rows[0].days.map((d) => d.day).slice(-1), ['2026-06-05']);
});

// ---------------------------------------------------------------------------
// Signing part of it
// ---------------------------------------------------------------------------

test('signing the clean days leaves the awkward one outstanding', async () => {
  const { db } = await setup();

  const done = await read(await signDays(ctx(db, {
    body: {
      staffId: 1,
      days: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-05'],
      daysApplied: 0,
    },
  })));

  assert.equal(done.signed, 4);
  assert.equal(done.excluded, 1, 'Thursday was inside the span and deliberately left out');
  assert.equal(done.kind, 'partial');

  const out = await read(await outstanding(ctx(db, { query: WEEK })));
  assert.deepEqual(out.rows[0].days.map((d) => d.day), ['2026-06-04']);
  assert.equal(out.rows[0].issues.counts.absent, 1);
});

test('the day a sign-off left out can be signed on its own afterwards', async () => {
  // The rule this whole change turns on. Compared on the raw dates, the week
  // would refuse Thursday for ever and nobody could settle it at all.
  const { db } = await setup();
  await signDays(ctx(db, {
    body: { staffId: 1, days: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-05'], daysApplied: 0 },
  }));

  const later = await read(await signDays(ctx(db, {
    body: { staffId: 1, days: ['2026-06-04'], daysApplied: 1, note: 'Rang him, no explanation' },
  })));

  assert.equal(later.signed, 1);
  assert.equal(later.kind, 'day');

  const out = await read(await outstanding(ctx(db, { query: WEEK })));
  assert.equal(out.rows.length, 0, 'nothing left');
});

test('signing a day twice is refused, and the message names the day', async () => {
  const { db } = await setup();
  await signDays(ctx(db, { body: { staffId: 1, days: ['2026-06-01', '2026-06-02'], daysApplied: 0 } }));

  await assert.rejects(
    () => signDays(ctx(db, { body: { staffId: 1, days: ['2026-06-02', '2026-06-03'], daysApplied: 0 } })),
    /2026-06-02 signed off/,
  );
});

test('a day that has not finished cannot be signed', async () => {
  const { db } = await setup();
  const today = new Date().toISOString().slice(0, 10);
  await assert.rejects(
    () => signDays(ctx(db, { body: { staffId: 1, days: [today] } })),
    /has not finished/,
  );
});

test('signing nothing is refused rather than recorded as an empty sign-off', async () => {
  const { db } = await setup();
  await assert.rejects(() => signDays(ctx(db, { body: { staffId: 1, days: [] } })), /at least one day/);
});

test('what was signed, and what it was worth, is recorded against the figures', async () => {
  const { raw, db } = await setup();
  await signDays(ctx(db, {
    body: { staffId: 1, days: ['2026-06-01', '2026-06-02'], daysApplied: 0, note: 'All fine' },
  }));

  const row = raw.prepare('SELECT * FROM att_period_review').get();
  assert.equal(row.from_day, '2026-06-01');
  assert.equal(row.to_day, '2026-06-02');
  assert.equal(row.scheduled_days, 2);
  assert.equal(row.worked_days, 2);
  assert.equal(row.days_applied, 0);
  assert.equal(row.note, 'All fine');
  assert.match(row.decided_by, /Yaa/, 'the planner’s own name is on it');
  assert.equal(row.excluded_days, null, 'a contiguous sign-off excludes nothing');
});

test('signing over a known problem records that it was known', async () => {
  const { raw, db } = await setup();
  await signDays(ctx(db, { body: { staffId: 1, days: ['2026-06-03'], daysApplied: 0 } }));

  const row = raw.prepare('SELECT * FROM att_period_review').get();
  assert.deepEqual(JSON.parse(row.issues), { late: 1 });
});

test('reopening puts the days back on the list', async () => {
  const { db } = await setup();
  await signDays(ctx(db, { body: { staffId: 1, days: ['2026-06-01', '2026-06-02'], daysApplied: 0 } }));
  assert.equal((await read(await outstanding(ctx(db, { query: WEEK })))).rows[0].unsignedCount, 3);

  await reopenDays(ctx(db, { body: { staffId: 1, from: '2026-06-01', to: '2026-06-02' } }));
  assert.equal((await read(await outstanding(ctx(db, { query: WEEK })))).rows[0].unsignedCount, 5);
});

// ---------------------------------------------------------------------------
// Asking somebody instead
// ---------------------------------------------------------------------------

test('a period can be raised rather than signed, and it reaches the queue', async () => {
  const { db } = await setup();

  await raiseQuery(ctx(db, {
    body: {
      staffId: 1,
      days: ['2026-06-04'],
      reason: 'Absent all day and nobody knows why. I would rather not charge his leave.',
      issues: { absent: 1 },
    },
  }));

  const queue = await read(await listQueries(ctx(db, { session: MANAGER })));
  assert.equal(queue.rows.length, 1);

  const q = queue.rows[0];
  assert.equal(q.staff.name, 'Henry Aryee');
  assert.equal(q.status, 'open');
  assert.match(q.raisedBy, /Yaa/);
  assert.deepEqual(q.days, ['2026-06-04']);
  assert.equal(q.notes.length, 1, 'the reason is the first thing said on it');
});

test('raising it rings the bell for whoever settles days', async () => {
  const { raw, db } = await setup();
  await raiseQuery(ctx(db, { body: { staffId: 1, days: ['2026-06-04'], reason: 'Unexplained' } }));

  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.query'").get();
  assert.ok(notice);
  assert.equal(notice.audience, 'att_manage', 'addressed to the permission, not to a person');
  assert.match(notice.title, /Henry Aryee/);
});

test('the same period cannot be raised twice', async () => {
  const { db } = await setup();
  await raiseQuery(ctx(db, { body: { staffId: 1, days: ['2026-06-03', '2026-06-04'], reason: 'Odd week' } }));

  await assert.rejects(
    () => raiseQuery(ctx(db, { body: { staffId: 1, days: ['2026-06-04'], reason: 'Again' } })),
    /already a question open/,
  );
});

test('the outstanding list shows that a question is already open', async () => {
  const { db } = await setup();
  await raiseQuery(ctx(db, { body: { staffId: 1, days: ['2026-06-04'], reason: 'Unexplained' } }));

  const out = await read(await outstanding(ctx(db, { query: WEEK })));
  assert.ok(out.rows[0].query, 'so nobody raises it a second time');
  assert.equal(out.rows[0].query.status, 'open');
});

test('an administrator can comment without closing it', async () => {
  const { db } = await setup();
  await raiseQuery(ctx(db, { body: { staffId: 1, days: ['2026-06-04'], reason: 'Unexplained' } }));
  const [q] = (await read(await listQueries(ctx(db, { session: MANAGER })))).rows;

  await answerQuery(ctx(db, {
    session: MANAGER, body: { action: 'comment', body: 'Checking with the kitchen — leave it open.' },
  }), q.id);

  const [again] = (await read(await listQueries(ctx(db, { session: MANAGER })))).rows;
  assert.equal(again.status, 'open');
  assert.equal(again.notes.length, 2);
});

test('an administrator can hand it back with a direction', async () => {
  const { raw, db } = await setup();
  await raiseQuery(ctx(db, { body: { staffId: 1, days: ['2026-06-04'], reason: 'Unexplained' } }));
  const [q] = (await read(await listQueries(ctx(db, { session: MANAGER })))).rows;

  await answerQuery(ctx(db, {
    session: MANAGER,
    body: { action: 'direction', body: 'He was at the clinic. Mark it sick leave, then sign it.' },
  }), q.id);

  const [again] = (await read(await listQueries(ctx(db, { session: MANAGER })))).rows;
  assert.equal(again.status, 'answered');
  assert.equal(again.outcome, 'returned');
  assert.equal(again.notes.at(-1).kind, 'direction');

  // And the person who raised it is told.
  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.query_answered'").get();
  assert.equal(notice.audience, 'att_signoff');
});

test('an administrator can sign it off there and then', async () => {
  const { raw, db } = await setup();
  await raiseQuery(ctx(db, { body: { staffId: 1, days: ['2026-06-04'], reason: 'Unexplained' } }));
  const [q] = (await read(await listQueries(ctx(db, { session: MANAGER })))).rows;

  const out = await read(await answerQuery(ctx(db, {
    session: MANAGER,
    body: { action: 'sign', daysApplied: 1, body: 'Unexplained. Charged one day.' },
  }), q.id));

  assert.equal(out.status, 'resolved');
  assert.equal(out.signed, 1);

  // Signed under the administrator's name, not the planner's.
  const review = raw.prepare('SELECT * FROM att_period_review').get();
  assert.match(review.decided_by, /Ama/);
  assert.equal(review.days_applied, 1);

  // And it is off the outstanding list.
  assert.equal((await read(await outstanding(ctx(db, { query: WEEK })))).rows[0].unsignedCount, 4);
});

test('signing the days a question was about answers the question', async () => {
  const { db } = await setup();
  await raiseQuery(ctx(db, { body: { staffId: 1, days: ['2026-06-04'], reason: 'Unexplained' } }));

  // The planner works it out themselves and signs it.
  await signDays(ctx(db, { body: { staffId: 1, days: ['2026-06-04'], daysApplied: 1 } }));

  const queue = await read(await listQueries(ctx(db, { session: MANAGER })));
  assert.equal(queue.rows.length, 0, 'no longer waiting on anybody');
});

test('signing only part of what was asked about leaves the question open', async () => {
  const { db } = await setup();
  await raiseQuery(ctx(db, {
    body: { staffId: 1, days: ['2026-06-03', '2026-06-04'], reason: 'Both of these' },
  }));

  await signDays(ctx(db, { body: { staffId: 1, days: ['2026-06-03'], daysApplied: 0 } }));

  const queue = await read(await listQueries(ctx(db, { session: MANAGER })));
  assert.equal(queue.rows.length, 1, 'one of the two days is still a question');
});

test('whoever raised it can take it back', async () => {
  const { db } = await setup();
  await raiseQuery(ctx(db, { body: { staffId: 1, days: ['2026-06-04'], reason: 'Unexplained' } }));
  const [q] = (await read(await listQueries(ctx(db, { session: MANAGER })))).rows;

  await withdrawQuery(ctx(db, { body: {} }), q.id);
  assert.equal((await read(await listQueries(ctx(db, { session: MANAGER })))).rows.length, 0);
});

test('an answer with nothing in it is refused', async () => {
  const { db } = await setup();
  await raiseQuery(ctx(db, { body: { staffId: 1, days: ['2026-06-04'], reason: 'Unexplained' } }));
  const [q] = (await read(await listQueries(ctx(db, { session: MANAGER })))).rows;

  await assert.rejects(
    () => answerQuery(ctx(db, { session: MANAGER, body: { action: 'direction', body: '  ' } }), q.id),
    /Say something/,
  );
});

// ---------------------------------------------------------------------------
// Clock-time changes, on the screen the period is signed from
// ---------------------------------------------------------------------------

test('a change waiting on a day is shown against it, and never signed over blind', async () => {
  // Signing a period off while a correction to it is pending would settle
  // somebody's leave against a figure another person has already said is
  // wrong. The list has to say so on the row.
  const { raw, db } = await setup();
  const { correctTimes } = await import('../src/routes/attendance.js');

  await correctTimes(
    ctx(db, {
      session: { ...PLANNER, permissions: [...PLANNER.permissions, 'att_times'] },
      body: { staffId: 1, out: '18:30', reason: 'The function ran on' },
    }),
    '2026-06-03',
  );

  const out = await read(await outstanding(ctx(db, { query: WEEK })));
  const days = out.rows[0].days;
  const wednesday = days.find((d) => d.day === '2026-06-03');

  assert.ok(wednesday.pendingTimes, 'the row carries the waiting change');
  assert.equal(wednesday.pendingTimes.now_out, '18:30');
  assert.equal(wednesday.pendingTimes.actor, 'Yaa (planner)');
  assert.equal(wednesday.out, '14:00', 'and the figures are still what the terminal read');

  assert.ok(days.every((d) => 'corrected_in' in d && 'corrected_out' in d),
    'every row carries what has already been corrected, so the dialog opens on it');

  // Nothing was applied, so nothing was recomputed away.
  const row = raw.prepare("SELECT * FROM att_days WHERE staff_id = 1 AND day = '2026-06-03'").get();
  assert.equal(row.corrected_out, null);
});

test('the sign-off list says who may correct a time on it', async () => {
  const { db } = await setup();

  const planner = await read(await outstanding(ctx(db, { query: WEEK })));
  assert.equal(planner.canFixTimes, false, 'this fixture planner was not given it');

  const allowed = await read(await outstanding(ctx(db, {
    query: WEEK,
    session: { ...PLANNER, permissions: [...PLANNER.permissions, 'att_times'] },
  })));
  assert.equal(allowed.canFixTimes, true);
});

// ---------------------------------------------------------------------------
// A day left out is not a day signed
// ---------------------------------------------------------------------------

test('signing some days of a week leaves the rest genuinely outstanding', async () => {
  const { raw, db } = await setup();
  const { staffReport } = await import('../src/routes/attendance.js');

  // Monday and Friday only, with three days in between deliberately left out.
  await signDays(ctx(db, {
    session: MANAGER,
    body: { staffId: 1, days: ['2026-06-01', '2026-06-05'], daysApplied: 0 },
  }));

  const still = await read(await outstanding(ctx(db, { query: WEEK })));
  assert.deepEqual(still.rows[0].days.map((d) => d.day),
    ['2026-06-02', '2026-06-03', '2026-06-04'],
    'the three left out are still on the list');

  // And the person's own report has to agree with the list. Reading the span's
  // dates alone would mark all five as settled, which hides exactly the days
  // somebody left out in order to come back to them.
  const report = await read(await staffReport(
    ctx(db, { session: MANAGER, query: '?from=2026-06-01&to=2026-06-05' }), '1',
  ));

  assert.equal(report.signedSpans.length, 1);
  assert.deepEqual(report.signedSpans[0].excluded,
    ['2026-06-02', '2026-06-03', '2026-06-04'],
    'the report is told which days the sign-off did not cover');

  const signedOn = (day) => report.signedSpans.some((sp) => sp.from <= day && sp.to >= day
    && !sp.excluded.includes(day));
  assert.equal(signedOn('2026-06-01'), true);
  assert.equal(signedOn('2026-06-03'), false, 'a day between two signed days is not signed');
  assert.equal(signedOn('2026-06-05'), true);

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_period_review').get().n, 1);
});

test('the charge offered is for the days ticked, not the window they sit in', async () => {
  // Ticking three days of a fortnight and being handed the fortnight's figure
  // is how eleven days of somebody's leave move by accident.
  const { overUnderOf } = await import('../public/js/views/att-shared.js');

  // Each day carries what it delivered and what was expected of it, so any
  // handful of them comes to the same answer the whole week would.
  const q = 5 / 7;
  const week = [
    { day: '2026-06-01', owed: 1, quota: q },
    { day: '2026-06-02', owed: 0, quota: q },
    { day: '2026-06-03', owed: 0, quota: q },
    { day: '2026-06-04', owed: 1, quota: q },
    { day: '2026-06-05', owed: 1, quota: q },
  ];

  assert.equal(overUnderOf(week), -1, 'three days delivered against three and a half expected');
  assert.equal(overUnderOf(week.filter((d) => d.day === '2026-06-01')), 0,
    'one day delivered, and less than one expected of it');
  assert.equal(overUnderOf(week.filter((d) => !d.owed)), -1);
  assert.equal(overUnderOf([]), 0);
});

// ---------------------------------------------------------------------------
// Asking a particular person, privately
// ---------------------------------------------------------------------------

/** A login that exists, so a question can be addressed to it. */
function withLogins(raw) {
  raw.exec('DELETE FROM users');
  raw.prepare(
    `INSERT INTO users (id, name, email, role, active) VALUES
       (1, 'Ama', 'ama@example.test', 'manager', 1),
       (2, 'Yaa', 'yaa@example.test', 'planner', 1),
       (3, 'Kwame', 'kwame@example.test', 'admin', 1),
       (4, 'Kofi', 'kofi@example.test', 'viewer', 1)`,
  ).run();
}

test('only people who could answer a question can be asked one', async () => {
  const { raw, db } = await setup();
  withLogins(raw);
  const { listDeciders } = await import('../src/routes/signoff.js');

  const { people } = await read(await listDeciders(ctx(db)));
  const names = people.map((p) => p.name).sort();
  assert.deepEqual(names, ['Ama', 'Kwame'],
    'a manager and an administrator settle days; a planner and a reports-only login do not');
  assert.ok(people.every((p) => !('email' in p)),
    'and picking a name off a list does not need anybody’s email address');
});

test('a question can be addressed to somebody, and their bell rings for it', async () => {
  const { raw, db } = await setup();
  withLogins(raw);

  await raiseQuery(ctx(db, {
    body: {
      staffId: 1,
      days: ['2026-06-04'],
      reason: 'Absent all day and nobody knows why',
      addressedTo: 3,
    },
  }));

  const row = raw.prepare('SELECT * FROM att_query').get();
  assert.equal(row.addressed_to, 3);
  assert.equal(row.addressed_name, 'Kwame');

  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.query'").get();
  assert.equal(notice.user_id, 3, 'named, so it is not three people’s problem and nobody’s job');
  assert.match(notice.title, /has asked you to look/);
});

test('a question cannot be addressed to somebody who could not answer it', async () => {
  const { raw, db } = await setup();
  withLogins(raw);

  await assert.rejects(
    () => raiseQuery(ctx(db, {
      body: { staffId: 1, days: ['2026-06-04'], reason: 'Why?', addressedTo: 4 },
    })),
    /cannot answer a question/,
  );
});

test('nobody in particular is still allowed, and reaches whoever holds the permission', async () => {
  const { raw, db } = await setup();
  withLogins(raw);

  await raiseQuery(ctx(db, { body: { staffId: 1, days: ['2026-06-04'], reason: 'Why?' } }));

  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.query'").get();
  assert.equal(notice.user_id, null);
  assert.equal(notice.audience, 'att_manage');
});

test('a question is read by whoever can answer it, and by nobody else', async () => {
  // What somebody writes to raise a question is a sentence about a colleague.
  // Every planner and every supervisor being able to read all of them is not a
  // queue, it is a noticeboard about people who never agreed to be on it.
  const { raw, db } = await setup();
  withLogins(raw);

  await raiseQuery(ctx(db, {
    session: { user: { id: 2, name: 'Yaa', role: 'planner' }, permissions: ['att_view', 'att_signoff'] },
    body: { staffId: 1, days: ['2026-06-04'], reason: 'He was at the clinic, I think' },
  }));

  // Whoever can answer sees it.
  const boss = await read(await listQueries(ctx(db, { session: MANAGER, query: '?status=all' })));
  assert.equal(boss.rows.length, 1);
  assert.equal(boss.canDecide, true);

  // The person who asked sees their own.
  const mine = await read(await listQueries(ctx(db, {
    session: { user: { id: 2, name: 'Yaa', role: 'planner' }, permissions: ['att_view', 'att_signoff'] },
    query: '?status=all',
  })));
  assert.equal(mine.rows.length, 1);
  assert.equal(mine.canDecide, false);

  // A second planner sees nothing of it.
  const other = await read(await listQueries(ctx(db, {
    session: { user: { id: 5, name: 'Adjoa', role: 'planner' }, permissions: ['att_view', 'att_signoff'] },
    query: '?status=all',
  })));
  assert.equal(other.rows.length, 0, 'not a noticeboard');
});

test('an answer is visible to the person who asked, and still to nobody else', async () => {
  const { raw, db } = await setup();
  withLogins(raw);
  const asker = {
    user: { id: 2, name: 'Yaa', role: 'planner' },
    permissions: ['att_view', 'att_signoff'],
  };

  const raised = await read(await raiseQuery(ctx(db, {
    session: asker,
    body: { staffId: 1, days: ['2026-06-04'], reason: 'Why was he out?' },
  })));
  await answerQuery(ctx(db, {
    session: MANAGER,
    body: { action: 'direction', body: 'He was at the clinic — mark it sick leave, then sign it.' },
  }), String(raised.id));

  const mine = await read(await listQueries(ctx(db, { session: asker, query: '?status=all' })));
  assert.equal(mine.rows.length, 1);
  assert.match(mine.rows[0].notes.map((n) => n.body).join(' '), /clinic/);

  const other = await read(await listQueries(ctx(db, {
    session: { user: { id: 5, name: 'Adjoa', role: 'planner' }, permissions: ['att_view', 'att_signoff'] },
    query: '?status=all',
  })));
  assert.equal(other.rows.length, 0);
});

// ---------------------------------------------------------------------------
// Clearing everything nothing is wrong with
// ---------------------------------------------------------------------------

test('the list narrows by day, not by person', async () => {
  // A cook with four clean days and one unexplained Thursday used to vanish
  // from "clean" entirely: their four good days appeared only under "with
  // issues", beside the one bad one, with a button offering to sign them.
  // Which is the right offer and completely the wrong place.
  const { raw, db } = await setup();
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (2, '1002', 'Clean Sheet', 'Kitchen', '2020-01-01')").run();
  for (const day of ['2026-06-01', '2026-06-02']) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (2, ?, 1)').run(day);
    for (const at of [`${day} 06:00:00`, `${day} 14:00:00`]) {
      raw.prepare(
        `INSERT INTO att_punches (staff_id, employee_no, device_serial, at_utc, at_local, day, source, dedupe_key)
         VALUES (2, '1002', 'TEST', ?1, ?1, ?2, 'test', ?3)`,
      ).run(at, day, `clean-${at}`);
    }
  }

  // Henry's week: Monday and Tuesday clean, Wednesday late, Thursday absent,
  // Friday clean.
  const everybody = await read(await outstanding(ctx(db, { query: WEEK })));
  assert.deepEqual(everybody.rows.map((r) => r.staff.name).sort(), ['Clean Sheet', 'Henry Aryee']);

  const wrong = await read(await outstanding(ctx(db, { query: `${WEEK}&issues=1` })));
  assert.deepEqual(wrong.rows.map((r) => r.staff.name), ['Henry Aryee'],
    'the clean sheet has nothing wrong anywhere, so drops out entirely');
  assert.deepEqual(wrong.rows[0].days.map((d) => d.day), ['2026-06-03', '2026-06-04'],
    'and only his two bad days are shown, not his whole week');

  const clean = await read(await outstanding(ctx(db, { query: `${WEEK}&issues=0` })));
  assert.deepEqual(clean.rows.map((r) => r.staff.name).sort(), ['Clean Sheet', 'Henry Aryee'],
    'and his three good days are here, where somebody looking to clear things will find them');
  assert.deepEqual(
    clean.rows.find((r) => r.staff.name === 'Henry Aryee').days.map((d) => d.day),
    ['2026-06-01', '2026-06-02', '2026-06-05'],
  );
});

test('a day waiting on a clock-time change is not a clean day to the filter either', async () => {
  const { db } = await setup();
  const { correctTimes } = await import('../src/routes/attendance.js');

  await correctTimes(ctx(db, {
    session: { ...PLANNER, permissions: [...PLANNER.permissions, 'att_times'] },
    body: { staffId: 1, out: '18:30', reason: 'The function ran on' },
  }), '2026-06-01');

  const clean = await read(await outstanding(ctx(db, { query: `${WEEK}&issues=0` })));
  assert.deepEqual(clean.rows[0].days.map((d) => d.day), ['2026-06-02', '2026-06-05'],
    'it looks settled and its figures are about to move');
});


test('signing every clean day leaves the awkward ones behind', async () => {
  // What the one-press button does, per person, through the ordinary route.
  // Henry's week is clean on Monday, Tuesday and Friday; late on Wednesday and
  // absent on Thursday.
  const { raw, db } = await setup();

  const before = await read(await outstanding(ctx(db, { query: WEEK })));
  const cleanDays = before.rows[0].days.filter((d) => !d.issues.length && !d.pendingTimes);
  assert.deepEqual(cleanDays.map((d) => d.day), ['2026-06-01', '2026-06-02', '2026-06-05']);

  await signDays(ctx(db, {
    session: MANAGER,
    body: { staffId: 1, days: cleanDays.map((d) => d.day), daysApplied: 0, note: 'Nothing outstanding on these days' },
  }));

  const after = await read(await outstanding(ctx(db, { query: WEEK })));
  assert.deepEqual(after.rows[0].days.map((d) => d.day), ['2026-06-03', '2026-06-04'],
    'the late day and the absence stay, on their own');

  const review = raw.prepare('SELECT * FROM att_period_review').get();
  assert.equal(review.days_applied, 0, 'a clean day is neither an extra one nor a missed one');
  assert.deepEqual(JSON.parse(review.excluded_days), ['2026-06-03', '2026-06-04']);
});

test('a day with a clock-time change waiting is not a clean day', async () => {
  // It looks clean today and its figures are about to move, which is exactly
  // the day a one-press clear must not sweep up.
  const { db } = await setup();
  const { correctTimes } = await import('../src/routes/attendance.js');

  await correctTimes(ctx(db, {
    session: { ...PLANNER, permissions: [...PLANNER.permissions, 'att_times'] },
    body: { staffId: 1, out: '18:30', reason: 'The function ran on' },
  }), '2026-06-01');

  const out = await read(await outstanding(ctx(db, { query: WEEK })));
  const clean = out.rows[0].days.filter((d) => !d.issues.length && !d.pendingTimes);
  assert.ok(!clean.some((d) => d.day === '2026-06-01'),
    'Monday has nothing flagged, but somebody has asked for its times to move');
  assert.deepEqual(clean.map((d) => d.day), ['2026-06-02', '2026-06-05']);
});

test('a question parks the days it names, not the person', async () => {
  // Asking about a Thursday nobody can explain must not put that person's
  // other four days beyond reach. Parking somebody's whole week because one
  // day of it has a question on it is the surest way to stop anybody asking.
  const { db } = await setup();

  await raiseQuery(ctx(db, {
    body: { staffId: 1, days: ['2026-06-04'], reason: 'Absent and nobody knows why' },
  }));

  const out = await read(await outstanding(ctx(db, { query: WEEK })));
  const days = out.rows[0].days;

  assert.equal(days.length, 5, 'every day is still on the row');
  const asked = days.filter((d) => d.query);
  assert.deepEqual(asked.map((d) => d.day), ['2026-06-04'],
    'and exactly the day the question named carries it');
  assert.equal(asked[0].query.status, 'open');
  assert.match(asked[0].query.reason, /nobody knows why/);

  assert.equal(out.asked, 1, 'counted in days, because days are what the groups hold');
  assert.equal(out.answered, 0);
});

test('answering a question moves only its days back into play', async () => {
  const { db } = await setup();
  const raised = await read(await raiseQuery(ctx(db, {
    body: { staffId: 1, days: ['2026-06-03', '2026-06-04'], reason: 'Two odd days' },
  })));
  await answerQuery(ctx(db, {
    session: MANAGER,
    body: { action: 'direction', body: 'Mark Thursday sick and sign the rest.' },
  }), String(raised.id));

  const out = await read(await outstanding(ctx(db, { query: WEEK })));
  assert.equal(out.answered, 2);
  assert.equal(out.asked, 0);
  assert.deepEqual(
    out.rows[0].days.filter((d) => d.query?.status === 'answered').map((d) => d.day),
    ['2026-06-03', '2026-06-04'],
  );
  assert.deepEqual(
    out.rows[0].days.filter((d) => !d.query).map((d) => d.day),
    ['2026-06-01', '2026-06-02', '2026-06-05'],
    'and the other three were never held up by it',
  );
});
