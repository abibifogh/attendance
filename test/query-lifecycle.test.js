import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  answerQuery, outstanding, raiseQuery, signDays,
} from '../src/routes/signoff.js';

/**
 * What answering a question does to the days it was about.
 *
 * The distinction that matters: a reply is not an answer. Somebody can add a
 * note to a thread and mean nothing by it, and while the question is open the
 * days stay unsignable — which is right, and which is also why the screen must
 * never let somebody answer carefully and then find they have only replied.
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

const DAYS = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'];

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_query; DELETE FROM users;`);
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
    for (const [at, dir] of [['06:00:00', 'in'], ['14:00:00', 'out']]) {
      raw.prepare(
        `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day,
                                  direction, dedupe_key)
         VALUES ('D1', '1', 1, ?, ?, ?, ?, ?)`,
      ).run(`${day} ${at}`, `${day} ${at}`, day, dir, `${day}-${at}-${dir}`);
    }
  }
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 2, name: 'Yaa', role: 'admin' }, permissions: ['att_signoff', 'att_manage', 'att_rota'] };
const ctx = (db, body, query = '') => ({
  db,
  env: {},
  url: new URL(`https://x/api/att/x${query}`),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const WINDOW = '?from=2026-06-01&to=2026-06-10';
const listing = async (db) => (await outstanding(ctx(db, null, WINDOW))).json();

const askAbout = async (db, days) => (await (await raiseQuery(ctx(db, {
  staffId: 1, days, reason: 'Two short days I cannot explain.',
}))).json()).id;

test('a question parks its own days and leaves the rest alone', async () => {
  const { db } = setup();
  const id = await askAbout(db, ['2026-06-02', '2026-06-03']);
  assert.ok(id);

  const out = await listing(db);
  assert.equal(out.asked, 2);
  assert.equal(out.answered, 0);
  // The other three are still perfectly signable.
  await signDays(ctx(db, {
    staffId: 1, days: ['2026-06-01', '2026-06-04', '2026-06-05'], daysApplied: 0,
  }));
  assert.equal((await listing(db)).total, 2);
});

test('a reply is not an answer: the days stay parked', async () => {
  const { db } = setup();
  const id = await askAbout(db, ['2026-06-02', '2026-06-03']);

  await answerQuery(ctx(db, { action: 'comment', body: 'Looking into it.' }), id);

  const out = await listing(db);
  assert.equal(out.asked, 2, 'still waiting');
  assert.equal(out.answered, 0);
  await assert.rejects(
    () => signDays(ctx(db, { staffId: 1, days: ['2026-06-02'], daysApplied: 0 })),
    /waiting on an answer/,
  );
});

test('handing it back moves the days and unblocks them', async () => {
  const { db } = setup();
  const id = await askAbout(db, ['2026-06-02', '2026-06-03']);

  await answerQuery(ctx(db, {
    action: 'direction', body: 'He was at the clinic. Mark it sick leave and sign it.',
  }), id);

  const out = await listing(db);
  assert.equal(out.asked, 0);
  assert.equal(out.answered, 2, 'they move to the answered group');

  await signDays(ctx(db, { staffId: 1, days: ['2026-06-02', '2026-06-03'], daysApplied: 0 }));
  assert.equal((await listing(db)).total, 3);
});

test('signing the days it asked about closes the question', async () => {
  const { db, raw } = setup();
  const id = await askAbout(db, ['2026-06-02', '2026-06-03']);

  await answerQuery(ctx(db, { action: 'direction', body: 'Sign it.' }), id);
  await signDays(ctx(db, { staffId: 1, days: ['2026-06-02', '2026-06-03'], daysApplied: 0 }));

  const row = raw.prepare('SELECT status, outcome FROM att_query WHERE id = ?').get(id);
  assert.equal(row.status, 'resolved');
  assert.equal(row.outcome, 'signed');
});

test('closing it with nothing needed also frees the days', async () => {
  const { db } = setup();
  const id = await askAbout(db, ['2026-06-02']);

  await answerQuery(ctx(db, { action: 'close', body: 'Nothing in it.' }), id);

  const out = await listing(db);
  assert.equal(out.asked, 0);
  await signDays(ctx(db, { staffId: 1, days: ['2026-06-02'], daysApplied: 0 }));
});

test('a signed day does not come back onto the list', async () => {
  const { db } = setup();
  assert.equal((await listing(db)).total, 5);

  await signDays(ctx(db, { staffId: 1, days: DAYS, daysApplied: 0 }));

  const out = await listing(db);
  assert.equal(out.total, 0);
  assert.equal(out.rows.length, 0);
});

test('a broken review table is heard rather than read as nothing signed', async () => {
  const { db, raw } = setup();
  await signDays(ctx(db, { staffId: 1, days: DAYS, daysApplied: 0 }));

  // Anything other than "this database has not been upgraded yet" has to
  // surface. An empty answer here puts every signed day back on the list.
  const broken = {
    ...db,
    prepare: (sql) => (sql.includes('att_period_review')
      ? { bind: () => ({ all: async () => { throw new Error('D1_ERROR: network connection lost'); } }) }
      : db.prepare(sql)),
  };
  await assert.rejects(() => outstanding(ctx(broken, null, WINDOW)), /connection lost/);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM att_period_review').get().n, 1);
});
