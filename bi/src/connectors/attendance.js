import { all } from '../lib/db.js';
import { emptyBundle } from './bundle.js';
import { minor } from '../lib/money.js';

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

export async function pull({ db, from, to }) {
  const bundle = emptyBundle();
  if (!db) {
    bundle.notes.push('No HIVE database is bound to this Worker.');
    return bundle;
  }

  const staff = await all(db, `
    SELECT id, employee_no, name, department, job_title, active
      FROM att_staff`);

  const byId = new Map();
  for (const row of staff) {
    const line = lineForDepartment(row.department);
    byId.set(row.id, { line, department: row.department || '' });
    bundle.people.push({
      externalId: String(row.id),
      employeeNo: row.employee_no || null,
      name: row.name,
      department: row.department || null,
      jobTitle: row.job_title || null,
      line,
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

  bundle.notes.push(`${staff.length} staff, ${days.length} staff-days`);
  return bundle;
}
