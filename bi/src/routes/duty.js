import { all, getSettings, run, setSetting } from '../lib/db.js';
import { badRequest } from '../lib/http.js';
import { callLink } from '../lib/link.js';
import { frame, esc } from './invitations.js';
import { adminEmails } from './prepaid.js';
import { gather, arrange } from './assistant.js';
import * as mgmt from './mgmt.js';
import { requireAdmin } from './till.js';

/**
 * What supervisors are held to, by email, on Accra's clock (UTC).
 *
 * - **The morning digest**, 07:00 every day: each supervisor's own Assistant
 *   list (what is waiting on them, what is going wrong), with the admins
 *   copied. Nothing pending, nothing sent.
 * - **The Saturday management report**: one supervisor an admin chooses sends
 *   this week's report (Monday to Friday) to everybody by 10:00 on Saturday.
 *   They are reminded at 17:00 on Friday and 09:00 on Saturday; if it has not
 *   gone they are told at 10:00 and 12:00, with the admins copied; and at
 *   14:00, more than four hours late, GH₵50 comes off their bonus in HIVE and
 *   they and the admins are told. Each step happens once a week.
 *
 * An hourly schedule runs `dutyDue`; each step is kept in a log, so the same
 * hour run twice does nothing twice.
 */

const SETTING = 'mgmt_duty';
const LOG = 'mgmt_duty_log';
const DEFAULT_AMOUNT = 5000;
export const DUE_HOUR = 10;
export const DOCK_HOUR = 14;
const DAY = 86_400_000;

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
const plusDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
/** The Monday of the week `day` is in. */
export const mondayOf = (day) => plusDays(day, -((weekday(day) + 6) % 7));
const cedis = (minor) => `GH₵${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** Active accounts with Insight as a supervisor, as `roleOf` reads an account. */
export async function supervisors(env) {
  const rows = await all(env.DB, `SELECT a.id, a.name, a.email FROM accounts a
    JOIN account_access x ON x.account_id = a.id AND x.system_id = 'insight' AND x.role = 'supervisor'
    WHERE a.active = 1 ORDER BY a.name, a.email`).catch(() => []);
  return rows.map((r) => ({ id: Number(r.id), name: r.name || r.email, email: r.email || null, access: [{ systemId: 'insight', role: 'supervisor' }] }));
}

// ------------------------------------------------------------- the settings --

export async function dutySettings(env) {
  let s = {};
  try { s = JSON.parse((await getSettings(env.DB).catch(() => ({})))[SETTING] || '{}'); } catch { s = {}; }
  return { on: s.on === true, accountId: Number(s.accountId) || null, amount: Number(s.amount) || DEFAULT_AMOUNT, digest: s.digest !== false };
}

/** An admin's: who sends the Saturday report, whether it is on, and whether the morning digest goes. */
export async function saveDuty(env, body, account) {
  await requireAdmin(account);
  const current = await dutySettings(env);
  const accountId = body?.accountId === undefined ? current.accountId : (Number(body.accountId) || null);
  const people = await supervisors(env);
  const person = accountId ? people.find((p) => p.id === accountId) : null;
  if (accountId && !person) throw badRequest('Choose one of the supervisors.');
  const on = body?.on === undefined ? current.on : Boolean(body.on);
  if (on && !person) throw badRequest('Choose the supervisor who sends it first.');
  if (on && !person.email) throw badRequest(`${person.name} has no email address, so they cannot be reminded.`);
  const digest = body?.digest === undefined ? current.digest : Boolean(body.digest);
  await setSetting(env.DB, SETTING, JSON.stringify({ on, accountId, amount: current.amount, digest }));
  // They read the report to send it: it is shared with them, if it was not already.
  if (person) {
    await run(env.DB, "INSERT OR IGNORE INTO report_access (account_id, report, granted_by) VALUES (?1, 'management', ?2)",
      person.id, 'Saturday report duty').catch(() => {});
  }
  return dutyView(env, account);
}

/** Settings › Notifications › Management report: the duty, who could hold it, and the last few weeks. */
export async function dutyView(env, account) {
  await requireAdmin(account);
  const s = await dutySettings(env);
  const log = await readLog(env);
  const people = await supervisors(env);
  return {
    ...s,
    supervisors: people.map((p) => ({ id: p.id, name: p.name, hasEmail: Boolean(p.email) })),
    weeks: Object.entries(log).sort(([a], [b]) => b.localeCompare(a)).slice(0, 6).map(([key, w]) => ({ key, ...w })),
  };
}

/** Whether the person asking holds the duty, and where this week's report stands. */
export async function dutyMine(env, account, { now = Date.now() } = {}) {
  const s = await dutySettings(env);
  const key = mondayOf(dayOf(now));
  const week = (await readLog(env))[key] || {};
  const mine = s.on && Number(account?.id) === s.accountId;
  return { on: s.on, mine, key, due: `${plusDays(key, 5)}T${String(DUE_HOUR).padStart(2, '0')}:00:00Z`, sent: week.sent || null };
}

/**
 * The Saturday report as a card for Today: for the supervisor who sends it,
 * all week; for an admin, from Friday's reminder until it has gone. Where it
 * stands: `ahead`, `soon` (Friday's reminder has gone), `late` (past 10:00 on
 * Saturday), `docked` (the GH₵ came off), or `sent`. `last` is last week's.
 */
export async function dutyCard(env, account, { now = Date.now(), admin = false } = {}) {
  const s = await dutySettings(env);
  if (!s.on || !s.accountId) return null;
  const mine = Number(account?.id) === s.accountId;
  if (!mine && !admin) return null;
  const key = mondayOf(dayOf(now));
  const log = await readLog(env);
  const week = log[key] || {};
  const at = (day, hour) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);
  const friday = plusDays(key, 4);
  const saturday = plusDays(key, 5);
  const t = new Date(now).getTime();
  const stage = week.sent ? 'sent' : week.docked ? 'docked' : t >= at(saturday, DUE_HOUR) ? 'late' : t >= at(friday, 17) ? 'soon' : 'ahead';
  if (!mine && ['ahead', 'sent'].includes(stage)) return null;
  const person = (await supervisors(env)).find((p) => p.id === s.accountId);
  const last = log[plusDays(key, -7)] || null;
  return {
    mine, who: person?.name || 'The supervisor on duty', stage, from: key, to: friday, amount: s.amount,
    due: new Date(at(saturday, DUE_HOUR)).toISOString(), dock: new Date(at(saturday, DOCK_HOUR)).toISOString(),
    reminders: [new Date(at(friday, 17)).toISOString(), new Date(at(saturday, 9)).toISOString()],
    sent: week.sent || null, docked: week.docked || null,
    last: last ? { sent: last.sent || null, docked: last.docked || null } : null,
  };
}

/** May this account send this week's report to everybody: an admin, or the supervisor on duty, for this week. */
export async function maySendToEverybody(env, account, { period, at }, { now = Date.now() } = {}) {
  const mine = await dutyMine(env, account, { now });
  return mine.mine && period === 'week' && mondayOf(String(at || '')) === mine.key;
}

// --------------------------------------------------------------- the log --

async function readLog(env) {
  try { return JSON.parse((await getSettings(env.DB).catch(() => ({})))[LOG] || '{}'); } catch { return {}; }
}

async function writeLog(env, key, change) {
  const log = await readLog(env);
  log[key] = { ...(log[key] || {}), ...change, steps: [...new Set([...(log[key]?.steps || []), ...(change.steps || [])])] };
  // Eight weeks is plenty to look back on.
  const keep = Object.keys(log).sort().slice(-8);
  await setSetting(env.DB, LOG, JSON.stringify(Object.fromEntries(keep.map((k) => [k, log[k]]))));
  return log[key];
}

/** The week's report went to everybody: when, and by whom. The first send counts. */
export async function recordSent(env, { key, at = new Date().toISOString(), by = null }) {
  const week = (await readLog(env))[key];
  if (week?.sent) return week;
  return writeLog(env, key, { sent: { at, by } });
}

// ------------------------------------------------------------ the emails --

async function mail(env, { to, cc = [], subject, html, text, kind, fetchImpl }) {
  return callLink({
    binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/mail',
    body: { to, cc: cc.filter((e) => e && e.toLowerCase() !== String(to).toLowerCase()), subject, html, text, kind, senderName: 'Insight' },
  });
}

const button = (href, label) => (href ? `<a href="${esc(href)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;padding:12px 20px">${esc(label)}</a>` : '');
const WHEN_WORDS = { overdue: 'Overdue', today: 'Due today', later: 'Later' };
const WHEN_COLOUR = { overdue: '#b91c1c', today: '#8a5a00', later: '#6b6a64' };

/**
 * A supervisor's morning email: the same list as their Today, in the same
 * order (overdue, due today, later), with the Saturday report on top when it
 * is theirs. It is their only reminder: to-dos are not emailed one by one.
 */
export function digestEmail({ name, items, base, duty = null }) {
  const first = String(name || '').split(/\s+/)[0] || 'there';
  const groups = ['overdue', 'today', 'later'].map((w) => [w, items.filter((x) => x.when === w)]).filter(([, xs]) => xs.length);
  const overdue = items.filter((x) => x.when === 'overdue').length;
  const meta = (x) => [x.from ? `from ${x.from}` : null, x.why || null,
    x.when === 'overdue' && x.late ? `${x.late} day${x.late === 1 ? '' : 's'} late` : x.when === 'later' && x.due ? `due ${shortDay(x.due)}` : null].filter(Boolean).join(' · ');
  const row = (x) => `<tr><td style="padding:9px 0;border-bottom:1px solid #ecebe6">
      <b style="color:#111110">${esc(x.title)}</b>${meta(x) ? ` <span style="color:#8a8780;font-size:13px">· ${esc(meta(x))}</span>` : ''}</td></tr>`;
  const html = frame(`
    <h1 style="margin:0 0 6px;font-size:22px;line-height:1.25;color:#111110">Good morning, ${esc(first)}</h1>
    <p style="margin:0 0 16px">The same list as Today in Insight.</p>
    ${duty ? `<div style="border-left:3px solid #d97706;background:#fff7ed;padding:12px 16px;margin:0 0 16px;border-radius:0 10px 10px 0"><b>${esc(duty)}</b></div>` : ''}
    ${groups.map(([w, xs]) => `<p style="margin:16px 0 0;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${WHEN_COLOUR[w]}">${WHEN_WORDS[w]}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${xs.map(row).join('')}</table>`).join('')}
    <p style="margin:20px 0 0">${button(base ? `${base}/#/assistant` : null, 'Open Today in Insight')}</p>
    <p style="margin:18px 0 0;font-size:12px;color:#8a8780">Sent every morning at 7:00 while something is waiting on you. The admins get a copy.</p>`);
  const text = [`Good morning, ${first}`, 'The same list as Today in Insight.', duty || '',
    ...groups.flatMap(([w, xs]) => [`${WHEN_WORDS[w]}:`, ...xs.map((x) => `- ${x.title}${meta(x) ? ` (${meta(x)})` : ''}`)]),
    base ? `${base}/#/assistant` : ''].filter(Boolean).join('\n');
  const n = items.length;
  return { subject: `${first}, ${n} thing${n === 1 ? '' : 's'} today${overdue ? ` — ${overdue} overdue` : ''}`, html, text };
}
const shortDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Each supervisor's morning email, with the admins copied. */
export async function sendDigests(env, { now = Date.now(), fetchImpl } = {}) {
  const s = await dutySettings(env);
  if (!s.digest) return { sent: 0, reason: 'switched off' };
  const base = (await mgmt.mailSettings(env)).origin || null;
  const cc = await adminEmails(env);
  const mine = await dutyMine(env, { id: s.accountId }, { now });
  const day = dayOf(now);
  let sent = 0;
  const failed = [];
  const quiet = [];
  for (const person of await supervisors(env)) {
    if (!person.email) { failed.push(`${person.name}: no email address`); continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const data = await gather(env, person, { now });
      const items = arrange(data.items.filter((x) => x.tab !== 'done'), day);
      // The Saturday report, on the morning it is due, for whoever sends it.
      const duty = s.on && person.id === s.accountId && weekday(day) === 6 && !mine.sent
        ? `This week's management report is due by 10:00 today: open Reports › Management report and press Send to everybody.` : null;
      if (!items.length && !duty) { quiet.push(person.name); continue; }
      const m = digestEmail({ name: person.name, items, base, duty });
      // eslint-disable-next-line no-await-in-loop
      await mail(env, { to: person.email, cc, ...m, kind: 'insight_digest', fetchImpl });
      sent += 1;
    } catch (err) { failed.push(`${person.name}: ${err.message}`); }
  }
  return { sent, quiet, failed };
}

// ------------------------------------------------------ the Saturday report --

function dutyEmail({ name, headline, lines, base, tone = 'warn' }) {
  const first = String(name || '').split(/\s+/)[0] || 'there';
  const colour = tone === 'bad' ? '#b91c1c' : '#d97706';
  const html = frame(`
    <p style="margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${colour}">Management report</p>
    <h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:#111110">${esc(headline)}</h1>
    <p style="margin:0 0 6px">Hello ${esc(first)},</p>
    ${lines.map((l) => `<p style="margin:0 0 12px">${esc(l)}</p>`).join('')}
    <p style="margin:18px 0 0">${button(base ? `${base}/#/management?period=week` : null, 'Open the management report')}</p>`);
  return { subject: headline, html, text: [headline, `Hello ${first},`, ...lines, base ? `${base}/#/management?period=week` : ''].filter(Boolean).join('\n\n') };
}

/**
 * The step due this hour, if any, for this week's report: a reminder, a late
 * notice, or the deduction. `now` is a Date or a time in milliseconds.
 */
export function stepAt(now) {
  const d = new Date(now);
  const day = dayOf(d);
  const hour = d.getUTCHours();
  const dow = d.getUTCDay();
  if (dow === 5 && hour === 17) return { step: 'friday', key: mondayOf(day) };
  if (dow !== 6) return null;
  const key = mondayOf(day);
  if (hour === 9) return { step: 'morning', key };
  if (hour === DUE_HOUR) return { step: 'late', key };
  if (hour === 12) return { step: 'later', key };
  // From 14:00, every hour until HIVE has taken it: one that could not be reached is asked again.
  if (hour >= DOCK_HOUR) return { step: 'dock', key };
  return null;
}

/** This hour's step for the Saturday report, done once. */
export async function saturdayDue(env, { now = Date.now(), fetchImpl } = {}) {
  const s = await dutySettings(env);
  const at = stepAt(now);
  if (!s.on || !s.accountId || !at) return { step: at?.step || null, done: false };
  const person = (await supervisors(env)).find((p) => p.id === s.accountId);
  if (!person?.email) return { step: at.step, done: false, reason: 'the supervisor on duty has no email address' };
  const week = (await readLog(env))[at.key] || {};
  if (week.sent) return { step: at.step, done: false, reason: 'sent' };
  if ((week.steps || []).includes(at.step)) return { step: at.step, done: false, reason: 'already done' };
  const base = (await mgmt.mailSettings(env)).origin || null;
  const admins = await adminEmails(env);
  const saturday = plusDays(at.key, 5);
  const what = `this week's management report (${longDay(at.key).replace(/^\w+ /, '')} to ${longDay(plusDays(at.key, 4)).replace(/^\w+ /, '')})`;
  const how = 'Open Reports › Management report, check it, and press Send to everybody.';
  let m;
  let cc = [];
  let docked = null;
  if (at.step === 'friday') {
    m = dutyEmail({ name: person.name, headline: 'Tomorrow by 10:00: the management report', lines: [`You send ${what} by 10:00 on ${longDay(saturday)}.`, how], base });
  } else if (at.step === 'morning') {
    m = dutyEmail({ name: person.name, headline: 'Due at 10:00 today: the management report', lines: [`${what[0].toUpperCase()}${what.slice(1)} is due in an hour.`, how], base });
  } else if (at.step === 'late' || at.step === 'later') {
    cc = admins;
    m = dutyEmail({
      name: person.name, tone: at.step === 'later' ? 'bad' : 'warn',
      headline: at.step === 'late' ? 'Late: the management report was due at 10:00' : 'Still not sent: the management report',
      lines: [`${what[0].toUpperCase()}${what.slice(1)} was due at 10:00 and has not gone yet.`, how,
        `If it has not gone by ${DOCK_HOUR}:00, more than four hours late, ${cedis(s.amount)} comes off your bonus.`],
      base,
    });
  } else {
    cc = admins;
    const out = await callLink({
      binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/pay/dock',
      body: { email: person.email, amount: s.amount, key: `mgmt-late:${at.key}`, by: 'Insight', reason: `Management report for the week of ${at.key} not sent by ${DOCK_HOUR}:00 on ${saturday}, more than four hours late` },
    });
    docked = { amount: s.amount, month: out?.month || null, at: new Date(now).toISOString() };
    m = dutyEmail({
      name: person.name, tone: 'bad', headline: `${cedis(s.amount)} off your bonus: the management report is over four hours late`,
      lines: [`${what[0].toUpperCase()}${what.slice(1)} was due at 10:00 and had not gone by ${DOCK_HOUR}:00.`,
        `${cedis(s.amount)} has come off your ${out?.month ? `${new Date(`${out.month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })} ` : ''}bonus in HIVE. It still needs sending: ${how.toLowerCase()}`],
      base,
    });
  }
  // The step is kept before the email, so a failed email is not a second deduction.
  await writeLog(env, at.key, { steps: [at.step], ...(docked ? { docked } : {}), who: person.name });
  await mail(env, { to: person.email, cc, ...m, kind: 'insight_mgmt_duty', fetchImpl });
  return { step: at.step, done: true, docked };
}

/** The hourly run: the morning digest at 07:00, and the Saturday report's steps. */
export async function dutyDue(env, { now = Date.now(), fetchImpl } = {}) {
  const out = {};
  if (new Date(now).getUTCHours() === 7) out.digest = await sendDigests(env, { now, fetchImpl }).catch((err) => ({ error: String(err?.message || err) }));
  out.saturday = await saturdayDue(env, { now, fetchImpl }).catch((err) => ({ error: String(err?.message || err) }));
  return out;
}
