import { all } from '../lib/db.js';
import { emptyBundle } from './bundle.js';
import { minor, toMinor } from '../lib/money.js';

/**
 * The attendance system, read straight from its database.
 *
 * No HTTP, no key, no service account. The attendance app is a Cloudflare
 * Worker over a D1 database in the same account as this one, so this Worker
 * simply binds that database a second time and reads it. Nothing here writes,
 * and the binding is the whole of the security story: a Worker can only reach
 * a database somebody put in its configuration.
 *
 * What this system uniquely knows: who was physically on the premises, and
 * when. Every other system in the group records what somebody *did*. This is
 * the only one that records that they were *there*, which is what makes it the
 * spine of the whole warehouse — a till variance, a missed housekeeping round
 * and an hour of overtime all become answerable questions the moment they can
 * be set beside a clock-in.
 */

/**
 * Departments to business lines.
 *
 * A department is what the payroll calls a group of people; a line is what the
 * accounts call a part of the business. They are nearly the same thing and the
 * difference is exactly where labour cost goes missing, so the mapping is
 * written down rather than guessed at each use.
 *
 * Anything unrecognised lands in 'admin', deliberately: an unmapped department
 * showing up as an unexplained lump of admin cost is a prompt to fix the map.
 * Silently spreading it across the revenue lines would flatter every one of
 * them and nobody would ever notice.
 */
const DEPARTMENT_LINE = [
  [/(house\s*keep|housekeep|room\s*attend|cleaner|laundry\s*room)/i, 'housekeeping'],
  [/(maint|engineer|technic|handy|plumb|electric)/i, 'maintenance'],
  [/(kitchen|chef|cook|culinar)/i, 'restaurant'],
  [/(restaurant|waiter|waitress|server|service|f\s*&\s*b|dining)/i, 'restaurant'],
  [/(bar|barten|bev)/i, 'bar'],
  [/(breakfast|pastry|bakery)/i, 'breakfast'],
  [/(laundry|wash|press|dry\s*clean)/i, 'laundry'],
  [/(front\s*office|reception|front\s*desk|concierge|porter|rooms?)/i, 'rooms'],
  [/(security|guard)/i, 'admin'],
];

export function lineForDepartment(department) {
  const text = String(department || '').trim();
  if (!text) return 'admin';
  for (const [pattern, line] of DEPARTMENT_LINE) {
    if (pattern.test(text)) return line;
  }
  return 'admin';
}

/**
 * HIVE's weeks-per-month, for turning a salary into an hour.
 *
 * 52/12, not 4. A month is not four weeks and the difference is 8% of every
 * salaried person's hourly cost — which is larger than most of the effects
 * this warehouse exists to detect.
 */
const WEEKS_PER_MONTH = 52 / 12;

/**
 * A rate, per hour, in pesewas.
 *
 * Mirrors `perDayAndHour` in HIVE's own `src/lib/pay.js` rather than importing
 * it: these are two Workers, and a shared file between them is a shared
 * deploy, which is the coupling this app exists to avoid. The copy is held to
 * the original by a parity test, which is not deployed and may therefore read
 * across freely.
 *
 * Two conversions happen here at once and both are easy to get wrong.
 *
 * The unit: HIVE keeps money as REAL cedis. Everything in this warehouse is
 * whole pesewas. `toMinor`, never `minor` — the latter would load GH₵1,800 as
 * 1800 pesewas, which is GH₵18, and nothing downstream would complain.
 *
 * The basis: a monthly salary is not an hourly rate until you know how the
 * person's week is shaped. Six days a week for the same money is a lower
 * hourly cost, and dividing by a flat five is exactly backwards for the people
 * who work the most.
 */
export function hourlyCost(rate, { daysPerWeek = 5, hoursPerDay = 8 } = {}) {
  if (!rate) return null;
  // Guarded before Number(), not after. `Number(null)` and `Number('')` are
  // both 0, so a missing amount would arrive as a person who costs nothing an
  // hour — which is a different and much worse claim than not knowing what
  // they cost. Zero itself is still a real answer and survives.
  if (rate.amount === null || rate.amount === undefined || rate.amount === '') return null;
  const cedis = Number(rate.amount);
  if (!Number.isFinite(cedis)) return null;

  const days = Math.max(1, Number(daysPerWeek) || 5);
  const hours = Math.max(1, Number(hoursPerDay) || 8);

  if (rate.basis === 'hourly') return toMinor(cedis);
  if (rate.basis === 'daily') return toMinor(cedis / hours);
  // monthly, and anything unrecognised — a salary is the common case and the
  // safe reading of a missing basis.
  return toMinor(cedis / (WEEKS_PER_MONTH * days) / hours);
}

/**
 * The rate in force on a day: the latest one starting on or before it.
 *
 * Nothing at all before somebody's first rate, which is honest — the system
 * does not know what they cost then, and carrying today's rate backwards would
 * silently restate last year's wage bill every time somebody got a rise.
 */
export function rateOn(rates, day) {
  let found = null;
  for (const rate of rates || []) {
    if (!rate.from_day || rate.from_day > day) continue;
    if (!found || rate.from_day > found.from_day) found = rate;
  }
  return found;
}

export async function pull({ db, from, to }) {
  const bundle = emptyBundle();
  if (!db) {
    bundle.notes.push('No HIVE database is bound to this Worker.');
    return bundle;
  }

  const staff = await all(db, `
    SELECT id, employee_no, name, department, job_title, active, days_per_week
      FROM att_staff`);

  // What each person is paid, and how their week is shaped.
  //
  // Until this was read, every person in the warehouse had no rate at all and
  // the whole wage bill was one flat property-wide default — a night porter, a
  // chef and a manager priced identically. That single figure sat underneath
  // every labour finding the app produces.
  //
  // Missing tables are tolerated rather than fatal: a property that has not
  // started running payroll still gets its attendance read, and the run log
  // says which parts were unavailable instead of the whole pull failing.
  const rates = new Map();
  const [payRows, payNote] = await optional(db, `
    SELECT staff_id, basis, amount, from_day FROM hr_pay`, [], 'hr_pay');
  for (const row of payRows) {
    const list = rates.get(row.staff_id) || [];
    list.push(row);
    rates.set(row.staff_id, list);
  }
  if (payNote) bundle.notes.push(payNote);

  const defaultDaysPerWeek = Number(await setting(db, 'att_days_per_week')) || 5;

  const byId = new Map();
  for (const row of staff) {
    const line = lineForDepartment(row.department);
    const daysPerWeek = Number(row.days_per_week) || defaultDaysPerWeek;
    // Costed at the rate in force at the end of the window rather than today's,
    // so re-reading an old month does not restate it at this year's wages.
    const rate = rateOn(rates.get(row.id), to);
    byId.set(row.id, { line, department: row.department || '', daysPerWeek });
    bundle.people.push({
      externalId: String(row.id),
      employeeNo: row.employee_no || null,
      name: row.name,
      department: row.department || null,
      jobTitle: row.job_title || null,
      line,
      hourCost: hourlyCost(rate, { daysPerWeek }),
      active: row.active === 1,
    });
  }

  // `att_reasons` is what turns a status into a fact about the business: it is
  // the table that says whether a day counts as worked and whether it was
  // paid. Reading it rather than hard-coding the codes means a reason the
  // property invents next year is classified correctly without a deploy here.
  const reasons = new Map();
  for (const row of await all(db, 'SELECT code, kind, paid, counts_as_worked FROM att_reasons')) {
    reasons.set(row.code, { kind: row.kind, paid: row.paid === 1, worked: row.counts_as_worked === 1 });
  }

  const days = await all(db, `
    SELECT staff_id, day, scheduled, expected_minutes, first_in, last_out,
           worked_minutes, late_minutes, overtime_minutes, status, reason_code
      FROM att_days
     WHERE day BETWEEN ?1 AND ?2`, from, to);

  for (const row of days) {
    const who = byId.get(row.staff_id) || { line: 'admin', department: '' };
    const reason = reasons.get(row.reason_code) || {};
    bundle.personDays.push({
      day: row.day,
      externalId: String(row.staff_id),
      line: who.line,
      department: who.department,
      status: row.status || '',
      reasonCode: row.reason_code || null,
      reasonKind: reason.kind || null,
      countsAsWorked: reason.worked === true,
      scheduled: row.scheduled === 1,
      expectedMinutes: minor(row.expected_minutes),
      workedMinutes: minor(row.worked_minutes),
      lateMinutes: minor(row.late_minutes),
      overtimeMinutes: minor(row.overtime_minutes),
      firstIn: row.first_in || null,
      lastOut: row.last_out || null,
    });
  }

  for (const row of await all(db,
    'SELECT day, name FROM att_holidays WHERE active = 1 AND day BETWEEN ?1 AND ?2', from, to)) {
    bundle.holidays.push({ day: row.day, name: row.name });
  }

  // ---------------------------------------------------------- payslips --
  //
  // What people were actually paid, which is a different and better number
  // than what they probably cost. Monthly, because a pay run is monthly; the
  // warehouse keeps it at that grain rather than smearing it across days it
  // would then fail to reconcile with.
  //
  // Only closed runs. A draft is an accountant's working, and a report that
  // moves while somebody is mid-calculation is a report nobody trusts twice.
  //
  // Every month the window touches, not only whole ones — a window covering
  // the 3rd to the 9th of March is still a window in which March's payroll is
  // the relevant payroll.
  const [slips, slipNote] = await optional(db, `
    SELECT r.month, s.staff_id, s.gross, s.bonus_gross, s.ssf_employee,
           s.ssf_employer, s.paye, s.loans, s.net, s.cost
      FROM pay_slip s
      JOIN pay_run r ON r.id = s.run_id
     WHERE r.status = 'final'
       AND r.month BETWEEN ?1 AND ?2`, [from.slice(0, 7), to.slice(0, 7)], 'pay_slip');

  for (const row of slips) {
    const who = byId.get(row.staff_id) || { line: 'admin', department: '' };
    bundle.payroll.push({
      month: row.month,
      externalId: String(row.staff_id),
      line: who.line,
      department: who.department,
      // Every one of these is REAL cedis in HIVE. toMinor, never minor.
      gross: toMinor(row.gross),
      bonusGross: toMinor(row.bonus_gross),
      ssfEmployee: toMinor(row.ssf_employee),
      ssfEmployer: toMinor(row.ssf_employer),
      paye: toMinor(row.paye),
      loans: toMinor(row.loans),
      net: toMinor(row.net),
      cost: toMinor(row.cost),
    });
  }
  if (slipNote) bundle.notes.push(slipNote);

  const withRate = bundle.people.filter((p) => p.hourCost != null).length;
  bundle.notes.push(
    `${staff.length} staff (${withRate} with a rate of their own), ${days.length} staff-days`
    + (slips.length ? `, ${slips.length} payslips` : ''),
  );
  return bundle;
}

/** One setting, or null. */
async function setting(db, key) {
  const [rows] = await optional(db, 'SELECT value FROM settings WHERE key = ?1', [key], 'settings');
  return rows[0]?.value ?? null;
}

/**
 * A query whose table may not exist yet.
 *
 * HIVE gained payroll in a migration; a property that has not applied it, or
 * has not started using it, should still have its attendance read. The
 * alternative — one missing table failing the whole pull — turns an optional
 * feature into a hard dependency, and does it silently until the night the
 * report is empty.
 *
 * Returns the rows and a note, so the run log says what was unavailable rather
 * than leaving somebody to wonder why the wage bill is a guess again.
 */
async function optional(db, sql, params, what) {
  try {
    return [await all(db, sql, ...params), null];
  } catch (err) {
    if (/no such table|no such column/i.test(String(err?.message ?? err))) {
      return [[], `${what} is not in this HIVE database yet.`];
    }
    throw err;
  }
}
