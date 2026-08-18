/**
 * What a connector hands back.
 *
 * Every connector answers in this one shape, whatever it had to do to get
 * there. That is the whole trick of this application: four systems that share
 * no field name, no money format and no idea of what a "day" is, each turned
 * into the same eleven lists by the one piece of code that understands it, and
 * never spoken of again in its own terms.
 *
 * A connector may leave any list empty. The laundry knows nothing about
 * housekeeping and is not asked to pretend otherwise.
 */
export function emptyBundle() {
  return {
    // Staff, as the system knows them. `externalId` must be stable.
    people: [],
    // One person, one day: worked, late, absent, on leave.
    personDays: [],
    // Money earned, by line, by day.
    revenue: [],
    // Money spent, by line, by day.
    costs: [],
    // Money spent, line by line, so unit prices can be compared.
    purchaseLines: [],
    // How much business there was: guests, covers, orders.
    demand: [],
    // Work that was due and work that was done.
    service: [],
    // Till closes and what they were out by.
    cashControl: [],
    // Stock consumed.
    usage: [],
    // Public holidays, which change what a quiet day means.
    holidays: [],
    // Anything the connector wants the run log to say.
    notes: [],
  };
}

export function mergeBundles(bundles) {
  const out = emptyBundle();
  for (const b of bundles) {
    if (!b) continue;
    for (const key of Object.keys(out)) {
      if (Array.isArray(b[key])) out[key].push(...b[key]);
    }
  }
  return out;
}

/** How many rows a bundle carries, for the run log. */
export function bundleSize(bundle) {
  return Object.values(bundle).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}
