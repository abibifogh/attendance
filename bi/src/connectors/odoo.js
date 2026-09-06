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
 * Read-only by construction: `search_read` is the only method called anywhere
 * in this file, and there is no code path that writes. That is not a promise
 * in a comment — it is the whole of the surface.
 */
export function odooConfig(source, env) {
  const config = source?.config || {};
  const base = String(config.base || '').replace(/\/+$/, '');
  return {
    base,
    db: config.db || '',
    // How Odoo says which part of the business a cost belongs to. Set by an
    // owner, because only they know how their chart is arranged.
    lineBy: config.lineBy || 'analytic',
    lineMap: config.lineMap || {},
    key: env?.[config.secretName || 'ODOO_API_KEY'] || '',
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
    if (err?.name === 'AbortError') throw new Error(`Odoo did not answer in time reading ${model}.`);
    throw new Error(`Odoo could not be reached: ${String(err?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Odoo refused the API key. Check it, and that the user it belongs to may read accounting.');
  }
  if (response.status === 404) {
    throw new Error(`Odoo has no ${model} model, or the address is wrong. Check the Odoo address in Setup.`);
  }
  if (!response.ok) {
    let detail = '';
    try { detail = JSON.stringify(await response.json()).slice(0, 300); } catch { /* body already gone */ }
    throw new Error(`Odoo answered ${response.status} reading ${model}. ${detail}`);
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

export async function pull({ source, env, from, to, fetchImpl = fetch }) {
  const bundle = emptyBundle();
  const config = odooConfig(source, env);
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
    'amount_total', 'amount_residual', 'currency_id', 'journal_id',
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
  const moveIds = moves.map((m) => m.id);
  const lines = moveIds.length ? await searchRead(config, 'account.move.line', [
    ['move_id', 'in', moveIds],
    ['display_type', '=', false],
    ['product_id', '!=', false],
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

  for (const bill of bundle.bills) {
    bill.fromOrder = withOrder.has(Number(bill.externalId));
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
export async function check({ source, env, fetchImpl = fetch }) {
  const config = odooConfig(source, env);
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
