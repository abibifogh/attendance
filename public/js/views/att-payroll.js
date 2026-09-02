import { api } from '../api.js';
import {
  confirmAction, deltaBadge, fmtNum, h, keepPlace, money, monthOf, mount, shiftMonth, toast,
  todayISO,
} from '../util.js';
import { bulkUpload, card, dropdownMenu, emptyState } from './components.js';
import {
  GENERAL, field, formDialog, sayDepartments, sayTiers, schemeDepartments, schemesByDepartment,
  showSheet,
} from './att-shared.js';
import { holdRefresh, replaceParams, warnBeforeLeaving } from '../app.js';
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

/**
 * Which department groups are open, kept across a redraw.
 *
 * Saving scores redraws the whole screen. Folding every department away each
 * time means opening them again before the next figure can be typed, on a
 * screen whose whole job is typing figures.
 */
const openGroups = new Set();

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
    // Called with no arguments after a save: whoever pressed it has not moved,
    // so the page should not either. Called with arguments because a control
    // was pressed, and a fresh month starts at the top.
    const stayed = Object.keys(next).length === 0;
    const putBack = stayed ? keepPlace() : null;
    replaceParams('att-payroll', merged);
    mount(host, await renderAttPayroll(merged));
    if (putBack) putBack();
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
        tile('Net to pay', cash(data.totals.net), netSplit(data)),
        tile('Cost to the property', cash(data.totals.cost),
          `including ${cash(data.totals.ssnitEmployer)} employer SSNIT`))
      : null,

    onPayroll.length ? noAccountWarning(data) : null,

    onPayroll.length
      ? card('The month', {
        wide: true,
        // Which state the month is in, in a colour rather than a sentence. It
        // is the one thing about this card somebody checks at a glance, and
        // the sentence explaining what a draft is was explaining it every
        // month to people who found out in the first one.
        note: closed
          ? h('span.pill.good', 'Closed')
          : h('span.pill.warn', 'Draft'),
        actions: h('div.btn-row',
          comparePicker(data, month, reload),
          exportButton(data, month, closed),
          data.slips
            ? h('button.btn-sm', { onclick: () => openAllSlips(data, month) },
              'Download slips')
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
          h('td.num', cash(line.basic),
            line.partMonth
              ? h('small.muted', { style: { display: 'block' } }, `${line.partMonth.days} of ${line.partMonth.of} days`)
              : null),
          // The allowances and the bonus as the payslip says them: the bonus is
          // what was agreed, and the tax the property carried on it sits with
          // the allowances. The row still adds to the same gross either way,
          // and a screen that disagreed with the payslip is a question nobody
          // should have to answer twice.
          h('td.num', line.slip?.allowanceTotal || line.allowanceTotal
            ? h('div',
              cash(line.slip?.allowanceTotal ?? line.allowanceTotal),
              line.slip?.carried
                ? h('small.muted', ` with ${cash(line.slip.carried)} on the bonus`)
                : null)
            : h('span.muted', '—')),
          h('td.num', line.bonus.net
            ? h('div',
              cash(line.bonus.net),
              line.bonus.docked ? h('small.muted', ` less ${cash(line.bonus.docked)}`) : null)
            : h('span.muted', '—')),
          h('td.num', h('strong', cash(line.gross))),
          h('td.num', line.ssnit.employee ? cash(line.ssnit.employee) : h('span.muted', '—')),
          h('td.num', cash(line.paye.total)),
          h('td.num', line.loanTotal ? cash(line.loanTotal) : h('span.muted', '—')),
          h('td.num', h('strong', cash(line.net))),
          h('td.num', movementCell(line.against, cash)),
          h('td.num.off-phone', costCell(line.employerCost, line.againstCost, cash)))),
          h('tr.pay-total',
            h('td', h('strong', 'Everybody')),
            h('td.num', cash(data.totals.basic)),
            h('td.num', cash(data.totals.allowancesOnSlip ?? data.totals.allowances)),
            h('td.num', cash(data.totals.bonusNet)),
            h('td.num', h('strong', cash(data.totals.gross))),
            h('td.num', cash(data.totals.ssnitEmployee)),
            h('td.num', cash(data.totals.paye)),
            h('td.num', cash(data.totals.loans)),
            h('td.num', h('strong', cash(data.totals.net))),
            h('td.num', movementCell(wholeMonthAgainst(data), cash)),
            h('td.num.off-phone',
              costCell(data.totals.cost, wholeMonthAgainst(data, 'cost'), cash)))))),
        compareNote(data),
        takeHomeNote(data, cash),
        advanceNote(data, cash),
        advancesMovedOn(data, cash),
        h('p.muted', { style: { fontSize: '.85rem' } }, data.slips
          ? 'Press a row for the payslip behind it.'
          : 'Payslips are an administrator\u2019s to open. The figures here are what the '
            + 'month comes to; what makes each of them up is on the slip.'))
      : emptyState('Nobody is on the payroll yet',
        'Say what each person is paid and whether SSNIT applies to them, and the month works '
        + 'itself out.'),

    schemesCard(data, month, closed, reload, cash),
    penaltiesCard(data, month, closed, reload, cash),
    severanceCard(data, month, closed, reload, cash),
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
/**
 * The two ways a month leaves the app, under one button.
 *
 * They were side by side on the bar as Print this table and Excel, which reads
 * as two unrelated things when they are one job with a choice of file. PDF is
 * the browser's own print dialog, because Save as PDF is a destination in it
 * on every platform and a second way of making one would only disagree with
 * the first.
 */
/**
 * Which allowances were worked out rather than agreed.
 *
 * Worth one quiet line rather than a column: on a property that does this for
 * everybody it is simply how the payroll works and nobody needs telling twice.
 * The people worth naming are the ones it could not be done for.
 */
function takeHomeNote(data, cash) {
  const worked = (data.lines ?? []).filter((l) => l.takeHome != null);
  if (!worked.length) return null;

  // Their basic and their bonus already carry them past the figure agreed with
  // them, so there is no allowance to add and nothing is taken off them to get
  // back down to it. Somebody has to look at that.
  const over = worked.filter((l) => l.overshoots);
  const one = over.length === 1;

  return h('p.muted', { style: { fontSize: '.85rem' } },
    worked.length === 1
      ? 'One allowance is worked out from an agreed take-home rather than entered. '
      : `${worked.length} allowances are worked out from an agreed take-home rather than `
        + 'entered. ',
    over.length
      ? h('span',
        over.map((l, at) => h('span', at ? ', ' : '', h('strong', l.staff.name))),
        one ? ' already takes home more than that' : ' already take home more than that',
        ' on basic and bonus alone, so ',
        one ? 'they get' : 'they get',
        ' no allowance. Nothing is taken off anybody to bring them back down.')
      : 'Change what somebody is on under Set pay and allowances.');
}

/**
 * Why the Advance column is empty against somebody who has one running.
 *
 * A dash there is four different situations wearing the same face: it has not
 * started yet, it was let go this month, it was already recorded, or there is
 * no month set for it to start at all. The first is normal and the last is a
 * record somebody has to fix, and until this line existed the only way to tell
 * them apart was to open the Advances screen and work it out.
 */
const NOT_DUE = {
  no_start: 'no month set for it to start',
  let_go: 'let go this month',
  not_on_payroll: 'not on the payroll, so there is nothing for it to come off',
};

function advanceNote(data, cash) {
  const rows = data.advancesNotDue ?? [];
  if (!rows.length) return null;

  const say = (row) => (row.why === 'not_yet' && row.from
    ? `not until ${niceMonth(row.from)}`
    : NOT_DUE[row.why] ?? 'not due this month');

  // Said once at the end rather than against each name, because it is the same
  // instruction however many people it applies to.
  const missing = rows.filter((row) => row.why === 'not_on_payroll');

  return h('p.muted', { style: { fontSize: '.85rem' } },
    rows.length === 1
      ? 'One advance is running with nothing coming off it this month: '
      : `${rows.length} advances are running with nothing coming off them this month: `,
    rows.map((row, at) => h('span', at ? '; ' : '',
      h('strong', row.name),
      `, ${say(row)}`,
      row.left ? ` (${cash(row.left)} left)` : '')),
    '.',
    missing.length
      ? ' Say what they are paid under Who is on the payroll, and the deduction comes off '
        + 'next time this month is worked out.'
      : '');
}

/**
 * A closed month whose advances have been edited since it was closed.
 *
 * The table on a closed month is the snapshot that was written, which is the
 * whole point of closing one. But somebody who has just let a month go on the
 * Advances page and come back to find the deduction still sitting there has
 * been told nothing, and will reasonably conclude the app ignored them.
 */
function advancesMovedOn(data, cash) {
  const rows = data.advancesChanged ?? [];
  if (!rows.length) return null;

  return h('p.muted', { style: { fontSize: '.85rem' } },
    h('strong', 'This month is closed, so the advances above are as they were written. '),
    rows.length === 1 ? 'One has been changed since: ' : `${rows.length} have been changed since: `,
    rows.map((row, at) => h('span', at ? '; ' : '',
      h('strong', row.name),
      ` ${cash(row.was)} here, ${cash(row.now)} on the books now`)),
    '. Reopen the month and close it again to take that up.');
}

/**
 * What the net figure is actually made of, once it leaves the building.
 *
 * "What goes out to people" was true and told nobody anything. How many of it
 * goes by transfer and how many has to be handed over is the thing somebody
 * needs before they set a morning aside for it.
 */
function netSplit(data) {
  const bank = data.bank;
  if (!bank) return 'what goes out to people';
  if (!bank.byHand) return `${bank.toBank} by transfer`;
  if (!bank.toBank) return `${bank.byHand} paid by hand`;
  return `${bank.toBank} by transfer · ${bank.byHand} by hand`;
}

/**
 * Somebody the property means to pay by bank and cannot.
 *
 * This is the one thing about the bank file worth interrupting somebody over.
 * Every figure against them on the payroll is right, so nothing on this screen
 * looks wrong, and the first anybody hears of it is the person asking on the
 * second of the month where their money is. Named rather than counted: three
 * people is not something anybody can act on, three names is.
 */
function noAccountWarning(data) {
  const names = data.bank?.missing ?? [];
  if (!names.length) return null;

  return h('div.alert.warn',
    h('span.alert-icon', '🏦'),
    h('div',
      h('div.alert-title', names.length === 1
        ? `${names[0]} is down to be paid by bank and has no account number`
        : `${names.length} people are down to be paid by bank and have no account number`),
      h('div.alert-detail',
        (names.length === 1 ? 'They are ' : `${names.join(', ')} are `)
        + 'left off the bank file, so nothing reaches them. Put the account number on their '
        + 'record under People, or change how they are paid.')));
}

function exportButton(data, month, closed) {
  return dropdownMenu({
    label: 'Export',
    title: 'Take the month away as a file',
    items: [
      {
        label: 'PDF',
        title: 'Opens the print dialog, where Save as PDF is one of the destinations',
        onClick: () => printReport({
          title: `Payroll, ${niceMonth(month)}`,
          subtitle: data.property || '',
          note: `${data.rates.label}. ${closed ? 'Closed' : 'Draft'}.`,
        }),
      },
      {
        label: 'Excel',
        title: 'The month, the journal and the GRA schedule as one workbook',
        href: `/api/payroll/book?month=${encodeURIComponent(month)}`,
      },
      {
        label: 'Bank file (Excel)',
        title: 'Just the net pays and the account numbers, with the people paid by hand '
          + 'listed on their own sheet',
        href: `/api/payroll/bank?month=${encodeURIComponent(month)}`,
      },
      {
        label: 'Bank file (CSV)',
        title: 'The transfers on their own, bare, for uploading to the bank',
        href: `/api/payroll/bank?month=${encodeURIComponent(month)}&as=csv`,
      },
    ],
  });
}

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
  const wanted = read.willCreate ?? { allowances: [], schemes: [] };

  // An allowance or a bonus scheme the property has not got. A file naming one
  // is the ordinary way a property that already runs it gets it in, but making
  // it is a decision — so it is named, and off until somebody ticks it.
  const make = h('input', { type: 'checkbox' });

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

      tally.creating
        ? h('div.alert.warn',
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', `${tally.creating} new `
              + `${tally.creating === 1 ? 'thing' : 'things'} this file names`),
            h('ul.pay-import-changes',
              wanted.allowances.map((name) => h('li', h('strong', name), ' — an allowance')),
              wanted.schemes.map((s) => h('li', h('strong', s.name),
                ' — a bonus scheme paying a set figure, covering everybody the file gives a '
                + 'figure for'))),
            h('label.tickline', { style: { marginTop: '.4rem' } }, make,
              h('span', 'Make them')),
            h('div.alert-detail', 'Leave it unticked and those columns are left alone, the '
              + 'same as any column nobody recognised.')))
        : null,

      read.unknown.length
        ? h('div.returns-warn',
          h('strong', 'Columns nobody recognised, so they were left alone'),
          h('div', read.unknown.join(', ')),
          h('div.muted', 'An allowance column has to say so: “Allowance: Transport”. A bonus '
            + 'column names the scheme: “Bonus: Housing” for a set figure, or “Score: Guest '
            + 'scores” for one that is scored. A scored scheme cannot be made from a sheet, '
            + 'because a column of percentages does not say what the scheme is worth.'))
        : null,

      read.skipped.length
        ? h('div.returns-warn',
          h('strong', `${read.skipped.length} line${read.skipped.length === 1 ? '' : 's'} skipped`),
          h('ul', read.skipped.map((row) => h('li',
            `Line ${row.at}: ${row.name || row.employeeNo || 'blank'} · ${row.why}`))))
        : null,

      lines.length ? h('div.pay-import-list', lines) : null),

    onSubmit: () => (tally.changes
      ? api.payrollApplyInput({ month, text, create: make.checked })
      : Promise.resolve({ basics: 0, allowances: 0, scores: 0 })),
  });

  if (!done) return;
  const bits = [];
  const created = (done.made?.allowances?.length ?? 0) + (done.made?.schemes?.length ?? 0);
  if (created) bits.push(`${created} made`);
  if (done.basics) bits.push(`${done.basics} salaries`);
  if (done.allowances) bits.push(`${done.allowances} allowances`);
  if (done.scores) bits.push(`${done.scores} scores`);
  // What it named and was not allowed to make, so an untouched column is never
  // just an absence somebody has to notice.
  if (done.notMade?.length) {
    toast(`Left alone, nothing was made for them: ${done.notMade.join(', ')}.`, 'warn');
  }
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
        dropdownMenu({
          label: 'Export',
          title: 'Take the journal and the schedule away',
          items: [
            { label: 'PDF', onClick: () => window.print(), title: 'Opens the print dialog, where Save as PDF is one of the destinations' },
            { label: 'Excel', href: `/api/payroll/book?month=${encodeURIComponent(month)}`, title: 'The month, the journal and the GRA schedule as one workbook' },
          ],
        }),
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

/**
 * What the month cost, and whether it cost more than the last one.
 *
 * The net and the cost move apart, which is the point of showing both: paying
 * a bonus gross rather than net, or taking somebody off SSNIT, costs the
 * property less without changing anybody's pay. A wage bill read only through
 * the net never shows that.
 *
 * Down is the good direction here, which is the opposite of the net beside it,
 * so the arrow is coloured the other way round.
 */
function costCell(now, against, cash) {
  if (!against || against.percent === null) return cash(now);
  return h('div',
    h('div', cash(now)),
    h('small.muted', { style: { display: 'block' } },
      deltaBadge(against.percent, { higherIsBetter: false }),
      ' ',
      cash(against.was)));
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
function wholeMonthAgainst(data, what = 'net') {
  const key = what === 'cost' ? 'againstCost' : 'against';
  const figure = (line) => (what === 'cost' ? line.employerCost : line.net);
  const both = (data.lines ?? []).filter((line) => line[key]);
  if (!both.length) return null;

  const was = both.reduce((n, line) => n + (line[key].was ?? 0), 0);
  const now = both.reduce((n, line) => n + figure(line), 0);
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
function perPersonScores(scheme, data, scored, typed, closed, cash) {
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
        typed.add(`${scheme.id}|${staffId}`);
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
/**
 * A rung each, off the scheme's own ladder.
 *
 * A list rather than a box, because the scores are the agreement: Nkosoɔ pays
 * for a 1 through a 10 and nothing else, and a box would let somebody type a
 * 12 and find out it was refused after they had done twenty of them. Picking
 * shows the money beside the score, which is the pair somebody is actually
 * deciding between.
 */
function perPersonTiers(scheme, data, scored, typed, closed, cash) {
  const rungs = scheme.tiers ?? [];
  if (!rungs.length) {
    return h('p.muted', { style: { fontSize: '.85rem' } },
      'This one has no scores set yet. Edit it and say what each score is worth.');
  }

  const rows = scheme.staffIds.map((staffId) => {
    const person = data.staff.find((s) => s.id === staffId);
    const held = scheme.scores.find((x) => x.staffId === staffId);
    const now = held?.tier ?? null;

    const worth = h('span.muted');
    const say = (value) => {
      const rung = rungs.find((t) => t.score === Number(value));
      worth.textContent = rung ? cash(rung.amount) : '';
    };

    const pick = h('select.pay-tier', {
      disabled: closed,
      'aria-label': `What ${person?.name ?? 'somebody'} scored on ${scheme.name}`,
      onchange: (e) => {
        const value = e.target.value === '' ? null : Number(e.target.value);
        if (value == null) scored.delete(`${scheme.id}|${staffId}`);
        else scored.set(`${scheme.id}|${staffId}`, value);
        typed.add(`${scheme.id}|${staffId}`);
        say(e.target.value);
      },
    },
    h('option', { value: '', selected: now == null }, 'Not scored yet'),
    rungs.map((t) => h('option', {
      value: t.score, selected: now != null && Number(now) === t.score,
    }, `${t.score} — ${cash(t.amount)}`)));

    // Only where a rung has actually been picked. Setting every unscored
    // person to the bottom rung on opening the screen would pay everybody
    // seventy cedis for having been looked at.
    if (now != null) scored.set(`${scheme.id}|${staffId}`, Number(now));
    say(now ?? '');

    return h('tr',
      h('td', person?.name ?? `Staff ${staffId}`,
        now == null ? h('small.muted', ' \u00b7 not scored yet') : null),
      h('td', pick),
      h('td.num', worth));
  });

  return rows.length
    ? h('table.pay-scores', h('tbody', rows))
    : h('p.muted', { style: { fontSize: '.85rem' } }, 'Nobody is under this one yet.');
}

function perPersonAmounts(scheme, data, scored, typed, closed, cash) {
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
        typed.add(`${scheme.id}|${staffId}`);
      },
    });

    // Set at once rather than only when somebody types, so pressing Save
    // writes the figure on screen. Otherwise a person shown the scheme's usual
    // amount but never touched would be saved as whatever they had before.
    scored.set(`${scheme.id}|${staffId}`, Math.max(0, Number(now) || 0));

    return h('tr',
      h('td', person?.name ?? `Staff ${staffId}`,
        held?.award == null ? h('small.muted', ' · not set yet') : null),
      // The currency in front of the box, because the box beside it on another
      // scheme wants a percentage and the two look identical otherwise.
      h('td.num', h('span.muted', `${data.currency ?? 'GHS'} `), input),
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
function sharedScore(scheme, data, scored, typed, closed, cash) {
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
      for (const id of ids) {
        scored.set(`${scheme.id}|${id}`, value);
        typed.add(`${scheme.id}|${id}`);
      }
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
  // What a person actually typed, as against what the boxes were opened
  // holding. A scheme that pays a set figure fills its boxes with the usual
  // amount so Save writes what is on screen, and that must not read as
  // unsaved work somebody would be sorry to lose.
  const typed = new Set();

  // NOT WHILE SOMEBODY IS TYPING INTO IT. This screen watches attendance as
  // well as pay, so on a busy morning every clock-in was a live update, and a
  // live update redraws the view — taking a page of half-typed scores with it.
  // Somebody would enter fifteen figures, press Save, and find one of them had
  // survived. The rota has held itself against this from the beginning; the
  // payroll never did.
  holdRefresh(() => typed.size > 0);

  // And the same for leaving the screen. Keyed, because the payroll redraws
  // itself when the month changes without going near the router, and without
  // a key every month somebody looked at would leave a guard behind holding a
  // map that can never empty.
  warnBeforeLeaving(() => (typed.size && !closed
    ? `${typed.size} bonus figure${typed.size === 1 ? '' : 's'} are not saved`
    : null), { key: 'payroll-scores' });

  return card('Bonus schemes', {
    wide: true,
    note: data.schemes.length ? `${data.schemes.length}` : 'none yet',
    actions: h('button.btn-sm.btn-primary', {
      onclick: () => editScheme(null, data, reload),
    }, 'New scheme'),
  },
  h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
    'A scheme either pays a share of one figure, scored per person, or a set figure agreed '
    + 'with each of them. Whether the figure is what somebody receives or what gets taxed is '
    + 'set against the person, under Who is on the payroll. Somebody can be under several '
    + 'schemes or under none.'),

  data.schemes.length
    // Folded. A property with nine schemes across four departments opened on a
    // page of score boxes, and the month's figures were three screens down.
    ? schemesByDepartment(data.schemes).map((group) => h('details.pay-scheme-group', {
      // Folded or not as it was left. Saving a page of scores redraws this
      // screen, and folding every department away each time means opening
      // them again before the next figure can be typed.
      open: openGroups.has(group.name),
      ontoggle: (e) => {
        if (e.target.open) openGroups.add(group.name); else openGroups.delete(group.name);
      },
    },
    h('summary.pay-scheme-dept',
      h('span', group.name),
      h('small.muted', `${group.schemes.length} scheme${group.schemes.length === 1 ? '' : 's'}`)),
    group.schemes.map((scheme) => {
      // A scheme that covers the whole property is scored once. It is not
      // twenty people who happen to agree; it is one figure about the
      // property, and typing it twenty times is twenty chances to differ.
      const everybody = schemeDepartments(scheme).length === 0;

      const body = scheme.kind === 'amount'
        ? perPersonAmounts(scheme, data, scored, typed, closed, cash)
        : scheme.kind === 'tier'
          // Always a rung each, even where the scheme covers the property.
          // A tier is a thing said about a person, not about the year.
          ? perPersonTiers(scheme, data, scored, typed, closed, cash)
          : everybody
            ? sharedScore(scheme, data, scored, typed, closed, cash)
            : perPersonScores(scheme, data, scored, typed, closed, cash);

      return h('div.pay-scheme',
        h('div.pay-scheme-head',
          h('div',
            h('strong', scheme.name),
            // Which kind it is, said in a word rather than left to be worked
            // out from the sentence beside it. Typing money into a box that
            // wants a percentage is capped at a hundred and reads as the
            // screen ignoring what was typed.
            scheme.kind === 'amount'
              ? h('span.pill.info', { style: { marginLeft: '.4rem' } }, 'A set figure each')
              : scheme.kind === 'tier'
                ? h('span.pill.good', { style: { marginLeft: '.4rem' } }, 'Scored by tier')
                : h('span.pill', { style: { marginLeft: '.4rem' } }, 'Scored out of 100'),
            h('span.muted', scheme.kind === 'amount'
              ? ` · ${cash(scheme.amount)} unless somebody is set a different figure`
              : scheme.kind === 'tier'
                ? ` · ${sayTiers(scheme.tiers, cash)}`
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
    h('option', { value: 'score', selected: !['amount', 'tier'].includes(scheme?.kind) },
      'Scored out of a hundred'),
    h('option', { value: 'amount', selected: scheme?.kind === 'amount' },
      'A set figure for each person'),
    h('option', { value: 'tier', selected: scheme?.kind === 'tier' },
      'A score off a table, each worth a stated amount'));

  const WORTH = {
    score: ['Worth at 100%', 'What somebody gets at a hundred per cent'],
    amount: ['The usual figure',
      'Offered to anybody who has not been set their own. Change theirs on the payroll screen'],
  };
  const worth = h('span', WORTH[scheme?.kind ?? 'score']?.[0] ?? WORTH.score[0]);
  const worthNote = h('small.muted', WORTH[scheme?.kind ?? 'score']?.[1] ?? WORTH.score[1]);
  const worthInput = h('input', {
    type: 'number', name: 'amount', step: '0.01', min: '0', required: true,
    value: scheme?.amount ?? '',
  });

  // The ladder: a score and what it pays, a row each. Written out rather than
  // worked out from a start and a step, because every one of these stops being
  // even eventually and a scheme that cannot hold what was agreed gets worked
  // around in somebody's head.
  const rungs = h('div.tier-rows');
  const tiers = (scheme?.tiers ?? []).map((t) => ({ score: t.score, amount: t.amount }));

  const drawRungs = () => {
    rungs.replaceChildren(...(tiers.length
      ? tiers.map((row, at) => h('div.tier-row',
        h('input.tier-in', {
          type: 'number', step: '1', min: '0', value: row.score, 'aria-label': 'Score',
          oninput: (e) => { tiers[at].score = Number(e.target.value); },
        }),
        h('span.muted', 'is worth'),
        h('input.tier-in', {
          type: 'number', step: '0.01', min: '0', value: row.amount, 'aria-label': 'Bonus amount',
          oninput: (e) => { tiers[at].amount = Number(e.target.value); },
        }),
        h('button.btn-ghost.btn-sm', {
          type: 'button',
          title: 'Take this score off the table',
          onclick: () => { tiers.splice(at, 1); drawRungs(); },
        }, '\u2715')))
      : [h('p.muted', { style: { fontSize: '.85rem', margin: 0 } },
        'No scores yet. Add the first one, or fill in ten at once.')]));
  };
  drawRungs();

  const addRung = h('button.btn-sm', {
    type: 'button',
    onclick: () => {
      const last = tiers[tiers.length - 1];
      // The next score up, and the same step in money as the last two rungs
      // took, because these are nearly always a ladder and typing seventy,
      // ninety, a hundred and ten by hand is ten chances to fat-finger one.
      const step = tiers.length > 1
        ? Math.round((last.amount - tiers[tiers.length - 2].amount) * 100) / 100
        : 0;
      tiers.push({
        score: last ? Number(last.score) + 1 : 1,
        amount: last ? Math.max(0, Math.round((last.amount + step) * 100) / 100) : 0,
      });
      drawRungs();
    },
  }, 'Add a score');

  const tierBox = h('div',
    h('div.btn-row', { style: { marginBottom: '.4rem' } }, addRung),
    rungs,
    h('small.muted', 'A score not on this table is refused rather than rounded to the nearest, '
      + 'because a 5 paid what a 6 was promised is worse than being told to look again.'));

  const tierField = field('What each score pays', tierBox);
  const worthField = h('label.field', worth, worthInput, worthNote);

  const showKind = () => {
    const kind = kindPick.value;
    const byTier = kind === 'tier';
    // On a tiered scheme the table is the whole answer, so there is no single
    // figure to ask for. What the scheme is worth is its top rung, filled in
    // on saving rather than typed twice and left to disagree with itself.
    tierField.hidden = !byTier;
    worthField.hidden = byTier;
    // A hidden required box stops a form submitting with nothing on screen to
    // say why.
    worthInput.required = !byTier;
    if (!byTier) {
      worth.textContent = WORTH[kind][0];
      worthNote.textContent = WORTH[kind][1];
    }
  };
  kindPick.addEventListener('change', showKind);
  showKind();

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
      // the hint change when the kind above does, and the whole thing goes
      // away on a tiered scheme where the table is the answer.
      worthField,
      tierField,
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
      // A tiered scheme is worth its top rung. Nobody should have to type
      // that twice and keep the two in step.
      amount: form.get('kind') === 'tier'
        ? (tiers.length ? Math.max(...tiers.map((t) => Number(t.amount) || 0)) : 0)
        : form.get('amount'),
      kind: form.get('kind'),
      note: form.get('note'),
      tiers: form.get('kind') === 'tier' ? tiers : null,
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

/**
 * What somebody was paid off with, for the month it went out in.
 *
 * Column 26 of the GRA form asks for it and nothing else on the form moves
 * because of it: what severance costs in tax depends on what it was for, and
 * that is a decision above a payroll. Kept against the month rather than the
 * person, because it happens once, and on a profile it would quietly repeat.
 */
function severanceCard(data, month, closed, reload, cash) {
  const rows = data.severances ?? [];
  return card('Severance paid', {
    wide: true,
    note: rows.length ? `${rows.length} this month` : 'nothing this month',
    actions: closed ? null : h('button.btn-sm', {
      onclick: () => addSeverance(data, month, reload),
    }, 'Record severance'),
  },
  h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
    'What somebody was paid off with when they left. It goes in column 26 of the GRA schedule '
    + 'for the month it went out in, and nothing else moves: it is not put through the tax '
    + 'here, because what it costs depends on what it was for.'),

  rows.length
    ? h('ul.adv-requests', rows.map((v) => {
      const person = data.staff.find((s) => s.id === v.staffId);
      return h('li',
        h('div',
          h('div.adv-who', person?.name ?? `Staff ${v.staffId}`),
          v.note ? h('div.muted', v.note) : null),
        h('div.btn-row',
          h('strong', cash(v.amount)),
          closed ? null : h('button.btn-ghost.btn-sm', {
            title: 'Take it back off the return',
            onclick: async () => {
              await api.payrollRemoveSeverance(v.id);
              toast('Taken off.', 'good');
              await reload();
            },
          }, '✕')));
    }))
    : null);
}

async function addSeverance(data, month, reload) {
  const done = await formDialog({
    title: 'Record severance',
    submitLabel: 'Record it',
    body: h('div',
      field('Who', h('select', { name: 'staffId', required: true },
        h('option', { value: '' }, 'Choose somebody'),
        data.staff.map((s) => h('option', { value: s.id }, s.name)))),
      field('How much', h('input', {
        type: 'number', name: 'amount', step: '0.01', min: '0.01', required: true,
      }), 'What was paid off, in full'),
      field('What it was for', h('input', {
        type: 'text', name: 'note', maxlength: 300,
      }), 'For your own record. It does not go to the GRA')),
    onSubmit: (form) => api.payrollSeverance({
      month,
      staffId: form.get('staffId'),
      amount: form.get('amount'),
      note: form.get('note'),
    }),
  });
  if (!done) return;
  toast('Recorded. It is on the schedule for this month.', 'good');
  await reload();
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

// Folded or not as it was left. Saving the payroll redraws this screen, and
// folding it away again each time means opening it before the next look.
let peopleOpen = false;

function peopleCard(data, reload, cash) {
  const on = data.staff.filter((s) => s.onPayroll);

  return card('Who is on the payroll', {
    wide: true,
    note: `${on.length} of ${data.staff.length}`,
    actions: h('button.btn-sm', { onclick: () => editPeople(data, reload) }, 'Set pay and allowances'),
  },
  on.length
    // Folded. It is a row per person and it never changes from one month to
    // the next, so it sat at the bottom of the page taking up a screen and a
    // half of somewhere nobody was going. Open it when somebody is checking
    // what it says, which is the only time it is worth reading.
    ? h('details.pay-people', {
      open: peopleOpen,
      ontoggle: (e) => { peopleOpen = e.target.open; },
    },
    h('summary.pay-people-head',
      h('span', 'What each of them is paid'),
      h('small.muted', `${on.length} on the payroll`)),
    h('div.table-wrap', h('table',
      h('thead', h('tr',
        h('th', 'Name'), h('th.num', 'Basic'), h('th', 'Allowances'), h('th', 'SSNIT'),
        h('th', 'Bonus'), h('th.num', 'Takes home'),
      )),
      h('tbody', on.map((person) => h('tr',
        h('td', person.name, h('small.muted', person.department ? ` · ${person.department}` : '')),
        h('td.num', cash(person.basic)),
        h('td', person.allowances.length
          ? person.allowances.map((a) => `${a.name} ${cash(a.amount)}`).join(' · ')
          : h('span.muted', 'none')),
        h('td', person.ssnit ? h('span.pill.good', 'yes') : h('span.pill', 'no')),
        h('td', person.bonusIsNet === false
          ? h('span.pill', { title: 'Their bonus figures are already gross. Tax comes out of the '
              + 'bonus, so the property adds nothing on top.' }, 'gross')
          : h('span.pill.good', { title: 'Their bonus figures are what they receive. The property '
              + 'carries the tax and it goes into their allowance.' }, 'net')),
        h('td.num', person.takeHome == null
          ? h('span.muted', { title: 'They are paid what is entered against them.' }, 'as entered')
          : h('strong', { title: 'The allowance is worked out from this every month.' },
            cash(person.takeHome)))))))))
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
    bonusIsNet: s.bonusIsNet !== false,
    // Blank rather than nought where nobody has agreed one. Nought is a
    // take-home of nothing, which is a real if unlikely answer, and it must
    // not be what an empty box means.
    takeHome: s.takeHome == null ? '' : s.takeHome,
    bonusOpening: s.bonusOpening ?? 0,
    // What the GRA form says about them. Blank means nobody has said, and the
    // form still falls back to their job title and to resident and full time.
    graPosition: s.graPosition ?? '',
    graResidency: s.graResidency ?? '',
    graRelief: s.graRelief ?? 0,
    jobTitle: s.jobTitle ?? null,
    allowances: s.allowances.map((a) => ({ ...a })),
  }]));
  const year = String(data.month ?? '').slice(0, 4);
  // Only worth asking about where the 15% is read across the year. Read
  // against the month being paid there is no running total, so there is
  // nothing a figure from before this app could tell it.
  const yearly = data.rates?.bonusCapBasis === 'annual';

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
    // Which way this person's bonus figures were agreed. It varies from one
    // person to the next, which is why it sits here and not in the settings.
    const netBonus = h('input', {
      type: 'checkbox', checked: mine.bonusIsNet,
      'aria-label': `${person.name}'s bonus figures are what they receive`,
      onchange: (e) => { mine.bonusIsNet = e.target.checked; },
    });
    // What they take home. Left empty, their bonus comes off their scores the
    // way it always has; given a figure, the bonus is worked back from it
    // every month and nobody types it again.
    const takeHome = h('input.med-amount', {
      type: 'number', step: '0.01', min: '0', value: mine.takeHome,
      placeholder: 'as entered',
      'aria-label': `What ${person.name} takes home`,
      onchange: (e) => { mine.takeHome = e.target.value === '' ? '' : Number(e.target.value); },
    });
    const allowanceCount = h('span.muted',
      mine.allowances.length ? `${mine.allowances.length}` : 'none');
    // What the return will say about them, so somebody can see at a glance
    // which rows are still on the fallback.
    const returnSummary = h('span.muted', sayReturn(mine));

    // What they have already had as bonus this year, before this app was
    // keeping it. The 5% rate is capped at 15% of the year's basic and the
    // cap is a running total, so a property that starts here in August has
    // seven months the ceiling knows nothing about.
    const opening = yearly
      ? h('input.med-amount', {
        type: 'number', step: '0.01', min: '0', value: mine.bonusOpening || '',
        'aria-label': `Bonus ${person.name} has already had in ${year}`,
        onchange: (e) => { mine.bonusOpening = Number(e.target.value) || 0; },
      })
      : null;

    const tick = h('input', {
      type: 'checkbox', checked: mine.onPayroll,
      'aria-label': `${person.name} is on the payroll`,
      onchange: (e) => {
        mine.onPayroll = e.target.checked;
        basic.disabled = !e.target.checked;
        ssnit.disabled = !e.target.checked;
        netBonus.disabled = !e.target.checked;
        takeHome.disabled = !e.target.checked;
        line.classList.toggle('adv-skipped', !e.target.checked);
      },
    });
    basic.disabled = !mine.onPayroll;
    ssnit.disabled = !mine.onPayroll;
    netBonus.disabled = !mine.onPayroll;
    takeHome.disabled = !mine.onPayroll;

    const line = h(`tr${mine.onPayroll ? '' : '.adv-skipped'}`,
      h('td', h('label.tickline', tick, h('span', person.name))),
      h('td.num', basic),
      // Both ticks in one cell, one above the other. A column each pushed the
      // allowances button off the side of the dialog.
      h('td',
        h('label.tickline', ssnit, h('span', 'SSNIT')),
        h('label.tickline', netBonus, h('span', 'Net bonus'))),
      h('td.num', takeHome),
      yearly ? h('td.num', opening) : null,
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
        }, 'Allowances')),
      h('td.num',
        returnSummary,
        h('button.btn-sm', {
          type: 'button',
          style: { marginLeft: '.4rem' },
          onclick: async () => {
            const next = await editForReturn(person, mine, data);
            if (!next) return;
            Object.assign(mine, next);
            returnSummary.textContent = sayReturn(mine);
          },
        }, 'Return')));
    return line;
  });

  const done = await formDialog({
    title: 'Pay and allowances',
    submitLabel: 'Save the payroll',
    wide: 'xl',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Tick everybody the payroll covers and give their monthly basic. SSNIT is 5.5% from '
        + 'them and 13% from the property, on basic salary alone. Untick it for anybody it '
        + 'does not apply to.'),
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Bonus is net where the figures agreed are what the person receives. The property then '
        + 'carries the tax on top and it shows in their allowance. Untick it for anybody whose '
        + 'bonus figures were worked out gross already, or the tax gets paid twice.'),
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Takes home is what the person is actually on, bonus included. Give it and the '
        + 'allowance is worked out from it every month \u2014 whatever they score and '
        + 'whatever the tax does \u2014 so nobody recalculates it. Leave it empty and they '
        + 'are paid their basic, their allowances and their scored bonus as entered. It is '
        + 'measured before any advance they are repaying and before anything docked off '
        + 'their bonus, so both still cost them what they are meant to.'),
      h('p.muted', { style: { fontSize: '.85rem' } },
        'GRA return is the grade, the residency and any reliefs the form asks about somebody. '
        + 'Left alone, the form uses their job title and puts them down as resident and full '
        + 'time, which is right for most people. Change it here when it changes for them.'),
      yearly
        ? h('p.muted', { style: { fontSize: '.85rem' } },
          `Bonus already had in ${year} is for months this app did not run. The 5% rate on a `
          + `bonus reaches 15% of the year's basic and the rest goes through the bands, so the `
          + 'ceiling has to know what was paid before it. Leave it at nothing where every '
          + 'month of the year was done here.')
        : null,
      h('div.table-wrap.med-set-wrap', h('table.med-set',
        h('thead', h('tr',
          h('th', 'On the payroll'), h('th.num', 'Basic'), h('th', ''),
          h('th.num', 'Takes home'),
          yearly ? h('th.num', `Bonus already had in ${year}`) : null,
          h('th.num', 'Allowances'), h('th.num', 'GRA return'),
        )),
        h('tbody', rows)))),
    onSubmit: async () => api.payrollProfiles({
      rows: [...state.entries()].map(([staffId, v]) => ({
        staffId,
        onPayroll: v.onPayroll,
        basic: v.basic,
        ssnit: v.ssnit,
        bonusIsNet: v.bonusIsNet,
        takeHome: v.takeHome,
        graPosition: v.graPosition,
        graResidency: v.graResidency,
        graRelief: v.graRelief,
        bonusOpening: v.bonusOpening,
        bonusOpeningYear: year,
        allowances: v.allowances,
      })),
    }),
  });
  if (!done) return;
  toast(`${done.set} on the payroll.`, 'good');
  await reload();
}

/** The three things the GRA form asks, in a line short enough for a cell. */
function sayReturn(mine) {
  const bits = [];
  bits.push(mine.graPosition || (mine.jobTitle ? `${mine.jobTitle}*` : 'job title*'));
  if (mine.graResidency && mine.graResidency !== 'Resident-Full-Time') {
    bits.push(mine.graResidency.replace('Resident-', ''));
  }
  if (Number(mine.graRelief) > 0) bits.push(`relief ${mine.graRelief}`);
  return bits.join(' · ');
}

/**
 * What the return says about one person.
 *
 * Three columns of the GRA form that a payroll cannot work out: the grade,
 * whether somebody is here full time, and any relief they hold a certificate
 * for. All three change over somebody's time here, so they are set against the
 * person and can be changed again the month they change.
 *
 * Leaving any of them empty keeps the reading the form had before anybody
 * could set them, which is right for almost everybody, so nobody has to fill
 * in twenty-five rows to file a return.
 */
async function editForReturn(person, mine, data) {
  const positions = (data.positions ?? ['MANAGEMENT', 'SENIOR', 'JUNIOR']);
  const residencies = (data.residencies ?? ['Resident-Full-Time']);

  const position = h('input', {
    type: 'text', value: mine.graPosition || '', maxlength: 40, list: 'gra-positions',
    placeholder: mine.jobTitle || person.department || 'From their job title',
  });
  const residency = h('select',
    residencies.map((r) => h('option', {
      value: r,
      selected: (mine.graResidency || 'Resident-Full-Time') === r,
    }, r)));
  const relief = h('input', {
    type: 'number', step: '0.01', min: '0', value: mine.graRelief || '',
    placeholder: '0.00',
  });

  const done = await formDialog({
    title: `${person.name} on the GRA return`,
    submitLabel: 'Keep it',
    body: h('div',
      // h() reads .class out of a selector and nothing else, so the id goes in
      // as a property. As a selector it becomes the tag name and createElement
      // throws on the hash.
      h('datalist', { id: 'gra-positions' }, positions.map((v) => h('option', { value: v }))),
      field('Position', position,
        'Column 4. The grade on the form, not the job. Leave it empty to use their job title.'),
      field('Residency', residency,
        'Column 5. Resident and full time unless they are here on some other footing.'),
      field('Deductible reliefs', relief,
        'Column 20. Only what they hold a certificate from the GRA for. Nought for almost '
        + 'everybody.')),
    onSubmit: () => true,
  });
  if (!done) return null;

  return {
    graPosition: position.value.trim(),
    graResidency: residency.value,
    graRelief: Number(relief.value) || 0,
  };
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
