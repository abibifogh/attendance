import { badRequest, forbidden, int, json, notFound, readJson, str } from '../lib/http.js';
import { getPepper, hashPin } from '../lib/auth.js';
import { allows, effectivePermissions } from '../lib/permissions.js';
import {
  MAX_GRANT_DAYS, UNLOCK_HOURS, afterWrongCode, isAdmin, iso, mayOpen, newCode, readAccess,
  refusalFor, tidyCode, unlockUntil,
} from '../lib/payroll-access.js';

/**
 * Granting, revoking and unlocking payroll access.
 *
 * The grant is a deliberate act by an administrator, recorded with their name
 * against it and an end date. The code is shown to them once and handed over
 * however they choose; only its fingerprint is kept, so a lost one is replaced
 * rather than recovered, which is how every other code in this app works.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(actorOf(ctx), action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

const hashCode = (code, pepper) => hashPin(`payroll:${tidyCode(code)}`, pepper);

export const rowFor = (db, userId) => db.prepare(
  'SELECT * FROM pay_access WHERE user_id = ?',
).bind(userId).first().catch(() => null);

/**
 * The gate every payroll request goes through.
 *
 * Called from the router rather than from each handler, because a route added
 * later and wired to the wrong permission is exactly the accident this exists
 * to stop.
 */
export async function guardPayroll(ctx) {
  const verdict = mayOpen(ctx.session, await rowFor(ctx.db, ctx.session.user.id));
  if (verdict.ok) return;
  throw forbidden(refusalFor(verdict.why), { payrollLocked: true, state: verdict.why });
}

/** Where the person stands, for the screen that has to ask them for a code. */
export async function myAccess(ctx) {
  const admin = isAdmin(ctx.session);
  const access = readAccess(admin ? null : await rowFor(ctx.db, ctx.session.user.id));

  return json({
    admin,
    open: admin || access.state === 'open',
    unlockHours: UNLOCK_HOURS,
    ...access,
  });
}

/** Type the code, open the payroll for a while. */
export async function unlock(ctx) {
  if (isAdmin(ctx.session)) return json({ ok: true, open: true, admin: true });

  const body = await readJson(ctx.request);
  const typed = tidyCode(body.code);
  if (!typed) throw badRequest('Type the code you were given.');

  const row = await rowFor(ctx.db, ctx.session.user.id);
  const access = readAccess(row);
  if (access.state === 'none') throw forbidden(refusalFor('none'), { payrollLocked: true });
  if (access.state === 'expired') throw forbidden(refusalFor('expired'), { payrollLocked: true });
  if (access.state === 'locked') throw forbidden(refusalFor('locked'), { payrollLocked: true });

  const pepper = await getPepper(ctx.db);
  if (await hashCode(typed, pepper) !== row.code_hash) {
    const after = afterWrongCode(row);
    await ctx.db.prepare(
      "UPDATE pay_access SET tries = ?2, locked_until = ?3 WHERE user_id = ?1",
    ).bind(ctx.session.user.id, after.tries, after.lockedUntil).run();
    await audit(ctx, 'payroll.unlock_failed', ctx.session.user.id, { lockedOut: !!after.lockedUntil });

    throw forbidden(after.lockedUntil
      ? refusalFor('locked')
      : 'That code is not right.', { payrollLocked: true });
  }

  const until = unlockUntil();
  await ctx.db.prepare(
    `UPDATE pay_access
        SET unlocked_at = datetime('now'), unlocked_until = ?2, tries = 0, locked_until = NULL
      WHERE user_id = ?1`,
  ).bind(ctx.session.user.id, until).run();
  await audit(ctx, 'payroll.unlock', ctx.session.user.id, { until });

  return json({ ok: true, open: true, unlockedUntil: until, unlockHours: UNLOCK_HOURS });
}

/** Shut it again, for somebody leaving a machine on a desk. */
export async function lock(ctx) {
  await ctx.db.prepare('UPDATE pay_access SET unlocked_until = NULL WHERE user_id = ?')
    .bind(ctx.session.user.id).run();
  return json({ ok: true, open: isAdmin(ctx.session) });
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

  return json({ people, unlockHours: UNLOCK_HOURS, maxDays: MAX_GRANT_DAYS });
}

/**
 * Grant somebody payroll access, and hand back the code once.
 *
 * Granting again replaces what was there: a new code, a new end date, and any
 * unlock they were holding is dropped. That is the way to change somebody's
 * end date and the way to replace a code they have lost, and it is one button
 * rather than three.
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
    `INSERT INTO pay_access (user_id, code_hash, granted_by, expires_at, note)
     VALUES (?1, ?2, ?3, ?4, ?5)
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
    unlockHours: UNLOCK_HOURS,
  });
}

/** Take it away. Any unlock they are holding goes with it, at once. */
export async function revoke(ctx, idParam) {
  const userId = int(idParam, 'Who', { required: true, min: 1 });
  const gone = await ctx.db.prepare('DELETE FROM pay_access WHERE user_id = ?').bind(userId).run();
  if (!Number(gone?.meta?.changes ?? 0)) throw notFound('They did not have it.');
  await audit(ctx, 'payroll.revoke', userId, {});
  return json({ ok: true });
}
