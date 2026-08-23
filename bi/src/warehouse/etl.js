import { all, first, run, writeAll, groupConfig } from '../lib/db.js';
import { daysBetween, dow, dowLabel, isoWeek, month, todayIn, addDays } from '../lib/dates.js';
import { listSources, pullSource } from '../connectors/index.js';
import { lineForDepartment } from '../connectors/attendance.js';
import { Register } from './identity.js';
import { minor } from '../lib/money.js';

/**
 * The run.
 *
 * Ask each source for a window, turn what comes back into facts, replace that
 * window's facts with them. Replace, not add: a run is idempotent, so a day
 * that is loaded twice is loaded once, and the standard fix for "these numbers
 * look wrong" is to run it again rather than to work out what to delete first.
 *
 * The window is short by default and reaches backwards a few days, because
 * every one of these systems accepts a late correction. A punch that arrived
 * this morning belongs to Tuesday, an invoice gets entered on Friday for
 * Monday's delivery, and a laundry bill is settled a week after it was raised.
 * Loading only yesterday would freeze all of that at whatever it happened to
 * be at midnight.
 */

/** How far back a routine run reaches. Long enough to catch a late entry. */
const CATCH_UP_DAYS = 10;

export async function runEtl(env, { from, to, trigger = 'manual' } = {}) {
  const db = env.DB;
  const config = await groupConfig(db);
  const today = todayIn(config.timezone);
  const toDay = to || addDays(today, -1);
  const fromDay = from || addDays(toDay, -(CATCH_UP_DAYS - 1));

  const started = await db.prepare(`
    INSERT INTO etl_run (from_day, to_day, trigger) VALUES (?1, ?2, ?3) RETURNING id`)
    .bind(fromDay, toDay, trigger).first();
  const runId = started?.id ?? (await first(db, 'SELECT MAX(id) AS id FROM etl_run'))?.id;

  const sources = await listSources(db);
  const results = [];
  let rowsWritten = 0;

  try {
    const register = new Register(db);
    await register.load();

    // The calendar first. Every fact joins to it, and a report that groups by
    // weekday is otherwise parsing dates in SQL a hundred thousand times.
    rowsWritten += await loadCalendar(db, fromDay, toDay);

    const bundles = [];
    for (const source of sources) {
      const result = await pullSource(source, { env, from: fromDay, to: toDay, demo: config.demoMode });
      bundles.push({ source, ...result });
      results.push({ sourceId: source.id, status: result.status, detail: result.detail });
      await run(db, `
        UPDATE sources
           SET last_ok_at    = CASE WHEN ?2 IN ('ok','demo') THEN datetime('now') ELSE last_ok_at END,
               last_error    = CASE WHEN ?2 = 'error' THEN ?3 ELSE NULL END,
               last_error_at = CASE WHEN ?2 = 'error' THEN datetime('now') ELSE last_error_at END
         WHERE id = ?1`, source.id, result.status, result.detail || null);
    }

    // A day is only cleared when at least one source actually answered for it.
    // Otherwise a night when every system was unreachable would wipe the week
    // and the dashboard would report a hotel that took no money and served
    // nobody, which is worse than showing yesterday's figures with a warning.
    const answered = bundles.some((b) => b.status === 'ok' || b.status === 'demo');
    if (!answered) {
      await finish(db, runId, 'no-sources', rowsWritten, results, 'No source answered; nothing was replaced.');
      return { runId, status: 'no-sources', from: fromDay, to: toDay, rows: rowsWritten, sources: results };
    }

    rowsWritten += await clearWindow(db, fromDay, toDay);

    for (const { source, bundle, status } of bundles) {
      if (status !== 'ok' && status !== 'demo') continue;
      rowsWritten += await loadBundle(db, register, source.id, bundle, config, fromDay, toDay);
    }

    rowsWritten += await register.flush();
    rowsWritten += await rollUpLabour(db, fromDay, toDay, config);

    await finish(db, runId, 'ok', rowsWritten, results);
    return { runId, status: 'ok', from: fromDay, to: toDay, rows: rowsWritten, sources: results };
  } catch (err) {
    await finish(db, runId, 'error', rowsWritten, results, String(err?.message ?? err));
    throw err;
  }
}

async function finish(db, runId, status, rows, results, detail) {
  await run(db, `
    UPDATE etl_run SET finished_at = datetime('now'), status = ?2, rows_written = ?3, detail = ?4
     WHERE id = ?1`, runId, status, rows, detail || null);
  for (const r of results) {
    await run(db, `
      INSERT INTO etl_source_run (run_id, source_id, status, detail)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (run_id, source_id) DO UPDATE SET status = ?3, detail = ?4`,
      runId, r.sourceId, r.status, (r.detail || '').slice(0, 400));
  }
}

async function loadCalendar(db, from, to) {
  const statements = daysBetween(from, to).map((day) => db.prepare(`
    INSERT INTO dim_day (day, dow, dow_label, iso_week, month, is_weekend)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (day) DO UPDATE SET dow = ?2, dow_label = ?3, iso_week = ?4, month = ?5, is_weekend = ?6`)
    .bind(day, dow(day), dowLabel(day), isoWeek(day), month(day), dow(day) >= 6 ? 1 : 0));
  return writeAll(db, statements);
}

/** Everything derived for this window, gone, ready to be written again. */
async function clearWindow(db, from, to) {
  const tables = [
    'fact_revenue', 'fact_labour', 'fact_cost', 'fact_demand',
    'fact_service', 'fact_cash_control', 'fact_person_day', 'fact_usage',
  ];
  for (const table of tables) {
    await run(db, `DELETE FROM ${table} WHERE day BETWEEN ?1 AND ?2`, from, to);
  }
  await run(db, 'DELETE FROM fact_purchase_line WHERE day BETWEEN ?1 AND ?2', from, to);
  await run(db, 'UPDATE dim_day SET is_holiday = 0, holiday = NULL WHERE day BETWEEN ?1 AND ?2', from, to);
  return 0;
}

async function loadBundle(db, register, sourceId, bundle, config, from, to) {
  const statements = [];
  const inWindow = (day) => typeof day === 'string' && day >= from && day <= to;

  // ------------------------------------------------------------ people --
  for (const person of bundle.people || []) {
    await register.person(sourceId, person);
  }

  // -------------------------------------------------------- person-days --
  const personIdFor = new Map();
  for (const row of bundle.personDays || []) {
    if (!inWindow(row.day)) continue;
    let personId = personIdFor.get(row.externalId);
    if (personId === undefined) {
      personId = await register.person(sourceId, { externalId: row.externalId, name: row.externalId });
      personIdFor.set(row.externalId, personId);
    }
    if (!personId) continue;
    statements.push(db.prepare(`
      INSERT INTO fact_person_day
        (day, person_id, line_id, status, reason_code, scheduled, expected_minutes,
         worked_minutes, late_minutes, overtime_minutes, first_in, last_out)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      ON CONFLICT (day, person_id) DO UPDATE SET
        line_id = ?3, status = ?4, reason_code = ?5, scheduled = ?6, expected_minutes = ?7,
        worked_minutes = ?8, late_minutes = ?9, overtime_minutes = ?10, first_in = ?11, last_out = ?12`)
      .bind(row.day, personId, row.line || lineForDepartment(row.department), row.status || '',
        row.reasonCode || null, row.scheduled ? 1 : 0, minor(row.expectedMinutes),
        minor(row.workedMinutes),
        minor(row.lateMinutes), minor(row.overtimeMinutes), row.firstIn || null, row.lastOut || null));
  }

  // ---------------------------------------------------------- payroll --
  //
  // Written by month rather than by day, and so deliberately outside the
  // window-replace cycle every other fact goes through. A payslip belongs to
  // the month it was run for; spreading it over that month's days would
  // produce a daily wage figure that reconciles with no document anybody could
  // be shown, which is the opposite of what payroll is for.
  //
  // Replaced by month instead: re-reading any window that touches March
  // rewrites March's payslips and nothing else.
  const payrollMonths = new Set();
  for (const row of bundle.payroll || []) {
    if (typeof row.month !== 'string' || !/^\d{4}-\d{2}$/.test(row.month)) continue;
    let personId = personIdFor.get(row.externalId);
    if (personId === undefined) {
      personId = await register.person(sourceId, { externalId: row.externalId, name: row.externalId });
      personIdFor.set(row.externalId, personId);
    }
    if (!personId) continue;

    if (!payrollMonths.has(row.month)) {
      payrollMonths.add(row.month);
      await run(db, 'DELETE FROM fact_payroll WHERE month = ?1 AND source_id = ?2', row.month, sourceId);
    }

    statements.push(db.prepare(`
      INSERT INTO fact_payroll
        (month, person_id, source_id, line_id, department, gross, bonus_gross,
         ssf_employee, ssf_employer, paye, loans, net, cost)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT (month, person_id) DO UPDATE SET
        source_id = ?3, line_id = ?4, department = ?5, gross = ?6, bonus_gross = ?7,
        ssf_employee = ?8, ssf_employer = ?9, paye = ?10, loans = ?11, net = ?12, cost = ?13`)
      .bind(row.month, personId, sourceId,
        row.line || lineForDepartment(row.department), row.department || '',
        minor(row.gross), minor(row.bonusGross), minor(row.ssfEmployee), minor(row.ssfEmployer),
        minor(row.paye), minor(row.loans), minor(row.net), minor(row.cost)));
  }

  // ----------------------------------------------------------- revenue --
  for (const row of bundle.revenue || []) {
    if (!inWindow(row.day)) continue;
    statements.push(db.prepare(`
      INSERT INTO fact_revenue
        (day, line_id, source_id, gross, discounts, net, collected, outstanding, cash, card, other_tender, orders, covers, units)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      ON CONFLICT (day, line_id, source_id) DO UPDATE SET
        gross = fact_revenue.gross + ?4, discounts = fact_revenue.discounts + ?5,
        net = fact_revenue.net + ?6, collected = fact_revenue.collected + ?7,
        outstanding = fact_revenue.outstanding + ?8, cash = fact_revenue.cash + ?9,
        card = fact_revenue.card + ?10, other_tender = fact_revenue.other_tender + ?11,
        orders = fact_revenue.orders + ?12, covers = fact_revenue.covers + ?13,
        units = fact_revenue.units + ?14`)
      .bind(row.day, row.line, sourceId, minor(row.gross), minor(row.discounts), minor(row.net),
        minor(row.collected), minor(row.outstanding), minor(row.cash), minor(row.card),
        minor(row.other), minor(row.orders), minor(row.covers), Number(row.units) || 0));
  }

  // -------------------------------------------------------------- costs --
  for (const row of bundle.costs || []) {
    if (!inWindow(row.day)) continue;
    const supplierId = row.supplierName ? await register.supplier(row.supplierName) : 0;
    statements.push(db.prepare(`
      INSERT INTO fact_cost (day, line_id, source_id, category, supplier_id, amount)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT (day, line_id, source_id, category, supplier_id)
        DO UPDATE SET amount = fact_cost.amount + ?6`)
      .bind(row.day, row.line, sourceId, row.category || 'purchases', supplierId, minor(row.amount)));
  }

  // ----------------------------------------------------- purchase lines --
  for (const row of bundle.purchaseLines || []) {
    if (!inWindow(row.day)) continue;
    const supplierId = row.supplierName ? await register.supplier(row.supplierName) : 0;
    const itemId = await register.item(row.itemName, row.unit);
    statements.push(db.prepare(`
      INSERT INTO fact_purchase_line
        (day, source_id, external_id, line_id, item_id, supplier_id, qty, unit, unit_cost, amount)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        day = ?1, line_id = ?4, item_id = ?5, supplier_id = ?6, qty = ?7, unit = ?8,
        unit_cost = ?9, amount = ?10`)
      .bind(row.day, sourceId, row.externalId, row.line, itemId, supplierId || null,
        Number(row.qty) || 0, row.unit || null, minor(row.unitCost), minor(row.amount)));
    // A purchase is also a cost. Kept in both places on purpose: the line is
    // for comparing prices, the cost is for the margin, and making the margin
    // screen re-aggregate every invoice line is how a dashboard gets slow.
    statements.push(db.prepare(`
      INSERT INTO fact_cost (day, line_id, source_id, category, supplier_id, amount)
      VALUES (?1, ?2, ?3, 'purchases', ?4, ?5)
      ON CONFLICT (day, line_id, source_id, category, supplier_id)
        DO UPDATE SET amount = fact_cost.amount + ?5`)
      .bind(row.day, row.line, sourceId, supplierId, minor(row.amount)));
  }

  // ------------------------------------------------------------- demand --
  for (const row of bundle.demand || []) {
    if (!inWindow(row.day)) continue;
    statements.push(db.prepare(`
      INSERT INTO fact_demand (day, inhouse_guests, outside_guests, rooms_cleaned, rooms_tracked, covers, laundry_orders, laundry_loads)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT (day) DO UPDATE SET
        inhouse_guests = MAX(fact_demand.inhouse_guests, ?2),
        outside_guests = MAX(fact_demand.outside_guests, ?3),
        rooms_cleaned  = MAX(fact_demand.rooms_cleaned,  ?4),
        rooms_tracked  = MAX(fact_demand.rooms_tracked,  ?5),
        covers         = fact_demand.covers + ?6,
        laundry_orders = fact_demand.laundry_orders + ?7,
        laundry_loads  = fact_demand.laundry_loads + ?8`)
      .bind(row.day, minor(row.inhouseGuests), minor(row.outsideGuests), minor(row.roomsCleaned),
        minor(row.roomsTracked), minor(row.covers), minor(row.laundryOrders), Number(row.laundryLoads) || 0));
  }

  // ------------------------------------------------------------ service --
  for (const row of bundle.service || []) {
    if (!inWindow(row.day)) continue;
    statements.push(db.prepare(`
      INSERT INTO fact_service (day, line_id, checks_due, checks_done, faults_found, issues_opened, issues_closed, issues_open, oldest_open_days)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT (day, line_id) DO UPDATE SET
        checks_due = fact_service.checks_due + ?3, checks_done = fact_service.checks_done + ?4,
        faults_found = fact_service.faults_found + ?5, issues_opened = fact_service.issues_opened + ?6,
        issues_closed = fact_service.issues_closed + ?7, issues_open = MAX(fact_service.issues_open, ?8),
        oldest_open_days = MAX(fact_service.oldest_open_days, ?9)`)
      .bind(row.day, row.line, minor(row.checksDue), minor(row.checksDone), minor(row.faultsFound),
        minor(row.issuesOpened), minor(row.issuesClosed), minor(row.issuesOpen), minor(row.oldestOpenDays)));
  }

  // ------------------------------------------------------- cash control --
  for (const row of bundle.cashControl || []) {
    if (!inWindow(row.day)) continue;
    let personId = null;
    if (row.personExternalId) personId = await register.person(sourceId, { externalId: row.personExternalId, name: row.personName || row.personExternalId });
    else if (row.personName) personId = await register.personByName(sourceId, row.personName);
    statements.push(db.prepare(`
      INSERT INTO fact_cash_control (day, source_id, external_id, line_id, shift, person_id, expected, counted, variance)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        day = ?1, line_id = ?4, shift = ?5, person_id = ?6, expected = ?7, counted = ?8, variance = ?9`)
      .bind(row.day, sourceId, row.externalId, row.line, row.shift || '', personId,
        minor(row.expected), minor(row.counted), minor(row.variance)));
  }

  // -------------------------------------------------------------- usage --
  for (const row of bundle.usage || []) {
    if (!inWindow(row.day)) continue;
    const itemId = await register.item(row.itemName, row.unit);
    if (!itemId) continue;
    statements.push(db.prepare(`
      INSERT INTO fact_usage (day, item_id, line_id, qty, value)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (day, item_id, line_id) DO UPDATE SET
        qty = fact_usage.qty + ?4, value = fact_usage.value + ?5`)
      .bind(row.day, itemId, row.line, Number(row.qty) || 0, minor(row.value)));
  }

  // ----------------------------------------------------------- holidays --
  for (const row of bundle.holidays || []) {
    if (!inWindow(row.day)) continue;
    statements.push(db.prepare('UPDATE dim_day SET is_holiday = 1, holiday = ?2 WHERE day = ?1')
      .bind(row.day, row.name));
  }

  return writeAll(db, statements);
}

/**
 * Turn the person-day rows into the labour a line actually cost.
 *
 * Done in SQL, after everything is loaded, rather than in the connector,
 * because a person's line comes from attendance and their rate may come from
 * somewhere else entirely. Costing labour at the point of reading would freeze
 * whichever rate happened to be known first.
 *
 * The rate is a stated estimate unless a person carries their own. Every
 * screen that shows a margin says so, because a margin quoted to the pesewa on
 * top of a guessed wage bill is a lie told confidently.
 */
async function rollUpLabour(db, from, to, config) {
  await run(db, 'DELETE FROM fact_labour WHERE day BETWEEN ?1 AND ?2', from, to);
  const rows = await all(db, `
    SELECT d.day,
           COALESCE(d.line_id, p.line_id, 'admin') AS line,
           COALESCE(p.department, '')              AS department,
           SUM(CASE WHEN d.scheduled = 1 THEN 1 ELSE 0 END)                        AS scheduled_count,
           SUM(CASE WHEN d.worked_minutes > 0 THEN 1 ELSE 0 END)                   AS present_count,
           SUM(CASE WHEN d.scheduled = 1 AND d.worked_minutes = 0
                     AND d.status NOT IN ('leave','holiday','rest') THEN 1 ELSE 0 END) AS absent_count,
           SUM(CASE WHEN d.status = 'leave' THEN 1 ELSE 0 END)                     AS leave_count,
           SUM(CASE WHEN d.late_minutes > 0 THEN 1 ELSE 0 END)                     AS late_count,
           SUM(d.worked_minutes)   AS worked_minutes,
           SUM(d.late_minutes)     AS late_minutes,
           SUM(d.overtime_minutes) AS overtime_minutes,
           SUM(d.expected_minutes) AS expected_minutes,
           SUM(d.worked_minutes * COALESCE(p.hour_cost, ?3) / 60.0) AS labour_cost,
           -- Which of the three the money came from. 'rate' only when every
           -- person in the group had one; one unrated person makes the whole
           -- figure part-guess, and saying "rate" of it would be a claim the
           -- number cannot support.
           CASE WHEN SUM(CASE WHEN p.hour_cost IS NULL THEN 1 ELSE 0 END) = 0
                THEN 'rate' ELSE 'default' END AS cost_basis
      FROM fact_person_day d
      JOIN dim_person p ON p.id = d.person_id
     WHERE d.day BETWEEN ?1 AND ?2
     GROUP BY d.day, line, department`, from, to, config.defaultHourCost);

  const statements = rows.map((row) => db.prepare(`
    INSERT INTO fact_labour
      (day, line_id, department, scheduled_count, present_count, absent_count, leave_count, late_count,
       expected_minutes, worked_minutes, late_minutes, overtime_minutes, labour_cost, cost_basis)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    ON CONFLICT (day, line_id, department) DO UPDATE SET
      scheduled_count = ?4, present_count = ?5, absent_count = ?6, leave_count = ?7, late_count = ?8,
      expected_minutes = ?9, worked_minutes = ?10, late_minutes = ?11, overtime_minutes = ?12,
      labour_cost = ?13, cost_basis = ?14`)
    .bind(row.day, row.line, row.department, row.scheduled_count, row.present_count,
      row.absent_count, row.leave_count, row.late_count,
      // What HIVE says people were down to work. This used to be
      // `scheduled_count * 480` — a hard-coded eight-hour day on a property
      // that runs six-hour breakfast shifts and twelve-hour night cover, which
      // made rostered-against-worked a comparison with a fiction. HIVE has
      // stored the real figure all along and the connector was already
      // fetching it; there was simply nowhere to put it.
      Math.round(row.expected_minutes || 0), Math.round(row.worked_minutes || 0),
      Math.round(row.late_minutes || 0), Math.round(row.overtime_minutes || 0),
      Math.round(row.labour_cost || 0), row.cost_basis || 'default'));

  return writeAll(db, statements);
}
