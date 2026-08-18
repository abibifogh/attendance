import { all, first, run } from '../lib/db.js';
import { badRequest, notFound, str } from '../lib/http.js';
import { getPepper, normaliseEmail, storedPassword } from '../lib/auth.js';
import { secretNameFor } from '../lib/sso.js';

/**
 * Accounts, and what each may reach.
 *
 * Only an owner gets here. The rules are deliberately few and each of them is
 * about not being able to lock the group out or quietly hand over more than was
 * meant:
 *
 *   - Nobody can remove the last owner, including themselves.
 *   - Nobody can switch off their own account.
 *   - A grant is per system and per person; there is no role that carries all
 *     of them, because "manager" means five different things in five systems.
 */

export async function list(env) {
  const rows = await all(env.DB, `
    SELECT a.*, (SELECT COUNT(*) FROM account_access x WHERE x.account_id = a.id) AS grants
      FROM accounts a ORDER BY a.active DESC, a.name`);
  const access = await all(env.DB, 'SELECT * FROM account_access');
  const systems = await all(env.DB, 'SELECT * FROM systems ORDER BY sort_order');

  return {
    accounts: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      isOwner: row.is_owner === 1,
      active: row.active === 1,
      hasPassword: Boolean(row.password_hash),
      note: row.note,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      access: access.filter((a) => a.account_id === row.id)
        .map((a) => ({ systemId: a.system_id, role: a.role || '' })),
    })),
    systems: systems.map((s) => ({
      id: s.id, label: s.label, description: s.description,
      homeUrl: s.home_url || '', ssoUrl: s.sso_url || '',
      ssoEnabled: s.sso_enabled === 1,
      secretName: secretNameFor(s.id),
      secretSet: secretNameFor(s.id) ? Boolean(env[secretNameFor(s.id)]) : null,
    })),
  };
}

export async function save(env, body, actor) {
  const email = normaliseEmail(str(body?.email, 'Email address', { required: true, max: 200 }));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('That is not an email address');
  const name = str(body?.name, 'Name', { required: true, max: 120 });
  const id = body?.id ? Number(body.id) : null;

  if (id) {
    const existing = await first(env.DB, 'SELECT * FROM accounts WHERE id = ?1', id);
    if (!existing) throw notFound('No such account');

    const active = body.active === undefined ? existing.active : (body.active ? 1 : 0);
    const isOwner = body.isOwner === undefined ? existing.is_owner : (body.isOwner ? 1 : 0);

    // Two accounts cannot share an address — the table enforces it, and
    // catching it here means a sentence rather than a constraint failure.
    const clash = await first(env.DB, 'SELECT id, name FROM accounts WHERE email = ?1 AND id <> ?2', email, id);
    if (clash) throw badRequest(`${clash.name} already uses that address.`);

    if (existing.is_owner === 1 && isOwner === 0) await refuseIfLastOwner(env.DB, id);
    if (existing.active === 1 && active === 0) {
      await refuseIfLastOwner(env.DB, id);
      if (actor?.id === id) throw badRequest('You cannot switch off your own account.');
    }

    await run(env.DB, `
      UPDATE accounts SET email = ?2, name = ?3, is_owner = ?4, active = ?5, note = ?6 WHERE id = ?1`,
      id, email, name, isOwner, active, str(body?.note, 'Note', { max: 400 }));
    return list(env);
  }

  const clash = await first(env.DB, 'SELECT id FROM accounts WHERE email = ?1', email);
  if (clash) throw badRequest('An account already uses that address');

  await run(env.DB, `
    INSERT INTO accounts (email, name, is_owner, active, note) VALUES (?1, ?2, ?3, 1, ?4)`,
    email, name, body?.isOwner ? 1 : 0, str(body?.note, 'Note', { max: 400 }));
  return list(env);
}

/**
 * Set somebody's password.
 *
 * The browser has already done the stretching; what arrives is a derived key,
 * the salt it used and the work factor. All three are kept — the salt and the
 * iteration count are not secret, they only have to be remembered so the same
 * derivation can be repeated at sign-in.
 */
export async function setPassword(env, id, body) {
  const account = await first(env.DB, 'SELECT id FROM accounts WHERE id = ?1', Number(id));
  if (!account) throw notFound('No such account');

  const passwordKey = str(body?.passwordKey, 'Password', { required: true, max: 200 });
  const salt = str(body?.passwordSalt, 'Salt', { required: true, max: 100 });
  const iterations = Number(body?.passwordIterations) || 600_000;
  if (iterations < 100_000) throw badRequest('That password was not stretched enough to store.');

  const stored = await storedPassword({ passwordKey, salt, iterations }, await getPepper(env.DB));
  await run(env.DB, 'UPDATE accounts SET password_hash = ?2 WHERE id = ?1', Number(id), stored);
  return { ok: true };
}

export async function setAccess(env, id, body, actor) {
  const accountId = Number(id);
  const account = await first(env.DB, 'SELECT * FROM accounts WHERE id = ?1', accountId);
  if (!account) throw notFound('No such account');

  const wanted = Array.isArray(body?.access) ? body.access : [];
  const systems = new Set((await all(env.DB, 'SELECT id FROM systems')).map((s) => s.id));

  await run(env.DB, 'DELETE FROM account_access WHERE account_id = ?1', accountId);
  for (const entry of wanted) {
    const systemId = str(entry?.systemId, 'System', { max: 40 });
    if (!systemId || !systems.has(systemId)) continue;
    await run(env.DB, `
      INSERT INTO account_access (account_id, system_id, role, granted_by)
      VALUES (?1, ?2, ?3, ?4)`,
      accountId, systemId, str(entry?.role, 'Role', { max: 40 }) || '', actor?.email || 'owner');
  }
  return list(env);
}

/**
 * Where a system lives, and whether it will accept a hand-off.
 *
 * Addresses only. The shared secret is a Worker secret and is not accepted
 * here at any price — a secret typed into a web form is a secret in a browser
 * history, a proxy log and a database export.
 */
export async function saveSystem(env, id, body) {
  const system = await first(env.DB, 'SELECT * FROM systems WHERE id = ?1', id);
  if (!system) throw notFound('No such system');

  const url = (value, field) => {
    const text = str(value, field, { max: 300 });
    if (!text) return '';
    let parsed;
    try { parsed = new URL(text); } catch { throw badRequest(`${field} is not a web address`); }
    // Plain HTTP would carry the code in clear across the network, and the code
    // is a bearer of somebody's identity for the next ninety seconds.
    if (parsed.protocol !== 'https:') throw badRequest(`${field} must start with https://`);
    return parsed.toString();
  };

  const homeUrl = body.homeUrl === undefined ? system.home_url : url(body.homeUrl, 'Home address');
  const ssoUrl = body.ssoUrl === undefined ? system.sso_url : url(body.ssoUrl, 'Sign-in address');
  const enabled = body.ssoEnabled === undefined ? system.sso_enabled : (body.ssoEnabled ? 1 : 0);

  if (enabled && !ssoUrl) throw badRequest('Single sign-on needs a sign-in address before it can be switched on.');

  await run(env.DB, `
    UPDATE systems SET home_url = ?2, sso_url = ?3, sso_enabled = ?4 WHERE id = ?1`,
    id, homeUrl, ssoUrl, enabled);
  return list(env);
}

export async function handoffLog(env) {
  const rows = await all(env.DB, 'SELECT * FROM sso_log ORDER BY id DESC LIMIT 100');
  return {
    log: rows.map((r) => ({
      at: r.at, systemId: r.system_id, email: r.email, event: r.event, detail: r.detail,
    })),
  };
}

/** The group must never be left without somebody who can let people back in. */
async function refuseIfLastOwner(db, id) {
  const others = await first(db,
    'SELECT COUNT(*) AS n FROM accounts WHERE is_owner = 1 AND active = 1 AND id <> ?1', id);
  if (!others?.n) {
    throw badRequest('That is the last active owner. Make somebody else an owner first, or nobody will be able to let people back in.');
  }
}
