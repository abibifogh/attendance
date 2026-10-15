import { all, first, run, getSettings, setSetting } from '../lib/db.js';
import { badRequest } from '../lib/http.js';
import { openActivities, doneActivities, odooUsers } from '../connectors/odoo.js';
import { odooSource } from './safebook.js';
import { roleOf, accessOf, requireAdmin } from './till.js';

/**
 * Odoo activities, read and never written: what waits for whom in Odoo,
 * in the Inbox, beside a shift's POs, per person, and in each person's own
 * Inbox once an admin has said who they are in Odoo.
 *
 * Odoo is asked at most every ten minutes, or when somebody presses Refresh
 * now; in between, the last read is shown. The open ones are kept, and one no
 * longer open is marked gone, so a done activity still has its due date.
 */

const FRESH_MINUTES = 10;
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => new Date().toISOString().slice(0, 10);
const who = (account) => account?.name || account?.email || 'Owner';

/** Ask Odoo again, unless the last read is recent enough. Returns an error message, or null. */
export async function refresh(env, { force = false, fetchImpl } = {}) {
  const source = await odooSource(env);
  if (!source) return 'Odoo is not set up yet.';
  const settings = await getSettings(env.DB).catch(() => ({}));
  const last = settings.odoo_activity_at ? Date.parse(`${settings.odoo_activity_at.replace(' ', 'T')}Z`) : 0;
  if (!force && Date.now() - last < FRESH_MINUTES * 60 * 1000) return null;
  const opts = { ...source, ...(fetchImpl ? { fetchImpl } : {}) };
  const at = now();
  // Each read has its own name, so one no longer open is known even when two reads share a second.
  const readId = `${at}#${Math.random().toString(36).slice(2, 10)}`;
  try {
    const month = `${today().slice(0, 7)}-01`;
    const [open, done, users] = await Promise.all([openActivities(opts), doneActivities({ ...opts, since: month }), odooUsers(opts)]);
    const stmts = [];
    for (const a of open) {
      stmts.push(env.DB.prepare(`INSERT INTO odoo_activity (id, model, res_id, res_name, type, summary, note, deadline, user_id, user_name, partner, amount, seen_at, read_id, gone_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL)
        ON CONFLICT (id) DO UPDATE SET model = ?2, res_id = ?3, res_name = ?4, type = ?5, summary = ?6, note = ?7, deadline = ?8,
          user_id = ?9, user_name = ?10, partner = ?11, amount = ?12, seen_at = ?13, read_id = ?14, gone_at = NULL`)
        .bind(a.id, a.model, a.resId, a.resName, a.type, a.summary, a.note, a.deadline, a.userId, a.userName, a.partner, a.amount, at, readId));
    }
    // Open before and not now: done, or deleted.
    stmts.push(env.DB.prepare('UPDATE odoo_activity SET gone_at = ?1 WHERE gone_at IS NULL AND COALESCE(read_id, \'\') <> ?2').bind(at, readId));
    const userOf = new Map(users.filter((u) => u.partnerId).map((u) => [u.partnerId, u.id]));
    for (const d of done) {
      stmts.push(env.DB.prepare(`INSERT INTO odoo_activity_done (id, model, res_id, res_name, type, user_id, done_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT (id) DO NOTHING`).bind(d.id, d.model, d.resId, d.resName, d.type, userOf.get(d.partnerId) ?? null, d.doneAt));
    }
    for (const u of users) {
      stmts.push(env.DB.prepare(`INSERT INTO odoo_user (id, name, login, email, partner_id) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT (id) DO UPDATE SET name = ?2, login = ?3, email = ?4, partner_id = ?5`).bind(u.id, u.name, u.login, u.email, u.partnerId));
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50)); // eslint-disable-line no-await-in-loop
    await setSetting(env.DB, 'odoo_activity_at', at);
    return null;
  } catch (err) {
    return `Odoo could not be read just now: ${err.message}`;
  }
}

/** Where an activity is due, against today. */
const stateOf = (deadline, day = today()) => (!deadline ? 'planned' : deadline < day ? 'overdue' : deadline === day ? 'today' : 'planned');
const daysLate = (deadline, day = today()) => (deadline && deadline < day
  ? Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${deadline}T12:00:00Z`)) / 86400000) : 0);

/**
 * The activities this account may see. An admin: every one, and each
 * person's month. Anybody else: their own (once linked to an Odoo user), and
 * with Odoo shared with them, those on purchase orders, for the shifts' PO
 * tables.
 */
export async function activitiesView(env, query, account, { fetchImpl } = {}) {
  const admin = roleOf(account) === 'admin';
  const access = await accessOf(env, account);
  const link = account?.id != null ? await first(env.DB, 'SELECT * FROM odoo_link WHERE account_id = ?1', account.id).catch(() => null) : null;
  const mine = link ? Number(link.odoo_user_id) : null;
  if (!admin && mine == null && !(access.odoo > 0)) return { configured: true, linked: false, activities: [], people: null };

  const error = await refresh(env, { force: query?.force === '1' || query?.force === true, fetchImpl });
  const source = await odooSource(env);
  if (!source) return { configured: false, linked: mine != null, activities: [], people: null };
  const settings = await getSettings(env.DB).catch(() => ({}));
  const base = String(source.config.base || '').replace(/\/+$/, '');

  const [rows, links] = await Promise.all([
    all(env.DB, 'SELECT * FROM odoo_activity WHERE gone_at IS NULL ORDER BY deadline, id').catch(() => []),
    all(env.DB, 'SELECT l.*, a.name AS account_name FROM odoo_link l LEFT JOIN accounts a ON a.id = l.account_id').catch(() => []),
  ]);
  const accountOf = new Map(links.map((l) => [Number(l.odoo_user_id), l.account_name || l.odoo_name]));
  // The shift a PO was paid from, by its closing report in HIVE.
  const poNames = [...new Set(rows.filter((r) => r.model === 'purchase.order').map((r) => String(r.res_name).toUpperCase()))];
  const shiftOf = new Map();
  if (env.ATT_DB && poNames.length) {
    for (let i = 0; i < poNames.length; i += 90) {
      const chunk = poNames.slice(i, i + 90);
      // eslint-disable-next-line no-await-in-loop
      const found = await all(env.ATT_DB, `SELECT t.po, t.day, t.slot, r.name FROM till_po t LEFT JOIN till_report r ON r.id = t.report_id
        WHERE UPPER(t.po) IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')}) ORDER BY t.id`, ...chunk).catch(() => []);
      for (const f of found) if (!shiftOf.has(String(f.po).toUpperCase())) shiftOf.set(String(f.po).toUpperCase(), { day: f.day, slot: f.slot, name: f.name || null });
    }
  }
  const view = (r) => ({
    id: r.id, model: r.model, resId: r.res_id, resName: r.res_name, type: r.type, summary: r.summary, note: r.note,
    deadline: r.deadline, state: stateOf(r.deadline), late: daysLate(r.deadline),
    userId: r.user_id, userName: r.user_name, account: accountOf.get(Number(r.user_id)) || null, mine: mine != null && Number(r.user_id) === mine,
    partner: r.partner, amount: access.money > 0 || admin ? r.amount : null,
    shift: r.model === 'purchase.order' ? shiftOf.get(String(r.res_name).toUpperCase()) || null : null,
    url: base && r.res_id ? `${base}/web#model=${encodeURIComponent(r.model)}&id=${r.res_id}&view_type=form` : null,
  });
  const visible = rows.filter((r) => admin || (mine != null && Number(r.user_id) === mine) || (access.odoo > 0 && r.model === 'purchase.order'));
  return {
    configured: true,
    linked: mine != null,
    me: mine,
    readAt: settings.odoo_activity_at || null,
    error,
    activities: visible.map(view),
    people: admin ? await peopleOf(env, rows, accountOf) : null,
  };
}

/** Each person's activities: open by when they are due, and this month's done, late or not. */
async function peopleOf(env, open, accountOf) {
  const month = today().slice(0, 7);
  const done = await all(env.DB, `SELECT d.*, (SELECT a.deadline FROM odoo_activity a WHERE a.model = d.model AND a.res_id = d.res_id AND a.type = d.type
      AND a.gone_at IS NOT NULL ORDER BY a.gone_at DESC LIMIT 1) AS deadline
    FROM odoo_activity_done d WHERE d.done_at >= ?1`, `${month}-01`).catch(() => []);
  const users = new Map((await all(env.DB, 'SELECT id, name FROM odoo_user').catch(() => [])).map((u) => [Number(u.id), u.name]));
  const out = new Map();
  const of = (id, name) => {
    const key = Number(id);
    if (!out.has(key)) out.set(key, { userId: key, name: accountOf.get(key) || name || users.get(key) || 'Somebody in Odoo', linked: accountOf.has(key), overdue: 0, today: 0, planned: 0, done: 0, doneLate: 0 });
    return out.get(key);
  };
  for (const r of open) {
    if (r.user_id == null) continue;
    of(r.user_id, r.user_name)[stateOf(r.deadline)] += 1;
  }
  for (const d of done) {
    if (d.user_id == null) continue;
    const p = of(d.user_id, null);
    p.done += 1;
    if (d.deadline && String(d.done_at).slice(0, 10) > d.deadline) p.doneLate += 1;
  }
  return [...out.values()].sort((a, b) => b.overdue - a.overdue || b.today - a.today || a.name.localeCompare(b.name));
}

/** For Accounts: Odoo's people, who is linked to whom, and a suggestion by email for the rest. */
export async function linksView(env, account, { fetchImpl } = {}) {
  await requireAdmin(account);
  const error = await refresh(env, { fetchImpl });
  const users = await all(env.DB, 'SELECT id, name, login, email FROM odoo_user ORDER BY name').catch(() => []);
  const links = await all(env.DB, 'SELECT * FROM odoo_link').catch(() => []);
  const accounts = await all(env.DB, 'SELECT id, name, email FROM accounts').catch(() => []);
  const low = (s) => String(s || '').trim().toLowerCase();
  const suggest = {};
  for (const a of accounts) {
    if (links.some((l) => Number(l.account_id) === Number(a.id)) || !a.email) continue;
    const u = users.find((x) => low(x.email) === low(a.email) || low(x.login) === low(a.email));
    if (u) suggest[a.id] = u.id;
  }
  return {
    error,
    users: users.map((u) => ({ id: Number(u.id), name: u.name, login: u.login })),
    links: Object.fromEntries(links.map((l) => [l.account_id, Number(l.odoo_user_id)])),
    suggest,
  };
}

/** Say who an Insight account is in Odoo, or that they are nobody there. */
export async function saveLink(env, body, account) {
  await requireAdmin(account);
  const accountId = Number(body?.accountId);
  if (!Number.isInteger(accountId)) throw badRequest('Which account?');
  if (body?.odooUserId == null || body.odooUserId === '') {
    await run(env.DB, 'DELETE FROM odoo_link WHERE account_id = ?1', accountId);
    return { ok: true };
  }
  const odooUserId = Number(body.odooUserId);
  const user = await first(env.DB, 'SELECT id, name FROM odoo_user WHERE id = ?1', odooUserId);
  if (!user) throw badRequest('That Odoo user is not known yet. Refresh, and choose again.');
  const taken = await first(env.DB, 'SELECT account_id FROM odoo_link WHERE odoo_user_id = ?1 AND account_id <> ?2', odooUserId, accountId);
  if (taken) throw badRequest(`${user.name} is already linked to another account.`);
  await run(env.DB, `INSERT INTO odoo_link (account_id, odoo_user_id, odoo_name, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (account_id) DO UPDATE SET odoo_user_id = ?2, odoo_name = ?3, by_name = ?4, at = ?5`, accountId, odooUserId, user.name, who(account), now());
  return { ok: true };
}
