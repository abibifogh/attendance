import { all, first, groupConfig } from '../lib/db.js';
import { loadFacts, totals } from '../insight/facts.js';
import { analyse, sourceHealth } from '../insight/engine.js';
import { resolveRange, addDays, todayIn } from '../lib/dates.js';
import { pct, ratio, change } from '../lib/money.js';
import { bare, dayName } from '../insight/labels.js';
import { median, sum, groupBy, halves } from '../insight/stats.js';

/**
 * The screens.
 *
 * Every panel answers with the same three things: the numbers, the window they
 * cover, and which source systems stood behind them. The third is not
 * decoration. A margin computed while the POS was unreachable is a different
 * number from the same margin computed with it, and a dashboard that does not
 * say which one you are looking at will eventually be believed at the wrong
 * moment.
 */

async function context(env, query, defaultDays = 30) {
  const db = env.DB;
  const config = await groupConfig(db);
  const range = resolveRange(query, config.timezone, { days: defaultDays });
  return { db, config, ...range };
}

/** What the app needs before it can draw anything. */
export async function bootstrap(env) {
  const db = env.DB;
  const config = await groupConfig(db);
  const lastRun = await first(db, 'SELECT * FROM etl_run ORDER BY id DESC LIMIT 1');
  const sources = await sourceHealth(db);
  const span = await first(db, 'SELECT MIN(day) AS first_day, MAX(day) AS last_day FROM dim_day');
  const lines = await all(db, 'SELECT * FROM dim_line ORDER BY sort_order');

  return {
    group: {
      name: config.groupName,
      timezone: config.timezone,
      currency: { code: config.currencyCode, symbol: config.currencySymbol },
      today: todayIn(config.timezone),
    },
    demoMode: config.demoMode,
    assumptions: {
      defaultHourCost: config.defaultHourCost,
      labourTargetPct: config.labourTargetPct,
    },
    lines: lines.map((l) => ({ id: l.id, label: l.label, revenueLine: l.revenue_line === 1 })),
    sources,
    data: { firstDay: span?.first_day || null, lastDay: span?.last_day || null },
    lastRun: lastRun ? {
      id: lastRun.id, status: lastRun.status, from: lastRun.from_day, to: lastRun.to_day,
      startedAt: lastRun.started_at, finishedAt: lastRun.finished_at, rows: lastRun.rows_written,
      detail: lastRun.detail,
    } : null,
  };
}

/**
 * The brief: what somebody should know before they do anything else today.
 *
 * Deliberately short. The value of a morning screen is inversely proportional
 * to how much is on it — a page with forty tiles gets skimmed and then stops
 * being opened. So: five numbers, how each has moved, and the findings worth
 * the most money.
 */
export async function brief(env, query) {
  const { db, config, from, to } = await context(env, query, 30);
  const facts = await loadFacts(db, from, to);
  const now = totals(facts);

  // The same length of window, immediately before this one. Comparing a month
  // against the month before is the only comparison most people make, and
  // making it here means nobody has to do it in their head.
  const priorTo = addDays(from, -1);
  const priorFrom = addDays(priorTo, -(facts.dayList.length - 1));
  const before = totals(await loadFacts(db, priorFrom, priorTo));

  const { findings, errors } = await analyse(db, { from, to, persist: true });
  const open = await all(db, `
    SELECT * FROM findings WHERE state IN ('open','acknowledged')
     ORDER BY impact_monthly DESC, severity LIMIT 6`);

  const metric = (label, value, previous, unit, note) => ({
    label, value, previous, unit, changePct: change(previous, value), note,
  });

  return {
    range: { from, to, days: facts.dayList.length },
    comparison: { from: priorFrom, to: priorTo },
    demoMode: config.demoMode,
    headline: [
      metric('Revenue recorded', now.net, before.net, 'money',
        'Everything the four systems saw. No room revenue: nothing here records it.'),
      metric('Contribution', now.contribution, before.contribution, 'money',
        'Revenue less purchases and wages. Not profit — no rent, power or depreciation is in any of these systems.'),
      metric('Wage bill', now.labourCost, before.labourCost, 'money',
        `Hours actually worked, priced at ${config.defaultHourCost / 100} per hour where a person has no rate of their own.`),
      metric('Guest nights', now.guestNights, before.guestNights, 'count',
        'From the breakfast app, the only daily occupancy figure the group keeps.'),
      metric('Revenue per hour worked', now.revenuePerHour, before.revenuePerHour, 'money',
        'The one number that moves when either side of the business changes.'),
      metric('Revenue per guest night', now.revenuePerGuest, before.revenuePerGuest, 'money',
        'What the average guest spends beyond their room.'),
    ],
    money: {
      collected: now.collected, outstanding: now.outstanding,
      cash: now.cash, card: now.card, other: now.other,
    },
    findings: open.map(shapeFinding),
    findingsTotal: findings.reduce((n, f) => n + f.impactMonthly, 0),
    ruleErrors: errors,
    sources: await sourceHealth(db),
  };
}

/** Contribution by line, and the daily series behind it. */
export async function pnl(env, query) {
  const { db, config, from, to } = await context(env, query, 30);
  const facts = await loadFacts(db, from, to);
  const byLine = groupBy(facts.lineRows, (r) => r.line);
  const lines = await all(db, 'SELECT * FROM dim_line ORDER BY sort_order');
  const meta = new Map(lines.map((l) => [l.id, l]));

  const rows = [...byLine.entries()].map(([line, lineRows]) => {
    const net = sum(lineRows.map((r) => r.net));
    const cost = sum(lineRows.map((r) => r.cost));
    const labour = sum(lineRows.map((r) => r.labourCost));
    const hours = sum(lineRows.map((r) => r.workedMinutes)) / 60;
    return {
      line,
      label: meta.get(line)?.label || bare(line),
      revenueLine: meta.get(line)?.revenue_line === 1,
      net, cost, labour,
      contribution: net - cost - labour,
      marginPct: pct(net - cost - labour, net),
      labourPct: pct(labour, net),
      costPct: pct(cost, net),
      hours: Math.round(hours * 10) / 10,
      revenuePerHour: hours > 0 ? Math.round(net / hours) : null,
      orders: sum(lineRows.map((r) => r.orders)),
      covers: sum(lineRows.map((r) => r.covers)),
    };
  }).sort((a, b) => (meta.get(a.line)?.sort_order ?? 99) - (meta.get(b.line)?.sort_order ?? 99));

  const daily = facts.dayList.map((day) => {
    const dayRows = facts.forDay(day);
    return {
      day,
      dow: facts.byDay.get(day)?.dow_label,
      isHoliday: facts.byDay.get(day)?.is_holiday === 1,
      net: sum(dayRows.map((r) => r.net)),
      cost: sum(dayRows.map((r) => r.cost)),
      labour: sum(dayRows.map((r) => r.labourCost)),
      contribution: sum(dayRows.map((r) => r.contribution)),
      guests: facts.guestsOn(day),
    };
  });

  return {
    range: { from, to, days: facts.dayList.length },
    demoMode: config.demoMode,
    lines: rows,
    total: totals(facts),
    daily,
    caveats: [
      'Room revenue is not in any of the four systems, so the group total is understated by the whole of the rooms business.',
      `Wages are hours worked priced at ${config.currencySymbol}${(config.defaultHourCost / 100).toFixed(2)} an hour unless a person carries their own rate.`,
      'Contribution is revenue less purchases and wages. Rent, power, water and depreciation are in none of these systems.',
      'Breakfast will always look like a loss here: the food is bought for every guest in the house, and only the outside guests pay a fee that any system records. It is a cost of the rooms, and the rooms are the line nothing reports.',
      'Housekeeping, maintenance and admin have no takings of their own by design. They are costs the earning lines carry, not businesses that failed.',
    ],
  };
}

/** Hours, absence, lateness and overtime, by line and by department. */
export async function labour(env, query) {
  const { db, config, from, to } = await context(env, query, 30);
  const facts = await loadFacts(db, from, to);

  const byDept = groupBy(facts.labour, (l) => `${l.line_id}|${l.department}`);
  const departments = [...byDept.entries()].map(([key, rows]) => {
    const [line, department] = key.split('|');
    const worked = sum(rows.map((r) => r.worked_minutes));
    const net = sum(facts.forLine(line).map((r) => r.net));
    const lineWorked = sum(facts.forLine(line).map((r) => r.workedMinutes));
    return {
      line, department: department || '(none)',
      hours: Math.round((worked / 60) * 10) / 10,
      cost: sum(rows.map((r) => r.labour_cost)),
      overtimeHours: Math.round((sum(rows.map((r) => r.overtime_minutes)) / 60) * 10) / 10,
      lateMinutes: sum(rows.map((r) => r.late_minutes)),
      absences: sum(rows.map((r) => r.absent_count)),
      leaveDays: sum(rows.map((r) => r.leave_count)),
      // The department's share of what its line earned, which is the only way
      // to compare a kitchen with a front desk at all.
      shareOfLineRevenue: lineWorked > 0 ? Math.round((net * (worked / lineWorked)) ) : null,
    };
  }).sort((a, b) => b.cost - a.cost);

  const daily = facts.dayList.map((day) => {
    const rows = facts.forDay(day);
    const hours = sum(rows.map((r) => r.workedMinutes)) / 60;
    const net = sum(rows.map((r) => r.net));
    return {
      day, dow: facts.byDay.get(day)?.dow_label,
      hours: Math.round(hours * 10) / 10,
      cost: sum(rows.map((r) => r.labourCost)),
      net,
      revenuePerHour: hours > 0 ? Math.round(net / hours) : null,
      absences: sum(rows.map((r) => r.absentCount)),
      guests: facts.guestsOn(day),
    };
  });

  // The weekday picture, which is where a rota is actually changed.
  const byDow = groupBy(daily.filter((d) => d.hours > 0), (d) => d.dow);
  const weekdays = [...byDow.entries()].map(([dow, rows]) => ({
    dow, dowLabel: dayName(dow),
    days: rows.length,
    medianHours: Math.round((median(rows.map((r) => r.hours)) || 0) * 10) / 10,
    medianNet: Math.round(median(rows.map((r) => r.net)) || 0),
    medianGuests: Math.round(median(rows.map((r) => r.guests)) || 0),
    medianRevenuePerHour: Math.round(median(rows.map((r) => r.revenuePerHour).filter(Number.isFinite)) || 0),
  })).sort((a, b) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(a.dow)
    - ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(b.dow));

  return { range: { from, to }, demoMode: config.demoMode, departments, daily, weekdays };
}

/** Guests, covers, orders — and every line expressed per guest. */
export async function demand(env, query) {
  const { db, config, from, to } = await context(env, query, 30);
  const facts = await loadFacts(db, from, to);

  const daily = facts.dayList.map((day) => {
    const d = facts.demandByDay.get(day) || {};
    const rows = facts.forDay(day);
    const guests = d.inhouse_guests || 0;
    const net = sum(rows.map((r) => r.net));
    return {
      day, dow: facts.byDay.get(day)?.dow_label,
      guests,
      outsideGuests: d.outside_guests || 0,
      covers: d.covers || 0,
      laundryOrders: d.laundry_orders || 0,
      roomsCleaned: d.rooms_cleaned || 0,
      net,
      spendPerGuest: guests > 0 ? Math.round(net / guests) : null,
      captureRate: guests > 0 ? ratio(d.covers || 0, guests) : null,
      attachRate: guests > 0 ? ratio(d.laundry_orders || 0, guests) : null,
    };
  });

  const withGuests = daily.filter((d) => d.guests > 0);
  const perGuest = (line) => {
    const guests = sum(withGuests.map((d) => d.guests));
    if (!guests) return null;
    return Math.round(sum(facts.forLine(line).map((r) => r.net)) / guests);
  };

  return {
    range: { from, to },
    demoMode: config.demoMode,
    daily,
    summary: {
      guestNights: sum(withGuests.map((d) => d.guests)),
      medianGuests: Math.round(median(withGuests.map((d) => d.guests)) || 0),
      trend: halves(withGuests.map((d) => d.guests), 5),
      spendPerGuest: {
        restaurant: perGuest('restaurant'),
        bar: perGuest('bar'),
        laundry: perGuest('laundry'),
        breakfast: perGuest('breakfast'),
      },
      captureRate: ratio(sum(withGuests.map((d) => d.covers)), sum(withGuests.map((d) => d.guests))),
      attachRate: ratio(sum(withGuests.map((d) => d.laundryOrders)), sum(withGuests.map((d) => d.guests))),
    },
    note: 'Guests in house come from the breakfast app, where they are recorded each morning so the kitchen knows how many to cook for. It is the only daily occupancy figure the group keeps.',
  };
}

/** Till closes, collection, and the tender mix. */
export async function cash(env, query) {
  const { db, config, from, to } = await context(env, query, 30);
  const facts = await loadFacts(db, from, to);

  const closes = facts.cash.filter((c) => c.expected > 0 || c.counted > 0);
  const byPerson = groupBy(closes.filter((c) => c.person_id), (c) => c.person_id);

  const people = [...byPerson.entries()].map(([personId, rows]) => {
    const shortRows = rows.filter((r) => r.variance < -500);
    return {
      personId,
      name: rows[0].display_name || 'Unnamed',
      department: rows[0].department || null,
      // How the name was matched. Shown so nobody reads a name-matched row as
      // firmly as an employee-number-matched one.
      matchedBy: rows[0].confidence || 'name',
      closes: rows.length,
      shortCloses: shortRows.length,
      shortRatePct: Math.round((shortRows.length / rows.length) * 100),
      totalVariance: sum(rows.map((r) => r.variance)),
      worstVariance: Math.min(...rows.map((r) => r.variance)),
    };
  }).sort((a, b) => a.totalVariance - b.totalVariance);

  const daily = facts.dayList.map((day) => {
    const rows = facts.forDay(day);
    const dayCloses = closes.filter((c) => c.day === day);
    return {
      day,
      collected: sum(rows.map((r) => r.collected)),
      outstanding: sum(rows.map((r) => r.outstanding)),
      cash: sum(rows.map((r) => r.cash)),
      card: sum(rows.map((r) => r.card)),
      other: sum(rows.map((r) => r.other)),
      variance: sum(dayCloses.map((c) => c.variance)),
    };
  });

  const t = totals(facts);
  return {
    range: { from, to },
    demoMode: config.demoMode,
    summary: {
      charged: t.net,
      collected: t.collected,
      outstanding: t.outstanding,
      collectedPct: pct(t.collected, t.net),
      tender: { cash: t.cash, card: t.card, other: t.other },
      closes: closes.length,
      totalVariance: sum(closes.map((c) => c.variance)),
      shortCloses: closes.filter((c) => c.variance < -500).length,
    },
    people,
    daily,
    note: 'A person is named here only because attendance and the POS agree on who they are. Where the two systems were matched on a name alone rather than an employee number, the row says so.',
  };
}

/** Group spend by supplier, and the same item bought at two prices. */
export async function suppliers(env, query) {
  const { db, config, from, to } = await context(env, query, 90);
  const facts = await loadFacts(db, from, to);
  const lines = facts.purchases.filter((p) => p.amount > 0);
  const total = sum(lines.map((l) => l.amount));

  const bySupplier = groupBy(lines, (l) => l.supplier_name || 'Unrecorded');
  const rows = [...bySupplier.entries()].map(([supplier, supplierRows]) => ({
    supplier,
    spend: sum(supplierRows.map((r) => r.amount)),
    sharePct: pct(sum(supplierRows.map((r) => r.amount)), total),
    purchases: supplierRows.length,
    lines: [...new Set(supplierRows.map((r) => r.line_id))],
    items: [...new Set(supplierRows.map((r) => r.item_name).filter(Boolean))].slice(0, 8),
  })).sort((a, b) => b.spend - a.spend);

  // The same item, in the same unit, bought by more than one part of the
  // business. This table is the whole reason the item dimension exists.
  const byItem = groupBy(lines.filter((l) => l.item_id && l.unit_cost > 0), (l) => `${l.item_id}|${l.unit || ''}`);
  const comparisons = [];
  for (const [, itemRows] of byItem) {
    const sides = [...groupBy(itemRows, (r) => r.line_id).entries()].map(([line, r]) => ({
      line, label: bare(line),
      unitCost: Math.round(median(r.map((x) => x.unit_cost)) || 0),
      qty: Math.round(sum(r.map((x) => x.qty)) * 100) / 100,
      spend: sum(r.map((x) => x.amount)),
      purchases: r.length,
      supplier: [...new Set(r.map((x) => x.supplier_name).filter(Boolean))].join(', '),
    })).filter((s) => s.unitCost > 0).sort((a, b) => a.unitCost - b.unitCost);
    if (sides.length < 2) continue;
    const gap = pct(sides[sides.length - 1].unitCost - sides[0].unitCost, sides[0].unitCost);
    comparisons.push({
      item: itemRows[0].item_name,
      unit: itemRows[0].unit || null,
      sides,
      gapPct: gap,
      // What the dearer side would have saved buying at the cheaper price.
      couldSave: Math.round(sides[sides.length - 1].qty * (sides[sides.length - 1].unitCost - sides[0].unitCost)),
    });
  }
  comparisons.sort((a, b) => (b.couldSave || 0) - (a.couldSave || 0));

  return {
    range: { from, to },
    demoMode: config.demoMode,
    total,
    suppliers: rows,
    comparisons: comparisons.slice(0, 20),
    note: 'Suppliers and items are matched across systems by name, after company suffixes and pack sizes are stripped. Prices are only ever compared within the same unit.',
  };
}

/** Work due against work done: housekeeping rounds and maintenance. */
export async function service(env, query) {
  const { db, config, from, to } = await context(env, query, 30);
  const facts = await loadFacts(db, from, to);

  const daily = facts.dayList.map((day) => {
    const hk = facts.service.find((s) => s.day === day && s.line_id === 'housekeeping');
    const mx = facts.service.filter((s) => s.day === day && s.line_id === 'maintenance');
    const hkLabour = facts.labour.filter((l) => l.day === day && l.line_id === 'housekeeping');
    return {
      day, dow: facts.byDay.get(day)?.dow_label,
      checksDue: hk?.checks_due || 0,
      checksDone: hk?.checks_done || 0,
      completionPct: hk?.checks_due ? Math.round((hk.checks_done / hk.checks_due) * 100) : null,
      mismatches: hk?.faults_found || 0,
      onDuty: sum(hkLabour.map((l) => l.present_count)),
      absent: sum(hkLabour.map((l) => l.absent_count)),
      maintenanceJobs: sum(mx.map((m) => m.issues_opened)),
      guests: facts.guestsOn(day),
    };
  });

  const withChecks = daily.filter((d) => d.checksDue > 0);
  const shortDays = withChecks.filter((d) => d.absent > 0);
  const fullDays = withChecks.filter((d) => d.absent === 0);

  return {
    range: { from, to },
    demoMode: config.demoMode,
    daily,
    summary: {
      checksDue: sum(withChecks.map((d) => d.checksDue)),
      checksDone: sum(withChecks.map((d) => d.checksDone)),
      completionPct: pct(sum(withChecks.map((d) => d.checksDone)), sum(withChecks.map((d) => d.checksDue))),
      mismatches: sum(withChecks.map((d) => d.mismatches)),
      maintenanceJobs: sum(daily.map((d) => d.maintenanceJobs)),
      // The comparison that needs two systems at once.
      completionFullTeamPct: fullDays.length ? Math.round((median(fullDays.map((d) => d.completionPct)) || 0)) : null,
      completionShortTeamPct: shortDays.length ? Math.round((median(shortDays.map((d) => d.completionPct)) || 0)) : null,
      fullTeamDays: fullDays.length,
      shortTeamDays: shortDays.length,
    },
    note: 'Checks come from the housekeeping module; who was on duty comes from the attendance terminal. Neither application can see the other.',
  };
}

export async function findings(env, query) {
  const db = env.DB;
  const state = String(query?.state || 'live');
  const where = state === 'all' ? '1 = 1'
    : state === 'live' ? "state IN ('open','acknowledged')"
      : 'state = ?1';
  const rows = state === 'all' || state === 'live'
    ? await all(db, `SELECT * FROM findings WHERE ${where} ORDER BY impact_monthly DESC, severity`)
    : await all(db, `SELECT * FROM findings WHERE ${where} ORDER BY impact_monthly DESC, severity`, state);
  return { findings: rows.map(shapeFinding), state };
}

function shapeFinding(row) {
  let evidence = {};
  let sources = [];
  try { evidence = JSON.parse(row.evidence || '{}'); } catch { evidence = {}; }
  try { sources = JSON.parse(row.sources || '[]'); } catch { sources = []; }
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    ruleId: row.rule_id,
    severity: row.severity,
    headline: row.headline,
    detail: row.detail,
    action: row.action,
    line: row.line_id,
    impactMonthly: row.impact_monthly,
    confidence: row.confidence,
    sources, evidence,
    from: row.from_day, to: row.to_day,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    state: row.state,
    stateBy: row.state_by,
    stateNote: row.state_note,
  };
}

export { shapeFinding };
