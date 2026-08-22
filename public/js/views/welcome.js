import { api } from '../api.js';
import { h, mount, todayISO } from '../util.js';
import { navigate } from '../app.js';
import { brandMark } from '../brand.js';

/**
 * The first thing somebody sees after signing in.
 *
 * It used to be a toast that said "Welcome, Ama" and slid away after four
 * seconds, which is not a welcome — it is a receipt for a password.
 *
 * WHAT A WELCOME IS FOR. Somebody signing in at twenty past six in the morning
 * has one question, and it is not "did that work". It is "what is waiting for
 * me". So the panel answers that: the time of day and their name, and then the
 * one line that is actually theirs — the next shift for somebody on the rota,
 * the count of days needing a decision for whoever settles them, the number of
 * unread notices for everybody else. Pressing it goes there.
 *
 * ONCE PER SIGN-IN, NOT ONCE PER SCREEN. It appears when a session begins and
 * then not again until the next one. A greeting that reappears every time
 * somebody changes tab is furniture.
 *
 * It is also the one place in the app that is allowed to be warm. Everything
 * else here is a figure somebody is being held to.
 */

const SEEN = 'att.welcomed';

/** Whether this sign-in has already been greeted. */
export function alreadyWelcomed() {
  try {
    return sessionStorage.getItem(SEEN) === todayISO();
  } catch {
    // A browser refusing storage gets the welcome every time, which is a
    // smaller problem than a crash on the way in.
    return false;
  }
}

export function markWelcomed() {
  try {
    sessionStorage.setItem(SEEN, todayISO());
  } catch { /* nothing to do about it, and nothing that depends on it */ }
}

/** Morning, afternoon or evening, from the reader's own clock. */
function partOfDay(hour) {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 22) return 'Good evening';
  return 'Good evening';
}

/**
 * The panel.
 *
 * Drawn immediately with the greeting, and the line underneath fills in when
 * the answer arrives. Nobody should wait on a network round trip to be said
 * hello to.
 */
export function welcomePanel({ name, role, permissions = [] }) {
  const now = new Date();
  const first = String(name ?? '').trim().split(/\s+/)[0] || 'there';

  const held = (key) => permissions.includes(key);
  const line = h('div.welcome-line', h('span.welcome-dim', 'Looking…'));
  const actions = h('div.welcome-actions');

  const panel = h('div.welcome',
    h('div.welcome-mark', brandMark('2.4rem')),
    h('div.welcome-body',
      h('div.welcome-eyebrow', new Intl.DateTimeFormat('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long',
      }).format(now)),
      h('h2.welcome-hello', `${partOfDay(now.getHours())}, ${first}`),
      line,
      actions,
    ),
    h('button.welcome-close', {
      type: 'button',
      'aria-label': 'Close',
      onclick: () => panel.remove(),
    }, '✕'),
  );

  // What is actually waiting for them, which is the only part of this worth
  // reading twice. Asked for after the panel is on screen, and quietly
  // dropped if it fails — a greeting that shows an error is worse than one
  // that shows nothing.
  (async () => {
    const said = await whatIsWaiting({ held });
    if (!said) {
      mount(line, h('span', 'Nothing is waiting for you.'));
      return;
    }
    mount(line, said.text);
    if (said.go) {
      mount(actions, h('button.btn-sm.welcome-go', {
        onclick: () => { panel.remove(); navigate(said.go.path, said.go.params ?? {}); },
      }, said.go.label));
    }
  })();

  return panel;
}

/**
 * One line, chosen by what this person is here to do.
 *
 * In the order somebody would want to be told: their own next shift first if
 * they are on the rota, then whatever is waiting on a decision, then the bell.
 * Never more than one thing — a welcome that lists four is a dashboard.
 */
async function whatIsWaiting({ held }) {
  if (held('att_me')) {
    const mine = await api.myWeek().catch(() => null);
    const next = mine?.next;
    if (next) {
      const when = next.seconds < 3600
        ? 'in under an hour'
        : next.seconds < 24 * 3600
          ? `in ${Math.round(next.seconds / 3600)} hours`
          : `on ${new Intl.DateTimeFormat('en-GB', { weekday: 'long' })
            .format(new Date(`${next.day}T12:00:00Z`))}`;
      return {
        text: h('span', 'Your next shift is ', h('strong', next.shift.name), ' ',
          h('strong', when), `, at ${next.shift.starts_at}.`),
        go: { path: 'att-me', label: 'My shifts' },
      };
    }
    return {
      text: h('span', 'Nothing on your rota just yet.'),
      go: { path: 'att-me', label: 'My shifts' },
    };
  }

  if (held('att_view')) {
    const today = await api.attDay(todayISO()).catch(() => null);
    const open = Number(today?.totals?.openCount) || 0;
    const absent = Number(today?.totals?.daysAbsent) || 0;

    if (open || absent) {
      return {
        text: h('span',
          open ? h('span', h('strong', String(open)), ' to confirm') : null,
          open && absent ? h('span', ' and ') : null,
          absent ? h('span', h('strong', String(absent)), ' absent') : null,
          ' this morning.'),
        go: { path: 'att-today', label: 'The morning list' },
      };
    }
    return {
      text: h('span', 'Everybody is accounted for this morning.'),
      go: { path: 'att-today', label: 'Today' },
    };
  }

  const bell = await api.notices?.().catch(() => null);
  const unread = Number(bell?.unread) || 0;
  return {
    text: unread
      ? h('span', h('strong', String(unread)), ' new since you last looked.')
      : h('span', 'Nothing new since you last looked.'),
    go: null,
  };
}
