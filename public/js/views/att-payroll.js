import { api } from '../api.js';
import {
  confirmAction, deltaBadge, fmtNum, h, money, monthOf, mount, shiftMonth, toast, todayISO,
} from '../util.js';
import { bulkUpload, card, emptyState } from './components.js';
import {
  GENERAL, field, formDialog, sayDepartments, schemeDepartments, schemesByDepartment, showSheet,
} from './att-shared.js';
import { replaceParams } from '../app.js';
import { printReport } from '../print.js';
import { niceMonth } from './att-advances.js';
import { companyOf, payslipPage, showPayslips } from './payslip.js';
import { returnsSheet } from './pay-returns.js';

/**
 * The payroll.
 *
 * FOUR THINGS IN THE ORDER THEY ARE DONE. Who is on it and what they are paid;
 * the bonus schemes and what everybody scored; what came off for misconduct;
 * and then the month itself, worked out, checked and closed. A screen that put
 * the setup and the running of a payroll on the same footing would make
 * somebody scroll past the parts that only change once a year, every month.
 *
 * NOTHING IS FINAL UNTIL IT IS CLOSED. The figures on screen are a draft that
 * moves when anything behind it moves. Closing the month writes every payslip
 * down as it stands and records the advance deductions against the balances
 * they came off, and after that nothing recomputes.
 *
 * THE PAYSLIP SHOWS ITS WORKING. Every figure on it can be pointed at: the
 * bonus a person earned, what came off it and why, what the grossing up cost,
 * which tax bands were used and how much fell in each. A payslip that says
 * "PAYE 309.00" and nothing else is a number somebody has to take on trust,
 * and payday is when trust is thinnest.
 */

/**
 * Arriving at the payroll tab.
 *
 * ASKED EVERY TIME, not once a day. Whatever window was left over from earlier
 * is dropped here, before anything is fetched, so opening this tab always
 * begins with the question. Everything inside the screen calls
 * `renderAttPayroll` directly, so changing the month does not ask again.
 */
export async function renderAttPayrollTab(params) {
  await api.payrollLock().catch(() => {});
  return renderAttPayroll(params);
}

export async function renderAttPayroll(params) {
  const host = h('div');
  const month = /^\d{4}-\d{2}$/.test(params.month) ? params.month : monthOf(todayISO());

  // The lock, before anything is asked for. A screen that fetched the month
  // first and put a padlock over it would have already been sent the month.
  const access = await api.payrollAccess().catch(() => ({ open: true, state: 'open' }));
  if (!access.open) {
    mount(host, lockScreen(access, async () => {
      mount(host, await renderAttPayroll(params));
    }));
    return host;
  }

  const data = await api.payroll(month, params.compare || null);
  const cash = (n) => money(n, data.currency);
  const closed = data.status === 'final';

  const reload = async (next = {}) => {
    const merged = { ...params, month, ...next };
    replaceParams('att-payroll', merged);
    mount(host, await renderAttPayroll(merged));
  };

  const onPayroll = data.staff.filter((s) => s.onPayroll);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Payroll'),
        // Which table this month is worked out on, and where it started. A
        // payroll run after a budget change is exactly when somebody needs to
        // see that March is still on March's figures.
        h('div.sub', `${niceMonth(month)} · ${data.rates.label}`,
          data.rates.from && data.rates.from !== '0000-01'
            ? h('span.muted', ` · in force from ${niceMonth(data.rates.from)}`)
            : null),
      ),
      h('div.btn-row',
        // The month and its two arrows stay together: wrapping between them
        // leaves an arrow stranded above the box it moves.
        h('div.btn-row.pay-month-pick',
          h('button.btn-sm', { onclick: () => reload({ month: shiftMonth(month, -1) }) }, '‹'),
          h('input', {
            type: 'month', value: month, 'aria-label': 'Month',
            onchange: (e) => e.target.value && reload({ month: e.target.value }),
          }),
          h('button.btn-sm', { onclick: () => reload({ month: shiftMonth(month, 1) }) }, '›')),
        h('button.btn-sm', { onclick: () => reload({ month: monthOf(todayISO()) }) }, 'This month'),
        // Leaving the tab asks for the PIN again anyway; this is for somebody
        // who is staying on the screen and wants it shut behind them now.
        h('button.btn-ghost.btn-sm', {
          title: 'Shut the payroll now, without leaving the screen',
          onclick: () => lockNow(reload),
        }, 'Lock'),
        access.hasPin
          ? h('button.btn-ghost.btn-sm', {
            title: 'Change the PIN you open the payroll with',
            onclick: () => changePin(access, reload),
          }, 'PIN')
          : null,
        closed
          ? null
          : h('button.btn-sm', {
            title: 'Bring last month\u2019s scores across so only what changed is typed',
            onclick: () => startFrom(month, reload),
          }, 'Start from last month')),
    ),

    closed
      ? h('div.alert.good',
        h('span.alert-icon', '✓'),
        h('div',
          h('div.alert-title', `${niceMonth(month)} is closed`),
          h('div.alert-detail',
            `Closed by ${data.closedBy || 'somebody'}. Every payslip is written down as it `
            + 'stood, and nothing here recomputes. Reopening takes back the advance deductions '
            + 'it recorded.')),
        h('button.btn-sm', {
          onclick: async () => {
            if (!confirmAction(`Open ${niceMonth(month)} again? The payslips are taken back and `
              + 'so are the advance deductions this payroll recorded.')) return;
            await api.payrollReopen({ month });
            toast('Open again.', 'good');
            await reload();
          },
        }, 'Open it again'))
      : null,

    onPayroll.length
      ? h('div.grid.grid-4.pay-tiles',
        tile('Gross', cash(data.totals.gross),
          `${data.totals.people} on the payroll`),
        tile('Deductions', cash(data.totals.ssnitEmployee + data.totals.paye + data.totals.loans),
          `SSNIT ${cash(data.totals.ssnitEmployee)} · PAYE ${cash(data.totals.paye)}`
          + (data.totals.loans ? ` · advances ${cash(data.totals.loans)}` : '')),
        tile('Net to pay', cash(data.totals.net), 'what goes out to people'),
        tile('Cost to the property', cash(data.totals.cost),
          `including ${cash(data.totals.ssnitEmployer)} employer SSNIT`))
      : null,

    onPayroll.length
      ? card('The month', {
        wide: true,
        note: closed ? 'closed' : 'a draft — it moves when anything behind it moves',
        actions: h('div.btn-row',
          comparePicker(data, month, reload),
          h('button.btn-sm', { onclick: () => printReport({
            title: `Payroll, ${niceMonth(month)}`,
            subtitle: data.property || '',
            note: `${data.rates.label}. ${closed ? 'Closed' : 'Draft'}.`,
          }) }, 'Print this table'),
          data.slips
            ? h('button.btn-sm', { onclick: () => openAllSlips(data, month) },
              `All ${data.lines.length} payslips`)
            : null,
          h('button.btn-sm', { onclick: () => openReturns(month) },
            'Journal and PAYE'),
          closed ? null : importButton(month, reload),
          closed
            ? null
            : h('button.btn.btn-primary', {
              onclick: () => close(month, data, reload, cash),
            }, 'Close the month')),
      },
        h('div.table-wrap', h('table.pay-table',
          h('thead', h('tr',
            h('th', 'Name'),
            h('th.num', 'Basic'),
            h('th.num', 'Allowances'),
            h('th.num', 'Bonus'),
            h('th.num', 'Gross'),
            h('th.num', 'SSNIT'),
            h('th.num', 'PAYE'),
            h('th.num', 'Advance'),
            h('th.num', 'Net'),
            h('th.num', compareHead(data)),
            h('th.num', 'Cost'),
          )),
          h('tbody', data.lines.map((line) => h('tr.pay-row', {
            tabindex: data.slips ? 0 : null,
            role: data.slips ? 'button' : null,
            title: data.slips ? 'The payslip' : null,
            onclick: data.slips ? () => openSlip(line, data, month, reload) : null,
            onkeydown: data.slips
              ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault(); openSlip(line, data, month, reload);
                }
              }
              : null,
          },
          h('td',
            h('div.adv-who', line.staff.name),
            h('small.muted', line.staff.department || `No. ${line.staff.employeeNo ?? ''}`),
            !line.ssnit.qualifies ? h('small.pill', 'no SSNIT') : null),
          h('td.num', cash(line.basic)),
          h('td.num', line.allowanceTotal ? cash(line.allowanceTotal) : h('span.muted', '—')),
          h('td.num', line.bonus.gross
            ? h('div',
              cash(line.bonus.gross),
              line.bonus.docked ? h('small.muted', ` less ${cash(line.bonus.docked)}`) : null)
            : h('span.muted', '—')),
          h('td.num', h('strong', cash(line.gross))),
          h('td.num', line.ssnit.employee ? cash(line.ssnit.employee) : h('span.muted', '—')),
          h('td.num', cash(line.paye.total)),
          h('td.num', line.loanTotal ? cash(line.loanTotal) : h('span.muted', '—')),
          h('td.num', h('strong', cash(line.net))),
          h('td.num', movementCell(line.against, cash)),
          h('td.num.off-phone', cash(line.employerCost)))),
          h('tr.pay-total',
            h('td', h('strong', 'Everybody')),
            h('td.num', cash(data.totals.basic)),
            h('td.num', cash(data.totals.allowances)),
            h('td.num', cash(data.totals.bonusGross)),
            h('td.num', h('strong', cash(data.totals.gross))),
            h('td.num', cash(data.totals.ssnitEmployee)),
            h('td.num', cash(data.totals.paye)),
            h('td.num', cash(data.totals.loans)),
            h('td.num', h('strong', cash(data.totals.net))),
            h('td.num', movementCell(wholeMonthAgainst(data), cash)),
            h('td.num.off-phone', cash(data.totals.cost)))))),
        compareNote(data),
        h('p.muted', { style: { fontSize: '.85rem' } }, data.slips
          ? 'Press a row for the payslip behind it.'
          : 'Payslips are an administrator\u2019s to open. The figures here are what the '
            + 'month comes to; what makes each of them up is on the slip.'))
      : emptyState('Nobody is on the payroll yet',
        'Say what each person is paid and whether SSNIT applies to them, and the month works '
        + 'itself out.'),

    schemesCard(data, month, closed, reload, cash),
    penaltiesCard(data, month, closed, reload, cash),
    peopleCard(data, reload, cash),
  );

  return host;
}

/**
 * Start this month from an earlier one.
 *
 * Salaries, allowances and who is under which scheme are standing things and
 * carry over by themselves. What this brings across is the month's own
 * working: the scores. Misconduct is asked about rather than assumed, because
 * money taken off in June is not money taken off in July.
 */
async function startFrom(month, reload) {
  const previous = shiftMonth(month, -1);

  const pick = h('input', { type: 'month', name: 'from', value: previous, max: shiftMonth(month, -1) });
  const penalties = h('input', { type: 'checkbox', name: 'penalties' });

  const done = await formDialog({
    title: `Start ${niceMonth(month)} from an earlier month`,
    submitLabel: 'Bring it across',
    body: h('div',
      h('p.muted', { style: { fontSize: '.9rem', marginTop: 0 } },
        'Salaries, allowances and who is under which scheme are not monthly things, so they are '
        + 'already here. What comes across is the scoring, which is mostly the same month to '
        + 'month, so only what changed has to be typed.'),
      field('Copy from', pick),
      h('label.tickline', penalties,
        h('span', 'Also what came off for misconduct',
          h('small.muted', ' \u00b7 leave this alone unless the same deduction runs every month'))),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Scores already typed into this month are replaced. Anybody taken off a scheme since, '
        + 'or who has left, is left out.')),
    onSubmit: () => api.payrollCopy({
      month,
      from: pick.value || previous,
      penalties: penalties.checked,
    }),
  });

  if (!done) return;
  const bits = [`${done.scores} score${done.scores === 1 ? '' : 's'}`];
  if (done.penalties) bits.push(`${done.penalties} off the bonus`);
  toast(done.scores || done.penalties
    ? `Brought across: ${bits.join(' and ')}.`
    : 'There was nothing to bring across.', done.scores ? 'good' : 'warn');
  await reload();
}

/**
 * The padlock.
 *
 * WHAT SOMEBODY IS PAID IS THE MOST SENSITIVE THING THIS APP KNOWS, and until
 * recently one tick on a login was the whole of the protection. A tick is set
 * once and then forgotten: it survives somebody changing job, and nothing
 * about a screen tells you who currently holds it.
 *
 * So the permission is only the first of four. An administrator grants the
 * person payroll access with an end date on it and hands them a code. The
 * person chooses a PIN of their own, which is not the PIN they sign in with.
 * And that PIN is asked for every single time this tab is opened, because a
 * lock that is opened once in the morning is a lock that is open all day to
 * whoever walks past the desk.
 */
function lockScreen(access, reload) {
  if (access.state === 'setup') return choosePin(access, reload);
  return askPin(access, reload);
}

/** The card the lock lives on, whatever it happens to be saying. */
function lockCard(title, blurb, ...rest) {
  return h('div',
    h('div.page-head', h('div', h('h1', 'Payroll'), h('div.sub', 'Locked'))),
    h('div.card.pay-lock',
      h('div.pay-lock-mark', '\u{1F512}'),
      h('h2', title),
      h('p.muted', blurb),
      ...rest));
}

const pinBox = (label) => h('input.pay-code', {
  type: 'password', inputmode: 'numeric', autocomplete: 'off',
  maxlength: 10, placeholder: '\u2022\u2022\u2022\u2022', 'aria-label': label,
});

const codeBox = () => h('input.pay-code', {
  type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
  maxlength: 20, placeholder: '000 000 000', 'aria-label': 'The code you were given',
});

/** Type your PIN. The everyday case, and the one this screen is built around. */
function askPin(access, reload) {
  if (access.state !== 'shut') {
    return lockCard(
      access.state === 'expired'
        ? 'Your payroll access has run out'
        : access.state === 'locked'
          ? 'Shut for a while'
          : 'You cannot open this yet',
      access.state === 'expired'
        ? 'An administrator can grant it again, with a new code.'
        : access.state === 'locked'
          ? 'Too many wrong tries. Wait a while, or ask an administrator to reset your payroll '
            + 'PIN for you.'
          : 'Payroll is not opened by a tick on a login. An administrator has to grant it to '
            + 'you, and they will give you a code to start with.',
      access.expiresAt && access.state !== 'expired'
        ? h('p.muted.pay-lock-when', `Your access runs until ${niceStamp(access.expiresAt)}.`)
        : null,
    );
  }

  const pin = pinBox('Payroll PIN');
  const problem = h('p.form-error', { style: { display: 'none' } });

  const open = async () => {
    problem.style.display = 'none';
    button.disabled = true;
    try {
      await api.payrollUnlock({ pin: pin.value });
      await reload();
    } catch (err) {
      button.disabled = false;
      problem.textContent = err.message;
      problem.style.display = '';
      pin.select();
    }
  };

  const button = h('button.btn.btn-primary', { onclick: open }, 'Open the payroll');
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  setTimeout(() => pin.focus(), 0);

  return lockCard(
    'Enter your payroll PIN',
    'Your own PIN, not the one you sign in with. It is asked for every time you open this tab.',
    h('div.pay-lock-form', pin, button),
    problem,
    h('p.muted.pay-lock-when',
      'Forgotten it? An administrator resets it for you, and you choose another.'),
  );
}

/**
 * Choose one, the first time.
 *
 * A member of staff proves it is them with the code an administrator handed
 * over. An administrator has already signed in with an email address and a
 * password, which is the strongest thing this app asks anybody for, so they
 * are asked for nothing beyond the PIN itself.
 */
function choosePin(access, reload) {
  // An administrator on the keypad. Their login PIN opens the app but it does
  // not get to choose the PIN that guards the payroll, or the payroll would be
  // behind four digits somebody could read over their shoulder.
  if (access.needsPassword) {
    return lockCard(
      'Sign in with your password first',
      'You are signed in with your keypad PIN. Choosing the PIN that guards the payroll takes '
      + 'your email address and password, which is the strongest thing this app asks you for. '
      + 'Sign out, sign back in that way, and come here again.',
      h('p.muted.pay-lock-when',
        'After that, the payroll PIN is all you type, from the keypad or anywhere else.'),
    );
  }

  const code = codeBox();
  const pin = pinBox('New payroll PIN');
  const again = pinBox('The same again');
  const problem = h('p.form-error', { style: { display: 'none' } });

  const save = async () => {
    problem.style.display = 'none';
    if (pin.value !== again.value) {
      problem.textContent = 'The two PINs are not the same.';
      problem.style.display = '';
      again.select();
      return;
    }
    button.disabled = true;
    try {
      await api.payrollSetPin({ pin: pin.value, code: access.needsCode ? code.value : undefined });
      toast('Payroll PIN set. You will be asked for it every time.', 'good');
      await reload();
    } catch (err) {
      button.disabled = false;
      problem.textContent = err.message;
      problem.style.display = '';
    }
  };

  const button = h('button.btn.btn-primary', { onclick: save }, 'Set it and open the payroll');
  for (const box of [code, pin, again]) {
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  }
  setTimeout(() => (access.needsCode ? code : pin).focus(), 0);

  return lockCard(
    'Choose your payroll PIN',
    access.needsCode
      ? 'Type the code an administrator gave you, then pick a PIN of your own. From then on the '
        + 'PIN is all you type, and it is asked for every time you open this tab.'
      : 'Pick a PIN of your own, between 4 and 10 digits. It is asked for every time you open '
        + 'this tab, so it is what stops an unattended screen being an open payroll.',
    h('div.pay-lock-fields',
      access.needsCode ? h('label', h('span', 'The code you were given'), code) : null,
      h('label', h('span', 'New payroll PIN'), pin),
      h('label', h('span', 'The same again'), again)),
    h('p.muted', { style: { fontSize: '.85rem' } },
      'It has to be different from the PIN you sign in with.'),
    h('div.btn-row', button),
    problem,
  );
}

/** Change it from inside, for somebody who thinks it has been seen. */
async function changePin(access, reload) {
  const current = pinBox('Current payroll PIN');
  const pin = pinBox('New payroll PIN');
  const again = pinBox('The same again');

  const done = await formDialog({
    title: 'Your payroll PIN',
    submitLabel: 'Change it',
    body: h('div',
      h('p.muted', { style: { fontSize: '.9rem', marginTop: 0 } },
        'This is the PIN you type to open the payroll, not the one you sign in with. Only its '
        + 'fingerprint is kept, so a forgotten one is reset by an administrator rather than '
        + 'looked up.'),
      field('The one you use now', current),
      field('New PIN', pin, '4 to 10 digits'),
      field('The same again', again)),
    onSubmit: () => {
      if (pin.value !== again.value) throw new Error('The two PINs are not the same.');
      return api.payrollSetPin({ current: current.value, pin: pin.value });
    },
  });

  if (!done) return;
  toast('Changed.', 'good');
  await reload();
}

/** Shut it now, for somebody walking away from a desk. */
async function lockNow(reload) {
  await api.payrollLock().catch(() => {});
  await reload();
}

/** 'YYYY-MM-DD HH:MM:SS' as somebody would say it. */
function niceStamp(value) {
  const t = new Date(String(value).replace(' ', 'T') + 'Z');
  if (Number.isNaN(t.getTime())) return String(value);
  return t.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * A month's figures, out of a spreadsheet.
 *
 * WHAT COMES DOWN IS THIS MONTH AS IT STANDS, not a blank form. Somebody
 * changes the two figures that changed and sends it back, which is both less
 * typing and far less to get wrong than a template with headings and nothing
 * under them.
 *
 * WHAT IT WOULD DO SITS ON THE SCREEN UNTIL SOMEBODY AGREES. Payroll decides
 * what people are paid, so an import that writes first and reports afterwards
 * is one nobody dares run a second time.
 */
function importButton(month, reload) {
  return bulkUpload({
    accept: '.csv,text/csv',
    title: 'Take the month down as a spreadsheet, or send one back. Nothing is written '
      + 'until you agree to it.',
    template: {
      href: `/api/payroll/input/template?month=${encodeURIComponent(month)}`,
      download: `payroll-${month}.csv`,
      label: 'Download template',
    },
    onFile: async (file) => {
      try {
        const text = await file.text();
        const read = await api.payrollReadInput({ month, text });
        await showImport({ month, text, read, reload });
      } catch (err) {
        toast(err.message, 'bad');
      }
    },
  });
}

/** What the file would do, and the button that does it. */
async function showImport({ month, text, read, reload }) {
  const { tally } = read;

  const lines = read.lines.map((line) => h('div.pay-import-row',
    h('div',
      h('strong', line.name),
      line.changes.length
        ? h('ul.pay-import-changes', line.changes.map((c) => h('li',
          `${c.label}: `,
          h('span.muted', c.from === null ? 'nothing' : String(c.from)),
          ' to ',
          h('strong', String(c.to)),
          c.kind === 'allowance' && c.taxable === false ? h('span.muted', ', not taxed') : null,
          // Introducing an allowance is a bigger thing than changing a figure
          // in one, so the line says which it is.
          c.isNew ? h('span.pill.good', { style: { marginLeft: '.4rem' } }, 'new') : null)))
        : null,
      line.notes.length
        ? h('ul.pay-import-notes', line.notes.map((n) => h('li', `${n.what}: ${n.why}`)))
        : null)));

  const done = await formDialog({
    title: `${niceMonth(month)} from a spreadsheet`,
    submitLabel: tally.changes ? `Change ${tally.changes} figures` : 'Nothing to change',
    body: h('div',
      h('p.muted', { style: { fontSize: '.9rem', marginTop: 0 } },
        tally.changes
          ? `${tally.changes} figure${tally.changes === 1 ? '' : 's'} would change across `
            + `${tally.people} ${tally.people === 1 ? 'person' : 'people'}. Nothing has been `
            + 'written yet.'
          : 'Nothing in that file is different from what is already here.'),

      read.missingColumns.length
        ? h('div.returns-warn', `The sheet needs ${read.missingColumns.join(' and ')}.`)
        : null,

      read.unknown.length
        ? h('div.returns-warn',
          h('strong', 'Columns nobody recognised, so they were left alone'),
          h('div', read.unknown.join(', ')),
          h('div.muted', 'An allowance or a scheme has to exist here before a column can set '
            + 'it. Nothing is made from a spreadsheet.'))
        : null,

      read.skipped.length
        ? h('div.returns-warn',
          h('strong', `${read.skipped.length} line${read.skipped.length === 1 ? '' : 's'} skipped`),
          h('ul', read.skipped.map((row) => h('li',
            `Line ${row.at}: ${row.name || row.employeeNo || 'blank'} · ${row.why}`))))
        : null,

      lines.length ? h('div.pay-import-list', lines) : null),

    onSubmit: () => (tally.changes
      ? api.payrollApplyInput({ month, text })
      : Promise.resolve({ basics: 0, allowances: 0, scores: 0 })),
  });

  if (!done) return;
  const bits = [];
  if (done.basics) bits.push(`${done.basics} salaries`);
  if (done.allowances) bits.push(`${done.allowances} allowances`);
  if (done.scores) bits.push(`${done.scores} scores`);
  toast(bits.length ? `Set: ${bits.join(', ')}.` : 'Nothing changed.', bits.length ? 'good' : 'warn');
  await reload();
}

/**
 * The month's journal and its PAYE schedule, on a sheet that prints.
 *
 * Behind its own request rather than on the page, because it reads TIN and
 * SSNIT numbers out of the personal records and those have no business on a
 * screen that is left open on a desk all afternoon.
 */
async function openReturns(month) {
  let data;
  try {
    data = await api.payrollReturns(month);
  } catch (err) {
    return toast(err.message, 'bad');
  }

  const shade = h('div.preview-shade', {
    onclick: (e) => { if (e.target === shade) shade.remove(); },
  });
  shade.append(h('div.preview-wrap.preview-wide',
    h('div.preview-bar',
      h('strong', 'Journal and PAYE schedule'),
      h('span.muted', `${niceMonth(month)} · ${data.status === 'final' ? 'closed' : 'draft'}`),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => window.print() }, 'Print or save as PDF'),
        h('button.btn-sm', { onclick: () => shade.remove() }, 'Close'))),
    h('div.preview-pages', h('div.returns-sheet', returnsSheet(data, niceMonth(month))))));

  document.body.append(shade);
  return shade;
}

// --------------------------------------------------------------------------
// The payslip
// --------------------------------------------------------------------------

/**
 * One payslip, as the page it will be printed on.
 *
 * The paper itself is in payslip.js, because a slip is drawn the same whether
 * it is opened from here or printed twenty-four at a time.
 */
function openSlip(line, data, month) {
  const page = payslipPage({ line, data, month: { key: month, nice: niceMonth(month) } });
  showPayslips([page], {
    title: line.staff.name,
    subtitle: `${niceMonth(month)} · ${data.status === 'final' ? 'closed' : 'draft'}`,
  });
}

/** Everybody's, one page each, ready for the printer. */
function openAllSlips(data, month) {
  const company = companyOf();
  const pages = data.lines.map((line) => payslipPage({
    line, data, month: { key: month, nice: niceMonth(month) }, company,
  }));
  showPayslips(pages, {
    title: `${data.lines.length} payslips`,
    subtitle: `${niceMonth(month)} · one page each`,
  });
}

/**
 * How far somebody's net pay has moved since another month.
 *
 * A column of net figures says what everybody is being paid and nothing about
 * which of them is worth a second look. Somebody's net moves for a dozen
 * reasons — a bonus month, an advance that has finished, three days of unpaid
 * leave, a rate change — and a per cent against last month is the one number
 * that finds the lines to check before the month is closed.
 */
function movementCell(against, cash) {
  if (!against) return h('span.muted', '—');
  if (against.percent === null) {
    // Nothing to be a per cent of. An infinite rise is not a number anybody
    // can act on, so it says what actually happened instead.
    return h('div',
      h('span.delta.up', '↑ new'),
      h('small.muted', { style: { display: 'block' } }, `was ${cash(against.was)}`));
  }
  return h('div',
    deltaBadge(against.percent, { higherIsBetter: true }),
    h('small.muted', { style: { display: 'block' } }, cash(against.was)));
}

/** Said under the table when the month being compared against is not settled. */
function compareNote(data) {
  const other = data.compare?.month;
  const status = data.compare?.status;
  if (!other || status === 'final') return null;

  return h('p.muted', { style: { fontSize: '.85rem' } },
    status === 'none'
      ? `${niceMonth(other)} was never run, so there is nothing to read this month against. `
        + 'Pick another month with the box above the table.'
      : `* ${niceMonth(other)} is still a draft, so the per cents are against figures that `
        + 'can still move. Close it and they settle.');
}

/**
 * Which month the net figures are read against.
 *
 * Last month by default, because that is the comparison somebody makes without
 * being asked. But the useful one is often further back: the same month last
 * year, or the month before a pay review, and a screen that can only ever
 * answer "last month" sends somebody to a spreadsheet.
 */
function comparePicker(data, month, reload) {
  const other = data.compare?.month ?? shiftMonth(month, -1);
  const box = h('input.pay-compare', {
    type: 'month',
    value: other,
    max: shiftMonth(month, -1),
    'aria-label': 'Compare each net with this month',
    onchange: (e) => {
      if (!e.target.value || e.target.value === month) return;
      reload({ compare: e.target.value });
    },
  });

  return h('div.btn-row.pay-month-pick',
    h('span.muted', { style: { fontSize: '.85rem' } }, 'vs'),
    box,
    other === shiftMonth(month, -1)
      ? null
      : h('button.btn-ghost.btn-sm', {
        title: 'Back to the month before this one',
        onclick: () => reload({ compare: null }),
      }, '↺'));
}

/** The heading over that column, saying which month it is against. */
function compareHead(data) {
  const other = data.compare?.month;
  if (!other) return 'vs.';

  const status = data.compare?.status;
  const said = status === 'none'
    ? `${niceMonth(other)} was never run, so there is nothing to read these against`
    : status === 'final'
      ? `Each net beside what ${niceMonth(other)} actually paid`
      : `Each net beside ${niceMonth(other)}, which is still a draft and can move`;

  return h('span', { title: said },
    'vs ', h('span.muted', niceMonth(other)),
    // A draft is not what anybody was paid, and the column should not be read
    // as though it were.
    status && status !== 'final' ? h('span.muted', ' *') : null);
}

/**
 * The same figure for the whole month, worked out from the lines rather than
 * asked for separately.
 *
 * Only over the people who were on both months. A property that took on four
 * people would otherwise read as a rise in everybody's pay.
 */
function wholeMonthAgainst(data) {
  const both = (data.lines ?? []).filter((line) => line.against);
  if (!both.length) return null;

  const was = both.reduce((n, line) => n + (line.against.was ?? 0), 0);
  const now = both.reduce((n, line) => n + line.net, 0);
  if (Math.abs(was) < 0.005) return null;
  return {
    was: Math.round(was * 100) / 100,
    change: Math.round((now - was) * 100) / 100,
    percent: Math.round(((now - was) / Math.abs(was)) * 1000) / 10,
  };
}

// --------------------------------------------------------------------------
// The schemes
// --------------------------------------------------------------------------

/**
 * A scheme for one department: a score against each name under it.
 *
 * Different people did different amounts of the thing the scheme is about, so
 * each of them gets their own figure.
 */
function perPersonScores(scheme, data, scored, closed, cash) {
  const rows = scheme.staffIds.map((staffId) => {
    const person = data.staff.find((s) => s.id === staffId);
    const now = scheme.scores.find((x) => x.staffId === staffId)?.score ?? 0;
    const out = h('span.muted', cash(scheme.amount * (now / 100)));

    const input = h('input.pay-score', {
      type: 'number', min: '0', max: '100', step: '1', value: now,
      disabled: closed,
      'aria-label': `${person?.name ?? 'Somebody'} on ${scheme.name}`,
      oninput: (e) => {
        const value = Math.max(0, Math.min(100, Number(e.target.value) || 0));
        scored.set(`${scheme.id}|${staffId}`, value);
        out.textContent = cash(scheme.amount * (value / 100));
      },
    });

    return h('tr',
      h('td', person?.name ?? `Staff ${staffId}`),
      h('td.num', input, h('span.muted', '%')),
      h('td.num', out));
  });

  return rows.length
    ? h('table.pay-scores', h('tbody', rows))
    : h('p.muted', { style: { fontSize: '.85rem' } }, 'Nobody is under this one yet.');
}

/**
 * A scheme that pays a set figure: what each person gets, in money.
 *
 * Not everything a property pays as a bonus is about how well something was
 * done. Housing money for four supervisors at three different figures is an
 * agreement with each of them, and asking what per cent of 500 comes to 350 is
 * arithmetic nobody should be doing at a desk.
 *
 * The scheme's own worth is the figure offered to somebody who has never been
 * set one, because most of them are the same and typing the usual figure
 * fifteen times is fifteen chances to slip.
 */
function perPersonAmounts(scheme, data, scored, closed, cash) {
  const rows = scheme.staffIds.map((staffId) => {
    const person = data.staff.find((s) => s.id === staffId);
    const held = scheme.scores.find((x) => x.staffId === staffId);
    const now = held?.award ?? scheme.amount;

    const input = h('input.med-amount', {
      type: 'number', min: '0', step: '0.01', value: now,
      disabled: closed,
      'aria-label': `What ${person?.name ?? 'somebody'} gets on ${scheme.name}`,
      oninput: (e) => {
        scored.set(`${scheme.id}|${staffId}`, Math.max(0, Number(e.target.value) || 0));
      },
    });

    // Set at once rather than only when somebody types, so pressing Save
    // writes the figure on screen. Otherwise a person shown the scheme's usual
    // amount but never touched would be saved as whatever they had before.
    scored.set(`${scheme.id}|${staffId}`, Math.max(0, Number(now) || 0));

    return h('tr',
      h('td', person?.name ?? `Staff ${staffId}`,
        held?.award == null ? h('small.muted', ' · not set yet') : null),
      h('td.num', input),
      h('td.num'));
  });

  return rows.length
    ? h('table.pay-scores', h('tbody', rows))
    : h('p.muted', { style: { fontSize: '.85rem' } }, 'Nobody is under this one yet.');
}

/**
 * A General scheme: one score, and everybody under it gets it.
 *
 * A scheme with no department is about the property rather than about a
 * person. Whether the year was a good one, whether the place got through its
 * inspection: the answer is the same for everybody it covers, so it is asked
 * once and applied to all of them.
 *
 * Where the stored scores already differ, the box opens empty and says so.
 * Guessing which of them was meant, or quietly flattening them to the first
 * one, would change what somebody is paid without anybody deciding to.
 */
function sharedScore(scheme, data, scored, closed, cash) {
  const ids = scheme.staffIds;
  if (!ids.length) {
    return h('p.muted', { style: { fontSize: '.85rem' } }, 'Nobody is under this one yet.');
  }

  const scores = ids.map((id) => scheme.scores.find((x) => x.staffId === id)?.score ?? 0);
  const same = scores.every((n) => n === scores[0]);
  const now = same ? scores[0] : null;

  const out = h('strong', cash(scheme.amount * ((now ?? 0) / 100)));
  const each = h('span.muted', now === null ? 'once they all agree' : 'each, to all of them');

  const input = h('input.pay-score', {
    type: 'number', min: '0', max: '100', step: '1',
    value: now === null ? '' : now,
    placeholder: now === null ? '—' : '',
    disabled: closed,
    'aria-label': `Everybody on ${scheme.name}`,
    oninput: (e) => {
      const value = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      for (const id of ids) scored.set(`${scheme.id}|${id}`, value);
      out.textContent = cash(scheme.amount * (value / 100));
      each.textContent = 'each, to all of them';
    },
  });

  const names = ids
    .map((id) => String(data.staff.find((s) => s.id === id)?.name ?? '').trim().split(/\s+/)[0])
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  return h('div.pay-shared',
    h('div.pay-shared-set',
      h('label', 'Everybody on it scores'),
      input,
      h('span.muted', '%'),
      out,
      each),
    now === null
      ? h('p.pay-shared-mixed',
        'The scores on this one are not all the same at the moment. Typing a figure here sets '
        + 'it for everybody; leaving it alone changes nothing.')
      : null,
    h('p.muted.pay-shared-who',
      `${ids.length} ${ids.length === 1 ? 'person' : 'people'}: ${names.join(', ')}`));
}

function schemesCard(data, month, closed, reload, cash) {
  const scored = new Map();

  return card('Bonus schemes', {
    wide: true,
    note: data.schemes.length ? `${data.schemes.length}` : 'none yet',
    actions: h('button.btn-sm.btn-primary', {
      onclick: () => editScheme(null, data, reload),
    }, 'New scheme'),
  },
  h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
    'A scheme either pays a share of one figure, scored per person, or a set figure agreed '
    + 'with each of them. Both are net: what somebody actually receives, with the tax on it '
    + 'carried by the property. Somebody can be under several schemes or under none.'),

  data.schemes.length
    // Folded. A property with nine schemes across four departments opened on a
    // page of score boxes, and the month's figures were three screens down.
    ? schemesByDepartment(data.schemes).map((group) => h('details.pay-scheme-group',
    h('summary.pay-scheme-dept',
      h('span', group.name),
      h('small.muted', `${group.schemes.length} scheme${group.schemes.length === 1 ? '' : 's'}`)),
    group.schemes.map((scheme) => {
      // A scheme that covers the whole property is scored once. It is not
      // twenty people who happen to agree; it is one figure about the
      // property, and typing it twenty times is twenty chances to differ.
      const everybody = schemeDepartments(scheme).length === 0;

      const body = scheme.kind === 'amount'
        ? perPersonAmounts(scheme, data, scored, closed, cash)
        : everybody
          ? sharedScore(scheme, data, scored, closed, cash)
          : perPersonScores(scheme, data, scored, closed, cash);

      return h('div.pay-scheme',
        h('div.pay-scheme-head',
          h('div',
            h('strong', scheme.name),
            h('span.muted', scheme.kind === 'amount'
              ? ` · ${cash(scheme.amount)} unless somebody is set a different figure`
              : ` · ${cash(scheme.amount)} at 100%`),
            scheme.note ? h('div.muted', scheme.note) : null),
          h('div.btn-row',
            h('button.btn-sm', { onclick: () => editScheme(scheme, data, reload) }, 'Edit'),
            h('button.btn-ghost.btn-sm', {
              title: 'Take this scheme off the books',
              onclick: async () => {
                if (!confirmAction(`Remove ${scheme.name}? Payslips already issued keep what `
                  + 'they paid.')) return;
                await api.payrollRemoveScheme(scheme.id);
                toast('Removed.', 'good');
                await reload();
              },
            }, '✕'))),
        body);
    })))
    : null,

  data.schemes.length && !closed
    ? h('div.btn-row', { style: { marginTop: '.6rem' } },
      h('button.btn.btn-primary', {
        onclick: async (e) => {
          // One box per person either way. What it holds is a score on a
          // scored scheme and money on one that pays a set figure, so both go
          // and the server reads whichever its scheme calls for.
          const rows = [...scored.entries()].map(([key, value]) => {
            const [schemeId, staffId] = key.split('|').map(Number);
            return { schemeId, staffId, score: value, amount: value };
          });
          if (!rows.length) { toast('Nothing has been entered yet.', 'warn'); return; }
          e.target.disabled = true;
          try {
            await api.payrollScores({ month, rows });
            toast(`${rows.length} saved.`, 'good');
            await reload();
          } catch (err) {
            e.target.disabled = false;
            toast(err.message, 'bad');
          }
        },
        // Named for what is actually on the screen. A property whose only
        // schemes pay a set figure has not scored anything.
      }, data.schemes.every((s) => s.kind === 'amount') ? 'Save the figures' : 'Save the scores'))
    : null);
}

async function editScheme(scheme, data, reload) {
  const picked = new Set(scheme?.staffIds ?? []);

  // The departments the property already has, off the staff list, plus
  // whatever this scheme is under in case those have since emptied.
  const departments = [...new Set([
    ...data.staff.map((person) => person.department).filter(Boolean),
    ...schemeDepartments(scheme),
  ])].sort((a, b) => a.localeCompare(b));

  // Ticks rather than a dropdown, because a scheme can cover two: the kitchen
  // and the bistro share a service bonus, and filing it under one of them left
  // the other half of the staff ticked in as strays.
  const chosen = new Set(schemeDepartments(scheme));
  const departmentPick = h('div.works-picker', departments.length
    ? departments.map((name) => h('label.tickline',
      h('input', {
        type: 'checkbox',
        checked: chosen.has(name),
        onchange: (e) => {
          if (e.target.checked) chosen.add(name); else chosen.delete(name);
          drawList();
        },
      }),
      h('span', name)))
    : h('p.muted', { style: { fontSize: '.85rem', margin: 0 } },
      'No departments on the staff list yet, so this one covers everybody.'));

  // Scored, or a set figure each. Two genuinely different things, and the
  // second was being forced through the first: somebody working out what per
  // cent of 500 comes to 350 so that four supervisors could be paid what they
  // were promised.
  const kindPick = h('select', { name: 'kind' },
    h('option', { value: 'score', selected: scheme?.kind !== 'amount' },
      'Scored out of a hundred'),
    h('option', { value: 'amount', selected: scheme?.kind === 'amount' },
      'A set figure for each person'));

  const worth = h('span', scheme?.kind === 'amount' ? 'The usual figure' : 'Worth at 100%');
  const worthNote = h('small.muted', scheme?.kind === 'amount'
    ? 'Offered to anybody who has not been set their own. Change theirs on the payroll screen'
    : 'What somebody gets at a hundred per cent');
  kindPick.addEventListener('change', () => {
    const paid = kindPick.value === 'amount';
    worth.textContent = paid ? 'The usual figure' : 'Worth at 100%';
    worthNote.textContent = paid
      ? 'Offered to anybody who has not been set their own. Change theirs on the payroll screen'
      : 'What somebody gets at a hundred per cent';
  });

  const list = h('div.pos-edit-list');
  const note = h('p.muted.scheme-who-note', { style: { fontSize: '.8rem' } });

  /**
   * Who can be under it.
   *
   * A scheme for the kitchen is scored on kitchen work, so the list is the
   * kitchen. Scrolling past everybody else to find four names is how the wrong
   * person gets ticked, and a scheme is money.
   *
   * SOMEBODY ALREADY TICKED IS NEVER HIDDEN. A person moves department, or the
   * scheme is moved to another one, and they are still under it until somebody
   * says otherwise. Dropping them off the list would take their bonus away
   * without anybody deciding to, so they stay on it and are marked as being
   * from somewhere else.
   */
  function drawList() {
    const want = [...chosen];
    const covers = (person) => !want.length || want.includes(person.department);
    const shown = data.staff.filter((person) => covers(person) || picked.has(person.id));

    const strays = shown.filter((p) => want.length && !covers(p)).length;

    list.replaceChildren(...(shown.length
      ? shown.map((person) => {
        const elsewhere = want.length && !covers(person);
        return h('label.tickline', { class: elsewhere ? 'is-elsewhere' : '' },
          h('input', {
            type: 'checkbox',
            checked: picked.has(person.id),
            onchange: (e) => {
              if (e.target.checked) picked.add(person.id); else picked.delete(person.id);
            },
          }),
          h('span', person.name,
            person.department ? h('small.muted', ` · ${person.department}`) : null));
      })
      : [h('p.muted', { style: { fontSize: '.85rem', margin: 0 } },
        `Nobody is in ${sayDepartments(want)} at the moment.`)]));

    note.textContent = want.length
      ? (strays
        ? `${sayDepartments(want)} only, and ${strays} already under it from elsewhere. `
          + 'Untick anybody who should not be.'
        : `${sayDepartments(want)} only. Tick nothing to put the whole property under it.`)
      : 'Everybody, because a scheme with no department covers the whole property.';
  }
  drawList();

  const done = await formDialog({
    title: scheme ? `The ${scheme.name} scheme` : 'A new bonus scheme',
    submitLabel: scheme ? 'Save it' : 'Make it',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'What it is worth is a net figure — what somebody actually receives at a hundred per '
        + 'cent. The tax on it is worked out at payroll and carried by the property.'),
      field('Called', h('input', {
        type: 'text', name: 'name', maxlength: 80, required: true, value: scheme?.name ?? '',
      })),
      field('How it pays', kindPick,
        'Scored is a share of one figure, worked out from how well somebody did. A set '
        + 'figure is money agreed with each person and nothing to do with performance'),
      // Built by hand rather than through field(), because both the label and
      // the hint change when the kind above does.
      h('label.field', worth, h('input', {
        type: 'number', name: 'amount', step: '0.01', min: '0', required: true,
        value: scheme?.amount ?? '',
      }), worthNote),
      field('What it is for', h('input', {
        type: 'text', name: 'note', maxlength: 300, value: scheme?.note ?? '',
      })),
      field('Departments', departmentPick,
        'Tick every one it covers, and more than one is fine. Tick nothing and it covers the '
        + `whole property, where it is grouped under ${GENERAL} and scored once`),
      h('p.muted', { style: { fontSize: '.85rem', marginBottom: '.2rem' } }, 'Who is under it'),
      note,
      list),
    onSubmit: (form) => api.payrollScheme({
      id: scheme?.id ?? null,
      name: form.get('name'),
      amount: form.get('amount'),
      kind: form.get('kind'),
      note: form.get('note'),
      departments: [...chosen],
      staffIds: [...picked],
    }),
  });
  if (!done) return;
  toast(`${done.name}: ${done.people} ${done.people === 1 ? 'person' : 'people'}.`, 'good');
  await reload();
}

// --------------------------------------------------------------------------
// Misconduct
// --------------------------------------------------------------------------

function penaltiesCard(data, month, closed, reload, cash) {
  return card('Off the bonus', {
    wide: true,
    note: data.penalties.length ? `${data.penalties.length} this month` : 'nothing this month',
    actions: closed ? null : h('button.btn-sm', {
      onclick: () => addPenalty(data, month, reload),
    }, 'Take money off'),
  },
  h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
    'A net figure, off the bonus rather than off the salary, and it shows on the payslip with '
    + 'the reason beside it. The person is told the day it is entered rather than on payday.'),

  data.penalties.length
    ? h('ul.adv-requests', data.penalties.map((p) => {
      const person = data.staff.find((s) => s.id === p.staffId);
      return h('li',
        h('div',
          h('div.adv-who', person?.name ?? `Staff ${p.staffId}`),
          h('div.muted', p.reason)),
        h('div.btn-row',
          h('strong', cash(p.amount)),
          closed ? null : h('button.btn-ghost.btn-sm', {
            title: 'Put it back',
            onclick: async () => {
              await api.payrollRemovePenalty(p.id);
              toast('Put back.', 'good');
              await reload();
            },
          }, '✕')));
    }))
    : null);
}

async function addPenalty(data, month, reload) {
  const done = await formDialog({
    title: 'Take money off a bonus',
    submitLabel: 'Take it off',
    body: h('div',
      field('Who', h('select', { name: 'staffId', required: true },
        h('option', { value: '' }, 'Choose somebody'),
        data.staff.filter((s) => s.onPayroll)
          .map((s) => h('option', { value: s.id }, s.name)))),
      field('How much', h('input', {
        type: 'number', name: 'amount', step: '0.01', min: '0.01', required: true,
      }), 'A net figure — what they lose in hand'),
      field('What happened', h('input', {
        type: 'text', name: 'reason', maxlength: 300, required: true,
      }), 'This goes on their payslip and into the message they get')),
    onSubmit: (form) => api.payrollPenalty({
      month,
      staffId: form.get('staffId'),
      amount: form.get('amount'),
      reason: form.get('reason'),
    }),
  });
  if (!done) return;
  toast('Taken off. They have been told.', 'good');
  await reload();
}

// --------------------------------------------------------------------------
// Who is on the payroll
// --------------------------------------------------------------------------

function peopleCard(data, reload, cash) {
  const on = data.staff.filter((s) => s.onPayroll);

  return card('Who is on the payroll', {
    wide: true,
    note: `${on.length} of ${data.staff.length}`,
    actions: h('button.btn-sm', { onclick: () => editPeople(data, reload) }, 'Set pay and allowances'),
  },
  on.length
    ? h('div.table-wrap', h('table',
      h('thead', h('tr',
        h('th', 'Name'), h('th.num', 'Basic'), h('th', 'Allowances'), h('th', 'SSNIT'),
      )),
      h('tbody', on.map((person) => h('tr',
        h('td', person.name, h('small.muted', person.department ? ` · ${person.department}` : '')),
        h('td.num', cash(person.basic)),
        h('td', person.allowances.length
          ? person.allowances.map((a) => `${a.name} ${cash(a.amount)}`).join(' · ')
          : h('span.muted', 'none')),
        h('td', person.ssnit ? h('span.pill.good', 'yes') : h('span.pill', 'no')))))))
    : h('p.muted', 'Nobody yet.'));
}

/**
 * Everybody's pay, in one form.
 *
 * The allowances are the awkward part: they are a list per person, and a
 * dialog with twenty-four nested lists in it is unusable. So the table sets
 * the basic and the SSNIT flag, and allowances are edited one person at a
 * time from the same row.
 */
async function editPeople(data, reload) {
  const state = new Map(data.staff.map((s) => [s.id, {
    onPayroll: s.onPayroll,
    basic: s.basic ?? 0,
    ssnit: s.ssnit,
    allowances: s.allowances.map((a) => ({ ...a })),
  }]));

  const rows = data.staff.map((person) => {
    const mine = state.get(person.id);

    const basic = h('input.med-amount', {
      type: 'number', step: '0.01', min: '0', value: mine.basic || '',
      'aria-label': `${person.name}'s basic salary`,
      onchange: (e) => { mine.basic = Number(e.target.value) || 0; },
    });
    const ssnit = h('input', {
      type: 'checkbox', checked: mine.ssnit,
      'aria-label': `${person.name} pays SSNIT`,
      onchange: (e) => { mine.ssnit = e.target.checked; },
    });
    const allowanceCount = h('span.muted',
      mine.allowances.length ? `${mine.allowances.length}` : 'none');

    const tick = h('input', {
      type: 'checkbox', checked: mine.onPayroll,
      'aria-label': `${person.name} is on the payroll`,
      onchange: (e) => {
        mine.onPayroll = e.target.checked;
        basic.disabled = !e.target.checked;
        ssnit.disabled = !e.target.checked;
        line.classList.toggle('adv-skipped', !e.target.checked);
      },
    });
    basic.disabled = !mine.onPayroll;
    ssnit.disabled = !mine.onPayroll;

    const line = h(`tr${mine.onPayroll ? '' : '.adv-skipped'}`,
      h('td', h('label.tickline', tick, h('span', person.name))),
      h('td.num', basic),
      h('td', h('label.tickline', ssnit, h('span', 'SSNIT'))),
      h('td.num',
        allowanceCount,
        h('button.btn-sm', {
          type: 'button',
          style: { marginLeft: '.4rem' },
          onclick: async () => {
            const next = await editAllowances(person, mine.allowances, data);
            if (!next) return;
            mine.allowances = next;
            allowanceCount.textContent = next.length ? `${next.length}` : 'none';
          },
        }, 'Allowances')));
    return line;
  });

  const done = await formDialog({
    title: 'Pay and allowances',
    submitLabel: 'Save the payroll',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Tick everybody the payroll covers and give their monthly basic. SSNIT is 5.5% from '
        + 'them and 13% from the property, on basic salary alone — untick it for anybody it '
        + 'does not apply to.'),
      h('div.table-wrap.med-set-wrap', h('table.med-set',
        h('thead', h('tr',
          h('th', 'On the payroll'), h('th.num', 'Basic'), h('th', ''), h('th.num', 'Allowances'),
        )),
        h('tbody', rows)))),
    onSubmit: async () => api.payrollProfiles({
      rows: [...state.entries()].map(([staffId, v]) => ({
        staffId,
        onPayroll: v.onPayroll,
        basic: v.basic,
        ssnit: v.ssnit,
        allowances: v.allowances,
      })),
    }),
  });
  if (!done) return;
  toast(`${done.set} on the payroll.`, 'good');
  await reload();
}

/** One person's allowances, added a line at a time. */
async function editAllowances(person, current, data) {
  const rows = [];
  const list = h('div.med-lines');
  const cash = (n) => money(n, data.currency);
  const total = h('div.med-total');

  const retotal = () => {
    const sum = rows.reduce((n, r) => n + (Number(r.amount.value) || 0), 0);
    total.textContent = `${rows.length} · ${cash(sum)}`;
  };

  const addRow = (existing = null) => {
    const name = h('input', {
      type: 'text', maxlength: 60, placeholder: 'Transport', value: existing?.name ?? '',
      'aria-label': 'What the allowance is',
    });
    const amount = h('input', {
      type: 'number', step: '0.01', min: '0', value: existing?.amount ?? '',
      'aria-label': 'How much', oninput: retotal,
    });
    const taxable = h('input', {
      type: 'checkbox', checked: existing ? existing.taxable !== false : true,
      'aria-label': 'Taxable',
    });

    const row = { name, amount, taxable };
    const line = h('div.med-line',
      h('div.med-line-main', name, amount),
      h('div.med-line-file',
        h('label.tickline', taxable, h('span', 'Taxable')),
        h('button.btn-ghost.btn-sm', {
          type: 'button',
          'aria-label': 'Take it off',
          onclick: () => {
            const at = rows.indexOf(row);
            if (at >= 0) rows.splice(at, 1);
            line.remove();
            retotal();
          },
        }, '✕')));

    rows.push(row);
    list.append(line);
    retotal();
  };

  for (const allowance of current) addRow(allowance);
  if (!current.length) addRow();

  const done = await formDialog({
    title: `${person.name}’s allowances`,
    submitLabel: 'Keep these',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'One line each, because a payslip has to say what the money was for. Untick taxable '
        + 'for a genuine reimbursement — everything else is taxed with the salary.'),
      list,
      h('div.med-line-foot',
        h('button.btn-sm', { type: 'button', onclick: () => addRow() }, 'Add another'),
        total)),
    onSubmit: async () => rows
      .filter((r) => r.name.value.trim() && Number(r.amount.value) > 0)
      .map((r) => ({
        name: r.name.value.trim(),
        amount: Number(r.amount.value),
        taxable: r.taxable.checked,
      })),
  });
  return done ?? null;
}

// --------------------------------------------------------------------------

async function close(month, data, reload, cash) {
  const t = data.totals;
  const done = await formDialog({
    title: `Close ${niceMonth(month)}`,
    submitLabel: 'Close it',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Every payslip is written down exactly as it stands, and the advance deductions are '
        + 'recorded against the balances they come off. After this nothing here recomputes.'),
      h('table.slip-table', h('tbody',
        h('tr', h('td', 'People'), h('td.num', String(t.people))),
        h('tr', h('td', 'Gross'), h('td.num', cash(t.gross))),
        h('tr', h('td', 'PAYE to the GRA'), h('td.num', cash(t.paye))),
        h('tr', h('td', 'SSNIT, both halves'), h('td.num', cash(t.ssnitEmployee + t.ssnitEmployer))),
        h('tr', h('td', 'Advances recovered'), h('td.num', cash(t.loans))),
        h('tr.slip-sum', h('td', h('strong', 'Net to pay')), h('td.num', h('strong', cash(t.net)))),
        h('tr', h('td', 'Cost to the property'), h('td.num', cash(t.cost))))),
      field('Anything to note', h('input', { type: 'text', name: 'note', maxlength: 300 }))),
    onSubmit: (form) => api.payrollClose({ month, note: form.get('note') }),
  });
  if (!done) return;
  toast(`${niceMonth(month)} closed. ${done.people} payslips.`, 'good');
  await reload();
}

const tile = (label, value, sub) => h('div.stat',
  h('div.stat-label', label),
  h('div.stat-value', value),
  h('div.stat-sub', sub));
