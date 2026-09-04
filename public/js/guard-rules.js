/**
 * When to lock the screen, and when to end the session altogether.
 *
 * Two different worries wearing one word. A phone put down on a bar with the
 * rota open is a screen anybody walking past can read; a phone handed to
 * somebody for a moment is a screen they can be trusted with for a moment but
 * not left alone with. The first wants the session gone. The second wants the
 * PIN asked and the session kept, because the person is still standing there
 * and signing them out entirely would be answering a small problem with a
 * large annoyance.
 *
 * Pure, and given the clock as numbers, because every bug in this kind of code
 * is a clock bug and a clock you cannot hold still is a clock you cannot test.
 */

/** Untouched for this long and the session ends. */
export const IDLE_MINUTES = 5;
export const IDLE_MS = IDLE_MINUTES * 60 * 1000;

/**
 * What should happen, given how long since somebody touched the screen and how
 * long the app spent behind another one.
 *
 *   'out'     Sign them out. Nobody has touched this for long enough that the
 *             person who was here has gone.
 *   'lock'    Ask for the PIN. They are back, and the app cannot tell whether
 *             the hand holding the phone is the same one.
 *   'nothing' Carry on.
 *
 * Signing out wins over locking. Somebody who has been away longer than the
 * limit is gone whether or not they came back to the app themselves, and a
 * lock screen on a session that should have ended is a session that has not
 * ended.
 */
export function whatToDo({
  idleMs = 0, awayMs = null, installed = false, limitMs = IDLE_MS,
} = {}) {
  if (idleMs >= limitMs) return 'out';

  // Only the installed app. In a browser tab, switching to another tab is how
  // people work: looking something up and coming back is not a reason to ask
  // anybody for anything, and an app that did it would be turned off by
  // lunchtime.
  if (installed && awayMs != null) return 'lock';

  return 'nothing';
}

/**
 * How long the app may be away without it counting.
 *
 * Nothing, ordinarily. The exception is a trip the app sent them on itself: a
 * file picker for their photograph, a print dialog for a payslip, a share
 * sheet. Android backgrounds the app for all three, and demanding a PIN on the
 * way back would interrupt the very thing it was asked to do, losing the
 * upload. So those places say so first, and the return is expected.
 */
export function ownTrip(pendingUntil, now = Date.now()) {
  return pendingUntil != null && now <= pendingUntil;
}
