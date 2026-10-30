import { onClock } from './attendance.js';
import { recompute } from './attendance-ingest.js';
import { createNotice } from './notices.js';
import { firstUsableEmail, isEmail } from './notify.js';
import { sayDate, sayRange } from './email-design.js';
import { addDays, diffDays, dow, nowIn } from '../util/dates.js';

/**
 * Christmas or New Year: the rules.
 *
 * The office offers a few pairs of days (Christmas, New Year), says how many of
 * each department may have each, and asks everybody on the rota except casual
 * staff to choose one. Each person gets one choice off and works the others.
 *
 * Two ways of filling a choice. First come, first served: once a department's
 * places are taken the choice shows as full and cannot be picked. Or the
 * office decides: everybody says what they want, and the office moves people
 * where a department has gone over before it confirms.
 *
 * Confirming turns each pick into approved leave of its own kind, "Holiday
 * chosen", so it sits on the rota and on the person's shifts like any other
 * leave and the rota will not put anybody on it. A day in it that is a public
 * holiday costs nothing; any other day comes off annual leave when the round
 * says so (2 January, usually).
 *
 * Nobody is shown who else chose what. A member of staff sees how many places
 * are left in their own department, and that is all.
 */

export const REASON = 'holiday_choice';

/** A round and its choices, each with its limits by department. */
export async function readRound(db, id) {
  const row = await db.prepare('SELECT * FROM hol_round WHERE id = ?').bind(id).first().catch(() => null);
  if (!row) return null;
  const [options, limits] = await Promise.all([
    db.prepare('SELECT * FROM hol_option WHERE round_id = ? ORDER BY position, id').bind(id).all(),
    db.prepare(
      `SELECT l.* FROM hol_limit l JOIN hol_option o ON o.id = l.option_id WHERE o.round_id = ?`,
    ).bind(id).all(),
  ]);
  const limitsBy = new Map();
  for (const l of limits.results ?? []) {
    if (!limitsBy.has(l.option_id)) limitsBy.set(l.option_id, {});
    limitsBy.get(l.option_id)[l.department] = Number(l.places);
  }
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    mode: row.mode,
    dueOn: row.due_on,
    unanswered: row.unanswered,
    remind: Boolean(row.remind),
    chargeLeave: Boolean(row.charge_leave),
    openedAt: row.opened_at,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    options: (options.results ?? []).map((o) => ({
      id: o.id, label: o.label, from: o.from_day, to: o.to_day, limits: limitsBy.get(o.id) ?? {},
    })),
  };
}

/** The round staff are answering now, if there is one. */
export async function openRound(db) {
  const row = await db.prepare("SELECT id FROM hol_round WHERE status = 'open' ORDER BY id DESC LIMIT 1")
    .first().catch(() => null);
  return row ? readRound(db, row.id) : null;
}

/**
 * Who is asked: everybody active on the rota, less casual staff (paid by the
 * day). The same people the leave planner leaves out, for the same reason.
 */
export async function askedPeople(db) {
  const [staff, casual] = await Promise.all([
    db.prepare('SELECT * FROM att_staff WHERE active = 1 ORDER BY department, name').all(),
    db.prepare(
      `SELECT p.staff_id FROM hr_pay p
        WHERE p.basis = 'daily'
          AND p.id = (SELECT q.id FROM hr_pay q WHERE q.staff_id = p.staff_id ORDER BY q.from_day DESC, q.id DESC LIMIT 1)`,
    ).all().catch(() => ({ results: [] })),
  ]);
  const casualIds = new Set((casual.results ?? []).map((r) => Number(r.staff_id)));
  return (staff.results ?? [])
    .filter((s) => onClock(s) && !casualIds.has(Number(s.id)))
    .map((s) => ({ id: Number(s.id), name: s.name, department: s.department || 'Other' }));
}

/** Every answer so far, by person. */
export async function picksFor(db, roundId) {
  const rows = await db.prepare('SELECT * FROM hol_pick WHERE round_id = ?').bind(roundId).all()
    .catch(() => ({ results: [] }));
  return new Map((rows.results ?? []).map((r) => [Number(r.staff_id), r]));
}

/** Places a department has on a choice; null when there is no limit. */
export const placesOf = (option, department) => {
  const n = option.limits?.[department];
  return Number.isFinite(n) ? n : null;
};

/** How many of a department have taken a choice, leaving one person out. */
export function takenBy(picks, people, optionId, department, exceptStaffId = null) {
  const inDept = new Set(people.filter((p) => p.department === department).map((p) => p.id));
  let n = 0;
  for (const [staffId, pick] of picks) {
    if (staffId === exceptStaffId || !inDept.has(staffId)) continue;
    if (Number(pick.option_id) === Number(optionId)) n += 1;
  }
  return n;
}

/** Places left on a choice for somebody, counting everybody but them. */
export function leftFor(option, picks, people, person) {
  const places = placesOf(option, person.department);
  if (places == null) return null;
  return Math.max(0, places - takenBy(picks, people, option.id, person.department, person.id));
}

/** The days of a choice that are not public holidays: what may come off leave. */
export async function chargeableDays(db, option) {
  const days = [];
  for (let d = option.from; d <= option.to; d = addDays(d, 1)) days.push(d);
  const rows = await db.prepare(
    `SELECT day, observed_on FROM att_holidays WHERE active = 1
      AND (day BETWEEN ?1 AND ?2 OR observed_on BETWEEN ?1 AND ?2)`,
  ).bind(option.from, option.to).all().catch(() => ({ results: [] }));
  // The date itself and the Monday it is observed on both count: Boxing Day
  // on a Saturday is still a holiday to the person having it off.
  const off = new Set((rows.results ?? []).flatMap((r) => [r.day, r.observed_on].filter(Boolean)));
  return days.filter((d) => !off.has(d));
}

const recordEmail = (row) => (isEmail(String(row?.login_email ?? '').trim()) ? null : firstUsableEmail(row?.personal_email));

/** Logins and addresses for a set of people. */
export async function contactsFor(db, staffIds) {
  if (!staffIds.length) return new Map();
  const rows = await db.prepare(
    `SELECT s.id AS staff_id, s.name, u.id AS user_id, u.email AS login_email, hp.personal_email
       FROM att_staff s
       LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
       LEFT JOIN hr_profile hp ON hp.staff_id = s.id
      WHERE s.id IN (${staffIds.map(() => '?').join(',')})`,
  ).bind(...staffIds).all().catch(() => ({ results: [] }));
  const map = new Map();
  for (const r of rows.results ?? []) if (!map.has(Number(r.staff_id))) map.set(Number(r.staff_id), r);
  return map;
}

const choicesLine = (round) => round.options.map((o) => `${o.label} (${sayRange(o.from, o.to)})`).join(' or ');

/** The question, or a reminder of it, to one person. */
export async function askPerson(db, { round, person, contact, reminder = false, actor = null }, ctx) {
  if (!contact?.user_id && !recordEmail(contact)) return false;
  const first = String(person.name ?? '').split(/\s+/)[0];
  const title = reminder ? `Choose your holiday: ${round.title}` : `${round.title}: which would you like off?`;
  await createNotice(db, {
    kind: 'leave.holiday_asked',
    level: reminder ? 'warn' : 'info',
    title,
    body: `${choicesLine(round)}. Answer by ${sayDate(round.dueOn)}.`,
    link: '#/my-holiday',
    actor: actor || 'HIVE',
    userId: contact.user_id ?? null,
    emailTo: recordEmail(contact),
    push: true,
    email: true,
    cc: false,
    text: false,
    mail: {
      status: reminder ? 'Reminder' : 'Choose your holiday',
      tone: reminder ? 'warn' : 'info',
      eyebrow: 'Holidays',
      subject: title,
      preheader: `Answer by ${sayDate(round.dueOn)}.`,
      headline: `${first}, which would you like off?`,
      sub: `Answer by ${sayDate(round.dueOn)} · one tap on your phone`,
      facts: round.options.map((o) => [o.label, sayRange(o.from, o.to)]),
      note: 'You get one of these off and work the other. Places in each department are limited, '
        + (round.mode === 'first' ? 'and they go to whoever answers first.' : 'and the office settles it where too many choose the same.'),
      button: 'Choose my holiday',
      why: 'You get this because you are on the rota over the holidays.'
        + (round.remind ? ' A reminder comes every Monday until you answer, then on each of the last three days.' : ''),
    },
  }, ctx);
  return true;
}

/** Ask everybody, when the round is opened. */
export async function askEverybody(db, round, ctx, today = null, actor = null) {
  const people = await askedPeople(db);
  const contacts = await contactsFor(db, people.map((p) => p.id));
  let n = 0;
  for (const person of people) {
    await db.prepare('INSERT OR IGNORE INTO hol_pick (round_id, staff_id) VALUES (?1, ?2)')
      .bind(round.id, person.id).run();
    if (!await askPerson(db, { round, person, contact: contacts.get(person.id), actor }, ctx)) continue;
    n += 1;
    if (today) {
      await db.prepare('UPDATE hol_pick SET reminded_on = ?1 WHERE round_id = ?2 AND staff_id = ?3')
        .bind(today, round.id, person.id).run();
    }
  }
  return n;
}

/** Remind whoever has not answered, now. Returns how many were reminded. */
export async function remindWaiting(db, round, ctx, { today = null, actor = null, onlyDue = false } = {}) {
  const people = await askedPeople(db);
  const picks = await picksFor(db, round.id);
  const waiting = people.filter((p) => !picks.get(p.id)?.option_id);
  const contacts = await contactsFor(db, waiting.map((p) => p.id));
  let n = 0;
  for (const person of waiting) {
    await db.prepare('INSERT OR IGNORE INTO hol_pick (round_id, staff_id) VALUES (?1, ?2)')
      .bind(round.id, person.id).run();
    if (onlyDue && today) {
      const claim = await db.prepare(
        `UPDATE hol_pick SET reminded_on = ?1
          WHERE round_id = ?2 AND staff_id = ?3 AND COALESCE(reminded_on, '') < ?1`,
      ).bind(today, round.id, person.id).run();
      if (!Number(claim?.meta?.changes ?? 0)) continue;
    }
    if (await askPerson(db, { round, person, contact: contacts.get(person.id), reminder: true, actor }, ctx)) n += 1;
  }
  return n;
}

/**
 * The reminders, from the cron. Every Monday while a round is open, and each
 * of the last three days before it is due; never before nine.
 */
export async function watchHolidayChoices(db, { timezone = 'UTC', ctx = null } = {}) {
  const now = nowIn(timezone);
  const today = now.slice(0, 10);
  if (Number(now.slice(11, 13)) < 9) return { reminded: 0 };
  const rows = await db.prepare("SELECT id FROM hol_round WHERE status = 'open' AND remind = 1")
    .all().catch(() => ({ results: [] }));
  let reminded = 0;
  for (const { id } of rows.results ?? []) {
    const round = await readRound(db, id);
    if (!round || today > round.dueOn) continue;
    const lastDays = diffDays(today, round.dueOn) < 3;
    // dow() counts from Monday as 0.
    if (!lastDays && dow(today) !== 0) continue;
    reminded += await remindWaiting(db, round, ctx, { today, onlyDue: true });
  }
  return { reminded };
}

/**
 * Everything that would stop a round being confirmed, in words the office
 * can act on. Empty when it can go.
 */
export function whatStopsIt(round, people, picks) {
  const problems = [];
  const waiting = people.filter((p) => !picks.get(p.id)?.option_id);
  if (waiting.length && round.unanswered === 'office') {
    problems.push(`${waiting.length} ${waiting.length === 1 ? 'person has' : 'people have'} not answered. Choose for them first.`);
  }
  for (const option of round.options) {
    for (const department of [...new Set(people.map((p) => p.department))]) {
      const places = placesOf(option, department);
      if (places == null) continue;
      const taken = takenBy(picks, people, option.id, department);
      if (taken > places) {
        problems.push(`${department} has ${taken} on ${option.label} and ${places} ${places === 1 ? 'place' : 'places'}. Move ${taken - places}.`);
      }
    }
  }
  return problems;
}

/** The choice with most room in somebody's department, for anybody not answered. */
export function roomiestFor(round, picks, people, person) {
  let best = null;
  let bestLeft = -Infinity;
  for (const option of round.options) {
    const left = leftFor(option, picks, people, person);
    const score = left == null ? 1e6 : left;
    if (score > bestLeft) { best = option; bestLeft = score; }
  }
  return best;
}

/**
 * Confirm: give anybody not answered a choice with room, write every pick as
 * approved leave, and tell everybody. Somebody who already has leave over any
 * of the days keeps what they have, and is reported rather than doubled up.
 */
export async function confirmRound(db, round, { actor, ctx = null } = {}) {
  const people = await askedPeople(db);
  let picks = await picksFor(db, round.id);

  const given = [];
  if (round.unanswered === 'room') {
    for (const person of people) {
      if (picks.get(person.id)?.option_id) continue;
      const option = roomiestFor(round, picks, people, person);
      if (!option) continue;
      await db.prepare(
        `INSERT INTO hol_pick (round_id, staff_id, option_id, picked_at, by_office, picked_by)
         VALUES (?1, ?2, ?3, datetime('now'), 1, ?4)
         ON CONFLICT (round_id, staff_id) DO UPDATE SET option_id = ?3, picked_at = datetime('now'), by_office = 1, picked_by = ?4`,
      ).bind(round.id, person.id, option.id, actor).run();
      picks.set(person.id, { option_id: option.id, by_office: 1 });
      given.push(person.name);
    }
    picks = await picksFor(db, round.id);
  }

  const optionBy = new Map(round.options.map((o) => [o.id, o]));
  const charge = new Map();
  for (const o of round.options) charge.set(o.id, round.chargeLeave ? (await chargeableDays(db, o)).length : 0);

  const written = [];
  const skipped = [];
  const contacts = await contactsFor(db, people.map((p) => p.id));
  for (const person of people) {
    const pick = picks.get(person.id);
    const option = optionBy.get(Number(pick?.option_id));
    if (!option || pick.leave_id) continue;
    const clash = await db.prepare(
      `SELECT id FROM att_leave WHERE staff_id = ?1 AND status IN ('approved', 'pending')
          AND from_day <= ?2 AND to_day >= ?3`,
    ).bind(person.id, option.to, option.from).first();
    if (clash) { skipped.push(person.name); continue; }
    const leave = await db.prepare(
      `INSERT INTO att_leave
         (staff_id, reason_code, from_day, to_day, days, half_day, status, reason,
          requested_by, decided_by, decided_at, estimated)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'approved', ?6, ?7, ?7, datetime('now'), 0)
       RETURNING id`,
    ).bind(person.id, REASON, option.from, option.to, charge.get(option.id) ?? 0,
      `${option.label} · ${round.title}`, actor).first();
    await db.prepare('UPDATE hol_pick SET leave_id = ?1 WHERE round_id = ?2 AND staff_id = ?3')
      .bind(leave.id, round.id, person.id).run();
    written.push({ person, option });
  }

  await db.prepare(
    "UPDATE hol_round SET status = 'confirmed', confirmed_at = datetime('now'), confirmed_by = ?1 WHERE id = ?2",
  ).bind(actor, round.id).run();

  const ids = written.map((w) => w.person.id);
  const from = round.options.reduce((d, o) => (o.from < d ? o.from : d), round.options[0]?.from);
  const to = round.options.reduce((d, o) => (o.to > d ? o.to : d), round.options[0]?.to);
  if (ids.length && from && to) await recompute(db, { staffIds: ids, from, to });

  for (const { person, option } of written) {
    const contact = contacts.get(person.id);
    if (!contact?.user_id && !recordEmail(contact)) continue;
    const others = round.options.filter((o) => o.id !== option.id);
    const days = charge.get(option.id) ?? 0;
    await createNotice(db, {
      kind: 'leave.holiday_confirmed',
      level: 'good',
      title: `${option.label} off: ${sayRange(option.from, option.to)}`,
      body: `${others.length ? `You work ${others.map((o) => `${o.label} (${sayRange(o.from, o.to)})`).join(' and ')}. ` : ''}`
        + (days ? `${days} day${days === 1 ? '' : 's'} come${days === 1 ? 's' : ''} off your annual leave.` : 'Nothing comes off your annual leave.'),
      link: '#/my-holiday',
      actor: 'HIVE',
      userId: contact.user_id ?? null,
      emailTo: recordEmail(contact),
      push: true,
      email: true,
      cc: false,
      text: false,
    }, ctx);
  }

  return { written: written.length, given, skipped };
}
