import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowanceTotal, readColumns, readSheet } from '../src/lib/pay-import.js';

/**
 * "Allowances: Total".
 *
 * A column somebody adds up by hand and puts at the end of the allowances, and
 * for a long time the one thing the importer would not have: read as an
 * allowance called Total it puts a second copy of everybody's allowances on a
 * payslip, and read as nothing at all it was reported back as a column nobody
 * recognised.
 */

const KOFI = [{ id: 1, name: 'Kofi Mensah', employee_no: '1', active: 1 }];
const PAID = new Map([[1, { basic: 2000 }]]);
const HAS = new Map([[1, [
  { name: 'Transport', amount: 200, taxable: 1 },
  { name: 'Housing', amount: 300, taxable: 1 },
]]]);

const notesOf = (read) => read.lines.flatMap((l) => l.notes.map((n) => `${n.what}: ${n.why}`));
const changesOf = (read) => read.lines.flatMap((l) => l.changes.map((c) => `${c.name}=${c.to}`));

// ---------------------------------------------------------------------------

test('the half dozen ways people write it all read the same', () => {
  for (const heading of [
    'Allowances: Total', 'Allowance: Total', 'Total allowances', 'Total allowance',
    'Allowances Total', 'ALLOWANCES: TOTAL', ' allowances - total ', 'Sum of allowances',
  ]) {
    assert.equal(isAllowanceTotal(heading), true, heading);
  }
});

test('and an allowance that is not one is left alone', () => {
  for (const heading of ['Allowance: Transport', 'Allowances: Housing', 'Total', 'Basic']) {
    assert.equal(isAllowanceTotal(heading), false, heading);
  }
});

test('the plural reads as the singular, so "Allowances: Housing" is Housing', () => {
  const { columns, unknown } = readColumns(['Allowances: Housing'], { allowances: ['Housing'] });
  assert.deepEqual(unknown, []);
  assert.equal(columns[0].kind, 'allowance');
  assert.equal(columns[0].name, 'Housing');
});

test('a total is never a column nobody recognised', () => {
  const { columns, unknown } = readColumns(
    ['Employee no', 'Allowance: Transport', 'Allowances: Total'],
    { allowances: ['Transport', 'Housing'] },
  );
  assert.deepEqual(unknown, [], 'this is the error it used to give');
  assert.equal(columns[2].kind, 'allowanceTotal');
});

test('and it never becomes an allowance called Total', () => {
  const { columns } = readColumns(['Allowances: Total'], { allowances: ['Transport', 'Housing'] });
  assert.equal(columns[0].kind, 'allowanceTotal');
  assert.equal(columns[0].name, undefined, 'a payslip line reading "Total" is nobody’s idea');
});

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

const opts = (over = {}) => ({
  staff: KOFI, profiles: PAID, allowanceBy: HAS,
  allowances: ['Transport', 'Housing'], ...over,
});

test('a total that agrees with the columns beside it says nothing', () => {
  const read = readSheet(
    'Employee no,Allowance: Transport,Allowance: Housing,Allowances: Total\n1,400,300,700',
    opts(),
  );
  assert.deepEqual(changesOf(read), ['Transport=400']);
  assert.deepEqual(notesOf(read), [], 'four hundred and three hundred is seven hundred');
});

test('and one that does not is said, against the line it is on', () => {
  const read = readSheet(
    'Employee no,Allowance: Transport,Allowance: Housing,Allowances: Total\n1,400,300,900',
    opts(),
  );
  assert.deepEqual(notesOf(read), [
    'Allowances: the sheet totals 900.00, the payroll will pay 700.00',
  ]);
});

test('it is checked against what will be paid, not against the sheet alone', () => {
  // The sheet only moves Transport. Housing is untouched and still counts.
  const read = readSheet('Employee no,Allowance: Transport,Allowances: Total\n1,400,400', opts());
  assert.deepEqual(notesOf(read), [
    'Allowances: the sheet totals 400.00, the payroll will pay 700.00',
  ], 'the three hundred of Housing they already have is part of the total');
});

test('a total sets nothing of its own', () => {
  const read = readSheet(
    'Employee no,Allowance: Transport,Allowances: Total\n1,400,999',
    opts(),
  );
  assert.deepEqual(changesOf(read), ['Transport=400'], 'the 999 changes no figure anywhere');
});

test('a total on a line with nothing to say about it is quiet', () => {
  const read = readSheet('Employee no,Allowance: Transport,Allowances: Total\n1,400,', opts());
  assert.deepEqual(notesOf(read), [], 'a blank total is not a total of nought');
});

test('rubbish in the total column is named rather than read as a figure', () => {
  const read = readSheet('Employee no,Allowances: Total\n1,n/a', opts());
  assert.deepEqual(notesOf(read), ['Allowances: the total is not a figure']);
});

// ---------------------------------------------------------------------------
// The one case where it sets
// ---------------------------------------------------------------------------

test('a bare total on a property with one allowance is that allowance', () => {
  const read = readSheet('Employee no,Allowances: Total\n1,500', opts({
    allowances: ['Transport'],
    allowanceBy: new Map([[1, [{ name: 'Transport', amount: 200, taxable: 1 }]]]),
  }));
  assert.deepEqual(changesOf(read), ['Transport=500'], 'there is exactly one thing it can mean');
  assert.deepEqual(notesOf(read), []);
});

test('but not where there is a column for that allowance already', () => {
  const read = readSheet('Employee no,Allowance: Transport,Allowances: Total\n1,400,500', opts({
    allowances: ['Transport'],
    allowanceBy: new Map([[1, [{ name: 'Transport', amount: 200, taxable: 1 }]]]),
  }));
  assert.deepEqual(changesOf(read), ['Transport=400'], 'the named column is the instruction');
  assert.deepEqual(notesOf(read), [
    'Allowances: the sheet totals 500.00, the payroll will pay 400.00',
  ]);
});

test('and never where the property runs more than one', () => {
  const read = readSheet('Employee no,Allowances: Total\n1,900', opts());
  assert.deepEqual(changesOf(read), [], 'a total cannot say how it splits');
  assert.match(notesOf(read)[0], /column per allowance/);
});
