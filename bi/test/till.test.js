import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import * as routes from '../src/routes/shifts.js';
import * as till from '../src/routes/till.js';
import { issuesFor, withStatus, compare, readReport } from '../src/shifts/till.js';
import { signLink, verifyLink, callLink } from '../src/lib/link.js';
import { parseJournal } from '../src/shifts/assd.js';
import * as safe from '../src/routes/safe.js';
import * as envelopes from '../src/routes/envelopes.js';
import * as notes from '../src/routes/notes.js';

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
  assert.deepEqual(deposit.items.find((i) => i.code === '405'), { date: '2026-08-01', code: '405', qty: 1, name: 'Padlock Deposit', amount: 3000 });
  assert.deepEqual(refund.items, [{ date: '2026-08-01', code: '405', qty: -1, name: 'Padlock Deposit', amount: -3000 }], 'a refund prints no date of its own');
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
    // Not until the shift is checked: the amount may still change.
    await assert.rejects(till.resolve(env, { key: list.issues[0].key, userId: 8, outcome: 'recover', note: 'agreed' }, OWNER, { fetchImpl }), /not been checked yet/);
    assert.equal(asked.length, 0, 'HIVE is not asked');
    await till.checkShift(env, { day: '2026-08-01', slot: 'afternoon' }, OWNER, { fetchImpl });
    asked.length = 0;
    const out = await till.resolve(env, { key: list.issues[0].key, userId: 8, outcome: 'recover', note: 'agreed' }, OWNER, { fetchImpl });
    assert.equal(out.advanceId, 55);
    const [path, sent] = asked[0];
    assert.equal(path, '/api/link/till/recover');
    assert.deepEqual({ ...sent, checkedAt: undefined }, {
      userId: 8, amount: 2000, key: list.issues[0].key, reason: 'Till: Cash left the drawer with no envelope or PO, 2026-08-01 afternoon', by: 'Test Owner',
      day: '2026-08-01', slot: 'afternoon', checked: true, checkedBy: 'Test Owner', checkedAt: undefined,
    });
    assert.ok(sent.checkedAt, 'when it was checked goes with it');
    assert.equal(asked[1][0], '/api/link/till/tell');

    // Recovered from pay stays on their list, marked so; nothing else settled does.
    list = await till.linkIssues(env, { userId: 8 });
    assert.equal(list.issues.length, 1);
    assert.deepEqual({ ...list.issues[0].recovered, at: undefined }, { how: 'recover', amount: 2000, at: undefined, by: 'Test Owner', advanceId: 55 });
    assert.equal(list.cleared, 0);
    // And it is decided, so it is no longer waiting in HIVE.
    assert.deepEqual((await till.linkToDecide(env)).issues, []);
  } finally {
    global.Date = RealDate;
    Date.now = realNow;
  }
});

test('HIVE lists shortages on checked shifts and decides them: not recovered leaves the person’s list', async () => {
  const { env } = await setUp();
  const realNow = Date.now;
  const RealDate = Date;
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [RealDate.parse('2026-08-03T09:00:00Z')])); } static now() { return RealDate.parse('2026-08-03T09:00:00Z'); } };
  try {
    const fetchImpl = async () => Response.json({ ok: true });
    // Not checked yet: nothing to decide.
    assert.deepEqual((await till.linkToDecide(env)).issues, []);
    await till.checkShift(env, { day: '2026-08-01', slot: 'afternoon' }, OWNER, { fetchImpl });
    const waiting = (await till.linkToDecide(env)).issues;
    assert.equal(waiting.length, 1);
    assert.deepEqual([waiting[0].userId, waiting[0].amount, waiting[0].day, waiting[0].slot, waiting[0].checkedBy], [8, 2000, '2026-08-01', 'afternoon', 'Test Owner']);
    // No answer from them is needed.
    assert.equal(waiting[0].answer, null);

    await assert.rejects(till.linkDecide(env, { key: waiting[0].key, userId: 8, outcome: 'maybe' }, { fetchImpl }), /Recover it, pay it, or not/);
    await till.linkDecide(env, { key: waiting[0].key, userId: 8, outcome: 'writeoff', by: 'Pay Person' }, { fetchImpl });
    assert.deepEqual((await till.linkToDecide(env)).issues, []);
    const list = await till.linkIssues(env, { userId: 8 });
    assert.deepEqual(list.issues, [], 'not recovered leaves their list');
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
  // ALPHA's GH₵200 movement: the count before it was all notes, so to the safe.
  const alpha = async () => (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).days[0].shifts.find((s) => s.user === 'ALPHA');
  assert.deepEqual([(await alpha()).register.expenses, (await alpha()).register.toSafe], [0, 20000]);
  const out = await routes.saveMovement(env, { seq: 400106, kind: 'expenses' }, SUPERVISOR, { pending: true });
  assert.deepEqual([out.pending, out.seq], [true, 400106]);
  let a = await alpha();
  assert.equal(a.register.expenses, 0, 'not counted yet');
  assert.equal(a.moves.find((m) => m.seq === 400106).pending.by, 'Sam Supervisor');

  const waiting = (await till.overview(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).approvals;
  assert.deepEqual(waiting.map((x) => [x.seq, x.kind, x.amount]), [[400106, 'expenses', 20000]]);
  await assert.rejects(till.approve(env, { seq: 400106, ok: true }, SUPERVISOR), /Only an admin/);
  await till.approve(env, { seq: 400106, ok: true }, OWNER);
  a = await alpha();
  assert.deepEqual([a.register.expenses, a.register.toSafe], [20000, 0]);
  await assert.rejects(routes.saveMovement(env, { seq: 400106, kind: 'safe' }, SUPERVISOR, { pending: true }), /already been corrected/);
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

test('laundry paid by card on the terminal and not keyed in ASSD is one difference, not two', async () => {
  const { env } = await setUp();
  await env.DB.prepare("INSERT INTO etl_run (id, from_day, to_day, status) VALUES (1, '2026-07-25', '2026-08-02', 'ok')").run();
  await env.DB.prepare("INSERT INTO etl_source_run (run_id, source_id, status) VALUES (1, 'laundry', 'ok')").run();
  // The guest paid GH₵14 for laundry by card on the hotel terminal at 10:15; the laundry system has it at 10:12.
  await env.DB.prepare(`INSERT INTO terminal_txn (rrn, at, day, kind, amount, last4, approved, loaded_at)
    VALUES ('T1', '2026-08-01 10:15:00', '2026-08-01', 'card', 1400, '8159', 1, '2026-08-02 08:00:00')`).run();
  await env.DB.prepare("INSERT INTO laundry_txn (source_id, kind, ref, at, day, amount, method) VALUES ('laundry', 'payment', 'L-9', '2026-08-01 10:12:00', '2026-08-01', 1400, 'card')").run();
  const read = async () => (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).exceptions;

  let x = await read();
  const one = x.find((e) => e.kind === 'laundry-card');
  assert.deepEqual([one.key, one.amount, one.minutesApart, one.laundry.ref, one.event.last4, one.user], ['laundry-card:t:T1', 1400, 3, 'L-9', '8159', 'ALPHA']);
  assert.equal(x.some((e) => e.kind === 'not-recorded' || e.kind === 'laundry-mismatch'), false, 'neither shown on its own');

  // One answer settles both.
  await routes.saveAnswer(env, { key: one.key, answer: 'Keyed in ASSD now' }, OWNER);
  x = await read();
  assert.equal(x.find((e) => e.key === one.key).answer.answer, 'Keyed in ASSD now');

  // Not the same payment: apart again, each to answer, and the card says why.
  await routes.saveAnswer(env, { key: one.key, answer: 'Not the same payment' }, OWNER);
  x = await read();
  assert.equal(x.some((e) => e.kind === 'laundry-card'), false);
  assert.equal(x.find((e) => e.kind === 'not-recorded').split.key, one.key);
  assert.equal(x.find((e) => e.kind === 'laundry-mismatch').amount, -1400);

  // Further apart than half an hour: not paired.
  await routes.saveAnswer(env, { key: one.key, answer: '' }, OWNER);
  await env.DB.prepare("UPDATE laundry_txn SET at = '2026-08-01 11:00:00' WHERE ref = 'L-9'").run();
  x = await read();
  assert.equal(x.some((e) => e.kind === 'laundry-card'), false);
});

test('laundry keyed twice by card says what the terminal and the laundry system saw', async () => {
  // ALPHA keys GH₵70 of laundry by card twice; the terminal approved it once.
  const laundry = (seq) => block('Reservation', 'ALPHA', seq, '01.08.26', '001',
    ['01.08.26   540   Laundry   1   70,00   70,00 GHS   0', '01.08.26   CR.   CREDIT CARD   70,00 GHS', '70,00 GHS'], 'Test Guest / 1 Road');
  const lines = journal();
  const at = lines.findIndex((l) => l.includes('400103'));
  const start = lines.lastIndexOf(lines.slice(0, at).reverse().find((l) => l.startsWith('Reservation')), at);
  const end = lines.findIndex((l, i) => i > at && l.startsWith('Money Count'));
  const { env } = await setUp([...lines.slice(0, start), ...laundry(400103), ...laundry(400104), ...lines.slice(end)]);
  await env.DB.prepare(`INSERT INTO terminal_txn (rrn, at, day, kind, amount, last4, approved, loaded_at)
    VALUES ('T7', '2026-08-01 09:30:00', '2026-08-01', 'card', 7000, '4242', 1, '2026-08-02 08:00:00')`).run();
  const read = async () => (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).exceptions.find((e) => e.kind === 'duplicate');

  let x = await read();
  assert.ok(x, 'keyed twice');
  assert.deepEqual([x.declined, x.laundry], [[], { read: false }], 'the laundry system not read yet');

  await env.DB.prepare("INSERT INTO etl_run (id, from_day, to_day, status) VALUES (1, '2026-07-25', '2026-08-02', 'ok')").run();
  await env.DB.prepare("INSERT INTO etl_source_run (run_id, source_id, status) VALUES (1, 'laundry', 'ok')").run();
  await env.DB.prepare("INSERT INTO laundry_txn (source_id, kind, ref, at, day, amount, method) VALUES ('laundry', 'payment', 'L-7', '2026-08-01 09:27:00', '2026-08-01', 7000, 'card')").run();
  x = await read();
  assert.deepEqual(x.laundry, { read: true, same: [{ at: '2026-08-01 09:27:00', method: 'card', ref: 'L-7' }] }, 'paid once in the laundry system too');
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
  // CHARLIE is nobody's login yet: not known, which is not a mismatch. Once
  // mapped to Ama, ASSD has somebody else on the night it sits on.
  assert.equal(night.assdMatches, null);
  await env.DB.prepare("INSERT INTO till_people (assd_user, hive_user_id) VALUES ('CHARLIE', 7)").run();
  const again = await till.overview(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER);
  assert.equal(again.reports.find((r) => r.day === '2026-08-01' && r.slot === 'night').assdMatches, false);
});

test('a report moves to any free shift near when it was signed, with a reason kept', async () => {
  const { env, hive } = await setUp();
  const id = hive.raw.prepare('SELECT id FROM till_report WHERE user_id = 8').get().id;
  const sent = [];
  const fetchImpl = async (req) => { sent.push(await req.json()); return Response.json({ ok: true, moved: true }); };
  const move = (body) => till.moveReport(env, { reportId: id, day: '2026-08-01', slot: 'night', reason: 'Signed after 22:00', ...body }, OWNER, { fetchImpl });
  await assert.rejects(move({ reason: '' }), /Say why/);
  await assert.rejects(move({ day: '2026-08-04' }), /two days either side/i, 'signed on 1 August: the 4th is too far');
  await move({ day: '2026-07-30' });
  await move({});
  assert.deepEqual(sent.at(-1), { reportId: id, day: '2026-08-01', slot: 'night', by: 'Test Owner', reason: 'Signed after 22:00' });

  // The chooser's view of a day: who ASSD has on each shift and any report there.
  const day = await till.slotsFor(env, { day: '2026-08-01' }, OWNER);
  assert.deepEqual(day.slots.map((x) => [x.slot, x.assdUser, x.report?.name || null]),
    [['morning', 'ALPHA', 'Ama Test'], ['afternoon', 'BRAVO', 'Kofi Test'], ['night', 'CHARLIE', null]]);
  await assert.rejects(till.slotsFor(env, { day: 'soon' }, OWNER), /Which day/);
  await assert.rejects(till.slotsFor(env, { day: '2026-08-01' }, SUPERVISOR), /not been shared|look at this/);

  // Once moved in HIVE, the report says where it came from, who moved it and why.
  hive.raw.exec("UPDATE till_report SET slot = 'night', moved_from = '2026-08-01|afternoon', moved_by = 'Test Owner', moved_at = '2026-08-02 09:14:00', moved_reason = 'Signed after 22:00' WHERE user_id = 8");
  const view = await till.overview(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER);
  assert.deepEqual(view.reports.find((r) => r.slot === 'night' && r.day === '2026-08-01').report.moved, {
    from: { day: '2026-08-01', slot: 'afternoon' }, by: 'Test Owner', at: '2026-08-02 09:14:00', reason: 'Signed after 22:00',
  });
});

test('a shift card shows the POs from its closing report, not "no PO numbers yet"', async () => {
  const { env } = await setUp();
  const view = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  const afternoon = view.days.flatMap((d) => d.shifts).find((s) => s.slot === 'afternoon');
  assert.ok(afternoon.expense, 'the closing report gives it an expense block');
  assert.deepEqual(afternoon.expense.odoo.orders.map((o) => [o.name, o.total, o.fromReport]), [['P00412', 3000, true]]);
  assert.equal(afternoon.expense.odooTotal, 3000);
  assert.deepEqual(afternoon.expense.fromReport, ['P00412']);
  assert.equal(afternoon.expense.poNumbers, null, 'nothing is written into what is typed here');
  // A PO typed here as well is not shown twice.
  await routes.saveExpense(env, { day: '2026-08-01', slot: 'afternoon', sheetTotal: '50', poNumbers: 'P00412' }, OWNER);
  await env.DB.prepare("UPDATE shift_expense SET odoo = ?1 WHERE day = '2026-08-01' AND slot = 'afternoon'")
    .bind(JSON.stringify({ orders: [{ name: 'P00412', vendor: 'A Supplier', total: 3000, state: 'purchase' }], unknown: [] })).run();
  const again = (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).days.flatMap((d) => d.shifts).find((s) => s.slot === 'afternoon');
  assert.deepEqual(again.expense.odoo.orders.map((o) => o.name), ['P00412']);
  assert.deepEqual(again.expense.fromReport, []);
});

test('a drawer difference reconciled with others leaves its person’s list; one waiting for an admin does not', async () => {
  // BRAVO counts 20 more than the drawer should hold at the end.
  const lines = journal().map((l) => l.replace('00005   10 GHS   5   10,00   50,00 GHS', '00005   10 GHS   7   10,00   70,00 GHS'));
  const { env } = await setUp(lines);
  const drawer = async () => (await till.issuesBetween(env, '2026-08-01', '2026-08-02')).issues.filter((i) => i.kind === 'drawer');
  assert.deepEqual((await drawer()).map((i) => [i.key, i.userId, i.amount]), [['drawer:2026-08-01:afternoon', 8, 2000]]);

  await routes.saveLink(env, { keys: ['drawer:2026-08-01:afternoon', 'drawer:2026-08-03:morning'], note: 'The 20 short the next morning' }, SUPERVISOR, { pending: true });
  assert.equal((await drawer()).length, 1, 'still theirs until an admin approves');
  await env.DB.prepare("UPDATE shift_link SET status = 'applied'").run();
  assert.deepEqual(await drawer(), [], 'reconciled: off the list');
  assert.ok(!(await till.linkIssues(env, { userId: 8 })).issues.some((i) => i.kind === 'drawer'), 'and off HIVE’s To sort out');
  await env.DB.prepare('DELETE FROM shift_link').run();
  assert.equal((await drawer()).length, 1, 'undone: back on it');
});

test('a PO HIVE saved as confirmed reads as approved on the shift', async () => {
  const { env, hive } = await setUp();
  hive.raw.prepare("UPDATE till_po SET state = 'confirmed'").run();
  const out = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  const bravo = out.days[0].shifts.find((s) => s.slot === 'afternoon');
  assert.deepEqual(bravo.expense.odoo.orders.map((o) => [o.name, o.state]), [['P00412', 'purchase']]);
});

test('an admin puts a drawer difference on staff accounts, with a reason; they are told, and undo puts it back', async () => {
  // BRAVO (Kofi, 8) counts 20 more than the drawer should hold.
  const lines = journal().map((l) => l.replace('00005   10 GHS   5   10,00   50,00 GHS', '00005   10 GHS   7   10,00   70,00 GHS'));
  const { env, hive } = await setUp(lines);
  hive.raw.exec("INSERT INTO users (id, name, role, active) VALUES (9, 'Yaw Test', 'staff', 1)");
  const told = [];
  const fetchImpl = async (request) => { told.push(JSON.parse(await request.text())); return Response.json({ ok: true }); };
  const key = 'drawer:2026-08-01:afternoon';
  const listOf = async (userId) => (await till.issuesBetween(env, '2026-08-01', '2026-08-02')).issues
    .filter((i) => Number(i.userId) === userId && ['drawer', 'moved'].includes(i.kind)).map((i) => [i.kind, i.amount]);
  assert.deepEqual(await listOf(8), [['drawer', 2000]]);

  const move = (body, who = OWNER) => till.moveToStaff(env, { key, reason: 'Yaw relieved Kofi without a count', ...body }, who, { fetchImpl });
  await assert.rejects(move({ shares: [{ userId: 9, amount: 2000 }] }, SUPERVISOR), /Only an admin/);
  await assert.rejects(move({ shares: [{ userId: 9, amount: 2000 }], reason: '' }), /reason/i);
  await assert.rejects(move({ shares: [{ userId: 9, amount: 1500 }] }), /come to GH₵15\.00 and the difference is GH₵20\.00/);
  await assert.rejects(move({ shares: [{ userId: 9, amount: 1000 }, { userId: 9, amount: 1000 }] }), /chosen twice/);
  await assert.rejects(move({ shares: [{ userId: 99, amount: 2000 }] }), /from the list/);
  await assert.rejects(till.moveToStaff(env, { key: 'not-found:1', shares: [], reason: 'x' }, OWNER), /Which day/);

  const out = await move({ shares: [{ userId: 9, amount: 1200 }, { userId: 8, amount: 800 }] });
  assert.equal(out.told, 2, 'both carriers told; Kofi carries a share, so no separate word that it left him');
  assert.deepEqual(told.map((t) => [t.userIds[0], t.kind, t.title]), [
    [9, 'till.moved', 'Moved to your account: GH₵12.00 over'],
    [8, 'till.moved', 'Moved to your account: GH₵8.00 over'],
  ]);
  assert.match(told[0].body, /Kofi Test's shift\)\. Why: Yaw relieved Kofi without a count/);
  assert.deepEqual(await listOf(8), [['moved', 800]], 'his own drawer item is replaced by his share');
  assert.deepEqual(await listOf(9), [['moved', 1200]]);
  const yaw = (await till.issuesBetween(env, '2026-08-01', '2026-08-02')).issues.find((i) => i.userId === 9);
  assert.equal(yaw.moved.reason, 'Yaw relieved Kofi without a count');
  assert.match(yaw.text, /The drawer was over by GH₵20\.00 on Kofi Test's shift\. GH₵12\.00 of it is on your account\./);

  // On the Shifts screen the card is answered, with who carries what.
  const shift = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  const x = shift.exceptions.find((e) => e.key === key);
  assert.equal(x.answer.answer, 'Put on a staff account');
  assert.deepEqual(x.moved.shares.map((y) => [y.name, y.amount]), [['Yaw Test', 1200], ['Kofi Test', 800]]);
  await assert.rejects(move({ shares: [{ userId: 9, amount: 2000 }] }), /already/);

  // A settled share keeps the move; until then, undo puts it back and tells them.
  await env.DB.prepare("INSERT INTO till_resolution (key, hive_user_id, outcome, by_name, at) VALUES (?1, 9, 'accept', 'Test Owner', '2026-08-03 09:00:00')").bind(yaw.key).run();
  await assert.rejects(till.undoMove(env, { id: out.id }, OWNER, { fetchImpl }), /Yaw Test's share was accepted already/);
  await env.DB.prepare('DELETE FROM till_resolution').run();
  told.length = 0;
  await till.undoMove(env, { id: out.id }, OWNER, { fetchImpl });
  assert.deepEqual(told.map((t) => [t.userIds[0], t.title]), [[9, 'Taken off your account: GH₵12.00 over'], [8, 'Taken off your account: GH₵8.00 over']]);
  assert.deepEqual(await listOf(8), [['drawer', 2000]], 'back as it was');
  assert.deepEqual(await listOf(9), []);
  await assert.rejects(till.undoMove(env, { id: out.id }, OWNER, { fetchImpl }), /undone already/);

  // All of it on somebody else: the shift's own person is told it left them.
  told.length = 0;
  await move({ shares: [{ userId: 9, amount: 2000 }] });
  assert.deepEqual(told.map((t) => [t.userIds[0], t.title]), [[9, 'Moved to your account: GH₵20.00 over'], [8, 'Moved off your list: GH₵20.00 over']]);
  assert.match(told[1].body, /now on Yaw Test's account/);
  assert.deepEqual(await listOf(8), []);
});

test('any difference with an amount goes on an account as a deficit or a surplus, deciding an answer waiting for approval', async () => {
  const { env, hive } = await setUp();
  hive.raw.exec("INSERT INTO users (id, name, role, active) VALUES (9, 'Yaw Test', 'staff', 1)");
  const told = [];
  const fetchImpl = async (request) => { told.push(JSON.parse(await request.text())); return Response.json({ ok: true }); };
  const view = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  const DRAWER = ['drawer-short', 'drawer-over', 'handover-gap'];
  const x = view.exceptions.find((e) => e.amount && e.slot && e.severity !== 'info' && !DRAWER.includes(e.kind));
  assert.ok(x, `a difference other than the drawer's: ${view.exceptions.map((e) => e.kind).join(', ')}`);
  // A supervisor answered it; it waits for an admin.
  await routes.saveAnswer(env, { key: x.key, answer: 'Explained', note: 'Billed cash instead of card' }, SUPERVISOR, { pending: true });
  const whole = Math.abs(x.amount);
  const move = (body) => till.moveToStaff(env, { key: x.key, day: x.day, reason: 'Billed cash instead of card', shares: [{ userId: 8, amount: whole }], ...body }, OWNER, { fetchImpl });
  await assert.rejects(move({}), /deficit \(they owe it\) or a surplus/);
  await assert.rejects(move({ day: '' , direction: 'deficit' }), /Which day/);
  const out = await move({ direction: 'deficit' });
  assert.equal(out.ok, true);
  assert.match(told[0].title, new RegExp(`Moved to your account: GH₵${(whole / 100).toFixed(2)} deficit`));
  const kofi = (await till.issuesBetween(env, '2026-08-01', '2026-08-02')).issues.find((i) => i.userId === 8 && i.kind === 'moved');
  assert.equal(kofi.amount, -whole, 'a deficit: owed by them');
  assert.match(kofi.text, /^A deficit of GH₵/);
  const after = (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).exceptions.find((e) => e.key === x.key);
  assert.equal(after.answer.answer, 'Put on a staff account');
  assert.equal(after.proposed, null, 'the supervisor\'s answer is set aside');
  assert.equal((await till.pendingAnswers(env)).some((a) => a.id === x.key), false, 'and gone from Approvals');
  // Approving it from a screen not yet refreshed says how it was decided.
  await assert.rejects(till.approve(env, { answer: x.key, ok: true }, OWNER), /already decided: put on Kofi Test's account by Test Owner/);
});

test('what two reconciled differences do not net to goes on a staff account, and undoing it undoes the reconciliation', async () => {
  const { env } = await setUp();
  const fetchImpl = async () => Response.json({ ok: true });
  // Two card payments on the morning that ASSD never shows.
  const head = '"SN","Date","PAN","MTI","Terminal","Type","TransactionType","Amount","STAN","MCC","TransactionFee","RRN","MID","Merchant","Currency","Responsecode","Status","AgentId","PhoneNumber","ApprovalCode","IsCNP"';
  const tap = (n, at, amount) => `"${n}","${at}","=""411111******000${n}""","0200","=""TERM0001""","000000","Purchase","${amount}","=""10000${n}""","7011","D00000000","=""90000000000${n}""","=""MID""","TEST HOTEL","936","=""00""","Approved or completed successfully","=""""","=""""","=""A1B2C${n}""","NO"`;
  await routes.uploadTerminal(env, { text: [head, tap(1, '2026-08-01 09:00:00', '40.00'), tap(2, '2026-08-01 09:30:00', '25.00')].join('\n'), name: 'tams.csv' }, OWNER);
  const view = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER);
  const open =view.exceptions.filter((e) => e.slot && e.severity !== 'info' && till.flowOf(e) != null && !e.answer && !e.link);
  // Two whose money does not net to nothing.
  let pair = null;
  for (const a of open) for (const b of open) if (!pair && a !== b && till.flowOf(a) + till.flowOf(b) !== 0) pair = [a, b];
  assert.ok(pair, `two differences with amounts: ${open.map((e) => e.kind).join(', ')}`);
  const net = till.flowOf(pair[0]) + till.flowOf(pair[1]);
  const keys = pair.map((x) => x.key);
  const days = [...new Set(pair.map((x) => x.day))];
  const left = (body) => till.moveLeftToStaff(env, { keys, days, reason: 'Kept the change', shares: [{ userId: 8, amount: Math.abs(net) }], ...body }, OWNER, { fetchImpl });
  await assert.rejects(left({ amount: net + 100 }), /What is left has changed/);
  await assert.rejects(left({ shares: [{ userId: 8, amount: Math.abs(net) + 1 }] }), /Place all of it/);
  await assert.rejects(till.moveLeftToStaff(env, { keys, days, reason: 'x', shares: [] }, SUPERVISOR), /admin/i);
  const out = await left({ amount: net });
  assert.equal(out.ok, true);

  // Both reconciled together; the leftover is on Kofi's list, as a deficit or a surplus.
  const after = (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER)).exceptions.filter((e) => keys.includes(e.key));
  assert.ok(after.every((e) => e.link), 'both reconciled');
  assert.match(after[0].link.note, /left, put on Kofi Test: Kept the change/);
  const kofi = (await till.issuesBetween(env, '2026-08-01', '2026-08-02')).issues.find((i) => i.userId === 8 && i.kind === 'moved');
  assert.equal(kofi.amount, net);
  assert.match(kofi.text, new RegExp(`^A ${net < 0 ? 'deficit' : 'surplus'} of GH₵`));

  // The reconciliation cannot be undone on its own while the leftover is on an account.
  await assert.rejects(routes.removeLink(env, { id: after[0].link.id }, OWNER), /on a staff account/);
  // Taking it off the account undoes both.
  await till.undoMove(env, { id: out.id }, OWNER, { fetchImpl });
  const again = (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER)).exceptions.filter((e) => keys.includes(e.key));
  assert.ok(again.every((e) => !e.link), 'open again');

  // Undoing the reconciliation, as an admin, takes the leftover off the account too.
  await left({});
  const link = (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER)).exceptions.find((e) => e.key === keys[0]).link;
  assert.equal(await till.undoLeftOf(env, link.id, OWNER, { fetchImpl }), true);
  await routes.removeLink(env, { id: link.id }, OWNER);
  assert.equal((await till.issuesBetween(env, '2026-08-01', '2026-08-02')).issues.some((i) => i.userId === 8 && i.kind === 'moved'), false, 'off Kofi’s list');
});

test('a keying slip nets as what ASSD has over what the terminal took', () => {
  assert.equal(till.flowOf({ kind: 'keying', amount: 4000, difference: 2000 }), -2000);
  assert.equal(till.flowOf({ kind: 'not-recorded', amount: 1000 }) + till.flowOf({ kind: 'keying', amount: 4000, difference: 2000 }), -1000);
});

test('admins are told an answer waits once a quarter of an hour, with what it is and how many wait in all', async () => {
  const { env } = await setUp();
  await env.DB.prepare("INSERT INTO till_notify (hive_user_id, name, push, email, amounts, on_closed, on_answer, on_approval) VALUES (3, 'Test Owner', 1, 1, 1, 1, 1, 1)").run();
  const sent = [];
  const fetchImpl = async (request) => { sent.push(JSON.parse(await request.text())); return Response.json({ ok: true }); };
  const t0 = Date.parse('2026-10-17T23:53:00Z');
  await routes.saveAnswer(env, { key: 'drawer:2026-08-01:afternoon', answer: 'Explained' }, SUPERVISOR, { pending: true });
  assert.equal(await till.tellApprovers(env, { text: 'Sam answered “Explained” for the drawer count, Sat 1 Aug afternoon.' }, { fetchImpl, now: t0 }), true);
  assert.equal(sent[0].title, 'Waiting for your approval');
  assert.match(sent[0].body, /the drawer count, Sat 1 Aug afternoon\. Decide in Insight → ✓ Approvals\./);
  // Two minutes later, another: not a second email.
  await routes.saveAnswer(env, { key: 'handover:2026-08-01:night', answer: 'Explained' }, SUPERVISOR, { pending: true });
  assert.equal(await till.tellApprovers(env, { text: 'again' }, { fetchImpl, now: t0 + 2 * 60_000 }), false);
  assert.equal(sent.length, 1);
  // After the quiet spell: told again, with the count as it stands.
  assert.equal(await till.tellApprovers(env, { text: 'later' }, { fetchImpl, now: t0 + 16 * 60_000 }), true);
  assert.equal(sent[1].title, '2 things waiting for your approval');
  assert.match(sent[1].body, /2 are waiting in all\./);
});

test('a shift is “not checked yet” on its person’s list until somebody checks it', async () => {
  const { env, hive } = await setUp();
  const RealDate = Date;
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [RealDate.parse('2026-08-03T09:00:00Z')])); } static now() { return RealDate.parse('2026-08-03T09:00:00Z'); } };
  const told = [];
  const fetchImpl = async (request) => { told.push(JSON.parse(await request.text())); return Response.json({ ok: true }); };
  const shift = { day: '2026-08-01', slot: 'afternoon' };
  try {
    let [kofi] = (await till.linkIssues(env, { userId: 8 })).issues;
    assert.equal(kofi.checked, false, 'nobody has checked it yet');

    // Before the check, only a note: it is shown, and does not count as an answer.
    hive.raw.prepare(`INSERT INTO till_answer (key, user_id, how, text, at) VALUES (?, 8, 'note', 'A guest was given change twice', '2026-08-02 08:00:00')`).run(kofi.key);
    [kofi] = (await till.linkIssues(env, { userId: 8 })).issues;
    assert.equal(kofi.status, 'open');
    assert.equal(kofi.note.text, 'A guest was given change twice');

    // Checking needs the "Check shifts" access; an admin has it.
    await assert.rejects(till.checkShift(env, shift, SUPERVISOR, { fetchImpl }), /not been shared|not change/);
    await assert.rejects(till.checkShift(env, { day: '2026-08-03', slot: 'morning' }, OWNER, { fetchImpl }), /once its day is over/);
    const out = await till.checkShift(env, shift, OWNER, { fetchImpl });
    assert.equal(out.open, 1);
    assert.deepEqual([told[0].kind, told[0].userIds], ['till.checked', [8]], 'its person is told');
    [kofi] = (await till.linkIssues(env, { userId: 8 })).issues;
    assert.deepEqual([kofi.checked, kofi.checkedBy], [true, 'Test Owner']);
    // The other shift is still not checked.
    assert.ok((await till.linkIssues(env, { userId: 7 })).issues.every((i) => i.checked === false));

    // The overview says so, with what was noted.
    let row = (await till.overview(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).reports.find((r) => r.slot === 'afternoon');
    assert.deepEqual([row.check.by, row.check.changed, row.notes[0].text], ['Test Owner', false, 'A guest was given change twice']);
    // The quick list of checks says it too, without working the shifts out.
    assert.deepEqual((await till.checkList(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER)).checks.map((c) => [c.day, c.slot, c.by]),
      [['2026-08-01', 'afternoon', 'Test Owner']]);
    assert.deepEqual((await till.checkList(env, { from: '2026-08-02', to: '2026-08-02' }, OWNER)).checks, [], 'only the days asked for');

    // Changed since it was checked (here: the amount it was checked at differs): not checked again.
    await env.DB.prepare(`UPDATE shift_check SET snapshot = ?1`).bind(JSON.stringify({ [kofi.key]: '-1500|' })).run();
    [kofi] = (await till.linkIssues(env, { userId: 8 })).issues;
    assert.equal(kofi.checked, false);
    row = (await till.overview(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).reports.find((r) => r.slot === 'afternoon');
    assert.equal(row.check.changed, true);

    // Undone: not checked yet again. A supervisor given "Check shifts" may check.
    await till.uncheckShift(env, shift, OWNER);
    assert.equal((await till.linkIssues(env, { userId: 8 })).issues[0].checked, false);
    await till.saveSettings(env, { access: { accountId: 9, area: 'check', level: 2 } }, OWNER);
    await till.checkShift(env, shift, SUPERVISOR, { fetchImpl });
    assert.equal((await till.linkIssues(env, { userId: 8 })).issues[0].checkedBy, 'Sam Supervisor');
  } finally {
    global.Date = RealDate;
  }
});

test('Odoo not answering a PO lookup is said in Odoo’s words, not “something went wrong”', async () => {
  const { db } = freshDb();
  await db.prepare("INSERT OR REPLACE INTO sources (id, label, kind, config, enabled) VALUES ('odoo', 'Odoo', 'odoo_json2', '{\"base\":\"https://odoo.example.test\"}', 1)").run();
  const env = { DB: db, SSO_SECRET_ATTENDANCE: SECRET, ODOO_KEY_ODOO: 'k', ASSETS: { fetch: async () => new Response('x') } };
  const worker = (await import('../src/index.js')).default;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  try {
    const text = '{"names":["412"]}';
    const headers = await signLink(SECRET, '/api/link/till/po', text);
    const res = await worker.fetch(new Request('https://insight.example.test/api/link/till/po', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: text }), env, { waitUntil: () => {} });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /^Odoo did not answer in time \(purchase\.order, search_read\)\.$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('envelopes moved to the safe: one line each, marked received with a count, undone, and as a spreadsheet', async () => {
  const { env, hive } = await setUp();
  // Kofi's afternoon sent two envelopes as well.
  hive.raw.exec(`UPDATE till_report SET to_safe = 1, envelopes = '[{"no":"418","amount":3000},{"no":"419","amount":2000}]' WHERE user_id = 8`);
  const range = { from: '2026-08-01', to: '2026-08-01' };
  let view = await envelopes.envelopesView(env, range, OWNER);
  const mine = view.lines.filter((l) => l.no);
  assert.deepEqual(mine.map((l) => [l.slot, l.no, l.amount, l.first]),
    [['afternoon', '418', 3000, true], ['afternoon', '419', 2000, false], ['morning', '417', 25000, true]]);
  const ama = mine.find((l) => l.no === '417');
  assert.deepEqual([ama.by, ama.assd, ama.shiftDiff], ['Ama Test', 20000, 5000], 'her envelope says 250 where ASSD moved 200');
  // A supervisor: nothing until an admin gives "Envelopes received"; See to
  // look, See and act to mark them received.
  await assert.rejects(envelopes.envelopesView(env, range, SUPERVISOR), /not been shared/);
  await env.DB.prepare("INSERT INTO till_access (account_id, area, level) VALUES (9, 'envelopes', 1)").run();
  assert.equal((await envelopes.envelopesView(env, range, SUPERVISOR)).lines.length, view.lines.length);
  await assert.rejects(envelopes.receive(env, { receivedOn: '2026-08-03', items: [{ day: '2026-08-01', slot: 'afternoon', no: '419' }] }, SUPERVISOR), /look at this, not change it/);
  await env.DB.prepare("UPDATE till_access SET level = 2 WHERE account_id = 9 AND area = 'envelopes'").run();
  await envelopes.receive(env, { receivedOn: '2026-08-03', items: [{ day: '2026-08-01', slot: 'afternoon', no: '419' }] }, SUPERVISOR);
  await envelopes.undo(env, { day: '2026-08-01', slot: 'afternoon', no: '419' }, SUPERVISOR);

  // Received: counted short needs a reason; the rest are counted at what they say.
  const item = (no, slot, extra = {}) => ({ day: '2026-08-01', slot, no, ...extra });
  await assert.rejects(envelopes.receive(env, { receivedOn: '2026-08-03', items: [item('417', 'morning', { counted: '240' })] }, OWNER), /say why/);
  await assert.rejects(envelopes.receive(env, { receivedOn: '2099-01-01', items: [item('418', 'afternoon')] }, OWNER), /still to come/);
  await assert.rejects(envelopes.receive(env, { receivedOn: '2026-08-03', items: [item('999', 'afternoon')] }, OWNER), /not one moved/);
  const out = await envelopes.receive(env, {
    receivedOn: '2026-08-03', with: 'Sam Supervisor',
    items: [item('417', 'morning', { counted: '240', why: 'One 10 note missing' }), item('418', 'afternoon')],
  }, OWNER);
  assert.deepEqual([out.received, out.counted], [2, 27000]);
  await assert.rejects(envelopes.receive(env, { receivedOn: '2026-08-03', items: [item('418', 'afternoon')] }, OWNER), /already marked/);

  view = await envelopes.envelopesView(env, range, OWNER);
  const got = view.lines.find((l) => l.no === '417').received;
  assert.deepEqual([got.on, got.with, got.counted, got.diff, got.why], ['2026-08-03', 'Sam Supervisor', 24000, -1000, 'One 10 note missing']);
  assert.equal(view.totals.waitingCount, view.lines.length - 2);
  assert.equal(view.totals.diff, -1000);
  // "Everything not received" leaves the received ones out.
  const open = await envelopes.envelopesView(env, { open: '1' }, OWNER);
  assert.ok(!open.lines.some((l) => l.received));

  const csv = await (await envelopes.envelopesCsv(env, range, OWNER)).text();
  assert.match(csv, /2026-08-01,morning,Ama Test,417,250\.00,200\.00,50\.00,2026-08-03,Sam Supervisor,240\.00,-10\.00,One 10 note missing,Test Owner/);

  await envelopes.undo(env, { day: '2026-08-01', slot: 'morning', no: '417' }, OWNER);
  view = await envelopes.envelopesView(env, range, OWNER);
  assert.equal(view.lines.find((l) => l.no === '417').received, null);
});

test('whose shift it was: chosen with a reason, its differences follow, both are told, and it can go back', async () => {
  const { env } = await setUp();
  const told = [];
  const fetchImpl = async (req) => { told.push(await req.json()); return Response.json({ ok: true }); };
  const day = '2026-08-01';
  const c = await till.ownerChoices(env, { day, slot: 'afternoon' }, OWNER);
  assert.deepEqual([c.assdUser, c.closedBy.name, c.chosen], ['BRAVO', 'Kofi Test', null]);
  assert.ok(c.people.some((p) => p.name === 'Ama Test'));
  await assert.rejects(till.setOwner(env, { day, slot: 'afternoon', userId: 7 }, OWNER, { fetchImpl }), /Say why/);
  await assert.rejects(till.setOwner(env, { day, slot: 'afternoon', userId: 99, why: 'x y z' }, OWNER, { fetchImpl }), /Choose whose/);
  await assert.rejects(till.setOwner(env, { day, slot: 'afternoon', userId: 7, why: 'Ama covered' }, SUPERVISOR, { fetchImpl }), /not been shared|look at this/);

  const before = (await till.issuesBetween(env, day, day)).issues.filter((i) => i.slot === 'afternoon');
  assert.ok(before.length && before.every((i) => i.userId === 8), 'Kofi closed it, so it is his');
  const out = await till.setOwner(env, { day, slot: 'afternoon', userId: 7, why: 'Ama covered; Kofi signed for her' }, OWNER, { fetchImpl });
  assert.equal(out.changed, true);
  assert.deepEqual(told.map((t) => [t.kind, t.userIds[0], /now yours|no longer yours/.exec(t.title)[0]]), [['till.owner', 7, 'now yours'], ['till.owner', 8, 'no longer yours']]);
  const after = (await till.issuesBetween(env, day, day)).issues.filter((i) => i.slot === 'afternoon');
  assert.ok(after.every((i) => i.userId === 7), 'its differences follow the person chosen');
  const view = await till.overview(env, { from: day, to: day }, OWNER);
  const row = view.reports.find((r) => r.slot === 'afternoon');
  assert.deepEqual([row.owner.name, row.owner.why, row.owner.by], ['Ama Test', 'Ama covered; Kofi signed for her', 'Test Owner']);

  await till.setOwner(env, { day, slot: 'afternoon', userId: null }, OWNER, { fetchImpl });
  assert.ok((await till.issuesBetween(env, day, day)).issues.filter((i) => i.slot === 'afternoon').every((i) => i.userId === 8), 'back to who closed it');
});

test('whatever an admin decides another way takes a supervisor’s waiting answer off Waiting for admin', async () => {
  const { env } = await setUp();
  const range = { from: '2026-08-01', to: '2026-08-01' };
  const waiting = async () => (await till.overview(env, range, OWNER)).answerApprovals.map((a) => `${a.type}:${a.keys.join('+')}`);

  // An admin answers it directly: the supervisor's answer, and a reconciliation waiting with it, are set aside.
  await routes.saveAnswer(env, { key: 'a:1', answer: 'Explained', note: 'Counted again' }, SUPERVISOR, { pending: true });
  await routes.saveLink(env, { keys: ['b:2', 'c:3'], note: 'Same money' }, SUPERVISOR, { pending: true });
  assert.deepEqual(await waiting(), ['answer:a:1', 'link:b:2+c:3']);
  await routes.saveAnswer(env, { key: 'a:1', answer: 'Not a problem' }, OWNER);
  await routes.saveAnswer(env, { key: 'c:3', answer: 'Corrected in ASSD' }, OWNER);
  assert.deepEqual(await waiting(), []);
  const hist = async (key) => (await notes.history(env, { key }, OWNER)).items.map((i) => i.text);
  assert.deepEqual((await hist('a:1')).slice(1), ['Sam Supervisor’s answer “Explained” set aside: answered by an admin instead', 'Answered “Not a problem”']);
  assert.match((await hist('b:2'))[0], /“Reconciled together” set aside: answered by an admin instead/);

  // An admin reconciles it with others: the same.
  await routes.saveAnswer(env, { key: 'd:4', answer: 'Explained' }, SUPERVISOR, { pending: true });
  await routes.saveLink(env, { keys: ['d:4', 'e:5'], note: 'One story' }, OWNER);
  assert.deepEqual(await waiting(), []);

  // Already on a staff account: a supervisor cannot answer it, and one left from before is swept off.
  await env.DB.prepare("INSERT INTO till_move (key, kind, day, slot, amount, shares, reason, by_name, at) VALUES ('f:6', 'drawer-short', '2026-08-01', 'night', -500, '[]', 'Taken', 'Test Owner', '2026-08-02 08:00:00')").run();
  await assert.rejects(routes.saveAnswer(env, { key: 'f:6', answer: 'Explained' }, SUPERVISOR, { pending: true }), /staff account already/);
  await env.DB.prepare("INSERT INTO shift_answer (key, answer, by_name, at, status) VALUES ('f:6', 'Explained', 'Sam Supervisor', '2026-08-02 09:00:00', 'pending')").run();
  assert.deepEqual(await waiting(), []);
  assert.match((await hist('f:6'))[0], /set aside: put on a staff account/);
});

test('a payment moved to another shift says so in its own field, apart from one put on staff accounts', async () => {
  const { env, hive } = await setUp();
  hive.raw.exec("INSERT INTO users (id, name, role, active) VALUES (9, 'Yaw Test', 'staff', 1)");
  await env.DB.prepare(`INSERT INTO terminal_txn (rrn, at, day, kind, amount, last4, approval, approved, status, loaded_at)
    VALUES ('777001', '2026-08-01 14:20:00', '2026-08-01', 'card', 12300, '4242', 'A1', 1, 'approved', '2026-08-02 06:00:00')`).run();
  const range = { from: '2026-08-01', to: '2026-08-01' };
  const find = async () => (await routes.shifts(env, range, OWNER)).exceptions.find((e) => e.event?.id === 't:777001');
  const x = await find();
  assert.equal(x.kind, 'not-recorded');
  const to = x.slot === 'morning' ? 'afternoon' : 'morning';
  await routes.movePayment(env, { eventId: 't:777001', key: x.key, day: '2026-08-01', slot: to, why: 'Taken just after the hand-over', fromDay: x.day, fromSlot: x.slot }, OWNER);
  const y = await find();
  assert.equal(y.slot, to);
  assert.deepEqual([y.home.fromSlot, y.home.why], [x.slot, 'Taken just after the hand-over']);
  assert.equal(y.moved, undefined, '`moved` is only for staff accounts: the shift page reads its shares');
  // Put on a staff account as well: both say so, each in its own field.
  await till.moveToStaff(env, { key: y.key, day: y.day, direction: 'surplus', reason: 'Kept the change', shares: [{ userId: 9, amount: 12300 }] }, OWNER, { fetchImpl: async () => Response.json({ ok: true }) });
  const z = await find();
  assert.equal(z.home.fromSlot, x.slot);
  assert.deepEqual(z.moved.shares.map((s) => s.name), ['Yaw Test']);
});

test('an answer waiting for an admin whose difference is gone leaves Waiting for admin', async () => {
  const { env } = await setUp();
  const range = { from: '2026-08-01', to: '2026-08-03' };
  const still = (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).exceptions.find((e) => e.severity !== 'info' && e.day === '2026-08-01');
  assert.ok(still, 'a difference that is still there');
  await routes.saveAnswer(env, { key: still.key, answer: 'Explained' }, SUPERVISOR, { pending: true });
  // Gone since: a card ASSD showed that has since been found, on a day read.
  await routes.saveAnswer(env, { key: 'not-found:2026-08-01:999:0', answer: 'Explained', note: 'Paid at 1:53 am' }, SUPERVISOR, { pending: true });
  await routes.saveLink(env, { keys: ['paid-more:2026-08-01:night:1', 'paid-less:2026-08-01:night:2'] }, SUPERVISOR, { pending: true });
  // Not judged: a day not read, and a key that names no day.
  await routes.saveAnswer(env, { key: 'drawer:2026-05-01:morning', answer: 'Explained' }, SUPERVISOR, { pending: true });
  await routes.saveAnswer(env, { key: 'odd:key', answer: 'Explained' }, SUPERVISOR, { pending: true });
  const waiting = (await till.overview(env, range, OWNER)).answerApprovals.map((a) => a.keys.join('+')).sort();
  assert.deepEqual(waiting, ['drawer:2026-05-01:morning', 'odd:key', still.key].sort());
  // Keys that carry an ASSD line rather than a day are dated by the line.
  assert.equal(await routes.dayOfKey(env, 'not-found:400104:0'), '2026-08-01');
  assert.equal(await routes.dayOfKey(env, 'stay:70001-50001'), null);
  const h = (await notes.history(env, { key: 'not-found:2026-08-01:999:0' }, OWNER)).items.map((i) => i.text);
  assert.match(h.at(-1), /set aside: the difference is no longer on its shift/);
});

test('water and padlocks on each shift: the counts, what went out and came back, and the money, line by line', async () => {
  const { env } = await setUp();
  const view = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  const all = view.days.flatMap((d) => d.shifts);
  const alpha = all.find((s) => s.user === 'ALPHA');
  const bravo = all.find((s) => s.user === 'BRAVO');
  // ALPHA took one padlock deposit; ASSD counted the padlocks at the start and the end.
  assert.equal(alpha.stockNames['405'], 'Padlock Deposit');
  assert.ok(alpha.stockStartSeq && alpha.stockEndSeq && alpha.stockStartSeq < alpha.stockEndSeq);
  assert.deepEqual([alpha.goods['405'].out, alpha.goods['405'].back, alpha.goods['405'].amount], [1, 0, 3000]);
  assert.deepEqual(alpha.goods['405'].lines.map((l) => [l.seq, l.qty]), [[400104, 1]]);
  // BRAVO gave one back.
  assert.deepEqual([bravo.goods['405'].out, bravo.goods['405'].back, bravo.goods['405'].amount], [0, 1, -3000]);
  // The closing report's rentals carry the article, to be set against ASSD's.
  const rep = (await till.overview(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).reports.find((r) => r.slot === 'morning');
  assert.equal(rep.compare.rentals.find((x) => x.id === 'padlock').article, '405');
});

test('a PO the closing report says the drawer paid, paid from the big safe instead: off the drawer, on the safe book', async () => {
  const { env } = await setUp();
  const range = { from: '2026-08-01', to: '2026-08-01' };
  const afternoon = async () => (await routes.shifts(env, range, OWNER)).days.flatMap((d) => d.shifts).find((s) => s.slot === 'afternoon');
  const safeBook = () => env.DB.prepare("SELECT kind, day, amount, po FROM safe_entry WHERE po = 'P00412'").all().then((r) => r.results.map((x) => ({ ...x })));
  let s = await afternoon();
  assert.equal(s.expense.sheetTotal, 3000, 'the closing report says GH₵30 left the drawer for P00412');
  await assert.rejects(routes.poFromSafe(env, { day: '2026-08-01', slot: 'afternoon', po: '412', amount: '10' }, OWNER), /Why/);

  // Part of it: GH₵10 from the safe, GH₵20 the drawer's.
  await routes.poFromSafe(env, { day: '2026-08-01', slot: 'afternoon', po: '412', amount: '10', why: 'Topped up from the safe' }, OWNER);
  s = await afternoon();
  assert.equal(s.expense.sheetTotal, 2000);
  const order = s.expense.odoo.orders.find((o) => o.name === 'P00412');
  assert.deepEqual([order.total, order.fromSafe], [2000, 1000]);
  assert.deepEqual(await safeBook(), [{ kind: 'po', day: '2026-08-01', amount: 1000, po: 'P00412' }]);

  // All of it: off the drawer altogether; the safe book's line follows.
  await routes.poFromSafe(env, { day: '2026-08-01', slot: 'afternoon', po: 'P00412', amount: '30', why: 'Paid from the safe' }, OWNER);
  s = await afternoon();
  assert.equal(s.expense.sheetTotal, 0);
  assert.equal((s.expense.odoo?.orders || []).some((o) => o.name === 'P00412'), false);
  assert.deepEqual(s.expense.fromSafe.map((x) => [x.po, x.amount, x.why]), [['P00412', 3000, 'Paid from the safe']]);
  assert.deepEqual((await safeBook()).map((r) => r.amount), [3000], 'one line, not two');

  // Undone: the drawer's again, and off the safe book.
  await routes.poFromSafe(env, { day: '2026-08-01', slot: 'afternoon', po: 'P00412', back: true }, OWNER);
  s = await afternoon();
  assert.equal(s.expense.sheetTotal, 3000);
  assert.deepEqual(await safeBook(), []);
});

test('an expense with no PO the big safe paid: off the drawer, which kept the cash, and in the safe book waiting for its PO', async () => {
  const { env } = await setUp();
  const range = { from: '2026-08-01', to: '2026-08-01' };
  const shiftWith = async () => (await routes.shifts(env, range, OWNER)).days.flatMap((d) => d.shifts).find((s) => s.register?.expenses > 0);
  const before = await shiftWith();
  const r0 = before.register;
  await assert.rejects(routes.poFromSafe(env, { day: before.day, slot: before.slot, noPo: true, amount: '10', why: 'Paid from the safe' }, OWNER), /What it was for/);
  const out = await routes.poFromSafe(env, { day: before.day, slot: before.slot, noPo: true, amount: '10', what: 'Gas refill', why: 'The manager paid it from the safe' }, OWNER);
  assert.equal(out.po, 'NOPO-1');
  const after = (await routes.shifts(env, range, OWNER)).days.flatMap((d) => d.shifts).find((s) => s.day === before.day && s.slot === before.slot);
  assert.equal(after.register.expenses, r0.expenses - 1000, 'the drawer’s expenses are less what the safe paid');
  assert.equal(after.register.expected, r0.expected + 1000, 'so the drawer should hold that much more');
  assert.deepEqual(after.expense.fromSafe.map((x) => [x.po, x.noPo, x.what, x.amount]), [['NOPO-1', true, 'Gas refill', 1000]]);
  const book = (await env.DB.prepare("SELECT kind, amount, description, po FROM safe_entry WHERE kind = 'pending'").all()).results.map((x) => ({ ...x }));
  assert.deepEqual(book, [{ kind: 'pending', amount: 1000, description: 'Gas refill', po: null }]);
  // A second is its own; undoing one leaves the other.
  assert.equal((await routes.poFromSafe(env, { day: before.day, slot: before.slot, noPo: true, amount: '5', what: 'Bulbs', why: 'Safe' }, OWNER)).po, 'NOPO-2');
  await routes.poFromSafe(env, { day: before.day, slot: before.slot, po: 'NOPO-1', back: true }, OWNER);
  const last = (await routes.shifts(env, range, OWNER)).days.flatMap((d) => d.shifts).find((s) => s.day === before.day && s.slot === before.slot);
  assert.equal(last.register.expenses, r0.expenses - 500);
  assert.deepEqual((await env.DB.prepare("SELECT description FROM safe_entry WHERE kind = 'pending'").all()).results.map((x) => x.description), ['Bulbs']);
});

test('HIVE asking about checks: a difference put on staff accounts is checked while the move stands', async () => {
  const { env } = await setUp();
  await env.DB.prepare("INSERT INTO shift_check (day, slot, by_name, at, snapshot) VALUES ('2026-08-01', 'morning', 'Test Owner', '2026-08-02 08:00:00', '{}')").run();
  await env.DB.prepare("INSERT INTO till_move (id, key, kind, day, slot, amount, shares, reason, by_name, at) VALUES (7, 'f:6', 'drawer-short', '2026-08-01', 'night', -500, '[]', 'Taken', 'Test Owner', '2026-08-02 09:00:00')").run();
  const out = await till.linkChecks(env, {
    shifts: [{ day: '2026-08-01', slot: 'morning' }, { day: '2026-08-01', slot: 'night' }],
    keys: ['moved:7:3', 'moved:8:3', 'not-a-key'],
  });
  assert.deepEqual(out.checked.map((c) => c.slot), ['morning']);
  assert.deepEqual(out.keys, [{ key: 'moved:7:3', by: 'Test Owner', at: '2026-08-02 09:00:00' }]);
  // Undone: no longer.
  await env.DB.prepare("UPDATE till_move SET undone_at = '2026-08-03 08:00:00' WHERE id = 7").run();
  assert.deepEqual((await till.linkChecks(env, { shifts: [], keys: ['moved:7:3'] })).keys, []);
});

test('a surplus put on somebody’s account can be paid with salary, from HIVE or Insight, by an admin', async () => {
  const { env } = await setUp();
  const realNow = Date.now;
  const RealDate = Date;
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [RealDate.parse('2026-08-03T09:00:00Z')])); } static now() { return RealDate.parse('2026-08-03T09:00:00Z'); } };
  try {
    await env.DB.prepare(`INSERT INTO till_move (id, key, kind, day, slot, owner_name, amount, shares, reason, by_name, at)
      VALUES (4, 'drawer:2026-08-01:night', 'drawer-over', '2026-08-01', 'night', 'Someone', 1500, '[{"userId":8,"name":"Kofi","amount":1500}]', 'Over at the count', 'Test Owner', '2026-08-02 08:00:00')`).run();
    const asked = [];
    const fetchImpl = async (request) => {
      const path = new URL(request.url).pathname;
      asked.push([path, JSON.parse(await request.text())]);
      return Response.json(path === '/api/link/till/credit' ? { ok: true, creditId: 12 } : { ok: true });
    };
    const waiting = (await till.linkToDecide(env)).issues.filter((i) => i.key === 'moved:4:8');
    assert.equal(waiting.length, 1);
    assert.deepEqual([waiting[0].amount, waiting[0].surplus], [1500, true]);
    // A supervisor cannot; recovering a surplus makes no sense.
    await assert.rejects(till.resolve(env, { key: 'moved:4:8', userId: 8, outcome: 'pay' }, SUPERVISOR, { fetchImpl }), /not been shared|not change|Only an admin/);
    await assert.rejects(till.resolve(env, { key: 'moved:4:8', userId: 8, outcome: 'recover' }, OWNER, { fetchImpl }), /not a shortage/);

    await till.linkDecide(env, { key: 'moved:4:8', userId: 8, outcome: 'pay', by: 'Pay Person' }, { fetchImpl });
    const [path, sent] = asked[0];
    assert.equal(path, '/api/link/till/credit');
    assert.deepEqual([sent.userId, sent.amount, sent.key, sent.day, sent.slot, sent.checked], [8, 1500, 'moved:4:8', '2026-08-01', 'night', true]);
    // Off the waiting list, and on theirs marked paid through payroll.
    assert.deepEqual((await till.linkToDecide(env)).issues.filter((i) => i.key === 'moved:4:8'), []);
    const mine = (await till.linkIssues(env, { userId: 8 })).issues.find((i) => i.key === 'moved:4:8');
    assert.deepEqual([mine.recovered.how, mine.recovered.creditId, mine.recovered.amount], ['pay', 12, 1500]);
  } finally {
    global.Date = RealDate;
    Date.now = realNow;
  }
});
