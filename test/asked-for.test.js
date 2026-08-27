import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { decideAvailability, getRoster, setAvailability, waitingAvailability } from '../src/routes/attendance.js';
import { setMyAvailability } from '../src/routes/me.js';

/**
 * Availability somebody asks for, and somebody else agrees to.
 *
 * "I cannot work the 14th" used to take effect the moment it was typed, which
 * makes it a statement rather than a request: the property could not say no,
 * and the person was never told either way. What is pinned down here is that a
 * day marked by the person waits, that a day marked by whoever builds the rota
 * does not — they are the approval — that agreeing leaves the mark and
 * declining takes it away, and that either answer reaches the person who asked.
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
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_availability; DELETE FROM users; DELETE FROM app_notices;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Reception', '06:00', '14:00', 0, 5)`,
  ).run();
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Adjoa', '2020-01-01')",
  ).run();
  // Her login, so an answer has somewhere to go.
  raw.prepare(
    "INSERT INTO users (id, name, role, active, staff_id) VALUES (9, 'Adjoa', 'staff', 1, 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = {
  user: { id: 2, name: 'Yaa', role: 'planner' },
  permissions: ['att_rota', 'att_view'],
};
const HER = {
  user: { id: 9, name: 'Adjoa', role: 'staff', staff_id: 1 },
  permissions: ['att_me'],
};

const ctx = (db, { body = null, query = '', session = PLANNER } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/x${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const DAYS = ['2099-09-14', '2099-09-15'];
const rows = (raw) => raw.prepare('SELECT * FROM att_availability ORDER BY day').all();
const notices = (raw) => raw.prepare('SELECT * FROM app_notices ORDER BY id').all();

const ask = (db, body) => setMyAvailability(ctx(db, { body, session: HER }));
const waiting = async (db) => (await waitingAvailability(ctx(db))).json();
const decide = (db, body) => decideAvailability(ctx(db, { body }));

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

test('a day somebody marks for themselves waits for an answer', async () => {
  const { db, raw } = setup();
  const said = await (await ask(db, { days: DAYS, status: 'unavailable', note: 'Graduation' })).json();

  assert.deepEqual(said, { ok: true, asked: 2, status: 'unavailable', decision: 'waiting' });
  assert.deepEqual(rows(raw).map((r) => r.decision), ['waiting', 'waiting']);
});

test('asking rings the bell for whoever has to work around it, once', async () => {
  const { db, raw } = setup();
  await ask(db, { days: DAYS, status: 'unavailable', note: 'Graduation' });

  const rung = notices(raw).filter((n) => n.kind === 'attendance.availability_asked');
  assert.equal(rung.length, 1, 'a fortnight marked off is one thing to answer');
  assert.match(rung[0].title, /Adjoa asked about 2 days/);
  assert.equal(rung[0].audience, 'att_rota');
});

test('whoever builds the rota is the approval', async () => {
  const { db, raw } = setup();
  await setAvailability(ctx(db, {
    body: { staffId: 1, days: DAYS, status: 'unavailable', note: 'Told me in person' },
  }));

  assert.deepEqual(rows(raw).map((r) => r.decision), ['approved', 'approved']);
  assert.equal(rows(raw)[0].decided_by, 'Yaa (planner)');
  assert.deepEqual((await waiting(db)).waiting, [], 'nothing to answer: they answered it');
});

test('asking again about a day already answered puts it back in the queue', async () => {
  const { db, raw } = setup();
  await setAvailability(ctx(db, { body: { staffId: 1, days: [DAYS[0]], status: 'unavailable' } }));
  assert.equal(rows(raw)[0].decision, 'approved');

  await ask(db, { days: [DAYS[0]], status: 'preferred', note: 'Actually I would like it' });
  assert.equal(rows(raw)[0].decision, 'waiting', 'the answer was to the old request');
  assert.equal(rows(raw)[0].decided_by, null);
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

test('a run of days is one thing to answer', async () => {
  const { db } = setup();
  await ask(db, { days: DAYS, status: 'unavailable', note: 'Graduation' });

  const list = (await waiting(db)).waiting;
  assert.equal(list.length, 1);
  assert.equal(list[0].staff, 'Adjoa');
  assert.deepEqual(list[0].days, DAYS);
  assert.equal(list[0].note, 'Graduation');
  assert.equal(list[0].status, 'unavailable');
});

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

test('agreeing leaves the mark standing, and says who agreed', async () => {
  const { db, raw } = setup();
  await ask(db, { days: DAYS, status: 'unavailable' });

  const done = await (await decide(db, { staffId: 1, days: DAYS, decision: 'approved' })).json();
  assert.deepEqual(done, { ok: true, decision: 'approved', days: 2 });
  assert.deepEqual(rows(raw).map((r) => r.decision), ['approved', 'approved']);
  assert.equal(rows(raw)[0].decided_by, 'Yaa (planner)');
  assert.ok(rows(raw)[0].decided_at);
});

test('declining takes the mark off, because the day is ordinary again', async () => {
  const { db, raw } = setup();
  await ask(db, { days: DAYS, status: 'unavailable' });

  await decide(db, { staffId: 1, days: DAYS, decision: 'declined', note: 'We are short that week' });
  assert.deepEqual(rows(raw), [], 'a mark that has been said no to still reads as a mark');
});

test('either answer reaches the person who asked, and nobody else', async () => {
  const { db, raw } = setup();
  await ask(db, { days: DAYS, status: 'unavailable' });
  await decide(db, { staffId: 1, days: DAYS, decision: 'approved' });

  const told = notices(raw).filter((n) => n.kind === 'attendance.availability_decided');
  assert.equal(told.length, 1);
  assert.equal(told[0].user_id, 9, 'her login, not the noticeboard');
  assert.equal(told[0].audience, null);
  assert.match(told[0].title, /Agreed/);
  assert.match(told[0].body, /has been agreed/);
});

test('a decline says so, and carries the reason where one was given', async () => {
  const { db, raw } = setup();
  await ask(db, { days: [DAYS[0]], status: 'unavailable' });
  await decide(db, {
    staffId: 1, days: [DAYS[0]], decision: 'declined', note: 'We are short that week.',
  });

  const told = notices(raw).find((n) => n.kind === 'attendance.availability_decided');
  assert.match(told.title, /Not agreed/);
  assert.match(told.body, /We are short that week\./);
});

test('answering something nobody asked about is refused', async () => {
  const { db } = setup();
  await assert.rejects(
    () => decide(db, { staffId: 1, days: DAYS, decision: 'approved' }),
    /Nothing there is waiting/,
  );
});

test('an answer that is neither yes nor no is refused', async () => {
  const { db } = setup();
  await ask(db, { days: DAYS, status: 'unavailable' });
  await assert.rejects(
    () => decide(db, { staffId: 1, days: DAYS, decision: 'maybe' }),
    /approved or declined/,
  );
});

test('answering one day of a run leaves the rest waiting', async () => {
  const { db, raw } = setup();
  await ask(db, { days: DAYS, status: 'unavailable' });

  await decide(db, { staffId: 1, days: [DAYS[0]], decision: 'approved' });
  assert.deepEqual(rows(raw).map((r) => [r.day, r.decision]), [
    [DAYS[0], 'approved'],
    [DAYS[1], 'waiting'],
  ]);
});

// ---------------------------------------------------------------------------
// And the grid says which is which
// ---------------------------------------------------------------------------

test('the grid says whether a mark has been answered', async () => {
  const { db } = setup();
  await ask(db, { days: ['2099-09-14'], status: 'unavailable', note: 'Graduation' });

  const data = await (await getRoster(ctx(db, { query: '?from=2099-09-14&to=2099-09-20' }))).json();
  const cell = data.rows.find((r) => r.staff.name === 'Adjoa')
    .days.find((d) => d.day === '2099-09-14');

  assert.equal(cell.availability.decision, 'waiting');
  assert.equal(cell.availability.note, 'Graduation');
  assert.equal(data.asked, 1, 'and the toolbar knows there is something to answer');
});

test('an answered mark reads as a fact rather than a question', async () => {
  const { db } = setup();
  await ask(db, { days: ['2099-09-14'], status: 'unavailable' });
  await decide(db, { staffId: 1, days: ['2099-09-14'], decision: 'approved' });

  const data = await (await getRoster(ctx(db, { query: '?from=2099-09-14&to=2099-09-20' }))).json();
  const cell = data.rows.find((r) => r.staff.name === 'Adjoa')
    .days.find((d) => d.day === '2099-09-14');

  assert.equal(cell.availability.decision, 'approved');
  assert.equal(data.asked, 0);
});
