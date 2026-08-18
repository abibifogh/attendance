import { all, first, run } from './db.js';
import { HttpError, badRequest, forbidden } from './http.js';
import { b64urlEncode, timingSafeEqual } from './auth.js';

/**
 * Signing in once, and arriving at four other systems already signed in.
 *
 * This is the authorization-code half of OAuth and nothing else. It is written
 * out here rather than pulled in because the whole of it is ninety lines, and
 * because an identity provider is the last place to put a dependency nobody in
 * the building can read.
 *
 * The flow, once:
 *
 *   1. Somebody signed in here clicks "Restaurant POS" on the hub.
 *   2. This app checks they have been granted that system, mints 32 random
 *      bytes, and stores the *hash* of them against that account and that
 *      system, good for ninety seconds and one use.
 *   3. The browser is redirected to the POS's own /sso endpoint with the code.
 *   4. The POS's server — not the browser — calls back here with the code and
 *      its own shared secret, and gets the person's name, address and role.
 *   5. The POS creates its own native session and sends them to its home page.
 *
 * Four decisions in there are worth stating, because each is the reason a
 * simpler version of this would be unsafe.
 *
 * **The identity travels on the back channel, never in the URL.** Step 3 hands
 * over an opaque code and nothing else. A URL ends up in a browser history, a
 * server log, a `Referer` header and whatever the person pastes into a chat;
 * a code that is single-use and ninety seconds old is worthless in all of them,
 * and an email address and a role are not.
 *
 * **Single use is enforced here, not there.** There are four far ends and one
 * of these, and a replay check is only as good as the system that forgets to
 * implement it. The `UPDATE ... WHERE redeemed_at IS NULL` in `redeem` is the
 * whole mechanism: the second redemption of a code changes no rows and is
 * refused.
 *
 * **Every system has its own secret and can only redeem its own codes.** A
 * compromised laundry cannot mint itself a session on the POS, because the
 * secret it holds does not authenticate it as the POS and a code issued for the
 * POS is refused when anybody else presents it.
 *
 * **The redirect target is configuration, never input.** `sso_url` is set by an
 * owner and read from the database. An identity provider that redirects
 * wherever the query string says is a phishing page hosted on your own domain.
 */

/** Ninety seconds: long enough for a redirect, short enough to be worthless. */
export const CODE_TTL_SECONDS = 90;

/** Where each system's shared secret lives on this Worker. */
export const SECRET_NAMES = {
  attendance: 'SSO_SECRET_ATTENDANCE',
  breakfast: 'SSO_SECRET_BREAKFAST',
  pos: 'SSO_SECRET_POS',
  laundry: 'SSO_SECRET_LAUNDRY',
};

export const secretNameFor = (systemId) => SECRET_NAMES[systemId] ?? null;

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64urlEncode(new Uint8Array(digest));
}

async function log(db, { systemId, accountId, email, event, detail }) {
  await run(db, `
    INSERT INTO sso_log (system_id, account_id, email, event, detail)
    VALUES (?1, ?2, ?3, ?4, ?5)`,
    systemId ?? null, accountId ?? null, email ?? null, event, (detail ?? '').slice(0, 300));
}

/**
 * Mint a hand-off for one account into one system.
 *
 * Refuses before it mints, on every count: the system has to exist, have single
 * sign-on switched on, have somewhere to send the person, hold a secret so it
 * can redeem, and the account has to have been granted it. An owner is granted
 * everything by virtue of being an owner; nobody else is granted anything by
 * implication.
 */
export async function issueCode(env, account, systemId) {
  const db = env.DB;
  const system = await first(db, 'SELECT * FROM systems WHERE id = ?1', systemId);
  if (!system) throw badRequest('No such system');

  // A bootstrap session is the shared password, not a person. It exists to
  // create the first account and must not become a skeleton key to the group.
  if (account.bootstrap) {
    await log(db, { systemId, event: 'refused', detail: 'bootstrap session' });
    throw forbidden('Create yourself a real account before opening another system from here. The shared password gets you in to set this up, and no further.');
  }

  const granted = account.isOwner || account.access.some((a) => a.systemId === systemId);
  if (!granted) {
    await log(db, { systemId, accountId: account.id, email: account.email, event: 'refused', detail: 'not granted' });
    throw forbidden(`Your account has not been given ${system.label}.`);
  }
  if (!system.sso_enabled) throw badRequest(`${system.label} has not been set up for single sign-on yet.`);
  if (!system.sso_url) throw badRequest(`${system.label} has no sign-in address configured.`);

  const secretName = secretNameFor(systemId);
  if (!secretName || !env[secretName]) {
    throw badRequest(`${system.label} has no shared secret on this Worker. Set it with \`wrangler secret put ${secretName ?? 'SSO_SECRET_…'}\`.`);
  }

  const code = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString().replace('T', ' ').slice(0, 19);

  await run(db, `
    INSERT INTO sso_codes (code_hash, system_id, account_id, expires_at)
    VALUES (?1, ?2, ?3, ?4)`, await sha256(code), systemId, account.id, expires);

  // Housekeeping, cheaply and here rather than on a schedule: anything an hour
  // old is long dead and there is no reason to keep it.
  await run(db, "DELETE FROM sso_codes WHERE expires_at < datetime('now', '-1 hour')");
  await log(db, { systemId, accountId: account.id, email: account.email, event: 'issued' });

  const url = new URL(system.sso_url);
  url.searchParams.set('code', code);
  return { url: url.toString(), system, expiresIn: CODE_TTL_SECONDS };
}

/**
 * Turn a code into an identity, once.
 *
 * Called server-to-server by the far system, which proves it is the far system
 * with its own shared secret. Everything that can go wrong here — no such code,
 * expired, already used, issued for somebody else — comes back as the same
 * refusal, because telling a caller which of those it was tells them something
 * about codes they do not hold.
 */
export async function redeemCode(env, { code, systemId, secret }) {
  const db = env.DB;

  const secretName = secretNameFor(systemId);
  const expected = secretName ? env[secretName] : null;
  if (!expected || !secret || !timingSafeEqual(secret, expected)) {
    await log(db, { systemId, event: 'refused', detail: 'bad system secret' });
    throw new HttpError(401, 'Not a recognised system');
  }
  if (typeof code !== 'string' || code.length < 20) throw badRequest('That code cannot be redeemed');

  const hash = await sha256(code);

  // The single line that makes a code single-use. A second redemption changes
  // no rows, whatever else about it looks fine.
  const claimed = await db.prepare(`
    UPDATE sso_codes SET redeemed_at = datetime('now')
     WHERE code_hash = ?1
       AND system_id = ?2
       AND redeemed_at IS NULL
       AND expires_at > datetime('now')`).bind(hash, systemId).run();

  if (!claimed?.meta?.changes) {
    await log(db, { systemId, event: 'refused', detail: 'code not live' });
    throw badRequest('That code cannot be redeemed');
  }

  const row = await first(db, `
    SELECT c.account_id, a.email, a.name, a.active, a.is_owner
      FROM sso_codes c JOIN accounts a ON a.id = c.account_id
     WHERE c.code_hash = ?1`, hash);

  // Switched off between the click and the redemption. Ninety seconds is a
  // small window and it is not zero, and this is a front door.
  if (!row || !row.active) {
    await log(db, { systemId, accountId: row?.account_id, event: 'refused', detail: 'account not active' });
    throw badRequest('That code cannot be redeemed');
  }

  const access = await first(db,
    'SELECT role FROM account_access WHERE account_id = ?1 AND system_id = ?2', row.account_id, systemId);

  await log(db, { systemId, accountId: row.account_id, email: row.email, event: 'redeemed' });

  return {
    sub: String(row.account_id),
    email: row.email,
    name: row.name,
    role: access?.role || (row.is_owner ? 'owner' : ''),
    issuer: 'insight',
  };
}

/** The systems a person may open, in the order the hub shows them. */
export async function systemsFor(env, account) {
  const rows = await all(env.DB, 'SELECT * FROM systems ORDER BY sort_order, label');
  const granted = new Map(account.access.map((a) => [a.systemId, a.role]));

  return rows.map((row) => {
    const allowed = account.isOwner || granted.has(row.id);
    const secretName = secretNameFor(row.id);
    const hasSecret = secretName ? Boolean(env[secretName]) : true;
    return {
      id: row.id,
      label: row.label,
      description: row.description,
      homeUrl: row.home_url || null,
      role: granted.get(row.id) ?? (account.isOwner ? 'owner' : null),
      granted: allowed,
      // Can this person actually be handed over, or will they have to sign in
      // again when they get there? The hub says which, rather than offering a
      // button that silently degrades.
      handOff: Boolean(allowed && row.sso_enabled && row.sso_url && hasSecret && !account.bootstrap),
      reason: !allowed ? 'Not granted to your account'
        : account.bootstrap ? 'Sign in with your own account to be handed over'
          : !row.sso_enabled ? 'Single sign-on is switched off for this system'
            : !row.sso_url ? 'No sign-in address configured'
              : !hasSecret ? `${secretName} is not set on this Worker`
                : null,
      secretName,
    };
  });
}
