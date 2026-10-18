import { createNotice } from './notices.js';
import { loadDataset } from './attendance.js';
import { runningShift } from './shift-watch.js';
import { addDays, diffDays, nowIn } from '../util/dates.js';
import { sayDate, sayTime } from './email-design.js';
import { firstUsableEmail, isEmail } from './notify.js';

/**
 * Off sick, absent, or here?
 *
 * Somebody is on the rota, their shift started half an hour ago and the
 * terminal has seen nothing. The shift watcher has already buzzed them. This
 * asks the people running the floor the one question that settles the day,
 * and keeps asking until a planner, a supervisor or an administrator answers.
 *
 * Nobody is marked absent by the app. The answer is a person's, and the
 * question exists so that the answer is given on the morning, by somebody who
 * knows, rather than a week later from memory.
 *
 * HOW OFTEN. Every half hour while the shift is still running, because that is
 * when an answer is worth most. After the shift, every hour between seven in
 * the morning and nine at night on the same day, and every three hours in the
 * daytime after that. It never stops on its own: the only things that close a
 * question are an answer, a clock-in turning up, or somebody settling the day
 * some other way.
 */

/** How long after the start of the shift, past its grace, to ask. */
export const ASK_AFTER_MINUTES = 30;

/** How often to ask again while the shift is still running. */
const REPEAT_ON_SHIFT = 30;

/** And after the shift has ended, on the day itself and on later days. */
const REPEAT_SAME_DAY = 60;
const REPEAT_LATER = 180;

/** The hours, local time, a question that has outlived its shift is asked in. */
const DAY_STARTS = 7;
const DAY_ENDS = 21;

/** Days after the last sick day to send the certificate in. */
export const NOTE_DUE_DAYS = 3;

/** Minutes since the epoch for a local "YYYY-MM-DD HH:MM". Good for differences only. */
const absOf = (stamp) => Date.parse(`${String(stamp).replace(' ', 'T').slice(0, 16)}:00Z`) / 60000;

const recordEmail = (row) => (isEmail(String(row?.login_email ?? '').trim()) ? null : firstUsableEmail(row?.personal_email));

export async function watchAbsences(db, { timezone = 'UTC', ctx = null } = {}) {
  const on = await db.prepare("SELECT value FROM settings WHERE key = 'att_absence_ask'")
    .first().catch(() => null);
  if (on?.value === '0') return { asked: 0, opened: 0, closed: 0, reason: 'switched off' };

  const now = nowIn(timezone);
  const [today, clock] = now.split(' ');
  const hour = Number(clock.slice(0, 2));
  const minutesNow = absOf(now) - absOf(`${today} 00:00`);
  const yesterday = addDays(today, -1);

  const [ds, punches, ruled, said] = await Promise.all([
    // The day before yesterday too, for "off sick yesterday" behind an
    // overnight shift that began yesterday.
    loadDataset(db, { from: addDays(today, -2), to: today }),
    db.prepare('SELECT DISTINCT staff_id, day FROM att_punches WHERE day >= ?1')
      .bind(addDays(today, -14)).all().catch(() => ({ results: [] })),
    db.prepare("SELECT staff_id, day, resolved_by FROM att_days WHERE resolution = 'resolved' AND day >= ?1")
      .bind(addDays(today, -14)).all().catch(() => ({ results: [] })),
    db.prepare(
      `SELECT id, staff_id, from_day, to_day FROM att_leave
        WHERE status = 'pending' AND reason_code = 'sick_leave' AND to_day >= ?1`,
    ).bind(yesterday).all().catch(() => ({ results: [] })),
  ]);

  const seen = new Set((punches.results ?? []).map((r) => `${Number(r.staff_id)}|${r.day}`));
  const settledBy = new Map((ruled.results ?? []).map((r) => [`${Number(r.staff_id)}|${r.day}`, r.resolved_by]));
  const here = (staffId, day) => seen.has(`${staffId}|${day}`)
    || (day < today && seen.has(`${staffId}|${addDays(day, 1)}`));

  // New questions first.
  let opened = 0;
  for (const staff of ds.staff) {
    if (!staff.active) continue;
    const staffId = Number(staff.id);
    const found = runningShift(ds, staffId, today, minutesNow)
      ?? runningShift(ds, staffId, yesterday, minutesNow + 24 * 60);
    if (!found) continue;

    const wait = Number(found.shift.grace_in_minutes ?? 0) + ASK_AFTER_MINUTES;
    if (found.minutesIn < wait) continue;
    if (here(staffId, found.day)) continue;
    if (settledBy.has(`${staffId}|${found.day}`)) continue;

    const before = ds.leaveBy.get(`${staffId}|${addDays(found.day, -1)}`);
    const followUp = before?.reason_code === 'sick_leave' ? 1 : 0;
    const asked = (said.results ?? []).find((l) => Number(l.staff_id) === staffId
      && l.from_day <= found.day && l.to_day >= found.day);

    const made = await db.prepare(
      `INSERT OR IGNORE INTO att_absence_q
         (staff_id, day, shift_name, starts_at, ends_at, follow_up, said_leave_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      staffId, found.day, found.shift.name ?? null, found.shift.starts_at ?? null,
      found.shift.ends_at ?? null, followUp, asked?.id ?? null,
    ).run().catch(() => null);
    if (Number(made?.meta?.changes ?? 0) > 0) opened += 1;
  }

  // Then every question still waiting: closed if the day has answered itself,
  // asked again if it is time.
  const open = await db.prepare('SELECT * FROM att_absence_q WHERE answer IS NULL ORDER BY day, id')
    .all().catch(() => ({ results: [] }));

  let asked = 0;
  let closed = 0;
  for (const q of open.results ?? []) {
    const staffId = Number(q.staff_id);
    const staff = ds.staffById.get(staffId)
      ?? await db.prepare('SELECT id, name, department, active FROM att_staff WHERE id = ?')
        .bind(staffId).first().catch(() => null);

    const settled = !staff?.active ? 'HIVE (no longer on the staff list)'
      : here(staffId, q.day) ? 'came_in'
        : settledBy.get(`${staffId}|${q.day}`)
          ?? (await leaveOn(db, staffId, q.day))?.decided_by
          ?? null;
    if (settled) {
      const cameIn = settled === 'came_in';
      await db.prepare(
        `UPDATE att_absence_q SET answer = ?1, answered_by = ?2, answered_at = datetime('now')
          WHERE id = ?3 AND answer IS NULL`,
      ).bind(cameIn ? 'came_in' : 'settled', cameIn ? 'HIVE (a clock-in arrived)' : settled, q.id).run();
      closed += 1;
      continue;
    }

    // Still within the shift, or not.
    const start = absOf(`${q.day} ${q.starts_at ?? '00:00'}`);
    let end = absOf(`${q.day} ${q.ends_at ?? '23:59'}`);
    if (end <= start) end += 24 * 60;
    const nowAbs = absOf(now);
    const onShift = nowAbs < end;

    let gap = REPEAT_ON_SHIFT;
    if (!onShift) {
      if (hour < DAY_STARTS || hour >= DAY_ENDS) continue;
      gap = q.day >= yesterday && nowAbs - end < 12 * 60 ? REPEAT_SAME_DAY : REPEAT_LATER;
    }
    if (q.times_asked > 0 && q.last_asked_at && nowAbs - absOf(q.last_asked_at) < gap - 2) continue;

    // Claimed before it is sent, so two overlapping runs cannot both ask.
    const claim = await db.prepare(
      `UPDATE att_absence_q SET times_asked = times_asked + 1, last_asked_at = ?1
        WHERE id = ?2 AND answer IS NULL AND times_asked = ?3`,
    ).bind(now, q.id, Number(q.times_asked)).run().catch(() => null);
    if (!Number(claim?.meta?.changes ?? 0)) continue;

    const late = Math.max(0, Math.round(nowAbs - start));
    await createNotice(db, questionNotice({ q, staff, late, first: Number(q.times_asked) === 0 }), ctx);
    asked += 1;
  }

  const notes = await chaseSickNotes(db, { today, hour, ctx }).catch((err) => {
    console.error('Sick note chase failed', err);
    return { reminded: 0 };
  });

  return { opened, asked, closed, notesReminded: notes.reminded, day: today };
}

/** Approved leave of any kind covering a day, if there is some. */
async function leaveOn(db, staffId, day) {
  return db.prepare(
    `SELECT id, decided_by FROM att_leave
      WHERE staff_id = ?1 AND status = 'approved' AND from_day <= ?2 AND to_day >= ?2
      LIMIT 1`,
  ).bind(staffId, day).first().catch(() => null);
}

/** "34 minutes", "2 hours", for a phone notification. */
export function sayLate(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour' : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'a day' : `${days} days`;
}

/** The question, as it goes to the bell, the phone and, the first time, the inbox. */
export function questionNotice({ q, staff, late, first }) {
  const name = staff?.name ?? 'Somebody';
  const shift = q.shift_name ? `${q.shift_name} ${sayTime(q.starts_at)}` : 'their shift';
  const title = q.follow_up ? `Is ${name} still off sick?` : `Is ${name} off sick?`;
  const lead = q.follow_up
    ? `Off sick yesterday. No clock-in today, ${sayLate(late)} after the start of the ${shift}.`
    : `No clock-in ${sayLate(late)} after the start of the ${shift}.`;
  const body = `${lead} Off sick, absent, or here? Answer in HIVE.`
    + (q.said_leave_id ? ` ${name} said in HIVE they are off sick.` : '');

  return {
    kind: 'attendance.absence_question',
    level: 'warn',
    title: first ? title : `Still to answer: ${title.charAt(0).toLowerCase()}${title.slice(1)}`,
    body,
    link: '#/home',
    day: q.day,
    actor: 'HIVE',
    // Planners, supervisors, managers and administrators: whoever can build
    // the rota. Settling a day is theirs to do.
    audience: 'att_rota',
    push: true,
    // An inbox once. The phone every time, which is what gets it answered.
    email: first,
    cc: false,
    text: false,
    mail: {
      status: 'Needs your answer',
      tone: 'warn',
      eyebrow: 'Attendance',
      subject: title,
      preheader: lead,
      headline: title,
      sub: `${staff?.department ? `${staff.department} · ` : ''}${sayDate(q.day)}`,
      facts: [
        ['Shift', q.shift_name ? `${q.shift_name}, ${sayTime(q.starts_at)} to ${sayTime(q.ends_at)}` : null],
        ['Clock-in', 'None yet', { tone: 'warn' }],
      ],
      note: 'Open HIVE and answer: off sick, absent, or here. Nobody is marked absent until '
        + 'somebody answers, and HIVE keeps asking until then.',
      button: 'Answer in HIVE',
      why: 'You get this because you look after the rota.',
    },
  };
}

/**
 * Whether a sick leave needs a certificate, and when by.
 *
 * Two days or more, counted as calendar days off. Due three days after the
 * last of them.
 */
export function noteNeeded(leave) {
  const span = diffDays(leave.from_day, leave.to_day) + 1;
  return span >= 2 ? { due: addDays(leave.to_day, NOTE_DUE_DAYS), span } : null;
}

/**
 * Put the certificate on the list, or keep its date in step with the leave.
 *
 * Called whenever a sick leave is written or stretched. A leave that has come
 * back down to one day keeps an owed note as it was: somebody has to waive it.
 */
export async function owedNoteFor(db, leave) {
  const need = noteNeeded(leave);
  if (!need) return null;
  await db.prepare(
    `INSERT INTO att_sick_note (leave_id, staff_id, due_on) VALUES (?1, ?2, ?3)
     ON CONFLICT (leave_id) DO UPDATE SET due_on = excluded.due_on
       WHERE att_sick_note.status = 'owed'`,
  ).bind(leave.id, leave.staff_id, need.due).run();
  return need;
}

/**
 * A reminder a day to whoever still owes a certificate, from the morning after
 * the last sick day. And on the first day past the date, the office is told
 * once.
 */
async function chaseSickNotes(db, { today, hour, ctx }) {
  if (hour < 9) return { reminded: 0 };
  const owed = await db.prepare(
    `SELECT n.*, l.from_day, l.to_day, s.name, u.id AS user_id, u.email AS login_email,
            hp.personal_email
       FROM att_sick_note n
       JOIN att_leave l ON l.id = n.leave_id
       JOIN att_staff s ON s.id = n.staff_id
       LEFT JOIN users u ON u.staff_id = n.staff_id AND u.active = 1
       LEFT JOIN hr_profile hp ON hp.staff_id = n.staff_id
      WHERE n.status = 'owed' AND l.status = 'approved' AND l.to_day < ?1
        AND COALESCE(n.reminded_on, '') < ?1`,
  ).bind(today).all().catch(() => ({ results: [] }));

  let reminded = 0;
  for (const n of owed.results ?? []) {
    const claim = await db.prepare(
      "UPDATE att_sick_note SET reminded_on = ?1 WHERE leave_id = ?2 AND COALESCE(reminded_on, '') < ?1",
    ).bind(today, n.leave_id).run().catch(() => null);
    if (!Number(claim?.meta?.changes ?? 0)) continue;

    const late = today > n.due_on;
    const days = diffDays(n.from_day, n.to_day) + 1;
    if (n.user_id || recordEmail(n)) {
      await createNotice(db, {
        kind: 'attendance.sick_note_owed',
        level: late ? 'warn' : 'info',
        title: late ? 'Your medical certificate is late' : `Send your medical certificate by ${sayDate(n.due_on)}`,
        body: `You were off sick for ${days} days. Two days or more needs a certificate from the `
          + 'clinic or hospital. Without one, the days are unpaid. Take a photo of it in HIVE.',
        link: '#/my-day',
        day: n.to_day,
        actor: 'HIVE',
        userId: n.user_id ?? null,
        emailTo: recordEmail(n),
        push: true,
        email: true,
        cc: false,
        text: false,
        mail: {
          status: late ? 'Late' : 'To do',
          tone: 'warn',
          eyebrow: 'Sick leave',
          subject: late ? 'Your medical certificate is late' : `Send your medical certificate by ${sayDate(n.due_on)}`,
          preheader: 'Take a photo of it in HIVE.',
          headline: 'Send your medical certificate',
          sub: `${days} days off sick`,
          facts: [['Due', sayDate(n.due_on), late ? { tone: 'warn' } : undefined]],
          note: 'Two days or more off sick needs a certificate from the clinic or hospital. '
            + 'Without one, the days are unpaid. Open HIVE and take a photo of it.',
          button: 'Open HIVE',
          why: 'You get this because you were off sick.',
        },
      }, ctx);
    }

    if (n.due_on === addDays(today, -1)) {
      await createNotice(db, {
        kind: 'attendance.sick_note_late',
        level: 'warn',
        title: `${n.name}: medical certificate not in`,
        body: `Off sick ${days} days, certificate due ${sayDate(n.due_on)}. Change the leave to `
          + 'unpaid, or wait for it.',
        link: `#/att-leave?staffId=${n.staff_id}`,
        day: n.to_day,
        actor: 'HIVE',
        audience: 'att_manage',
        push: true,
        email: true,
        cc: false,
        text: false,
      }, ctx);
    }
    reminded += 1;
  }
  return { reminded };
}
