import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { decideLeave, requestLeave, setLeaveType } from '../src/routes/attendance.js';

/**
 * How much of an approved span actually costs somebody a day.
 *
 * Asking for the week and being given it does not mean the whole week comes
 * off the entitlement: two of those days may have been rest days anyway, or
 * the manager may decide to carry part of it. The figure is settled at
 * approval, because that is when a person is looking at it.
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
            DELETE FROM att_leave; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-01')`,
  ).run();
  // Five rostered days, Monday to Friday. The weekend is free anyway.
  for (const day of ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, 1)').run(day);
  }
  return { raw, db: d1(raw) };
}

const ctx = (db, session, body) => ({
  db,
  env: {},
  url: new URL('https://x/api/att/leave'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const PLANNER = { user: { id: 7, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };
const MANAGER = { user: { id: 3, name: 'Ama', role: 'manager' }, permissions: ['att_manage', 'att_rota'] };

const ask = async (db) => {
  const out = await (await requestLeave(ctx(db, PLANNER, {
    staffId: 1, reason: 'annual_leave', from: '2026-06-01', to: '2026-06-05',
  }))).json();
  return out;
};

test('the whole span is charged unless somebody says otherwise', async () => {
  const { db, raw } = setup();
  const asked = await ask(db);
  assert.equal(asked.days, 5);

  await decideLeave(ctx(db, MANAGER, { decision: 'approved' }), asked.id);

  const row = raw.prepare('SELECT * FROM att_leave WHERE id = ?').get(asked.id);
  assert.equal(row.status, 'approved');
  assert.equal(row.days, 5);
});

test('part of the span can be recorded as ordinary rest instead', async () => {
  const { db, raw } = setup();
  const asked = await ask(db);

  const out = await (await decideLeave(
    ctx(db, MANAGER, { decision: 'approved', daysCharged: 3.5 }), asked.id,
  )).json();
  assert.equal(out.charged, 3.5);

  const row = raw.prepare('SELECT * FROM att_leave WHERE id = ?').get(asked.id);
  assert.equal(row.days, 3.5, 'the balance only loses what was charged');
});

test('you cannot charge more than was asked for, or a third of a day', async () => {
  const { db } = setup();
  const asked = await ask(db);

  await assert.rejects(
    () => decideLeave(ctx(db, MANAGER, { decision: 'approved', daysCharged: 6 }), asked.id),
    /between 0 and 5/,
  );
  await assert.rejects(
    () => decideLeave(ctx(db, MANAGER, { decision: 'approved', daysCharged: 1.25 }), asked.id),
    /half days/,
  );
});

test('rejecting leaves the frozen figure alone and says why', async () => {
  const { db, raw } = setup();
  const asked = await ask(db);

  await decideLeave(ctx(db, MANAGER, {
    decision: 'rejected', daysCharged: 1, note: 'Two others are already off.',
  }), asked.id);

  const row = raw.prepare('SELECT * FROM att_leave WHERE id = ?').get(asked.id);
  assert.equal(row.status, 'rejected');
  assert.equal(row.days, 5, 'a rejected request costs nothing and is not quietly rewritten');
  assert.equal(row.decision_note, 'Two others are already off.');
});

test('the person who asked is the one told', async () => {
  const { db, raw } = setup();
  const asked = await ask(db);
  assert.equal(
    raw.prepare('SELECT requested_by_id FROM att_leave WHERE id = ?').get(asked.id).requested_by_id,
    7,
  );

  await decideLeave(ctx(db, MANAGER, { decision: 'approved', daysCharged: 5 }), asked.id);

  const notice = raw.prepare(
    "SELECT * FROM app_notices WHERE kind = 'attendance.leave_decided'",
  ).get();
  assert.equal(notice.user_id, 7);
});

// ---------------------------------------------------------------------------
// What kind of leave it is
// ---------------------------------------------------------------------------

/**
 * The type is the half of a leave record that decides what it costs.
 *
 * Whoever asks picks the option they know the name of. Whether it is paid, and
 * whether it comes off the entitlement, is the property's decision, and until
 * now the only way to change it was to cancel the whole thing and type it in
 * again — which loses who asked, when, and why.
 */

test('the type can be settled at the moment it is approved', async () => {
  const { db, raw } = setup();
  const asked = await ask(db);

  await decideLeave(ctx(db, MANAGER, {
    decision: 'approved', reason: 'unpaid_leave',
  }), asked.id);

  const row = raw.prepare('SELECT * FROM att_leave WHERE id = ?').get(asked.id);
  assert.equal(row.reason_code, 'unpaid_leave');
  assert.equal(row.status, 'approved');
});

test('approving without saying leaves the type as it was asked for', async () => {
  const { db, raw } = setup();
  const asked = await ask(db);
  await decideLeave(ctx(db, MANAGER, { decision: 'approved' }), asked.id);
  assert.equal(
    raw.prepare('SELECT reason_code FROM att_leave WHERE id = ?').get(asked.id).reason_code,
    'annual_leave',
  );
});

test('the type can be changed afterwards, and the days are worked out again', async () => {
  const { db, raw } = setup();
  const asked = await ask(db);
  await decideLeave(ctx(db, MANAGER, { decision: 'approved' }), asked.id);

  // Annual leave is paid and comes off the entitlement. Unpaid is neither.
  const before = raw.prepare(
    "SELECT reason_code FROM att_days WHERE staff_id = 1 AND day = '2026-06-02'",
  ).get();
  assert.equal(before.reason_code, 'annual_leave');

  const out = await (await setLeaveType(
    ctx(db, MANAGER, { reason: 'unpaid_leave' }), asked.id,
  )).json();
  assert.equal(out.reason, 'unpaid_leave');

  assert.equal(
    raw.prepare('SELECT reason_code FROM att_leave WHERE id = ?').get(asked.id).reason_code,
    'unpaid_leave',
  );
  assert.equal(
    raw.prepare("SELECT reason_code FROM att_days WHERE staff_id = 1 AND day = '2026-06-02'")
      .get().reason_code,
    'unpaid_leave',
    'the days follow, so the pay and the balance follow',
  );
});

test('a pending request can be retyped before anybody decides it', async () => {
  const { db, raw } = setup();
  const asked = await (await requestLeave(ctx(db, PLANNER, {
    staffId: 1, reason: 'annual_leave', from: '2026-06-01', to: '2026-06-05',
  }))).json();
  assert.equal(asked.status, 'pending');

  await setLeaveType(ctx(db, MANAGER, { reason: 'sick_leave' }), asked.id);

  const row = raw.prepare('SELECT * FROM att_leave WHERE id = ?').get(asked.id);
  assert.equal(row.reason_code, 'sick_leave');
  assert.equal(row.status, 'pending', 'retyping is not deciding');
});

test('only a kind of leave will do', async () => {
  const { db } = setup();
  const asked = await ask(db);

  // A verdict about a day worked is not a kind of leave.
  await assert.rejects(
    () => setLeaveType(ctx(db, MANAGER, { reason: 'late' }), asked.id),
    /not a kind of leave/,
  );
  await assert.rejects(
    () => setLeaveType(ctx(db, MANAGER, { reason: 'nonsense' }), asked.id),
    /no such type of leave/i,
  );
  await assert.rejects(
    () => decideLeave(ctx(db, MANAGER, { decision: 'approved', reason: 'absent' }), asked.id),
    /not a kind of leave/,
  );
});

test('a retired type is not offered, even by hand', async () => {
  const { db, raw } = setup();
  raw.prepare("UPDATE att_reasons SET active = 0 WHERE code = 'compassionate'").run();
  const asked = await ask(db);

  await assert.rejects(
    () => setLeaveType(ctx(db, MANAGER, { reason: 'compassionate' }), asked.id),
    /not offered any more/,
  );
});

test('the same type again changes nothing and says so quietly', async () => {
  const { db, raw } = setup();
  const asked = await ask(db);
  const out = await (await setLeaveType(
    ctx(db, MANAGER, { reason: 'annual_leave' }), asked.id,
  )).json();
  assert.equal(out.ok, true);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM app_notices').get().n, 0,
    'nobody is told about a change that did not happen');
});

test('a rejected request keeps the type it was asked with', async () => {
  const { db } = setup();
  const asked = await ask(db);
  await decideLeave(ctx(db, MANAGER, { decision: 'rejected', note: 'Short-staffed' }), asked.id);

  await assert.rejects(
    () => setLeaveType(ctx(db, MANAGER, { reason: 'unpaid_leave' }), asked.id),
    /record of what was asked for/,
  );
});

test('the person is told what their leave is now recorded as', async () => {
  const { db, raw } = setup();
  const asked = await ask(db);
  await decideLeave(ctx(db, MANAGER, { decision: 'approved' }), asked.id);
  await setLeaveType(ctx(db, MANAGER, { reason: 'unpaid_leave' }), asked.id);

  const notice = raw.prepare(
    "SELECT * FROM app_notices WHERE kind = 'attendance.leave_type'",
  ).get();
  assert.ok(notice, 'it may have changed what they are paid');
  assert.match(notice.title, /unpaid leave/);
  assert.match(notice.body, /changed from annual leave/);
  assert.match(notice.body, /It is unpaid\./);
});
