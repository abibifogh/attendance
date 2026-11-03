import { all, first, getSettings, run, setSetting } from '../lib/db.js';
import { addDays } from '../lib/dates.js';
import { badRequest, forbidden, str } from '../lib/http.js';
import { tell } from '../lib/notices.js';
import { stockPoLines } from '../connectors/odoo.js';
import { odooSource } from './safebook.js';
import { roleOf } from './till.js';
import * as mgmt from './mgmt.js';
import { shareOut } from './todo.js';

/**
 * Stock from Odoo.
 *
 * Every 15 minutes Insight reads the POs confirmed in Odoo (from the day an
 * admin chose) and offers each line to the stores: the breakfast app first,
 * then Maintenance. Each app knows which Odoo product is which of its items
 * (the same list its own "bring a PO in" uses) and answers for each line:
 * recorded as stock, on its way (for a storekeeper to say Received), already
 * there, not this store, or unknown. A line neither store knows becomes a
 * "Which store?" to-do for the person an admin chose; their answer is written
 * into that store's list, so it is asked once per Odoo product.
 *
 * When it becomes stock is an admin's choice (`stock_feed.mode`):
 *   confirmed  as soon as the PO is confirmed in Odoo
 *   store      when the storekeeper says Received in the store
 *   odoo       when the receipt is validated in Odoo (the line is fully received there)
 *
 * Insight never counts or changes stock itself: each store records it, by its
 * own rules. Insight keeps what it offered and what each store said
 * (`stock_line`), and raises to-dos for what needs a person: which store, a
 * delivery short, one not received after three days, and stock that stayed
 * after its PO was cancelled.
 */

/** How the stores are called: replaced in tests. */
export const io = { fetch: (...a) => fetch(...a) };

export const MODES = {
  confirmed: 'As soon as the PO is confirmed in Odoo',
  store: 'When the storekeeper says Received',
  odoo: 'When the receipt is validated in Odoo',
};
export const STORES = { breakfast: 'breakfast store', maintenance: 'Maintenance store' };
const APPS = ['breakfast', 'maintenance'];
const LATE_DAYS = 3;
const CHUNK = 200;
const PLACED = ['recorded', 'expected', 'received', 'already'];
const KINDS = ['stockmatch', 'stockshort', 'stocklate', 'stockkept'];

const stampOf = (at) => new Date(at).toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const keyOf = (productId, uomId) => `${Number(productId)}:${Number(uomId) || 0}`;
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const round2 = (n) => Math.round(Number(n) * 100) / 100;

function mustAdmin(account) {
  if (roleOf(account) !== 'admin') throw forbidden('Stock from Odoo is for admins.');
}
function mustHelp(account) {
  if (!['admin', 'supervisor'].includes(roleOf(account))) throw forbidden('Only a supervisor or an admin can say which store.');
}

// --------------------------------------------------------------- settings --

/** The admin's choices: when it becomes stock, who answers "Which store?", and from which day. */
export async function feedSettings(env) {
  const s = await getSettings(env.DB).catch(() => ({}));
  let v = {};
  try { v = JSON.parse(s.stock_feed || '{}'); } catch { v = {}; }
  return {
    mode: MODES[v.mode] ? v.mode : 'confirmed',
    askTo: Number.isInteger(Number(v.askTo)) && Number(v.askTo) > 0 ? Number(v.askTo) : null,
    from: isDay(v.from) ? v.from : null,
  };
}

export async function saveFeedSettings(env, body, account) {
  mustAdmin(account);
  const s = await feedSettings(env);
  if (body?.mode !== undefined) {
    if (!MODES[body.mode]) throw badRequest('Choose when it becomes stock.');
    s.mode = body.mode;
  }
  if (body?.askTo !== undefined) {
    if (body.askTo === null || body.askTo === '') s.askTo = null;
    else {
      const id = Number(body.askTo);
      const ok = (await helpers(env)).some((p) => Number(p.id) === id);
      if (!ok) throw badRequest('Choose an active supervisor or admin.');
      s.askTo = id;
    }
  }
  if (body?.from !== undefined) {
    if (!isDay(body.from)) throw badRequest('Choose the first day, as YYYY-MM-DD.');
    s.from = body.from;
  }
  await setSetting(env.DB, 'stock_feed', JSON.stringify(s));
  // The person changed: open questions go to the new one.
  if (body?.askTo !== undefined && s.askTo) {
    const p = (await helpers(env)).find((x) => Number(x.id) === s.askTo);
    await run(env.DB, `UPDATE money_todo SET assignee_id = ?1, assignee_name = ?2 WHERE kind IN (${KINDS.map((k) => `'${k}'`).join(', ')}) AND state != 'closed'`, p.id, p.name || p.email);
  }
  return { ok: true, settings: s };
}

/** Who can be asked: active supervisors and admins of Insight. */
async function helpers(env) {
  return all(env.DB, `SELECT a.id, a.name, a.email, g.role FROM accounts a JOIN account_access g ON g.account_id = a.id
    WHERE g.system_id = 'insight' AND g.role IN ('supervisor', 'admin') AND a.active = 1 ORDER BY a.name, a.id`).catch(() => []);
}

// ------------------------------------------------------------- the stores --

// Maintenance's signed `assets` function takes the stock calls: it turns away
// anything it does not know, so calling it before its update is harmless.
const maintenanceUrl = (env) => env.MAINTENANCE_ASSETS_URL
  || (env.MAINTENANCE_APPROVALS_URL ? String(env.MAINTENANCE_APPROVALS_URL).replace(/\/approvals\/?$/, '/assets') : null);

/** One signed call to a store. */
export async function askStore(env, app, body) {
  let url;
  let secret;
  let path;
  let what;
  if (app === 'breakfast') {
    const base = await mgmt.breakfastBase(env);
    secret = env.SSO_SECRET_BREAKFAST;
    if (!secret || !base) throw new Error('not linked');
    url = `${base}/api/link/stock`; path = '/api/link/stock'; what = 'The breakfast app';
  } else if (app === 'maintenance') {
    url = maintenanceUrl(env); secret = env.SSO_SECRET_MAINTENANCE;
    if (!secret || !url) throw new Error('not linked');
    path = '/assets'; what = 'Maintenance';
  } else throw badRequest('No such store.');
  try {
    return await mgmt.ask({ url, secret, path, body, fetchImpl: io.fetch, what });
  } catch (err) {
    // The shared helper speaks of the management report; here it is stock.
    if (/does not answer the management report|Rooms, register or add\?/.test(err.message)) throw new Error(`${what} does not take stock from Odoo yet: its update is not deployed.`);
    throw err;
  }
}

async function offerTo(env, app, mode, lines) {
  const out = {};
  for (let i = 0; i < lines.length; i += CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    const res = await askStore(env, app, { action: 'offer', mode, lines: lines.slice(i, i + CHUNK).map(asSent) });
    Object.assign(out, res.lines || {});
  }
  return out;
}

async function lineCall(env, app, action, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    const res = await askStore(env, app, { action, lineIds: ids.slice(i, i + CHUNK) });
    Object.assign(out, res.lines || {});
  }
  return out;
}

/** A line as the stores are sent it. */
const asSent = (l) => ({
  lineId: l.lineId, po: l.po, poId: l.poId, supplier: l.supplier, confirmedOn: l.confirmedOn,
  productId: l.productId, uomId: l.uomId, product: l.product, uom: l.uom, qty: l.qty, priceUnit: l.priceUnit,
});

// ------------------------------------------------------------------- sync --

async function saveAnswer(env, lineId, app, a, at) {
  const state = a.state === 'already' && PLACED.includes(a.current) ? a.current : a.state;
  await run(env.DB, `UPDATE stock_line SET app = ?2, state = ?3, item = ?4, store_qty = ?5, store_unit = ?6, unit_cost = ?7, note = ?8,
      received = COALESCE(?9, received), received_by = COALESCE(?10, received_by), received_at = COALESCE(?11, received_at), updated_at = ?12 WHERE line_id = ?1`,
  lineId, app, state, a.item?.name ?? null, a.qty ?? null, a.item?.unit ?? null, a.unitCost ?? null, a.reason ?? null,
  a.received ?? null, a.receivedBy ?? null, a.receivedAt ?? null, at);
}

/**
 * Read Odoo and act: new lines offered to the stores, cancelled POs taken
 * back, deliveries on their way checked, and the to-dos that follow raised or
 * closed. Returns what it did, or why it did nothing.
 */
export async function syncStock(env, { now = Date.now() } = {}) {
  const s = await feedSettings(env);
  const at = stampOf(now);
  const today = at.slice(0, 10);
  if (!s.from) return { skipped: 'No first day is set.' };
  if (s.from > today) return { skipped: `Starts with POs confirmed on ${s.from}.` };
  const source = await odooSource(env);
  if (!source?.token) return { skipped: 'Odoo is not linked.' };

  const said = {};
  const counts = { read: 0, offered: 0, placed: 0, asked: 0, cancelled: 0 };
  const knownPos = (await all(env.DB, "SELECT DISTINCT po_id FROM stock_line WHERE state NOT IN ('cancelled', 'none') AND po_id IS NOT NULL")).map((r) => Number(r.po_id));
  let lines;
  try {
    lines = await stockPoLines({ ...source, since: s.from, ids: knownPos, fetchImpl: io.fetch });
  } catch (err) {
    const error = String(err?.message || err).slice(0, 300);
    await setSetting(env.DB, 'stock_feed_last', JSON.stringify({ at, error }));
    return { skipped: `Odoo could not be read: ${error}` };
  }
  counts.read = lines.length;
  const have = new Map((await all(env.DB, 'SELECT * FROM stock_line')).map((r) => [Number(r.line_id), r]));
  const notStock = new Set((await all(env.DB, 'SELECT product_id, uom_id FROM stock_product')).map((r) => keyOf(r.product_id, r.uom_id)));

  const toOffer = [];
  const toCancel = { breakfast: [], maintenance: [] };
  for (const l of lines) {
    const row = have.get(l.lineId);
    if (l.poState === 'cancel') {
      if (!row) continue;
      if (row.app && toCancel[row.app] && PLACED.includes(row.state)) toCancel[row.app].push(l.lineId);
      else if (!['cancelled', 'none', 'kept'].includes(row.state)) await run(env.DB, "UPDATE stock_line SET state = 'cancelled', updated_at = ?2 WHERE line_id = ?1", l.lineId, at); // eslint-disable-line no-await-in-loop
      continue;
    }
    if (!l.confirmedOn || l.confirmedOn < s.from) continue;
    if (!row) {
      // eslint-disable-next-line no-await-in-loop
      await run(env.DB, `INSERT INTO stock_line (line_id, po, po_id, supplier, confirmed_on, product_id, uom_id, product, uom, qty, price, state, first_seen, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'new', ?12, ?12)`, l.lineId, l.po, l.poId, l.supplier, l.confirmedOn, l.productId, l.uomId, l.product, l.uom, l.qty, l.priceUnit, at);
    } else if (!['new', 'ask', 'waiting'].includes(row.state)) continue;
    if (notStock.has(keyOf(l.productId, l.uomId))) {
      await run(env.DB, "UPDATE stock_line SET app = 'none', state = 'none', note = NULL, updated_at = ?2 WHERE line_id = ?1", l.lineId, at); // eslint-disable-line no-await-in-loop
      continue;
    }
    let qty = l.qty;
    if (s.mode === 'odoo') {
      const full = l.received > 0 && (l.received >= l.qty || l.poState === 'done');
      if (!full) {
        await run(env.DB, "UPDATE stock_line SET state = 'waiting', note = 'Not received in Odoo yet', updated_at = ?2 WHERE line_id = ?1", l.lineId, at); // eslint-disable-line no-await-in-loop
        continue;
      }
      qty = l.received;
    }
    toOffer.push({ ...l, qty });
  }

  // Offer: the breakfast store first; what it does not take, to Maintenance.
  counts.offered = toOffer.length;
  const answers = new Map(toOffer.map((l) => [l.lineId, {}]));
  let rest = toOffer;
  const mode = s.mode === 'odoo' ? 'odoo' : s.mode;
  for (const app of APPS) {
    if (!rest.length) break;
    let res = null;
    try { res = await offerTo(env, app, mode, rest); said[app] = 'ok'; } catch (err) { said[app] = String(err?.message || err).slice(0, 200); }
    const next = [];
    for (const l of rest) {
      const a = res?.[l.lineId] || res?.[String(l.lineId)];
      answers.get(l.lineId)[app] = a || { state: 'error' };
      if (a && PLACED.includes(a.state)) {
        await saveAnswer(env, l.lineId, app, a, at); // eslint-disable-line no-await-in-loop
        counts.placed += 1;
      } else if (a?.state === 'refused') {
        // Its store, but it cannot take it now (a closed period): tried again next time, there.
        await run(env.DB, 'UPDATE stock_line SET app = ?2, state = \'waiting\', note = ?3, updated_at = ?4 WHERE line_id = ?1', l.lineId, app, a.reason || `The ${STORES[app]} could not take it just now.`, at); // eslint-disable-line no-await-in-loop
      } else next.push(l);
    }
    rest = next;
  }
  for (const l of rest) {
    const a = answers.get(l.lineId);
    const failed = APPS.filter((app) => !a[app] || a[app].state === 'error');
    let state;
    let note = null;
    if (failed.length) { state = 'waiting'; note = `Not read just now: ${failed.map((x) => STORES[x]).join(' and ')}`; }
    else if (APPS.every((app) => a[app].state === 'ignored')) state = 'none';
    else { state = 'ask'; counts.asked += 1; }
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, 'UPDATE stock_line SET state = ?2, app = ?3, note = ?4, updated_at = ?5 WHERE line_id = ?1', l.lineId, state, state === 'none' ? 'none' : null, note, at);
  }

  // Cancelled in Odoo: each store takes back what it can.
  for (const app of APPS) {
    if (!toCancel[app].length) continue;
    let res = null;
    try { res = await lineCall(env, app, 'cancel', toCancel[app]); said[app] = said[app] || 'ok'; } catch (err) { said[app] = String(err?.message || err).slice(0, 200); continue; }
    for (const id of toCancel[app]) {
      const a = res[id] || res[String(id)];
      if (!a) continue;
      const state = a.state === 'kept' ? 'kept' : 'cancelled';
      await run(env.DB, 'UPDATE stock_line SET state = ?2, note = ?3, updated_at = ?4 WHERE line_id = ?1', id, state, a.reason || null, at); // eslint-disable-line no-await-in-loop
      counts.cancelled += 1;
    }
  }

  // On its way: what each store says now.
  for (const app of APPS) {
    const ids = (await all(env.DB, "SELECT line_id FROM stock_line WHERE app = ?1 AND state IN ('expected', 'already')", app)).map((r) => Number(r.line_id)); // eslint-disable-line no-await-in-loop
    if (!ids.length) continue;
    let res = null;
    try { res = await lineCall(env, app, 'status', ids); said[app] = said[app] || 'ok'; } catch (err) { said[app] = String(err?.message || err).slice(0, 200); continue; }
    for (const id of ids) {
      const a = res[id] || res[String(id)];
      if (!a || a.state === 'missing') continue;
      await saveAnswer(env, id, app, a, at); // eslint-disable-line no-await-in-loop
    }
  }

  const todos = await syncStockTodos(env, { today, at, askTo: s.askTo });
  await setSetting(env.DB, 'stock_feed_last', JSON.stringify({ at, said, counts }));
  return { ok: true, said, counts, todos };
}

// ------------------------------------------------------------------ to-dos --

/** What needs a person, from the lines as they are now: raised, kept up to date, or closed. */
export async function syncStockTodos(env, { today, at, askTo }) {
  const rows = await all(env.DB, "SELECT * FROM stock_line WHERE state IN ('ask', 'received', 'expected', 'kept') ORDER BY confirmed_on, line_id");
  const wanted = new Map();
  for (const r of rows) {
    if (r.state === 'ask') {
      const key = `stockmatch:${keyOf(r.product_id, r.uom_id)}`;
      const t = wanted.get(key) || {
        kind: 'stockmatch', ref: r.product, day: r.confirmed_on, amount: 0,
        detail: { productId: Number(r.product_id), uomId: Number(r.uom_id) || 0, product: r.product, uom: r.uom, supplier: r.supplier, lines: [] },
      };
      t.amount += Math.round(Number(r.qty) * Number(r.price) * 100);
      t.detail.lines.push({ po: r.po, supplier: r.supplier, qty: r.qty, price: r.price, confirmedOn: r.confirmed_on });
      wanted.set(key, t);
    } else if (r.state === 'received' && r.received != null && r.store_qty != null && Number(r.received) < Number(r.store_qty) - 1e-9) {
      wanted.set(`stockshort:${r.line_id}`, {
        kind: 'stockshort', ref: r.po, day: r.confirmed_on, amount: Math.round((Number(r.store_qty) - Number(r.received)) * Number(r.unit_cost || 0) * 100),
        detail: { po: r.po, supplier: r.supplier, app: r.app, item: r.item || r.product, unit: r.store_unit || '', expected: Number(r.store_qty), received: Number(r.received), by: r.received_by, at: r.received_at },
      });
    } else if (r.state === 'expected' && String(r.first_seen).slice(0, 10) <= addDays(today, -LATE_DAYS)) {
      const key = `stocklate:${r.po_id}:${r.app}`;
      const t = wanted.get(key) || {
        kind: 'stocklate', ref: r.po, day: r.confirmed_on, amount: 0,
        detail: { po: r.po, supplier: r.supplier, app: r.app, since: String(r.first_seen).slice(0, 10), lines: [] },
      };
      t.amount += Math.round(Number(r.qty) * Number(r.price) * 100);
      t.detail.lines.push({ item: r.item || r.product, qty: r.store_qty, unit: r.store_unit || '' });
      wanted.set(key, t);
    } else if (r.state === 'kept') {
      wanted.set(`stockkept:${r.line_id}`, {
        kind: 'stockkept', ref: r.po, day: r.confirmed_on, amount: Math.round(Number(r.qty) * Number(r.price) * 100),
        detail: { po: r.po, supplier: r.supplier, app: r.app, item: r.item || r.product, qty: r.store_qty, unit: r.store_unit || '', reason: r.note },
      });
    }
  }
  const existing = await all(env.DB, `SELECT * FROM money_todo WHERE kind IN (${KINDS.map((k) => `'${k}'`).join(', ')})`);
  let closed = 0;
  for (const t of existing) {
    const w = wanted.get(t.key);
    if (w) {
      if (t.state !== 'closed') await run(env.DB, 'UPDATE money_todo SET detail = ?2, amount = ?3 WHERE id = ?1', t.id, JSON.stringify(w.detail), w.amount); // eslint-disable-line no-await-in-loop
      continue;
    }
    if (t.state === 'closed') continue;
    const why = {
      stockmatch: 'Its store is known now.',
      stocklate: 'Received in the store, or cancelled.',
      stockshort: 'Put right.',
      stockkept: 'Put right.',
    }[t.kind];
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, "UPDATE money_todo SET state = 'closed', closed_by = 'Insight', closed_at = ?2, closed_why = ?3 WHERE id = ?1", t.id, at, why);
    closed += 1;
  }
  const have = new Set(existing.map((t) => t.key));
  const person = askTo ? (await helpers(env)).find((p) => Number(p.id) === Number(askTo)) || null : null;
  let raised = 0;
  for (const [key, t] of wanted) {
    if (have.has(key)) continue;
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, `INSERT INTO money_todo (key, kind, ref, day, amount, detail, opened_at, assignee_id, assignee_name)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`, key, t.kind, t.ref, t.day, t.amount, JSON.stringify(t.detail), at, person?.id ?? null, person ? (person.name || person.email) : null);
    raised += 1;
    const d = t.detail;
    const text = t.kind === 'stockmatch' ? [`Which store is ${t.ref}?`, `On ${d.lines.map((l) => l.po).join(', ')} from ${d.supplier || 'a supplier'}. Answer once; every later PO with it goes there too.`]
      : t.kind === 'stockshort' ? [`${t.ref}: ${d.item} came in short`, `${d.received} of ${d.expected} ${d.unit} received in the ${STORES[d.app]}.`]
        : t.kind === 'stocklate' ? [`${t.ref} not received after ${LATE_DAYS} days`, `${d.supplier || 'The supplier'}: still on its way in the ${STORES[d.app]}.`]
          : [`${t.ref} cancelled, but its stock stayed`, `${d.item} in the ${STORES[d.app]}: ${d.reason || 'correct it there'}.`];
    if (person) await tell(env, { to: [person.id], kind: 'insight_stock', title: text[0], body: text[1], link: '#/inbox', key: `stock:${key}` }).catch(() => {}); // eslint-disable-line no-await-in-loop
  }
  if (!person && raised) await shareOut(env);
  return { raised, closed };
}

// --------------------------------------------------------- which store? --

/** A store's items, to choose from. */
export async function storeItems(env, app, account) {
  mustHelp(account);
  if (!APPS.includes(app)) throw badRequest('No such store.');
  try {
    const res = await askStore(env, app, { action: 'items' });
    return { ok: true, items: res.items || [] };
  } catch (err) {
    throw badRequest(`The ${STORES[app]} could not be read: ${String(err?.message || err).slice(0, 200)}`);
  }
}

/**
 * "Which store?" answered: written into that store's list (and the other told
 * it is not theirs), or remembered as not stock; then its lines go there.
 */
export async function matchProduct(env, body, account, { now = Date.now() } = {}) {
  mustHelp(account);
  const at = stampOf(now);
  const productId = Number(body?.productId);
  const uomId = Number(body?.uomId) || 0;
  if (!Number.isInteger(productId) || productId <= 0) throw badRequest('Which Odoo product?');
  const rows = await all(env.DB, 'SELECT * FROM stock_line WHERE product_id = ?1 AND uom_id = ?2 ORDER BY line_id', productId, uomId);
  const sample = rows[0];
  if (!sample) throw badRequest('Insight has not seen that product on a PO.');
  const app = String(body?.app || '');
  if (app === 'none') {
    await run(env.DB, 'INSERT OR REPLACE INTO stock_product (product_id, uom_id, product, by_name, at) VALUES (?1, ?2, ?3, ?4, ?5)', productId, uomId, sample.product, who(account), at);
    await run(env.DB, "UPDATE stock_line SET app = 'none', state = 'none', note = ?3, updated_at = ?4 WHERE product_id = ?1 AND uom_id = ?2 AND state IN ('ask', 'waiting', 'new')", productId, uomId, `Not stock (${who(account)})`, at);
    await closeMatch(env, productId, uomId, `Not stock, said ${who(account)}.`, at);
    return { ok: true, app: 'none', placed: 0 };
  }
  if (!APPS.includes(app)) throw badRequest('Choose the breakfast store, the Maintenance store, or Not stock.');
  const factor = body?.factor === undefined || body?.factor === '' ? 1 : Number(body.factor);
  if (!Number.isFinite(factor) || factor <= 0) throw badRequest('How many of the store’s unit is one Odoo unit? A number above 0.');
  const itemId = body?.itemId === undefined || body?.itemId === null || body?.itemId === '' ? null : body.itemId;
  const newName = str(body?.newItem?.name, 'the new item’s name', { max: 120 });
  const newUnit = str(body?.newItem?.unit, 'the new item’s unit', { max: 30 });
  if (itemId == null && !newName) throw badRequest('Choose the item, or name a new one.');
  const map = { action: 'map', productId, uomId, product: sample.product, uom: sample.uom, factor, ignore: false, ...(itemId != null ? { itemId } : { newItem: { name: newName, unit: newUnit || '' } }) };
  let item;
  try {
    item = (await askStore(env, app, map)).item || null;
  } catch (err) {
    throw badRequest(`The ${STORES[app]} did not take it: ${String(err?.message || err).slice(0, 200)}`);
  }
  // The other store is told it is not theirs, so it is not asked again there either.
  const other = APPS.find((x) => x !== app);
  await askStore(env, other, { action: 'map', productId, uomId, product: sample.product, uom: sample.uom, ignore: true }).catch(() => {});

  // Its lines, now: offered to that store.
  const s = await feedSettings(env);
  const waiting = rows.filter((r) => ['ask', 'waiting', 'new'].includes(r.state));
  let placed = 0;
  if (waiting.length) {
    const lines = waiting.map((r) => ({ lineId: Number(r.line_id), po: r.po, poId: r.po_id, supplier: r.supplier, confirmedOn: r.confirmed_on, productId, uomId, product: r.product, uom: r.uom, qty: Number(r.qty), priceUnit: Number(r.price) }));
    let res = {};
    try { res = await offerTo(env, app, s.mode === 'odoo' ? 'odoo' : s.mode, lines); } catch { res = {}; }
    for (const l of lines) {
      const a = res[l.lineId] || res[String(l.lineId)];
      if (a && PLACED.includes(a.state)) { await saveAnswer(env, l.lineId, app, a, at); placed += 1; } // eslint-disable-line no-await-in-loop
      else await run(env.DB, "UPDATE stock_line SET state = 'waiting', note = ?2, updated_at = ?3 WHERE line_id = ?1", l.lineId, `Sent to the ${STORES[app]}; it is offered again on the next read.`, at); // eslint-disable-line no-await-in-loop
    }
  }
  await closeMatch(env, productId, uomId, `Goes to the ${STORES[app]}${item?.name ? ` as ${item.name}` : ''} (${who(account)}).`, at);
  return { ok: true, app, item, placed };
}

async function closeMatch(env, productId, uomId, why, at) {
  await run(env.DB, "UPDATE money_todo SET state = 'closed', closed_by = ?2, closed_at = ?3, closed_why = ?4 WHERE key = ?1 AND state != 'closed'",
    `stockmatch:${keyOf(productId, uomId)}`, 'Insight', at, why);
}

// ------------------------------------------------------------------- page --

/** Buying › Stock from Odoo: the settings, what came through lately, and how each line went. */
export async function overview(env, account, { days = 14, now = Date.now() } = {}) {
  mustAdmin(account);
  const s = await feedSettings(env);
  const today = stampOf(now).slice(0, 10);
  const since = addDays(today, -Math.max(1, Math.min(90, Number(days) || 14)));
  const week = addDays(today, -6);
  const lines = await all(env.DB, 'SELECT * FROM stock_line WHERE confirmed_on >= ?1 OR state IN (\'ask\', \'expected\', \'waiting\', \'kept\') ORDER BY confirmed_on DESC, po_id DESC, line_id LIMIT 600', since);
  const inWeek = (r) => String(r.confirmed_on || '') >= week;
  const value = (xs) => round2(xs.reduce((t, r) => t + Number(r.qty || 0) * Number(r.price || 0), 0));
  const into = (app) => lines.filter((r) => r.app === app && ['recorded', 'received', 'already', 'expected'].includes(r.state) && inWeek(r));
  const pos = [];
  const byPo = new Map();
  for (const r of lines) {
    const k = `${r.po_id}`;
    if (!byPo.has(k)) { byPo.set(k, { po: r.po, supplier: r.supplier, confirmedOn: r.confirmed_on, total: 0, lines: [] }); pos.push(byPo.get(k)); }
    const p = byPo.get(k);
    p.total = round2(p.total + Number(r.qty || 0) * Number(r.price || 0));
    p.lines.push({
      lineId: Number(r.line_id), product: r.product, uom: r.uom, qty: Number(r.qty), price: Number(r.price), app: r.app, state: r.state,
      item: r.item, storeQty: r.store_qty, storeUnit: r.store_unit, unitCost: r.unit_cost, received: r.received, receivedBy: r.received_by, receivedAt: r.received_at, note: r.note,
    });
  }
  let last = null;
  try { last = JSON.parse((await first(env.DB, "SELECT value FROM settings WHERE key = 'stock_feed_last'"))?.value || 'null'); } catch { last = null; }
  const askTo = s.askTo ? (await helpers(env)).find((p) => Number(p.id) === s.askTo) || null : null;
  return {
    settings: s, modes: MODES, people: (await helpers(env)).map((p) => ({ id: p.id, name: p.name || p.email, role: p.role })),
    askTo: askTo ? { id: askTo.id, name: askTo.name || askTo.email } : null,
    last,
    tiles: {
      onTheWay: lines.filter((r) => r.state === 'expected').length,
      breakfast: { lines: into('breakfast').length, value: value(into('breakfast')) },
      maintenance: { lines: into('maintenance').length, value: value(into('maintenance')) },
      ask: new Set(lines.filter((r) => r.state === 'ask').map((r) => keyOf(r.product_id, r.uom_id))).size,
      none: lines.filter((r) => r.state === 'none' && inWeek(r)).length,
    },
    pos,
  };
}

/** Read Odoo now (an admin pressed it): the same as every 15 minutes. */
export async function runNow(env, account) {
  mustAdmin(account);
  const out = await syncStock(env);
  return { ...(await overview(env, account)), ran: out };
}
