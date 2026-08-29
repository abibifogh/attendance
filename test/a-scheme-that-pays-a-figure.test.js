import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  closeRun, copyRun, payroll, saveScheme, setProfiles, setScores,
} from '../src/routes/payroll.js';

/**
 * A bonus scheme that pays a set figure rather than a score.
 *
 * Not everything a property pays as a bonus is about how well something was
 * done. Housing money for four supervisors at three different figures is an
 * agreement with each of them, and forcing it through a score meant somebody
 * working out what per cent of 500 comes to 350.
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
  raw.exec('DELETE FROM att_staff; DELETE FROM pay_scheme; DELETE FROM pay_run;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  for (const [id, name] of [[1, 'Kofi'], [2, 'Ama'], [3, 'Yaw']]) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (?, ?, ?, '2020-01-01')`,
    ).run(id, String(id), name);
  }
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 9, name: 'Kwame', role: 'admin' }, permissions: ['hr_pay'] };
const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/payroll${query}`),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const MONTH = '2026-09';
const read = async (res) => res.json();

async function onPayroll(db) {
  await setProfiles(ctx(db, {
    body: { rows: [1, 2, 3].map((id) => ({ staffId: id, basic: 2000, ssnit: true })) },
  }));
}

async function housing(db, { amount = 300, staffIds = [1, 2] } = {}) {
  return read(await saveScheme(ctx(db, {
    body: { name: 'Housing', amount, kind: 'amount', staffIds },
  })));
}

test('a scheme says how it pays, and scored is the default', async () => {
  const { raw, db } = setup();
  await saveScheme(ctx(db, { body: { name: 'Guest scores', amount: 500, staffIds: [1] } }));
  await housing(db);

  const rows = raw.prepare('SELECT name, kind FROM pay_scheme ORDER BY name').all();
  assert.deepEqual(rows.map((r) => [r.name, r.kind]),
    [['Guest scores', 'score'], ['Housing', 'amount']]);
});

test('each person is given their own figure', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  const scheme = await housing(db);

  await setScores(ctx(db, {
    body: {
      month: MONTH,
      rows: [
        { schemeId: scheme.id, staffId: 1, amount: 350 },
        { schemeId: scheme.id, staffId: 2, amount: 500 },
      ],
    },
  }));

  const stored = raw.prepare('SELECT staff_id, score, amount FROM pay_score ORDER BY staff_id').all();
  assert.deepEqual(stored.map((r) => [r.staff_id, r.score, r.amount]), [[1, 100, 350], [2, 100, 500]],
    'the figure is the award, scored at a hundred, so nothing downstream changes');
});

test('what somebody gets is the figure, not a share of one', async () => {
  const { db } = setup();
  await onPayroll(db);
  const scheme = await housing(db);
  await setScores(ctx(db, {
    body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, amount: 350 }] },
  }));

  const out = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  const kofi = out.lines.find((l) => l.staff.name === 'Kofi');
  assert.equal(kofi.bonus.earned, 350);
  assert.equal(kofi.bonus.schemes[0].name, 'Housing');
});

test('somebody never set a figure gets the scheme’s usual one', async () => {
  const { db } = setup();
  await onPayroll(db);
  await housing(db, { amount: 300 });

  const out = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  const ama = out.lines.find((l) => l.staff.name === 'Ama');
  // Nothing has been typed for anybody, so nobody is scored yet.
  assert.equal(ama.bonus.earned, 0, 'until somebody presses Save, nothing is due');
});

test('the screen is told which kind it is, and what each person holds', async () => {
  const { db } = setup();
  await onPayroll(db);
  const scheme = await housing(db);
  await setScores(ctx(db, {
    body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, amount: 350 }] },
  }));

  const out = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  const shown = out.schemes.find((s) => s.id === scheme.id);
  assert.equal(shown.kind, 'amount');
  assert.equal(shown.scores.find((x) => x.staffId === 1).award, 350);
  assert.equal(shown.scores.find((x) => x.staffId === 2).award, null,
    'nothing set for them, which is different from nought');
});

test('a score sent to an amount scheme is ignored, and the money is taken', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  const scheme = await housing(db);
  await setScores(ctx(db, {
    body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, score: 40, amount: 350 }] },
  }));

  const row = raw.prepare('SELECT score, amount FROM pay_score').get();
  assert.equal(row.score, 100);
  assert.equal(row.amount, 350);
});

test('a scored scheme still works exactly as it did', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  const scheme = await read(await saveScheme(ctx(db, {
    body: { name: 'Guest scores', amount: 500, staffIds: [1] },
  })));
  await setScores(ctx(db, {
    body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, score: 80 }] },
  }));

  const row = raw.prepare('SELECT score, amount FROM pay_score').get();
  assert.equal(row.score, 80);
  assert.equal(row.amount, 500);

  const out = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(out.lines.find((l) => l.staff.name === 'Kofi').bonus.earned, 400);
});

test('starting a month from the last one keeps each person’s figure', async () => {
  const { db } = setup();
  await onPayroll(db);
  const scheme = await housing(db);
  await setScores(ctx(db, {
    body: {
      month: '2026-08',
      rows: [
        { schemeId: scheme.id, staffId: 1, amount: 350 },
        { schemeId: scheme.id, staffId: 2, amount: 500 },
      ],
    },
  }));

  await copyRun(ctx(db, { body: { month: MONTH, from: '2026-08' } }));

  const out = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  const shown = out.schemes.find((s) => s.id === scheme.id);
  assert.equal(shown.scores.find((x) => x.staffId === 1).award, 350);
  assert.equal(shown.scores.find((x) => x.staffId === 2).award, 500,
    'a figure agreed with somebody does not reset itself every month');
});

test('a scored scheme still forgets its award when carried across', async () => {
  const { db } = setup();
  await onPayroll(db);
  const scheme = await read(await saveScheme(ctx(db, {
    body: { name: 'Guest scores', amount: 500, staffIds: [1] },
  })));
  await setScores(ctx(db, {
    body: { month: '2026-08', rows: [{ schemeId: scheme.id, staffId: 1, score: 80 }] },
  }));

  // The scheme is worth more from September on.
  await saveScheme(ctx(db, {
    body: { id: scheme.id, name: 'Guest scores', amount: 1000, staffIds: [1] },
  }));
  await copyRun(ctx(db, { body: { month: MONTH, from: '2026-08' } }));

  const out = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(out.lines.find((l) => l.staff.name === 'Kofi').bonus.earned, 800,
    'eighty per cent of what it is worth now');
});

test('a closed month keeps the figure it was closed on', async () => {
  const { db } = setup();
  await onPayroll(db);
  const scheme = await housing(db);
  await setScores(ctx(db, {
    body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, amount: 350 }] },
  }));
  await closeRun(ctx(db, { body: { month: MONTH } }));

  // The usual figure changes afterwards. The closed month does not.
  await saveScheme(ctx(db, {
    body: { id: scheme.id, name: 'Housing', amount: 900, kind: 'amount', staffIds: [1, 2] },
  }));

  const out = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(out.lines.find((l) => l.staff.name === 'Kofi').bonus.earned, 350);
});

test('a scheme can be turned from scored into a set figure and back', async () => {
  const { raw, db } = setup();
  const scheme = await read(await saveScheme(ctx(db, {
    body: { name: 'Guest scores', amount: 500, staffIds: [1] },
  })));

  await saveScheme(ctx(db, {
    body: { id: scheme.id, name: 'Guest scores', amount: 500, kind: 'amount', staffIds: [1] },
  }));
  assert.equal(raw.prepare('SELECT kind FROM pay_scheme').get().kind, 'amount');

  await saveScheme(ctx(db, {
    body: { id: scheme.id, name: 'Guest scores', amount: 500, kind: 'score', staffIds: [1] },
  }));
  assert.equal(raw.prepare('SELECT kind FROM pay_scheme').get().kind, 'score');
});

// ---------------------------------------------------------------------------
// Out of the month's spreadsheet
// ---------------------------------------------------------------------------

const { readColumns, readSheet } = await import('../src/lib/pay-import.js');
const { applyInput, inputTemplate, readInput } = await import('../src/routes/payroll.js');

const HOUSING = { id: 7, name: 'Housing', kind: 'amount' };
const SCORED = { id: 8, name: 'Guest scores', kind: 'score' };
const ONE = [{ id: 1, employee_no: '1', name: 'Kofi', active: 1 }];
const PAID = new Map([[1, { staff_id: 1, basic: 2000, ssnit: 1 }]]);
const UNDER = new Map([[1, [7, 8]]]);

test('a scheme column is found by name, whatever word is above it', () => {
  for (const word of ['Score', 'Bonus', 'Amount']) {
    const { columns } = readColumns(['Employee no', `${word}: Housing`], { schemes: [HOUSING] });
    assert.equal(columns[1]?.kind, 'score', word);
    assert.equal(columns[1].scheme.id, 7);
  }
});

test('a set figure is read as money, not as a percentage', () => {
  const read = readSheet('Employee no,Bonus: Housing\n1,350', {
    staff: ONE, profiles: PAID, schemes: [HOUSING], memberOf: UNDER,
  });

  const [change] = read.lines[0].changes;
  assert.equal(change.to, 350);
  assert.equal(change.from, null, 'nothing set for them yet');
  assert.equal(change.paysAmount, true);
  assert.equal(change.label, 'Housing', 'not "Housing score", which it is not');
});

test('a figure over a hundred is a figure, not an impossible score', () => {
  const read = readSheet('Employee no,Bonus: Housing\n1,1500', {
    staff: ONE, profiles: PAID, schemes: [HOUSING], memberOf: UNDER,
  });
  assert.equal(read.lines[0].changes[0].to, 1500);
  assert.deepEqual(read.lines[0].notes, []);
});

test('a score over a hundred is still refused', () => {
  const read = readSheet('Employee no,Score: Guest scores\n1,150', {
    staff: ONE, profiles: PAID, schemes: [SCORED], memberOf: UNDER,
  });
  assert.deepEqual(read.lines[0].changes, []);
  assert.match(read.lines[0].notes[0].why, /0 to 100/);
});

test('the figure somebody already has is not a change', () => {
  const read = readSheet('Employee no,Bonus: Housing\n1,350', {
    staff: ONE,
    profiles: PAID,
    schemes: [HOUSING],
    memberOf: UNDER,
    awardBy: new Map([['7|1', 350]]),
  });
  assert.equal(read.lines.length, 0);
});

test('a figure against a scheme somebody is not under is refused', () => {
  const read = readSheet('Employee no,Bonus: Housing\n1,350', {
    staff: ONE, profiles: PAID, schemes: [HOUSING], memberOf: new Map(),
  });
  assert.deepEqual(read.lines[0].changes, []);
  assert.match(read.lines[0].notes[0].why, /not under this scheme/);
});

test('the sheet writes the figure through, and it lands as an award', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  const scheme = await housing(db, { staffIds: [1, 2] });

  await applyInput(ctx(db, {
    body: {
      month: MONTH,
      text: `Employee no,Bonus: Housing\n1,350\n2,500`,
    },
  }));

  const stored = raw.prepare('SELECT staff_id, score, amount FROM pay_score ORDER BY staff_id').all();
  assert.deepEqual(stored.map((r) => [r.staff_id, r.score, r.amount]), [[1, 100, 350], [2, 100, 500]]);

  const out = await read(await payroll(ctx(db, { query: `?month=${MONTH}` })));
  assert.equal(out.lines.find((l) => l.staff.name === 'Kofi').bonus.earned, 350);
  assert.equal(out.schemes.find((s) => s.id === scheme.id).scores.find((x) => x.staffId === 2).award, 500);
});

test('a scored scheme is still written as a score', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  await saveScheme(ctx(db, { body: { name: 'Guest scores', amount: 500, staffIds: [1] } }));

  await applyInput(ctx(db, {
    body: { month: MONTH, text: 'Employee no,Score: Guest scores\n1,80' },
  }));

  const row = raw.prepare('SELECT score, amount FROM pay_score').get();
  assert.equal(row.score, 80);
  assert.equal(row.amount, null, 'so the scheme’s worth today is what applies');
});

test('the template offers money for one and a score for the other', async () => {
  const { db } = setup();
  await onPayroll(db);
  const scheme = await housing(db, { staffIds: [1] });
  await saveScheme(ctx(db, { body: { name: 'Guest scores', amount: 500, staffIds: [1] } }));
  await setScores(ctx(db, {
    body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, amount: 350 }] },
  }));

  const body = await (await inputTemplate(ctx(db, { query: `?month=${MONTH}` }))).text();
  const lines = body.trim().split('\n');
  assert.match(lines[0], /Bonus: Housing/);
  assert.match(lines[0], /Score: Guest scores/);
  assert.match(lines.find((l) => l.startsWith('1,Kofi')), /350\.00/);
  assert.ok(lines.find((l) => l.startsWith('2,Ama')).includes(',,'),
    'blank against a scheme Ama is not under');
});

test('a round trip through the month’s template changes nothing', async () => {
  const { db } = setup();
  await onPayroll(db);
  const scheme = await housing(db, { staffIds: [1, 2] });
  await setScores(ctx(db, {
    body: {
      month: MONTH,
      rows: [
        { schemeId: scheme.id, staffId: 1, amount: 350 },
        { schemeId: scheme.id, staffId: 2, amount: 500 },
      ],
    },
  }));

  const sheet = await (await inputTemplate(ctx(db, { query: `?month=${MONTH}` }))).text();
  const out = await read(await readInput(ctx(db, { body: { month: MONTH, text: sheet } })));
  assert.equal(out.tally.changes, 0, 'what came down is what is already here');
});

test('a blank cell leaves somebody’s figure alone', async () => {
  const { raw, db } = setup();
  await onPayroll(db);
  const scheme = await housing(db, { staffIds: [1, 2] });
  await setScores(ctx(db, {
    body: { month: MONTH, rows: [{ schemeId: scheme.id, staffId: 1, amount: 350 }] },
  }));

  await applyInput(ctx(db, {
    body: { month: MONTH, text: 'Employee no,Bonus: Housing\n1,\n2,500' },
  }));

  const kofi = raw.prepare('SELECT amount FROM pay_score WHERE staff_id = 1').get();
  assert.equal(kofi.amount, 350);
});
