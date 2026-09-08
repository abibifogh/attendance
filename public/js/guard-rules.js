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
