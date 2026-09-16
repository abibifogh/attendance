/**
 * When to ask for the PIN again.
 *
 * A phone put down on a bar with the rota open is a screen anybody walking
 * past can read, and half of what this app holds is nobody else's business:
 * somebody's pay, somebody's leave, who is off sick on Thursday. So the screen
 * does not stay open indefinitely for a room to read.
 *
 * ONE TRIGGER, AND IT IS TIME. Five minutes with nobody touching the screen
 * and the PIN is asked, over the top of whatever was on it.
 *
 * IT USED TO ASK ON THE WAY BACK from another app as well. That was wrong.
 * Looking something up in WhatsApp and coming back is how people work, and an
 * app that demands six digits every time somebody answers a message is an app
 * they stop opening. Somebody who has really been away long enough for it to
 * matter has also been away long enough for the clock below to say so, which
 * reaches the same answer without charging everybody else for it.
 *
 * Pure, and given the clock as numbers, because every bug in this kind of code
 * is a clock bug and a clock you cannot hold still is a clock you cannot test.
 */

/** Untouched for this long and the PIN is asked. */
export const IDLE_MINUTES = 5;
export const IDLE_MS = IDLE_MINUTES * 60 * 1000;

/**
 * What should happen, given how long since somebody touched the screen.
 *
 *   'lock'    Ask for the PIN. Nothing is lost: it goes over the top of what
 *             was there, so a half-written leave request is still underneath
 *             and still there afterwards.
 *   'nothing' Carry on.
 */
export function whatToDo({ idleMs = 0, limitMs = IDLE_MS } = {}) {
  return idleMs >= limitMs ? 'lock' : 'nothing';
}

/**
 * And the same question on the way in.
 *
 * Closing the app and opening it again is not a reload: on a phone it comes
 * back out of memory with the session cookie still good for weeks, so the app
 * used to open straight on somebody's pay with nobody having proved they were
 * the person who put the phone down. The clock has to survive the app being
 * shut, which means it has to be written down.
 *
 * NO STAMP MEANS LOCK. A session that is still good with nothing on record of
 * anybody having opened it is the case this is for: the app was closed weeks
 * ago, or the cookie has been carried to a browser that was never signed in on
 * it. Signing in writes the stamp itself, so a sign-in is never followed by
 * being asked for the same PIN again.
 *
 * Unless the phone cannot remember anything at all, which is what `remembers`
 * says. A browser with storage refused would otherwise look exactly like a
 * session nobody has opened, every single time, and lock somebody out of an
 * app they have just signed into. Nothing was written down, so nothing can be
 * concluded, and the five-minute clock in memory is left to do the work.
 *
 * A stamp from the future locks. A clock that has been put back is how
 * somebody would try it, and there is no honest reading of it anyway.
 */
export function lockOnOpening({
  lastSeen = null, now = Date.now(), limitMs = IDLE_MS, remembers = true,
} = {}) {
  if (!remembers) return false;
  if (lastSeen == null || lastSeen === '') return true;
  const seen = Number(lastSeen);
  if (!Number.isFinite(seen) || seen <= 0) return true;
  if (seen > now) return true;
  return whatToDo({ idleMs: now - seen, limitMs }) === 'lock';
}

/**
 * A trip the app sent them on itself, and the clock forgiven for it.
 *
 * A file picker for their photograph, a print dialog for a payslip, a share
 * sheet. Android backgrounds the app for all three, and somebody choosing a
 * photograph has not walked away from the phone: the picker is them using it.
 * So those places say so first, and coming back resets the clock rather than
 * being counted as five minutes of nobody there.
 */
export function ownTrip(pendingUntil, now = Date.now()) {
  return pendingUntil != null && now <= pendingUntil;
}

/**
 * What the lock asks for, and what it can offer instead.
 *
 * WHY THIS IS A DECISION AND NOT A LOOKUP. The lock used to ask for whatever
 * the session said somebody last signed in with, and that is a guess. An old
 * session predating the field reads as a PIN whoever it belongs to; a session
 * says nothing about an administrator who signed in by password on Monday and
 * has held a PIN since Tuesday. Guessing is fine. Guessing with no way to
 * correct it is not, and the only way past a lock asking for the wrong thing
 * was Sign out instead, which on a phone means signing in again from scratch.
 *
 * So: ask for what they hold. Where they hold both, prefer what they last used
 * and let them say otherwise.
 *
 * The break-glass sign-in has no account behind it. What opens it is the
 * secret it came in on, which is not promised to be digits, so it is its own
 * answer and it is never swappable.
 */
export function asksFor({
  signsInWith = 'pin', hasPin = true, hasPassword = false, email = null, isRecovery = false,
} = {}) {
  if (isRecovery) return { ask: 'secret', canSwap: false };

  // A password is only usable where there is an address to salt it against.
  const password = Boolean(hasPassword && email);
  if (!password) return { ask: 'pin', canSwap: false };
  if (!hasPin) return { ask: 'password', canSwap: false };

  return { ask: signsInWith === 'password' ? 'password' : 'pin', canSwap: true };
}
