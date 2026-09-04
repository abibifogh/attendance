import { parseCsv } from './roster-import.js';
import { isAllowanceTotal, readAllowanceHeading } from './pay-import.js';
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

  // Everything else the property already keeps about somebody. The record was
  // only ever fillable one person at a time on a form, which is right for one
  // new starter and hopeless for ninety people whose numbers are sitting in a
  // spreadsheet somebody else typed years ago.
  ['preferredName', ['preferred name', 'known as', 'goes by', 'nickname', 'other name']],
  ['dateOfBirth', ['date of birth', 'birthday', 'born', 'dob', 'birth date']],
  ['gender', ['gender', 'sex']],
  ['otherPhone', ['other phone', 'second phone', 'alt phone', 'alternative phone',
    'other number', 'second number', 'another number']],
  ['address', ['address', 'address line', 'street', 'house address', 'residence']],
  ['town', ['town', 'city', 'suburb', 'area']],
  ['region', ['region', 'state', 'province']],
  ['digitalAddress', ['digital address', 'ghanapost', 'ghanapostgps', 'gps address',
    'ghana post gps', 'gps']],

  // Who to ring when something has happened. The one part of a staff record
  // that is read in a hurry, and the one most often missing.
  ['nextOfKin', ['next of kin', 'emergency contact', 'emergency name', 'kin',
    'in case of emergency']],
  ['nextOfKinPhone', ['next of kin phone', 'emergency phone', 'emergency number',
    'kin phone', 'next of kin number']],
  ['nextOfKinRelation', ['next of kin relationship', 'relationship', 'relation',
    'emergency relationship']],

  // Numbers and accounts. Only written by somebody who could already read
  // them, and refused with a reason to anybody else.
  ['idType', ['id type', 'identification', 'id kind', 'type of id']],
  ['idNumber', ['id number', 'ghana card', 'ghana card number', 'id no', 'identification number',
    'passport number', 'voter id']],
  ['ssnitNumber', ['ssnit number', 'ssnit no', 'social security number']],
  ['tinNumber', ['tin', 'tin number', 'tax number', 'tax identification number']],
  ['payMethod', ['pay method', 'paid by', 'payment method', 'how they are paid']],
  ['bankName', ['bank', 'bank name']],
  ['bankBranch', ['branch', 'bank branch']],
  ['accountName', ['account name', 'name on the account']],
  ['accountNumber', ['account number', 'account no', 'bank account', 'bank account number']],
  ['momoNetwork', ['momo network', 'mobile money network', 'momo provider', 'network']],
  ['momoNumber', ['momo', 'momo number', 'mobile money', 'mobile money number']],
];

/**
 * The fields that live beside the record rather than in it.
 *
 * `att_staff` holds the register; `hr_profile` holds everything about the
 * person. Split out here so the importer can write one row per table rather
 * than a column list per field.
 */
export const PROFILE_COLUMN = {
  preferredName: 'preferred_name',
  dateOfBirth: 'date_of_birth',
  gender: 'gender',
  phone: 'personal_phone',
  otherPhone: 'alt_phone',
  email: 'personal_email',
  address: 'address_line',
  town: 'town',
  region: 'region',
  digitalAddress: 'digital_address',
  idType: 'id_type',
  idNumber: 'id_number',
  ssnitNumber: 'ssnit_number',
  tinNumber: 'tin_number',
  payMethod: 'pay_method',
  bankName: 'bank_name',
  bankBranch: 'bank_branch',
  accountName: 'account_name',
  accountNumber: 'account_number',
  momoNetwork: 'momo_network',
  momoNumber: 'momo_number',
};

/** Next of kin, which is a row of its own because somebody may have two. */
export const KIN_FIELDS = ['nextOfKin', 'nextOfKinPhone', 'nextOfKinRelation'];

/**
 * The columns only somebody who can already read them may write.
 *
 * An import shows what it would change, from and to, so a sheet that could set
 * a bank account would also show the one that is there to whoever opened it.
 * That is the whole of the reason this list exists: reading and writing are
 * the same permission here because the preview makes them the same act.
 */
export const SENSITIVE = new Set([
  'idType', 'idNumber', 'ssnitNumber', 'tinNumber',
  'payMethod', 'bankName', 'bankBranch', 'accountName', 'accountNumber',
  'momoNetwork', 'momoNumber',
]);

export function readColumns(header) {
  const known = new Map();
  for (const [kind, words] of HEADINGS) {
    for (const word of words) known.set(word, kind);
  }

  const columns = [];
  const unknown = [];
  const taken = new Set();
  const allowances = new Set();

  header.forEach((raw, index) => {
    const key = norm(raw);
    if (!key) return;

    // "Allowance: Transport", the same words the payroll sheet uses. Written
    // out like that rather than as a bare name, so a column nobody recognises
    // can never quietly turn into money on a payslip.
    // A column of allowances added up. The month sheet checks one against the
    // columns beside it; here there is nothing to check it against and no way
    // to split it, and reading it as an allowance would put a payslip line
    // called Total in front of everybody.
    if (isAllowanceTotal(raw)) {
      unknown.push(text(raw));
      return;
    }

    const allowance = readAllowanceHeading(raw);
    if (allowance) {
      if (allowances.has(norm(allowance.name))) {
        unknown.push(text(raw));
        return;
      }
      allowances.add(norm(allowance.name));
      columns.push({
        index, kind: 'allowance', name: allowance.name, taxable: allowance.taxable,
      });
      return;
    }

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
  preferredName: 'Known as',
  dateOfBirth: 'Date of birth',
  gender: 'Gender',
  otherPhone: 'Other phone',
  address: 'Address',
  town: 'Town',
  region: 'Region',
  digitalAddress: 'Digital address',
  nextOfKin: 'Next of kin',
  nextOfKinPhone: 'Next of kin phone',
  nextOfKinRelation: 'Next of kin relationship',
  idType: 'ID type',
  idNumber: 'ID number',
  ssnitNumber: 'SSNIT number',
  tinNumber: 'TIN',
  payMethod: 'Pay method',
  bankName: 'Bank',
  bankBranch: 'Branch',
  accountName: 'Account name',
  accountNumber: 'Account number',
  momoNetwork: 'MoMo network',
  momoNumber: 'MoMo number',
};

const TRACKING_SAID = {
  full: 'the rota and attendance',
  'no-rota': 'attendance, never rostered',
  payroll: 'payroll only',
};

/** What somebody's record currently says, in the shape a cell would set. */
function standing(person, profile, pay, allowances = [], kin = null) {
  if (!person) return { allowanceBy: new Map() };
  return {
    allowanceBy: new Map(allowances.map((a) => [norm(a.name), a])),
    name: person.name ?? null,
    department: person.department ?? null,
    jobTitle: person.job_title ?? null,
    hiredOn: person.hired_on ?? null,
    leftOn: person.left_on ?? null,
    leaveDays: person.leave_days ?? null,
    daysPerWeek: person.days_per_week ?? null,
    tracking: person.on_clock === 0 ? 'payroll' : (person.on_rota === 0 ? 'no-rota' : 'full'),
    basic: pay ? Number(pay.basic) : null,
    ssnit: pay ? pay.ssnit !== 0 : null,
    note: person.note ?? null,
    // Everything that lives on the profile, read straight off the column it
    // came from so there is one list of them rather than two that drift.
    ...Object.fromEntries(
      Object.entries(PROFILE_COLUMN).map(([kind, column]) => [kind, profile?.[column] ?? null]),
    ),
    nextOfKin: kin?.name ?? null,
    nextOfKinPhone: kin?.phone ?? null,
    nextOfKinRelation: kin?.relationship ?? null,
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
export function readStaffSheet(sheet, {
  staff = [], profiles = new Map(), pay = new Map(), allowanceBy = new Map(),
  kinBy = new Map(), sensitive = false,
} = {}) {
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

  // A name column is wanted only where the sheet would create somebody. A
  // property sending back two columns of phone numbers for people already on
  // file has no reason to carry their names as well, and insisting on it made
  // the ordinary use of this, filling in details, the awkward one.
  const hasName = columns.some((c) => c.kind === 'name');
  let strangers = 0;

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
      strangers += 1;
      skipped.push({
        at,
        employeeNo,
        name,
        why: hasName
          ? 'nobody of that number here, and no name to add'
          : 'nobody of that number here, and the sheet has no name column to add one from',
      });
      return;
    }

    const now = standing(
      person, profiles.get(person?.id), pay.get(person?.id), allowanceBy.get(person?.id) ?? [],
      kinBy.get(person?.id),
    );
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

      if (kind === 'allowance') {
        const amount = readNumber(cell);
        if (Number.isNaN(amount) || amount < 0) {
          line.notes.push({ what: col.name, why: `“${text(cell)}” is not a figure` });
          continue;
        }
        const held = now.allowanceBy.get(norm(col.name));
        const was = held ? Number(held.amount) : null;
        const wasTaxable = held ? held.taxable !== 0 : null;
        if (was !== null && Math.abs(was - amount) < 0.005 && wasTaxable === col.taxable) continue;

        line.changes.push({
          kind: 'allowance',
          name: col.name,
          label: `${col.name} allowance`,
          from: was === null ? null : was.toFixed(2),
          to: amount.toFixed(2) + (col.taxable ? '' : ', not taxed'),
          value: { amount, taxable: col.taxable },
        });
        continue;
      }

      // A column somebody may not write is not silently dropped. Left unsaid,
      // a sheet with a bank column in it would import looking as if it had
      // worked and leave the accounts empty.
      if (SENSITIVE.has(kind) && !sensitive) {
        line.notes.push({
          what: LABELS[kind],
          why: 'only somebody who can manage employee records may set this',
        });
        continue;
      }

      let value;
      if (kind === 'hiredOn' || kind === 'leftOn' || kind === 'dateOfBirth') value = readDate(cell);
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

  if (strangers && !hasName) {
    missingColumns.push(
      `a name column, for the ${strangers} number${strangers === 1 ? '' : 's'} on it that `
      + 'nobody here has',
    );
  }

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
