import { all, first, run } from '../lib/db.js';
import { badRequest, notFound, str } from '../lib/http.js';
import { shifts as shiftsFor } from './shifts.js';
import { envelopeTotal } from '../shifts/till.js';
import { hiveReports, requireAdmin } from './till.js';

/**
 * The safe: what each shift moved into it, and the closures that dealt with it.
 *
 * Cash goes into the safe in envelopes, a few a day. Every so often an admin
 * and a supervisor close the safe together, tick the shifts whose envelopes
 * they have dealt with, and write down how much cash came out of the safe
 * after that. A shift is closed once; a closure can be undone.
 *
 * Two figures per shift, side by side: what ASSD says moved to the safe, and
 * what the person's envelopes in their HIVE closing report add up to.
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
const SLOTS = ['morning', 'afternoon', 'night'];

/** Whole cedis with up to two decimals, as typed, into pesewas. */
function cedis(value, field) {
  const text = String(value ?? '').replace(/[,\s]/g, '').replace(/^GH₵|^GHS/i, '');
  if (text === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw badRequest(`${field} is not an amount of money.`);
  return Math.round(Number(text) * 100);
}

/** Every shift in the days asked for that moved cash to the safe, with where it stands. */
async function shiftsToSafe(env, query, account) {
  const data = await shiftsFor(env, query, account);
  const { from, to } = data.range;
  const [reports, closed] = await Promise.all([
    hiveReports(env, from, to),
    all(env.DB, 'SELECT * FROM safe_closure_shift WHERE day BETWEEN ?1 AND ?2', from, to),
  ]);
  const reportOf = new Map(reports.map((r) => [`${r.day}|${r.slot}`, r]));
  const closedOf = new Map(closed.map((c) => [`${c.day}|${c.slot}`, c]));
  const rows = [];
  for (const d of data.days || []) {
    for (const s of d.shifts) {
      const report = reportOf.get(`${s.day}|${s.slot}`) || null;
      const assd = s.register?.toSafe || 0;
      const envelopes = report ? envelopeTotal(report) : null;
      const shut = closedOf.get(`${s.day}|${s.slot}`) || null;
      if (!assd && !envelopes && !shut) continue;
      rows.push({
        day: s.day,
        slot: s.slot,
        user: s.user,
        assd,
        envelopes,
        list: report?.toSafe ? report.envelopes : [],
        reportedBy: report?.name || null,
        agrees: envelopes == null ? null : envelopes === assd,
        closure: shut ? shut.closure_id : null,
      });
    }
  }
  rows.sort((a, b) => (a.day === b.day ? SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot) : a.day < b.day ? -1 : 1));
  return { range: data.range, rows };
}

export async function safeView(env, query, account) {
  await requireAdmin(account);
  const { range, rows } = await shiftsToSafe(env, query, account);
  const closures = await all(env.DB, `
    SELECT c.*, (SELECT COUNT(*) FROM safe_closure_shift x WHERE x.closure_id = c.id) AS shifts,
           (SELECT MIN(day) FROM safe_closure_shift x WHERE x.closure_id = c.id) AS first_day,
           (SELECT MAX(day) FROM safe_closure_shift x WHERE x.closure_id = c.id) AS last_day
      FROM safe_closure c ORDER BY c.closed_on DESC, c.id DESC LIMIT 60`);
  const open = rows.filter((r) => !r.closure);
  return {
    range,
    rows,
    open: {
      shifts: open.length,
      assd: open.reduce((t, r) => t + r.assd, 0),
      envelopes: open.reduce((t, r) => t + (r.envelopes || 0), 0),
    },
    closures: closures.map((c) => ({
      id: c.id, closedOn: c.closed_on, with: c.with_name, assd: c.assd, envelopes: c.envelopes,
      taken: c.taken, note: c.note, by: c.by_name, at: c.at,
      shifts: Number(c.shifts) || 0, firstDay: c.first_day, lastDay: c.last_day,
      // What the shifts put in, less what came out afterwards.
      left: c.taken == null ? null : c.assd - c.taken,
    })),
  };
}

/** Close the safe for the shifts ticked, and say how much was taken out after. */
export async function closeSafe(env, body, account) {
  await requireAdmin(account);
  const picked = (Array.isArray(body?.shifts) ? body.shifts : [])
    .map((s) => ({ day: String(s?.day ?? ''), slot: String(s?.slot ?? '') }))
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.day) && SLOTS.includes(s.slot));
  if (!picked.length) throw badRequest('Tick the shifts this closure dealt with.');
  if (picked.length > 300) throw badRequest('Three hundred shifts at most in one closure.');
  const closedOn = String(body?.closedOn ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closedOn)) throw badRequest('Which day was the safe closed?');
  const withName = str(body?.with, 'Closed with', { max: 120 }) || null;
  const taken = cedis(body?.taken, 'The cash taken out');
  const note = str(body?.note, 'Note', { max: 600 }) || null;

  // The amounts are worked out here, from the same figures the tab shows, not
  // taken from the page.
  const days = picked.map((s) => s.day).sort();
  const { rows } = await shiftsToSafe(env, { from: days[0], to: days[days.length - 1] }, account);
  const rowOf = new Map(rows.map((r) => [`${r.day}|${r.slot}`, r]));
  const chosen = [];
  for (const p of picked) {
    const row = rowOf.get(`${p.day}|${p.slot}`);
    if (!row) throw badRequest(`The ${p.slot} shift of ${p.day} moved nothing to the safe.`);
    if (row.closure) throw badRequest(`The ${p.slot} shift of ${p.day} is already in closure ${row.closure}.`);
    chosen.push(row);
  }

  const assd = chosen.reduce((t, r) => t + r.assd, 0);
  const envelopes = chosen.reduce((t, r) => t + (r.envelopes || 0), 0);
  const made = await first(env.DB, `INSERT INTO safe_closure (closed_on, with_name, assd, envelopes, taken, note, by_name, at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`, closedOn, withName, assd, envelopes, taken, note, who(account), now());
  for (const r of chosen) {
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, 'INSERT INTO safe_closure_shift (day, slot, closure_id, assd, envelopes) VALUES (?1, ?2, ?3, ?4, ?5)',
      r.day, r.slot, made.id, r.assd, r.envelopes || 0);
  }
  return { ok: true, id: made.id, assd, envelopes, taken };
}

/** Record, or correct, the cash taken out after a closure. */
export async function saveTaken(env, id, body, account) {
  await requireAdmin(account);
  const row = await first(env.DB, 'SELECT id FROM safe_closure WHERE id = ?1', Number(id));
  if (!row) throw notFound('No such closure');
  await run(env.DB, 'UPDATE safe_closure SET taken = ?2, note = COALESCE(?3, note) WHERE id = ?1',
    row.id, cedis(body?.taken, 'The cash taken out'), str(body?.note, 'Note', { max: 600 }) || null);
  return { ok: true };
}

/** Undo a closure: its shifts are open again. */
export async function undoClosure(env, id, account) {
  await requireAdmin(account);
  const row = await first(env.DB, 'SELECT id FROM safe_closure WHERE id = ?1', Number(id));
  if (!row) throw notFound('No such closure');
  await run(env.DB, 'DELETE FROM safe_closure_shift WHERE closure_id = ?1', row.id);
  await run(env.DB, 'DELETE FROM safe_closure WHERE id = ?1', row.id);
  return { ok: true };
}
