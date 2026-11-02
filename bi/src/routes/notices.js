import { all, first, run } from '../lib/db.js';
import { badRequest, forbidden } from '../lib/http.js';
import { pushTo } from '../lib/notices.js';
import { vapidKeys } from '../lib/webpush.js';

/**
 * A person's notifications, as an inbox: everything Insight told them, newest
 * (or newest reminded) first, with All, Unread, Urgent and Read; each opened,
 * marked read or unread; all marked read at once. And the phones and
 * computers they turned notifications on for.
 *
 * Only their own: an account sees its own notifications, nobody else's. The
 * owner signed in with the bootstrap key has no account, and no inbox.
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const FILTERS = {
  all: '1 = 1',
  unread: 'read_at IS NULL',
  urgent: 'urgent = 1 AND done_at IS NULL',
  read: 'read_at IS NOT NULL',
};

function mine(account) {
  const id = Number(account?.id);
  if (!Number.isInteger(id) || id <= 0) throw forbidden('Notifications are for somebody signed in with their own account.');
  return id;
}

const view = (n) => ({
  id: n.id, kind: n.kind, title: n.title, body: n.body || null, link: n.link || null, urgent: Boolean(n.urgent),
  at: n.at, lastAt: n.last_at, times: Number(n.times) || 1, read: Boolean(n.read_at), done: Boolean(n.done_at),
});

/** How many: unread, and urgent and not finished, for the bell and the tabs. */
export async function counts(env, account) {
  const id = Number(account?.id);
  if (!Number.isInteger(id) || id <= 0) return { unread: 0, urgent: 0, all: 0, read: 0 };
  const row = await first(env.DB, `SELECT COUNT(*) AS n, SUM(read_at IS NULL) AS unread, SUM(urgent = 1 AND done_at IS NULL) AS urgent,
    SUM(read_at IS NOT NULL) AS rd FROM notice WHERE account_id = ?1`, id).catch(() => null);
  return { all: Number(row?.n) || 0, unread: Number(row?.unread) || 0, urgent: Number(row?.urgent) || 0, read: Number(row?.rd) || 0 };
}

/** The inbox: one filter, newest first, a page at a time. */
export async function list(env, account, query = {}) {
  const id = mine(account);
  const filter = FILTERS[query.filter] ? query.filter : 'all';
  const before = Number(query.before) || null;
  const rows = await all(env.DB, `SELECT * FROM notice WHERE account_id = ?1 AND ${FILTERS[filter]} ${before ? 'AND id < ?2' : ''}
    ORDER BY last_at DESC, id DESC LIMIT 60`, id, ...(before ? [before] : []));
  const subs = await all(env.DB, 'SELECT id, device, at, last_ok, last_error FROM push_sub WHERE account_id = ?1 ORDER BY at', id).catch(() => []);
  return {
    filter, items: rows.map(view), counts: await counts(env, account),
    devices: subs.map((s) => ({ id: s.id, device: s.device || 'A browser', at: s.at, lastOk: s.last_ok, lastError: s.last_error })),
  };
}

/** Some read, or unread again. `all` with read: true marks everything read. */
export async function mark(env, body, account) {
  const id = mine(account);
  const read = body?.read !== false;
  if (body?.all) {
    if (!read) throw badRequest('Only all read at once.');
    await run(env.DB, 'UPDATE notice SET read_at = ?2 WHERE account_id = ?1 AND read_at IS NULL', id, now());
    return { ok: true, counts: await counts(env, account) };
  }
  const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : [body?.id]).map(Number).filter(Number.isInteger))].slice(0, 200);
  if (!ids.length) throw badRequest('Which notifications?');
  for (const n of ids) {
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, `UPDATE notice SET read_at = ${read ? '?3' : 'NULL'} WHERE id = ?1 AND account_id = ?2`, n, id, ...(read ? [now()] : []));
  }
  return { ok: true, counts: await counts(env, account) };
}

// ------------------------------------------------------------ push --

/** The key a browser needs to ask for notifications from Insight. */
export async function pushKey(env) {
  return { publicKey: (await vapidKeys(env.DB)).publicKey };
}

/** This browser, for this person: notifications on. The same browser again is updated, not added. */
export async function subscribe(env, body, account) {
  const id = mine(account);
  const sub = body?.subscription || body;
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw badRequest('That browser did not give what notifications need.');
  const device = String(body?.device || '').slice(0, 120) || null;
  await run(env.DB, `INSERT INTO push_sub (account_id, endpoint, p256dh, auth, device, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (endpoint) DO UPDATE SET account_id = ?1, p256dh = ?3, auth = ?4, device = COALESCE(?5, device), last_error = NULL`,
  id, endpoint, p256dh, auth, device, now());
  return { ok: true };
}

/** Notifications off: this browser, or one of theirs by its id. */
export async function unsubscribe(env, body, account) {
  const id = mine(account);
  if (body?.endpoint) await run(env.DB, 'DELETE FROM push_sub WHERE endpoint = ?1 AND account_id = ?2', String(body.endpoint), id);
  else if (body?.id) await run(env.DB, 'DELETE FROM push_sub WHERE id = ?1 AND account_id = ?2', Number(body.id), id);
  else throw badRequest('Which browser?');
  return { ok: true };
}

/** A test, to every browser of theirs: so they know it works before something real is sent. */
export async function test(env, account, { fetchImpl } = {}) {
  const id = mine(account);
  const sent = await pushTo(env, id, { title: 'Insight', body: 'Notifications work on this device.', url: '/#/notifications', tag: 'test' }, { fetchImpl });
  return { ok: true, sent };
}
