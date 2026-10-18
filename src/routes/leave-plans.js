import {
  badRequest, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import { leaveDaysFor, loadDataset } from '../lib/attendance.js';
import { recompute } from '../lib/attendance-ingest.js';
import { createNotice } from '../lib/notices.js';
import { firstName, sayDate, sayRange } from '../lib/email-design.js';
import { addDays, diffDays, isDay, nowIn, startOfWeek } from '../util/dates.js';
import {
  DEFAULT_MIN_DAYS, askForPlan, awayByDay, busyIn, contactsFor, defaultYear, eachDay,
  eligiblePeople, fullDays, inviteEverybody, limitFor, overLimit, planDays, readRound, spansFor,
} from '../lib/leave-plans.js';

/**
 * Leave plans: the person's own plan, the managers' board, and the round.
 *
 * The rules live in lib/leave-plans.js.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;
const nameOf = (actor) => String(actor ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();

async function today(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first().catch(() => null);
  return nowIn(row?.value || 'UTC').slice(0, 10);
}

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
    .bind(actorOf(ctx), action, entity == null ? null : String(entity), detail ? JSON.stringify(detail) : null)
    .run().catch(() => {});
}

function readDayOf(value, field) {
  const day = String(value ?? '');
  if (!isDay(day)) throw badRequest(`${field} is not a date.`);
  return day;
}

/** The round people are planning in now: open, and past its opening day. */
async function liveRound(db, now) {
  const row = await db.prepare(
    "SELECT * FROM leave_plan_round WHERE status = 'open' AND opens_on <= ?1 ORDER BY year DESC LIMIT 1",
  ).bind(now).first().catch(() => null);
  return readRound(row);
}

const shapeBlock = (b) => ({
  id: b.id,
  from: b.from_day,
  to: b.to_day,
  days: Number(b.days) || 0,
  reason: b.reason_code,
  status: b.status,
  note: b.note,
  suggestFrom: b.suggest_from,
  suggestTo: b.suggest_to,
  decidedBy: b.decided_by ? nameOf(b.decided_by) : null,
  decidedAt: b.decided_at,
});

/** Days the plan is asking for and not yet booked. */
const plannedDays = (blocks) => blocks
  .filter((b) => b.status !== 'declined' && !b.leave_id)
  .reduce((n, b) => n + (Number(b.days) || 0), 0);

// ---------------------------------------------------------------------------
// A person's own plan
// ---------------------------------------------------------------------------

async function meAndPlan(ctx) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  if (!staffId) throw forbidden('This login is not linked to a staff record yet.');
  const now = await today(ctx.db);
  const round = await liveRound(ctx.db, now);
  if (!round) return { now, round: null };
  const people = await eligiblePeople(ctx.db, round);
  const person = people.find((p) => Number(p.id) === staffId);
  if (!person) return { now, round, person: null };

  await ctx.db.prepare('INSERT OR IGNORE INTO leave_plan (round_id, staff_id) VALUES (?1, ?2)')
    .bind(round.id, staffId).run();
  const plan = await ctx.db.prepare('SELECT * FROM leave_plan WHERE round_id = ?1 AND staff_id = ?2')
    .bind(round.id, staffId).first();
  const blocks = (await ctx.db.prepare('SELECT * FROM leave_plan_block WHERE plan_id = ? ORDER BY from_day')
    .bind(plan.id).all()).results ?? [];
  return { now, round, person, plan, blocks };
}

export async function myPlan(ctx) {
  const { now, round, person, plan, blocks } = await meAndPlan(ctx);
  if (!round) return json({ round: null });
  if (!person) return json({ round: { year: round.year }, eligible: false });

  const { spans } = await spansFor(ctx.db, round);
  const away = awayByDay(spans);
  const limit = limitFor(round, person.department);
  const span = { staffId: person.id, department: person.department, from: person.balance.from, to: person.balance.to };

  const [holidays, reasons] = await Promise.all([
    ctx.db.prepare('SELECT day, name FROM att_holidays WHERE active = 1 AND day BETWEEN ?1 AND ?2 ORDER BY day')
      .bind(person.balance.from, person.balance.to).all().catch(() => ({ results: [] })),
    ctx.db.prepare(
      "SELECT code, label FROM att_reasons WHERE kind = 'leave' AND active = 1 AND staff_pick = 1 AND code <> 'sick_leave' ORDER BY sort_order, label",
    ).all().catch(() => ({ results: [] })),
  ]);

  const planned = plannedDays(blocks);
  return json({
    today: now,
    eligible: true,
    round: {
      year: round.year, dueOn: round.dueOn, minDays: round.minDays, busy: round.busy, limit,
      department: person.department,
    },
    plan: {
      id: plan.id, status: plan.status, sentAt: plan.sent_at,
      reviewedBy: plan.reviewed_by ? nameOf(plan.reviewed_by) : null, reviewedAt: plan.reviewed_at,
    },
    blocks: blocks.map((b) => ({
      ...shapeBlock(b),
      full: b.status === 'planned' && overLimit(away, { ...span, from: b.from_day, to: b.to_day }, limit).length > 0,
      busy: busyIn(round, b.from_day, b.to_day)?.label ?? null,
    })),
    balance: person.balance,
    planned,
    left: Math.round((person.balance.remaining - planned) * 2) / 2,
    fullDays: fullDays(away, span, limit),
    holidays: holidays.results ?? [],
    reasons: reasons.results ?? [],
  });
}

export async function addBlock(ctx) {
  const { round, person, plan, blocks } = await meAndPlan(ctx);
  if (!round || !person) throw badRequest('There is no leave plan open for you just now.');
  const moving = blocks.some((b) => b.status === 'move');
  if (plan.status === 'reviewed' && !moving) {
    throw badRequest('Your plan has been reviewed. Ask for more days under Requests, as usual.');
  }

  const body = await readJson(ctx.request);
  const from = readDayOf(body.from, 'The first day');
  const to = readDayOf(body.to || body.from, 'The last day');
  if (to < from) throw badRequest('The last day is before the first.');
  if (from < person.balance.from || to > person.balance.to) {
    throw badRequest(`Choose days in your ${round.year} leave year, ${sayRange(person.balance.from, person.balance.to)}.`);
  }
  if (diffDays(from, to) > 45) throw badRequest('That is more than six weeks in one go. Split it up.');

  const reason = str(body.reason, 'Type of leave', { max: 40 }) || 'annual_leave';
  const kind = await ctx.db.prepare(
    "SELECT code FROM att_reasons WHERE code = ? AND kind = 'leave' AND active = 1 AND staff_pick = 1 AND code <> 'sick_leave'",
  ).bind(reason).first();
  if (!kind) throw badRequest('That is not a kind of leave to plan.');

  if (blocks.some((b) => b.status !== 'declined' && b.from_day <= to && b.to_day >= from)) {
    throw badRequest('That overlaps time off already in your plan.');
  }
  const booked = await ctx.db.prepare(
    `SELECT id FROM att_leave WHERE staff_id = ?1 AND status IN ('approved','pending')
        AND from_day <= ?2 AND to_day >= ?3`,
  ).bind(person.id, to, from).first();
  if (booked) throw badRequest('You already have leave booked on some of those days.');

  const ds = await loadDataset(ctx.db, { from, to });
  const days = await planDays(ctx.db, ds, { staffId: person.id, from, to }, leaveDaysFor);
  const left = person.balance.remaining - plannedDays(blocks);
  if (reason === 'annual_leave' && days > left) {
    throw badRequest(`That is ${days} days and you have ${Math.max(0, left)} left to plan.`);
  }

  const row = await ctx.db.prepare(
    `INSERT INTO leave_plan_block (plan_id, from_day, to_day, days, reason_code)
     VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
  ).bind(plan.id, from, to, days, reason).first();

  const { spans } = await spansFor(ctx.db, round);
  const full = overLimit(awayByDay(spans), {
    staffId: person.id, department: person.department, from, to,
  }, limitFor(round, person.department));
  const busy = busyIn(round, from, to);

  return json({
    ok: true, id: row.id, days,
    warning: busy
      ? `${busy.label || 'That'} is a busy season: no leave from ${sayRange(busy.from, busy.to)}. Your manager may ask you to move it.`
      : full.length
        ? `${person.department} is full on ${full.length === 1 ? sayDate(full[0]) : `${full.length} of those days`}. Your manager may ask you to move it.`
        : null,
  });
}

export async function removeBlock(ctx, idParam) {
  const id = int(idParam, 'Time off', { required: true, min: 1 });
  const { plan, blocks } = await meAndPlan(ctx);
  const block = (blocks ?? []).find((b) => b.id === id);
  if (!plan || !block) throw notFound('That is not in your plan.');
  if (!['planned', 'move'].includes(block.status)) {
    throw badRequest('That is already decided. Change it under Requests, as usual.');
  }
  await ctx.db.prepare('DELETE FROM leave_plan_block WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

/** Take the dates the manager suggested instead. */
export async function takeSuggestion(ctx, idParam) {
  const id = int(idParam, 'Time off', { required: true, min: 1 });
  const { round, person, plan, blocks } = await meAndPlan(ctx);
  const block = (blocks ?? []).find((b) => b.id === id);
  if (!plan || !block) throw notFound('That is not in your plan.');
  if (block.status !== 'move' || !block.suggest_from) throw badRequest('There are no other dates suggested for that.');

  const from = block.suggest_from;
  const to = block.suggest_to || block.suggest_from;
  const ds = await loadDataset(ctx.db, { from, to });
  const days = await planDays(ctx.db, ds, { staffId: person.id, from, to }, leaveDaysFor);
  await ctx.db.prepare(
    `UPDATE leave_plan_block SET from_day = ?1, to_day = ?2, days = ?3, status = 'planned',
            suggest_from = NULL, suggest_to = NULL
      WHERE id = ?4`,
  ).bind(from, to, days, id).run();
  await ctx.db.prepare("UPDATE leave_plan SET status = 'sent', sent_at = datetime('now') WHERE id = ?").bind(plan.id).run();

  await createNotice(ctx.db, {
    kind: 'leave.plan_sent',
    level: 'info',
    title: `${person.name} took the dates you suggested`,
    body: `${sayRange(from, to)}, in the ${round.year} leave plan. Waiting for approval.`,
    link: '#/leave-plans',
    actor: person.name,
    audience: 'att_manage',
    push: false, email: false, text: false,
  }, ctx);
  return json({ ok: true });
}

export async function sendPlan(ctx) {
  const { round, person, plan, blocks } = await meAndPlan(ctx);
  if (!round || !person) throw badRequest('There is no leave plan open for you just now.');
  const live = blocks.filter((b) => b.status === 'planned');
  if (!live.length && plan.status !== 'draft') throw badRequest('Nothing new to send.');

  const planned = plannedDays(blocks) + blocks.filter((b) => b.leave_id).reduce((n, b) => n + Number(b.days || 0), 0);
  const need = Math.min(round.minDays, Math.max(0, person.balance.remaining + blocks.filter((b) => b.leave_id).reduce((n, b) => n + Number(b.days || 0), 0)));
  if (planned < need) {
    throw badRequest(`Plan at least ${need} days now. You have ${planned}. The rest can be asked for later in the year.`);
  }

  await ctx.db.prepare("UPDATE leave_plan SET status = 'sent', sent_at = datetime('now') WHERE id = ?").bind(plan.id).run();
  await audit(ctx, 'leave.plan_sent', plan.id, { year: round.year, days: planned });

  await createNotice(ctx.db, {
    kind: 'leave.plan_sent',
    level: 'info',
    title: `${person.name} sent a ${round.year} leave plan`,
    body: `${planned} days, ${live.length} block${live.length === 1 ? '' : 's'} of time off.`,
    link: '#/leave-plans',
    actor: person.name,
    audience: 'att_manage',
    push: false, email: false, text: false,
  }, ctx);

  // And when the last of a department is in, its managers hear once.
  if (round.tellManagers) {
    const people = (await eligiblePeople(ctx.db, round)).filter((p) => p.department === person.department);
    const sent = await ctx.db.prepare(
      "SELECT staff_id FROM leave_plan WHERE round_id = ?1 AND status <> 'draft'",
    ).bind(round.id).all();
    const done = new Set((sent.results ?? []).map((r) => Number(r.staff_id)));
    if (people.length && people.every((p) => done.has(Number(p.id)))) {
      await createNotice(ctx.db, {
        kind: 'leave.plan_department_in',
        level: 'good',
        title: `All ${person.department} leave plans for ${round.year} are in`,
        body: `${people.length} plan${people.length === 1 ? '' : 's'} waiting for approval.`,
        link: '#/leave-plans',
        actor: 'HIVE',
        audience: 'att_manage',
        push: true, email: true, text: false,
      }, ctx);
    }
  }
  return json({ ok: true, status: 'sent' });
}

// ---------------------------------------------------------------------------
// The managers' board
// ---------------------------------------------------------------------------

async function roundForYear(db, year) {
  return readRound(await db.prepare('SELECT * FROM leave_plan_round WHERE year = ?').bind(year).first().catch(() => null));
}

/** Everything the board shows, worked out once. */
async function boardFor(db, round, now) {
  const people = await eligiblePeople(db, round);
  const [{ spans, blocks }, plans] = await Promise.all([
    spansFor(db, round),
    db.prepare('SELECT * FROM leave_plan WHERE round_id = ?').bind(round.id).all(),
  ]);
  const planBy = new Map((plans.results ?? []).map((p) => [Number(p.staff_id), p]));
  const away = awayByDay(spans);
  const sentAt = new Map();
  for (const b of blocks) sentAt.set(b.id, b.sent_at);

  const clashes = [];
  const flag = (b, person) => {
    if (b.status !== 'planned' || b.plan_status === 'draft') return null;
    const busy = busyIn(round, b.from_day, b.to_day);
    if (busy) return { kind: 'busy', label: busy.label, busyFrom: busy.from, busyTo: busy.to };
    const limit = limitFor(round, person.department);
    const over = overLimit(away, { staffId: person.id, department: person.department, from: b.from_day, to: b.to_day }, limit);
    if (!over.length) return null;
    const others = new Set();
    for (const day of over) for (const id of away.get(`${person.department}|${day}`) ?? []) if (id !== person.id) others.add(id);
    return { kind: 'limit', days: over.length, firstDay: over[0], limit, with: [...others] };
  };

  const byId = new Map(people.map((p) => [Number(p.id), p]));
  const rows = people.map((p) => {
    const plan = planBy.get(Number(p.id));
    const mine = blocks.filter((b) => Number(b.staff_id) === Number(p.id));
    return {
      id: p.id,
      name: p.name,
      department: p.department,
      plan: plan ? { id: plan.id, status: plan.status, sentAt: plan.sent_at, remindedOn: plan.reminded_on } : null,
      blocks: mine.filter((b) => plan?.status !== 'draft').map((b) => {
        const clash = flag(b, p);
        if (clash) {
          clashes.push({
            blockId: b.id, staff: { id: p.id, name: p.name }, department: p.department,
            from: b.from_day, to: b.to_day, days: Number(b.days) || 0, sentAt: b.sent_at ?? null, ...clash,
            withNames: (clash.with ?? []).map((id) => byId.get(Number(id))?.name ?? 'Somebody'),
          });
        }
        return { ...shapeBlock(b), clash: clash ? clash.kind : null };
      }),
    };
  });

  // How full each department is, week by week: the most away on any day.
  const departments = [...new Set(people.map((p) => p.department))].map((name) => {
    const weeks = [];
    let monday = startOfWeek(`${round.year}-01-01`);
    while (monday <= `${round.year}-12-31`) {
      let most = 0;
      for (const day of eachDay(monday, addDays(monday, 6))) most = Math.max(most, away.get(`${name}|${day}`)?.size ?? 0);
      weeks.push({ monday, away: most });
      monday = addDays(monday, 7);
    }
    return { name, limit: limitFor(round, name), people: people.filter((p) => p.department === name).length, weeks };
  });

  // Who HIVE cannot reach: no login and no address. Somebody has to ask them
  // in person, and the board says so rather than claiming they were reminded.
  const contacts = await contactsFor(db, rows.filter((r) => !r.plan || r.plan.status === 'draft').map((r) => r.id));
  const reachable = (id) => {
    const c = contacts.get(id);
    return Boolean(c?.user_id || String(c?.login_email ?? '').includes('@') || String(c?.personal_email ?? '').includes('@'));
  };
  const notSent = rows.filter((r) => !r.plan || r.plan.status === 'draft')
    .map((r) => ({
      id: r.id, name: r.name, department: r.department, remindedOn: r.plan?.remindedOn ?? null, reachable: reachable(r.id),
    }));
  return {
    today: now,
    round,
    people: rows,
    departments,
    clashes: groupClashes(clashes),
    notSent,
    counts: {
      eligible: people.length,
      sent: people.length - notSent.length,
      reviewed: rows.filter((r) => r.plan?.status === 'reviewed').length,
      clashes: groupClashes(clashes).length,
      clear: rows.reduce((n, r) => n + r.blocks.filter((b) => b.status === 'planned' && !b.clash).length, 0),
      notSent: notSent.length,
    },
  };
}

/**
 * Three housekeepers on the same week is one clash to settle, not three.
 *
 * Over-the-limit blocks in a department that share days are put together,
 * with whoever sent theirs last named as the one to ask to move. A busy
 * season stays one block at a time: each is its own conversation.
 */
export function groupClashes(list) {
  const groups = [];
  for (const c of list) {
    const people = { blockId: c.blockId, id: c.staff.id, name: c.staff.name, sentAt: c.sentAt, from: c.from, to: c.to };
    if (c.kind === 'limit') {
      const same = groups.find((g) => g.kind === 'limit' && g.department === c.department
        && g.from <= c.to && g.to >= c.from);
      if (same) {
        same.people.push(people);
        if (c.from < same.from) same.from = c.from;
        if (c.to > same.to) same.to = c.to;
        continue;
      }
    }
    groups.push({
      kind: c.kind, department: c.department, from: c.from, to: c.to, limit: c.limit ?? null,
      label: c.label ?? null, busyFrom: c.busyFrom ?? null, busyTo: c.busyTo ?? null,
      // The others away who are not in this clash: approved leave already.
      withNames: c.withNames ?? [],
      people: [people],
    });
  }
  for (const g of groups) {
    const names = new Set(g.people.map((p) => p.name));
    g.withNames = g.withNames.filter((n) => !names.has(n));
    g.away = g.people.length + g.withNames.length;
    g.sentLast = [...g.people].sort((a, b) => String(b.sentAt ?? '').localeCompare(String(a.sentAt ?? '')) || b.blockId - a.blockId)[0];
  }
  return groups;
}

export async function board(ctx) {
  const now = await today(ctx.db);
  const asked = Number(ctx.url.searchParams.get('year'));
  const live = await ctx.db.prepare('SELECT year FROM leave_plan_round ORDER BY year DESC').all().catch(() => ({ results: [] }));
  const years = (live.results ?? []).map((r) => Number(r.year));
  const year = asked >= 2000 && asked <= 2100 ? asked : (years[0] ?? defaultYear(now));
  const round = await roundForYear(ctx.db, year);

  // The departments and their current limits, for the setup form.
  const depts = await ctx.db.prepare(
    "SELECT DISTINCT COALESCE(NULLIF(department, ''), 'Other') AS name FROM att_staff WHERE active = 1 ORDER BY name",
  ).all().catch(() => ({ results: [] }));
  const setup = {
    year,
    departments: (depts.results ?? []).map((d) => ({ name: d.name, limit: limitFor(round, d.name) })),
    suggested: { opensOn: `${year}-01-04`, dueOn: `${year}-01-31`, minDays: DEFAULT_MIN_DAYS },
  };

  if (!round) return json({ today: now, year, years, round: null, setup });
  return json({ ...(await boardFor(ctx.db, round, now)), year, years, setup });
}

/** Set up the round, and open it. */
export async function saveRound(ctx) {
  const body = await readJson(ctx.request);
  const year = int(body.year, 'Year', { required: true, min: 2000, max: 2100 });
  const opensOn = readDayOf(body.opensOn, 'Opens');
  const dueOn = readDayOf(body.dueOn, 'Plans due by');
  if (dueOn < opensOn) throw badRequest('Plans are due before planning opens.');
  const minDays = Number(body.minDays ?? DEFAULT_MIN_DAYS);
  if (!Number.isFinite(minDays) || minDays < 0 || minDays > 60) throw badRequest('Ask for between 0 and 60 days.');

  const busy = (Array.isArray(body.busy) ? body.busy : []).filter((b) => b && b.from).map((b) => {
    const from = readDayOf(b.from, 'A busy season');
    const to = readDayOf(b.to || b.from, 'A busy season');
    if (to < from) throw badRequest('A busy season ends before it starts.');
    return { from, to, label: str(b.label, 'Busy season', { max: 60 }) || 'Busy season' };
  });
  const limits = {};
  for (const [name, n] of Object.entries(body.limits && typeof body.limits === 'object' ? body.limits : {})) {
    const v = Number(n);
    if (Number.isFinite(v) && v >= 0 && v <= 50) limits[String(name).slice(0, 60)] = Math.round(v);
  }

  const before = await roundForYear(ctx.db, year);
  const open = Boolean(body.open) || before?.status === 'open';
  await ctx.db.prepare(
    `INSERT INTO leave_plan_round (year, opens_on, due_on, min_days, busy, limits, remind, tell_managers, status, opened_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT (year) DO UPDATE SET
       opens_on = excluded.opens_on, due_on = excluded.due_on, min_days = excluded.min_days,
       busy = excluded.busy, limits = excluded.limits, remind = excluded.remind,
       tell_managers = excluded.tell_managers, status = excluded.status,
       opened_by = COALESCE(leave_plan_round.opened_by, excluded.opened_by)`,
  ).bind(
    year, opensOn, dueOn, minDays, JSON.stringify(busy), JSON.stringify(limits),
    body.remind === false ? 0 : 1, body.tellManagers === false ? 0 : 1,
    open ? 'open' : 'draft', open ? actorOf(ctx) : null,
  ).run();
  await audit(ctx, 'leave.plan_round', year, { opensOn, dueOn, minDays, busy, limits, open });

  // Opened today or earlier: everybody is told now rather than at nine
  // tomorrow.
  let invited = 0;
  const now = await today(ctx.db);
  const round = await roundForYear(ctx.db, year);
  if (open && opensOn <= now && !round.invitedAt) {
    const claim = await ctx.db.prepare(
      "UPDATE leave_plan_round SET invited_at = datetime('now') WHERE id = ?1 AND invited_at IS NULL",
    ).bind(round.id).run();
    if (Number(claim?.meta?.changes ?? 0)) invited = await inviteEverybody(ctx.db, round, ctx, now);
  }
  return json({ ok: true, open, invited });
}

/** Approve one block: it becomes approved leave, on the rota and off the balance. */
async function approveBlock(ctx, block) {
  const clash = await ctx.db.prepare(
    `SELECT id FROM att_leave WHERE staff_id = ?1 AND status IN ('approved','pending')
        AND from_day <= ?2 AND to_day >= ?3`,
  ).bind(block.staff_id, block.to_day, block.from_day).first();
  if (clash) throw badRequest(`${block.name} already has leave booked on some of those days.`);

  const leave = await ctx.db.prepare(
    `INSERT INTO att_leave
       (staff_id, reason_code, from_day, to_day, days, half_day, status, reason,
        requested_by, requested_by_id, decided_by, decided_at, estimated)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'approved', ?6, ?7, NULL, ?8, datetime('now'), 0)
     RETURNING id`,
  ).bind(
    block.staff_id, block.reason_code, block.from_day, block.to_day, Number(block.days) || 0,
    `From the ${block.year} leave plan`, `${block.name} (staff)`, actorOf(ctx),
  ).first();
  await ctx.db.prepare(
    `UPDATE leave_plan_block SET status = 'approved', leave_id = ?1, decided_by = ?2,
            decided_at = datetime('now')
      WHERE id = ?3`,
  ).bind(leave.id, actorOf(ctx), block.id).run();
  await recompute(ctx.db, { staffIds: [block.staff_id], from: block.from_day, to: block.to_day });
  return leave.id;
}

const BLOCK_SQL = `SELECT b.*, p.staff_id, p.round_id, p.status AS plan_status, s.name, s.department, r.year
                     FROM leave_plan_block b
                     JOIN leave_plan p ON p.id = b.plan_id
                     JOIN att_staff s ON s.id = p.staff_id
                     JOIN leave_plan_round r ON r.id = p.round_id`;

export async function decideBlock(ctx, idParam) {
  const id = int(idParam, 'Time off', { required: true, min: 1 });
  const body = await readJson(ctx.request);
  const decision = ['approve', 'move', 'decline'].includes(body.decision) ? body.decision : null;
  if (!decision) throw badRequest('Say approve, ask to move, or decline.');

  const block = await ctx.db.prepare(`${BLOCK_SQL} WHERE b.id = ?`).bind(id).first();
  if (!block) throw notFound('That time off is not in any plan.');
  if (block.status !== 'planned') throw badRequest('That has already been decided.');

  const note = str(body.note, 'Message', { max: 400 });
  if (decision === 'approve') {
    await approveBlock(ctx, block);
  } else if (decision === 'move') {
    const suggestFrom = body.suggestFrom ? readDayOf(body.suggestFrom, 'The suggested first day') : null;
    const suggestTo = body.suggestTo ? readDayOf(body.suggestTo, 'The suggested last day') : suggestFrom;
    if (suggestFrom && suggestTo < suggestFrom) throw badRequest('The suggested last day is before the first.');
    if (!note && !suggestFrom) throw badRequest('Say why, or suggest other dates.');
    await ctx.db.prepare(
      `UPDATE leave_plan_block SET status = 'move', note = ?1, suggest_from = ?2, suggest_to = ?3,
              decided_by = ?4, decided_at = datetime('now')
        WHERE id = ?5`,
    ).bind(note, suggestFrom, suggestTo, actorOf(ctx), id).run();
  } else {
    await ctx.db.prepare(
      `UPDATE leave_plan_block SET status = 'declined', note = ?1, decided_by = ?2, decided_at = datetime('now')
        WHERE id = ?3`,
    ).bind(note, actorOf(ctx), id).run();
  }
  await audit(ctx, `leave.plan_block_${decision}`, id, { staffId: block.staff_id, from: block.from_day, to: block.to_day, note });
  const reviewed = await finishIfDone(ctx, block.plan_id);
  return json({ ok: true, decision, reviewed });
}

/** Approve every planned block that clashes with nothing. */
export async function approveClear(ctx) {
  const body = await readJson(ctx.request);
  const round = await roundForYear(ctx.db, int(body.year, 'Year', { required: true, min: 2000, max: 2100 }));
  if (!round) throw notFound('There is no plan round for that year.');
  const now = await today(ctx.db);
  const state = await boardFor(ctx.db, round, now);

  const ids = state.people.flatMap((p) => p.blocks.filter((b) => b.status === 'planned' && !b.clash).map((b) => b.id));
  const plans = new Set();
  let approved = 0;
  const skipped = [];
  for (const id of ids) {
    const block = await ctx.db.prepare(`${BLOCK_SQL} WHERE b.id = ?`).bind(id).first();
    if (!block || block.status !== 'planned') continue;
    try {
      await approveBlock(ctx, block);
      plans.add(block.plan_id);
      approved += 1;
    } catch (err) {
      skipped.push(`${block.name}: ${err.message}`);
    }
  }
  for (const planId of plans) await finishIfDone(ctx, planId);
  await audit(ctx, 'leave.plan_approve_clear', round.year, { approved, skipped: skipped.length });
  return json({ ok: true, approved, skipped });
}

/**
 * When nothing in a plan is waiting any more, it is reviewed, and the person
 * hears what was approved and what to move, in one message.
 */
async function finishIfDone(ctx, planId) {
  const blocks = (await ctx.db.prepare('SELECT * FROM leave_plan_block WHERE plan_id = ?').bind(planId).all()).results ?? [];
  if (blocks.some((b) => b.status === 'planned')) return false;
  const plan = await ctx.db.prepare(
    `SELECT p.*, r.year, s.name FROM leave_plan p JOIN leave_plan_round r ON r.id = p.round_id
       JOIN att_staff s ON s.id = p.staff_id WHERE p.id = ?`,
  ).bind(planId).first();
  if (!plan || plan.status === 'reviewed') return false;

  await ctx.db.prepare(
    "UPDATE leave_plan SET status = 'reviewed', reviewed_by = ?1, reviewed_at = datetime('now') WHERE id = ?2",
  ).bind(actorOf(ctx), planId).run();

  const sum = (s) => blocks.filter((b) => b.status === s).reduce((n, b) => n + (Number(b.days) || 0), 0);
  const approved = sum('approved');
  const move = sum('move');
  const declined = sum('declined');
  const contact = (await contactsFor(ctx.db, [plan.staff_id])).get(plan.staff_id);
  if (contact?.user_id || contact?.login_email || contact?.personal_email) {
    const title = move || declined
      ? `Your ${plan.year} leave plan: ${approved} days approved, ${move + declined} to look at`
      : `Your ${plan.year} leave plan is approved`;
    const said = blocks.find((b) => b.status === 'move' && b.note)?.note;
    await createNotice(ctx.db, {
      kind: 'leave.plan_reviewed',
      level: move || declined ? 'warn' : 'good',
      title,
      body: `${approved} days approved and on the rota.`
        + (move ? ` ${move} days to move.` : '')
        + (declined ? ` ${declined} days not approved.` : ''),
      link: '#/my-leave-plan',
      actor: actorOf(ctx),
      userId: contact.user_id ?? null,
      emailTo: contact.user_id ? null : (contact.personal_email || null),
      push: true, email: true, cc: false, text: false,
      mail: {
        status: move || declined ? 'Reviewed' : 'Approved',
        tone: move || declined ? 'warn' : 'good',
        eyebrow: 'Leave',
        subject: title,
        preheader: `${approved} days approved.`,
        headline: `Your ${plan.year} leave plan, reviewed`,
        sub: `Reviewed by ${ctx.session.user.name}`,
        facts: [
          ['Approved', `${approved} days`, { strong: true }],
          move ? ['To move', `${move} days`, { tone: 'warn' }] : null,
          declined ? ['Not approved', `${declined} days`, { tone: 'warn' }] : null,
        ].filter(Boolean),
        quote: said ? { by: `${firstName(ctx.session.user.name)} says`, text: said } : null,
        note: 'Approved days are on the rota now and taken off your balance.'
          + (move ? ' Open your plan in HIVE to take the dates suggested, or choose others.' : ''),
        button: 'Open my plan',
        why: 'You get this because you sent a leave plan.',
      },
    }, ctx);
  }
  return true;
}

/** Remind everybody whose plan is not in, now. */
export async function chase(ctx) {
  const body = await readJson(ctx.request);
  const round = await roundForYear(ctx.db, int(body.year, 'Year', { required: true, min: 2000, max: 2100 }));
  if (!round || round.status !== 'open') throw badRequest('That planning round is not open.');
  const now = await today(ctx.db);
  const people = await eligiblePeople(ctx.db, round);
  const sent = await ctx.db.prepare("SELECT staff_id FROM leave_plan WHERE round_id = ?1 AND status <> 'draft'")
    .bind(round.id).all();
  const done = new Set((sent.results ?? []).map((r) => Number(r.staff_id)));
  const waiting = people.filter((p) => !done.has(Number(p.id)));
  const contacts = await contactsFor(ctx.db, waiting.map((p) => p.id));
  let reminded = 0;
  for (const person of waiting) {
    await ctx.db.prepare('INSERT OR IGNORE INTO leave_plan (round_id, staff_id) VALUES (?1, ?2)').bind(round.id, person.id).run();
    if (!await askForPlan(ctx.db, {
      round, person, contact: contacts.get(person.id), reminder: true, chased: actorOf(ctx),
    }, ctx)) continue;
    reminded += 1;
    await ctx.db.prepare('UPDATE leave_plan SET reminded_on = ?1 WHERE round_id = ?2 AND staff_id = ?3')
      .bind(now, round.id, person.id).run();
  }
  await audit(ctx, 'leave.plan_chase', round.year, { reminded });
  return json({ ok: true, reminded, waiting: waiting.length });
}
