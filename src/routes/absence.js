import {
  badRequest, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import { leaveDaysFor, loadDataset, scheduleFor, toMinutes } from '../lib/attendance.js';
import { recompute } from '../lib/attendance-ingest.js';
import { createNotice } from '../lib/notices.js';
import { firstUsableEmail, isEmail } from '../lib/notify.js';
import { fromBase64 } from '../lib/files.js';
import { addDays, diffDays, isDay, nowIn } from '../util/dates.js';
import { firstName, sayDate, sayRange, sayTime } from '../lib/email-design.js';
import { owedNoteFor, sayLate } from '../lib/absence-watch.js';
import { correctTimes } from './attendance.js';
import { storeFile } from './people.js';

/**
 * Off sick, absent, or here: the answers.
 *
 * The question itself is raised by the watcher in lib/absence-watch.js. This
 * is what happens when somebody answers it, and the two things the person
 * themselves can do: say they are off sick before anybody has to ask, and send
 * the certificate a second day needs.
 */

const HOW = {
  called: 'Called',
  message: 'Sent a message',
  colleague: 'Told a colleague',
  none: 'No word',
};

/** The longest anybody can be put down as off sick in one answer. */
const MOST_SICK_DAYS = 14;

/** A certificate photo, after the phone has made it smaller. */
const MAX_NOTE_BYTES = 4_000_000;

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;
const recordEmail = (row) => (isEmail(String(row?.login_email ?? '').trim()) ? null : firstUsableEmail(row?.personal_email));

async function timezoneOf(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first().catch(() => null);
  return row?.value || 'UTC';
}

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(actorOf(ctx), action, entity == null ? null : String(entity), detail ? JSON.stringify(detail) : null)
    .run().catch(() => {});
}

/** Minutes between two local "YYYY-MM-DD HH:MM" stamps. */
const minutesBetween = (a, b) => (Date.parse(`${b.replace(' ', 'T')}:00Z`) - Date.parse(`${a.replace(' ', 'T')}:00Z`)) / 60000;

/**
 * The questions waiting, and the ones settled in the last day, for the Home
 * card and the Today screen.
 */
export async function listQuestions(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const now = nowIn(timezone);
  const today = now.slice(0, 10);

  const rows = await ctx.db.prepare(
    `SELECT q.*, s.name, s.department, l.requested_at AS said_at, l.reason AS said_note
       FROM att_absence_q q
       JOIN att_staff s ON s.id = q.staff_id
       LEFT JOIN att_leave l ON l.id = q.said_leave_id
      WHERE q.answer IS NULL OR q.day >= ?1
      ORDER BY q.answer IS NOT NULL, q.day, q.starts_at, s.name`,
  ).bind(addDays(today, -1)).all().catch(() => ({ results: [] }));
  const list = rows.results ?? [];

  const year = today.slice(0, 4);
  const sick = list.length
    ? await ctx.db.prepare(
      `SELECT staff_id, SUM(diffd) AS days FROM (
         SELECT staff_id, julianday(MIN(to_day, ?2)) - julianday(MAX(from_day, ?1)) + 1 AS diffd
           FROM att_leave
          WHERE status = 'approved' AND reason_code = 'sick_leave'
            AND to_day >= ?1 AND from_day <= ?2)
        GROUP BY staff_id`,
    ).bind(`${year}-01-01`, `${year}-12-31`).all().catch(() => ({ results: [] }))
    : { results: [] };
  const sickBy = new Map((sick.results ?? []).map((r) => [Number(r.staff_id), Number(r.days) || 0]));

  const shape = (q) => {
    const started = q.starts_at ? `${q.day} ${q.starts_at}` : null;
    return {
      id: q.id,
      day: q.day,
      staff: { id: q.staff_id, name: q.name, department: q.department },
      shift: q.shift_name ? { name: q.shift_name, starts_at: q.starts_at, ends_at: q.ends_at } : null,
      followUp: Boolean(q.follow_up),
      said: q.said_leave_id ? { at: q.said_at, note: q.said_note } : null,
      late: started ? sayLate(Math.max(0, Math.round(minutesBetween(started, now)))) : null,
      timesAsked: Number(q.times_asked ?? 0),
      sickThisYear: sickBy.get(Number(q.staff_id)) ?? 0,
      answer: q.answer,
      answeredBy: q.answered_by,
      answeredAt: q.answered_at,
      detail: readDetail(q.detail),
    };
  };

  return json({
    today,
    open: list.filter((q) => !q.answer).map(shape),
    settled: list.filter((q) => q.answer).map(shape),
  });
}

const readDetail = (text) => {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
};

/**
 * One answer to one question. The first wins: a second person answering is
 * told who got there first and what they said, and nothing changes.
 */
export async function answerQuestion(ctx, idParam) {
  const id = int(idParam, 'Question', { required: true, min: 1 });
  const body = await readJson(ctx.request);
  const answer = ['sick', 'absent', 'here'].includes(body.answer) ? body.answer : null;
  if (!answer) throw badRequest('Say off sick, absent, or here.');

  const q = await ctx.db.prepare(
    'SELECT q.*, s.name FROM att_absence_q q JOIN att_staff s ON s.id = q.staff_id WHERE q.id = ?',
  ).bind(id).first();
  if (!q) throw notFound('That question is not there any more.');
  if (q.answer) throw alreadyAnswered(q);

  const how = HOW[body.how] ? body.how : null;
  const note = str(body.note, 'Note', { max: 300 });

  // Everything checked before the question is claimed, so a typo never leaves
  // a question marked answered with nothing done.
  let until = q.day;
  if (answer === 'sick') {
    until = body.until ? String(body.until) : q.day;
    if (!isDay(until)) throw badRequest('That last day is not a date.');
    if (until < q.day) throw badRequest('The last sick day is before the first.');
    if (diffDays(q.day, until) >= MOST_SICK_DAYS) {
      throw badRequest(`${MOST_SICK_DAYS} days at most here. Longer sick leave goes in from Leave.`);
    }
  }
  let startTime = null;
  let why = null;
  if (answer === 'here') {
    startTime = String(body.in ?? '').trim().slice(0, 5);
    if (toMinutes(startTime) == null) throw badRequest('Say what time they started, like 06:25.');
    why = str(body.why, 'Why there is no clock-in', { required: true, max: 200 });
  }

  const claimed = await ctx.db.prepare(
    `UPDATE att_absence_q SET answer = ?1, answered_by = ?2, answered_by_id = ?3,
            answered_at = datetime('now')
      WHERE id = ?4 AND answer IS NULL`,
  ).bind(answer, actorOf(ctx), ctx.session.user.id ?? null, id).run();
  if (!Number(claimed?.meta?.changes ?? 0)) {
    const now = await ctx.db.prepare(
      'SELECT q.*, s.name FROM att_absence_q q JOIN att_staff s ON s.id = q.staff_id WHERE q.id = ?',
    ).bind(id).first();
    throw alreadyAnswered(now ?? q);
  }

  try {
    const outcome = answer === 'sick'
      ? await offSick(ctx, q, { until, how, note })
      : answer === 'absent'
        ? await markAbsent(ctx, q, { how, note })
        : await cameIn(ctx, q, { startTime, why });

    await ctx.db.prepare('UPDATE att_absence_q SET detail = ?1, leave_id = ?2 WHERE id = ?3')
      .bind(JSON.stringify(outcome.detail), outcome.leaveId ?? null, id).run();
    await audit(ctx, 'attendance.absence_answer', `${q.staff_id}|${q.day}`, { answer, ...outcome.detail });

    // Everybody else who was asked: told in the bell, so nobody answers twice.
    await createNotice(ctx.db, {
      kind: 'attendance.absence_answered',
      level: 'info',
      title: `${q.name}: ${outcome.said}`,
      body: `Answered by ${ctx.session.user.name}.`,
      link: '#/home',
      day: q.day,
      actor: actorOf(ctx),
      audience: 'att_rota',
      push: false,
      email: false,
      text: false,
    }, ctx);

    return json({ ok: true, answer, ...outcome.reply });
  } catch (err) {
    // Put the question back so somebody can answer it properly.
    await ctx.db.prepare(
      `UPDATE att_absence_q SET answer = NULL, answered_by = NULL, answered_by_id = NULL,
              answered_at = NULL
        WHERE id = ?1`,
    ).bind(id).run().catch(() => {});
    throw err;
  }
}

function alreadyAnswered(q) {
  const who = String(q.answered_by ?? 'Somebody').replace(/\s*\([^)]*\)\s*$/, '');
  const what = {
    sick: 'off sick', absent: 'absent', here: 'here, time put right',
    came_in: 'a clock-in arrived', settled: 'the day was settled',
  }[q.answer] ?? q.answer;
  return badRequest(`${who} already answered: ${what}.`, { already: true });
}

/** The login and addresses of the person the question is about. */
async function personOf(db, staffId) {
  return db.prepare(
    `SELECT s.id, s.name, u.id AS user_id, u.email AS login_email, hp.personal_email
       FROM att_staff s
       LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
       LEFT JOIN hr_profile hp ON hp.staff_id = s.id
      WHERE s.id = ?1 LIMIT 1`,
  ).bind(staffId).first().catch(() => null);
}

/**
 * Yes, off sick. Sick leave from the day of the question, approved by whoever
 * answered. Off sick yesterday stretches yesterday's leave; a sick day the
 * person asked for themselves is approved rather than doubled.
 */
async function offSick(ctx, q, { until, how, note }) {
  const by = actorOf(ctx);
  const reason = [how ? HOW[how] : null, note].filter(Boolean).join('. ') || null;

  const existing = await ctx.db.prepare(
    `SELECT * FROM att_leave
      WHERE staff_id = ?1 AND reason_code = 'sick_leave' AND status IN ('approved', 'pending')
        AND from_day <= ?2 AND to_day >= ?3
      ORDER BY status = 'approved' DESC, id DESC LIMIT 1`,
  ).bind(q.staff_id, q.day, addDays(q.day, -1)).first();

  const clash = await ctx.db.prepare(
    `SELECT id FROM att_leave
      WHERE staff_id = ?1 AND status IN ('approved', 'pending') AND from_day <= ?2 AND to_day >= ?3
        AND id <> ?4`,
  ).bind(q.staff_id, until, q.day, existing?.id ?? 0).first();
  if (clash) throw badRequest('Those days overlap other leave already booked. Change it from Leave.');

  const from = existing ? existing.from_day : q.day;
  const to = existing && existing.to_day > until ? existing.to_day : until;
  const ds = await loadDataset(ctx.db, { from, to });
  const count = leaveDaysFor({ from, to, staffId: q.staff_id, ds, halfDay: null });
  const days = count.allSettled ? 0 : count.days;

  let leaveId;
  if (existing) {
    await ctx.db.prepare(
      `UPDATE att_leave SET to_day = ?1, days = ?2, status = 'approved', estimated = ?3,
              decided_by = COALESCE(decided_by, ?4),
              decided_at = COALESCE(decided_at, datetime('now')),
              reason = COALESCE(?5, reason)
        WHERE id = ?6`,
    ).bind(to, days, count.estimated ? 1 : 0, by, reason, existing.id).run();
    leaveId = existing.id;
  } else {
    const row = await ctx.db.prepare(
      `INSERT INTO att_leave
         (staff_id, reason_code, from_day, to_day, days, half_day, status, reason,
          requested_by, requested_by_id, decided_by, decided_at, estimated)
       VALUES (?1, 'sick_leave', ?2, ?3, ?4, NULL, 'approved', ?5, ?6, ?7, ?6, datetime('now'), ?8)
       RETURNING id`,
    ).bind(q.staff_id, from, to, days, reason, by, ctx.session.user.id ?? null, count.estimated ? 1 : 0).first();
    leaveId = row.id;
  }

  await recompute(ctx.db, { staffIds: [q.staff_id], from, to });
  const leave = { id: leaveId, staff_id: q.staff_id, from_day: from, to_day: to };
  const need = await owedNoteFor(ctx.db, leave);

  const person = await personOf(ctx.db, q.staff_id);
  const range = from === to ? sayDate(from) : sayRange(from, to);
  const span = diffDays(from, to) + 1;
  if (person?.user_id || recordEmail(person)) {
    await createNotice(ctx.db, {
      kind: 'attendance.logged_sick',
      level: 'info',
      title: 'You are down as off sick',
      body: `${ctx.session.user.name} logged ${range} as sick leave, so it is not counted as absent. `
        + (need ? `${span} days needs a medical certificate by ${sayDate(need.due)}. Take a photo of it in HIVE.`
          : 'Get well soon.'),
      link: '#/my-day',
      day: q.day,
      actor: by,
      userId: person.user_id ?? null,
      emailTo: recordEmail(person),
      push: true,
      email: true,
      cc: false,
      text: false,
      mail: {
        status: 'Sick leave',
        tone: 'info',
        eyebrow: 'Attendance',
        subject: 'You are down as off sick',
        preheader: `${range}, logged by ${ctx.session.user.name}.`,
        headline: `Get well soon, ${firstName(person.name)}`,
        sub: range,
        facts: [
          ['Sick leave', `${span} day${span === 1 ? '' : 's'}`],
          ['Logged by', ctx.session.user.name],
          need ? ['Medical certificate', `Due ${sayDate(need.due)}`, { tone: 'warn' }] : null,
        ].filter(Boolean),
        note: need
          ? 'Two days or more needs a certificate from the clinic or hospital. Without one, the days are '
            + 'unpaid. Open HIVE and take a photo of it.'
          : 'Your shift is covered as sick leave, not counted as absent. If this is not right, speak to '
            + `${firstName(ctx.session.user.name)}.`,
        button: 'Open HIVE',
        why: 'You get this because you are on the rota.',
      },
    }, ctx);
  }

  return {
    leaveId,
    said: `off sick, ${range}`,
    detail: { until: to, how, note, days: span },
    reply: { leaveId, from, to, note: need ? { due: need.due } : null },
  };
}

/** No, absent. The day is settled as absent, as the Today screen would. */
async function markAbsent(ctx, q, { how, note }) {
  const said = [how ? HOW[how] : null, note].filter(Boolean).join('. ') || null;
  await ctx.db.prepare(
    `INSERT INTO att_days (staff_id, day, status, reason_code, resolution,
                           resolved_by, resolved_at, resolved_note)
     VALUES (?1, ?2, 'absent', 'absent', 'resolved', ?3, datetime('now'), ?4)
     ON CONFLICT (staff_id, day) DO UPDATE SET
       status = 'absent', reason_code = 'absent', resolution = 'resolved',
       resolved_by = excluded.resolved_by, resolved_at = excluded.resolved_at,
       resolved_note = excluded.resolved_note`,
  ).bind(q.staff_id, q.day, actorOf(ctx), said ? `Off sick or absent: ${said}` : 'Off sick or absent: absent').run();
  await recompute(ctx.db, { staffIds: [q.staff_id], from: q.day, to: q.day });

  const person = await personOf(ctx.db, q.staff_id);
  const shift = q.shift_name ? `${q.shift_name} ${sayTime(q.starts_at)}` : 'your shift';
  if (person?.user_id || recordEmail(person)) {
    await createNotice(ctx.db, {
      kind: 'attendance.marked_absent',
      level: 'warn',
      title: `Marked absent: ${shift}, ${sayDate(q.day)}`,
      body: `Nothing was recorded for you. If this is wrong, speak to ${firstName(ctx.session.user.name)}.`,
      link: '#/att-me',
      day: q.day,
      actor: actorOf(ctx),
      userId: person.user_id ?? null,
      emailTo: recordEmail(person),
      push: true,
      email: true,
      cc: false,
      text: false,
    }, ctx);
  }

  return { said: 'absent', detail: { how, note }, reply: {} };
}

/**
 * Here after all: the start time put right, through the same route as any
 * correction, so it carries a name and the administrators hear of it.
 */
async function cameIn(ctx, q, { startTime, why }) {
  const request = new Request('https://hive.local/correct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staffId: q.staff_id, in: startTime, reason: `Here, no clock-in: ${why}` }),
  });
  const response = await correctTimes({ ...ctx, request }, q.day);
  const out = await response.json().catch(() => ({}));
  return {
    said: `here from ${startTime}`,
    detail: { in: startTime, why, pending: Boolean(out.pending) },
    reply: { pending: Boolean(out.pending) },
  };
}

// ---------------------------------------------------------------------------
// The person's own side
// ---------------------------------------------------------------------------

async function meOf(ctx) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  if (!staffId) throw forbidden('This login is not linked to a staff record yet.');
  const staff = await ctx.db.prepare('SELECT * FROM att_staff WHERE id = ?').bind(staffId).first();
  if (!staff) throw notFound('The staff record this login points at is gone.');
  return staff;
}

/**
 * What My day needs: sick leave running now or just ended, any certificate
 * owed, and whether "I'm off sick today" makes sense right now.
 */
export async function mySick(ctx) {
  const staff = await meOf(ctx);
  const timezone = await timezoneOf(ctx.db);
  const now = nowIn(timezone);
  const today = now.slice(0, 10);

  const [current, notes, punched] = await Promise.all([
    ctx.db.prepare(
      `SELECT * FROM att_leave
        WHERE staff_id = ?1 AND reason_code = 'sick_leave' AND status IN ('approved', 'pending')
          AND to_day >= ?2 AND from_day <= ?3
        ORDER BY from_day DESC LIMIT 1`,
    ).bind(staff.id, addDays(today, -1), today).first().catch(() => null),
    ctx.db.prepare(
      `SELECT n.*, l.from_day, l.to_day FROM att_sick_note n JOIN att_leave l ON l.id = n.leave_id
        WHERE n.staff_id = ?1 AND n.status = 'owed' AND l.status = 'approved'
        ORDER BY n.due_on`,
    ).bind(staff.id).all().catch(() => ({ results: [] })),
    ctx.db.prepare('SELECT 1 FROM att_punches WHERE staff_id = ?1 AND day = ?2 LIMIT 1')
      .bind(staff.id, today).first().catch(() => null),
  ]);

  let canSay = false;
  let shift = null;
  if (!punched) {
    const ds = await loadDataset(ctx.db, { from: today, to: today });
    const onLeave = ds.leaveBy.get(`${staff.id}|${today}`)
      || (current && current.from_day <= today && current.to_day >= today);
    shift = scheduleFor(ds, staff.id, today).shift ?? null;
    const end = shift?.ends_at ? toMinutes(shift.ends_at) : null;
    const start = shift?.starts_at ? toMinutes(shift.starts_at) : null;
    const clock = toMinutes(now.slice(11, 16));
    const overnight = start != null && end != null && end <= start;
    canSay = Boolean(shift && !onLeave && (overnight || end == null || clock < end));
  }

  let loggedBy = null;
  if (current?.decided_by) loggedBy = String(current.decided_by).replace(/\s*\([^)]*\)\s*$/, '');

  return json({
    today,
    sick: current ? {
      id: current.id,
      from: current.from_day,
      to: current.to_day,
      status: current.status,
      days: diffDays(current.from_day, current.to_day) + 1,
      loggedBy,
    } : null,
    notes: (notes.results ?? []).map((n) => ({
      leaveId: n.leave_id, from: n.from_day, to: n.to_day, due: n.due_on,
      days: diffDays(n.from_day, n.to_day) + 1, late: today > n.due_on,
    })),
    canSay,
    shift: shift ? { name: shift.name, starts_at: shift.starts_at, ends_at: shift.ends_at } : null,
  });
}

/**
 * "I'm off sick today", from the person, before anybody has to chase them.
 *
 * Goes in as sick leave waiting for a decision, and the planners and
 * supervisors are told straight away. When the shift's question comes round it
 * says so, and answering yes approves this rather than logging a second one.
 */
export async function sayOffSick(ctx) {
  const staff = await meOf(ctx);
  const body = await readJson(ctx.request);
  const timezone = await timezoneOf(ctx.db);
  const today = nowIn(timezone).slice(0, 10);
  const days = int(body.days ?? 1, 'Days', { min: 1, max: 2 });
  const to = addDays(today, days - 1);
  const note = str(body.note, 'Note', { max: 300 });

  const clash = await ctx.db.prepare(
    `SELECT id FROM att_leave
      WHERE staff_id = ?1 AND status IN ('approved', 'pending') AND from_day <= ?2 AND to_day >= ?3`,
  ).bind(staff.id, to, today).first();
  if (clash) throw badRequest('You already have leave down for today. Speak to your supervisor.');

  const ds = await loadDataset(ctx.db, { from: today, to });
  const count = leaveDaysFor({ from: today, to, staffId: staff.id, ds, halfDay: null });
  const shift = scheduleFor(ds, staff.id, today).shift ?? null;

  const row = await ctx.db.prepare(
    `INSERT INTO att_leave
       (staff_id, reason_code, from_day, to_day, days, half_day, status, reason,
        requested_by, requested_by_id, estimated)
     VALUES (?1, 'sick_leave', ?2, ?3, ?4, NULL, 'pending', ?5, ?6, ?7, ?8) RETURNING id`,
  ).bind(
    staff.id, today, to, count.allSettled ? 0 : count.days, note ? `Said in HIVE: ${note}` : 'Said in HIVE',
    `${staff.name} (staff)`, ctx.session.user.id ?? null, count.estimated ? 1 : 0,
  ).first();

  await ctx.db.prepare(
    'UPDATE att_absence_q SET said_leave_id = ?1 WHERE staff_id = ?2 AND day = ?3 AND answer IS NULL',
  ).bind(row.id, staff.id, today).run().catch(() => {});

  await createNotice(ctx.db, {
    kind: 'attendance.said_sick',
    level: 'warn',
    title: `${staff.name} is off sick ${days === 2 ? 'today and tomorrow' : 'today'}`,
    body: (shift ? `Down for ${shift.name}, ${sayTime(shift.starts_at)}. ` : '')
      + (note ? `"${note}"` : 'No note.'),
    link: '#/att-leave',
    day: today,
    actor: staff.name,
    audience: 'att_rota',
    push: true,
    email: true,
    emailAudience: 'att_manage',
    text: false,
  }, ctx);

  await audit(ctx, 'attendance.said_sick', row.id, { staffId: staff.id, from: today, to });
  return json({ ok: true, id: row.id, from: today, to });
}

/** The certificate, photographed and filed on their record. */
export async function sendSickNote(ctx, leaveParam) {
  const staff = await meOf(ctx);
  const leaveId = int(leaveParam, 'Sick leave', { required: true, min: 1 });
  const note = await ctx.db.prepare(
    `SELECT n.*, l.from_day, l.to_day FROM att_sick_note n JOIN att_leave l ON l.id = n.leave_id
      WHERE n.leave_id = ?1 AND n.staff_id = ?2`,
  ).bind(leaveId, staff.id).first();
  if (!note) throw notFound('No certificate is owed for that sick leave.');
  if (note.status !== 'owed') throw badRequest('That certificate is already in.');

  const body = await readJson(ctx.request);
  const bytes = fromBase64(body.file?.base64 ?? body.base64);
  if (!bytes.length) throw badRequest('There was no picture in that. Try again.');
  if (bytes.length > MAX_NOTE_BYTES) throw badRequest('That picture is too large. Take a photo of it instead.');

  const documentId = await storeFile(ctx, staff.id, {
    kind: 'sick_note',
    title: `Medical certificate, ${sayRange(note.from_day, note.to_day)}`,
    filename: str(body.file?.filename ?? body.filename, 'File name', { max: 120 }) || 'certificate.jpg',
    mime: str(body.file?.mime ?? body.mime, 'File type', { max: 80 }) || 'image/jpeg',
    bytes,
    expiresOn: null,
    by: `${staff.name} (staff)`,
  });

  await ctx.db.prepare(
    "UPDATE att_sick_note SET status = 'sent', document_id = ?1, sent_at = datetime('now') WHERE leave_id = ?2",
  ).bind(documentId, leaveId).run();

  await createNotice(ctx.db, {
    kind: 'attendance.sick_note_sent',
    level: 'good',
    title: `${staff.name} sent a medical certificate`,
    body: `For ${sayRange(note.from_day, note.to_day)}. It is filed on ${firstName(staff.name)}'s record.`,
    link: '#/att-leave',
    actor: staff.name,
    audience: 'att_manage',
    push: false,
    email: false,
    text: false,
  }, ctx);

  await audit(ctx, 'attendance.sick_note_sent', leaveId, { documentId });
  return json({ ok: true, documentId });
}

