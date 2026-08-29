import { round2 } from './tax.js';

/**
 * A bonus scheme paid by tier.
 *
 * A table of scores and what each is worth: a 1 is seventy cedis, a 4 is a
 * hundred and thirty, a 10 is two hundred and fifty. The property decides the
 * score and the table decides the money, which is the way these are actually
 * run and agreed.
 *
 * THE TABLE IS A LADDER, NOT A FORMULA. It is tempting to notice that these
 * usually go up in even steps and store a start and a step instead. Every one
 * of them stops being even eventually — a top tier that jumps, a bottom one
 * that pays nothing — and a scheme that cannot express what was agreed gets
 * worked around in somebody's head. So the rungs are written out.
 *
 * WHAT WAS AWARDED IS COPIED, NEVER LOOKED UP AGAIN. The amount is read off
 * the table when the score is given and stored beside it, so moving a tier in
 * December does not quietly rewrite what somebody was paid in June. The table
 * says what a score is worth from now on; the payslip says what it was worth
 * then.
 */

/** The most rungs worth having. Past this it is not a ladder, it is a formula. */
export const MOST_TIERS = 40;

/**
 * A tier table, read from whatever a form or a database column holds.
 *
 * Sorted by score and with duplicates dropped, because the order is the whole
 * readability of it and two rows for a 4 is a table nobody can act on.
 */
export function readTiers(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];

  const byScore = new Map();
  for (const row of list) {
    const score = Number(row?.score ?? row?.tier);
    const amount = Number(row?.amount);
    if (!Number.isFinite(score) || !Number.isFinite(amount)) continue;
    if (score < 0 || score > 1000 || amount < 0 || amount > 1_000_000) continue;
    byScore.set(round2(score), { score: round2(score), amount: round2(amount) });
  }

  return [...byScore.values()]
    .sort((a, b) => a.score - b.score)
    .slice(0, MOST_TIERS);
}

/**
 * What a score is worth, or null where the table says nothing about it.
 *
 * An exact rung and nothing else. Interpolating between two of them would be
 * inventing a figure nobody agreed, and rounding to the nearest would quietly
 * pay a 5 what a 6 was promised.
 */
export function tierAmount(tiers, score) {
  const table = readTiers(tiers);
  const want = round2(Number(score));
  if (!Number.isFinite(want)) return null;
  const found = table.find((t) => t.score === want);
  return found ? found.amount : null;
}

/** The scores a table offers, in order, for a screen to put in a list. */
export const tierScores = (tiers) => readTiers(tiers).map((t) => t.score);

/** Whether a table is usable at all. One rung is a table; none is not. */
export const hasTiers = (tiers) => readTiers(tiers).length > 0;

/**
 * The table in a sentence, for a card that has one line to say it in.
 *
 * The ends and the count, because the rungs between them are on the screen
 * underneath and repeating all ten of them in a summary helps nobody.
 */
export function sayTiers(tiers, cash = (n) => String(n)) {
  const table = readTiers(tiers);
  if (!table.length) return 'no scores set yet';
  if (table.length === 1) {
    return `one score, ${table[0].score}, worth ${cash(table[0].amount)}`;
  }
  const first = table[0];
  const last = table[table.length - 1];
  return `${table.length} scores, ${first.score} at ${cash(first.amount)} `
    + `up to ${last.score} at ${cash(last.amount)}`;
}
