import { emptyBundle } from './bundle.js';
import { toMinor } from '../lib/money.js';

/**
 * Odoo, read over its External JSON-2 API.
 *
 * What this system uniquely knows: what the business was actually *invoiced*.
 * Every other source here records what somebody inside the business typed —
 * the kitchen booking in a delivery, the bar counting a shelf. Odoo carries
 * documents that came from outside and were approved, and the books that
 * followed from them.
 *
 * That difference is the whole reason to read it. "The kitchen recorded
 * forty crates of eggs and the supplier invoiced for forty-four" is a question
 * no single system in this group could ask, because each of them only holds
 * one side of it.
 *
 * ---------------------------------------------------------------------------
 *
 * The JSON-2 API, which is Odoo 19's and replaces the older /jsonrpc:
 *
 *   POST https://<host>/json/2/<model>/<method>
 *   Authorization: bearer <api key>
 *   Content-Type: application/json
 *   X-Odoo-Database: <db>        (only where one domain serves several)
 *
 *   { "domain": [...], "fields": [...], "limit": 500, "offset": 0,
 *     "order": "id", "context": { ... } }
 *
 * Arguments are named. There are no positional arguments in JSON-2, which is
 * the main thing that differs from every older example on the internet.
 *
 * The old `/jsonrpc` and `/xmlrpc/2` endpoints are scheduled for removal —
 * Odoo Online 21.1, winter 2027 — so this is written against the endpoint that
 * will still exist rather than the one most tutorials show.
 */

/** Odoo's page size here. Large enough to be few round trips, small enough to fit a Worker's memory. */
const PAGE = 500;

/** And a ceiling, so a misconfigured window cannot try to read a decade. */
const MAX_PAGES = 40;

/**
 * Everything this connector reads.
 *
 * Read-only, with one exception kept at the bottom of this file: Create PO
 * makes a draft purchase order and attaches its receipt (`create` on
 * purchase.order and ir.attachment, nothing else). Nothing here ever writes
 * to, confirms or deletes a record that already exists.
 */
/**
 * The connector's own view of its settings.
 *
 * Takes the same `(config, token)` every other connector here takes. It used
 * to take `(source, env)` and dig the key out of the environment itself —
 * which read well in its own tests, and could never work: the registry hands
 * every connector `{ config, token }`, so both arguments arrived undefined,
 * the address came out empty, and Odoo failed every check and every load with
 * an error about the address. Nothing typed into Setup could have fixed it.
 * The lesson is in `test/connectors.test.js`, which now dispatches every
 * registered connector through the registry rather than calling it directly.
 */
export function odooConfig(config, token) {
  const c = config || {};
  const base = String(c.base || '').replace(/\/+$/, '');
  return {
    base,
    db: c.db || '',
    // How Odoo says which part of the business a cost belongs to. Set by an
    // owner, because only they know how their chart is arranged.
    lineBy: c.lineBy || 'analytic',
    lineMap: c.lineMap || {},
    key: token || '',
  };
}

/**
 * One call.
 *
 * Errors are turned into sentences rather than passed on as objects: this runs
 * behind a Setup screen somebody is staring at, and "401" is not a thing a
 * person can act on where "the API key was refused" is.
 */
async function call(config, model, method, body, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  if (!config.base) throw new Error('No Odoo address is configured.');
  if (!config.key) throw new Error('No Odoo API key has been set on this Worker.');

  const headers = {
    Authorization: `bearer ${config.key}`,
    'Content-Type': 'application/json; charset=utf-8',
  };
  // Only where one domain serves several databases. Sending it always is
  // harmless on Odoo Online but wrong on some self-hosted setups, so it is
  // sent only when an owner said there was a choice to make.
  if (config.db) headers['X-Odoo-Database'] = config.db;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${config.base}/json/2/${model}/${method}`, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`Odoo did not answer in time (${model}, ${method}).`);
    throw new Error(`Odoo could not be reached: ${String(err?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }

  const doing = method === 'search_read' ? 'reading' : method === 'create' ? 'creating' : `calling ${method} on`;
  // What Odoo said, in its own words: JSON-2 answers an error with its name and message.
  const odooSaid = async () => {
    try {
      const body = await response.json();
      const text = body?.message || body?.error?.data?.message || body?.error?.message || JSON.stringify(body);
      return String(text).replace(/\s+/g, ' ').trim().slice(0, 400);
    } catch { return ''; }
  };
  if (response.status === 401) {
    throw new Error('Odoo refused the API key. Check it, and that the user it belongs to may read accounting.');
  }
  if (response.status === 403) {
    const said = await odooSaid();
    throw new Error(method === 'search_read' && !said
      ? 'Odoo refused the API key. Check it, and that the user it belongs to may read accounting.'
      : `Odoo did not allow ${doing} ${model}${said ? `: ${said}` : '.'}`);
  }
  if (response.status === 404) {
    throw new Error(`Odoo has no ${model} model, or the address is wrong. Check the Odoo address in Setup.`);
  }
  if (!response.ok) {
    const said = await odooSaid();
    throw new Error(`Odoo answered ${response.status} ${doing} ${model}${said ? `: ${said}` : '.'}`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`Odoo answered with something unreadable reading ${model}.`);
  }
}

/**
 * Every record matching a domain, a page at a time.
 *
 * Ordered by id rather than by date: a stable order is what makes paging
 * correct. Ordering by a date with ties means a record can appear on two pages
 * or on none, and a purchase that silently vanishes from a report is worse
 * than one that was never read.
 */
export async function searchRead(config, model, domain, fields, opts = {}) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await call(config, model, 'search_read', {
      domain,
      fields,
      limit: PAGE,
      offset: page * PAGE,
      order: 'id',
    }, opts);
    const list = Array.isArray(rows) ? rows : (rows?.records ?? []);
    out.push(...list);
    if (list.length < PAGE) return out;
  }
  return out;
}

/**
 * Odoo returns a many2one as `[id, "Display Name"]`, or `false` when unset.
 *
 * `false` rather than null is an Odoo idiom that catches everybody once: it is
 * falsy, so `row.partner_id[0]` on an unset field throws rather than returning
 * nothing.
 */
const refId = (value) => (Array.isArray(value) ? value[0] : null);
const refName = (value) => (Array.isArray(value) ? String(value[1] ?? '') : '');

/**
 * Which part of the business a cost belongs to.
 *
 * Odoo does not know about "the bar" and "the laundry"; it knows about
 * analytic accounts, or product categories, or whatever the property happens
 * to use. So the mapping is configuration, set by an owner who can see their
 * own chart, and anything unmapped lands in 'admin' — deliberately visible as
 * an unexplained lump rather than spread quietly across the lines that earn.
 */
export function lineFor(config, { analytic, category, journal }) {
  const map = config.lineMap || {};
  const candidates = config.lineBy === 'category'
    ? [category, analytic, journal]
    : [analytic, category, journal];

  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (!text) continue;
    if (map[text]) return map[text];
    // Case-insensitively too, because a chart of accounts is typed by people.
    const hit = Object.keys(map).find((k) => k.toLowerCase() === text.toLowerCase());
    if (hit) return map[hit];
  }
  return 'admin';
}

/** Odoo's account types, reduced to the five this warehouse cares about. */
export function accountKind(type) {
  const text = String(type || '');
  if (text.startsWith('expense')) return 'expense';
  if (text.startsWith('income')) return 'income';
  if (text.startsWith('asset')) return 'asset';
  if (text.startsWith('liability')) return 'liability';
  if (text.startsWith('equity')) return 'equity';
  return '';
}

export async function pull({ config: settings, token, from, to, fetchImpl = fetch }) {
  const bundle = emptyBundle();
  const config = odooConfig(settings, token);
  const opts = { fetchImpl };

  // Bills, at the accounting date rather than the entry date. A bill keyed in
  // three weeks late still belongs to its own month, and reporting it in the
  // month somebody got round to it turns a good month into a bad one for a
  // reason nobody can find.
  //
  // Vendor bills and vendor credit notes both. A credit note is a purchase
  // that un-happened, and leaving it out overstates every supplier total.
  const moves = await searchRead(config, 'account.move', [
    ['move_type', 'in', ['in_invoice', 'in_refund']],
    ['invoice_date', '>=', from],
    ['invoice_date', '<=', to],
    ['state', '!=', 'cancel'],
  ], [
    'id', 'name', 'ref', 'invoice_date', 'invoice_date_due', 'partner_id',
    'move_type', 'state', 'payment_state', 'amount_untaxed', 'amount_tax',
    'amount_total', 'amount_residual', 'currency_id', 'journal_id', 'invoice_origin',
  ], opts);

  // A refund is a negative purchase. Odoo stores its amounts positive and
  // distinguishes it by move_type, so the sign is applied here rather than
  // left for every reader downstream to remember.
  const signOf = (move) => (move.move_type === 'in_refund' ? -1 : 1);

  const billLine = new Map();

  for (const move of moves) {
    const supplier = refName(move.partner_id) || 'Unknown supplier';
    const sign = signOf(move);
    const line = lineFor(config, { journal: refName(move.journal_id) });
    billLine.set(move.id, line);

    bundle.bills.push({
      externalId: String(move.id),
      day: move.invoice_date,
      dueDay: move.invoice_date_due || null,
      supplier,
      line,
      // Odoo's own document number is `name`; the supplier's is `ref`. Only
      // the second can spot the same invoice entered twice.
      vendorRef: move.ref || null,
      state: move.state || '',
      paymentState: move.payment_state || '',
      untaxed: sign * toMinor(move.amount_untaxed),
      tax: sign * toMinor(move.amount_tax),
      total: sign * toMinor(move.amount_total),
      residual: sign * toMinor(move.amount_residual),
      currency: refName(move.currency_id),
      fromOrder: false,   // set below, once the lines are known
    });
  }

  // The lines. Product lines only: a bill also carries tax lines and the
  // balancing payable line, and counting those as purchases would double every
  // total and invent a supplier called "Accounts Payable".
  //
  // Odoo 16 and later mark a bill's ordinary lines `display_type = 'product'`
  // (tax, payable, section and note lines have types of their own), and the
  // JSON-2 API this reads is only on those versions. Before 16 the type was
  // empty for every line, product or tax, and only `product_id` told them
  // apart. Asking for `false` alone, as this once did, returns nothing at all
  // from a current Odoo: no costs from the books, and every bill read as
  // having no PO.
  const moveIds = moves.map((m) => m.id);
  const lines = moveIds.length ? await searchRead(config, 'account.move.line', [
    ['move_id', 'in', moveIds],
    '|', ['display_type', '=', 'product'],
    '&', ['display_type', '=', false], ['product_id', '!=', false],
  ], [
    'id', 'move_id', 'product_id', 'name', 'quantity', 'price_unit',
    'price_subtotal', 'price_total', 'account_id', 'product_uom_id',
    'analytic_distribution', 'purchase_line_id', 'date',
  ], opts) : [];

  const moveById = new Map(moves.map((m) => [m.id, m]));
  const withOrder = new Set();
  const accounts = new Map();

  for (const row of lines) {
    const move = moveById.get(refId(row.move_id));
    if (!move) continue;
    const sign = signOf(move);
    if (row.purchase_line_id) withOrder.add(move.id);

    const accountCode = refName(row.account_id).split(' ')[0] || '';
    if (accountCode) accounts.set(accountCode, refName(row.account_id));

    bundle.purchaseLines.push({
      day: move.invoice_date,
      externalId: `${move.id}:${row.id}`,
      billId: String(move.id),
      line: lineFor(config, {
        analytic: analyticName(row.analytic_distribution),
        journal: refName(move.journal_id),
      }) || billLine.get(move.id),
      supplierName: refName(move.partner_id) || 'Unknown supplier',
      itemName: refName(row.product_id) || row.name || 'Unnamed',
      qty: sign * (Number(row.quantity) || 0),
      unit: refName(row.product_uom_id) || null,
      // Odoo's price_unit excludes tax, which is the right basis for comparing
      // what two parts of the group paid for the same thing.
      unitCost: toMinor(row.price_unit),
      amount: sign * toMinor(row.price_subtotal),
      tax: sign * toMinor((Number(row.price_total) || 0) - (Number(row.price_subtotal) || 0)),
      accountCode: accountCode || null,
    });
  }

  // A bill made from a PO carries the PO's name as its origin as well as on
  // its lines; either is enough.
  const origin = new Map(moves.map((m) => [m.id, String(m.invoice_origin || '').trim()]));
  for (const bill of bundle.bills) {
    const id = Number(bill.externalId);
    bill.fromOrder = withOrder.has(id) || /^P\d+/i.test(origin.get(id) || '');
  }

  for (const [code, name] of accounts) {
    bundle.accounts.push({ code, name, kind: '' });
  }

  bundle.notes.push(
    `${moves.length} bills, ${lines.length} lines`
    + (moves.length >= PAGE * MAX_PAGES ? ' — and more than this window can read at once' : ''),
  );
  return bundle;
}

/**
 * The first analytic account on a line.
 *
 * Odoo 17 onwards stores this as a distribution — `{"3": 100.0}` — so one line
 * can be split across several. Only the largest share is taken: splitting a
 * single purchase line across two business lines would be more faithful and
 * would also mean no unit price could ever be compared with another, which is
 * the whole point of keeping lines.
 */
export function analyticName(distribution) {
  if (!distribution || typeof distribution !== 'object') return '';
  let best = null;
  let bestShare = -1;
  for (const [id, share] of Object.entries(distribution)) {
    const value = Number(share) || 0;
    if (value > bestShare) { bestShare = value; best = id; }
  }
  return best == null ? '' : String(best);
}

/**
 * Can this source answer at all?
 *
 * Asked before a run rather than discovered during one, so a Setup screen can
 * say "the key is wrong" instead of a dashboard saying the business stopped
 * buying anything.
 */
export async function check({ config: settings, token, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  try {
    const rows = await searchRead(config, 'res.company', [], ['id', 'name', 'currency_id'],
      { fetchImpl, timeoutMs: 10_000 });
    const company = rows[0];
    if (!company) return { ok: false, detail: 'The API key works, but it can see no company.' };
    return {
      ok: true,
      detail: `Connected to ${company.name} (${refName(company.currency_id) || 'no currency set'}).`,
    };
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) };
  }
}

/**
 * Purchase orders by their names (`P00412`), for the shift expense check.
 *
 * Read-only, like everything else here: one `search_read` on `purchase.order`.
 * Returns what the shift screen shows — vendor, total, state and whether it
 * has been billed — and lists the names Odoo did not recognise, so a typo in
 * a PO number is said out loud rather than read as "no expense".
 */
export async function purchaseOrders({ config: settings, token, names, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  const wanted = [...new Set((names || []).map((n) => String(n).trim()).filter(Boolean))];
  if (!wanted.length) return { orders: [], unknown: [] };
  const rows = await searchRead(config, 'purchase.order', [['name', 'in', wanted]],
    ['name', 'partner_id', 'amount_total', 'state', 'invoice_status', 'date_order'], { fetchImpl });
  const orders = rows.map((r) => ({
    name: String(r.name || ''),
    vendor: refName(r.partner_id),
    total: toMinor(r.amount_total),
    state: String(r.state || ''),
    billed: String(r.invoice_status || ''),
    orderedOn: r.date_order ? String(r.date_order).slice(0, 10) : null,
  }));
  const found = new Set(orders.map((o) => o.name.toUpperCase()));
  return { orders, unknown: wanted.filter((n) => !found.has(n.toUpperCase())) };
}

/**
 * Confirmed purchase orders dated on or after a day, for the safe book's
 * "paid from the safe?" list. Read-only, the same one `search_read`.
 */
export async function purchaseOrdersSince({ config: settings, token, since, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  const rows = await searchRead(config, 'purchase.order',
    [['date_order', '>=', `${since} 00:00:00`], ['state', 'in', ['purchase', 'done']]],
    ['name', 'partner_id', 'amount_total', 'state', 'date_order'], { fetchImpl });
  return rows.map((r) => ({
    name: String(r.name || ''),
    vendor: refName(r.partner_id),
    total: toMinor(r.amount_total),
    state: String(r.state || ''),
    orderedOn: r.date_order ? String(r.date_order).slice(0, 10) : null,
  }));
}

/**
 * Purchase orders paid in cash, with whether each has been billed and what it
 * bought by part of the business. Three read-only `search_read`s: the orders,
 * their bills, and the order lines of those not billed yet (whose cost has to
 * be placed somewhere until a bill places it).
 */
export async function cashPoDetails({ config: settings, token, names, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  const wanted = [...new Set((names || []).map((n) => String(n).trim()).filter(Boolean))];
  const orders = [];
  for (let i = 0; i < wanted.length; i += 80) {
    // eslint-disable-next-line no-await-in-loop
    orders.push(...await searchRead(config, 'purchase.order', [['name', 'in', wanted.slice(i, i + 80)]],
      ['id', 'name', 'partner_id', 'amount_total', 'state', 'date_order', 'invoice_ids'], { fetchImpl }));
  }
  const billIds = [...new Set(orders.flatMap((o) => (Array.isArray(o.invoice_ids) ? o.invoice_ids : [])))];
  const bills = billIds.length ? await searchRead(config, 'account.move', [['id', 'in', billIds]],
    ['id', 'name', 'state', 'invoice_date'], { fetchImpl }) : [];
  const billById = new Map(bills.map((b) => [b.id, b]));
  const out = orders.map((o) => {
    const own = (Array.isArray(o.invoice_ids) ? o.invoice_ids : []).map((id) => billById.get(id)).filter(Boolean)
      .map((b) => ({ name: String(b.name || ''), state: String(b.state || ''), day: b.invoice_date || null }));
    return {
      id: o.id,
      name: String(o.name || ''),
      vendor: refName(o.partner_id),
      total: toMinor(o.amount_total),
      state: String(o.state || ''),
      orderedOn: o.date_order ? String(o.date_order).slice(0, 10) : null,
      bills: own,
      // A cancelled bill is no bill.
      billed: own.some((b) => b.state !== 'cancel'),
      // Entered is not finished: a draft bill is still somebody's to-do.
      posted: own.some((b) => b.state === 'posted'),
      lines: [],
    };
  });
  const open = out.filter((o) => !o.billed);
  if (open.length) {
    const byId = new Map(open.map((o) => [o.id, o]));
    const rows = await searchRead(config, 'purchase.order.line', [['order_id', 'in', [...byId.keys()]]],
      ['order_id', 'price_total', 'analytic_distribution'], { fetchImpl });
    for (const r of rows) {
      const order = byId.get(refId(r.order_id));
      if (!order) continue;
      const line = lineFor(config, { analytic: analyticName(r.analytic_distribution) });
      const amount = toMinor(r.price_total);
      const have = order.lines.find((l) => l.line === line);
      if (have) have.amount += amount; else order.lines.push({ line, amount });
    }
  }
  const found = new Set(out.map((o) => o.name.toUpperCase()));
  return { orders: out, unknown: wanted.filter((n) => !found.has(n.toUpperCase())) };
}

/**
 * Every purchase order confirmed in Odoo since a day, with its bills: is one
 * entered, is one posted, which are drafts. Two read-only `search_read`s.
 */
export async function confirmedPoBills({ config: settings, token, since, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  const orders = await searchRead(config, 'purchase.order',
    [['date_order', '>=', `${since} 00:00:00`], ['state', 'in', ['purchase', 'done']]],
    ['id', 'name', 'partner_id', 'amount_total', 'state', 'date_order', 'invoice_ids'], { fetchImpl });
  const billIds = [...new Set(orders.flatMap((o) => (Array.isArray(o.invoice_ids) ? o.invoice_ids : [])))];
  const bills = [];
  for (let i = 0; i < billIds.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    bills.push(...await searchRead(config, 'account.move', [['id', 'in', billIds.slice(i, i + 200)]], ['id', 'name', 'state'], { fetchImpl }));
  }
  const billById = new Map(bills.map((b) => [b.id, b]));
  return orders.map((o) => {
    const own = (Array.isArray(o.invoice_ids) ? o.invoice_ids : []).map((id) => billById.get(id)).filter(Boolean);
    return {
      name: String(o.name || ''),
      vendor: refName(o.partner_id),
      total: toMinor(o.amount_total),
      state: String(o.state || ''),
      orderedOn: o.date_order ? String(o.date_order).slice(0, 10) : null,
      billed: own.some((b) => b.state !== 'cancel'),
      posted: own.some((b) => b.state === 'posted'),
      drafts: own.filter((b) => b.state === 'draft').map((b) => String(b.name || '')),
    };
  });
}

// ------------------------------------------------------------ activities --

/** Odoo keeps an activity's note as HTML; what a person wrote, as text. */
const plain = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .trim();

/**
 * Every activity still to do in Odoo that its read-only user may see: an
 * activity done is no longer one, so this is the open list. One `search_read`
 * on `mail.activity`, and one each on the purchase orders and bills they sit
 * on, for the supplier and the amount.
 */
export async function openActivities({ config: settings, token, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  const rows = await searchRead(config, 'mail.activity', [],
    ['res_model', 'res_id', 'res_name', 'activity_type_id', 'summary', 'note', 'date_deadline', 'user_id'], { fetchImpl });
  const brief = new Map();
  for (const model of ['purchase.order', 'account.move']) {
    const ids = [...new Set(rows.filter((r) => r.res_model === model).map((r) => r.res_id))];
    for (let i = 0; i < ids.length; i += 200) {
      // eslint-disable-next-line no-await-in-loop
      const found = await searchRead(config, model, [['id', 'in', ids.slice(i, i + 200)]], ['name', 'partner_id', 'amount_total'], { fetchImpl });
      for (const f of found) brief.set(`${model}:${f.id}`, { partner: refName(f.partner_id), amount: toMinor(f.amount_total) });
    }
  }
  return rows.map((r) => ({
    id: r.id,
    model: String(r.res_model || ''),
    resId: r.res_id ?? null,
    resName: String(r.res_name || ''),
    type: refName(r.activity_type_id),
    summary: String(r.summary || ''),
    note: plain(r.note),
    deadline: r.date_deadline ? String(r.date_deadline).slice(0, 10) : null,
    userId: refId(r.user_id),
    userName: refName(r.user_id),
    ...(brief.get(`${r.res_model}:${r.res_id}`) || { partner: null, amount: null }),
  }));
}

/**
 * Activities marked done since a day: Odoo writes each into the record's
 * history as a message carrying its activity type. One `search_read` on
 * `mail.message`. The author is a partner, not a user.
 */
export async function doneActivities({ config: settings, token, since, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  const rows = await searchRead(config, 'mail.message',
    [['mail_activity_type_id', '!=', false], ['date', '>=', `${since} 00:00:00`]],
    ['model', 'res_id', 'record_name', 'mail_activity_type_id', 'author_id', 'date'], { fetchImpl });
  return rows.map((r) => ({
    id: r.id,
    model: String(r.model || ''),
    resId: r.res_id ?? null,
    resName: String(r.record_name || ''),
    type: refName(r.mail_activity_type_id),
    partnerId: refId(r.author_id),
    doneAt: r.date ? String(r.date).slice(0, 19) : null,
  }));
}

/** Odoo's own people (not portal users): who an activity can be for. One `search_read` on `res.users`. */
export async function odooUsers({ config: settings, token, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  const rows = await searchRead(config, 'res.users', [['share', '=', false]], ['name', 'login', 'email', 'partner_id'], { fetchImpl });
  return rows.map((r) => ({ id: r.id, name: String(r.name || ''), login: String(r.login || ''), email: String(r.email || ''), partnerId: refId(r.partner_id) }));
}

// ------------------------------------------------------------- Create PO --

/**
 * What Create PO needs to fill its form: the vendors (anybody a PO has been
 * raised to; every partner if Odoo has never marked one) and the products
 * that may be bought.
 */
export async function poChoices({ config: settings, token, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  const opts = { fetchImpl };
  let vendors = await searchRead(config, 'res.partner', [['supplier_rank', '>', 0]], ['name'], opts);
  if (!vendors.length) vendors = await searchRead(config, 'res.partner', [['is_company', '=', true]], ['name'], opts);
  const products = await searchRead(config, 'product.product', [['purchase_ok', '=', true]], ['name', 'display_name'], opts);
  const byName = (a, b) => a.name.localeCompare(b.name);
  return {
    vendors: vendors.map((r) => ({ id: r.id, name: String(r.name || '').trim() })).filter((r) => r.name).sort(byName),
    products: products.map((r) => ({ id: r.id, name: String(r.display_name || r.name || '').trim() })).filter((r) => r.name).sort(byName),
  };
}

/** The vendor the last PO for a product went to, if any. */
export async function lastVendorFor({ config: settings, token, productId, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  const rows = await call(config, 'purchase.order.line', 'search_read', {
    domain: [['product_id', '=', Number(productId)], ['state', '!=', 'cancel']], fields: ['partner_id'], limit: 1, order: 'id desc',
  }, { fetchImpl });
  const row = (Array.isArray(rows) ? rows : rows?.records || [])[0];
  return row && Array.isArray(row.partner_id) ? { id: row.partner_id[0], name: refName(row.partner_id) } : null;
}

/** POs to one vendor on one day that are not cancelled: to warn of a PO raised twice. */
export async function posOnDay({ config: settings, token, vendorId, day, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  const rows = await searchRead(config, 'purchase.order', [
    ['partner_id', '=', Number(vendorId)], ['date_order', '>=', `${day} 00:00:00`], ['date_order', '<=', `${day} 23:59:59`], ['state', '!=', 'cancel'],
  ], ['name', 'amount_total', 'state', 'create_uid', 'origin'], { fetchImpl });
  return rows.map((r) => ({
    id: r.id, name: String(r.name || ''), total: toMinor(r.amount_total), state: String(r.state || ''), by: refName(r.create_uid), origin: r.origin || '',
  }));
}

/**
 * A draft purchase order (a request for quotation): one line, the product
 * and what was paid. Approving it stays in Odoo. `origin` says who made it
 * from Insight. Returns the new PO as Odoo has it, its total after any tax.
 */
export async function createDraftPo({ config: settings, token, vendorId, productId, description, amount, day, origin, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  const opts = { fetchImpl };
  const made = await call(config, 'purchase.order', 'create', {
    vals_list: [{
      partner_id: Number(vendorId),
      date_order: `${day} 12:00:00`,
      origin,
      order_line: [[0, 0, { product_id: Number(productId), name: description, product_qty: 1, price_unit: amount / 100 }]],
    }],
  }, opts);
  const id = Array.isArray(made) ? made[0] : Number(made);
  if (!Number.isInteger(id)) throw new Error('Odoo did not say which PO it made.');
  const rows = await call(config, 'purchase.order', 'search_read', {
    domain: [['id', '=', id]], fields: ['name', 'amount_total', 'state'], limit: 1,
  }, opts);
  const row = (Array.isArray(rows) ? rows : rows?.records || [])[0] || {};
  return {
    id, name: String(row.name || ''), total: row.amount_total != null ? toMinor(row.amount_total) : null, state: String(row.state || 'draft'),
    url: config.base ? `${config.base}/web#model=purchase.order&id=${id}&view_type=form` : null,
  };
}

/** A receipt kept on the PO it is for, in Odoo's attachments. */
export async function attachToPo({ config: settings, token, poId, name, mimetype, data, fetchImpl = fetch }) {
  const config = odooConfig(settings, token);
  const made = await call(config, 'ir.attachment', 'create', {
    vals_list: [{ name, datas: data, mimetype, res_model: 'purchase.order', res_id: Number(poId) }],
  }, { fetchImpl });
  return Array.isArray(made) ? made[0] : made;
}
