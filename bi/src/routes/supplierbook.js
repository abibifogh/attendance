import { all, first, run } from '../lib/db.js';
import { HttpError, badRequest, forbidden, str } from '../lib/http.js';
import { addDays, isDay, todayIn } from '../lib/dates.js';
import { orgKey } from '../warehouse/identity.js';
import { vendorList } from '../connectors/odoo.js';
import { odooSource } from './safebook.js';
import { roleOf } from './till.js';
import { ask, breakfastBase } from './mgmt.js';

/**
 * Buying › Suppliers: one list of suppliers.
 *
 * Odoo is the list. Its vendors are read into Insight (Refresh from Odoo) with
 * their contact details, tax number, terms and bank accounts, and Insight only
 * adds what Odoo has no place for:
 *
 * - **Key suppliers**, in groups. Odoo lists everybody a PO or bill ever went
 *   to: one-off shops, refunds to staff, people. The key ones are marked and
 *   grouped (Food, Maintenance…), and the page opens on them.
 * - **Not a supplier**: hidden from the list (a member of staff, a one-off).
 * - **Other spellings**: the same supplier as typed in the breakfast app, the
 *   maintenance store, a receipt. Linked to the Odoo supplier, their spend
 *   counts as theirs.
 * - **How they are paid**: MoMo and bank details, and a note. Payment details
 *   are seen and changed by admins and supervisors only, and every change is
 *   kept in the supplier's history.
 *
 * The list goes to the breakfast app and the maintenance store too (each
 * night, and when it changes here), so whoever records a delivery there picks
 * the supplier from it, key suppliers first, or types one it does not have.
 *
 * Spend is the warehouse's: Odoo bills by their date, and purchases from the
 * other systems (the breakfast app and the rest). Odoo's own purchase lines
 * are left out of that second part, since the bills already carry them.
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const monthOf = (day) => day.slice(0, 7);

/** The groups offered for key suppliers; any other may be typed. */
export const GROUPS = ['Food & breakfast', 'Drinks & bar', 'Maintenance & hardware', 'Cleaning & laundry', 'Utilities', 'Services', 'Office & other'];

/** Admins and supervisors change suppliers and see how they are paid; nobody else. */
export const mayEdit = (account) => ['admin', 'supervisor'].includes(roleOf(account));
function requireEditor(account) {
  if (!mayEdit(account)) throw forbidden('Only admins and supervisors change suppliers.');
}

async function log(env, odooId, what, account) {
  await run(env.DB, 'INSERT INTO supplier_log (odoo_id, what, by_name, at) VALUES (?1, ?2, ?3, ?4)', odooId, what, who(account), now());
}

// ---------------------------------------------------------------- Odoo --

/** Read Odoo's vendors into Insight, pressed by an admin or a supervisor. */
export async function refresh(env, account, { fetchImpl } = {}) {
  requireEditor(account);
  const out = await refreshFromOdoo(env, { fetchImpl });
  return { ...out, sent: await pushSuppliers(env, { fetchImpl }) };
}

/** Read Odoo's vendors into Insight (also each night). Those Odoo no longer lists stay, marked. */
export async function refreshFromOdoo(env, { fetchImpl } = {}) {
  const s = await odooSource(env);
  if (!s) throw new HttpError(409, 'Odoo is not set up in Insight yet: add it under Settings › Connections & files.');
  const vendors = await vendorList({ ...s, ...(fetchImpl ? { fetchImpl } : {}) });
  const at = now();
  for (const v of vendors) {
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, `INSERT INTO supplier_odoo (odoo_id, name, match_key, phone, email, vat, address, terms, company, staff, banks, in_odoo, refreshed_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12)
      ON CONFLICT (odoo_id) DO UPDATE SET name = ?2, match_key = ?3, phone = ?4, email = ?5, vat = ?6, address = ?7, terms = ?8,
        company = ?9, staff = ?10, banks = ?11, in_odoo = 1, refreshed_at = ?12`,
    v.id, v.name, orgKey(v.name), v.phone, v.email, v.vat, v.address, v.terms, v.company ? 1 : 0, v.staff ? 1 : 0, JSON.stringify(v.banks || []), at);
  }
  await run(env.DB, 'UPDATE supplier_odoo SET in_odoo = 0 WHERE refreshed_at <> ?1', at);
  return { ok: true, count: vendors.length, at };
}

// ---------------------------------------------------------------- spend --

/** Spend, owed and when last bought, by the warehouse's supplier key. */
async function spendByKey(env, from, to) {
  const sources = await all(env.DB, 'SELECT id, label, kind FROM sources').catch(() => []);
  const odooIds = sources.filter((x) => x.kind === 'odoo_json2').map((x) => x.id);
  const label = new Map(sources.map((x) => [x.id, x.label]));
  const notOdoo = odooIds.length ? `AND l.source_id NOT IN (${odooIds.map((_, i) => `?${i + 3}`).join(', ')})` : '';
  const [bills, owed, lines] = await Promise.all([
    all(env.DB, `SELECT s.match_key AS k, s.name, SUM(b.total) AS spend, MAX(b.day) AS last, COUNT(*) AS n
                   FROM fact_bill b JOIN dim_supplier s ON s.id = b.supplier_id
                  WHERE b.state != 'cancel' AND b.day BETWEEN ?1 AND ?2 GROUP BY s.match_key`, from, to).catch(() => []),
    all(env.DB, `SELECT s.match_key AS k, SUM(b.residual) AS owed
                   FROM fact_bill b JOIN dim_supplier s ON s.id = b.supplier_id
                  WHERE b.state = 'posted' AND b.payment_state IN ('not_paid', 'partial') GROUP BY s.match_key`).catch(() => []),
    all(env.DB, `SELECT s.match_key AS k, s.name, l.source_id AS src, SUM(l.amount) AS spend, MAX(l.day) AS last, COUNT(*) AS n
                   FROM fact_purchase_line l JOIN dim_supplier s ON s.id = l.supplier_id
                  WHERE l.day BETWEEN ?1 AND ?2 ${notOdoo} GROUP BY s.match_key, l.source_id`, from, to, ...odooIds).catch(() => []),
  ]);
  const out = new Map();
  const at = (k, name) => {
    if (!out.has(k)) out.set(k, { key: k, name, spend: 0, owed: 0, last: null, n: 0, systems: new Set() });
    return out.get(k);
  };
  for (const b of bills) {
    const x = at(b.k, b.name);
    x.spend += Number(b.spend) || 0; x.n += Number(b.n) || 0; x.systems.add('Odoo');
    if (!x.last || b.last > x.last) x.last = b.last;
  }
  for (const o of owed) at(o.k, o.k).owed += Number(o.owed) || 0;
  for (const l of lines) {
    const x = at(l.k, l.name);
    x.spend += Number(l.spend) || 0; x.n += Number(l.n) || 0; x.systems.add(label.get(l.src) || l.src);
    if (!x.last || l.last > x.last) x.last = l.last;
  }
  return out;
}

const blank = () => ({ spend: 0, owed: 0, last: null, n: 0, systems: new Set() });
function add(into, x) {
  into.spend += x.spend; into.owed += x.owed; into.n += x.n;
  if (x.last && (!into.last || x.last > into.last)) into.last = x.last;
  for (const s of x.systems) into.systems.add(s);
}

function windowOf(query) {
  const to = isDay(query?.to) ? query.to : todayIn('UTC');
  const from = isDay(query?.from) ? query.from : addDays(to, -89);
  if (from > to) throw badRequest('The start is after the end.');
  return { from, to };
}

/** What a viewer may see of how a supplier is paid: everything, or nothing. */
function payOf(extra, banks, canEdit) {
  if (!canEdit) return null;
  return { ...parse(extra?.pay || '{}', {}), odooBanks: banks };
}

// ----------------------------------------------------------------- list --

/** The suppliers page: key suppliers by group, everybody else in Odoo, and names not linked to anybody. */
export async function book(env, query, account) {
  const { from, to } = windowOf(query);
  const canEdit = mayEdit(account);
  const [vendors, extras, aliases, spend, src] = await Promise.all([
    all(env.DB, 'SELECT * FROM supplier_odoo ORDER BY name').catch(() => []),
    all(env.DB, 'SELECT * FROM supplier_extra').catch(() => []),
    all(env.DB, 'SELECT * FROM supplier_alias').catch(() => []),
    spendByKey(env, from, to),
    odooSource(env).catch(() => null),
  ]);
  const extraOf = new Map(extras.map((e) => [e.odoo_id, e]));
  const owner = new Map();
  for (const v of vendors) if (!owner.has(v.match_key)) owner.set(v.match_key, v.odoo_id);
  for (const a of aliases) owner.set(a.match_key, a.odoo_id);

  const totals = new Map(vendors.map((v) => [v.odoo_id, blank()]));
  const unlinked = [];
  for (const [k, x] of spend) {
    const id = owner.get(k);
    if (id != null && totals.has(id)) add(totals.get(id), x);
    else if (x.spend > 0) unlinked.push({ key: k, name: x.name, spend: x.spend, last: x.last, systems: [...x.systems] });
  }

  const rows = vendors.map((v) => {
    const e = extraOf.get(v.odoo_id) || {};
    const t = totals.get(v.odoo_id);
    return {
      id: v.odoo_id, name: v.name, phone: v.phone, email: v.email, vat: v.vat, terms: v.terms,
      staff: Boolean(v.staff), company: Boolean(v.company), inOdoo: Boolean(v.in_odoo),
      key: Boolean(e.is_key), group: e.grp || null, hidden: Boolean(e.hidden), note: e.note || null,
      spend: t.spend, owed: t.owed, last: t.last, purchases: t.n, systems: [...t.systems],
      aliases: aliases.filter((a) => a.odoo_id === v.odoo_id).map((a) => a.raw_name || a.match_key),
      hasPay: canEdit ? Boolean(Object.values(parse(e.pay || '{}', {})).some(Boolean) || parse(v.banks, []).length) : null,
    };
  }).sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));

  const keyRows = rows.filter((r) => r.key && !r.hidden);
  const groups = [...new Set([...GROUPS, ...keyRows.map((r) => r.group).filter(Boolean)])];
  const allSpend = rows.reduce((t, r) => t + r.spend, 0) + unlinked.reduce((t, u) => t + u.spend, 0);
  return {
    from, to, canEdit,
    refreshedAt: vendors.reduce((m, v) => (v.refreshed_at > m ? v.refreshed_at : m), '') || null,
    odooUrl: src?.config?.base ? String(src.config.base).replace(/\/+$/, '') : null,
    groups,
    tiles: {
      key: keyRows.length,
      keySpend: keyRows.reduce((t, r) => t + r.spend, 0),
      allSpend,
      owed: rows.filter((r) => !r.hidden).reduce((t, r) => t + r.owed, 0),
      unlinked: unlinked.length,
      unlinkedSpend: unlinked.reduce((t, u) => t + u.spend, 0),
    },
    suppliers: rows,
    unlinked: unlinked.sort((a, b) => b.spend - a.spend).slice(0, 60),
  };
}

// ------------------------------------------------------------ one of them --

/** One supplier: Odoo's details, what Insight adds, six months of spend, the latest bills and purchases, and the history. */
export async function one(env, query, account) {
  const id = Number(query?.id);
  const v = await first(env.DB, 'SELECT * FROM supplier_odoo WHERE odoo_id = ?1', id);
  if (!v) throw new HttpError(404, 'No such supplier. Refresh from Odoo if it is new.');
  const canEdit = mayEdit(account);
  const e = (await first(env.DB, 'SELECT * FROM supplier_extra WHERE odoo_id = ?1', id)) || {};
  const aliases = await all(env.DB, 'SELECT * FROM supplier_alias WHERE odoo_id = ?1 ORDER BY raw_name', id);
  const keys = [v.match_key, ...aliases.map((a) => a.match_key)];
  const marks = keys.map((_, i) => `?${i + 1}`).join(', ');
  const since = `${monthOf(addDays(todayIn('UTC'), -170))}-01`;
  const sources = await all(env.DB, 'SELECT id, label, kind FROM sources').catch(() => []);
  const odooIds = new Set(sources.filter((x) => x.kind === 'odoo_json2').map((x) => x.id));
  const label = new Map(sources.map((x) => [x.id, x.label]));
  const [bills, lines] = await Promise.all([
    all(env.DB, `SELECT b.day, b.vendor_ref, b.total, b.residual, b.payment_state, b.state FROM fact_bill b JOIN dim_supplier s ON s.id = b.supplier_id
                  WHERE s.match_key IN (${marks}) AND b.state != 'cancel' AND b.day >= ?${keys.length + 1} ORDER BY b.day DESC`, ...keys, since).catch(() => []),
    all(env.DB, `SELECT l.day, l.source_id, l.amount, l.qty, l.unit, i.name AS item FROM fact_purchase_line l JOIN dim_supplier s ON s.id = l.supplier_id
                  LEFT JOIN dim_item i ON i.id = l.item_id
                  WHERE s.match_key IN (${marks}) AND l.day >= ?${keys.length + 1} ORDER BY l.day DESC`, ...keys, since).catch(() => []),
  ]);
  const own = lines.filter((l) => !odooIds.has(l.source_id));
  const months = [];
  for (let m = monthOf(since); months.length < 6; ) {
    months.push(m);
    const [y, mo] = m.split('-').map(Number);
    m = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}`;
  }
  const byMonth = months.map((m) => ({
    month: m,
    spend: bills.filter((b) => monthOf(b.day) === m).reduce((t, b) => t + b.total, 0) + own.filter((l) => monthOf(l.day) === m).reduce((t, l) => t + l.amount, 0),
  }));
  const recent = [
    ...bills.map((b) => ({ day: b.day, what: `Bill${b.vendor_ref ? ` ${b.vendor_ref}` : ''}`, system: 'Odoo', amount: b.total, owed: b.state === 'posted' && ['not_paid', 'partial'].includes(b.payment_state) ? b.residual : 0 })),
    ...own.map((l) => ({ day: l.day, what: l.item ? `${l.item}${l.qty ? ` × ${l.qty}${l.unit ? ` ${l.unit}` : ''}` : ''}` : 'A purchase', system: label.get(l.source_id) || l.source_id, amount: l.amount, owed: 0 })),
  ].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 15);
  const history = canEdit ? await all(env.DB, 'SELECT what, by_name, at FROM supplier_log WHERE odoo_id = ?1 ORDER BY id DESC LIMIT 30', id) : [];
  return {
    canEdit,
    supplier: {
      id, name: v.name, phone: v.phone, email: v.email, vat: v.vat, address: v.address, terms: v.terms,
      staff: Boolean(v.staff), company: Boolean(v.company), inOdoo: Boolean(v.in_odoo), refreshedAt: v.refreshed_at,
      key: Boolean(e.is_key), group: e.grp || null, hidden: Boolean(e.hidden), note: e.note || null,
      aliases: aliases.map((a) => ({ key: a.match_key, name: a.raw_name || a.match_key, by: a.by_name, at: a.at })),
      pay: payOf(e, parse(v.banks, []), canEdit),
    },
    byMonth,
    recent,
    history,
    groups: GROUPS,
  };
}

// --------------------------------------------------------------- changes --

const PAY_FIELDS = { momoNumber: 'MoMo number', momoName: 'MoMo name', momoNetwork: 'MoMo network', bankName: 'Bank', bankAccountName: 'Account name', bankAccount: 'Account number' };
const masked = (v) => (v && v.length > 4 ? `…${v.slice(-4)}` : v || 'nothing');

/** Mark key (and its group), hide, a note, how they are paid. Each change is kept in their history. */
export async function save(env, body, account, { fetchImpl } = {}) {
  requireEditor(account);
  const id = Number(body?.id);
  const v = await first(env.DB, 'SELECT odoo_id, name FROM supplier_odoo WHERE odoo_id = ?1', id);
  if (!v) throw new HttpError(404, 'No such supplier.');
  const was = (await first(env.DB, 'SELECT * FROM supplier_extra WHERE odoo_id = ?1', id)) || { is_key: 0, grp: null, hidden: 0, note: null, pay: '{}' };
  const next = { ...was };
  const said = [];
  if (body.key !== undefined) {
    next.is_key = body.key ? 1 : 0;
    if (next.is_key !== was.is_key) said.push(next.is_key ? 'Marked a key supplier' : 'No longer a key supplier');
    if (next.is_key && next.hidden) { next.hidden = 0; said.push('Shown again'); }
  }
  if (body.group !== undefined) {
    next.grp = str(body.group, 'Group', { max: 60 }) || null;
    if (next.grp !== was.grp) said.push(next.grp ? `Group: ${next.grp}` : 'No group');
  }
  if (body.hidden !== undefined) {
    next.hidden = body.hidden ? 1 : 0;
    if (next.hidden !== was.hidden) said.push(next.hidden ? 'Hidden: not a supplier' : 'Shown again');
    if (next.hidden && next.is_key) { next.is_key = 0; said.push('No longer a key supplier'); }
  }
  if (body.note !== undefined) {
    next.note = str(body.note, 'Note', { max: 600 }) || null;
    if (next.note !== was.note) said.push('Note changed');
  }
  if (body.pay !== undefined) {
    const old = parse(was.pay || '{}', {});
    const pay = {};
    for (const [k, label] of Object.entries(PAY_FIELDS)) {
      pay[k] = str(body.pay?.[k], label, { max: 80 }) || null;
      if ((pay[k] || null) !== (old[k] || null)) said.push(`${label}: ${k.endsWith('Number') || k === 'bankAccount' ? masked(pay[k]) : (pay[k] || 'nothing')}`);
    }
    if (pay.momoNumber && !/^\+?[\d\s-]{9,16}$/.test(pay.momoNumber)) throw badRequest('The MoMo number: digits, like 024 123 4567.');
    next.pay = JSON.stringify(pay);
  }
  await run(env.DB, `INSERT INTO supplier_extra (odoo_id, is_key, grp, hidden, note, pay, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT (odoo_id) DO UPDATE SET is_key = ?2, grp = ?3, hidden = ?4, note = ?5, pay = ?6, updated_by = ?7, updated_at = ?8`,
  id, next.is_key, next.grp, next.hidden, next.note, next.pay || '{}', who(account), now());
  if (said.length) await log(env, id, said.join(' · '), account);
  // The apps' lists change only when who is key, in which group, or hidden does.
  if (body.key !== undefined || body.hidden !== undefined || body.group !== undefined) await pushSuppliers(env, fetchImpl ? { fetchImpl } : {}).catch(() => null);
  return { ok: true };
}

// --------------------------------------------------- the apps' lists --

/** The list the apps pick from: every Odoo supplier not hidden, key suppliers first. */
export async function appList(env) {
  const rows = await all(env.DB, `SELECT o.odoo_id, o.name, o.phone, COALESCE(e.is_key, 0) AS is_key, e.grp
    FROM supplier_odoo o LEFT JOIN supplier_extra e ON e.odoo_id = o.odoo_id
    WHERE o.in_odoo = 1 AND COALESCE(e.hidden, 0) = 0 ORDER BY COALESCE(e.is_key, 0) DESC, o.name`).catch(() => []);
  return rows.map((r) => ({ odooId: r.odoo_id, name: r.name, phone: r.phone || null, key: Boolean(r.is_key), group: r.grp || null }));
}

/**
 * Send the list to the breakfast app and the maintenance store, each signed
 * with its own secret. One that is not linked or cannot be reached is said,
 * never thrown: the list here is the one that matters.
 */
export async function pushSuppliers(env, { fetchImpl = fetch } = {}) {
  const suppliers = await appList(env);
  if (!suppliers.length) return { breakfast: 'nothing to send yet', maintenance: 'nothing to send yet' };
  const body = { suppliers };
  const out = {};
  try {
    const base = await breakfastBase(env);
    if (!base || !env.SSO_SECRET_BREAKFAST) throw new Error('not linked');
    const r = await ask({ url: `${base}/api/link/suppliers`, secret: env.SSO_SECRET_BREAKFAST, path: '/api/link/suppliers', body, fetchImpl, what: 'The breakfast app' });
    out.breakfast = `sent ${r.count ?? suppliers.length}`;
  } catch (err) { out.breakfast = String(err.message || err); }
  try {
    const url = env.MAINTENANCE_APPROVALS_URL ? String(env.MAINTENANCE_APPROVALS_URL).replace(/\/approvals\/?$/, '/suppliers') : null;
    if (!url || !env.SSO_SECRET_MAINTENANCE) throw new Error('not linked');
    const r = await ask({ url, secret: env.SSO_SECRET_MAINTENANCE, path: '/suppliers', body, fetchImpl, what: 'Maintenance' });
    out.maintenance = `sent ${r.count ?? suppliers.length}`;
  } catch (err) { out.maintenance = String(err.message || err); }
  return out;
}

/** Another spelling is this supplier (its spend counts as theirs), or is not after all. */
export async function link(env, body, account) {
  requireEditor(account);
  if (body?.unlink) {
    const key = String(body.unlink);
    const a = await first(env.DB, 'SELECT * FROM supplier_alias WHERE match_key = ?1', key);
    if (!a) return { ok: true };
    await run(env.DB, 'DELETE FROM supplier_alias WHERE match_key = ?1', key);
    await log(env, a.odoo_id, `“${a.raw_name || key}” is not this supplier after all`, account);
    return { ok: true };
  }
  const id = Number(body?.id);
  const v = await first(env.DB, 'SELECT odoo_id, name, match_key FROM supplier_odoo WHERE odoo_id = ?1', id);
  if (!v) throw new HttpError(404, 'No such supplier.');
  const name = str(body?.name, 'The other spelling', { required: true, max: 120 });
  const key = orgKey(name);
  if (!key) throw badRequest('That spelling has no letters or numbers in it.');
  if (key === v.match_key) return { ok: true };
  await run(env.DB, `INSERT INTO supplier_alias (match_key, odoo_id, raw_name, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (match_key) DO UPDATE SET odoo_id = ?2, raw_name = ?3, by_name = ?4, at = ?5`, key, id, name, who(account), now());
  await log(env, id, `“${name}” is this supplier`, account);
  return { ok: true };
}
