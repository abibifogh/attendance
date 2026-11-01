import { badRequest, forbidden, int, json, notFound, readJson, str } from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { isAdmin } from '../lib/payroll-access.js';
import {
  REASON_KINDS, REASON_LABELS, monthName, readRule, sayMoney, syncLateCharges,
} from '../lib/late-charges.js';
import { addDays, isMonth, monthOf, todayIn } from '../util/dates.js';
import { sayDate, sayTime } from '../lib/email-design.js';

/**
 * Money › Late charges, and the person's own side of it.
 *
 * Whoever does the wages sees every charge; only an administrator keeps or
 * waives one. The person sees their own, can say why, and has the rule to
 * accept in the app (the written agreement on file; charges apply either way).
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;
const nameOf = (ctx) => ctx.session.user.name;

const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(actorOf(ctx), action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

async function timezoneOf(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first().catch(() => null);
  return row?.value || 'UTC';
}

async function closedMonths(db) {
  const rows = await db.prepare(
    "SELECT substr(month, 1, 7) AS month, COALESCE(company_id, 1) AS company FROM pay_run WHERE status = 'final'",
  ).all().catch(() => ({ results: [] }));
  return new Set((rows.results ?? []).map((r) => `${r.month}|${r.company}`));
}

function shape(row, { closed, counts }) {
  const company = Number(row.company_id) || 1;
  return {
    id: row.id,
    staff: { id: row.staff_id, name: row.name ?? 'Somebody', department: row.department ?? null },
    day: row.day,
    shift: row.shift_name ? { name: row.shift_name, from: row.starts_at, to: row.ends_at } : null,
    clockIn: row.clock_in,
    minutes: Number(row.minutes_late) || 0,
    amount: Number(row.amount) || 0,
    currency: row.currency || 'GHS',
    month: row.month,
    status: row.status,
    reason: row.reason || row.reason_kind
      ? { kind: row.reason_kind, label: REASON_LABELS[row.reason_kind] ?? null, text: row.reason ?? null, at: row.reason_at ?? null }
      : null,
    decided: row.decided_by ? { by: row.decided_by, at: row.decided_at, note: row.decision_note ?? null } : null,
    closed: closed.has(`${row.month}|${company}`),
    countThisMonth: counts?.get(`${row.staff_id}|${String(row.day).slice(0, 7)}`) ?? 1,
  };
}

/** GET /api/late-charges?month=YYYY-MM */
export async function listLateCharges(ctx) {
  const timezone = await timezoneOf(ctx.db);
  // Up to date with the record before anybody decides anything on it.
  await syncLateCharges(ctx.db, { timezone, ctx }).catch((err) => console.error('late charge sync failed', err));
  const rule = await readRule(ctx.db);
  const today = todayIn(timezone);
  const url = new URL(ctx.request.url);
  const asked = url.searchParams.get('month');
  const months = ((await ctx.db.prepare(
    "SELECT DISTINCT month FROM late_charge WHERE status <> 'void' ORDER BY month DESC LIMIT 24",
  ).all().catch(() => ({ results: [] }))).results ?? []).map((r) => r.month);
  // The oldest month still holding charges nobody has looked at, so nothing
  // waits unseen behind the current one; else this month.
  const shut = await closedMonths(ctx.db);
  const waiting = ((await ctx.db.prepare(
    `SELECT DISTINCT c.month, COALESCE(s.company_id, 1) AS company
       FROM late_charge c JOIN att_staff s ON s.id = c.staff_id
      WHERE c.status = 'open' ORDER BY c.month`,
  ).all().catch(() => ({ results: [] }))).results ?? []).find((r) => !shut.has(`${r.month}|${r.company}`));
  const month = isMonth(asked) ? asked : (waiting?.month || monthOf(today));

  const rows = ((await ctx.db.prepare(
    `SELECT c.*, s.name, s.department, s.company_id
       FROM late_charge c JOIN att_staff s ON s.id = c.staff_id
      WHERE c.month = ?1 AND c.status <> 'void'
      ORDER BY c.day DESC, s.name`,
  ).bind(month).all().catch(() => ({ results: [] }))).results ?? []);
  const counts = new Map();
  for (const r of rows) {
    const k = `${r.staff_id}|${String(r.day).slice(0, 7)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const closed = await closedMonths(ctx.db);
  const charges = rows.map((r) => shape(r, { closed, counts }));
  const sum = (list) => Math.round(list.reduce((n, c) => n + c.amount, 0) * 100) / 100;
  const of = (s) => charges.filter((c) => c.status === s);
  return json({
    rule,
    month,
    monthName: monthName(month),
    months: [...new Set([month, ...months])].sort().reverse(),
    charges,
    totals: {
      count: charges.length,
      open: of('open').length,
      kept: of('kept').length,
      waived: of('waived').length,
      taken: sum([...of('open'), ...of('kept')]),
      waivedAmount: sum(of('waived')),
    },
    canDecide: isAdmin(ctx.session),
  });
}

/** POST /api/late-charges/decide { ids, action: keep|waive|reopen, note } */
export async function decideLateCharges(ctx) {
  if (!isAdmin(ctx.session)) throw forbidden('Only an administrator keeps or waives a late charge.');
  const body = await readJson(ctx.request);
  const action = ['keep', 'waive', 'reopen'].includes(body.action) ? body.action : null;
  if (!action) throw badRequest('Keep it, waive it, or look again?');
  const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map((x) => Number(x)).filter((x) => x > 0);
  if (!ids.length) throw badRequest('Which charge?');
  if (ids.length > 300) throw badRequest('Three hundred at a time at most.');
  const note = str(body.note, 'Reason', { max: 500 });
  if (action === 'waive' && !note) throw badRequest('Say why it is waived. They are told your reason.');

  const rule = await readRule(ctx.db);
  const closed = await closedMonths(ctx.db);
  const status = { keep: 'kept', waive: 'waived', reopen: 'open' }[action];
  let changed = 0;
  const skipped = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const row = await ctx.db.prepare(
      `SELECT c.*, s.company_id, s.name FROM late_charge c JOIN att_staff s ON s.id = c.staff_id WHERE c.id = ?1`,
    ).bind(id).first();
    if (!row) { skipped.push({ id, why: 'not found' }); continue; }
    if (row.status === 'void') { skipped.push({ id, why: 'no longer late' }); continue; }
    if (closed.has(`${row.month}|${Number(row.company_id) || 1}`)) {
      skipped.push({ id, why: `the ${monthName(row.month)} payroll is closed` });
      continue;
    }
    if (row.status === status) continue;
    // eslint-disable-next-line no-await-in-loop
    await ctx.db.prepare(
      `UPDATE late_charge
          SET status = ?2, decided_by = ?3, decided_at = datetime('now'), decision_note = ?4, updated_at = datetime('now')
        WHERE id = ?1`,
    ).bind(id, status, action === 'reopen' ? null : nameOf(ctx), action === 'reopen' ? null : note).run();
    changed += 1;
    // eslint-disable-next-line no-await-in-loop
    await audit(ctx, `late_charge.${action}`, id, { staffId: row.staff_id, day: row.day, note });
    if (action !== 'reopen') {
      // eslint-disable-next-line no-await-in-loop
      await tellDecided(ctx, rule, row, status, note).catch((err) => console.error('late charge decision notice failed', err));
    }
  }
  if (!changed && skipped.length) throw badRequest(`Not changed: ${skipped[0].why}.`);
  return json({ ok: true, changed, skipped });
}

async function tellDecided(ctx, rule, row, status, note) {
  const who = await ctx.db.prepare('SELECT id FROM users WHERE staff_id = ?1 AND active = 1 ORDER BY id LIMIT 1')
    .bind(row.staff_id).first().catch(() => null);
  if (!who?.id) return;
  const money = sayMoney(rule, row.amount);
  const day = sayDate(row.day);
  const waived = status === 'waived';
  await createNotice(ctx.db, {
    kind: 'attendance.late_charge_decided',
    level: waived ? 'good' : 'info',
    title: waived ? `Waived: your late charge for ${day}` : `Kept: your ${money} late charge for ${day}`,
    body: waived
      ? `Nothing comes off your pay for clocking in at ${sayTime(row.clock_in)}.${note ? ` “${note}”` : ''} ${nameOf(ctx)}`
      : `${money} comes off your ${monthName(row.month)} pay for clocking in at ${sayTime(row.clock_in)}.${note ? ` “${note}”` : ''}`,
    link: '#/att-me',
    day: row.day,
    actor: nameOf(ctx),
    userId: who.id,
    push: true,
    email: false,
    cc: false,
  }, ctx);
}

/** GET /api/late-charges/rule */
export async function lateRuleGet(ctx) {
  const rule = await readRule(ctx.db);
  const people = await ctx.db.prepare(
    'SELECT id, name, department, late_charge_exempt, late_rule_accepted_at FROM att_staff WHERE active = 1 ORDER BY name',
  ).all().catch(() => ({ results: [] }));
  const everybody = (people.results ?? []).map((p) => ({
    id: p.id, name: p.name, department: p.department ?? null,
    exempt: Boolean(Number(p.late_charge_exempt)), accepted: p.late_rule_accepted_at ?? null,
  }));
  const exempt = { results: everybody.filter((p) => p.exempt) };
  const accepted = await ctx.db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN late_rule_accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS yes
       FROM att_staff WHERE active = 1`,
  ).first().catch(() => null);
  return json({
    rule,
    exempt: exempt.results ?? [],
    people: everybody,
    accepted: { yes: Number(accepted?.yes ?? 0), total: Number(accepted?.total ?? 0) },
    canEdit: isAdmin(ctx.session),
  });
}

/** POST /api/late-charges/rule { on, amount, minutes, notify, from } */
export async function lateRuleSave(ctx) {
  if (!isAdmin(ctx.session)) throw forbidden('Only an administrator changes the late charge.');
  const body = await readJson(ctx.request);
  const set = [];
  if (body.on != null) set.push(['late_charge_on', body.on ? '1' : '0']);
  if (body.notify != null) set.push(['late_charge_notify', body.notify ? '1' : '0']);
  if (body.amount != null) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) throw badRequest('The amount is between 1 and 1,000.');
    set.push(['late_charge_amount', String(Math.round(amount * 100) / 100)]);
  }
  if (body.minutes != null) {
    const minutes = int(body.minutes, 'Minutes', { min: 1, max: 240 });
    set.push(['late_charge_minutes', String(minutes)]);
  }
  if (body.from != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.from))) throw badRequest('From which day?');
    set.push(['late_charge_from', String(body.from)]);
  }
  for (const [key, value] of set) {
    // eslint-disable-next-line no-await-in-loop
    await ctx.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).bind(key, value).run();
  }
  await audit(ctx, 'late_charge.rule', 'settings', Object.fromEntries(set));
  return lateRuleGet(ctx);
}

/** POST /api/late-charges/exempt { staffId, exempt } */
export async function lateExempt(ctx) {
  if (!isAdmin(ctx.session)) throw forbidden('Only an administrator decides who the late charge does not apply to.');
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Who', { required: true, min: 1 });
  const done = await ctx.db.prepare('UPDATE att_staff SET late_charge_exempt = ?2 WHERE id = ?1')
    .bind(staffId, body.exempt ? 1 : 0).run();
  if (!Number(done?.meta?.changes ?? 0)) throw notFound('No such member of staff.');
  await audit(ctx, 'late_charge.exempt', staffId, { exempt: Boolean(body.exempt) });
  return lateRuleGet(ctx);
}

const myStaffId = (ctx) => Number(ctx.session.user.staff_id) || 0;

/** GET /api/me/late-charges */
export async function myLateCharges(ctx) {
  const staffId = myStaffId(ctx);
  if (!staffId) return json({ rule: await readRule(ctx.db), charges: [], accepted: null, applies: false });
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  await syncLateCharges(ctx.db, { timezone, ctx, staffId, days: [addDays(today, -1), today] })
    .catch((err) => console.error('late charge sync failed', err));
  const rule = await readRule(ctx.db);
  const me = await ctx.db.prepare('SELECT late_charge_exempt, late_rule_accepted_at FROM att_staff WHERE id = ?1')
    .bind(staffId).first().catch(() => null);
  const rows = ((await ctx.db.prepare(
    `SELECT c.*, s.name, s.department, s.company_id
       FROM late_charge c JOIN att_staff s ON s.id = c.staff_id
      WHERE c.staff_id = ?1 AND c.status <> 'void' AND c.day >= ?2
      ORDER BY c.day DESC`,
  ).bind(staffId, addDays(today, -92)).all().catch(() => ({ results: [] }))).results ?? []);
  const closed = await closedMonths(ctx.db);
  return json({
    rule,
    applies: rule.on && !Number(me?.late_charge_exempt),
    accepted: me?.late_rule_accepted_at ?? null,
    charges: rows.map((r) => shape(r, { closed })),
    reasonKinds: REASON_KINDS.map((k) => ({ kind: k, label: REASON_LABELS[k] })),
  });
}

/** POST /api/me/late-charges/reason { id, kind, text } */
export async function myLateReason(ctx) {
  const staffId = myStaffId(ctx);
  if (!staffId) throw forbidden('This login is not linked to a member of staff.');
  const body = await readJson(ctx.request);
  const id = int(body.id, 'Which charge', { required: true, min: 1 });
  const kind = REASON_KINDS.includes(body.kind) ? body.kind : 'other';
  const text = str(body.text, 'Reason', { max: 500 });
  if (!text && kind === 'other') throw badRequest('Say what happened.');
  const row = await ctx.db.prepare('SELECT * FROM late_charge WHERE id = ?1 AND staff_id = ?2').bind(id, staffId).first();
  if (!row) throw notFound('No such late charge.');
  if (!['open', 'kept'].includes(row.status)) throw badRequest('This one is already settled.');
  await ctx.db.prepare(
    `UPDATE late_charge SET reason_kind = ?2, reason = ?3, reason_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1`,
  ).bind(id, kind, text || null).run();
  return json({ ok: true });
}

/** POST /api/me/late-rule/accept */
export async function acceptLateRule(ctx) {
  const staffId = myStaffId(ctx);
  if (!staffId) throw forbidden('This login is not linked to a member of staff.');
  await ctx.db.prepare(
    "UPDATE att_staff SET late_rule_accepted_at = COALESCE(late_rule_accepted_at, datetime('now')) WHERE id = ?1",
  ).bind(staffId).run();
  const row = await ctx.db.prepare('SELECT late_rule_accepted_at FROM att_staff WHERE id = ?1').bind(staffId).first();
  await audit(ctx, 'late_charge.accepted', staffId, {});
  return json({ ok: true, accepted: row?.late_rule_accepted_at ?? null });
}
