import { state } from '../app.js';
import { fmtNum, h, money } from '../util.js';
import { PAGE_H, PAGE_W } from './letter-paper.js';

/**
 * The payslip, as a piece of paper.
 *
 * ONE PAGE, ALWAYS. A payslip is filed, posted and handed over, and a second
 * sheet carrying three lines of tax working gets separated from the first and
 * lost. So this is not a screen that happens to print: it is an A4 page, drawn
 * at A4 proportions, and everything on it is sized in `em` off one root figure
 * that shrinks until the content fits. Somebody with eleven allowances and
 * four bonus schemes gets smaller type, not a second page.
 *
 * WHO PAID THEM, AT THE TOP. The name alone is not enough on a document
 * somebody takes to a bank or a SSNIT branch. The logo, the registered name,
 * the address, a telephone number, the TIN and the employer's SSNIT number all
 * head the page, and any of them left blank in Setup is simply left off rather
 * than printed as an empty label.
 *
 * EARNINGS ON THE LEFT, DEDUCTIONS ON THE RIGHT. The arrangement every payroll
 * in the world uses, because the question a payslip answers is "why is this
 * smaller than my salary", and two columns answer it at a glance. The working
 * underneath is there for the person who wants to check it.
 */

/** What Setup knows about the employer, in the shape this page wants. */
export function companyOf(settings = state.settings ?? {}) {
  const clean = (v) => String(v ?? '').trim();
  return {
    name: clean(settings.property_name) || 'This property',
    legalName: clean(settings.company_legal_name),
    address: clean(settings.property_address).split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    phone: clean(settings.company_phone),
    email: clean(settings.company_email),
    website: clean(settings.company_website),
    tin: clean(settings.company_tin),
    ssnit: clean(settings.company_ssnit),
    logo: clean(settings.company_logo_at)
      ? `/api/company/logo?v=${encodeURIComponent(clean(settings.company_logo_at))}`
      : null,
  };
}

const join = (parts, sep = ' · ') => parts.filter(Boolean).join(sep);

/**
 * One payslip, as one page.
 *
 * Returns the page unfitted. Call `fitPayslip` once it is in the document,
 * because nothing can be measured before then.
 */
export function payslipPage({ line, data, month, company = companyOf() }) {
  const cash = (n) => money(n, data.currency);
  const b = line.bonus ?? { schemes: [] };
  // How the earnings column reads. Older payslips saved before this was worked
  // out do not carry it, so the agreed allowances stand in.
  const slip = line.slip ?? {};
  const rates = data.rates ?? {};

  const sum = (label, value) => h('tr.slip-sum',
    h('td', h('strong', label)), h('td.num', h('strong', value)));

  const row = (label, value, note) => h('tr',
    h('td', label, note ? h('small.muted', ` ${note}`) : null),
    h('td.num', value));

  const deductions = [
    line.ssnit?.qualifies
      ? row(`SSNIT`, cash(line.ssnit.employee),
        `${fmtNum((rates.ssnitEmployee ?? 0) * 100, 1)}% of basic`)
      : null,
    // No breakdown beside it. Splitting the PAYE into a part on pay and a part
    // on the bonus is the property's working, not the reader's: what came off
    // is one figure, and the second one only invites the question of why a
    // bonus of four hundred carried tax of eighty-seven.
    row('PAYE', cash(line.paye.total)),
    // ONE LINE, WHATEVER THEY HAVE RUNNING. Two advances came off as two
    // identical rows both headed Salary advance, which reads as a mistake
    // rather than as two agreements. What a payslip has to answer is how much
    // came off, and that is one figure.
    //
    // And no running balance beside it. What is left to pay is a moving figure
    // that belongs on the advance screen, where it is shown properly with the
    // months behind and ahead of it; on a payslip it is a number with no
    // working, printed on a document somebody keeps.
    (line.loans ?? []).length
      ? row(
        (line.loans ?? []).length > 1 ? 'Salary advances' : 'Salary advance',
        cash(line.loanTotal ?? (line.loans ?? []).reduce((n, l) => n + (l.amount || 0), 0)),
      )
      : null,
  ].filter(Boolean);

  const took = (line.ssnit?.employee ?? 0) + line.paye.total + (line.loanTotal ?? 0);

  return h('div.slip-page', { style: { width: `${PAGE_W}px`, height: `${PAGE_H}px` } },
    h('div.slip-fit',

      // -------------------------------------------------------- the employer
      h('header.slip-company',
        company.logo
          ? h('img.slip-logo', { src: company.logo, alt: '' })
          : null,
        h('div.slip-company-words',
          h('div.slip-company-name', company.name),
          company.legalName && company.legalName !== company.name
            ? h('div.slip-company-legal', company.legalName)
            : null,
          company.address.length
            ? h('div.slip-company-line', company.address.join(', '))
            : null,
          join([company.phone, company.email, company.website])
            ? h('div.slip-company-line', join([company.phone, company.email, company.website]))
            : null,
          join([
            company.tin ? `TIN ${company.tin}` : '',
            company.ssnit ? `SSNIT employer no. ${company.ssnit}` : '',
          ])
            ? h('div.slip-company-line', join([
              company.tin ? `TIN ${company.tin}` : '',
              company.ssnit ? `SSNIT employer no. ${company.ssnit}` : '',
            ]))
            : null)),

      // ------------------------------------------------------------ who, when
      h('div.slip-banner',
        h('div.slip-banner-what', 'Payslip'),
        h('div.slip-banner-when', month.nice),
        data.status === 'final'
          ? h('span.slip-stamp.is-final', 'Final')
          : h('span.slip-stamp', 'Draft')),

      h('div.slip-who',
        who('Name', line.staff.name),
        who('Department', line.staff.department || '—'),
        who('Employee no.', line.staff.employeeNo || '—'),
        who('SSNIT', line.ssnit?.qualifies ? 'Contributing' : 'Not a member')),

      // ------------------------------------------------- earnings, deductions
      h('div.slip-cols',
        h('section.slip-col',
          h('h3.slip-col-head', 'Earnings'),
          h('table.slip-table', h('tbody',
            row('Basic salary', cash(line.basic),
              line.partMonth ? `${line.partMonth.days} of ${line.partMonth.of} days` : null),
            // The allowances as they read here, which is the agreed figures
            // with the tax the property carried on the bonus folded in. The
            // list the property actually agreed to pay is line.allowances, and
            // that is what the journal and the GRA schedule are drawn from.
            ...(slip.allowances ?? line.allowances ?? []).map((a) => row(a.name, cash(a.amount),
              a.taxable === false ? 'not taxed' : null)),
            // The bonus somebody was promised, and nothing else. A grossed-up
            // figure here is a number nobody was offered, and it invites the
            // one question a payslip cannot answer: why does this say 470 when
            // we agreed 400.
            b.net ? row('Bonus', cash(b.net)) : null,
            sum('Gross pay', cash(line.gross))))),

        h('section.slip-col',
          h('h3.slip-col-head', 'Deductions'),
          h('table.slip-table', h('tbody',
            ...deductions,
            deductions.length ? null : row('Nothing came off', cash(0)),
            sum('Total deductions', cash(took)))))),

      // ------------------------------------------------------------- the net
      h('div.slip-netband',
        h('div.slip-netband-label', 'Net pay'),
        h('div.slip-netband-value', cash(line.net))),

      // ------------------------------------------------------- the working
      h('div.slip-cols.slip-working',
        b.earned || b.docked
          ? h('section.slip-col',
            h('h3.slip-col-head', 'How the bonus came out'),
            h('table.slip-table', h('tbody',
              ...(b.schemes ?? []).map((sc) => row(sc.name, cash(sc.amount),
                `${cash(sc.award)} at ${fmtNum(sc.score, 0)}%`)),
              b.docked ? row('Less deductions for misconduct', `− ${cash(b.docked)}`) : null,
              b.notTaken
                ? row('More was docked than the bonus could carry', cash(b.notTaken))
                : null,
              sum('Bonus paid', cash(b.net)))),
            // Outside the table, because a sentence in a two-column money
            // table is a sentence sitting on top of the figures.
            b.tax
              ? h('p.slip-note',
                `Agreed as what you receive. The ${cash(b.tax)} of tax on it is carried by the `
                + 'property, and is in the allowance above.')
              : null)
          : null,

        // What the month cost on top of the pay. It used to be a line of small
        // print along the bottom, which is where a reader's eye goes last and
        // where two real figures do not belong.
        h('section.slip-col',
          h('h3.slip-col-head', 'What it cost the company'),
          h('table.slip-table', h('tbody',
            row('Gross pay', cash(line.gross)),
            line.ssnit?.qualifies
              ? row('Employer SSNIT', cash(line.ssnit.employer),
                `${fmtNum((rates.ssnitEmployer ?? 0) * 100, 0)}% of basic`)
              : null,
            sum('Cost to the company', cash(line.employerCost)))))),

      // ----------------------------------------------------------- the cost
      h('footer.slip-foot',
        h('p.slip-small',
          data.status === 'final'
            ? `${month.nice} is closed, so this payslip is a record and will not change. `
            : `${month.nice} is still open, so these figures move if anything behind them moves. `,
          'Keep it. It is your record of what you were paid and what was taken off.'))));
}

const who = (label, value) => h('div.slip-who-cell',
  h('div.slip-who-label', label),
  h('div.slip-who-value', value));

const STEPS = [1, 0.96, 0.92, 0.88, 0.84, 0.8, 0.76, 0.72, 0.68, 0.64, 0.6, 0.55, 0.5, 0.46];

/**
 * Shrink the page until it fits.
 *
 * Nothing can be measured until the page is in the document, so this is a
 * second pass rather than part of drawing it. Fourteen steps covers anything a
 * real property produces: the busiest slip the payroll can make, somebody with
 * a dozen allowances, two advances and every bonus scheme, does not shrink at
 * all.
 *
 * If even the smallest step overflows, the page is allowed to grow instead.
 * One page is the point of all this, but not at the price of a figure being
 * quietly clipped off the bottom of somebody's payslip.
 */
export function fitPayslip(page) {
  const body = page.querySelector('.slip-fit');
  if (!body) return 1;

  page.classList.remove('is-overlong');
  for (const step of STEPS) {
    body.style.setProperty('--slip-fit', String(step));
    if (body.scrollHeight <= body.clientHeight + 1) return step;
  }

  page.classList.add('is-overlong');
  return STEPS[STEPS.length - 1];
}

/**
 * The pages, over everything else, with a way to print them.
 *
 * The same overlay the letters preview uses, so the print stylesheet that
 * already turns one of these into one sheet of A4 does not have to be written
 * twice.
 */
export function showPayslips(pages, { title, subtitle }) {
  const shade = h('div.preview-shade', { onclick: (e) => { if (e.target === shade) shade.remove(); } });

  // A page is A4 and a phone is not, so each one is sized down to whatever is
  // in front of somebody. Printing undoes it: the stylesheet takes the
  // transform off and hands the printer 210 by 297 millimetres.
  const scale = Math.min(1, (Math.min(window.innerWidth, 950) - 56) / PAGE_W);
  const shown = pages.map((page) => (scale === 1 ? page : h('div.paper-scale', {
    style: { width: `${Math.round(PAGE_W * scale)}px`, height: `${Math.round(PAGE_H * scale)}px` },
  }, h('div.paper-scale-inner', {
    style: { transform: `scale(${scale})`, width: `${PAGE_W}px`, height: `${PAGE_H}px` },
  }, page))));

  shade.append(h('div.preview-wrap',
    h('div.preview-bar',
      h('strong', title),
      subtitle ? h('span.muted', subtitle) : null,
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => window.print() }, 'Print or save as PDF'),
        h('button.btn-sm', { onclick: () => shade.remove() }, 'Close'))),
    h('div.preview-pages', shown)));

  document.body.append(shade);
  // In the document at last, so the pages can be measured and shrunk to fit.
  for (const page of pages) fitPayslip(page);
  return shade;
}
