import { emptyBundle } from './bundle.js';
import { getJson } from './http.js';
import { HttpError } from '../lib/http.js';
import { toMinor, minor } from '../lib/money.js';

/**
 * A Supabase database, read over PostgREST.
 *
 * Supabase is Postgres with a REST API in front of it, and that API is what
 * this reads: `https://<ref>.supabase.co/rest/v1/<table>?select=…&day=gte.…`.
 * No Postgres driver, no connection pool, no TCP — which matters, because a
 * Cloudflare Worker cannot open a raw Postgres socket without a proxy, and
 * PostgREST is already there and already handles the range filtering this app
 * needs.
 *
 * The part that makes this different from the other four connectors: they each
 * know their own system's schema, because that schema is in a repository I can
 * read. A Supabase database is somebody's own Postgres and its tables are
 * whatever they made them. So this connector is **declarative** — the mapping
 * from that schema to this warehouse lives in the source's configuration, as
 * JSON, and no code changes to add a source.
 *
 * A mapping looks like this:
 *
 * ```json
 * {
 *   "base": "https://abcdefgh.supabase.co",
 *   "schema": "public",
 *   "tables": [
 *     {
 *       "fact": "revenue",
 *       "from": "daily_sales",
 *       "day": "sale_date",
 *       "line": "restaurant",
 *       "money": "major",
 *       "columns": { "net": "total", "collected": "paid", "orders": "ticket_count" }
 *     },
 *     {
 *       "fact": "demand",
 *       "from": "occupancy",
 *       "day": "night",
 *       "columns": { "inhouseGuests": "guests_in_house" }
 *     }
 *   ]
 * }
 * ```
 *
 * `money` is the field that is easiest to get wrong and most expensive to get
 * wrong: `"major"` means the column holds cedis with a decimal point and will
 * be multiplied by a hundred; `"minor"` means it already holds whole pesewas
 * and will be left alone. There is no default, because guessing here is how a
 * figure ends up out by two orders of magnitude in a direction nobody notices.
 */

/** Which bundle lists a mapping may write into, and how each row is shaped. */
const FACTS = {
  revenue: {
    money: ['gross', 'discounts', 'net', 'collected', 'outstanding', 'cash', 'card', 'other'],
    counts: ['orders', 'covers'],
    reals: ['units'],
    needsLine: true,
  },
  costs: {
    money: ['amount'],
    text: ['category', 'supplierName'],
    needsLine: true,
  },
  purchaseLines: {
    money: ['unitCost', 'amount'],
    reals: ['qty'],
    text: ['itemName', 'unit', 'supplierName', 'externalId'],
    needsLine: true,
  },
  demand: {
    counts: ['inhouseGuests', 'outsideGuests', 'roomsCleaned', 'roomsTracked', 'covers', 'laundryOrders'],
    reals: ['laundryLoads'],
  },
  service: {
    counts: ['checksDue', 'checksDone', 'faultsFound', 'issuesOpened', 'issuesClosed', 'issuesOpen', 'oldestOpenDays'],
    needsLine: true,
  },
  cashControl: {
    money: ['expected', 'counted', 'variance'],
    text: ['shift', 'personName', 'personExternalId', 'externalId'],
    needsLine: true,
  },
  usage: {
    money: ['value'],
    reals: ['qty'],
    text: ['itemName', 'unit'],
    needsLine: true,
  },
  people: {
    text: ['externalId', 'name', 'employeeNo', 'department', 'jobTitle'],
  },
};

/**
 * Check a mapping before it is ever used.
 *
 * Called by the setup screen as well as the pull, so a mistake is a sentence on
 * a form rather than a silently empty night's load.
 */
export function validateMapping(config) {
  const problems = [];
  const base = String(config?.base || '').trim();
  if (!base) problems.push('No address configured.');
  else {
    try {
      const url = new URL(base);
      if (url.protocol !== 'https:') problems.push('The address must start with https://');
    } catch { problems.push('That address is not a web address.'); }
  }

  const tables = Array.isArray(config?.tables) ? config.tables : [];
  if (!tables.length) problems.push('No tables mapped yet, so this source would load nothing.');

  tables.forEach((table, index) => {
    const where = `Table ${index + 1}${table?.from ? ` (${table.from})` : ''}`;
    const shape = FACTS[table?.fact];
    if (!shape) {
      problems.push(`${where}: "${table?.fact}" is not something this warehouse holds. Choose one of ${Object.keys(FACTS).join(', ')}.`);
      return;
    }
    if (!table.from) problems.push(`${where}: needs a table or view to read from.`);
    if (table.fact !== 'people' && !table.day) problems.push(`${where}: needs a column holding the day.`);
    if (shape.needsLine && !table.line && !table.lineColumn) {
      problems.push(`${where}: needs a business line, either fixed ("line": "restaurant") or from a column ("lineColumn": "…").`);
    }
    const columns = table.columns || {};
    const known = new Set([...(shape.money || []), ...(shape.counts || []), ...(shape.reals || []), ...(shape.text || [])]);
    for (const field of Object.keys(columns)) {
      if (!known.has(field)) problems.push(`${where}: "${field}" is not a field of ${table.fact}. Known: ${[...known].join(', ')}.`);
    }
    if ((shape.money || []).some((f) => columns[f]) && !['major', 'minor'].includes(table.money)) {
      problems.push(`${where}: set "money" to "major" if that table holds cedis like 12.50, or "minor" if it holds whole pesewas like 1250. There is no safe default.`);
    }
  });

  return problems;
}

export async function pull({ config, token, from, to }) {
  const bundle = emptyBundle();
  const base = String(config?.base || '').trim();
  if (!base) {
    bundle.notes.push('No Supabase address is configured.');
    return bundle;
  }
  if (!token) {
    bundle.notes.push('No Supabase key is set on this Worker.');
    return bundle;
  }

  const problems = validateMapping(config);
  if (problems.length) throw new HttpError(400, `This source's mapping is not usable: ${problems[0]}`);

  let rowsRead = 0;
  for (const table of config.tables) {
    const rows = await readTable(base, token, table, from, to, config.schema);
    rowsRead += rows.length;
    for (const row of rows) {
      const shaped = shape(table, row);
      if (shaped) bundle[table.fact].push(shaped);
    }
  }

  bundle.notes.push(`${config.tables.length} tables, ${rowsRead} rows`);
  return bundle;
}

/**
 * Read one mapped table for the window, following PostgREST's paging.
 *
 * PostgREST caps a response at its configured maximum however large a `limit`
 * is asked for, so this walks with `offset` until a page comes back short. A
 * short page really is the end here — unlike the POS's reports API, nothing is
 * filtered after the fact.
 */
async function readTable(base, token, table, from, to, schema) {
  const out = [];
  const pageSize = 1000;

  for (let offset = 0; offset < 200_000; offset += pageSize) {
    const url = new URL(`/rest/v1/${encodeURIComponent(table.from)}`, base);
    url.searchParams.set('select', '*');
    if (table.day) {
      url.searchParams.append(table.day, `gte.${from}`);
      url.searchParams.append(table.day, `lte.${to}`);
    }
    // A caller's own extra filters, verbatim in PostgREST's own syntax —
    // `{"status": "eq.settled"}`. Passed through rather than interpreted,
    // because re-inventing a query language that already exists is how a
    // connector grows a bug for every operator it forgot.
    for (const [column, filter] of Object.entries(table.where || {})) {
      url.searchParams.append(column, String(filter));
    }
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));

    const page = await getJson(url.toString(), {
      token,
      // Supabase wants the key twice: once as `apikey` and once as a bearer.
      // The second is what a row-level-security policy reads.
      headers: {
        apikey: token,
        ...(schema ? { 'Accept-Profile': schema } : {}),
      },
    });
    if (!Array.isArray(page)) return out;
    out.push(...page);
    if (page.length < pageSize) return out;
  }
  return out;
}

/** Turn one Postgres row into one warehouse row, per the mapping. */
function shape(table, row) {
  const spec = FACTS[table.fact];
  const columns = table.columns || {};
  const out = {};

  if (table.day) {
    const raw = row[table.day];
    if (!raw) return null;
    // A date, a timestamp or a timestamptz all reduce to the day they fall on.
    out.day = String(raw).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.day)) return null;
  }

  if (spec.needsLine) {
    out.line = table.lineColumn ? String(row[table.lineColumn] ?? '').trim() || table.line : table.line;
    if (!out.line) return null;
  }

  const toMoney = table.money === 'minor' ? minor : toMinor;
  for (const field of spec.money || []) {
    if (columns[field] != null) out[field] = toMoney(row[columns[field]]);
  }
  for (const field of spec.counts || []) {
    if (columns[field] != null) out[field] = Math.round(Number(row[columns[field]]) || 0);
  }
  for (const field of spec.reals || []) {
    if (columns[field] != null) out[field] = Number(row[columns[field]]) || 0;
  }
  for (const field of spec.text || []) {
    if (columns[field] != null && row[columns[field]] != null) out[field] = String(row[columns[field]]);
  }

  // Rows that are kept at their own grain need a stable identity, or a reload
  // would insert them all over again. Fall back to the table and the row's own
  // id, which is what a Postgres table almost always has.
  if ((table.fact === 'purchaseLines' || table.fact === 'cashControl') && !out.externalId) {
    const id = row.id ?? row.uuid ?? row[`${table.from}_id`];
    if (id == null) return null;
    out.externalId = `supabase:${table.from}:${id}`;
  }

  return out;
}

/** Does the key work, and is the mapping sane? For the setup screen. */
export async function check({ config, token }) {
  const problems = validateMapping(config);
  if (!token) return { ok: false, detail: 'No key set' };
  if (problems.length) return { ok: false, detail: problems[0] };

  const first = config.tables[0];
  const url = new URL(`/rest/v1/${encodeURIComponent(first.from)}`, config.base);
  url.searchParams.set('select', '*');
  url.searchParams.set('limit', '1');
  const rows = await getJson(url.toString(), { token, headers: { apikey: token } });
  return {
    ok: Array.isArray(rows),
    detail: Array.isArray(rows)
      ? `${config.tables.length} tables mapped; ${first.from} answered`
      : 'That table did not answer with rows',
  };
}

export { FACTS };
