import { api } from '../api.js';
import { h, money, mount } from '../util.js';
import { card, emptyState } from './components.js';
import { niceMonth } from './att-shared.js';
import { companyOf, fitPayslip, fitToWidth, payslipPage, showPayslips } from './payslip.js';

/**
 * My payslips.
 *
 * There was no way for a member of staff to see one. The only route to a
 * payslip wanted the payroll permission, a PIN and an administrator on top,
 * which is right for reading a colleague's and is the wrong end of the
 * building for reading your own, so people were being handed paper or asking.
 *
 * CLOSED MONTHS ONLY, and the screen says so. A draft moves: a score gets
 * changed, an allowance is corrected, and a figure somebody has written down
 * stops being true. Nobody should be reading a number that is still being
 * argued about upstairs.
 *
 * THE NEWEST ONE IS ALREADY OPEN. Somebody comes here on payday to see one
 * month, so that month is on the screen when it loads and the others are a
 * list beside it rather than a step in front of it.
 *
 * The paper itself is the same page the payroll prints. A payslip somebody is
 * shown on a phone and a payslip handed to them at a desk have to be the same
 * document, or the first question is which one is right.
 */

export async function renderAttMyPayslips(params) {
  const host = h('div');
  const data = await api.myPayslips(params.month);
  const cash = (n) => money(n, data.currency);

  if (!data.linked) {
    mount(host,
      h('div.page-head', h('div', h('h1', 'My payslips'))),
      emptyState('This login is not linked to your staff record',
        'Ask whoever set it up to point it at you under Users, and this will fill in.'));
    return host;
  }

  if (!data.months.length) {
    mount(host,
      h('div.page-head', h('div', h('h1', 'My payslips'))),
      emptyState('Nothing here yet',
        'A payslip appears the day the month it belongs to is closed. Until then the '
        + 'figures are still being worked out.'));
    return host;
  }

  const show = async (month) => mount(host, await renderAttMyPayslips({ ...params, month }));
  const company = companyOf();
  const page = payslipPage({
    line: data.line,
    data,
    month: { key: data.month, nice: niceMonth(data.month) },
    company,
  });
  const paper = fitToWidth(page);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'My payslips'),
        h('div.sub', `${data.months.length} month${data.months.length === 1 ? '' : 's'}, `
          + 'from the day each one was closed'),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => showPayslips([payslipPage({
          line: data.line, data, month: { key: data.month, nice: niceMonth(data.month) }, company,
        })], {
          title: data.line?.staff?.name ?? 'Payslip',
          subtitle: niceMonth(data.month),
        }) }, 'Print or save as PDF'))),

    // The months down one side and the slip beside them, so choosing another
    // is one press rather than a press and a scroll back up.
    h('div.slip-mine',
      h('div.slip-mine-list',
        card('Months', { note: `${data.months.length}` },
          h('ul.slip-mine-months', data.months.map((m) => h('li',
            h(`button.slip-mine-month${m.month === data.month ? '.is-on' : ''}`, {
              type: 'button',
              onclick: () => show(m.month),
            },
            h('span.slip-mine-when', niceMonth(m.month)),
            h('strong.slip-mine-net', cash(m.net))))))),
      ),
      h('div.slip-mine-paper', paper.box)),
  );

  // Sized down to whatever is in front of somebody once it is on the page. A4
  // is not a phone, and the same page has to fit both: first the body is
  // shrunk until the slip fits the height of the sheet, then the whole sheet
  // is scaled to the width there is for it. Both need it in the document
  // before anything can be measured.
  requestAnimationFrame(() => { fitPayslip(page); paper.fit(); });
  return host;
}
