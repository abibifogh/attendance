import { all } from '../lib/db.js';
import { emptyBundle } from './bundle.js';
import { toMinor } from '../lib/money.js';

/**
 * The breakfast, housekeeping and maintenance system, read from its database.
 *
 * One Cloudflare app, three modules, and by far the most undervalued data in
 * the group. Two things in here are worth more than anything else the group
 * records:
 *
 * 1. `service_days.inhouse_guests`. It is written down every morning so the
 *    kitchen knows how many to cook for. It is also, and nobody has ever used
 *    it this way, the only daily occupancy figure the business has. It is the
 *    denominator for the restaurant's capture rate, the laundry's attach rate,
 *    the food cost per head and the staff hours per guest — none of which have
 *    ever been calculable, because the number lived in a kitchen app.
 *
 * 2. `hk_checks.expected_state` against `state`. A bed the front desk believed
 *    was empty and the housekeeper found slept in is a room being used and not
 *    billed. That is revenue, sitting in a housekeeping table.
 */

export async function pull({ db, from, to }) {
  const bundle = emptyBundle();
  if (!db) {
    bundle.notes.push('No breakfast database is bound to this Worker.');
    return bundle;
  }

  // ------------------------------------------------------------- demand --
  const serviceDays = await all(db, `
    SELECT day, inhouse_guests, outside_guests, outsider_fee
      FROM service_days
     WHERE day BETWEEN ?1 AND ?2`, from, to);

  for (const row of serviceDays) {
    bundle.demand.push({
      day: row.day,
      inhouseGuests: Number(row.inhouse_guests) || 0,
      outsideGuests: Number(row.outside_guests) || 0,
    });
    // Outside guests pay a fee to eat. It is the only revenue this system
    // records, it is real money, and it has never appeared in a revenue
    // figure anywhere because the breakfast app calls it a service note.
    const fee = toMinor(row.outsider_fee) * (Number(row.outside_guests) || 0);
    if (fee > 0) {
      bundle.revenue.push({
        day: row.day, line: 'breakfast', gross: fee, net: fee, collected: fee,
        cash: fee, orders: Number(row.outside_guests) || 0, covers: Number(row.outside_guests) || 0,
      });
    }
  }

  // ---------------------------------------------------------- food costs --
  const ingredients = new Map();
  for (const row of await all(db, 'SELECT id, name, unit, default_unit_cost FROM ingredients')) {
    ingredients.set(row.id, { name: row.name, unit: row.unit, cost: toMinor(row.default_unit_cost) });
  }

  for (const row of await all(db, `
    SELECT id, day, ingredient_id, qty, unit_cost, supplier
      FROM purchases
     WHERE day BETWEEN ?1 AND ?2`, from, to)) {
    const ing = ingredients.get(row.ingredient_id) || {};
    const unitCost = toMinor(row.unit_cost);
    const qty = Number(row.qty) || 0;
    bundle.purchaseLines.push({
      day: row.day,
      externalId: `purchase:${row.id}`,
      line: 'breakfast',
      itemName: ing.name || `ingredient ${row.ingredient_id}`,
      unit: ing.unit || null,
      supplierName: row.supplier || null,
      qty,
      unitCost,
      amount: Math.round(unitCost * qty),
    });
  }

  // What was eaten, valued at what it cost. `usage` is entered by the cooks
  // every morning; priced, it becomes the food cost per guest, which is the
  // single most useful number the kitchen produces and one it has never seen.
  for (const row of await all(db, `
    SELECT day, ingredient_id, qty FROM usage WHERE day BETWEEN ?1 AND ?2`, from, to)) {
    const ing = ingredients.get(row.ingredient_id) || {};
    const qty = Number(row.qty) || 0;
    bundle.usage.push({
      day: row.day,
      line: 'breakfast',
      itemName: ing.name || `ingredient ${row.ingredient_id}`,
      unit: ing.unit || null,
      qty,
      value: Math.round((ing.cost || 0) * qty),
    });
  }

  // ---------------------------------------------------- housekeeping ------
  // Rounds live in one of two tables depending on how far the housekeeping
  // module has been migrated. Ask for the newer one and fall back, rather than
  // making the whole pull fail on a property that has not upgraded.
  const rounds = await tryAll(db, `
    SELECT day, COUNT(*) AS rounds, SUM(CASE WHEN submitted_at IS NOT NULL THEN 1 ELSE 0 END) AS done
      FROM hk_rounds WHERE day BETWEEN ?1 AND ?2 GROUP BY day`, from, to);

  const checks = await tryAll(db, `
    SELECT day,
           COUNT(*) AS checked,
           SUM(CASE WHEN expected_state IS NOT NULL AND expected_state <> state THEN 1 ELSE 0 END) AS mismatched
      FROM hk_checks WHERE day BETWEEN ?1 AND ?2 GROUP BY day`, from, to);

  const beds = await tryAll(db, 'SELECT COUNT(*) AS n FROM hk_beds WHERE active = 1');
  const bedCount = Number(beds[0]?.n) || 0;

  const hkByDay = new Map();
  for (const row of rounds) hkByDay.set(row.day, { ...(hkByDay.get(row.day) || {}), rounds: Number(row.rounds) || 0, roundsDone: Number(row.done) || 0 });
  for (const row of checks) hkByDay.set(row.day, { ...(hkByDay.get(row.day) || {}), checked: Number(row.checked) || 0, mismatched: Number(row.mismatched) || 0 });

  for (const [day, v] of hkByDay) {
    bundle.service.push({
      day,
      line: 'housekeeping',
      checksDue: bedCount * Math.max(1, v.rounds || 1),
      checksDone: v.checked || 0,
      faultsFound: v.mismatched || 0,
    });
    if (v.checked) {
      bundle.demand.push({ day, roomsCleaned: v.checked, roomsTracked: bedCount });
    }
  }

  // ------------------------------------------------------- maintenance ----
  for (const row of await tryAll(db, `
    SELECT p.id, p.day, p.qty, p.unit_cost, p.supplier, i.name, i.unit
      FROM mx_purchases p LEFT JOIN mx_items i ON i.id = p.item_id
     WHERE p.day BETWEEN ?1 AND ?2`, from, to)) {
    const unitCost = toMinor(row.unit_cost);
    const qty = Number(row.qty) || 0;
    bundle.purchaseLines.push({
      day: row.day,
      externalId: `mx-purchase:${row.id}`,
      line: 'maintenance',
      itemName: row.name || `item ${row.id}`,
      unit: row.unit || null,
      supplierName: row.supplier || null,
      qty,
      unitCost,
      amount: Math.round(unitCost * qty),
    });
  }

  // Items issued out of the maintenance store, valued at their standing cost.
  // Issues are the closest thing the group has to a count of things going
  // wrong, and their value is a cost the maintenance line really carries.
  for (const row of await tryAll(db, `
    SELECT s.day, SUM(s.qty * COALESCE(i.default_unit_cost, 0)) AS value, COUNT(*) AS issues
      FROM mx_issues s LEFT JOIN mx_items i ON i.id = s.item_id
     WHERE s.day BETWEEN ?1 AND ?2 GROUP BY s.day`, from, to)) {
    bundle.costs.push({
      day: row.day, line: 'maintenance', category: 'parts issued',
      amount: toMinor(row.value),
    });
    bundle.service.push({
      day: row.day, line: 'maintenance', issuesOpened: Number(row.issues) || 0,
    });
  }

  bundle.notes.push(`${serviceDays.length} service days, ${bundle.purchaseLines.length} purchase lines`);
  return bundle;
}

/**
 * A query that is allowed to find nothing, including a table that was never
 * created.
 *
 * The housekeeping and maintenance modules are optional and a property may
 * have neither. Letting a missing table end the whole pull would mean the
 * breakfast figures — which every other calculation depends on — vanish
 * because somebody never switched on a module they do not use.
 */
async function tryAll(db, sql, ...binds) {
  try {
    return await all(db, sql, ...binds);
  } catch (err) {
    if (/no such table|no such column/i.test(String(err?.message ?? err))) return [];
    throw err;
  }
}
