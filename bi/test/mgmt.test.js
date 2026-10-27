import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import { run } from '../src/lib/db.js';
import { verifyLink } from '../src/lib/link.js';
import * as mgmt from '../src/routes/mgmt.js';

/** The management report. Every name and figure is made up. */

const BF_SECRET = 'breakfast-test-secret';
const MX_SECRET = 'maintenance-test-secret';
const HIVE_SECRET = 'hive-test-secret';

/** What the breakfast app answers for a week (the shape of its /api/link/report). */
const breakfastWeek = (from) => ({
  ok: true, period: 'week', from, to: '2026-10-25', currency: 'GHS',
  insights: {
    partial: { isPartial: false, note: null },
    current: { guests: 200, inhouse: 180, outside: 20, cost: 4400, revenue: 1000, costPerGuest: 22, servedDays: 7 },
    previous: { guests: 200, inhouse: 185, outside: 15, cost: 4000, revenue: 750, costPerGuest: 20, servedDays: 7 },
    deltas: { guests: 0, cost: 10, costPerGuest: 10, revenue: 33.3 },
    series: ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']
      .map((day, i) => ({ day, recorded: i !== 6, costPerGuest: i !== 6 ? 21 + i * 0.2 : null })),
    risers: [{ ingredientId: 1, name: 'Eggs', cost: 1000, prevCost: 600 }, { ingredientId: 2, name: 'Butter', cost: 500, prevCost: 400 }],
    fallers: [{ ingredientId: 3, name: 'Fruit', cost: 300, prevCost: 400 }, { ingredientId: 1, name: 'Eggs', cost: 1000, prevCost: 600 }],
  },
  stock: {
    asOf: '2026-10-25', totalValue: 9000,
    reorder: [
      { name: 'Butter', unit: 'kg', stock: 1.2, parLevel: 5, daysCover: 2, status: 'below_par' },
      { name: 'Milk', unit: 'L', stock: -2, parLevel: 10, daysCover: null, status: 'negative' },
    ],
    shrinkage: [{ name: 'Sugar', countVarianceValue: -80 }, { name: 'Jam', countVarianceValue: 5 }],
  },
  suppliers: [{ name: 'A Poultry Farm', value: 2000 }, { name: 'A Dairy', value: 900 }],
  bakery: { runs: 3, qty: 120, value: 300 },
  missingDays: ['2026-10-25'],
});

/** What the maintenance report function answers (the shape of functions/report/logic.js build()). */
const maintenanceOf = ({ team, done }) => ({
  ok: true,
  rounds: {
    weeks: [], rooms: { done: 10, total: 12 }, areas: { done: 3, total: 3 }, missed: ['R4', 'R9'],
    faults: 6, fixed: 4, toJobs: 2, preventive: { done: 5, due: 6 }, visitors: [],
  },
  jobs: {
    reported: 14, done, open: 5, oldestOpenDays: 9, medianFixDays: 1.5, urgentOpen: 1,
    late: [{ room: 'R12', category: 'Plumbing', description: 'Shower', daysLate: 3 }],
    byCategory: [{ category: 'Plumbing', reported: 8, done: 7 }],
  },
  artisans: [
    { name: 'Kofi Test', trades: ['Plumbing'], score: 82, parts: { completion: 45, onTime: 17, kept: 12, plan: 10 }, done: 7, carried: 1, weeks: [] },
    { name: 'Ama Test', trades: ['Electrical'], score: 58, parts: { completion: 25, onTime: 13, kept: 15, plan: 5 }, done: 3, carried: 2, weeks: [] },
  ],
  team,
  store: {
    usedValue: 640, issues: 12, byCategory: [{ name: 'Plumbing', value: 400 }], topParts: [],
    belowPar: [{ name: 'Shower head', unit: 'each', onHand: 2, par: 5 }], belowParCount: 1,
    shelfValue: 5000, purchased: 300, counts: { made: 2, waiting: 1 }, stocktakes: 0,
    tools: { out: 2, overdue: [{ tool: 'Ladder', with: 'Kofi Test', daysOver: 2 }] },
  },
});

/** Both apps and HIVE, each checking the signature it is sent. */
function world() {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const text = await req.text();
    const body = JSON.parse(text);
    const sig = { at: req.headers.get('X-Till-At'), sig: req.headers.get('X-Till-Sig'), bodyText: text };
    if (url.host === 'breakfast.example.test') {
      assert.equal(url.pathname, '/api/link/report');
      assert.ok(await verifyLink(BF_SECRET, { ...sig, path: '/api/link/report' }), 'breakfast: signed with its own secret');
      calls.push(['breakfast', body]);
      return Response.json(breakfastWeek(body.week));
    }
    if (url.host === 'mx.example.test') {
      assert.equal(url.pathname, '/functions/v1/report');
      assert.ok(await verifyLink(MX_SECRET, { ...sig, path: '/report' }), 'maintenance: signed with its own secret');
      calls.push(['maintenance', body]);
      return Response.json(maintenanceOf(body.from === '2026-10-19' ? { team: 70, done: 12 } : { team: 78, done: 10 }));
    }
    assert.ok(await verifyLink(HIVE_SECRET, { ...sig, path: url.pathname }), 'HIVE: signed');
    calls.push(['hive', body]);
    return Response.json({ ok: true });
  };
  return { calls, fetchImpl };
}

async function linked() {
  const { db } = freshDb('migrations');
  await run(db, "UPDATE systems SET home_url = 'https://breakfast.example.test/' WHERE id = 'breakfast'");
  await run(db, `INSERT INTO accounts (id, email, name, is_owner, active, password_hash) VALUES
    (1, 'owner@example.test', 'Test Owner', 1, 1, 'x')`);
  return {
    DB: db,
    SSO_SECRET_BREAKFAST: BF_SECRET,
    SSO_SECRET_MAINTENANCE: MX_SECRET,
    SSO_SECRET_ATTENDANCE: HIVE_SECRET,
    MAINTENANCE_APPROVALS_URL: 'https://mx.example.test/functions/v1/approvals',
  };
}

test('the period: the last week that is over, or this month so far; and the ones either side', () => {
  const w = mgmt.periodOf({}, '2026-10-27');
  assert.deepEqual([w.period, w.from, w.to, w.prevFrom, w.prevTo, w.running, w.latest], ['week', '2026-10-19', '2026-10-25', '2026-10-12', '2026-10-18', false, false]);
  assert.match(w.label, /^Week 43 · Mon 19 – Sun 25 Oct 2026$/);
  assert.equal(mgmt.periodOf({ at: '2026-10-28' }, '2026-10-28').latest, true);
  const m = mgmt.periodOf({ period: 'month' }, '2026-10-27');
  assert.deepEqual([m.key, m.from, m.to, m.prevFrom, m.prevTo, m.running, m.before, m.after], ['2026-10', '2026-10-01', '2026-10-31', '2026-09-01', '2026-09-30', true, '2026-09', '2026-11']);
  assert.match(m.label, /October 2026 · 1 – 26 Oct, 5 days to go/);
  assert.equal(mgmt.periodOf({ period: 'month', at: '2026-02' }, '2026-10-27').to, '2026-02-28');
});

test('the report asks each app, signed with its own secret, and puts the figures together', async () => {
  const env = await linked();
  const { calls, fetchImpl } = world();
  const r = await mgmt.managementReport(env, { period: 'week', at: '2026-10-21' }, { fetchImpl, today: '2026-10-27' });
  assert.deepEqual(calls.map(([who, b]) => [who, b.week || b.from]).sort(), [['breakfast', '2026-10-19'], ['maintenance', '2026-10-12'], ['maintenance', '2026-10-19']]);

  // Each item's share of a guest, now and before: eggs 5.00 from 3.00.
  assert.deepEqual(r.breakfast.movers.map((m) => [m.name, m.change.toFixed(2)]), [['Eggs', '2.00'], ['Butter', '0.50'], ['Fruit', '-0.50']]);
  assert.deepEqual(r.breakfast.days, { due: 7, recorded: 6, missing: ['2026-10-25'] });
  assert.equal(r.breakfast.delivered, 2900);
  assert.equal(r.maintenance.before.team, 78);

  const tile = Object.fromEntries(r.tiles.map((t) => [t.label, t]));
  assert.deepEqual([tile['Food cost per guest'].value, tile['Food cost per guest'].sub, tile['Food cost per guest'].tone], ['GH₵ 22.00', '+GH₵ 2.00 on last week', 'bad']);
  assert.deepEqual([tile['Breakfast days recorded'].value, tile['Breakfast days recorded'].tone], ['6 of 7', 'warn']);
  assert.deepEqual([tile['Rooms on the rounds'].value, tile['Rooms on the rounds'].sub], ['10 of 12', '2 missed']);
  assert.deepEqual([tile['Team score'].value, tile['Team score'].sub, tile['Team score'].tone], ['70 / 100', '−8 on last week', 'warn']);

  const levels = r.attention.map((a) => a.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => ['bad', 'warn', 'good'].indexOf(a) - ['bad', 'warn', 'good'].indexOf(b)), 'most serious first');
  const said = r.attention.map((a) => a.text).join('\n');
  assert.match(said, /Food cost per guest was GH₵ 22\.00, \+10% on last week\. Most of it: Eggs, GH₵ 5\.00 a guest from GH₵ 3\.00/);
  assert.match(said, /Milk shows less than nothing in stock/);
  assert.match(said, /1 breakfast item below the reorder level or running out: Butter/);
  assert.match(said, /The last counts came out GH₵ 80 short of the books \(Sugar\)/);
  assert.match(said, /1 time-sensitive job past due: R12 shower \(3 days\)/);
  assert.match(said, /2 rooms and areas missed on the rounds: R4 and R9/);
  assert.match(said, /Ladder with Kofi Test \(2 days\)/);
  assert.match(said, /The team score fell to 70 from 78/);
  assert.match(said, /Ama Test \(58\) scored under 65/);
});

test('a system that is not linked, or cannot be reached, is said, and the rest is still made', async () => {
  const env = await linked();
  delete env.SSO_SECRET_BREAKFAST;
  const fetchImpl = async (input) => {
    if (String(input).includes('mx.example.test')) return Response.json({ error: 'Only Insight may ask for this, and it signs what it asks.' }, { status: 401 });
    throw new Error('should not be asked');
  };
  const r = await mgmt.managementReport(env, {}, { fetchImpl, today: '2026-10-27' });
  assert.equal(r.breakfast.ok, false);
  assert.match(r.breakfast.error, /Breakfast is not linked/);
  assert.match(r.maintenance.error, /Only Insight may ask/);
  assert.equal(r.tiles.length, 8);
  assert.ok(r.tiles.every((t) => t.value === '—'));
  assert.deepEqual(r.attention.map((a) => a.source), ['Breakfast', 'Maintenance']);

  const missing = await mgmt.managementReport({ ...env, SSO_SECRET_BREAKFAST: BF_SECRET }, {}, { fetchImpl: async () => new Response('', { status: 404 }), today: '2026-10-27' });
  assert.match(missing.maintenance.error, /does not answer the management report yet/);
});

test('the email: to the admins and the addresses added, each week once, with the link back', async () => {
  const env = await linked();
  await assert.rejects(mgmt.saveMailSettings(env, { emails: ['nope'] }), /not an email address/);
  const saved = await mgmt.saveMailSettings(env, { emails: ['GM@example.test', 'gm@example.test'] }, { origin: 'https://insight.example.test' });
  assert.deepEqual([saved.emails, saved.admins, saved.adminEmails], [['gm@example.test'], true, ['owner@example.test']]);

  const { calls, fetchImpl } = world();
  const env2 = { ...env, HIVE: null };
  // Sending by itself is off until an admin switches it on: Monday sends nothing.
  assert.equal(saved.auto, false);
  assert.equal((await mgmt.sendDue(env2, { day: '2026-10-26', fetchImpl }))[0].reason, 'switched off');
  assert.equal(calls.length, 0);
  // Pressing Send goes whether or not it is on.
  const pressed = await mgmt.sendReport(env2, { period: 'week', at: '2026-10-12', fetchImpl, today: '2026-10-26' });
  assert.equal(pressed.sent, 2);
  calls.length = 0;
  assert.equal((await mgmt.saveMailSettings(env, { emails: ['gm@example.test'], auto: true })).auto, true);
  const out = await mgmt.sendDue(env2, { day: '2026-10-26', fetchImpl });
  assert.deepEqual(out.map((x) => [x.sent, x.key]), [[2, '2026-10-19']]);
  const mails = calls.filter(([who]) => who === 'hive').map(([, b]) => b);
  assert.deepEqual(mails.map((m) => m.to), ['owner@example.test', 'gm@example.test']);
  assert.equal(mails[0].subject, 'Management report, Week 43');
  assert.match(mails[0].html, /Needs your attention/);
  assert.match(mails[0].html, /https:\/\/insight\.example\.test\/#\/management\?period=week&amp;at=2026-10-19/);
  assert.match(mails[0].text, /Kofi Test: 82/);
  assert.ok(mails[0].html.length < 60000, 'HIVE takes at most 60,000 characters');

  assert.deepEqual((await mgmt.sendDue(env2, { day: '2026-10-26', fetchImpl }))[0].reason, 'already sent');
  assert.deepEqual(await mgmt.sendDue(env2, { day: '2026-10-27', fetchImpl }), [], 'nothing on a Tuesday');

  // Monthly off: the 1st sends nothing; a try to oneself always goes.
  await mgmt.saveMailSettings(env, { emails: ['gm@example.test'], monthly: false });
  assert.equal((await mgmt.sendDue(env2, { day: '2026-11-01', fetchImpl }))[0].reason, 'switched off');
  const mine = await mgmt.sendReport(env2, { period: 'month', at: '2026-10', to: 'me@example.test', fetchImpl, today: '2026-11-01' });
  assert.equal(mine.sent, 1);
});

test('a section left out is not asked for, has no figures or lines, and is left out of the email', async () => {
  const env = await linked();
  const { calls, fetchImpl } = world();
  const r = await mgmt.managementReport(env, { period: 'week', at: '2026-10-21', skip: 'maintenance,nonsense' }, { fetchImpl, today: '2026-10-27' });
  assert.deepEqual(r.skip, ['maintenance']);
  assert.deepEqual(calls.map(([who]) => who), ['breakfast'], 'maintenance is not asked');
  assert.equal(r.maintenance.skipped, true);
  assert.ok(r.tiles.length === 4 && r.tiles.every((t) => t.source === 'Breakfast'));
  assert.ok(r.attention.every((a) => a.source === 'Breakfast'));
  const mail = mgmt.reportEmail(r, 'https://insight.example.test/#/management');
  assert.doesNotMatch(mail.html, /🔧 Maintenance/);
  assert.match(mail.html, /Left out of this report: Maintenance/);

  // Pressed: the sections chosen on the page. By itself: the ones saved for it.
  await mgmt.saveMailSettings(env, { emails: ['gm@example.test'], admins: false, auto: true, skip: ['breakfast'] });
  calls.length = 0;
  const env2 = { ...env, HIVE: null };
  await mgmt.sendReport(env2, { period: 'week', at: '2026-10-19', skip: ['maintenance'], to: 'me@example.test', fetchImpl, today: '2026-10-27' });
  assert.deepEqual(calls.filter(([who]) => who !== 'hive').map(([who]) => who), ['breakfast']);
  calls.length = 0;
  await mgmt.sendDue(env2, { day: '2026-10-26', fetchImpl });
  assert.deepEqual([...new Set(calls.filter(([who]) => who !== 'hive').map(([who]) => who))], ['maintenance']);
});
