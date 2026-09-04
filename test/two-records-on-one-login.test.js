import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  MOST_RECORDS, readIds, recordsOn, tidyExtras, whoIsMeant,
} from '../src/lib/records-on-a-login.js';
import { settleLeaving } from '../src/lib/leaving.js';
import worker from '../src/index.js';
import { createToken } from '../src/lib/auth.js';

/**
 * More than one person's record on a single login.
 *
 * The point of the tests is the refusals. A login that can open two people's
 * payslips is one mistake away from opening everybody's, so what is pinned down
 * here is that a request only ever reaches a record the administrator put on
 * that login: not one the browser asked for, not one that was taken off again,
 * and not one belonging to somebody who has left.
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
    async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}

// Kwame is the login. Adjoa is his wife, on the books and with no phone of her
// own; Yaw works here too and is nothing to do with either of them.
const KWAME = 1;
const ADJOA = 2;
const YAW = 3;

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_staff; DELETE FROM users;
            DELETE FROM att_shifts;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0)`,
  ).run();

  for (const [id, name] of [[KWAME, 'Kwame'], [ADJOA, 'Adjoa'], [YAW, 'Yaw']]) {
    raw.prepare(
      'INSERT INTO att_staff (id, employee_no, name, hired_on, department) VALUES (?, ?, ?, ?, ?)',
    ).run(id, String(id), name, '2020-01-01', 'Housekeeping');
  }

  // One administrator, and Kwame's own login.
  raw.prepare(
    "INSERT INTO users (id, name, role, active, email) VALUES (9, 'Boss', 'admin', 1, 'boss@x.test')",
  ).run();
  raw.prepare(
    "INSERT INTO users (id, name, role, active, staff_id) VALUES (10, 'Kwame', 'staff', 1, ?)",
  ).run(KWAME);

  return { raw, db: d1(raw) };
}

async function asUser(db, userId) {
  const env = {
    DB: db,
    SESSION_SECRET: 'x'.repeat(40),
    ASSETS: { fetch: async () => new Response('asset') },
  };
  const token = await createToken(
    { uid: userId, via: 'password', exp: Math.floor(Date.now() / 1000) + 3600 },
    env.SESSION_SECRET,
  );
  const call = (path, init = {}) => worker.fetch(new Request(`https://x${path}`, {
    ...init,
    headers: {
      cookie: `bf_session=${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  }), env, null);
  return { env, call };
}

/** Put a record on a login the way the Users screen does. */
const alsoOpens = (call, ids) => call('/api/users/10', {
  method: 'PUT',
  body: JSON.stringify({
    name: 'Kwame', role: 'staff', active: true, pin: '654321',
    staffId: KWAME, alsoStaffIds: ids,
  }),
});

// ---------------------------------------------------------------------------
// The rule on its own
// ---------------------------------------------------------------------------

test('their own record comes first, however the extras arrive', () => {
  assert.deepEqual(recordsOn(4, '9,11'), [4, 9, 11]);
  assert.deepEqual(recordsOn(4, [11, 9]), [4, 11, 9]);
  assert.deepEqual(recordsOn(4, '4,9'), [4, 9], 'a repeat of their own is not a second record');
  assert.deepEqual(recordsOn(4, null), [4]);
  assert.deepEqual(recordsOn(null, '9'), [9]);
});

test('nothing asked for means their own', () => {
  assert.deepEqual(whoIsMeant([4, 9], null), { staffId: 4, refused: false });
  assert.deepEqual(whoIsMeant([4, 9], ''), { staffId: 4, refused: false });
  assert.deepEqual(whoIsMeant([], null), { staffId: null, refused: false });
});

test('a record that is not on the login is refused, not quietly swapped', () => {
  // The whole reason this is a refusal: answering with their own record would
  // put one name at the top of the screen and another person's pay under it.
  assert.deepEqual(whoIsMeant([4, 9], 7), { staffId: null, refused: true });
  assert.deepEqual(whoIsMeant([4, 9], 'nine'), { staffId: null, refused: true });
  assert.deepEqual(whoIsMeant([4, 9], 9), { staffId: 9, refused: false });
});

test('extras are extra to somebody', () => {
  assert.deepEqual(tidyExtras([9, 11], null), [], 'a login that is nobody carries nobody');
  assert.deepEqual(tidyExtras([4, 9], 4), [9], 'their own is not one of the extras');
  assert.equal(tidyExtras(Array.from({ length: 30 }, (_, i) => i + 20), 4).length,
    MOST_RECORDS - 1, 'and there is a limit, because past it this is a shared account');
});

test('ids read the same however the database or the browser sends them', () => {
  assert.deepEqual(readIds('4,9'), [4, 9]);
  assert.deepEqual(readIds([4, '9', 9]), [4, 9]);
  assert.deepEqual(readIds(null), []);
  assert.deepEqual(readIds('4,x,-2,0'), [4]);
});

// ---------------------------------------------------------------------------
// Putting a record on a login
// ---------------------------------------------------------------------------

test('an administrator adds a second record and the Users screen says so', async () => {
  const { db, raw } = setup();
  const boss = await asUser(db, 9);

  const saved = await (await alsoOpens(boss.call, [ADJOA])).json();
  assert.deepEqual(saved.user.alsoStaffIds, [ADJOA]);

  const rows = raw.prepare('SELECT user_id, staff_id FROM user_staff').all();
  assert.deepEqual(rows.map((r) => [r.user_id, r.staff_id]), [[10, ADJOA]]);

  const list = await (await boss.call('/api/users')).json();
  assert.deepEqual(list.users.find((u) => u.id === 10).alsoStaffIds, [ADJOA]);
});

test('somebody who is not on the staff list cannot be put on a login', async () => {
  const { db, raw } = setup();
  const boss = await asUser(db, 9);

  const said = await alsoOpens(boss.call, [4321]);
  assert.equal(said.status, 400);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM user_staff').get().n, 0);
});

test('a bad name on a new login leaves no half-made login behind', async () => {
  // The check runs before the row is written, so the refusal is the whole of
  // what happened rather than the half of it that got there first.
  const { db, raw } = setup();
  const boss = await asUser(db, 9);

  const said = await boss.call('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Adjoa', role: 'staff', pin: '654321', staffId: ADJOA, alsoStaffIds: [4321],
    }),
  });
  assert.equal(said.status, 400);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM users WHERE name = 'Adjoa'").get().n, 0);
});

test('taking the record off again takes it off', async () => {
  const { db, raw } = setup();
  const boss = await asUser(db, 9);

  await alsoOpens(boss.call, [ADJOA, YAW]);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM user_staff').get().n, 2);

  await alsoOpens(boss.call, []);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM user_staff').get().n, 0);
});

// ---------------------------------------------------------------------------
// Whose screens come back
// ---------------------------------------------------------------------------

test('with nothing asked for, the login is still its own person', async () => {
  const { db } = setup();
  const boss = await asUser(db, 9);
  await alsoOpens(boss.call, [ADJOA]);

  const kwame = await asUser(db, 10);
  const week = await (await kwame.call('/api/me/week')).json();
  assert.equal(week.me.id, KWAME);
  assert.equal(week.me.name, 'Kwame');
});

test('asking for the other record answers with the other person', async () => {
  const { db } = setup();
  const boss = await asUser(db, 9);
  await alsoOpens(boss.call, [ADJOA]);

  const kwame = await asUser(db, 10);
  const week = await (await kwame.call('/api/me/week', {
    headers: { 'X-Hive-Acting-For': String(ADJOA) },
  })).json();
  assert.equal(week.me.id, ADJOA);
  assert.equal(week.me.name, 'Adjoa');
});

test('asking for somebody who was never put on the login is refused', async () => {
  const { db } = setup();
  const boss = await asUser(db, 9);
  await alsoOpens(boss.call, [ADJOA]);

  const kwame = await asUser(db, 10);
  const said = await kwame.call('/api/me/week', {
    headers: { 'X-Hive-Acting-For': String(YAW) },
  });
  assert.equal(said.status, 403);
});

test('the money screens follow the same choice as the week', async () => {
  // Pinned because they read the staff id off the session separately, and a
  // week that switched while the payslips did not would be the worst of both.
  const { db } = setup();
  const boss = await asUser(db, 9);
  await alsoOpens(boss.call, [ADJOA]);

  const kwame = await asUser(db, 10);
  const mine = await (await kwame.call('/api/me/advances')).json();
  const hers = await (await kwame.call('/api/me/advances', {
    headers: { 'X-Hive-Acting-For': String(ADJOA) },
  })).json();
  assert.equal(mine.linked, true);
  assert.equal(hers.linked, true);

  const said = await kwame.call('/api/me/advances', {
    headers: { 'X-Hive-Acting-For': String(YAW) },
  });
  assert.equal(said.status, 403);
});

test('the session says who is on the login, so the screen can offer them', async () => {
  const { db } = setup();
  const boss = await asUser(db, 9);
  await alsoOpens(boss.call, [ADJOA]);

  const kwame = await asUser(db, 10);
  const me = await (await kwame.call('/api/auth/me')).json();
  assert.deepEqual(me.records.map((p) => p.name), ['Kwame', 'Adjoa']);

  // And nothing at all for the ordinary login, which is one person.
  const alone = await (await boss.call('/api/auth/me')).json();
  assert.deepEqual(alone.records, []);
});

// ---------------------------------------------------------------------------
// Coming off again
// ---------------------------------------------------------------------------

test('somebody who leaves comes off whoever else was carrying them', async () => {
  const { db, raw } = setup();
  const boss = await asUser(db, 9);
  await alsoOpens(boss.call, [ADJOA]);

  await settleLeaving(db, {
    staffId: ADJOA, leftOn: '2020-06-30', today: '2020-07-01', actor: 'test',
  });
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM user_staff').get().n, 0);

  const kwame = await asUser(db, 10);
  const said = await kwame.call('/api/me/week', {
    headers: { 'X-Hive-Acting-For': String(ADJOA) },
  });
  assert.equal(said.status, 403, 'and the phone that had her record stops opening it');
});

test('removing a login takes its extra records with it', async () => {
  const { db, raw } = setup();
  const boss = await asUser(db, 9);
  await alsoOpens(boss.call, [ADJOA]);

  await boss.call('/api/users/10', { method: 'DELETE' });
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM user_staff').get().n, 0);
});
