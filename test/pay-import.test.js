import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readColumns, readMoney, readScore, readSheet, tallyOf } from '../src/lib/pay-import.js';

/**
 * A month's payroll input, out of a spreadsheet.
 *
 * The thing this has to get right is what it refuses. A payroll sheet arrives
 * from a finance office, has been round three people, and one of them has
 * added a row. Nothing in here may create a person, an allowance, a scheme or
 * an advance: the property decided those, and a file that could quietly add
 * one is a file that eventually does.
 */

const STAFF = [
  { id: 1, employee_no: '1001', name: 'Ama Boateng', active: 1 },
  { id: 2, employee_no: '1002', name: 'Kofi Mensah', active: 1 },
  { id: 3, employee_no: '1003', name: 'Yaw Osei', active: 0 },
];

const CONTEXT = {
  staff: STAFF,
  allowances: ['Transport', 'Meals on duty'],
  schemes: [{ id: 7, name: 'Front of house' }, { id: 8, name: 'Upselling' }],
  profiles: new Map([[1, { basic: 2000 }], [2, { basic: 1200 }]]),
  allowanceBy: new Map([
    [1, [{ name: 'Transport', amount: 300, taxable: 1 }]],
    [2, [{ name: 'Meals on duty', amount: 200, taxable: 0 }]],
  ]),
  scoreBy: new Map([['7|1', 80]]),
  memberOf: new Map([[1, [7, 8]], [2, [7]]]),
  advanceDue: new Map([[1, 250]]),
};

// ---------------------------------------------------------------------------
// Reading a cell
// ---------------------------------------------------------------------------

test('a blank cell is not a nought', () => {
  // The difference between leaving an allowance alone and taking it away.
  assert.equal(readMoney(''), null);
  assert.equal(readMoney('   '), null);
  assert.equal(readMoney(undefined), null);
  assert.equal(readMoney('0'), 0);
});

test('a figure survives a trip round a finance office', () => {
  assert.equal(readMoney('1,400.00'), 1400);
  assert.equal(readMoney('GHS 1,400'), 1400);
  assert.equal(readMoney('₵2,000.50'), 2000.5);
  assert.equal(readMoney(' 900 '), 900);
  // Brackets are how an accountant writes a negative.
  assert.equal(readMoney('(150.00)'), -150);
  assert.ok(Number.isNaN(readMoney('n/a')));
});

test('a score is read with or without its sign', () => {
  assert.equal(readScore('80'), 80);
  assert.equal(readScore('80%'), 80);
  assert.equal(readScore('62.5 %'), 62.5);
  assert.equal(readScore(''), null);
});

// ---------------------------------------------------------------------------
// The columns
// ---------------------------------------------------------------------------

test('columns are matched on the property’s own words, in any order', () => {
  const { columns, unknown } = readColumns(
    ['Score: Upselling', 'NAME', 'Transport', 'basic salary', 'Employee No'],
    CONTEXT,
  );
  assert.deepEqual(columns.map((c) => c.kind),
    ['score', 'name', 'allowance', 'basic', 'employeeNo']);
  assert.equal(columns[0].scheme.id, 8);
  assert.equal(columns[2].name, 'Transport');
  assert.deepEqual(unknown, []);
});

test('an allowance and a scheme of the same name are two different columns', () => {
  const both = {
    allowances: ['Service'],
    schemes: [{ id: 9, name: 'Service' }],
  };
  const { columns } = readColumns(['Service', 'Score: Service'], both);
  assert.equal(columns[0].kind, 'allowance');
  assert.equal(columns[1].kind, 'score');
});

test('a column nobody recognises is named back rather than dropped in silence', () => {
  const { columns, unknown } = readColumns(['Name', 'Housing', 'Score: Cleanliness'], CONTEXT);
  assert.deepEqual(columns.map((c) => c.kind), ['name']);
  assert.deepEqual(unknown, ['Housing', 'Score: Cleanliness']);
});

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

const sheet = (rows) => rows.map((r) => r.join(',')).join('\n');

test('only what changed is a change', () => {
  const read = readSheet(sheet([
    ['Employee no', 'Name', 'Basic', 'Transport', 'Score: Front of house'],
    ['1001', 'Ama Boateng', '2000.00', '350.00', '80'],
    ['1002', 'Kofi Mensah', '1300.00', '', '90'],
  ]), CONTEXT);

  const ama = read.lines.find((l) => l.staffId === 1);
  // Basic and the score are what they already were; only the allowance moved.
  assert.deepEqual(ama.changes.map((c) => c.label), ['Transport']);
  assert.deepEqual(
    ama.changes[0],
    { kind: 'allowance', name: 'Transport', label: 'Transport', from: 300, to: 350, taxable: true },
  );

  const kofi = read.lines.find((l) => l.staffId === 2);
  assert.deepEqual(kofi.changes.map((c) => [c.label, c.from, c.to]),
    [['Basic', 1200, 1300], ['Front of house score', 0, 90]]);

  assert.equal(tallyOf(read).changes, 3);
  assert.equal(tallyOf(read).people, 2);
});

test('a name the register does not know is skipped and named', () => {
  const read = readSheet(sheet([
    ['Employee no', 'Name', 'Basic'],
    ['9999', 'Somebody New', '1500'],
    ['1003', 'Yaw Osei', '1500'],
  ]), CONTEXT);

  assert.deepEqual(read.lines, []);
  assert.deepEqual(read.skipped.map((s) => [s.name, s.why]), [
    ['Somebody New', 'nobody of that name or number'],
    ['Yaw Osei', 'no longer here'],
  ]);
});

test('an employee number wins over a name, and either will do', () => {
  const read = readSheet(sheet([
    ['Name', 'Basic'],
    ['Kofi Mensah', '1250'],
  ]), CONTEXT);
  assert.equal(read.lines[0].staffId, 2);
  assert.equal(read.lines[0].changes[0].to, 1250);
});

test('a score against a scheme somebody is not under is refused', () => {
  const read = readSheet(sheet([
    ['Employee no', 'Score: Upselling'],
    ['1002', '75'],
  ]), CONTEXT);

  assert.deepEqual(read.lines[0].changes, []);
  assert.deepEqual(read.lines[0].notes, [{ what: 'Upselling', why: 'not under this scheme' }]);
});

test('a basic for somebody not on the payroll is refused', () => {
  const read = readSheet(sheet([
    ['Employee no', 'Basic'],
    ['1001', '2100'],
  ]), { ...CONTEXT, profiles: new Map() });

  assert.deepEqual(read.lines[0].changes, []);
  assert.deepEqual(read.lines[0].notes, [{ what: 'Basic', why: 'not on the payroll yet' }]);
});

test('nonsense in a cell is named rather than turned into a figure', () => {
  const read = readSheet(sheet([
    ['Employee no', 'Basic', 'Score: Front of house'],
    ['1001', 'ask HR', '150'],
  ]), CONTEXT);

  assert.deepEqual(read.lines[0].changes, []);
  assert.deepEqual(read.lines[0].notes, [
    { what: 'Basic', why: 'not a figure' },
    { what: 'Front of house', why: 'a score is 0 to 100' },
  ]);
});

test('an allowance set to nought is an allowance taken away, and a blank is not', () => {
  const zeroed = readSheet(sheet([
    ['Employee no', 'Transport'],
    ['1001', '0'],
  ]), CONTEXT);
  assert.deepEqual(zeroed.lines[0].changes.map((c) => [c.from, c.to]), [[300, 0]]);

  const left = readSheet(sheet([
    ['Employee no', 'Transport'],
    ['1001', ''],
  ]), CONTEXT);
  assert.deepEqual(left.lines, []);
});

test('an allowance somebody does not have yet is added to them, not invented', () => {
  // "Meals on duty" is one of the property's own allowances, so a figure in
  // that column gives Ama one. A column called "Housing" would not, because
  // nobody here has a Housing allowance to give.
  const read = readSheet(sheet([
    ['Employee no', 'Meals on duty', 'Housing'],
    ['1001', '150', '400'],
  ]), CONTEXT);

  assert.deepEqual(read.lines[0].changes.map((c) => [c.label, c.from, c.to]),
    [['Meals on duty', null, 150]]);
  assert.deepEqual(read.unknown, ['Housing']);
});

test('the advance column is checked against the books and never written to them', () => {
  const read = readSheet(sheet([
    ['Employee no', 'Advance'],
    ['1001', '250.00'],
    ['1002', '400.00'],
  ]), CONTEXT);

  // Ama's matches, so there is nothing to say.
  assert.equal(read.lines.find((l) => l.staffId === 1), undefined);
  // Kofi's does not, and nobody is repaying anything, so the sheet is wrong
  // about him and says so instead of creating an advance.
  const kofi = read.lines.find((l) => l.staffId === 2);
  assert.equal(kofi.changes.length, 0);
  assert.match(kofi.notes[0].why, /the sheet says 400.00, the payroll will take 0.00/);
});

test('a file with no way of telling who anybody is says so', () => {
  const read = readSheet(sheet([
    ['Basic', 'Transport'],
    ['2000', '300'],
  ]), CONTEXT);
  assert.deepEqual(read.missingColumns, ['an employee number or a name']);
});

test('an empty file is an empty file, not a crash', () => {
  const read = readSheet('', CONTEXT);
  assert.deepEqual(read.lines, []);
  assert.deepEqual(read.missingColumns, ['a header row']);
});

test('a sheet that changes nothing produces nothing to agree to', () => {
  const read = readSheet(sheet([
    ['Employee no', 'Basic', 'Transport', 'Score: Front of house', 'Advance'],
    ['1001', '2000.00', '300.00', '80.00', '250.00'],
  ]), CONTEXT);

  assert.deepEqual(read.lines, []);
  assert.equal(tallyOf(read).changes, 0);
});
