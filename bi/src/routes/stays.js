import { all, getSettings } from '../lib/db.js';
import { addDays } from '../lib/dates.js';
import { accessOf, roleOf } from './till.js';
import { withoutMoney } from './shifts.js';

/**
 * Stays not fully paid: the guests leaving in the next 24 hours who still owe,
 * and the ones who have left owing.
 *
 * Each ASSD reservation is one transaction in the journal, carrying every
 * night and extra charged to it and every payment taken on it, each dated.
 * Charged less paid is what the guest owes. The nights are the room and bed
 * articles (numbers 100 to 289 in ASSD); the night after the last one is the
 * day they leave.
 *
 * The journal prints only the lines dated inside the days it was exported for,
 * so two things decide whether a stay can be judged at all:
 *
 * - its last night must fall before the end of the journal loaded, or the
 *   stay may carry on past what is known and nobody is leaving yet;
 * - a payment taken before the first day loaded cannot be seen. A stay booked
 *   before then is still shown, with that said beside it.
 */

/** ASSD's article numbers for rooms and beds: a night of the stay. */
export const isNight = (code) => {
  const n = Number(code);
  return n >= 100 && n < 290;
};

/** How far back a stay that has ended is still shown. */
const LOOK_BACK_DAYS = 60;
const DEFAULT_CHECKOUT = '12:00';

/** One reservation, from its journal entry: its nights, what it was charged and what was paid. */
export function folioOf(entry) {
  const charges = entry.charges || [];
  const nights = [...new Set(charges.filter((c) => c.date && isNight(c.code) && c.amount > 0).map((c) => c.date))].sort();
  const rooms = [...new Set(charges.filter((c) => isNight(c.code) && c.name).map((c) => c.name))];
  const charged = charges.reduce((t, c) => t + (c.amount || 0), 0);
  const byMethod = {};
  for (const p of entry.payments || []) byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;
  const paid = Object.values(byMethod).reduce((t, v) => t + v, 0);
  const lastNight = nights[nights.length - 1] || null;
  return {
    seq: entry.seq,
    ref: entry.ref || null,
    bookedOn: entry.date,
    bookedBy: entry.user,
    rooms,
    nights: nights.length,
    firstNight: nights[0] || null,
    lastNight,
    checkout: lastNight ? addDays(lastNight, 1) : null,
    charged,
    paid,
    byMethod,
    balance: charged - paid,
  };
}

/**
 * Which stays to flag, at a moment.
 *
 * `journal` is the days the loaded journal covers; `checkoutTime` is the
 * hotel's check-out time, `HH:MM`, in Accra time (which is UTC).
 */
export function flagStays(folios, { now = new Date(), journal, checkoutTime = DEFAULT_CHECKOUT, threshold = 0 }) {
  const leaving = [];
  const left = [];
  if (!journal?.to) return { leaving, left };
  const time = /^\d\d:\d\d$/.test(checkoutTime) ? checkoutTime : DEFAULT_CHECKOUT;
  const nowMs = now.getTime();
  const oldest = addDays(now.toISOString().slice(0, 10), -LOOK_BACK_DAYS);
  for (const f of folios) {
    if (!f.lastNight || f.balance <= threshold) continue;
    // The night after the last one is not in the journal loaded: the stay may go on.
    if (f.lastNight >= journal.to) continue;
    if (f.checkout < oldest) continue;
    const at = Date.parse(`${f.checkout}T${time}:00Z`);
    const row = {
      ...f,
      checkoutAt: `${f.checkout} ${time}`,
      // Booked before the first day loaded: a payment taken then is not in it.
      unsure: Boolean(journal.from && f.bookedOn && f.bookedOn < journal.from),
      key: `stay:${f.ref || f.seq}`,
    };
    if (at <= nowMs) left.push(row);
    else if (at - nowMs <= 24 * 3600 * 1000) leaving.push(row);
  }
  leaving.sort((a, b) => (a.checkoutAt < b.checkoutAt ? -1 : 1));
  left.sort((a, b) => (a.checkoutAt < b.checkoutAt ? 1 : -1));
  return { leaving, left };
}

/** The Unpaid stays view. */
export async function unpaidStays(env, account, { now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const since = addDays(today, -(LOOK_BACK_DAYS + 31));
  const [rows, uploads, answers, settings] = await Promise.all([
    // Reservations with a charge in the last three months, read straight out
    // of each entry's stored lines.
    all(env.DB, `SELECT seq, staff, day, data FROM assd_entry
      WHERE kind = 'Reservation' AND EXISTS (
        SELECT 1 FROM json_each(assd_entry.data, '$.charges') c WHERE json_extract(c.value, '$.date') >= ?1)`, since),
    all(env.DB, "SELECT from_day, to_day FROM shift_upload WHERE kind = 'journal'"),
    all(env.DB, "SELECT * FROM shift_answer WHERE key LIKE 'stay:%'"),
    getSettings(env.DB).catch(() => ({})),
  ]);
  const journal = uploads.reduce((j, u) => ({
    from: !j.from || u.from_day < j.from ? u.from_day : j.from,
    to: !j.to || u.to_day > j.to ? u.to_day : j.to,
  }), { from: null, to: null });
  const folios = rows.map((r) => {
    let data = {};
    try { data = JSON.parse(r.data); } catch { data = {}; }
    return folioOf({ seq: r.seq, user: r.staff, date: r.day, ref: data.ref, charges: data.charges, payments: data.payments });
  });
  const checkoutTime = settings.checkout_time || DEFAULT_CHECKOUT;
  const flagged = flagStays(folios, { now, journal, checkoutTime, threshold: Math.max(0, Number(settings.till_threshold) || 0) });

  const answerOf = new Map(answers.map((a) => [a.key, {
    answer: a.answer, note: a.note, by: a.by_name, at: a.at, status: a.status || 'applied', approvedBy: a.decided_by || null,
  }]));
  const withAnswer = (row) => {
    const a = answerOf.get(row.key) || null;
    return { ...row, answer: a && a.status !== 'pending' ? a : null, proposed: a && a.status === 'pending' ? a : null };
  };
  const out = {
    now: now.toISOString(),
    journal: journal.to ? journal : null,
    checkoutTime,
    leaving: flagged.leaving.map(withAnswer),
    left: flagged.left.map(withAnswer),
  };
  if (roleOf(account) === 'admin') return out;
  const access = await accessOf(env, account);
  return access.money ? out : { ...withoutMoney(out), redacted: true };
}
