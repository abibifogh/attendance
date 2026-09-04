/**
 * The short code somebody can put on their own payslips.
 *
 * Signing in answers "is this their phone", once, in the morning. Opening a
 * payslip asks something else at a different moment: somebody is standing next
 * to them in a corridor, the phone is already unlocked, and the six digits
 * they typed at seven o'clock are no help at all.
 *
 * So this is four digits, chosen by the person whose pay it is, and it guards
 * one screen. Nobody has to have one, which is why the ordinary state is off:
 * a lock the property switches on for everybody is a lock everybody writes on
 * the back of their hand.
 *
 * IT DOES NOT LOCK THE PROPERTY OUT. Payroll and an administrator read what
 * they always read. A hotel that cannot open a payslip cannot answer a query
 * about the tax on it, and a code that could do that would be handing one
 * person the power to make their own pay unauditable.
 *
 * Pure and given the clock, because every bug in this kind of code is a clock
 * bug, and a clock you cannot hold still is a clock you cannot test.
 */

/** Four, because the user asked for four and the lockout does the rest. */
export const CODE_DIGITS = 4;
export const CODE_RE = /^\d{4}$/;
export const CODE_RULE = 'The code is four digits';

/** How long typing it keeps the tab open, while they are still reading. */
export const OPEN_MINUTES = 10;

/** Wrong tries before guessing stops being free, and for how long. */
export const MAX_TRIES = 5;
export const LOCKOUT_MINUTES = 15;

/**
 * Codes nobody should be allowed to pick.
 *
 * Ten thousand codes and five tries is already a poor bet for a guesser, so
 * this is not the wall. It is the handful anybody would try first while
 * holding the phone, which is the only attack this thing is really for.
 */
const OBVIOUS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '0123', '3210', '1212', '2580', '0852',
]);

export function codeLooksRight(code) {
  return CODE_RE.test(String(code ?? ''));
}

export function codeIsObvious(code) {
  return OBVIOUS.has(String(code ?? ''));
}

const at = (value) => {
  if (!value) return null;
  const t = Date.parse(String(value).replace(' ', 'T').replace(/Z?$/, 'Z'));
  return Number.isFinite(t) ? t : null;
};

const stampOf = (now) => (now instanceof Date ? now.getTime() : Number(now));

/** An SQLite-shaped timestamp so these columns read like every other one. */
export const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/**
 * What a user row means for this screen right now.
 *
 * `state` is the one word the screen needs:
 *
 *   off     No code set. The payslips open, as they always have.
 *   open    A code is set and was typed recently enough.
 *   shut    A code is set and they have to type it.
 *   locked  Too many wrong tries. Nothing opens until it passes.
 */
export function readLock(row, now = new Date()) {
  const stamp = stampOf(now);
  const has = Boolean(row?.payslip_pin_hash);

  if (!has) {
    return {
      state: 'off', on: false, open: true, setAt: null,
      lockedUntil: null, openUntil: null, triesLeft: MAX_TRIES,
    };
  }

  const locked = at(row.payslip_locked_until);
  const until = at(row.payslip_open_until);
  const tries = Number(row.payslip_tries ?? 0);

  const base = {
    on: true,
    setAt: row.payslip_pin_set_at ?? null,
    lockedUntil: row.payslip_locked_until ?? null,
    openUntil: row.payslip_open_until ?? null,
    triesLeft: Math.max(0, MAX_TRIES - tries),
  };

  if (locked != null && locked > stamp) return { ...base, state: 'locked', open: false };
  if (until != null && until > stamp) return { ...base, state: 'open', open: true };
  return { ...base, state: 'shut', open: false };
}

/** How far ahead a fresh unlock reaches. */
export function openUntil(now = new Date()) {
  return sqlTime(stampOf(now) + OPEN_MINUTES * 60_000);
}

/**
 * What a wrong try costs.
 *
 * The count carries across sessions, because a guesser who reloads the page is
 * the guesser this is for. It resets on the next right one.
 */
export function afterAWrongTry(row, now = new Date()) {
  const tries = Number(row?.payslip_tries ?? 0) + 1;
  if (tries < MAX_TRIES) {
    return { tries, lockedUntil: null, triesLeft: MAX_TRIES - tries };
  }
  return {
    tries: 0,
    lockedUntil: sqlTime(stampOf(now) + LOCKOUT_MINUTES * 60_000),
    triesLeft: MAX_TRIES,
  };
}

/** How long is left on a lockout, in whole minutes, for saying out loud. */
export function minutesLeft(lockedUntil, now = new Date()) {
  const end = at(lockedUntil);
  if (end == null) return 0;
  return Math.max(0, Math.ceil((end - stampOf(now)) / 60_000));
}
