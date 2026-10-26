import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, reportHtml, checks, counts, amount, fileName } from '../public/js/recon.js';

/** A made-up afternoon: the drawer short, a card refund with no reversal, a card line that never arrived. */
function model() {
  return {
    who: 'Kofi Test', day: '2026-10-13', when: 'Tue 13 Oct 2026', slot: 'Afternoon', hours: '14:00–22:00', seqs: 'ASSD 400071 to 400174', open: false, made: 'Mon 26 Oct 2026, 09:12',
    drawer: {
      steps: [
        { kind: 'start', label: 'Opening count', amount: 5600, ref: 'ASSD 400073' },
        { kind: 'in', label: 'Cash taken, as ASSD has it', amount: 119700, ref: '31 lines', parts: [{ label: 'Stays (rooms and beds)', amount: 88700 }, { label: 'At the till (water, items, services)', amount: 31000 }] },
        { kind: 'out', label: 'Expenses', amount: 5000, ref: 'ASSD 400103' },
      ],
      expected: 120300, counted: 112500, countedRef: 'ASSD 400171', variance: -7800, settled: null,
      handover: { from: 'Ama Test', before: 5600, first: 5600, gap: 0 },
      notes: ['28,000 pesewas keyed while the counts did not move: see below.'],
    },
    card: {
      assd: 559300, assdLines: 10, found: 586300, foundCount: 8, difference: 27000, matched: 8, matchedAmount: 586300,
      items: [
        { label: 'A refund keyed in ASSD', ref: 'ASSD 400101', amount: 30000, assd: -30000, found: 0, state: 'answer', text: 'No reversal six days on.', said: '' },
        { label: 'Recorded as card or MoMo, no payment arrived', ref: 'ASSD 400087', amount: -3000, assd: 3000, found: 0, state: 'approve', text: '', said: 'Waiting for an admin: “Explained” (Kofi Test)' },
      ],
    },
    expenses: { amount: 5000, ref: 'ASSD 400103', orders: [{ name: 'P00433', vendor: 'A Water Seller', total: 5000, ok: true }], poTotal: 5000, difference: 0 },
    goods: [{ name: 'Water', start: 234, out: 180, back: 175, should: 229, end: 229, diff: 0 }, { name: 'Padlocks', start: 11, out: 0, back: 0, should: 11, end: 11, diff: 0 }],
    laundry: null,
    diffs: [
      { kind: 'drawer-short', title: 'The drawer was short', amount: -7800, ref: '', text: 'It should have held 1,203.00.', state: 'answer', said: '' },
      { kind: 'keyed-no-cash', title: 'Keyed as cash, but the drawer did not move', amount: 28000, ref: '', text: 'The counts held 571.00.', state: 'info', said: '' },
      { kind: 'refund', title: 'A refund keyed in ASSD', amount: -30000, ref: 'ASSD 400101', text: '', state: 'answer', said: '' },
      { kind: 'not-found', title: 'Recorded as card or MoMo, no payment arrived', amount: 3000, ref: 'ASSD 400087', text: '', state: 'approve', said: 'Waiting for an admin: “<b>Explained</b>”' },
    ],
  };
}

test('amounts read as money, with a true minus', () => {
  assert.equal(amount(120300), '1,203.00');
  assert.equal(amount(-7800), '−78.00');
  assert.equal(amount(null), '—');
});

test('the checks: the drawer, the hand-over, stock still, each card difference, the rest of the card lines, expenses and stock', () => {
  const m = model();
  const list = checks(m);
  assert.deepEqual(list.map((x) => [x.group, x.title, x.state]), [
    ['Cash', 'Drawer at the close', 'bad'],
    ['Cash', 'Hand-over from the shift before', 'good'],
    ['Cash', 'Cash keyed while the counts stood still', 'warn'],
    ['Card & MoMo', 'A refund keyed in ASSD · ASSD 400101', 'bad'],
    ['Card & MoMo', 'Recorded as card or MoMo, no payment arrived · ASSD 400087', 'warn'],
    ['Card & MoMo', 'The other 8 lines', 'good'],
    ['Expenses, stock, laundry', 'Expenses against POs', 'good'],
    ['Expenses, stock, laundry', 'Water', 'good'],
    ['Expenses, stock, laundry', 'Padlocks', 'good'],
  ]);
  assert.deepEqual(counts(m), { answer: 2, approve: 1, all: 3 });
  // Answered: the drawer is settled whatever its size.
  m.drawer.settled = 'Answered: Explained';
  assert.equal(checks(m)[0].state, 'good');
});

test('three layouts of the same figures, each a page of its own, with what people typed escaped', () => {
  const m = model();
  assert.deepEqual(LAYOUTS.map((x) => x.id), ['statement', 'bridge', 'checklist']);
  for (const { id } of LAYOUTS) {
    const page = reportHtml(m, id);
    assert.match(page, /^<!doctype html>/);
    assert.match(page, new RegExp(`data-layout="${id}"`));
    assert.match(page, /Kofi Test/);
    assert.match(page, /1,203\.00/, `${id}: should hold`);
    assert.match(page, /1,125\.00/, `${id}: counted`);
    assert.ok(!page.includes('<b>Explained</b>'), `${id}: an answer's words are text, not markup`);
    assert.match(page, /&lt;b&gt;Explained&lt;\/b&gt;|Explained/);
  }
  const st = reportHtml(m, 'statement');
  assert.match(st, /\(78\.00\)/, 'short, in brackets');
  assert.match(st, /Checked by/);
  assert.match(st, /2 answers needed/);
  const br = reportHtml(m, 'bridge');
  assert.match(br, /class="bar gap"/, 'the difference striped');
  assert.ok(!br.includes('NaN'), 'every bar has a place and a width');
  assert.match(br, /class="bar total" style="left:0\.00%;width:4\.47%"/, 'the opening 56 of the 1,253 the drawer reached at its highest');
  assert.match(br, /2 of 3/);
  const ck = reportHtml(m, 'checklist');
  assert.match(ck, />5 agree</);
  assert.match(ck, /Approve or reject the answer on recorded as card or MoMo/);
  assert.equal(reportHtml(m, 'nonsense'), st, 'anything else is the statement');
});

test('a shift with nothing on it still makes a report', () => {
  const m = { ...model(), drawer: null, card: null, expenses: null, goods: [], laundry: null, diffs: [] };
  for (const { id } of LAYOUTS) assert.match(reportHtml(m, id), /Nothing|every difference is answered|Agree/);
  assert.equal(fileName(m, 'bridge'), 'reconciliation-2026-10-13-afternoon-kofi-test-bridge.html');
});
