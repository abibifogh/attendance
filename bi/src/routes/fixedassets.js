import { all, first, getSettings, run, setSetting } from '../lib/db.js';
import { badRequest, HttpError } from '../lib/http.js';
import { fixedAssetData } from '../connectors/odoo.js';
import { odooSource } from './safebook.js';
import * as mgmt from './mgmt.js';
import { requireAdmin } from './till.js';

/**
 * Fixed assets: found in Odoo, confirmed by an admin, kept in Maintenance.
 *
 * Insight reads from Odoo (connectors/odoo.js, fixedAssetData) the assets in
 * its Assets app, everything posted to a fixed asset account, and the vendor
 * bill lines that cost enough to be one. Each becomes one item here (fa_item):
 *
 * - **In the asset account**: an asset in Odoo's Assets app, or a debit on a
 *   fixed asset account that no Odoo asset already covers. Already
 *   capitalised; it needs only putting on the register, with its room.
 * - **A new purchase** that looks like an asset: its name has one of the
 *   words that point to an asset and none of those that never are, and it
 *   costs at least the amount each (or the amount on one line) in the rules.
 *   Booked to an expense account, it says so, for the accountant: Insight
 *   never changes Odoo.
 *
 * An admin decides each. **It's an asset**: each unit gets its NCA tag, a
 * name and a room, and, if it is serviced, how often and from when; they go
 * to Maintenance's equipment register (its `assets` function), which plans
 * the servicing. **Not an asset**: that product is remembered and not asked
 * about again.
 *
 * Read again each night with the other systems, and on "Read Odoo now".
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- rules --

const RULES = 'fa_rules';
export const DEFAULT_RULES = {
  minEach: 200000, // GH₵ 2,000 a unit
  minLine: 1000000, // or GH₵ 10,000 on one line, when the words point to an asset
  words: ['freezer', 'fridge', 'refrigerator', 'air condition', 'AC', 'split unit', 'TV', 'television', 'generator', 'pump',
    'water heater', 'boiler', 'washing machine', 'washer', 'dryer', 'iron press', 'computer', 'laptop', 'desktop', 'printer',
    'CCTV', 'camera', 'safe', 'bed', 'bunk', 'mattress', 'sofa', 'wardrobe', 'cabinet', 'table', 'desk', 'stove', 'cooker',
    'oven', 'microwave', 'blender', 'inverter', 'solar', 'battery bank', 'UPS', 'fan', 'router', 'POS', 'tank', 'motorbike', 'vehicle'],
  never: ['repair', 'service', 'servicing', 'labour', 'labor', 'fuel', 'diesel', 'petrol', 'refill', 'parts', 'spare', 'transport',
    'delivery', 'sheet', 'linen', 'towel', 'cleaning', 'chemical', 'paint', 'subscription', 'rent'],
  // Purchases from this day on are read. Everything on the asset accounts is read, whatever its day.
  since: null,
};

export async function rulesOf(env) {
  let s = {};
  try { s = JSON.parse((await getSettings(env.DB).catch(() => ({})))[RULES] || '{}'); } catch { s = {}; }
  return {
    minEach: Number.isFinite(Number(s.minEach)) && Number(s.minEach) > 0 ? Math.round(Number(s.minEach)) : DEFAULT_RULES.minEach,
    minLine: Number.isFinite(Number(s.minLine)) && Number(s.minLine) > 0 ? Math.round(Number(s.minLine)) : DEFAULT_RULES.minLine,
    words: Array.isArray(s.words) ? s.words : DEFAULT_RULES.words,
    never: Array.isArray(s.never) ? s.never : DEFAULT_RULES.never,
    since: DAY.test(String(s.since || '')) ? s.since : null,
  };
}

const cleanWords = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(','))
  .map((w) => String(w).trim()).filter((w) => w && w.length <= 40))].slice(0, 200);

/** An admin's: the amounts, the words, and from when purchases are read. */
export async function saveRules(env, body, account) {
  await requireAdmin(account);
  const cur = await rulesOf(env);
  const cedis = (v, what) => {
    if (v === undefined) return undefined;
    const n = Math.round(Number(v) * 100);
    if (!Number.isFinite(n) || n <= 0) throw badRequest(`${what} is not an amount.`);
    return n;
  };
  const next = {
    minEach: cedis(body?.minEach, 'The amount each') ?? cur.minEach,
    minLine: cedis(body?.minLine, 'The amount on one line') ?? cur.minLine,
    words: body?.words !== undefined ? cleanWords(body.words) : cur.words,
    never: body?.never !== undefined ? cleanWords(body.never) : cur.never,
    since: body?.since !== undefined ? (DAY.test(String(body.since || '')) ? body.since : null) : cur.since,
  };
  if (!next.words.length) throw badRequest('Give at least one word that points to an asset.');
  await setSetting(env.DB, RULES, JSON.stringify(next));
  return { ok: true, rules: next };
}

// ------------------------------------------------------------- picking --

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The words in a name, matched whole (and plural): "AC" is not in "vacuum", "bed" is in "beds". */
const hits = (text, words) => words.filter((w) => new RegExp(`(^|[^a-z0-9])${escapeRe(w.toLowerCase())}(e?s)?($|[^a-z0-9])`, 'i').test(text));
export const productKey = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
const cedi = (minor) => `GH₵ ${(minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;

/**
 * Whether a purchase line looks like a fixed asset, and why: a word that
 * points to an asset, none that never is, and enough money, each or on the line.
 */
export function looksLikeAsset(line, rules) {
  const text = `${line.name} ${line.label || ''}`;
  if (hits(text, rules.never).length) return null;
  const words = hits(text, rules.words);
  if (!words.length) return null;
  const each = line.unitCost >= rules.minEach;
  const whole = line.amount >= rules.minLine;
  if (!each && !whole) return null;
  return [`“${words[0]}”`, each ? `over ${cedi(rules.minEach)} each` : `${cedi(line.amount)} on one line`];
}

/** Odoo's data → the items, as they would be stored. */
export function itemsFrom(data, rules) {
  const assetAccountIds = new Set(data.accounts.map((a) => a.id));
  const covered = new Set((data.assets || []).flatMap((a) => a.lines));
  const out = [];
  for (const a of data.assets || []) {
    out.push({ key: `asset:${a.id}`, kind: 'odoo_asset', name: a.name, product: productKey(a.name), qty: 1, unitCost: a.value, amount: a.value,
      supplier: null, day: a.day, doc: `Asset: ${a.name}`, account: a.account, onAssetAccount: true, why: null });
  }
  const seen = new Set();
  for (const l of data.accountLines) {
    if (covered.has(l.id)) continue;
    seen.add(l.id);
    out.push({ key: `line:${l.id}`, kind: 'account', name: l.name, product: productKey(l.product || l.name), qty: l.qty, unitCost: l.unitCost || Math.round(l.amount / (l.qty || 1)),
      amount: l.amount, supplier: l.supplier, day: l.day, doc: l.doc, account: l.account, onAssetAccount: true, why: null });
  }
  for (const l of data.billLines) {
    if (covered.has(l.id) || seen.has(l.id) || assetAccountIds.has(l.accountId)) continue;
    const why = looksLikeAsset(l, rules);
    if (!why) continue;
    out.push({ key: `line:${l.id}`, kind: 'purchase', name: l.name, product: productKey(l.product || l.name), qty: l.qty, unitCost: l.unitCost,
      amount: l.amount, supplier: l.supplier, day: l.day, doc: l.doc, account: l.account, onAssetAccount: false, why });
  }
  return out;
}

const splitAccount = (text) => {
  const m = /^(\S+)\s+(.*)$/.exec(String(text || ''));
  return m ? { code: m[1], name: m[2] } : { code: null, name: text || null };
};

/** Read Odoo, and keep what may be a fixed asset. Decisions already taken stay as they are. */
export async function scan(env, { fetchImpl, today = new Date().toISOString().slice(0, 10) } = {}) {
  const source = await odooSource(env);
  if (!source) throw new HttpError(409, 'Odoo is not set up in Insight yet.');
  const rules = await rulesOf(env);
  const since = rules.since || new Date(Date.parse(`${today}T12:00:00Z`) - 730 * 86400000).toISOString().slice(0, 10);
  const data = await fixedAssetData({ ...source, since, minEach: Math.min(rules.minEach, rules.minLine), minLine: rules.minLine, ...(fetchImpl ? { fetchImpl } : {}) });
  const items = itemsFrom(data, rules);
  const remembered = new Set((await all(env.DB, 'SELECT product FROM fa_not_asset')).map((r) => r.product));
  const at = now();
  let fresh = 0;
  for (const x of items) {
    const { code, name } = splitAccount(x.account);
    const had = await first(env.DB, 'SELECT state FROM fa_item WHERE key = ?1', x.key);
    // A purchase of a product somebody said is not an asset is kept, as not one, and not asked about.
    const state = !had && x.kind === 'purchase' && remembered.has(x.product) ? 'not_asset' : 'review';
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, `INSERT INTO fa_item (key, kind, name, product, qty, unit_cost, amount, supplier, day, doc, account_code, account_name,
        on_asset_account, why, state, decided_by, decided_at, seen_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
      ON CONFLICT (key) DO UPDATE SET kind = ?2, name = ?3, product = ?4, qty = ?5, unit_cost = ?6, amount = ?7, supplier = ?8, day = ?9,
        doc = ?10, account_code = ?11, account_name = ?12, on_asset_account = ?13, why = ?14, seen_at = ?18`,
    x.key, x.kind, x.name, x.product, x.qty, x.unitCost, x.amount, x.supplier, x.day, x.doc, code, name,
    x.onAssetAccount ? 1 : 0, x.why ? JSON.stringify(x.why) : null, state,
    state === 'not_asset' ? 'Remembered: not an asset' : null, state === 'not_asset' ? at : null, at);
    if (!had) fresh += 1;
  }
  await setSetting(env.DB, 'fa_scanned', JSON.stringify({ at, found: items.length, fresh, accounts: data.accounts.length, assetsApp: data.assets !== null })).catch(() => {});
  return { ok: true, found: items.length, fresh, accounts: data.accounts.map((a) => `${a.code} ${a.name}`), assetsApp: data.assets !== null };
}

// --------------------------------------------------------- Maintenance --

/** Maintenance's `assets` function: MAINTENANCE_ASSETS_URL, or next to its approvals function. */
const assetsUrl = (env) => env.MAINTENANCE_ASSETS_URL
  || (env.MAINTENANCE_APPROVALS_URL ? String(env.MAINTENANCE_APPROVALS_URL).replace(/\/approvals\/?$/, '/assets') : null);
export const maintenanceLinked = (env) => Boolean(env.SSO_SECRET_MAINTENANCE && assetsUrl(env));

/** How the other app is called: replaced in tests. */
export const io = { fetch: (...a) => fetch(...a) };

export async function askMaintenance(env, body) {
  if (!maintenanceLinked(env)) throw new HttpError(409, 'Maintenance is not linked to Insight yet.');
  try {
    return await mgmt.ask({ url: assetsUrl(env), secret: env.SSO_SECRET_MAINTENANCE, path: '/assets', body, fetchImpl: io.fetch, what: 'Maintenance' });
  } catch (err) {
    const msg = /management report/.test(err.message) ? 'Maintenance does not take fixed assets yet: its assets function is not deployed.' : err.message;
    throw new HttpError(502, msg);
  }
}

const TAG = (n) => `NCA-${String(n).padStart(4, '0')}`;
const tagNumber = (tag) => { const m = /^NCA-(\d+)$/.exec(String(tag || '')); return m ? Number(m[1]) : 0; };

// ------------------------------------------------------------ the page --

const view = (r) => ({
  key: r.key, kind: r.kind, name: r.name, qty: r.qty, unitCost: r.unit_cost, amount: r.amount, supplier: r.supplier, day: r.day, doc: r.doc,
  account: r.account_code ? `${r.account_code} ${r.account_name || ''}`.trim() : (r.account_name || null),
  onAssetAccount: Boolean(r.on_asset_account), why: r.why ? JSON.parse(r.why) : null, state: r.state,
  units: r.units ? JSON.parse(r.units) : null, decidedBy: r.decided_by, decidedAt: r.decided_at,
});

/** Everything the page shows: what to review, what is on the asset accounts, the register, what is not an asset, and the rules. */
export async function faView(env, account) {
  await requireAdmin(account);
  const rows = (await all(env.DB, 'SELECT * FROM fa_item ORDER BY day DESC, key')).map(view);
  const settings = await getSettings(env.DB).catch(() => ({}));
  let scanned = null;
  try { scanned = JSON.parse(settings.fa_scanned || 'null'); } catch { scanned = null; }
  let register = null;
  let rooms = [];
  let registerError = null;
  if (maintenanceLinked(env)) {
    try {
      const [reg, places] = await Promise.all([askMaintenance(env, { action: 'register' }), askMaintenance(env, { action: 'rooms' })]);
      register = reg.assets || [];
      rooms = [...(places.rooms || []), ...(places.areas || [])];
    } catch (err) { registerError = err.message; }
  } else registerError = 'Maintenance is not linked to Insight yet.';
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const reg = register || [];
  return {
    review: rows.filter((r) => r.state === 'review'),
    account: rows.filter((r) => r.kind !== 'purchase'),
    notAssets: rows.filter((r) => r.state === 'not_asset'),
    register,
    registerError,
    rooms,
    rules: await rulesOf(env),
    scanned,
    nextTag: TAG(await nextTagNumber(env, reg)),
    totals: {
      review: rows.filter((r) => r.state === 'review').length,
      account: rows.filter((r) => r.kind !== 'purchase').length,
      accountOff: rows.filter((r) => r.kind !== 'purchase' && r.state === 'review').length,
      register: reg.length,
      rooms: new Set(reg.map((a) => a.room).filter(Boolean)).size,
      atCost: Math.round(reg.reduce((t, a) => t + (Number(a.cost) || 0), 0) * 100),
      late: reg.filter((a) => a.overdue_since).length,
      dueSoon: reg.filter((a) => !a.overdue_since && a.next_service && a.next_service >= today && a.next_service <= soon).length,
    },
  };
}

async function nextTagNumber(env, register) {
  const mine = (await first(env.DB, 'SELECT MAX(n) AS n FROM fa_tag'))?.n || 0;
  const theirs = Math.max(0, ...register.map((a) => tagNumber(a.tag)));
  return Math.max(Number(mine), theirs) + 1;
}

// ------------------------------------------------------------ deciding --

async function itemFor(env, key) {
  const r = await first(env.DB, 'SELECT * FROM fa_item WHERE key = ?1', String(key || ''));
  if (!r) throw new HttpError(404, 'That is not on the list any more: read Odoo again.');
  return r;
}

/**
 * It's an asset: each unit, with its NCA tag, name and room, and its
 * servicing, to Maintenance's register. Tags are given here, one higher
 * than any given before or on the register.
 */
export async function register(env, body, account) {
  await requireAdmin(account);
  const r = await itemFor(env, body?.key);
  if (r.state === 'registered') throw badRequest('That is on the register already.');
  const units = Array.isArray(body?.units) ? body.units : [];
  if (!units.length) throw badRequest('Say at least one: its name and room.');
  if (units.length > 100) throw badRequest('A hundred at a time at most.');
  const months = body?.serviceMonths == null || body.serviceMonths === '' ? 0 : Number(body.serviceMonths);
  if (!Number.isInteger(months) || months < 0 || months > 60) throw badRequest('How often it is serviced is not a number of months.');
  if (months && !DAY.test(String(body?.firstService || ''))) throw badRequest('Say when it is first serviced.');
  const reg = (await askMaintenance(env, { action: 'register' })).assets || [];
  let n = await nextTagNumber(env, reg);
  const each = Math.round(r.amount / units.length);
  const sent = units.map((u, i) => ({
    name: String(u?.name || '').trim(), room: String(u?.room || '').trim(), tag: TAG(n + i),
    cost: each / 100, supplier: r.supplier, bought: r.day, odoo_ref: r.doc, odoo_key: `${r.key}#${i + 1}`,
    service_months: months || null, first_service: months ? body.firstService : null,
    serviced_by: body?.servicedBy === 'supplier' ? 'supplier' : 'in_house',
  }));
  const out = await askMaintenance(env, { action: 'add', by: who(account), units: sent });
  const at = now();
  for (const u of sent) {
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, 'INSERT OR IGNORE INTO fa_tag (n, key, name, at) VALUES (?1, ?2, ?3, ?4)', tagNumber(u.tag), r.key, u.name, at);
  }
  n += sent.length;
  await run(env.DB, "UPDATE fa_item SET state = 'registered', units = ?2, decided_by = ?3, decided_at = ?4 WHERE key = ?1",
    r.key, JSON.stringify(sent.map((u) => ({ tag: u.tag, name: u.name, room: u.room }))), who(account), at);
  return { ok: true, added: out.added || [], skipped: out.skipped || [], tags: sent.map((u) => u.tag) };
}

/** Not an asset (that product is remembered), or back to review. */
export async function decide(env, body, account) {
  await requireAdmin(account);
  const r = await itemFor(env, body?.key);
  const at = now();
  if (body?.undo) {
    if (r.state !== 'not_asset') throw badRequest('Only one marked not an asset can be put back.');
    await run(env.DB, "UPDATE fa_item SET state = 'review', decided_by = NULL, decided_at = NULL WHERE key = ?1", r.key);
    if (r.product) await run(env.DB, 'DELETE FROM fa_not_asset WHERE product = ?1', r.product);
    return { ok: true, state: 'review' };
  }
  if (r.state === 'registered') throw badRequest('That is on the register: take it off in Maintenance.');
  await run(env.DB, "UPDATE fa_item SET state = 'not_asset', decided_by = ?2, decided_at = ?3 WHERE key = ?1", r.key, who(account), at);
  if (r.product && r.kind === 'purchase') {
    await run(env.DB, 'INSERT OR REPLACE INTO fa_not_asset (product, by_name, at) VALUES (?1, ?2, ?3)', r.product, who(account), at);
  }
  return { ok: true, state: 'not_asset' };
}

/** For Today: what waits on an admin. */
export async function todayItems(env) {
  const review = (await first(env.DB, "SELECT COUNT(*) AS n FROM fa_item WHERE state = 'review'").catch(() => null))?.n || 0;
  const out = [];
  if (review) {
    out.push({ tab: 'decide', key: 'fa:review', sev: 'info', title: `${review} possible fixed asset${review === 1 ? '' : 's'} from Odoo to review`,
      advice: 'Say whether each is a fixed asset; those that are go on the register in Maintenance, with their room and servicing.',
      actions: [{ label: 'Open fixed assets', href: '#/assets', primary: true }] });
  }
  if (maintenanceLinked(env)) {
    const reg = (await askMaintenance(env, { action: 'register' }).catch(() => ({ assets: [] }))).assets || [];
    const late = reg.filter((a) => a.overdue_since).sort((a, b) => String(a.overdue_since).localeCompare(String(b.overdue_since)));
    if (late.length) {
      out.push({ tab: 'fix', key: 'fa:late', sev: 'warn', title: `${late.length} asset${late.length === 1 ? '' : 's'} overdue for service`,
        why: late.slice(0, 4).map((a) => `${a.name}${a.tag ? ` (${a.tag})` : ''}${a.room ? `, ${a.room}` : ''}, since ${a.overdue_since}`).join(' · '),
        due: late[0].overdue_since, advice: 'Their service jobs are open in Maintenance: get them done, or say why not.',
        actions: [{ label: 'Open fixed assets', href: '#/assets', primary: true }] });
    }
  }
  return out;
}
