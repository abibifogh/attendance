import { all, first, groupConfig } from '../lib/db.js';
import { loadFacts, totals } from '../insight/facts.js';
import { analyse, sourceHealth } from '../insight/engine.js';
import { resolveRange, addDays, todayIn, daysBetween } from '../lib/dates.js';
import { pct, ratio, change } from '../lib/money.js';
import { bare, dayName } from '../insight/labels.js';
import { median, sum, groupBy, halves } from '../insight/stats.js';
import { buyingAnalysis } from '../insight/buying.js';
import { financialAnalysis } from '../insight/financials.js';

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
      standingCostMonthly: config.standingCostMonthly,
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
      wageBasisNote(facts, config),
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
    note: 'A person is named here only because HIVE and the POS agree on who they are. Where the two systems were matched on a name alone rather than an employee number, the row says so.',
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
/**
 * The books.
 *
 * Its own screen rather than a section of Buying, because the two answer
 * different questions from different evidence. Buying reads what the
 * operational systems recorded receiving; this reads what the business was
 * invoiced and what the accounts did with it. Where they disagree is itself
 * the finding, and that is only visible if both exist separately.
 *
 * Ninety days by default. A price trend needs more than a month to be a trend,
 * and a payment pattern needs more than one cycle.
 */
export async function books(env, query) {
  const { db, config, from, to } = await context(env, query, 90);

  const bills = await all(db, `
    SELECT b.*, s.name AS supplier
      FROM fact_bill b
      LEFT JOIN dim_supplier s ON s.id = b.supplier_id
     WHERE b.day BETWEEN ?1 AND ?2`, from, to);

  // Only lines that came from an accounting source. The other systems' lines
  // are in the same table on purpose — that is how a price gets compared
  // across the group — but this screen is about the books, and mixing a
  // kitchen's own record of a delivery into "what we were invoiced" would make
  // the totals disagree with Odoo for a reason nobody could find.
  const lines = await all(db, `
    SELECT p.*, s.name AS supplier, i.name AS item
      FROM fact_purchase_line p
      LEFT JOIN dim_supplier s ON s.id = p.supplier_id
      LEFT JOIN dim_item i ON i.id = p.item_id
     WHERE p.day BETWEEN ?1 AND ?2
       AND p.bill_id IS NOT NULL`, from, to);

  // As of the end of the window, not today. Re-reading last quarter should
  // report what was overdue then, not what is overdue now.
  const analysis = buyingAnalysis({ bills, lines, asOf: to });
  // Only the accounting sources. A screen that says "nothing here" has to be
  // able to tell "Odoo is not connected" from "Odoo is connected and this
  // window is genuinely empty", and those are different sentences.
  const health = (await sourceHealth(db)).filter((h) => h.id === 'odoo');
  // What the last load actually covered. "No bills in this window" and "this
  // window was never loaded" look identical on screen and need opposite
  // actions, and until this was passed through the screen guessed — it told
  // somebody to go and check for draft bills when the real answer was that the
  // days he was looking at had never been fetched.
  const lastRun = await first(db, 'SELECT from_day, to_day, finished_at FROM etl_run ORDER BY id DESC LIMIT 1');
  const loaded = lastRun ? { from: lastRun.from_day, to: lastRun.to_day, at: lastRun.finished_at } : null;
  const coversWindow = Boolean(loaded && loaded.from <= from && loaded.to >= to);

  return {
    range: { from, to },
    demoMode: config.demoMode,
    connected: health.filter((h) => h.status !== 'never run'),
    odoo: health[0] || null,
    loaded,
    coversWindow,
    ...analysis,
    caveats: [
      'A bill is what a supplier invoiced, which is not always what arrived. Where the kitchen '
        + 'recorded a different quantity, the difference is on the Buying screen.',
      'Draft bills are left out of every total here. They are somebody mid-entry, not a commitment.',
      'A credit note counts as a negative purchase, so a supplier total is what was billed less '
        + 'what was returned.',
      'Prices are compared before tax, which is the only basis on which two suppliers can be '
        + 'compared at all.',
    ],
  };
}

/**
 * The yardstick: everything a decision needs, against something to judge it by.
 *
 * The rest of the app reports. This compares — every figure against the period
 * before it, against what the day has to take to pay for itself, and against a
 * shock it might have to survive.
 *
 * Two things make it different from the Money screen, and both are about the
 * comparison rather than the numbers:
 *
 * The prior window is **exactly as long** as the current one, taken from the
 * days immediately before it. Thirty days against twenty-eight is a 7% fall
 * that came out of the calendar, and it would be reported here as a finding
 * about the business.
 *
 * The standing cost is measured, not assumed. Nothing in these five systems
 * records rent or electricity, so it is inferred from the relationship between
 * what a day takes and what a day costs — and where that relationship is too
 * weak to infer anything, the screen says so and declines the break-even
 * rather than printing one.
 */
export async function financials(env, query) {
  const { db, config, from, to } = await context(env, query, 30);
  // Exactly as many days as the current window, ending the day before it
  // starts. daysBetween hands back the days themselves, not a count.
  const span = daysBetween(from, to).length;
  const priorTo = addDays(from, -1);
  const priorFrom = addDays(priorTo, -(span - 1));

  const [facts, prior, bills] = await Promise.all([
    loadFacts(db, from, to),
    loadFacts(db, priorFrom, priorTo),
    all(db, 'SELECT day, due_day, state, total, residual FROM fact_bill WHERE day BETWEEN ?1 AND ?2', from, to),
  ]);

  const lines = await all(db, 'SELECT * FROM dim_line ORDER BY sort_order');
  const meta = new Map(lines.map((l) => [l.id, l]));

  // One row per line, both windows in the same shape, because the bridge takes
  // the two and every mismatch between them would show up as a business event.
  const shape = (source) => [...groupBy(source.lineRows, (r) => r.line).entries()].map(([line, rows]) => ({
    line,
    label: meta.get(line)?.label || bare(line),
    net: sum(rows.map((r) => r.net)),
    cost: sum(rows.map((r) => r.cost)),
    labour: sum(rows.map((r) => r.labourCost)),
    contribution: sum(rows.map((r) => r.contribution)),
    covers: sum(rows.map((r) => r.covers)),
    orders: sum(rows.map((r) => r.orders)),
    hours: sum(rows.map((r) => r.workedMinutes)) / 60,
    days: source.dayList.length,
  })).sort((a, b) => (meta.get(a.line)?.sort_order ?? 99) - (meta.get(b.line)?.sort_order ?? 99));

  const asDaily = (source) => source.dayList.map((day) => {
    const rows = source.forDay(day);
    return {
      day,
      net: sum(rows.map((r) => r.net)),
      cost: sum(rows.map((r) => r.cost)),
      labour: sum(rows.map((r) => r.labourCost)),
      contribution: sum(rows.map((r) => r.contribution)),
    };
  });

  const t = totals(facts);
  // Drafts are somebody mid-entry, not a commitment, and they are excluded
  // here for the same reason they are excluded on the Books screen.
  const posted = bills.filter((b) => b.state === 'posted');
  const billed = sum(posted.map((b) => b.total));
  const payable = sum(posted.map((b) => b.residual));

  // The month the window ends in, so the forecast has something to run to.
  // A range that is not a calendar month gets no forecast at all rather than
  // one projected against a month it does not sit inside.
  const endsMonth = to.slice(0, 7);
  const wholeMonth = from.slice(0, 7) === endsMonth && from.endsWith('-01');
  const daysInMonth = new Date(Date.UTC(Number(endsMonth.slice(0, 4)), Number(endsMonth.slice(5, 7)), 0)).getUTCDate();

  const analysis = financialAnalysis({
    currentDaily: asDaily(facts),
    currentLines: shape(facts),
    priorDaily: asDaily(prior),
    priorLines: shape(prior),
    charged: t.net,
    collected: t.collected,
    outstanding: t.outstanding,
    billed,
    paid: billed - payable,
    payable,
    daysInPeriod: wholeMonth ? daysInMonth : null,
    // Given as a month, applied by the day, so a 17-day range is charged
    // seventeen days of rent rather than a month of it.
    standingPerDay: Math.round(config.standingCostMonthly / 30.44),
  });

  const priorTotals = totals(prior);

  // The two windows must be read on the same basis or the comparison is a
  // comparison of bookkeeping, not of trading. If Odoo posted against a line
  // this month and not last, the bridge would report an enormous change in
  // what was bought — entirely because a different system was answering the
  // question. Refused rather than drawn, and the screen says which is which.
  const sameBasis = facts.costBasis.basis === prior.costBasis.basis
    && facts.costBasis.fromBooks.slice().sort().join() === prior.costBasis.fromBooks.slice().sort().join();

  return {
    range: { from, to, days: span },
    priorRange: { from: priorFrom, to: priorTo, days: span },
    demoMode: config.demoMode,
    ...analysis,
    ...(sameBasis ? {} : { bridge: null, lineBridges: [] }),
    costBasis: {
      basis: facts.costBasis.basis,
      fromBooks: facts.costBasis.fromBooks.map((id) => ({ line: id, label: meta.get(id)?.label || bare(id) })),
      excluded: facts.costBasis.excluded,
      excludedLines: facts.costBasis.excludedLines.map((id) => meta.get(id)?.label || bare(id)),
      uncovered: facts.costBasis.uncovered.map((u) => ({
        line: u.line, label: meta.get(u.line)?.label || bare(u.line), amount: u.amount,
      })),
      comparable: sameBasis,
      priorBasis: prior.costBasis.basis,
    },
    movement: {
      revenue: change(priorTotals.net, t.net),
      contribution: change(priorTotals.contribution, t.contribution),
      labour: change(priorTotals.labourCost, t.labourCost),
      cost: change(priorTotals.cost, t.cost),
    },
    hasBooks: posted.length > 0,
    caveats: [
      'Rooms are in none of the connected systems, so every figure here is the group without its '
        + 'rooms business. The break-even is the break-even of what is measured.',
      facts.costBasis.basis === 'operations'
        ? 'Purchases are what the operating systems recorded. Connect Odoo and the supplier’s own '
          + 'invoice replaces the kitchen’s note of the same delivery.'
        : 'Where Odoo has posted a bill against a line, that line’s purchases are Odoo’s figures and '
          + 'nothing else — the operating system’s record of the same delivery is dropped rather than '
          + 'added to it. Lines Odoo does not reach still come from the system that runs them, and are '
          + 'named on the screen.',
      'Purchases are treated as varying with takings and wages as fixed, because a rota is set a '
        + 'week ahead and does not shrink because Tuesday was quiet. Both are measured, not modelled. '
        + 'Rent, power, water and depreciation are in none of the connected systems and are taken '
        + 'from Setup; left unset, every break-even here is understated by exactly that amount.',
      wageBasisNote(facts, config),
      'The previous period is the same number of days immediately before this one. It is not the '
        + 'same period last year, so a seasonal business will read a season change as a decline.',
      'Stock is not valued by any connected system, so the cash cycle excludes it and is shorter '
        + 'than the real one by however long food sits on a shelf.',
    ],
  };
}

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
    note: 'Checks come from the housekeeping module; who was on duty comes from HIVE at the door. Neither application can see the other.',
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

/**
 * How the wage figure on this page was arrived at.
 *
 * Worth a sentence rather than a footnote nobody wrote, because "wages are 38%
 * of takings" means three different things depending on where the money came
 * from, and until HIVE ran payroll it always meant the weakest of them: hours
 * multiplied by one property-wide rate, the same for a night porter and a head
 * chef. A reader had no way to tell that from a measurement.
 *
 * So the page says which it is, and — when it is part one and part the other —
 * how much of the bill is which.
 */
export function wageBasisNote(facts, config) {
  const rows = facts.labour || [];
  const total = rows.reduce((sum, row) => sum + (row.labour_cost || 0), 0);
  const guessed = rows
    .filter((row) => (row.cost_basis || 'default') === 'default')
    .reduce((sum, row) => sum + (row.labour_cost || 0), 0);

  const fallback = `${config.currencySymbol}${(config.defaultHourCost / 100).toFixed(2)}`;

  if (total === 0) return 'No wage cost is recorded for this period.';
  if (guessed === 0) {
    return 'Wages are hours worked priced at each person\u2019s own rate from HIVE, '
      + 'which is a measurement rather than an estimate. It is not the payroll figure: '
      + 'a payslip also carries allowances, bonus and the employer\u2019s pension, and is monthly.';
  }
  if (guessed >= total) {
    return `Wages are hours worked priced at ${fallback} an hour for everybody, because nobody `
      + 'has a rate recorded in HIVE. Set the rates there and this figure stops being a guess.';
  }
  const share = Math.round((guessed / total) * 100);
  return `Wages are hours worked at each person\u2019s own rate from HIVE, except for ${share}% of `
    + `the bill where nobody has a rate recorded and ${fallback} an hour is assumed.`;
}
