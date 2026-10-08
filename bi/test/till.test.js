import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import * as routes from '../src/routes/shifts.js';
import * as till from '../src/routes/till.js';
import { issuesFor, withStatus, compare, readReport } from '../src/shifts/till.js';
import { signLink, verifyLink, callLink } from '../src/lib/link.js';
import { parseJournal } from '../src/shifts/assd.js';

/**
 * Closing a shift in HIVE, as Insight sees it.
 *
 * Everything here is invented: made-up users, a made-up hotel, made-up POs.
 * HIVE's own database is built from HIVE's migrations, the way Insight binds
 * it in production, so the reports are read with the real SQL.
 */

const PAGE = ['EHC/XXX test hotel   01.09.26 05:00', 'Business Reports   Page: 1', 'Benefit Date:   01.08.26   02.08.26', 'Type of Report:   Detail Journal of every Transaction'];
const block = (kind, user, seq, date, register, lines, guest = '/') => [`${kind}   ${user}   ${guest}`, `01-104-${seq}   ${register}/9${seq}-   ${date}   /`, ...lines];
const cash = (d, a) => `${d}   CASH   CASH   ${a} GHS`;
const count = (...notes) => [...notes, '0,00 GHS'];

/**
 * Two shifts. ALPHA takes 300 and a padlock deposit, moves 200 to the safe and
 * counts right; ASSD's own Items Count goes 6 → 5. BRAVO refunds a padlock,
 * pays 50 of expenses out of the drawer and counts right.
 */
function journal() {
  return [...PAGE,
    ...block('Beginn of Day Processing', 'ALPHA', 400100, '01.08.26', '001', []),
    ...block('Money Count', 'ALPHA', 400101, '01.08.26', '001', count('. .   00002   100 GHS   1   100,00   100,00 GHS')),
    ...block('Items Count', 'ALPHA', 400102, '01.08.26', '001', count('. .   405   Padlock Deposit   6   30,00   180,00 GHS')),
    ...block('Reservation', 'ALPHA', 400103, '01.08.26', '001', ['01.08.26   101   Double Room   1   300,00   300,00 GHS   19', cash('01.08.26', '300,00'), '300,00 GHS'], 'Test Guest / 1 Road'),
    ...block('Reservation', 'ALPHA', 400104, '01.08.26', '001', ['01.08.26   405   Padlock Deposit   1   30,00   30,00 GHS   0', cash('01.08.26', '30,00'), '30,00 GHS'], 'Test Guest / 1 Road'),
    ...block('Money Count', 'ALPHA', 400105, '01.08.26', '001', count('. .   00002   100 GHS   2   100,00   200,00 GHS')),
    ...block('Cash Movement', 'ALPHA', 400106, '01.08.26', '001', ['01.08.26   -200,00 GHS', '0,00 GHS']),
    ...block('Cash Movement', 'ALPHA', 400107, '01.08.26', '015', ['01.08.26   200,00 GHS', '0,00 GHS']),
    ...block('Money Count', 'ALPHA', 400108, '01.08.26', '001', count('. .   00002   100 GHS   2   100,00   200,00 GHS', '. .   00005   10 GHS   3   10,00   30,00 GHS')),
    ...block('Items Count', 'ALPHA', 400109, '01.08.26', '001', count('. .   405   Padlock Deposit   5   30,00   150,00 GHS')),
    ...block('Beginn of Day Processing', 'BRAVO', 400110, '01.08.26', '001', []),
    ...block('Money Count', 'BRAVO', 400111, '01.08.26', '001', count('. .   00002   100 GHS   2   100,00   200,00 GHS', '. .   00005   10 GHS   3   10,00   30,00 GHS')),
    ...block('Reservation', 'BRAVO', 400112, '01.08.26', '001', ['. .   405   Padlock Deposit   -1   30,00   -30,00 GHS   0', cash('01.08.26', '-30,00'), '-30,00 GHS'], 'Test Guest / 1 Road'),
    ...block('Money Count', 'BRAVO', 400113, '01.08.26', '001', count('. .   00002   100 GHS   1   100,00   100,00 GHS', '. .   00099   Total Expenses PAID   1   50,00   50,00 GHS')),
    ...block('Cash Movement', 'BRAVO', 400114, '01.08.26', '001', ['01.08.26   -50,00 GHS', '0,00 GHS']),
    ...block('Cash Movement', 'BRAVO', 400115, '01.08.26', '015', ['01.08.26   50,00 GHS', '0,00 GHS']),
    ...block('Money Count', 'BRAVO', 400116, '01.08.26', '001', count('. .   00002   100 GHS   1   100,00   100,00 GHS', '. .   00005   10 GHS   5   10,00   50,00 GHS')),
    ...block('Beginn of Day Processing', 'CHARLIE', 400120, '02.08.26', '001', []),
  ];
}

const OWNER = { name: 'Test Owner', isOwner: true, access: [] };
const SUPERVISOR = { id: 9, name: 'Sam Supervisor', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };
const SECRET = 'test-shared-secret';

/** HIVE's database, built from HIVE's own migrations, with two staff logins. */
function hiveDb() {
  const { raw, db } = freshDb('../migrations');
  raw.exec(`INSERT INTO users (id, name, role, active) VALUES (7, 'Ama Test', 'staff', 1), (8, 'Kofi Test', 'staff', 1)`);
  return { raw, db };
}

function report(raw, { day = '2026-08-01', slot, userId, name, cash: drawer, envelopes = [], rentals = {}, checks = [], expenses = [] }) {
  raw.prepare(`INSERT INTO till_report (day, slot, user_id, name, float_ok, cash, to_safe, envelopes, expenses, rentals, checks, signed_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, '2026-08-01 22:05:00')`)
    .run(day, slot, userId, name, drawer, envelopes.length ? 1 : 0, JSON.stringify(envelopes), JSON.stringify(expenses), JSON.stringify(rentals), JSON.stringify(checks));
}

async function setUp() {
  const { db } = freshDb();
  const hive = hiveDb();
  const env = { DB: db, ATT_DB: hive.db, SSO_SECRET_ATTENDANCE: SECRET };
  await routes.uploadJournal(env, { lines: journal(), name: 'journal.pdf' }, OWNER);
  // ALPHA was Ama. She wrote 250 in the envelope where ASSD moved 200, and
  // counted 4 padlocks at the end where ASSD's one deposit leaves 5.
  report(hive.raw, {
    slot: 'morning', userId: 7, name: 'Ama Test', cash: 23000, envelopes: [{ no: '417', amount: 25000 }],
    rentals: { padlock: { start: 6, end: 4 } }, checks: [{ id: 1, label: 'Scale', ok: false, guest: 'Room 12' }],
  });
  // BRAVO was Kofi. A confirmed PO covers 30 of the 50 paid out.
  report(hive.raw, { slot: 'afternoon', userId: 8, name: 'Kofi Test', cash: 15000, rentals: { padlock: { start: 5, end: 6 } } });
  hive.raw.prepare(`INSERT INTO till_po (po, user_id, day, slot, paid, total, vendor, state) VALUES ('P00412', 8, '2026-08-01', 'afternoon', 3000, 3000, 'A Supplier', 'purchase')`).run();
  return { env, hive };
}

test('rentals and ASSD’s own item counts are read from the journal, refunds included', () => {
  const entries = parseJournal(journal());
  const deposit = entries.find((e) => e.seq === 400104);
  const refund = entries.find((e) => e.seq === 400112);
  assert.deepEqual(deposit.items.find((i) => i.code === '405'), { date: '2026-08-01', code: '405', qty: 1 });
  assert.deepEqual(refund.items, [{ date: '2026-08-01', code: '405', qty: -1 }], 'a refund prints no date of its own');
  assert.deepEqual(entries.find((e) => e.seq === 400109).stock, { 405: 5 });
});

test('each shift beside its closing report: drawer, safe, money out and rentals', async () => {
  const { env } = await setUp();
  const { issues, shifts } = await till.issuesBetween(env, '2026-08-01', '2026-08-02');
  const alpha = shifts.find((s) => s.user === 'ALPHA');
  assert.deepEqual(alpha.items, { 101: 1, 405: 1 });
  assert.deepEqual([alpha.stockStart, alpha.stockEnd], [{ 405: 6 }, { 405: 5 }]);

  const kinds = issues.map((i) => `${i.kind}:${i.userId}:${i.amount}`).sort();
  assert.deepEqual(kinds, [
    'overclaimed:7:5000', // envelopes 250 against 200 moved out
    'rental:7:-3000', // 6 − 1 rented = 5 expected, 4 counted
    'unexplained:8:-2000', // 50 out, 30 covered by a PO
  ]);
  const rental = issues.find((i) => i.kind === 'rental');
  assert.equal(rental.qty, -1);
  assert.match(rental.text, /ASSD has 1 padlock deposit on your shift, so 5 were expected/);
  assert.ok(!issues.some((i) => i.userId === 8 && i.kind === 'rental'), 'one refunded, one more at the end: agrees');
});

test('agree or not, without the amounts', async () => {
  const { env, hive } = await setUp();
  const { shifts, pos } = await till.issuesBetween(env, '2026-08-01', '2026-08-02');
  const rows = hive.raw.prepare('SELECT * FROM till_report ORDER BY id').all().map(readReport);
  const c = compare(shifts.find((s) => s.user === 'ALPHA'), rows[0], { pos, rentals: [{ id: 'padlock', label: 'Padlocks', unit: 'padlock', article: '405', deposit: 3000 }] });
  assert.equal(c.countAgrees, true);
  assert.equal(c.safeAgrees, false);
  assert.equal(c.rentals[0].assdStock, 5);
});

test('a shift nobody closed is the mapped person’s, from the day reports began', () => {
  const shifts = [
    { day: '2026-07-31', slot: 'night', user: 'CHARLIE', register: {} },
    { day: '2026-08-01', slot: 'night', user: 'CHARLIE', register: {} },
  ];
  const out = issuesFor({ shifts, reports: [], people: new Map([['CHARLIE', 9]]), since: '2026-08-01' });
  assert.deepEqual(out.map((i) => [i.kind, i.day, i.userId]), [['noreport', '2026-08-01', 9]]);
});

test('small differences are left alone when asked', () => {
  const shifts = [{ day: '2026-08-01', slot: 'morning', user: 'A', register: { variance: -50, closing: 1000 } }];
  assert.equal(issuesFor({ shifts, reports: [], threshold: 100 }).length, 0);
  assert.equal(issuesFor({ shifts, reports: [], threshold: 0 }).length, 1);
});

test('where each stands: answered, sent back, settled', () => {
  const issue = { key: 'drawer:2026-08-01:morning', userId: 7 };
  const at = (t) => `2026-08-02 ${t}`;
  const one = (answers, resolutions) => withStatus([issue], { answers, resolutions })[0];
  assert.equal(one([], []).status, 'open');
  assert.equal(one([{ key: issue.key, user_id: 7, how: 'explain', text: 'miscounted', at: at('09:00') }], []).status, 'answered');
  assert.equal(one([{ key: issue.key, user_id: 7, how: 'explain', text: 'x', at: at('09:00') }],
    [{ key: issue.key, hive_user_id: 7, outcome: 'back', at: at('10:00') }]).status, 'open', 'sent back after the answer');
  assert.equal(one([{ key: issue.key, user_id: 7, how: 'explain', text: 'y', at: at('11:00') }],
    [{ key: issue.key, hive_user_id: 7, outcome: 'back', at: at('10:00') }]).status, 'answered', 'answered again');
  assert.equal(one([], [{ key: issue.key, hive_user_id: 7, outcome: 'writeoff', at: at('12:00') }]).status, 'settled');
  assert.equal(one([], [{ key: issue.key, hive_user_id: 8, outcome: 'writeoff', at: at('12:00') }]).status, 'open', 'somebody else’s decision');
});

test('a person’s list over the link, and settling it', async () => {
  const { env, hive } = await setUp();
  // The link looks at the last sixty days; this journal is in August 2026.
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-08-03T09:00:00Z');
  const RealDate = Date;
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [RealDate.parse('2026-08-03T09:00:00Z')])); } static now() { return RealDate.parse('2026-08-03T09:00:00Z'); } };
  try {
    let list = await till.linkIssues(env, { userId: 8 });
    assert.deepEqual(list.issues.map((i) => i.kind), ['unexplained']);
    assert.equal(list.issues[0].amount, -2000);

    hive.raw.prepare(`INSERT INTO till_answer (key, user_id, how, text, at) VALUES (?, 8, 'repay', 'From my pay', '2026-08-03 08:00:00')`).run(list.issues[0].key);
    list = await till.linkIssues(env, { userId: 8 });
    assert.equal(list.issues[0].status, 'answered');

    // Recovering from pay asks HIVE, signed; HIVE answers with the advance.
    const asked = [];
    const fetchImpl = async (request) => {
      const body = await request.text();
      const url = new URL(request.url);
      assert.ok(await verifyLink(SECRET, { at: request.headers.get('X-Till-At'), sig: request.headers.get('X-Till-Sig'), path: url.pathname, bodyText: body }));
      asked.push([url.pathname, JSON.parse(body)]);
      return Response.json(url.pathname.endsWith('/recover') ? { ok: true, advanceId: 55 } : { ok: true });
    };
    await assert.rejects(till.resolve(env, { key: list.issues[0].key, userId: 8, outcome: 'recover' }, SUPERVISOR, { fetchImpl }), /not been shared|not change/);
    const out = await till.resolve(env, { key: list.issues[0].key, userId: 8, outcome: 'recover', note: 'agreed' }, OWNER, { fetchImpl });
    assert.equal(out.advanceId, 55);
    assert.deepEqual(asked[0], ['/api/link/till/recover', { userId: 8, amount: 2000, key: list.issues[0].key, reason: 'Till: Cash left the drawer with no envelope or PO, 2026-08-01 afternoon', by: 'Test Owner' }]);
    assert.equal(asked[1][0], '/api/link/till/tell');

    list = await till.linkIssues(env, { userId: 8 });
    assert.deepEqual(list.issues, [], 'settled leaves the list');
    assert.equal(list.cleared, 1);
  } finally {
    global.Date = RealDate;
    Date.now = realNow;
  }
});

test('the link: signed, recent and unaltered, or refused', async () => {
  const headers = await signLink(SECRET, '/api/link/till/po', '{"names":["412"]}', 1_000_000);
  const base = { at: headers['X-Till-At'], sig: headers['X-Till-Sig'], path: '/api/link/till/po', bodyText: '{"names":["412"]}', now: 1_000_000 };
  assert.equal(await verifyLink(SECRET, base), true);
  assert.equal(await verifyLink('another secret', base), false);
  assert.equal(await verifyLink(SECRET, { ...base, bodyText: '{"names":["413"]}' }), false, 'altered on the way');
  assert.equal(await verifyLink(SECRET, { ...base, path: '/api/link/till/issues' }), false, 'replayed somewhere else');
  assert.equal(await verifyLink(SECRET, { ...base, now: 1_000_000 + 6 * 60 * 1000 }), false, 'too old');
  await assert.rejects(callLink({ secret: null, path: '/x' }), /not linked yet/);
});

test('a PO is found however somebody types it', () => {
  assert.deepEqual(till.poVariants('412'), ['412', 'P00412', 'PO00412', 'P000412']);
  assert.ok(till.poVariants('po 412').includes('P00412'));
  assert.ok(till.poVariants('PO0412').includes('P00412'), 'an O for a nought');
  assert.deepEqual(till.poVariants(''), []);
});

test('a supervisor gets what the admin chose, and nothing more', async () => {
  const { env } = await setUp();
  let access = await till.accessOf(env, SUPERVISOR);
  assert.deepEqual([access.day, access.week, access.month, access.money, access.moves], [1, 1, 0, 1, 2]);
  assert.equal(till.roleOf(SUPERVISOR), 'supervisor');
  assert.equal(till.roleOf({ access: [{ systemId: 'insight', role: '' }] }), 'admin');

  await till.saveSettings(env, { access: { accountId: 9, area: 'money', level: 0 } }, OWNER);
  access = await till.accessOf(env, SUPERVISOR);
  assert.equal(access.money, 0, 'their own copy');
  assert.equal(access.moves, 2, 'copied from everybody’s');
  assert.equal((await till.accessOf(env, { ...SUPERVISOR, id: 10 })).money, 1, 'nobody else changed');
  await assert.rejects(till.saveSettings(env, { threshold: 1 }, SUPERVISOR), /Only an admin/);

  const data = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  const cut = routes.forSupervisor(data, access);
  const alpha = cut.days[0].shifts[0];
  assert.equal(alpha.cash, null);
  assert.equal(alpha.register.closing, null);
  assert.equal(alpha.register.varianceSign, 0, 'agrees, without saying how much');
  assert.ok(Object.values(alpha.modes).every((v) => v === null));
  assert.equal(cut.redacted, true);
});

test('a supervisor’s correction waits for an admin', async () => {
  const { env } = await setUp();
  const bravo = async () => (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).days[0].shifts.find((s) => s.user === 'BRAVO');
  assert.equal((await bravo()).register.expenses, 5000);
  const out = await routes.saveMovement(env, { seq: 400114, kind: 'safe' }, SUPERVISOR, { pending: true });
  assert.deepEqual([out.pending, out.seq], [true, 400114]);
  let b = await bravo();
  assert.equal(b.register.expenses, 5000, 'not counted yet');
  assert.equal(b.moves.find((m) => m.seq === 400114).pending.by, 'Sam Supervisor');

  const waiting = (await till.overview(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).approvals;
  assert.deepEqual(waiting.map((a) => [a.seq, a.kind, a.amount]), [[400114, 'safe', 5000]]);
  await assert.rejects(till.approve(env, { seq: 400114, ok: true }, SUPERVISOR), /Only an admin/);
  await till.approve(env, { seq: 400114, ok: true }, OWNER);
  b = await bravo();
  assert.deepEqual([b.register.expenses, b.register.toSafe], [0, 5000]);
  await assert.rejects(routes.saveMovement(env, { seq: 400114, kind: 'expenses' }, SUPERVISOR, { pending: true }), /already been corrected/);
});

test('exceptions reconciled together count as answered, and come back when undone', async () => {
  const { env } = await setUp();
  const keys = ['not-recorded:a', 'not-found:b', 'handover:c'];
  await assert.rejects(routes.saveLink(env, { keys: ['one'] }, OWNER), /at least two/);
  await routes.saveLink(env, { keys, note: 'The same 203 paid on the 2nd and keyed on the 4th' }, OWNER);
  await assert.rejects(routes.saveLink(env, { keys: ['not-found:b', 'x:y'] }, OWNER), /already reconciled/);
  const row = (await env.DB.prepare('SELECT * FROM shift_link').all()).results[0];
  assert.deepEqual(JSON.parse(row.keys), keys);
  await routes.removeLink(env, { id: row.id });
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM shift_link').first()).n, 0);
});

test('the overview is cut to what a supervisor may see', async () => {
  const { env } = await setUp();
  await till.saveSettings(env, { access: { accountId: 9, area: 'money', level: 0 } }, OWNER);
  const admin = await till.overview(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  const sup = await till.overview(env, { from: '2026-08-01', to: '2026-08-01' }, SUPERVISOR);
  const a = admin.reports.find((r) => r.slot === 'morning');
  const s = sup.reports.find((r) => r.slot === 'morning');
  assert.equal(a.report.cash, 23000);
  assert.equal(s.report.cash, null);
  assert.equal(s.report.envelopes[0].amount, null);
  assert.equal(s.compare.safeAgrees, false, 'still says it does not agree');
  assert.equal(s.compare.out, null);
  assert.ok(admin.settings && !sup.settings, 'settings are the admin’s');
  assert.deepEqual(admin.settings.checks.map((c) => c.label), ['Scale', 'Hair dryer']);
  assert.deepEqual(admin.settings.rentals.map((r) => [r.id, r.article, r.deposit, r.refund, r.active]),
    [['padlock', '405', 3000, 3000, 1], ['towel', '400', 4000, 3000, 0]], 'towels set up, not counted yet');
});

test('the till settings: checks, rentals, who is told', async () => {
  const { env } = await setUp();
  await till.saveSettings(env, { check: { label: 'Iron' } }, OWNER);
  await till.saveSettings(env, { check: { id: 2, active: false } }, OWNER);
  assert.deepEqual((await till.linkSetup(env)).checks.map((c) => c.label), ['Scale', 'Iron']);
  await till.saveSettings(env, { rental: { id: 'towel', active: true } }, OWNER);
  assert.deepEqual((await till.linkSetup(env)).rentals.map((r) => r.id), ['padlock', 'towel']);
  await assert.rejects(till.saveSettings(env, { rental: { id: 'towel', refund: '50' } }, OWNER), /cannot be more than the deposit/);
  await till.saveSettings(env, { notify: { hiveUserId: 7, name: 'Ama Test', amounts: false } }, OWNER);
  assert.deepEqual((await till.linkRecipients(env, { event: 'closed' })).to, [{ userId: 7, name: 'Ama Test', push: true, email: true, amounts: false }]);
  assert.deepEqual((await till.linkRecipients(env, { event: 'approval' })).to, [], 'approvals are opt in');
});
