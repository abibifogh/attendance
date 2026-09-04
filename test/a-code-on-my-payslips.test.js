import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  closeRun, myPayslipLock, myPayslips, openMyPayslips, saveScheme, setMyPayslipLock,
  setProfiles, setScores, shutMyPayslips,
} from '../src/routes/payroll.js';
import { updateUser } from '../src/routes/admin.js';
import {
  LOCKOUT_MINUTES, MAX_TRIES, OPEN_MINUTES, afterAWrongTry, codeIsObvious, codeLooksRight,
  minutesLeft, readLock,
} from '../src/lib/payslip-lock.js';

/**
 * The code somebody puts on their own payslips.
 *
 * Signing in answers "is this their phone", once, in the morning. Opening a
 * payslip is asked at a different moment: somebody is beside them in a
 * corridor, the phone is already unlocked, and the six digits typed at seven
 * o'clock are no help at all.
 *
 * What is pinned down here is that the refusal carries no figures, that
 * guessing costs something, that only the person whose pay it is can change
 * it, and that it does not lock the property out of a document it has to be
 * able to answer questions about.
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

const CODE = '8317';
const OTHER = '4092';

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM users; DELETE FROM app_notices;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec("UPDATE settings SET value = 'GHS' WHERE key = 'currency'");
  for (const [id, name] of [[1, 'Ama Boateng'], [2, 'Kofi Mensah']]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
       VALUES (?, ?, ?, 'Kitchen', '2020-01-01')`,
    ).run(id, String(id), name);
    raw.prepare(
      'INSERT INTO users (id, name, role, active, staff_id) VALUES (?, ?, ?, 1, ?)',
    ).run(20 + id, name, 'staff', id);
  }
  raw.prepare(
    "INSERT INTO users (id, name, role, active, permissions) VALUES (9, 'Yaa', 'admin', 1, ?)",
  ).run(JSON.stringify(['hr_pay', 'admin_users']));
  return { raw, db: d1(raw) };
}

const WAGES = { user: { id: 9, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };
const BOSS = {
  user: { id: 9, name: 'Yaa', role: 'admin' },
  permissions: ['hr_pay', 'admin_users'],
};
const asStaff = (staffId) => ({
  user: { id: 20 + staffId, name: 'Them', role: 'staff', staff_id: staffId },
  permissions: ['att_me'],
});

const ctx = (db, session, { body = null, query = '', params = {} } = {}) => ({
  db,
  env: {},
  params,
  url: new URL(`https://x/api/me/payslips${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});
const read = async (response) => response.json();

async function aClosedMonth(db, month = '2099-01') {
  await setProfiles(ctx(db, WAGES, {
    body: { rows: [{ staffId: 1, basic: 2000, ssnit: true }, { staffId: 2, basic: 1200, ssnit: true }] },
  }));
  const scheme = await read(await saveScheme(ctx(db, WAGES, {
    body: { name: 'Nkosoɔ', amount: 400, departments: [], staffIds: [1, 2] },
  })));
  await setScores(ctx(db, WAGES, {
    body: { month, rows: [{ schemeId: scheme.id, staffId: 1, score: 100 }] },
  }));
  await closeRun(ctx(db, WAGES, { body: { month } }));
}

const turnOn = (db, staffId = 1, code = CODE) =>
  setMyPayslipLock(ctx(db, asStaff(staffId), { body: { code } }));

// ---------------------------------------------------------------------------
// The rules, on their own
// ---------------------------------------------------------------------------

test('four digits, and nothing anybody would try first', () => {
  assert.equal(codeLooksRight('8317'), true);
  assert.equal(codeLooksRight('831'), false);
  assert.equal(codeLooksRight('83170'), false);
  assert.equal(codeLooksRight('83a7'), false);

  for (const easy of ['0000', '1111', '1234', '4321']) {
    assert.equal(codeIsObvious(easy), true, easy);
  }
  assert.equal(codeIsObvious(CODE), false);
});

test('a wrong try costs a try, and the fifth costs a wait', () => {
  const now = new Date('2099-03-01T09:00:00Z');
  let row = { payslip_tries: 0 };

  for (let i = 1; i < MAX_TRIES; i += 1) {
    const cost = afterAWrongTry(row, now);
    assert.equal(cost.lockedUntil, null, `try ${i}`);
    assert.equal(cost.triesLeft, MAX_TRIES - i);
    row = { payslip_tries: cost.tries };
  }

  const last = afterAWrongTry(row, now);
  assert.notEqual(last.lockedUntil, null);
  assert.equal(minutesLeft(last.lockedUntil, now), LOCKOUT_MINUTES);
  // The count starts again, so the wait is not doubled by the next wrong one.
  assert.equal(last.tries, 0);
});

test('the window slides while somebody is reading and not after', () => {
  const now = new Date('2099-03-01T09:00:00Z');
  const on = { payslip_pin_hash: 'x', payslip_open_until: '2099-03-01 09:05:00' };
  assert.equal(readLock(on, now).state, 'open');

  const gone = { payslip_pin_hash: 'x', payslip_open_until: '2099-03-01 08:55:00' };
  assert.equal(readLock(gone, now).state, 'shut');

  const none = { payslip_pin_hash: null };
  assert.equal(readLock(none, now).state, 'off');
  assert.equal(readLock(none, now).open, true);
});

// ---------------------------------------------------------------------------
// Putting one on
// ---------------------------------------------------------------------------

test('nobody has one until they say so', async () => {
  const { db } = setup();
  await aClosedMonth(db);

  const lock = await read(await myPayslipLock(ctx(db, asStaff(1))));
  assert.equal(lock.on, false);

  const slips = await read(await myPayslips(ctx(db, asStaff(1))));
  assert.equal(slips.locked, undefined);
  assert.equal(slips.months.length, 1);
});

test('setting the first one asks for nothing but being signed in', async () => {
  const { db } = setup();
  await aClosedMonth(db);

  const out = await read(await turnOn(db));
  assert.equal(out.on, true);
  assert.equal(out.changed, false);

  // And it opens straight away, so the next screen does not ask for what was
  // just chosen.
  const slips = await read(await myPayslips(ctx(db, asStaff(1))));
  assert.equal(slips.locked, undefined);
});

test('an easy code is refused, and told why', async () => {
  const { db } = setup();
  await assert.rejects(() => turnOn(db, 1, '1234'), /less easy to guess/);
  await assert.rejects(() => turnOn(db, 1, '000'), /four digits/);
});

test('changing it needs the one they have', async () => {
  const { db, raw } = setup();
  await turnOn(db);

  await assert.rejects(
    () => setMyPayslipLock(ctx(db, asStaff(1), { body: { current: OTHER, code: '5521' } })),
    /not the code/,
  );
  const changed = await read(await setMyPayslipLock(ctx(db, asStaff(1), {
    body: { current: CODE, code: '5521' },
  })));
  assert.equal(changed.changed, true);

  // The old one stops working, the new one works.
  raw.prepare('UPDATE users SET payslip_open_until = NULL WHERE id = 21').run();
  await assert.rejects(() => openMyPayslips(ctx(db, asStaff(1), { body: { code: CODE } })));
  const open = await read(await openMyPayslips(ctx(db, asStaff(1), { body: { code: '5521' } })));
  assert.equal(open.open, true);
});

test('taking it off needs the one they have too', async () => {
  const { db } = setup();
  await turnOn(db);

  await assert.rejects(
    () => setMyPayslipLock(ctx(db, asStaff(1), { body: { current: OTHER, off: true } })),
    /not the code/,
  );
  const off = await read(await setMyPayslipLock(ctx(db, asStaff(1), {
    body: { current: CODE, off: true },
  })));
  assert.equal(off.on, false);
  assert.equal((await read(await myPayslipLock(ctx(db, asStaff(1))))).on, false);
});

// ---------------------------------------------------------------------------
// What the locked screen gives away
// ---------------------------------------------------------------------------

test('a locked answer carries no figures at all', async () => {
  const { db, raw } = setup();
  await aClosedMonth(db);
  await turnOn(db);
  raw.prepare('UPDATE users SET payslip_open_until = NULL WHERE id = 21').run();

  const out = await read(await myPayslips(ctx(db, asStaff(1))));
  assert.equal(out.locked, true);
  assert.equal(out.state, 'shut');
  assert.deepEqual(out.months, []);
  assert.equal(out.line, null);
  // Not even how many months there are, which is a shape worth withholding.
  assert.equal(JSON.stringify(out).includes('2099-01'), false);
});

test('the right code opens it and the window closes on the way out', async () => {
  const { db, raw } = setup();
  await aClosedMonth(db);
  await turnOn(db);
  raw.prepare('UPDATE users SET payslip_open_until = NULL WHERE id = 21').run();

  const open = await read(await openMyPayslips(ctx(db, asStaff(1), { body: { code: CODE } })));
  assert.equal(open.open, true);
  assert.equal(open.minutes, OPEN_MINUTES);

  const slips = await read(await myPayslips(ctx(db, asStaff(1))));
  assert.equal(slips.locked, undefined);
  assert.equal(slips.hasCode, true);
  assert.equal(slips.months.length, 1);

  await shutMyPayslips(ctx(db, asStaff(1)));
  assert.equal((await read(await myPayslips(ctx(db, asStaff(1))))).locked, true);
});

test('guessing runs out, and the wait is said in minutes', async () => {
  const { db, raw } = setup();
  await aClosedMonth(db);
  await turnOn(db);
  raw.prepare('UPDATE users SET payslip_open_until = NULL WHERE id = 21').run();

  for (let i = 1; i < MAX_TRIES; i += 1) {
    await assert.rejects(
      () => openMyPayslips(ctx(db, asStaff(1), { body: { code: OTHER } })),
      /tr(y|ies) left/,
    );
  }
  await assert.rejects(
    () => openMyPayslips(ctx(db, asStaff(1), { body: { code: OTHER } })),
    /Try again in \d+ minutes/,
  );

  // And the right one does not get through while the wait is running.
  await assert.rejects(
    () => openMyPayslips(ctx(db, asStaff(1), { body: { code: CODE } })),
    /Try again in \d+ minutes/,
  );
  assert.equal((await read(await myPayslips(ctx(db, asStaff(1))))).state, 'locked');
});

// ---------------------------------------------------------------------------
// Whose it is, and whose it is not
// ---------------------------------------------------------------------------

test('one person’s code is not another person’s', async () => {
  const { db, raw } = setup();
  await aClosedMonth(db);
  await turnOn(db, 1);
  raw.prepare('UPDATE users SET payslip_open_until = NULL WHERE id = 21').run();

  // Kofi never set one, so his payslips open as they always have.
  const his = await read(await myPayslips(ctx(db, asStaff(2))));
  assert.equal(his.locked, undefined);
  assert.equal(his.months.length, 1);

  // And hers stays shut.
  assert.equal((await read(await myPayslips(ctx(db, asStaff(1))))).locked, true);
});

test('a code stored is not the code, and the same digits differ from a login PIN', async () => {
  const { db, raw } = setup();
  await turnOn(db);

  const row = raw.prepare('SELECT payslip_pin_hash, pin_hash FROM users WHERE id = 21').get();
  assert.notEqual(row.payslip_pin_hash, CODE);
  assert.equal(String(row.payslip_pin_hash).includes(CODE), false);
  assert.notEqual(row.payslip_pin_hash, row.pin_hash);
});

test('an administrator can take it off but can never read it', async () => {
  const { db, raw } = setup();
  await aClosedMonth(db);
  await turnOn(db);
  raw.prepare('UPDATE users SET payslip_open_until = NULL WHERE id = 21').run();

  const before = await read(await updateUser(ctx(db, BOSS, {
    body: { name: 'Ama Boateng', role: 'staff', active: true, staffId: 1, pin: '481920' },
  }), 21));
  assert.equal(before.user.payslipCode, true);
  assert.equal(JSON.stringify(before).includes(CODE), false);
  // Still shut: saving somebody's record is not taking their code off.
  assert.equal((await read(await myPayslips(ctx(db, asStaff(1))))).locked, true);

  const after = await read(await updateUser(ctx(db, BOSS, {
    body: {
      name: 'Ama Boateng', role: 'staff', active: true, staffId: 1, clearPayslipCode: true,
    },
  }), 21));
  assert.equal(after.user.payslipCode, false);
  assert.equal((await read(await myPayslips(ctx(db, asStaff(1))))).locked, undefined);
});
