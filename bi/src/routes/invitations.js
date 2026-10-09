import { all, first, run } from '../lib/db.js';
import { badRequest, HttpError, notFound, str } from '../lib/http.js';
import { createToken, normaliseEmail, sessionCookie } from '../lib/auth.js';
import { callLink } from '../lib/link.js';
import * as accounts from './accounts.js';

/**
 * Inviting somebody, so they choose their own password.
 *
 * The owner decides who the person is and what they may reach; the account is
 * made there and then, with no password, so the grid shows them at once. The
 * person gets a link that works once and lasts a week. Opening it lets them set
 * a password and signs them in.
 *
 * A link can end four ways — used, withdrawn, replaced by a newer one, or
 * expired — and the page it opens says which, because "this link is invalid"
 * leaves somebody with no idea what to do next. An expired or replaced link
 * offers to ask the owner for a fresh one, and the owner sees that request on
 * the Accounts screen and can resend in one tap. Resending always makes a new
 * link and kills the old one: a link that has been forwarded around should
 * not keep working because the owner sent another.
 *
 * The email goes out through HIVE, which already holds the provider key and
 * the address staff recognise. If HIVE cannot send, the invitation still
 * exists and the owner gets the link to pass on themselves.
 */

const DAYS_VALID = 7;
const LEVELS = {
  owner: { label: 'Owner', note: 'Everything, in every system, and managing who can sign in.' },
  admin: { label: 'Admin', note: 'Every report, and all of Shifts.' },
  supervisor: { label: 'Supervisor', note: 'Shifts, with the parts chosen for supervisors.' },
  uploader: { label: 'Uploads only', note: 'Loading the ASSD journal, the bank statement and the card terminal report. Nothing else.' },
  none: { label: 'No reports', note: 'The hub: a way into the other systems below.' },
};

const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const plusDays = (days) => new Date(Date.now() + days * 864e5).toISOString().replace('T', ' ').slice(0, 19);
const asDate = (sql) => (sql ? new Date(`${String(sql).replace(' ', 'T')}Z`) : null);

const encoder = new TextEncoder();
async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** "Thursday 15 October", as somebody in Accra would read it. */
export function longDay(sql) {
  const date = asDate(sql);
  return date ? date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : '';
}

/** Where a link stands. Order matters: a used link that has since expired is still used. */
export function stateOf(row, now = new Date()) {
  if (!row) return 'unknown';
  if (row.used_at) return 'used';
  if (row.withdrawn_at) return 'withdrawn';
  if (row.replaced_at) return 'replaced';
  if (asDate(row.expires_at) <= now) return 'expired';
  return 'open';
}

/** What the owner sees on a row: the newest link for a person, in a word. */
export function statusOf(row, now = new Date()) {
  const state = stateOf(row, now);
  if (state === 'used') return 'joined';
  if (state === 'withdrawn') return 'withdrawn';
  if (row.asked_at) return 'asked';
  if (state === 'expired') return 'expired';
  if (row.opened_at) return 'opened';
  return 'sent';
}

function levelOf(account, access) {
  if (account.is_owner === 1) return 'owner';
  const insight = access.find((a) => a.system_id === 'insight');
  if (!insight) return 'none';
  return ['supervisor', 'uploader'].includes(insight.role) ? insight.role : 'admin';
}

// ---------------------------------------------------------------- owner --

/** Every person's newest invitation, with enough history to say what happened. */
export async function list(env) {
  const rows = await all(env.DB, `
    SELECT i.*, a.name, a.email, a.is_owner, a.active, a.password_hash,
           (SELECT COUNT(*) FROM invitations x WHERE x.account_id = i.account_id) AS sends
      FROM invitations i JOIN accounts a ON a.id = i.account_id
     WHERE i.id = (SELECT MAX(id) FROM invitations y WHERE y.account_id = i.account_id)
     ORDER BY i.id DESC`);
  const access = await all(env.DB, 'SELECT * FROM account_access');
  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    email: row.email,
    level: LEVELS[levelOf(row, access.filter((a) => a.account_id === row.account_id))].label,
    status: statusOf(row, now),
    sends: Number(row.sends) || 1,
    via: row.sent_via,
    emailError: row.email_error || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    openedAt: row.opened_at,
    usedAt: row.used_at,
    askedAt: row.asked_at,
    withdrawnAt: row.withdrawn_at,
    by: row.invited_by_name || null,
  }));
}

/**
 * Invite somebody new, or somebody already on the grid who has never set a
 * password. Somebody who has one is refused: they can already sign in, and
 * what they reach is changed on the grid.
 */
export async function invite(env, body, actor, { origin, fetchImpl } = {}) {
  const email = normaliseEmail(str(body?.email, 'Email address', { required: true, max: 200 }));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('That is not an email address');
  const name = str(body?.name, 'Name', { required: true, max: 120 });
  const level = Object.hasOwn(LEVELS, body?.level) ? body.level : null;
  if (!level) throw badRequest('Choose an access level.');
  const note = str(body?.note, 'Note', { max: 400 }) || null;
  const how = body?.how === 'link' ? 'link' : 'email';

  const existing = await first(env.DB, 'SELECT * FROM accounts WHERE email = ?1', email);
  if (existing?.password_hash) {
    throw badRequest(`${existing.name} already has an account. Change what they can reach on the grid instead.`);
  }

  let accountId;
  if (existing) {
    accountId = existing.id;
    await run(env.DB, 'UPDATE accounts SET name = ?2, is_owner = ?3, active = 1 WHERE id = ?1',
      accountId, name, level === 'owner' ? 1 : 0);
  } else {
    await run(env.DB, 'INSERT INTO accounts (email, name, is_owner, active) VALUES (?1, ?2, ?3, 1)',
      email, name, level === 'owner' ? 1 : 0);
    accountId = (await first(env.DB, 'SELECT id FROM accounts WHERE email = ?1', email)).id;
  }

  // What they may reach, the same rows the grid writes.
  const known = new Set((await all(env.DB, "SELECT id FROM systems WHERE id <> 'insight'")).map((s) => s.id));
  const grants = (Array.isArray(body?.systems) ? body.systems : [])
    .filter((id) => known.has(id)).map((systemId) => ({ systemId, role: '' }));
  if (level === 'admin') grants.push({ systemId: 'insight', role: '' });
  if (level === 'supervisor') grants.push({ systemId: 'insight', role: 'supervisor' });
  if (level === 'uploader') grants.push({ systemId: 'insight', role: 'uploader' });
  if (level !== 'owner') await accounts.setAccess(env, accountId, { access: grants }, actor);

  return issue(env, accountId, { note, how, actor, origin, fetchImpl });
}

/** Send again: a fresh link, and the old one stops working. Also how a withdrawn one is revived. */
export async function resend(env, id, body, actor, opts = {}) {
  const row = await first(env.DB, 'SELECT * FROM invitations WHERE id = ?1', Number(id));
  if (!row) throw notFound('No such invitation');
  const account = await first(env.DB, 'SELECT * FROM accounts WHERE id = ?1', row.account_id);
  if (!account) throw notFound('That person is no longer on the list');
  if (account.password_hash) throw badRequest(`${account.name} has already joined.`);
  await run(env.DB, 'UPDATE accounts SET active = 1 WHERE id = ?1', account.id);
  return issue(env, account.id, { note: row.note, how: body?.how === 'link' ? 'link' : 'email', actor, ...opts });
}

/** Stop a link working. The account stays on the grid, switched off, so they can be invited again. */
export async function withdraw(env, id) {
  const row = await first(env.DB, 'SELECT * FROM invitations WHERE id = ?1', Number(id));
  if (!row) throw notFound('No such invitation');
  if (row.used_at) throw badRequest('They have already joined. Switch their account off on the grid instead.');
  await run(env.DB, `UPDATE invitations SET withdrawn_at = ?2
     WHERE account_id = ?1 AND used_at IS NULL AND withdrawn_at IS NULL AND replaced_at IS NULL`,
  row.account_id, nowIso());
  await run(env.DB, 'UPDATE accounts SET active = 0 WHERE id = ?1 AND password_hash IS NULL', row.account_id);
  return { invitations: await list(env) };
}

async function issue(env, accountId, { note, how, actor, origin, fetchImpl }) {
  const account = await first(env.DB, 'SELECT * FROM accounts WHERE id = ?1', accountId);
  const at = nowIso();
  // Every link still open for this person stops now.
  await run(env.DB, `UPDATE invitations SET replaced_at = ?2
     WHERE account_id = ?1 AND used_at IS NULL AND withdrawn_at IS NULL AND replaced_at IS NULL`, accountId, at);

  const token = newToken();
  const expires = plusDays(DAYS_VALID);
  await run(env.DB, `INSERT INTO invitations
      (account_id, token_hash, note, invited_by_id, invited_by_name, invited_by_email, sent_via, created_at, expires_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  accountId, await sha256(token), note, actor?.id ?? null, actor?.name || null, actor?.email || null, how, at, expires);
  const inviteId = (await first(env.DB, 'SELECT MAX(id) AS id FROM invitations WHERE account_id = ?1', accountId)).id;

  const base = String(origin || env.SITE_URL || '').replace(/\/$/, '');
  const link = `${base}/#join=${token}`;

  let emailed = false;
  let emailError = null;
  if (how === 'email') {
    try {
      const access = await all(env.DB, 'SELECT * FROM account_access WHERE account_id = ?1', accountId);
      const systems = await all(env.DB, 'SELECT * FROM systems ORDER BY sort_order');
      const mail = invitationEmail({
        name: account.name,
        inviter: actor?.name || 'The owner',
        note,
        level: levelOf(account, access),
        others: account.is_owner === 1
          ? systems.filter((s) => s.id !== 'insight').map((s) => s.label)
          : systems.filter((s) => s.id !== 'insight' && access.some((a) => a.system_id === s.id)).map((s) => s.label),
        link,
        expires: longDay(expires),
        iconUrl: base ? `${base}/icon-180.png` : null,
      });
      await mailVia(env, { to: account.email, ...mail, kind: 'insight_invite', replyTo: actor?.email, fetchImpl });
      emailed = true;
    } catch (err) {
      emailError = err.message;
      await run(env.DB, 'UPDATE invitations SET email_error = ?2 WHERE id = ?1', inviteId, emailError.slice(0, 300));
    }
  }

  return {
    // The link goes back to the owner only when they asked for it, or when the
    // email could not go and they need something to pass on.
    link: how === 'link' || !emailed ? link : null,
    emailed,
    emailError,
    to: account.email,
    expires: longDay(expires),
    invitations: await list(env),
  };
}

/** One email, through HIVE. */
async function mailVia(env, { to, subject, html, text, kind, replyTo, fetchImpl }) {
  try {
    return await callLink({
      binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/mail',
      body: { to, subject, html, text, kind, replyTo, senderName: 'Insight' },
    });
  } catch (err) {
    throw new HttpError(err.status && err.status < 600 ? err.status : 502, err.message);
  }
}

// ---------------------------------------------------------------- the person --

async function byToken(env, token) {
  const text = String(token ?? '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(text)) return null;
  return first(env.DB, `
    SELECT i.*, a.name, a.email, a.is_owner, a.active, a.password_hash
      FROM invitations i JOIN accounts a ON a.id = i.account_id
     WHERE i.token_hash = ?1`, await sha256(text));
}

/** What the link's page needs to say, and the first time it is opened, noted. */
export async function look(env, body) {
  const row = await byToken(env, body?.token);
  const state = stateOf(row);
  if (!row) return { state };
  if (state === 'open' && !row.opened_at) {
    await run(env.DB, 'UPDATE invitations SET opened_at = ?2 WHERE id = ?1', row.id, nowIso());
  }
  const access = await all(env.DB, 'SELECT * FROM account_access WHERE account_id = ?1', row.account_id);
  const systems = await all(env.DB, 'SELECT * FROM systems ORDER BY sort_order');
  const level = levelOf(row, access);
  const newest = await first(env.DB, 'SELECT * FROM invitations WHERE account_id = ?1 ORDER BY id DESC LIMIT 1', row.account_id);
  return {
    state,
    name: row.name,
    email: row.email,
    inviter: row.invited_by_name || 'The owner',
    level: LEVELS[level].label,
    levelNote: LEVELS[level].note,
    others: systems.filter((s) => s.id !== 'insight' && (row.is_owner === 1 || access.some((a) => a.system_id === s.id))).map((s) => s.label),
    sentOn: longDay(row.created_at),
    expires: longDay(row.expires_at),
    // Whether asking for a new one makes sense, and whether it has been done.
    canAsk: (state === 'expired' || state === 'replaced') && !row.password_hash && row.active === 1,
    asked: Boolean(newest?.asked_at),
  };
}

/** Set a password from a working link, and be signed in. */
export async function accept(env, body, { fetchImpl } = {}) {
  const row = await byToken(env, body?.token);
  const state = stateOf(row);
  if (state !== 'open') {
    throw new HttpError(410, {
      used: 'This invitation has already been used. Sign in instead.',
      withdrawn: 'This invitation was withdrawn.',
      replaced: 'A newer invitation was sent. Use the most recent email.',
      expired: 'This invitation has expired.',
    }[state] || 'That link does not work.');
  }
  if (!row.active) throw new HttpError(410, 'This invitation was withdrawn.');
  if (!env.SESSION_SECRET) throw new HttpError(503, 'SESSION_SECRET has not been set on this Worker');

  const name = str(body?.name, 'Your name', { max: 120 }) || row.name;
  await accounts.setPassword(env, row.account_id, body);
  const at = nowIso();
  await run(env.DB, "UPDATE accounts SET name = ?2, last_login_at = datetime('now') WHERE id = ?1", row.account_id, name);
  await run(env.DB, 'UPDATE invitations SET used_at = ?2 WHERE id = ?1', row.id, at);

  await tellInviter(env, row, {
    subject: `${name} has joined Insight`,
    lines: [`${name} (${row.email}) set their password and signed in.`],
    fetchImpl,
  });

  const token = await createToken(env.SESSION_SECRET, { accountId: row.account_id });
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(token) },
  });
}

/** Ask for a fresh link from one that no longer works. Once per invitation is enough. */
export async function ask(env, body, { origin, fetchImpl } = {}) {
  const row = await byToken(env, body?.token);
  const state = stateOf(row);
  if (!row || !['expired', 'replaced'].includes(state) || row.password_hash || !row.active) {
    throw badRequest('There is nothing to ask for on this link.');
  }
  const newest = await first(env.DB, 'SELECT * FROM invitations WHERE account_id = ?1 ORDER BY id DESC LIMIT 1', row.account_id);
  if (newest.asked_at) return { ok: true, already: true };
  await run(env.DB, 'UPDATE invitations SET asked_at = ?2 WHERE id = ?1', newest.id, nowIso());

  const base = String(origin || env.SITE_URL || '').replace(/\/$/, '');
  await tellInviter(env, newest, {
    subject: `${row.name} asked for a new Insight link`,
    lines: [
      `${row.name} (${row.email}) opened an invitation that no longer works and asked for a fresh one.`,
      'Open Accounts and press Resend on their row.',
    ],
    link: base ? `${base}/#/accounts` : null,
    fetchImpl,
  });
  return { ok: true };
}

/** Tell whoever sent it, or every owner if it came from the shared password. Never fails the caller. */
async function tellInviter(env, row, { subject, lines, link = null, fetchImpl }) {
  let to = row.invited_by_email ? [row.invited_by_email] : [];
  if (!to.length) {
    to = (await all(env.DB, 'SELECT email FROM accounts WHERE is_owner = 1 AND active = 1')).map((r) => r.email);
  }
  const html = notice(lines, link);
  for (const one of to.slice(0, 10)) {
    // eslint-disable-next-line no-await-in-loop
    await mailVia(env, { to: one, subject, html, kind: 'insight_invite', fetchImpl }).catch(() => {});
  }
}

// ----------------------------------------------------------------- email --

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ESCAPE[c]);
const FONT = "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

function header(iconUrl) {
  return `<tr><td style="padding:22px 28px;border-bottom:1px solid #ecebe6">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      ${iconUrl ? `<td style="padding-right:12px"><img src="${esc(iconUrl)}" width="36" height="36" alt="" style="display:block;border-radius:8px"></td>` : ''}
      <td style="${FONT};color:#111110"><strong style="font-size:17px">Insight</strong><br><span style="font-size:12px;color:#6b6a64">Nice Operation</span></td>
    </tr></table></td></tr>`;
}

function frame(inner, iconUrl) {
  return `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#e9e8e2">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;border:1px solid #e1e0da">
    ${header(iconUrl)}
    <tr><td style="padding:26px 28px;${FONT};font-size:15px;line-height:1.5;color:#2f2e2b">${inner}</td></tr>
  </table></td></tr></table></body></html>`;
}

/** The invitation itself. */
export function invitationEmail({ name, inviter, note, level, others, link, expires, iconUrl }) {
  const first = String(name).split(/\s+/)[0] || name;
  const what = LEVELS[level] || LEVELS.none;
  const html = frame(`
    <h1 style="margin:0 0 14px;font-size:23px;line-height:1.25;color:#111110">${esc(first)}, ${esc(inviter)} has invited you to Insight</h1>
    <p style="margin:0 0 16px">Insight puts the front desk, the restaurant, the laundry, breakfast and the accounts on one page. You'll sign in with your own password, which you choose in the next step.</p>
    ${note ? `<div style="border-left:3px solid #2a78d6;background:#f3f7fd;padding:12px 16px;margin:0 0 16px;border-radius:0 10px 10px 0">
      <span style="display:block;font-size:12px;color:#4e4d49;font-weight:600">${esc(inviter)} wrote</span>${esc(note)}</div>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e0da;border-radius:12px;margin:0 0 20px">
      <tr><td style="padding:12px 16px 4px;font-size:12px;color:#4e4d49;font-weight:600;text-transform:uppercase;letter-spacing:.04em">What you'll have</td></tr>
      <tr><td style="padding:4px 16px"><span style="color:#4e4d49">In Insight:</span> <strong>${esc(what.label)}</strong>. ${esc(what.note)}</td></tr>
      ${others.length ? `<tr><td style="padding:4px 16px 12px"><span style="color:#4e4d49">From the hub:</span> <strong>${esc(others.join(', '))}</strong></td></tr>` : '<tr><td style="padding:0 0 8px"></td></tr>'}
    </table>
    <a href="${esc(link)}" style="display:inline-block;background:#2a78d6;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;padding:14px 24px">Set up your account</a>
    <p style="margin:10px 0 18px;font-size:13px;color:#4e4d49">The button works once and expires on <strong>${esc(expires)}</strong>.</p>
    <p style="margin:0 0 18px;font-size:13px;color:#6b6a64">If the button doesn't work, copy this into your browser:<br><span style="color:#1f62b5;word-break:break-all">${esc(link)}</span></p>
    <p style="margin:0;padding-top:14px;border-top:1px solid #ecebe6;font-size:13px;color:#6b6a64">Weren't expecting this? You can ignore it; nobody gets an account unless they finish setting it up. If the link has expired, open it anyway and you can ask ${esc(inviter)} for a new one.</p>`, iconUrl);
  const text = [
    `${first}, ${inviter} has invited you to Insight.`,
    note ? `\n${inviter} wrote: ${note}` : '',
    `\nIn Insight: ${what.label}. ${what.note}`,
    others.length ? `From the hub: ${others.join(', ')}` : '',
    `\nSet up your account: ${link}`,
    `The link works once and expires on ${expires}.`,
  ].filter(Boolean).join('\n');
  return { subject: `${inviter} has invited you to Insight`, html, text };
}

function notice(lines, link) {
  return frame(`${lines.map((l) => `<p style="margin:0 0 12px">${esc(l)}</p>`).join('')}
    ${link ? `<a href="${esc(link)}" style="display:inline-block;background:#2a78d6;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;padding:12px 20px">Open Accounts</a>` : ''}`, null);
}
