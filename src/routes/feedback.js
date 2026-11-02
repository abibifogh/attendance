import { badRequest, forbidden, int, json, notFound, readJson, str } from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { isAdmin } from '../lib/payroll-access.js';
import {
  STATUSES, activeQuestions, analyseRound, closeRound, eligibleStaff, feedbackSettings, nextOpening, openRound,
  readFeedbackSettings, submitAnswers, wasAsked,
} from '../lib/feedback.js';
import { todayIn } from '../util/dates.js';

/**
 * People › Feedback, and the survey on somebody's own phone.
 *
 * Admins and whoever manages HR see every result. Only an admin sees who said
 * what, and only in a round that was not anonymous. A supervisor, where the
 * setting allows, sees their own department's scores and comments, never
 * names, and nothing at all for a group smaller than the minimum.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;
const can = (ctx, permission) => (ctx.session?.permissions ?? []).includes(permission);
const manages = (ctx) => isAdmin(ctx.session) || can(ctx, 'hr_manage');

const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(actorOf(ctx), action, String(entity ?? ''), JSON.stringify(detail ?? {})).run().catch(() => {});

async function timezoneOf(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first().catch(() => null);
  return row?.value || 'UTC';
}

const roundOut = (r, answered) => ({
  id: r.id, label: r.label, opensOn: r.opens_on, closesOn: r.closes_on, status: r.status,
  anonymous: Boolean(Number(r.anonymous)), asked: Number(r.asked) || 0, answered,
  analysedAt: r.analysed_at ?? null, analysedBy: r.analysed_by ?? null, saidAt: r.said_at ?? null,
});

/** GET /api/feedback?round= */
export async function feedbackOverview(ctx) {
  const settings = await readFeedbackSettings(ctx.db);
  const full = manages(ctx);
  if (!full && !(settings.supervisors && can(ctx, 'att_manage'))) {
    throw forbidden('Staff feedback is for admins and HR.');
  }
  const names = isAdmin(ctx.session);
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);

  const rows = ((await ctx.db.prepare('SELECT * FROM fb_round ORDER BY id DESC LIMIT 24').all()
    .catch(() => ({ results: [] }))).results ?? []);
  const counts = new Map(((await ctx.db.prepare('SELECT round_id, COUNT(*) AS n FROM fb_done GROUP BY round_id').all()
    .catch(() => ({ results: [] }))).results ?? []).map((r) => [r.round_id, Number(r.n)]));
  const rounds = rows.map((r) => roundOut(r, counts.get(r.id) ?? 0));

  const asked = int(new URL(ctx.request.url).searchParams.get('round'), 'Round', { min: 1 });
  const chosen = rows.find((r) => r.id === asked) ?? rows.find((r) => r.status === 'closed') ?? rows[0] ?? null;

  let result = null;
  if (chosen?.analysis) {
    const a = JSON.parse(chosen.analysis);
    const anonymous = Boolean(Number(chosen.anonymous));
    const deptCounts = new Map();
    for (const c of a.comments ?? []) deptCounts.set(c.department, (deptCounts.get(c.department) ?? 0) + 1);
    // Group sizes from the answers, not the comments.
    const sizes = new Map(((await ctx.db.prepare(
      'SELECT COALESCE(department, \'Other\') AS d, COUNT(*) AS n FROM fb_response WHERE round_id = ?1 GROUP BY 1',
    ).bind(chosen.id).all().catch(() => ({ results: [] }))).results ?? []).map((r) => [r.d, Number(r.n)]));
    let mine = null;
    if (!full) {
      const me = await ctx.db.prepare('SELECT department FROM att_staff WHERE id = ?1')
        .bind(Number(ctx.session.user.staff_id) || 0).first().catch(() => null);
      mine = me?.department || null;
      if (!mine || (sizes.get(mine) ?? 0) < settings.minGroup) {
        result = { limited: true, department: mine, tooFew: true, minGroup: settings.minGroup };
      }
    }
    if (!result) {
      const nameBy = new Map();
      if (names && !anonymous) {
        const ids = [...new Set((a.comments ?? []).map((c) => c.staffId).filter(Boolean))];
        for (const id of ids) {
          // eslint-disable-next-line no-await-in-loop
          const s = await ctx.db.prepare('SELECT name FROM att_staff WHERE id = ?1').bind(id).first().catch(() => null);
          if (s) nameBy.set(id, s.name);
        }
      }
      const sensitive = new Set(a.sensitive ?? []);
      const shown = (a.comments ?? []).map((c, i) => ({
        i,
        area: c.area,
        text: c.text,
        score: c.score,
        choice: c.choice,
        department: (sizes.get(c.department) ?? 0) >= settings.minGroup ? c.department : null,
        name: names && !anonymous ? (nameBy.get(c.staffId) ?? null) : null,
        sensitive: sensitive.has(i),
        rawDepartment: c.department,
      })).filter((c) => (full || c.rawDepartment === mine) && (full || !c.sensitive))
        .map(({ rawDepartment, ...c }) => c);
      const keep = new Set(shown.map((c) => c.i));
      result = {
        limited: !full,
        department: mine,
        asked: a.asked,
        answered: a.answered,
        feel: a.feel,
        recommend: a.recommend,
        departments: (a.departments ?? []).filter((d) => full || d === mine),
        areas: (a.areas ?? []).map((ar) => ({
          ...ar,
          byDepartment: (ar.byDepartment ?? []).filter((d) => full || d.department === mine),
        })),
        themes: (a.themes ?? []).map((t) => ({ ...t, comments: t.comments.filter((i) => keep.has(i)) }))
          .filter((t) => t.comments.length),
        actions: full ? (a.actions ?? []) : [],
        comments: shown,
        by: a.by,
        names: names && !anonymous,
      };
    }
  }

  const actions = chosen ? ((await ctx.db.prepare('SELECT * FROM fb_action WHERE round_id = ?1 ORDER BY sort_order, id')
    .bind(chosen.id).all().catch(() => ({ results: [] }))).results ?? []) : [];

  return json({
    today,
    settings,
    nextRound: settings.on ? nextOpening(today, settings.months) : null,
    rounds,
    round: chosen ? roundOut(chosen, counts.get(chosen.id) ?? 0) : null,
    result,
    actions: actions.map((x) => ({ id: x.id, status: x.status, title: x.title, body: x.body })),
    canManage: full,
    canSeeNames: names,
    isAdmin: isAdmin(ctx.session),
  });
}

const needManage = (ctx) => { if (!manages(ctx)) throw forbidden('Only admins and HR run staff feedback.'); };

/** POST /api/feedback/rounds { anonymous } — a round now. */
export async function openFeedbackRound(ctx) {
  needManage(ctx);
  const body = await readJson(ctx.request).catch(() => ({}));
  const today = todayIn(await timezoneOf(ctx.db));
  const out = await openRound(ctx.db, {
    today, by: actorOf(ctx), ctx, anonymous: body.anonymous == null ? null : Boolean(body.anonymous),
    staffIds: Array.isArray(body.staffIds) ? body.staffIds : null,
  });
  if (!out.opened) throw badRequest(out.reason || 'Not opened.');
  await audit(ctx, 'feedback.open', out.id, { asked: out.asked });
  return json(out);
}

/** GET /api/feedback/people — everybody who could be sent a round, and who would be by default. */
export async function feedbackPeople(ctx) {
  needManage(ctx);
  const settings = await readFeedbackSettings(ctx.db);
  const today = todayIn(await timezoneOf(ctx.db));
  const eligible = new Set((await eligibleStaff(ctx.db, today, settings)).map((p) => Number(p.id)));
  const rows = await ctx.db.prepare(
    `SELECT s.id, s.name, s.department, s.hired_on,
            EXISTS (SELECT 1 FROM users u WHERE u.staff_id = s.id AND u.active = 1) AS has_login
       FROM att_staff s WHERE s.active = 1 ORDER BY s.name`,
  ).all();
  return json({
    minServiceDays: settings.minServiceDays,
    people: (rows.results ?? []).map((p) => ({
      id: p.id, name: p.name, department: p.department || null, hiredOn: p.hired_on || null,
      eligible: eligible.has(Number(p.id)), hasLogin: Boolean(Number(p.has_login)),
    })),
  });
}

/** POST /api/feedback/rounds/:id/close */
export async function closeFeedbackRound(ctx, idParam) {
  needManage(ctx);
  const id = int(idParam, 'Round', { required: true, min: 1 });
  const round = await ctx.db.prepare('SELECT * FROM fb_round WHERE id = ?1').bind(id).first();
  if (!round) throw notFound('No such round.');
  if (round.status !== 'open') throw badRequest('This round is already closed.');
  const analysis = await closeRound(ctx.db, round, { env: ctx.env, ctx, by: ctx.session.user.name });
  await audit(ctx, 'feedback.close', id, { answered: analysis.answered });
  return json({ ok: true });
}

/** POST /api/feedback/rounds/:id/analyse — read it again. */
export async function analyseFeedbackRound(ctx, idParam) {
  needManage(ctx);
  const id = int(idParam, 'Round', { required: true, min: 1 });
  const round = await ctx.db.prepare('SELECT * FROM fb_round WHERE id = ?1').bind(id).first();
  if (!round) throw notFound('No such round.');
  if (round.status !== 'closed') throw badRequest('A round is read once it has closed.');
  const a = await analyseRound(ctx.db, round, { env: ctx.env });
  return json({ ok: true, by: a.by });
}

/** POST /api/feedback/settings */
export async function saveFeedbackSettings(ctx) {
  if (!isAdmin(ctx.session)) throw forbidden('Only an administrator changes how staff feedback runs.');
  const body = await readJson(ctx.request);
  const set = [];
  if (body.on != null) set.push(['feedback_on', body.on ? '1' : '0']);
  if (body.anonymous != null) set.push(['feedback_anonymous', body.anonymous ? '1' : '0']);
  if (body.supervisors != null) set.push(['feedback_supervisors', body.supervisors ? '1' : '0']);
  if (body.months != null) {
    const months = (Array.isArray(body.months) ? body.months : String(body.months).split(','))
      .map(Number).filter((m) => m >= 1 && m <= 12);
    if (!months.length) throw badRequest('Pick at least one month.');
    set.push(['feedback_months', [...new Set(months)].sort((a, b) => a - b).join(',')]);
  }
  if (body.openDays != null) set.push(['feedback_open_days', String(int(body.openDays, 'Days open', { min: 1, max: 60 }))]);
  if (body.minGroup != null) set.push(['feedback_min_group', String(int(body.minGroup, 'Smallest group', { min: 1, max: 50 }))]);
  if (body.minServiceDays != null) set.push(['feedback_min_service_days', String(int(body.minServiceDays, 'Days employed', { min: 0, max: 365 }))]);
  for (const [key, value] of set) {
    // eslint-disable-next-line no-await-in-loop
    await ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .bind(key, value).run();
  }
  await audit(ctx, 'feedback.settings', 'settings', Object.fromEntries(set));
  return json({ ok: true, settings: feedbackSettings(Object.fromEntries(set)) });
}

/** GET /api/feedback/questions */
export async function feedbackQuestions(ctx) {
  needManage(ctx);
  const rows = await ctx.db.prepare('SELECT * FROM fb_question ORDER BY sort_order, id').all();
  return json({ questions: (rows.results ?? []).map((q) => ({ id: q.id, area: q.area, text: q.text, kind: q.kind, active: Boolean(q.active) })) });
}

/** POST /api/feedback/questions { questions: [{ id?, area, text, kind, active }] } in order */
export async function saveFeedbackQuestions(ctx) {
  needManage(ctx);
  const body = await readJson(ctx.request);
  const list = Array.isArray(body.questions) ? body.questions : [];
  if (!list.length) throw badRequest('Keep at least one question.');
  if (list.length > 30) throw badRequest('Thirty questions at most.');
  for (const [i, q] of list.entries()) {
    const area = str(q.area, 'Area', { required: true, max: 60 });
    const text = str(q.text, 'Question', { required: true, max: 300 });
    const kind = ['scale', 'recommend', 'text'].includes(q.kind) ? q.kind : 'scale';
    const active = q.active === false ? 0 : 1;
    if (q.id) {
      // eslint-disable-next-line no-await-in-loop
      await ctx.db.prepare('UPDATE fb_question SET area = ?2, text = ?3, kind = ?4, active = ?5, sort_order = ?6 WHERE id = ?1')
        .bind(Number(q.id), area, text, kind, active, (i + 1) * 10).run();
    } else {
      // eslint-disable-next-line no-await-in-loop
      await ctx.db.prepare('INSERT INTO fb_question (area, text, kind, active, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(area, text, kind, active, (i + 1) * 10).run();
    }
  }
  await audit(ctx, 'feedback.questions', 'questions', { count: list.length });
  return feedbackQuestions(ctx);
}

/** POST /api/feedback/rounds/:id/actions { actions: [{ status, title, body }] } — the whole list */
export async function saveFeedbackActions(ctx, idParam) {
  needManage(ctx);
  const id = int(idParam, 'Round', { required: true, min: 1 });
  const body = await readJson(ctx.request);
  const list = (Array.isArray(body.actions) ? body.actions : []).slice(0, 20);
  await ctx.db.prepare('DELETE FROM fb_action WHERE round_id = ?1').bind(id).run();
  for (const [i, a] of list.entries()) {
    const title = str(a.title, 'What', { max: 160 });
    if (!title) continue;
    // eslint-disable-next-line no-await-in-loop
    await ctx.db.prepare('INSERT INTO fb_action (round_id, status, title, body, sort_order, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(id, STATUSES.includes(a.status) ? a.status : 'doing', title, str(a.body, 'More', { max: 600 }) || null, (i + 1) * 10, ctx.session.user.name).run();
  }
  return json({ ok: true });
}

/** POST /api/feedback/rounds/:id/said — send You said, we did to everybody. */
export async function publishSaid(ctx, idParam) {
  needManage(ctx);
  const id = int(idParam, 'Round', { required: true, min: 1 });
  const round = await ctx.db.prepare('SELECT * FROM fb_round WHERE id = ?1').bind(id).first();
  if (!round) throw notFound('No such round.');
  const n = await ctx.db.prepare('SELECT COUNT(*) AS n FROM fb_action WHERE round_id = ?1').bind(id).first();
  if (!Number(n?.n)) throw badRequest('Add at least one thing first.');
  const body = await readJson(ctx.request).catch(() => ({}));
  // Whoever an admin picked, or everybody.
  const chosen = Array.isArray(body.staffIds) ? [...new Set(body.staffIds.map(Number).filter((x) => x > 0))] : null;
  if (chosen && !chosen.length) throw badRequest('Pick at least one person to send it to.');
  await ctx.db.prepare("UPDATE fb_round SET said_at = datetime('now'), said_to = ?2 WHERE id = ?1")
    .bind(id, chosen ? JSON.stringify(chosen) : null).run();
  const everybody = await ctx.db.prepare(
    `SELECT u.id, u.staff_id FROM users u JOIN att_staff s ON s.id = u.staff_id WHERE u.active = 1 AND s.active = 1`,
  ).all().catch(() => ({ results: [] }));
  const people = { results: (everybody.results ?? []).filter((u) => !chosen || chosen.includes(Number(u.staff_id))) };
  for (const u of people.results ?? []) {
    // eslint-disable-next-line no-await-in-loop
    await createNotice(ctx.db, {
      kind: 'feedback.said', level: 'info',
      title: `You said, we did: ${round.label}`,
      body: 'What the team said in the feedback, and what is being done about it.',
      link: '#/my-feedback', actor: ctx.session.user.name, userId: u.id, push: true, email: false, cc: false,
    }, ctx).catch(() => {});
  }
  await audit(ctx, 'feedback.said', id, {});
  return json({ ok: true, told: (people.results ?? []).length });
}

/** GET /api/me/feedback */
export async function myFeedback(ctx) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  const open = await ctx.db.prepare("SELECT * FROM fb_round WHERE status = 'open' ORDER BY id DESC LIMIT 1").first().catch(() => null);
  let round = null;
  if (open && staffId && await wasAsked(ctx.db, open, staffId)) {
    const done = await ctx.db.prepare('SELECT 1 AS x FROM fb_done WHERE round_id = ?1 AND staff_id = ?2')
      .bind(open.id, staffId).first().catch(() => null);
    round = {
      id: open.id, label: open.label, closesOn: open.closes_on,
      anonymous: Boolean(Number(open.anonymous)),
      questions: JSON.parse(open.questions || '[]'),
      done: Boolean(done),
    };
  }
  // The latest You said, we did sent to everybody or to them.
  const saidRows = await ctx.db.prepare(
    'SELECT * FROM fb_round WHERE said_at IS NOT NULL ORDER BY said_at DESC LIMIT 8',
  ).all().catch(() => ({ results: [] }));
  const saidRound = (saidRows.results ?? []).find((r) => {
    if (!r.said_to) return true;
    try { return JSON.parse(r.said_to).map(Number).includes(staffId); } catch { return false; }
  }) ?? null;
  let said = null;
  if (saidRound) {
    const acts = await ctx.db.prepare('SELECT * FROM fb_action WHERE round_id = ?1 ORDER BY sort_order, id').bind(saidRound.id).all();
    const a = saidRound.analysis ? JSON.parse(saidRound.analysis) : null;
    said = {
      label: saidRound.label, at: saidRound.said_at,
      answered: a?.answered ?? null, asked: a?.asked ?? null,
      actions: (acts.results ?? []).map((x) => ({ status: x.status, title: x.title, body: x.body })),
    };
  }
  return json({ round, said });
}

/** POST /api/me/feedback { roundId, answers } */
export async function answerFeedback(ctx) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  if (!staffId) throw forbidden('This login is not linked to a member of staff.');
  const body = await readJson(ctx.request);
  const id = int(body.roundId, 'Round', { required: true, min: 1 });
  const round = await ctx.db.prepare('SELECT * FROM fb_round WHERE id = ?1').bind(id).first();
  if (!round) throw notFound('No such round.');
  const staff = await ctx.db.prepare('SELECT id, department FROM att_staff WHERE id = ?1').bind(staffId).first();
  if (!staff) throw notFound('No such member of staff.');
  if (!await wasAsked(ctx.db, round, staffId)) throw forbidden('This round was not sent to you.');
  try {
    await submitAnswers(ctx.db, { round, staff, answers: body.answers ?? {} });
  } catch (err) {
    throw badRequest(err.message);
  }
  return json({ ok: true });
}

export { activeQuestions };
