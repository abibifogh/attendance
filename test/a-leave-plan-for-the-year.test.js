import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  addBlock, approveClear, board, chase, decideBlock, myPlan, removeBlock, saveRound, sendPlan, takeSuggestion,
} from '../src/routes/leave-plans.js';
import { defaultYear, watchLeavePlans } from '../src/lib/leave-plans.js';
import { KINDS } from '../src/lib/notice-kinds.js';

/**
 * A leave plan for the year: asked for once, planned around the busy seasons
 * and the weeks a department is already full, approved in one place.
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
            DELETE FROM att_leave; DELETE FROM app_notices; DELETE FROM push_subscriptions;
            DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  const people = [
    [1, 'Desk One', 'Front desk'],
    [2, 'Desk Two', 'Front desk'],
    [3, 'House Three', 'Housekeeping'],
    [4, 'Casual Four', 'Housekeeping'],
  ];
  for (const [id, name, dept] of people) {
    raw.prepare(
      "INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (?, ?, ?, ?, '2020-01-01')",
    ).run(id, String(id), name, dept);
    raw.prepare(
      "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (?, ?, 'staff', ?, ?, 1)",
    ).run(10 + id, name, `pin${id}`, id);
  }
  raw.prepare("INSERT INTO hr_pay (staff_id, basis, amount, from_day) VALUES (4, 'daily', 1, '2020-01-01')").run();
  return { raw, db: d1(raw) };
}

const as = (id, name) => ({ user: { id: 10 + id, name, role: 'staff', staff_id: id }, permissions: ['att_me'] });
const ONE = as(1, 'Desk One');
const TWO = as(2, 'Desk Two');
const ADMIN = { user: { id: 2, name: 'Ad Min', role: 'admin' }, permissions: ['att_setup', 'att_manage', 'att_rota'] };

const ctx = (db, session, body = {}, query = '') => ({
  db,
  env: {},
  url: new URL(`https://x/api/x${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
});
const read = async (p) => (await p).json();

const ROUND = {
  year: 2027,
  opensOn: '2027-01-04',
  dueOn: '2027-01-31',
  minDays: 5,
  busy: [{ from: '2027-12-20', to: '2028-01-02', label: 'Christmas and New Year' }],
  limits: { 'Front desk': 1, Housekeeping: 2 },
  open: true,
};

function clock(t, stamp) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(`${stamp}:00Z`) });
  return (next) => t.mock.timers.setTime(Date.parse(`${next}:00Z`));
}

test('next year from October on', () => {
  assert.equal(defaultYear('2026-10-18'), 2027);
  assert.equal(defaultYear('2027-01-05'), 2027);
});

test('opening planning asks everybody who earns leave, and not the casual staff', async (t) => {
  const { db, raw } = setup();
  clock(t, '2027-01-04T10:00');
  const out = await read(saveRound(ctx(db, ADMIN, ROUND)));
  assert.equal(out.open, true);
  assert.equal(out.invited, 3);
  const asked = raw.prepare("SELECT user_id FROM app_notices WHERE kind = 'leave.plan_asked' ORDER BY user_id").all();
  assert.deepEqual(asked.map((r) => r.user_id), [11, 12, 13]);
  const notice = raw.prepare("SELECT * FROM app_notices WHERE kind = 'leave.plan_asked'").get();
  assert.ok(!/\b(he|she|his|her)\b/i.test(`${notice.title} ${notice.body}`));
});

test('saved without opening asks nobody', async (t) => {
  const { db, raw } = setup();
  clock(t, '2027-01-04T10:00');
  await saveRound(ctx(db, ADMIN, { ...ROUND, open: false }));
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM app_notices WHERE kind = 'leave.plan_asked'").get().n, 0);
  assert.equal((await read(myPlan(ctx(db, ONE)))).round, null);
});

test('a person plans around a week the department already has, and sends the plan', async (t) => {
  const { db, raw } = setup();
  clock(t, '2027-01-04T10:00');
  await saveRound(ctx(db, ADMIN, ROUND));

  let mine = await read(myPlan(ctx(db, ONE)));
  assert.equal(mine.eligible, true);
  assert.equal(mine.round.limit, 1);
  assert.equal(mine.plan.status, 'draft');

  const added = await read(addBlock(ctx(db, ONE, { from: '2027-04-12', to: '2027-04-23' })));
  assert.equal(added.days, 10, 'two weeks off, weekends not counted');
  await assert.rejects(addBlock(ctx(db, ONE, { from: '2027-04-20', to: '2027-04-21' })), /overlaps/);

  // Too little to send yet.
  raw.prepare('UPDATE leave_plan_round SET min_days = 40').run();
  await assert.rejects(sendPlan(ctx(db, ONE)), /Plan at least/);
  raw.prepare('UPDATE leave_plan_round SET min_days = 5').run();
  await read(sendPlan(ctx(db, ONE)));

  // The colleague sees those days as full, and is warned when picking them.
  const theirs = await read(myPlan(ctx(db, TWO)));
  assert.ok(theirs.fullDays.includes('2027-04-14'));
  const warned = await read(addBlock(ctx(db, TWO, { from: '2027-04-19', to: '2027-04-23' })));
  assert.match(warned.warning, /Front desk is full/);

  mine = await read(myPlan(ctx(db, ONE)));
  assert.equal(mine.plan.status, 'sent');
});

test('the board shows the clash, and approving the clear ones leaves it to settle', async (t) => {
  const { db, raw } = setup();
  clock(t, '2027-01-04T10:00');
  await saveRound(ctx(db, ADMIN, ROUND));
  await addBlock(ctx(db, ONE, { from: '2027-04-12', to: '2027-04-16' }));
  await addBlock(ctx(db, ONE, { from: '2027-08-02', to: '2027-08-06' }));
  await sendPlan(ctx(db, ONE));
  await addBlock(ctx(db, TWO, { from: '2027-04-12', to: '2027-04-16' }));
  await addBlock(ctx(db, TWO, { from: '2027-12-20', to: '2027-12-24' }));
  await sendPlan(ctx(db, TWO));

  const state = await read(board(ctx(db, ADMIN, {}, '?year=2027')));
  assert.equal(state.counts.eligible, 3);
  assert.equal(state.counts.sent, 2);
  assert.equal(state.notSent[0].name, 'House Three');
  // Both April blocks are over the limit of one: one clash to settle, with
  // whoever sent last named. December is a busy season.
  assert.equal(state.clashes.length, 2);
  const april = state.clashes.find((c) => c.kind === 'limit');
  assert.deepEqual(april.people.map((p) => p.name).sort(), ['Desk One', 'Desk Two']);
  assert.equal(april.away, 2);
  assert.equal(april.sentLast.name, 'Desk Two');
  const dec = state.clashes.find((c) => c.kind === 'busy');
  assert.equal(dec.from, '2027-12-20', 'the block keeps its own dates');
  assert.equal(dec.busyFrom, '2027-12-20');
  assert.equal(state.notSent[0].reachable, true);

  const out = await read(approveClear(ctx(db, ADMIN, { year: 2027 })));
  assert.equal(out.approved, 1, 'only August is clear');
  const leave = raw.prepare('SELECT * FROM att_leave').all();
  assert.equal(leave.length, 1);
  assert.equal(leave[0].status, 'approved');
  assert.equal(leave[0].reason_code, 'annual_leave');
  assert.equal(leave[0].from_day, '2027-08-02');
});

test('ask to move with other dates; one tap takes them; the plan is reviewed once nothing waits', async (t) => {
  const { db, raw } = setup();
  clock(t, '2027-01-04T10:00');
  await saveRound(ctx(db, ADMIN, ROUND));
  await addBlock(ctx(db, ONE, { from: '2027-04-12', to: '2027-04-16' }));
  await sendPlan(ctx(db, ONE));
  const [block] = raw.prepare('SELECT * FROM leave_plan_block').all();

  await assert.rejects(decideBlock(ctx(db, ADMIN, { decision: 'move' }), String(block.id)), /Say why/);
  const moved = await read(decideBlock(ctx(db, ADMIN, {
    decision: 'move', note: 'Front desk is short that week.', suggestFrom: '2027-04-19', suggestTo: '2027-04-23',
  }), String(block.id)));
  assert.equal(moved.reviewed, true);
  const told = raw.prepare("SELECT * FROM app_notices WHERE kind = 'leave.plan_reviewed'").get();
  assert.equal(told.user_id, 11);

  await takeSuggestion(ctx(db, ONE), String(block.id));
  const after = raw.prepare('SELECT * FROM leave_plan_block WHERE id = ?').get(block.id);
  assert.equal(after.from_day, '2027-04-19');
  assert.equal(after.status, 'planned');
  assert.equal(raw.prepare('SELECT status FROM leave_plan').get().status, 'sent');

  await decideBlock(ctx(db, ADMIN, { decision: 'approve' }), String(block.id));
  assert.equal(raw.prepare('SELECT status FROM leave_plan').get().status, 'reviewed');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM att_leave WHERE status = 'approved'").get().n, 1);
  await assert.rejects(removeBlock(ctx(db, ONE), String(block.id)), /already decided/);
});

test('reminders on Mondays, every day in the last week, and a manager can chase', async (t) => {
  const { db, raw } = setup();
  const set = clock(t, '2027-01-04T10:00');
  await saveRound(ctx(db, ADMIN, ROUND));
  await addBlock(ctx(db, ONE, { from: '2027-04-12', to: '2027-04-16' }));
  await sendPlan(ctx(db, ONE));
  const reminders = () => raw.prepare("SELECT COUNT(*) AS n FROM app_notices WHERE kind = 'leave.plan_asked' AND level = 'warn'").get().n;

  set('2027-01-05T10:00'); // a Tuesday
  assert.equal((await watchLeavePlans(db, { timezone: 'UTC' })).reminded, 0);
  set('2027-01-11T08:00'); // Monday, before nine
  assert.equal((await watchLeavePlans(db, { timezone: 'UTC' })).reminded, 0);
  set('2027-01-11T09:30');
  assert.equal((await watchLeavePlans(db, { timezone: 'UTC' })).reminded, 2, 'the two who have not sent');
  assert.equal((await watchLeavePlans(db, { timezone: 'UTC' })).reminded, 0, 'once a day');
  set('2027-01-27T10:00'); // a Wednesday in the last week
  assert.equal((await watchLeavePlans(db, { timezone: 'UTC' })).reminded, 2);
  set('2027-02-01T10:00'); // past the date
  assert.equal((await watchLeavePlans(db, { timezone: 'UTC' })).reminded, 0);
  assert.equal(reminders(), 4);

  const chased = await read(chase(ctx(db, ADMIN, { year: 2027 })));
  assert.equal(chased.reminded, 2);
});

test('a round opening on a later day invites on that day', async (t) => {
  const { db, raw } = setup();
  const set = clock(t, '2026-12-01T10:00');
  const out = await read(saveRound(ctx(db, ADMIN, ROUND)));
  assert.equal(out.invited, 0);
  set('2027-01-04T09:15');
  assert.equal((await watchLeavePlans(db, { timezone: 'UTC' })).invited, 3);
  assert.equal((await watchLeavePlans(db, { timezone: 'UTC' })).invited, 0);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM app_notices WHERE kind = 'leave.plan_asked'").get().n, 3);
});

test('the leave plan notices are listed with the others', () => {
  const keys = new Set(KINDS.map((k) => k.key));
  for (const k of ['leave.plan_asked', 'leave.plan_reviewed', 'leave.plan_department_in']) assert.ok(keys.has(k), k);
});
