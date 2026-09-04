import { api } from '../api.js';
import { h, money, mount, toast } from '../util.js';
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

  if (data.locked) {
    mount(host,
      h('div.page-head', h('div', h('h1', 'My payslips'))),
      lockedCard(data, async () => mount(host, await renderAttMyPayslips(params))));
    return host;
  }

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

  // Shut again the moment they leave the screen. Without this the window runs
  // its full length on a phone that has been put face-up on a bar.
  if (data.hasCode) shutOnLeaving(host);
  return host;
}

/**
 * The screen behind the code.
 *
 * It says nothing about what is behind it. Not how many months, not the last
 * one, not a figure: a locked screen that leaks the shape of what it is
 * guarding has only moved the problem one line down.
 */
function lockedCard(data, reload) {
  const box = h('input.slip-code', {
    type: 'password', inputMode: 'numeric', autocomplete: 'off',
    maxLength: 4, placeholder: '••••', 'aria-label': 'Your payslip code',
  });

  const go = async () => {
    try {
      await api.myOpenPayslips(box.value);
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
      box.value = '';
      box.focus();
    }
  };

  if (data.state === 'locked') {
    return card('Locked for now', { wide: true },
      h('p', 'Too many wrong tries. The code will work again shortly.'),
      h('p.muted', 'If you have forgotten it, whoever looks after logins can take it off '
        + 'for you. Nobody can read it back to you, not even them.'));
  }

  return card('Type your code', { wide: true },
    h('p', 'You have put a four digit code on your payslips. Type it to open them.'),
    h('div.slip-code-row',
      box,
      h('button.btn', { onclick: go }, 'Open')),
    h('p.muted', `${data.triesLeft} ${data.triesLeft === 1 ? 'try' : 'tries'} left before it `
      + 'stops accepting guesses for a while.'),
    h('p.muted', 'Forgotten it? Whoever looks after logins can take it off for you, and you '
      + 'can put a new one on. Nobody can read the old one back to you.'));
}

/** Tell the server the tab is closed, once, when the screen goes away. */
function shutOnLeaving(host) {
  const watch = new MutationObserver(() => {
    if (host.isConnected) return;
    watch.disconnect();
    api.myShutPayslips().catch(() => {});
  });
  watch.observe(document.body, { childList: true, subtree: true });
}
