import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  MOST_DAYS, leaveDaysDecision, maySetLeaveDays, readLeaveDays, sayDays,
} from '../src/lib/leave-days.js';
import {
  changeDaysApplied, decideLeaveChange, leaveChanges, signDays,
} from '../src/routes/signoff.js';

/**
 * Days on and off somebody's leave, and who may actually move them.
 *
 * Signing a month records one figure that is not a fact about the month: how
 * many days it takes off, or gives back to, that person's entitlement. Here the
 * person who signs is usually the person who built the rota the shortfall is
 * about, which is the wrong number of hands on something that ends up in
 * somebody's pay.
 *
 * What is pinned down is that the days still get signed — holding that up would
 * stop the property working — and that the balance does not move until an
 * administrator says so.
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

const DAYS = ['2026-06-01', '2026-06-02', '2026-06-03'];

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_period_review; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-01')`,
  ).run();
  for (const day of DAYS) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, 1)').run(day);
    for (const [at, dir] of [['06:00:00', 'in'], ['14:00:00', 'out']]) {
      raw.prepare(
        `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day,
                                  direction, dedupe_key)
         VALUES ('D1', '1', 1, ?, ?, ?, ?, ?)`,
      ).run(`${day} ${at}`, `${day} ${at}`, day, dir, `${day}-${at}-${dir}`);
    }
  }
  return { raw, db: d1(raw) };
}

/** Builds the rota and closes months off. Cannot move a balance. */
const PLANNER = {
  user: { id: 2, name: 'Jessica', role: 'planner' },
  permissions: ['att_view', 'att_rota', 'att_times', 'att_signoff'],
};
/** The one who can. */
const BOSS = {
  user: { id: 1, name: 'Kwame', role: 'admin' },
  permissions: ['att_view', 'att_reports', 'att_manage', 'att_signoff', 'att_setup'],
};

const ctx = (db, session, body = null) => ({
  db,
  env: {},
  url: new URL('https://x/api/att/x'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const sign = (db, session, days, daysApplied, note = null) =>
  signDays(ctx(db, session, { staffId: 1, days, daysApplied, note })).then((r) => r.json());

const queue = (db, session = BOSS) => leaveChanges(ctx(db, session)).then((r) => r.json());
const applied = (raw) => Number(raw.prepare('SELECT days_applied FROM att_period_review').get()?.days_applied ?? 0);

// ---------------------------------------------------------------------------
// The rule on its own
// ---------------------------------------------------------------------------

test('an administrator sets the figure; everybody else asks for it', () => {
  assert.equal(maySetLeaveDays(['att_setup']), true);
  assert.equal(maySetLeaveDays(['att_signoff', 'att_manage']), false);

  assert.deepEqual(leaveDaysDecision({ was: 0, days: -3, permissions: ['att_setup'] }),
    { apply: -3, propose: null });
  assert.deepEqual(leaveDaysDecision({ was: 0, days: -3, permissions: ['att_signoff'] }),
    { apply: 0, propose: { was: 0, days: -3 } });
});

test('asking for the figure that already stands is agreement, not a request', () => {
  // Otherwise re-signing a period an administrator has already decided fills
  // the queue with rows saying "leave it as it is".
  assert.deepEqual(leaveDaysDecision({ was: -3, days: -3, permissions: ['att_signoff'] }),
    { apply: -3, propose: null });
  assert.deepEqual(leaveDaysDecision({ was: 0, days: 0, permissions: ['att_signoff'] }),
    { apply: 0, propose: null });
});

test('a figure that is not a whole sensible number of days is not one', () => {
  assert.equal(readLeaveDays('3'), 3);
  assert.equal(readLeaveDays('-2.4'), -2);
  assert.equal(readLeaveDays(MOST_DAYS + 1), null);
  assert.equal(readLeaveDays('nine'), null);
  assert.equal(readLeaveDays('', 0), 0);
});

test('the figure reads as somebody would say it', () => {
  assert.equal(sayDays(-3), '3 days off');
  assert.equal(sayDays(-1), '1 day off');
  assert.equal(sayDays(2), '2 days back');
  assert.equal(sayDays(0), 'no change');
});

// ---------------------------------------------------------------------------
// Signing off
// ---------------------------------------------------------------------------

test('the planner signs the days and the balance does not move', async () => {
  const { db, raw } = setup();
  const out = await sign(db, PLANNER, DAYS, -2, 'Short two days.');

  assert.equal(out.signed, 3, 'the days are signed, because that is their job');
  assert.equal(out.daysApplied, 0, 'and nothing has come off his leave');
  assert.equal(applied(raw), 0);
  assert.deepEqual(out.leaveAsked, { id: out.leaveAsked.id, days: -2 });

  const asked = raw.prepare('SELECT * FROM att_leave_change').all();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].days, -2);
  assert.equal(asked[0].was, 0);
  assert.equal(asked[0].status, 'pending');
  assert.match(asked[0].actor, /Jessica/);
  assert.match(asked[0].reason, /Short two days/);
});

test('an administrator signing the same days moves it there and then', async () => {
  const { db, raw } = setup();
  const out = await sign(db, BOSS, DAYS, -2);

  assert.equal(out.daysApplied, -2);
  assert.equal(applied(raw), -2);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM att_leave_change').get().n, 0,
    'and nobody is asked to approve their own figure');
});

test('signing with nothing against the leave asks nobody anything', async () => {
  const { db, raw } = setup();
  const out = await sign(db, PLANNER, DAYS, 0);
  assert.equal(out.leaveAsked, null);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM att_leave_change').get().n, 0);
});

test('re-signing a period does not undo a figure an administrator already set', async () => {
  // The upsert used to overwrite whatever stood there. A planner pressing sign
  // again would have quietly given back days the administrator had charged.
  const { db, raw } = setup();
  await sign(db, BOSS, DAYS, -2);
  await sign(db, PLANNER, DAYS, -2);

  assert.equal(applied(raw), -2, 'still charged');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM att_leave_change').get().n, 0,
    'and asking for what already stands is not a request');
});

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

test('approving is the moment the balance moves', async () => {
  const { db, raw } = setup();
  await sign(db, PLANNER, DAYS, -2);
  const [asked] = (await queue(db)).rows;

  assert.equal(asked.status, 'pending');
  const out = await (await decideLeaveChange(ctx(db, BOSS, { approve: true }), asked.id)).json();

  assert.equal(out.approved, true);
  assert.equal(applied(raw), -2);
  assert.equal(raw.prepare('SELECT status FROM att_leave_change').get().status, 'approved');
});

test('sending it back moves nothing, because nothing had moved', async () => {
  const { db, raw } = setup();
  await sign(db, PLANNER, DAYS, -2);
  const [asked] = (await queue(db)).rows;

  await decideLeaveChange(ctx(db, BOSS, { approve: false, note: 'He was at the clinic.' }), asked.id);

  assert.equal(applied(raw), 0);
  const row = raw.prepare('SELECT * FROM att_leave_change').get();
  assert.equal(row.status, 'refused');
  assert.match(row.decision_note, /clinic/);
});

test('the same request cannot be approved twice', async () => {
  const { db } = setup();
  await sign(db, PLANNER, DAYS, -2);
  const [asked] = (await queue(db)).rows;

  await decideLeaveChange(ctx(db, BOSS, { approve: true }), asked.id);
  await assert.rejects(
    () => decideLeaveChange(ctx(db, BOSS, { approve: true }), asked.id),
    /already been dealt with/,
  );
});

test('a request is refused when somebody has moved the figure since', async () => {
  // Approving what a screen said last week over what the record says today is
  // how two people both charge the same month.
  const { db, raw } = setup();
  await sign(db, PLANNER, DAYS, -2);
  const [asked] = (await queue(db)).rows;

  const review = raw.prepare('SELECT id FROM att_period_review').get().id;
  await changeDaysApplied(ctx(db, BOSS, { daysApplied: -1 }), review);

  await assert.rejects(
    () => decideLeaveChange(ctx(db, BOSS, { approve: true }), asked.id),
    /changed it since/,
  );
  assert.equal(applied(raw), -1, 'and what the administrator set stands');
});

test('the queue is readable by whoever asked and decidable only by an administrator', async () => {
  const { db } = setup();
  await sign(db, PLANNER, DAYS, -2);

  const theirs = await queue(db, PLANNER);
  assert.equal(theirs.pending, 1, 'the person waiting can see they are waiting');
  assert.equal(theirs.canDecide, false);
  assert.equal((await queue(db, BOSS)).canDecide, true);
});

test('correcting a figure afterwards goes the same way', async () => {
  const { db, raw } = setup();
  await sign(db, BOSS, DAYS, -2);
  const review = raw.prepare('SELECT id FROM att_period_review').get().id;

  const out = await (await changeDaysApplied(
    ctx(db, PLANNER, { daysApplied: 0, note: 'He made it up on the Saturday.' }), review,
  )).json();

  assert.equal(out.asked, true);
  assert.equal(out.daysApplied, -2, 'unchanged until somebody says otherwise');
  assert.equal(applied(raw), -2);
  assert.equal(raw.prepare('SELECT days FROM att_leave_change').get().days, 0);
});
