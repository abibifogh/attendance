import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { checkAgainst, claimTotal, spentOf, standingOf } from '../src/lib/medical.js';
import {
  claim, decideClaim, medical, myMedical, receipt, setAllowances, withdrawClaim,
} from '../src/routes/medical.js';

/**
 * The medical allowance.
 *
 * The figures here decide whether somebody is reimbursed for a hospital bill,
 * so the two things worth pinning hardest are that the balance is what the
 * receipts say it is, and that nobody can read anybody else's bills.
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
  raw.exec('DELETE FROM att_staff; DELETE FROM users; DELETE FROM app_notices;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec("UPDATE settings SET value = 'GHS' WHERE key = 'currency'");
  for (const [id, name] of [[1, 'Kofi Mensah'], [2, 'Ama Boateng']]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
       VALUES (?, ?, ?, 'Kitchen', '2020-01-01')`,
    ).run(id, String(id), name);
  }
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (7, 'Kofi', 'staff', 'x', 1, 1)",
  ).run();
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (8, 'Ama', 'staff', 'y', 2, 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const KOFI = { user: { id: 7, name: 'Kofi Mensah', role: 'staff', staff_id: 1 }, permissions: ['att_me'] };
const AMA = { user: { id: 8, name: 'Ama Boateng', role: 'staff', staff_id: 2 }, permissions: ['att_me'] };
const WAGES = { user: { id: 3, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };

const ctx = (db, session, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/medical${query}`),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const read = async (response) => response.json();
const notices = (raw) => raw.prepare('SELECT * FROM app_notices ORDER BY id').all();

const YEAR = Number(new Date().getUTCFullYear());
const today = new Date().toISOString().slice(0, 10);

/** A one-pixel PNG, so the file path is exercised without a fixture on disk. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const giveAllowance = (db, rows) => setAllowances(ctx(db, WAGES, {
  body: { year: YEAR, rows },
}));

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

test('a claim is the sum of its bills, not a figure somebody typed', () => {
  assert.equal(claimTotal([{ amount: 120.5 }, { amount: 30.25 }, { amount: 9 }]), 159.75);
  assert.equal(claimTotal([]), 0);
});

test('what is left is the opening balance less what was actually allowed', () => {
  const claims = [
    { status: 'approved', amount: 300, approved: 250 },
    { status: 'requested', amount: 120 },
    { status: 'rejected', amount: 400 },
    { status: 'withdrawn', amount: 80 },
  ];
  const standing = standingOf({ year: YEAR, allowance: 1000, opening: 800 }, claims);

  assert.equal(spentOf(claims), 250, 'approved for less is what counts, not what was asked');
  assert.equal(standing.left, 550);
  assert.equal(standing.waiting, 120, 'and what is waiting is neither spent nor free');
  assert.equal(standing.ifAllApproved, 430);
  assert.equal(standing.carriedIn, 200, 'the part claimed before the app was keeping the record');
});

test('a claim bigger than the balance is reported rather than refused outright', () => {
  const standing = standingOf({ year: YEAR, allowance: 500, opening: 500 }, []);
  assert.equal(checkAgainst(standing, 200).ok, true);

  const over = checkAgainst(standing, 700);
  assert.equal(over.ok, false);
  assert.equal(over.over, 200);
  assert.match(over.reason, /200 more than the 500 left/);

  assert.equal(checkAgainst(null, 100).ok, false, 'and nobody without an allowance');
});

// ---------------------------------------------------------------------------
// Setting the year
// ---------------------------------------------------------------------------

test('the office sets who qualifies and what they get, everybody at once', async () => {
  const { db } = setup();
  const out = await read(await giveAllowance(db, [
    { staffId: 1, qualifies: true, allowance: 1000 },
    { staffId: 2, qualifies: true, allowance: 1000, opening: 400 },
  ]));
  assert.equal(out.set, 2);

  const seen = await read(await medical(ctx(db, WAGES, { query: `?year=${YEAR}` })));
  const kofi = seen.people.find((p) => p.staff.id === 1);
  const ama = seen.people.find((p) => p.staff.id === 2);

  assert.equal(kofi.standing.left, 1000, 'a whole allowance where nothing is carried in');
  assert.equal(ama.standing.left, 400, 'and what was actually left where something is');
  assert.equal(ama.standing.carriedIn, 600);
  assert.equal(seen.totals.allowance, 1400);
});

test('a starting balance cannot be more than the allowance it belongs to', async () => {
  const { db } = setup();
  await assert.rejects(
    () => giveAllowance(db, [{ staffId: 1, qualifies: true, allowance: 500, opening: 900 }]),
    /cannot be more than the allowance/,
  );
});

test('unticking somebody takes the year off them and leaves their claims alone', async () => {
  const { raw, db } = setup();
  await giveAllowance(db, [{ staffId: 1, qualifies: true, allowance: 600 }]);
  await claim(ctx(db, KOFI, { body: { receipts: [{ amount: 100, spentOn: today }] } }));

  const out = await read(await giveAllowance(db, [{ staffId: 1, qualifies: false }]));
  assert.equal(out.removed, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hr_medical_claim').get().n, 1,
    'what was paid does not stop being true because the arrangement ended');
});

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

test('a claim carries its bills, and the office is told', async () => {
  const { raw, db } = setup();
  await giveAllowance(db, [{ staffId: 1, qualifies: true, allowance: 1000 }]);

  const out = await read(await claim(ctx(db, KOFI, {
    body: {
      what: 'Malaria treatment',
      receipts: [
        { amount: 120.5, what: 'Consultation', spentOn: today, file: { base64: PIXEL, mime: 'image/png', filename: 'bill.png' } },
        { amount: 79.5, what: 'Pharmacy', spentOn: today },
      ],
    },
  })));

  assert.equal(out.amount, 200, 'the total is the bills added up');
  assert.equal(out.status, 'requested');

  const told = notices(raw).at(-1);
  assert.equal(told.audience, 'hr_pay');
  assert.match(told.title, /Kofi Mensah has claimed GHS 200/);

  const mine = await read(await myMedical(ctx(db, KOFI, { query: `?year=${YEAR}` })));
  assert.equal(mine.standing.left, 1000, 'nothing comes off until it is approved');
  assert.equal(mine.standing.waiting, 200);
  assert.equal(mine.claims[0].receipts.length, 2);
  assert.equal(mine.claims[0].receipts[0].hasFile, true);
  assert.equal(mine.claims[0].receipts[1].hasFile, false, 'a bill with no picture is allowed');

  // The picture went into the document store rather than into the claim row.
  const doc = raw.prepare("SELECT * FROM hr_document WHERE kind = 'medical_receipt'").get();
  assert.equal(doc.staff_id, 1);
  assert.ok(doc.bytes > 0);
});

test('ten bills is the ceiling, and it is said rather than silently trimmed', async () => {
  const { db } = setup();
  await giveAllowance(db, [{ staffId: 1, qualifies: true, allowance: 5000 }]);

  const eleven = Array.from({ length: 11 }, () => ({ amount: 10, spentOn: today }));
  await assert.rejects(
    () => claim(ctx(db, KOFI, { body: { receipts: eleven } })),
    /Ten bills at most/,
  );

  const ten = Array.from({ length: 10 }, () => ({ amount: 10, spentOn: today }));
  const out = await read(await claim(ctx(db, KOFI, { body: { receipts: ten } })));
  assert.equal(out.amount, 100);
});

test('a claim needs a bill, a real amount and a date that has happened', async () => {
  const { db } = setup();
  await giveAllowance(db, [{ staffId: 1, qualifies: true, allowance: 500 }]);

  await assert.rejects(() => claim(ctx(db, KOFI, { body: { receipts: [] } })), /at least one bill/);
  await assert.rejects(
    () => claim(ctx(db, KOFI, { body: { receipts: [{ amount: 0, spentOn: today }] } })),
    /Bill 1/,
  );
  await assert.rejects(
    () => claim(ctx(db, KOFI, { body: { receipts: [{ amount: 50, spentOn: '2099-01-01' }] } })),
    /dated in the future/,
  );
});

test('somebody with no allowance is told to ask the office rather than left guessing', async () => {
  const { db } = setup();
  await assert.rejects(
    () => claim(ctx(db, KOFI, { body: { receipts: [{ amount: 50, spentOn: today }] } })),
    /no medical allowance set/,
  );
});

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

async function claimed(db, amount = 200) {
  await giveAllowance(db, [{ staffId: 1, qualifies: true, allowance: 1000 }]);
  const out = await read(await claim(ctx(db, KOFI, {
    body: { receipts: [{ amount, spentOn: today, what: 'Hospital' }] },
  })));
  return out.id;
}

test('approving takes the claim off the balance and tells the person', async () => {
  const { raw, db } = setup();
  const id = await claimed(db, 250);

  const out = await read(await decideClaim(ctx(db, WAGES, { body: { approve: true } }), id));
  assert.equal(out.approved, 250);
  assert.equal(out.left, 750);

  const mine = await read(await myMedical(ctx(db, KOFI, { query: `?year=${YEAR}` })));
  assert.equal(mine.standing.spent, 250);
  assert.equal(mine.standing.left, 750);
  assert.equal(mine.standing.waiting, 0);

  const told = notices(raw).at(-1);
  assert.equal(told.user_id, 7);
  assert.match(told.title, /GHS 250 is approved/);
  assert.match(told.body, /GHS 750 is left/);
});

test('a claim can be approved for less than was asked, and both figures are kept', async () => {
  const { raw, db } = setup();
  const id = await claimed(db, 400);

  await decideClaim(ctx(db, WAGES, {
    body: { approve: true, amount: 300, note: 'The vitamins are not covered' },
  }), id);

  const mine = await read(await myMedical(ctx(db, KOFI, { query: `?year=${YEAR}` })));
  assert.equal(mine.claims[0].amount, 400, 'what was asked');
  assert.equal(mine.claims[0].approved, 300, 'and what was allowed');
  assert.equal(mine.standing.spent, 300);
  assert.match(notices(raw).at(-1).body, /You asked for GHS 400/);
});

test('more than was claimed cannot be approved', async () => {
  const { db } = setup();
  const id = await claimed(db, 200);
  await assert.rejects(
    () => decideClaim(ctx(db, WAGES, { body: { approve: true, amount: 500 } }), id),
    /cannot approve more than was claimed/i,
  );
});

test('going past the balance takes a deliberate tick', async () => {
  const { db } = setup();
  await giveAllowance(db, [{ staffId: 1, qualifies: true, allowance: 300 }]);
  const out = await read(await claim(ctx(db, KOFI, {
    body: { receipts: [{ amount: 500, spentOn: today }] },
  })));

  await assert.rejects(
    () => decideClaim(ctx(db, WAGES, { body: { approve: true } }), out.id),
    /200 more than the 300 left/,
  );

  // The property can still decide to cover it, and says so on purpose.
  const done = await read(await decideClaim(ctx(db, WAGES, {
    body: { approve: true, over: true, note: 'Agreed with the manager' },
  }), out.id));
  assert.equal(done.approved, 500);

  const mine = await read(await myMedical(ctx(db, KOFI, { query: `?year=${YEAR}` })));
  assert.equal(mine.standing.left, -200, 'and the balance says so rather than hiding it');
});

test('a claim turned down costs nothing, and says why', async () => {
  const { raw, db } = setup();
  const id = await claimed(db, 200);

  await decideClaim(ctx(db, WAGES, { body: { approve: false, note: 'Not a medical bill' } }), id);

  const mine = await read(await myMedical(ctx(db, KOFI, { query: `?year=${YEAR}` })));
  assert.equal(mine.standing.left, 1000);
  assert.equal(mine.claims[0].status, 'rejected');
  assert.equal(mine.claims[0].decision, 'Not a medical bill');
  assert.match(notices(raw).at(-1).title, /not approved/);
});

test('nothing can be decided twice', async () => {
  const { db } = setup();
  const id = await claimed(db);
  await decideClaim(ctx(db, WAGES, { body: { approve: true } }), id);
  await assert.rejects(
    () => decideClaim(ctx(db, WAGES, { body: { approve: false } }), id),
    /already been decided/,
  );
});

test('a claim nobody has decided can be taken back, and only by whoever made it', async () => {
  const { db } = setup();
  const id = await claimed(db);

  await assert.rejects(() => withdrawClaim(ctx(db, AMA), id), /not one of yours/);
  await withdrawClaim(ctx(db, KOFI), id);

  const mine = await read(await myMedical(ctx(db, KOFI, { query: `?year=${YEAR}` })));
  assert.equal(mine.claims[0].status, 'withdrawn');
  assert.equal(mine.standing.waiting, 0);
});

// ---------------------------------------------------------------------------
// Who may read a bill
// ---------------------------------------------------------------------------

test('a receipt is readable by whoever it belongs to and by whoever decides it', async () => {
  const { raw, db } = setup();
  await giveAllowance(db, [{ staffId: 1, qualifies: true, allowance: 1000 }]);
  await claim(ctx(db, KOFI, {
    body: {
      receipts: [{
        amount: 60, spentOn: today,
        file: { base64: PIXEL, mime: 'image/png', filename: 'bill.png' },
      }],
    },
  }));
  const id = raw.prepare('SELECT id FROM hr_medical_receipt').get().id;

  const mine = await receipt(ctx(db, KOFI), id);
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('Content-Type'), 'image/png');
  assert.equal(mine.headers.get('Cache-Control'), 'private, no-store');

  const office = await receipt(ctx(db, WAGES), id);
  assert.equal(office.status, 200);

  // And by nobody else, whatever the menu let them open.
  await assert.rejects(() => receipt(ctx(db, AMA), id), /not yours/);
});

test('one person’s claims are never in another person’s answer', async () => {
  const { db } = setup();
  await giveAllowance(db, [
    { staffId: 1, qualifies: true, allowance: 1000 },
    { staffId: 2, qualifies: true, allowance: 1000 },
  ]);
  await claim(ctx(db, KOFI, { body: { receipts: [{ amount: 100, spentOn: today }] } }));

  const hers = await read(await myMedical(ctx(db, AMA, { query: `?year=${YEAR}` })));
  assert.equal(hers.claims.length, 0);
  assert.equal(hers.standing.left, 1000);
});
