import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { myWeek } from '../src/routes/me.js';
import { publishRoster, saveRoster } from '../src/routes/attendance.js';

/**
 * A week nobody has published says nothing at all.
 *
 * The screen used to mark a day the planner had decided but not published as
 * "Being worked out", so that a blank Thursday could be told from a Thursday
 * that is a day off. The reasoning was sound and the effect was not: five days
 * reading "Being worked out" beside one reading "Not out yet" hands somebody
 * the shape of next week before anybody has promised them anything. They read
 * the empty Wednesday as their day off and make plans on it, the draft moves,
 * because a draft is a planner thinking out loud, and the app has lied to them.
 *
 * So a day being worked on now reads exactly like a day nobody has touched.
 * What survives is the other half of that reasoning, and it is the half that
 * was true: once the week has gone out, a blank day is a day off and says so.
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

/** A Monday well ahead of today, which is the week the rota is built in. */
const MON = '2099-09-14';
const on = (n) => {
  const d = new Date(`${MON}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_leave; DELETE FROM att_availability; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes)
     VALUES (1, 'Breakfast', '06:00', '14:00', 0)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-01')`,
  ).run();
  raw.prepare(
    "INSERT INTO users (id, name, role, staff_id, active) VALUES (7, 'Kofi', 'staff', 1, 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const KOFI = { user: { id: 7, name: 'Kofi', role: 'staff', staff_id: 1 }, permissions: ['att_me'] };
const PLANNER = { user: { id: 3, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };

const ctx = (db, session, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/me/week${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const week = async (db) => (await myWeek(ctx(db, KOFI, { query: `?from=${MON}` }))).json();
const dayOf = (out, day) => out.days.find((d) => d.day === day);
const draft = (db, days) => saveRoster(ctx(db, PLANNER, {
  body: { entries: days.map((day) => ({ staffId: 1, day, shiftId: 1 })) },
}));
const publish = (db, from = MON, to = on(6)) => publishRoster(ctx(db, PLANNER, { body: { from, to } }));

// ---------------------------------------------------------------------------
// While it is being worked out
// ---------------------------------------------------------------------------

test('a drafted day is indistinguishable from a day nobody has touched', async () => {
  const { db } = setup();
  await draft(db, [MON, on(1), on(3), on(4), on(5)]);

  const out = await week(db);
  // Exactly the week in the screenshot: five days drafted, Wednesday not.
  const wednesday = dayOf(out, on(2));
  for (const day of [MON, on(1), on(3), on(4), on(5)]) {
    assert.deepEqual({ ...dayOf(out, day), day: null }, { ...wednesday, day: null }, day);
  }
});

test('nothing in the answer names the shift, the day or the fact of a draft', async () => {
  const { db } = setup();
  await draft(db, [MON]);

  const out = await week(db);
  // The days only. Elsewhere in the answer "pending" is how many days of leave
  // somebody has asked for, which is their own business and nothing to do with
  // the rota.
  const said = JSON.stringify(out.days);
  assert.equal(said.includes('Breakfast'), false, 'not the shift they were pencilled in for');
  assert.equal(said.includes('pending'), false, 'nor a flag saying somebody is deciding');
  assert.equal(said.includes('06:00'), false);
});

test('the week reads as empty, because for them it is', async () => {
  const { db } = setup();
  await draft(db, [MON, on(1), on(2), on(3), on(4)]);

  const out = await week(db);
  const mine = out.days.filter((d) => d.day >= MON && d.day <= on(6));
  assert.equal(mine.filter((d) => d.shift).length, 0);
  assert.equal(mine.filter((d) => d.restDay).length, 0, 'and no day off is promised either');
});

test('a draft written after the week went out withdraws that day, quietly', async () => {
  const { db } = setup();
  await publish(db);
  // The week has gone out with nothing on Tuesday, so Tuesday was their day
  // off. Now somebody is drafting a shift onto it.
  await draft(db, [on(1)]);

  const out = await week(db);
  const day = dayOf(out, on(1));
  assert.equal(day.restDay, false, 'it is no longer a promised day off');
  assert.equal(day.shift, null, 'and it is not a shift yet either');
});

// ---------------------------------------------------------------------------
// Once it is out
// ---------------------------------------------------------------------------

test('published, the shift is there in full', async () => {
  const { db } = setup();
  await draft(db, [MON]);
  await publish(db);

  const day = dayOf(await week(db), MON);
  assert.equal(day.shift.name, 'Breakfast');
  assert.equal(day.shift.starts_at, '06:00');
});

test('published, a blank day is a day off and says so', async () => {
  const { db } = setup();
  await draft(db, [MON]);
  await publish(db);

  const out = await week(db);
  assert.equal(dayOf(out, MON).restDay, false, 'they are working');
  assert.equal(dayOf(out, on(2)).restDay, true, 'and the week said nothing about Wednesday');
  // Past the end of what went out, still nothing promised.
  assert.equal(dayOf(out, on(9)).restDay, false);
});

test('a standing pattern is theirs without any of this', async () => {
  const { raw, db } = setup();
  raw.prepare('INSERT INTO att_patterns (staff_id, week, dow, shift_id) VALUES (1, 0, 0, 1)').run();

  const day = dayOf(await week(db), MON);
  assert.equal(day.shift.name, 'Breakfast', 'the arrangement they agreed to needs no publishing');
});

test('approved leave shows whether or not the week has gone out', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
     VALUES (1, 'annual_leave', ?, ?, 1, 'approved')`,
  ).run(on(1), on(1));

  const day = dayOf(await week(db), on(1));
  assert.equal(day.leave, 'Annual leave', 'leave is a decision, not a draft');
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

test('the words "Being worked out" are gone from the screen', () => {
  const view = readFileSync('public/js/views/att-me.js', 'utf8');
  assert.equal(/'Being worked out'/.test(view), false);
  assert.match(view, /h\('small\.muted', 'Not out yet'\)/);
});

test('and the route does not send the flag it read', () => {
  const route = readFileSync('src/routes/me.js', 'utf8');
  assert.equal(/^\s*pending: draft,/m.test(route), false);
  // The fact itself is still worked out, because a day being decided must not
  // be called a day off.
  assert.match(route, /const draft = schedule\.source === 'roster' && !rostered\?\.published;/);
  assert.match(route, /restDay: \(settled && !shift\) \|\| \(!shift && !draft && promised\(day\)\)/);
});
