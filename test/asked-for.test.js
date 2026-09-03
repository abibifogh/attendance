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

// ---------------------------------------------------------------------------
// Two days, and no more
// ---------------------------------------------------------------------------

/**
 * Unavailability is for a day or two. Anything longer is leave, which is
 * approved by somebody, comes off a balance and leaves a record of who agreed
 * to it, none of which happens here. So the limit is not tidiness, it is the
 * line between the two screens, and what is pinned down below is that the line
 * holds however somebody arrives at it.
 */
test('three days at once is refused, and the answer says where to go instead', async () => {
  const { db, raw } = setup();
  await assert.rejects(
    () => ask(db, { days: ['2099-09-14', '2099-09-15', '2099-09-16'], status: 'unavailable' }),
    /2 days at most.*ask for leave/i,
  );
  assert.equal(rows(raw).length, 0, 'and nothing was written');
});

test('two days is fine', async () => {
  const { db, raw } = setup();
  await ask(db, { days: DAYS, status: 'unavailable' });
  assert.equal(rows(raw).length, 2);
});

test('a third day joined onto two already there is refused', async () => {
  const { db, raw } = setup();
  await ask(db, { days: DAYS, status: 'unavailable' });

  await assert.rejects(
    () => ask(db, { days: ['2099-09-16'], status: 'unavailable' }),
    /2 days in a row at most.*would make 3/i,
  );
  assert.equal(rows(raw).length, 2, 'the two already there are left alone');
});

test('one day at a time is still one week off, and is stopped the same way', async () => {
  const { db } = setup();
  await ask(db, { days: ['2099-09-14'], status: 'unavailable' });
  await ask(db, { days: ['2099-09-15'], status: 'unavailable' });
  await assert.rejects(
    () => ask(db, { days: ['2099-09-16'], status: 'unavailable' }),
    /2 days in a row at most/,
  );
});

test('a day that fills the gap between two marks makes a run of three', async () => {
  const { db } = setup();
  await ask(db, { days: ['2099-09-14'], status: 'unavailable' });
  await ask(db, { days: ['2099-09-16'], status: 'unavailable' });

  await assert.rejects(
    () => ask(db, { days: ['2099-09-15'], status: 'unavailable' }),
    /would make 3/,
  );
});

test('days scattered about are not a spell of absence', async () => {
  const { db, raw } = setup();
  await ask(db, { days: ['2099-09-06'], status: 'unavailable' });
  await ask(db, { days: ['2099-09-13'], status: 'unavailable' });
  await ask(db, { days: ['2099-09-20'], status: 'unavailable' });

  assert.equal(rows(raw).length, 3, 'three separate Sundays are three separate facts');
});

test('saving the same two days again is not four days', async () => {
  const { db, raw } = setup();
  await ask(db, { days: DAYS, status: 'unavailable', note: 'Graduation' });
  await ask(db, { days: DAYS, status: 'unavailable', note: 'Graduation, all day' });

  assert.equal(rows(raw).length, 2);
  assert.equal(rows(raw)[0].note, 'Graduation, all day', 'and the second one is what stands');
});

test('a declined day is not counted against the limit', async () => {
  const { db, raw } = setup();
  await ask(db, { days: ['2099-09-14'], status: 'unavailable' });
  await decide(db, { staffId: 1, days: ['2099-09-14'], decision: 'declined', note: 'Needed' });

  await ask(db, { days: ['2099-09-15', '2099-09-16'], status: 'unavailable' });
  assert.equal(rows(raw).filter((r) => r.decision === 'waiting').length, 2);
});

test('wanting to work is not being away, so the limit leaves it alone', async () => {
  const { db, raw } = setup();
  await ask(db, {
    days: ['2099-09-14', '2099-09-15', '2099-09-16', '2099-09-17'],
    status: 'preferred',
  });
  assert.equal(rows(raw).length, 4);
});

// ---------------------------------------------------------------------------
// The planner writing it down themselves
// ---------------------------------------------------------------------------

/**
 * "Kofi cannot do Thursdays this month" is a thing somebody says to a planner
 * in a corridor, and until now there was nowhere to put it: the route has
 * existed since availability did and nothing in the app called it.
 *
 * The rules are the other way round from the staff screen, and deliberately.
 * There is no two-day cap, because that cap exists to stop unavailability
 * being a back door to a week off nobody approved, and the person writing here
 * is the person who would have done the approving. And nothing waits, for the
 * same reason: asking them to approve their own note is a press that means
 * nothing.
 */
const plan = (db, body) => setAvailability(ctx(db, { body }));

test('a planner is not held to two days', async () => {
  const { db, raw } = setup();
  const week = ['2099-09-14', '2099-09-15', '2099-09-16', '2099-09-17', '2099-09-18'];
  const out = await (await plan(db, { staffId: 1, days: week, status: 'unavailable' })).json();

  assert.equal(out.marked, 5);
  assert.equal(rows(raw).length, 5);
  assert.deepEqual([...new Set(rows(raw).map((r) => r.decision))], ['approved']);
});

test('a planner taking the mark off leaves the day ordinary', async () => {
  const { db, raw } = setup();
  await plan(db, { staffId: 1, days: DAYS, status: 'unavailable', note: 'Evening class' });
  assert.equal(rows(raw).length, 2);

  const out = await (await plan(db, { staffId: 1, days: [DAYS[0]], clear: true })).json();
  assert.equal(out.cleared, 1);
  assert.deepEqual(rows(raw).map((r) => r.day), [DAYS[1]], 'and the other one stands');
});

test('a planner can take off a day the person asked about themselves', async () => {
  const { db, raw } = setup();
  await ask(db, { days: [DAYS[0]], status: 'unavailable' });
  assert.equal(rows(raw)[0].decision, 'waiting');

  await plan(db, { staffId: 1, days: [DAYS[0]], clear: true });
  assert.equal(rows(raw).length, 0);
});

test('a planner writing over what somebody asked for settles it', async () => {
  const { db, raw } = setup();
  await ask(db, { days: [DAYS[0]], status: 'unavailable', note: 'Graduation' });

  await plan(db, { staffId: 1, days: [DAYS[0]], status: 'unavailable', note: 'Graduation, agreed' });
  const [mark] = rows(raw);
  assert.equal(mark.decision, 'approved', 'nothing is left waiting on the person who wrote it');
  assert.equal(mark.note, 'Graduation, agreed');
  assert.match(mark.set_by, /Yaa/);
});

test('a window inside the day, for an appointment rather than the whole of it', async () => {
  const { db, raw } = setup();
  await plan(db, {
    staffId: 1, days: [DAYS[0]], status: 'unavailable',
    fromTime: '09:00', toTime: '11:30', note: 'Clinic',
  });
  const [mark] = rows(raw);
  assert.equal(mark.from_time, '09:00');
  assert.equal(mark.to_time, '11:30');
});

test('half a window is refused rather than stored as a whole day', async () => {
  const { db } = setup();
  await assert.rejects(
    () => plan(db, { staffId: 1, days: [DAYS[0]], fromTime: '09:00' }),
    /both times, or neither/i,
  );
  await assert.rejects(
    () => plan(db, { staffId: 1, days: [DAYS[0]], fromTime: '11:00', toTime: '09:00' }),
    /has to come after/i,
  );
});

test('marking somebody who is not there is refused', async () => {
  const { db } = setup();
  await assert.rejects(
    () => plan(db, { staffId: 9999, days: [DAYS[0]] }),
    /No such member of staff/,
  );
});

test('the rota screen is where it is written from', () => {
  const view = readFileSync('public/js/views/att-rota.js', 'utf8');
  assert.match(view, /async function markAvailability/);
  assert.match(view, /api\.attSetAvailability/);
  // Beside the name, which is the one cell that survives the phone layout.
  assert.match(view, /rota-who-more/);
  // And only for somebody who may change the rota.
  assert.match(view, /mayEdit \? h\('button\.rota-who-more'/);
});
