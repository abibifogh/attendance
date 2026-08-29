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
