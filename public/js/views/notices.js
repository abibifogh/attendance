import { api } from '../api.js';
import { onLive } from '../live.js';
import { fmtSince as when, h, mount } from '../util.js';

/**
 * The bell.
 *
 * Every submitted check already sends an email. This is the same events kept
 * where somebody who lives in the app will meet them — and, more usefully, the
 * one channel that still works when the email does not. A wrong sending domain
 * or an empty recipient list is invisible until somebody asks why they never
 * heard about Tuesday; here it shows up as a warning the moment it happens.
 *
 * It is a live feed. It used to refresh every couple of minutes, which was the
 * compromise a timer forces: often enough that a manager might see a round land
 * while looking at the screen, rarely enough that a phone left on the counter
 * all day was not asking constantly. Neither half of that is true any more:
 * anything that puts a notice in the bell is said down the same socket the rest
 * of the app listens on, so the count moves when it happens and sits still the
 * rest of the time.
 *
 * OPENING IT IS NOT READING IT. It used to be: the panel marked everything
 * read the moment it appeared, which is fine for a counter and useless for a
 * list. Somebody who opens the bell, sees six things and deals with two has no
 * way back to the other four, because the app has already decided they were
 * all handled. Read is now something a person says, with the button that says
 * it, and until they do the three tabs keep the two piles apart.
 */

/**
 * What the notice is about, said in one character.
 *
 * By kind rather than by level, because "info" is what almost everything is
 * and a column of identical marks tells a reader nothing. Matched on the
 * prefix, so a family of notices shares its mark and a new member of that
 * family arrives with the right one already.
 *
 * A warning or a stop still overrides it. What a notice is about matters less
 * than that it is going wrong, and the border down the side says the same
 * thing in colour for anybody who does not read the mark.
 */
const KIND_ICON = [
  ['attendance.availability', '📆'],
  ['attendance.leave', '🌴'],
  ['attendance.terminal', '📡'],
  ['attendance.query', '❓'],
  ['attendance.days_applied', '✅'],
  ['attendance.times', '⏱'],
  ['attendance.clock', '⏱'],
  ['attendance.not_clocked_in', '⏰'],
  ['attendance.running_late', '🏃'],
  ['attendance', '🕘'],
  ['rota.published', '🗓'],
  ['recruitment', '💼'],
  ['advance', '💵'],
  ['medical', '🩺'],
  ['payroll', '💷'],
  ['birthday', '🎂'],
  ['contract', '📄'],
  ['letter', '✉️'],
  ['correspondence', '✉️'],
  ['month', '📊'],
];

const LEVEL_ICON = { high: '⛔', warn: '⚠️' };

export function iconFor(notice) {
  if (LEVEL_ICON[notice?.level]) return LEVEL_ICON[notice.level];
  const kind = String(notice?.kind ?? '');
  for (const [prefix, icon] of KIND_ICON) {
    if (kind === prefix || kind.startsWith(`${prefix}.`) || kind.startsWith(`${prefix}_`)) {
      return icon;
    }
  }
  return '🔔';
}

/** The three piles, and which notices belong in each. */
export const TABS = [
  ['unread', 'Unread', (n) => n.unread],
  ['all', 'All', () => true],
  ['read', 'Read', (n) => !n.unread],
];

let stopListening = null;

export function noticeBell() {
  const count = h('span.bell-count');
  const panel = h('div.bell-panel');
  const list = h('div.bell-list');
  const tabRow = h('div.bell-tabs');

  let open = false;
  let tab = 'unread';
  let state = { notices: [], unread: 0, latestId: 0 };

  const button = h('button.btn-ghost.btn-sm.bell', {
    title: 'What has happened',
    'aria-label': 'Notifications',
    onclick: (event) => {
      event.stopPropagation();
      open = !open;
      panel.classList.toggle('open', open);
      // Opening lands on whichever pile has something in it. A bell with six
      // waiting opens on the six; a bell with none opens on the list rather
      // than on an empty tab saying there is nothing, which is the answer to a
      // question nobody asked.
      if (open) {
        tab = state.unread ? 'unread' : 'all';
        draw();
      }
    },
  }, '🔔', count);

  const paintCount = () => {
    count.textContent = state.unread > 9 ? '9+' : String(state.unread || '');
    count.classList.toggle('on', state.unread > 0);
    button.classList.toggle('has-unread', state.unread > 0);
  };

  const markAll = async (event) => {
    if (!state.latestId) return;
    event.target.disabled = true;
    try {
      await api.markNoticesSeen(state.latestId);
      state = {
        ...state,
        notices: state.notices.map((n) => ({ ...n, unread: false })),
        unread: 0,
        lastSeen: state.latestId,
      };
      paintCount();
      // Standing on the Unread tab having just emptied it is standing in front
      // of a blank panel. The list they just cleared is the one to show.
      if (tab === 'unread') tab = 'all';
      draw();
    } catch {
      event.target.disabled = false;
    }
  };

  const drawTabs = () => {
    mount(tabRow, TABS.map(([key, label, belongs]) => {
      const n = state.notices.filter(belongs).length;
      return h('button.bell-tab', {
        class: `bell-tab ${tab === key ? 'on' : ''}`,
        'aria-pressed': String(tab === key),
        onclick: () => { tab = key; draw(); },
      }, label, n ? h('span.bell-tab-n', String(n)) : null);
    }));
  };

  const draw = () => {
    drawTabs();
    const belongs = (TABS.find(([key]) => key === tab) ?? TABS[1])[2];
    const showing = state.notices.filter(belongs);

    mount(list, showing.length
      ? showing.map((n) => h('a.bell-item', {
        class: `bell-item ${n.unread ? 'unread' : ''} level-${n.level || 'info'}`,
        href: n.link || '#/',
        onclick: () => { open = false; panel.classList.remove('open'); },
      },
        h('span.bell-icon', iconFor(n)),
        h('div.bell-text',
          h('div.bell-title', n.title),
          n.body ? h('div.bell-body', n.body) : null,
          h('div.bell-when', when(n.at)),
        ),
      ))
      : h('p.muted', { style: { margin: '.5rem .2rem', fontSize: '.86rem' } },
        state.unavailable
          ? 'Notifications need the latest database update before they can be recorded.'
          : tab === 'unread'
            ? 'Nothing waiting. Everything here has been read.'
            : tab === 'read'
              ? 'Nothing read yet.'
              : 'Nothing yet. Anything that happens appears here.'));
  };

  const refresh = async () => {
    try {
      // Enough to fill a Read tab with. Twenty was the whole list when the
      // whole list was the only view of it.
      const data = await api.notices(60);
      state = data;
      paintCount();
      if (open) draw();
    } catch {
      // A bell that cannot count is not worth an error message on somebody's
      // screen. It simply shows nothing until the next attempt.
    }
  };

  // One subscription for the app's lifetime, pointed at whichever bell is on
  // screen. The old one is dropped rather than left listening, or every render
  // of the shell would leave another bell behind counting into nothing.
  stopListening?.();
  stopListening = onLive((event) => {
    if (document.hidden) return;
    // Anything at all: the bell is rung by half the app, so a topic list here
    // would be a list to keep in step with every screen there is. Coming back
    // from a dropped connection counts too — a notice may have landed while
    // this browser was on its own.
    if (event.topics || event.missed) refresh();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  // Clicking anywhere else closes it, which is what every menu on every phone
  // already does.
  document.addEventListener('click', () => {
    if (!open) return;
    open = false;
    panel.classList.remove('open');
  });
  panel.addEventListener('click', (event) => event.stopPropagation());

  mount(panel,
    h('div.bell-head',
      h('strong', 'What has happened'),
      h('button.bell-mark', { onclick: markAll }, 'Mark all as read'),
    ),
    tabRow,
    list,
  );

  refresh();

  return h('div.bell-wrap', button, panel);
}
