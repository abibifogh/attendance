/**
 * Who may open the payroll, and for how long.
 *
 * THREE LOCKS, NOT ONE. Holding the pay permission says somebody is the kind
 * of person who might. A grant, made deliberately and with an end date on it,
 * says they may at the moment. A code they have to type says it is them and
 * not whoever picked the tablet up, and the unlock that code buys runs out on
 * its own.
 *
 * ADMINISTRATORS ARE NOT GRANTED ANYTHING. They are the ones who grant, and a
 * property with one administrator must never be able to lock itself out of its
 * own payroll. Everything below is about everybody else.
 *
 * The functions here are pure and take the clock as an argument, because every
 * bug in this kind of code is a clock bug and a clock you cannot hold still is
 * a clock you cannot test.
 */

/** How long typing the code keeps payroll open. */
export const UNLOCK_HOURS = 8;

/** Wrong codes before guessing stops being free, and for how long it stops. */
export const MAX_TRIES = 5;
export const LOCKOUT_MINUTES = 30;

/** The longest a grant may run before somebody has to decide again. */
export const MAX_GRANT_DAYS = 180;

export const isAdmin = (session) => session?.user?.role === 'admin';

const at = (value) => {
  if (!value) return null;
  const t = Date.parse(String(value).replace(' ', 'T').replace(/Z?$/, 'Z'));
  return Number.isFinite(t) ? t : null;
};

/**
 * What a grant row means right now.
 *
 * `state` is the one word the screen needs: what to show and what to ask for.
 */
export function readAccess(row, now = new Date()) {
  const stamp = now instanceof Date ? now.getTime() : Number(now);

  if (!row) {
    return {
      state: 'none', granted: false, unlocked: false,
      expiresAt: null, unlockedUntil: null, lockedUntil: null,
    };
  }

  const expires = at(row.expires_at);
  const until = at(row.unlocked_until);
  const locked = at(row.locked_until);

  const base = {
    granted: expires != null && expires > stamp,
    expiresAt: row.expires_at ?? null,
    unlockedUntil: row.unlocked_until ?? null,
    lockedUntil: row.locked_until ?? null,
    grantedBy: row.granted_by ?? null,
    grantedAt: row.granted_at ?? null,
    note: row.note ?? null,
  };

  // The grant running out beats everything else: a locked-out person whose
  // grant has expired is not locked out, they are simply not granted.
  if (!base.granted) return { ...base, state: 'expired', unlocked: false };
  if (locked != null && locked > stamp) return { ...base, state: 'locked', unlocked: false };

  const unlocked = until != null && until > stamp;
  return { ...base, state: unlocked ? 'open' : 'shut', unlocked };
}

/**
 * May this request see the payroll?
 *
 * Admin, or granted and unlocked. Nothing else, and no combination of ticks
 * on a login adds up to it.
 */
export function mayOpen(session, row, now = new Date()) {
  if (isAdmin(session)) return { ok: true, why: 'admin', access: readAccess(row, now) };
  const access = readAccess(row, now);
  if (access.state === 'open') return { ok: true, why: 'unlocked', access };
  return { ok: false, why: access.state, access };
}

/** What to say to somebody the lock has just turned away. */
export function refusalFor(state) {
  switch (state) {
    case 'expired':
      return 'Your payroll access has run out. An administrator can grant it again.';
    case 'locked':
      return 'Too many wrong codes. Payroll is shut for a while; try again later or ask an '
        + 'administrator for a new code.';
    case 'shut':
      return 'Payroll is locked. Enter your payroll code to open it.';
    default:
      return 'You have not been granted payroll access. An administrator has to grant it, and '
        + 'they will give you a code.';
  }
}

/**
 * A wrong code, and what it costs.
 *
 * Counted rather than timed out on the first miss, because somebody typing a
 * six-figure code on a phone gets it wrong now and then and should not be shut
 * out for an afternoon over a fat thumb.
 */
export function afterWrongCode(row, now = new Date()) {
  const stamp = now instanceof Date ? now.getTime() : Number(now);
  const tries = Number(row?.tries ?? 0) + 1;
  if (tries < MAX_TRIES) return { tries, lockedUntil: null };
  return { tries: 0, lockedUntil: iso(stamp + LOCKOUT_MINUTES * 60_000) };
}

/** When an unlock granted now would run out. */
export const unlockUntil = (now = new Date()) => iso(
  (now instanceof Date ? now.getTime() : Number(now)) + UNLOCK_HOURS * 3_600_000,
);

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
