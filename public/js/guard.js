import { api } from './api.js';
import { deriveLoginKey } from './crypto.js';
import { h, mount } from './util.js';
import { IDLE_MINUTES, IDLE_MS, lockOnOpening, ownTrip, whatToDo } from './guard-rules.js';

/**
 * Watching for the person having gone.
 *
 * A phone put down on a bar with the rota open is a screen anybody walking
 * past can read, and half of what this app holds is nobody else's business:
 * somebody's pay, somebody's leave, who is off sick on Thursday. So the screen
 * does not stay open indefinitely for a room to read.
 *
 * ONE ANSWER, AND ONE TRIGGER. Untouched for five minutes and the PIN is
 * asked, over the top of whatever was on the screen. Nothing is lost: a
 * half-written leave request is still underneath it and still there
 * afterwards, because somebody who left the phone for six minutes is usually
 * the same person coming back to it, and throwing their work away would be
 * answering a small question with a large annoyance.
 *
 * It used to ask on the way back from another app as well, and that was
 * wrong: looking something up in WhatsApp and coming back is how people work.
 *
 * WHAT COUNTS AS ACTIVITY is somebody touching the thing. Not the app talking
 * to itself: a punch landing on the terminal redraws this screen every few
 * minutes on a busy morning, and counting that would mean the phone on the bar
 * never locks at all, which is the whole case this exists for.
 *
 * AND THE CLOCK IS WRITTEN DOWN. Closing the app and opening it again is not a
 * reload. On a phone it comes back with the session cookie still good for
 * weeks, and the app used to open straight on somebody's pay with nobody
 * having proved they were the person who put it down. A clock held only in
 * memory could not see that, because the app it lived in was gone. So the last
 * time anybody touched the screen is kept where it survives being shut, and
 * opening the app asks the same question as any other five minutes away.
 */

let watching = false;
let lastTouch = Date.now();
let expectingUntil = null;
let ticker = null;
let locked = false;
let onOut = null;
let onShortPin = null;
let whoIsIn = () => ({ signsInWith: 'pin', email: null });

const TICK_MS = 15_000;
const SEEN_KEY = 'att.lastSeen';

/**
 * The clock, kept somewhere the app being closed cannot reach.
 *
 * Written at most once a tick rather than on every touch: a scroll is a
 * hundred events and a storage write on each of them is a stutter on the one
 * device this app has to be smooth on. Fifteen seconds of slack against a five
 * minute rule is nothing.
 *
 * Wrapped, because a browser with storage refused throws on the read as well
 * as the write, and a phone that will not remember is a phone that locks every
 * time rather than one that cannot start.
 */
function writeSeen(at = Date.now()) {
  // Never while the lock is up. Leaving a locked phone writes the moment it
  // was locked otherwise, and opening it again reads that back as somebody
  // having just been here — which is the lock letting itself off.
  if (locked) return false;
  try {
    localStorage.setItem(SEEN_KEY, String(at));
    return true;
  } catch { return false; }
}

function readSeen() {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}

/**
 * Whether this phone can remember anything at all.
 *
 * Asked by writing, because reading tells you nothing: a browser with storage
 * refused reads back null, which is indistinguishable from a session nobody
 * has ever opened. Told apart here, or somebody in a private window would be
 * locked out of an app they had just signed into, over and over.
 *
 * Its own key, written and taken away again, so the probe cannot be mistaken
 * for the clock it is checking the storage for.
 */
function remembers() {
  try {
    const probe = `${SEEN_KEY}.probe`;
    localStorage.setItem(probe, '1');
    const back = localStorage.getItem(probe);
    localStorage.removeItem(probe);
    return back === '1';
  } catch { return false; }
}

/**
 * Somebody has just proved who they are.
 *
 * Called by the sign-in, before the watch starts, so that signing in is never
 * followed by being asked for the same PIN a second time.
 */
export function justProved() {
  writeSeen();
}

/** On the way out, so the next person to open it is asked. */
export function forgetSeen() {
  try { localStorage.removeItem(SEEN_KEY); } catch { /* nothing to do */ }
}

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
export function guard({ signOut, who, shortPin }) {
  onOut = signOut;
  onShortPin = shortPin ?? onShortPin;
  // Read fresh each time rather than captured: the same page can be signed out
  // of and into again as two different people.
  if (who) whoIsIn = who;
  if (watching) return;
  watching = true;

  for (const kind of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    window.addEventListener(kind, touched, { passive: true, capture: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Back, and coming back is not by itself a reason to ask for anything.
    // Being brought to the front is not being touched either, so the clock is
    // left where it was and it is the clock that decides: away two minutes and
    // nothing happens, away ten and the PIN is asked, exactly as it would be
    // for a phone left face up on the bar for ten.
    if (ownTrip(expectingUntil)) { expectingUntil = null; touched(); return; }
    decide();
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

  // Leaving is worth writing down on its own: a phone locked with the app on
  // screen fires this and nothing else, and without it the clock stops at
  // whatever the last tick happened to catch.
  for (const kind of ['pagehide', 'blur']) {
    window.addEventListener(kind, () => writeSeen(lastTouch));
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) writeSeen(lastTouch);
  });

  ticker = setInterval(decide, TICK_MS);

  // THE QUESTION ON THE WAY IN, before the clock is reset by starting up.
  // Somebody who closed the app an hour ago is somebody who has been away an
  // hour, whatever the session cookie still says.
  const seen = readSeen();
  if (lockOnOpening({ lastSeen: seen, remembers: remembers() })) {
    touched();
    showLock();
    return;
  }
  touched();
  writeSeen();
}

/** Stop, on the way out, so a signed-out page is not still counting. */
export function unguard() {
  watching = false;
  locked = false;
  forgetSeen();
  clearInterval(ticker);
  ticker = null;
  document.querySelector('.lock-screen')?.remove();
}

function decide() {
  if (!watching || locked) return;
  if (whatToDo({ idleMs: Date.now() - lastTouch }) === 'lock') { showLock(); return; }
  writeSeen(lastTouch);
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
      let out;
      if (byPassword) {
        const params = await api.passwordSalt(me.email);
        out = await api.unlock({
          passwordKey: await deriveLoginKey(typed, params.salt, params.iterations),
        });
      } else {
        out = await api.unlock({ pin: typed });
      }
      locked = false;
      touched();
      writeSeen();
      screen.remove();
      // A PIN from before the rule changed. Said here rather than saved for
      // their next sign-in, because a session lasts two months and the next
      // sign-in may never come.
      if (out?.mustChangePin) onShortPin?.();
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
