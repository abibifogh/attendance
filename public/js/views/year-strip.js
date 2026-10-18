import { h } from '../util.js';

/**
 * The year at a glance, a week a bar.
 *
 * Used by a person's own leave plan and by the managers' board. Each week is
 * one cell; what colours it is decided by the caller, so the same strip shows
 * "busy season, department full, your time off" to a person and "approved,
 * waiting, over the limit" to a manager.
 */

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

const toDay = (d) => d.toISOString().slice(0, 10);
const plus = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toDay(d);
};

/** The Mondays of a year, starting with the week the first of January is in. */
export function mondaysOf(year) {
  const first = new Date(`${year}-01-01T12:00:00Z`);
  const back = (first.getUTCDay() + 6) % 7;
  const out = [];
  for (let day = plus(`${year}-01-01`, -back); day <= `${year}-12-31`; day = plus(day, 7)) out.push(day);
  return out;
}

/** Whether a span touches the week starting on a Monday. */
export const inWeek = (monday, from, to) => from <= plus(monday, 6) && to >= monday;

/** Short "12–23 Apr" or "28 Apr – 2 May". */
export function sayRange(from, to) {
  const a = new Date(`${from}T12:00:00Z`);
  const b = new Date(`${to}T12:00:00Z`);
  const month = (d) => d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  const wd = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  if (from === to) return `${wd(a)} ${a.getUTCDate()} ${month(a)}`;
  if (a.getUTCMonth() === b.getUTCMonth()) return `${wd(a)} ${a.getUTCDate()} – ${wd(b)} ${b.getUTCDate()} ${month(b)}`;
  return `${wd(a)} ${a.getUTCDate()} ${month(a)} – ${wd(b)} ${b.getUTCDate()} ${month(b)}`;
}

/**
 * The strip itself. `stateOf(monday)` returns a class name for the cell, or
 * null for an ordinary week, and optionally a title.
 */
export function yearStrip(year, stateOf, { label = null, months = true } = {}) {
  const weeks = mondaysOf(year);
  return h('div.ys', { role: 'img', 'aria-label': label || `${year}, week by week` },
    h('div.ys-cells', { style: { gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` } },
      weeks.map((monday) => {
        const got = stateOf(monday);
        const cls = typeof got === 'string' ? got : got?.cls;
        return h(`span.ys-cell${cls ? `.${cls.split(' ').join('.')}` : ''}`, { title: got?.title ?? monday });
      })),
    months ? h('div.ys-months', MONTHS.map((m) => h('span', m))) : null);
}

/** The key under a strip. */
export function stripKey(items) {
  return h('div.ys-key', items.map(([cls, text]) => h('span', h(`i.ys-cell.${cls}`), text)));
}
