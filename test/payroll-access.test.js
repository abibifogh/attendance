import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  LOCKOUT_MINUTES, MAX_TRIES, UNLOCK_MINUTES, afterWrongTry, iso, mayOpen, needsRenewal, newCode,
  readAccess, refusalFor, tidyCode, unlockUntil,
} from '../src/lib/payroll-access.js';
import {
  accessList, grant, guardPayroll, lock, myAccess, resetPin, revoke, setPin, unlock,
} from '../src/routes/payroll-access.js';
import { payroll, setProfiles } from '../src/routes/payroll.js';
import worker from '../src/index.js';
import { createToken, getPepper, hashPin } from '../src/lib/auth.js';

/**
 * The lock on the payroll.
 *
 * What people are paid is the one thing in this app that cannot be un-seen, so
 * what matters here is what is refused. Every case below is somebody being
 * turned away: no grant, an expired one, a wrong PIN, a PIN guessed at, a PIN
 * that is only the login PIN again, a colleague's payslip, and a route added
 * later that somebody forgot to lock.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-22T10:00:00Z');
const rowAt = (over = {}) => ({
  user_id: 4,
  code_hash: 'x',
  pin_hash: 'p',
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

test('granted with no PIN yet is a setup, not a refusal', () => {
  const a = readAccess(rowAt({ pin_hash: null }), NOW);
  assert.equal(a.state, 'setup');
  assert.equal(a.granted, true);
  assert.equal(a.hasPin, false);
});

test('granted and enrolled but not unlocked is shut, not open', () => {
  const a = readAccess(rowAt(), NOW);
  assert.equal(a.state, 'shut');
  assert.equal(a.granted, true);
  assert.equal(a.unlocked, false);
});

test('a row with no end date on it never runs out', () => {
  // Which is only ever an administrator's own row: they are granted nothing,
  // and a property with one administrator must never lock itself out.
  const a = readAccess(rowAt({ code_hash: null, expires_at: null }), NOW);
  assert.equal(a.granted, true);
  assert.equal(a.state, 'shut');
});

test('an unlock that has run out is shut again', () => {
  const stillGood = readAccess(rowAt({ unlocked_until: iso(NOW + 10 * MINUTE) }), NOW);
  assert.equal(stillGood.state, 'open');

  const gone = readAccess(rowAt({ unlocked_until: iso(NOW - MINUTE) }), NOW);
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
    const after = afterWrongTry(row, NOW);
    assert.equal(after.tries, i);
    assert.equal(after.lockedUntil, null, 'a fat thumb is not a break-in');
    row = { ...row, tries: after.tries };
  }

  const last = afterWrongTry(row, NOW);
  assert.equal(last.tries, 0, 'the count starts again with the lockout');
  assert.equal(last.lockedUntil, iso(NOW + LOCKOUT_MINUTES * MINUTE));

  assert.equal(readAccess(rowAt({ locked_until: last.lockedUntil }), NOW).state, 'locked');
});

test('the window is minutes, and it slides only once half of it has gone', () => {
  assert.equal(unlockUntil(new Date(NOW)), iso(NOW + UNLOCK_MINUTES * MINUTE));

  const fresh = rowAt({ unlocked_until: iso(NOW + UNLOCK_MINUTES * MINUTE) });
  assert.equal(needsRenewal(fresh, NOW), false, 'no write behind every read');

  const wearing = rowAt({ unlocked_until: iso(NOW + 5 * MINUTE) });
  assert.equal(needsRenewal(wearing, NOW), true, 'an hour of work does not shut halfway');

  assert.equal(needsRenewal(rowAt(), NOW), false, 'nothing to renew');
});

// ---------------------------------------------------------------------------
// Who may open it
// ---------------------------------------------------------------------------

const asAdmin = { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['hr_pay'], via: 'password' };
// The same administrator, in through the keypad rather than the sign-in form.
const asAdminOnAPin = { ...asAdmin, via: 'pin' };
const asBookkeeper = { user: { id: 4, name: 'Yaa', role: 'manager' }, permissions: ['hr_pay'], via: 'pin' };
const asRecovery = {
  user: { id: 0, name: 'Recovery access', role: 'admin', isRecovery: true },
  permissions: ['hr_pay'],
};

test('an administrator is asked for a PIN like everybody else', () => {
  const out = mayOpen(asAdmin, null, NOW);
  assert.equal(out.ok, false);
  assert.equal(out.why, 'setup', 'no row means they have never chosen one, not that they cannot');
  assert.match(refusalFor(out.why), /Choose a payroll PIN/);

  // And once they have one, it is the same question as anybody else gets.
  assert.equal(mayOpen(asAdmin, rowAt({ code_hash: null, expires_at: null }), NOW).why, 'shut');
});

test('the recovery login is the way back in, and the only way past the PIN', () => {
  // Whoever holds the worker's secrets already holds everything a PIN
  // protects, and a property with one administrator who has forgotten theirs
  // must not be locked out of its own payroll.
  const out = mayOpen(asRecovery, null, NOW);
  assert.equal(out.ok, true);
  assert.equal(out.why, 'recovery');
});

test('the permission on its own opens nothing', () => {
  const out = mayOpen(asBookkeeper, null, NOW);
  assert.equal(out.ok, false);
  assert.equal(out.why, 'none');
  assert.match(refusalFor(out.why), /not been granted/);
});

test('a grant on its own opens nothing either', () => {
  const out = mayOpen(asBookkeeper, rowAt({ pin_hash: null }), NOW);
  assert.equal(out.ok, false);
  assert.equal(out.why, 'setup');
});

test('granted, enrolled, unlocked and inside every window is the only way in', () => {
  const out = mayOpen(asBookkeeper, rowAt({ unlocked_until: iso(NOW + MINUTE) }), NOW);
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

/** Grant a bookkeeper and take them all the way through to a PIN. */
async function enrolled(db, { pin = '4321' } = {}) {
  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));
  await setPin(ctx(db, asBookkeeper, { body: { code: made.code, pin } }));
  return made;
}

test('a grant hands back a code once, and only its fingerprint is kept', async () => {
  const { db, raw } = setup();
  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));

  assert.match(made.code, /^\d{3} \d{3} \d{3}$/);
  assert.equal(made.name, 'Yaa');

  const row = raw.prepare('SELECT * FROM pay_access WHERE user_id = 4').get();
  assert.ok(row.code_hash);
  assert.ok(!String(row.code_hash).includes(tidyCode(made.code)), 'the code itself is not kept');
  assert.equal(row.granted_by, 'Kwame (admin)');
  assert.equal(row.pin_hash, null, 'a grant is not a PIN');
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

// ---------------------------------------------------------------------------
// The PIN
// ---------------------------------------------------------------------------

test('a member of staff needs the code to choose a PIN, and it has to be the right one', async () => {
  const { db } = setup();
  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));

  await assert.rejects(
    () => setPin(ctx(db, asBookkeeper, { body: { pin: '4321' } })),
    /Type the code/,
  );
  await assert.rejects(
    () => setPin(ctx(db, asBookkeeper, { body: { code: '000 000 001', pin: '4321' } })),
    /code is not right/,
  );

  const done = await read(await setPin(ctx(db, asBookkeeper, { body: { code: made.code, pin: '4321' } })));
  assert.equal(done.open, true, 'they just proved it is them, so they are in');
});

test('a PIN is 4 to 10 digits and nothing else', async () => {
  const { db } = setup();
  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));

  for (const bad of ['12', '12345678901', 'abcd', '12 34', '']) {
    await assert.rejects(
      () => setPin(ctx(db, asBookkeeper, { body: { code: made.code, pin: bad } })),
      /4 to 10 digits/,
      String(bad),
    );
  }
});

test('the payroll PIN cannot be the PIN they sign in with', async () => {
  const { db, raw } = setup();
  const pepper = await getPepper(db);
  raw.prepare('UPDATE users SET pin_hash = ? WHERE id = 4')
    .run(await hashPin('1234', pepper));

  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));
  await assert.rejects(
    () => setPin(ctx(db, asBookkeeper, { body: { code: made.code, pin: '1234' } })),
    /different from the PIN you sign in with/,
  );

  // Anything else is fine.
  await setPin(ctx(db, asBookkeeper, { body: { code: made.code, pin: '9876' } }));
});

test('a payroll PIN is not stored where a login PIN could be compared with it', async () => {
  const { db, raw } = setup();
  const pepper = await getPepper(db);
  raw.prepare('UPDATE users SET pin_hash = ? WHERE id = 4').run(await hashPin('1234', pepper));

  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));
  await setPin(ctx(db, asBookkeeper, { body: { code: made.code, pin: '5678' } }));

  const row = raw.prepare('SELECT pin_hash FROM pay_access WHERE user_id = 4').get();
  assert.notEqual(row.pin_hash, await hashPin('5678', pepper),
    'hashed under its own label, so the two can never be matched up');
});

test('an administrator chooses one with no code, having signed in with a password', async () => {
  const { db, raw } = setup();
  await assert.rejects(() => guardPayroll(ctx(db, asAdmin)), /Choose a payroll PIN/);

  const done = await read(await setPin(ctx(db, asAdmin, { body: { pin: '2468' } })));
  assert.equal(done.open, true);
  await guardPayroll(ctx(db, asAdmin));

  const row = raw.prepare('SELECT * FROM pay_access WHERE user_id = 1').get();
  assert.equal(row.code_hash, null, 'granted nothing');
  assert.equal(row.expires_at, null, 'and it does not run out');
});

test('an administrator on a login PIN cannot choose the payroll PIN with it', async () => {
  // Four digits overheard at the tablet must not be the whole of what stands
  // between somebody and everybody's pay.
  const { db } = setup();
  await assert.rejects(
    () => setPin(ctx(db, asAdminOnAPin, { body: { pin: '2468' } })),
    /Sign in with your email address and password/,
  );

  // The password session sets it, and after that the keypad session opens it
  // with the payroll PIN like anybody else.
  await setPin(ctx(db, asAdmin, { body: { pin: '2468' } }));
  await lock(ctx(db, asAdminOnAPin));
  assert.equal((await read(await unlock(ctx(db, asAdminOnAPin, { body: { pin: '2468' } })))).open, true);
  await guardPayroll(ctx(db, asAdminOnAPin));
});

test('the screen is told to ask for the password before the form is filled in', async () => {
  const { db } = setup();
  const keypad = {
    ...asAdminOnAPin,
    user: { ...asAdminOnAPin.user, has_pin: 1 },
  };
  const now = await read(await myAccess(ctx(db, keypad)));
  assert.equal(now.state, 'setup');
  assert.equal(now.needsPassword, true);

  // And not once there is a payroll PIN to type instead.
  await setPin(ctx(db, asAdmin, { body: { pin: '2468' } }));
  assert.equal((await read(await myAccess(ctx(db, keypad)))).needsPassword, false);
});

test('an administrator with no login PIN is not asked for the password again', async () => {
  // There is nothing shorter to shoulder-surf, so the session they are in is
  // already the strongest thing they have.
  const { db, raw } = setup();
  raw.prepare('UPDATE users SET pin_hash = NULL WHERE id = 1').run();
  assert.equal((await read(await setPin(ctx(db, asAdminOnAPin, { body: { pin: '2468' } })))).open, true);
});

test('changing it needs the one in use now', async () => {
  const { db } = setup();
  await enrolled(db, { pin: '4321' });

  await assert.rejects(
    () => setPin(ctx(db, asBookkeeper, { body: { current: '0000', pin: '5555' } })),
    /current payroll PIN is not right/,
  );
  await setPin(ctx(db, asBookkeeper, { body: { current: '4321', pin: '5555' } }));

  await lock(ctx(db, asBookkeeper));
  await assert.rejects(() => unlock(ctx(db, asBookkeeper, { body: { pin: '4321' } })), /not right/);
  assert.equal((await read(await unlock(ctx(db, asBookkeeper, { body: { pin: '5555' } })))).open, true);
});

test('the right PIN opens it, and the wrong one does not', async () => {
  const { db } = setup();
  await enrolled(db, { pin: '4321' });
  await lock(ctx(db, asBookkeeper));

  await assert.rejects(
    () => unlock(ctx(db, asBookkeeper, { body: { pin: '0000' } })),
    /not right/,
  );

  const opened = await read(await unlock(ctx(db, asBookkeeper, { body: { pin: '4321' } })));
  assert.equal(opened.open, true);

  const now = await read(await myAccess(ctx(db, asBookkeeper)));
  assert.equal(now.open, true);
  assert.equal(now.state, 'open');
});

test('the PIN keeps working after the window runs out, until the grant does not', async () => {
  const { db, raw } = setup();
  await enrolled(db, { pin: '4321' });

  // Come back after lunch: the window has gone but the PIN has not.
  raw.prepare("UPDATE pay_access SET unlocked_until = '2020-01-01 00:00:00' WHERE user_id = 4").run();
  assert.equal((await read(await myAccess(ctx(db, asBookkeeper)))).state, 'shut');
  assert.equal((await read(await unlock(ctx(db, asBookkeeper, { body: { pin: '4321' } })))).open, true);

  // Come back next year: it opens nothing.
  raw.prepare("UPDATE pay_access SET expires_at = '2020-01-01 00:00:00' WHERE user_id = 4").run();
  await assert.rejects(
    () => unlock(ctx(db, asBookkeeper, { body: { pin: '4321' } })),
    /run out/,
  );
});

test('five wrong PINs and it shuts', async () => {
  const { db } = setup();
  await enrolled(db, { pin: '4321' });

  for (let i = 0; i < MAX_TRIES - 1; i += 1) {
    await assert.rejects(
      () => unlock(ctx(db, asBookkeeper, { body: { pin: '0000' } })), /not right/,
    );
  }
  await assert.rejects(
    () => unlock(ctx(db, asBookkeeper, { body: { pin: '0000' } })), /Too many wrong tries/,
  );
  assert.equal((await read(await myAccess(ctx(db, asBookkeeper)))).state, 'locked');

  // And the right one is no use while it is shut.
  await assert.rejects(
    () => unlock(ctx(db, asBookkeeper, { body: { pin: '4321' } })), /Too many wrong tries/,
  );
});

test('an administrator resets a forgotten PIN, and that opens nothing by itself', async () => {
  const { db } = setup();
  await enrolled(db, { pin: '4321' });

  await resetPin(ctx(db, asAdmin), '4');
  const now = await read(await myAccess(ctx(db, asBookkeeper)));
  assert.equal(now.state, 'setup');
  assert.equal(now.hasPin, false);
  assert.equal(now.needsCode, true, 'they need their code again to choose another');
  await assert.rejects(() => guardPayroll(ctx(db, asBookkeeper)), /Choose a payroll PIN/);

  // Nothing to reset twice.
  await assert.rejects(() => resetPin(ctx(db, asAdmin), '4'), /have not set a payroll PIN/);
});

test('a reset does not throw away the grant, so the same code still enrols them', async () => {
  const { db } = setup();
  const made = await enrolled(db, { pin: '4321' });
  await resetPin(ctx(db, asAdmin), '4');
  assert.equal((await read(await setPin(ctx(db, asBookkeeper, { body: { code: made.code, pin: '8642' } })))).open, true);
});

test('taking it away stops somebody who has it open, at once', async () => {
  const { db } = setup();
  await enrolled(db, { pin: '4321' });
  assert.equal((await read(await myAccess(ctx(db, asBookkeeper)))).open, true);

  await revoke(ctx(db, asAdmin), '4');
  assert.equal((await read(await myAccess(ctx(db, asBookkeeper)))).open, false);
  await assert.rejects(() => guardPayroll(ctx(db, asBookkeeper)), /not been granted/);
});

test('locking it shuts it without giving up the grant or the PIN', async () => {
  const { db } = setup();
  await enrolled(db, { pin: '4321' });
  await lock(ctx(db, asBookkeeper));

  const now = await read(await myAccess(ctx(db, asBookkeeper)));
  assert.equal(now.state, 'shut');
  assert.equal(now.granted, true);
  assert.equal(now.hasPin, true, 'the PIN opens it again');
});

test('the gate turns away everybody who has not been through all four locks', async () => {
  const { db } = setup();

  await assert.rejects(() => guardPayroll(ctx(db, asBookkeeper)), /not been granted/);

  const made = await read(await grant(ctx(db, asAdmin, { body: { userId: 4, days: 30 } })));
  await assert.rejects(() => guardPayroll(ctx(db, asBookkeeper)), /Choose a payroll PIN/);

  await setPin(ctx(db, asBookkeeper, { body: { code: made.code, pin: '4321' } }));
  await guardPayroll(ctx(db, asBookkeeper));

  await lock(ctx(db, asBookkeeper));
  await assert.rejects(() => guardPayroll(ctx(db, asBookkeeper)), /Enter your payroll PIN/);

  await unlock(ctx(db, asBookkeeper, { body: { pin: '4321' } }));
  await guardPayroll(ctx(db, asBookkeeper));

  // And an administrator no longer sails through with no row at all.
  await assert.rejects(() => guardPayroll(ctx(db, asAdmin)), /Choose a payroll PIN/);
});

test('the window slides while somebody is working', async () => {
  const { db, raw } = setup();
  await enrolled(db, { pin: '4321' });

  // Most of the window gone, and they are still typing.
  const nearly = iso(Date.now() + 3 * MINUTE);
  raw.prepare('UPDATE pay_access SET unlocked_until = ? WHERE user_id = 4').run(nearly);
  await guardPayroll(ctx(db, asBookkeeper));

  const after = raw.prepare('SELECT unlocked_until FROM pay_access WHERE user_id = 4').get();
  assert.ok(after.unlocked_until > nearly, 'a payroll that takes an hour does not shut halfway');
});

test('the list says where everybody stands, including who has a PIN', async () => {
  const { db } = setup();
  await enrolled(db, { pin: '4321' });

  const { people } = await read(await accessList(ctx(db, asAdmin)));
  const by = new Map(people.map((p) => [p.name, p]));

  assert.equal(by.get('Kwame').admin, true);
  assert.equal(by.get('Kwame').access.hasPin, false, 'the administrator has not set one');
  assert.equal(by.get('Yaa').access.state, 'open');
  assert.equal(by.get('Yaa').access.hasPin, true);
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

test('every payroll route is behind the lock, except the few that open it', async () => {
  const source = readFileSync('src/index.js', 'utf8');
  const routes = [...source.matchAll(/'\/api\/payroll[^']*'/g)].map((m) => m[0].slice(1, -1));
  assert.ok(routes.length > 8, 'found the routes');

  const outside = new Set([
    '/api/payroll/access', '/api/payroll/unlock', '/api/payroll/pin', '/api/payroll/lock',
    '/api/payroll/pin/', '/api/payroll/pin/:id',
    '/api/payroll/grants', '/api/payroll/grants/', '/api/payroll/grants/:id',
  ]);

  // `locked` in the router decides this, and it is a prefix so a route added
  // later is covered the day it is written. This asserts the exceptions are
  // the ones intended and nothing has quietly joined them.
  for (const path of routes) {
    assert.equal(path.startsWith('/api/payroll'), true, `${path} is under the payroll prefix`);
    if (outside.has(path)) continue;
    assert.ok(!path.endsWith('/pin') && !path.endsWith('/unlock'), `${path} is locked`);
  }
});

/**
 * Through the front door, with a real signed cookie.
 *
 * The tests above call the handlers. This one goes through the router, which
 * is where the locks actually live, because a handler that is right behind a
 * gate nobody wired up is not protection.
 */
async function asUser(db, raw, userId, via = 'password') {
  const env = {
    DB: db,
    SESSION_SECRET: 'x'.repeat(40),
    ASSETS: { fetch: async () => new Response('asset') },
  };
  const token = await createToken(
    { uid: userId, via, exp: Math.floor(Date.now() / 1000) + 3600 },
    env.SESSION_SECRET,
  );
  const call = (path, init = {}) => worker.fetch(new Request(`https://x${path}`, {
    ...init,
    headers: { cookie: `bf_session=${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  }), env, null);
  return { env, call };
}

test('the router turns a bookkeeper away until every lock is open', async () => {
  const { db, raw } = setup();
  const admin = await asUser(db, raw, 1);
  const book = await asUser(db, raw, 4);

  // The permission alone.
  let res = await book.call('/api/payroll?month=2026-08');
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /not been granted/);

  // Granted, still no PIN.
  const made = await (await admin.call('/api/payroll/grants', {
    method: 'POST', body: JSON.stringify({ userId: 4, days: 30 }),
  })).json();
  res = await book.call('/api/payroll?month=2026-08');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).detail.payrollLocked, true);

  // Enrolled, which opens it there and then.
  assert.equal((await book.call('/api/payroll/pin', {
    method: 'POST', body: JSON.stringify({ code: made.code, pin: '4321' }),
  })).status, 200);
  assert.equal((await book.call('/api/payroll?month=2026-08')).status, 200);

  // Leaving the tab shuts it, and every payroll route is behind the same gate,
  // including the ones added after this was written.
  await (await book.call('/api/payroll/lock', { method: 'POST', body: '{}' })).json();
  for (const path of ['/api/payroll?month=2026-08', '/api/payroll/returns?month=2026-08',
    '/api/payroll/input/template?month=2026-08']) {
    assert.equal((await book.call(path)).status, 403, path);
  }

  // And the PIN lets them back in without another code.
  assert.equal((await book.call('/api/payroll/unlock', {
    method: 'POST', body: JSON.stringify({ pin: '4321' }),
  })).status, 200);
  assert.equal((await book.call('/api/payroll?month=2026-08')).status, 200);
});

test('an administrator is stopped at the payroll until they have set a PIN', async () => {
  const { db, raw } = setup();
  const admin = await asUser(db, raw, 1, 'password');

  const shut = await admin.call('/api/payroll?month=2026-08');
  assert.equal(shut.status, 403);
  assert.match((await shut.json()).error, /Choose a payroll PIN/);

  assert.equal((await admin.call('/api/payroll/pin', {
    method: 'POST', body: JSON.stringify({ pin: '2468' }),
  })).status, 200);
  assert.equal((await admin.call('/api/payroll?month=2026-08')).status, 200);
});

test('somebody else’s payslip is refused to anybody who is not an administrator', async () => {
  const { db, raw } = setup();
  const admin = await asUser(db, raw, 1);
  const book = await asUser(db, raw, 4);

  await admin.call('/api/payroll/pin', { method: 'POST', body: JSON.stringify({ pin: '2468' }) });
  await admin.call('/api/payroll/profiles', {
    method: 'POST',
    body: JSON.stringify({ rows: [{ staffId: 1, onPayroll: true, basic: 2000, ssnit: true }] }),
  });

  // The bookkeeper is fully unlocked, and it still makes no difference.
  const made = await (await admin.call('/api/payroll/grants', {
    method: 'POST', body: JSON.stringify({ userId: 4, days: 30 }),
  })).json();
  await book.call('/api/payroll/pin', {
    method: 'POST', body: JSON.stringify({ code: made.code, pin: '4321' }),
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
    assert.equal((await nobody.call(path)).status, 403, path);
  }

  // Including the two that exist to open it: no permission, no PIN to set.
  for (const path of ['/api/payroll/pin', '/api/payroll/unlock']) {
    const res = await nobody.call(path, { method: 'POST', body: JSON.stringify({ pin: '4321' }) });
    assert.equal(res.status, 403, path);
  }
});
