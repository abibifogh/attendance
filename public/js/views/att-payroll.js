import { api } from '../api.js';
import {
  confirmAction, fmtNum, h, money, monthOf, mount, shiftMonth, toast, todayISO,
} from '../util.js';
import { card, emptyState } from './components.js';
import { field, formDialog, showSheet } from './att-shared.js';
import { replaceParams } from '../app.js';
import { printReport } from '../print.js';
import { niceMonth } from './att-advances.js';
import { companyOf, payslipPage, showPayslips } from './payslip.js';

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

export async function renderAttPayroll(params) {
  const host = h('div');
  const month = /^\d{4}-\d{2}$/.test(params.month) ? params.month : monthOf(todayISO());
  const data = await api.payroll(month);
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
        h('div.sub', `${niceMonth(month)} · ${data.rates.label}`),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => reload({ month: shiftMonth(month, -1) }) }, '‹'),
        h('input', {
          type: 'month', value: month, 'aria-label': 'Month',
          onchange: (e) => e.target.value && reload({ month: e.target.value }),
        }),
        h('button.btn-sm', { onclick: () => reload({ month: shiftMonth(month, 1) }) }, '›'),
        h('button.btn-sm', { onclick: () => reload({ month: monthOf(todayISO()) }) }, 'This month')),
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
          h('button.btn-sm', { onclick: () => printReport({
            title: `Payroll, ${niceMonth(month)}`,
            subtitle: data.property || '',
            note: `${data.rates.label}. ${closed ? 'Closed' : 'Draft'}.`,
          }) }, 'Print this table'),
          h('button.btn-sm', { onclick: () => openAllSlips(data, month) },
            `All ${data.lines.length} payslips`),
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
            h('th.num', 'Cost'),
          )),
          h('tbody', data.lines.map((line) => h('tr.pay-row', {
            tabindex: 0,
            role: 'button',
            title: 'The payslip',
            onclick: () => openSlip(line, data, month, reload),
            onkeydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSlip(line, data, month, reload); }
            },
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
            h('td.num.off-phone', cash(data.totals.cost)))))),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'Press a row for the payslip behind it.'))
      : emptyState('Nobody is on the payroll yet',
        'Say what each person is paid and whether SSNIT applies to them, and the month works '
        + 'itself out.'),

    schemesCard(data, month, closed, reload, cash),
    penaltiesCard(data, month, closed, reload, cash),
    peopleCard(data, reload, cash),
  );

  return host;
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

// --------------------------------------------------------------------------
// The schemes
// --------------------------------------------------------------------------

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
    'A scheme is worth so much in somebody’s hand at a hundred per cent. Score each person and '
    + 'they get that share of it. Somebody can be under several schemes or under none.'),

  data.schemes.length
    ? data.schemes.map((scheme) => {
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

      return h('div.pay-scheme',
        h('div.pay-scheme-head',
          h('div',
            h('strong', scheme.name),
            h('span.muted', ` · ${cash(scheme.amount)} at 100%`),
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

        rows.length
          ? h('table.pay-scores', h('tbody', rows))
          : h('p.muted', { style: { fontSize: '.85rem' } }, 'Nobody is under this one yet.'));
    })
    : null,

  data.schemes.length && !closed
    ? h('div.btn-row', { style: { marginTop: '.6rem' } },
      h('button.btn.btn-primary', {
        onclick: async (e) => {
          const rows = [...scored.entries()].map(([key, score]) => {
            const [schemeId, staffId] = key.split('|').map(Number);
            return { schemeId, staffId, score };
          });
          if (!rows.length) { toast('Nothing has been scored yet.', 'warn'); return; }
          e.target.disabled = true;
          try {
            await api.payrollScores({ month, rows });
            toast(`${rows.length} score${rows.length === 1 ? '' : 's'} saved.`, 'good');
            await reload();
          } catch (err) {
            e.target.disabled = false;
            toast(err.message, 'bad');
          }
        },
      }, 'Save the scores'))
    : null);
}

async function editScheme(scheme, data, reload) {
  const picked = new Set(scheme?.staffIds ?? []);

  const list = h('div.pos-edit-list', data.staff.map((person) => h('label.tickline',
    h('input', {
      type: 'checkbox',
      checked: picked.has(person.id),
      onchange: (e) => { if (e.target.checked) picked.add(person.id); else picked.delete(person.id); },
    }),
    h('span', person.name,
      person.department ? h('small.muted', ` · ${person.department}`) : null))));

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
      field('Worth at 100%', h('input', {
        type: 'number', name: 'amount', step: '0.01', min: '0', required: true,
        value: scheme?.amount ?? '',
      })),
      field('What it is for', h('input', {
        type: 'text', name: 'note', maxlength: 300, value: scheme?.note ?? '',
      })),
      h('p.muted', { style: { fontSize: '.85rem', marginBottom: '.2rem' } }, 'Who is under it'),
      list),
    onSubmit: (form) => api.payrollScheme({
      id: scheme?.id ?? null,
      name: form.get('name'),
      amount: form.get('amount'),
      note: form.get('note'),
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
