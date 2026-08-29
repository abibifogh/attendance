import { parseCsv } from './roster-import.js';
import { round2 } from './tax.js';

/**
 * A month's payroll input, read out of a spreadsheet.
 *
 * Everything here is pure. Given the text of a file and what the property
 * already has, it says what each line would do without touching anything,
 * because an import that writes first and reports afterwards is one nobody
 * dares run twice.
 *
 * IT CREATES NOTHING. Not a person, not a scheme, not an advance. A name the
 * register does not know is reported and skipped; a column that is not one of
 * the property's own allowances or schemes is reported and ignored. The whole
 * point of a payroll sheet is that the property already decided who is on it,
 * and a file that could quietly add somebody is a file that eventually does.
 *
 * THE COLUMNS ARE THE PROPERTY'S OWN WORDS. Allowance columns are named after
 * the allowances in use; a score column is named after the scheme. Nobody has
 * to learn a format: they download this month's sheet, change the figures that
 * changed, and send it back.
 */

const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Employee number, however a spreadsheet decided to mangle it. */
const cleanNo = (value) => String(value ?? '').trim().replace(/\.0$/, '');

/**
 * A figure out of a cell.
 *
 * Blank is not zero: a column somebody left alone must not wipe what is
 * already there, and the difference between "nothing" and "nought" is the
 * difference between leaving an allowance alone and taking it away. Null means
 * the cell was empty.
 */
export function readMoney(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  // Currency marks, thousands separators, and the brackets accountants use for
  // a negative. All of them turn up in a sheet that has been round a finance
  // office.
  const negative = /^\(.*\)$/.test(raw);
  const bare = raw.replace(/^\(|\)$/g, '').replace(/[^\d.-]/g, '');
  if (!bare || bare === '-' || bare === '.') return NaN;
  const n = Number(bare);
  if (!Number.isFinite(n)) return NaN;
  return round2(negative ? -n : n);
}

/** A score out of a cell. Percentages, with or without the sign. */
export function readScore(value) {
  const n = readMoney(String(value ?? '').replace('%', ''));
  return n;
}

/**
 * An allowance column, read out of its heading.
 *
 * `Allowance: Transport` names one. The prefix is what makes it safe to accept
 * a name the property has never used: a stray column called Transport stays
 * unknown and is reported, but a heading that says outright what it is can
 * introduce the allowance. Nothing about a person is invented either way — an
 * allowance is a label on a line of a payslip, not somebody's employment.
 *
 * Taxability rides in brackets: `Allowance: Transport (not taxable)`. Taxable
 * is the default, because most of them are and getting it wrong the other way
 * understates the tax.
 */
export function readAllowanceHeading(raw) {
  const text = String(raw ?? '').trim();
  const found = /^(?:allowance)\s*[:\-]\s*(.+)$/i.exec(text);
  if (!found) return null;

  let name = found[1].trim();
  let taxable = true;

  const bracket = /\(([^)]*)\)\s*$/.exec(name);
  if (bracket) {
    const said = norm(bracket[1]);
    if (['not taxable', 'tax free', 'non taxable', 'untaxed', 'exempt'].includes(said)) {
      taxable = false;
      name = name.slice(0, bracket.index).trim();
    } else if (['taxable', 'taxed'].includes(said)) {
      name = name.slice(0, bracket.index).trim();
    }
  }

  return name ? { name, taxable } : null;
}

/**
 * What the sheet's columns mean.
 *
 * Matched on the property's own words rather than on position, so a column
 * moved or a column removed changes nothing. Anything unrecognised is named
 * back rather than silently dropped.
 */
export function readColumns(header, { allowances = [], schemes = [] } = {}) {
  const byAllowance = new Map(allowances.map((name) => [norm(name), name]));
  const byScheme = new Map(schemes.map((s) => [norm(s.name), s]));

  const columns = [];
  const unknown = [];

  header.forEach((raw, index) => {
    const key = norm(raw);
    if (!key) return;

    if (['employee no', 'employee number', 'employee no.', 'staff no', 'no'].includes(key)) {
      columns.push({ index, kind: 'employeeNo' });
      return;
    }
    if (['name', 'employee', 'employee name', 'staff'].includes(key)) {
      columns.push({ index, kind: 'name' });
      return;
    }
    if (['basic', 'basic salary', 'salary'].includes(key)) {
      columns.push({ index, kind: 'basic' });
      return;
    }
    if (['advance', 'advance due', 'advance deduction', 'advances'].includes(key)) {
      columns.push({ index, kind: 'advance' });
      return;
    }

    // "Score: Front of house" is how the template writes a scheme, because a
    // scheme called Transport and an allowance called Transport are two
    // different columns and a bare name could not tell them apart.
    //
    // The word is not what decides how the cell is read. A scheme that pays a
    // set figure holds money and one that is scored holds a percentage, and
    // the scheme itself knows which it is — so somebody who writes Score above
    // a column of amounts gets what they meant rather than a refusal.
    const scored = key.match(/^(?:score|bonus|amount)\s*[:\-]\s*(.+)$/);
    if (scored && byScheme.has(norm(scored[1]))) {
      columns.push({ index, kind: 'score', scheme: byScheme.get(norm(scored[1])) });
      return;
    }
    const allowance = readAllowanceHeading(raw);
    const allowanceName = allowance ? norm(allowance.name) : key;
    if (byAllowance.has(allowanceName)) {
      columns.push({
        index,
        kind: 'allowance',
        name: byAllowance.get(allowanceName),
        // A heading that says taxable or not overrules what the existing rows
        // hold, because somebody wrote it down on purpose.
        taxable: allowance ? allowance.taxable : null,
      });
      return;
    }

    // Named as an allowance, and one the property has not used before. The
    // prefix is the whole safeguard: a bare column heading can never turn into
    // an allowance by accident.
    if (allowance) {
      columns.push({
        index, kind: 'allowance', name: allowance.name, taxable: allowance.taxable, isNew: true,
      });
      return;
    }

    unknown.push(String(raw).trim());
  });

  return { columns, unknown };
}

/**
 * What the file would do.
 *
 * A row per line of the sheet, each saying which person it matched and what
 * would change about them, plus the lines that matched nobody. Nothing is
 * written; the caller decides whether to.
 */
export function readSheet(text, {
  staff = [], allowances = [], schemes = [], profiles = new Map(),
  allowanceBy = new Map(), scoreBy = new Map(), awardBy = new Map(),
  memberOf = new Map(), advanceDue = new Map(),
} = {}) {
  const rows = parseCsv(text);
  if (!rows.length) {
    return { columns: [], unknown: [], lines: [], skipped: [], missingColumns: ['a header row'] };
  }

  const [header, ...body] = rows;
  const { columns, unknown } = readColumns(header, { allowances, schemes });

  const byNo = new Map(staff.map((s) => [cleanNo(s.employee_no), s]));
  const byName = new Map(staff.map((s) => [norm(s.name), s]));

  const hasNo = columns.some((c) => c.kind === 'employeeNo');
  const hasName = columns.some((c) => c.kind === 'name');
  const missingColumns = [];
  if (!hasNo && !hasName) missingColumns.push('an employee number or a name');

  const lines = [];
  const skipped = [];

  body.forEach((cells, i) => {
    const at = i + 2; // The line number in the file, header counted.
    const get = (kind) => {
      const col = columns.find((c) => c.kind === kind);
      return col ? cells[col.index] : undefined;
    };

    const employeeNo = cleanNo(get('employeeNo'));
    const name = String(get('name') ?? '').trim();
    const person = (employeeNo && byNo.get(employeeNo)) || (name && byName.get(norm(name))) || null;

    if (!person) {
      if (employeeNo || name) skipped.push({ at, employeeNo, name, why: 'nobody of that name or number' });
      return;
    }
    if (!person.active) {
      skipped.push({ at, employeeNo, name: person.name, why: 'no longer here' });
      return;
    }

    const line = {
      at,
      staffId: person.id,
      name: person.name,
      employeeNo: person.employee_no,
      changes: [],
      notes: [],
    };

    for (const col of columns) {
      const cell = cells[col.index];

      if (col.kind === 'basic') {
        const value = readMoney(cell);
        if (value === null) continue;
        if (Number.isNaN(value) || value < 0) {
          line.notes.push({ what: 'Basic', why: 'not a figure' });
          continue;
        }
        const now = profiles.get(person.id)?.basic;
        if (now == null) {
          // Somebody the property has not put on the payroll. Setting a basic
          // from a spreadsheet is putting them on it, which is a decision.
          line.notes.push({ what: 'Basic', why: 'not on the payroll yet' });
          continue;
        }
        if (round2(now) !== value) {
          line.changes.push({ kind: 'basic', label: 'Basic', from: round2(now), to: value });
        }
        continue;
      }

      if (col.kind === 'allowance') {
        const value = readMoney(cell);
        if (value === null) continue;
        if (Number.isNaN(value) || value < 0) {
          line.notes.push({ what: col.name, why: 'not a figure' });
          continue;
        }
        // An allowance on somebody with no basic never reaches a payslip, so
        // setting one would look like it worked and do nothing.
        if (profiles.get(person.id)?.basic == null) {
          line.notes.push({ what: col.name, why: 'not on the payroll yet' });
          continue;
        }

        const now = (allowanceBy.get(person.id) ?? [])
          .find((a) => norm(a.name) === norm(col.name));
        const from = now ? round2(now.amount) : null;
        // The heading wins where it said so, then whatever the person already
        // has, then taxable — which is what most of them are.
        const taxable = col.taxable == null ? (now ? now.taxable !== 0 : true) : col.taxable;

        if (from !== value || (now && (now.taxable !== 0) !== taxable)) {
          line.changes.push({
            kind: 'allowance', name: col.name, label: col.name, from, to: value, taxable,
            // Only where it is one, because introducing an allowance is a
            // bigger thing than changing a figure in one and the screen says so.
            ...(col.isNew ? { isNew: true } : {}),
          });
          if (col.isNew && value > 0) {
            line.notes.push({ what: col.name, why: 'an allowance the property has not used before' });
          }
        }
        continue;
      }

      if (col.kind === 'score') {
        const paysAmount = col.scheme.kind === 'amount';
        const value = paysAmount ? readMoney(cell) : readScore(cell);
        if (value === null) continue;

        if (Number.isNaN(value) || value < 0 || (!paysAmount && value > 100)) {
          line.notes.push({
            what: col.scheme.name,
            why: paysAmount ? 'not a figure' : 'a score is 0 to 100',
          });
          continue;
        }
        if (!(memberOf.get(person.id) ?? []).includes(col.scheme.id)) {
          line.notes.push({ what: col.scheme.name, why: 'not under this scheme' });
          continue;
        }

        // A scheme that pays a set figure is compared against the figure this
        // person is down for, and one that is scored against their score.
        const from = paysAmount
          ? (awardBy.get(`${col.scheme.id}|${person.id}`) ?? null)
          : round2(scoreBy.get(`${col.scheme.id}|${person.id}`) ?? 0);

        if (from !== value) {
          line.changes.push({
            kind: 'score',
            schemeId: col.scheme.id,
            label: paysAmount ? col.scheme.name : `${col.scheme.name} score`,
            from,
            to: value,
            ...(paysAmount ? { paysAmount: true } : {}),
          });
        }
        continue;
      }

      if (col.kind === 'advance') {
        const value = readMoney(cell);
        if (value === null) continue;
        // Read, checked, and never written. An advance is an agreement with a
        // balance behind it, and the payroll takes the instalment that
        // agreement says. A figure typed into a spreadsheet is not an
        // agreement, so the sheet is compared against the books rather than
        // allowed to overrule them.
        const due = round2(advanceDue.get(person.id) ?? 0);
        if (Number.isNaN(value)) {
          line.notes.push({ what: 'Advance', why: 'not a figure' });
        } else if (value !== due) {
          line.notes.push({
            what: 'Advance',
            why: `the sheet says ${value.toFixed(2)}, the payroll will take ${due.toFixed(2)}`,
          });
        }
      }
    }

    if (line.changes.length || line.notes.length) lines.push(line);
  });

  return { columns, unknown, lines, skipped, missingColumns };
}

/** What a run of the file comes to, for the sentence above the Apply button. */
export function tallyOf(read) {
  const counts = { basic: 0, allowance: 0, score: 0 };
  for (const line of read.lines) {
    for (const change of line.changes) counts[change.kind] += 1;
  }
  return {
    people: read.lines.filter((l) => l.changes.length).length,
    ...counts,
    changes: counts.basic + counts.allowance + counts.score,
    notes: read.lines.reduce((n, l) => n + l.notes.length, 0),
    skipped: read.skipped.length,
  };
}
