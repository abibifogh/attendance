import { all, run } from '../lib/db.js';
import { badRequest, csvResponse, str } from '../lib/http.js';
import { addDays } from '../lib/dates.js';
import { shifts as shiftsFor } from './shifts.js';
import { hiveReports, requireAdmin } from './till.js';

/**
 * Money › Safe › Envelopes received: every envelope receptionists moved to
 * the safe in a period, beside what ASSD moved, and which an admin has
 * actually received into the safe, counted, with whom.
 *
 * One line per envelope, from the HIVE closing report. A shift whose ASSD
 * journal moved cash to the safe with no envelope in HIVE gets one line of
 * its own, so nothing that left the drawer goes unaccounted for. Separate from
 * the safe book on purpose: the book says what the safe should hold; this
 * says which envelopes have been seen in it.
 */

const SLOTS = ['morning', 'afternoon', 'night'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';
/** How far back "everything not received" looks. */
const OPEN_DAYS = 90;

/** Typed cedis into pesewas, or null when nothing was typed. */
function cedis(value, field) {
  const text = String(value ?? '').replace(/[,\s]/g, '').replace(/^GH₵|^GHS/i, '');
  if (text === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw badRequest(`${field} is not an amount of money.`);
  return Math.round(Number(text) * 100);
}

/** The shifts' ASSD side for the days asked, two months at a time. */
async function journalShifts(env, from, to, account) {
  const out = [];
  for (let start = from; start <= to;) {
    const end = [addDays(start, 61), to].sort()[0];
    // eslint-disable-next-line no-await-in-loop
    const data = await shiftsFor(env, { from: start, to: end }, account);
    for (const d of data.days || []) out.push(...d.shifts);
    start = addDays(end, 1);
  }
  return out;
}

/** Every envelope line for the days, each with what was received, if it was. */
export async function envelopeLines(env, { from, to }, account) {
  const [shifts, reports, received] = await Promise.all([
    journalShifts(env, from, to, account),
    hiveReports(env, from, to),
    all(env.DB, 'SELECT * FROM safe_received WHERE day BETWEEN ?1 AND ?2', from, to).catch(() => []),
  ]);
  const shiftOf = new Map(shifts.map((s) => [`${s.day}|${s.slot}`, s]));
  const reportOf = new Map(reports.map((r) => [`${r.day}|${r.slot}`, r]));
  const got = new Map(received.map((r) => [`${r.day}|${r.slot}|${r.envelope_no}`, r]));
  const keys = [...new Set([...shiftOf.keys(), ...reportOf.keys()])].filter((k) => k.slice(0, 10) >= from && k.slice(0, 10) <= to);
  const lines = [];
  for (const key of keys) {
    const [day, slot] = key.split('|');
    const shift = shiftOf.get(key) || null;
    const report = reportOf.get(key) || null;
    const assd = shift ? shift.register?.toSafe || 0 : null;
    const envelopes = report?.toSafe ? (report.envelopes || []).filter((e) => e && (e.no || e.amount)) : [];
    const said = envelopes.reduce((t, e) => t + (Number(e.amount) || 0), 0);
    const base = {
      day, slot, by: report?.name || shift?.user || null, assd,
      // The shift's envelopes against what ASSD moved, once per shift.
      shiftDiff: envelopes.length && assd != null ? said - assd : null,
      inJournal: Boolean(shift),
    };
    const line = (no, amount, i, count) => {
      const r = got.get(`${day}|${slot}|${no}`) || null;
      return {
        ...base, no: no || null, amount, expected: amount ?? assd ?? 0, first: i === 0, of: count,
        received: r ? {
          on: r.received_on, with: r.with_name || null, by: r.by_name, at: r.at,
          counted: r.counted, diff: r.counted - r.expected, why: r.why || null,
        } : null,
      };
    };
    if (envelopes.length) envelopes.forEach((e, i) => lines.push(line(String(e.no || `${i + 1}`).trim(), Number(e.amount) || 0, i, envelopes.length)));
    else if (assd > 0) lines.push(line('', null, 0, 1));
  }
  lines.sort((a, b) => (a.day === b.day ? SLOTS.indexOf(b.slot) - SLOTS.indexOf(a.slot) || (a.no || '').localeCompare(b.no || '') : a.day < b.day ? 1 : -1));
  return lines;
}

function rangeOf(query) {
  const open = String(query?.open || '') === '1';
  const to = DAY.test(String(query?.to || '')) && !open ? query.to : today();
  const from = open ? addDays(to, -(OPEN_DAYS - 1)) : DAY.test(String(query?.from || '')) ? query.from : addDays(to, -6);
  if (from > to) throw badRequest('The start is after the end.');
  if (!open && addDays(from, 366) < to) throw badRequest('A year at a time at most.');
  return { from, to, open };
}

/** The page: the lines and the four totals. */
export async function envelopesView(env, query, account) {
  await requireAdmin(account);
  const range = rangeOf(query);
  let lines = await envelopeLines(env, range, account);
  if (range.open) lines = lines.filter((l) => !l.received);
  const waiting = lines.filter((l) => !l.received);
  const done = lines.filter((l) => l.received);
  return {
    range,
    lines,
    totals: {
      count: lines.length,
      shifts: new Set(lines.map((l) => `${l.day}|${l.slot}`)).size,
      expected: lines.reduce((t, l) => t + l.expected, 0),
      received: done.reduce((t, l) => t + l.expected, 0),
      receivedCount: done.length,
      counted: done.reduce((t, l) => t + l.received.counted, 0),
      waiting: waiting.reduce((t, l) => t + l.expected, 0),
      waitingCount: waiting.length,
      oldest: waiting.length ? waiting.map((l) => l.day).sort()[0] : null,
      diff: done.reduce((t, l) => t + l.received.diff, 0),
      diffCount: done.filter((l) => l.received.diff !== 0).length,
      // Per shift, not per envelope: what the envelopes said against ASSD.
      said: lines.reduce((t, l) => t + (l.amount || 0), 0),
      assd: lines.filter((l) => l.first).reduce((t, l) => t + (l.assd || 0), 0),
    },
  };
}

/**
 * Mark envelopes received: each with what was counted (what it said, unless
 * typed otherwise) and, when that differs, why. What it should have held is
 * worked out here, not taken from the page.
 */
export async function receive(env, body, account) {
  await requireAdmin(account);
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) throw badRequest('Tick the envelopes received.');
  if (items.length > 300) throw badRequest('Three hundred at most at once.');
  const receivedOn = String(body?.receivedOn || '').trim();
  if (!DAY.test(receivedOn)) throw badRequest('Which day were they received?');
  if (receivedOn > today()) throw badRequest('That day is still to come.');
  const withName = str(body?.with, 'Counted with', { max: 120 }) || null;
  const picked = items.map((x) => ({ day: String(x?.day || ''), slot: String(x?.slot || ''), no: String(x?.no ?? '').trim(), counted: x?.counted, why: x?.why }))
    .filter((x) => DAY.test(x.day) && SLOTS.includes(x.slot));
  if (!picked.length) throw badRequest('Tick the envelopes received.');
  const days = picked.map((x) => x.day).sort();
  const lines = await envelopeLines(env, { from: days[0], to: days[days.length - 1] }, account);
  const lineOf = new Map(lines.map((l) => [`${l.day}|${l.slot}|${l.no || ''}`, l]));
  const rows = [];
  for (const p of picked) {
    const l = lineOf.get(`${p.day}|${p.slot}|${p.no}`);
    const name = `${p.no ? `Envelope ${p.no}` : 'The cash'} from the ${p.slot} of ${p.day}`;
    if (!l) throw badRequest(`${name} is not one moved to the safe.`);
    if (l.received) throw badRequest(`${name} is already marked received.`);
    const counted = cedis(p.counted, `What was counted for ${name.toLowerCase()}`) ?? l.expected;
    const why = str(p.why, 'Why', { max: 300 }) || null;
    if (counted !== l.expected && !why) throw badRequest(`${name} was counted at a different amount: say why.`);
    rows.push([l.day, l.slot, l.no || '', l.expected, counted, receivedOn, withName, counted === l.expected ? null : why, who(account), now()]);
  }
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, `INSERT INTO safe_received (day, slot, envelope_no, expected, counted, received_on, with_name, why, by_name, at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`, ...r);
  }
  return { ok: true, received: rows.length, counted: rows.reduce((t, r) => t + r[4], 0) };
}

/** Take a "received" back. */
export async function undo(env, body, account) {
  await requireAdmin(account);
  const day = String(body?.day || '');
  const slot = String(body?.slot || '');
  if (!DAY.test(day) || !SLOTS.includes(slot)) throw badRequest('Which envelope?');
  await run(env.DB, 'DELETE FROM safe_received WHERE day = ?1 AND slot = ?2 AND envelope_no = ?3', day, slot, String(body?.no ?? '').trim());
  return { ok: true };
}

/** The same table as a spreadsheet. */
export async function envelopesCsv(env, query, account) {
  const { range, lines, totals } = await envelopesView(env, query, account);
  const c = (minor) => (minor == null ? '' : (minor / 100).toFixed(2));
  const rows = [
    [`Envelopes moved to the safe, ${range.from} to ${range.to}${range.open ? ' (not received)' : ''}`],
    ['Day', 'Shift', 'Receptionist', 'Envelope', 'Envelope says', 'ASSD moved (shift)', 'Envelope vs ASSD (shift)', 'Received on', 'Counted with', 'Counted in the safe', 'Short / over', 'Why', 'Marked by'],
    ...lines.map((l) => [l.day, l.slot, l.by || '', l.no || 'no envelope in HIVE', c(l.amount), l.first ? c(l.assd) : '', l.first ? c(l.shiftDiff) : '',
      l.received?.on || '', l.received?.with || '', c(l.received?.counted), l.received ? c(l.received.diff) : '', l.received?.why || '', l.received?.by || '']),
    ['Total', '', '', `${totals.count} envelopes`, c(totals.said), c(totals.assd), '', `${totals.receivedCount} received`, '', c(totals.counted), c(totals.diff), '', ''],
  ];
  return csvResponse(`safe-envelopes-${range.from}-to-${range.to}.csv`, rows);
}
