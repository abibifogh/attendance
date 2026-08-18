/**
 * How the parts of the business are named in a sentence.
 *
 * Three forms, because English needs three. A finding's headline starts a
 * sentence, its detail refers to the line mid-sentence, and a table column
 * wants the bare name. Getting this wrong produces "72% of The restaurant's
 * overtime", which is the kind of thing that makes a person trust the numbers
 * less than they should.
 */
const LINES = {
  rooms:        { bare: 'Rooms',        lead: 'Rooms',            mid: 'the rooms' },
  restaurant:   { bare: 'Restaurant',   lead: 'The restaurant',   mid: 'the restaurant' },
  bar:          { bare: 'Bar',          lead: 'The bar',          mid: 'the bar' },
  breakfast:    { bare: 'Breakfast',    lead: 'Breakfast',        mid: 'breakfast' },
  laundry:      { bare: 'Laundry',      lead: 'The laundry',      mid: 'the laundry' },
  housekeeping: { bare: 'Housekeeping', lead: 'Housekeeping',     mid: 'housekeeping' },
  maintenance:  { bare: 'Maintenance',  lead: 'Maintenance',      mid: 'maintenance' },
  admin:        { bare: 'Admin',        lead: 'Admin',            mid: 'admin' },
};

/** Starting a sentence: "The restaurant earns…" */
export const lead = (line) => LINES[line]?.lead || line;
/** Inside a sentence: "…the overtime the restaurant paid" */
export const mid = (line) => LINES[line]?.mid || line;
/** In a table cell or a chart legend. */
export const bare = (line) => LINES[line]?.bare || line;

const DAYS = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
};

/** 'Sat' → 'Saturday'. */
export const dayName = (short) => DAYS[short] || short;
/** 'Sat' → 'Saturdays'. Not 'Sats'. */
export const dayNamePlural = (short) => `${dayName(short)}s`;

/**
 * Which source system a line's money comes from.
 *
 * Used to label a finding with the systems it drew on, so somebody can tell at
 * a glance whether a conclusion crossed a boundary no single app could.
 */
export function revenueSourceFor(line) {
  if (line === 'laundry') return 'laundry';
  if (line === 'breakfast') return 'breakfast';
  if (line === 'restaurant' || line === 'bar') return 'pos';
  return null;
}
