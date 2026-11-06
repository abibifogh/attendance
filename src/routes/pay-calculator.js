import { badRequest, bool, json, readJson } from '../lib/http.js';
import { FLAT_RATES, payeOn, ratesForResidency, round2, ssnitOn } from '../lib/tax.js';
import { ratesOn } from '../lib/tax-tables.js';
import { todayIn } from '../util/dates.js';

/**
 * Gross to net, and net to gross.
 *
 * "What does it cost to pay somebody 2,000 in hand?" The same arithmetic the
 * payroll runs: SSNIT on the basic, PAYE on what is left after the employee's
 * SSNIT, with the bands in force for the month asked about. Behind the payroll
 * lock, because the figures it is asked about are people's pay.
 */

const RESIDENCIES = ['Resident', ...Object.keys(FLAT_RATES)];

/** One month's pay worked forward from a gross and a basic. */
export function payFrom(gross, basic, { rates, ssnit = true }) {
  const g = round2(gross);
  const b = round2(Math.min(basic, g));
  const s = ssnitOn(b, { qualifies: ssnit, rates });
  const chargeable = round2(g - s.employee);
  const paye = payeOn(chargeable, rates.bands);
  return {
    gross: g,
    basic: b,
    allowances: round2(g - b),
    ssnitEmployee: s.employee,
    chargeable,
    paye: paye.tax,
    steps: paye.steps,
    net: round2(chargeable - paye.tax),
    ssnitEmployer: s.employer,
    cost: round2(g + s.employer),
  };
}

/**
 * The smallest gross, to the pesewa, that pays at least `net` in hand. With
 * no basic given, the whole gross is basic. Net only ever rises with gross, so
 * a search finds it whatever the bands are.
 */
export function grossFor(net, { basic = null, rates, ssnit = true }) {
  const target = round2(net);
  const at = (g) => payFrom(g, basic ?? g, { rates, ssnit });
  if (basic != null) {
    const floor = at(basic);
    if (floor.net > target) {
      return { error: `A basic of ${basic.toFixed(2)} on its own already pays ${floor.net.toFixed(2)} in hand. Lower the basic.` };
    }
  }
  let lo = basic ?? 0;
  let hi = Math.max(lo, target) * 2 + 100;
  for (let i = 0; i < 60 && at(hi).net < target; i += 1) hi *= 2;
  for (let i = 0; i < 80 && hi - lo > 0.001; i += 1) {
    const mid = (lo + hi) / 2;
    if (at(mid).net < target) lo = mid; else hi = mid;
  }
  // To the pesewa, upwards, then down again while it still pays enough.
  let g = Math.ceil(hi * 100) / 100;
  while (g > 0.01 && at(round2(g - 0.01)).net >= target) g = round2(g - 0.01);
  return at(g);
}

/** POST /api/payroll/calculator { mode, amount, basic, residency, ssnit, month } */
export async function calculate(ctx) {
  const body = await readJson(ctx.request);
  const mode = body.mode === 'gross' ? 'gross' : 'net';
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) throw badRequest('Enter the amount.');
  const basic = body.basic === '' || body.basic == null ? null : Number(body.basic);
  if (basic != null && (!Number.isFinite(basic) || basic < 0)) throw badRequest('The basic is not a number.');
  if (mode === 'gross' && basic != null && basic > amount) throw badRequest('The basic cannot be more than the gross.');
  const residency = RESIDENCIES.includes(body.residency) ? body.residency : 'Resident';

  const settings = Object.fromEntries(((await ctx.db.prepare('SELECT key, value FROM settings').all()
    .catch(() => ({ results: [] }))).results ?? []).map((r) => [r.key, r.value]));
  const month = /^\d{4}-\d{2}$/.test(body.month ?? '') ? body.month : todayIn(settings.timezone || 'UTC').slice(0, 7);
  const tables = await ctx.db.prepare('SELECT * FROM pay_rates').all().catch(() => ({ results: [] }));
  const { rates: base, from } = ratesOn(month, tables.results ?? [], settings);
  const rates = ratesForResidency(base, residency === 'Resident' ? null : residency);
  const ssnit = bool(body.ssnit, true);

  const out = mode === 'gross'
    ? payFrom(amount, basic ?? amount, { rates, ssnit })
    : grossFor(amount, { basic, rates, ssnit });
  if (out.error) throw badRequest(out.error);

  return json({
    mode, month, residency, ssnit,
    rates: {
      label: rates.flat != null ? `${residency}: ${round2(rates.flat * 100)}% flat` : (base.label ?? 'GRA monthly bands'),
      from: from ?? null,
      ssnitEmployee: rates.ssnitEmployee,
      ssnitEmployer: rates.ssnitEmployer,
    },
    residencies: RESIDENCIES,
    ...out,
  });
}
