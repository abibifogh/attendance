import { api } from '../api.js';
import { confirmAction, fmtDayShort, h, mount, shiftDay, toast } from '../util.js';
import { card, emptyState } from './components.js';
import { formDialog } from './att-shared.js';
import { replaceParams } from '../app.js';
import { printReport } from '../print.js';

/**
 * The weekly lunch list, as the kitchen reads it.
 *
 * ONE NUMBER MATTERS AND EVERYTHING ELSE EXPLAINS IT. The count under each day
 * is what the order is placed on, so it is the largest thing on the page. The
 * names under it are there so somebody can check the count rather than trust
 * it, which is the difference between a report and a receipt.
 *
 * SEVEN COLUMNS, MONDAY TO SUNDAY. Not a list of people with days against
 * them: the kitchen buys by the day, so the day is the unit, and a person who
 * eats four times appears four times.
 */
export async function renderAttLunch(params = {}) {
  const host = h('div');
  const data = await api.lunch(params.week).catch((err) => ({ error: err.message }));

  const reload = async (next = {}) => {
    if (next.week !== undefined) replaceParams('att-lunch', { week: next.week });
    mount(host, await renderAttLunch({ ...params, ...next }));
  };

  if (data.error) {
    mount(host, h('div.page-head', h('h1', 'Lunch')), emptyState('Nothing to show yet', data.error));
    return host;
  }

  const { summary, window } = data;
  const thisIsTheWeek = data.monday === window.monday;

  mount(host,
    h('div.page-head.no-print',
      h('div',
        h('h1', 'Lunch'),
        h('div.sub', `Week of ${fmtDayShort(data.monday)}`
          + (thisIsTheWeek ? ' · the week being ordered' : '')),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => reload({ week: shiftDay(data.monday, -7) }) }, '‹'),
        h('button.btn-sm', { onclick: () => reload({ week: null }) }, 'The coming week'),
        h('button.btn-sm', { onclick: () => reload({ week: shiftDay(data.monday, 7) }) }, '›'),
        h('button.btn.btn-primary', { onclick: () => printReport({
          title: `Lunch, week of ${fmtDayShort(data.monday)}`,
          subtitle: data.property || '',
          note: `${summary.plates} lunches over the week.`,
          footer: false,
        }) }, 'Print the week'),
      ),
    ),

    windowLine(data, window, thisIsTheWeek, reload),

    // The sheet the kitchen orders against. Seven columns, the count under
    // each, and the names under that.
    card('The week', { wide: true, note: `${summary.plates} lunches` },
      h('div.table-wrap', h('table.lunch-table',
        h('thead', h('tr', summary.columns.map((c) => h('th',
          h('div.lunch-th-day', c.short),
          h('div.lunch-th-date', fmtDayShort(c.day)))))),
        h('tbody',
          h('tr.lunch-heads', summary.columns.map((c) => h('td',
            h('div.lunch-count', String(c.heads)),
            h('div.lunch-of', ofWhat(data, c))))),
          h('tr.lunch-meals', summary.columns.map((c) => h('td',
            c.meal
              ? h('div.lunch-meal', c.meal, c.note ? h('small.muted', c.note) : null)
              : h('span.muted', '—')))),
          h('tr', summary.columns.map((c) => h('td',
            c.names.length
              ? h('ul.lunch-names', c.names.map((n) => h('li', n)))
              : h('span.muted', 'nobody'))))))),
      h('p.muted.no-print', { style: { fontSize: '.85rem' } },
        'The number is what you order against. The names under it are so you can check it.')),

    card('What is being served', {
      wide: true,
      note: 'One meal a day, for everybody',
      actions: h('button.btn-sm', { onclick: () => setMenu(data, reload) }, 'Set the menu'),
    },
    h('div.lunch-menu-grid', data.menu.map((m) => h('div.lunch-menu-cell',
      h('div.lunch-menu-day', fmtDayShort(m.day)),
      m.meal
        ? h('div', h('strong', m.meal), m.note ? h('div', h('small.muted', m.note)) : null)
        : h('span.muted', 'Not set'))))),

    data.waiting.length
      ? card('Still to say', {
        wide: true,
        note: `${data.waiting.length} ${data.waiting.length === 1 ? 'person' : 'people'}`,
      },
      h('p.muted', { style: { fontSize: '.85rem' } },
        'On the rota and has not answered. Saying no counts as answering; these have said '
        + 'nothing, so the kitchen is guessing about them.'),
      h('div.lunch-waiting', data.waiting.map((person) => h('div.lunch-waiting-row',
        h('div',
          h('strong', person.name),
          h('div', h('small.muted', person.days.map((d) => fmtDayShort(d)).join(' · ')))),
        h('button.btn-sm.no-print', {
          onclick: () => putThemDown(person, data, reload),
        }, 'Put them down'))))) 
      : null,

    linkCard(data, reload),
  );

  return host;
}

const ofWhat = (data, column) => {
  const on = data.rostered.find((r) => r.day === column.day)?.people ?? 0;
  return on ? `of ${on} in` : 'nobody in';
};

/** Whether the list is taking answers, and when it next will be. */
function windowLine(data, window, thisIsTheWeek, reload) {
  if (!data.on) return null;

  return h('div.alert.no-print', { class: window.open ? 'good' : '' },
    h('span.alert-icon', window.open ? '🟢' : '🕒'),
    h('div',
      h('div.alert-title', window.open
        ? `Open until the end of ${fmtDayShort(window.closesAfter)}`
        : `Shut. Opens on ${fmtDayShort(window.opensOn)}`),
      h('div.alert-detail', window.open
        ? `Answers are being taken for the week of ${fmtDayShort(window.monday)}.`
        : `When it opens it will be for the week of ${fmtDayShort(window.monday)}.`)),
    thisIsTheWeek ? null : h('button.btn-sm', {
      style: { marginLeft: 'auto' },
      onclick: () => reload({ week: null }),
    }, 'Go to that week'));
}

/** The address the list lives at. */
function linkCard(data, reload) {
  // Furniture for whoever runs the list, not for the sheet that goes to the
  // kitchen, so it stays off the print.
  return h('div.no-print', { style: { gridColumn: '1 / -1' } },
  card('The link staff order on', {
    wide: true,
    note: data.on ? 'open' : 'closed',
  },
  h('p.muted', { style: { fontSize: '.9rem' } },
    'One address for the whole property. Put it on the noticeboard and in the group chat: '
    + 'whoever opens it finds their own name, sees the days they are down to work next week, '
    + 'and ticks the ones they are eating. It shows first names, rostered days and the menu, '
    + 'and nothing else about anybody.'),

  h('div.btn-row',
    h('button.btn.btn-primary', {
      onclick: async () => {
        if (data.hasLink && !confirmAction('Make a new link? The one on the noticeboard stops '
          + 'working the moment this one is made.')) return;
        try {
          const made = await api.lunchMakeLink();
          await showLink(made.url);
          await reload();
        } catch (err) {
          toast(err.message, 'bad');
        }
      },
    }, data.hasLink ? 'Make a new link' : 'Make the link'),

    data.on
      ? h('button.btn-sm', {
        onclick: async () => {
          if (!confirmAction('Close the list? The link stops opening. Nothing already said is '
            + 'lost, and making a new link opens it again.')) return;
          try {
            await api.lunchClose();
            toast('Closed.', 'good');
            await reload();
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      }, 'Close the list')
      : null,

    h('button.btn-sm', { onclick: () => setDays(data, reload) }, 'When it opens')),

  data.hasLink
    ? h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
      'The link itself is not kept, only a fingerprint of it, so it cannot be shown again. '
      + 'If it is lost, make another.')
    : null));
}

async function showLink(url) {
  await formDialog({
    title: 'The link — copy it now',
    submitLabel: 'Done',
    body: h('div',
      h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', 'This is the only time you will see it'),
          h('div.alert-detail', 'Only a fingerprint is stored. Lose it and you make another, '
            + 'which retires this one.'))),
      h('textarea.link-box', { rows: 3, readonly: true, onclick: (e) => e.target.select() }, url),
      h('div.btn-row',
        h('button.btn-sm.btn-primary', {
          type: 'button',
          onclick: async (e) => {
            try {
              await navigator.clipboard.writeText(url);
              e.target.textContent = 'Copied ✓';
            } catch { toast('Select the text and copy it.', 'bad'); }
          },
        }, 'Copy it'))),
    onSubmit: async () => ({ ok: true }),
  });
}

const WEEKDAYS = [
  [1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'],
  [5, 'Friday'], [6, 'Saturday'], [7, 'Sunday'],
];

/** Which days of the week the list takes answers on. */
async function setDays(data, reload) {
  const on = new Set(String(data.openDays).split(',').map(Number));

  const done = await formDialog({
    title: 'When the list is open',
    submitLabel: 'Save',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'The days answers are taken on, for the week beginning the following Monday. Thursday '
        + 'to Sunday is the usual arrangement: the order goes in over the weekend for the week '
        + 'that starts on Monday.'),
      h('div', { style: { display: 'grid', gap: '.3rem' } },
        WEEKDAYS.map(([n, label]) => h('label.tickline',
          h('input', { type: 'checkbox', name: 'day', value: n, checked: on.has(n) }),
          h('span', label))))),
    onSubmit: async (form) => api.lunchSetDays({ days: form.getAll('day').map(Number) }),
  });

  if (done) { toast('Saved.', 'good'); await reload(); }
}

/** The week's meals, all seven in one submission. */
async function setMenu(data, reload) {
  const fields = data.menu.map((m) => ({
    day: m.day,
    meal: h('input', { type: 'text', maxlength: 120, value: m.meal ?? '', placeholder: 'Nothing that day' }),
    note: h('input', { type: 'text', maxlength: 200, value: m.note ?? '', placeholder: 'Note (optional)' }),
  }));

  const done = await formDialog({
    title: `The menu, week of ${fmtDayShort(data.monday)}`,
    submitLabel: 'Save the week',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'One meal a day, the same for everybody. Leave a day blank where there is nothing, and '
        + 'it comes off the list rather than showing as an empty line.'),
      h('div.lunch-menu-form', fields.map((f) => h('div.lunch-menu-field',
        h('div.lunch-menu-day', fmtDayShort(f.day)),
        f.meal,
        f.note)))),
    onSubmit: async () => api.lunchSetMenu({
      days: fields.map((f) => ({ day: f.day, meal: f.meal.value.trim(), note: f.note.value.trim() })),
    }),
  });

  if (done) { toast('Saved.', 'good'); await reload(); }
}

/** Somebody who told the kitchen in person rather than opening the link. */
async function putThemDown(person, data, reload) {
  const picks = new Map(person.days.map((d) => [d, true]));

  const done = await formDialog({
    title: person.name,
    submitLabel: 'Put them down',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'For somebody who told you rather than opening the link. Untick a day they are not '
        + 'eating; both answers count as having said.'),
      h('div', { style: { display: 'grid', gap: '.3rem' } },
        person.days.map((day) => h('label.tickline',
          h('input', {
            type: 'checkbox', checked: true,
            onchange: (e) => picks.set(day, e.target.checked),
          }),
          h('span', fmtDayShort(day),
            h('small.muted', ` · ${data.menu.find((m) => m.day === day)?.meal ?? 'no menu yet'}`)))))),
    onSubmit: async () => {
      for (const [day, taking] of picks) {
        await api.lunchSetOrder({ staffId: person.id, day, taking });
      }
      return { ok: true };
    },
  });

  if (done) { toast('Put down.', 'good'); await reload(); }
}
