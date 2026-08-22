import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  LOCKOUT_MINUTES, MAX_TRIES, UNLOCK_HOURS, afterWrongCode, iso, mayOpen, newCode, readAccess,
  refusalFor, tidyCode, unlockUntil,
} from '../src/lib/payroll-access.js';
import { accessList, grant, guardPayroll, lock, myAccess, revoke, unlock } from '../src/routes/payroll-access.js';
import { payroll, setProfiles } from '../src/routes/payroll.js';
import worker from '../src/index.js';
import { createToken } from '../src/lib/auth.js';

/**
 * The lock on the payroll.
 *
 * What people are paid is the one thing in this app that cannot be un-seen, so
 * what matters here is what is refused. Every case below is somebody being
 * turned away: no grant, an expired one, a wrong code, a code guessed at, a
 * colleague's payslip, and a route added later that somebody forgot to lock.
 */

const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-22T10:00:00Z');
const rowAt = (over = {}) => ({
  user_id: 4,
  code_hash: 'x',
  granted_by: 'Kwame (admin)',
  expires_at: iso(NOW + 30 * 24 * HOUR),
  unlocked_until: null,
  locked_until: null,
  tries: 0,
  ...over,
});

// ---------------------------------------------------------------------------
// What the row means
// ---------------------------------------------------------------------------

test('no grant is not a grant', () => {
  const a = readAccess(null, NOW);
  assert.equal(a.state, 'none');
  assert.equal(a.granted, false);
  assert.equal(a.unlocked, false);
});

test('granted but not unlocked is shut, not open', () => {
  const a = readAccess(rowAt(), NOW);
  assert.equal(a.state, 'shut');
  assert.equal(a.granted, true);
  assert.equal(a.unlocked, false);
});

test('an unlock that has run out is shut again', () => {
  const stillGood = readAccess(rowAt({ unlocked_until: iso(NOW + HOUR) }), NOW);
  assert.equal(stillGood.state, 'open');

  const gone = readAccess(rowAt({ unlocked_until: iso(NOW - 60_000) }), NOW);
  assert.equal(gone.state, 'shut', 'a minute past is past');
});

test('the grant running out beats everything else', () => {
  // Somebody who was unlocked five minutes before their grant ended does not
  // stay unlocked for the rest of the day.
  const a = readAccess(rowAt({
    expires_at: iso(NOW - HOUR),
    unlocked_until: iso(NOW + 4 * HOUR),
  }), NOW);
  assert.equal(a.state, 'expired');
  assert.equal(a.unlocked, false);

  // And a locked-out person whose grant has expired is not locked out, they
  // are simply not granted any more.
  const b = readAccess(rowAt({
    expires_at: iso(NOW - HOUR),
    locked_until: iso(NOW + HOUR),
  }), NOW);
  assert.equal(b.state, 'expired');
});

test('guessing stops being free', () => {
  let row = rowAt();
  for (let i = 1; i < MAX_TRIES; i += 1) {
    const after = afterWrongCode(row, NOW);
    assert.equal(after.tries, i);
    assert.equal(after.lockedUntil, null, 'a fat thumb is not a break-in');
    row = { ...row, tries: after.tries };
  }

  const last = afterWrongCode(row, NOW);
  assert.equal(last.tries, 0, 'the count starts again with the lockout');
  assert.equal(last.lockedUntil, iso(NOW + LOCKOUT_MINUTES * 60_000));

  assert.equal(readAccess(rowAt({ locked_until: last.lockedUntil }), NOW).state, 'locked');
});

test('an unlock lasts a working day and no longer', () => {
  assert.equal(unlockUntil(new Date(NOW)), iso(NOW + UNLOCK_HOURS * HOUR));
});

// ---------------------------------------------------------------------------
// Who may open it
// ---------------------------------------------------------------------------

const asAdmin = { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['hr_pay'] };
const asBookkeeper = { user: { id: 4, name: 'Yaa', role: 'manager' }, permissions: ['hr_pay'] };

test('an administrator is always in, and never needs a grant', () => {
  assert.deepEqual(mayOpen(asAdmin, null, NOW).ok, true);
  assert.equal(mayOpen(asAdmin, null, NOW).why, 'admin');
  // Which is the point: a property with one administrator must never be able
  // to lock itself out of its own payroll.
});

test('the permission on its own opens nothing', () => {
  const out = mayOpen(asBookkeeper, null, NOW);
  assert.equal(out.ok, false);
  assert.equal(out.why, 'none');
  assert.match(refusalFor(out.why), /not been granted/);
});

test('a grant on its own opens nothing either', () => {
  const out = mayOpen(asBookkeeper, rowAt(), NOW);
  assert.equal(out.ok, false);
  assert.equal(out.why, 'shut');
  assert.match(refusalFor(out.why), /Enter your payroll code/);
});

test('granted, unlocked, and inside both windows is the only way in', () => {
  const out = mayOpen(asBookkeeper, rowAt({ unlocked_until: iso(NOW + HOUR) }), NOW);
  assert.equal(out.ok, true);
  assert.equal(out.why, 'unlocked');
});

// ---------------------------------------------------------------------------
// The code
// ---------------------------------------------------------------------------

test('a code is nine digits and reads out loud', () => {
  for (let i = 0; i < 50; i += 1) {
    const code = newCode();
    assert.match(code, /^\d{3} \d{3} \d{3}$/);
  }
  // Typed back with or without the spaces, because it is read off paper.
  assert.equal(tidyCode('123 456 789'), '123456789');
  assert.equal(tidyCode('123456789'), '123456789');
  assert.equal(tidyCode('123-456-789'), '123456789');
});

// ---------------------------------------------------------------------------
// Against a real database
// ---------------------------------------------------------------------------

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
  raw.exec('DELETE FROM users; DELETE FROM att_staff;');
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Ama', '2020-01-01')",
  ).run();
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, active) VALUES (1, 'Kwame', 'admin', 'a', 1)",
  ).run();
  // A bookkeeper: the pay permission and nothing else that matters here.
  raw.prepare(
    `INSERT INTO users (id, name, role, permissions, pin_hash, active)
     VALUES (4, 'Yaa', 'manager', '["hr_pay"]', 'b', 1)`,
  ).run();
  // And somebody without it at all.
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, active) VALUES (5, 'Kofi', 'staff', 'c', 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const ctx = (db, session, { body = null, url = '/api/payroll/grants' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x${url}`),
  session,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const read = async (r) => r.json();

test('a grant hands back a code once, and only its fingerprint is kept', async () => {
  const { db, raw } = setup();
  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));

  assert.match(made.code, /^\d{3} \d{3} \d{3}$/);
  assert.equal(made.name, 'Yaa');

  const row = raw.prepare('SELECT * FROM pay_access WHERE user_id = 4').get();
  assert.ok(row.code_hash);
  assert.ok(!String(row.code_hash).includes(tidyCode(made.code)), 'the code itself is not kept');
  assert.equal(row.granted_by, 'Kwame (admin)');
});

test('somebody without the pay permission cannot be granted the second lock', async () => {
  const { db } = setup();
  await assert.rejects(
    () => grant(ctx(db, asAdmin, { body: { userId: 5, days: 30 } })),
    /does not have "Pay and labour cost"/,
  );
});

test('an administrator has nothing to be given', async () => {
  const { db } = setup();
  await assert.rejects(
    () => grant(ctx(db, asAdmin, { body: { userId: 1, days: 30 } })),
    /already has the payroll/,
  );
});

test('the right code opens it, and the wrong one does not', async () => {
  const { db } = setup();
  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));

  await assert.rejects(
    () => unlock(ctx(db, asBookkeeper, { body: { code: '000 000 001' } })),
    /not right/,
  );

  const opened = await read(await unlock(ctx(db, asBookkeeper, { body: { code: made.code } })));
  assert.equal(opened.open, true);

  const now = await read(await myAccess(ctx(db, asBookkeeper)));
  assert.equal(now.open, true);
  assert.equal(now.state, 'open');
});

test('the code still works after the unlock runs out, until the grant does not', async () => {
  const { db, raw } = setup();
  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));
  await unlock(ctx(db, asBookkeeper, { body: { code: made.code } }));

  // Come back tomorrow: the unlock has gone but the code has not.
  raw.prepare("UPDATE pay_access SET unlocked_until = '2020-01-01 00:00:00' WHERE user_id = 4").run();
  assert.equal((await read(await myAccess(ctx(db, asBookkeeper)))).state, 'shut');
  assert.equal((await read(await unlock(ctx(db, asBookkeeper, { body: { code: made.code } })))).open, true);

  // Come back next year: it opens nothing.
  raw.prepare("UPDATE pay_access SET expires_at = '2020-01-01 00:00:00' WHERE user_id = 4").run();
  await assert.rejects(
    () => unlock(ctx(db, asBookkeeper, { body: { code: made.code } })),
    /run out/,
  );
});

test('five wrong codes and it shuts', async () => {
  const { db } = setup();
  await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } }));

  for (let i = 0; i < MAX_TRIES - 1; i += 1) {
    await assert.rejects(
      () => unlock(ctx(db, asBookkeeper, { body: { code: '000 000 001' } })), /not right/,
    );
  }
  await assert.rejects(
    () => unlock(ctx(db, asBookkeeper, { body: { code: '000 000 001' } })), /Too many wrong codes/,
  );
  assert.equal((await read(await myAccess(ctx(db, asBookkeeper)))).state, 'locked');
});

test('taking it away stops somebody who has it open, at once', async () => {
  const { db } = setup();
  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));
  await unlock(ctx(db, asBookkeeper, { body: { code: made.code } }));
  assert.equal((await read(await myAccess(ctx(db, asBookkeeper)))).open, true);

  await revoke(ctx(db, asAdmin), '4');
  assert.equal((await read(await myAccess(ctx(db, asBookkeeper)))).open, false);
  await assert.rejects(() => guardPayroll(ctx(db, asBookkeeper)), /not been granted/);
});

test('locking it again shuts it without giving up the grant', async () => {
  const { db } = setup();
  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));
  await unlock(ctx(db, asBookkeeper, { body: { code: made.code } }));
  await lock(ctx(db, asBookkeeper));

  const now = await read(await myAccess(ctx(db, asBookkeeper)));
  assert.equal(now.state, 'shut');
  assert.equal(now.granted, true, 'the code still opens it again');
});

test('the gate turns away everybody who has not been through all three locks', async () => {
  const { db } = setup();

  await assert.rejects(() => guardPayroll(ctx(db, asBookkeeper)), /not been granted/);

  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));
  await assert.rejects(() => guardPayroll(ctx(db, asBookkeeper)), /Enter your payroll code/);

  await unlock(ctx(db, asBookkeeper, { body: { code: made.code } }));
  await guardPayroll(ctx(db, asBookkeeper));

  // And an administrator sails through with no row at all.
  await guardPayroll(ctx(db, asAdmin));
});

test('the list says where everybody stands, and leaves out who cannot hold it', async () => {
  const { db } = setup();
  await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } }));

  const { people } = await read(await accessList(ctx(db, asAdmin)));
  const by = new Map(people.map((p) => [p.name, p]));

  assert.equal(by.get('Kwame').admin, true);
  assert.equal(by.get('Yaa').access.state, 'shut');
  assert.equal(by.has('Kofi'), false, 'no pay permission, so nothing to grant');
});

// ---------------------------------------------------------------------------
// The payslip
// ---------------------------------------------------------------------------

test('a payroll line reaches anybody but an administrator without its payslip', async () => {
  const { db } = setup();
  await setProfiles(ctx(db, asAdmin, {
    body: {
      rows: [{
        staffId: 1,
        onPayroll: true,
        basic: 2000,
        ssnit: true,
        allowances: [{ name: 'Transport', amount: 300, taxable: true }],
      }],
    },
  }));

  const mine = await read(await payroll(ctx(db, asAdmin, { url: '/api/payroll?month=2026-08' })));
  assert.equal(mine.slips, true);
  assert.equal(mine.lines[0].allowances.length, 1);
  assert.ok(mine.lines[0].paye.steps.length);

  const theirs = await read(await payroll(
    ctx(db, asBookkeeper, { url: '/api/payroll?month=2026-08' }),
  ));
  assert.equal(theirs.slips, false);
  // The figures the month is made of are still there, because that is the job.
  assert.equal(theirs.lines[0].basic, 2000);
  assert.equal(theirs.lines[0].allowanceTotal, 300);
  assert.equal(theirs.lines[0].net, mine.lines[0].net);
  // What the payslip would have added is not.
  assert.deepEqual(theirs.lines[0].allowances, []);
  assert.deepEqual(theirs.lines[0].paye.steps, []);
  assert.deepEqual(theirs.lines[0].bonus.schemes, []);
  assert.deepEqual(theirs.lines[0].loans, []);
});

// ---------------------------------------------------------------------------
// The routing table itself
// ---------------------------------------------------------------------------

test('every payroll route is behind the lock, except the three that open it', async () => {
  const source = readFileSync('src/index.js', 'utf8');
  const routes = [...source.matchAll(/'\/api\/payroll[^']*'/g)].map((m) => m[0].slice(1, -1));
  assert.ok(routes.length > 8, 'found the routes');

  const outside = new Set([
    '/api/payroll/access', '/api/payroll/unlock', '/api/payroll/lock',
    '/api/payroll/grants', '/api/payroll/grants/:id',
  ]);

  // `locked` in the router decides this, and it is a prefix so a route added
  // later is covered the day it is written. This asserts the exceptions are
  // the ones intended and nothing has quietly joined them.
  for (const path of routes) {
    const shouldBeLocked = !outside.has(path);
    assert.equal(
      path.startsWith('/api/payroll'),
      true,
      `${path} is under the payroll prefix`,
    );
    if (!shouldBeLocked) assert.ok(outside.has(path), `${path} is a deliberate exception`);
  }
});

/**
 * Through the front door, with a real signed cookie.
 *
 * The tests above call the handlers. This one goes through the router, which
 * is where both locks actually live, because a handler that is right behind a
 * gate nobody wired up is not protection.
 */
async function asUser(db, raw, userId) {
  const env = {
    DB: db,
    SESSION_SECRET: 'x'.repeat(40),
    ASSETS: { fetch: async () => new Response('asset') },
  };
  const token = await createToken(
    { uid: userId, exp: Math.floor(Date.now() / 1000) + 3600 },
    env.SESSION_SECRET,
  );
  const call = (path, init = {}) => worker.fetch(new Request(`https://x${path}`, {
    ...init,
    headers: { cookie: `bf_session=${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  }), env, null);
  return { env, call };
}

test('the router turns a bookkeeper away from the payroll until all three locks are open', async () => {
  const { db, raw } = setup();
  const admin = await asUser(db, raw, 1);
  const book = await asUser(db, raw, 4);

  // The permission alone.
  let res = await book.call('/api/payroll?month=2026-08');
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /not been granted/);

  // Granted, still shut.
  const made = await (await admin.call('/api/payroll/grants', {
    method: 'POST', body: JSON.stringify({ userId: 4, days: 30 }),
  })).json();
  res = await book.call('/api/payroll?month=2026-08');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).detail.payrollLocked, true);

  // Unlocked.
  assert.equal((await book.call('/api/payroll/unlock', {
    method: 'POST', body: JSON.stringify({ code: made.code }),
  })).status, 200);
  assert.equal((await book.call('/api/payroll?month=2026-08')).status, 200);

  // Every other payroll route is behind the same gate, including the ones
  // added after this was written.
  await (await book.call('/api/payroll/lock', { method: 'POST', body: '{}' })).json();
  for (const path of ['/api/payroll?month=2026-08', '/api/payroll/returns?month=2026-08',
    '/api/payroll/input/template?month=2026-08']) {
    assert.equal((await book.call(path)).status, 403, path);
  }
});

test('somebody else’s payslip is refused to anybody who is not an administrator', async () => {
  const { db, raw } = setup();
  const admin = await asUser(db, raw, 1);
  const book = await asUser(db, raw, 4);

  await admin.call('/api/payroll/profiles', {
    method: 'POST',
    body: JSON.stringify({ rows: [{ staffId: 1, onPayroll: true, basic: 2000, ssnit: true }] }),
  });

  // The bookkeeper is fully unlocked, and it still makes no difference.
  const made = await (await admin.call('/api/payroll/grants', {
    method: 'POST', body: JSON.stringify({ userId: 4, days: 30 }),
  })).json();
  await book.call('/api/payroll/unlock', {
    method: 'POST', body: JSON.stringify({ code: made.code }),
  });
  assert.equal((await book.call('/api/payroll?month=2026-08')).status, 200,
    'they can run the month');

  const refused = await book.call('/api/payroll/slip/1?month=2026-08');
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /Only an administrator/);

  assert.equal((await admin.call('/api/payroll/slip/1?month=2026-08')).status, 200);
});

test('a login with no pay permission gets nowhere near any of it', async () => {
  const { db, raw } = setup();
  const nobody = await asUser(db, raw, 5);

  for (const path of ['/api/payroll?month=2026-08', '/api/payroll/access',
    '/api/payroll/slip/1', '/api/payroll/grants']) {
    const res = await nobody.call(path);
    assert.equal(res.status, 403, path);
  }
});
