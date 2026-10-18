import { badRequest, int, json, notFound, readJson, str } from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { OWED_SINCE, tillLedger } from '../lib/till-watch.js';
import { firstUsableEmail, isEmail } from '../lib/notify.js';
import { firstName, sayDate, sayHours } from '../lib/email-design.js';
import { addDays, isDay, nowIn, todayIn } from '../util/dates.js';
import { closedSummary, historyOf, readReport, reopenReport } from './till.js';

/**
 * The front desk's closing reports, for whoever keeps track of them.
 *
 * Every reception shift somebody was rostered on, with its report if it came
 * in, and the ones that did not. A shift that has not ended yet is still
 * running; one they never clocked in for owes nothing and is said so rather
 * than chased. Anything still owed can be chased from here, one person or
 * everybody at once, and the screen says when each was last chased.
 */

const SLOT_WORD = { morning: 'morning', afternoon: 'afternoon', night: 'night' };
/** Chasing the same report again inside this many minutes is refused. */
export const CHASE_GAP_MINUTES = 60;

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

async function timezoneOf(db) {
  return (await db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first().catch(() => null))?.value || 'UTC';
}

const stateOf = (row) => {
  if (row.report && !row.report.reopened_at) return 'in';
  if (row.report?.reopened_at) return 'reopened';
  if (!row.ended) return 'running';
  if (!row.worked) return 'not_worked';
  // Missing from before the cut-off: listed, never asked for or chased.
  if (row.day < OWED_SINCE) return 'not_asked';
  return 'owed';
};

/** When each report was last chased, by person, day and shift. */
async function lastChased(db, from, to) {
  const rows = await db.prepare(
    `SELECT user_id, day, slot, MAX(at) AS at, COUNT(*) AS times
       FROM app_notices WHERE kind = 'till.chase' AND day BETWEEN ?1 AND ?2
      GROUP BY user_id, day, slot`,
  ).bind(addDays(from, -1), to).all().catch(() => ({ results: [] }));
  return new Map((rows.results ?? []).map((r) => [`${r.user_id}|${r.day}|${r.slot}`, { at: r.at, times: Number(r.times) }]));
}

function rangeFrom(url, timezone) {
  const today = todayIn(timezone);
  const to = isDay(url.searchParams.get('to')) ? url.searchParams.get('to') : today;
  const from = isDay(url.searchParams.get('from')) ? url.searchParams.get('from') : addDays(to, -6);
  if (from > to) throw badRequest('The start is after the end.');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 62) throw badRequest('Two months at most at a time.');
  return { from, to };
}

export async function tillReports(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const { from, to } = rangeFrom(ctx.url, timezone);
  const ledger = await tillLedger(ctx.db, { from, to, timezone });
  const chased = await lastChased(ctx.db, from, to);
  // How many times each report has been submitted, so one that was put right
  // after the fact says so.
  const counted = await ctx.db.prepare(
    `SELECT user_id, day, slot, COUNT(*) AS n FROM till_report
      WHERE day BETWEEN ?1 AND ?2 GROUP BY user_id, day, slot`,
  ).bind(addDays(from, -1), to).all().catch(() => ({ results: [] }));
  const versionsBy = new Map((counted.results ?? []).map((r) => [`${r.user_id}|${r.day}|${r.slot}`, Number(r.n)]));

  const rows = ledger.map((row) => {
    const state = stateOf(row);
    let summary = null;
    if (row.report) {
      try { summary = closedSummary(readReport(row.report), true); } catch { summary = null; }
    }
    return {
      userId: row.userId,
      name: row.name,
      day: row.day,
      slot: row.slot,
      shiftDay: row.shiftDay,
      shift: row.shift,
      state,
      reportId: row.report && !row.report.reopened_at ? row.report.id : null,
      versions: versionsBy.get(`${row.userId}|${row.day}|${row.slot}`) ?? 0,
      signedAt: row.report?.signed_at ?? null,
      reopenedAt: row.report?.reopened_at ?? null,
      reopenReason: row.report?.reopen_reason ?? null,
      cash: row.report ? Number(row.report.cash) || 0 : null,
      device: row.report?.device ?? null,
      summary,
      chased: chased.get(`${row.userId}|${row.day}|${row.slot}`) ?? null,
    };
  });

  const count = (s) => rows.filter((r) => r.state === s).length;
  return json({
    from,
    to,
    totals: {
      in: count('in'),
      owed: count('owed') + count('reopened'),
      notWorked: count('not_worked'),
      running: count('running'),
    },
    chaseGapMinutes: CHASE_GAP_MINUTES,
    rows,
  });
}

/** One reminder, from the person who pressed Chase. */
function chaseNotice({ row, by, userId, emailTo }) {
  const word = SLOT_WORD[row.slot] ?? 'shift';
  const title = `Please submit your closing report for the ${word} shift on ${sayDate(row.day)}`;
  return {
    kind: 'till.chase',
    level: 'warn',
    title,
    body: `${by} asked for it. Submit it under Close till; later shifts cannot be closed until it is in.`,
    link: '#/att-my-till',
    day: row.day,
    slot: row.slot,
    actor: by,
    userId,
    emailTo,
    push: true,
    email: true,
    mail: {
      status: 'Asked for',
      tone: 'warn',
      eyebrow: 'Till',
      subject: title,
      preheader: `${by} asked for your closing report. Submit it under Close till.`,
      headline: title,
      sub: `${by} asked for it`,
      facts: row.shift ? [['Shift', `${row.shift.name}, ${sayHours(row.shift.starts_at, row.shift.ends_at)}`],
        ['Closing report', 'Not submitted yet', { tone: 'bad', strong: true }]] : [],
      note: 'Submit it under Close till. Closing reports go in order, so a later shift cannot be '
        + 'closed until this one is in.',
      button: 'Close my till',
      why: 'You get this because a manager chased a closing report from a shift you worked.',
    },
  };
}

/**
 * Chase one report, or everybody's still owed between two days.
 *
 * Only a report that is actually owed: the shift has ended, they clocked in
 * for it, and nothing is in (or it was reopened). The same report is not
 * chased twice within the hour, so a double press sends one message.
 */
export async function chaseTill(ctx) {
  const body = await readJson(ctx.request);
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  const all = body.all === true;

  let from; let to;
  if (all) {
    to = isDay(body.to) ? body.to : today;
    from = isDay(body.from) ? body.from : addDays(to, -6);
  } else {
    if (!isDay(body.day)) throw badRequest('Which day?');
    if (!SLOT_WORD[body.slot]) throw badRequest('Which shift?');
    int(body.userId, 'Who', { required: true, min: 1 });
    // The report day is the evening a night shift began, so the shift itself
    // may sit a day either side.
    from = addDays(body.day, -1);
    to = addDays(body.day, 1);
  }

  const ledger = await tillLedger(ctx.db, { from, to, timezone });
  const wanted = ledger.filter((row) => ['owed', 'reopened'].includes(stateOf(row))
    && (all || (row.userId === Number(body.userId) && row.day === body.day && row.slot === body.slot)));
  if (!all && !wanted.length) throw badRequest('That report is not owed: it is in, the shift has not ended, or they did not work it.');

  const recent = await ctx.db.prepare(
    `SELECT user_id, day, slot FROM app_notices
      WHERE kind = 'till.chase' AND at >= datetime('now', ?1)`,
  ).bind(`-${CHASE_GAP_MINUTES} minutes`).all().catch(() => ({ results: [] }));
  const justChased = new Set((recent.results ?? []).map((r) => `${r.user_id}|${r.day}|${r.slot}`));

  const emails = await ctx.db.prepare(
    `SELECT u.id, u.email, hp.personal_email FROM users u
       LEFT JOIN hr_profile hp ON hp.staff_id = u.staff_id`,
  ).all().catch(() => ({ results: [] }));
  const emailBy = new Map((emails.results ?? []).map((u) => [Number(u.id), u]));
  const by = firstName(ctx.session.user.name) || ctx.session.user.name || 'A manager';

  let sent = 0;
  let skipped = 0;
  for (const row of wanted) {
    if (justChased.has(`${row.userId}|${row.day}|${row.slot}`)) { skipped += 1; continue; }
    const u = emailBy.get(row.userId) ?? {};
    await createNotice(ctx.db, chaseNotice({
      row, by, userId: row.userId,
      emailTo: isEmail(String(u.email ?? '').trim()) ? null : firstUsableEmail(u.personal_email),
    }), ctx);
    sent += 1;
  }
  if (!all && !sent) throw badRequest(`Chased less than ${CHASE_GAP_MINUTES} minutes ago. Give them a little time.`);

  await ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)')
    .bind(actorOf(ctx), 'till.chase', all ? `${from}..${to}` : `${body.userId}|${body.day}|${body.slot}`,
      JSON.stringify({ sent, skipped, note: str(body.note, 'Note', { max: 200 }) || null }))
    .run().catch(() => {});

  return json({ ok: true, sent, skipped, at: nowIn(timezone) });
}

/**
 * Let somebody submit a closing report again, because something in it is
 * wrong. The report is kept as it was, marked reopened with who and why; they
 * are told, it counts as owed until it is in again, and the new one is kept
 * beside it so the history shows what changed.
 */
export async function reopenTillReport(ctx, idParam) {
  const body = await readJson(ctx.request);
  const id = int(idParam, 'Which report', { required: true, min: 1 });
  const reason = str(body.reason, 'What needs putting right', { required: true, max: 400 });
  const report = await ctx.db.prepare('SELECT * FROM till_report WHERE id = ?1 AND reopened_at IS NULL').bind(id).first();
  if (!report) throw notFound('That report is already open to resubmit, or there is no such report.');
  await reopenReport(ctx, report, { by: ctx.session.user.name, reason });
  await ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)')
    .bind(actorOf(ctx), 'till.reopen', String(id), JSON.stringify({ reason, user: report.user_id, day: report.day, slot: report.slot }))
    .run().catch(() => {});
  return json({ ok: true });
}

/** Every version of one person's report for one shift. */
export async function tillHistory(ctx) {
  const userId = int(ctx.url.searchParams.get('userId'), 'Who', { required: true, min: 1 });
  const day = ctx.url.searchParams.get('day');
  const slot = ctx.url.searchParams.get('slot');
  if (!isDay(day) || !SLOT_WORD[slot]) throw badRequest('Which shift?');
  const rows = await ctx.db.prepare(
    'SELECT * FROM till_report WHERE user_id = ?1 AND day = ?2 AND slot = ?3 ORDER BY signed_at',
  ).bind(userId, day, slot).all();
  const [shift] = historyOf(rows.results ?? []);
  return json({ shift: shift ?? null });
}
