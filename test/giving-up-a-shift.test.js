import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { loadDataset } from '../src/lib/attendance.js';
import {
  findingsForSwap, goesStraightThrough, offerable, swapRules, tooLate, whoCanCover, whyNot,
} from '../src/lib/swaps.js';
import {
  decideSwap, dropSwap, offerSwap, swapBoard, swapQueue, takeSwap, whatICanOffer,
} from '../src/routes/swaps.js';

/**
 * Giving up a shift, and taking one.
 *
 * What this replaces is a phone call: I cannot do Saturday, do you know
 * anybody, let me ask around, ring me back. It ended with a supervisor editing
 * the grid on somebody's word, and no record of who had agreed to what.
 *
 * THE RULE THIS FILE EXISTS FOR IS THAT THE ROTA CHANGES ONCE. Offering does
 * nothing to it. Taking does nothing to it. A shift half-attached to two
 * people is the state a rota must never be in, and every test below that pokes
 * at the middle of the sequence is checking that it never is.
 *
 * The second rule is that every check is asked twice. A fortnight is long
 * enough for the week to be rebuilt, the shift deleted, the person put on
 * something else or the day signed off, and the approval is the one that
 * writes, so the approval is the one that has to look again.
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

// Far enough ahead that nothing here is ever "too late", whatever day the
// suite runs on.
const soon = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return d.toISOString().slice(0, 10);
};
const SAT = soon(10);
const SUN = soon(11);
const MON = soon(12);

const TEAM = [
  { id: 1, name: 'Regina Sampson', department: 'F&B' },
  { id: 2, name: 'Doreen Aitee', department: 'F&B' },
  { id: 3, name: 'Henry Aryee', department: 'F&B' },
  { id: 4, name: 'Kojo Mensah', department: 'Housekeeping' },
];

function setup({ on = true, approval = 'always', notice = 24, cap = 0 } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_leave; DELETE FROM att_availability; DELETE FROM att_swap;
            DELETE FROM att_period_review; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");

  const set = (key, value) => raw.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2',
  ).run(key, String(value));
  set('swaps_on', on ? '1' : '0');
  set('swap_approval', approval);
  set('swap_notice_hours', notice);
  set('swap_monthly_cap', cap);

  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, department)
     VALUES (1, 'Breakfast', '06:00', '14:00', 0, 'F&B'),
            (2, 'Evening', '14:00', '22:00', 0, 'F&B'),
            (3, 'Rooms', '08:00', '16:00', 0, 'Housekeeping'),
            (4, 'Night', '22:00', '06:00', 0, 'F&B'),
            (5, 'Lunch', '12:00', '20:00', 0, 'F&B')`,
  ).run();

  for (const p of TEAM) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on, active)
       VALUES (?, ?, ?, ?, '2020-01-01', 1)`,
    ).run(p.id, String(p.id), p.name, p.department);
    raw.prepare(
      'INSERT INTO users (id, name, role, active, staff_id) VALUES (?, ?, ?, 1, ?)',
    ).run(100 + p.id, p.name, 'staff', p.id);
  }
  raw.prepare(
    "INSERT INTO users (id, name, role, permissions, active) VALUES (99, 'Yaa', 'manager', ?, 1)",
  ).run(JSON.stringify(['att_view', 'att_rota']));

  return { raw, db: d1(raw) };
}

/** A published shift on the rota, returning its row id. */
const rota = (raw, staffId, day, shiftId = 1, published = 1) => Number(raw.prepare(
  `INSERT INTO att_roster (staff_id, day, shift_id, set_by, published, ever_published)
   VALUES (?, ?, ?, 'test', ?, ?) RETURNING id`,
).get(staffId, day, shiftId, published, published).id);

const asStaff = (id) => ({
  user: { id: 100 + id, name: TEAM.find((p) => p.id === id).name, role: 'staff', staff_id: id },
  permissions: ['att_me'],
});
const asPlanner = () => ({
  user: { id: 99, name: 'Yaa', role: 'manager' },
  permissions: ['att_view', 'att_rota'],
});

const ctx = (db, session, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/swaps${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', body
    ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
    : {}),
});

const board = async (db, id) => (await swapBoard(ctx(db, asStaff(id)))).json();
const offer = async (db, id, body) => (await offerSwap(ctx(db, asStaff(id), { body }))).json();
const take = async (db, id, swapId) => (await takeSwap(ctx(db, asStaff(id), { body: {} }), swapId)).json();
const drop = async (db, id, swapId) => (await dropSwap(ctx(db, asStaff(id), { body: {} }), swapId)).json();
const queue = async (db) => (await swapQueue(ctx(db, asPlanner()))).json();
const decide = async (db, swapId, body) => (
  await decideSwap(ctx(db, asPlanner(), { body }), swapId)
).json();

const dataset = (db) => loadDataset(db, { from: soon(-20), to: soon(40), now: `${soon(0)} 09:00` });

// ---------------------------------------------------------------------------
// The rules, on their own
// ---------------------------------------------------------------------------

test('the rules are off and conservative until the property says otherwise', () => {
  assert.deepEqual(swapRules({}), {
    on: false, noticeHours: 24, approval: 'always', crossDepartment: false, monthlyCap: 0,
  });
  assert.deepEqual(swapRules({
    swaps_on: '1', swap_notice_hours: '48', swap_approval: 'clean',
    swap_cross_department: '1', swap_monthly_cap: '3',
  }), {
    on: true, noticeHours: 48, approval: 'clean', crossDepartment: true, monthlyCap: 3,
  });
  // A typo in the approval setting must not be the thing that stops a manager
  // seeing a swap.
  assert.equal(swapRules({ swap_approval: 'sometimes' }).approval, 'always');
});

test('too late is counted from when the shift starts, not from midnight', () => {
  const night = { starts_at: '22:00', ends_at: '06:00' };
  // Ten in the morning on the day of a ten-at-night shift is twelve hours off.
  assert.equal(tooLate('2099-03-04', night, '2099-03-04 10:00', 24), true);
  assert.equal(tooLate('2099-03-04', night, '2099-03-04 10:00', 6), false);
  // And the day before is a day and a half, which clears a 24-hour rule that
  // counting off the date would have failed.
  assert.equal(tooLate('2099-03-04', night, '2099-03-03 09:00', 24), false);
});

// ---------------------------------------------------------------------------
// Who could take it
// ---------------------------------------------------------------------------

test('somebody in another department cannot take it, and is told why', async () => {
  const { db, raw } = setup();
  rota(raw, 1, SAT, 1);
  const ds = await dataset(db);
  const shift = ds.shiftById.get(1);

  assert.equal(whyNot(ds, ds.staffById.get(2), SAT, shift, { rules: swapRules(ds.settings) }), null);
  assert.match(
    whyNot(ds, ds.staffById.get(4), SAT, shift, { rules: swapRules(ds.settings) }),
    /do not work in F&B/,
  );
});

test('somebody already working across those hours cannot take it', async () => {
  const { db, raw } = setup();
  rota(raw, 1, SAT, 1);
  rota(raw, 2, SAT, 5);                        // Doreen is on lunch, 12 to 8
  const ds = await dataset(db);

  assert.match(
    whyNot(ds, ds.staffById.get(2), SAT, ds.shiftById.get(1), {}),
    /already on Lunch/,
  );
  // And a second shift that does not overlap is a double, which the property
  // allows and the findings account for. It is not this rule's business.
  assert.equal(whyNot(ds, ds.staffById.get(3), SAT, ds.shiftById.get(1), {}), null);
});

test('a night that runs into the morning is in the way of the morning', async () => {
  const { db, raw } = setup();
  // Henry is on the night before, finishing at six, and the shift going is a
  // breakfast starting at six.
  rota(raw, 3, soon(9), 4);
  const ds = await dataset(db);

  const why = whyNot(ds, ds.staffById.get(3), SAT, ds.shiftById.get(1), {});
  assert.equal(why, null, 'six to six is a clean handover, not an overlap');

  // But a shift that genuinely overlaps is refused.
  const overlapping = { ...ds.shiftById.get(1), starts_at: '05:00' };
  assert.match(whyNot(ds, ds.staffById.get(3), SAT, overlapping, {}), /runs into it/);
});

test('leave and a day somebody has said they cannot work both count', async () => {
  const { db, raw } = setup();
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status, requested_by)
     VALUES (2, 'annual_leave', ?, ?, 1, 'approved', 'test')`,
  ).run(SAT, SAT);
  const ds = await dataset(db);
  const shift = ds.shiftById.get(1);

  assert.match(whyNot(ds, ds.staffById.get(2), SAT, shift, {}), /on leave/);
  assert.match(
    whyNot(ds, ds.staffById.get(3), SAT, shift, { away: new Set([`3|${SAT}`]) }),
    /cannot work that day/,
  );
});

test('who can cover leaves out the person giving it up', async () => {
  const { db, raw } = setup();
  rota(raw, 1, SAT, 1);
  const ds = await dataset(db);

  const can = whoCanCover(ds, { day: SAT, shift: ds.shiftById.get(1), exceptStaffId: 1 });
  assert.deepEqual(can.map((p) => p.name), ['Doreen Aitee', 'Henry Aryee']);
});

// ---------------------------------------------------------------------------
// What it would do to the fortnight
// ---------------------------------------------------------------------------

test('a swap that leaves eight hours between two shifts says so, loudly', async () => {
  const { db, raw } = setup();
  // Regina is on the Saturday evening. Doreen is on the Sunday breakfast, so
  // taking Regina's evening leaves her eight hours to sleep.
  rota(raw, 1, SAT, 2);
  rota(raw, 2, SUN, 1);
  const ds = await dataset(db);

  const findings = findingsForSwap(ds, {
    from: ds.staffById.get(1),
    to: ds.staffById.get(2),
    day: SAT,
    shift: ds.shiftById.get(2),
  });
  assert.equal(findings[0].level, 'high');
  assert.match(findings[0].text, /Doreen Aitee would finish Evening and start Breakfast 8 hours/);
});

test('and a swap that changes nothing says nothing', async () => {
  const { db, raw } = setup();
  rota(raw, 1, SAT, 1);
  const ds = await dataset(db);

  const findings = findingsForSwap(ds, {
    from: ds.staffById.get(1), to: ds.staffById.get(2), day: SAT, shift: ds.shiftById.get(1),
  });
  assert.deepEqual(findings.filter((f) => f.level !== 'ok'), []);
  assert.equal(goesStraightThrough({ approval: 'clean' }, findings), true);
  assert.equal(goesStraightThrough({ approval: 'always' }, findings), false);
});

test('a draft shift is not one anybody can offer', async () => {
  const { db, raw } = setup();
  rota(raw, 1, SAT, 1, 0);
  const ds = await dataset(db);

  assert.deepEqual(
    offerable(ds, 1, { from: SAT, to: SAT, now: `${soon(0)} 09:00`, rules: swapRules(ds.settings) }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Putting one up
// ---------------------------------------------------------------------------

test('a shift goes on the board and the people who can cover it are counted', async () => {
  const { db, raw } = setup();
  const id = rota(raw, 1, SAT, 1);

  const out = await offer(db, 1, { rosterId: id, reason: 'Funeral in Ho.' });
  assert.equal(out.ok, true);
  assert.equal(out.told, 2, 'Doreen and Henry, not the housekeeper');

  const seen = await board(db, 2);
  assert.equal(seen.offers.length, 1);
  assert.equal(seen.offers[0].canTake, true);
  assert.equal(seen.offers[0].reason, 'Funeral in Ho.');

  // And nothing has moved on the rota.
  assert.equal(raw.prepare('SELECT staff_id FROM att_roster WHERE id = ?').get(id).staff_id, 1);
});

test('somebody else’s shift is not theirs to give away', async () => {
  const { db, raw } = setup();
  const id = rota(raw, 1, SAT, 1);
  await assert.rejects(() => offer(db, 2, { rosterId: id }), /not your shift/);
});

test('a shift starting sooner than the rule allows is refused', async () => {
  const { db, raw } = setup({ notice: 24 });
  const id = rota(raw, 1, soon(0), 1);
  await assert.rejects(() => offer(db, 1, { rosterId: id }), /before it starts/);
});

test('the same shift cannot go up twice', async () => {
  const { db, raw } = setup();
  const id = rota(raw, 1, SAT, 1);
  await offer(db, 1, { rosterId: id });
  await assert.rejects(() => offer(db, 1, { rosterId: id }), /already on the board/);
});

test('a cap on how many a month is kept', async () => {
  const { db, raw } = setup({ cap: 1 });
  await offer(db, 1, { rosterId: rota(raw, 1, SAT, 1) });
  await assert.rejects(
    () => offer(db, 1, { rosterId: rota(raw, 1, SUN, 1) }),
    /most the property allows/,
  );
});

// ---------------------------------------------------------------------------
// Naming the people to ask
// ---------------------------------------------------------------------------

test('a shift can be put to named colleagues, with the board behind them', async () => {
  const { db, raw } = setup();
  const id = rota(raw, 1, SAT, 1);
  const out = await offer(db, 1, { rosterId: id, aimedAt: [2], aimedOnly: false });
  assert.equal(out.aimedAt, 'Doreen Aitee');

  const hers = await board(db, 2);
  assert.equal(hers.aimed.length, 1, 'put to her by name');
  assert.equal(hers.offers.length, 0);

  const his = await board(db, 3);
  assert.equal(his.offers.length, 1, 'and still on the board for everybody else');
});

test('or to named colleagues and nobody else', async () => {
  const { db, raw } = setup();
  await offer(db, 1, { rosterId: rota(raw, 1, SAT, 1), aimedAt: [2], aimedOnly: true });

  assert.equal((await board(db, 2)).aimed.length, 1);
  const his = await board(db, 3);
  assert.equal(his.offers.length + his.aimed.length, 0, 'Henry never sees it');
});

test('more than one person can be named at once', async () => {
  const { db, raw } = setup();
  const out = await offer(db, 1, {
    rosterId: rota(raw, 1, SAT, 1), aimedAt: [2, 3], aimedOnly: true,
  });
  assert.equal(out.aimedAt, 'Doreen Aitee, Henry Aryee');
  assert.equal(out.told, 2);
  assert.equal((await board(db, 2)).aimed.length, 1);
  assert.equal((await board(db, 3)).aimed.length, 1);
});

test('naming somebody who cannot cover it is refused, and says who', async () => {
  const { db, raw } = setup();
  await assert.rejects(
    () => offer(db, 1, { rosterId: rota(raw, 1, SAT, 1), aimedAt: [4] }),
    /Kojo Mensah cannot take it\. They do not work in F&B/,
  );
});

test('saying no to one put to you passes it to the rest', async () => {
  const { db, raw } = setup();
  const out = await offer(db, 1, {
    rosterId: rota(raw, 1, SAT, 1), aimedAt: [2, 3], aimedOnly: true,
  });
  await drop(db, 2, out.id);

  assert.equal((await board(db, 2)).aimed.length, 0, 'gone from hers');
  assert.equal((await board(db, 3)).aimed.length, 1, 'still on his');
});

test('and the last no closes it', async () => {
  const { db, raw } = setup();
  const out = await offer(db, 1, { rosterId: rota(raw, 1, SAT, 1), aimedAt: [2], aimedOnly: true });
  await drop(db, 2, out.id);

  const row = raw.prepare('SELECT status FROM att_swap WHERE id = ?').get(out.id);
  assert.equal(row.status, 'declined');
});

// ---------------------------------------------------------------------------
// Taking one
// ---------------------------------------------------------------------------

test('taking a shift is a request, and the rota does not move', async () => {
  const { db, raw } = setup();
  const rosterId = rota(raw, 1, SAT, 1);
  const out = await offer(db, 1, { rosterId });

  const took = await take(db, 2, out.id);
  assert.equal(took.approved, false);
  assert.equal(raw.prepare('SELECT staff_id FROM att_roster WHERE id = ?').get(rosterId).staff_id, 1);
  assert.equal(raw.prepare('SELECT status FROM att_swap WHERE id = ?').get(out.id).status, 'claimed');
});

test('two people cannot take the same shift', async () => {
  const { db, raw } = setup();
  const out = await offer(db, 1, { rosterId: rota(raw, 1, SAT, 1) });
  await take(db, 2, out.id);
  await assert.rejects(() => take(db, 3, out.id), /already taken/);
});

test('somebody who cannot work it cannot take it, whatever they send', async () => {
  const { db, raw } = setup();
  const out = await offer(db, 1, { rosterId: rota(raw, 1, SAT, 1) });
  await assert.rejects(() => take(db, 4, out.id), /do not work in F&B/);
});

test('one put to somebody by name is not open to anybody else', async () => {
  const { db, raw } = setup();
  const out = await offer(db, 1, {
    rosterId: rota(raw, 1, SAT, 1), aimedAt: [2], aimedOnly: true,
  });
  await assert.rejects(() => take(db, 3, out.id), /put to somebody else/);
});

test('a clean swap goes straight through where the property has said so', async () => {
  const { db, raw } = setup({ approval: 'clean' });
  const rosterId = rota(raw, 1, SAT, 1);
  const out = await offer(db, 1, { rosterId });

  const took = await take(db, 2, out.id);
  assert.equal(took.approved, true);
  assert.equal(raw.prepare('SELECT staff_id FROM att_roster WHERE id = ?').get(rosterId).staff_id, 2);
});

test('and one with something flagged never does', async () => {
  const { db, raw } = setup({ approval: 'clean' });
  rota(raw, 2, SUN, 1);                       // Doreen opens on the Sunday
  const rosterId = rota(raw, 1, SAT, 2);      // Regina's Saturday evening
  const out = await offer(db, 1, { rosterId });

  const took = await take(db, 2, out.id);
  assert.equal(took.approved, false, 'eight hours between the two');
  assert.ok(took.findings.some((f) => f.level === 'high'));
  assert.equal(raw.prepare('SELECT staff_id FROM att_roster WHERE id = ?').get(rosterId).staff_id, 1);
});

test('handing it back puts it on the board again', async () => {
  const { db, raw } = setup();
  const out = await offer(db, 1, { rosterId: rota(raw, 1, SAT, 1) });
  await take(db, 2, out.id);
  await drop(db, 2, out.id);

  const row = raw.prepare('SELECT status, taken_by FROM att_swap WHERE id = ?').get(out.id);
  assert.equal(row.status, 'open');
  assert.equal(row.taken_by, null);
});

test('and the person who put it up can take it off', async () => {
  const { db, raw } = setup();
  const out = await offer(db, 1, { rosterId: rota(raw, 1, SAT, 1) });
  await drop(db, 1, out.id);

  assert.equal(raw.prepare('SELECT status FROM att_swap WHERE id = ?').get(out.id).status, 'withdrawn');
  assert.equal((await board(db, 2)).offers.length, 0);
});

// ---------------------------------------------------------------------------
// The decision, which is the only thing that writes
// ---------------------------------------------------------------------------

test('approving moves the roster row and says who did it', async () => {
  const { db, raw } = setup();
  const rosterId = rota(raw, 1, SAT, 1);
  const out = await offer(db, 1, { rosterId });
  await take(db, 2, out.id);

  const done = await decide(db, out.id, { approve: true });
  assert.equal(done.status, 'approved');

  const row = raw.prepare('SELECT staff_id, set_by FROM att_roster WHERE id = ?').get(rosterId);
  assert.equal(row.staff_id, 2);
  assert.match(row.set_by, /Yaa \(manager\).*Regina Sampson to Doreen Aitee/);
});

test('turning it down leaves the rota exactly as it was', async () => {
  const { db, raw } = setup();
  const rosterId = rota(raw, 1, SAT, 1);
  const out = await offer(db, 1, { rosterId });
  await take(db, 2, out.id);

  await decide(db, out.id, { approve: false, note: 'We need her on that one.' });
  assert.equal(raw.prepare('SELECT staff_id FROM att_roster WHERE id = ?').get(rosterId).staff_id, 1);
  const swap = raw.prepare('SELECT status, decision FROM att_swap WHERE id = ?').get(out.id);
  assert.equal(swap.status, 'declined');
  assert.equal(swap.decision, 'We need her on that one.');
});

test('a week put back into draft cannot be approved', async () => {
  const { db, raw } = setup();
  const rosterId = rota(raw, 1, SAT, 1);
  const out = await offer(db, 1, { rosterId });
  await take(db, 2, out.id);
  raw.prepare('UPDATE att_roster SET published = 0 WHERE id = ?').run(rosterId);

  await assert.rejects(() => decide(db, out.id, { approve: true }), /back in draft/);
});

test('a cell changed under the offer cannot be approved', async () => {
  const { db, raw } = setup();
  const rosterId = rota(raw, 1, SAT, 1);
  const out = await offer(db, 1, { rosterId });
  await take(db, 2, out.id);
  raw.prepare('UPDATE att_roster SET shift_id = 2 WHERE id = ?').run(rosterId);

  await assert.rejects(() => decide(db, out.id, { approve: true }), /has been changed/);
});

test('a shift taken off the rota cannot be approved', async () => {
  const { db, raw } = setup();
  const rosterId = rota(raw, 1, SAT, 1);
  const out = await offer(db, 1, { rosterId });
  await take(db, 2, out.id);
  raw.prepare('DELETE FROM att_roster WHERE id = ?').run(rosterId);

  await assert.rejects(() => decide(db, out.id, { approve: true }), /taken off the rota/);
});

test('a signed-off day is closed, and the swap is refused', async () => {
  const { db, raw } = setup();
  const rosterId = rota(raw, 1, SAT, 1);
  const out = await offer(db, 1, { rosterId });
  await take(db, 2, out.id);

  raw.prepare(
    `INSERT INTO att_period_review
       (staff_id, kind, from_day, to_day, scheduled_days, worked_days, difference, decided_by)
     VALUES (1, 'month', ?, ?, 20, 20, 0, 'Yaa')`,
  ).run(soon(0), soon(30));

  await assert.rejects(() => decide(db, out.id, { approve: true }), /signed off/);
  assert.equal(raw.prepare('SELECT staff_id FROM att_roster WHERE id = ?').get(rosterId).staff_id, 1);
});

test('somebody who has since been put on something else cannot be given it', async () => {
  const { db, raw } = setup();
  const rosterId = rota(raw, 1, SAT, 1);
  const out = await offer(db, 1, { rosterId });
  await take(db, 2, out.id);
  rota(raw, 2, SAT, 5);                        // Doreen is on lunch now

  await assert.rejects(() => decide(db, out.id, { approve: true }), /cannot take it any more/);
});

// ---------------------------------------------------------------------------
// Swapping one for another
// ---------------------------------------------------------------------------

test('a swap names both shifts and moves both rows', async () => {
  const { db, raw } = setup();
  const mine = rota(raw, 1, SAT, 1);
  const theirs = rota(raw, 2, MON, 2);

  const out = await offer(db, 1, { rosterId: mine, aimedAt: [2], backRosterId: theirs });
  assert.equal(raw.prepare('SELECT kind FROM att_swap WHERE id = ?').get(out.id).kind, 'trade');

  // It waits on the one person it was put to.
  const hers = await board(db, 2);
  assert.equal(hers.trades.length, 1);
  assert.equal(hers.trades[0].back.name, 'Evening');

  await take(db, 2, out.id);
  await decide(db, out.id, { approve: true });

  assert.equal(raw.prepare('SELECT staff_id FROM att_roster WHERE id = ?').get(mine).staff_id, 2);
  assert.equal(raw.prepare('SELECT staff_id FROM att_roster WHERE id = ?').get(theirs).staff_id, 1);
});

test('a swap has to be with one person, and their shift has to be theirs', async () => {
  const { db, raw } = setup();
  const mine = rota(raw, 1, SAT, 1);
  const theirs = rota(raw, 2, MON, 2);

  await assert.rejects(
    () => offer(db, 1, { rosterId: mine, aimedAt: [2, 3], backRosterId: theirs }),
    /swap is with one person/,
  );
  await assert.rejects(
    () => offer(db, 1, { rosterId: mine, aimedAt: [3], backRosterId: theirs }),
    /not theirs/,
  );
});

// ---------------------------------------------------------------------------
// The two screens
// ---------------------------------------------------------------------------

test('the offer dialog is told who can cover each shift', async () => {
  const { db, raw } = setup();
  rota(raw, 1, SAT, 1);
  rota(raw, 1, SUN, 1);

  const out = await (await whatICanOffer(ctx(db, asStaff(1)))).json();
  assert.equal(out.on, true);
  assert.equal(out.shifts.length, 2);
  assert.deepEqual(out.shifts[0].canCover.map((p) => p.name), ['Doreen Aitee', 'Henry Aryee']);
});

test('a shift already on the board is not offered again', async () => {
  const { db, raw } = setup();
  const id = rota(raw, 1, SAT, 1);
  rota(raw, 1, SUN, 1);
  await offer(db, 1, { rosterId: id });

  const out = await (await whatICanOffer(ctx(db, asStaff(1)))).json();
  assert.deepEqual(out.shifts.map((s) => s.day), [SUN]);
});

test('the planner sees what is waiting, with the findings on it', async () => {
  const { db, raw } = setup();
  rota(raw, 2, SUN, 1);
  const out = await offer(db, 1, { rosterId: rota(raw, 1, SAT, 2) });
  await take(db, 2, out.id);

  const seen = await queue(db);
  assert.equal(seen.waiting.length, 1);
  assert.equal(seen.waiting[0].from.name, 'Regina Sampson');
  assert.equal(seen.waiting[0].takenBy.name, 'Doreen Aitee');
  assert.ok(seen.waiting[0].findings.some((f) => f.level === 'high'));
});

test('and what is still going, with how many could take it', async () => {
  const { db, raw } = setup();
  await offer(db, 1, { rosterId: rota(raw, 1, SAT, 1) });

  const seen = await queue(db);
  assert.equal(seen.board.length, 1);
  assert.equal(seen.board[0].canCover, 2);
});

test('nothing is on any screen while swaps are turned off', async () => {
  const { db, raw } = setup({ on: false });
  rota(raw, 1, SAT, 1);

  assert.equal((await board(db, 1)).on, false);
  assert.equal((await (await whatICanOffer(ctx(db, asStaff(1)))).json()).on, false);
  assert.equal((await queue(db)).on, false);
});

test('and a shift cannot be offered while they are off', async () => {
  const { db, raw } = setup({ on: false });
  await assert.rejects(
    () => offer(db, 1, { rosterId: rota(raw, 1, SAT, 1) }),
    /turned off/,
  );
});

// ---------------------------------------------------------------------------
// Where it sits, and who may reach it
// ---------------------------------------------------------------------------

test('a staff member reaches the board, and only a planner the queue', () => {
  const index = readFileSync('src/index.js', 'utf8');
  assert.match(index, /\['GET', '\/api\/swaps', 'att_me', swaps\.swapBoard\]/);
  assert.match(index, /\['POST', '\/api\/swaps\/:id\/take', 'att_me', swaps\.takeSwap\]/);
  assert.match(index,
    /\['POST', '\/api\/swaps\/:id\/decide', \['att_rota', 'att_manage'\], swaps\.decideSwap\]/);
});

test('it is a tab beside the two screens it belongs to, not a new link', () => {
  const app = readFileSync('public/js/app.js', 'utf8');
  assert.match(app, /group: 'me', tab: 'Swaps'/);
  assert.match(app, /group: 'rota', tab: 'Swaps'/);
  // Ten links in the menu, not eleven.
  assert.equal(/key: 'swaps', label:/.test(app), false);
});

test('the offer dialog can name several colleagues at once', () => {
  const view = readFileSync('public/js/views/swaps.js', 'utf8');
  assert.match(view, /picked = new Set/);
  assert.match(view, /aimedAt: \[\.\.\.picked\]/);
  // And the board behind them is a choice, not a consequence.
  assert.match(view, /aimedOnly: picked\.size > 0 && !openToo/);
});
