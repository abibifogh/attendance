import { api } from '../api.js';
import { replaceParams } from '../app.js';
import { fmtDay, h, mount, shiftDay, todayISO } from '../util.js';
import { card, emptyState, moreActions, table } from './components.js';
import { printButton } from '../print.js';
import { asHours } from './att-shared.js';

/**
 * The week as totals, everybody on one page.
 *
 * There is somebody at every property whose whole question is whether the week
 * adds up. They do not need to know that Kwesi was eleven minutes late on
 * Tuesday, and a screen that tells them anyway is a screen full of other
 * people's business.
 *
 * So this is four numbers a person and a line at the bottom. Days down for and
 * days worked, hours asked for and hours recorded, and the difference between
 * the last two — which is the number the question is usually really about.
 * Nothing opens, nothing is editable, and no name is a link through to
 * anything: whoever holds this permission holds it instead of the reports
 * rather than as well as them, and a way through to a person's own week would
 * be the reports by another door.
 */
export async function renderAttTotals(params) {
  const host = h('div');
  const from = params.from || mondayOf(todayISO());
  const data = await api.attTotals(from);

  const reload = async (nextFrom) => {
    replaceParams('att-totals', { from: nextFrom });
    mount(host, await renderAttTotals({ from: nextFrom }));
  };

  const span = `${fmtDay(data.from)} to ${fmtDay(data.to, { withYear: true })}`;

  const nav = h('div.toolbar',
    h('button.btn-sm', {
      onclick: () => reload(shiftDay(data.from, -7)),
      'aria-label': 'The week before',
    }, '‹', h('span.only-desk', ' Previous week')),
    h('input', {
      type: 'date', value: data.from, 'aria-label': 'Week beginning',
      onchange: (e) => e.target.value && reload(mondayOf(e.target.value)),
    }),
    h('button.btn-sm', {
      onclick: () => reload(shiftDay(data.from, 7)),
      'aria-label': 'The week after',
    }, h('span.only-desk', 'Next week '), '›'),
    data.from === mondayOf(todayISO())
      ? null
      : h('button.btn-sm', { onclick: () => reload(mondayOf(todayISO())) }, 'This week'),
    h('div', { style: { flex: 1 } }),
    moreActions(printButton({
      title: 'Weekly totals',
      subtitle: span,
      footer: 'Hours rostered are what the rota asked for. Hours worked are what the '
        + 'terminal recorded, and a day nobody has settled yet counts what it has so far.',
    })),
  );

  const head = h('div.page-head',
    h('h1', 'Weekly totals'),
    h('div.sub', span),
  );

  if (!data.rows.length) {
    mount(host, head, nav, emptyState(
      'Nobody on the rota this week',
      'Once the week has people on it, their hours add up here.',
    ));
    return host;
  }

  // The difference between what was asked for and what was recorded. Said as a
  // signed number because both directions matter and they mean opposite
  // things: under is cover that did not happen, over is somebody owed.
  const diff = (row) => row.workedMinutes - row.expectedMinutes;
  const signed = (minutes) => {
    if (!minutes) return '—';
    return `${minutes > 0 ? '+' : '−'}${asHours(Math.abs(minutes))}`;
  };

  const columns = [
    {
      key: 'staff',
      label: 'Name',
      format: (v) => h('div',
        h('div', v.name),
        h('small.muted', v.department || `No. ${v.employee_no}`)),
    },
    // Said as a string, because a nought is a real answer here and an empty
    // cell reads as a question rather than one.
    { key: 'daysRostered', label: 'Days down for', align: 'right', format: (v) => String(v) },
    { key: 'daysWorked', label: 'Days worked', align: 'right', format: (v) => String(v) },
    {
      key: 'expectedMinutes',
      label: 'Hours rostered',
      align: 'right',
      format: (v) => asHours(v),
    },
    {
      key: 'workedMinutes',
      label: 'Hours worked',
      align: 'right',
      format: (v) => asHours(v),
    },
    {
      key: 'staff',
      label: 'Difference',
      align: 'right',
      format: (v, row) => h('span', {
        class: diff(row) < 0 ? 'muted' : '',
        title: diff(row) < 0
          ? 'Fewer hours recorded than the rota asked for'
          : 'More hours recorded than the rota asked for',
      }, signed(diff(row))),
    },
  ];

  const line = (label, value) => h('div.tot-line', h('span.muted', label), h('strong', value));

  mount(host,
    head,
    nav,
    card('The week', {},
      h('div.tot-summary',
        line('People', String(data.totals.people)),
        line('Days worked', String(data.totals.daysWorked)),
        line('Hours rostered', asHours(data.totals.expectedMinutes)),
        line('Hours worked', asHours(data.totals.workedMinutes)),
      ),
      // Wrapped so a phone can set the whole thing a size smaller. Six columns
      // of numbers is a wide table on a handset, and small type that scrolls a
      // little beats big type that scrolls a lot.
      h('div.tot-table', table(columns, data.rows, { empty: 'Nobody on the rota this week.' })),
      h('p.muted', { style: { fontSize: '.8rem', marginTop: '.6rem' } },
        'Hours rostered are what the rota asked for. Hours worked are what the terminal '
        + 'recorded, so a day still waiting to be settled counts what it has so far.'),
    ),
  );

  return host;
}

/** The Monday of whatever week a day falls in. */
function mondayOf(day) {
  const at = new Date(`${day}T12:00:00Z`);
  return shiftDay(day, -((at.getUTCDay() + 6) % 7));
}
