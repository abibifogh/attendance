import { all, first, run } from '../lib/db.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { roleOf } from './till.js';

/**
 * Who sees which reports.
 *
 * An admin (and an owner) sees every report. Anybody else may be given report
 * pages one by one: a supervisor on top of Shifts, an uploader on top of the
 * files, or somebody whose Insight is "Reports only" (a general manager who
 * reads the figures and touches nothing). An admin ticks them under Admin ›
 * Who sees which reports.
 *
 * Ticking a report for somebody with no Insight at all gives them Insight as
 * Reports only; taking the last one away from a Reports only person takes
 * Insight away again, so the hub is all they keep.
 *
 * A report page is reached through the endpoints it reads, so each endpoint a
 * page reads is named here with its report. Everything else marked `insight`
 * stays an admin's. What a report page lets an admin change (settings, who is
 * emailed, a reading put right) stays an admin's too: those check for an
 * admin themselves.
 */

export const REPORTS = [
  { key: 'brief', label: 'Brief', note: 'The morning summary and its findings.' },
  { key: 'management', label: 'Management report', note: 'The weekly and monthly report: breakfast and maintenance.' },
  { key: 'money', label: 'Profit & loss', note: 'Revenue and costs, and how spending was paid.' },
  { key: 'yardstick', label: 'Health', note: 'Each part of the business against its targets.' },
  { key: 'prepaid', label: 'Prepaid stays', note: 'What guests paid before arrival.' },
  { key: 'cash', label: 'Cash & collections', note: 'Takings by till and how they were collected.' },
  { key: 'labour', label: 'Staff costs', note: 'Hours worked and wages against revenue.' },
  { key: 'guests', label: 'Guests', note: 'Guests in house and demand.' },
  { key: 'buying', label: 'Suppliers & spend', note: 'Spend by supplier, and the suppliers list (supervisors may also change it).' },
  { key: 'niceplace', label: 'Nice Place', note: 'The washroom counters against takings.' },
];
const KEYS = new Set(REPORTS.map((r) => r.key));

/** Each endpoint a report page reads, with its report. */
const ENDPOINTS = {
  'GET /api/brief': 'brief',
  'GET /api/findings': 'brief',
  'GET /api/reports/management': 'management',
  'POST /api/reports/management/send': 'management', // to the person pressing it; to everybody needs an admin
  'GET /api/pnl': 'money',
  'GET /api/money/cash': 'money',
  'GET /api/money/articles': 'money',
  'GET /api/financials': 'yardstick',
  'GET /api/money/prepaid': 'prepaid',
  'GET /api/money/prepaid.csv': 'prepaid',
  'GET /api/cash': 'cash',
  'GET /api/labour': 'labour',
  'GET /api/demand': 'guests',
  'GET /api/suppliers': 'buying',
  'GET /api/suppliers/book': 'buying',
  'GET /api/suppliers/one': 'buying',
  // Changing a supplier: Buying, and then an admin or a supervisor (supplierbook.js).
  'POST /api/suppliers/refresh': 'buying',
  'POST /api/suppliers/save': 'buying',
  'POST /api/suppliers/link': 'buying',
  'GET /api/np': 'niceplace',
};

/** The report an endpoint belongs to, or null when it is an admin's alone. */
export const reportOfEndpoint = (method, path) => ENDPOINTS[`${method} ${path}`] || null;

/** The roles that may be given reports one by one. */
const GRANTABLE = new Set(['supervisor', 'uploader', 'reports']);

/** The report pages this account may open: every one for an admin. */
export async function reportsOf(env, account) {
  const role = roleOf(account);
  if (role === 'admin') return REPORTS.map((r) => r.key);
  if (!GRANTABLE.has(role) || account?.id == null) return [];
  const rows = await all(env.DB, 'SELECT report FROM report_access WHERE account_id = ?1', account.id).catch(() => []);
  return rows.map((r) => r.report).filter((k) => KEYS.has(k));
}

/** Refuse unless this account may read the report this endpoint belongs to. */
export async function requireReport(env, account, method, path) {
  const report = reportOfEndpoint(method, path);
  if (!report) throw forbidden('Only an admin can open that.');
  if (!(await reportsOf(env, account)).includes(report)) {
    const label = REPORTS.find((r) => r.key === report)?.label || 'That report';
    throw forbidden(`${label} has not been shared with you. An admin can share it under Settings › People & access › Reports they see.`);
  }
}

const LEVEL_WORDS = { supervisor: 'Supervisor', uploader: 'Uploads only', reports: 'Reports only' };

/** Everybody an admin may share reports with, and what each has. */
export async function list(env) {
  const accounts = await all(env.DB, 'SELECT id, name, email, is_owner FROM accounts WHERE active = 1 ORDER BY name');
  const grants = await all(env.DB, "SELECT account_id, role FROM account_access WHERE system_id = 'insight'");
  const rows = await all(env.DB, 'SELECT account_id, report FROM report_access').catch(() => []);
  const role = (a) => {
    if (a.is_owner === 1) return 'admin';
    const g = grants.find((x) => x.account_id === a.id);
    if (!g) return 'none';
    return GRANTABLE.has(g.role) ? g.role : 'admin';
  };
  return {
    reports: REPORTS,
    people: accounts.map((a) => {
      const level = role(a);
      return {
        id: a.id,
        name: a.name,
        email: a.email,
        level,
        levelWords: level === 'admin' ? (a.is_owner === 1 ? 'Owner' : 'Admin') : level === 'none' ? 'Hub only' : LEVEL_WORDS[level],
        reports: level === 'admin' ? REPORTS.map((r) => r.key) : rows.filter((r) => r.account_id === a.id).map((r) => r.report).filter((k) => KEYS.has(k)),
      };
    }),
  };
}

/** Set one person's reports. Gives Insight as Reports only to somebody with none; takes it back when the last goes. */
export async function save(env, body, actor) {
  const id = Number(body?.accountId);
  const account = await first(env.DB, 'SELECT id, is_owner, active FROM accounts WHERE id = ?1', id);
  if (!account) throw notFound('No such account.');
  const reports = [...new Set((Array.isArray(body?.reports) ? body.reports : []).map(String))];
  const bad = reports.find((k) => !KEYS.has(k));
  if (bad) throw badRequest(`${bad} is not a report.`);
  const grant = await first(env.DB, "SELECT role FROM account_access WHERE account_id = ?1 AND system_id = 'insight'", id);
  if (account.is_owner === 1 || (grant && !GRANTABLE.has(grant.role))) throw badRequest('An admin sees every report already.');

  await run(env.DB, 'DELETE FROM report_access WHERE account_id = ?1', id);
  for (const report of reports) {
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, 'INSERT INTO report_access (account_id, report, granted_by) VALUES (?1, ?2, ?3)', id, report, actor?.email || actor?.name || 'admin');
  }
  if (!grant && reports.length) {
    await run(env.DB, "INSERT INTO account_access (account_id, system_id, role, granted_by) VALUES (?1, 'insight', 'reports', ?2)", id, actor?.email || 'admin');
  }
  if (grant?.role === 'reports' && !reports.length) {
    await run(env.DB, "DELETE FROM account_access WHERE account_id = ?1 AND system_id = 'insight'", id);
  }
  return list(env);
}
