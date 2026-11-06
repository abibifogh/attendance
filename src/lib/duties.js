import { loadDataset, onRota, scheduleFor } from './attendance.js';
import { createNotice } from './notices.js';
import { addDays, nowIn } from '../util/dates.js';

/**
 * Duties on a shift.
 *
 * A job somebody does on top of the shift they already have: making staff
 * lunch, the common areas, the laundry. It rides on their shift as a tag. No
 * second card on the rota, no second clock-in, and the hours stay the shift's.
 *
 * A duty can also BE a shift: the Common area shift is the common area. On a
 * day somebody is on one of those, the duty is covered by their own shift and
 * nobody needs to be given it. Only on a day nobody is does somebody else have
 * it added to theirs.
 */

const ids = (text) => {
  try { return (JSON.parse(text || '[]') || []).map(Number).filter((n) => Number.isInteger(n) && n > 0); } catch { return []; }
};

export const stepsOf = (text) => String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12);

export function dutyView(row) {
  return {
    id: Number(row.id),
    name: row.name,
    department: row.department || null,
    shiftIds: ids(row.shift_ids),
    kind: row.kind || null,
    readyBy: row.ready_by || null,
    beforeOnly: Boolean(row.before_only),
    steps: stepsOf(row.steps),
    stepsText: row.steps ?? '',
    needsDaily: Boolean(row.needs_daily),
    tellBefore: Boolean(row.tell_before),
    fair: Boolean(row.fair),
    active: Boolean(row.active),
  };
}

export async function listDuties(db, { all = false } = {}) {
  const rows = await db.prepare(
    `SELECT * FROM rota_duty ${all ? '' : 'WHERE active = 1'} ORDER BY sort, name`,
  ).all().catch(() => ({ results: [] }));
  return (rows.results ?? []).map(dutyView);
}

/** What somebody is on that day, if anything. */
const shiftOn = (ds, staffId, day) => scheduleFor(ds, staffId, day).shift ?? null;

/** Whether a shift lets its person take a duty that must be ready by a time. */
export function inTime(duty, shift) {
  if (!shift) return false;
  if (!duty.beforeOnly || !duty.readyBy) return true;
  // A shift running overnight from the evening before is not on in the morning.
  return String(shift.starts_at) < String(duty.readyBy);
}

const firstOf = (name) => String(name ?? '').trim().split(/\s+/)[0];
const monthOf = (day) => String(day).slice(0, 7);

/**
 * Every duty on every day of a period: who has it by their own shift, who has
 * it added, who could be given it and how often each has had it this month.
 * The rota draws its duty rows from this, and the fill uses it.
 */
export async function dutyBoard(db, { from, to, ds = null, duties = null }) {
  duties = duties ?? await listDuties(db);
  if (!duties.length) return { duties: [], days: [], cells: {} };
  ds = ds ?? await loadDataset(db, { from: addDays(from, -1), to: addDays(to, 1) });

  const monthFrom = `${monthOf(from)}-01`;
  const monthTo = `${monthOf(to)}-31`;
  const [assigned, counted] = await Promise.all([
    db.prepare('SELECT * FROM rota_duty_day WHERE day BETWEEN ?1 AND ?2').bind(from, to).all()
      .catch(() => ({ results: [] })),
    db.prepare(
      `SELECT duty_id, staff_id, substr(day, 1, 7) AS month, COUNT(*) AS n
         FROM rota_duty_day WHERE day BETWEEN ?1 AND ?2 GROUP BY duty_id, staff_id, month`,
    ).bind(monthFrom, monthTo).all().catch(() => ({ results: [] })),
  ]);
  const counts = new Map((counted.results ?? []).map((r) => [`${r.duty_id}|${r.staff_id}|${r.month}`, Number(r.n)]));
  const byDayDuty = new Map();
  for (const a of assigned.results ?? []) {
    const key = `${a.day}|${a.duty_id}`;
    if (!byDayDuty.has(key)) byDayDuty.set(key, []);
    byDayDuty.get(key).push(a);
  }
  // Shifts that are themselves a duty, of any duty: whoever is on one is
  // somebody else's last choice for an extra one.
  const dutyShifts = new Set(duties.flatMap((d) => d.shiftIds));
  const people = ds.staff.filter(onRota);

  const days = [];
  const cells = {};
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const row = { day, duties: [] };
    for (const duty of duties) {
      const inDept = people.filter((s) => !duty.department || s.department === duty.department);
      const byShift = [];
      for (const s of people) {
        const sh = shiftOn(ds, s.id, day);
        if (sh && duty.shiftIds.includes(Number(sh.id))) byShift.push({ staffId: s.id, name: s.name, shift: sh.name });
      }
      const added = [];
      for (const a of byDayDuty.get(`${day}|${duty.id}`) ?? []) {
        const s = ds.staffById.get(Number(a.staff_id));
        const sh = s ? shiftOn(ds, s.id, day) : null;
        // A duty rides on a shift: somebody taken off the day takes it off
        // with them, and it comes back if the shift does.
        if (!s || !sh) continue;
        let done = [];
        try { done = JSON.parse(a.done || '[]'); } catch { done = []; }
        added.push({ staffId: s.id, name: s.name, first: firstOf(s.name), shift: sh.name, startsAt: sh.starts_at, done });
        const key = `${s.id}|${day}`;
        (cells[key] = cells[key] ?? []).push({ dutyId: duty.id, name: duty.name });
      }
      const eligible = inDept
        .map((s) => ({ s, sh: shiftOn(ds, s.id, day) }))
        .filter(({ sh }) => sh)
        .map(({ s, sh }) => ({
          staffId: s.id,
          name: s.name,
          shift: sh.name,
          startsAt: sh.starts_at,
          ok: inTime(duty, sh),
          own: duty.shiftIds.includes(Number(sh.id)),
          onDutyShift: dutyShifts.has(Number(sh.id)),
          count: counts.get(`${duty.id}|${s.id}|${monthOf(day)}`) ?? 0,
          has: added.some((a) => a.staffId === s.id),
        }))
        .filter((e) => !e.own)
        .sort((a, b) => (b.ok - a.ok) || (a.onDutyShift - b.onDutyShift)
          || (duty.fair ? a.count - b.count : 0) || a.name.localeCompare(b.name));
      row.duties.push({
        dutyId: duty.id,
        byShift,
        added,
        eligible,
        gap: duty.needsDaily && !byShift.length && !added.length,
        suggest: eligible.find((e) => e.ok) ?? null,
      });
    }
    days.push(row);
  }
  return { duties, days, cells };
}

/** Give a duty to somebody on a day, or take it off them. */
export async function setDuty(db, { dutyId, day, staffId, on = true, by = null, ds = null }) {
  const duty = (await listDuties(db)).find((d) => d.id === Number(dutyId));
  if (!duty) return { ok: false, error: 'No such duty.' };
  if (!on) {
    await db.prepare('DELETE FROM rota_duty_day WHERE duty_id = ?1 AND day = ?2 AND staff_id = ?3')
      .bind(duty.id, day, staffId).run();
    return { ok: true, duty };
  }
  ds = ds ?? await loadDataset(db, { from: addDays(day, -1), to: addDays(day, 1) });
  const person = ds.staffById.get(Number(staffId));
  if (!person) return { ok: false, error: 'No such member of staff.' };
  const sh = shiftOn(ds, person.id, day);
  if (!sh) return { ok: false, error: `${person.name} has no shift that day. A duty goes on a shift.` };
  if (!inTime(duty, sh)) {
    return { ok: false, error: `${person.name} starts at ${sh.starts_at}, after ${duty.name.toLowerCase()} is due at ${duty.readyBy}.` };
  }
  await db.prepare(
    `INSERT INTO rota_duty_day (duty_id, day, staff_id, set_by) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (duty_id, day, staff_id) DO NOTHING`,
  ).bind(duty.id, day, person.id, by).run();
  return { ok: true, duty, person, shift: sh };
}

/** Fill the days nobody has a duty, fewest this month first. */
export async function fillDuty(db, { dutyId, from, to, by = null }) {
  const duties = (await listDuties(db)).filter((d) => d.id === Number(dutyId));
  if (!duties.length) return { filled: 0 };
  const ds = await loadDataset(db, { from: addDays(from, -1), to: addDays(to, 1) });
  const board = await dutyBoard(db, { from, to, ds, duties });
  const extra = new Map(); // given in this fill, so the count moves as it goes
  let filled = 0;
  for (const day of board.days) {
    const cell = day.duties[0];
    if (!cell.gap) continue;
    const pick = cell.eligible.filter((e) => e.ok)
      .map((e) => ({ ...e, count: e.count + (extra.get(`${e.staffId}|${day.day.slice(0, 7)}`) ?? 0) }))
      .sort((a, b) => (a.onDutyShift - b.onDutyShift) || (duties[0].fair ? a.count - b.count : 0) || a.name.localeCompare(b.name))[0];
    if (!pick) continue;
    // eslint-disable-next-line no-await-in-loop
    const done = await setDuty(db, { dutyId, day: day.day, staffId: pick.staffId, by, ds });
    if (done.ok) {
      filled += 1;
      const k = `${pick.staffId}|${day.day.slice(0, 7)}`;
      extra.set(k, (extra.get(k) ?? 0) + 1);
    }
  }
  return { filled };
}

/** The plates on the Lunch list for a day. */
export async function platesOn(db, day) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM lunch_order WHERE day = ? AND taking = 1')
    .bind(day).first().catch(() => null);
  return Number(row?.n ?? 0);
}

/** Somebody's duties on a run of days, for their own shifts screen. */
export async function myDuties(db, staffId, from, to) {
  const rows = await db.prepare(
    `SELECT dd.*, d.name, d.kind, d.ready_by, d.steps
       FROM rota_duty_day dd JOIN rota_duty d ON d.id = dd.duty_id
      WHERE dd.staff_id = ?1 AND dd.day BETWEEN ?2 AND ?3 AND d.active = 1
      ORDER BY dd.day, d.sort`,
  ).bind(staffId, from, to).all().catch(() => ({ results: [] }));
  const out = new Map();
  for (const r of rows.results ?? []) {
    let done = [];
    try { done = JSON.parse(r.done || '[]'); } catch { done = []; }
    const item = {
      dutyId: Number(r.duty_id), name: r.name, kind: r.kind || null, readyBy: r.ready_by || null,
      steps: stepsOf(r.steps), done, by: r.set_by || null,
      plates: r.kind === 'lunch' ? await platesOn(db, r.day) : null,
    };
    if (!out.has(r.day)) out.set(r.day, []);
    out.get(r.day).push(item);
  }
  return out;
}

/** "you make staff lunch" / "common area as well" */
export function sayDuty(duty) {
  if (duty.kind === 'lunch') return `you make ${duty.name.toLowerCase()}`;
  return `${duty.name.toLowerCase()} as well`;
}

/**
 * The evening before, from the cron: everybody given a duty for tomorrow is
 * told, with their shift, once. Only on a shift they can already see: a draft
 * rota is not out, and neither is a duty on it.
 */
export async function tellDutiesTomorrow(db, { ctx = null, now = null } = {}) {
  const settings = Object.fromEntries(((await db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('timezone', 'duty_tell_at')",
  ).all().catch(() => ({ results: [] }))).results ?? []).map((r) => [r.key, r.value]));
  const timezone = settings.timezone || 'UTC';
  const clock = now ?? nowIn(timezone);
  const at = settings.duty_tell_at || '18:00';
  if (clock.slice(11, 16) < at) return { told: 0 };
  const tomorrow = addDays(clock.slice(0, 10), 1);

  const rows = await db.prepare(
    `SELECT dd.id, dd.staff_id, dd.day, d.id AS duty_id, d.name, d.kind, d.ready_by, u.id AS user_id
       FROM rota_duty_day dd
       JOIN rota_duty d ON d.id = dd.duty_id AND d.active = 1 AND d.tell_before = 1
       JOIN users u ON u.staff_id = dd.staff_id AND u.active = 1
      WHERE dd.day = ?1 AND dd.told_at IS NULL`,
  ).bind(tomorrow).all().catch(() => ({ results: [] }));
  if (!(rows.results ?? []).length) return { told: 0 };

  const ds = await loadDataset(db, { from: clock.slice(0, 10), to: addDays(tomorrow, 1) });
  let told = 0;
  for (const r of rows.results) {
    const sched = scheduleFor(ds, Number(r.staff_id), tomorrow);
    const rostered = ds.rosterBy.get(`${r.staff_id}|${tomorrow}`);
    const out = sched.source === 'pattern' || (sched.source === 'roster' && Boolean(rostered?.published));
    if (!sched.shift || !out) continue;
    // Claimed first, so a cron that runs twice tells nobody twice.
    // eslint-disable-next-line no-await-in-loop
    const claim = await db.prepare("UPDATE rota_duty_day SET told_at = datetime('now') WHERE id = ? AND told_at IS NULL")
      .bind(r.id).run();
    if (!Number(claim?.meta?.changes ?? 0)) continue;
    const plates = r.kind === 'lunch' ? await platesOn(db, tomorrow) : null;
    const duty = { name: r.name, kind: r.kind };
    // eslint-disable-next-line no-await-in-loop
    await createNotice(db, {
      kind: 'rota.duty_tomorrow', level: 'info',
      title: `Tomorrow: ${sched.shift.name} at ${sched.shift.starts_at}, and ${sayDuty(duty)}`,
      body: [
        plates != null ? `${plates} eating so far, from the Lunch list.` : null,
        r.ready_by ? `Ready by ${r.ready_by}.` : null,
      ].filter(Boolean).join(' ') || 'It is on your shift in My shifts.',
      link: '#/att-me', day: tomorrow, userId: Number(r.user_id), push: true, email: false, cc: false,
    }, ctx).catch((err) => console.error('duty notice failed', err));
    told += 1;
  }
  return { told };
}


