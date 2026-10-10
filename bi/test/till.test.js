import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import * as routes from '../src/routes/shifts.js';
import * as till from '../src/routes/till.js';
import { issuesFor, withStatus, compare, readReport } from '../src/shifts/till.js';
import { signLink, verifyLink, callLink } from '../src/lib/link.js';
import { parseJournal } from '../src/shifts/assd.js';
import * as safe from '../src/routes/safe.js';

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

async function setUp(lines = journal()) {
  const { db } = freshDb();
  const hive = hiveDb();
  const env = { DB: db, ATT_DB: hive.db, SSO_SECRET_ATTENDANCE: SECRET };
  await routes.uploadJournal(env, { lines, name: 'journal.pdf' }, OWNER);
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

// ---------------------------------------------------------------- the safe --

test('the safe: each shift’s envelopes beside ASSD, closed with a supervisor, and undone', async () => {
  const { env } = await setUp();
  const range = { from: '2026-08-01', to: '2026-08-01' };
  await assert.rejects(safe.safeView(env, range, SUPERVISOR), /Only an admin/);

  let view = await safe.safeView(env, range, OWNER);
  assert.deepEqual(view.rows.map((r) => [r.slot, r.user, r.assd, r.envelopes, r.agrees, r.closure]),
    [['morning', 'ALPHA', 20000, 25000, false, null]], 'only the shift that moved cash to the safe');
  assert.deepEqual(view.rows[0].list, [{ no: '417', amount: 25000 }]);
  assert.deepEqual(view.open, { shifts: 1, assd: 20000, envelopes: 25000 });

  await assert.rejects(safe.closeSafe(env, { shifts: [], closedOn: '2026-08-05' }, OWNER), /Tick the shifts/);
  await assert.rejects(safe.closeSafe(env, { shifts: [{ day: '2026-08-01', slot: 'afternoon' }], closedOn: '2026-08-05' }, OWNER), /moved nothing to the safe/);
  const out = await safe.closeSafe(env, {
    shifts: [{ day: '2026-08-01', slot: 'morning' }], closedOn: '2026-08-05', with: 'Sam Supervisor', taken: '150.00', note: 'Banked',
    // Amounts sent by the page are ignored: the server works them out.
    assd: 1,
  }, OWNER);
  assert.deepEqual([out.assd, out.envelopes, out.taken], [20000, 25000, 15000]);
  await assert.rejects(safe.closeSafe(env, { shifts: [{ day: '2026-08-01', slot: 'morning' }], closedOn: '2026-08-06' }, OWNER), /already in closure/);

  view = await safe.safeView(env, range, OWNER);
  assert.equal(view.rows[0].closure, out.id);
  assert.deepEqual(view.open, { shifts: 0, assd: 0, envelopes: 0 });
  assert.deepEqual(view.closures.map((c) => [c.closedOn, c.with, c.shifts, c.assd, c.taken, c.left]),
    [['2026-08-05', 'Sam Supervisor', 1, 20000, 15000, 5000]]);

  await safe.saveTaken(env, out.id, { taken: '200' }, OWNER);
  assert.equal((await safe.safeView(env, range, OWNER)).closures[0].left, 0);
  await safe.undoClosure(env, out.id, OWNER);
  view = await safe.safeView(env, range, OWNER);
  assert.deepEqual([view.rows[0].closure, view.closures.length], [null, 0]);
});

// ---------------------------------------------------------- unlabelled cash --

test('cash moved out with no label is an exception, and labelling it clears it', async () => {
  // ALPHA moves 150 where the count before it holds 200 in notes: no label.
  const lines = journal().map((l) => l.replace('01.08.26   -200,00 GHS', '01.08.26   -150,00 GHS').replace('01.08.26   200,00 GHS', '01.08.26   150,00 GHS'));
  const { env } = await setUp(lines);
  const read = async () => (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).exceptions;
  const x = (await read()).find((e) => e.kind === 'movement-unlabelled');
  assert.ok(x, 'flagged');
  assert.deepEqual([x.key, x.group, x.seq, x.amount, x.user, x.labels], ['unlabelled:400106', 'unlabelled', 400106, 15000, 'ALPHA', true]);

  await routes.saveMovement(env, { seq: 400106, kind: 'safe' }, OWNER);
  assert.equal((await read()).some((e) => e.kind === 'movement-unlabelled'), false, 'labelled, so gone');
});

// ------------------------------------------------------------------ laundry --

test('the laundry is compared shift by shift, once the laundry system has been read', async () => {
  // ALPHA takes 30 for laundry at the desk (in place of the padlock deposit);
  // the laundry system took 20 in the morning.
  const lines = journal().map((l) => l.replace('01.08.26   405   Padlock Deposit   1   30,00   30,00 GHS   0', '01.08.26   540   Laundry   1   30,00   30,00 GHS   0'));
  const { env } = await setUp(lines);
  await env.DB.prepare("INSERT INTO laundry_txn (source_id, kind, ref, at, day, amount, method) VALUES ('laundry', 'payment', 'L-1', '2026-08-01 09:30:00', '2026-08-01', 2000, 'cash')").run();
  await env.DB.prepare("INSERT INTO laundry_txn (source_id, kind, ref, at, day, amount, method) VALUES ('laundry', 'order', 'L-1', '2026-08-01 09:00:00', '2026-08-01', 3000, NULL)").run();
  const read = () => routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);

  // Not read yet: nothing to compare with, so nothing is flagged.
  let data = await read();
  assert.equal(data.exceptions.some((e) => e.kind === 'laundry-mismatch'), false);
  assert.equal(data.days[0].shifts.find((s) => s.user === 'ALPHA').laundrySystem, null);

  await env.DB.prepare("INSERT INTO etl_run (id, from_day, to_day, status) VALUES (1, '2026-07-25', '2026-08-02', 'ok')").run();
  await env.DB.prepare("INSERT INTO etl_source_run (run_id, source_id, status) VALUES (1, 'laundry', 'ok')").run();
  data = await read();
  const alpha = data.days[0].shifts.find((s) => s.user === 'ALPHA');
  assert.equal(alpha.laundry, 3000);
  const { list, ...sums } = alpha.laundrySystem;
  assert.deepEqual(sums, { collected: 2000, cash: 2000, card: 0, charged: 3000, payments: 1, orders: 1 });
  // Line by line, for the drop-down under the note: the laundry system's own
  // payment and order, and ASSD's laundry line with how it was paid.
  assert.deepEqual(list.map((t) => [t.kind, t.ref, t.at, t.amount, t.method]).sort(),
    [['order', 'L-1', '2026-08-01 09:00:00', 3000, null], ['payment', 'L-1', '2026-08-01 09:30:00', 2000, 'cash']]);
  assert.deepEqual(alpha.laundryLines.map((l) => [l.seq, l.amount, l.paid]), [[400104, 3000, 'cash']]);
  assert.ok(alpha.cashLines.some((c) => c.seq === 400103 && c.amount === 30000), 'each cash payment is listed');
  const x = data.exceptions.filter((e) => e.kind === 'laundry-mismatch');
  assert.deepEqual(x.map((e) => [e.key, e.amount, e.assd, e.system]), [['laundry:2026-08-01:morning', 1000, 3000, 2000]]);
  assert.equal(data.days[0].shifts.find((s) => s.user === 'BRAVO').laundrySystem.collected, 0, 'BRAVO: none either side, so no exception');
});

// ------------------------------------------------- a supervisor’s answers --

test('a supervisor’s answers and reconciliations wait for an admin before they clear', async () => {
  // ALPHA's 150 with no label, and the drawer over, so there is something to answer.
  const { env } = await setUp(journal().map((l) => l.replace('01.08.26   -200,00 GHS', '01.08.26   -150,00 GHS').replace('01.08.26   200,00 GHS', '01.08.26   150,00 GHS')));
  const range = { from: '2026-08-01', to: '2026-08-01' };
  const first = (await routes.shifts(env, range, OWNER)).exceptions.find((e) => e.severity !== 'info');
  assert.ok(first, 'there is something to answer');

  const out = await routes.saveAnswer(env, { key: first.key, answer: 'Explained', note: 'Counted again' }, SUPERVISOR, { pending: true });
  assert.equal(out.pending, true);
  let x = (await routes.shifts(env, range, OWNER)).exceptions.find((e) => e.key === first.key);
  assert.equal(x.answer, null, 'not cleared yet');
  assert.deepEqual([x.proposed.answer, x.proposed.by], ['Explained', 'Sam Supervisor']);

  const waiting = (await till.overview(env, range, OWNER)).answerApprovals;
  assert.deepEqual(waiting.map((a) => [a.type, a.id, a.answer]), [['answer', first.key, 'Explained']]);
  await assert.rejects(till.approve(env, { answer: first.key, ok: true }, SUPERVISOR), /Only an admin/);
  await till.approve(env, { answer: first.key, ok: true }, OWNER);
  x = (await routes.shifts(env, range, OWNER)).exceptions.find((e) => e.key === first.key);
  assert.equal(x.answer.answer, 'Explained');
  assert.equal(x.answer.approvedBy, 'Test Owner');
  await assert.rejects(routes.saveAnswer(env, { key: first.key, answer: 'Not a problem' }, SUPERVISOR, { pending: true }), /already been answered/);

  // A reconciliation, rejected: it is gone and the exceptions are open again.
  await routes.saveLink(env, { keys: ['a:1', 'b:2'], note: 'Same money' }, SUPERVISOR, { pending: true });
  const link = (await till.overview(env, range, OWNER)).answerApprovals.find((a) => a.type === 'link');
  assert.deepEqual(link.keys, ['a:1', 'b:2']);
  await till.approve(env, { link: link.id, ok: false }, OWNER);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM shift_link').first()).n, 0);

  // An admin's own answer applies at once.
  const second = (await routes.shifts(env, range, OWNER)).exceptions.find((e) => e.severity !== 'info' && e.key !== first.key);
  if (second) {
    await routes.saveAnswer(env, { key: second.key, answer: 'Not a problem' }, OWNER);
    assert.equal((await routes.shifts(env, range, OWNER)).exceptions.find((e) => e.key === second.key).answer.answer, 'Not a problem');
  }
});

test('a supervisor never gets the totals', async () => {
  const { env } = await setUp();
  const data = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  assert.ok(data.totals);
  assert.equal(routes.forSupervisor(data, { day: 1, week: 1, money: 1, bank: 1, net: 1 }).totals, null);
});

// ------------------------------------------------------------ the safe book --

test('the safe book: in from the shifts, out as written, Odoo offered, a count to close the page', async () => {
  const { env, hive } = await setUp();
  const safebook = await import('../src/routes/safebook.js');
  await env.DB.prepare("UPDATE sources SET config = '{\"base\":\"https://odoo.example.test\"}', enabled = 1 WHERE id = 'odoo'").run();
  env.ODOO_KEY_ODOO = 'k';
  // A small invented Odoo: three confirmed POs, one draft, and P00412, which a closing report already claimed.
  const ODOO = [
    { name: 'P00412', partner_id: [1, 'A Produce Seller'], amount_total: 30, state: 'purchase', date_order: '2026-08-01 09:00:00' },
    { name: 'P00433', partner_id: [2, 'A Gas Seller'], amount_total: 20, state: 'purchase', date_order: '2026-08-02 09:00:00' },
    { name: 'P00440', partner_id: [3, 'A Water Supplier'], amount_total: 15, state: 'purchase', date_order: '2026-08-02 10:00:00' },
    { name: 'P00444', partner_id: [4, 'A Cleaning Supplier'], amount_total: 5, state: 'purchase', date_order: '2026-08-02 11:00:00' },
    { name: 'P00450', partner_id: [5, 'A Hardware Shop'], amount_total: 9, state: 'draft', date_order: '2026-08-02 12:00:00' },
  ];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const domain = body.domain || [];
    let rows = ODOO;
    for (const [field, op, value] of domain) {
      if (field === 'name' && op === 'in') rows = rows.filter((r) => value.includes(r.name));
      if (field === 'date_order') rows = rows.filter((r) => r.date_order >= value);
      if (field === 'state') rows = rows.filter((r) => value.includes(r.state));
    }
    return new Response(JSON.stringify(rows.slice(body.offset || 0, (body.offset || 0) + (body.limit || 100))), { headers: { 'Content-Type': 'application/json' } });
  };
  const owner = { ...OWNER, isOwner: true };
  // Nothing has been counted, so the book has not begun.
  let book = await safebook.bookView(env, owner, { fetchImpl });
  assert.equal(book.started, false);
  await assert.rejects(safebook.bookView(env, SUPERVISOR, { fetchImpl }), /Only an admin/);

  // Start it: 500 counted on the 1st. ALPHA's 200 that day is taken as in it already.
  const started = await safebook.countSafe(env, { counted: '500', closedOn: '2026-07-31', with: 'Sam Supervisor' }, owner);
  assert.equal(started.started, true);
  book = await safebook.bookView(env, owner, { fetchImpl });
  assert.equal(book.started, true);
  assert.deepEqual(book.lines.map((l) => [l.type, l.day, l.amount, l.balance]), [['in', '2026-08-01', 20000, 70000]], 'ALPHA’s envelope comes in by itself');
  // P00412 is claimed by a closing report and the draft is not confirmed: neither is offered.
  assert.deepEqual(book.suggestions.map((s) => s.name), ['P00433', 'P00440', 'P00444']);
  // Only the POs ordered in the days on screen.
  const inJuly = await safebook.bookView(env, owner, { fetchImpl, from: '2026-07-01', to: '2026-07-31' });
  assert.deepEqual(inJuly.suggestions, []);
  const onTheSecond = await safebook.bookView(env, owner, { fetchImpl, from: '2026-08-02', to: '2026-08-02' });
  assert.deepEqual(onTheSecond.suggestions.map((s) => s.name), ['P00433', 'P00440', 'P00444']);
  const onTheFirst = await safebook.bookView(env, owner, { fetchImpl, from: '2026-08-01', to: '2026-08-01' });
  assert.deepEqual(onTheFirst.suggestions, [], 'P00412 is the only PO that day, and a closing report has it');

  // Out: a PO from the safe (its amount is the PO's), cash banked, and a payment waiting for its PO.
  await assert.rejects(safebook.addEntry(env, { kind: 'po', po: 'P00412', day: '2026-08-02' }, owner, { fetchImpl }), /already accounted for in a closing report/);
  await assert.rejects(safebook.addEntry(env, { kind: 'po', po: 'P00450', day: '2026-08-02' }, owner, { fetchImpl }), /not confirmed/);
  const po = await safebook.addEntry(env, { kind: 'po', po: '433', day: '2026-08-02' }, owner, { fetchImpl });
  assert.deepEqual([po.po, po.amount], ['P00433', 2000]);
  await assert.rejects(safebook.addEntry(env, { kind: 'po', po: 'P00433', day: '2026-08-02' }, owner, { fetchImpl }), /already accounted for in the safe/);
  await safebook.addEntry(env, { kind: 'banked', amount: '100', ref: 'GTBank slip 0048812', day: '2026-08-02' }, owner);
  await assert.rejects(safebook.addEntry(env, { kind: 'banked', amount: '100', day: '2026-08-02' }, owner), /Where it went/);
  await safebook.addEntry(env, { kind: 'pending', amount: '15', description: 'Water delivery', day: '2026-08-02' }, owner);
  book = await safebook.bookView(env, owner, { fetchImpl });
  assert.equal(book.balance, 50000 + 20000 - 2000 - 10000 - 1500);
  assert.equal(book.pending, 1);
  const water = book.suggestions.find((s) => s.name === 'P00440');
  assert.ok(water.pending, 'the 15 waiting for a PO is offered P00440 of the same amount');

  // Give the waiting payment its PO.
  const settled = await safebook.settleEntry(env, water.pending, { po: 'P00440' }, owner, { fetchImpl });
  assert.deepEqual([settled.po, settled.differs], ['P00440', false]);

  // A drawer cannot claim a PO the safe paid: Insight tells HIVE so.
  const link = await till.linkPo(env, { names: ['P00433'] }, { fetchImpl });
  assert.deepEqual(link.found[0].safe, { day: '2026-08-02' });

  // Count: 5 short of the book, and P00444 is exactly that.
  book = await safebook.bookView(env, owner, { fetchImpl, counted: 56000 });
  assert.equal(book.balance, 56500);
  assert.deepEqual(book.explains, ['P00444']);
  const count = await safebook.countSafe(env, { counted: '565', closedOn: '2026-08-02', with: 'Sam Supervisor' }, owner);
  assert.deepEqual([count.book, count.difference], [56500, 0]);
  book = await safebook.bookView(env, owner, { fetchImpl });
  assert.deepEqual(book.lines, [], 'a new page');
  assert.equal(book.start.counted, 56500);
  assert.equal(book.closures[0].difference, 0);

  // Undo the count: its envelope and payments are back on the open page.
  await safe.undoClosure(env, count.id, owner);
  book = await safebook.bookView(env, owner, { fetchImpl });
  assert.equal(book.lines.length, 4);
  void hive;
});

test('which waiting POs add up to a difference', async () => {
  const { addingUpTo } = await import('../src/routes/safebook.js');
  const list = [{ name: 'A', amount: 18000 }, { name: 'B', amount: 67500 }, { name: 'C', amount: 9500 }];
  assert.deepEqual(addingUpTo(list, 85500).map((x) => x.name), ['A', 'B']);
  assert.deepEqual(addingUpTo(list, 9500).map((x) => x.name), ['C']);
  assert.deepEqual(addingUpTo(list, 1), []);
  assert.deepEqual(addingUpTo(list, 0), []);
});

test('a report filed on the shift beside the one ASSD has its writer on is pointed out', async () => {
  const { env, hive } = await setUp();
  // Kofi closed late and the clock offered the night; ASSD has him (BRAVO) on
  // the afternoon, and CHARLIE on the night.
  hive.raw.exec("UPDATE till_report SET slot = 'night' WHERE user_id = 8");
  await env.DB.prepare("INSERT INTO till_people (assd_user, hive_user_id) VALUES ('BRAVO', 8)").run();
  const view = await till.overview(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER);
  const afternoon = view.reports.find((r) => r.day === '2026-08-01' && r.slot === 'afternoon');
  const night = view.reports.find((r) => r.day === '2026-08-01' && r.slot === 'night');
  assert.equal(afternoon.report, null);
  assert.deepEqual([afternoon.nearby?.slot, afternoon.nearby?.name], ['night', 'Kofi Test']);
  assert.deepEqual(night.belongs, { day: '2026-08-01', slot: 'afternoon', assdUser: 'BRAVO' });
  // Only an admin, or a supervisor allowed to reopen, may move it.
  await assert.rejects(till.moveReport(env, { reportId: afternoon.nearby.id, day: '2026-08-01', slot: 'afternoon' }, SUPERVISOR), /not been shared|look at this/);
  await assert.rejects(till.moveReport(env, { reportId: afternoon.nearby.id, day: '2026-08-01', slot: 'evening' }, OWNER), /Which shift/);
});
