import { parseCsv } from './roster-import.js';
import { isDay } from '../util/dates.js';

/**
 * The staff register, out of a spreadsheet.
 *
 * Everything here is pure: given the text of a file and who the property
 * already knows, it says what each line would do without touching anything.
 *
 * THIS ONE ADDS PEOPLE, AND IT IS THE ONLY IMPORT THAT DOES. Every other
 * importer in the app refuses a name it has not seen, on the grounds that a
 * rota or a payroll sheet is about people somebody already decided to employ,
 * and a file that can quietly invent one eventually does. That reasoning does
 * not hold here, because inventing people is the entire job: this is how a
 * property that has been running on a spreadsheet for six years gets its
 * register in without typing ninety names.
 *
 * So the safeguard is somewhere else. Every line is worked out and shown
 * first — who would be added, who would change and what about them — and
 * nothing at all is written until somebody has read that and pressed the
 * button.
 *
 * A BLANK CELL LEAVES WHAT IS THERE ALONE. It is not an instruction to clear a
 * department or a start date. Somebody sending back a sheet with two columns
 * filled in means to set two things, not to wipe the rest.
 */

const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Employee number, however a spreadsheet decided to mangle it. */
export const cleanNo = (value) => String(value ?? '').trim().replace(/\.0$/, '');

const text = (value) => String(value ?? '').trim();

/**
 * A date out of a cell.
 *
 * Spreadsheets hand back whatever the person's locale felt like, so all four
 * of the ways a start date actually arrives are read: 2020-01-06, 06/01/2020,
 * 6 Jan 2020, and the serial number Excel writes when a column was formatted
 * as a date and then exported as text.
 */
export function readDate(value) {
  const raw = text(value);
  if (!raw) return null;

  if (isDay(raw)) return raw;

  // Excel's own count of days since 1899-12-30. Only in the range a working
  // life could be, so a plain number that means something else is refused
  // rather than turned into 1907.
  if (/^\d{5}$/.test(raw)) {
    const serial = Number(raw);
    if (serial >= 20000 && serial <= 60000) {
      const at = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
      return at.toISOString().slice(0, 10);
    }
    return NaN;
  }

  const slashed = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(raw);
  if (slashed) {
    const [, a, b, year] = slashed;
    // Day first. It is how the whole property writes a date, and the one case
    // that would be ambiguous is settled by the only convention in use here.
    const day = Number(a);
    const month = Number(b);
    if (month < 1 || month > 12 || day < 1 || day > 31) return NaN;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const spelled = new Date(`${raw} UTC`);
  if (!Number.isNaN(spelled.getTime())) {
    const iso = spelled.toISOString().slice(0, 10);
    if (isDay(iso)) return iso;
  }

  return NaN;
}

/** A plain number out of a cell. Null for an empty one, NaN for nonsense. */
export function readNumber(value) {
  const raw = text(value).replace(/[^\d.-]/g, '');
  if (!text(value)) return null;
  if (!raw || raw === '-' || raw === '.') return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Yes or no out of a cell, in the words people actually type.
 *
 * Null for a blank one, because a column somebody left alone must not read as
 * a no.
 */
export function readYesNo(value) {
  const key = norm(value);
  if (!key) return null;
  if (['yes', 'y', 'true', '1', 'on', 'x', '✓', 'tick'].includes(key)) return true;
  if (['no', 'n', 'false', '0', 'off', '-'].includes(key)) return false;
  return NaN;
}

/** What somebody is here for, in whatever words the sheet used. */
export function readTracking(value) {
  const key = norm(value);
  if (!key) return null;
  if (['payroll', 'payroll only', 'pay only', 'paid only', 'payroll-only'].includes(key)) {
    return 'payroll';
  }
  if ([
    'no rota', 'not on rota', 'not on the rota', 'never rostered', 'off rota', 'no-rota',
    'attendance only', 'attendance',
  ].includes(key)) {
    return 'no-rota';
  }
  if (['rota', 'rota and attendance', 'both', 'full', 'normal', 'yes'].includes(key)) {
    return 'full';
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * What the sheet's columns mean.
 *
 * Matched on the words a property actually puts at the top of a staff list
 * rather than on position, so a column moved or a column missing changes
 * nothing. Anything unrecognised is named back rather than silently dropped,
 * because a heading nobody read is how a whole column of phone numbers goes
 * missing without anybody noticing.
 */
const HEADINGS = [
  ['employeeNo', ['employee no', 'employee number', 'employee no.', 'staff no', 'staff number',
    'staff id', 'no', 'id', 'emp no', 'employee id']],
  ['name', ['name', 'full name', 'employee', 'employee name', 'staff', 'staff name']],
  ['department', ['department', 'dept', 'section', 'unit']],
  ['jobTitle', ['job title', 'title', 'position', 'role', 'designation', 'job']],
  ['hiredOn', ['started', 'start date', 'hired', 'hired on', 'date employed', 'date of employment',
    'employment date', 'joined']],
  ['leftOn', ['left', 'left on', 'leaving date', 'date left', 'exit date', 'end date']],
  ['leaveDays', ['annual leave days', 'leave days', 'leave entitlement', 'annual leave']],
  ['daysPerWeek', ['days a week', 'days per week', 'working days', 'days']],
  ['tracking', ['here for', 'what they are here for', 'kind', 'type', 'on the rota', 'rota']],
  ['phone', ['phone', 'mobile', 'phone number', 'mobile number', 'telephone', 'contact',
    'contact number']],
  ['email', ['email', 'e-mail', 'email address']],
  ['basic', ['basic', 'basic salary', 'salary', 'monthly salary', 'gross', 'basic pay']],
  ['ssnit', ['ssnit', 'on ssnit', 'ssnit member']],
  ['note', ['note', 'notes', 'remark', 'remarks', 'comment']],
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
    // Only the first column of a kind counts. A sheet with Name twice is a
    // sheet somebody pasted badly, and reading both would have the second
    // silently overrule the first.
    if (!kind || taken.has(kind)) {
      unknown.push(text(raw));
      return;
    }
    taken.add(kind);
    columns.push({ index, kind });
  });

  return { columns, unknown };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const LABELS = {
  name: 'Name',
  department: 'Department',
  jobTitle: 'Job title',
  hiredOn: 'Started',
  leftOn: 'Left',
  leaveDays: 'Annual leave days',
  daysPerWeek: 'Days a week',
  tracking: 'Here for',
  phone: 'Phone',
  email: 'Email',
  basic: 'Basic salary',
  ssnit: 'SSNIT',
  note: 'Note',
};

const TRACKING_SAID = {
  full: 'the rota and attendance',
  'no-rota': 'attendance, never rostered',
  payroll: 'payroll only',
};

/** What somebody's record currently says, in the shape a cell would set. */
function standing(person, profile, pay) {
  if (!person) return {};
  return {
    name: person.name ?? null,
    department: person.department ?? null,
    jobTitle: person.job_title ?? null,
    hiredOn: person.hired_on ?? null,
    leftOn: person.left_on ?? null,
    leaveDays: person.leave_days ?? null,
    daysPerWeek: person.days_per_week ?? null,
    tracking: person.on_clock === 0 ? 'payroll' : (person.on_rota === 0 ? 'no-rota' : 'full'),
    phone: profile?.personal_phone ?? null,
    email: profile?.personal_email ?? null,
    basic: pay ? Number(pay.basic) : null,
    ssnit: pay ? pay.ssnit !== 0 : null,
    note: person.note ?? null,
  };
}

const said = (kind, value) => {
  if (value === null || value === undefined || value === '') return null;
  if (kind === 'tracking') return TRACKING_SAID[value] ?? String(value);
  if (kind === 'ssnit') return value ? 'yes' : 'no';
  if (kind === 'basic') return Number(value).toFixed(2);
  return String(value);
};

/**
 * What the file would do.
 *
 * One entry per line of the sheet, saying whether it would add somebody or
 * change them and exactly what about them, plus the lines nothing could be
 * done with. Nothing is written; the caller decides whether to.
 */
export function readStaffSheet(sheet, { staff = [], profiles = new Map(), pay = new Map() } = {}) {
  const rows = parseCsv(sheet);
  if (!rows.length) {
    return {
      columns: [], unknown: [], lines: [], skipped: [], missingColumns: ['a header row'],
    };
  }

  const [header, ...body] = rows;
  const { columns, unknown } = readColumns(header);

  const byNo = new Map(staff.map((s) => [cleanNo(s.employee_no), s]));

  const missingColumns = [];
  if (!columns.some((c) => c.kind === 'employeeNo')) {
    missingColumns.push('an employee number column');
  }
  if (!columns.some((c) => c.kind === 'name')) missingColumns.push('a name column');

  const lines = [];
  const skipped = [];
  const seen = new Set();

  body.forEach((cells, i) => {
    const at = i + 2; // The line number in the file, header counted.
    const cellOf = (kind) => {
      const col = columns.find((c) => c.kind === kind);
      return col ? cells[col.index] : undefined;
    };

    const employeeNo = cleanNo(cellOf('employeeNo'));
    const name = text(cellOf('name'));
    if (!employeeNo && !name) return;

    if (!employeeNo) {
      skipped.push({ at, employeeNo, name, why: 'no employee number' });
      return;
    }
    if (seen.has(employeeNo)) {
      skipped.push({ at, employeeNo, name, why: `${employeeNo} is on an earlier line too` });
      return;
    }
    seen.add(employeeNo);

    const person = byNo.get(employeeNo) ?? null;
    if (!person && !name) {
      skipped.push({ at, employeeNo, name, why: 'nobody of that number here, and no name to add' });
      return;
    }

    const now = standing(person, profiles.get(person?.id), pay.get(person?.id));
    const line = {
      at,
      staffId: person?.id ?? null,
      employeeNo,
      name: name || person?.name || employeeNo,
      adding: !person,
      changes: [],
      notes: [],
    };

    for (const col of columns) {
      const { kind } = col;
      if (kind === 'employeeNo') continue;
      const cell = cells[col.index];
      if (text(cell) === '') continue;

      let value;
      if (kind === 'hiredOn' || kind === 'leftOn') value = readDate(cell);
      else if (kind === 'leaveDays' || kind === 'daysPerWeek' || kind === 'basic') {
        value = readNumber(cell);
      } else if (kind === 'ssnit') value = readYesNo(cell);
      else if (kind === 'tracking') value = readTracking(cell);
      else value = text(cell);

      if (Number.isNaN(value)) {
        line.notes.push({ what: LABELS[kind], why: `“${text(cell)}” could not be read` });
        continue;
      }
      if (kind === 'daysPerWeek' && (value < 0.5 || value > 7)) {
        line.notes.push({ what: LABELS[kind], why: 'a week has seven days' });
        continue;
      }
      if ((kind === 'leaveDays' || kind === 'basic') && value < 0) {
        line.notes.push({ what: LABELS[kind], why: 'cannot be less than nothing' });
        continue;
      }

      const from = now[kind] ?? null;
      const same = kind === 'basic'
        ? from !== null && Math.abs(Number(from) - value) < 0.005
        : String(from ?? '') === String(value ?? '');
      if (same) continue;

      line.changes.push({
        kind, label: LABELS[kind], from: said(kind, from), to: said(kind, value), value,
      });
    }

    // Somebody being added is a change in itself, even where every other cell
    // is blank. Without this an all-but-empty line reads as "nothing to do"
    // and the person is quietly never created.
    if (line.adding || line.changes.length || line.notes.length) lines.push(line);
  });

  return { columns, unknown, lines, skipped, missingColumns };
}

/** What a run of the file comes to, for the sentence above the Import button. */
export function tallyOf(read) {
  const adding = read.lines.filter((l) => l.adding).length;
  const changing = read.lines.filter((l) => !l.adding && l.changes.length).length;
  // Only what would change about somebody already here. Counting the cells of
  // a person being added among them turns "three new people" into "three
  // people and nineteen changes", which reads as far more happening than is.
  const changes = read.lines
    .filter((l) => !l.adding)
    .reduce((n, l) => n + l.changes.length, 0);
  return {
    adding,
    changing,
    changes,
    notes: read.lines.reduce((n, l) => n + l.notes.length, 0),
    skipped: read.skipped.length,
    // Nothing worth pressing a button for. Said as one number so the screen
    // does not have to work it out again and reach a different answer.
    nothing: adding === 0 && changes === 0,
  };
}
