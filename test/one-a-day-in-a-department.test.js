import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { setMyAvailability } from '../src/routes/me.js';
import { setAvailability } from '../src/routes/attendance.js';
import {
  daysTakenInDepartment, departmentTakenMessage, firstDayTaken,
} from '../src/lib/away.js';

/**
 * Two people out of one department on one day.
 *
 * The property-wide ceiling is about the whole place: three away out of two
 * dozen is survivable wherever they come from. This is a sharper problem. Two
 * of the four housekeepers picking the same Thursday leaves the floor at half
 * strength whatever the rest of the property is doing, and it happens in good
 * faith, because a member of staff sees their own week and nobody else's. The
 * second one cannot see the first one's request, so the first anybody hears of
 * it is Thursday.
 *
 * So a department takes one a day, first asked, and the second person is told
 * why and sent to the one person who can see both requests.
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

// Two in housekeeping, two in the kitchen, and one with no department at all.
const PEOPLE = [
  ['Ama', 'Housekeeping'],
  ['Esi', 'Housekeeping'],
  ['Kofi', 'Kitchen'],
  ['Yaw', 'Kitchen'],
  ['Adjoa', null],
];

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_availability; DELETE FROM att_leave; DELETE FROM users;
            DELETE FROM app_notices;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  PEOPLE.forEach(([name, department], i) => {
    raw.prepare(
      'INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (?,?,?,?,?)',
    ).run(i + 1, String(i + 1), name, department, '2020-01-01');
    raw.prepare(
      'INSERT INTO users (id, name, role, active, staff_id) VALUES (?,?,?,1,?)',
    ).run(100 + i, name, 'staff', i + 1);
  });
  return { raw, db: d1(raw) };
}

const DAY = '2099-09-10';
const NEXT = '2099-09-11';

const asStaff = (i) => ({
  user: { id: 100 + i, name: PEOPLE[i][0], role: 'staff', staff_id: i + 1 },
  permissions: ['att_me'],
});
const PLANNER = { user: { id: 9, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };

const ctx = (db, body, session) => ({
  db,
  env: {},
  url: new URL('https://x/api/x'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const cannotWork = (db, i, days = [DAY]) => setMyAvailability(ctx(db, {
  days, status: 'unavailable', note: 'Travelling',
}, asStaff(i)));

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test('the first one goes through and the second one from that department does not', async () => {
  const { db } = setup();
  await cannotWork(db, 0);
  await assert.rejects(() => cannotWork(db, 1), /already asked about/);
});

test('the message says why, what to do, and nobody else’s name', async () => {
  const { db } = setup();
  await cannotWork(db, 0);
  const said = await cannotWork(db, 1).catch((err) => err.message);

  assert.match(said, /Somebody else in Housekeeping/);
  assert.match(said, /Thursday 10 September/);
  assert.match(said, /only one person from a department can be off on the same day/);
  assert.match(said, /talk to your manager/);
  // This screen belongs to a member of staff, and the app does not show one
  // member of staff anybody else's week. The reason is complete without it.
  assert.equal(said.includes('Ama'), false);
});

test('another department is not affected by it', async () => {
  const { db } = setup();
  await cannotWork(db, 0);
  // Kofi in the kitchen has nothing to do with housekeeping's Thursday.
  await cannotWork(db, 2);
  await assert.rejects(() => cannotWork(db, 3), /Somebody else in Kitchen/);
});

test('a different day is fine', async () => {
  const { db } = setup();
  await cannotWork(db, 0, [DAY]);
  await cannotWork(db, 1, [NEXT]);
});

test('the run they ask for is refused on the first day of it that is taken', async () => {
  const { db } = setup();
  await cannotWork(db, 0, [NEXT]);
  const said = await cannotWork(db, 1, [DAY, NEXT]).catch((err) => err.message);
  assert.match(said, /Friday 11 September/, 'the day that is actually taken');
});

test('changing your own mind about a day you already have is not being second', async () => {
  const { db } = setup();
  await cannotWork(db, 0, [DAY]);
  // The same person saving the same day again, with a different note. Their
  // own row must not count against them.
  await setMyAvailability(ctx(db, {
    days: [DAY], status: 'unavailable', note: 'Hospital, not travelling',
  }, asStaff(0)));
});

test('a day somebody was turned down for is free again', async () => {
  const { db, raw } = setup();
  await cannotWork(db, 0);
  raw.prepare("UPDATE att_availability SET decision = 'refused' WHERE staff_id = 1").run();
  await cannotWork(db, 1);
});

test('a day somebody has taken back is free again', async () => {
  const { db, raw } = setup();
  await cannotWork(db, 0);
  raw.prepare('DELETE FROM att_availability WHERE staff_id = 1').run();
  await cannotWork(db, 1);
});

test('waiting counts as much as agreed', async () => {
  const { db, raw } = setup();
  await cannotWork(db, 0);
  assert.equal(raw.prepare('SELECT decision FROM att_availability').get().decision, 'waiting');
  // Letting the second one through while the first is unanswered would mean
  // the answer arrives too late to be an answer.
  await assert.rejects(() => cannotWork(db, 1), /already asked about/);
});

test('wanting to work is not being away, so the rule says nothing about it', async () => {
  const { db } = setup();
  await cannotWork(db, 0);
  await setMyAvailability(ctx(db, {
    days: [DAY], status: 'preferred',
  }, asStaff(1)));
});

test('somebody with no department is not in anybody’s department', async () => {
  const { db } = setup();
  await cannotWork(db, 0);
  await cannotWork(db, 4, [DAY]);
});

test('a planner writing it for somebody is not asking permission', async () => {
  const { db } = setup();
  await cannotWork(db, 0);
  // They can see the whole week, and they are the person the message above
  // sends everybody to. Holding them to the rule would leave nobody able to
  // answer it.
  const out = await setAvailability(ctx(db, {
    staffId: 2, days: [DAY], status: 'unavailable', note: 'Agreed at the meeting',
  }, PLANNER));
  assert.equal(JSON.parse(await out.text()).ok, true);
});

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

test('which days are taken, and by which department', async () => {
  const { db } = setup();
  await cannotWork(db, 0, [DAY]);

  const forHousekeeping = await daysTakenInDepartment(db, {
    department: 'Housekeeping', days: [DAY, NEXT], exceptStaffId: 2,
  });
  assert.deepEqual([...forHousekeeping], [DAY]);

  const forTheKitchen = await daysTakenInDepartment(db, {
    department: 'Kitchen', days: [DAY, NEXT], exceptStaffId: 3,
  });
  assert.deepEqual([...forTheKitchen], []);

  const forNobody = await daysTakenInDepartment(db, {
    department: null, days: [DAY], exceptStaffId: 5,
  });
  assert.deepEqual([...forNobody], []);
});

test('the first taken day of a run is the one named', () => {
  assert.equal(firstDayTaken([NEXT, DAY], new Set([NEXT])), NEXT);
  assert.equal(firstDayTaken([DAY, NEXT], new Set([DAY, NEXT])), DAY);
  assert.equal(firstDayTaken([DAY, NEXT], new Set()), null);
});

test('the message reads the same wherever it is built', () => {
  assert.equal(
    departmentTakenMessage('2099-09-10', 'Housekeeping'),
    'Somebody else in Housekeeping has already asked about Thursday 10 September, and only one '
    + 'person from a department can be off on the same day. Choose another day, or talk to your '
    + 'manager if it has to be that one.',
  );
});
