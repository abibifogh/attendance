import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync } from 'node:zlib';

import { readXlsx } from '../public/js/xlsx-read.js';
import { workbook } from '../src/lib/xlsx.js';
import { matchStaff, readMedicalSheet } from '../src/lib/medical-sheet.js';
import { FROM_SHEET, checkSheet, importSheet, medical } from '../src/routes/medical.js';

/**
 * The office's medical sheet, brought into HIVE.
 *
 * The sheet is the one the property kept before HIVE: a row a person, what
 * they brought forward, a column a month, and what that leaves, worked out in
 * formulas like `=1300+C4-P4`. The people and figures here are made up. The
 * shape is the real sheet's: names spelt a letter differently, middle names on
 * one side and not the other, and a stray row of figures under the totals.
 */

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

/** A zip, compressed the way Excel and Google Sheets write one. */
function deflatedZip(parts) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const raw = enc.encode(text);
    const data = deflateRawSync(raw);
    const nameBytes = enc.encode(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

const GOOGLE_SHEET = deflatedZip({
  'xl/workbook.xml': '<workbook><sheets><sheet state="visible" name="2026" sheetId="1" r:id="rId3"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId3" Type="x" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>NAME OF EMPLOYEE</t></si><si><t>BAL. B/F</t></si>'
    + '<si><r><t>Kofi </t></r><r><t>Mensah &amp; Co</t></r></si><si><t>JAN</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
    + '<row r="2"><c r="B2" t="s"><v>0</v></c><c r="C2" t="s"><v>1</v></c><c r="D2" t="s"><v>3</v></c></row>'
    + '<row r="3"><c r="A3" s="4"/><c r="B3" t="s"><v>2</v></c><c r="C3"><v>750.4</v></c>'
    + '<c r="D3"><f>400+120.5</f><v>520.5</v></c><c r="E3" t="inlineStr"><is><t>typed</t></is></c></row>'
    + '</sheetData></worksheet>',
  'xl/theme/theme1.xml': '<theme/>',
});

test('a compressed sheet reads as the values it shows, formulas as their results', async () => {
  const [sheet, ...more] = await readXlsx(GOOGLE_SHEET);
  assert.equal(more.length, 0);
  assert.equal(sheet.name, '2026');
  assert.deepEqual(sheet.rows[0], [], 'an empty first row is still a row');
  assert.deepEqual(sheet.rows[1], [null, 'NAME OF EMPLOYEE', 'BAL. B/F', 'JAN']);
  assert.deepEqual(sheet.rows[2], [null, 'Kofi Mensah & Co', 750.4, 520.5, 'typed'],
    'shared strings in runs, entities, a formula’s saved result, an inline string');
});

test('HIVE’s own spreadsheets read back too', async () => {
  const bytes = workbook([{ name: 'Mine', rows: [['Name', 'Amount'], ['Ama', 12.5]] }]);
  const [sheet] = await readXlsx(bytes);
  assert.equal(sheet.name, 'Mine');
  assert.deepEqual(sheet.rows, [['Name', 'Amount'], ['Ama', 12.5]]);
});

test('something that is not a spreadsheet says so', async () => {
  await assert.rejects(readXlsx(new TextEncoder().encode('name,amount\nAma,1')), /not a spreadsheet/);
});

// ---------------------------------------------------------------------------
// What the sheet says
// ---------------------------------------------------------------------------

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const person = (name, bf, months) => {
  const m = MONTHS.map((_, i) => months[i] ?? null);
  const claimed = m.reduce((n, v) => n + (v ?? 0), 0);
  return [null, name, bf, ...m, claimed, Math.round((1300 + (bf ?? 0) - claimed) * 100) / 100];
};
const SHEET = [
  [null, null, 'SN - STAFF MEDICAL ALLOWANCE'],
  [],
  [null, 'NAME OF EMPLOYEE', 'BAL. B/F', ...MONTHS, 'CLAIMS', 'BAL. C/F'],
  person('Mensah Akosua Serwaa', 800, [280, null, null, 60, null, null, 620, 760]),
  person('Kwame Nii Boateng', -5, []),
  person('Abena Pokua Owusu', 30, [null, null, 200, 580, null, null, 75, 140, 600]),
  person('Grace Lamptey', null, []),
  [null, null, null, 280, 0, 200, 640, 0, 0, 695, 900, 600, 0, 0, 0, 3315, 3910],
  [null, null, null, null, null, null, null, 300, null, null, 650],
];

test('everybody on it, with the year’s figure worked back from the sheet’s own columns', () => {
  const { people } = readMedicalSheet(SHEET);
  assert.equal(people.length, 4);
  const [akosua, kwame, abena, grace] = people;
  assert.deepEqual(
    { ...akosua, notes: undefined },
    {
      row: 4,
      name: 'Mensah Akosua Serwaa',
      broughtForward: 800,
      months: [280, 0, 0, 60, 0, 0, 620, 760, 0, 0, 0, 0],
      claimed: 1720,
      allowance: 1300,
      left: 380,
      notes: undefined,
    },
  );
  assert.equal(kwame.broughtForward, -5, 'a debt carried in stays a debt');
  assert.equal(kwame.left, 1295);
  assert.equal(abena.left, -265, 'claimed more than they had');
  assert.equal(grace.broughtForward, 0, 'nothing brought forward is nought');
  assert.ok(people.every((p) => p.allowance === 1300));
});

test('the totals and a row of figures with no name are left out, and said', () => {
  const { left } = readMedicalSheet(SHEET);
  assert.deepEqual(left, [
    { row: 8, why: 'the totals', figures: [] },
    { row: 9, why: 'figures with no name', figures: ['May 300', 'Aug 650'] },
  ]);
});

test('a claims column that disagrees with the months is pointed out', () => {
  const rows = SHEET.slice(0, 4).map((r) => [...r]);
  rows[3][15] = 1700;
  const [akosua] = readMedicalSheet(rows).people;
  assert.equal(akosua.claimed, 1720, 'the months are what counts');
  assert.match(akosua.notes[0], /claims column says 1700/);
});

test('a sheet with no heading row is refused with what it needs', () => {
  assert.throws(() => readMedicalSheet([['a', 'b'], [1, 2]]), /heading row/);
});

// ---------------------------------------------------------------------------
// Who is who
// ---------------------------------------------------------------------------

const STAFF = [
  { id: 1, name: 'Akosua Serwaa Mensah', active: 1 },
  { id: 2, name: 'Kwame Boateng', active: 1 },
  { id: 3, name: 'Kojo Antim', active: 1 },
  { id: 4, name: 'Salifu Musah Abdullai', active: 1 },
  { id: 5, name: 'Kofi Owusu Darko', active: 1 },
  { id: 6, name: 'Kofi Tetteh', active: 0 },
  { id: 7, name: 'Ama Sarpong', active: 1 },
  { id: 8, name: 'Efua Nana Adjoa Quaye', active: 1 },
];
const who = (name) => matchStaff(name, STAFF);

test('the same words in any order are the same person', () => {
  assert.deepEqual([who('Mensah Akosua Serwaa').level, who('Mensah Akosua Serwaa').staffId], ['same', 1]);
  assert.deepEqual([who('Tetteh Kofi').level, who('Tetteh Kofi').staffId], ['same', 6],
    'including somebody who has left');
});

test('a middle name, or a letter spelt differently, is a close match', () => {
  assert.deepEqual([who('Kwame Nii Boateng').level, who('Kwame Nii Boateng').staffId], ['close', 2]);
  assert.deepEqual([who('Kojo Antwim').level, who('Kojo Antwim').staffId], ['close', 3]);
  assert.deepEqual([who('Salifu Musah Abdulai').level, who('Salifu Musah Abdulai').staffId], ['close', 4]);
  assert.deepEqual([who('Efua Adjoa Quaye').level, who('Efua Adjoa Quaye').staffId], ['close', 8]);
});

test('a first name alone is offered, never chosen', () => {
  const kofi = who('Kofi Anane');
  assert.equal(kofi.level, 'check');
  assert.equal(kofi.staffId, null);
  assert.deepEqual(kofi.candidates.map((c) => c.id).sort(), [5, 6]);
  const ama = who('Asantewaa Ama Ofori');
  assert.equal(ama.level, 'check');
  assert.equal(ama.staffId, null);
  assert.equal(ama.candidates[0].id, 7);
});

test('nobody like them is nobody', () => {
  assert.deepEqual(who('Grace Lamptey'), { level: 'none', staffId: null, candidates: [] });
});

test('two people equally close is a question, not a guess', () => {
  const twins = [{ id: 1, name: 'Kofi Mensah', active: 1 }, { id: 2, name: 'Kofi Mensah', active: 1 }];
  assert.equal(matchStaff('Kofi Mensah', twins).level, 'check');
});

// ---------------------------------------------------------------------------
// Bringing it in
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
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM users;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, hired_on, active) VALUES
    (1, 'E1', 'Akosua Serwaa Mensah', 'Front', '2020-01-01', 1),
    (2, 'E2', 'Kwame Boateng', 'Kitchen', '2020-01-01', 1),
    (3, 'E3', 'Abena Pokua Owusu', 'Front', '2020-01-01', 1),
    (4, 'E4', 'Esi Arthur', 'Kitchen', '2020-01-01', 0)`);
  return { raw, db: d1(raw) };
}

const OFFICE = { user: { id: 9, name: 'Yaa', role: 'admin' }, permissions: ['hr_pay'] };
const ctx = (db, body = null, query = '') => ({
  db,
  env: {},
  url: new URL(`https://x/api/medical${query}`),
  session: OFFICE,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  }),
});
const read = async (r) => r.json();

test('checking a sheet matches it against everybody in HIVE and writes nothing', async () => {
  const { raw, db } = setup();
  const sheet = [...SHEET.slice(0, 7), person('Esi Arthur', 2500, [null, null, null, null, null, null, null, null, 300])];
  const out = await read(await checkSheet(ctx(db, { year: 2026, rows: sheet })));

  const by = Object.fromEntries(out.people.map((p) => [p.name, p.match]));
  assert.equal(by['Mensah Akosua Serwaa'].staffId, 1);
  assert.equal(by['Kwame Nii Boateng'].staffId, 2);
  assert.equal(by['Abena Pokua Owusu'].staffId, 3);
  assert.equal(by['Esi Arthur'].staffId, 4, 'somebody who has left is still found');
  assert.equal(by['Grace Lamptey'].level, 'none');
  assert.equal(out.staff.length, 4);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hr_medical_allowance').get().n, 0, 'nothing written');
});

const rowsFor = (people) => people.map(([staffId, bf, months]) => ({
  staffId, allowance: 1300, broughtForward: bf, months: [...months, ...new Array(12 - months.length).fill(0)],
}));
const AKOSUA = [1, 800, [280, 0, 0, 60, 0, 0, 620, 760]];
const ABENA = [3, 30, [0, 0, 200, 580, 0, 0, 75, 140, 600]];

async function standing(db, id) {
  const out = await read(await medical(ctx(db, null, '?year=2026')));
  return out.people.find((p) => p.staff.id === id).standing;
}

test('starting from what is left: HIVE shows what the sheet shows', async () => {
  const { raw, db } = setup();
  const done = await read(await importSheet(ctx(db, { year: 2026, mode: 'balance', rows: rowsFor([AKOSUA, ABENA]) })));
  assert.deepEqual(done, { ok: true, year: 2026, mode: 'balance', people: 2, claims: 0 });

  const akosua = await standing(db, 1);
  assert.equal(akosua.allowance, 1300);
  assert.equal(akosua.left, 380);

  const abena = await standing(db, 3);
  assert.equal(abena.left, 0, 'nobody starts below nothing');
  assert.match(raw.prepare('SELECT note FROM hr_medical_allowance WHERE staff_id = 3').get().note, /265 over/,
    'and what they went over is written down');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hr_medical_claim').get().n, 0);
});

test('starting from what was brought forward: every month’s paper claims are written in', async () => {
  const { raw, db } = setup();
  const done = await read(await importSheet(ctx(db, { year: 2026, mode: 'history', rows: rowsFor([AKOSUA, ABENA]) })));
  assert.equal(done.claims, 9, 'four months for Akosua, five for Abena');

  const akosua = await standing(db, 1);
  assert.equal(akosua.opening, 2100);
  assert.equal(akosua.spent, 1720);
  assert.equal(akosua.left, 380);
  assert.equal((await standing(db, 3)).left, -265, 'the claims carry them over, as they did');

  const july = raw.prepare("SELECT * FROM hr_medical_claim WHERE staff_id = 1 AND what LIKE '%July%'").get();
  assert.equal(july.amount, 620);
  assert.equal(july.status, 'approved');
  assert.equal(july.asked_at, '2026-07-01 00:00:00');
  assert.equal(july.decision, FROM_SHEET);
});

test('bringing it in again replaces what it wrote, and leaves claims made in HIVE alone', async () => {
  const { raw, db } = setup();
  raw.exec(`INSERT INTO hr_medical_claim (staff_id, year, amount, approved, what, status)
    VALUES (1, 2026, 120, 120, 'Pharmacy', 'approved')`);

  await importSheet(ctx(db, { year: 2026, mode: 'history', rows: rowsFor([AKOSUA]) }));
  await importSheet(ctx(db, { year: 2026, mode: 'history', rows: rowsFor([AKOSUA]) }));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hr_medical_claim WHERE staff_id = 1').get().n, 5,
    'four from the sheet, once, and the one made in HIVE');

  await importSheet(ctx(db, { year: 2026, mode: 'balance', rows: rowsFor([AKOSUA]) }));
  const left = raw.prepare('SELECT what FROM hr_medical_claim WHERE staff_id = 1').all().map((r) => r.what);
  assert.deepEqual(left, ['Pharmacy'], 'switching to a balance takes the paper claims back out');

  const check = await read(await checkSheet(ctx(db, { year: 2026, rows: SHEET })));
  assert.deepEqual(check.held['1'], {
    allowance: 1300, opening: 380, claims: 1, approved: 120, waiting: 0, fromSheet: 0,
  }, 'and the check says a claim made in HIVE is there, so it can be looked at');
});

test('one person on two rows, or somebody not in HIVE, is refused', async () => {
  const { db } = setup();
  await assert.rejects(importSheet(ctx(db, { year: 2026, rows: rowsFor([AKOSUA, AKOSUA]) })),
    /matched to two rows/);
  await assert.rejects(importSheet(ctx(db, { year: 2026, rows: rowsFor([[99, 0, []]]) })),
    /not in HIVE/);
});
