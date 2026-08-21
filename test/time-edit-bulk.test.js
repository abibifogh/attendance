import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { correctTimes, decideTimeEdits } from '../src/routes/attendance.js';

/**
 * Ruling on a stack of clock corrections at once.
 *
 * A morning's worth of them all say the same thing — the terminal missed the
 * clock-out again — and answering them one dialog at a time is how a queue
 * stops being read. Each is still applied on its own terms; what is shared is
 * the decision and the note.
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

const DAYS = ['2026-06-01', '2026-06-02', '2026-06-03'];

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_time_edit; DELETE FROM app_notices; DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-01')`,
  ).run();
  for (const day of DAYS) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, 1)').run(day);
    // Clocked in, never clocked out. The everyday case.
    raw.prepare(
      `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day,
                                direction, dedupe_key)
       VALUES ('D1', '1', 1, ?, ?, ?, 'in', ?)`,
    ).run(`${day} 06:00:00`, `${day} 06:00:00`, day, `${day}-in`);
  }
  return { raw, db: d1(raw) };
}

const PLANNER = { user: { id: 5, name: 'Yaa', role: 'planner' }, permissions: ['att_times'] };
const ADMIN = { user: { id: 2, name: 'Ama', role: 'admin' }, permissions: ['att_setup', 'att_times'] };

const ctx = (db, session, body) => ({
  db,
  env: {},
  url: new URL('https://x/api/att/time-edits/decide'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const askForAll = async (db) => {
  for (const day of DAYS) {
    await correctTimes(ctx(db, PLANNER, {
      staffId: 1, in: '06:00', out: '14:00', reason: 'Terminal missed the clock-out',
    }), day);
  }
};

test('one answer settles the whole stack', async () => {
  const { db, raw } = setup();
  await askForAll(db);
  const ids = raw.prepare("SELECT id FROM att_time_edit WHERE status = 'pending'").all().map((r) => r.id);
  assert.equal(ids.length, 3);

  const out = await (await decideTimeEdits(ctx(db, ADMIN, {
    ids, decision: 'approve', note: null,
  }))).json();
  assert.equal(out.decided.length, 3);
  assert.equal(out.failed.length, 0);

  assert.equal(raw.prepare("SELECT count(*) AS n FROM att_time_edit WHERE status = 'approved'").get().n, 3);
  // Each day was applied on its own terms, not as one blanket edit.
  for (const day of DAYS) {
    const row = raw.prepare('SELECT corrected_out FROM att_days WHERE staff_id = 1 AND day = ?').get(day);
    assert.equal(row.corrected_out, '14:00');
  }
});

test('one that cannot be ruled on does not stop the rest', async () => {
  const { db, raw } = setup();
  await askForAll(db);
  const ids = raw.prepare("SELECT id FROM att_time_edit WHERE status = 'pending'").all().map((r) => r.id);

  const out = await (await decideTimeEdits(ctx(db, ADMIN, {
    ids: [...ids, 9999], decision: 'approve',
  }))).json();
  assert.equal(out.decided.length, 3);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].id, 9999);
});

test('sending a stack back will not take no answer', async () => {
  const { db, raw } = setup();
  await askForAll(db);
  const ids = raw.prepare("SELECT id FROM att_time_edit WHERE status = 'pending'").all().map((r) => r.id);

  await assert.rejects(
    () => decideTimeEdits(ctx(db, ADMIN, { ids, decision: 'reject' })),
    /Say why/,
  );

  await decideTimeEdits(ctx(db, ADMIN, {
    ids, decision: 'reject', note: 'The terminal was down. Raise it against the right shift.',
  }));
  assert.equal(raw.prepare("SELECT count(*) AS n FROM att_time_edit WHERE status = 'rejected'").get().n, 3);
  // Nothing was applied to any of the days.
  assert.equal(raw.prepare('SELECT count(*) AS n FROM att_days WHERE corrected_out IS NOT NULL').get().n, 0);
});

test('an approval rings the bell and does not send an email', async () => {
  const { db, raw } = setup();
  await askForAll(db);
  const ids = raw.prepare("SELECT id FROM att_time_edit WHERE status = 'pending'").all().map((r) => r.id);

  // Asking for a correction rings its own bell; this test is about the answer.
  raw.exec('DELETE FROM app_notices');

  const sent = [];
  const withMail = {
    ...ctx(db, ADMIN, { ids, decision: 'approve' }),
    env: { RESEND_API_KEY: 'x', ATT_EMAIL_FROM: 'a@b.com' },
  };
  globalThis.fetch = async (...args) => { sent.push(args); return new Response('{}', { status: 200 }); };

  await decideTimeEdits(withMail);
  assert.equal(sent.length, 0, 'no email for an approval');
  assert.equal(
    raw.prepare("SELECT count(*) AS n FROM app_notices WHERE kind = 'attendance.times'").get().n,
    3,
    'the bell still rings',
  );
});

test('nothing ticked is refused rather than treated as everything', async () => {
  const { db } = setup();
  await assert.rejects(
    () => decideTimeEdits(ctx(db, ADMIN, { ids: [], decision: 'approve' })),
    /Tick at least one/,
  );
});
