import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { decideLeave, leaveDays, requestLeave } from '../src/routes/attendance.js';
import { askForLeave, myWeek } from '../src/routes/me.js';

/**
 * Leave asked for before the rota reaches that far.
 *
 * A rota is built a fortnight out; leave is booked months out. Counting the
 * days off the rota meant a request for a week in December, made in August,
 * came to nought days and was refused — which taught people to wait until a
 * fortnight before, the opposite of what anybody planning a rota wants.
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
            DELETE FROM att_leave; DELETE FROM att_holidays; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0)`,
  ).run();
  // Kofi has no standing pattern at all. Ama works Monday to Friday.
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-01'),
            (2, '2', 'Ama', 'Kitchen', '2020-01-01')`,
  ).run();
  for (const d of [0, 1, 2, 3, 4]) {
    raw.prepare('INSERT INTO att_patterns (staff_id, dow, shift_id) VALUES (2, ?, 1)').run(d);
  }
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (7, 'Kofi', 'staff', 'x', 1, 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 9, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };
const MANAGER = { user: { id: 3, name: 'Esi', role: 'manager' }, permissions: ['att_manage', 'att_rota'] };
const KOFI = { user: { id: 7, name: 'Kofi', role: 'staff', staff_id: 1 } };

const ctx = (db, session, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/leave${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

// A whole week next December, which no rota reaches.
const FROM = '2026-12-07';
const TO = '2026-12-13';

test('a member of staff can ask for a week nobody has rostered yet', async () => {
  const { db, raw } = setup();

  const out = await (await askForLeave(ctx(db, KOFI, {
    body: { reason: 'annual_leave', from: FROM, to: TO },
  }))).json();

  assert.equal(out.status, 'pending');
  assert.equal(out.estimated, true, 'said plainly to be a guess');
  assert.equal(out.days, 5, 'seven calendar days at five days a week');

  const row = raw.prepare('SELECT * FROM att_leave WHERE id = ?').get(out.id);
  assert.equal(row.estimated, 1);
});

test('somebody with a standing pattern is not guessed at', async () => {
  const { db, raw } = setup();
  const out = await (await requestLeave(ctx(db, PLANNER, {
    body: { staffId: 2, reason: 'annual_leave', from: FROM, to: TO },
  }))).json();

  assert.equal(out.estimated, false, 'their pattern already says what the week is');
  assert.equal(out.days, 5, 'Monday to Friday');
  assert.equal(raw.prepare('SELECT estimated FROM att_leave WHERE id = ?').get(out.id).estimated, 0);
});

test('a pattern that says nothing about Saturday is saying they do not work it', async () => {
  // The silence in a Monday-to-Friday pattern is an answer, not a gap. Reading
  // it as a gap would put half a day of leave on everybody's weekend — and it
  // makes the weekend the one span there really is no leave to take in.
  const { db } = setup();
  await assert.rejects(
    () => requestLeave(ctx(db, PLANNER, {
      body: { staffId: 2, reason: 'annual_leave', from: '2026-12-12', to: '2026-12-13' },
    })),
    /already a rest day or a public holiday/,
  );
});

test('part of a span rostered means the blanks in it are decisions, not gaps', async () => {
  // Somebody has been through this week by hand. The days they left empty are
  // days off, and guessing at them would charge leave for a rest day.
  const { db, raw } = setup();
  for (const d of ['2026-12-07', '2026-12-08', '2026-12-09']) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
      .run(d);
  }
  const out = await (await requestLeave(ctx(db, PLANNER, {
    body: { staffId: 1, reason: 'annual_leave', from: FROM, to: TO },
  }))).json();
  assert.equal(out.days, 3);
  assert.equal(out.estimated, false);
});

test('a week of public holidays has no leave in it, and says so', async () => {
  const { db, raw } = setup();
  for (const day of ['2026-12-07', '2026-12-08', '2026-12-09']) {
    raw.prepare(
      "INSERT INTO att_holidays (day, name, active) VALUES (?, 'Test', 1)",
    ).run(day);
  }
  await assert.rejects(
    () => requestLeave(ctx(db, PLANNER, {
      body: { staffId: 2, reason: 'annual_leave', from: '2026-12-07', to: '2026-12-09' },
    })),
    /already a rest day or a public holiday/,
  );
});

test('the estimate is settled when the rota catches up', async () => {
  const { db, raw } = setup();
  const out = await (await askForLeave(ctx(db, KOFI, {
    body: { reason: 'annual_leave', from: FROM, to: TO },
  }))).json();
  assert.equal(out.days, 5);

  // December arrives and somebody builds the week: six days on, one off.
  for (const d of ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-12']) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
      .run(d);
  }

  const now = await (await leaveDays(ctx(db, MANAGER), String(out.id))).json();
  assert.equal(now.asked, 5, 'what the guess said');
  assert.equal(now.days, 6, 'what the rota says now');
  assert.equal(now.estimated, true);
  assert.equal(now.stillEstimated, false, 'the rota covers every day of it');
  assert.equal(now.ceiling, 6, 'so more than the guess may be charged');
});

test('approving takes the figure the rota now says, and it stops being a guess', async () => {
  const { db, raw } = setup();
  const out = await (await askForLeave(ctx(db, KOFI, {
    body: { reason: 'annual_leave', from: FROM, to: TO },
  }))).json();

  for (const d of ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-12']) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
      .run(d);
  }

  const done = await (await decideLeave(
    ctx(db, MANAGER, { body: { decision: 'approved' } }), String(out.id),
  )).json();
  assert.equal(done.charged, 6, 'the guess of five is not what gets charged');

  const row = raw.prepare('SELECT * FROM att_leave WHERE id = ?').get(out.id);
  assert.equal(row.days, 6);
  assert.equal(row.estimated, 0, 'decided is decided');
});

test('an approver can charge above the guess, and never above the calendar', async () => {
  const { db } = setup();
  const out = await (await askForLeave(ctx(db, KOFI, {
    body: { reason: 'annual_leave', from: FROM, to: TO },
  }))).json();
  assert.equal(out.days, 5);

  // Nobody has rostered it even now, so the ceiling is the seven days in it.
  await assert.rejects(
    () => decideLeave(ctx(db, MANAGER, {
      body: { decision: 'approved', daysCharged: 8 },
    }), String(out.id)),
    /between 0 and 7/,
  );

  const done = await (await decideLeave(ctx(db, MANAGER, {
    body: { decision: 'approved', daysCharged: 6 },
  }), String(out.id))).json();
  assert.equal(done.charged, 6);
});

test('a figure that was never a guess still cannot be inflated', async () => {
  // Ama has a pattern, so her five days were counted rather than guessed, and
  // the old ceiling stands: an approver charges less, never more.
  const { db } = setup();
  const out = await (await requestLeave(ctx(db, PLANNER, {
    body: { staffId: 2, reason: 'annual_leave', from: FROM, to: TO },
  }))).json();
  assert.equal(out.days, 5);
  assert.equal(out.estimated, false);

  await assert.rejects(
    () => decideLeave(ctx(db, MANAGER, {
      body: { decision: 'approved', daysCharged: 6 },
    }), String(out.id)),
    /between 0 and 5/,
  );
});

test('the staff screen offers no rota-shaped excuse for not asking early', async () => {
  const { db } = setup();
  const week = await (await myWeek(ctx(db, KOFI, { query: '' }))).json();
  assert.ok(Array.isArray(week.reasons) && week.reasons.length, 'there is something to ask for');
});
