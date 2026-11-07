import { all, first, run } from '../lib/db.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { AREAS, PRESETS as SUPERVISOR_PRESETS, accessOf, requireAdmin, roleOf } from './till.js';
import { REPORTS, reportsOf } from './reportaccess.js';

/**
 * Settings › People & access › Who sees what: one table, one row per person,
 * one column per tab in Insight, each Hidden, See or Do.
 *
 * Three things already decided what somebody who is not an admin gets, and
 * this table writes all three, so nothing else has to change its mind:
 *
 *   - The Shifts areas (till_access): the front desk tabs, To sort out, Nice
 *     Place and Upload files. Their handlers check an area, as they always
 *     did; the ticks under each tab in the table are those areas.
 *   - The shared reports (report_access): the report pages, Spend, Suppliers,
 *     Staff costs and Nice Place's counters.
 *   - tab_access, new: the tabs that were an admin's alone (Approvals, Floats,
 *     Receipts, Stock from Odoo, Fixed assets, the Safe, Everybody,
 *     Evaluations). A request to one of their endpoints from somebody given
 *     that tab is answered as for an admin, for that request only (`lift`).
 *
 * Settings stays with admins. Making or unmaking an admin is an owner's.
 */

/** Every tab, in menu order. max: 1 See only, 2 See or Do; 'always' on for everybody; 'admin' admins only. */
export const TABS = [
  { key: 'mylist', place: 'Today', label: 'My list', max: 'always', routes: ['assistant', 'my-evaluation'] },
  { key: 'approvals', place: 'Today', label: 'Approvals', max: 2, routes: ['approvals'] },
  { key: 'notifications', place: 'Today', label: 'Notifications', max: 'always', routes: ['notifications'] },
  { key: 'inbox', place: 'To sort out', label: 'To sort out', max: 2, routes: ['inbox'] },
  { key: 'shifts', place: 'Front desk', label: 'Shifts', max: 2, routes: ['shifts'] },
  { key: 'closing', place: 'Front desk', label: 'Closing reports', max: 2, routes: ['closing'] },
  { key: 'cashiers', place: 'Front desk', label: 'Cashiers', max: 1, routes: ['people'] },
  { key: 'safe', place: 'Front desk', label: 'Safe', max: 2, routes: ['safe'] },
  { key: 'npcounters', place: 'Front desk', label: 'NP counters & money', max: 2, routes: ['niceplace'], report: 'niceplace' },
  { key: 'pickups', place: 'Front desk', label: 'NP pickups', max: 2, routes: ['np-pickups'] },
  { key: 'upload', place: 'Front desk', label: 'Upload files', max: 2, routes: ['upload'] },
  { key: 'floats', place: 'Buying & stock', label: 'Floats', max: 2, routes: ['floats'] },
  { key: 'receipts', place: 'Buying & stock', label: 'Receipts', max: 2, routes: ['receipts'] },
  { key: 'spend', place: 'Buying & stock', label: 'Spend', max: 1, routes: ['spend'], report: 'buying' },
  { key: 'stock', place: 'Buying & stock', label: 'Stock from Odoo', max: 2, routes: ['stock'] },
  { key: 'assets', place: 'Buying & stock', label: 'Fixed assets', max: 2, routes: ['assets'] },
  { key: 'suppliers', place: 'Buying & stock', label: 'Suppliers', max: 2, routes: ['suppliers'], report: 'buying' },
  { key: 'everybody', place: 'Team', label: 'Everybody', max: 1, routes: ['team'] },
  { key: 'evaluations', place: 'Team', label: 'Evaluations', max: 2, routes: ['evaluations'] },
  { key: 'labour', place: 'Team', label: 'Staff costs', max: 1, routes: ['labour'], report: 'labour' },
  { key: 'pnl', place: 'Reports', label: 'Profit & loss', max: 1, routes: ['money'], report: 'money' },
  { key: 'health', place: 'Reports', label: 'Health', max: 1, routes: ['yardstick'], report: 'yardstick' },
  { key: 'cash', place: 'Reports', label: 'Cash & collections', max: 1, routes: ['cash'], report: 'cash' },
  { key: 'management', place: 'Reports', label: 'Management report', max: 1, routes: ['management'], report: 'management' },
  { key: 'guests', place: 'Reports', label: 'Occupancy & spend', max: 1, routes: ['guests'], report: 'guests' },
  { key: 'prepaid', place: 'Reports', label: 'Prepaid stays', max: 1, routes: ['prepaid'], report: 'prepaid' },
  { key: 'people', place: 'Settings', label: 'People & access', max: 'admin', routes: ['access', 'accounts'] },
  { key: 'whogets', place: 'Settings', label: 'Who gets what', max: 'admin', routes: ['who-gets', 'notify', 'notify-mgmt', 'notify-prepaid'] },
  { key: 'rules', place: 'Settings', label: 'Rules', max: 'admin', routes: ['rules', 'np-rules', 'receipt-rules', 'stock-rules', 'team-rules'] },
  { key: 'connections', place: 'Settings', label: 'Connections & files', max: 'admin', routes: ['setup', 'speed', 'files'] },
  { key: 'shared', place: 'Settings', label: 'Shared reports', max: 'admin', routes: ['reports'] },
];
const TAB = new Map(TABS.map((t) => [t.key, t]));
const levelMax = (t) => (t.max === 'always' || t.max === 'admin' ? 2 : t.max);

/**
 * The finer things inside a tab: each one a Shifts area, ticked or not. A
 * tick at level 2 is an action, so it only counts while its tab is on Do.
 */
export const TICKS = {
  shifts: [
    { area: 'day', level: 1, label: 'Day view' }, { area: 'week', level: 1, label: 'Week view' },
    { area: 'month', level: 1, label: 'Month view and table' }, { area: 'money', level: 1, label: 'See amounts' },
    { area: 'odoo', level: 1, label: 'Odoo POs' }, { area: 'check', level: 2, label: 'Check a shift' },
    { area: 'proof', level: 2, label: 'Ask for proof' },
  ],
  inbox: [
    { area: 'answers', level: 2, label: 'Act on staff answers' }, { area: 'advances', level: 2, label: 'Advances' },
    { area: 'bank', level: 2, label: 'Card and bank' }, { area: 'moves', level: 2, label: 'Cash movements' },
    { area: 'money_out', level: 2, label: 'Money out: recover, pay, write off' },
  ],
  closing: [{ area: 'reopen', level: 2, label: 'Reopen a report' }],
  cashiers: [{ area: 'net', level: 1, label: 'Net by person' }],
  // On See the Safe is Envelopes received alone; this lets them mark envelopes too. Do is the whole safe.
  safe: [{ area: 'envelopes', level: 2, label: 'Mark envelopes received', withSee: true }],
  npcounters: [{ area: 'niceplace', level: 2, label: 'Answer counter questions' }],
};

/** The areas each front desk tab owns: gone when the tab is hidden. */
const OWNS = {
  shifts: ['day', 'week', 'month', 'money', 'odoo', 'check', 'proof'],
  inbox: ['answers', 'advances', 'bank', 'moves', 'money_out'],
  closing: ['reports', 'reopen'],
  cashiers: ['net'],
  safe: ['envelopes'],
  npcounters: ['niceplace'],
  pickups: ['pickups'],
  upload: ['files'],
};

/**
 * Endpoints of the tabs that were an admin's alone. Somebody given the tab
 * has the endpoint answered as for an admin: a GET needs See, anything else
 * Do. Each tab's Rules stay in Settings, which is an admin's.
 */
const LIFTS = {
  approvals: ['GET /api/approvals', 'POST /api/approvals/decide'],
  floats: [
    'GET /api/floats', 'GET /api/floats/:id', 'GET /api/floats/:id/statement', 'GET /api/receipts/:id/file',
    'POST /api/floats/dests', 'POST /api/floats/move', 'POST /api/floats/give', 'POST /api/floats/back', 'POST /api/floats/undo',
    'POST /api/floats/note', 'POST /api/floats/decide', 'POST /api/floats/link', 'POST /api/floats/add', 'POST /api/floats/amount',
  ],
  receipts: [
    'GET /api/receipts', 'GET /api/receipts/choices', 'GET /api/receipts/:id/file', 'GET /api/po/find', 'GET /api/po/recent',
    'POST /api/receipts/upload', 'POST /api/receipts/dismiss', 'POST /api/receipts/retry',
  ],
  stock: ['GET /api/stock', 'GET /api/stock/items', 'POST /api/stock/run', 'POST /api/stock/match'],
  assets: ['GET /api/assets', 'POST /api/assets/scan', 'POST /api/assets/register', 'POST /api/assets/decide'],
  safe: [
    'GET /api/safe', 'GET /api/safe/book', 'GET /api/safe/envelopes', 'GET /api/safe/envelopes.csv', 'GET /api/suspense',
    'POST /api/safe/entry', 'POST /api/safe/entry/:id/po', 'POST /api/safe/entry/:id/remove', 'POST /api/safe/dismiss',
    'POST /api/safe/count', 'POST /api/safe/close', 'POST /api/safe/:id/taken', 'POST /api/safe/:id/undo',
    'POST /api/safe/envelopes/receive', 'POST /api/safe/envelopes/undo',
    'POST /api/suspense/add', 'POST /api/suspense/match', 'POST /api/suspense/safe', 'POST /api/suspense/undo',
  ],
  everybody: ['GET /api/team', 'GET /api/team/:id'],
  evaluations: ['GET /api/team/evaluations', 'GET /api/team/:id', 'GET /api/team/:id/evaluation', 'POST /api/team/:id/score', 'POST /api/team/:id/note'],
};
const LIFT_TABS = new Map();
for (const [tab, list] of Object.entries(LIFTS)) {
  for (const e of list) LIFT_TABS.set(e, [...(LIFT_TABS.get(e) || []), tab]);
}

/** Changing a supplier: Suppliers on Do. Reading them is the Buying report, as before. */
export const SUPPLIER_WRITES = new Set(['POST /api/suppliers/save', 'POST /api/suppliers/link', 'POST /api/suppliers/refresh']);

/** The roles that are not an admin, as the table names them. */
const ROLE_WORDS = { supervisor: 'Custom', uploader: 'Upload only', reports: 'Reports only', npcash: 'Nice Place cash' };

/**
 * What each role and set of areas and reports gives, tab by tab, for
 * somebody an admin has not yet saved in the table.
 */
export function derive(role, a = {}, reports = []) {
  const r = new Set(reports);
  const out = Object.fromEntries(TABS.map((t) => [t.key, 0]));
  if (!role) return out;
  out.mylist = 1; out.notifications = 1;
  if (role === 'admin') return Object.fromEntries(TABS.map((t) => [t.key, levelMax(t)]));
  const any = (...keys) => keys.some((k) => (a[k] || 0) >= 1);
  const acts = (...keys) => keys.some((k) => (a[k] || 0) >= 2);
  const sup = role === 'supervisor';
  if (sup && any('day', 'week', 'month', 'money')) out.shifts = acts('check', 'proof') ? 2 : 1;
  if (sup) out.inbox = acts('answers', 'advances', 'bank', 'moves', 'money_out', 'niceplace') ? 2 : 1;
  if (sup && any('reports')) out.closing = acts('reopen') ? 2 : 1;
  if (sup && any('net', 'answers')) out.cashiers = 1;
  if (sup && any('envelopes')) out.safe = 1;
  if (r.has('niceplace') || role === 'npcash') out.npcounters = acts('niceplace') ? 2 : 1;
  if ((sup || role === 'npcash') && any('pickups')) out.pickups = acts('pickups') ? 2 : 1;
  if (role === 'uploader' || (sup && any('files'))) out.upload = 2;
  for (const t of TABS) {
    if (t.report && t.key !== 'npcounters' && r.has(t.report)) out[t.key] = t.key === 'suppliers' && sup ? 2 : 1;
  }
  return out;
}

async function areasOf(env, account) {
  return accessOf(env, account);
}

/** Each tab and how far this account may go with it: 0, 1 or 2. */
export async function tabsOf(env, account) {
  const role = roleOf(account);
  if (!role || role === 'admin') return derive(role);
  const rows = role === 'supervisor' && account?.id != null
    ? await all(env.DB, 'SELECT tab, level FROM tab_access WHERE account_id = ?1', account.id).catch(() => [])
    : [];
  if (!rows.length) return derive(role, await areasOf(env, account), await reportsOf(env, account));
  const out = Object.fromEntries(TABS.map((t) => [t.key, 0]));
  out.mylist = 1; out.notifications = 1;
  for (const row of rows) {
    const t = TAB.get(row.tab);
    if (t && typeof t.max === 'number') out[t.key] = Math.max(0, Math.min(t.max, Number(row.level) || 0));
  }
  return out;
}

/**
 * The account to answer this request as: the same account, but an admin, when
 * the endpoint belongs to a tab that was an admin's alone and they have been
 * given that tab far enough. Null when nothing is lifted.
 */
export async function lift(env, account, method, routePath) {
  if (!account || roleOf(account) !== 'supervisor') return null;
  const tabs = LIFT_TABS.get(`${method} ${routePath}`);
  if (!tabs) return null;
  const need = method === 'GET' || method === 'HEAD' ? 1 : 2;
  const mine = await tabsOf(env, account);
  const by = tabs.find((t) => (mine[t] || 0) >= need);
  if (!by) return null;
  return {
    ...account,
    lifted: by,
    access: (account.access || []).map((g) => (g.systemId === 'insight' ? { ...g, role: 'admin' } : g)),
  };
}

// --------------------------------------------------------------- presets --

const NONE = Object.fromEntries(AREAS.map((a) => [a.key, 0]));
const areasFrom = (levels = {}) => ({ ...NONE, ...levels });

/** Where a person can start from, each with its tabs and areas worked out the same way. */
export function presets() {
  const sets = [
    ...SUPERVISOR_PRESETS.map((p) => ({ key: p.key, label: p.label, text: p.text, role: 'supervisor', areas: areasFrom(p.levels), reports: [] })),
    { key: 'npcash', label: 'Nice Place cash', text: 'Sees Nice Place’s counters and money and picks up its envelopes.', role: 'npcash', areas: areasFrom({ niceplace: 1, pickups: 2 }), reports: ['niceplace'] },
    { key: 'uploader', label: 'Upload only', text: 'Loads the shift files and nothing else.', role: 'uploader', areas: areasFrom({ files: 2 }), reports: [] },
  ];
  return [
    { key: 'admin', label: 'Admin', text: 'Everything, Settings too. Only an owner makes somebody an admin.', admin: true },
    ...sets.map((s) => ({ key: s.key, label: s.label, text: s.text, tabs: derive(s.role, s.areas, s.reports), areas: s.areas })),
    { key: 'reports', label: 'Reports only', text: 'The report pages ticked, and nothing else.', tabs: derive('reports'), areas: areasFrom() },
    { key: 'none', label: 'No Insight access', text: 'The other systems only.', none: true },
  ];
}

// --------------------------------------------------------------- the table --

/** Everybody, what they have tab by tab, and the other systems. Admins only. */
export async function list(env, actor) {
  await requireAdmin(actor);
  const accounts = await all(env.DB, 'SELECT id, name, email, is_owner FROM accounts WHERE active = 1 ORDER BY name');
  const grants = await all(env.DB, 'SELECT account_id, system_id, role FROM account_access');
  const systems = (await all(env.DB, 'SELECT id, label FROM systems ORDER BY sort_order')).filter((s) => s.id !== 'insight');
  const explicit = new Set((await all(env.DB, 'SELECT DISTINCT account_id FROM tab_access').catch(() => [])).map((r) => Number(r.account_id)));
  const people = [];
  for (const a of accounts) {
    const mine = grants.filter((g) => g.account_id === a.id);
    const access = mine.map((g) => ({ systemId: g.system_id, role: g.role || '' }));
    const account = { id: a.id, isOwner: a.is_owner === 1, access };
    const role = roleOf(account);
    // eslint-disable-next-line no-await-in-loop
    const areas = role ? await accessOf(env, account) : areasFrom();
    // eslint-disable-next-line no-await-in-loop
    const tabs = await tabsOf(env, account);
    people.push({
      id: a.id,
      name: a.name,
      email: a.email,
      isOwner: a.is_owner === 1,
      role: role || 'none',
      roleWords: role === 'admin' ? (a.is_owner === 1 ? 'Owner' : 'Admin') : role ? ROLE_WORDS[role] : 'No Insight access',
      saved: explicit.has(a.id),
      tabs,
      areas,
      systems: Object.fromEntries(systems.map((s) => [s.id, a.is_owner === 1 || mine.some((g) => g.system_id === s.id)])),
    });
  }
  return {
    tabs: TABS.map(({ key, place, label, max }) => ({ key, place, label, max })),
    ticks: TICKS,
    presets: presets(),
    systems: systems.map((s) => ({ id: s.id, label: s.label })),
    people,
    me: { id: actor.id ?? null, isOwner: Boolean(actor.isOwner || actor.bootstrap) },
  };
}

/** Tabs and areas made to agree: a hidden tab owns nothing; a See tab does nothing; a shown tab has what it needs. */
export function settle(tabsIn = {}, areasIn = {}) {
  const tabs = {};
  for (const t of TABS) {
    if (t.max === 'always') tabs[t.key] = 1;
    else if (t.max === 'admin') tabs[t.key] = 0;
    else tabs[t.key] = Math.max(0, Math.min(t.max, Math.round(Number(tabsIn[t.key]) || 0)));
  }
  const areas = {};
  for (const a of AREAS) areas[a.key] = Math.max(0, Math.min(a.max, Math.round(Number(areasIn[a.key]) || 0)));
  for (const [tab, keys] of Object.entries(OWNS)) {
    if (!tabs[tab]) for (const k of keys) areas[k] = 0;
  }
  // A tick that acts counts only while its tab is on Do.
  for (const [tab, ticks] of Object.entries(TICKS)) {
    if (tabs[tab] === 1) for (const t of ticks) if (t.level === 2 && !t.withSee) areas[t.area] = Math.min(areas[t.area], 1);
  }
  if (tabs.shifts && !['day', 'week', 'month'].some((k) => areas[k])) { areas.day = 1; areas.week = 1; areas.month = 1; }
  if (tabs.shifts === 2 && !areas.check && !areas.proof) { areas.check = 2; areas.proof = 2; }
  if (tabs.inbox === 2 && !TICKS.inbox.some((t) => areas[t.area] >= 2)) { areas.answers = 2; areas.advances = 2; }
  if (tabs.closing) areas.reports = 1;
  if (tabs.closing === 2) areas.reopen = 2;
  if (tabs.cashiers) areas.net = Math.max(areas.net, 1);
  if (tabs.safe) areas.envelopes = Math.max(areas.envelopes, tabs.safe === 2 ? 2 : 1);
  if (tabs.npcounters) areas.niceplace = Math.max(areas.niceplace, tabs.npcounters === 2 ? 2 : 1);
  areas.pickups = tabs.pickups;
  areas.files = tabs.upload;
  return { tabs, areas };
}

/** The shared reports that go with a set of tabs. */
export function reportsFor(tabs) {
  const out = new Set();
  for (const t of TABS) if (t.report && (tabs[t.key] || 0) >= 1) out.add(t.report);
  return [...out].filter((k) => REPORTS.some((r) => r.key === k));
}

async function setGrant(env, accountId, role, by) {
  const had = await first(env.DB, "SELECT role FROM account_access WHERE account_id = ?1 AND system_id = 'insight'", accountId);
  if (role === null) {
    if (had) await run(env.DB, "DELETE FROM account_access WHERE account_id = ?1 AND system_id = 'insight'", accountId);
  } else if (had) {
    await run(env.DB, "UPDATE account_access SET role = ?2 WHERE account_id = ?1 AND system_id = 'insight'", accountId, role);
  } else {
    await run(env.DB, "INSERT INTO account_access (account_id, system_id, role, granted_by) VALUES (?1, 'insight', ?2, ?3)", accountId, role, by);
  }
}

async function clearRows(env, accountId) {
  await run(env.DB, 'DELETE FROM tab_access WHERE account_id = ?1', accountId);
  await run(env.DB, 'DELETE FROM till_access WHERE account_id = ?1', accountId);
  await run(env.DB, 'DELETE FROM report_access WHERE account_id = ?1', accountId);
}

/**
 * Save people from the table: { people: [{ accountId, start: admin|none|custom, tabs, areas, systems }] }.
 * Admins only; making or unmaking an admin, and the other systems, an owner's.
 */
export async function save(env, body, actor) {
  await requireAdmin(actor);
  const owner = Boolean(actor.isOwner || actor.bootstrap);
  const by = actor.email || actor.name || 'admin';
  const wanted = Array.isArray(body?.people) ? body.people : [];
  if (!wanted.length) throw badRequest('Nothing to save.');
  const systems = new Set((await all(env.DB, 'SELECT id FROM systems')).map((s) => s.id));
  for (const p of wanted.slice(0, 200)) {
    const id = Number(p?.accountId);
    // eslint-disable-next-line no-await-in-loop
    const a = await first(env.DB, 'SELECT id, name, is_owner, active FROM accounts WHERE id = ?1', id);
    if (!a || a.active !== 1) throw notFound('No such person.');
    // eslint-disable-next-line no-await-in-loop
    const grants = await all(env.DB, 'SELECT system_id, role FROM account_access WHERE account_id = ?1', id);
    const wasAdmin = a.is_owner === 1 || roleOf({ access: grants.map((g) => ({ systemId: g.system_id, role: g.role })) }) === 'admin';
    const start = ['admin', 'none', 'custom'].includes(p?.start) ? p.start : 'custom';

    if (p?.systems && typeof p.systems === 'object') {
      if (!owner) throw forbidden('Only an owner changes who opens the other systems.');
      for (const [sys, on] of Object.entries(p.systems)) {
        if (sys === 'insight' || !systems.has(sys) || a.is_owner === 1) continue;
        const has = grants.some((g) => g.system_id === sys);
        // eslint-disable-next-line no-await-in-loop
        if (on && !has) await run(env.DB, 'INSERT INTO account_access (account_id, system_id, role, granted_by) VALUES (?1, ?2, ?3, ?4)', id, sys, '', by);
        // eslint-disable-next-line no-await-in-loop
        else if (!on && has) await run(env.DB, 'DELETE FROM account_access WHERE account_id = ?1 AND system_id = ?2', id, sys);
      }
    }
    if (p?.start === undefined) continue;

    if (a.is_owner === 1) {
      if (start !== 'admin') throw badRequest(`${a.name} is an owner: an owner sees everything.`);
      continue;
    }
    if (Number(actor.id) === id && start !== 'admin' && wasAdmin) throw badRequest('You cannot take your own admin away. Ask another admin or an owner.');
    if ((start === 'admin') !== wasAdmin && !owner) {
      throw forbidden(start === 'admin' ? 'Only an owner makes somebody an admin.' : 'Only an owner takes an admin away.');
    }
    if (start === 'admin') {
      // eslint-disable-next-line no-await-in-loop
      await setGrant(env, id, 'admin', by);
      // eslint-disable-next-line no-await-in-loop
      await clearRows(env, id);
      continue;
    }
    if (start === 'none') {
      // eslint-disable-next-line no-await-in-loop
      await setGrant(env, id, null, by);
      // eslint-disable-next-line no-await-in-loop
      await clearRows(env, id);
      continue;
    }
    const { tabs, areas } = settle(p?.tabs || {}, p?.areas || {});
    // eslint-disable-next-line no-await-in-loop
    await setGrant(env, id, 'supervisor', by);
    // eslint-disable-next-line no-await-in-loop
    await clearRows(env, id);
    for (const t of TABS) {
      // eslint-disable-next-line no-await-in-loop
      await run(env.DB, 'INSERT INTO tab_access (account_id, tab, level, set_by) VALUES (?1, ?2, ?3, ?4)', id, t.key, tabs[t.key], by);
    }
    // Every area written, the hidden ones too: a person with rows of their own never falls back to the defaults.
    for (const ar of AREAS) {
      // eslint-disable-next-line no-await-in-loop
      await run(env.DB, 'INSERT INTO till_access (account_id, area, level) VALUES (?1, ?2, ?3)', id, ar.key, areas[ar.key]);
    }
    for (const report of reportsFor(tabs)) {
      // eslint-disable-next-line no-await-in-loop
      await run(env.DB, 'INSERT INTO report_access (account_id, report, granted_by) VALUES (?1, ?2, ?3)', id, report, by);
    }
  }
  return list(env, actor);
}
