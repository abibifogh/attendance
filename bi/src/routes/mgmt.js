import { first, getSettings, setSetting } from '../lib/db.js';
import { addDays, dow, isDay, isoWeek, todayIn } from '../lib/dates.js';
import { badRequest } from '../lib/http.js';
import { callLink, signLink } from '../lib/link.js';
import { frame, esc } from './invitations.js';
import { adminEmails } from './prepaid.js';

/**
 * The management report: a week or a month of the other systems, on one
 * page and in one email.
 *
 * Each system works out its own figures and Insight only asks for them, so
 * what the report says is what that system's own screens say:
 *
 * - Breakfast (the breakfast app, /api/link/report): food used at cost,
 *   guests, cost per guest and what moved it, deliveries, the bakery, stock
 *   below its reorder level, counts against the books.
 * - Maintenance (the maintenance database's `report` function): the room
 *   rounds, the jobs, each artisan's score as its Productivity page gives it,
 *   the store's parts used and stock.
 *
 * Each call is signed with that system's own secret (lib/link.js), the same
 * signature the till link and Approvals use. A system that cannot be reached
 * is said, and the rest of the report is still made.
 *
 * Then the few things worth a decision, from every system, most serious
 * first: "Needs your attention". More systems join as sections of their own.
 *
 * The email goes when an admin presses Send. Sending by itself (Monday
 * morning for the week before, the 1st for the month before) is off until an
 * admin switches it on. It goes to Insight's admins and whoever else an admin
 * adds.
 */

const SETTING = 'mgmt_report';
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// ------------------------------------------------------------------ words --

const cedis = (x, dp = 0) => (x == null || !Number.isFinite(Number(x)) ? '—'
  : `${Number(x) < 0 ? '−' : ''}GH₵ ${Math.abs(Number(x)).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const count = (n) => (n == null ? '—' : Number(n).toLocaleString('en-GB'));
const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
const pctWords = (p) => (p == null ? null : `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(Math.abs(p) < 10 ? 1 : 0).replace(/\.0$/, '')}%`);
const at = (day, opts) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
const dayShort = (day) => at(day, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
const monthName = (m) => at(`${m}-15`, { month: 'long', year: 'numeric' });
const listWords = (xs, max = 5) => (xs.length <= max ? xs.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`);
const tone = (score) => (score == null ? 'none' : score >= 80 ? 'good' : score >= 65 ? 'warn' : 'bad');

// ---------------------------------------------------------------- periods --

const mondayOf = (day) => addDays(day, 1 - dow(day));
const lastOfMonth = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0, 12)).toISOString().slice(0, 10); };
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const i = y * 12 + (mo - 1) + n; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };
const weekNo = (day) => Number(isoWeek(day).slice(-2));

/**
 * The period asked for. A week by any day in it, a month by YYYY-MM. With
 * nothing asked: the last week that is over, or this month so far.
 */
export function periodOf({ period = 'week', at: asked } = {}, today) {
  if (period === 'month') {
    const m = MONTH.test(String(asked || '')) ? asked : isDay(asked) ? asked.slice(0, 7) : today.slice(0, 7);
    const from = `${m}-01`;
    const to = lastOfMonth(m);
    const prev = shiftMonth(m, -1);
    const running = to >= today && from <= today;
    const left = running ? Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 864e5) + 1 : 0;
    return {
      period: 'month', key: m, from, to, prevFrom: `${prev}-01`, prevTo: lastOfMonth(prev), running,
      title: monthName(m),
      label: running ? `${monthName(m)} · ${at(from, { day: 'numeric' })} – ${at(addDays(today, -1) < from ? from : addDays(today, -1), { day: 'numeric', month: 'short' })}, ${plural(left, 'day')} to go` : monthName(m),
      vs: `against ${at(`${prev}-15`, { month: 'long' })}`,
      prevName: at(`${prev}-15`, { month: 'long' }),
      before: shiftMonth(m, -1), after: shiftMonth(m, 1),
      latest: m >= today.slice(0, 7),
    };
  }
  const from = mondayOf(isDay(asked) ? asked : addDays(today, -7));
  const to = addDays(from, 6);
  const running = to >= today && from <= today;
  return {
    period: 'week', key: from, from, to, prevFrom: addDays(from, -7), prevTo: addDays(from, -1), running,
    title: `Week ${weekNo(from)}`,
    label: `Week ${weekNo(from)} · ${dayShort(from).replace(/ \S+$/, '')} – ${dayShort(to)} ${to.slice(0, 4)}${running ? ' · still running' : ''}`,
    vs: `against week ${weekNo(addDays(from, -7))}`,
    prevName: 'last week',
    before: addDays(from, -7), after: addDays(from, 7),
    latest: addDays(from, 7) > today,
  };
}

// -------------------------------------------------------------- the asking --

async function ask({ url, secret, path, body, fetchImpl, what }) {
  const text = JSON.stringify(body ?? {});
  const headers = { 'Content-Type': 'application/json', ...(await signLink(secret, path, text)) };
  let response;
  try { response = await fetchImpl(url, { method: 'POST', headers, body: text }); } catch (err) { throw new Error(`${what} could not be reached: ${err.message}`); }
  const data = await response.json().catch(() => ({}));
  if (response.status === 404 && !data?.error) throw new Error(`${what} does not answer the management report yet: its update is not deployed.`);
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `${what} answered ${response.status}.`);
  return data;
}

/** Where the breakfast app is: BREAKFAST_URL, or the address it has under Accounts › Systems. */
async function breakfastBase(env) {
  if (env.BREAKFAST_URL) return String(env.BREAKFAST_URL).trim().replace(/\/+$/, '');
  const row = await first(env.DB, "SELECT home_url, sso_url FROM systems WHERE id = 'breakfast'").catch(() => null);
  const url = row?.home_url || row?.sso_url;
  try { return url ? new URL(url).origin : null; } catch { return null; }
}

async function askBreakfast(env, p, fetchImpl) {
  const base = await breakfastBase(env);
  if (!env.SSO_SECRET_BREAKFAST) throw new Error('Breakfast is not linked: Insight has no SSO_SECRET_BREAKFAST. Run Actions › "Set Insight\'s secrets" in the attendance repository with Insight\'s address in the box.');
  if (!base) throw new Error('Breakfast is not linked: Insight does not know its address. Set it under Accounts › Where each system lives.');
  const body = p.period === 'month' ? { period: 'month', month: p.key } : { period: 'week', week: p.from };
  return ask({ url: `${base}/api/link/report`, secret: env.SSO_SECRET_BREAKFAST, path: '/api/link/report', body, fetchImpl, what: 'The breakfast app' });
}

/** The maintenance database's report function: MAINTENANCE_REPORT_URL, or next to its approvals function. */
const maintenanceUrl = (env) => env.MAINTENANCE_REPORT_URL
  || (env.MAINTENANCE_APPROVALS_URL ? String(env.MAINTENANCE_APPROVALS_URL).replace(/\/approvals\/?$/, '/report') : null);

async function askMaintenance(env, body, fetchImpl) {
  const url = maintenanceUrl(env);
  if (!env.SSO_SECRET_MAINTENANCE) throw new Error('Maintenance is not linked: Insight has no SSO_SECRET_MAINTENANCE. Add INSIGHT_SSO_SECRET_MAINTENANCE to the attendance repository\'s secrets and run Actions › "Set Insight\'s secrets".');
  if (!url) throw new Error('Maintenance is not linked: Insight does not know its address (MAINTENANCE_APPROVALS_URL in wrangler.toml).');
  return ask({ url, secret: env.SSO_SECRET_MAINTENANCE, path: '/report', body, fetchImpl, what: 'Maintenance' });
}

const settle = (promise) => promise.then((data) => ({ ok: true, data }), (err) => ({ ok: false, error: String(err?.message || err) }));

// ------------------------------------------------------------- breakfast --

/** The breakfast app's answer, as the page and the email draw it. */
export function breakfastSection(d, p, today) {
  const i = d.insights || {};
  const cur = i.current || {};
  const prev = i.previous || {};
  const week = p.period === 'week';

  // Cost per guest: each morning of a week, each week of a month.
  const series = week
    ? (i.series || []).map((s) => ({ label: at(s.day, { weekday: 'short' }), value: s.recorded ? s.costPerGuest : null, day: s.day }))
    : (i.weeks || []).map((w) => ({ label: `Wk ${weekNo(w.weekStart)}`, value: w.costPerGuest, day: w.weekStart }));

  // What moved the cost per guest: each item's share of a guest, now and before.
  const rows = week ? [...(i.risers || []), ...(i.fallers || [])] : (i.ingredients || []);
  const seen = new Set();
  const movers = rows.filter((r) => { const k = r.ingredientId ?? r.name; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((r) => {
      const now = cur.guests ? (Number(r.cost) || 0) / cur.guests : null;
      const before = prev.guests ? (Number(r.prevCost) || 0) / prev.guests : null;
      return { name: r.name, now, before, change: now != null && before != null ? now - before : null };
    })
    .filter((m) => m.change != null && Math.abs(m.change) >= 0.005)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 6)
    .sort((a, b) => b.change - a.change);

  // Deliveries: the five biggest suppliers and the rest together.
  const sup = d.suppliers || [];
  const suppliers = sup.length > 6
    ? [...sup.slice(0, 5), { name: 'Other', value: sup.slice(5).reduce((t, s) => t + s.value, 0) }]
    : sup;
  const delivered = sup.reduce((t, s) => t + (Number(s.value) || 0), 0);

  // Days a breakfast was due: up to yesterday in a period still running.
  const lastDue = p.to < today ? p.to : addDays(today, -1);
  let due = 0;
  for (let x = p.from; x <= lastDue; x = addDays(x, 1)) due += 1;
  const missing = d.missingDays || [];

  const stock = d.stock || {};
  const reorder = (stock.reorder || []).map((r) => ({
    name: r.name, unit: r.unit || '', stock: r.stock, par: r.parLevel, daysCover: r.daysCover, status: r.status,
  }));
  const short = (stock.shrinkage || []).filter((r) => Number(r.countVarianceValue) < 0);
  const projection = i.projection || null;

  return {
    ok: true,
    note: i.partial?.note || null,
    cost: cur.cost ?? null,
    prevCost: prev.cost ?? null,
    costChange: i.deltas?.cost ?? null,
    perGuest: cur.costPerGuest ?? null,
    prevPerGuest: prev.costPerGuest ?? null,
    perGuestChange: i.deltas?.costPerGuest ?? null,
    guests: cur.guests ?? 0,
    inhouse: cur.inhouse ?? 0,
    outside: cur.outside ?? 0,
    projection: projection ? { cost: projection.projectedCost, guests: projection.projectedGuests } : null,
    prevFullCost: i.previousFullMonth?.cost ?? null,
    figures: [
      { label: 'In-house guests', now: count(cur.inhouse), before: count(prev.inhouse) },
      { label: 'Outside guests', now: count(cur.outside), before: count(prev.outside) },
      { label: 'Outside guests paid', now: cedis(cur.revenue), before: cedis(prev.revenue) },
      { label: 'Food used, at cost', now: cedis(cur.cost), before: cedis(prev.cost) },
      { label: 'Per guest', now: cedis(cur.costPerGuest, 2), before: cedis(prev.costPerGuest, 2) },
      { label: 'Deliveries', now: cedis(delivered), before: '' },
      { label: 'Baked in-house', now: d.bakery?.runs ? `${count(d.bakery.qty)} · ${cedis(d.bakery.value)}` : '—', before: '' },
    ],
    series,
    reference: prev.costPerGuest ?? null,
    movers,
    suppliers,
    delivered,
    days: { due, recorded: Math.max(0, due - missing.length), missing },
    reorder,
    stockValue: stock.totalValue ?? null,
    short: { value: short.reduce((t, r) => t + Number(r.countVarianceValue), 0), names: short.slice(0, 4).map((r) => r.name) },
  };
}

// ----------------------------------------------------------- maintenance --

/** The maintenance database's answer, with the period before it for the comparisons. */
export function maintenanceSection(d, before) {
  const r = d.rounds || {};
  return {
    ok: true,
    ...d,
    roundsShare: r.rooms?.total ? (r.rooms.done / r.rooms.total) : null,
    before: before ? {
      team: before.team ?? null,
      jobsDone: before.jobs?.done ?? null,
      usedValue: before.store?.usedValue ?? null,
      roundsShare: before.rounds?.rooms?.total ? before.rounds.rooms.done / before.rounds.rooms.total : null,
    } : null,
  };
}

// ----------------------------------------------------- tiles and attention --

/** The eight figures at the top. */
export function tilesOf(p, bf, mx) {
  const off = (label, source, why) => ({ label, value: '—', sub: why, tone: 'none', source });
  const out = [];
  if (bf?.ok) {
    const sub = p.period === 'month' && bf.projection
      ? `on course for ${cedis(bf.projection.cost)}${bf.prevFullCost != null ? ` · ${p.prevName} ${cedis(bf.prevFullCost)}` : ''}`
      : bf.costChange != null ? `${pctWords(bf.costChange)} on ${p.prevName}` : 'nothing to compare with';
    const pg = bf.perGuest != null && bf.prevPerGuest != null ? bf.perGuest - bf.prevPerGuest : null;
    out.push(
      { label: 'Breakfast food cost', value: cedis(bf.cost), sub, tone: bf.costChange >= 10 ? 'warn' : 'none', source: 'Breakfast' },
      {
        label: 'Food cost per guest', value: cedis(bf.perGuest, 2),
        sub: pg == null ? 'nothing to compare with' : `${pg >= 0 ? '+' : '−'}${cedis(Math.abs(pg), 2)} on ${p.prevName}`,
        tone: bf.perGuestChange == null ? 'none' : bf.perGuestChange >= 5 ? 'bad' : bf.perGuestChange >= 2 ? 'warn' : bf.perGuestChange <= -2 ? 'good' : 'none',
        source: 'Breakfast',
      },
      { label: 'Guests at breakfast', value: count(bf.guests), sub: `${count(bf.inhouse)} in-house · ${count(bf.outside)} outside`, tone: 'none', source: 'Breakfast' },
      {
        label: 'Breakfast days recorded', value: `${bf.days.recorded} of ${bf.days.due}`,
        sub: bf.days.missing.length ? `missing: ${listWords(bf.days.missing.map(dayShort), 3)}` : bf.days.due ? 'every day recorded' : 'no day due yet',
        tone: bf.days.missing.length ? 'warn' : bf.days.due ? 'good' : 'none', source: 'Breakfast',
      },
    );
  } else if (!bf?.skipped) {
    const why = bf?.error ? 'could not be read' : 'not linked';
    out.push(off('Breakfast food cost', 'Breakfast', why), off('Food cost per guest', 'Breakfast', why), off('Guests at breakfast', 'Breakfast', why), off('Breakfast days recorded', 'Breakfast', why));
  }
  if (mx?.ok) {
    const rooms = mx.rounds?.rooms || { done: 0, total: 0 };
    const missed = (mx.rounds?.missed || []).length;
    const share = mx.roundsShare;
    const teamChange = mx.team != null && mx.before?.team != null ? mx.team - mx.before.team : null;
    out.push(
      p.period === 'week'
        ? { label: 'Rooms on the rounds', value: `${rooms.done} of ${rooms.total}`, sub: p.running ? 'the week is still running' : missed ? `${missed} missed` : 'every room visited', tone: p.running ? 'none' : missed ? 'warn' : 'good', source: 'Maintenance' }
        : { label: 'Rounds coverage', value: share == null ? '—' : `${Math.round(share * 100)}%`, sub: `${count(rooms.done)} of ${count(rooms.total)} room visits`, tone: share == null ? 'none' : share >= 0.95 ? 'good' : 'warn', source: 'Maintenance' },
      { label: 'Jobs done', value: count(mx.jobs?.done), sub: `${count(mx.jobs?.reported)} reported · ${count(mx.jobs?.open)} open`, tone: mx.jobs?.late?.length ? 'warn' : 'none', source: 'Maintenance' },
      {
        label: 'Team score', value: mx.team == null ? '—' : `${mx.team} / 100`,
        sub: teamChange == null ? 'out of 100' : `${teamChange > 0 ? '+' : teamChange < 0 ? '−' : '±'}${Math.abs(teamChange)} on ${p.prevName}`,
        tone: teamChange != null && teamChange <= -5 && tone(mx.team) === 'good' ? 'warn' : tone(mx.team), source: 'Maintenance',
      },
      { label: 'Store parts used', value: cedis(mx.store?.usedValue), sub: `${plural(mx.store?.issues ?? 0, 'part', 'parts')} issued`, tone: 'none', source: 'Maintenance' },
    );
  } else if (!mx?.skipped) {
    const why = mx?.error ? 'could not be read' : 'not linked';
    out.push(off(p.period === 'week' ? 'Rooms on the rounds' : 'Rounds coverage', 'Maintenance', why), off('Jobs done', 'Maintenance', why), off('Team score', 'Maintenance', why), off('Store parts used', 'Maintenance', why));
  }
  return out;
}

/** The few things worth a decision, from every system, most serious first. */
export function attentionOf(p, bf, mx) {
  const out = [];
  const add = (level, text, source) => out.push({ level, text, source });
  if (bf && !bf.ok && !bf.skipped) add('warn', `Breakfast could not be read: ${bf.error}`, 'Breakfast');
  if (bf?.ok) {
    if (bf.perGuestChange != null && bf.perGuestChange >= 5) {
      const top = bf.movers.find((m) => m.change > 0);
      add(bf.perGuestChange >= 10 ? 'bad' : 'warn',
        `Food cost per guest was ${cedis(bf.perGuest, 2)}, ${pctWords(bf.perGuestChange)} on ${p.prevName}${top ? `. Most of it: ${top.name}, ${cedis(top.now, 2)} a guest from ${cedis(top.before, 2)}` : ''}.`, 'Breakfast');
    } else if (bf.perGuestChange != null && bf.perGuestChange <= -5) {
      add('good', `Food cost per guest came down to ${cedis(bf.perGuest, 2)}, ${pctWords(bf.perGuestChange)} on ${p.prevName}.`, 'Breakfast');
    }
    if (bf.days.missing.length) add('warn', `Breakfast was not recorded on ${listWords(bf.days.missing.map(dayShort), 4)}: the figures leave ${bf.days.missing.length === 1 ? 'that day' : 'those days'} out.`, 'Breakfast');
    const negative = bf.reorder.filter((r) => r.status === 'negative');
    const low = bf.reorder.filter((r) => r.status !== 'negative');
    if (negative.length) add('bad', `${listWords(negative.map((r) => r.name), 4)} show${negative.length === 1 ? 's' : ''} less than nothing in stock: deliveries or counts are missing.`, 'Breakfast');
    if (low.length) add('warn', `${plural(low.length, 'breakfast item')} below the reorder level or running out: ${listWords(low.map((r) => r.name), 4)}.`, 'Breakfast');
    if (bf.short.value <= -50) add('warn', `The last counts came out ${cedis(-bf.short.value)} short of the books (${listWords(bf.short.names, 3)}).`, 'Breakfast');
  }
  if (mx && !mx.ok && !mx.skipped) add('warn', `Maintenance could not be read: ${mx.error}`, 'Maintenance');
  if (mx?.ok) {
    const late = mx.jobs?.late || [];
    if (late.length) add('bad', `${plural(late.length, 'time-sensitive job')} past due: ${listWords(late.map((j) => `${j.room} ${String(j.description || j.category).toLowerCase()} (${plural(j.daysLate, 'day')})`), 3)}.`, 'Maintenance');
    const urgent = (mx.jobs?.urgentOpen || 0);
    if (urgent) add('warn', `${plural(urgent, 'urgent job')} still open.`, 'Maintenance');
    const missed = mx.rounds?.missed || [];
    if (missed.length) add('warn', `${plural(missed.length, 'room or area', 'rooms and areas')} missed on the rounds: ${listWords([...new Set(missed)], 6)}.`, 'Maintenance');
    else if (!p.running && mx.rounds?.rooms?.total) add('good', 'Every room and area was visited on the rounds.', 'Maintenance');
    const overdue = mx.store?.tools?.overdue || [];
    if (overdue.length) add('warn', `${plural(overdue.length, 'tool')} not brought back: ${listWords(overdue.map((t) => `${t.tool} with ${t.with} (${plural(t.daysOver, 'day')})`), 3)}.`, 'Maintenance');
    if (mx.store?.belowParCount) add('warn', `${plural(mx.store.belowParCount, 'store part')} below the reorder level: ${listWords((mx.store.belowPar || []).map((x) => x.name), 4)}.`, 'Maintenance');
    if (mx.store?.counts?.waiting) add('warn', `${plural(mx.store.counts.waiting, 'store count')} waiting to be approved.`, 'Maintenance');
    const drop = mx.team != null && mx.before?.team != null ? mx.team - mx.before.team : null;
    if (drop != null && drop <= -5) add('warn', `The team score fell to ${mx.team} from ${mx.before.team}.`, 'Maintenance');
    const weak = (mx.artisans || []).filter((a) => a.score != null && a.score < 65);
    if (weak.length) add('warn', `${listWords(weak.map((a) => `${a.name} (${a.score})`), 3)} scored under 65.`, 'Maintenance');
  }
  const rank = { bad: 0, warn: 1, good: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ------------------------------------------------------------- the report --

/** The whole report for a period. Never throws for a system that cannot be reached. */
/** The sections a report can leave out, in the order they are shown. */
export const SECTIONS = [{ key: 'breakfast', label: 'Breakfast' }, { key: 'maintenance', label: 'Maintenance' }];

/** The sections to leave out: a list or "a,b", only ones that exist. */
export function skipOf(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const known = new Set(SECTIONS.map((x) => x.key));
  return [...new Set(list.map((x) => String(x).trim()).filter((x) => known.has(x)))];
}

const SKIPPED = { ok: false, skipped: true };

export async function managementReport(env, query = {}, { fetchImpl = fetch, today = todayIn('UTC'), now = new Date() } = {}) {
  const p = periodOf({ period: query.period, at: query.at }, today);
  // A section left out is not asked for at all.
  const skip = skipOf(query.skip);
  const [bfRaw, mxRaw, mxBefore] = await Promise.all([
    skip.includes('breakfast') ? null : settle(askBreakfast(env, p, fetchImpl)),
    skip.includes('maintenance') ? null : settle(askMaintenance(env, { from: p.from, to: p.to, today }, fetchImpl)),
    skip.includes('maintenance') ? null : settle(askMaintenance(env, { from: p.prevFrom, to: p.prevTo, today }, fetchImpl)),
  ]);
  const breakfast = !bfRaw ? SKIPPED : bfRaw.ok ? breakfastSection(bfRaw.data, p, today) : { ok: false, error: bfRaw.error };
  const maintenance = !mxRaw ? SKIPPED : mxRaw.ok ? maintenanceSection(mxRaw.data, mxBefore.ok ? mxBefore.data : null) : { ok: false, error: mxRaw.error };
  return {
    ...p,
    today,
    made: now.toISOString(),
    skip,
    sections: SECTIONS,
    tiles: tilesOf(p, breakfast, maintenance),
    attention: attentionOf(p, breakfast, maintenance),
    breakfast,
    maintenance,
  };
}

// --------------------------------------------------------------- the email --

/** Who gets it: Insight's admins (unless switched off) and the addresses added. */
export async function mailSettings(env) {
  let s = {};
  try { s = JSON.parse((await getSettings(env.DB).catch(() => ({})))[SETTING] || '{}'); } catch { s = {}; }
  return {
    admins: s.admins !== false,
    // Sending by itself: off until an admin switches it on.
    auto: s.auto === true,
    // The sections sending by itself leaves out.
    skip: skipOf(s.skip),
    weekly: s.weekly !== false,
    monthly: s.monthly !== false,
    emails: Array.isArray(s.emails) ? s.emails : [],
    origin: s.origin || null,
    lastSent: s.lastSent || {},
  };
}

export async function saveMailSettings(env, body, { origin = null } = {}) {
  const emails = [...new Set((Array.isArray(body?.emails) ? body.emails : []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const bad = emails.find((e) => !EMAIL.test(e) || e.length > 200);
  if (bad) throw badRequest(`${bad} is not an email address.`);
  if (emails.length > 20) throw badRequest('Twenty addresses at most.');
  const current = await mailSettings(env);
  const flag = (k) => (body?.[k] === undefined ? current[k] : Boolean(body[k]));
  await setSetting(env.DB, SETTING, JSON.stringify({
    ...current, emails, admins: flag('admins'), auto: flag('auto'), skip: body?.skip === undefined ? current.skip : skipOf(body.skip), weekly: flag('weekly'), monthly: flag('monthly'), origin: origin || current.origin || null,
  }));
  return { ...(await mailSettings(env)), adminEmails: await adminEmails(env) };
}

/** The report as an email: the figures, what needs attention, the two sections in short, and the link. */
export function reportEmail(r, link) {
  const cell = 'padding:6px 8px;border-bottom:1px solid #ecebe6;font-size:13px';
  const num = `${cell};text-align:right;white-space:nowrap`;
  // Each part under a rule of its own, so the sections read apart.
  const head = (t) => `<h2 style="margin:24px 0 10px;padding-top:14px;border-top:2px solid #e1e0d9;font-size:16px;color:#111110">${t}</h2>`;
  const colour = { bad: '#a32121', warn: '#8a5a00', good: '#006300', none: '#4e4d49' };
  const tilesHtml = [0, 2, 4, 6].map((n) => `<tr>${r.tiles.slice(n, n + 2).map((t) => `<td width="50%" style="padding:10px 12px;background:#f2f1ed;border-radius:10px;vertical-align:top">
      <span style="display:block;font-size:12px;color:#4e4d49">${esc(t.label)}</span><strong style="font-size:17px;color:#111110">${esc(t.value)}</strong><br>
      <span style="font-size:12px;color:${colour[t.tone] || colour.none}">${esc(t.sub)}</span></td>`).join('')}</tr>`).join('');
  const attention = r.attention.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${r.attention.map((a) => `<tr><td style="${cell};width:18px;color:${colour[a.level]};font-weight:800">${a.level === 'good' ? '✓' : '!'}</td><td style="${cell}">${esc(a.text)}</td><td style="${cell};color:#898781;font-size:11px;white-space:nowrap">${esc(a.source)}</td></tr>`).join('')}</table>`
    : '<p>Nothing stands out.</p>';
  const bf = r.breakfast;
  const breakfast = bf?.ok
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <tr><th style="${cell}"></th><th style="${num};font-size:11px;color:#4e4d49">This ${r.period}</th><th style="${num};font-size:11px;color:#4e4d49">${esc(r.prevName[0].toUpperCase() + r.prevName.slice(1))}</th></tr>
        ${bf.figures.map((f) => `<tr><td style="${cell}">${esc(f.label)}</td><td style="${num}">${esc(f.now)}</td><td style="${num};color:#898781">${esc(f.before)}</td></tr>`).join('')}</table>
       ${bf.movers.length ? `<p style="margin:10px 0 0;font-size:13px">What moved the cost per guest: ${esc(bf.movers.map((m) => `${m.name} ${m.change > 0 ? '+' : '−'}${Math.abs(m.change).toFixed(2)}`).join(' · '))} (GH₵ a guest).</p>` : ''}`
    : `<p style="color:#8a5a00">${esc(bf?.error || 'Not linked.')}</p>`;
  const mx = r.maintenance;
  const maintenance = mx?.ok
    ? `<p style="margin:0 0 8px;font-size:13px">Rounds: ${mx.rounds.rooms.done} of ${mx.rounds.rooms.total} room visits, ${mx.rounds.areas.done} of ${mx.rounds.areas.total} areas; ${mx.rounds.faults} faults found, ${mx.rounds.fixed} fixed on the spot, ${mx.rounds.toJobs} became jobs.<br>
        Jobs: ${mx.jobs.reported} reported, ${mx.jobs.done} done, ${mx.jobs.open} open${mx.jobs.medianFixDays != null ? `; half were fixed within ${mx.jobs.medianFixDays} days` : ''}.<br>
        Store: ${cedis(mx.store.usedValue)} of parts used; ${mx.store.belowParCount} below the reorder level; ${mx.store.tools.out} tools out.</p>
       ${mx.artisans.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <tr><th style="${cell};text-align:left;font-size:11px;color:#4e4d49">Artisan</th><th style="${num};font-size:11px;color:#4e4d49">Score</th><th style="${num};font-size:11px;color:#4e4d49">Jobs done</th><th style="${num};font-size:11px;color:#4e4d49">Carried over</th></tr>
        ${mx.artisans.map((a) => `<tr><td style="${cell}">${esc(a.name)}</td><td style="${num};color:${colour[tone(a.score)]};font-weight:700">${a.score ?? '—'}</td><td style="${num}">${a.done}</td><td style="${num}">${a.carried}</td></tr>`).join('')}</table>` : ''}`
    : `<p style="color:#8a5a00">${esc(mx?.error || 'Not linked.')}</p>`;

  const subject = `Management report, ${r.period === 'week' ? r.label.split(' · ')[0] : r.title}`;
  const html = frame(`
    <h1 style="margin:0 0 4px;font-size:22px;color:#111110">Management report</h1>
    <p style="margin:0 0 14px;color:#4e4d49">${esc(r.label)} · ${esc(r.vs)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:0 0 6px">${tilesHtml}</table>
    ${head('Needs your attention')}${attention}
    ${bf?.skipped ? '' : `${head('☕ Breakfast')}${breakfast}`}
    ${mx?.skipped ? '' : `${head('🔧 Maintenance')}${maintenance}`}
    ${r.skip?.length ? `<p style="margin:16px 0 0;font-size:13px;color:#6b6a64">Left out of this report: ${esc(r.sections.filter((x) => r.skip.includes(x.key)).map((x) => x.label).join(', '))}.</p>` : ''}
    ${link ? `<p style="margin:18px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#2a78d6;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;padding:12px 20px">Open the full report</a></p>` : ''}
    <p style="margin:18px 0 0;padding-top:12px;border-top:1px solid #ecebe6;font-size:12px;color:#6b6a64">You get this because you are an admin in Insight, or an admin added this address under Reports › Management. The full report, with the charts, opens in Insight and prints to PDF from there.</p>`);
  const text = [
    `Management report — ${r.label} (${r.vs})`,
    '',
    ...r.tiles.map((t) => `${t.label}: ${t.value} (${t.sub})`),
    '',
    'Needs your attention:',
    ...(r.attention.length ? r.attention.map((a) => `${a.level === 'good' ? '✓' : '!'} ${a.text} [${a.source}]`) : ['Nothing stands out.']),
    '',
    ...(mx?.ok ? ['Artisans:', ...mx.artisans.map((a) => `${a.name}: ${a.score ?? '—'} · ${a.done} done · ${a.carried} carried over`)] : []),
    link ? `\nOpen the full report: ${link}` : '',
  ].join('\n');
  return { subject, html, text };
}

/**
 * Send a period's report.
 *
 * - `auto`: Monday's run (the week before) or the 1st's (the month before),
 *   only when an admin switched sending by itself on. A period already sent
 *   is skipped.
 * - `to`: one address, somebody trying it. Always goes.
 * - otherwise: everybody it goes to, pressed by an admin.
 */
export async function sendReport(env, { period = 'week', at: asked, skip = null, to = null, auto = false, origin = null, fetchImpl = fetch, today = todayIn('UTC'), now = new Date() } = {}) {
  const settings = await mailSettings(env);
  const p = periodOf({ period, at: asked }, today);
  if (auto && (!settings.auto || !settings[p.period === 'week' ? 'weekly' : 'monthly'])) return { sent: 0, key: p.key, reason: 'switched off' };
  if (auto && settings.lastSent?.[p.period] === p.key) return { sent: 0, key: p.key, reason: 'already sent' };
  const recipients = to
    ? [String(to).trim().toLowerCase()]
    : [...new Set([...(settings.admins ? await adminEmails(env) : []), ...settings.emails])];
  if (!recipients.length) return { sent: 0, key: p.key, reason: 'nobody gets the management report' };
  if (recipients.some((e) => !EMAIL.test(e))) throw badRequest('That is not an email address.');

  // Pressed: the sections chosen on the page. By itself: the ones saved for it.
  const left = skipOf(auto ? settings.skip : skip);
  const report = await managementReport(env, { period: p.period, at: p.key, skip: left }, { fetchImpl, today, now });
  const base = origin || settings.origin || null;
  const mail = reportEmail(report, base ? `${base}/#/management?period=${p.period}&at=${p.key}${left.length ? `&skip=${left.join(',')}` : ''}` : null);
  let sent = 0;
  const failed = [];
  for (const one of recipients) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await callLink({
        binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/mail',
        body: { to: one, subject: mail.subject, html: mail.html, text: mail.text, kind: 'insight_management', senderName: 'Insight' },
      });
      sent += 1;
    } catch (err) { failed.push(`${one}: ${err.message}`); }
  }
  if (!to && sent) {
    const fresh = await mailSettings(env);
    await setSetting(env.DB, SETTING, JSON.stringify({ ...fresh, lastSent: { ...fresh.lastSent, [p.period]: p.key, at: now.toISOString(), by: auto ? 'schedule' : 'by hand' } }));
  }
  return { sent, key: p.key, failed };
}

/** The morning run: on Mondays the week before, on the 1st the month before. */
export async function sendDue(env, { day = todayIn('UTC'), fetchImpl = fetch } = {}) {
  const out = [];
  if (dow(day) === 1) out.push(await sendReport(env, { period: 'week', at: addDays(day, -7), auto: true, fetchImpl, today: day }).catch((err) => ({ error: String(err?.message || err) })));
  if (day.endsWith('-01')) out.push(await sendReport(env, { period: 'month', at: shiftMonth(day.slice(0, 7), -1), auto: true, fetchImpl, today: day }).catch((err) => ({ error: String(err?.message || err) })));
  return out;
}
