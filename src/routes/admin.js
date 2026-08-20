import { originOf } from '../lib/site.js';
import { badRequest, bool, json, notFound, readJson, str } from '../lib/http.js';
import {
  getPepper, hashPin, isReservedPin, normaliseEmail, storedPassword,
} from '../lib/auth.js';
import {
  PERMISSIONS, PERMISSION_KEYS, ROLES, effectivePermissions, isRole,
} from '../lib/permissions.js';
import { listNotices, markSeen } from '../lib/notices.js';
import { emailExceptions, isEmail, parseRecipients } from '../lib/notify.js';
import { isDay } from '../util/dates.js';

/**
 * Logins, notifications and the data itself.
 *
 * Everything an administrator does that is not attendance. Kept in one file
 * behind one permission, because the three things have exactly one audience.
 */

const PIN_RE = /^\d{4,10}$/;
const MIN_PASSWORD = 10;

// Deliberately identical for "a colleague has it" and "the server reserves it".
export const PIN_TAKEN = 'That PIN is not available. Please choose a different one.';

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(
    `${ctx.session.user.name} (${ctx.session.user.role})`,
    action,
    entity == null ? null : String(entity),
    detail ? JSON.stringify(detail) : null,
  ).run().catch(() => {});
}

function setting(db, key, value) {
  return db.prepare(
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2',
  ).bind(key, value);
}

// ---------------------------------------------------------------------------
// People who can sign in
// ---------------------------------------------------------------------------

/**
 * Administrators sign in with an email address and password; everyone else
 * uses a PIN. Validated here rather than only in the form, so the rule holds
 * however the request arrives.
 */
function readCredentials(body, role, { existing = null } = {}) {
  const isAdmin = role === 'admin';

  if (isAdmin) {
    const email = normaliseEmail(str(body.email, 'Email address', { max: 200, fallback: '' }));
    if (!email && !existing?.email) throw badRequest('An administrator needs an email address to sign in with');
    if (email && !isEmail(email)) throw badRequest('That does not look like an email address');

    // The browser stretches the password and sends the derived key with the
    // salt it used; the raw password never reaches here. Length and shape are
    // checked in the browser, where the password still exists.
    const password = body.passwordKey
      ? {
        passwordKey: String(body.passwordKey),
        salt: str(body.passwordSalt, 'Password salt', { required: true, max: 64 }),
        iterations: body.passwordIterations,
      }
      : null;

    if (!password && !existing?.password_hash) {
      throw badRequest(`An administrator needs a password of at least ${MIN_PASSWORD} characters`);
    }

    return { isAdmin, email: email || existing?.email, password, pin: null };
  }

  // Everyone else: a PIN, required on creation. Right for a supervisor holding
  // a phone in a corridor with one hand.
  const pin = str(body.pin, 'PIN', { max: 10, fallback: '' });
  if (!pin && !existing?.pin_hash) throw badRequest('Give this person a PIN of 4 to 10 digits');
  if (pin && !PIN_RE.test(pin)) throw badRequest('The PIN must be 4 to 10 digits');

  // A demoted administrator keeps their address on file but stops using it.
  const email = normaliseEmail(str(body.email, 'Email address', { max: 200, fallback: '' }));
  if (email && !isEmail(email)) throw badRequest('That does not look like an email address');

  return { isAdmin, email: email || null, password: null, pin };
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    signsInWith: row.role === 'admin' ? 'password' : 'pin',
    hasPassword: typeof row.password_hash === 'string' && row.password_hash.startsWith('pbkdf2c$'),
    role: row.role,
    permissions: effectivePermissions(row),
    customPermissions: row.permissions ? JSON.parse(row.permissions) : null,
    active: Boolean(row.active),
    note: row.note ?? null,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

/**
 * The state of the emergency recovery PIN.
 *
 * A user PIN can never be set to the recovery PIN — that is refused. The
 * reverse is not something this app can refuse, because the recovery PIN is set
 * on the server, outside it. If somebody changes it to a value a supervisor
 * already uses, the users table is consulted first and the supervisor silently
 * shadows it: the way back in stops working, and nobody finds out until the day
 * it is needed. So it is checked and reported here instead.
 */
async function recoveryStatus(ctx) {
  const configured = Boolean(ctx.env.MANAGER_PIN);

  const stored = await ctx.db.prepare(
    "SELECT value FROM settings WHERE key = 'allow_recovery_pin'",
  ).first();
  const enabled = stored?.value !== '0';

  let conflictsWith = null;
  if (configured) {
    const hash = await hashPin(ctx.env.MANAGER_PIN, await getPepper(ctx.db));
    const clash = await ctx.db.prepare(
      'SELECT name FROM users WHERE pin_hash = ? AND active = 1',
    ).bind(hash).first();
    if (clash) conflictsWith = clash.name;
  }

  return { configured, enabled, conflictsWith };
}

export async function listUsers(ctx) {
  const rows = await ctx.db.prepare(
    'SELECT * FROM users ORDER BY active DESC, role, name',
  ).all();

  return json({
    users: (rows.results ?? []).map(publicUser),
    roles: ROLES,
    permissions: PERMISSIONS,
    recovery: await recoveryStatus(ctx),
  });
}

function readPermissions(body) {
  if (body.permissions == null) return null; // use role defaults
  if (!Array.isArray(body.permissions)) throw badRequest('Permissions must be a list');
  const clean = body.permissions.filter((p) => PERMISSION_KEYS.includes(p));
  if (!clean.length) throw badRequest('Give the person at least one section they can open');
  return JSON.stringify(clean);
}

export async function createUser(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 80 });
  const role = str(body.role, 'Role', { required: true, max: 20 });
  if (!isRole(role)) throw badRequest('Unknown role');

  const creds = readCredentials(body, role);
  const permissions = readPermissions(body);
  const note = str(body.note, 'Note', { max: 300 });

  if (creds.pin && await isReservedPin(creds.pin, ctx.env)) throw badRequest(PIN_TAKEN);

  const pepper = await getPepper(ctx.db);
  const pinHash = creds.pin ? await hashPin(creds.pin, pepper) : null;
  const passwordHash = creds.password ? await storedPassword(creds.password, pepper) : null;

  try {
    const row = await ctx.db.prepare(
      `INSERT INTO users (name, pin_hash, email, password_hash, role, permissions, active, note)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?) RETURNING *`,
    ).bind(name, pinHash, creds.email, passwordHash, role, permissions, note).first();

    await audit(ctx, 'user.create', row.id, {
      name, role, signIn: creds.isAdmin ? 'password' : 'pin',
    });
    return json({ user: publicUser(row) }, { status: 201 });
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw badRequest(creds.isAdmin
        ? 'That email address is already in use by another account.'
        : PIN_TAKEN);
    }
    throw err;
  }
}

export async function updateUser(ctx, id) {
  const body = await readJson(ctx.request);
  const userId = Number(id);

  const existing = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!existing) throw notFound('User not found');

  const name = str(body.name, 'Name', { required: true, max: 80 });
  const role = str(body.role, 'Role', { required: true, max: 20 });
  if (!isRole(role)) throw badRequest('Unknown role');

  const permissions = readPermissions(body);
  const active = bool(body.active, true);
  const note = str(body.note, 'Note', { max: 300 });

  // Never let the last way in disappear. Demoting or deactivating yourself is
  // fine as long as somebody else can still reach the Users screen.
  if (existing.role === 'admin' && (role !== 'admin' || !active)) {
    const others = await ctx.db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
    ).bind(userId).first();
    if (!others?.n) {
      throw badRequest('This is the only active administrator. Add another one before changing this account.');
    }
  }

  const creds = readCredentials(body, role, { existing });
  if (creds.pin && await isReservedPin(creds.pin, ctx.env)) throw badRequest(PIN_TAKEN);

  // Promoting somebody to administrator retires their PIN, so the short code
  // they have been typing all along stops being a way in.
  let pinHash = creds.isAdmin ? null : existing.pin_hash;
  if (creds.pin) pinHash = await hashPin(creds.pin, await getPepper(ctx.db));

  let passwordHash = existing.password_hash;
  if (creds.password) passwordHash = await storedPassword(creds.password, await getPepper(ctx.db));

  try {
    const row = await ctx.db.prepare(
      `UPDATE users SET name = ?, role = ?, permissions = ?, active = ?, note = ?,
                        pin_hash = ?, email = ?, password_hash = ?
       WHERE id = ? RETURNING *`,
    ).bind(
      name, role, permissions, active ? 1 : 0, note,
      pinHash, creds.email ?? null, passwordHash, userId,
    ).first();

    await audit(ctx, 'user.update', userId, {
      name,
      role,
      active,
      pinChanged: Boolean(creds.pin),
      passwordChanged: Boolean(creds.password),
    });
    return json({ user: publicUser(row) });
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw badRequest(creds.isAdmin
        ? 'That email address is already in use by another account.'
        : PIN_TAKEN);
    }
    throw err;
  }
}

export async function deleteUser(ctx, id) {
  const userId = Number(id);
  const existing = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!existing) throw notFound('User not found');

  if (existing.role === 'admin') {
    const others = await ctx.db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
    ).bind(userId).first();
    if (!others?.n) throw badRequest('You cannot remove the only administrator.');
  }

  // A login and a member of staff are different things. Removing the login of
  // somebody whose attendance is recorded must not take their attendance with
  // it, so the link is cut and the staff record stands on its own.
  await ctx.db.batch([
    ctx.db.prepare('UPDATE att_staff SET user_id = NULL WHERE user_id = ?').bind(userId),
    ctx.db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);

  await audit(ctx, 'user.delete', userId, { name: existing.name });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function getNotifications(ctx) {
  const rows = await ctx.db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));

  const [recent, devices, pushLog] = await Promise.all([
    ctx.db.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 20').all()
      .catch(() => ({ results: [] })),
    ctx.db.prepare(
      `SELECT p.id, p.label, p.created_at, u.name
         FROM push_subscriptions p
         LEFT JOIN users u ON u.id = p.user_id
        ORDER BY p.created_at DESC`,
    ).all().catch(() => ({ results: [] })),
    ctx.db.prepare('SELECT * FROM push_log ORDER BY at DESC LIMIT 10').all()
      .catch(() => ({ results: [] })),
  ]);

  return json({
    // One digest a morning, and only when there is something to do about it.
    emailEnabled: settings.att_email_enabled === '1',
    pushEnabled: settings.push_on_exception !== '0',
    inAppEnabled: settings.notices_enabled !== '0',
    // Every notice by mail as well as by bell, to whoever the notice names.
    noticeEmail: settings.notice_email !== '0',
    recipients: parseRecipients(settings.att_email_to),
    from: settings.email_from || '',
    // Where a reply goes. Staff do reply to these, and a reply that vanishes
    // into an unread mailbox teaches them the mail is not worth reading.
    replyTo: settings.email_reply_to || '',
    // Shown as the origin it will actually be used as, not as whatever is
    // stored. A path left in this box is neutralised everywhere it is read,
    // but a box that keeps displaying it invites somebody to conclude the
    // setting is fine and go looking for the fault somewhere else.
    siteUrl: originOf(settings.site_url) || '',
    // The key itself is never returned — only whether one is present.
    providerConfigured: Boolean(ctx.env.RESEND_API_KEY),
    devices: devices.results ?? [],
    pushLog: pushLog.results ?? [],
    log: recent.results ?? [],
  });
}

export async function updateNotifications(ctx) {
  const body = await readJson(ctx.request);

  const list = Array.isArray(body.recipients)
    ? body.recipients.map((r) => String(r).trim()).filter(Boolean)
    : parseRecipients(body.recipients);
  const bad = list.filter((r) => !isEmail(r));
  if (bad.length) throw badRequest(`Not a valid email address: ${bad[0]}`);
  if (list.length > 25) throw badRequest('That is a lot of recipients — 25 is the limit');

  const from = str(body.from, 'From address', { max: 200, fallback: '' }) || '';
  if (from && !isEmail(from.replace(/^.*<([^>]+)>.*$/, '$1'))) {
    throw badRequest('The "from" address does not look like an email address');
  }

  const replyTo = str(body.replyTo, 'Reply-to address', { max: 200, fallback: '' }) || '';
  if (replyTo && !isEmail(replyTo.replace(/^.*<([^>]+)>.*$/, '$1'))) {
    throw badRequest('The "reply to" address does not look like an email address');
  }

  const siteUrl = str(body.siteUrl, 'Site address', { max: 300, fallback: '' }) || '';
  if (siteUrl && !/^https?:\/\//i.test(siteUrl)) {
    throw badRequest('The site address should start with https://');
  }

  // This screen is several cards writing to one endpoint. A switch the sender
  // did not mention keeps whatever it already had — otherwise saving the email
  // card would quietly turn phone alerts back on for somebody who switched them
  // off.
  const current = await ctx.db.prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries((current.results ?? []).map((r) => [r.key, r.value]));

  const emailEnabled = bool(body.emailEnabled, stored.att_email_enabled === '1') ? '1' : '0';
  const pushEnabled = bool(body.pushEnabled, stored.push_on_exception !== '0') ? '1' : '0';
  const inApp = bool(body.inAppEnabled, stored.notices_enabled !== '0') ? '1' : '0';
  const noticeEmail = bool(body.noticeEmail, stored.notice_email !== '0') ? '1' : '0';

  await ctx.db.batch([
    setting(ctx.db, 'att_email_enabled', emailEnabled),
    setting(ctx.db, 'att_email_to', JSON.stringify(list)),
    setting(ctx.db, 'email_from', from),
    setting(ctx.db, 'email_reply_to', replyTo),
    // Stored as an origin, not as whatever was in the address bar when
    // somebody filled the box in. A path left on the end here reappears in the
    // middle of every link the property sends out, and the person holding the
    // link is the one who finds out.
    setting(ctx.db, 'site_url', originOf(siteUrl)),
    setting(ctx.db, 'push_on_exception', pushEnabled),
    setting(ctx.db, 'notices_enabled', inApp),
    setting(ctx.db, 'notice_email', noticeEmail),
  ]);

  await audit(ctx, 'notifications.update', null, {
    emailEnabled, pushEnabled, recipients: list.length,
  });
  return getNotifications(ctx);
}

/** Send yesterday's digest now, so an administrator can prove it works. */
export async function testNotification(ctx) {
  const latest = await ctx.db.prepare(
    'SELECT day FROM att_days ORDER BY day DESC LIMIT 1',
  ).first();
  if (!latest) throw badRequest('There is no attendance recorded yet to send a summary for.');

  const rows = await ctx.db.prepare(
    `SELECT d.status, d.resolution, d.reason_code, d.first_in,
            d.late_minutes, d.early_minutes, s.name
     FROM att_days d JOIN att_staff s ON s.id = d.staff_id
     WHERE d.day = ? AND s.active = 1`,
  ).bind(latest.day).all();

  const days = rows.results ?? [];
  await emailExceptions(ctx.db, ctx.env, {
    day: latest.day,
    open: days.filter((d) => d.resolution === 'open').length,
    absent: days.filter((d) => d.status === 'absent').length,
    escalated: [],
    rows: days,
  });

  // By id, not by time. `at` is only accurate to the second, so a test pressed
  // in the same second as the row before it reports the wrong one — and the
  // wrong one is usually the older success, which is the single most
  // misleading answer this button could give.
  const result = await ctx.db.prepare(
    'SELECT * FROM email_log ORDER BY id DESC LIMIT 1',
  ).first();
  return json({ ok: result?.status === 'sent', result });
}

// ---------------------------------------------------------------------------
// Erasing data
// ---------------------------------------------------------------------------

const CONFIRM_PHRASE = 'ERASE';

/**
 * What is about to be deleted, so the confirmation is an informed one.
 *
 * Counted from the same columns the delete uses, so it cannot promise one thing
 * and do another.
 */
export async function dataSummary(ctx) {
  const from = ctx.url.searchParams.get('from');
  const to = ctx.url.searchParams.get('to');
  if (from && !isDay(from)) throw badRequest('That start date is not valid.');
  if (to && !isDay(to)) throw badRequest('That end date is not valid.');

  const bounded = from && to;
  const counts = bounded
    ? await ctx.db.prepare(
      `SELECT (SELECT COUNT(*) FROM att_punches WHERE day BETWEEN ?1 AND ?2) AS punches,
              (SELECT COUNT(*) FROM att_days   WHERE day BETWEEN ?1 AND ?2) AS days,
              (SELECT COUNT(*) FROM att_leave  WHERE from_day <= ?2 AND to_day >= ?1) AS leave`,
    ).bind(from, to).first()
    : await ctx.db.prepare(
      `SELECT (SELECT COUNT(*) FROM att_punches) AS punches,
              (SELECT COUNT(*) FROM att_days) AS days,
              (SELECT COUNT(*) FROM att_leave) AS leave`,
    ).first();

  const kept = await ctx.db.prepare(
    `SELECT (SELECT COUNT(*) FROM att_staff) AS staff,
            (SELECT COUNT(*) FROM att_shifts) AS shifts,
            (SELECT COUNT(*) FROM att_holidays) AS holidays,
            (SELECT COUNT(*) FROM att_devices) AS devices,
            (SELECT COUNT(*) FROM users) AS users`,
  ).first();

  return json({
    from: from ?? null,
    to: to ?? null,
    willDelete: {
      punches: Number(counts?.punches ?? 0),
      days: Number(counts?.days ?? 0),
      leave: Number(counts?.leave ?? 0),
    },
    willKeep: {
      staff: Number(kept?.staff ?? 0),
      shifts: Number(kept?.shifts ?? 0),
      holidays: Number(kept?.holidays ?? 0),
      devices: Number(kept?.devices ?? 0),
      users: Number(kept?.users ?? 0),
    },
    confirmPhrase: CONFIRM_PHRASE,
  });
}

/**
 * Delete recorded attendance, and only that.
 *
 * People, shifts, absence reasons, public holidays, terminals and logins are
 * never touched. Erasing is for clearing a trial run before going live, or for
 * a period that should never have been imported — not for starting the whole
 * property again, which is what deleting the roster would mean.
 */
export async function eraseData(ctx) {
  const body = await readJson(ctx.request);
  if (String(body.confirm ?? '').trim() !== CONFIRM_PHRASE) {
    throw badRequest(`Type ${CONFIRM_PHRASE} to confirm.`);
  }

  const from = body.from ? String(body.from) : null;
  const to = body.to ? String(body.to) : null;
  if (from && !isDay(from)) throw badRequest('That start date is not valid.');
  if (to && !isDay(to)) throw badRequest('That end date is not valid.');
  if (from && to && from > to) throw badRequest('The start date is after the end date.');

  const statements = from && to
    ? [
      ctx.db.prepare('DELETE FROM att_punches WHERE day BETWEEN ?1 AND ?2').bind(from, to),
      ctx.db.prepare('DELETE FROM att_days WHERE day BETWEEN ?1 AND ?2').bind(from, to),
      ctx.db.prepare('DELETE FROM att_leave WHERE from_day <= ?2 AND to_day >= ?1').bind(from, to),
      ctx.db.prepare('DELETE FROM att_roster WHERE day BETWEEN ?1 AND ?2').bind(from, to),
    ]
    : [
      ctx.db.prepare('DELETE FROM att_punches'),
      ctx.db.prepare('DELETE FROM att_days'),
      ctx.db.prepare('DELETE FROM att_leave'),
      ctx.db.prepare('DELETE FROM att_roster'),
    ];

  await ctx.db.batch(statements);
  await audit(ctx, 'data.erase', null, { from, to });

  return json({ ok: true, from, to });
}

// ---------------------------------------------------------------------------
// The trail, and the bell
// ---------------------------------------------------------------------------

export async function auditTrail(ctx) {
  const limit = Math.min(Number(ctx.url.searchParams.get('limit') ?? 100) || 100, 500);
  const rows = await ctx.db.prepare(
    'SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?',
  ).bind(limit).all();
  return json({ entries: rows.results ?? [] });
}

export async function listNoticesRoute(ctx) {
  const limit = Math.min(Number(ctx.url.searchParams.get('limit') ?? 20) || 20, 100);
  return json(await listNotices(ctx.db, ctx.session.user.id, limit, ctx.session.permissions));
}

export async function markNoticesSeen(ctx) {
  const body = await readJson(ctx.request);
  await markSeen(ctx.db, ctx.session.user.id, body.lastId);
  return json({ ok: true });
}
