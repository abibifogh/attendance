import { api } from './api.js';
import { deriveLoginKey } from './crypto.js';
import { h, mount } from './util.js';
import { isInstalled } from './install.js';
import { IDLE_MINUTES, IDLE_MS, ownTrip, whatToDo } from './guard-rules.js';

/**
 * Watching for the person having gone.
 *
 * A phone put down on a bar with the rota open is a screen anybody walking
 * past can read, and half of what this app holds is nobody else's business:
 * somebody's pay, somebody's leave, who is off sick on Thursday. So the screen
 * does not stay open indefinitely for a room to read.
 *
 * TWO ANSWERS, BECAUSE THERE ARE TWO SITUATIONS. Untouched for five minutes
 * and the session ends: whoever was here has walked away and is not coming
 * back to this screen. Away behind another app and back again, on a phone with
 * HIVE installed, and the PIN is asked: they are standing right there, and
 * signing them out would be answering a small question with a large
 * annoyance.
 *
 * WHAT COUNTS AS ACTIVITY is somebody touching the thing. Not the app talking
 * to itself: a punch landing on the terminal redraws this screen every few
 * minutes on a busy morning, and counting that would mean the phone on the bar
 * never locks at all, which is the whole case this exists for.
 */

let watching = false;
let lastTouch = Date.now();
let hiddenAt = null;
let expectingUntil = null;
let ticker = null;
let locked = false;
let onOut = null;
let whoIsIn = () => ({ signsInWith: 'pin', email: null });

const TICK_MS = 15_000;

/** Somebody touched the screen. */
function touched() {
  lastTouch = Date.now();
}

/**
 * A trip the app sent them on itself.
 *
 * A file picker for their photograph, a print dialog for a payslip, a share
 * sheet. Android backgrounds the app for all three and coming back is not
 * somebody returning to an unattended phone, it is the middle of the job they
 * asked for. Demanding the PIN there would lose the upload they were making.
 */
export function goingOutBriefly(seconds = 120) {
  expectingUntil = Date.now() + seconds * 1000;
}

/** Start watching. Called once, after somebody is signed in. */
export function guard({ signOut, who }) {
  onOut = signOut;
  // Read fresh each time rather than captured: the same page can be signed out
  // of and into again as two different people.
  if (who) whoIsIn = who;
  if (watching) return;
  watching = true;

  for (const kind of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    window.addEventListener(kind, touched, { passive: true, capture: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    // Back. Being brought to the front is not being touched, so the idle clock
    // is left where it was: somebody who put the phone down twenty minutes ago
    // and picked it up is still somebody whose session should have ended.
    const away = hiddenAt == null ? null : Date.now() - hiddenAt;
    hiddenAt = null;
    if (ownTrip(expectingUntil)) { expectingUntil = null; touched(); return; }
    decide(away);
  });

  // The trips the app sends people on itself, caught in one place rather than
  // at ten call sites. A file picker for a photograph or a receipt, and the
  // print dialog for a payslip, both background the app on Android; coming
  // back from one is the middle of the job somebody asked for, not somebody
  // returning to a phone they left on a bar.
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === 'file') goingOutBriefly();
  }, true);
  window.addEventListener('beforeprint', () => goingOutBriefly());

  ticker = setInterval(() => decide(null), TICK_MS);
  touched();
}

/** Stop, on the way out, so a signed-out page is not still counting. */
export function unguard() {
  watching = false;
  locked = false;
  clearInterval(ticker);
  ticker = null;
  document.querySelector('.lock-screen')?.remove();
}

function decide(awayMs) {
  if (!watching || locked) return;

  const answer = whatToDo({
    idleMs: Date.now() - lastTouch,
    awayMs,
    installed: isInstalled(),
  });

  if (answer === 'out') { onOut?.(); return; }
  if (answer === 'lock') showLock();
}

/**
 * The screen that has to be answered before anything else is shown.
 *
 * Over the top of everything rather than in place of it, so nothing is lost:
 * a half-written leave request is still there underneath and is still there
 * afterwards. It cannot be dismissed, only answered or signed out of.
 */
function showLock() {
  if (locked) return;
  locked = true;

  const me = whoIsIn() ?? {};
  // An administrator signs in with a password and may hold no PIN at all, so
  // asking for one would be asking for something they do not have.
  const byPassword = me.signsInWith === 'password';
  const box = h('input.lock-pin', {
    type: 'password',
    inputMode: byPassword ? 'text' : 'numeric',
    autocomplete: byPassword ? 'current-password' : 'off',
    placeholder: byPassword ? 'Your password' : 'Your PIN',
    'aria-label': byPassword ? 'Your password' : 'Your PIN',
  });
  const said = h('p.lock-said');

  const open = async (event) => {
    const typed = box.value;
    if (!typed) { said.textContent = 'Type it in first.'; return; }
    event.target.disabled = true;
    said.textContent = 'Checking…';
    try {
      if (byPassword) {
        const params = await api.passwordSalt(me.email);
        await api.unlock({
          passwordKey: await deriveLoginKey(typed, params.salt, params.iterations),
        });
      } else {
        await api.unlock({ pin: typed });
      }
      locked = false;
      touched();
      screen.remove();
    } catch (err) {
      said.textContent = err.message;
      box.value = '';
      event.target.disabled = false;
      box.focus();
    }
  };

  const screen = h('div.lock-screen',
    h('div.lock-card',
      h('div.lock-mark', h('img', { src: '/icons/hive-192.png', alt: '', width: 44, height: 44 })),
      h('h2', 'Welcome back'),
      h('p.muted', byPassword
        ? 'Type your password to carry on.'
        : 'Type your PIN to carry on. Nothing you were doing has been lost.'),
      h('div.lock-row',
        box,
        h('button.btn.btn-primary', { onclick: open }, 'Open')),
      said,
      h('button.btn-sm.lock-out', { onclick: () => onOut?.() }, 'Sign out instead'),
    ));

  document.body.append(screen);
  // Enter is what a thumb reaches for on a numeric keypad; the button is for
  // everybody else.
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') screen.querySelector('.btn-primary').click();
  });
  setTimeout(() => box.focus(), 0);
}

export { IDLE_MINUTES, IDLE_MS };
