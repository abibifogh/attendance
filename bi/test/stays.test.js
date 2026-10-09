import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import * as routes from '../src/routes/shifts.js';
import * as till from '../src/routes/till.js';
import { folioOf, flagStays, isNight, unpaidStays } from '../src/routes/stays.js';
import { parseJournal } from '../src/shifts/assd.js';

/**
 * Stays not fully paid: leaving in the next 24 hours, or gone.
 *
 * Made-up reservations in a made-up journal: what each was charged and paid
 * is all the check reads.
 */

const PAGE = ['EHC/XXX test hotel   06.08.26 05:00', 'Business Reports   Page: 1', 'Benefit Date:   01.08.26   05.08.26', 'Type of Report:   Detail Journal of every Transaction'];
const res = (seq, ref, booked, lines) => [`Reservation   ALPHA`, `01-103-${seq}   001/${ref}   ${booked}   /`, ...lines];
const night = (d, code, name, amount) => `${d}   ${code}   ${name}   1   ${amount}   ${amount} GHS   19`;

function journal() {
  return [...PAGE,
    'Beginn of Day Processing   ALPHA', '01-104-600100   001/9600100-   01.08.26   /',
    // Three nights at 100, paid 100 in cash: owes 200. Leaves the 4th.
    ...res(600101, '70001-50001', '01.08.26', [night('01.08.26', '121', 'Double Room', '100,00'), night('02.08.26', '121', 'Double Room', '100,00'),
      night('03.08.26', '121', 'Double Room', '100,00'), '01.08.26   718   Water Bottle   1   10,00   10,00 GHS   19',
      '01.08.26   CASH   CASH   110,00 GHS', '310,00 GHS']),
    // Paid in full by card: never flagged.
    ...res(600102, '70002-50002', '01.08.26', [night('01.08.26', '210', '8-Bed Dorm', '80,00'), night('02.08.26', '210', '8-Bed Dorm', '80,00'),
      '01.08.26   CR.   CREDIT CARD   160,00 GHS', '160,00 GHS']),
    // Still there on the last day loaded: the stay may go on, so not judged.
    ...res(600103, '70003-50003', '02.08.26', [night('04.08.26', '250', 'Female Dorm', '90,00'), night('05.08.26', '250', 'Female Dorm', '90,00'), '180,00 GHS']),
    // Booked before the journal loaded begins: shown, and said to be unsure.
    ...res(600104, '70004-50004', '20.07.26', [night('02.08.26', '101', 'Single Room (DB)', '200,00'), '200,00 GHS']),
  ];
}

const OWNER = { name: 'Test Owner', isOwner: true, access: [] };
const SUPERVISOR = { id: 9, name: 'Sam Supervisor', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };

async function setUp() {
  const { db } = freshDb();
  const env = { DB: db };
  await routes.uploadJournal(env, { lines: journal(), name: 'journal.pdf' }, OWNER);
  return env;
}

test('a reservation’s nights, charges and payments, from the journal', () => {
  const entries = parseJournal(journal());
  const f = folioOf(entries.find((e) => e.seq === 600101));
  assert.deepEqual([f.ref, f.nights, f.firstNight, f.lastNight, f.checkout], ['70001-50001', 3, '2026-08-01', '2026-08-03', '2026-08-04']);
  assert.deepEqual([f.charged, f.paid, f.balance, f.byMethod], [31000, 11000, 20000, { cash: 11000 }]);
  assert.deepEqual(f.rooms, ['Double Room']);
  assert.equal(isNight('718'), false, 'a water bottle is not a night');
  assert.equal(isNight('293'), false, 'nor is a no-show fee');
  assert.equal(isNight('250'), true);
});

test('who leaves in the next 24 hours owing, and who has gone owing', () => {
  const folios = parseJournal(journal()).filter((e) => e.kind === 'Reservation').map(folioOf);
  const journalDays = { from: '2026-08-01', to: '2026-08-05' };
  // The evening before check-out: leaving within 24 hours.
  let out = flagStays(folios, { now: new Date('2026-08-03T18:00:00Z'), journal: journalDays, checkoutTime: '12:00' });
  assert.deepEqual(out.leaving.map((x) => [x.ref, x.balance, x.checkoutAt]), [['70001-50001', 20000, '2026-08-04 12:00']]);
  assert.deepEqual(out.left.map((x) => [x.ref, x.unsure]), [['70004-50004', true]], 'left on the 3rd, booked before the journal begins');

  // After check-out time on the day: gone.
  out = flagStays(folios, { now: new Date('2026-08-04T12:30:00Z'), journal: journalDays, checkoutTime: '12:00' });
  assert.deepEqual(out.leaving, []);
  assert.deepEqual(out.left.map((x) => x.ref).sort(), ['70001-50001', '70004-50004']);

  // A later check-out time keeps them "leaving" a little longer.
  out = flagStays(folios, { now: new Date('2026-08-04T12:30:00Z'), journal: journalDays, checkoutTime: '14:00' });
  assert.deepEqual(out.leaving.map((x) => x.ref), ['70001-50001']);

  // Two days out is not yet 24 hours.
  out = flagStays(folios, { now: new Date('2026-08-02T11:00:00Z'), journal: journalDays });
  assert.deepEqual(out.leaving, []);

  // A small enough balance is left alone, as everywhere else.
  out = flagStays(folios, { now: new Date('2026-08-04T12:30:00Z'), journal: journalDays, threshold: 20000 });
  assert.deepEqual(out.left.map((x) => x.ref), []);
  assert.deepEqual(flagStays(folios, { now: new Date(), journal: null }), { leaving: [], left: [] });
});

test('the view, its answers, and a supervisor’s answer waiting for an admin', async () => {
  const env = await setUp();
  const now = new Date('2026-08-04T13:00:00Z');
  let view = await unpaidStays(env, OWNER, { now });
  assert.deepEqual(view.journal, { from: '2026-08-01', to: '2026-08-05' });
  assert.deepEqual(view.left.map((x) => x.key).sort(), ['stay:70001-50001', 'stay:70004-50004']);
  assert.equal(view.left.find((x) => x.ref === '70001-50001').balance, 20000);

  // The check-out time is a setting.
  await till.saveSettings(env, { checkoutTime: '14:00' }, OWNER);
  view = await unpaidStays(env, OWNER, { now });
  assert.equal(view.checkoutTime, '14:00');
  assert.deepEqual(view.leaving.map((x) => x.ref), ['70001-50001']);
  await assert.rejects(till.saveSettings(env, { checkoutTime: 'noon' }, OWNER), /time of day/);

  await routes.saveAnswer(env, { key: 'stay:70001-50001', answer: 'Guest owes, chasing', note: 'Promised by Friday' }, SUPERVISOR, { pending: true });
  view = await unpaidStays(env, OWNER, { now });
  const row = view.leaving.find((x) => x.ref === '70001-50001');
  assert.equal(row.answer, null);
  assert.equal(row.proposed.by, 'Sam Supervisor');
  await till.approve(env, { answer: 'stay:70001-50001', ok: true }, OWNER);
  view = await unpaidStays(env, OWNER, { now });
  assert.equal(view.leaving.find((x) => x.ref === '70001-50001').answer.answer, 'Guest owes, chasing');

  // A supervisor sees it by default; without the amounts when not given them.
  const sup = await unpaidStays(env, SUPERVISOR, { now });
  assert.equal(sup.leaving.length, 1);
  await till.saveSettings(env, { access: { accountId: 9, area: 'money', level: 0 } }, OWNER);
  const blind = await unpaidStays(env, SUPERVISOR, { now });
  assert.equal(blind.redacted, true);
  assert.equal(blind.leaving[0].balance, null);
});
