import { all, run, writeAll } from '../lib/db.js';
import { badRequest } from '../lib/http.js';
import { addDays, dow, dowLabel, isoWeek, month, daysBetween } from '../lib/dates.js';
import { requireAdmin } from './till.js';
import { isNight } from './stays.js';

/**
 * Revenue from the ASSD journal.
 *
 * Every reservation in the journal carries what it was charged, line by line
 * and day by day: each night, each extra, each deposit. Added up by day, that
 * is the rooms' takings, which no other system reports.
 *
 * The nights (articles 100 to 289) are always the rooms. Every other article
 * is decided once, by an admin, because only they know what it is: revenue of
 * a part of the business, revenue another system already reports (laundry has
 * its own), or not revenue at all (a deposit, a tax). Until it is decided it is
 * left out, and the Money page says how much is waiting.
 *
 * Written to fact_revenue under the source `assd`, so every screen that reads
 * revenue reads it. The nightly load clears its window and this writes it back.
 */

export const ASSD_SOURCE = 'assd';
const SPECIAL = new Set(['none', 'elsewhere']);
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';

/** What a newly seen article starts as: deposits are not revenue, laundry is the laundry system's. */
function firstGuess(code, name, rentalArticles) {
  if (rentalArticles.has(code)) return 'none';
  if (code === '540' || /laundry/i.test(name)) return 'elsewhere';
  if (/deposit|refund/i.test(name)) return 'none';
  return null;
}

async function articleMap(env) {
  const rows = await all(env.DB, 'SELECT code, name, line_id FROM assd_article');
  return new Map(rows.map((r) => [r.code, r]));
}

/** Each charge in the journal dated between two days, with the reservation it belongs to. */
async function chargesBetween(env, from, to) {
  const where = from && to
    ? `WHERE EXISTS (SELECT 1 FROM json_each(assd_entry.data, '$.charges') c
         WHERE json_extract(c.value, '$.date') BETWEEN ?1 AND ?2)`
    : "WHERE json_array_length(assd_entry.data, '$.charges') > 0";
  const rows = await all(env.DB, `SELECT seq, data FROM assd_entry ${where}`, ...(from && to ? [from, to] : []));
  const out = [];
  for (const row of rows) {
    let data;
    try { data = JSON.parse(row.data); } catch { continue; }
    for (const c of data.charges || []) {
      if (!c.date || (from && c.date < from) || (to && c.date > to)) continue;
      out.push({ seq: row.seq, date: c.date, code: String(c.code || ''), name: String(c.name || ''), amount: Number(c.amount) || 0 });
    }
  }
  return out;
}

/** Note any article not seen before, with its first guess. */
async function learnArticles(env, charges, known) {
  let rentals = new Set();
  try { rentals = new Set((await all(env.DB, 'SELECT article FROM till_rental')).map((r) => String(r.article))); } catch { /* no rentals yet */ }
  const fresh = new Map();
  for (const c of charges) {
    if (isNight(c.code) || known.has(c.code) || fresh.has(c.code)) continue;
    fresh.set(c.code, { code: c.code, name: c.name, line_id: firstGuess(c.code, c.name, rentals) });
  }
  if (!fresh.size) return;
  await writeAll(env.DB, [...fresh.values()].map((a) => env.DB.prepare(
    'INSERT INTO assd_article (code, name, line_id) VALUES (?1, ?2, ?3) ON CONFLICT (code) DO NOTHING',
  ).bind(a.code, a.name, a.line_id)));
  for (const a of fresh.values()) known.set(a.code, a);
}

/** The line a charge is revenue of, or null when it is not counted here. */
function lineOf(code, known, lines) {
  if (isNight(code)) return 'rooms';
  const line = known.get(code)?.line_id;
  return line && !SPECIAL.has(line) && lines.has(line) ? line : null;
}

/**
 * Write the journal's revenue for the days between `from` and `to` (every day
 * the journal has, when neither is given). Returns what was written.
 */
export async function rebuildAssdRevenue(env, { from = null, to = null } = {}) {
  const charges = await chargesBetween(env, from, to);
  const known = await articleMap(env);
  await learnArticles(env, charges, known);
  const lines = new Set((await all(env.DB, 'SELECT id FROM dim_line')).map((r) => r.id));

  const bucket = new Map();
  for (const c of charges) {
    const line = lineOf(c.code, known, lines);
    if (!line) continue;
    const key = `${c.date}|${line}`;
    const b = bucket.get(key) || { day: c.date, line, net: 0, folios: new Set(), units: 0 };
    b.net += c.amount;
    b.folios.add(c.seq);
    // A room-night: a night charged, less a night taken back.
    if (line === 'rooms' && isNight(c.code)) b.units += c.amount > 0 ? 1 : c.amount < 0 ? -1 : 0;
    bucket.set(key, b);
  }

  const days = charges.map((c) => c.date).sort();
  const lo = from || days[0];
  const hi = to || days[days.length - 1];
  if (!lo || !hi) return { days: 0, revenue: 0 };

  await run(env.DB, 'DELETE FROM fact_revenue WHERE source_id = ?1 AND day BETWEEN ?2 AND ?3', ASSD_SOURCE, lo, hi);
  // The calendar has to know the days, or no screen will show them.
  await writeAll(env.DB, [...new Set([...bucket.values()].map((b) => b.day))].map((day) => env.DB.prepare(
    `INSERT INTO dim_day (day, dow, dow_label, iso_week, month, is_weekend) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (day) DO NOTHING`,
  ).bind(day, dow(day), dowLabel(day), isoWeek(day), month(day), dow(day) >= 6 ? 1 : 0)));
  const rows = [...bucket.values()];
  await writeAll(env.DB, rows.map((b) => env.DB.prepare(
    `INSERT INTO fact_revenue (day, line_id, source_id, gross, discounts, net, collected, outstanding, orders, units)
     VALUES (?1, ?2, ?3, ?4, 0, ?4, ?4, 0, ?5, ?6)
     ON CONFLICT (day, line_id, source_id) DO UPDATE SET gross = ?4, net = ?4, collected = ?4, orders = ?5, units = ?6`,
  ).bind(b.day, b.line, ASSD_SOURCE, b.net, b.folios.size, b.units)));
  return { days: daysBetween(lo, hi, 4000).length, revenue: rows.reduce((t, b) => t + b.net, 0) };
}

/** What the journal charged in a window, by article, and which are still to be decided. */
export async function articlesView(env, { from, to }) {
  const charges = await chargesBetween(env, from, to);
  const known = await articleMap(env);
  await learnArticles(env, charges, known);
  const lines = await all(env.DB, 'SELECT id, label FROM dim_line ORDER BY sort_order');
  const byCode = new Map();
  let nights = 0;
  let nightCount = 0;
  for (const c of charges) {
    if (isNight(c.code)) { nights += c.amount; nightCount += c.amount > 0 ? 1 : c.amount < 0 ? -1 : 0; continue; }
    const a = byCode.get(c.code) || { code: c.code, name: known.get(c.code)?.name || c.name, amount: 0, charges: 0 };
    a.amount += c.amount;
    a.charges += 1;
    byCode.set(c.code, a);
  }
  const articles = [...known.values()].map((k) => ({
    code: k.code, name: k.name, line: k.line_id || null,
    amount: byCode.get(k.code)?.amount || 0, charges: byCode.get(k.code)?.charges || 0,
  })).sort((a, b) => (a.line === null) - (b.line === null) || b.amount - a.amount || a.code.localeCompare(b.code));
  const undecided = articles.filter((a) => a.line === null);
  return {
    range: { from, to },
    nights: { amount: nights, count: nightCount },
    articles,
    lines,
    undecided: { count: undecided.length, amount: undecided.reduce((t, a) => t + a.amount, 0) },
  };
}

/** An admin decides what an article's charges are. */
export async function saveArticle(env, body, account) {
  await requireAdmin(account);
  const code = String(body?.code || '').trim();
  if (!/^\d{3}$/.test(code)) throw badRequest('An ASSD article number has three digits.');
  if (isNight(code)) throw badRequest('Articles 100 to 289 are nights, and always the rooms.');
  const line = body?.line == null || body.line === '' ? null : String(body.line);
  const lines = new Set((await all(env.DB, 'SELECT id FROM dim_line')).map((r) => r.id));
  if (line !== null && !SPECIAL.has(line) && !lines.has(line)) throw badRequest('Choose a part of the business, or say it is not revenue.');
  await run(env.DB, `INSERT INTO assd_article (code, name, line_id, by_name, at) VALUES (?1, '', ?2, ?3, ?4)
    ON CONFLICT (code) DO UPDATE SET line_id = ?2, by_name = ?3, at = ?4`, code, line, who(account), now());
  // Everything the journal holds is written again with the new decision. A
  // year back is plenty; older months are re-read by their own nightly load.
  const today = new Date().toISOString().slice(0, 10);
  const result = await rebuildAssdRevenue(env, { from: addDays(today, -400), to: today });
  return { ok: true, code, line, ...result };
}
