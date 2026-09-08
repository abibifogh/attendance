import { badRequest, forbidden, json, notFound, readJson, str } from '../lib/http.js';
import {
  createToken, getPepper, hashPin, isReservedPin, markPinOk, normaliseEmail, sessionCookie,
  storedPassword, throttleCheck, throttleFail, tokenTtl,
} from '../lib/auth.js';
import { effectivePermissions } from '../lib/permissions.js';
import { renderJoinInvite, sendEmail, senderNameOf, senderWithName } from '../lib/notify.js';
import { siteOrigin } from '../lib/site.js';
import {
  DAYS_TO_JOIN, LEAST_PASSWORD, MOST_DAYS, readChoice, waysFor, whyNotOpen,
} from '../lib/joining.js';

/**
 * Inviting somebody into a login, and the other side of that link.
 *
 * Everything below `/api/j/` is reachable by anybody holding the token, so the
 * surface is three things: read who the invitation is for, set a way in, and
 * nothing else. No request here can act on anybody but the account the link
 * was made for, because the token names it.
 *
 * The token is the whole of the link. Only its fingerprint is stored, so a
 * copy of the database opens nothing and a lost link is replaced rather than
 * recovered. It is spent the moment credentials are set.
 */

const actorOf = (ctx) => (ctx.session?.user
  ? `${ctx.session.user.name} (${ctx.session.user.role})`
  : null);

const ipOf = (ctx) => ctx.request.headers.get('CF-Connecting-IP') || 'unknown';

const hashJoinToken = (token, pepper) => hashPin(`join:${token}`, pepper);

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(actorOf(ctx), action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

async function setting(db, key, fallback = null) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key).first().catch(() => null);
  return row?.value ?? fallback;
}

const propertyName = (db) => setting(db, 'property_name', 'Somewhere Nice');

// ---------------------------------------------------------------------------
// Making one
// ---------------------------------------------------------------------------

/**
 * Invite somebody into an account.
 *
 * Any live invitation the account already had is cancelled first. Two live
 * links into one login is one more than anybody can keep track of, and the
 * reason people press this twice is that the first one did not arrive.
 */
export async function inviteToJoin(ctx, id) {
  const userId = Number(id);
  const user = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!user) throw notFound('No such login.');
  if (!user.active) throw badRequest('That login is switched off. Switch it on first.');

  const body = await readJson(ctx.request);
  const email = normaliseEmail(str(body.email, 'Email address', { max: 200, fallback: '' })
    || user.email || '');
  if (!email || !email.includes('@')) {
    throw badRequest('An invitation needs an email address to go to.');
  }

  // An administrator signs in with their address, so it has to be theirs and
  // it has to be free. Checked now rather than when they open the link, where
  // the only thing left to say is "ask for another one".
  if (user.role === 'admin') {
    const taken = await ctx.db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?')
      .bind(email, userId).first().catch(() => null);
    if (taken) throw badRequest('Another login already uses that email address.');
  }

  const days = Number(body.days) > 0
    ? Math.min(MOST_DAYS, Math.round(Number(body.days)))
    : DAYS_TO_JOIN;

  const pepper = await getPepper(ctx.db);
  const token = newToken();

  await ctx.db.prepare(
    "UPDATE user_invite SET revoked_at = datetime('now') "
    + 'WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL',
  ).bind(userId).run().catch(() => {});

  const made = await ctx.db.prepare(
    `INSERT INTO user_invite (user_id, email, token_hash, expires_at, created_by)
     VALUES (?1, ?2, ?3, datetime('now', ?4), ?5) RETURNING id`,
  ).bind(userId, email, await hashJoinToken(token, pepper), `+${days} days`, actorOf(ctx)).first();

  const url = `${await siteOrigin(ctx.db, ctx.url.origin)}/j/${token}`;
  const sent = await postIt(ctx, { user, email, url, days }).catch((err) => String(err.message ?? err));

  if (sent === true) {
    await ctx.db.prepare("UPDATE user_invite SET sent_at = datetime('now') WHERE id = ?")
      .bind(made.id).run().catch(() => {});
  }

  await audit(ctx, 'user.invite', userId, { days, emailed: sent === true });

  return json({
    ok: true,
    id: made.id,
    // Shown once, so it can be passed on by hand where the email did not land
    // or the property has no email set up at all.
    url,
    email,
    days,
    sent: sent === true,
    whyNot: sent === true ? null : sent,
  });
}

/** Send it, in the same clothes as everything else the property sends. */
async function postIt(ctx, { user, email, url, days }) {
  const apiKey = ctx.env?.RESEND_API_KEY;
  const from = await setting(ctx.db, 'email_from');
  if (!apiKey || !from) {
    return 'This property has not set up email yet, so nothing was sent. '
      + 'The link is on screen — pass it on yourself.';
  }

  const name = await propertyName(ctx.db);
  const senderName = await setting(ctx.db, 'email_sender_name');
  const message = renderJoinInvite({
    propertyName: name,
    name: user.name,
    url,
    days,
    ways: waysFor(user.role),
    siteUrl: await siteOrigin(ctx.db, ctx.url.origin),
  });

  await sendEmail({
    apiKey,
    // Named like every other message the property sends. A link asking
    // somebody to set a credential, arriving from a bare address, is the shape
    // of every phishing mail anybody has ever had.
    from: senderWithName(from, senderNameOf({ email_sender_name: senderName })),
    to: email,
    subject: message.subject,
    html: message.html,
  });
  return true;
}

/** Cancel whatever is outstanding. The link stops working the moment this runs. */
export async function cancelInvitation(ctx, id) {
  const userId = Number(id);
  const done = await ctx.db.prepare(
    "UPDATE user_invite SET revoked_at = datetime('now') "
    + 'WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL',
  ).bind(userId).run().catch(() => ({ meta: { changes: 0 } }));

  const changed = Number(done?.meta?.changes ?? 0);
  if (!changed) throw badRequest('There is no invitation outstanding for that login.');
  await audit(ctx, 'user.invite_cancelled', userId, {});
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// The other side of it
// ---------------------------------------------------------------------------

async function inviteFor(ctx, token) {
  const pepper = await getPepper(ctx.db);
  const invite = await ctx.db.prepare('SELECT * FROM user_invite WHERE token_hash = ?')
    .bind(await hashJoinToken(String(token ?? ''), pepper)).first().catch(() => null);

  const now = await ctx.db.prepare("SELECT datetime('now') AS at").first();
  const why = whyNotOpen(invite, { now: now?.at });
  if (why) {
    // A link that does not exist and one that has been cancelled are the same
    //404 to anybody guessing: the wording differs, the status does not, so
    // nothing here confirms that a token was close to a real one.
    if (!invite) throw notFound(why);
    throw forbidden(why);
  }

  const user = await ctx.db.prepare('SELECT * FROM users WHERE id = ?')
    .bind(invite.user_id).first();
  if (!user || !user.active) {
    throw forbidden('That account is no longer open. Ask whoever set it up.');
  }
  return { invite, user };
}

/**
 * What is behind the link, before anything is set.
 *
 * Their own first name, the property, and the ways they may pick. Not the
 * role, not the permissions, not the address it went to: somebody who found
 * this link in a forwarded message learns nothing about the property from it.
 */
export async function joinHead(ctx, token) {
  const { invite, user } = await inviteFor(ctx, token);

  if (!invite.opened_at) {
    await ctx.db.prepare("UPDATE user_invite SET opened_at = datetime('now') WHERE id = ?")
      .bind(invite.id).run().catch(() => {});
  }

  return json({
    property: await propertyName(ctx.db),
    name: String(user.name).split(' ')[0],
    ways: waysFor(user.role),
    // The address it was sent to, which is the one a password sign-in will
    // use. Shown because they are reading it in that mailbox anyway, and
    // because an address they cannot see is one they cannot correct.
    email: invite.email,
    leastPassword: LEAST_PASSWORD,
  });
}

/**
 * Setting the way in.
 *
 * The link is spent here whatever they chose, and they are signed in on the
 * spot: making somebody set a PIN and then immediately type it into a login
 * screen is a step that exists only because it was easier to build.
 */
export async function joinSet(ctx, token) {
  const ip = ipOf(ctx);
  const gate = await throttleCheck(ctx.db, ip, { pin: false });
  if (!gate.allowed) throw forbidden('Too many tries. Wait a few minutes and open the link again.');

  const { invite, user } = await inviteFor(ctx, token);
  const body = await readJson(ctx.request);
  const chose = readChoice(body, user.role);
  if (chose.error) {
    await throttleFail(ctx.db, ip, { everybody: false });
    throw badRequest(chose.error);
  }

  const pepper = await getPepper(ctx.db);
  const writes = [];

  if (chose.way === 'pin') {
    if (await isReservedPin(chose.pin, ctx.env)) {
      throw badRequest('That PIN is already in use here. Pick another.');
    }
    const clash = await ctx.db.prepare('SELECT id FROM users WHERE pin_hash = ? AND id <> ?')
      .bind(await hashPin(chose.pin, pepper), user.id).first().catch(() => null);
    if (clash) throw badRequest('That PIN is already in use here. Pick another.');

    writes.push(ctx.db.prepare('UPDATE users SET pin_hash = ?2 WHERE id = ?1')
      .bind(user.id, await hashPin(chose.pin, pepper)));
  } else {
    const taken = await ctx.db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?')
      .bind(invite.email, user.id).first().catch(() => null);
    if (taken) {
      throw badRequest('Another login already uses that email address. Ask for an invitation '
        + 'to a different one.');
    }
    writes.push(ctx.db.prepare('UPDATE users SET email = ?2, password_hash = ?3 WHERE id = ?1')
      .bind(user.id, invite.email, await storedPassword(chose.password, pepper)));
  }

  writes.push(ctx.db.prepare(
    "UPDATE user_invite SET used_at = datetime('now'), chose = ?2 WHERE id = ?1",
  ).bind(invite.id, chose.way));

  try {
    await ctx.db.batch(writes);
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw badRequest(chose.way === 'pin'
        ? 'That PIN is already in use here. Pick another.'
        : 'Another login already uses that email address.');
    }
    throw err;
  }

  if (chose.way === 'pin') await markPinOk(ctx.db, user.id);
  await ctx.db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
    .bind(user.id).run().catch(() => {});
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
  ).bind(`${user.name} (${user.role})`, 'user.joined', String(user.id),
    JSON.stringify({ way: chose.way })).run().catch(() => {});

  // Straight in, with the session the login screen would have given them.
  const fresh = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  const now = Math.floor(Date.now() / 1000);
  const session = await createToken({
    uid: fresh.id,
    role: fresh.role,
    recovery: 0,
    via: chose.way === 'pin' ? 'pin' : 'password',
    iat: now,
    exp: now + tokenTtl(fresh.role),
  }, ctx.env.SESSION_SECRET);

  return json({
    ok: true,
    way: chose.way,
    role: fresh.role,
    name: fresh.name,
    permissions: effectivePermissions(fresh),
  }, {
    headers: { 'Set-Cookie': sessionCookie(session, fresh.role, ctx.url.protocol === 'https:') },
  });
}
