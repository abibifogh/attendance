import { api } from '../api.js';
import { fmtDayShort, h, mount, shiftDay, toast } from '../util.js';
import { card, emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';
import { replaceParams } from '../app.js';

/**
 * My lunch.
 *
 * WHAT WAS MISSING. All of this happened on one address outside the app: find
 * your name, tick four boxes, and that was the last you saw of your own
 * answer. Once the window shut there was nowhere that would tell you what you
 * had said, so "am I down for Thursday?" was a question you asked a person in
 * a kitchen, and the answer to "I did order" was nobody's to check.
 *
 * TWO STATES, AND THE PAGE SAYS WHICH IT IS IN. While the list is open,
 * changing your mind is changing your mind: nothing has been ordered, nobody
 * has read the number, and putting somebody in a queue to change an answer
 * they could change on the link a minute ago would be ceremony. Once it shuts,
 * the count has gone to the kitchen, so a change is asked for and waits for
 * whoever has to buy the food.
 *
 * THE WHOLE WEEK, INCLUDING DAYS THEY ARE NOT IN. A day they are not working
 * is drawn and greyed rather than left out, because a list of three rows on a
 * seven-day week reads as the app having lost half of it.
 */
export async function renderAttMyLunch(params = {}) {
  const host = h('div');
  const data = await api.myLunch(params.week).catch((err) => ({ error: err.message }));

  const reload = async (next = {}) => {
    if (next.week !== undefined) replaceParams('att-my-lunch', { week: next.week });
    mount(host, await renderAttMyLunch({ ...params, ...next }));
  };

  if (data.error) {
    mount(host, h('div.page-head', h('h1', 'My lunch')),
      emptyState('Nothing to show yet', data.error));
    return host;
  }

  if (!data.on) {
    mount(host, h('div.page-head', h('h1', 'My lunch')),
      emptyState('The lunch list is off',
        'Nobody is being asked about lunch at the moment. If that is wrong, speak to whoever '
        + 'runs the kitchen.'));
    return host;
  }

  const mine = data.days.filter((d) => d.rostered);
  const thisIsTheWeek = data.monday === data.orderingFor;

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'My lunch'),
        h('div.sub', `Week of ${fmtDayShort(data.monday)}`
          + (thisIsTheWeek ? ' · the week being ordered' : '')),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => reload({ week: shiftDay(data.monday, -7) }) }, '‹'),
        h('button.btn-sm', { onclick: () => reload({ week: null }) }, 'The coming week'),
        h('button.btn-sm', { onclick: () => reload({ week: shiftDay(data.monday, 7) }) }, '›'),
      ),
    ),

    stateLine(data),

    card('My week', { wide: true, note: `${mine.filter((d) => d.taking).length} lunches` },
      mine.length
        ? h('div.me-list', mine.map((day) => dayRow(day, data, reload)))
        : h('p.muted', 'You are not down to work any day this week, so there is no lunch to '
          + 'order. If you are coming in anyway, ask whoever runs the kitchen to put you down.')),

    data.answered.length
      ? card('What was said about my changes', { wide: true, note: `${data.answered.length}` },
        h('div.me-list', data.answered.map((row) => answeredRow(row))))
      : null,
  );

  return host;
}

/**
 * Whether the list is taking answers, said as what it means for them.
 *
 * Not "the window is closed at 09:14". Somebody standing in a corridor wants
 * to know whether they can change Thursday, and if not, who can.
 */
function stateLine(data) {
  if (data.open) {
    return h('div.alert.info', { style: { display: 'block' } },
      h('div.alert-title', 'The list is open'),
      h('div.alert-detail', 'Change any day yourself and it takes effect straight away. '
        + (data.closesOn ? `It shuts ${whenShort(data.closesOn)}.` : '')));
  }
  return h('div.alert.warn', { style: { display: 'block' } },
    h('div.alert-title', 'The list is shut for this week'),
    h('div.alert-detail', 'The count has gone to the kitchen, so a change is asked for rather '
      + 'than made, and whoever runs the kitchen decides. '
      + (data.opensOn ? `It opens again ${whenShort(data.opensOn)}.` : '')));
}

/** A 'YYYY-MM-DD HH:MM' as somebody would say it. */
function whenShort(stamp) {
  if (!stamp) return '';
  const [day, time] = String(stamp).split(' ');
  return time ? `on ${fmtDayShort(day)} at ${time}` : `on ${fmtDayShort(day)}`;
}

/** One day: what it is, what I said, and the one thing I can do about it. */
function dayRow(day, data, reload) {
  const said = day.taking === null ? 'Not said'
    : day.taking ? 'Eating' : 'Not eating';
  const pill = day.taking === null ? 'warn' : day.taking ? 'good' : '';

  return h('div.me-day',
    h('div.me-when',
      h('strong', fmtDayShort(day.day).split(' ')[1] ?? fmtDayShort(day.day)),
      h('small.muted', day.name)),
    h('div.me-what',
      h('strong', day.meal || 'The menu for this day is not up yet'),
      day.note ? h('small.muted', day.note) : null,
      day.asking
        ? h('small.muted',
          `Asked to be ${day.asking.want ? 'put down' : 'taken off'}, waiting on the kitchen`)
        : null),
    h('div.me-was',
      h(`span.pill${pill ? `.${pill}` : ''}`, said),
      day.asking
        ? h('button.btn-sm', {
          style: { marginLeft: '.4rem' },
          onclick: async () => {
            try {
              await api.myLunchWithdraw(day.asking.id);
              toast('Taken back.');
              await reload();
            } catch (err) { toast(err.message, 'bad'); }
          },
        }, 'Take it back')
        : h('button.btn-sm', {
          style: { marginLeft: '.4rem' },
          onclick: () => changeDay(day, data, reload),
        }, data.open ? 'Change' : 'Ask to change')),
  );
}

/** What the kitchen said, kept where they can read it again. */
function answeredRow(row) {
  const ok = row.decision === 'approved';
  return h('div.me-day',
    h('div.me-when',
      h('strong', fmtDayShort(row.day).split(' ')[1] ?? fmtDayShort(row.day)),
      h('small.muted', fmtDayShort(row.day).split(' ')[0] ?? '')),
    h('div.me-what',
      h('strong', row.want ? 'Asked to be put down' : 'Asked to be taken off'),
      row.decisionNote ? h('small.muted', `“${row.decisionNote}”`) : null,
      row.decidedBy ? h('small.muted', `${ok ? 'Agreed' : 'Refused'} by ${row.decidedBy}`) : null),
    h('div.me-was', h(`span.pill.${ok ? 'good' : 'bad'}`, ok ? 'Agreed' : 'Not agreed')),
  );
}

/**
 * Asking for a day to be different.
 *
 * One question, because there is only one: they want the opposite of what they
 * have. The dialog says which way round it is going rather than offering two
 * boxes to think about.
 */
async function changeDay(day, data, reload) {
  const want = !(day.taking === true);

  const done = await formDialog({
    title: `${day.name}, ${fmtDayShort(day.day)}`,
    submitLabel: data.open ? 'Change it' : 'Ask the kitchen',
    body: h('div',
      h('p', h('strong', want ? 'Put me down for lunch' : 'Take me off lunch'),
        day.meal ? h('small.muted', ` · ${day.meal}`) : null),
      h('p.muted', { style: { fontSize: '.85rem' } }, data.open
        ? 'The list is open, so this takes effect straight away.'
        : 'The list is shut and the count has gone to the kitchen, so this is a request. '
          + 'Whoever runs the kitchen will say yes or no, and you will be told which.'),
      data.open
        ? null
        : field('Why', h('input', { type: 'text', name: 'note', maxlength: 200 }),
          'Optional, and it helps. A reason is what somebody says yes to'),
    ),
    onSubmit: async (form) => api.myLunchAsk({
      day: day.day,
      want,
      note: form.get('note') || null,
    }),
  });

  if (!done) return;
  toast(done.changed ? 'Changed.' : 'Asked. The kitchen will answer.', 'good');
  await reload();
}
