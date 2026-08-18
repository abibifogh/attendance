// Money is a whole number of pesewas, everywhere, from the moment a figure
// enters this app until the moment it is printed.
//
// This is not fussiness. Three of the four source systems hand out money as a
// floating-point number of cedis, and adding a hundred of those together drifts
// by enough to make a reconciliation screen argue with a cash drawer. The POS
// already does the right thing and sends minor units; the others are converted
// at the connector, once, and never converted back until display.

/** Cedis (a float, from a source that should have known better) → pesewas. */
export function toMinor(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** A figure that is already minor units, defended against nulls and strings. */
export function minor(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Pesewas → cedis, for display only. Never feed this back into a sum. */
export function toMajor(value) {
  return minor(value) / 100;
}

/**
 * A ratio of two money figures, as a percentage to one decimal.
 *
 * Returns null rather than zero or Infinity when the denominator is empty. A
 * labour ratio on a day with no revenue is not "0%" and it is not "∞%"; it is a
 * question that has no answer, and every rule in this app depends on being able
 * to tell that apart from a real number.
 */
export function pct(part, whole) {
  const w = Number(whole);
  if (!Number.isFinite(w) || w === 0) return null;
  return Math.round((Number(part) / w) * 1000) / 10;
}

/** A safe division that gives back null instead of a nonsense number. */
export function ratio(part, whole, places = 2) {
  const w = Number(whole);
  if (!Number.isFinite(w) || w === 0) return null;
  const f = 10 ** places;
  return Math.round((Number(part) / w) * f) / f;
}

/** The change from `before` to `after`, as a percentage. Null if unanswerable. */
export function change(before, after) {
  const b = Number(before);
  if (!Number.isFinite(b) || b === 0) return null;
  return Math.round(((Number(after) - b) / Math.abs(b)) * 1000) / 10;
}

export function formatMoney(valueMinor, { symbol = 'GH₵' } = {}) {
  const n = toMajor(valueMinor);
  const s = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(Math.abs(n));
  return `${n < 0 ? '-' : ''}${symbol}${s}`;
}
