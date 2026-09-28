import { S, colName } from './xlsx.js';
import { round2 } from './tax.js';

/**
 * The month's payroll input, laid out the way the office keeps its bonus sheet.
 *
 * A department across the top and its schemes under it, the bonus in money
 * rather than in scores, then what was docked and what that leaves. Along the
 * left, who they are and the figures that move from month to month: the
 * basic, the take-home and whether the bonus goes on top of it. Everything is
 * filled in from the payroll as it stands, so the job is to change what
 * changed and send it back.
 *
 * A scheme that covers several departments has a column under each, because
 * that is how the office lays it out: Grati-Pay under Maintenance, again under
 * Reception, again under Security. A person's figure is in the column under
 * their own department and the others stay blank, so reading it back finds
 * exactly one figure per person per scheme.
 */

const MONEY = (n) => ({ v: round2(n), s: S.money });

/** The groups across the top: everybody's schemes first, then each department's, in the property's order. */
export function schemeGroups(schemes, departmentOrder = []) {
  const live = schemes.filter((s) => s.active);
  const general = live.filter((s) => !s.departments.length);
  const named = new Set(live.flatMap((s) => s.departments));
  const order = [
    ...departmentOrder.filter((d) => named.has(d)),
    ...[...named].filter((d) => !departmentOrder.includes(d)).sort((a, b) => a.localeCompare(b)),
  ];
  const groups = [];
  if (general.length) groups.push({ department: null, schemes: general });
  for (const department of order) {
    groups.push({ department, schemes: live.filter((s) => s.departments.includes(department)) });
  }
  return groups;
}

/**
 * The sheet, as `{ name, rows, widths, merges, freeze }` for the workbook writer.
 *
 * `people` is everybody on the month's payroll, each with their line as the
 * payroll works it out, so the bonus columns hold what HIVE would pay today.
 */
export function inputSheet({
  title, month, currency = 'GHS', people = [], schemes = [], departmentOrder = [],
  allowances = [], allowanceBy = new Map(), deductionBy = new Map(), advanceDue = new Map(),
}) {
  const groups = schemeGroups(schemes, departmentOrder);

  // Column by column, so the headings, the group row and every line agree on
  // where each thing is.
  const cols = [
    { head: 'Employee no', group: '', width: 11, key: 'no' },
    { head: 'Staff name', group: '', width: 28, key: 'name' },
    { head: 'Department', group: '', width: 16, key: 'department' },
    { head: 'Basic', group: 'PAY', width: 11, key: 'basic' },
    { head: 'Take-home', group: 'PAY', width: 12, key: 'takeHome' },
    { head: '+ bonus', group: 'PAY', width: 9, key: 'plusBonus' },
    ...allowances.map((name) => ({ head: `Allowance: ${name}`, group: 'ALLOWANCES', width: 14, key: 'allowance', name })),
  ];
  const firstScheme = cols.length;
  for (const group of groups) {
    for (const scheme of group.schemes) {
      cols.push({
        head: scheme.name,
        group: group.department ? group.department.toUpperCase() : 'EVERYBODY',
        width: Math.max(11, Math.min(18, scheme.name.length + 2)),
        key: 'scheme',
        scheme,
        department: group.department,
      });
    }
  }
  const lastScheme = cols.length - 1;
  cols.push(
    { head: 'Deductions', group: 'BONUS', width: 12, key: 'deductions' },
    { head: 'Total', group: 'BONUS', width: 12, key: 'total' },
    { head: 'Advance', group: '', width: 11, key: 'advance' },
  );
  const at = (key) => cols.findIndex((c) => c.key === key);

  // The column each person's figure for a scheme goes in: under their own
  // department where the scheme covers it, else the first place it appears.
  const columnFor = (scheme, department) => {
    const own = cols.findIndex((c) => c.key === 'scheme' && c.scheme.id === scheme.id
      && c.department === department);
    if (own >= 0) return own;
    return cols.findIndex((c) => c.key === 'scheme' && c.scheme.id === scheme.id);
  };

  const TOP = 4; // Rows above the first person: title, note, groups, headings.
  const rows = [
    [{ v: title, s: S.title }],
    [`Change what changed this month and upload it back under Bulk upload. A blank cell leaves `
      + `a figure as it is. Bonus columns are the money the scheme pays them, in ${currency}.`],
    cols.map((c, i) => {
      const before = i > 0 ? cols[i - 1].group : null;
      return c.group && c.group !== before ? { v: c.group, s: S.head } : { v: c.group ? '' : null, s: c.group ? S.head : 0 };
    }),
    cols.map((c) => ({ v: c.head, s: S.head })),
  ];

  // Everybody in their department, in the property's order, then by name, so
  // the sheet reads in the same blocks as the one the office already keeps.
  const rank = (d) => {
    const i = departmentOrder.indexOf(d ?? '');
    return i < 0 ? departmentOrder.length : i;
  };
  const sorted = [...people].sort((a, b) => rank(a.department) - rank(b.department)
    || String(a.department ?? '').localeCompare(String(b.department ?? ''))
    || a.name.localeCompare(b.name));

  sorted.forEach((person, n) => {
    const r = TOP + n;
    const cells = cols.map(() => null);
    cells[at('no')] = { v: person.employeeNo ?? '', text: true };
    cells[at('name')] = person.name;
    cells[at('department')] = person.department ?? '';
    cells[at('basic')] = MONEY(person.basic);
    cells[at('takeHome')] = person.takeHome == null ? null : MONEY(person.takeHome);
    cells[at('plusBonus')] = person.takeHome == null ? null : (person.takeHomeFixed ? 'Yes' : 'No');

    for (const [i, c] of cols.entries()) {
      if (c.key !== 'allowance') continue;
      const found = (allowanceBy.get(person.id) ?? []).find((a) => a.name === c.name);
      cells[i] = found ? MONEY(found.amount) : null;
    }
    for (const earned of person.schemes) {
      const scheme = schemes.find((s) => s.id === earned.id);
      if (!scheme?.active) continue;
      const i = columnFor(scheme, person.department ?? null);
      if (i >= 0) cells[i] = MONEY(earned.amount);
    }

    const deductions = round2(deductionBy.get(person.id) ?? 0);
    cells[at('deductions')] = MONEY(deductions);
    const earnedTotal = round2(person.schemes.reduce((t, s) => t + (Number(s.amount) || 0), 0));
    cells[at('total')] = lastScheme >= firstScheme
      ? {
        f: `SUM(${colName(firstScheme)}${r + 1}:${colName(lastScheme)}${r + 1})-${colName(at('deductions'))}${r + 1}`,
        v: round2(earnedTotal - deductions),
        s: S.money,
      }
      : MONEY(earnedTotal - deductions);
    cells[at('advance')] = MONEY(advanceDue.get(person.id) ?? 0);
    rows.push(cells);
  });

  // The totals, as formulas, under every figure that adds up.
  if (sorted.length) {
    const first = TOP + 1;
    const last = TOP + sorted.length;
    rows.push(cols.map((c, i) => {
      if (c.key === 'no') return { v: 'Totals', s: S.total };
      if (['basic', 'takeHome', 'allowance', 'scheme', 'deductions', 'total', 'advance'].includes(c.key)) {
        const sum = rows.slice(TOP).reduce((t, row) => t + (Number(row[i]?.v) || 0), 0);
        return { f: `SUM(${colName(i)}${first}:${colName(i)}${last})`, v: round2(sum), s: S.moneyTotal };
      }
      return { v: null, s: S.total };
    }));
  }

  // One merged cell over each run of columns that share a group.
  const merges = [];
  for (let i = 0; i < cols.length;) {
    let j = i;
    while (j + 1 < cols.length && cols[j + 1].group === cols[i].group) j += 1;
    if (cols[i].group && j > i) merges.push(`${colName(i)}3:${colName(j)}3`);
    i = j + 1;
  }

  return {
    name: `Input ${month}`,
    rows,
    widths: cols.map((c) => c.width),
    merges,
    freeze: TOP,
  };
}
