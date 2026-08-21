import { json } from '../lib/http.js';
import { allows } from '../lib/permissions.js';
import { leaveBalance, loadDataset } from '../lib/attendance.js';
import {
  assessPerson, limitsFrom, restFindings, strainScore,
} from '../lib/workload.js';
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

function windowOf(url, timezone) {
  const today = todayIn(timezone);
  const from = isDay(url.searchParams.get('from')) ? url.searchParams.get('from') : today;
  const to = isDay(url.searchParams.get('to')) ? url.searchParams.get('to') : addDays(from, 13);
  return { from, to };
}

export async function workload(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const { from, to } = windowOf(ctx.url, timezone);
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
    if (!staff.active) continue;
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
    rows,
    limits,
    showsLeave,
    departments: [...new Set(ds.staff.filter((s) => s.active)
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
    if (!staff.active) continue;
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
