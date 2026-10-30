import { add, h, mount } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';
import { systemMark } from '../glyphs.js';
import { state } from '../app.js';

/**
 * The front door.
 *
 * Five systems, one sign-in. A card per system says what it is, whether this
 * person has been given it, and — the part that matters — whether clicking will
 * actually carry their sign-in across or drop them on another login form.
 *
 * A button that silently degrades is worse than no button, so a system that
 * cannot hand over says why, in the sentence, and offers a plain link instead.
 */
export async function renderHub(root) {
  const data = await api('/hub');
  const { account, systems } = data;

  const reachable = systems.filter((s) => s.granted);
  const others = systems.filter((s) => !s.granted);

  add(root,
    account.bootstrap ? banner('demo',
      h('strong', 'You are signed in with the shared password. '),
      'It gets you in to set this up and no further — it cannot be handed over to another system, because a password out of a config file is not a person. Create yourself an account under Accounts, then sign in as yourself.') : null,

    h('div.card',
      h('h2', `Good to see you, ${account.name.split(' ')[0]}`),
      h('p.sub', reachable.length
        ? 'Everything you have been given. Signing in here is enough — you will not be asked again on the other side.'
        : 'Your account has not been given any of the group\'s systems yet. An owner can change that under Settings › People & access.'),
      h('div.grid.two', reachable.map((system) => systemCard(system)))),

    others.length ? h('div.card',
      h('h3', 'Not yours'),
      h('p.sub', 'The rest of the group\'s software. An owner grants these one at a time.'),
      h('div.grid.two', others.map((system) => systemCard(system)))) : null,
  );

  function systemCard(system) {
    const isHere = system.id === 'insight';
    return h('div.tile.syscard',
      // The mark sits beside the heading and its sentence rather than above
      // them, so the eye lands on the shape and reads across. A row of icons
      // stacked over a row of titles is two lists to scan instead of one.
      h('div.syshead',
        h('span.sysmark-slot', { 'aria-hidden': 'true' }, markOf(system)),
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '.5rem', flexWrap: 'wrap' } },
            h('h3', { style: { margin: 0 } }, system.label),
            system.role ? h('span.pill', system.role) : null,
            !system.granted ? h('span.pill', 'not granted') : null),
          h('p.small.muted', { style: { margin: '.15rem 0 0' } }, system.description || ''))),

      // This app is already open, so its card is a link across the tab bar
      // rather than a hand-off — but only for somebody who has actually been
      // given the reports. Offering a button to a tab that does not exist for
      // them is the same broken promise as a sign-in that does not sign them in.
      isHere
        ? (system.granted
          ? h('button.btn', { onclick: () => { location.hash = '#/'; } }, 'Open the numbers')
          : h('p.small.muted', { style: { margin: 0 } }, 'You have not been given the reports.'))
        : system.handOff
          ? h('button.btn.primary', {
            onclick: (event) => open(event, system),
          }, `Open ${system.label} →`)
          // Why first, then the fallback. A button above an explanation reads
          // as the offer and the explanation as small print; the other way
          // round it reads as what it is — this will not carry your sign-in,
          // and here is the door anyway.
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '.4rem' } },
            h('p.small.muted', { style: { margin: 0 } }, system.reason || ''),
            system.homeUrl
              ? h('a.btn', { href: system.homeUrl, target: '_blank', rel: 'noopener' },
                `Go to ${system.label} and sign in there`)
              : null),
    );
  }

  /**
   * Mint a hand-off and follow it.
   *
   * The tab is opened before the request, not after: a browser only allows a
   * new tab in direct response to a click, and by the time an await has
   * resolved that permission is gone and the pop-up is blocked. So the tab is
   * claimed immediately and pointed somewhere once the code exists.
   */
  function open(event, system) {
    return openSystem(event.currentTarget, system, `Open ${system.label} →`);
  }
}

async function openSystem(button, system, label) {
  const tab = window.open('', '_blank', 'noopener');
  button.disabled = true;
  if (label) button.textContent = 'Signing you in…';
  try {
    const { url } = await api('/sso/start', { method: 'POST', body: { systemId: system.id } });
    if (tab) tab.location = url;
    else location.href = url;   // pop-ups blocked: go in this tab instead
  } catch (err) {
    if (tab) tab.close();
    alert(err.message);
  } finally {
    button.disabled = false;
    if (label) button.textContent = label;
  }
}

/**
 * The apps button's panel: each other system this person was given, opened
 * signed in where it can be, and a plain link where it cannot.
 */
export async function appsPanel(el) {
  el.textContent = 'Reading…';
  let systems;
  try { ({ systems } = await api('/hub')); } catch (err) { el.textContent = err.message; return; }
  const mine = systems.filter((s) => s.granted && s.id !== 'insight');
  mount(el,
    h('p.pop-note', mine.length ? 'Open another system, already signed in' : 'You have not been given any other system yet.'),
    h('div.apps', mine.map((system) => (system.handOff
      ? h('button', { type: 'button', onclick: (event) => openSystem(event.currentTarget, system) }, h('span.apps-mark', markOf(system)), system.label)
      : h('a', { href: system.homeUrl || '#', target: '_blank', rel: 'noopener', title: system.reason || '' }, h('span.apps-mark', markOf(system)), system.label)))));
}

/** A system's mark: the one place it is drawn, for its card and for the apps panel. */
function markOf(system) { return systemMark(system.id, system.label); }
