import { fmtDayShort, h, mount, toast } from './util.js';

/**
 * The lunch list, as everybody who eats here sees it.
 *
 * Its own page, sharing nothing with the office app but the stylesheet and two
 * helpers. It is opened on a phone, in a corridor, by somebody who has thirty
 * seconds and no account, so it is three taps: find your name, tick the days,
 * done.
 *
 * WHAT IT CAN REACH IS ALMOST NOTHING. First names, the days each person is
 * rostered next week, and the meals. That is the entire surface, and it is
 * deliberate: this address goes on a noticeboard and into a group chat, and
 * everything it could show is something anybody photographing the board could
 * take away.
 */

const root = document.getElementById('lunch');
const token = tokenFrom(location.pathname, 'lunch');

function tokenFrom(pathname, prefix) {
  const parts = pathname.split('/').filter(Boolean);
  const at = parts.lastIndexOf(prefix);
  if (at === -1 || at === parts.length - 1) return '';
  try {
    return decodeURIComponent(parts[at + 1]);
  } catch {
    return parts[at + 1];
  }
}

let list = null;

start();

async function start() {
  if (!token) return fail('This address is not complete. Ask for the link again.');
  try {
    list = await call(`/api/l/${encodeURIComponent(token)}`, null, 'GET');
  } catch (err) {
    return fail(err.message);
  }
  return pickName();
}

// ---------------------------------------------------------------------------
// Finding your name
// ---------------------------------------------------------------------------

/**
 * The list of names, filtered as you type.
 *
 * A property with forty people is a page nobody scrolls, so the box at the top
 * narrows it. Only people who are actually on the rota next week are here:
 * thirty names that cannot order anything is thirty names in the way.
 */
function pickName() {
  const rows = h('div.lunch-people');
  const find = h('input', {
    type: 'search', placeholder: 'Type your name', autocomplete: 'off',
    'aria-label': 'Find your name',
  });

  const draw = () => {
    const want = find.value.trim().toLowerCase();
    const shown = list.people.filter((p) => !want || p.name.toLowerCase().includes(want));
    mount(rows, shown.length
      ? shown.map((person) => h('button.lunch-name', {
        onclick: () => openMine(person),
      }, h('strong', person.first), h('small.muted', person.name)))
      : h('p.muted', 'Nobody by that name is on the rota next week.'));
  };
  find.addEventListener('input', draw);
  draw();

  mount(root, shell(
    h('div.card',
      h('h2', 'Lunch next week'),
      h('p.muted', weekWords(list)),
      list.open
        ? null
        : h('div.alert.warn',
          h('span.alert-icon', '🕒'),
          h('div',
            h('div.alert-title', 'The list is not taking answers yet'),
            h('div.alert-detail', list.opensOn
              ? `It opens on ${fmtDayShort(list.opensOn)}. You can see what is coming below.`
              : 'You can see what is coming below.'))),
    ),

    list.menu.length
      ? h('div.card',
        h('h3', 'On the menu'),
        h('div.lunch-menu', list.menu.map((m) => h('div.lunch-menu-row',
          h('strong', fmtDayShort(m.day)),
          h('span', m.meal),
          m.note ? h('small.muted', m.note) : null))))
      : null,

    h('div.card',
      h('h3', 'Find your name'),
      h('label.field', h('span', 'Your name'), find),
      rows),
  ));
  find.focus();
}

// ---------------------------------------------------------------------------
// Your days
// ---------------------------------------------------------------------------

async function openMine(person) {
  let mine;
  try {
    mine = await call(`/api/l/${encodeURIComponent(token)}/me/${person.id}`, null, 'GET');
  } catch (err) {
    return toast(err.message, 'bad');
  }

  // Nothing said yet reads as no rather than as blank. Somebody who taps
  // straight through has said "not eating", which is the answer the kitchen
  // needs and the one a blank box does not give it.
  const answers = new Map(mine.days.map((d) => [d.day, d.taking ?? false]));

  const rows = mine.days.map((d) => {
    // The word on the right says what the box means, so a row read on its own
    // still answers the question.
    const word = h('span.lunch-day-yes', answers.get(d.day) ? 'Eating' : 'No');
    const tick = h('input', {
      type: 'checkbox',
      checked: answers.get(d.day),
      disabled: !mine.open,
      onchange: (e) => {
        answers.set(d.day, e.target.checked);
        word.textContent = e.target.checked ? 'Eating' : 'No';
      },
    });
    return h('label.lunch-day', { class: mine.open ? '' : 'is-shut' },
      tick,
      h('div.lunch-day-what',
        h('div.lunch-day-name', d.name, h('small.muted', ` · ${fmtDayShort(d.day)}`)),
        d.meal
          ? h('div.lunch-day-meal', d.meal, d.note ? h('small.muted', ` · ${d.note}`) : null)
          : h('div.lunch-day-meal.muted', 'The menu for this day is not up yet')),
      word);
  });

  const save = h('button.btn.btn-primary.lunch-save', {
    disabled: !mine.open,
    onclick: async () => {
      save.disabled = true;
      try {
        await call(`/api/l/${encodeURIComponent(token)}/me/${person.id}`, {
          days: mine.days.map((d) => ({ day: d.day, taking: answers.get(d.day) === true })),
        });
        done(mine, answers);
      } catch (err) {
        save.disabled = false;
        toast(err.message, 'bad');
      }
    },
  }, 'That is my week');

  mount(root, shell(
    h('div.card',
      h('button.btn-sm.invite-back', { onclick: () => pickName() }, '‹ Not me'),
      h('h2', `Hello, ${mine.who.first}`),
      h('p.muted', mine.days.length
        ? `You are down to work ${mine.days.length} day${mine.days.length === 1 ? '' : 's'} `
          + `next week. Tick the ones you are eating.`
        : 'You are not down to work next week, so there is nothing to order.')),

    mine.days.length
      ? h('div.card', h('div.lunch-days', rows), save)
      : null,

    mine.open
      ? null
      : h('p.muted', { style: { textAlign: 'center' } },
        'The list is shut, so this is only what was already said.'),
  ));
  window.scrollTo(0, 0);
}

function done(mine, answers) {
  const taking = mine.days.filter((d) => answers.get(d.day) === true);

  mount(root, shell(
    h('div.card.lunch-done',
      h('div.lunch-tick', '✓'),
      h('h2', 'Thank you'),
      taking.length
        ? h('div',
          h('p.muted', `You are down for lunch on ${taking.length} `
            + `day${taking.length === 1 ? '' : 's'}:`),
          h('ul.lunch-summary', taking.map((d) => h('li',
            h('strong', d.name), d.meal ? h('span.muted', ` · ${d.meal}`) : null))))
        : h('p.muted', 'You are not down for lunch on any day next week.'),
      h('p.muted', { style: { fontSize: '.85rem' } },
        mine.closesAfter
          ? `You can change your mind until the end of ${fmtDayShort(mine.closesAfter)}. `
            + 'Open the link again and find your name.'
          : 'Open the link again to change it.'),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => pickName() }, 'Somebody else')),
    ),
  ));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------

const weekWords = (data) => `The week of ${fmtDayShort(data.monday)}`
  + `${data.closesAfter ? `. Answers close at the end of ${fmtDayShort(data.closesAfter)}` : ''}`;

function shell(...children) {
  return h('div.invite-inner',
    h('header.invite-head', h('div.invite-brand', list?.property || 'Lunch')),
    ...children,
  );
}

function fail(message) {
  mount(root, h('div.invite-inner',
    h('header.invite-head', h('div.invite-brand', 'Lunch')),
    h('div.card',
      h('h2', 'This link will not open'),
      h('p', message),
      h('p.muted', 'The list may be closed for the season, or the address may have been '
        + 'replaced. Ask whoever runs the kitchen for the current one.'),
    ),
  ));
}

async function call(path, body, method = 'POST') {
  const response = await fetch(path, {
    method,
    headers: body == null ? {} : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  }).catch(() => null);

  if (!response) throw new Error('No connection. Check your data and try again.');

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}
