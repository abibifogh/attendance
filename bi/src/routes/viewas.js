import { all, first, run } from '../lib/db.js';
import { HttpError, badRequest, json } from '../lib/http.js';
import { clearViewAsCookie, currentAccount, mayViewAs, mayViewAsRow, viewAsCookie, accessFor } from '../lib/auth.js';

/**
 * View as: an admin sees Insight as somebody else sees it, to know what they
 * see. Look only: the router refuses every change while it is on. Each time
 * is logged (who, as whom, from and until), shown to owners under Accounts.
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** The admin really signed in, whatever they are looking as. */
async function viewer(request, env) {
  const account = await currentAccount(request, env, { real: true });
  if (!account) throw new HttpError(401, 'Sign in required');
  if (!mayViewAs(account)) throw new HttpError(403, 'Only an admin can view Insight as somebody else.');
  return account;
}

/** What an account is in Insight, in words. */
function roleWords(row, access) {
  if (row.is_owner === 1) return 'Owner';
  const grant = access.find((a) => a.systemId === 'insight');
  if (!grant) return 'Hub only: the other systems, no Insight screens';
  if (grant.role === 'supervisor') return 'Supervisor';
  if (grant.role === 'uploader') return 'Uploader: upload files only';
  if (grant.role === 'reports') return 'Reports only: the reports an admin chose';
  return 'Admin';
}

/** Whom this admin may look as. */
export async function choices(env, { request }) {
  const me = await viewer(request, env);
  const rows = await all(env.DB, 'SELECT id, name, email, is_owner, active FROM accounts WHERE active = 1 ORDER BY name');
  const out = [];
  for (const row of rows.filter((r) => mayViewAsRow(me, r))) {
    // eslint-disable-next-line no-await-in-loop
    const access = await accessFor(env.DB, row.id);
    out.push({ id: row.id, name: row.name, email: row.email, role: roleWords(row, access) });
  }
  return { accounts: out };
}

/** Start looking as somebody (or switch to somebody else). */
export async function start(env, { request, body }) {
  const me = await viewer(request, env);
  const row = await first(env.DB, 'SELECT id, name, is_owner, active FROM accounts WHERE id = ?1', Number(body?.accountId));
  if (!row) throw badRequest('Whom?');
  if (!mayViewAsRow(me, row)) {
    throw new HttpError(403, Number(row.id) === Number(me.id) ? 'That is you.' : row.active ? 'Only an owner can view as an owner.' : 'That account is switched off.');
  }
  const at = now();
  await run(env.DB, 'UPDATE view_as_log SET ended_at = ?2 WHERE by_id = ?1 AND ended_at IS NULL', me.id, at);
  await run(env.DB, 'INSERT INTO view_as_log (by_id, by_name, as_id, as_name, started_at) VALUES (?1, ?2, ?3, ?4, ?5)', me.id, me.name, row.id, row.name, at);
  return json({ ok: true, as: row.name }, { headers: { 'Set-Cookie': await viewAsCookie(env.SESSION_SECRET, { by: me.id, as: row.id }) } });
}

/** Back to being yourself. Always works, even signed out: it only clears the cookie. */
export async function stop(env, { request }) {
  const me = await currentAccount(request, env, { real: true }).catch(() => null);
  if (me?.id != null) await run(env.DB, 'UPDATE view_as_log SET ended_at = ?2 WHERE by_id = ?1 AND ended_at IS NULL', me.id, now()).catch(() => {});
  return json({ ok: true }, { headers: { 'Set-Cookie': clearViewAsCookie() } });
}

/** Who looked as whom, newest first: for owners. */
export async function log(env) {
  const rows = await all(env.DB, 'SELECT * FROM view_as_log ORDER BY id DESC LIMIT 50').catch(() => []);
  // The cookie lasts 4 hours: one never stopped ended by itself then.
  const lapsed = (at) => new Date(new Date(`${at.replace(' ', 'T')}Z`).getTime() + 4 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  return {
    log: rows.map((r) => ({
      by: r.by_name, as: r.as_name, startedAt: r.started_at,
      endedAt: r.ended_at || (lapsed(r.started_at) < now() ? lapsed(r.started_at) : null),
    })),
  };
}
