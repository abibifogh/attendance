import { api } from '../api.js';
import { confirmAction, fmtDayShort, h, mount, shiftDay, toast } from '../util.js';
import { card, emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';
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
  // Two different weeks, and the screen has to be able to name both. The one
  // being ordered is what the kitchen buys against; the one we are standing in
  // is what it cooks today, and that is the one it opens on.
  const thisIsTheWeek = data.monday === window.monday;
  const weekEnd = shiftDay(data.monday, 6);
  const onThisWeek = data.today >= data.monday && data.today <= weekEnd;

  mount(host,
    h('div.page-head.no-print',
      h('div',
        h('h1', 'Lunch'),
        h('div.sub', `Week of ${fmtDayShort(data.monday)}`
          + (onThisWeek ? ' · this week' : '')
          + (thisIsTheWeek ? ' · the week being ordered' : '')),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => reload({ week: shiftDay(data.monday, -7) }) }, '‹'),
        onThisWeek
          ? null
          : h('button.btn-sm', { onclick: () => reload({ week: null }) }, 'This week'),
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
      h('div.btn-row.no-print', { style: { marginTop: '.5rem' } },
        h('button.btn-sm', { onclick: () => putAnybodyDown(data, reload) }, 'Put somebody down'),
        // The receipt goes on its own when the list shuts. This is for a
        // kitchen that has just put four people down by hand and wants to tell
        // them now, and for a week worth sending again after a change.
        h('button.btn-sm', { onclick: () => tellThem(data, reload) },
          data.toldFor === data.monday ? 'Send it again' : 'Tell everybody what they ordered'),
        h('p.muted', { style: { fontSize: '.85rem', margin: 0 } },
          'The number is what you order against. The names under it are so you can check it.'))),

    // Off the printout. What the kitchen carries out of here is the count and
    // the names; the menu is the thing they are cooking from memory anyway,
    // and on paper it pushed the sheet onto a second page.
    card('What is being served', {
      wide: true,
      cls: 'no-print',
      note: 'The same every week',
      actions: h('button.btn-sm', { onclick: () => setMenu(data, reload) }, 'Set the menu'),
    },
    h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
      'One meal a day, the same for everybody, and it repeats. Monday is this every Monday '
      + 'until somebody changes it.'),
    h('div.lunch-menu-grid', data.menu.map((m) => h('div.lunch-menu-cell',
      h('div.lunch-menu-day', m.short),
      m.meal
        ? h('div', h('strong', m.meal), m.note ? h('div', h('small.muted', m.note)) : null)
        : h('span.muted', 'Not set'))))),

    data.waiting.length
      ? card('Still to say', {
        wide: true,
        cls: 'no-print',
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

    // ABOVE EVERYTHING THAT IS ONLY READING. The rest of this screen is a
    // count and three lists; this is the one part somebody has to decide
    // about, and a decision under a fold is a decision that waits a week.
    data.changes?.length
      ? card('Waiting on you', {
        wide: true,
        cls: 'no-print',
        note: `${data.changes.length} to answer`,
      },
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Asked for after the list shut, so the count you ordered against has already gone. '
        + 'Saying yes changes the plate as well, so there is nothing to remember afterwards.'),
      h('div.lunch-waiting', data.changes.map((ask) => h('div.lunch-waiting-row',
        h('div',
          h('strong', ask.name),
          h('div', h('small.muted',
            `${ask.want ? 'Wants lunch on' : 'Wants to come off'} ${fmtDayShort(ask.day)}`
            + `${ask.note ? ` \u00b7 \u201c${ask.note}\u201d` : ''}`))),
        h('div.btn-row',
          h('button.btn-sm', { onclick: () => decideChange(ask, 'declined', reload) }, 'No'),
          h('button.btn.btn-primary.btn-sm', {
            onclick: () => decideChange(ask, 'approved', reload),
          }, 'Yes')))))) 
      : null,

    // EVERY ANSWER IS SOMEWHERE ON THIS PAGE. Without this one, saying no put
    // somebody in neither list: not under a day, because they are not eating,
    // and not in the chase list, because they answered. Somebody who filled
    // the form in appeared nowhere, and "but I did order" could not be checked
    // against anything.
    data.declined?.length
      ? card('Said no', {
        wide: true,
        cls: 'no-print',
        note: `${data.declined.length} ${data.declined.length === 1 ? 'person' : 'people'}`,
      },
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Answered, and not eating. Nothing to chase. It is here so that somebody who says they '
        + 'answered can be found, and so a no can be turned into a yes if they change their '
        + 'mind.'),
      h('div.lunch-waiting', data.declined.map((person) => h('div.lunch-waiting-row',
        h('div',
          h('strong', person.name),
          h('div', h('small.muted', `no for ${person.days.map((d) => fmtDayShort(d)).join(' \u00b7 ')}`))),
        h('button.btn-sm.no-print', {
          // Nothing ticked to begin with. The days against this name are the
          // ones they said no to, and opening the dialog with those ticked
          // would be the screen proposing the opposite of what they said.
          onclick: () => putThemDown({ ...person, days: [] }, data, reload, { anyDay: true }),
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

/** A 'YYYY-MM-DD HH:MM' as somebody would say it. */
function whenShort(stamp) {
  if (!stamp) return '';
  const [day, time] = String(stamp).split(' ');
  return time ? `${fmtDayShort(day)} at ${time}` : fmtDayShort(day);
}

/**
 * Whether the list is taking answers, and when it next will be.
 *
 * Three states, not two. Off at the switch is a decision somebody made and
 * stays until they unmake it; shut is the clock, and it says the hour it opens
 * because "Thursday" is not an answer to "when can I put my name down".
 */
function windowLine(data, window, thisIsTheWeek, reload) {
  const off = !data.on;
  const open = window.open;

  return h('div.alert.no-print', { class: open ? 'good' : (off ? 'warn' : '') },
    h('span.alert-icon', open ? '🟢' : (off ? '⏸️' : '🕒')),
    h('div',
      h('div.alert-title', off
        ? 'Turned off'
        : open
          ? `Open until ${whenShort(window.closesOn)}`
          : `Shut. Opens ${whenShort(window.opensOn)}`),
      h('div.alert-detail', off
        ? 'Nobody can answer, whatever the times say. The link still works and says so.'
        : open
          ? `Answers are being taken for the week of ${fmtDayShort(window.monday)}.`
          : `When it opens it will be for the week of ${fmtDayShort(window.monday)}.`)),
    thisIsTheWeek ? null : h('button.btn-sm', {
      style: { marginLeft: 'auto' },
      // Named rather than left as "the default". The default is this week now,
      // and this button is the one that goes to the other one.
      onclick: () => reload({ week: window.monday }),
    }, 'Go to that week'));
}

const dayLabel = (n) => (WEEKDAYS.find(([d]) => d === Number(n)) ?? [0, ''])[1];

/** The address the list lives at. */
function linkCard(data, reload) {
  // Furniture for whoever runs the list, not for the sheet that goes to the
  // kitchen, so it stays off the print.
  return h('div.no-print', { style: { gridColumn: '1 / -1' } },
  card('The link staff order on', {
    wide: true,
    note: data.on ? 'taking answers on a timer' : 'turned off',
  },
  h('p.muted', { style: { fontSize: '.9rem' } },
    'One address for the whole property, and it does not change. Put it on the noticeboard '
    + 'once and leave it there: whoever opens it finds their own name, sees the days they are '
    + 'down to work next week, and ticks the ones they are eating. It shows first names, '
    + 'rostered days and the menu, and nothing else about anybody.'),

  h('p.muted.lunch-when-said', { style: { fontSize: '.9rem' } },
    'It opens ', h('strong', dayLabel(data.schedule?.opensDow), ' at ', data.schedule?.opensAt),
    ' and shuts ', h('strong', dayLabel(data.schedule?.closesDow), ' at ', data.schedule?.closesAt),
    ', every week, on its own.'),

  h('div.btn-row',
    h('button.btn.btn-primary', { onclick: () => setSchedule(data, reload) }, 'When it opens'),

    h('button.btn-sm', {
      onclick: async () => {
        if (data.on && !confirmAction('Turn the list off? Nobody can answer until it is turned '
          + 'back on, whatever the times say. The link and everything already said are '
          + 'untouched.')) return;
        try {
          await api.lunchSwitch({ on: !data.on });
          toast(data.on ? 'Turned off.' : 'Turned on.', 'good');
          await reload();
        } catch (err) {
          toast(err.message, 'bad');
        }
      },
    }, data.on ? 'Turn it off' : 'Turn it on'),

    h('button.btn-ghost.btn-sm', {
      title: data.hasLink
        ? 'Only if the address has got out. Everybody has to be given the new one.'
        : 'Make the address staff will use',
      onclick: async () => {
        if (data.hasLink && !confirmAction('Make a new address? The one on the noticeboard stops '
          + 'working the moment this one is made, and everybody has to be given the new one. '
          + 'You do not need this to open or shut the list.')) return;
        try {
          const made = await api.lunchMakeLink();
          await showLink(made.url);
          await reload();
        } catch (err) {
          toast(err.message, 'bad');
        }
      },
    }, data.hasLink ? 'Replace the address' : 'Make the link')),

  data.hasLink
    ? h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
      'The link itself is not kept, only a fingerprint of it, so it cannot be shown again. '
      + 'Turning the list off and on again does not touch it; only replacing it does.')
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

/**
 * The two moments the list opens and shuts on, every week.
 *
 * Days and times. "Open on Thursday" leaves the kitchen and everybody else
 * disagreeing about Thursday evening, and the disagreement only ever shows up
 * as a plate too few.
 */
async function setSchedule(data, reload) {
  const s = data.schedule ?? {};
  const dayPick = (name, value) => h('select', { name },
    WEEKDAYS.map(([n, label]) => h('option', { value: n, selected: n === Number(value) }, label)));
  const timePick = (name, value) => h('input', { type: 'time', name, value: value || '00:00', required: true });

  const opensDow = dayPick('opensDow', s.opensDow ?? 4);
  const opensAt = timePick('opensAt', s.opensAt ?? '00:00');
  const closesDow = dayPick('closesDow', s.closesDow ?? 1);
  const closesAt = timePick('closesAt', s.closesAt ?? '00:00');

  const done = await formDialog({
    title: 'When the list opens and shuts',
    submitLabel: 'Save',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
        'The same two moments every week. Answers are for the week beginning the first Monday '
        + 'after it shuts, so everybody putting their name down in one window is ordering for '
        + 'the same week.'),
      h('div.lunch-when',
        h('div.lunch-when-row',
          h('span.lunch-when-label', 'Opens'), opensDow, h('span.muted', 'at'), opensAt),
        h('div.lunch-when-row',
          h('span.lunch-when-label', 'Shuts'), closesDow, h('span.muted', 'at'), closesAt)),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Thursday 00:00 to Monday 00:00 is the usual arrangement: the order goes in over the '
        + 'weekend for the week that starts on the Monday.')),
    onSubmit: async () => api.lunchSetSchedule({
      opensDow: Number(opensDow.value),
      opensAt: opensAt.value,
      closesDow: Number(closesDow.value),
      closesAt: closesAt.value,
    }),
  });

  if (done) { toast('Saved.', 'good'); await reload(); }
}

/**
 * The standing week's meals, all seven in one submission.
 *
 * Set once. Monday is the same thing every Monday until somebody says
 * otherwise, which is what a kitchen actually does: nobody sits down each week
 * and decides afresh what Wednesday is.
 */
async function setMenu(data, reload) {
  const fields = data.menu.map((m) => ({
    dow: m.dow,
    name: m.name,
    meal: h('input', { type: 'text', maxlength: 120, value: m.meal ?? '', placeholder: 'Nothing that day' }),
    note: h('input', { type: 'text', maxlength: 200, value: m.note ?? '', placeholder: 'Note (optional)' }),
  }));

  const done = await formDialog({
    title: 'The menu, every week',
    submitLabel: 'Save the week',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'One meal a day, the same for everybody, and the same every week. Change it here and it '
        + 'changes from the next list onwards. Leave a day blank where there is nothing and it '
        + 'comes off rather than showing as an empty line.'),
      h('div.lunch-menu-form', fields.map((f) => h('div.lunch-menu-field',
        h('div.lunch-menu-day', f.name),
        f.meal,
        f.note)))),
    onSubmit: async () => api.lunchSetMenu({
      days: fields.map((f) => ({ dow: f.dow, meal: f.meal.value.trim(), note: f.note.value.trim() })),
    }),
  });

  if (done) { toast('Saved.', 'good'); await reload(); }
}

/** Somebody who told the kitchen in person rather than opening the link. */
/**
 * Put somebody down, whether the rota expects them or not.
 *
 * The link asks staff about the days they are working, because asking anybody
 * about a day they are at home invites an answer the kitchen then cooks for.
 * That is the right rule for a form somebody fills in alone. It is the wrong
 * rule for whoever runs the kitchen: a manager in on their day off, somebody
 * covering at the last minute, a person on leave who is in for a meeting. Here
 * anybody can be put down for any day, and the days the rota does not expect
 * them on say so rather than being hidden.
 */
async function putThemDown(person, data, reload, { anyDay = false } = {}) {
  const expected = new Set(person.days ?? []);
  const days = anyDay ? data.week : (person.days ?? []);
  const picks = new Map(days.map((d) => [d, expected.has(d) || Boolean(person.taking?.has?.(d))]));

  const mealOn = (day) => data.onTheDay?.find((m) => m.day === day)?.meal ?? 'no menu yet';

  const done = await formDialog({
    title: person.name,
    submitLabel: 'Put them down',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        anyDay
          ? 'Any day of the week, whether they are on the rota or not. Tick what they are '
            + 'eating; an unticked day counts as having said no.'
          : 'For somebody who told you rather than opening the link. Untick a day they are not '
            + 'eating; both answers count as having said.'),
      h('div', { style: { display: 'grid', gap: '.3rem' } },
        days.map((day) => h('label.tickline',
          h('input', {
            type: 'checkbox', checked: picks.get(day) === true,
            onchange: (e) => picks.set(day, e.target.checked),
          }),
          h('span', fmtDayShort(day),
            h('small.muted', ` \u00b7 ${mealOn(day)}`),
            anyDay && !expected.has(day)
              ? h('small.muted.lunch-not-in', ' \u00b7 not on the rota')
              : null))))),
    onSubmit: () => api.lunchSetOrder({
      staffId: person.id,
      days: [...picks].map(([day, taking]) => ({ day, taking })),
    }),
  });

  if (done) { toast(`${done.name ?? 'Put'} down.`, 'good'); await reload(); }
}

/** Anybody on the payroll, and any day of the week being looked at. */
async function putAnybodyDown(data, reload) {
  const people = [...data.staff].sort((a, b) => a.name.localeCompare(b.name));
  if (!people.length) return toast('Nobody to put down yet.', 'warn');

  const pick = h('select', { name: 'who' },
    people.map((p) => h('option', { value: p.id }, p.name)));

  const chosen = await formDialog({
    title: 'Put somebody down',
    submitLabel: 'Pick the days',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
        'Anybody, on any day of this week, whether the rota has them in or not.'),
      field('Who', pick)),
    onSubmit: async () => ({ id: Number(pick.value) }),
  });
  if (!chosen) return null;

  const person = people.find((p) => p.id === chosen.id);
  const rostered = data.rosteredBy?.[String(chosen.id)] ?? [];
  return putThemDown({ ...person, days: rostered }, data, reload, { anyDay: true });
}

/**
 * Yes or no to a change, with a line to say why where it is no.
 *
 * A refusal reaches the person who asked, so it needs something in it. Yes
 * does not: the plate changing is the whole message.
 */
async function decideChange(ask, decision, reload) {
  const yes = decision === 'approved';

  const done = await formDialog({
    title: ask.name,
    submitLabel: yes ? 'Yes, change it' : 'No',
    body: h('div',
      h('p', h('strong', `${ask.want ? 'Lunch on' : 'Off lunch on'} ${fmtDayShort(ask.day)}`)),
      ask.note ? h('p.muted', { style: { fontSize: '.85rem' } }, `\u201c${ask.note}\u201d`) : null,
      h('p.muted', { style: { fontSize: '.85rem' } }, yes
        ? 'They go down as ' + (ask.want ? 'eating' : 'not eating')
          + ' straight away, and the count above changes with it.'
        : 'They are told, so say what you can. Nobody else sees this.'),
      field(yes ? 'Anything to add' : 'Why', h('input', {
        type: 'text', name: 'note', maxlength: 300,
      }), yes ? 'Optional' : 'They read this'),
    ),
    onSubmit: async (form) => api.lunchDecideChange(ask.id, {
      decision,
      note: form.get('note') || null,
    }),
  });

  if (!done) return;
  toast(yes ? 'Changed, and they have been told.' : 'Answered.', yes ? 'good' : '');
  await reload();
}

/**
 * Emailing everybody their own week.
 *
 * Asked first, because it is a message to the whole property and a button that
 * sends one without asking is a button somebody presses twice.
 */
async function tellThem(data, reload) {
  const again = data.toldFor === data.monday;
  if (!confirmAction(
    'Email everybody who answered for this week, saying which days they are down for and what '
    + 'is being served? Anybody who said nothing gets nothing: there is nothing to confirm, '
    + 'and chasing them is what the lists below are for.'
    + (again ? '\n\nThis week has already been sent once.' : ''),
  )) return;

  try {
    const out = await api.lunchTell(data.monday);
    toast(out.sent
      ? `${out.sent} told.${out.noAddress ? ` ${out.noAddress} have no email address on file.` : ''}`
      : 'Nobody could be told: no email addresses on file, or email is not set up.',
    out.sent ? 'good' : 'bad');
    await reload();
  } catch (err) {
    toast(err.message, 'bad');
  }
}
