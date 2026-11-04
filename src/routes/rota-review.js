import { badRequest, forbidden, int, json, notFound, readJson, str } from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { addDays, isDay, nowIn, startOfWeek } from '../util/dates.js';
import {
  DAY_NAMES, deadlineFor, draftPeople, publishGate, readDraftRule, reviewersOf, sayDue, weekLabel,
} from '../lib/rota-draft.js';

/**
 * The draft rota sent for review, and the weekly deadline it is sent by.
 *
 * Whoever plans the rota sends the weeks they have drafted to the
 * administrators chosen in Settings (every administrator if nobody is
 * chosen). A reviewer approves it or sends it back with a note, and the
 * planner is told either way. Publishing is unchanged: this is the step
 * before it.
 */

const isAdmin = (ctx) => ctx.session?.user?.role === 'admin';
const actorOf = (ctx) => ctx.session.user.name;
const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(`${ctx.session.user.name} (${ctx.session.user.role})`, action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

function rangeLabel(from, to) {
  if (to === addDays(from, 6)) return weekLabel(from);
  const fmt = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
  return `${fmt(from)} – ${fmt(to)}`;
}

function reviewOut(r, people) {
  if (!r) return null;
  let asked = [];
  try { asked = JSON.parse(r.reviewers ?? '[]'); } catch { /* none written */ }
  const nameOf = (id) => people.find((p) => Number(p.id) === Number(id))?.name ?? null;
  return {
    id: r.id, from: r.day_from, to: r.day_to, status: r.status, note: r.note ?? null,
    sentBy: r.sent_by, sentAt: r.sent_at,
    reviewers: asked.map(nameOf).filter(Boolean),
    reviewerIds: asked.map(Number),
    decidedBy: r.decided_by ?? null, decidedAt: r.decided_at ?? null, decisionNote: r.decision_note ?? null,
  };
}

/** GET /api/att/rota-review?from=&to= — where this stretch stands, and its deadline. */
export async function rotaReviewState(ctx) {
  const q = new URL(ctx.request.url).searchParams;
  const from = isDay(q.get('from')) ? q.get('from') : null;
  const to = isDay(q.get('to')) ? q.get('to') : from;
  if (!from) throw badRequest('Which week?');
  const rule = await readDraftRule(ctx.db);
  const now = nowIn(rule.timezone);
  const { admins } = await draftPeople(ctx.db);
  const row = await ctx.db.prepare(
    `SELECT * FROM rota_review WHERE day_from <= ?2 AND day_to >= ?1 AND status != 'replaced'
      ORDER BY id DESC LIMIT 1`,
  ).bind(from, to).first().catch(() => null);
  const reviewers = reviewersOf(rule, admins);
  const week = startOfWeek(from);
  const d = deadlineFor(rule, week);
  const review = reviewOut(row, admins);
  return json({
    review,
    deadline: rule.on ? { due: d.due, said: sayDue(d.due, now), past: now >= d.due, week } : null,
    reviewers: reviewers.map((a) => ({ id: a.id, name: a.name })),
    canReview: isAdmin(ctx) && (rule.reviewers.length === 0 || rule.reviewers.includes(Number(ctx.session.user.id))),
    // Whether this login may publish what is shown: a planner only once it is approved.
    publish: await publishGate(ctx.db, { from, to, role: ctx.session?.user?.role }),
    now,
  });
}

/** POST /api/att/rota-review { from, to, note } — the planner sends what they drafted. */
export async function sendRotaForReview(ctx) {
  const body = await readJson(ctx.request);
  if (!isDay(body.from) || !isDay(body.to) || body.to < body.from) throw badRequest('Which days?');
  if (addDays(body.from, 62) < body.to) throw badRequest('Two months at most in one go.');
  const note = str(body.note, 'Note', { max: 600 }) || null;
  const rule = await readDraftRule(ctx.db);
  const { admins } = await draftPeople(ctx.db);
  let reviewers = reviewersOf(rule, admins);
  // Nobody reviews their own draft where somebody else can.
  const others = reviewers.filter((r) => Number(r.id) !== Number(ctx.session.user.id));
  if (others.length) reviewers = others;
  if (!reviewers.length) throw badRequest('There is no administrator to review it. Choose one in Settings › Rota & clocking › Draft deadline.');

  await ctx.db.prepare(
    "UPDATE rota_review SET status = 'replaced' WHERE day_from <= ?2 AND day_to >= ?1 AND status IN ('sent', 'returned', 'approved')",
  ).bind(body.from, body.to).run();
  const made = await ctx.db.prepare(
    `INSERT INTO rota_review (day_from, day_to, note, reviewers, sent_by, sent_by_user)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`,
  ).bind(body.from, body.to, note, JSON.stringify(reviewers.map((r) => Number(r.id))), actorOf(ctx), ctx.session.user.id ?? null).first();
  await audit(ctx, 'rota.review_sent', made?.id, { from: body.from, to: body.to });

  const label = rangeLabel(body.from, body.to);
  for (const r of reviewers) {
    // eslint-disable-next-line no-await-in-loop
    await createNotice(ctx.db, {
      kind: 'rota.review_asked', level: 'info',
      title: `Review the draft rota for ${label}`,
      body: `${actorOf(ctx)} sent it for review.${note ? ` “${note}”` : ''}`,
      link: `#/att-rota?from=${startOfWeek(body.from)}`, actor: actorOf(ctx), userId: r.id, push: true, email: true,
    }, ctx).catch((err) => console.error('review notice failed', err));
  }
  return json({ ok: true, id: made?.id ?? null, reviewers: reviewers.map((r) => r.name) });
}

/** POST /api/att/rota-review/:id/decide { action: approve | return, note } */
export async function decideRotaReview(ctx, idParam) {
  if (!isAdmin(ctx)) throw forbidden('Only an administrator reviews the draft rota.');
  const id = int(idParam, 'Which', { required: true, min: 1 });
  const body = await readJson(ctx.request);
  const action = body.action === 'return' ? 'return' : body.action === 'approve' ? 'approve' : null;
  if (!action) throw badRequest('Approve it or send it back.');
  const note = str(body.note, 'Note', { max: 600 }) || null;
  if (action === 'return' && !note) throw badRequest('Say what needs changing.');
  const row = await ctx.db.prepare('SELECT * FROM rota_review WHERE id = ?1').bind(id).first();
  if (!row) throw notFound('No such review.');
  if (row.status !== 'sent') throw badRequest(row.status === 'replaced' ? 'A newer draft has been sent since.' : 'This one has already been answered.');
  const rule = await readDraftRule(ctx.db);
  if (rule.reviewers.length && !rule.reviewers.includes(Number(ctx.session.user.id))) {
    throw forbidden('You are not one of the reviewers chosen in Settings.');
  }
  await ctx.db.prepare(
    "UPDATE rota_review SET status = ?2, decided_by = ?3, decided_at = datetime('now'), decision_note = ?4 WHERE id = ?1",
  ).bind(id, action === 'approve' ? 'approved' : 'returned', actorOf(ctx), note).run();
  await audit(ctx, `rota.review_${action}`, id, { note });

  const label = rangeLabel(row.day_from, row.day_to);
  if (row.sent_by_user) {
    await createNotice(ctx.db, {
      kind: 'rota.review_done', level: action === 'approve' ? 'good' : 'warn',
      title: action === 'approve' ? `Approved: the draft rota for ${label}` : `Sent back: the draft rota for ${label}`,
      body: action === 'approve'
        ? `${actorOf(ctx)} approved it.${note ? ` “${note}”` : ''} It can be published.`
        : `${actorOf(ctx)}: “${note}”. Change it and send it for review again.`,
      link: `#/att-rota?from=${startOfWeek(row.day_from)}`, actor: actorOf(ctx), userId: row.sent_by_user, push: true, email: true,
    }, ctx).catch((err) => console.error('review answer notice failed', err));
  }
  return json({ ok: true });
}

/** GET /api/att/rota-draft — the rule, and the administrators who could review. */
export async function rotaDraftRule(ctx) {
  const rule = await readDraftRule(ctx.db);
  const { admins, planners } = await draftPeople(ctx.db);
  const now = nowIn(rule.timezone);
  const next = deadlineFor(rule, addDays(startOfWeek(now.slice(0, 10)), 7 * rule.weeksAhead));
  const upcoming = next.due > now ? next : deadlineFor(rule, addDays(next.weekStart, 7));
  return json({
    rule: { ...rule, timezone: undefined, publishNeedsReview: String((await ctx.db.prepare("SELECT value FROM settings WHERE key = 'rota_publish_needs_review'").first().catch(() => null))?.value ?? '1') !== '0' },
    admins: admins.map((a) => ({ id: a.id, name: a.name })),
    planners: planners.map((p) => ({ id: p.id, name: p.name })),
    days: DAY_NAMES,
    next: { week: weekLabel(upcoming.weekStart), due: sayDue(upcoming.due, now), steps: upcoming.steps.map((s) => ({ step: s.step, said: sayDue(s.at, now) })) },
    canEdit: isAdmin(ctx),
  });
}

/** POST /api/att/rota-draft — an administrator changes the rule. */
export async function saveRotaDraftRule(ctx) {
  if (!isAdmin(ctx)) throw forbidden('Only an administrator changes the draft deadline.');
  const b = await readJson(ctx.request);
  const clock = (v, what) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? ''))) throw badRequest(`${what}: a time like 17:00.`);
    return String(v);
  };
  const vals = {
    rota_draft_on: b.on ? '1' : '0',
    rota_draft_due_dow: String(int(b.dueDow, 'Due on', { required: true, min: 0, max: 6 })),
    rota_draft_due_time: clock(b.dueTime, 'Due at'),
    rota_draft_first_days: String(int(b.firstDays, 'First reminder', { required: true, min: 0, max: 6 })),
    rota_draft_first_time: clock(b.firstTime, 'First reminder at'),
    rota_draft_last_hours: String(int(b.lastHours, 'Last reminder', { required: true, min: 0, max: 48 })),
    rota_draft_weeks_ahead: String(int(b.weeksAhead, 'Which week', { required: true, min: 1, max: 3 })),
    rota_draft_cc_admins: b.ccAdmins === false ? '0' : '1',
    rota_publish_needs_review: b.publishNeedsReview === false ? '0' : '1',
    rota_review_by: JSON.stringify((Array.isArray(b.reviewers) ? b.reviewers : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)),
  };
  for (const [key, value] of Object.entries(vals)) {
    // eslint-disable-next-line no-await-in-loop
    await ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2')
      .bind(key, value).run();
  }
  await audit(ctx, 'rota.draft_rule', 'settings', vals);
  return rotaDraftRule(ctx);
}
