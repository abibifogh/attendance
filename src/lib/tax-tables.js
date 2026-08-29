import { BANDS, RATES, ratesFrom } from './tax.js';
import { TIERS, tiersFrom } from './statutory.js';

/**
 * Which figures a month is worked out on.
 *
 * A tax table is not a fact about the property, it is a fact about a period.
 * The bands that applied in January are the January bands however many budgets
 * have happened since, and a month reopened in July to fix one allowance must
 * not come back retaxed.
 *
 * A closed month never had this problem: closing writes every payslip out in
 * full and nothing recomputes them afterwards. This is for the months still
 * open, and for the ones somebody reopens.
 */

const monthOk = (value) => /^\d{4}-\d{2}$/.test(String(value ?? ''));

/**
 * The stamp on the row that captures what a property was using before it dated
 * anything. Sorts before every real month, so it answers for all of them.
 */
export const EARLIEST = '0000-01';

/** Rows in the shape the table stores them, as a set of rates. */
export function tableToRates(row) {
  let bands = null;
  try {
    const parsed = JSON.parse(row.bands);
    if (Array.isArray(parsed) && parsed.length) {
      bands = parsed.map((band) => ({
        width: band.width == null ? null : Number(band.width),
        rate: Number(band.rate),
      }));
    }
  } catch {
    // A stored table nobody can parse is not a reason to pay everybody
    // nothing. Fall back to the published figures, the same as the setting.
    bands = null;
  }

  const number = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value)
    : fallback);

  return {
    rates: {
      bands: bands ?? null,
      ssnitEmployee: number(row.ssnit_employee, RATES.ssnitEmployee),
      ssnitEmployer: number(row.ssnit_employer, RATES.ssnitEmployer),
      bonusFinalRate: number(row.bonus_rate, RATES.bonusFinalRate),
      bonusShareOfBasic: number(row.bonus_share, RATES.bonusShareOfBasic),
      label: String(row.label ?? ''),
    },
    tiers: {
      tier1: number(row.tier1, TIERS.tier1),
      tier2: number(row.tier2, TIERS.tier2),
    },
  };
}

/**
 * The newest table that had started by that month, or today's figures.
 *
 * The fallback is the settings, which is what a property that has never dated
 * a table has — and the only table it has ever had, so it is the right answer
 * for every month.
 */
export function ratesOn(month, tables = [], settings = {}) {
  const started = (tables ?? [])
    .filter((row) => monthOk(row.from_month) || row.from_month === EARLIEST)
    .filter((row) => String(row.from_month) <= String(month))
    .sort((a, b) => String(b.from_month).localeCompare(String(a.from_month)));

  const [newest] = started;
  if (!newest) {
    return {
      rates: ratesFrom(settings),
      tiers: tiersFrom(settings),
      from: null,
      table: null,
    };
  }

  const { rates, tiers } = tableToRates(newest);
  // A stored table with no usable bands falls back to the setting's bands
  // rather than to nothing, which would tax everybody at zero.
  if (!rates.bands) rates.bands = ratesFrom(settings).bands ?? BANDS;
  return { rates, tiers, from: newest.from_month, table: newest };
}

/** How a dated table reads on a screen. */
export function sayFrom(value) {
  if (!value || value === EARLIEST) return 'everything before that';
  const [year, month] = String(value).split('-');
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return at.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
