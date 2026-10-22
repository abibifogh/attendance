import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnOf, signedAmount, shiftLine, monthLines, byPerson, toCsv } from '../public/js/difftable.js';

/**
 * Shifts › Table: every difference signed one way (plus is money in that
 * ASSD does not show, minus is money ASSD shows that is not there), in its
 * column, and each shift's line. Everything is invented.
 */

const ex = (kind, amount, extra = {}) => ({ kind, amount, day: '2026-10-08', slot: 'afternoon', severity: 'warning', key: `${kind}:1`, ...extra });

test('each kind lands in its column, signed one way', () => {
  const cases = [
    [ex('drawer-short', -16500, { group: 'drawer' }), 'drawer', -16500],
    [ex('drawer-over', 500, { group: 'drawer' }), 'drawer', 500],
    [ex('movement-unlabelled', 20000, { group: 'unlabelled' }), 'drawer', -20000],
    [ex('receipts-unclear', 3000, { group: 'drawer' }), 'drawer', 0],
    [ex('not-found', 30000, { group: 'missing' }), 'card', -30000],
    [ex('not-recorded', 233600, { group: 'unrecorded' }), 'card', 233600],
    [ex('transposition', 900, { group: 'keying', paid: 12300, assd: 13200 }), 'card', -900],
    [ex('paid-more', 300, { group: 'paidmore', paid: 27900, assd: 27600 }), 'card', 300],
    [ex('never-settled', 5000, { group: 'settlement' }), 'bank', -5000],
    // A card refund with no bank reversal: card money taken that ASSD keyed back out.
    [ex('refund', -30000, { group: 'settlement' }), 'card', 30000],
    [ex('expense-no-po', 4000, { group: 'nopo' }), 'po', -4000],
    [ex('laundry-mismatch', 1500, { group: 'laundry' }), 'laundry', -1500],
  ];
  for (const [x, col, v] of cases) {
    assert.equal(columnOf(x), col, x.kind);
    assert.equal(signedAmount(x), v, x.kind);
  }
  assert.equal(signedAmount(ex('not-found', null)), null, 'hidden from whoever does not see amounts');
});

test('a shift’s line: the net of each kind, and where it stands', () => {
  const s = { day: '2026-10-08', slot: 'afternoon', user: 'KOFI' };
  const list = [
    ex('drawer-short', -16500, { group: 'drawer', answer: { answer: 'Put on a staff account' } }),
    ex('not-found', 30000, { group: 'missing', key: 'nf:2', proposed: { answer: 'Explained' } }),
    ex('not-recorded', 10000, { group: 'unrecorded', key: 'nr:3' }),
    ex('regrouped', 99999, { severity: 'info', key: 'rg:4' }),
    ex('drawer-short', -100, { slot: 'night', key: 'other' }),
  ];
  const l = shiftLine(s, list);
  assert.deepEqual(l.kinds, { drawer: -16500, card: -20000, bank: 0, po: 0, laundry: 0 });
  assert.deepEqual([l.net, l.open, l.waiting, l.answered, l.count, l.status], [-36500, 1, 1, 1, 3, 'open']);
  assert.equal(shiftLine(s, list.slice(0, 2)).status, 'waiting');
  // A drawer short of 78 with a movement of 50 labelled by hand: still 78. The
  // drawer's difference already holds the movement; the label only explains it.
  const notes = [ex('drawer-short', -7800, { group: 'drawer', key: 'drawer:x' }),
    ex('movement-labelled', 5000, { group: 'drawer', key: 'labelled:1', answer: { answer: 'Labelled by hand: it was expenses' } }),
    ex('movement-matched', 2000, { group: 'drawer', key: 'matched:2', answer: { answer: 'Matched as a duplicate' } }),
    ex('movement-twice', 2000, { group: 'drawer', key: 'twice:3' }),
    ex('movement-reversal', 1500, { group: 'drawer', key: 'rev:4' })];
  const d = shiftLine(s, notes);
  assert.deepEqual([d.kinds.drawer, d.net, d.count, d.answered], [-7800, -7800, 5, 2]);
  assert.equal(shiftLine(s, list.slice(0, 1)).status, 'answered');
  assert.equal(shiftLine(s, []).status, 'agrees');
  assert.equal(shiftLine({ ...s, open: true }, []).status, 'journal');
});

test('the month: every day with its three shifts, by person, and as CSV', () => {
  const shifts = [{ day: '2026-10-01', slot: 'morning', user: 'AMA' }, { day: '2026-10-02', slot: 'night', user: 'KOFI' }];
  const days = monthLines(shifts, [ex('drawer-short', -2000, { day: '2026-10-02', slot: 'night' })], '2026-10-01', '2026-10-03');
  assert.deepEqual(days.map((d) => [d.day, d.slots.map((l) => l?.user ?? null)]),
    [['2026-10-01', ['AMA', null, null]], ['2026-10-02', [null, null, 'KOFI']], ['2026-10-03', [null, null, null]]]);
  const lines = days.flatMap((d) => d.slots.filter(Boolean));
  assert.deepEqual(byPerson(lines, (l) => l.user).map((p) => [p.who, p.net, p.open]), [['KOFI', -2000, 1], ['AMA', 0, 0]]);
  const csv = toCsv(lines, (l) => (l.user === 'KOFI' ? 'Kofi, Test' : 'Ama Test')).split('\n');
  assert.equal(csv[0], 'Day,Shift,Who,Drawer,Card & MoMo,Bank,POs & expenses,Laundry,Net,Open,Waiting for admin,Answered,Status');
  assert.equal(csv[2], '2026-10-02,night,"Kofi, Test",-20.00,0.00,0.00,0.00,0.00,-20.00,1,0,0,open');
});
