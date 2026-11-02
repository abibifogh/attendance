import { createNotice } from './notices.js';
import { addDays, nowIn } from '../util/dates.js';

/**
 * Staff feedback, every quarter, by itself.
 *
 * A round opens on the first Monday of the months set (January, April, July
 * and October to begin with) and stays open for a set number of days.
 * Whoever has not answered is reminded on the third and eighth day and the
 * last. When it closes, the answers are added up and the comments read and
 * sorted into themes (by Workers AI where the worker has it, by area where
 * it does not), and admins are told the results are in.
 *
 * Names are kept with answers unless the round is anonymous. Whether it is
 * is fixed when the round opens; an anonymous round stores no name with any
 * answer, so it cannot be switched back to reveal them afterwards.
 */

export const MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const STATUSES = ['doing', 'done', 'looking', 'keeping'];

export function feedbackSettings(map = {}) {
  const months = String(map.feedback_months ?? '1,4,7,10').split(',')
    .map((m) => Number(m.trim())).filter((m) => m >= 1 && m <= 12);
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : d;
  };
  return {
    on: map.feedback_on !== '0',
    months: months.length ? [...new Set(months)].sort((a, b) => a - b) : [1, 4, 7, 10],
    openDays: num(map.feedback_open_days, 12, 1, 60),
    anonymous: map.feedback_anonymous === '1',
    minGroup: num(map.feedback_min_group, 5, 1, 50),
    supervisors: map.feedback_supervisors !== '0',
    minServiceDays: num(map.feedback_min_service_days, 30, 0, 365),
  };
}

export async function readFeedbackSettings(db) {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'feedback_%'").all()
    .catch(() => ({ results: [] }));
  return feedbackSettings(Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value])));
}

/** The first Monday of a month, as YYYY-MM-DD. */
export function firstMonday(year, month) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  const shift = (8 - d.getUTCDay()) % 7;
  d.setUTCDate(1 + shift);
  return d.toISOString().slice(0, 10);
}

/** The next round's opening day on or after a day. */
export function nextOpening(today, months) {
  const [y, m] = today.split('-').map(Number);
  for (let i = 0; i < 25; i += 1) {
    const month = ((m - 1 + i) % 12) + 1;
    const year = y + Math.floor((m - 1 + i) / 12);
    if (!months.includes(month)) continue;
    const day = firstMonday(year, month);
    if (day >= today) return day;
  }
  return null;
}

export function roundLabel(day) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** Everybody a round asks: active, and here long enough. */
export async function eligibleStaff(db, today, settings) {
  const since = addDays(today, -settings.minServiceDays);
  const rows = await db.prepare(
    `SELECT s.id, s.name, s.department,
            (SELECT u.id FROM users u WHERE u.staff_id = s.id AND u.active = 1 ORDER BY u.id LIMIT 1) AS user_id
       FROM att_staff s
      WHERE s.active = 1 AND (s.hired_on IS NULL OR s.hired_on <= ?1)
      ORDER BY s.name`,
  ).bind(since).all().catch(() => ({ results: [] }));
  return rows.results ?? [];
}

export async function activeQuestions(db) {
  const rows = await db.prepare('SELECT * FROM fb_question WHERE active = 1 ORDER BY sort_order, id').all()
    .catch(() => ({ results: [] }));
  return (rows.results ?? []).map((q) => ({ id: q.id, area: q.area, text: q.text, kind: q.kind }));
}

/** Active staff by id, whoever they are, for a round an admin addressed by hand. */
export async function staffByIds(db, ids) {
  const out = [];
  for (const id of [...new Set(ids.map(Number).filter((n) => n > 0))]) {
    // eslint-disable-next-line no-await-in-loop
    const row = await db.prepare(
      `SELECT s.id, s.name, s.department,
              (SELECT u.id FROM users u WHERE u.staff_id = s.id AND u.active = 1 ORDER BY u.id LIMIT 1) AS user_id
         FROM att_staff s WHERE s.id = ?1 AND s.active = 1`,
    ).bind(id).first().catch(() => null);
    if (row) out.push(row);
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Everybody a round was sent to. A round from before the list was kept went to everybody eligible. */
export async function askedFor(db, round, settings) {
  const rows = await db.prepare(
    `SELECT s.id, s.name, s.department,
            (SELECT u.id FROM users u WHERE u.staff_id = s.id AND u.active = 1 ORDER BY u.id LIMIT 1) AS user_id
       FROM fb_asked a JOIN att_staff s ON s.id = a.staff_id
      WHERE a.round_id = ?1 AND s.active = 1 ORDER BY s.name`,
  ).bind(round.id).all().catch(() => ({ results: [] }));
  if ((rows.results ?? []).length) return rows.results;
  const any = await db.prepare('SELECT 1 AS x FROM fb_asked WHERE round_id = ?1 LIMIT 1').bind(round.id).first().catch(() => null);
  return any ? [] : eligibleStaff(db, round.opens_on, settings ?? await readFeedbackSettings(db));
}

/** Whether somebody was sent a round. */
export async function wasAsked(db, round, staffId) {
  const any = await db.prepare('SELECT 1 AS x FROM fb_asked WHERE round_id = ?1 LIMIT 1').bind(round.id).first().catch(() => null);
  if (!any) return true;
  const me = await db.prepare('SELECT 1 AS x FROM fb_asked WHERE round_id = ?1 AND staff_id = ?2').bind(round.id, staffId).first().catch(() => null);
  return Boolean(me);
}

export async function openRound(db, { today, by = 'HIVE', settings = null, ctx = null, anonymous = null, staffIds = null } = {}) {
  const s = settings ?? await readFeedbackSettings(db);
  const already = await db.prepare("SELECT id FROM fb_round WHERE status = 'open' LIMIT 1").first().catch(() => null);
  if (already) return { id: already.id, opened: false, reason: 'A round is already open.' };
  const questions = await activeQuestions(db);
  if (!questions.length) return { opened: false, reason: 'There are no questions to ask.' };
  // Whoever an admin picked, or everybody eligible.
  const people = Array.isArray(staffIds) ? await staffByIds(db, staffIds) : await eligibleStaff(db, today, s);
  if (!people.length) return { opened: false, reason: 'Pick at least one person to send it to.' };
  const anon = anonymous == null ? s.anonymous : Boolean(anonymous);
  const closes = addDays(today, s.openDays - 1);
  const done = await db.prepare(
    `INSERT INTO fb_round (label, opens_on, closes_on, anonymous, questions, asked, opened_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(roundLabel(today), today, closes, anon ? 1 : 0, JSON.stringify(questions), people.length, by).run();
  const id = Number(done?.meta?.last_row_id) || (await db.prepare('SELECT MAX(id) AS id FROM fb_round').first()).id;
  for (const p of people) {
    // eslint-disable-next-line no-await-in-loop
    await db.prepare('INSERT OR IGNORE INTO fb_asked (round_id, staff_id) VALUES (?1, ?2)').bind(id, p.id).run();
  }
  await tellStaff(db, people, {
    kind: 'feedback.open',
    title: 'Your say: how is work going?',
    body: `A few quick questions about your work. Open until ${sayDay(closes)}.`,
    day: today,
  }, ctx);
  return { id, opened: true, asked: people.length, closes };
}

const sayDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

async function tellStaff(db, people, { kind, title, body, day }, ctx) {
  for (const p of people) {
    if (!p.user_id) continue;
    // eslint-disable-next-line no-await-in-loop
    await createNotice(db, {
      kind, level: 'info', title, body, link: '#/my-feedback', day, actor: 'HIVE',
      userId: p.user_id, push: true, email: false, cc: false,
    }, ctx).catch((err) => console.error('feedback notice failed', err));
  }
}

/**
 * The daily turn: open a round on its day, remind on the third and eighth
 * days and the last, and close and read it the day after it shuts.
 */
export async function watchFeedback(db, { timezone = 'UTC', env = null, ctx = null, today: given = null } = {}) {
  const s = await readFeedbackSettings(db);
  const today = given ?? nowIn(timezone).split(' ')[0];
  const out = { opened: false, reminded: 0, closed: false };

  const open = await db.prepare("SELECT * FROM fb_round WHERE status = 'open' ORDER BY id DESC LIMIT 1").first().catch(() => null);

  if (open && today > open.closes_on) {
    await closeRound(db, open, { env, ctx });
    out.closed = true;
  } else if (open) {
    const day = daysBetween(open.opens_on, today) + 1;
    if (day === 3 || day === 8 || today === open.closes_on) {
      const people = await askedFor(db, open, s);
      const doneRows = await db.prepare('SELECT staff_id FROM fb_done WHERE round_id = ?1').bind(open.id).all()
        .catch(() => ({ results: [] }));
      const done = new Set((doneRows.results ?? []).map((r) => Number(r.staff_id)));
      const waiting = [];
      for (const p of people) {
        // Only somebody who can be told: a login of their own, not yet answered.
        if (done.has(Number(p.id)) || !p.user_id) continue;
        // eslint-disable-next-line no-await-in-loop
        const claimed = await db.prepare('INSERT OR IGNORE INTO att_nudge (staff_id, day, kind) VALUES (?1, ?2, ?3)')
          .bind(p.id, today, `feedback:${open.id}`).run().catch(() => null);
        if (Number(claimed?.meta?.changes ?? 0)) waiting.push(p);
      }
      await tellStaff(db, waiting, {
        kind: 'feedback.reminder',
        title: today === open.closes_on ? 'Last day for your say' : 'A few minutes for your say?',
        body: today === open.closes_on
          ? 'The feedback closes tonight. A few quick questions about your work.'
          : `A few quick questions about your work. Open until ${sayDay(open.closes_on)}.`,
        day: today,
      }, ctx);
      out.reminded = waiting.length;
    }
  }

  if (!open && s.on) {
    const [y, m] = today.split('-').map(Number);
    if (s.months.includes(m) && today === firstMonday(y, m)) {
      const had = await db.prepare('SELECT 1 AS x FROM fb_round WHERE substr(opens_on, 1, 7) = ?1 LIMIT 1')
        .bind(today.slice(0, 7)).first().catch(() => null);
      if (!had) {
        const r = await openRound(db, { today, settings: s, ctx });
        out.opened = Boolean(r.opened);
      }
    }
  }
  return out;
}

export async function closeRound(db, round, { env = null, ctx = null, by = 'HIVE' } = {}) {
  await db.prepare("UPDATE fb_round SET status = 'closed' WHERE id = ?1").bind(round.id).run();
  const analysis = await analyseRound(db, { ...round, status: 'closed' }, { env });
  await createNotice(db, {
    kind: 'feedback.results',
    level: 'info',
    title: `Staff feedback for ${round.label} is in`,
    body: `${analysis.answered} of ${analysis.asked} answered. See what staff are saying.`,
    link: '#/feedback',
    actor: by,
    audience: 'users',
    push: true,
    email: true,
  }, ctx).catch((err) => console.error('feedback results notice failed', err));
  return analysis;
}

/** Answer a round, once. */
export async function submitAnswers(db, { round, staff, answers }) {
  if (round.status !== 'open') throw new Error('This round has closed.');
  const done = await db.prepare('INSERT OR IGNORE INTO fb_done (round_id, staff_id) VALUES (?1, ?2)')
    .bind(round.id, staff.id).run();
  if (!Number(done?.meta?.changes ?? 0)) throw new Error('You have already answered this round. Thank you.');
  const questions = JSON.parse(round.questions || '[]');
  const clean = {};
  for (const q of questions) {
    const a = answers?.[q.id] ?? answers?.[String(q.id)];
    if (!a) continue;
    const comment = String(a.comment ?? '').trim().slice(0, 1000) || null;
    if (q.kind === 'scale') {
      const score = Number(a.score);
      if (Number.isInteger(score) && score >= 1 && score <= 5) clean[q.id] = { score, comment };
      else if (comment) clean[q.id] = { comment };
    } else if (q.kind === 'recommend') {
      if (['yes', 'maybe', 'no'].includes(a.choice)) clean[q.id] = { choice: a.choice, comment };
    } else if (comment) {
      clean[q.id] = { comment };
    }
  }
  await db.prepare('INSERT INTO fb_response (round_id, staff_id, department, answers) VALUES (?1, ?2, ?3, ?4)')
    .bind(round.id, round.anonymous ? null : staff.id, staff.department || null, JSON.stringify(clean)).run();
  return { ok: true };
}

const round1 = (n) => Math.round(n * 10) / 10;
const avg = (list) => (list.length ? round1(list.reduce((a, b) => a + b, 0) / list.length) : null);

/** The numbers: per question, per department, and against the round before. */
export function tally({ questions, responses, previous = null, minGroup = 5 }) {
  const departments = [...new Set(responses.map((r) => r.department || 'Other'))].sort();
  const prevBy = new Map((previous?.areas ?? []).map((a) => [a.area, a.score]));
  const areas = [];
  let recommend = null;
  const comments = [];
  for (const q of questions) {
    const given = responses.map((r) => ({ r, a: r.answers?.[q.id] ?? r.answers?.[String(q.id)] })).filter((x) => x.a);
    for (const { r, a } of given) {
      if (a.comment) {
        comments.push({
          question: q.id, area: q.area, text: a.comment, score: a.score ?? null,
          choice: a.choice ?? null, department: r.department || 'Other', staffId: r.staff_id ?? null,
        });
      }
    }
    if (q.kind === 'scale') {
      const scores = given.map((x) => x.a.score).filter((n) => Number.isInteger(n));
      const score = avg(scores);
      const byDept = departments.map((d) => {
        const list = given.filter((x) => (x.r.department || 'Other') === d).map((x) => x.a.score).filter(Number.isInteger);
        return { department: d, n: list.length, score: list.length >= minGroup ? avg(list) : null };
      });
      const before = prevBy.get(q.area);
      areas.push({
        question: q.id, area: q.area, text: q.text, n: scores.length, score,
        delta: score != null && before != null ? round1(score - before) : null,
        byDepartment: byDept,
        comments: given.filter((x) => x.a.comment).length,
      });
    } else if (q.kind === 'recommend') {
      const c = { yes: 0, maybe: 0, no: 0 };
      for (const { a } of given) c[a.choice] = (c[a.choice] ?? 0) + 1;
      const total = c.yes + c.maybe + c.no;
      recommend = { ...c, total, score: total ? Math.round(((c.yes - c.no) / total) * 100) : null };
    }
  }
  const feel = areas[0] ?? null;
  return { departments, areas, recommend, comments, feel: feel ? { score: feel.score, delta: feel.delta } : null };
}

/** Comments sorted into themes without the AI: one theme per area. */
export function plainThemes(comments) {
  const by = new Map();
  for (const [i, c] of comments.entries()) {
    if (!by.has(c.area)) by.set(c.area, []);
    by.get(c.area).push(i);
  }
  const tone = (list) => {
    const s = list.map((i) => comments[i].score).filter((n) => n != null);
    if (!s.length) return 'mixed';
    const low = s.filter((n) => n <= 2).length;
    const high = s.filter((n) => n >= 4).length;
    return low > high * 2 ? 'negative' : high > low * 2 ? 'positive' : 'mixed';
  };
  return [...by].map(([area, list]) => ({
    title: area, area, summary: `${list.length} comment${list.length === 1 ? '' : 's'} about ${area.toLowerCase()}.`,
    tone: tone(list), comments: list,
  })).sort((a, b) => b.comments.length - a.comments.length);
}

/** Pull the first JSON object out of a model's reply. */
export function readJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

async function aiThemes(env, comments, areas) {
  if (!env?.AI || !comments.length) return null;
  const list = comments.map((c, i) => `${i}. [${c.area}${c.score ? `, ${c.score}/5` : ''}] ${c.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
  const scores = areas.map((a) => `${a.area}: ${a.score ?? '-'} of 5 (${a.delta == null ? 'no earlier round' : `${a.delta >= 0 ? '+' : ''}${a.delta} on last round`})`).join('\n');
  const system = 'You read anonymous staff survey comments for a small hotel in Ghana and sort them into themes for the managers. '
    + 'Write plainly and kindly, in British English, without jargon. Never guess who wrote anything. Reply with JSON only.';
  const user = `Scores by area:\n${scores}\n\nComments, numbered:\n${list}\n\n`
    + 'Return JSON: {"themes":[{"title":"short theme","area":"the closest area","summary":"one or two sentences on what people say","tone":"positive|negative|mixed","comments":[numbers]}],'
    + '"areas":[{"area":"area name","headline":"one sentence on how it stands"}],'
    + '"actions":[{"title":"one practical thing to do","why":"why, from the comments"}],'
    + '"sensitive":[numbers of comments describing harassment, abuse, discrimination, theft or danger to someone]}. '
    + 'Up to 10 themes, most mentioned first; every comment in at least one theme; up to 3 actions.';
  try {
    const out = await env.AI.run(MODEL, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 2000, temperature: 0.2,
    });
    const json = readJson(out?.response ?? out?.result?.response ?? out);
    if (!json || !Array.isArray(json.themes)) return null;
    const ok = (n) => Number.isInteger(n) && n >= 0 && n < comments.length;
    return {
      themes: json.themes.slice(0, 12).map((t) => ({
        title: String(t.title ?? '').slice(0, 80) || 'Other',
        area: String(t.area ?? '').slice(0, 60) || null,
        summary: String(t.summary ?? '').slice(0, 500),
        tone: ['positive', 'negative', 'mixed'].includes(t.tone) ? t.tone : 'mixed',
        comments: (Array.isArray(t.comments) ? t.comments : []).map(Number).filter(ok),
      })).filter((t) => t.comments.length),
      headlines: Object.fromEntries((Array.isArray(json.areas) ? json.areas : [])
        .map((a) => [String(a.area ?? ''), String(a.headline ?? '').slice(0, 200)])),
      actions: (Array.isArray(json.actions) ? json.actions : []).slice(0, 3)
        .map((a) => ({ title: String(a.title ?? '').slice(0, 120), why: String(a.why ?? '').slice(0, 300) })).filter((a) => a.title),
      sensitive: (Array.isArray(json.sensitive) ? json.sensitive : []).map(Number).filter(ok),
    };
  } catch (err) {
    console.error('feedback analysis failed', err);
    return null;
  }
}

export async function analyseRound(db, round, { env = null } = {}) {
  const s = await readFeedbackSettings(db);
  const questions = JSON.parse(round.questions || '[]');
  const rows = await db.prepare('SELECT * FROM fb_response WHERE round_id = ?1 ORDER BY id').bind(round.id).all()
    .catch(() => ({ results: [] }));
  const responses = (rows.results ?? []).map((r) => ({ ...r, answers: JSON.parse(r.answers || '{}') }));
  const prevRow = await db.prepare(
    "SELECT analysis FROM fb_round WHERE id < ?1 AND status = 'closed' AND analysis IS NOT NULL ORDER BY id DESC LIMIT 1",
  ).bind(round.id).first().catch(() => null);
  const previous = prevRow?.analysis ? JSON.parse(prevRow.analysis) : null;
  const t = tally({ questions, responses, previous, minGroup: s.minGroup });
  const ai = await aiThemes(env, t.comments, t.areas);
  const analysis = {
    asked: Number(round.asked) || 0,
    answered: responses.length,
    feel: t.feel,
    recommend: t.recommend,
    departments: t.departments,
    areas: t.areas.map((a) => ({ ...a, headline: ai?.headlines?.[a.area] || null })),
    comments: t.comments,
    themes: ai?.themes?.length ? ai.themes : plainThemes(t.comments),
    actions: ai?.actions ?? [],
    sensitive: ai?.sensitive ?? [],
    by: ai ? 'ai' : 'plain',
  };
  await db.prepare("UPDATE fb_round SET analysis = ?2, analysed_at = datetime('now'), analysed_by = ?3 WHERE id = ?1")
    .bind(round.id, JSON.stringify(analysis), analysis.by).run();
  return analysis;
}
