/**
 * Joining: the invitation, and the person choosing how they will sign in.
 *
 * A login used to be made with its way in already decided. Somebody typed a
 * PIN into the form and then had to get that PIN across a desk or into a
 * message, which is the same problem twice: the thing that opens the account
 * travels through a third party's hands, and it is a thing the person never
 * chose and will not remember.
 *
 * So the account is made empty and the person is invited into it, and WHICH
 * WAY THEY SIGN IN IS THEIRS TO PICK. A housekeeper working off a tablet in a
 * corridor wants six digits she can key with one hand while holding a pile of
 * towels. Whoever does the wages wants an address and a password their browser
 * already fills in. Neither is right for the other and the app is in no
 * position to know which of them somebody is.
 */

import { PIN_DIGITS, pinLooksRight } from './auth.js';

/** How somebody can sign in. */
export const WAYS = ['pin', 'password'];

/** How many characters a password has to be. The same rule everywhere. */
export const LEAST_PASSWORD = 10;

/** How long an invitation lasts if nobody says otherwise. */
export const DAYS_TO_JOIN = 3;

/** The longest it may be set to. */
export const MOST_DAYS = 30;

/**
 * Which ways this account may be opened.
 *
 * An administrator keeps a password whatever else they hold: it is the
 * credential that authorises changing a PIN, granting the payroll and
 * everything else an administrator does, so an administrator with only six
 * digits would be an administrator who cannot be asked to prove anything.
 * Everybody else picks.
 */
export function waysFor(role) {
  return role === 'admin' ? ['password'] : [...WAYS];
}

/** Whether this account may be opened that way. */
export function mayChoose(role, way) {
  return waysFor(role).includes(way);
}

/**
 * Why the link will not open, in words the person can act on.
 *
 * Four different problems with four different answers, and one "this link is
 * not valid" would send somebody to the wrong one. Spent is the common case
 * and the friendliest: they have already done this and are looking at an old
 * message.
 */
export function whyNotOpen(invite, { now = new Date().toISOString() } = {}) {
  if (!invite) {
    return 'This link does not work. Ask whoever set your account up for another one.';
  }
  if (invite.revoked_at) {
    return 'This invitation has been cancelled. Ask for a new one.';
  }
  if (invite.used_at) {
    return 'This invitation has already been used. If that was you, just sign in. '
      + 'If it was not, tell whoever looks after logins straight away.';
  }
  if (String(invite.expires_at) <= String(now).slice(0, 19).replace('T', ' ')) {
    return 'This invitation has expired. Ask for a new one — they take a moment to make.';
  }
  return null;
}

/**
 * What somebody sent back, checked.
 *
 * Refused rather than corrected. The one thing this must never do is quietly
 * set a way in that is not the way the person thought they were setting.
 */
export function readChoice(body = {}, role = 'staff') {
  const way = String(body.way ?? '').trim();
  if (!WAYS.includes(way)) return { error: 'Choose a PIN or a password.' };
  if (!mayChoose(role, way)) {
    return { error: 'This account signs in with an email address and a password.' };
  }

  if (way === 'pin') {
    const pin = String(body.pin ?? '').trim();
    if (!pinLooksRight(pin)) {
      return { error: `Your PIN has to be ${PIN_DIGITS} to 10 digits, and digits only.` };
    }
    if (/^(\d)\1+$/.test(pin)) {
      return { error: 'That is the same digit over and over. Pick something harder to watch.' };
    }
    if (isARun(pin)) {
      return { error: 'That is a straight run of digits. Pick something harder to guess.' };
    }
    return { way, pin };
  }

  const key = String(body.passwordKey ?? '');
  const salt = String(body.passwordSalt ?? '');
  if (!key || !salt) {
    return { error: 'Your password did not reach us properly. Try once more.' };
  }
  return {
    way,
    password: { passwordKey: key, salt, iterations: body.passwordIterations },
  };
}

/** 123456, or 987654. Both are the first thing anybody tries. */
export function isARun(pin) {
  const digits = String(pin);
  if (digits.length < 3) return false;
  let up = true;
  let down = true;
  for (let i = 1; i < digits.length; i += 1) {
    const step = Number(digits[i]) - Number(digits[i - 1]);
    if (step !== 1) up = false;
    if (step !== -1) down = false;
  }
  return up || down;
}

/**
 * What the account list says about somebody who has not signed in yet.
 *
 * The three states are different jobs for whoever is looking. Nothing sent is
 * something to do. Sent and not opened is a nudge, or an address to check.
 * Opened and not finished is somebody who got as far as the page and stopped,
 * which is usually a PIN that was already taken.
 */
export function howItStands(invite, { hasCredentials = false } = {}) {
  if (hasCredentials) return null;
  if (!invite || invite.revoked_at) return 'no way in yet';
  if (invite.used_at) return null;
  if (invite.opened_at) return 'opened the invitation, not finished';
  if (invite.sent_at) return 'invitation sent';
  return 'invitation made, not sent';
}
