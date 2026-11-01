/**
 * The rota's planning sums: no DOM, so they can be tested and so every part of
 * the screen reads the same answer.
 *
 *   hoursTone  how somebody's planned hours stand against their week
 *   coverGaps  the shifts that must be on the rota and have nobody on them
 *   restGaps   a day that starts too soon after the day before ended
 */

const mins = (hhmm) => {
  const [h, m] = String(hhmm ?? '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
};

/** Monday is 0, as the shifts' "runs on" days are stored. */
export const weekdayOf = (day) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;

const listOf = (value) => {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [parsed]; } catch { return String(value).split(','); }
};

/**
 * On target within two hours either way; under; over by up to eight; and
 * far over beyond that.
 */
export function hoursTone(hours, target) {
  const t = Number(target) || 0;
  const diff = Math.round((Number(hours) - t) * 10) / 10;
  const say = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)}h`;
  if (!t) return { k: 'none', diff, label: '' };
  if (Math.abs(diff) <= 2) return { k: 'ok', diff, label: 'on target' };
  if (diff < 0) return { k: 'under', diff, label: `${say(-diff)} under` };
  if (diff <= 8) return { k: 'over', diff, label: `${say(diff)} over` };
  return { k: 'far', diff, label: `${say(diff)} over` };
}

/**
 * Must-cover shifts with nobody on them, day by day.
 *
 * A shift marked "must be on the rota" in Setup is a requirement on every day
 * it runs. Alternatives (one breakfast of several) answer for each other, over
 * the day or the week as the group says. A shift that belongs to named people
 * who are all away that day is not a gap anybody could fill, so it is left out.
 *
 * `onDay(day)` gives the shift ids held that day (primary and second shifts),
 * `away(staffId, day)` whether somebody is on leave or off the rota that day.
 */
export function coverGaps({ shifts = [], days = [], onDay, away = () => false, department = null }) {
  const active = shifts.filter((s) => s.active !== 0 && s.active !== false);
  const must = active.filter((s) => s.cover === 'must' && !(s.needed != null && Number(s.needed) <= 0)
    && (!department || !s.department || s.department === department));
  const groups = new Map();
  for (const s of must) {
    const key = s.alt_group ? `g:${s.alt_group}` : `s:${s.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const weekOf = (day) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - weekdayOf(day));
    return d.toISOString().slice(0, 10);
  };
  const gaps = [];
  for (const [key, list] of groups) {
    const lead = list[0];
    const members = key.startsWith('g:') ? active.filter((s) => s.alt_group === lead.alt_group) : [lead];
    const ids = new Set(members.map((s) => String(s.id)));
    const needed = Math.max(...list.map((s) => (s.needed == null ? 1 : Number(s.needed))));
    const weekly = lead.alt_scope === 'week';
    for (const day of days) {
      const running = list.filter((s) => {
        const on = listOf(s.runs_on).map(Number).filter((n) => n >= 0 && n <= 6);
        return !on.length || on.includes(weekdayOf(day));
      });
      if (!running.length) continue;
      // Belongs to named people, all of them away: nobody else could work it.
      const named = running.flatMap((s) => listOf(s.only_staff).map(Number).filter(Number.isFinite)
        .concat(Number(s.only_staff_id) > 0 ? [Number(s.only_staff_id)] : []));
      if (named.length && named.every((id) => away(id, day))) continue;
      const span = weekly ? days.filter((d) => weekOf(d) === weekOf(day)) : [day];
      const held = span.flatMap((d) => (onDay(d) ?? []).map(String)).filter((id) => ids.has(id)).length;
      if (weekly && held > 0) continue;
      if (held < needed) {
        gaps.push({ day, shift: running[0], short: needed - held, label: list.length > 1 || members.length > 1 ? running[0].name : lead.name });
      }
    }
  }
  return gaps.sort((a, b) => (a.day === b.day ? String(a.label).localeCompare(String(b.label)) : a.day < b.day ? -1 : 1));
}

/**
 * Days that start too soon after the day before ended, for one person.
 *
 * `held` is one entry per day, in order: the shift on it (or null). The
 * answer is one entry per day: null, or the hours of rest before it.
 */
export function restGaps(held, minRestHours = 12) {
  return held.map((shift, i) => {
    const before = i > 0 ? held[i - 1] : null;
    if (!shift || !before) return null;
    const bs = mins(before.starts_at);
    let be = mins(before.ends_at);
    const s = mins(shift.starts_at);
    if (bs == null || be == null || s == null) return null;
    if (be <= bs) be += 24 * 60;
    const rest = (s + 24 * 60 - be) / 60;
    return rest < minRestHours ? Math.max(0, Math.round(rest * 10) / 10) : null;
  });
}
