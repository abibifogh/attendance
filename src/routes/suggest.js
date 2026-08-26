import { badRequest, json } from '../lib/http.js';
import { loadDataset } from '../lib/attendance.js';
import { limitsFrom } from '../lib/workload.js';
import { readHistory, suggestRota, HISTORY_WEEKS } from '../lib/suggest.js';
import { addDays, diffDays, isDay, startOfWeek, todayIn } from '../util/dates.js';

/**
 * A first draft of a rota, offered and never applied.
 *
 * This route writes nothing. It reads the weeks behind, works out what would
 * fill the blanks in the window, and hands the list back for somebody to look
 * at. Applying it goes through the ordinary Save the grid already uses, which
 * means the same validation, the same audit line, and — the point of the whole
 * exercise — the same unpublished state. A suggestion arrives dashed, is
 * counted by the Publish button like any other draft, and reaches a member of
 * staff only when a person has pressed Publish.
 */
export async function suggestRoster(ctx) {
  const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first())?.value || 'UTC';

  const asked = ctx.url.searchParams.get('from');
  const from = startOfWeek(isDay(asked) ? asked : todayIn(timezone));
  const to = isDay(ctx.url.searchParams.get('to'))
    ? ctx.url.searchParams.get('to')
    : addDays(from, 6);
  if (diffDays(from, to) < 0) throw badRequest('The last day is before the first.');
  if (diffDays(from, to) > 27) throw badRequest('Four weeks at most in one go.');

  // The weeks behind, read from the roster and from what people actually
  // worked. A shift somebody covered that never reached the rota is still what
  // this property does on a Tuesday.
  const historyFrom = addDays(from, -HISTORY_WEEKS * 7);
  const [ds, past, worked, availability] = await Promise.all([
    loadDataset(ctx.db, { from: addDays(from, -14), to: addDays(to, 7) }),
    ctx.db.prepare(
      'SELECT staff_id, day, shift_id FROM att_roster WHERE day >= ?1 AND day < ?2',
    ).bind(historyFrom, from).all().catch(() => ({ results: [] })),
    ctx.db.prepare(
      `SELECT staff_id, day, shift_id FROM att_days
        WHERE day >= ?1 AND day < ?2 AND shift_id IS NOT NULL AND worked_minutes > 0`,
    ).bind(historyFrom, from).all().catch(() => ({ results: [] })),
    ctx.db.prepare(
      'SELECT * FROM att_availability WHERE day BETWEEN ?1 AND ?2',
    ).bind(from, to).all().catch(() => ({ results: [] })),
  ]);

  // Deduplicated: a day that is both on the rota and worked is one day.
  const seen = new Set();
  const rows = [];
  for (const row of [...(past.results ?? []), ...(worked.results ?? [])]) {
    const key = `${row.staff_id}|${row.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }

  const availabilityBy = new Map(
    (availability.results ?? []).map((a) => [`${a.staff_id}|${a.day}`, a]),
  );

  const out = suggestRota({
    ds,
    history: readHistory(rows),
    from,
    to,
    availabilityBy,
    limits: limitsFrom(ds.settings ?? {}),
  });

  // Named here rather than in the library, so the pure part stays free of
  // anything to do with how a screen reads.
  const named = out.entries.map((entry) => ({
    ...entry,
    staff: ds.staffById.get(entry.staffId)?.name ?? null,
    shift: ds.shiftById.get(entry.shiftId)?.name ?? null,
  }));

  return json({
    from,
    to,
    weeksRead: HISTORY_WEEKS,
    historyRows: rows.length,
    entries: named,
    gaps: out.gaps,
    instead: out.instead ?? [],
    filled: out.filled,
    considered: out.considered,
    // Said out loud on the way out, because it is the promise the whole
    // feature rests on and a caller should be able to read it back.
    applied: false,
    publishes: false,
  });
}
