import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchShift, matchStaff, parseCsv, parseRotaCsv, planImport, readDate, readTime, shiftNameFor,
} from '../src/lib/roster-import.js';

/**
 * Reading a week's rota out of somebody else's export.
 *
 * The file is written by a scheduling system this app does not control, so
 * every assumption in here is one it could break next release. What the tests
 * pin is the behaviour that matters when it does: a line that cannot be read is
 * reported rather than dropped, and a name that is not certain is refused
 * rather than guessed.
 */

const STAFF = [
  { id: 1, name: 'Henry Aryee', employee_no: 'BKF001', active: 1 },
  { id: 2, name: 'Angela Ayima Asare', employee_no: 'HSK005', active: 1 },
  { id: 3, name: 'Chichi', employee_no: 'BAR001', active: 1 },
  { id: 4, name: 'Emmanuel Ofori Bennie', employee_no: 'ART004', active: 1 },
  { id: 5, name: 'Patience Torto', employee_no: 'HSK004', active: 1 },
];

const SHIFTS = [
  { id: 10, name: 'Breakfast main', starts_at: '05:00', ends_at: '11:30', department: 'F&B', active: 1 },
  { id: 11, name: 'Housekeeping main', starts_at: '08:00', ends_at: '17:00', department: 'Housekeeping', active: 1 },
  { id: 12, name: 'Craft', starts_at: '08:00', ends_at: '17:00', department: 'F&B', active: 1 },
  { id: 13, name: 'Maintenance 1', starts_at: '08:00', ends_at: '17:00', department: 'Maintenance', active: 1 },
];

// ---------------------------------------------------------------------------
// The file itself
// ---------------------------------------------------------------------------

test('a quoted comma does not split a field', () => {
  // The dates in this export read "Aug 17, 2026". Naive splitting loses the
  // year into a column of its own and every row after it slides sideways.
  const rows = parseCsv('"a","Aug 17, 2026","c"\n');
  assert.deepEqual(rows, [['a', 'Aug 17, 2026', 'c']]);
});

test('a doubled quote is one quote', () => {
  assert.deepEqual(parseCsv('"she said ""no""",b'), [['she said "no"', 'b']]);
});

test('the awkward shapes of a real file are read', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']], 'Windows line endings');
  assert.deepEqual(parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']], 'no trailing newline');
  assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']], 'an empty field in the middle');
  assert.deepEqual(parseCsv('"line\none",b'), [['line\none', 'b']], 'a newline inside quotes');
  assert.deepEqual(parseCsv('a,b\n\n\nc,d'), [['a', 'b'], ['c', 'd']], 'blank lines dropped');
});

test('dates and times are read in the shapes the export writes them', () => {
  assert.equal(readDate('Aug 17, 2026'), '2026-08-17');
  assert.equal(readDate('August 3, 2026'), '2026-08-03');
  assert.equal(readDate('2026-08-17'), '2026-08-17');
  assert.equal(readDate('the seventeenth'), null);

  assert.equal(readTime('05:00'), '05:00');
  assert.equal(readTime('5:00'), '05:00');
  assert.equal(readTime('17:30:00'), '17:30');
  assert.equal(readTime('25:00'), null);
});

test('a file that is not a rota is refused rather than half-read', () => {
  assert.match(parseRotaCsv('one,two\n1,2').problem, /does not look like a rota/i);
  assert.match(parseRotaCsv('').problem, /empty/i);
});

test('columns are found however they are capitalised', () => {
  const { rows, problem } = parseRotaCsv(
    'employee name,START DATE,Start Time,End Time\n'
    + '"Henry Aryee","Aug 17, 2026","05:00","11:30"\n',
  );
  assert.equal(problem, null);
  assert.equal(rows[0].name, 'Henry Aryee');
  assert.equal(rows[0].day, '2026-08-17');
});

test('an unreadable line is reported, never silently dropped', () => {
  const { rows } = parseRotaCsv(
    'Employee Names,Start Date,Start Time,End Time\n'
    + '"Henry Aryee","Aug 17, 2026","05:00","11:30"\n'
    + '"Henry Aryee","not a date","05:00","11:30"\n'
    + '"","Aug 17, 2026","05:00","11:30"\n'
    + '"Henry Aryee","Aug 17, 2026","05:00","05:00"\n',
  );
  assert.equal(rows.length, 4, 'a file that quietly loses rows is worse than one that says which');
  assert.equal(rows[0].problem, null);
  assert.match(rows[1].problem, /start date/i);
  assert.match(rows[2].problem, /name/i);
  assert.match(rows[3].problem, /same time/i);
});

// ---------------------------------------------------------------------------
// Who and what a line means
// ---------------------------------------------------------------------------

test('a name is matched exactly, by alias, or by two words', () => {
  assert.equal(matchStaff('Henry Aryee', STAFF).staff.id, 1);
  assert.equal(matchStaff('henry aryee', STAFF).how, 'exact');

  // Reordered and lengthened: three words in common.
  assert.equal(matchStaff('Angela Asare Ayima', STAFF).staff.id, 2);
  assert.equal(matchStaff('Angela Asare Ayima', STAFF).how, 'words');

  const aliases = new Map([['chichi ayim', 3]]);
  assert.equal(matchStaff('Chichi Ayim', STAFF, aliases).staff.id, 3);
  assert.equal(matchStaff('Chichi Ayim', STAFF, aliases).how, 'alias');
});

test('one shared first name is never enough', () => {
  // This is the whole point. Emmanuel Twum is a different person, and quietly
  // rostering Emmanuel Ofori Bennie for his shifts is only noticed at payroll.
  const result = matchStaff('Emmanuel Twum', STAFF);
  assert.equal(result.staff, null);
  assert.equal(result.how, 'none');

  // Same reasoning, same answer, even where a human would recognise it.
  assert.equal(matchStaff('Patience Naa Torshie', STAFF).staff, null);
  // Until somebody says so once.
  assert.equal(matchStaff('Patience Naa Torshie', STAFF, new Map([['patience naa torshie', 5]])).staff.id, 5);
});

test('the position breaks a tie between shifts sharing their hours', () => {
  const at8 = { startsAt: '08:00', endsAt: '17:00' };
  assert.equal(matchShift({ ...at8, position: 'SN Craft Shop' }, SHIFTS).shift.name, 'Craft');
  assert.equal(matchShift({ ...at8, position: 'SN Housekeeping' }, SHIFTS).shift.name, 'Housekeeping main');
  assert.equal(matchShift({ ...at8, position: 'SN Maintenance' }, SHIFTS).shift.name, 'Maintenance 1');
  assert.equal(matchShift({ startsAt: '05:00', endsAt: '11:30', position: '' }, SHIFTS).how, 'times');
  assert.equal(matchShift({ startsAt: '05:30', endsAt: '11:30', position: '' }, SHIFTS).shift, null);
});

test('a shift the property does not have is named from the line', () => {
  assert.equal(
    shiftNameFor({ position: 'SN Breakfast', startsAt: '05:30', endsAt: '11:30', title: 'Breakfast Main' }),
    'Breakfast Main 05:30–11:30',
  );
  assert.equal(
    shiftNameFor({ position: 'SN Watchman', startsAt: '17:30', endsAt: '06:30', title: '' }),
    'Watchman 17:30–06:30',
  );
});

// ---------------------------------------------------------------------------
// The plan for a whole file
// ---------------------------------------------------------------------------

const FILE = 'Employee Names,Position,Start Date,End Date,Start Time,End Time,Title,Note\n'
  + '"Henry Aryee","SN Breakfast","Aug 17, 2026","Aug 17, 2026","05:00","11:30","Breakfast Main",""\n'
  + '"Angela Asare Ayima","SN Housekeeping","Aug 17, 2026","Aug 17, 2026","08:00","17:00","",""\n'
  + '"Emmanuel Twum","SN CBS Project","Aug 17, 2026","Aug 17, 2026","08:00","17:00","",""\n'
  + '"Henry Aryee","SN Breakfast","Aug 18, 2026","Aug 18, 2026","05:30","11:30","Breakfast Main",""\n';

const context = { staff: STAFF, shifts: SHIFTS, aliases: new Map(), rosterBy: new Map() };

test('a file is planned without anything being written', () => {
  const plan = planImport(parseRotaCsv(FILE).rows, context);

  assert.equal(plan.from, '2026-08-17');
  assert.equal(plan.to, '2026-08-18');
  assert.equal(plan.counts.roster, 3);
  assert.equal(plan.counts.people, 2);
  assert.equal(plan.counts.skipped, 1, 'the Emmanuel who is not ours');
  assert.equal(plan.counts.newShifts, 1, '05:30 is not a shift this property has');
});

test('an existing rostered day is counted as a replacement, not a surprise', () => {
  const plan = planImport(parseRotaCsv(FILE).rows, {
    ...context,
    rosterBy: new Map([['1|2026-08-17', { shift_id: 11 }]]),
  });
  assert.equal(plan.counts.replacing, 1);
});

test('two lines for one person on one day keep the later and say so', () => {
  const twice = 'Employee Names,Position,Start Date,Start Time,End Time\n'
    + '"Henry Aryee","SN Breakfast","Aug 17, 2026","05:00","11:30"\n'
    + '"Henry Aryee","SN Housekeeping","Aug 17, 2026","08:00","17:00"\n';

  const plan = planImport(parseRotaCsv(twice).rows, context);
  assert.equal(plan.counts.roster, 1);
  assert.equal(plan.rows[0].action, 'skip');
  assert.match(plan.rows[0].problem, /line 3/);
  assert.equal(plan.rows[1].shiftName, 'Housekeeping main');
});
