import { HttpError } from './http.js';
import { cleanNo, readLink } from './maintenance-bonus.js';
import { addDays, todayIn } from '../util/dates.js';
import { isReceptionShift } from './till-watch.js';

/**
 * Admin shifts, out to Team Tasks.
 *
 * "For those required to send a weekly plan, check their shift in HIVE. If
 * they have an admin shift, make those days visible and require the plan for
 * that day to be completed before they can submit their plan. Allow an hour
 * break (usually 1 to 2pm)."
 *
 * Team Tasks lives in the Maintenance database, so the shifts go there, once
 * a day with the nightly run (00:30), with the same link and key HIVE already
 * uses to collect the bonus and the deductions. What goes is every Admin
 * shift on the rota for the next two weeks, today included: who (by employee
 * number, the way the two systems match everybody), which day, the shift's
 * name and its hours. Each sending replaces what Maintenance had for those
 * days, so a shift moved or taken off the rota goes from Team Tasks the next
 * night. Days already gone by are left as they were sent.
 *
 * An Admin shift is one whose name, or the day's own title, says Admin (as
 * "Admin 1", "Admin 2"), the same test the till uses to know a shift has no
 * drawer. Draft days go too, marked as such: plans are due before many weeks
 * are published, and a plan made against the draft is better than none.
 */

export const isAdminShift = (name) => /\badmin\b/i.test(String(name ?? ''));

const hhmm = (v) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};

/** Every Admin shift on the rota between two days, with an employee number to match by. */
export async function adminShiftsBetween(db, from, to) {
  const rows = (await db.prepare(
    `SELECT r.day, r.published, r.title, s.name AS shift, s.starts_at, s.ends_at,
            st.employee_no, st.name AS staff_name
       FROM att_roster r
       JOIN att_shifts s ON s.id = r.shift_id
       JOIN att_staff st ON st.id = r.staff_id
      WHERE r.staff_id IS NOT NULL AND r.day BETWEEN ?1 AND ?2
      ORDER BY r.day, st.name`,
  ).bind(from, to).all()).results ?? [];
  const out = [];
  const unnumbered = new Set();
  for (const r of rows) {
    if (!isAdminShift(r.shift) && !isAdminShift(r.title)) continue;
    const starts = hhmm(r.starts_at);
    const ends = hhmm(r.ends_at);
    if (!starts || !ends) continue;
    if (!cleanNo(r.employee_no)) { unnumbered.add(r.staff_name); continue; }
    out.push({
      employee_no: String(r.employee_no).trim(),
      name: r.staff_name,
      day: r.day,
      shift: r.title && isAdminShift(r.title) ? r.title : r.shift,
      starts_at: starts,
      ends_at: ends,
      published: Number(r.published) === 1,
    });
  }
  return { shifts: out, unnumbered: [...unnumbered] };
}

/** How far ahead the shifts go: two weeks, today included. */
export const DAYS_AHEAD = 14;

/**
 * Send them. Runs from the scheduler once a day; does nothing until HIVE is
 * linked to Maintenance. Throws with a sentence a person can act on.
 */
export async function sendAdminShifts(env, { fetchImpl = fetch, today = null } = {}) {
  const out = { sent: 0, matched: 0, unmatched: [] };
  if (!env?.MAINTENANCE_LINK || !env.DB) return out;
  const link = readLink(env.MAINTENANCE_LINK);
  if (!link) throw new HttpError(503, 'HIVE is not linked to Maintenance yet.');
  const tz = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'timezone'").first().catch(() => null))?.value || 'UTC';
  const day = today ?? todayIn(tz);
  const from = day;
  const to = addDays(day, DAYS_AHEAD - 1);
  const { shifts, unnumbered } = await adminShiftsBetween(env.DB, from, to);

  let response;
  try {
    response = await fetchImpl(`${link.url}/rest/v1/rpc/mx_hive_shifts_put`, {
      method: 'POST',
      headers: {
        apikey: link.anon,
        Authorization: `Bearer ${link.anon}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_key: link.key, p_from: from, p_to: to, p_shifts: shifts }),
    });
  } catch {
    throw new HttpError(502, 'Maintenance could not be reached.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const said = data?.message || data?.error || `Maintenance answered ${response.status}.`;
    throw new HttpError(502, /mx_hive_shifts_put.* does not exist|Could not find the function/i.test(said)
      ? 'Maintenance does not take the Admin shifts yet: its database update has not been run.'
      : said);
  }
  out.sent = shifts.length;
  out.matched = Number(data?.matched ?? 0);
  out.unmatched = [
    ...unnumbered.map((n) => `${n} (no employee number in HIVE)`),
    ...(Array.isArray(data?.unmatched) ? data.unmatched.map((u) => `${u.name ?? u.employee_no} (${u.employee_no}: nobody in Maintenance has it)`) : []),
  ];
  return out;
}

/* ------------------------------------------------------------------------ *
 * Who is at the front desk.
 *
 * "The at the desk info should be picked from hive's rota."
 *
 * Maintenance's front desk page names whoever sends a guest's problem. It
 * takes the name from here: every reception shift on the rota, sent every
 * hour (a swap made this morning shows by the next hour), from yesterday (a
 * night shift that began then is still on after midnight) to two weeks ahead. A reception shift is the till's own
 * test: the shift's department (or position, or name) says Reception or Front
 * Office, or failing those the person's department does; an Admin shift
 * filed under Reception is not one. Receptionists are often not in
 * Maintenance, so these go by name, with the employee number when there is one.
 * ------------------------------------------------------------------------ */

/** Every reception shift on the rota between two days, by person. */
export async function deskShiftsBetween(db, from, to) {
  const rows = (await db.prepare(
    `SELECT r.day, r.title, s.name AS shift, s.starts_at, s.ends_at, s.department, s.position,
            st.employee_no, st.name AS staff_name, st.department AS staff_department
       FROM att_roster r
       JOIN att_shifts s ON s.id = r.shift_id
       JOIN att_staff st ON st.id = r.staff_id
      WHERE r.staff_id IS NOT NULL AND r.day BETWEEN ?1 AND ?2
      ORDER BY r.day, s.starts_at, st.name`,
  ).bind(from, to).all()).results ?? [];
  const out = [];
  for (const r of rows) {
    const shift = { name: r.shift, department: r.department, position: r.position };
    if (isAdminShift(r.title) || !isReceptionShift(shift, { department: r.staff_department })) continue;
    const starts = hhmm(r.starts_at);
    const ends = hhmm(r.ends_at);
    if (!starts || !ends || !String(r.staff_name ?? '').trim()) continue;
    out.push({
      name: String(r.staff_name).trim(),
      employee_no: cleanNo(r.employee_no) ? String(r.employee_no).trim() : null,
      day: r.day,
      shift: r.title || r.shift,
      starts_at: starts,
      ends_at: ends,
    });
  }
  return out;
}

/** Send them, every hour. Throws with a sentence a person can act on. */
export async function sendDeskShifts(env, { fetchImpl = fetch, today = null } = {}) {
  const out = { sent: 0 };
  if (!env?.MAINTENANCE_LINK || !env.DB) return out;
  const link = readLink(env.MAINTENANCE_LINK);
  if (!link) throw new HttpError(503, 'HIVE is not linked to Maintenance yet.');
  const tz = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'timezone'").first().catch(() => null))?.value || 'UTC';
  const day = today ?? todayIn(tz);
  const from = addDays(day, -1);
  const to = addDays(day, DAYS_AHEAD - 1);
  const shifts = await deskShiftsBetween(env.DB, from, to);
  let response;
  try {
    response = await fetchImpl(`${link.url}/rest/v1/rpc/mx_hive_desk_put`, {
      method: 'POST',
      headers: {
        apikey: link.anon,
        Authorization: `Bearer ${link.anon}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_key: link.key, p_from: from, p_to: to, p_shifts: shifts }),
    });
  } catch {
    throw new HttpError(502, 'Maintenance could not be reached.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const said = data?.message || data?.error || `Maintenance answered ${response.status}.`;
    throw new HttpError(502, /mx_hive_desk_put.* does not exist|Could not find the function/i.test(said)
      ? 'Maintenance does not take the front desk rota yet: its database update has not been run.'
      : said);
  }
  out.sent = shifts.length;
  return out;
}
