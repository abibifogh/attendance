import { json } from '../lib/http.js';
import { allows } from '../lib/permissions.js';
import { computeRange, leaveBalance, loadDataset, onRota } from '../lib/attendance.js';
import {
  assessPerson, limitsFrom, restFindings, shiftsInWindow, strainScore,
} from '../lib/workload.js';
import {
  analyseCost, analyseRisk, analyseShape, analyseTime, previousWindow,
} from '../lib/analytics.js';
import { costingFor } from './pay.js';
import { addDays, diffDays, isDay, todayIn } from '../util/dates.js';

/**
 * Shift intelligence: how the rota is treating people.
 *
 * Read against the plan rather than the record, because the point is to see it
 * while it can still be changed. A fortnight ahead is the window a rota is
 * actually built in, so that is the default.
 */

async function timezoneOf(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first().catch(() => null);
  return row?.value || 'UTC';
}

/**
 * The longest stretch this screen will read in one go.
 *
 * A quarter. Everything here is derived from punches and the roster over the
 * whole window, so a year asked for by accident is a slow page for everybody
 * on the property rather than an error for the one person who asked. Asking
 * for more gets the first quarter of it and is told so.
 */
const MAX_SPAN = 92;

function windowOf(url, timezone) {
  const today = todayIn(timezone);
  const from = isDay(url.searchParams.get('from')) ? url.searchParams.get('from') : today;
  const asked = isDay(url.searchParams.get('to')) ? url.searchParams.get('to') : addDays(from, 13);

  // A backwards range is a mistake somebody made in two date boxes, and the
  // kindest reading of it is the day they landed on.
  if (asked < from) return { from, to: from, clamped: false };

  const clamped = diffDays(from, asked) + 1 > MAX_SPAN;
  return { from, to: clamped ? addDays(from, MAX_SPAN - 1) : asked, clamped };
}

export async function workload(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const { from, to, clamped } = windowOf(ctx.url, timezone);
  const span = diffDays(from, to) + 1;

  const onlyDepartment = ctx.url.searchParams.get('department') || '';

  // Balances are a personnel figure, not a planning one, and whoever builds
  // the rota is deliberately never shown them. So the "leave never taken"
  // finding only appears for somebody who could have looked it up anyway.
  const showsLeave = allows('att_reports', ctx.session.permissions);

  const ds = await loadDataset(ctx.db, { from: addDays(from, -1), to: addDays(to, 1) });
  const limits = limitsFrom(ds.settings);

  const people = [];
  for (const staff of ds.staff) {
    if (!onRota(staff)) continue;
    if (onlyDepartment && (staff.department || '') !== onlyDepartment) continue;
    people.push(assessPerson(ds, staff, from, to, limits));
  }

  // The second pass. Fairness only means anything against the people standing
  // next to them, so it cannot be worked out one person at a time.
  const rows = people.map((person) => {
    const staff = ds.staffById.get(person.staff.id);
    const balance = showsLeave
      ? leaveBalance({
        staff,
        records: [],
        requests: ds.requestsByStaff.get(staff.id) ?? [],
        settings: ds.settings,
        asOf: to,
        reasons: ds.reasonBy,
      })
      : null;

    // How far through the leave year we are. In January everybody holds their
    // whole entitlement and saying so about all of them is noise; the same
    // fact in October is a person nobody can spare.
    const leave = balance
      ? {
        ...balance,
        yearElapsed: Math.max(0, Math.min(1,
          diffDays(balance.from, to) / Math.max(1, diffDays(balance.from, balance.to)))),
      }
      : null;

    const resting = restFindings(person, people, limits, leave);
    const findings = [...person.findings, ...resting];

    return {
      ...person,
      findings,
      resting,
      score: strainScore({ ...person, findings: person.findings }, limits),
      // Counted separately from the strain score on purpose. Somebody being
      // under-used is a different problem from somebody being worn out, and
      // adding them together would put both in the middle and hide each.
      quiet: resting.length,
    };
  });

  rows.sort((a, b) => b.score - a.score || a.staff.name.localeCompare(b.staff.name));

  const breaches = rows.reduce(
    (n, r) => n + r.findings.filter((f) => f.level === 'high').length, 0,
  );

  return json({
    from,
    to,
    span,
    // Said rather than silently done, so a range that comes back shorter than
    // the one somebody typed does not read as a bug.
    clamped,
    maxSpan: MAX_SPAN,
    rows,
    limits,
    showsLeave,
    departments: [...new Set(ds.staff.filter(onRota)
      .map((s) => s.department).filter(Boolean))].sort(),
    summary: {
      people: rows.length,
      strained: rows.filter((r) => r.score >= 60).length,
      breaches,
      quiet: rows.filter((r) => r.quiet).length,
    },
  });
}

/**
 * The same reading, cut down to what the rota grid needs.
 *
 * One line per person for the fortnight on screen, so a warning can sit
 * against the row somebody is editing rather than on a screen they have to
 * remember to open afterwards.
 */
export async function rotaWarnings(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const { from, to } = windowOf(ctx.url, timezone);

  const ds = await loadDataset(ctx.db, { from: addDays(from, -1), to: addDays(to, 1) });
  const limits = limitsFrom(ds.settings);

  const rows = {};
  for (const staff of ds.staff) {
    if (!onRota(staff)) continue;
    const person = assessPerson(ds, staff, from, to, limits);
    if (!person.findings.length) continue;
    rows[staff.id] = {
      level: person.findings.some((f) => f.level === 'high') ? 'high' : 'warn',
      count: person.findings.length,
      findings: person.findings.map((f) => ({
        level: f.level, title: f.title, detail: f.detail, law: f.law,
      })),
    };
  }

  return json({ from, to, rows });
}

/**
 * The workforce, measured four ways.
 *
 * The table above this answers "who is being worked too hard". This answers
 * the four questions a hotel asks once it has stopped firefighting: what the
 * labour costs and which part of that could be different, where the time goes
 * against what was agreed, who is at risk and what liability sits behind them,
 * and what shape the cover actually is across a day.
 *
 * MONEY ONLY FOR SOMEBODY WHO MAY SEE MONEY. The rest of it is a rota question
 * and travels for anybody who may read the rota. The cost block is simply
 * absent for everybody else rather than blanked out on the screen, because a
 * screen that hides something it was sent is not hiding it.
 *
 * READ AGAINST THE WINDOW BEFORE IT, and as rates rather than totals. A wage
 * bill that went up tells nobody anything; it goes up when trade goes up. Cost
 * per worked hour moves only when something has actually changed.
 */
export async function analytics(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const { from, to, clamped } = windowOf(ctx.url, timezone);
  const span = diffDays(from, to) + 1;
  const onlyDepartment = ctx.url.searchParams.get('department') || '';

  const seesPay = allows('hr_pay', ctx.session.permissions);
  const seesLeave = allows('att_reports', ctx.session.permissions);

  const ds = await loadDataset(ctx.db, { from: addDays(from, -1), to: addDays(to, 1) });
  const limits = limitsFrom(ds.settings);

  const mine = ds.staff.filter((staff) => onRota(staff)
    && (!onlyDepartment || (staff.department || '') === onlyDepartment));

  const people = mine.map((staff) => assessPerson(ds, staff, from, to, limits));

  // The rota as it stands, per person, for the shape of the cover. Kept from
  // the same pass rather than worked out again: reading the roster twice for
  // a quarter is the difference between a page and a wait.
  const worked = new Map(mine.map((staff) => [staff.id, shiftsInWindow(ds, staff.id, from, to)]));

  // What the clock recorded, which is a different question from what the rota
  // asked. Absence and lateness come from here and from nowhere else.
  const daysBy = new Map(mine.map((staff) => [
    staff.id, computeRange(ds, staff.id, from, to),
  ]));

  const rows = people.map((person) => {
    const staff = ds.staffById.get(person.staff.id);
    const balance = seesLeave
      ? leaveBalance({
        staff,
        records: [],
        requests: ds.requestsByStaff.get(staff.id) ?? [],
        settings: ds.settings,
        asOf: to,
        reasons: ds.reasonBy,
      })
      : null;
    return {
      ...person,
      leave: balance,
      score: strainScore(person, limits),
    };
  });

  const time = analyseTime({ people, daysBy });
  const shape = analyseShape({
    ds,
    worked,
    from,
    to,
    joiners: mine.filter((s) => s.hired_on && s.hired_on >= from && s.hired_on <= to),
    leavers: mine.filter((s) => s.left_on && s.left_on >= from && s.left_on <= to),
  });

  let cost = null;
  let risk = analyseRisk({ rows });
  if (seesPay) {
    const back = previousWindow(from, to);
    const [now, before] = await Promise.all([
      costingFor(ctx, from, to),
      costingFor(ctx, back.from, back.to),
    ]);
    const only = (rowsIn) => (onlyDepartment
      ? rowsIn.filter((r) => (r.staff.department || '') === onlyDepartment)
      : rowsIn);

    const wasRows = only(before.rows);
    cost = {
      currency: now.currency,
      missing: now.missing,
      fromPayroll: now.fromPayroll,
      ...analyseCost({
        rows: only(now.rows),
        span,
        previous: {
          from: back.from,
          to: back.to,
          people: wasRows.length,
          ...analyseCost({ rows: wasRows, span }),
        },
      }),
    };

    // What a day of somebody's leave is worth, for the liability. Their own
    // rate, not an average: a manager's untaken fortnight is not worth what a
    // porter's is, and averaging them is how a liability comes out wrong in
    // whichever direction the payroll happens to be shaped.
    const dayRateBy = new Map(now.rows
      .filter((r) => Number(r.cost?.perDay) > 0)
      .map((r) => [r.staff.id, Number(r.cost.perDay)]));
    risk = analyseRisk({ rows, dayRateBy });
  }

  return json({
    from,
    to,
    span,
    clamped,
    maxSpan: MAX_SPAN,
    seesPay,
    seesLeave,
    departments: [...new Set(ds.staff.filter(onRota)
      .map((s) => s.department).filter(Boolean))].sort(),
    department: onlyDepartment || null,
    cost,
    time,
    risk,
    shape,
  });
}
