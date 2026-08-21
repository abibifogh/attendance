/**
 * What the rota costs.
 *
 * Two ideas hold this together, and the second is the one that makes the
 * figures worth anything.
 *
 * A RATE HAS A DATE. The cost of a Tuesday in March is worked out at the rate
 * in force on that Tuesday, not at today's. Anything else means a rise in June
 * quietly rewrites what January cost, and the report somebody printed at the
 * time stops agreeing with the app that produced it.
 *
 * SALARY IS NOT AN HOURLY RATE IN DISGUISE. A monthly wage does not go up
 * because somebody worked a sixth day, and pretending it does produces a
 * labour-cost figure that reacts to the rota when the bank balance will not.
 * So cost is reported in two parts: what the period costs whatever the rota
 * says, and what the rota itself adds. The second is the only part a planner
 * can actually change, and burying it inside a single total is how a hotel
 * ends up trying to save money by cutting shifts that cost nothing.
 */

/** Months to weeks, the ordinary way: twelve months over fifty-two weeks. */
const WEEKS_PER_MONTH = 52 / 12;

export const PAY_BASES = ['monthly', 'daily', 'hourly'];

/**
 * The rate in force on a given day.
 *
 * The latest one starting on or before it. Nothing at all before somebody's
 * first rate, which is honest: the app does not know what they cost, and a
 * zero would look like an answer.
 */
export function rateOn(rates, day) {
  let found = null;
  for (const rate of rates ?? []) {
    if (rate.from_day > day) continue;
    if (!found || rate.from_day > found.from_day) found = rate;
  }
  return found;
}

/**
 * A rate expressed per day and per hour, for comparing people paid differently.
 *
 * Needs to know how the person's week is shaped, because converting a monthly
 * salary without it is arithmetic on an assumption. Six days a week for the
 * same money is a lower daily rate, and a comparison that misses that is
 * exactly backwards.
 */
export function perDayAndHour(rate, { daysPerWeek = 5, hoursPerDay = 8 } = {}) {
  if (!rate) return null;
  const amount = Number(rate.amount) || 0;
  const days = Math.max(1, Number(daysPerWeek) || 5);
  const hours = Math.max(1, Number(hoursPerDay) || 8);

  if (rate.basis === 'daily') return { day: amount, hour: amount / hours };
  if (rate.basis === 'hourly') return { day: amount * hours, hour: amount };

  const perDay = amount / (WEEKS_PER_MONTH * days);
  return { day: perDay, hour: perDay / hours };
}

/**
 * What one person costs over a window.
 *
 * `days` is what they are down to work, each with its hours and whether it
 * falls on a public holiday. `overtimeHours` is whatever the hours rules make
 * of the period — this does not decide what counts as overtime, it only prices
 * what it is told.
 */
export function costFor({
  rates, days = [], overtimeHours = 0, holidayHours = 0,
  daysPerWeek = 5, hoursPerDay = 8, span = 14,
  overtimeMultiplier = 1.5, holidayMultiplier = 2,
}) {
  const onDay = days.length ? rateOn(rates, days[0].day) : rateOn(rates, undefined);
  if (!onDay) return null;

  const per = perDayAndHour(onDay, { daysPerWeek, hoursPerDay });
  const currency = onDay.currency || 'GHS';

  // What the period costs before anybody builds a rota.
  const fixed = onDay.basis === 'monthly'
    ? (Number(onDay.amount) || 0) * (span / (WEEKS_PER_MONTH * 7))
    : 0;

  // What the rota adds on top of that.
  let variable = 0;
  if (onDay.basis === 'daily') {
    variable = days.reduce((sum, d) => {
      const rate = rateOn(rates, d.day);
      const each = perDayAndHour(rate, { daysPerWeek, hoursPerDay });
      return sum + (each?.day ?? 0);
    }, 0);
  } else if (onDay.basis === 'hourly') {
    variable = days.reduce((sum, d) => {
      const rate = rateOn(rates, d.day);
      const each = perDayAndHour(rate, { daysPerWeek, hoursPerDay });
      return sum + (each?.hour ?? 0) * (Number(d.hours) || 0);
    }, 0);
  }

  // Overtime and holiday premiums, priced at the hourly equivalent whatever
  // the basis. A salaried cook working a public holiday costs the property
  // something even though their salary does not move.
  const premium = (per?.hour ?? 0)
    * (overtimeHours * Math.max(0, overtimeMultiplier - (onDay.basis === 'hourly' ? 1 : 0))
      + holidayHours * Math.max(0, holidayMultiplier - (onDay.basis === 'hourly' ? 1 : 0)));

  // Rounded to the pesewa first, then added. A breakdown whose parts do not
  // come to the total shown beside them is the fastest way to lose somebody's
  // confidence in a figure about money.
  const round = (n) => Math.round(n * 100) / 100;
  const parts = { fixed: round(fixed), variable: round(variable), premium: round(premium) };

  return {
    currency,
    basis: onDay.basis,
    rate: Number(onDay.amount) || 0,
    from: onDay.from_day,
    perDay: round(per?.day ?? 0),
    perHour: round(per?.hour ?? 0),
    ...parts,
    total: round(parts.fixed + parts.variable + parts.premium),
  };
}

/** Money as somebody would write it down. */
export function money(amount, currency = 'GHS') {
  const n = Number(amount) || 0;
  return `${currency} ${n.toLocaleString('en-GB', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}
