/**
 * Who may open the payroll, and what they have to type to do it.
 *
 * FOUR LOCKS, NOT ONE. Holding the pay permission says somebody is the kind of
 * person who might. A grant, made deliberately and with an end date on it,
 * says they may at the moment. A code an administrator hands over says the
 * grant is real and reached the right person. And a PIN of their own, asked
 * every single time the tab is opened, says the person in front of the screen
 * right now is still them.
 *
 * THE PIN IS THE ONE THAT MATTERS DAY TO DAY. The other three are set once and
 * then sit there. An unlock that lasted a working day meant the payroll was
 * typed open at nine and stayed open to anybody who walked past the desk until
 * five. So the window is short, it slides only while somebody is working, and
 * the screen drops it the moment they leave.
 *
 * ADMINISTRATORS ARE NOT GRANTED ANYTHING, but they do have a PIN. They are
 * the ones who grant, and a property with one administrator must never be able
 * to lock itself out of its own payroll — so an administrator needs no code
 * and no end date, chooses their PIN the first time they open the tab, and the
 * recovery login in the worker's secrets is the way back if they forget it.
 *
 * The functions here are pure and take the clock as an argument, because every
 * bug in this kind of code is a clock bug and a clock you cannot hold still is
 * a clock you cannot test.
 */

/** How long typing the PIN keeps payroll open, if nobody touches it. */
export const UNLOCK_MINUTES = 30;

/** Wrong tries before guessing stops being free, and for how long it stops. */
export const MAX_TRIES = 5;
export const LOCKOUT_MINUTES = 30;

/** The longest a grant may run before somebody has to decide again. */
export const MAX_GRANT_DAYS = 180;

/** Same shape as a login PIN, so nobody has to learn a second rule. */
export const PIN_RE = /^\d{4,10}$/;

export const isAdmin = (session) => session?.user?.role === 'admin';

/** The break-glass login backed by a worker secret, not a row in this table. */
export const isRecovery = (session) => Boolean(session?.user?.isRecovery);

const at = (value) => {
  if (!value) return null;
  const t = Date.parse(String(value).replace(' ', 'T').replace(/Z?$/, 'Z'));
  return Number.isFinite(t) ? t : null;
};

/**
 * What a row means right now.
 *
 * `state` is the one word the screen needs: what to show and what to ask for.
 * A null `expires_at` never runs out, which is only ever an administrator's
 * own row.
 */
export function readAccess(row, now = new Date()) {
  const stamp = now instanceof Date ? now.getTime() : Number(now);

  if (!row) {
    return {
      state: 'none', granted: false, hasPin: false, hasCode: false, unlocked: false,
      expiresAt: null, unlockedUntil: null, lockedUntil: null,
    };
  }

  const expires = at(row.expires_at);
  const until = at(row.unlocked_until);
  const locked = at(row.locked_until);

  const base = {
    granted: expires == null || expires > stamp,
    hasPin: Boolean(row.pin_hash),
    hasCode: Boolean(row.code_hash),
    expiresAt: row.expires_at ?? null,
    unlockedUntil: row.unlocked_until ?? null,
    lockedUntil: row.locked_until ?? null,
    grantedBy: row.granted_by ?? null,
    grantedAt: row.granted_at ?? null,
    pinSetAt: row.pin_set_at ?? null,
    note: row.note ?? null,
  };

  // The grant running out beats everything else: a locked-out person whose
  // grant has expired is not locked out, they are simply not granted.
  if (!base.granted) return { ...base, state: 'expired', unlocked: false };
  if (locked != null && locked > stamp) return { ...base, state: 'locked', unlocked: false };

  // Allowed in, but with nothing to prove it with yet.
  if (!base.hasPin) return { ...base, state: 'setup', unlocked: false };

  const unlocked = until != null && until > stamp;
  return { ...base, state: unlocked ? 'open' : 'shut', unlocked };
}

/**
 * May this request see the payroll?
 *
 * Unlocked within the last few minutes by somebody who typed their own PIN.
 * Nothing else, for anybody, and no combination of ticks on a login adds up
 * to it. The recovery login is the single exception, because whoever holds
 * the worker's secrets already holds everything a PIN protects.
 */
export function mayOpen(session, row, now = new Date()) {
  const access = readAccess(row, now);
  if (isRecovery(session)) return { ok: true, why: 'recovery', access };
  if (access.state === 'open') return { ok: true, why: 'unlocked', access };

  // An administrator has no grant to be missing; an empty row means they have
  // simply never chosen a PIN.
  const why = isAdmin(session) && access.state === 'none' ? 'setup' : access.state;
  return { ok: false, why, access };
}

/** What to say to somebody the lock has just turned away. */
export function refusalFor(state) {
  switch (state) {
    case 'expired':
      return 'Your payroll access has run out. An administrator can grant it again.';
    case 'locked':
      return 'Too many wrong tries. Payroll is shut for a while; wait, or ask an administrator '
        + 'to reset your payroll PIN.';
    case 'setup':
      return 'Choose a payroll PIN before you open this. It has to be different from the PIN '
        + 'you sign in with.';
    case 'shut':
      return 'Payroll is locked. Enter your payroll PIN to open it.';
    default:
      return 'You have not been granted payroll access. An administrator has to grant it, and '
        + 'they will give you a code.';
  }
}

/**
 * A wrong PIN or a wrong code, and what it costs.
 *
 * Counted rather than timed out on the first miss, because somebody typing on
 * a phone gets it wrong now and then and should not be shut out for an
 * afternoon over a fat thumb.
 */
export function afterWrongTry(row, now = new Date()) {
  const stamp = now instanceof Date ? now.getTime() : Number(now);
  const tries = Number(row?.tries ?? 0) + 1;
  if (tries < MAX_TRIES) return { tries, lockedUntil: null };
  return { tries: 0, lockedUntil: iso(stamp + LOCKOUT_MINUTES * 60_000) };
}

/** When an unlock granted now would run out. */
export const unlockUntil = (now = new Date()) => iso(
  (now instanceof Date ? now.getTime() : Number(now)) + UNLOCK_MINUTES * 60_000,
);

/**
 * Is the window worth pushing out again?
 *
 * The unlock slides while somebody is working, or a payroll that takes an hour
 * would shut in the middle of it. Renewing on every request would mean a write
 * behind every read, so it waits until half the window has gone.
 */
export function needsRenewal(row, now = new Date()) {
  const stamp = now instanceof Date ? now.getTime() : Number(now);
  const until = at(row?.unlocked_until);
  if (until == null) return false;
  return until - stamp < (UNLOCK_MINUTES * 60_000) / 2;
}

/** SQLite writes 'YYYY-MM-DD HH:MM:SS', so everything here does too. */
export function iso(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The code somebody is given.
 *
 * Nine digits in threes. Long enough that guessing it is not worth the five
 * tries, short enough to read down a phone line, and digits alone because it
 * gets read out loud and O and 0 are the same sound.
 */
export function newCode() {
  const digits = crypto.getRandomValues(new Uint32Array(3));
  return [...digits].map((n) => String(n % 1000).padStart(3, '0')).join(' ');
}

/** Codes are compared with the spaces taken out, because people type them in. */
export const tidyCode = (value) => String(value ?? '').replace(/\D/g, '');

/** A PIN is compared exactly, so all this does is drop what a keyboard added. */
export const tidyPin = (value) => String(value ?? '').trim();
