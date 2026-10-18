import { badRequest, forbidden, int, json, notFound, readJson } from '../lib/http.js';
import {
  VIEW_AS_SECONDS, clearViewAsCookie, createToken, viewAsCookie,
} from '../lib/auth.js';
import { ROLES, effectivePermissions } from '../lib/permissions.js';

/**
 * Viewing HIVE as somebody else.
 *
 * An administrator picks a login and HIVE answers every screen as that person
 * for up to an hour: their menu, their Home, their shifts and pay, what their
 * permissions let them open and what they do not. Nothing can be changed while
 * it lasts; the request handler refuses every save. It exists so whoever sets
 * up a login can see what they have given somebody, and so "I can't see the
 * button" can be looked at rather than guessed at.
 */

const roleLabel = Object.fromEntries(ROLES.map((r) => [r.key, r.label]));

const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(`${ctx.session.user.name} (${ctx.session.user.role})`, action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

const mustBeAdmin = (ctx) => {
  if (ctx.session.user.role !== 'admin' || ctx.session.user.isRecovery) {
    throw forbidden('Only an administrator can view HIVE as somebody else.');
  }
};

/** Everybody who can be viewed as, by the kind of login they are. */
export async function viewAsPeople(ctx) {
  mustBeAdmin(ctx);
  const rows = await ctx.db.prepare(
    `SELECT u.id, u.name, u.role, u.permissions, u.staff_id, s.department, s.job_title
       FROM users u LEFT JOIN att_staff s ON s.id = u.staff_id
      WHERE u.active = 1 AND u.id != ? ORDER BY u.name`,
  ).bind(Number(ctx.session.user.id)).all();
  return json({
    people: (rows.results ?? []).map((u) => {
      const held = effectivePermissions(u);
      return {
        id: u.id,
        name: u.name,
        role: u.role,
        roleLabel: roleLabel[u.role] ?? u.role,
        // The front desk is a member of staff who closes a till, which is the
        // difference the menu shows, so it is said.
        frontDesk: held.includes('till') && u.role !== 'admin',
        department: u.department ?? null,
        jobTitle: u.job_title ?? null,
      };
    }),
  });
}

/** Start viewing as one of them. */
export async function startViewAs(ctx) {
  mustBeAdmin(ctx);
  const body = await readJson(ctx.request);
  const id = int(body.userId, 'Who', { required: true, min: 1 });
  if (id === Number(ctx.session.user.id)) throw badRequest('That is you.');
  const target = await ctx.db.prepare('SELECT id, name, role, active FROM users WHERE id = ?').bind(id).first();
  if (!target || !target.active) throw notFound('No such login, or it is switched off.');

  const token = await createToken({
    viewAs: true,
    by: Number(ctx.session.user.id),
    as: id,
    exp: Math.floor(Date.now() / 1000) + VIEW_AS_SECONDS,
  }, ctx.env.SESSION_SECRET);
  await audit(ctx, 'view_as.start', id, { name: target.name, role: target.role });
  return json({ ok: true, name: target.name, minutes: VIEW_AS_SECONDS / 60 }, {
    headers: { 'Set-Cookie': viewAsCookie(token, ctx.url.protocol === 'https:') },
  });
}

/** And back to being themselves. */
export async function stopViewAs(ctx) {
  await audit(ctx, 'view_as.stop', null, {});
  return json({ ok: true }, {
    headers: { 'Set-Cookie': clearViewAsCookie(ctx.url.protocol === 'https:') },
  });
}
