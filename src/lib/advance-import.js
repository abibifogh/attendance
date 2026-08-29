import { parseCsv } from './roster-import.js';
import { readDate, readNumber } from './staff-import.js';
import { PURPOSES, instalmentFor, purposeOf } from './advances.js';
import { round2 } from './tax.js';

/**
 * Salary advances, out of a spreadsheet.
 *
 * A property arriving with eleven advances already running has them on a sheet
 * somewhere, and typing them into a dialog one at a time is both an afternoon
 * and eleven chances to mistype a balance. Everything here is pure: given the
 * text of a file and what the property already holds, it says what each line
 * would do without touching anything.
 *
 * IT CREATES NOBODY. A staff number the register does not know is reported and
 * skipped, the same as every other import but the staff one. An advance is
 * money against a person who works here; a file that could invent the person
 * as well is a file nobody should run.
 *
 * AND IT NEVER RECORDS THE SAME ADVANCE TWICE. One person, one amount, one
 * date is taken to be the same advance, so a sheet run again after a correction
 * adds what is new and leaves the rest alone. Without that, the second run of
 * a twelve-line file doubles everybody's deductions and nobody notices until
 * payday.
 */

const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const text = (value) => String(value ?? '').trim();
const cleanNo = (value) => text(value).replace(/\.0$/, '');

const HEADINGS = [
  ['employeeNo', ['employee no', 'employee number', 'employee no.', 'staff no', 'staff number',
    'staff id', 'no', 'id', 'emp no']],
  ['name', ['name', 'employee', 'employee name', 'staff', 'staff name']],
  ['amount', ['amount', 'advance', 'advance amount', 'principal', 'sum', 'given']],
  ['months', ['months', 'over', 'months to repay', 'repay over', 'term', 'instalments']],
  ['monthly', ['monthly', 'a month', 'monthly deduction', 'instalment', 'deduction',
    'per month']],
  ['takenOn', ['taken on', 'date', 'date taken', 'given on', 'date given', 'issued']],
  ['startMonth', ['starts', 'start month', 'first month', 'from', 'repay from', 'starting']],
  ['purpose', ['purpose', 'kind', 'type']],
  ['reason', ['what it is for', 'reason', 'note', 'notes', 'detail', 'remark']],
  ['repaid', ['already repaid', 'repaid', 'paid back', 'paid so far', 'recovered',
    'already paid']],
];

export function readColumns(header) {
  const known = new Map();
  for (const [kind, words] of HEADINGS) {
    for (const word of words) known.set(word, kind);
  }

  const columns = [];
  const unknown = [];
  const taken = new Set();

  header.forEach((raw, index) => {
    const key = norm(raw);
    if (!key) return;
    const kind = known.get(key);
    if (!kind || taken.has(kind)) {
      unknown.push(text(raw));
      return;
    }
    taken.add(kind);
    columns.push({ index, kind });
  });

  return { columns, unknown };
}

/** A month out of a cell: 2026-04, 04/2026, or April 2026. */
export function readMonth(value) {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}$/.test(raw)) {
    const n = Number(raw.slice(5));
    return n >= 1 && n <= 12 ? raw : NaN;
  }
  const slashed = /^(\d{1,2})[/.-](\d{4})$/.exec(raw);
  if (slashed) {
    const n = Number(slashed[1]);
    return n >= 1 && n <= 12 ? `${slashed[2]}-${String(n).padStart(2, '0')}` : NaN;
  }
  // "April 2026", and the day-bearing forms a date column would hold.
  const day = readDate(raw);
  if (day && !Number.isNaN(day)) return String(day).slice(0, 7);
  const spelled = new Date(`1 ${raw} UTC`);
  if (!Number.isNaN(spelled.getTime())) return spelled.toISOString().slice(0, 7);
  return NaN;
}

/** Which of the property's purposes a cell names. */
export function readPurpose(value) {
  const key = norm(value);
  if (!key) return null;
  const found = PURPOSES.find((p) => p.key === key || norm(p.label) === key);
  if (found) return found.key;
  if (['other', 'something else', 'emergency', 'misc'].includes(key)) return 'other';
  return NaN;
}

/**
 * What the file would do.
 *
 * One entry per line, saying who it is for and what the advance would be, plus
 * the lines nothing can be done with. Nothing is written; the caller decides.
 */
export function readAdvanceSheet(sheet, { staff = [], open = [], today = null } = {}) {
  const rows = parseCsv(sheet);
  if (!rows.length) {
    return { columns: [], unknown: [], lines: [], skipped: [], missingColumns: ['a header row'] };
  }

  const [header, ...body] = rows;
  const { columns, unknown } = readColumns(header);

  const byNo = new Map(staff.map((s) => [cleanNo(s.employee_no), s]));
  // One person, one amount, one date is the same advance. Both what the
  // property already holds and what earlier lines of this file would add, so a
  // sheet with a line duplicated inside it is caught as well.
  const already = new Set(open.map((a) => `${a.staff_id}|${round2(a.amount)}|${a.taken_on ?? ''}`));

  const missingColumns = [];
  if (!columns.some((c) => c.kind === 'employeeNo')) missingColumns.push('an employee number column');
  if (!columns.some((c) => c.kind === 'amount')) missingColumns.push('an amount column');

  const lines = [];
  const skipped = [];

  body.forEach((cells, i) => {
    const at = i + 2; // The line number in the file, header counted.
    const cellOf = (kind) => {
      const col = columns.find((c) => c.kind === kind);
      return col ? cells[col.index] : undefined;
    };

    const employeeNo = cleanNo(cellOf('employeeNo'));
    const said = text(cellOf('name'));
    if (!employeeNo && !said && text(cellOf('amount')) === '') return;

    const person = employeeNo ? byNo.get(employeeNo) : null;
    if (!person) {
      skipped.push({ at, employeeNo, name: said, why: 'nobody of that number here' });
      return;
    }
    if (!person.active) {
      skipped.push({ at, employeeNo, name: person.name, why: 'no longer here' });
      return;
    }

    const amount = readNumber(cellOf('amount'));
    if (amount === null || Number.isNaN(amount) || amount <= 0) {
      skipped.push({ at, employeeNo, name: person.name, why: 'no amount, or not a figure' });
      return;
    }

    const problems = [];
    const takenOn = (() => {
      const value = readDate(cellOf('takenOn'));
      if (value === null) return today;
      if (Number.isNaN(value)) {
        problems.push({ what: 'Taken on', why: `“${text(cellOf('takenOn'))}” could not be read` });
        return today;
      }
      return value;
    })();

    const startMonth = (() => {
      const value = readMonth(cellOf('startMonth'));
      if (value === null) return String(takenOn ?? '').slice(0, 7) || null;
      if (Number.isNaN(value)) {
        problems.push({ what: 'Starts', why: `“${text(cellOf('startMonth'))}” is not a month` });
        return String(takenOn ?? '').slice(0, 7) || null;
      }
      return value;
    })();

    const purpose = (() => {
      const value = readPurpose(cellOf('purpose'));
      if (value === null) return null;
      if (Number.isNaN(value)) {
        problems.push({
          what: 'Purpose',
          why: `“${text(cellOf('purpose'))}” is not one of ${PURPOSES.map((p) => p.label).join(', ')}`,
        });
        return null;
      }
      return value;
    })();

    const months = (() => {
      const value = readNumber(cellOf('months'));
      if (value === null) return purposeOf(purpose)?.months ?? 1;
      if (Number.isNaN(value) || value < 1 || value > 60) {
        problems.push({ what: 'Months', why: 'has to be between 1 and 60' });
        return purposeOf(purpose)?.months ?? 1;
      }
      return Math.round(value);
    })();

    const monthly = (() => {
      const value = readNumber(cellOf('monthly'));
      if (value === null) return instalmentFor(round2(amount), months);
      if (Number.isNaN(value) || value <= 0) {
        problems.push({ what: 'Monthly', why: 'not a figure' });
        return instalmentFor(round2(amount), months);
      }
      return round2(value);
    })();

    const repaid = (() => {
      const value = readNumber(cellOf('repaid'));
      if (value === null) return 0;
      if (Number.isNaN(value) || value < 0) {
        problems.push({ what: 'Already repaid', why: 'not a figure' });
        return 0;
      }
      if (round2(value) > round2(amount)) {
        problems.push({ what: 'Already repaid', why: 'more than the advance itself' });
        return 0;
      }
      return round2(value);
    })();

    const key = `${person.id}|${round2(amount)}|${takenOn ?? ''}`;
    if (already.has(key)) {
      skipped.push({
        at, employeeNo, name: person.name, why: 'already on the books, to the pesewa and the day',
      });
      return;
    }
    already.add(key);

    lines.push({
      at,
      staffId: person.id,
      employeeNo: person.employee_no,
      name: person.name,
      amount: round2(amount),
      months,
      monthly,
      takenOn,
      startMonth,
      purpose,
      reason: text(cellOf('reason')) || null,
      repaid,
      // What is actually left to take, which is the figure the payroll will
      // work from and the one somebody checking the sheet wants to see.
      outstanding: round2(round2(amount) - repaid),
      notes: problems,
    });
  });

  return { columns, unknown, lines, skipped, missingColumns };
}

/** What a run of the file comes to, for the sentence above the button. */
export function tallyOf(read) {
  return {
    adding: read.lines.length,
    money: round2(read.lines.reduce((n, l) => n + l.amount, 0)),
    outstanding: round2(read.lines.reduce((n, l) => n + l.outstanding, 0)),
    notes: read.lines.reduce((n, l) => n + l.notes.length, 0),
    skipped: read.skipped.length,
    nothing: read.lines.length === 0,
  };
}
