import { badRequest, forbidden, int, json, notFound, readJson, str } from '../lib/http.js';
import { getPepper, hashPin } from '../lib/auth.js';
import { allows, effectivePermissions } from '../lib/permissions.js';
import {
  MAX_GRANT_DAYS, PIN_RE, UNLOCK_MINUTES, afterWrongTry, isAdmin, isRecovery, iso, mayOpen,
  needsRenewal, newCode, readAccess, refusalFor, tidyCode, tidyPin, unlockUntil,
} from '../lib/payroll-access.js';

/**
 * Granting payroll access, and the PIN that opens it.
 *
 * The grant is a deliberate act by an administrator, recorded with their name
 * against it and an end date. The code that comes with it is shown once and
 * handed over however they choose; only its fingerprint is kept, so a lost one
 * is replaced rather than recovered, which is how every other code in this app
 * works.
 *
 * The PIN is the person's own. They choose it, it is not the one they sign in
 * with, and they type it every time they open the payroll.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(actorOf(ctx), action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

const hashCode = (code, pepper) => hashPin(`payroll:${tidyCode(code)}`, pepper);

/**
 * The PIN is hashed under its own label.
 *
 * Not for secrecy — the pepper does that — but so that a payroll PIN and a
 * login PIN can never be compared with each other, in this database or in a
 * copy of it. Somebody who did use the same digits for both should not have
 * that fact readable off two matching rows.
 */
const hashPayPin = (pin, pepper) => hashPin(`payroll-pin:${tidyPin(pin)}`, pepper);

export const rowFor = (db, userId) => db.prepare(
  'SELECT * FROM pay_access WHERE user_id = ?',
).bind(userId).first().catch(() => null);

/** Count a wrong try against somebody, and say whether that was the last one. */
async function countWrongTry(ctx, row) {
  const after = afterWrongTry(row);
  await ctx.db.prepare(
    'UPDATE pay_access SET tries = ?2, locked_until = ?3 WHERE user_id = ?1',
  ).bind(ctx.session.user.id, after.tries, after.lockedUntil).run().catch(() => {});
  return after;
}

/**
 * The gate every payroll request goes through.
 *
 * Called from the router rather than from each handler, because a route added
 * later and wired to the wrong permission is exactly the accident this exists
 * to stop.
 */
export async function guardPayroll(ctx) {
  const row = await rowFor(ctx.db, ctx.session.user.id);
  const verdict = mayOpen(ctx.session, row);
  if (!verdict.ok) throw forbidden(refusalFor(verdict.why), { payrollLocked: true, state: verdict.why });

  // The window slides while somebody is actually working, or a payroll that
  // takes an hour would shut halfway through it.
  if (verdict.why === 'unlocked' && needsRenewal(row)) {
    await ctx.db.prepare('UPDATE pay_access SET unlocked_until = ?2 WHERE user_id = ?1')
      .bind(ctx.session.user.id, unlockUntil()).run().catch(() => {});
  }
}

/** Where the person stands, for the screen that has to ask them for a PIN. */
export async function myAccess(ctx) {
  const admin = isAdmin(ctx.session);
  const recovery = isRecovery(ctx.session);
  const row = recovery ? null : await rowFor(ctx.db, ctx.session.user.id);
  const access = readAccess(row);
  const verdict = mayOpen(ctx.session, row);

  return json({
    ...access,
    admin,
    recovery,
    open: verdict.ok,
    // `mayOpen` has the last word on the state, because it is the only thing
    // that knows an administrator with no row has a PIN to choose rather than
    // a grant to wait for.
    state: verdict.ok ? 'open' : verdict.why,
    // A code is only ever asked for from somebody who was granted one.
    needsCode: !admin && !recovery && !access.hasPin,
    unlockMinutes: UNLOCK_MINUTES,
  });
}

/**
 * Choose a payroll PIN, or change the one you have.
 *
 * WHAT PROVES IT IS YOU depends on who you are. An administrator setting their
 * first one has already signed in with an email address and a password, which
 * is the strongest thing this app asks anybody for; after that, their current
 * PIN. Everybody else proves it with the code an administrator handed them, or
 * with the PIN they already have.
 */
export async function setPin(ctx) {
  if (isRecovery(ctx.session)) {
    throw badRequest('Recovery access has no payroll PIN of its own. Sign in as yourself to '
      + 'choose one, or reset somebody else’s from Users & data.');
  }

  const body = await readJson(ctx.request);
  const pin = tidyPin(body.pin);
  if (!PIN_RE.test(pin)) throw badRequest('The payroll PIN must be 4 to 10 digits.');

  const me = ctx.session.user;
  const admin = isAdmin(ctx.session);
  const row = await rowFor(ctx.db, me.id);
  const access = readAccess(row);

  if (!admin && (access.state === 'none' || access.state === 'expired')) {
    throw forbidden(refusalFor(access.state), { payrollLocked: true, state: access.state });
  }
  if (access.state === 'locked') {
    throw forbidden(refusalFor('locked'), { payrollLocked: true, state: 'locked' });
  }

  const pepper = await getPepper(ctx.db);
  const current = tidyPin(body.current);
  const code = tidyCode(body.code);

  // An administrator with no PIN yet has nothing to prove: the password they
  // signed in with is already the strongest credential here.
  let proved = admin && !access.hasPin;
  let wanted = null;

  if (!proved && current) {
    proved = await hashPayPin(current, pepper) === row.pin_hash;
    wanted = 'Your current payroll PIN is not right.';
  }
  if (!proved && !admin && code && row?.code_hash) {
    proved = await hashCode(code, pepper) === row.code_hash;
    wanted = 'That code is not right.';
  }

  if (!proved) {
    if (!current && !code) {
      throw badRequest(access.hasPin
        ? 'Type your current payroll PIN as well, so we know it is you.'
        : 'Type the code an administrator gave you, so we know it is you.');
    }
    const after = await countWrongTry(ctx, row);
    await audit(ctx, 'payroll.pin_failed', me.id, { lockedOut: !!after.lockedUntil });
    throw forbidden(after.lockedUntil ? refusalFor('locked') : wanted, { payrollLocked: true });
  }

  // The whole point is that it is not the PIN they sign in with. Somebody who
  // shoulder-surfs the tablet at the door should not be one tap from payroll.
  const user = await ctx.db.prepare('SELECT pin_hash FROM users WHERE id = ?').bind(me.id).first();
  if (user?.pin_hash && await hashPin(pin, pepper) === user.pin_hash) {
    throw badRequest('Your payroll PIN has to be different from the PIN you sign in with.');
  }

  const until = unlockUntil();
  await ctx.db.prepare(
    `INSERT INTO pay_access (user_id, pin_hash, pin_set_at, unlocked_at, unlocked_until,
                             tries, locked_until)
     VALUES (?1, ?2, datetime('now'), datetime('now'), ?3, 0, NULL)
     ON CONFLICT (user_id) DO UPDATE
       SET pin_hash = ?2, pin_set_at = datetime('now'), unlocked_at = datetime('now'),
           unlocked_until = ?3, tries = 0, locked_until = NULL`,
  ).bind(me.id, await hashPayPin(pin, pepper), until).run();

  await audit(ctx, access.hasPin ? 'payroll.pin_changed' : 'payroll.pin_set', me.id, {});

  return json({ ok: true, open: true, unlockedUntil: until, unlockMinutes: UNLOCK_MINUTES });
}

/** Type the PIN, open the payroll for a little while. */
export async function unlock(ctx) {
  if (isRecovery(ctx.session)) return json({ ok: true, open: true, recovery: true });

  const body = await readJson(ctx.request);
  const typed = tidyPin(body.pin);
  if (!typed) throw badRequest('Type your payroll PIN.');

  const row = await rowFor(ctx.db, ctx.session.user.id);
  const access = readAccess(row);
  const admin = isAdmin(ctx.session);

  if (!admin && (access.state === 'none' || access.state === 'expired')) {
    throw forbidden(refusalFor(access.state), { payrollLocked: true, state: access.state });
  }
  if (access.state === 'locked') {
    throw forbidden(refusalFor('locked'), { payrollLocked: true, state: 'locked' });
  }
  if (!access.hasPin) {
    throw forbidden(refusalFor('setup'), { payrollLocked: true, state: 'setup' });
  }

  const pepper = await getPepper(ctx.db);
  if (await hashPayPin(typed, pepper) !== row.pin_hash) {
    const after = await countWrongTry(ctx, row);
    await audit(ctx, 'payroll.unlock_failed', ctx.session.user.id, { lockedOut: !!after.lockedUntil });
    throw forbidden(after.lockedUntil ? refusalFor('locked') : 'That PIN is not right.',
      { payrollLocked: true });
  }

  const until = unlockUntil();
  await ctx.db.prepare(
    `UPDATE pay_access
        SET unlocked_at = datetime('now'), unlocked_until = ?2, tries = 0, locked_until = NULL
      WHERE user_id = ?1`,
  ).bind(ctx.session.user.id, until).run();
  await audit(ctx, 'payroll.unlock', ctx.session.user.id, { until });

  return json({ ok: true, open: true, unlockedUntil: until, unlockMinutes: UNLOCK_MINUTES });
}

/**
 * Shut it again.
 *
 * The screen calls this every time somebody arrives at the payroll tab, which
 * is what makes the PIN a question rather than a formality: whatever window
 * was left over from earlier is gone before anything is fetched.
 */
export async function lock(ctx) {
  await ctx.db.prepare('UPDATE pay_access SET unlocked_until = NULL WHERE user_id = ?')
    .bind(ctx.session.user.id).run().catch(() => {});
  return json({ ok: true, open: false });
}

// ---------------------------------------------------------------------------
// What an administrator does
// ---------------------------------------------------------------------------

/** Everybody who could hold payroll access, and where each of them stands. */
export async function accessList(ctx) {
  const users = await ctx.db.prepare(
    'SELECT id, name, role, permissions, active FROM users WHERE active = 1 ORDER BY name',
  ).all();
  const rows = await ctx.db.prepare('SELECT * FROM pay_access').all().catch(() => ({ results: [] }));
  const by = new Map((rows.results ?? []).map((r) => [r.user_id, r]));

  const people = (users.results ?? []).map((user) => {
    const held = effectivePermissions(user);
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      admin: user.role === 'admin',
      // Somebody without the permission cannot be granted anything: the grant
      // is the second lock, not a way round the first.
      canHold: user.role === 'admin' || allows('hr_pay', held),
      access: readAccess(by.get(user.id)),
    };
  }).filter((p) => p.canHold || p.access.state !== 'none');

  return json({ people, unlockMinutes: UNLOCK_MINUTES, maxDays: MAX_GRANT_DAYS });
}

/**
 * Grant somebody payroll access, and hand back the code once.
 *
 * Granting again replaces what was there: a new code, a new end date, and any
 * window they were holding is shut. That is the way to change somebody's end
 * date and the way to replace a code they have lost, and it is one button
 * rather than three. Their PIN is their own and survives it; resetting that is
 * a separate button, because it is a separate thing to have lost.
 */
export async function grant(ctx) {
  const body = await readJson(ctx.request);
  const userId = int(body.userId, 'Who', { required: true, min: 1 });
  const days = int(body.days, 'How long', { required: true, min: 1, max: MAX_GRANT_DAYS });
  const note = str(body.note, 'Note', { max: 200 });

  const user = await ctx.db.prepare(
    'SELECT id, name, role, permissions, active FROM users WHERE id = ?',
  ).bind(userId).first();
  if (!user?.active) throw notFound('No such login.');
  if (user.role === 'admin') {
    throw badRequest('An administrator already has the payroll and is the one who grants it. '
      + 'There is nothing to give them.');
  }

  if (!allows('hr_pay', effectivePermissions(user))) {
    throw badRequest(`${user.name} does not have "Pay and labour cost" on their login. Give them `
      + 'that first: the grant is the second lock, not a way round the first.');
  }

  const code = newCode();
  const pepper = await getPepper(ctx.db);
  const expires = iso(Date.now() + days * 86_400_000);

  await ctx.db.prepare(
    `INSERT INTO pay_access (user_id, code_hash, granted_by, granted_at, expires_at, note)
     VALUES (?1, ?2, ?3, datetime('now'), ?4, ?5)
     ON CONFLICT (user_id) DO UPDATE
       SET code_hash = ?2, granted_by = ?3, granted_at = datetime('now'), expires_at = ?4,
           note = ?5, unlocked_at = NULL, unlocked_until = NULL, tries = 0, locked_until = NULL`,
  ).bind(userId, await hashCode(code, pepper), actorOf(ctx), expires, note || null).run();

  await audit(ctx, 'payroll.grant', userId, { name: user.name, days, expires });

  return json({
    ok: true,
    name: user.name,
    code,
    expiresAt: expires,
    unlockMinutes: UNLOCK_MINUTES,
  });
}

/**
 * Reset somebody's payroll PIN, so they can choose another.
 *
 * This opens nothing on its own: the next person to sign in as them has to
 * choose a new PIN, and a member of staff needs their code to do it. It is
 * also how one administrator gets another back in, and with a single
 * administrator the recovery login in the worker's secrets is the way home.
 */
export async function resetPin(ctx, idParam) {
  const userId = int(idParam, 'Who', { required: true, min: 1 });
  const done = await ctx.db.prepare(
    `UPDATE pay_access
        SET pin_hash = NULL, pin_set_at = NULL, unlocked_until = NULL, tries = 0,
            locked_until = NULL
      WHERE user_id = ?1 AND pin_hash IS NOT NULL`,
  ).bind(userId).run();

  if (!Number(done?.meta?.changes ?? 0)) throw notFound('They have not set a payroll PIN.');
  await audit(ctx, 'payroll.pin_reset', userId, {});
  return json({ ok: true });
}

/** Take it away. Any window they are holding goes with it, at once. */
export async function revoke(ctx, idParam) {
  const userId = int(idParam, 'Who', { required: true, min: 1 });
  const gone = await ctx.db.prepare('DELETE FROM pay_access WHERE user_id = ?').bind(userId).run();
  if (!Number(gone?.meta?.changes ?? 0)) throw notFound('They did not have it.');
  await audit(ctx, 'payroll.revoke', userId, {});
  return json({ ok: true });
}
