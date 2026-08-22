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

    // ---- the PAYE schedule ----------------------------------------------
    h('section.returns-block',
      h('h2', 'PAYE schedule'),
      h('p.muted',
        `Every employee, what they earned, what came off and what tax that came to, in `
        + `${data.currency}. Tax relief is left empty because it is claimed on a certificate `
        + 'the GRA issues to the person, not something a payroll knows.'),
      h('div.table-wrap',
        h('table.returns-table.returns-paye',
          h('thead', h('tr', columns.map((c) => h(c.money ? 'th.num' : 'th', c.label)))),
          h('tbody',
            schedule.rows.map((row) => h('tr', columns.map((c) => h(
              c.money ? 'td.num' : 'td',
              c.money
                ? (row[c.key] === null ? '' : figure(row[c.key]))
                : String(row[c.key] ?? ''),
            )))),
            h('tr.returns-total', columns.map((c, i) => {
              if (i === 0) return h('td', h('strong', 'Totals'));
              const total = schedule.totals[c.key];
              return c.money && total !== undefined
                ? h('td.num', h('strong', figure(total)))
                : h(c.money ? 'td.num' : 'td', '');
            }))))),

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
