import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  answerQueries, answerQuery, listQueries, outstanding, raiseQuery, signDays,
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

// ---------------------------------------------------------------------------
// What the question is about
// ---------------------------------------------------------------------------

const questions = async (db) => (await listQueries(ctx(db, null, '?status=all'))).json();
const onlyQuestion = async (db) => (await questions(db)).rows[0];

/** Move a day's punches, so a day on the question is a day with something on it. */
const clockedAt = (raw, day, inAt, outAt) => {
  raw.prepare('DELETE FROM att_punches WHERE day = ? AND staff_id = 1').run(day);
  for (const [at, dir] of [[inAt, 'in'], [outAt, 'out']].filter(([at]) => at)) {
    raw.prepare(
      `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day,
                                direction, dedupe_key)
       VALUES ('D1', '1', 1, ?, ?, ?, ?, ?)`,
    ).run(`${day} ${at}`, `${day} ${at}`, day, dir, `${day}-${at}-${dir}-x`);
  }
};

test('a question carries the days it is about, and what was clocked on them', async () => {
  // The whole point: the counts on the card and what they are counting are on
  // the same card, rather than one screen apart.
  const { db } = setup();
  await askAbout(db, [DAYS[0], DAYS[1]]);

  const q = await onlyQuestion(db);
  assert.deepEqual(q.records.map((r) => r.day), [DAYS[0], DAYS[1]]);
  assert.equal(q.records[0].shift, 'Morning');
  assert.equal(q.records[0].in, '06:00');
  assert.equal(q.records[0].out, '14:00');
  assert.equal(q.records[0].label, 'Present');
  assert.deepEqual(q.records[0].issues, []);
});

test('a late day says how late on the question itself', async () => {
  const { db, raw } = setup();
  clockedAt(raw, DAYS[0], '06:40:00', '14:00:00');
  await askAbout(db, [DAYS[0]]);

  const q = await onlyQuestion(db);
  assert.equal(q.records[0].in, '06:40');
  assert.ok(q.records[0].lateMinutes >= 30, `late by ${q.records[0].lateMinutes}`);
  assert.ok(q.records[0].issues.includes('late'));
});

test('a day nobody clocked comes back saying so rather than lying about a time', async () => {
  const { db, raw } = setup();
  raw.prepare('DELETE FROM att_punches WHERE day = ? AND staff_id = 1').run(DAYS[2]);
  await askAbout(db, [DAYS[2]]);

  const q = await onlyQuestion(db);
  assert.equal(q.records[0].in, null);
  assert.equal(q.records[0].out, null);
  assert.equal(q.records[0].shift, 'Morning', 'the shift they were due on is still worth saying');
});

test('one forgotten question does not drag years of attendance in behind it', async () => {
  // The days are read out of one dataset for the whole screen, so the span it
  // covers is capped. A question left open since 2019 beside this week's comes
  // back without its days rather than making everybody wait for six years of
  // punches to load.
  const { db, raw } = setup();
  const recent = await askAbout(db, [DAYS[0]]);
  const ancient = await askAbout(db, [DAYS[1]]);
  raw.prepare("UPDATE att_query SET from_day = '2019-01-01', to_day = '2019-01-01', days = ? WHERE id = ?")
    .run(JSON.stringify(['2019-01-01']), ancient);

  const rows = (await questions(db)).rows;
  assert.deepEqual(rows.find((q) => q.id === ancient).records, []);
  assert.equal(rows.find((q) => q.id === recent).records.length, 1,
    'and this week\u2019s question still has its day');
});

// ---------------------------------------------------------------------------
// Several at once
// ---------------------------------------------------------------------------

const together = (db, body) => answerQueries(ctx(db, body)).then((r) => r.json());

test('one sentence answers several questions', async () => {
  const { db, raw } = setup();
  const a = await askAbout(db, [DAYS[0]]);
  const b = await askAbout(db, [DAYS[1]]);

  const out = await together(db, {
    ids: [a, b], action: 'direction', body: 'Charge these to sick leave and sign them.',
  });

  assert.equal(out.done.length, 2);
  assert.equal(out.skipped.length, 0);
  const rows = raw.prepare('SELECT status FROM att_query ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.status), ['answered', 'answered']);

  // The same words on each thread, and a bell each for whoever asked.
  const notes = raw.prepare("SELECT * FROM att_query_note WHERE kind = 'direction'").all();
  assert.equal(notes.length, 2);
  for (const note of notes) assert.match(note.body, /sick leave/);
});

test('one that cannot be answered is named rather than taking the rest down', async () => {
  const { db, raw } = setup();
  const a = await askAbout(db, [DAYS[0]]);
  const b = await askAbout(db, [DAYS[1]]);
  await answerQuery(ctx(db, { action: 'close' }), b);

  const out = await together(db, { ids: [a, b], action: 'close', body: 'Nothing in these.' });

  assert.equal(out.done.length, 1);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].id, b);
  assert.match(out.skipped[0].why, /already been dealt with/);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM att_query WHERE status = 'resolved'").get().n, 2);
});

test('signing several puts nothing against anybody’s leave', async () => {
  // A figure spread across several people is not a decision about any of them.
  // Whatever the caller sends, a bulk sign applies nothing.
  const { db, raw } = setup();
  const a = await askAbout(db, [DAYS[0]]);
  const b = await askAbout(db, [DAYS[1]]);

  await together(db, { ids: [a, b], action: 'sign', body: 'Both fine.', daysApplied: -3 });

  const applied = raw.prepare('SELECT days_applied FROM att_period_review').all();
  assert.equal(applied.length, 2);
  for (const row of applied) assert.equal(row.days_applied, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM att_leave_change').get().n, 0,
    'and nobody is asked to approve one either');
});

test('an empty tick list is refused rather than quietly doing nothing', async () => {
  const { db } = setup();
  await assert.rejects(() => answerQueries(ctx(db, { ids: [], action: 'close' })),
    /at least one question/);
});
