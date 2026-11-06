import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card } from './components.js';
import { lockScreen } from './att-payroll.js';

/**
 * Money › Payroll › Calculator.
 *
 * Net to gross and gross to net, worked out the way the payroll works it out:
 * SSNIT on the basic, PAYE on the rest after the employee's SSNIT, at the
 * bands in force this month. Behind the payroll PIN like the rest of payroll.
 */

const money = (n) => Number(n ?? 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (r) => `${Math.round(r * 1000) / 10}%`;

export async function renderPayCalculator() {
  const host = h('div');
  const access = await api.payrollAccess().catch(() => ({ open: true, state: 'open' }));
  if (!access.open) {
    mount(host, lockScreen(access, async () => mount(host, await renderPayCalculator())));
    return host;
  }

  let mode = 'net';
  const amount = h('input', { type: 'number', min: 0, step: '0.01', inputmode: 'decimal', placeholder: '2000.00', required: true });
  const basic = h('input', { type: 'number', min: 0, step: '0.01', inputmode: 'decimal', placeholder: 'Blank: all of it is basic' });
  const residency = h('select',
    h('option', { value: 'Resident' }, 'Resident, full time (the bands)'),
    h('option', { value: 'Resident-Part-Time' }, 'Resident, part time (10% flat)'),
    h('option', { value: 'Resident-Casual' }, 'Resident, casual (5% flat)'),
    h('option', { value: 'Non-Resident' }, 'Non-resident (25% flat)'));
  const ssnit = h('input', { type: 'checkbox', checked: true });
  const amountLabel = h('span', 'Net pay in hand');
  const result = h('div');

  const modeBtn = (key, label) => h('button.seg-btn', {
    type: 'button',
    class: mode === key ? 'active' : '',
    onclick: (e) => {
      mode = key;
      e.target.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.target));
      amountLabel.textContent = key === 'net' ? 'Net pay in hand' : 'Gross pay';
      mount(result);
    },
  }, label);

  const line = (label, value, { strong = false, minus = false, muted = false } = {}) => h('tr', { class: muted ? 'muted' : '' },
    h('td', strong ? h('strong', label) : label),
    h('td.num', strong ? h('strong', minus ? `(${money(value)})` : money(value)) : (minus ? `(${money(value)})` : money(value))));

  const work = async (e) => {
    e?.preventDefault();
    if (!amount.value) { amount.focus(); return; }
    try {
      const r = await api.payCalculate({
        mode, amount: Number(amount.value), basic: basic.value === '' ? null : Number(basic.value),
        residency: residency.value, ssnit: ssnit.checked,
      });
      mount(result,
        h('div.calc-headline',
          h('div', h('small', mode === 'net' ? 'Gross to pay' : 'Net in hand'), h('b', `GHS ${money(mode === 'net' ? r.gross : r.net)}`)),
          h('div', h('small', 'Costs you, with employer SSNIT'), h('b', `GHS ${money(r.cost)}`))),
        h('div.table-wrap', h('table.data.calc-table',
          h('tbody',
            line('Basic salary', r.basic),
            line('Allowances', r.allowances),
            line('Gross', r.gross, { strong: true }),
            line(`SSNIT, employee ${pct(r.rates.ssnitEmployee)} of basic`, r.ssnitEmployee, { minus: true }),
            line('Chargeable income', r.chargeable),
            line('PAYE', r.paye, { minus: true }),
            line('Net pay', r.net, { strong: true }),
            line(`SSNIT, employer ${pct(r.rates.ssnitEmployer)} of basic (on top)`, r.ssnitEmployer, { muted: true }),
            line('Cost to the business', r.cost, { strong: true })))),
        r.steps?.length
          ? h('details.calc-steps', h('summary', 'How the PAYE is made up'),
            h('table.data', h('tbody', r.steps.map((s) => h('tr',
              h('td', `${money(s.amount)} at ${pct(s.rate)}`), h('td.num', money(s.tax)))))))
          : null,
        h('p.muted', { style: { fontSize: '.82rem' } },
          `${r.rates.label}${r.rates.from ? `, in force from ${r.rates.from}` : ''}. `
          + 'SSNIT is on the basic only, as on the payslip. A bonus is taxed separately and is not included.'));
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  mount(host,
    h('div.page-head', h('div', h('h1', 'Pay calculator'), h('div.sub', 'Net to gross, or gross to net, at this month’s rates'))),
    card(null, { wide: true },
      h('form.calc-form', { onsubmit: work },
        h('div.seg', { role: 'group', 'aria-label': 'What you know' },
          modeBtn('net', 'I know the net'), modeBtn('gross', 'I know the gross')),
        h('div.field-row',
          h('label.field', amountLabel, amount),
          h('label.field', h('span', 'Basic salary'), basic, h('small.muted', 'The rest is paid as allowances'))),
        h('div.field-row',
          h('label.field', h('span', 'Tax status'), residency),
          h('label.tickline', { style: { alignSelf: 'end' } }, ssnit, h('span', 'Pays SSNIT'))),
        h('div.btn-row', h('button.btn.btn-primary', { type: 'submit' }, 'Work it out'))),
      result),
  );
  return host;
}
