import { callLink } from './till-link.js';

/**
 * Till shortages come off pay only from a checked shift.
 *
 * Insight decides when a shift is checked: somebody has looked at its report,
 * drawer and payments and said so, and its amounts are final. A shortage
 * recovered from pay arrives already checked, but a check can be taken back,
 * and shortages recovered before this rule existed never said. So every few
 * minutes HIVE asks Insight about the shift behind each till shortage still
 * being repaid, and writes down whether it is checked. The payroll reads that:
 * no check, nothing comes off, and the payroll screen says why.
 */

const SLOTS = new Set(['morning', 'afternoon', 'night']);

/** The shift a till shortage came from, from its columns or its reason. */
export function shiftOf(advance) {
  if (advance.till_day && SLOTS.has(advance.till_slot)) return { day: advance.till_day, slot: advance.till_slot };
  const m = String(advance.reason ?? '').match(/(\d{4}-\d{2}-\d{2}) (morning|afternoon|night)\s*$/);
  return m ? { day: m[1], slot: m[2] } : null;
}

/**
 * Bring every open till shortage's check up to date. Quiet when there are
 * none, and when Insight cannot be reached: the last answer stands.
 */
export async function syncTillChecks(db, env, { fetchImpl = null } = {}) {
  const rows = (await db.prepare(
    `SELECT a.* FROM hr_advance a
      WHERE a.purpose = 'till' AND a.status = 'approved'
        AND a.amount > COALESCE((SELECT SUM(e.amount) FROM hr_advance_entry e WHERE e.advance_id = a.id), 0)`,
  ).all().catch(() => ({ results: [] }))).results ?? [];
  if (!rows.length) return { asked: 0, checked: 0, held: 0 };

  const shifts = new Map();
  for (const advance of rows) {
    const shift = shiftOf(advance);
    if (shift) shifts.set(`${shift.day}|${shift.slot}`, shift);
  }
  if (!shifts.size) return { asked: 0, checked: 0, held: rows.length };

  let answer;
  try {
    answer = await callLink({
      binding: env.INSIGHT, secret: env.INSIGHT_SSO_SECRET, fetchImpl,
      path: '/api/link/till/checks', body: { shifts: [...shifts.values()] },
    });
  } catch {
    return { asked: shifts.size, checked: null, held: null };
  }
  const checks = new Map((answer?.checked ?? []).map((c) => [`${c.day}|${c.slot}`, c]));

  let checked = 0;
  let held = 0;
  for (const advance of rows) {
    const shift = shiftOf(advance);
    const c = shift ? checks.get(`${shift.day}|${shift.slot}`) : null;
    if (c) checked += 1; else held += 1;
    const at = c ? String(c.at ?? '') || new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
    const by = c ? String(c.by ?? '') || null : null;
    if ((advance.till_checked_at ?? null) === at && (advance.till_checked_by ?? null) === by
      && advance.till_day === (shift?.day ?? null) && advance.till_slot === (shift?.slot ?? null)) continue;
    await db.prepare(
      'UPDATE hr_advance SET till_checked_at = ?1, till_checked_by = ?2, till_day = ?3, till_slot = ?4 WHERE id = ?5',
    ).bind(at, by, shift?.day ?? null, shift?.slot ?? null, advance.id).run();
  }
  return { asked: shifts.size, checked, held };
}
