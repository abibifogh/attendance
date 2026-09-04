import { h, mount, toast } from '../util.js';
import { showSheet } from './att-shared.js';
import {
  browserName, canPrompt, inAnotherApp, isAndroid, isApple, isInstalled, onInstallChange,
  openInChromeUrl, promptInstall,
} from '../install.js';

/**
 * Getting HIVE onto a phone, and saying how when the browser will not offer.
 *
 * Half the property never finds this, and the reason is not that they cannot
 * follow instructions. On Android the menu item sits below "Desktop site",
 * past the bottom of a screen nobody thinks to scroll; on an iPhone it is
 * behind an icon Apple never names in words; and a link sent on WhatsApp opens
 * inside WhatsApp, where the option does not exist at all and the page looks
 * completely normal while it does not.
 *
 * So this names the browser somebody is actually holding and says where their
 * button is, rather than describing a menu they do not have.
 */

/**
 * Where the button is on the phone somebody is actually holding.
 *
 * "It is in the menu" is no help to a person in Samsung Internet, where the
 * menu has a different icon and the item has a different name, and it is
 * worse than no help in a window opened by WhatsApp, where there is no menu
 * and never was one.
 *
 * That last case is the commonest and the one nobody guesses. A link sent on
 * WhatsApp opens inside WhatsApp; the page looks completely normal, and
 * somebody spends twenty minutes hunting for a button that was never going
 * to be there. So it is named first, and Android is handed the way out.
 */
export function installSteps(apple = isApple()) {
  const where = browserName();
  const note = (...bits) => h('div.guide-note',
    { style: { marginTop: 0, fontSize: '.83rem' } }, ...bits);

  if (inAnotherApp()) {
    return h('div',
      note(
        h('strong', 'This page is open inside another app, not in a browser. '),
        'A link opened from WhatsApp, Facebook or Instagram opens in that app’s own window, '
        + 'and those windows cannot install anything. Open it in Chrome and the option '
        + 'appears.'),
      isAndroid()
        ? h('div.btn-row', { style: { marginTop: '.6rem' } },
          h('a.btn.btn-primary', { href: openInChromeUrl() }, 'Open in Chrome'))
        : h('p.muted', { style: { fontSize: '.83rem', marginBottom: 0 } },
          'Press the ⋯ or ⌄ in the corner of this window and choose "Open in browser", '
          + 'then try again from there.'));
  }

  if (apple) {
    // Named by its icon, because Apple does not name it in words anywhere on
    // the screen.
    return note(
      h('strong', 'On an iPhone or iPad: '),
      'press Share, the square with the arrow coming out of the top, then ',
      h('strong', 'Add to Home Screen'), '. Safari is the only browser on an iPhone that can '
      + 'do it: Chrome on an iPhone cannot, whatever its menu says.');
  }

  if (where === 'samsung') {
    return note(
      h('strong', 'In Samsung Internet: '),
      'press the three lines at the bottom right, then ', h('strong', 'Add page to'),
      ', then ', h('strong', 'Home screen'), '.');
  }

  if (where === 'firefox') {
    return note(
      h('strong', 'In Firefox: '),
      'press the ⋮ menu, then ', h('strong', 'Install'), ' or ',
      h('strong', 'Add to Home screen'), '.');
  }

  if (where === 'opera') {
    return note(
      h('strong', 'In Opera: '),
      'press the menu, then ', h('strong', 'Add to'), ', then ',
      h('strong', 'Home screen'), '. Opera Mini cannot do it at all; Chrome can.');
  }

  // Chrome, Edge and anything else Chromium. The menu item is near the
  // bottom, below Desktop site, which is why it is so often missed: the list
  // is longer than the screen and nobody scrolls a menu.
  return h('div',
    note(
      h('strong', 'Press the ⋮ at the top right, '),
      'then scroll the menu down to ', h('strong', 'Add to Home screen'),
      '. It sits below "Desktop site", past the bottom of the screen, which is why it '
      + 'looks missing. Press it and choose Install.'),
    h('p.muted', { style: { fontSize: '.83rem', marginBottom: 0 } },
      'Still not there? Sign in first, look at a page or two, then try the menu again. '
      + 'Chrome only offers it once it has seen the site working.'));
}


/**
 * The whole offer: a button where the browser will give one, steps where it
 * will not.
 *
 * `redraw` is called when the browser changes its mind, which it does a moment
 * after a page loads. A button that never appears is indistinguishable from
 * one that does not exist.
 */
export function installCard(redraw = null) {
  if (isInstalled()) return null;

  return h('div',
    h('h3', { style: { fontSize: '.95rem', marginBottom: '.35rem' } }, 'Put HIVE on this device'),
    h('p.muted', { style: { fontSize: '.85rem' } },
      'It opens from the home screen like any other app: no address to type, no browser bars, '
      + 'and it starts even before the signal does.'),

    canPrompt()
      ? h('button.btn-primary', {
        onclick: async (event) => {
          event.target.disabled = true;
          const outcome = await promptInstall();
          if (outcome === 'accepted') toast('Installed. Look for HIVE on your home screen.', 'good');
          else { event.target.disabled = false; if (redraw) redraw(); }
        },
      }, 'Install')
      : installSteps(),
  );
}

/**
 * A line on the way in, for somebody who has never been told this exists.
 *
 * The offer lived under My account, which is a screen people open to change a
 * PIN and otherwise never. So it also sits on the screen staff actually open,
 * once, until they either do it or say no.
 *
 * Dismissed for good rather than for a session. Being asked every morning to
 * install something is how somebody comes to ignore the app in general, and
 * this is a convenience rather than a thing anybody has to do.
 */
const ASKED = 'hive.install.asked';

export function installNudge() {
  if (isInstalled()) return null;
  // A desk is not where this matters, and the browser bar it removes is not in
  // anybody's way there.
  if (!/Android|iPhone|iPad|iPod/.test(navigator.userAgent || '')) return null;
  try { if (localStorage.getItem(ASKED)) return null; } catch { /* private window */ }

  const host = h('div.install-nudge');

  const put = () => {
    try { localStorage.setItem(ASKED, '1'); } catch { /* nothing to remember it with */ }
    mount(host);
  };

  mount(host,
    h('div.install-nudge-what',
      h('strong', 'Keep HIVE on your home screen'),
      h('small.muted', 'It opens like an app, and your shifts are there before the signal is.')),
    h('div.btn-row',
      h('button.btn-sm', { onclick: put }, 'Not now'),
      h('button.btn-sm.btn-primary', {
        onclick: () => {
          showSheet({ title: 'Put HIVE on this phone', body: installCard() });
          put();
        },
      }, 'Show me how')),
  );

  return host;
}

export { isInstalled, onInstallChange };
