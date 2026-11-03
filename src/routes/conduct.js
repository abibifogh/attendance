import { badRequest, forbidden, int, json, notFound, readJson, str } from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { isAdmin } from '../lib/payroll-access.js';
import { tillMonthFor } from '../lib/advances.js';
import { isDay, isMonth, monthOf, todayIn } from '../util/dates.js';
import { sayDate } from '../lib/email-design.js';

/**
 * Bonus deductions for breaking a house rule.
 *
 * A fixed amount per rule, set by an admin, levied by an admin with one
 * press. It comes off the month's bonus, or salary where there is no bonus
 * to take it from (see splitConduct in the payroll). The person is told at
 * once and can reply; an admin can drop it until that payroll closes.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;
const needAdmin = (ctx) => { if (!isAdmin(ctx.session)) throw forbidden('Only an administrator levies or changes bonus deductions.'); };
const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(actorOf(ctx), action, String(entity ?? ''), JSON.stringify(detail ?? {})).run().catch(() => {});

async function settingsOf(db) {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('timezone', 'currency', 'conduct_notify')").all()
    .catch(() => ({ results: [] }));
  const m = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  return { timezone: m.timezone || 'UTC', currency: m.currency || 'GHS', notify: m.conduct_notify !== '0' };
}

async function closedMonths(db) {
  const rows = await db.prepare(
    "SELECT substr(month, 1, 7) AS month, COALESCE(company_id, 1) AS company FROM pay_run WHERE status = 'final'",
  ).all().catch(() => ({ results: [] }));
  return new Set((rows.results ?? []).map((r) => `${r.month}|${r.company}`));
}

const ruleOut = (r) => ({
  id: r.id, name: r.name, note: r.note ?? null, amount: Number(r.amount) || 0,
  doubleRepeat: Boolean(Number(r.double_repeat)), active: Boolean(Number(r.active)),
});

async function rulesOf(db) {
  const rows = await db.prepare('SELECT * FROM conduct_rule ORDER BY sort_order, id').all().catch(() => ({ results: [] }));
  return (rows.results ?? []).map(ruleOut);
}

const levyOut = (r, closed) => ({
  id: r.id,
  staff: { id: r.staff_id, name: r.name ?? 'Somebody', department: r.department ?? null },
  rule: r.rule_name, ruleId: r.rule_id, amount: Number(r.amount) || 0, doubled: Boolean(Number(r.doubled)),
  currency: r.currency || 'GHS', note: r.note ?? null, day: r.day, month: r.month, status: r.status,
  leviedBy: r.levied_by, leviedAt: r.levied_at,
  dropped: r.status === 'dropped' ? { by: r.dropped_by, at: r.dropped_at, reason: r.drop_reason } : null,
  reply: r.reply ? { text: r.reply, at: r.reply_at } : null,
  closed: closed.has(`${r.month}|${Number(r.company_id) || 1}`),
});

/** GET /api/conduct?month= */
export async function conductOverview(ctx) {
  const { timezone, currency } = await settingsOf(ctx.db);
  const today = todayIn(timezone);
  const asked = new URL(ctx.request.url).searchParams.get('month');
  const month = isMonth(asked) ? asked : monthOf(today);
  const rows = ((await ctx.db.prepare(
    `SELECT c.*, s.name, s.department, s.company_id FROM conduct_levy c JOIN att_staff s ON s.id = c.staff_id
      WHERE c.month = ?1 ORDER BY c.day DESC, c.id DESC`,
  ).bind(month).all().catch(() => ({ results: [] }))).results ?? []);
  const closed = await closedMonths(ctx.db);
  const levies = rows.map((r) => levyOut(r, closed));
  const active = levies.filter((l) => l.status === 'active');
  const byRule = new Map();
  for (const l of active) {
    const b = byRule.get(l.rule) ?? { rule: l.rule, count: 0, amount: 0 };
    b.count += 1; b.amount += l.amount;
    byRule.set(l.rule, b);
  }
  const months = ((await ctx.db.prepare('SELECT DISTINCT month FROM conduct_levy ORDER BY month DESC LIMIT 24').all()
    .catch(() => ({ results: [] }))).results ?? []).map((r) => r.month);
  return json({
    month,
    months: [...new Set([month, monthOf(today), ...months])].sort().reverse(),
    currency,
    rules: await rulesOf(ctx.db),
    levies,
    totals: {
      count: active.length,
      people: new Set(active.map((l) => l.staff.id)).size,
      amount: Math.round(active.reduce((n, l) => n + l.amount, 0) * 100) / 100,
      replied: active.filter((l) => l.reply).length,
    },
    byRule: [...byRule.values()].sort((a, b) => b.amount - a.amount),
    canLevy: isAdmin(ctx.session),
    // Who a levy can be on, for the person picker. Only an admin gets it.
    people: isAdmin(ctx.session)
      ? ((await ctx.db.prepare('SELECT id, name, department FROM att_staff WHERE active = 1 ORDER BY name').all()
        .catch(() => ({ results: [] }))).results ?? [])
      : [],
    today,
  });
}

/** GET /api/conduct/staff/:id — what a levy on them would be, before it is pressed. */
export async function conductForStaff(ctx, idParam) {
  const staffId = int(idParam, 'Who', { required: true, min: 1 });
  const { timezone } = await settingsOf(ctx.db);
  const today = todayIn(timezone);
  const staff = await ctx.db.prepare('SELECT id, name, department FROM att_staff WHERE id = ?1').bind(staffId).first();
  if (!staff) throw notFound('No such member of staff.');
  const rows = ((await ctx.db.prepare(
    `SELECT rule_id, rule_name, amount, day FROM conduct_levy
      WHERE staff_id = ?1 AND status = 'active' AND substr(day, 1, 7) = ?2 ORDER BY day DESC`,
  ).bind(staffId, today.slice(0, 7)).all().catch(() => ({ results: [] }))).results ?? []);
  return json({
    staff, today,
    rules: (await rulesOf(ctx.db)).filter((r) => r.active),
    thisMonth: rows.map((r) => ({ ruleId: r.rule_id, rule: r.rule_name, amount: Number(r.amount), day: r.day })),
  });
}

/** POST /api/conduct/levy { staffId, ruleId, note, day } */
export async function levyConduct(ctx) {
  needAdmin(ctx);
  const body = await readJson(ctx.request);
  const staffId = int(body.staffId, 'Who', { required: true, min: 1 });
  const ruleId = int(body.ruleId, 'Which rule', { required: true, min: 1 });
  const note = str(body.note, 'Note', { max: 400 }) || null;
  const { timezone, currency, notify } = await settingsOf(ctx.db);
  const today = todayIn(timezone);
  const day = isDay(body.day) ? body.day : today;
  if (day > today) throw badRequest('Not a day still to come.');
  const staff = await ctx.db.prepare('SELECT id, name, active FROM att_staff WHERE id = ?1').bind(staffId).first();
  if (!staff?.active) throw notFound('No such member of staff.');
  const rule = await ctx.db.prepare('SELECT * FROM conduct_rule WHERE id = ?1').bind(ruleId).first();
  if (!rule || !Number(rule.active)) throw badRequest('That rule is not in use.');
  const before = await ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM conduct_levy
      WHERE staff_id = ?1 AND rule_id = ?2 AND status = 'active' AND substr(day, 1, 7) = ?3`,
  ).bind(staffId, ruleId, day.slice(0, 7)).first();
  const doubled = Boolean(Number(rule.double_repeat)) && Number(before?.n ?? 0) >= 1;
  const amount = Math.round(Number(rule.amount) * (doubled ? 2 : 1) * 100) / 100;
  const month = await tillMonthFor(ctx.db, day, staffId);
  const done = await ctx.db.prepare(
    `INSERT INTO conduct_levy (staff_id, rule_id, rule_name, amount, doubled, currency, note, day, month, levied_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).bind(staffId, ruleId, rule.name, amount, doubled ? 1 : 0, currency, note, day, month, ctx.session.user.name).run();
  const id = Number(done?.meta?.last_row_id) || null;
  await audit(ctx, 'conduct.levy', id, { staffId, rule: rule.name, amount, doubled, day });
  if (notify) {
    const who = await ctx.db.prepare('SELECT id FROM users WHERE staff_id = ?1 AND active = 1 ORDER BY id LIMIT 1').bind(staffId).first().catch(() => null);
    if (who?.id) {
      const month_ = new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
      await createNotice(ctx.db, {
        kind: 'conduct.levied', level: 'warn',
        title: `${currency} ${amount} off your ${month_} bonus: ${rule.name.toLowerCase()}`,
        body: `${sayDate(day)}${note ? `. “${note}”` : ''}. Where there is no bonus to take it from, it comes off salary. You can reply in My pay.`,
        link: '#/my-conduct', day, actor: ctx.session.user.name, userId: who.id, push: true, email: true, cc: false,
      }, ctx).catch((err) => console.error('conduct notice failed', err));
    }
  }
  return json({ ok: true, id, amount, doubled, month });
}

/** POST /api/conduct/levy/:id/drop { reason } */
export async function dropConduct(ctx, idParam) {
  needAdmin(ctx);
  const id = int(idParam, 'Which', { required: true, min: 1 });
  const body = await readJson(ctx.request).catch(() => ({}));
  const reason = str(body.reason, 'Why', { max: 300 }) || null;
  const row = await ctx.db.prepare(
    'SELECT c.*, s.company_id FROM conduct_levy c JOIN att_staff s ON s.id = c.staff_id WHERE c.id = ?1',
  ).bind(id).first();
  if (!row) throw notFound('No such deduction.');
  if (row.status !== 'active') throw badRequest('Already dropped.');
  if ((await closedMonths(ctx.db)).has(`${row.month}|${Number(row.company_id) || 1}`)) {
    throw badRequest('That payroll is closed, so it has already come off.');
  }
  await ctx.db.prepare(
    "UPDATE conduct_levy SET status = 'dropped', dropped_by = ?2, dropped_at = datetime('now'), drop_reason = ?3 WHERE id = ?1",
  ).bind(id, ctx.session.user.name, reason).run();
  await audit(ctx, 'conduct.drop', id, { reason });
  const { notify, currency } = await settingsOf(ctx.db);
  if (notify && body.quiet !== true) {
    const who = await ctx.db.prepare('SELECT id FROM users WHERE staff_id = ?1 AND active = 1 ORDER BY id LIMIT 1').bind(row.staff_id).first().catch(() => null);
    if (who?.id) {
      await createNotice(ctx.db, {
        kind: 'conduct.dropped', level: 'good',
        title: `Dropped: ${currency} ${Number(row.amount)} for ${row.rule_name.toLowerCase()}`,
        body: `Nothing comes off for ${sayDate(row.day)}.${reason ? ` “${reason}”` : ''}`,
        link: '#/my-conduct', actor: ctx.session.user.name, userId: who.id, push: true, email: false, cc: false,
      }, ctx).catch(() => {});
    }
  }
  return json({ ok: true });
}

/** POST /api/conduct/rules { rules: [{ id?, name, note, amount, doubleRepeat, active }], notify } */
export async function saveConductRules(ctx) {
  needAdmin(ctx);
  const body = await readJson(ctx.request);
  const list = Array.isArray(body.rules) ? body.rules : [];
  if (list.length > 40) throw badRequest('Forty rules at most.');
  for (const [i, r] of list.entries()) {
    const name = str(r.name, 'What', { max: 80 });
    if (!name) continue;
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) throw badRequest(`An amount for “${name}”, between 1 and 10,000.`);
    const vals = [name, str(r.note, 'Shown under it', { max: 120 }) || null, Math.round(amount * 100) / 100,
      r.doubleRepeat ? 1 : 0, r.active === false ? 0 : 1, (i + 1) * 10];
    if (r.id) {
      // eslint-disable-next-line no-await-in-loop
      await ctx.db.prepare('UPDATE conduct_rule SET name = ?2, note = ?3, amount = ?4, double_repeat = ?5, active = ?6, sort_order = ?7 WHERE id = ?1')
        .bind(Number(r.id), ...vals).run();
    } else {
      // eslint-disable-next-line no-await-in-loop
      await ctx.db.prepare('INSERT INTO conduct_rule (name, note, amount, double_repeat, active, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(...vals).run();
    }
  }
  if (body.notify != null) {
    await ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('conduct_notify', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(body.notify ? '1' : '0').run();
  }
  await audit(ctx, 'conduct.rules', 'rules', { count: list.length });
  return conductRules(ctx);
}

/** GET /api/conduct/rules */
export async function conductRules(ctx) {
  const { notify, currency } = await settingsOf(ctx.db);
  return json({ rules: await rulesOf(ctx.db), notify, currency, canEdit: isAdmin(ctx.session) });
}

const myStaffId = (ctx) => Number(ctx.session.user.staff_id) || 0;

/** GET /api/me/conduct */
export async function myConduct(ctx) {
  const staffId = myStaffId(ctx);
  if (!staffId) return json({ levies: [] });
  const rows = ((await ctx.db.prepare(
    `SELECT c.*, s.name, s.department, s.company_id FROM conduct_levy c JOIN att_staff s ON s.id = c.staff_id
      WHERE c.staff_id = ?1 ORDER BY c.day DESC, c.id DESC LIMIT 40`,
  ).bind(staffId).all().catch(() => ({ results: [] }))).results ?? []);
  const closed = await closedMonths(ctx.db);
  return json({ levies: rows.map((r) => levyOut(r, closed)) });
}

/** POST /api/me/conduct/reply { id, text } */
export async function replyConduct(ctx) {
  const staffId = myStaffId(ctx);
  if (!staffId) throw forbidden('This login is not linked to a member of staff.');
  const body = await readJson(ctx.request);
  const id = int(body.id, 'Which', { required: true, min: 1 });
  const text = str(body.text, 'Reply', { required: true, max: 600 });
  const row = await ctx.db.prepare('SELECT * FROM conduct_levy WHERE id = ?1 AND staff_id = ?2').bind(id, staffId).first();
  if (!row) throw notFound('No such deduction.');
  if (row.status !== 'active') throw badRequest('This one has been dropped.');
  await ctx.db.prepare("UPDATE conduct_levy SET reply = ?2, reply_at = datetime('now') WHERE id = ?1").bind(id, text).run();
  await createNotice(ctx.db, {
    kind: 'conduct.reply', level: 'info',
    title: `A reply about a bonus deduction`,
    body: `${row.rule_name}, ${sayDate(row.day)}: “${text.slice(0, 160)}”`,
    link: '#/conduct', actor: ctx.session.user.name, audience: 'hr_pay', push: true, email: false,
  }, ctx).catch(() => {});
  return json({ ok: true });
}
