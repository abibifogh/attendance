import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { askForLeave, setMyAvailability } from '../src/routes/me.js';
import { setAvailability } from '../src/routes/attendance.js';
import { AWAY_CAP_DEFAULT, dayFullMessage, listNames, whoIsAway } from '../src/lib/away.js';

/**
 * How many people may be off on one day.
 *
 * A property can survive two or three people being away at once and cannot
 * survive eight, and nothing in the app knew that. Leave was answered one
 * request at a time, on whether that person could spare the days, with no view
 * of who else had already asked for the same Friday. The first anybody heard
 * about a Friday with nine people off was the Friday.
 *
 * What is pinned down here is that the ceiling counts both kinds of being
 * away, that it holds against what staff ask for and not against what a
 * planner writes, and that the refusal says which day is full and who is on
 * it — because "no" with no reason reads as a judgement on the person asking.
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

const NAMES = ['Ama', 'Kofi', 'Yaw', 'Esi', 'Adjoa'];

function setup(cap = null) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_availability; DELETE FROM att_leave; DELETE FROM users;
            DELETE FROM app_notices;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  if (cap != null) {
    raw.prepare("UPDATE settings SET value = ? WHERE key = 'att_away_cap'").run(String(cap));
  }
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Breakfast', '06:00', '14:00', 0, 5)`,
  ).run();
  NAMES.forEach((name, i) => {
    raw.prepare(
      'INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (?, ?, ?, ?)',
    ).run(i + 1, String(i + 1), name, '2020-01-01');
    raw.prepare(
      'INSERT INTO users (id, name, role, active, staff_id) VALUES (?, ?, ?, 1, ?)',
    ).run(100 + i, name, 'staff', i + 1);
  });
  return { raw, db: d1(raw) };
}

const DAY = '2099-09-11';
const NEXT = '2099-09-12';

const asStaff = (i) => ({
  user: { id: 100 + i, name: NAMES[i], role: 'staff', staff_id: i + 1 },
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

/** Put somebody on the rota, so leave has something to come off. */
const rota = (raw, staffId, day) => raw.prepare(
  "INSERT INTO att_roster (staff_id, day, shift_id, set_by, published) VALUES (?, ?, 1, 'test', 1)",
).run(staffId, day);

const leaveOn = (db, i, from = DAY, to = from) => askForLeave(ctx(db, {
  from, to, reason: 'annual_leave', note: 'Family',
}, asStaff(i)));

const cannotWork = (db, i, days = [DAY]) => setMyAvailability(ctx(db, {
  days, status: 'unavailable', note: 'Travelling',
}, asStaff(i)));

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

test('the property starts at three, and it is a setting', () => {
  const { raw } = setup();
  assert.equal(AWAY_CAP_DEFAULT, 3);
  assert.equal(raw.prepare("SELECT value FROM settings WHERE key = 'att_away_cap'").get().value, '3');
});

test('three can ask for the same day and the fourth is told why not', async () => {
  const { db, raw } = setup();
  for (let i = 0; i < 5; i += 1) rota(raw, i + 1, DAY);

  await leaveOn(db, 0);
  await leaveOn(db, 1);
  await leaveOn(db, 2);

  await assert.rejects(() => leaveOn(db, 3), (err) => {
    assert.match(err.message, /Only 3 people can be off on any one day/);
    assert.match(err.message, /Friday 11 September is already full/);
    // No names. My shifts is somebody's own week and nobody else's, and this
    // message must not hand out what the rest of the app withholds.
    for (const name of NAMES) assert.equal(err.message.includes(name), false, name);
    return true;
  });

  assert.equal(
    raw.prepare("SELECT COUNT(*) AS n FROM att_leave WHERE status = 'pending'").get().n, 3,
    'and nothing was written for the fourth',
  );
});

test('the two kinds of being away are counted together', async () => {
  const { db, raw } = setup();
  for (let i = 0; i < 5; i += 1) rota(raw, i + 1, DAY);

  await leaveOn(db, 0);
  await cannotWork(db, 1);
  await cannotWork(db, 2);

  await assert.rejects(() => leaveOn(db, 3), /already full/);
  await assert.rejects(() => cannotWork(db, 3), /already full/);
});

test('the number is the property’s to set', async () => {
  const { db, raw } = setup(1);
  for (let i = 0; i < 5; i += 1) rota(raw, i + 1, DAY);

  await leaveOn(db, 0);
  await assert.rejects(() => leaveOn(db, 1), /Only one person can be off on any one day/);
});

test('nought means nobody may ask', async () => {
  const { db, raw } = setup(0);
  rota(raw, 1, DAY);
  await assert.rejects(() => leaveOn(db, 0), /can be off on any one day/);
});

test('a day that is not full takes the request', async () => {
  const { db, raw } = setup();
  for (let i = 0; i < 5; i += 1) { rota(raw, i + 1, DAY); rota(raw, i + 1, NEXT); }

  await leaveOn(db, 0);
  await leaveOn(db, 1);
  const out = await (await leaveOn(db, 2)).json();
  assert.equal(out.ok, true, 'the third still gets it');

  // And the fourth can have the day after, which nobody has asked about.
  const other = await (await leaveOn(db, 3, NEXT, NEXT)).json();
  assert.equal(other.ok, true);
});

test('a run of days is refused on the first one that is full, and says which', async () => {
  const { db, raw } = setup();
  for (let i = 0; i < 5; i += 1) { rota(raw, i + 1, DAY); rota(raw, i + 1, NEXT); }

  await leaveOn(db, 0, NEXT, NEXT);
  await leaveOn(db, 1, NEXT, NEXT);
  await leaveOn(db, 2, NEXT, NEXT);

  await assert.rejects(() => leaveOn(db, 3, DAY, NEXT), /Saturday 12 September/);
});

test('their own days do not count against them', async () => {
  const { db, raw } = setup(1);
  rota(raw, 1, DAY);
  await cannotWork(db, 0);
  // The same person asking about the same day again is amending, not a second
  // person arriving.
  const out = await (await cannotWork(db, 0)).json();
  assert.equal(out.ok, true);
});

test('leave somebody withdrew or was refused frees the day again', async () => {
  const { db, raw } = setup(1);
  rota(raw, 1, DAY); rota(raw, 2, DAY);

  await leaveOn(db, 0);
  await assert.rejects(() => leaveOn(db, 1), /already full/);

  raw.prepare("UPDATE att_leave SET status = 'rejected' WHERE staff_id = 1").run();
  const out = await (await leaveOn(db, 1)).json();
  assert.equal(out.ok, true);
});

// ---------------------------------------------------------------------------
// It does not stand in a planner's way
// ---------------------------------------------------------------------------

test('a planner writing unavailability is not held to it', async () => {
  const { db, raw } = setup(1);
  for (let i = 0; i < 5; i += 1) rota(raw, i + 1, DAY);
  await cannotWork(db, 0);

  const out = await (await setAvailability(ctx(db, {
    staffId: 2, days: [DAY], status: 'unavailable', note: 'Agreed months ago',
  }, PLANNER))).json();

  assert.equal(out.ok, true, 'they can see the whole week and are the ones who would say yes');
  assert.equal(out.marked, 1);
});

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

test('the refusal says the day and the number, and names nobody', () => {
  const said = dayFullMessage({ day: '2099-09-11', names: ['Ama', 'Kofi', 'Yaw'] }, 3);
  assert.match(said, /Only 3 people can be off/);
  assert.match(said, /Friday 11 September is already full/);
  assert.match(said, /Try another day/, 'and what to do about it');
  assert.equal(/Ama|Kofi|Yaw/.test(said), false,
    'a member of staff is not shown anybody else\'s week anywhere else either');
});

test('one name reads as one name', () => {
  assert.equal(listNames(['Ama']), 'Ama');
  assert.equal(listNames(['Ama', 'Kofi']), 'Ama and Kofi');
  assert.equal(listNames(['Ama', 'Kofi', 'Yaw']), 'Ama, Kofi and Yaw');
});

test('who is away reads both kinds and leaves the person out of their own count', async () => {
  const { db, raw } = setup();
  rota(raw, 1, DAY); rota(raw, 2, DAY);
  await leaveOn(db, 0);
  await cannotWork(db, 1);

  const all = await whoIsAway(db, { from: DAY, to: DAY });
  assert.deepEqual([...(all.get(DAY) ?? [])].sort(), ['Ama', 'Kofi']);

  const without = await whoIsAway(db, { from: DAY, to: DAY, exceptStaffId: 1 });
  assert.deepEqual([...(without.get(DAY) ?? [])], ['Kofi']);
});
