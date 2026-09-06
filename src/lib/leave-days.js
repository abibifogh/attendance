import { allows } from './permissions.js';
import { createNotice } from './notices.js';

/**
 * Who may actually move somebody's leave days.
 *
 * Signing a month off records one figure that is not a fact about the month:
 * how many days it takes off, or gives back to, that person's entitlement. At
 * this property the person who signs periods is usually the person who built
 * the rota, and the shortfall being charged is usually about the rota. That is
 * the wrong number of hands on something that ends up in somebody's pay.
 *
 * So the figure is an administrator's to set. Anybody else's becomes a request:
 * the days are still signed, the balance stays exactly where it was, and what
 * they asked for waits.
 *
 * The rule is here, with no database and no request in sight, because it is
 * applied in three places — signing a set of days, signing a whole month, and
 * correcting a figure afterwards — and three copies of a rule about somebody's
 * leave is two copies too many.
 */

/** Past this and it is a typing mistake rather than a decision. */
export const MOST_DAYS = 60;

/** The permission that says administrator, the same one clock changes use. */
export const DECIDES = 'att_setup';

export function maySetLeaveDays(permissions) {
  return allows(DECIDES, permissions);
}

/** A whole number of days, or null if it is not one. */
export function readLeaveDays(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const days = Number(value);
  if (!Number.isFinite(days)) return null;
  const whole = Math.round(days);
  return Math.abs(whole) > MOST_DAYS ? null : whole;
}

/**
 * What to write, and what to ask for.
 *
 * `apply` is the figure that goes on the sign-off — the one that moves the
 * balance. `propose` is what somebody wanted instead, where they may not have
 * it. Asking for the figure that already stands is not a request; it is
 * agreement, and a queue full of those is a queue nobody reads.
 */
export function leaveDaysDecision({ was = 0, days, permissions }) {
  const before = Math.round(Number(was) || 0);
  const wanted = Math.round(Number(days) || 0);

  if (wanted === before) return { apply: before, propose: null };
  if (maySetLeaveDays(permissions)) return { apply: wanted, propose: null };
  return { apply: before, propose: { was: before, days: wanted } };
}

/** A figure as somebody would say it out loud. */
export function sayDays(days) {
  const n = Math.round(Number(days) || 0);
  if (!n) return 'no change';
  const word = Math.abs(n) === 1 ? 'day' : 'days';
  return n > 0 ? `${n} ${word} back` : `${Math.abs(n)} ${word} off`;
}

/**
 * Somebody wants a leave balance moved and may not move it themselves.
 *
 * Written down as a request and left there. Nothing about the balance changes
 * until an administrator says so, which is the whole point: the days are signed
 * either way, and the one figure that comes out of somebody's entitlement is
 * the one that waits.
 *
 * Here rather than in a route because two routes raise one, and a request
 * recorded two slightly different ways is a queue that reads as two queues.
 */
export async function askToMoveLeave(ctx, { staff, from, to, reviewId = null, propose, reason }) {
  const actor = `${ctx.session.user.name} (${ctx.session.user.role})`;

  const asked = await ctx.db.prepare(
    `INSERT INTO att_leave_change
       (staff_id, review_id, from_day, to_day, was, days, reason, status, actor, actor_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9) RETURNING id`,
  ).bind(
    staff.id, reviewId, from, to, propose.was, propose.days,
    reason || null, actor, ctx.session.user.id ?? null,
  ).first().catch(() => null);

  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(actor, 'attendance.leave_days_asked', String(staff.id), JSON.stringify({
    from, to, was: propose.was, days: propose.days,
  })).run().catch(() => {});

  await createNotice(ctx.db, {
    kind: 'attendance.leave_days_asked',
    level: 'warn',
    title: `${staff.name}: ${sayDays(propose.days)} waiting on you`,
    body: `${actor} signed ${from} to ${to} and asks for ${sayDays(propose.days)} against `
      + `${staff.name}\u2019s leave. It stands at ${sayDays(propose.was)} until you decide.`
      + `${reason ? ` ${reason}` : ''}`,
    link: '#/signoff?tab=leave',
    actor,
    audience: DECIDES,
  }, ctx);

  return asked?.id ?? null;
}
