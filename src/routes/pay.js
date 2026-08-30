import { badRequest, json, notFound, readJson, str } from '../lib/http.js';
import { loadDataset } from '../lib/attendance.js';
import { PAY_BASES, costFor, rateOn } from '../lib/pay.js';
import { assessPerson, limitsFrom, shiftsInWindow } from '../lib/workload.js';
import { addDays, diffDays, isDay, todayIn } from '../util/dates.js';

/**
 * Pay rates, and the rota read in money.
 *
 * Everything here is behind `hr_pay`, which nobody holds by default. The route
 * table is the gate; this file assumes whoever reached it was allowed to.
 */

async function timezoneOf(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first().catch(() => null);
  return row?.value || 'UTC';
}

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(actorOf(ctx), action, entity == null ? null : String(entity),
    detail ? JSON.stringify(detail) : null).run().catch(() => {});
}

/** Every rate somebody has ever been on, newest first. */
export async function staffPay(ctx, id) {
  const staffId = Number(id);
  const staff = await ctx.db.prepare('SELECT id, name FROM att_staff WHERE id = ?')
    .bind(staffId).first();
  if (!staff) throw notFound('No such member of staff.');

  const rows = await ctx.db.prepare(
    'SELECT * FROM hr_pay WHERE staff_id = ? ORDER BY from_day DESC',
  ).bind(staffId).all().catch(() => ({ results: [] }));

  const settings = await ctx.db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('currency')",
  ).all().catch(() => ({ results: [] }));

  return json({
    staff,
    rates: rows.results ?? [],
    currency: (settings.results ?? []).find((r) => r.key === 'currency')?.value || 'GHS',
  });
}

/**
 * Put somebody on a rate from a given day.
 *
 * Re-entering the same start date replaces it — that is a correction. A new
 * start date is a rise, and everything before it keeps costing what it cost.
 */
export async function setPay(ctx, id) {
  const staffId = Number(id);
  const body = await readJson(ctx.request);

  const staff = await ctx.db.prepare('SELECT id, name FROM att_staff WHERE id = ?')
    .bind(staffId).first();
  if (!staff) throw notFound('No such member of staff.');

  const basis = str(body.basis, 'Basis', { required: true, max: 10 });
  if (!PAY_BASES.includes(basis)) {
    throw badRequest('Pay is monthly, daily or hourly.');
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw badRequest('That is not an amount somebody could be paid.');
  }
  if (amount > 10_000_000) throw badRequest('That is more than this app will believe.');

  const fromDay = String(body.fromDay ?? '');
  if (!isDay(fromDay)) throw badRequest('Say which day this rate starts.');

  const timezone = await timezoneOf(ctx.db);
  const currency = str(body.currency, 'Currency', { max: 8, fallback: null })
    || (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'currency'")
      .first().catch(() => null))?.value || 'GHS';

  await ctx.db.prepare(
    `INSERT INTO hr_pay (staff_id, basis, amount, currency, from_day, note, set_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (staff_id, from_day) DO UPDATE SET
       basis = excluded.basis, amount = excluded.amount, currency = excluded.currency,
       note = excluded.note, set_by = excluded.set_by, set_at = datetime('now')`,
  ).bind(staffId, basis, amount, currency, fromDay,
    str(body.note, 'Note', { max: 300 }), actorOf(ctx)).run();

  // Deliberately not logging the amount. The audit trail is read by more
  // people than the pay screen is, and "who changed it and when" is what it
  // exists to answer.
  await audit(ctx, 'pay.set', staffId, { basis, fromDay, today: todayIn(timezone) });
  return staffPay(ctx, staffId);
}

/** Take a rate off the record — for one entered against the wrong person. */
export async function removePay(ctx, id, rateId) {
  const staffId = Number(id);
  await ctx.db.prepare('DELETE FROM hr_pay WHERE id = ? AND staff_id = ?')
    .bind(Number(rateId), staffId).run();
  await audit(ctx, 'pay.remove', staffId, { rate: Number(rateId) });
  return staffPay(ctx, staffId);
}

/**
 * What a period costs, per person and per department.
 *
 * Costed against the plan, like the workload reading it sits beside, because
 * the question is what next fortnight will cost while there is still time to
 * change it.
 */
export async function labourCost(ctx) {
  const timezone = await timezoneOf(ctx.db);
  const today = todayIn(timezone);
  const from = isDay(ctx.url.searchParams.get('from')) ? ctx.url.searchParams.get('from') : today;
  const to = isDay(ctx.url.searchParams.get('to')) ? ctx.url.searchParams.get('to') : addDays(from, 13);
  return json(await costingFor(ctx, from, to));
}

/**
 * The same reading, as a value rather than a response.
 *
 * The analytics screen needs this window and the one before it, and a route
 * that can only answer over HTTP would mean asking the app to fetch from
 * itself. Everything of substance lives here; labourCost is the address it
 * answers on.
 */
export async function costingFor(ctx, from, to) {
  const span = diffDays(from, to) + 1;

  const [ds, payRows, profiles, allowances, rateRow] = await Promise.all([
    loadDataset(ctx.db, { from: addDays(from, -1), to: addDays(to, 1) }),
    ctx.db.prepare('SELECT * FROM hr_pay ORDER BY from_day').all().catch(() => ({ results: [] })),
    // The payroll's own figures. This report used to read hr_pay and nothing
    // else, which is a table only this report writes to — so a property that
    // set everybody up under Payroll had every single person come back as
    // having no rate, and the card said nothing at all.
    ctx.db.prepare('SELECT * FROM pay_profile').all().catch(() => ({ results: [] })),
    ctx.db.prepare('SELECT * FROM pay_allowance WHERE active = 1').all()
      .catch(() => ({ results: [] })),
    ctx.db.prepare("SELECT * FROM pay_rates WHERE id = 1").first().catch(() => null),
  ]);

  const payBy = new Map();
  for (const row of payRows.results ?? []) {
    if (!payBy.has(row.staff_id)) payBy.set(row.staff_id, []);
    payBy.get(row.staff_id).push(row);
  }

  // What somebody costs a month according to the payroll: their basic, their
  // standing allowances, and the property's own pension contribution on the
  // basic. That last part is a real cost and it is not in anybody's pay, so a
  // wage bill that leaves it out understates by an eighth.
  const employerSsnit = Number(rateRow?.ssnit_employer ?? ds.settings.pay_ssnit_employer) || 0.13;
  const allowanceBy = new Map();
  for (const row of allowances.results ?? []) {
    allowanceBy.set(row.staff_id, (allowanceBy.get(row.staff_id) ?? 0) + (Number(row.amount) || 0));
  }
  const fromPayroll = new Map();
  for (const profile of profiles.results ?? []) {
    const basic = Number(profile.basic) || 0;
    const monthly = basic + (allowanceBy.get(profile.staff_id) ?? 0)
      + (profile.ssnit ? basic * employerSsnit : 0);
    if (monthly <= 0) continue;
    fromPayroll.set(profile.staff_id, [{
      basis: 'monthly',
      amount: Math.round(monthly * 100) / 100,
      currency: ds.settings.currency || 'GHS',
      // What somebody is on now, applied across the window. A dated rate says
      // what they were on at the time and is used ahead of this wherever there
      // is one; the payroll only ever holds the current figure. The response
      // says which each row came from rather than leaving it to be assumed.
      from_day: '1970-01-01',
    }]);
  }

  const limits = limitsFrom(ds.settings);
  const currency = ds.settings.currency || 'GHS';
  const overtimeMultiplier = Number(ds.settings.pay_overtime_multiplier) || 1.5;
  const holidayMultiplier = Number(ds.settings.pay_holiday_multiplier) || 2;

  const rows = [];
  const missing = [];

  for (const staff of ds.staff) {
    if (!staff.active) continue;

    const worked = shiftsInWindow(ds, staff.id, from, to)
      .filter((w) => !w.leave && w.shift && w.day >= from && w.day <= to);

    const person = assessPerson(ds, staff, from, to, limits);
    const hours = worked.reduce((n, w) => n + w.hours, 0);

    // Hours past the weekly limit, week by week, which is what a premium is
    // actually owed on.
    const overtimeHours = person.weeks.reduce(
      (n, w) => n + Math.max(0, w.hours - limits.weeklyHours.value), 0,
    );
    const holidayHours = worked.filter((w) => w.holiday).reduce((n, w) => n + w.hours, 0);

    const dated = payBy.get(staff.id) ?? [];
    const hasDated = Boolean(rateOn(dated, from) || rateOn(dated, to));
    const rates = hasDated ? dated : (fromPayroll.get(staff.id) ?? []);
    if (!rates.length) {
      missing.push({ id: staff.id, name: staff.name, department: staff.department ?? null });
      continue;
    }

    const hoursPerDay = worked.length ? hours / worked.length : 8;
    const cost = costFor({
      rates,
      days: worked,
      overtimeHours,
      holidayHours,
      daysPerWeek: Number(staff.days_per_week) || Number(ds.settings.att_days_per_week) || 5,
      hoursPerDay,
      span,
      overtimeMultiplier,
      holidayMultiplier,
    });

    rows.push({
      staff: {
        id: staff.id, name: staff.name, department: staff.department ?? null,
      },
      // Where the figure came from. A dated rate is what they were on at the
      // time; the payroll is what they are on now.
      source: hasDated ? 'rate' : 'payroll',
      days: worked.length,
      hours: Math.round(hours * 10) / 10,
      overtimeHours: Math.round(overtimeHours * 10) / 10,
      holidayHours: Math.round(holidayHours * 10) / 10,
      cost,
    });
  }

  rows.sort((a, b) => (b.cost?.total ?? 0) - (a.cost?.total ?? 0));

  const departments = new Map();
  for (const row of rows) {
    const key = row.staff.department || 'No department';
    if (!departments.has(key)) {
      departments.set(key, { department: key, people: 0, hours: 0, fixed: 0, variable: 0, premium: 0, total: 0 });
    }
    const d = departments.get(key);
    d.people += 1;
    d.hours += row.hours;
    d.fixed += row.cost.fixed;
    d.variable += row.cost.variable;
    d.premium += row.cost.premium;
    d.total += row.cost.total;
  }

  const round = (n) => Math.round(n * 100) / 100;
  const totals = rows.reduce((acc, r) => ({
    fixed: acc.fixed + r.cost.fixed,
    variable: acc.variable + r.cost.variable,
    premium: acc.premium + r.cost.premium,
    total: acc.total + r.cost.total,
    hours: acc.hours + r.hours,
  }), { fixed: 0, variable: 0, premium: 0, total: 0, hours: 0 });

  return {
    from,
    to,
    span,
    currency,
    rows,
    // Named rather than counted. "Three people have no rate" sends somebody
    // hunting; the names send them straight there, and until every name is
    // gone the total below is an understatement rather than an answer.
    missing,
    // How many of the figures above are today's payroll rather than a rate
    // dated to the period. Said rather than left to be assumed: over a window
    // in the past the two are not the same thing.
    fromPayroll: rows.filter((r) => r.source === 'payroll').length,
    departments: [...departments.values()]
      .map((d) => ({
        ...d,
        hours: round(d.hours),
        fixed: round(d.fixed),
        variable: round(d.variable),
        premium: round(d.premium),
        total: round(d.total),
      }))
      .sort((a, b) => b.total - a.total),
    totals: {
      fixed: round(totals.fixed),
      variable: round(totals.variable),
      premium: round(totals.premium),
      total: round(totals.total),
      hours: round(totals.hours),
      perHour: totals.hours ? round(totals.total / totals.hours) : 0,
    },
    rates: { overtimeMultiplier, holidayMultiplier },
  };
}
