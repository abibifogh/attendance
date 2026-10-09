import { all } from '../lib/db.js';
import { addDays, daysBetween } from '../lib/dates.js';

/**
 * The warehouse, read once, in the shape every rule and every screen wants.
 *
 * There are a dozen rules and eight screens, and each of them wants some
 * arrangement of the same six facts. Reading them once per request and handing
 * the same object to everybody is both faster and — the reason it is done this
 * way — the only way to guarantee that the number on the summary tile and the
 * number in the finding underneath it are the same number.
 */
export async function loadFacts(db, from, to) {
  const [days, revenue, labour, cost, demand, service, cash, personDays, purchases, usage, bookSources] = await Promise.all([
    all(db, 'SELECT * FROM dim_day WHERE day BETWEEN ?1 AND ?2 ORDER BY day', from, to),
    all(db, `SELECT day, line_id, SUM(gross) gross, SUM(discounts) discounts, SUM(net) net,
                    SUM(collected) collected, SUM(outstanding) outstanding, SUM(cash) cash,
                    SUM(card) card, SUM(other_tender) other_tender, SUM(orders) orders,
                    SUM(covers) covers, SUM(units) units
               FROM fact_revenue WHERE day BETWEEN ?1 AND ?2 GROUP BY day, line_id`, from, to),
    all(db, `SELECT * FROM fact_labour WHERE day BETWEEN ?1 AND ?2`, from, to),
    // Kept split by source. Two systems can hold a record of the same food —
    // the kitchen's own delivery note and the supplier's invoice — and adding
    // them is the one thing that must never happen here.
    all(db, `SELECT day, line_id, source_id, category, supplier_id, SUM(amount) amount
               FROM fact_cost WHERE day BETWEEN ?1 AND ?2
              GROUP BY day, line_id, source_id, category, supplier_id`, from, to),
    all(db, 'SELECT * FROM fact_demand WHERE day BETWEEN ?1 AND ?2', from, to),
    all(db, 'SELECT * FROM fact_service WHERE day BETWEEN ?1 AND ?2', from, to),
    // The link's confidence travels with the row. A variance attributed to a
    // person by name alone must never be presented with the certainty of one
    // attributed by employee number.
    all(db, `SELECT c.*, p.display_name, p.department, l.confidence
               FROM fact_cash_control c
               LEFT JOIN dim_person p ON p.id = c.person_id
               LEFT JOIN person_link l ON l.source_id = c.source_id AND l.person_id = c.person_id
              WHERE c.day BETWEEN ?1 AND ?2`, from, to),
    all(db, `SELECT d.*, p.display_name, p.department
               FROM fact_person_day d JOIN dim_person p ON p.id = d.person_id
              WHERE d.day BETWEEN ?1 AND ?2`, from, to),
    all(db, `SELECT l.*, i.name item_name, i.match_key item_key, s.name supplier_name
               FROM fact_purchase_line l
               LEFT JOIN dim_item i ON i.id = l.item_id
               LEFT JOIN dim_supplier s ON s.id = l.supplier_id
              WHERE l.day BETWEEN ?1 AND ?2`, from, to),
    all(db, `SELECT u.*, i.name item_name FROM fact_usage u
               LEFT JOIN dim_item i ON i.id = u.item_id
              WHERE u.day BETWEEN ?1 AND ?2`, from, to),
    all(db, "SELECT id FROM sources WHERE kind = 'odoo_json2'"),
  ]);

  const basis = chooseCostBasis(cost, new Set(bookSources.map((r) => r.id)));
  // A month HIVE has run payroll for is costed at its payslips, not at hours times rates.
  const payslips = await applyPayslips(db, labour, from, to);

  const dayList = days.map((d) => d.day);
  const byDay = new Map(days.map((d) => [d.day, d]));

  // One row per day per line, with revenue, labour and cost side by side.
  // This is the join the group has never had: the till and the clock and the
  // invoice book, on the same line of the same table.
  const lineKey = (day, line) => `${day}|${line}`;
  const lines = new Map();
  const ensure = (day, line) => {
    const key = lineKey(day, line);
    if (!lines.has(key)) {
      lines.set(key, {
        day, line,
        net: 0, gross: 0, discounts: 0, collected: 0, outstanding: 0,
        cash: 0, card: 0, other: 0, orders: 0, covers: 0, units: 0,
        labourCost: 0, workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0,
        presentCount: 0, absentCount: 0, scheduledCount: 0,
        cost: 0, costByCategory: {},
      });
    }
    return lines.get(key);
  };

  for (const row of revenue) {
    const bucket = ensure(row.day, row.line_id);
    bucket.gross += row.gross; bucket.discounts += row.discounts; bucket.net += row.net;
    bucket.collected += row.collected; bucket.outstanding += row.outstanding;
    bucket.cash += row.cash; bucket.card += row.card; bucket.other += row.other_tender;
    bucket.orders += row.orders; bucket.covers += row.covers; bucket.units += row.units;
  }
  for (const row of labour) {
    const bucket = ensure(row.day, row.line_id);
    bucket.labourCost += row.labour_cost;
    bucket.workedMinutes += row.worked_minutes;
    bucket.overtimeMinutes += row.overtime_minutes;
    bucket.lateMinutes += row.late_minutes;
    bucket.presentCount += row.present_count;
    bucket.absentCount += row.absent_count;
    bucket.scheduledCount += row.scheduled_count;
  }
  for (const row of basis.rows) {
    const bucket = ensure(row.day, row.line_id);
    bucket.cost += row.amount;
    bucket.costByCategory[row.category] = (bucket.costByCategory[row.category] || 0) + row.amount;
  }

  // Contribution: what the line earned, less what it bought and what it paid
  // people. Not profit — there is no rent, no electricity and no depreciation
  // in any of these four systems — and every screen that shows it says so.
  for (const bucket of lines.values()) {
    bucket.contribution = bucket.net - bucket.cost - bucket.labourCost;
    bucket.workedHours = Math.round((bucket.workedMinutes / 60) * 10) / 10;
    bucket.revenuePerHour = bucket.workedMinutes > 0 ? Math.round(bucket.net / (bucket.workedMinutes / 60)) : null;
    bucket.labourPct = bucket.net > 0 ? Math.round((bucket.labourCost / bucket.net) * 1000) / 10 : null;
  }

  const demandByDay = new Map(demand.map((d) => [d.day, d]));

  return {
    from, to,
    days, dayList, byDay,
    lineRows: [...lines.values()].sort((a, b) => (a.day === b.day ? a.line.localeCompare(b.line) : a.day.localeCompare(b.day))),
    demand, demandByDay,
    labour, service, cash, personDays, purchases, usage,
    cost: basis.rows,
    costBasis: basis,
    payslipMonths: payslips.months,
    /** Every row for one line, in date order. */
    forLine(line) {
      return this.lineRows.filter((r) => r.line === line);
    },
    /** Every line's rows for one day. */
    forDay(day) {
      return this.lineRows.filter((r) => r.day === day);
    },
    guestsOn(day) {
      const row = demandByDay.get(day);
      return row ? row.inhouse_guests : 0;
    },
  };
}

/** Group totals for a window: one row, the whole business. */
export function totals(facts) {
  const out = {
    net: 0, gross: 0, discounts: 0, collected: 0, outstanding: 0,
    cash: 0, card: 0, other: 0, orders: 0, covers: 0,
    labourCost: 0, workedMinutes: 0, overtimeMinutes: 0, cost: 0, contribution: 0,
    guestNights: 0, laundryOrders: 0, roomsCleaned: 0,
  };
  for (const row of facts.lineRows) {
    out.net += row.net; out.gross += row.gross; out.discounts += row.discounts;
    out.collected += row.collected; out.outstanding += row.outstanding;
    out.cash += row.cash; out.card += row.card; out.other += row.other;
    out.orders += row.orders; out.covers += row.covers;
    out.labourCost += row.labourCost; out.workedMinutes += row.workedMinutes;
    out.overtimeMinutes += row.overtimeMinutes; out.cost += row.cost;
    out.contribution += row.contribution;
  }
  for (const row of facts.demand) {
    out.guestNights += row.inhouse_guests;
    out.laundryOrders += row.laundry_orders;
    out.roomsCleaned += row.rooms_cleaned;
  }
  out.workedHours = Math.round((out.workedMinutes / 60) * 10) / 10;
  out.revenuePerHour = out.workedMinutes > 0 ? Math.round(out.net / (out.workedMinutes / 60)) : null;
  out.revenuePerGuest = out.guestNights > 0 ? Math.round(out.net / out.guestNights) : null;
  out.labourPct = out.net > 0 ? Math.round((out.labourCost / out.net) * 1000) / 10 : null;
  return out;
}

/**
 * Which record of a purchase to believe.
 *
 * Two systems can hold the same food. The kitchen writes down what a delivery
 * contained; weeks later the supplier invoices for it and Odoo posts the bill.
 * Both land in `fact_cost` under different sources, and summing them counts
 * every crate twice — which deflates contribution, raises the break-even and
 * looks exactly like a bad month. It is the kind of fault that appears the day
 * a new source is connected and is never traced back to that day.
 *
 * The choice is made **per line, never blended within a line**. Where the books
 * have posted a cost against a line, the books are that line's record and the
 * operating system's version of it is dropped. A bill is what was actually
 * charged and agreed; a delivery note is what somebody in a kitchen wrote down
 * at six in the morning.
 *
 * Per line rather than for the whole window, because Odoo rarely reaches every
 * part of a hotel at once. In this group's own data, Odoo posts against
 * breakfast, the till carries the restaurant's food and the maintenance store
 * carries its own parts — so a single books-or-nothing switch would take the
 * restaurant's entire food cost to zero and turn its margin into a triumph.
 * That is a worse error than the double count it was meant to fix, and a
 * quieter one.
 *
 * `uncovered` names the lines still being read from an operating system, which
 * is the one thing this choice can hide. The line map in Setup is what moves
 * them across, and the screens say so.
 *
 * `addOnIds` are the books' own records of cash spent and not billed yet (a
 * PO paid from the drawer or the safe). They add to the books, never decide a
 * line's basis, and are dropped on a line read from an operating system,
 * which will have written the same purchase down when it arrived.
 */
export function chooseCostBasis(cost, bookSourceIds, addOnIds = new Set(['odoo-cash'])) {
  const linesInBooks = new Set(
    cost.filter((r) => bookSourceIds.has(r.source_id)).map((r) => r.line_id),
  );
  const linesInOperations = new Set(
    cost.filter((r) => !bookSourceIds.has(r.source_id) && !addOnIds.has(r.source_id)).map((r) => r.line_id),
  );

  const rows = [];
  const dropped = [];
  for (const row of cost) {
    if (addOnIds.has(row.source_id)) {
      if (!linesInBooks.has(row.line_id) && linesInOperations.has(row.line_id)) dropped.push(row);
      else rows.push(row);
      continue;
    }
    // A line the books speak for is a line only the books speak for.
    if (linesInBooks.has(row.line_id) && !bookSourceIds.has(row.source_id)) {
      dropped.push(row);
      continue;
    }
    rows.push(row);
  }

  const bookish = (row) => bookSourceIds.has(row.source_id) || addOnIds.has(row.source_id);
  const byLine = new Map();
  for (const row of rows) {
    const from = bookish(row) ? 'books' : 'operations';
    byLine.set(row.line_id, from);
  }
  const uncovered = new Map();
  for (const row of rows) {
    if (bookish(row)) continue;
    uncovered.set(row.line_id, (uncovered.get(row.line_id) || 0) + row.amount);
  }

  return {
    basis: linesInBooks.size ? (uncovered.size ? 'books-in-part' : 'books') : 'operations',
    rows,
    sources: [...new Set(rows.map((r) => r.source_id))],
    fromBooks: [...linesInBooks],
    // What an operating system said about a line the books already cover, and
    // is deliberately not being counted a second time.
    excluded: dropped.reduce((a, r) => a + r.amount, 0),
    excludedLines: [...new Set(dropped.map((r) => r.line_id))],
    // Lines the books do not reach, still read from the system that runs them.
    uncovered: [...uncovered.entries()]
      .map(([line, amount]) => ({ line, amount }))
      .sort((a, b) => b.amount - a.amount),
    byLine,
  };
}

const lastOfMonth = (m) => addDays(`${addDays(`${m}-28`, 4).slice(0, 7)}-01`, -1);

/**
 * Wages from the payslips, where there are any.
 *
 * Hours worked at each person's rate is a measurement of time, not of what
 * anybody was paid: a payslip carries allowances, bonus and the employer's
 * SSF, and only a payslip reconciles with the bank. So for every month HIVE
 * has a finalised pay run for, the payslips' cost (gross pay plus the
 * employer's SSF) replaces it.
 *
 * A payslip is monthly and these screens are daily, so each department's
 * payslips are spread over the month's days by the hours that department
 * worked each day (the line's hours, when the department has none recorded;
 * evenly, when the line has none at all). Only the days asked for are kept,
 * so a week inside a paid month shows that week's share.
 *
 * The rows of `labour` in those months are rewritten in place, with
 * `cost_basis` 'payslip'; a day the payslips reach and attendance does not
 * gains a row of its own. Months without a finalised run keep hours × rate.
 */
export async function applyPayslips(db, labour, from, to) {
  const firstMonth = from.slice(0, 7);
  const lastMonth = to.slice(0, 7);
  let pay = [];
  try {
    pay = await all(db, `SELECT month, line_id, department, SUM(cost) AS cost FROM fact_payroll
      WHERE month BETWEEN ?1 AND ?2 GROUP BY month, line_id, department`, firstMonth, lastMonth);
  } catch { return { months: [] }; }
  pay = pay.filter((p) => (p.cost || 0) > 0);
  if (!pay.length) return { months: [] };
  const months = [...new Set(pay.map((p) => p.month))].sort();
  const paid = new Set(months);

  // The whole of each paid month's attendance, not only the days asked for.
  const worked = await all(db, `SELECT day, line_id, department, worked_minutes FROM fact_labour WHERE day BETWEEN ?1 AND ?2`,
    `${months[0]}-01`, lastOfMonth(months[months.length - 1]));

  const alloc = new Map();
  const put = (day, line, dept, amount) => {
    if (day < from || day > to || !amount) return;
    const k = `${day}|${line}|${dept}`;
    alloc.set(k, (alloc.get(k) || 0) + amount);
  };
  for (const p of pay) {
    const inMonth = worked.filter((w) => w.day.startsWith(p.month) && w.line_id === p.line_id && (w.worked_minutes || 0) > 0);
    let spread = inMonth.filter((w) => w.department === p.department);
    if (!spread.length) spread = inMonth;
    const shares = [];
    if (spread.length) {
      const byDay = new Map();
      for (const w of spread) byDay.set(w.day, (byDay.get(w.day) || 0) + w.worked_minutes);
      const total = [...byDay.values()].reduce((t, m) => t + m, 0);
      for (const [day, m] of byDay) shares.push([day, (p.cost * m) / total]);
    } else {
      const days = daysBetween(`${p.month}-01`, lastOfMonth(p.month));
      for (const day of days) shares.push([day, p.cost / days.length]);
    }
    // Whole pesewas that still add up to the payslips.
    let given = 0;
    shares.sort((a, b) => a[0].localeCompare(b[0])).forEach(([day, amount], i) => {
      const value = i === shares.length - 1 ? p.cost - given : Math.round(amount);
      given += value;
      put(day, p.line_id, p.department, value);
    });
  }

  for (const row of labour) {
    if (!paid.has(row.day.slice(0, 7))) continue;
    const k = `${row.day}|${row.line_id}|${row.department}`;
    row.labour_cost = alloc.get(k) || 0;
    row.cost_basis = 'payslip';
    alloc.delete(k);
  }
  for (const [k, amount] of alloc) {
    const [day, line, department] = k.split('|');
    labour.push({
      day, line_id: line, department, scheduled_count: 0, present_count: 0, absent_count: 0, leave_count: 0,
      late_count: 0, expected_minutes: 0, worked_minutes: 0, late_minutes: 0, overtime_minutes: 0,
      labour_cost: amount, cost_basis: 'payslip',
    });
  }
  return { months };
}
