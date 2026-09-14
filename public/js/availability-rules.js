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
