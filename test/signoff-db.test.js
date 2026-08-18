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
