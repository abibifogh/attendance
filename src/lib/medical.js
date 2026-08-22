/**
 * The medical allowance.
 *
 * A property gives each qualifying person so much a year towards medical
 * bills. Without an app that is a drawer of receipts, a figure somebody keeps
 * in their head, and an argument in November about whether March's pharmacy
 * bill was counted.
 *
 * WHAT IS LEFT IS NEVER STORED. It is the opening balance less what has
 * actually been approved. The same reasoning as the advances ledger: a stored
 * balance is a figure with nothing behind it, and this is precisely the kind
 * of figure somebody needs to be able to disagree with — item by item, against
 * the bills they handed in.
 *
 * A CLAIM IS ITS RECEIPTS. The total is the sum of the bills rather than a
 * number somebody typed in a box, so a claim and its evidence cannot drift
 * apart. Ten bills is the ceiling, which is a judgement about what a person
 * will sit and photograph on a phone rather than a rule about what is true.
 *
 * WHAT WAS ASKED AND WHAT WAS ALLOWED ARE TWO FIGURES. A claim cut down on
 * approval — one bill was for something the property does not cover, or there
 * was not enough left in the year — keeps both, because that is the part
 * somebody will ask about afterwards.
 */

/** Money, to the nearest pesewa. */
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** As many bills as somebody will photograph in one sitting. */
export const MAX_RECEIPTS = 10;

export const STATUSES = ['requested', 'approved', 'rejected', 'withdrawn'];

/** The year a claim belongs to, from the day it was spent or asked. */
export const yearOf = (day) => Number(String(day ?? '').slice(0, 4)) || null;

/** A claim's total: the bills behind it, added up. */
export function claimTotal(receipts = []) {
  return round2(receipts.reduce((n, r) => n + (Number(r.amount) || 0), 0));
}

/** What has actually been allowed out of a year's claims. */
export function spentOf(claims = []) {
  return round2(claims
    .filter((c) => c.status === 'approved')
    .reduce((n, c) => n + (Number(c.approved ?? c.amount) || 0), 0));
}

/** What is waiting on somebody's decision, which is not spent but is not free either. */
export function pendingOf(claims = []) {
  return round2(claims
    .filter((c) => c.status === 'requested')
    .reduce((n, c) => n + (Number(c.amount) || 0), 0));
}

/**
 * One person's year.
 *
 * `left` is what can still be approved. `ifAllApproved` is what would be left
 * if everything waiting went through, which is the figure whoever decides
 * actually needs: approving four claims that each fit inside the balance can
 * still take somebody past it.
 */
export function standingOf(allowance, claims = []) {
  if (!allowance) return null;
  const opening = round2(allowance.opening ?? allowance.allowance);
  const spent = spentOf(claims);
  const waiting = pendingOf(claims);

  return {
    year: allowance.year,
    allowance: round2(allowance.allowance),
    opening,
    spent,
    waiting,
    left: round2(opening - spent),
    ifAllApproved: round2(opening - spent - waiting),
    // Where the opening balance is not the whole allowance, something had
    // already been claimed before the app was keeping the record. Worth saying
    // out loud on the screen rather than leaving two figures to disagree.
    carriedIn: round2(round2(allowance.allowance) - opening),
  };
}

/**
 * Whether a claim can be approved for an amount, and what to say if not.
 *
 * Nothing here refuses on its own. It reports; the route decides, and a person
 * can still allow more than the balance where the property has agreed to —
 * which happens, and an app that made it impossible would just be worked
 * around on paper.
 */
export function checkAgainst(standing, amount) {
  const asked = round2(amount);
  if (!standing) {
    return { ok: false, over: 0, reason: 'They have no medical allowance set for that year.' };
  }
  if (asked <= 0) return { ok: false, over: 0, reason: 'A claim has to be for something.' };
  if (asked <= standing.left) return { ok: true, over: 0, reason: null };
  return {
    ok: false,
    over: round2(asked - standing.left),
    reason: `That is ${round2(asked - standing.left)} more than the ${standing.left} left `
      + 'in their allowance this year.',
  };
}
