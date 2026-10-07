/**
 * How much of a week somebody may say they cannot work.
 *
 * Pure, and its own module, because the browser cannot load a worker module
 * and the screen has to be able to say the answer before the server does. The
 * authority is `busiestWeek` in `src/routes/me.js`; this is the same rule
 * written out again, and a test walks both and refuses to let them drift.
 *
 * PER WEEK, NOT PER MONTH. It was once two days per request, which refused
 * somebody marking a Wednesday this week and a Wednesday next: four scattered
 * days across a month read as asking for four days off, and they are not. They
 * are four separate Wednesdays, and no week is any thinner for them. What the
 * rota cannot absorb is one week going thin, so that is what is counted.
 */

/** How many days somebody can say they cannot work in any one week. */
export const MAX_UNAVAILABLE_DAYS = 2;

/**
 * The week with the most days in it, Monday to Sunday.
 *
 * Monday because that is the week this app builds rotas in, and a limit
 * measured over a different week from the rota is a limit nobody can reason
 * about. Where two weeks tie the earlier one is named, so the message does not
 * point somewhere different on every save for no reason a reader can see.
 */
export function busiestWeek(days) {
  const weeks = new Map();
  for (const day of [...new Set(days)]) {
    // Monday of that week, without a date library: the ISO day shifted so
    // Monday is nought, taken off the date.
    const at = new Date(`${day}T00:00:00Z`);
    at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
    const week = at.toISOString().slice(0, 10);
    weeks.set(week, (weeks.get(week) ?? 0) + 1);
  }

  let worst = null;
  for (const [week, count] of weeks) {
    if (!worst || count > worst.days || (count === worst.days && week < worst.week)) {
      worst = { week, days: count };
    }
  }
  return worst ?? { week: null, days: 0 };
}

/**
 * The days somebody asked about, the way they would say them.
 *
 * Runs of consecutive days read as a run and separate days are listed, so two
 * Saturdays a month apart read as "Sat 18 Oct and Sat 15 Nov" rather than
 * "18 Oct to 15 Nov", which is a month off nobody asked for. Written again in
 * `src/lib/asked-days.js` for the notice that answers them, and a test keeps
 * the two saying the same thing.
 */
export function sayAskedDays(days) {
  const sorted = [...new Set((days ?? []).map(String))].sort();
  const runs = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && dayAfter(last.to) === day) last.to = day;
    else runs.push({ from: day, to: day });
  }
  const say = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
  const parts = runs.map((r) => (r.from === r.to ? say(r.from) : `${say(r.from)} to ${say(r.to)}`));
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function dayAfter(day) {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}
