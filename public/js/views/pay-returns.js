import { h, money } from '../util.js';
import { companyOf } from './payslip.js';

/**
 * The two returns a month has to produce, on paper somebody can file.
 *
 * THE JOURNAL IS A SHEET TO TYPE FROM, NOT A LEDGER. This app does not keep
 * the books and never will. What it can do is hand over the entry already
 * balanced and already split, which is the part that goes wrong when it is
 * worked out by hand at the end of a long month.
 *
 * THE TIER SPLIT IS THE POINT OF IT. 18.5% of basic goes to the pension and it
 * is not one payment: 13.5% to SSNIT and 5% to the second-tier trustee, on
 * separate forms to separate people. Reporting a single figure leaves that
 * division to whoever is typing, every month.
 *
 * THE PAYE SCHEDULE IS THE GRA'S OWN COLUMNS. Same order, same names, so it
 * reads straight across into the return rather than being translated. Where
 * the app cannot know a column, it leaves it empty rather than filling it with
 * a guess that would be filed as fact.
 */

export function returnsSheet(data, niceMonth) {
  const cash = (n) => money(n, data.currency);
  // The schedule carries the currency once, in its heading. Fourteen columns
  // of "GHS" is what pushes it off the side of a landscape sheet, and a tax
  // return is not read one cell at a time.
  const figure = (n) => new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n) || 0);
  const company = companyOf();
  const { journal, schedule } = data;
  const columns = data.columns ?? [];

  return h('div.returns',
    h('div.returns-head',
      h('div',
        h('h1', company.legalName || data.property || 'The property'),
        company.tin ? h('div.muted', `TIN ${company.tin}`) : null,
        company.ssnit ? h('div.muted', `Employer SSNIT ${company.ssnit}`) : null),
      h('div.returns-when',
        h('strong', niceMonth),
        h('div.muted', data.status === 'final' ? 'Closed' : 'Draft, still moving'))),

    // ---- the journal ----------------------------------------------------
    h('section.returns-block',
      h('h2', 'Payroll journal'),
      h('p.muted', 'The entry for the month, to be typed into the books as it stands.'),
      h('table.returns-table.returns-journal',
        h('thead', h('tr',
          h('th', 'Account'),
          h('th.num', 'Debit'),
          h('th.num', 'Credit'))),
        h('tbody',
          journal.debits.map((row) => h('tr',
            h('td', h('strong', row.account), h('div.muted', row.detail)),
            h('td.num', cash(row.amount)),
            h('td.num', ''))),
          journal.credits.map((row) => h('tr',
            h('td', h('span.returns-indent'), row.account, h('div.muted', row.detail)),
            h('td.num', ''),
            h('td.num', cash(row.amount)))),
          h('tr.returns-total',
            h('td', h('strong', 'Totals')),
            h('td.num', h('strong', cash(journal.debitTotal))),
            h('td.num', h('strong', cash(journal.creditTotal)))))),
      journal.difference
        ? h('p.returns-warn',
          `The two sides are out by ${cash(Math.abs(journal.difference))}. That is rounding `
          + 'to the pesewa person by person; put it wherever the books usually take it.')
        : null),

    // ---- the pension, split the way it is paid ---------------------------
    h('section.returns-block',
      h('h2', 'Social security, tier by tier'),
      h('p.muted',
        'One deduction, two payments. The whole 18.5% of basic is divided under Act 766 and '
        + 'remitted separately.'),
      h('div.returns-tiers',
        tier('From the worker', cash(journal.pension.employee),
          `${pct(data.rates.ssnitEmployee)} of basic`),
        tier('From the property', cash(journal.pension.employer),
          `${pct(data.rates.ssnitEmployer)} of basic`),
        tier('Tier 1, to SSNIT', cash(journal.pension.tier1),
          `${pct(data.tiers.tier1)} of basic`, true),
        tier('Tier 2, to the trustee', cash(journal.pension.tier2),
          `${pct(data.tiers.tier2)} of basic`, true)),
      journal.pension.unallocated
        ? h('p.returns-warn',
          `${cash(journal.pension.unallocated)} of the contribution belongs to neither tier. `
          + 'The rates as set do not add up, so somebody has to say where it goes.')
        : null),

    // ---- the SSNIT return -----------------------------------------------
    data.ssnit
      ? h('section.returns-block',
        h('h2', 'SSNIT contribution return'),
        h('p.muted',
          `${data.ssnit.members} contributing ${data.ssnit.members === 1 ? 'member' : 'members'}, `
          + `in ${data.currency}. Who contributed, on what basic, and how the 18.5% splits `
          + 'between SSNIT and the trustee. Somebody not contributing is left off rather than '
          + 'shown at nought: the return is a list of members.'),
        h('div.table-wrap',
          h('table.returns-table.returns-paye',
            h('thead', h('tr', data.ssnit.columns.map((c) => h(c.money ? 'th.num' : 'th', c.label)))),
            h('tbody',
              data.ssnit.rows.map((row) => h('tr', data.ssnit.columns.map((c) => h(
                c.money ? 'td.num' : 'td',
                c.money ? figure(row[c.key]) : String(row[c.key] ?? ''),
              )))),
              h('tr.returns-total', data.ssnit.columns.map((c, i) => {
                if (i === 0) return h('td', h('strong', 'Totals'));
                return c.money
                  ? h('td.num', h('strong', figure(data.ssnit.totals[c.key])))
                  : h('td', '');
              }))))))
      : null,

    // ---- the PAYE schedule ----------------------------------------------
    h('section.returns-block',
      h('h2', 'PAYE schedule'),
      h('div.table-wrap', graForm(data, schedule, columns, figure)),
      h('p.muted',
        `Amounts in ${data.currency}. Deductible reliefs are left at nought unless a relief is `
        + 'set against the person, because they are claimed on a certificate the GRA issues to '
        + 'the person, not something a payroll knows.'),
      h('p.muted',
        'A bonus is taxed at 5% as a final tax up to the 15% ceiling (column 12 and 13). Anything '
        + 'past that ceiling is the excess bonus (column 14): it is income rather than a separate '
        + 'tax, so it is already inside the chargeable income and the tax deductible beside it.'),

      data.missing.length
        ? h('div.returns-warn',
          h('strong', 'Missing before this can be filed'),
          h('ul', data.missing.map((who) => h('li', `${who.name}: ${who.wants.join(' and ')}`))))
        : null),

    h('p.returns-foot',
      `${data.rates.label}. Prepared from the payroll as it stood when this was printed.`));
}

function tier(label, amount, detail, strong) {
  return h('div.returns-tier', { class: strong ? 'is-payment' : '' },
    h('div.returns-tier-label', label),
    h('div.returns-tier-amount', amount),
    h('div.muted', detail));
}

const pct = (rate) => `${Math.round(Number(rate) * 1000) / 10}%`;

/**
 * The GRA's form, as the paper looks.
 *
 * Copied from the GRA's own workbook (DT 107A, 2022): the heading block in its
 * frame with the boxes for the tax office, the employer and the month, the
 * column numbers along the top, PENSIONS over columns 9 and 10, the bonus and
 * overtime columns shaded the way the form shades them, and TOTALS along the
 * bottom. Whoever files it has the GRA's sheet beside them, and the two should
 * look the same.
 */
function graForm(data, schedule, columns, figure) {
  const employer = data.employer ?? {};
  const office = employer.taxOffice ?? {};
  const [year, mm] = String(data.month ?? '').split('-');
  const asFiled = mm && year ? `${mm}/${year}` : '';
  const shade = (c) => ({
    bonus: 'is-light', overtime: 'is-light', bonusTax: 'is-dark', overtimeTax: 'is-dark',
  }[c.key] ?? '');
  const cls = (c, base = '') => [base, c.money ? 'num' : '', shade(c)].filter(Boolean).join(' ');
  const tick = (kind) => h('span.gra-box.gra-tick', { class: office.kind === kind ? 'is-ticked' : '' },
    kind, office.kind === kind ? h('b', { 'aria-label': 'ticked' }, ' ✓') : null);
  const pensionAt = columns.findIndex((c) => c.key === 'ssf');

  return h('div.gra-form',
    h('div.gra-head', h('div.gra-head-inner',
      h('div.gra-title', 'GHANA REVENUE AUTHORITY'),
      h('div.gra-sub', 'DOMESTIC TAX REVENUE DIVISION'),
      h('div.gra-doc', 'EMPLOYER’S MONTHLY TAX DEDUCTIONS SCHEDULE (P. A. Y. E.)'),
      h('div.gra-fields',
        h('div.gra-label', 'CURRENT TAX OFFICE'),
        h('div.gra-office',
          h('div.gra-office-boxes', tick('LTO'), tick('TSC'), h('span.gra-box.gra-office-name', office.name || '')),
          h('div.gra-office-notes', h('span', '(tick one)'), h('span', 'Name of Tax Office'))),
        h('div'),
        h('div.gra-label', 'NAME OF EMPLOYER'),
        h('div.gra-box.gra-employer', employer.name || ''),
        h('div.gra-month',
          h('span.gra-label', 'FOR THE MONTH OF'),
          h('span.gra-month-box',
            h('span.gra-box', asFiled),
            h('small', '(MM/YYYY)'))),
        h('div.gra-label', 'EMPLOYER’S TIN / GH. CARD NO.'),
        h('div.gra-box.gra-tin', employer.tin || ''),
        h('div')))),

    h('table.gra-table',
      h('thead',
        h('tr.gra-nums', columns.map((c) => h('th', { class: shade(c) }, c.no ?? ''))),
        h('tr.gra-group', columns.map((c, i) => {
          if (i === pensionAt) return h('th.gra-pensions', { colSpan: 2 }, 'PENSIONS');
          if (i === pensionAt + 1) return null;
          return h('th', { class: shade(c) });
        })),
        h('tr.gra-heads', columns.map((c) => h('th', { class: cls(c) }, c.label)))),
      h('tbody',
        schedule.rows.map((row) => h('tr', columns.map((c) => h('td', { class: cls(c, c.key) },
          c.money
            ? (row[c.key] === null ? '' : (Number(row[c.key]) ? figure(row[c.key]) : '-'))
            : String(row[c.key] ?? '')))))),
      h('tfoot',
        h('tr', columns.map((c, i) => {
          if (i === 0) return h('td.gra-total-label', { colSpan: 1 }, 'TOTALS');
          const total = schedule.totals[c.key];
          return h('td', { class: cls(c) }, c.money && total !== undefined ? (Number(total) ? figure(total) : '-') : '');
        })))));
}

