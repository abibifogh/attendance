import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { readXlsx } from '../public/js/xlsx-read.js';
import {
  addPenalty, applyInput, inputTemplate, readInput, saveScheme, setProfiles, setScores,
} from '../src/routes/payroll.js';

/**
 * The month's payroll sheet, laid out like the office's bonus sheet.
 *
 * Departments across the top with their schemes under them, the bonus in
 * money, then Deductions and a Total. Along the left, the basic, the
 * take-home and whether the bonus goes on top. Downloaded filled in, changed,
 * and sent back. The people are made up; the schemes are the property's.
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
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

const MONTH = '2026-10';
const WAGES = { user: { id: 9, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };
const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/payroll${query}`),
  session: WAGES,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  }),
});
const read = async (r) => r.json();

async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM users;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec(`INSERT INTO settings (key, value) VALUES ('att_departments', 'Housekeeping\nMaintenance\nReception')
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES
    (1, 'E1', 'Akosua Mensah', 'Housekeeping', '2020-01-01'),
    (2, 'E2', 'Kojo Antwi', 'Maintenance', '2020-01-01'),
    (3, 'E3', 'Ama Boateng', 'Reception', '2020-01-01')`);
  const db = d1(raw);

  await setProfiles(ctx(db, {
    body: {
      rows: [
        { staffId: 1, basic: 800, ssnit: true, takeHome: 1850, takeHomeFixed: true, allowances: [] },
        { staffId: 2, basic: 700, ssnit: true, allowances: [] },
        { staffId: 3, basic: 490, ssnit: false, takeHome: 600, allowances: [] },
      ],
    },
  }));
  const scheme = async (body) => read(await saveScheme(ctx(db, { body })));
  const everybody = await scheme({ name: 'Nkosoɔ bonus', amount: 110, departments: [], staffIds: [1, 3] });
  const anidaho = await scheme({ name: 'Anidahɔ bonus', amount: 400, departments: ['Housekeeping'], staffIds: [1] });
  const grati = await scheme({
    name: 'Grati-Pay', amount: 0, kind: 'amount', departments: ['Maintenance', 'Reception'], staffIds: [2, 3],
  });
  await setScores(ctx(db, {
    body: {
      month: MONTH,
      rows: [
        { schemeId: everybody.id, staffId: 1, score: 100 },
        { schemeId: everybody.id, staffId: 3, score: 100 },
        { schemeId: anidaho.id, staffId: 1, score: 100 },
        { schemeId: grati.id, staffId: 2, amount: 250 },
        { schemeId: grati.id, staffId: 3, amount: 200 },
      ],
    },
  }));
  await addPenalty(ctx(db, { body: { month: MONTH, staffId: 3, amount: 20, reason: 'Late for shift' } }));
  return { raw, db, ids: { everybody: everybody.id, anidaho: anidaho.id, grati: grati.id } };
}

async function sheet(db) {
  const response = await inputTemplate(ctx(db, { query: `?month=${MONTH}` }));
  assert.match(response.headers.get('Content-Type'), /spreadsheetml/);
  const [first] = await readXlsx(new Uint8Array(await response.arrayBuffer()));
  return first.rows;
}

test('the sheet is laid out like the office’s: departments over their schemes, money in the cells', async () => {
  const { db } = await setup();
  const rows = await sheet(db);
  const groups = rows[2];
  const heads = rows[3];

  assert.deepEqual(heads.slice(0, 6), ['Employee no', 'Staff name', 'Department', 'Basic', 'Take-home', '+ bonus']);
  assert.deepEqual(heads.slice(6), [
    'Nkosoɔ bonus', 'Anidahɔ bonus', 'Grati-Pay', 'Grati-Pay', 'Deductions', 'Total', 'Advance',
  ], 'a scheme covering two departments has a column under each');
  assert.deepEqual([groups[6], groups[7], groups[8], groups[9]], ['EVERYBODY', 'HOUSEKEEPING', 'MAINTENANCE', 'RECEPTION']);

  const line = (name) => rows.find((r) => r[1] === name);
  assert.deepEqual(line('Akosua Mensah').slice(3, 13), [800, 1850, 'Yes', 110, 400, null, null, 0, 510, 0]);
  const kojo = line('Kojo Antwi');
  assert.equal(kojo[4], null, 'no take-home, so the box is empty');
  assert.equal(kojo[5], null, 'and so is + bonus');
  assert.equal(kojo[8], 250, 'under his own department');
  assert.equal(kojo[9], null);
  const ama = line('Ama Boateng');
  assert.deepEqual([ama[4], ama[5]], [600, 'No']);
  assert.equal(ama[8], null);
  assert.equal(ama[9], 200, 'under Reception, not Maintenance');
  assert.equal(ama[10], 20, 'what was docked');
  assert.equal(ama[11], 290, '110 + 200 less 20');

  const totals = rows.find((r) => r[0] === 'Totals');
  assert.equal(totals[3], 1990, 'the basics added up');
});

test('sent back untouched, it changes nothing and knows every column', async () => {
  const { db } = await setup();
  const rows = await sheet(db);
  const out = await read(await readInput(ctx(db, { body: { month: MONTH, rows } })));
  assert.deepEqual(out.unknown, []);
  assert.deepEqual(out.skipped, [], 'the totals line is not a person');
  assert.equal(out.tally.changes, 0);
});

test('changed and sent back: bonuses in money, take-homes, + bonus and deductions all land', async () => {
  const { raw, db, ids } = await setup();
  const rows = await sheet(db);
  const at = (name) => rows.findIndex((r) => r[1] === name);
  rows[at('Akosua Mensah')][7] = 320; // Anidahɔ: 320 of 400 is a score of 80
  rows[at('Akosua Mensah')][4] = 1900;
  rows[at('Kojo Antwi')][8] = 300; // Grati-Pay pays a figure
  rows[at('Ama Boateng')][5] = 'Yes';
  rows[at('Ama Boateng')][10] = 50; // 20 with a reason already; the sheet adds 30

  const preview = await read(await readInput(ctx(db, { body: { month: MONTH, rows } })));
  const anidaho = preview.lines.find((l) => l.staffId === 1).changes.find((c) => c.schemeId === ids.anidaho);
  assert.deepEqual([anidaho.from, anidaho.to, anidaho.score], [400, 320, 80], 'shown in money, set as a score');
  assert.equal(preview.tally.changes, 5);

  const done = await read(await applyInput(ctx(db, { body: { month: MONTH, rows } })));
  assert.deepEqual([done.scores, done.takeHomes, done.deductions], [2, 2, 1]);

  const score = (scheme, staff) => raw.prepare(
    'SELECT s.score, s.amount FROM pay_score s JOIN pay_run r ON r.id = s.run_id WHERE r.month = ? AND scheme_id = ? AND staff_id = ?',
  ).get(MONTH, scheme, staff);
  assert.deepEqual({ ...score(ids.anidaho, 1) }, { score: 80, amount: 400 });
  assert.deepEqual({ ...score(ids.grati, 2) }, { score: 100, amount: 300 });

  const profile = (id) => raw.prepare('SELECT take_home, take_home_basis FROM pay_profile WHERE staff_id = ?').get(id);
  assert.deepEqual({ ...profile(1) }, { take_home: 1900, take_home_basis: 'fixed' });
  assert.deepEqual({ ...profile(3) }, { take_home: 600, take_home_basis: 'fixed' });

  const docked = raw.prepare('SELECT amount, reason FROM pay_penalty WHERE staff_id = 3 ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(docked, [
    { amount: 20, reason: 'Late for shift' },
    { amount: 30, reason: 'Deductions on the payroll sheet' },
  ], 'the one with a reason stays, the sheet adds the rest');

  // Sent again with a different total, the sheet's share is replaced, not added to.
  const again = await sheet(db);
  again[again.findIndex((r) => r[1] === 'Ama Boateng')][10] = 25;
  await applyInput(ctx(db, { body: { month: MONTH, rows: again } }));
  assert.deepEqual(raw.prepare('SELECT amount FROM pay_penalty WHERE staff_id = 3 ORDER BY id').all().map((r) => r.amount), [20, 5]);

  // And going below what was docked with a reason is refused with why.
  const lower = await sheet(db);
  lower[lower.findIndex((r) => r[1] === 'Ama Boateng')][10] = 10;
  const refused = await read(await readInput(ctx(db, { body: { month: MONTH, rows: lower } })));
  assert.match(refused.lines.find((l) => l.staffId === 3).notes[0].why, /already docked with a reason/);
});

test('a figure more than a scheme pays at a full score is refused, and so is one in the wrong department’s column twice over', async () => {
  const { db } = await setup();
  const rows = await sheet(db);
  const akosua = rows.findIndex((r) => r[1] === 'Akosua Mensah');
  rows[akosua][7] = 450;
  const out = await read(await readInput(ctx(db, { body: { month: MONTH, rows } })));
  assert.match(out.lines.find((l) => l.staffId === 1).notes[0].why, /more than it pays at a full score \(400\.00\)/);

  const twice = await sheet(db);
  const kojo = twice.findIndex((r) => r[1] === 'Kojo Antwi');
  twice[kojo][9] = 275; // A second, different Grati-Pay figure under Reception
  const clash = await read(await readInput(ctx(db, { body: { month: MONTH, rows: twice } })));
  assert.match(clash.lines.find((l) => l.staffId === 2).notes[0].why, /two different figures/);
});

test('the office’s own bonus sheet reads too: headings over two rows, bare scheme names', async () => {
  const { raw, db, ids } = await setup();
  const rows = [
    [null, 'STAFF NAME', null, 'HOUSEKEEPING', 'MAINTENANCE', 'RECEPTION', 'DEDUCTIONS', 'TOTAL'],
    [null, null, 'Nkosoɔ bonus', 'Anidahɔ bonus', 'Grati-Pay', 'Grati-Pay', null, 'Net'],
    [null, 'Akosua Mensah', 110, 360, null, null, 0, 470],
    [null, 'Kojo Antwi', null, null, 250, null, 0, 250],
    [null, 'Somebody Else', 110, null, null, 200, 0, 310],
    [null, null, null, null, null, null, 0, 1030],
  ];
  const out = await read(await readInput(ctx(db, { body: { month: MONTH, rows } })));
  assert.deepEqual(out.unknown, []);
  assert.deepEqual(out.skipped.map((s) => s.name), ['Somebody Else'], 'a name HIVE does not have is said, not guessed');
  const change = out.lines.find((l) => l.staffId === 1).changes;
  assert.deepEqual(change.map((c) => [c.schemeId, c.to, c.score]), [[ids.anidaho, 360, 90]]);
  await applyInput(ctx(db, { body: { month: MONTH, rows } }));
  assert.equal(raw.prepare('SELECT score FROM pay_score WHERE scheme_id = ? AND staff_id = 1').get(ids.anidaho).score, 90);
});

test('the plain CSV is still there for anything that wants it', async () => {
  const { db } = await setup();
  const csv = await (await inputTemplate(ctx(db, { query: `?month=${MONTH}&as=csv` }))).text();
  assert.match(csv.split('\n')[0], /^Employee no,Name,Basic/);
});
