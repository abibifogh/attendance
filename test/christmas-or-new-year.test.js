import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  board, choose, confirm, mine, officePick, remind, removeRound, saveRound, suggestion,
} from '../src/routes/holiday-choice.js';
import { KINDS } from '../src/lib/notice-kinds.js';

/**
 * Christmas or New Year: everybody on the rota except casual staff chooses
 * which holiday they have off. Places in each department go to whoever answers
 * first; confirming writes each choice as leave, a day that is not a public
 * holiday comes off annual leave, and everybody is told. Made-up people only.
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
            DELETE FROM users; DELETE FROM att_holidays;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  const people = [
    [1, 'Desk One', 'Front office'],
    [2, 'Desk Two', 'Front office'],
    [3, 'Desk Three', 'Front office'],
    [4, 'Cook Four', 'Kitchen'],
    [5, 'Casual Five', 'Kitchen'],
  ];
  for (const [id, name, dept] of people) {
    raw.prepare(
      "INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (?, ?, ?, ?, '2020-01-01')",
    ).run(id, String(id), name, dept);
    raw.prepare(
      "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (?, ?, 'staff', ?, ?, 1)",
    ).run(10 + id, name, `pin${id}`, id);
  }
  raw.prepare("INSERT INTO hr_pay (staff_id, basis, amount, from_day) VALUES (5, 'daily', 1, '2020-01-01')").run();
  // Boxing Day on a Saturday is observed on the Monday; the Saturday is still a holiday.
  raw.exec(`INSERT INTO att_holidays (day, name, observed_on) VALUES
    ('2099-12-25', 'Christmas Day', NULL),
    ('2099-12-26', 'Boxing Day', '2099-12-28'),
    ('2100-01-01', 'New Year''s Day', NULL);`);
  return { raw, db: d1(raw) };
}

const as = (id, name) => ({ user: { id: 10 + id, name, role: 'staff', staff_id: id }, permissions: ['att_me'] });
const ONE = as(1, 'Desk One');
const TWO = as(2, 'Desk Two');
const THREE = as(3, 'Desk Three');
const CASUAL = as(5, 'Casual Five');
const OFFICE = { user: { id: 2, name: 'Off Ice', role: 'manager' }, permissions: ['att_manage', 'att_view'] };

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

const ROUND = (extra = {}) => ({
  title: 'Christmas or New Year 2099',
  dueOn: '2099-11-20',
  mode: 'first',
  unanswered: 'room',
  remind: true,
  chargeLeave: true,
  options: [
    { label: 'Christmas', from: '2099-12-25', to: '2099-12-26', limits: { 'Front office': 1, Kitchen: 1 } },
    { label: 'New Year', from: '2100-01-01', to: '2100-01-02', limits: { 'Front office': 2, Kitchen: 1 } },
  ],
  ...extra,
});

async function opened(db, extra = {}) {
  const out = await read(saveRound(ctx(db, OFFICE, { ...ROUND(extra), open: true })));
  const b = await read(board(ctx(db, OFFICE)));
  const [christmas, newYear] = b.round.options;
  return { id: out.id, out, christmas, newYear };
}

test('a new one starts as Christmas and New Year, half of each department on each', async () => {
  const { db } = setup();
  const s = await read(suggestion(ctx(db, OFFICE)));
  assert.match(s.title, /^Christmas or New Year \d{4}$/);
  assert.deepEqual(s.options.map((o) => [o.label, o.from.slice(5), o.to.slice(5)]),
    [['Christmas', '12-25', '12-26'], ['New Year', '01-01', '01-02']]);
  // Casual staff are not asked, so not counted.
  assert.deepEqual(s.departments, [{ name: 'Front office', people: 3 }, { name: 'Kitchen', people: 1 }]);
  assert.deepEqual(s.options[0].limits, { 'Front office': 1, Kitchen: 0 });
  assert.deepEqual(s.options[1].limits, { 'Front office': 2, Kitchen: 1 });
});

test('asking tells everybody on the rota but casual staff, by phone and email', async () => {
  const { raw, db } = setup();
  const { out } = await opened(db);
  assert.equal(out.asked, 4);
  const told = raw.prepare("SELECT user_id FROM app_notices WHERE kind = 'leave.holiday_asked' ORDER BY user_id").all()
    .map((r) => r.user_id);
  assert.deepEqual(told, [11, 12, 13, 14]);
  assert.ok(KINDS.some((k) => k.key === 'leave.holiday_asked'));
  assert.ok(KINDS.some((k) => k.key === 'leave.holiday_confirmed'));
  const casual = await read(mine(ctx(db, CASUAL)));
  assert.equal(casual.round, null);
  assert.equal(casual.asked, false);
});

test('first come, first served: a full choice says so and cannot be picked', async () => {
  const { db } = setup();
  const { christmas, newYear } = await opened(db);
  let me = await read(mine(ctx(db, ONE)));
  assert.equal(me.round.open, true);
  assert.deepEqual(me.options.map((o) => [o.label, o.left]), [['Christmas', 1], ['New Year', 2]]);

  await read(choose(ctx(db, ONE, { optionId: christmas.id })));
  me = await read(mine(ctx(db, TWO)));
  assert.equal(me.options[0].full, true);
  // Places, never names: nothing about who else chose.
  assert.equal(JSON.stringify(me).includes('Desk One'), false);
  await assert.rejects(choose(ctx(db, TWO, { optionId: christmas.id })), /Christmas is full in Front office/);
  await read(choose(ctx(db, TWO, { optionId: newYear.id })));

  // The one who has it can still change and come back.
  me = await read(mine(ctx(db, ONE)));
  assert.equal(me.choice, christmas.id);
  assert.equal(me.options[0].full, false);
});

test('after the date to answer, a change goes through the office', async () => {
  const { db } = setup();
  const { christmas } = await opened(db, { dueOn: '2020-01-01' });
  await assert.rejects(choose(ctx(db, ONE, { optionId: christmas.id })), /date to answer has passed/);
  await read(officePick(ctx(db, OFFICE, { staffId: 1, optionId: christmas.id }, ''), String((await read(board(ctx(db, OFFICE)))).round.id)));
  const b = await read(board(ctx(db, OFFICE)));
  assert.equal(b.people.find((p) => p.id === 1).optionId, christmas.id);
  assert.equal(b.people.find((p) => p.id === 1).byOffice, true);
});

test('when the office decides, a department over its places stops confirming until somebody moves', async () => {
  const { db } = setup();
  const { id, christmas, newYear } = await opened(db, { mode: 'decide' });
  await read(choose(ctx(db, ONE, { optionId: christmas.id })));
  await read(choose(ctx(db, TWO, { optionId: christmas.id })));
  let b = await read(board(ctx(db, OFFICE)));
  assert.match(b.problems.join(' '), /Front office has 2 on Christmas and 1 place. Move 1/);
  await assert.rejects(confirm(ctx(db, OFFICE), String(id)), /Move 1/);
  await read(officePick(ctx(db, OFFICE, { staffId: 2, optionId: newYear.id }), String(id)));
  b = await read(board(ctx(db, OFFICE)));
  assert.deepEqual(b.problems, []);
});

test('confirming writes leave: public holidays cost nothing, 2 January comes off annual leave', async () => {
  const { raw, db } = setup();
  const { id, christmas, newYear } = await opened(db);
  await read(choose(ctx(db, ONE, { optionId: christmas.id })));
  await read(choose(ctx(db, TWO, { optionId: newYear.id })));
  // Desk Three and Cook Four never answer: each is given the choice with room.
  const out = await read(confirm(ctx(db, OFFICE), String(id)));
  assert.equal(out.written, 4);
  assert.deepEqual(out.given.sort(), ['Cook Four', 'Desk Three']);

  const leave = raw.prepare(
    "SELECT staff_id, reason_code, from_day, to_day, days, status, reason FROM att_leave ORDER BY staff_id",
  ).all();
  assert.deepEqual(leave.map((l) => [l.staff_id, l.from_day, l.days, l.status, l.reason_code]), [
    [1, '2099-12-25', 0, 'approved', 'holiday_choice'],
    [2, '2100-01-01', 1, 'approved', 'holiday_choice'],
    [3, '2100-01-01', 1, 'approved', 'holiday_choice'],
    [4, '2099-12-25', 0, 'approved', 'holiday_choice'],
  ]);
  assert.match(leave[0].reason, /^Christmas · Christmas or New Year 2099$/);
  // The leave kind is not one staff can ask for themselves.
  const reason = raw.prepare("SELECT deducts_leave, staff_pick, selectable FROM att_reasons WHERE code = 'holiday_choice'").get();
  assert.deepEqual({ ...reason }, { deducts_leave: 1, staff_pick: 0, selectable: 0 });

  const told = raw.prepare("SELECT user_id, title, body FROM app_notices WHERE kind = 'leave.holiday_confirmed' ORDER BY user_id").all();
  assert.equal(told.length, 4);
  assert.match(told[0].title, /^Christmas off/);
  assert.match(told[0].body, /You work New Year/);
  assert.match(told[0].body, /Nothing comes off your annual leave/);
  assert.match(told[1].body, /1 day comes off your annual leave/);

  const me = await read(mine(ctx(db, ONE)));
  assert.equal(me.round.status, 'confirmed');
  assert.equal(me.round.open, false);
  await assert.rejects(confirm(ctx(db, OFFICE), String(id)), /confirmed already/);
  await assert.rejects(removeRound(ctx(db, OFFICE), String(id)), /confirmed/);
});

test('with annual leave left alone, nothing is charged', async () => {
  const { raw, db } = setup();
  const { id, newYear } = await opened(db, { chargeLeave: false });
  await read(choose(ctx(db, ONE, { optionId: newYear.id })));
  await read(confirm(ctx(db, OFFICE), String(id)));
  assert.equal(raw.prepare('SELECT SUM(days) AS n FROM att_leave').get().n, 0);
});

test('somebody who already has leave over those days keeps it, and is reported', async () => {
  const { raw, db } = setup();
  const { id, christmas } = await opened(db);
  raw.prepare("INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status) VALUES (1, 'annual_leave', '2099-12-20', '2099-12-31', 5, 'approved')").run();
  await read(choose(ctx(db, ONE, { optionId: christmas.id })));
  const out = await read(confirm(ctx(db, OFFICE), String(id)));
  assert.deepEqual(out.skipped, ['Desk One']);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM att_leave WHERE staff_id = 1").get().n, 1);
});

test('nobody unanswered may be left for the office when the office said it would choose', async () => {
  const { db } = setup();
  const { id } = await opened(db, { unanswered: 'office' });
  await assert.rejects(confirm(ctx(db, OFFICE), String(id)), /4 people have not answered/);
});

test('a reminder goes only to whoever has not answered', async () => {
  const { raw, db } = setup();
  const { id, christmas } = await opened(db);
  await read(choose(ctx(db, ONE, { optionId: christmas.id })));
  raw.exec('DELETE FROM app_notices');
  const out = await read(remind(ctx(db, OFFICE), String(id)));
  assert.equal(out.reminded, 3);
  const told = raw.prepare("SELECT user_id FROM app_notices WHERE kind = 'leave.holiday_asked'").all().map((r) => r.user_id);
  assert.equal(told.includes(11), false);
});

test('choices are checked: two at least, in order, not overlapping, answered before they start', async () => {
  const { db } = setup();
  await assert.rejects(saveRound(ctx(db, OFFICE, { ...ROUND(), options: ROUND().options.slice(0, 1) })), /at least two/);
  await assert.rejects(saveRound(ctx(db, OFFICE, ROUND({ dueOn: '2099-12-30' }))), /due after Christmas has started/);
  const overlap = ROUND();
  overlap.options[1] = { ...overlap.options[1], from: '2099-12-26' };
  await assert.rejects(saveRound(ctx(db, OFFICE, overlap)), /overlap/);
  await read(saveRound(ctx(db, OFFICE, ROUND())));
  await assert.rejects(saveRound(ctx(db, OFFICE, ROUND())), /already a holiday choice under way/);
});

test('a choice somebody has picked cannot be taken away', async () => {
  const { db } = setup();
  const { id, christmas, newYear } = await opened(db);
  await read(choose(ctx(db, ONE, { optionId: christmas.id })));
  const again = ROUND({ id });
  again.options = [{ ...again.options[1], id: newYear.id }, { label: 'Easter', from: '2100-04-01', to: '2100-04-02' }];
  await assert.rejects(saveRound(ctx(db, OFFICE, again)), /Christmas has been chosen already/);
});
