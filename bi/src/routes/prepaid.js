import { all, getSettings, setSetting } from '../lib/db.js';
import { addDays } from '../lib/dates.js';
import { badRequest } from '../lib/http.js';
import { callLink } from '../lib/link.js';
import { isNight } from './stays.js';
import { frame, esc } from './invitations.js';

/**
 * Prepaid stays: how much of what reservations were charged was paid before
 * the guest arrived, by bank transfer or by card online, against what was
 * paid at the desk.
 *
 * A reservation is one ASSD Reservation entry: its nights, its charges and
 * every payment on it. It belongs to the month of its first night (the month
 * the guest arrived); one with no night charged belongs to the day it was
 * keyed. Guests' names are taken out of the journal before it leaves the
 * browser, so a reservation is its ASSD number and its rooms.
 *
 * On the 5th of each month the month before goes by email, through HIVE, to
 * the addresses an admin chose.
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SETTING = 'prepaid_mail';

/** What a prepaid payment line says it was: bank transfer, or card online. */
export const viaOf = (label) => (/\bCC\b|CARD|CREDIT/i.test(String(label)) ? 'online' : 'bank');

export const firstOf = (month) => `${month}-01`;
export function lastOf(month) {
  const [y, m] = month.split('-').map(Number);
  return addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1);
}
export function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** One reservation, from its stored entry. */
export function reservationOf(row) {
  let data = {};
  try { data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}); } catch { data = {}; }
  const charges = data.charges || [];
  const payments = data.payments || [];
  const nights = [...new Set(charges.filter((c) => c.date && isNight(c.code) && c.amount > 0).map((c) => c.date))].sort();
  const rooms = [...new Set(charges.filter((c) => isNight(c.code) && c.name).map((c) => c.name))];
  const charged = charges.reduce((t, c) => t + (c.amount || 0), 0);
  const prepaid = { bank: 0, online: 0, total: 0, lines: [] };
  const desk = { cash: 0, card: 0, other: 0, total: 0 };
  for (const p of payments) {
    if (p.method === 'prepaid') {
      const via = viaOf(p.label);
      prepaid[via] += p.amount;
      prepaid.total += p.amount;
      prepaid.lines.push({ via, day: p.date || null, amount: p.amount });
    } else {
      const k = p.method === 'cash' || p.method === 'card' ? p.method : 'other';
      desk[k] += p.amount;
      desk.total += p.amount;
    }
  }
  const lastNight = nights[nights.length - 1] || null;
  const arrival = nights[0] || row.day || null;
  const paid = prepaid.total + desk.total;
  return {
    seq: row.seq,
    ref: data.ref || null,
    bookedOn: row.day || null,
    bookedBy: row.staff || null,
    rooms,
    nights: nights.length,
    arrival,
    checkout: lastNight ? addDays(lastNight, 1) : null,
    charged,
    prepaid,
    desk,
    paid,
    balance: charged - paid,
    status: prepaid.total <= 0 ? 'none' : prepaid.total >= charged ? 'full' : 'part',
  };
}

async function reservationsBetween(env, from, to) {
  // Reservations with a night, or keyed, in the window; read a little wider
  // and kept by arrival, so a stay keyed early is not missed.
  const rows = await all(env.DB, `SELECT seq, staff, day, data FROM assd_entry
    WHERE kind = 'Reservation' AND (day BETWEEN ?1 AND ?2 OR EXISTS (
      SELECT 1 FROM json_each(assd_entry.data, '$.charges') c WHERE json_extract(c.value, '$.date') BETWEEN ?1 AND ?2))`, from, to);
  return rows.map(reservationOf).filter((r) => r.arrival && r.arrival >= from && r.arrival <= to);
}

/** The figures of one month's reservations. */
export function totalsOf(list) {
  const t = { count: list.length, charged: 0, prepaid: 0, bank: 0, online: 0, desk: 0, owing: 0, owingCount: 0, nights: 0, full: 0, part: 0, none: 0 };
  for (const r of list) {
    t.charged += r.charged;
    t.prepaid += r.prepaid.total;
    t.bank += r.prepaid.bank;
    t.online += r.prepaid.online;
    t.desk += r.desk.total;
    t.nights += r.nights;
    t[r.status] += 1;
    if (r.balance > 0) { t.owing += r.balance; t.owingCount += 1; }
  }
  t.share = t.charged > 0 ? t.prepaid / t.charged : null;
  return t;
}

const thisMonth = (now = new Date()) => now.toISOString().slice(0, 7);

/** The page: one month, its reservations, and the six months to it. */
export async function prepaidView(env, query = {}, { now = new Date() } = {}) {
  const month = MONTH.test(String(query.month || '')) ? query.month : shiftMonth(thisMonth(now), -1);
  const first = shiftMonth(month, -5);
  const all6 = await reservationsBetween(env, firstOf(first), lastOf(month));
  const months = [];
  for (let i = 0; i < 6; i += 1) {
    const m = shiftMonth(first, i);
    months.push({ month: m, ...totalsOf(all6.filter((r) => r.arrival.slice(0, 7) === m)) });
  }
  const list = all6.filter((r) => r.arrival.slice(0, 7) === month).sort((a, b) => (a.arrival < b.arrival ? -1 : a.arrival > b.arrival ? 1 : a.seq - b.seq));
  const uploads = await all(env.DB, "SELECT MIN(from_day) AS lo, MAX(to_day) AS hi FROM shift_upload WHERE kind = 'journal'").catch(() => []);
  return {
    month,
    totals: totalsOf(list),
    months,
    reservations: list,
    journal: uploads[0]?.hi ? { from: uploads[0].lo, to: uploads[0].hi } : null,
    mail: await mailSettings(env),
  };
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const cedis = (minor) => (minor / 100).toFixed(2);

/** Every reservation of a month, as a spreadsheet. */
export function csvOf(list) {
  const head = ['Reservation', 'ASSD number', 'Rooms', 'Arrival', 'Check-out', 'Nights', 'Charged', 'Prepaid by bank transfer', 'Prepaid by card online',
    'Prepaid', 'Paid at the desk', 'Balance', 'Status', 'Prepayment keyed', 'Keyed by'];
  const word = { full: 'Prepaid in full', part: 'Part prepaid', none: 'Not prepaid' };
  const rows = list.map((r) => [r.ref || '', r.seq, r.rooms.join('; '), r.arrival, r.checkout || '', r.nights, cedis(r.charged),
    cedis(r.prepaid.bank), cedis(r.prepaid.online), cedis(r.prepaid.total), cedis(r.desk.total), cedis(r.balance), word[r.status],
    r.prepaid.lines.map((l) => l.day).filter(Boolean).join('; '), r.bookedBy || '']);
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export async function prepaidCsv(env, query = {}) {
  const month = MONTH.test(String(query.month || '')) ? query.month : null;
  if (!month) throw badRequest('Which month? As YYYY-MM.');
  return { month, csv: csvOf(await reservationsBetween(env, firstOf(month), lastOf(month))) };
}

// ------------------------------------------------------------------ mail --

async function mailSettings(env) {
  const raw = (await getSettings(env.DB).catch(() => ({})))[SETTING];
  let s = {};
  try { s = JSON.parse(raw || '{}'); } catch { s = {}; }
  return { emails: Array.isArray(s.emails) ? s.emails : [], lastSent: s.lastSent || null, origin: s.origin || null };
}

/** An admin sets who gets the monthly summary. */
export async function saveMailSettings(env, body, { origin = null } = {}) {
  const emails = [...new Set((Array.isArray(body?.emails) ? body.emails : []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const bad = emails.find((e) => !EMAIL.test(e) || e.length > 200);
  if (bad) throw badRequest(`${bad} is not an email address.`);
  if (emails.length > 20) throw badRequest('Twenty addresses at most.');
  const current = await mailSettings(env);
  // Where Insight lives, for the email's button: the monthly run has no
  // request to read it from.
  await setSetting(env.DB, SETTING, JSON.stringify({ ...current, emails, origin: origin || current.origin || null }));
  return mailSettings(env);
}

const money = (minor) => `GH₵${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plain = (minor) => (minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`);
const monthName = (month) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDay = (day) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

/** The email for a month: subject, HTML, plain text and the CSV. */
export function summaryEmail({ month, totals, previous, list, link }) {
  const prepaid = list.filter((r) => r.status !== 'none');
  const shown = prepaid.slice(0, 60);
  const subject = `Prepaid stays, ${monthName(month)}: ${money(totals.prepaid)} (${pct(totals.share)})`;
  const cell = 'padding:7px 8px;border-bottom:1px solid #ecebe6;font-size:13px';
  const num = `${cell};text-align:right;white-space:nowrap`;
  const how = (r) => r.prepaid.lines.map((l) => `${l.via === 'online' ? 'Card online' : 'Bank'}${l.day ? `, ${shortDay(l.day)}` : ''}`).join('; ');
  const fig = (label, big, small) => `<td style="padding:10px 12px;background:#f2f1ed;border-radius:10px;vertical-align:top">
    <span style="display:block;font-size:12px;color:#4e4d49">${esc(label)}</span><strong style="font-size:17px;color:#111110">${esc(big)}</strong><br>
    <span style="font-size:12px;color:#4e4d49">${esc(small)}</span></td>`;
  const html = frame(`
    <h1 style="margin:0 0 6px;font-size:22px;color:#111110">Prepaid stays, ${esc(monthName(month))}</h1>
    <p style="margin:0 0 14px">Reservations that arrived in ${esc(monthName(month).split(' ')[0])}, and how much of them was paid before arrival.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:0 0 14px"><tr>
      ${fig('Charged', money(totals.charged), `${totals.count} reservation${totals.count === 1 ? '' : 's'}`)}
      ${fig('Prepaid', money(totals.prepaid), `${pct(totals.share)}${previous?.share != null ? ` · ${monthName(previous.month).split(' ')[0]} ${pct(previous.share)}` : ''}`)}
      ${fig('Bank transfer / card online', `${plain(totals.bank)} / ${plain(totals.online)}`, `${totals.full} in full · ${totals.part} in part`)}
    </tr></table>
    ${prepaid.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr>${['Reservation', 'Room', 'Stay', 'Charged', 'Prepaid', 'How'].map((x, i) => `<th style="${i >= 3 && i <= 4 ? num : cell};font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#4e4d49;text-align:${i >= 3 && i <= 4 ? 'right' : 'left'}">${x}</th>`).join('')}</tr>
      ${shown.map((r) => `<tr><td style="${cell}">${esc(r.ref || r.seq)}</td><td style="${cell}">${esc(r.rooms.join(', '))}</td>
        <td style="${cell}">${esc(shortDay(r.arrival))}${r.checkout ? `–${esc(shortDay(r.checkout))}` : ''}</td>
        <td style="${num}">${plain(r.charged)}</td><td style="${num}">${plain(r.prepaid.total)}</td><td style="${cell}">${esc(how(r))}</td></tr>`).join('')}
      ${prepaid.length > shown.length ? `<tr><td colspan="6" style="${cell};color:#6b6a64">… and ${prepaid.length - shown.length} more prepaid reservations, in the attached list</td></tr>` : ''}
      <tr><td style="${cell};font-weight:700">${prepaid.length} prepaid</td><td style="${cell}"></td><td style="${cell}"></td>
        <td style="${num};font-weight:700">${plain(prepaid.reduce((t, r) => t + r.charged, 0))}</td><td style="${num};font-weight:700">${plain(totals.prepaid)}</td><td style="${cell}"></td></tr>
    </table>` : '<p>No reservation that arrived this month was prepaid.</p>'}
    <p style="margin:14px 0">📎 The attached list has all ${totals.count} reservations.</p>
    ${link ? `<a href="${esc(link)}" style="display:inline-block;background:#2a78d6;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;padding:12px 20px">Open in Insight</a>` : ''}
    <p style="margin:18px 0 0;padding-top:12px;border-top:1px solid #ecebe6;font-size:12px;color:#6b6a64">You get this because an admin added this address in Insight → Money → Prepaid stays. Amounts in GH₵. Guests are identified by reservation number and room only.</p>`);
  const text = [
    `Prepaid stays, ${monthName(month)}`,
    `Charged ${money(totals.charged)} on ${totals.count} reservations; prepaid ${money(totals.prepaid)} (${pct(totals.share)}): bank transfer ${money(totals.bank)}, card online ${money(totals.online)}.`,
    `${totals.full} prepaid in full, ${totals.part} in part, ${totals.none} not prepaid.`,
    '',
    ...shown.map((r) => `${r.ref || r.seq} · ${r.rooms.join(', ')} · ${shortDay(r.arrival)} · charged ${plain(r.charged)} · prepaid ${plain(r.prepaid.total)} (${how(r)})`),
    link ? `\nOpen in Insight: ${link}` : '',
  ].join('\n');
  return { subject, html, text, csv: csvOf(list), filename: `prepaid-stays-${month}.csv` };
}

/**
 * Send a month's summary: to everyone chosen (the monthly run), or to one
 * address (an admin trying it). Each address is one email through HIVE.
 */
export async function sendSummary(env, { month, to = null, fetchImpl, origin = null, now = new Date() } = {}) {
  const m = MONTH.test(String(month || '')) ? month : shiftMonth(thisMonth(now), -1);
  const settings = await mailSettings(env);
  // The monthly run sends a month once, however often it is woken.
  if (!to && settings.lastSent?.month === m) return { sent: 0, month: m, reason: 'already sent' };
  const recipients = to ? [String(to).trim().toLowerCase()] : settings.emails;
  if (!recipients.length) return { sent: 0, reason: 'nobody gets the prepaid summary' };
  if (recipients.some((e) => !EMAIL.test(e))) throw badRequest('That is not an email address.');
  const view = await prepaidView(env, { month: m }, { now });
  const previous = view.months[view.months.length - 2] || null;
  const base = origin || settings.origin || null;
  const mail = summaryEmail({ month: m, totals: view.totals, previous, list: view.reservations, link: base ? `${base}/#/prepaid?month=${m}` : null });
  const attachments = [{ filename: mail.filename, content: btoa(unescape(encodeURIComponent(mail.csv))) }];
  let sent = 0;
  const failed = [];
  for (const one of recipients) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await callLink({
        binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/mail',
        body: { to: one, subject: mail.subject, html: mail.html, text: mail.text, kind: 'insight_prepaid', senderName: 'Insight', attachments },
      });
      sent += 1;
    } catch (err) { failed.push(`${one}: ${err.message}`); }
  }
  if (!to && sent) await setSetting(env.DB, SETTING, JSON.stringify({ ...settings, lastSent: { at: now.toISOString(), month: m, count: sent } }));
  return { sent, month: m, failed };
}
