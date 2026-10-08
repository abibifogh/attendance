import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import {
  assdMoney, assdDate, journalWindow, mergeEntry, parseJournal, segment, methodOf, labelMovements,
} from '../src/shifts/assd.js';
import { parseTerminalCsv, csvRow, unwrap } from '../src/shifts/terminal.js';
import { parseStatement, classify, sheetTime } from '../src/shifts/bank.js';
import {
  reconcile, settlement, placeShifts, slotAt, slotIndex, hoursOf, minuteOf,
  isTransposition, isDecimalSlip, isOneDigitOff,
} from '../src/shifts/reconcile.js';
import { itemsToLines, redactJournalLines } from '../public/js/pdf-lines.js';
import { purchaseOrders } from '../src/connectors/odoo.js';
import * as routes from '../src/routes/shifts.js';

/**
 * Shift reconciliation.
 *
 * Every fixture here is invented: made-up users, made-up guests, made-up
 * cards. The repository is public, and the real journal names real guests.
 * The shapes are copied from ASSD, the bank and the terminal portal exactly;
 * the contents are not.
 */

// ------------------------------------------------------------- fixtures --

const PAGE = [
  'EHC/XXX test hotel   01.09.26 05:00',
  'Business Reports   Page: 1',
  'Journal:   01   01',
  'Benefit Date:   01.08.26   02.08.26',
  'Type of Report:   Detail Journal of every Transaction',
];
const block = (kind, user, seq, date, register, lines, guest = '/') => [
  `${kind}   ${user}   ${guest}`,
  `01-104-${seq}   ${register}/9${seq}-   ${date}   /`,
  ...lines,
];
const card = (date, amount) => `${date}   CR.   CREDIT CARD   ${amount} GHS`;
const cash = (date, amount) => `${date}   CASH   CASH   ${amount} GHS`;
const marker = (user, seq, date) => block('Beginn of Day Processing', user, seq, date, '001', []);
const sale = (user, seq, date, pays, guest = 'Test Guest / 1 Example Road') => block('Reservation', user, seq, date, '001', [
  `${date}   101   Double Room   1   100,00   100,00 GHS   19`, ...pays, '0,00 GHS'], guest);

/** Two days of an invented hotel, in ASSD's order. */
function journal() {
  return [
    ...PAGE,
    ...sale('ALPHA', 300498, '28.07.26', []),
    ...marker('ALPHA', 300499, '01.08.26'),
    // The opening count at hand-over.
    ...block('Money Count', 'ALPHA', 300500, '01.08.26', '001', ['. .   00002   100 GHS   1   100,00   100,00 GHS', '100,00 GHS']),
    // A block split by a page break, repeating its header.
    'Reservation   ALPHA   Test Guest / 1 Example Road',
    '01-104-300502   001/9300502-   01.08.26   SOMEWHERE /',
    ...PAGE,
    'Reservation   ALPHA   Test Guest / 1 Example Road',
    '01-104-300502   001/9300502-   01.08.26   SOMEWHERE /',
    card('01.08.26', '500,00'),
    ...block('Cash Register', 'ALPHA', 300503, '01.08.26', '001', [
      '01.08.26   540   Laundry Service   1   70,00   70,00 GHS   19', cash('01.08.26', '70,00')]),
    ...sale('ALPHA', 300504, '01.08.26', [cash('01.08.26', '300,00')]),
    ...sale('ALPHA', 300505, '01.08.26', [card('01.08.26', '883,00')]),
    ...sale('ALPHA', 300506, '01.08.26', [card('01.08.26', '276,00')]),
    ...block('Money Count', 'ALPHA', 300507, '01.08.26', '001', [
      '. .   00002   100 GHS   1   100,00   100,00 GHS',
      '. .   00099   Total Expenses PAID   1   50,00   50,00 GHS', '150,00 GHS']),
    ...block('Cash Movement', 'ALPHA', 300508, '01.08.26', '001', ['01.08.26   -150,00 GHS', '0,00 GHS']),
    ...block('Cash Movement', 'ALPHA', 300509, '01.08.26', '015', ['01.08.26   150,00 GHS', '0,00 GHS']),
    // The closing count: 318 where 320 was due.
    ...block('Money Count', 'ALPHA', 300510, '01.08.26', '001', [
      '. .   00002   100 GHS   3   100,00   300,00 GHS', '. .   00010   2 GHS   9   2,00   18,00 GHS', '318,00 GHS']),
    ...block('End cash deficit/surplus', 'ALPHA', 300512, '01.08.26', '001', [
      '01.08.26   Deficit cash POS   0   0,00   -2,00 GHS   0', '01.08.26   Cash   -2,00 GHS', '-2,00 GHS']),
    // Back office, on another register: never a shift's money.
    ...block('Accounting', 'DELTA', 300511, '01.08.26', '015', [
      '01.08.26   CC Prepayments   -226,00 GHS', '01.08.26   Credit card EURO   226,00 GHS', '0,00 GHS'], 'GUEST NAME'),

    ...marker('BRAVO', 300520, '01.08.26'),
    ...sale('BRAVO', 300521, '01.08.26', [card('01.08.26', '1.200,00')]),
    ...sale('BRAVO', 300522, '01.08.26', [card('01.08.26', '150,00')]),
    ...sale('BRAVO', 300523, '01.08.26', [card('01.08.26', '250,00')]),
    ...sale('BRAVO', 300524, '01.08.26', [card('01.08.26', '640,00')]),
    // BRAVO's first count finds 8 less than ALPHA left. The same 20.00 is
    // then moved out twice though it left once, so the drawer counts 20 over.
    ...block('Money Count', 'BRAVO', 300525, '01.08.26', '001', ['. .   00002   100 GHS   3   100,00   300,00 GHS', '. .   00020   10 GHS   1   10,00   10,00 GHS', '310,00 GHS']),
    ...block('Cash Movement', 'BRAVO', 300526, '01.08.26', '001', ['01.08.26   -20,00 GHS', '0,00 GHS']),
    ...block('Cash Movement', 'BRAVO', 300527, '01.08.26', '015', ['01.08.26   20,00 GHS', '0,00 GHS']),
    ...block('Cash Movement', 'BRAVO', 300528, '01.08.26', '001', ['01.08.26   -20,00 GHS', '0,00 GHS']),
    ...block('Cash Movement', 'BRAVO', 300529, '01.08.26', '015', ['01.08.26   20,00 GHS', '0,00 GHS']),
    ...block('Money Count', 'BRAVO', 300530, '01.08.26', '001', ['. .   00002   100 GHS   2   100,00   200,00 GHS', '. .   00020   10 GHS   9   10,00   90,00 GHS', '290,00 GHS']),

    // The night's marker carries the next morning's date, as ASSD does.
    ...marker('CHARLIE', 300535, '02.08.26'),
    ...sale('CHARLIE', 300536, '02.08.26', [card('02.08.26', '90,00')]),
    ...sale('CHARLIE', 300537, '02.08.26', [card('02.08.26', '45,00')]),
    // CHARLIE puts 20.00 back into the drawer: the second of BRAVO's two.
    ...block('Cash Movement', 'CHARLIE', 300538, '02.08.26', '001', ['02.08.26   20,00 GHS', '0,00 GHS']),
    ...block('Cash Movement', 'CHARLIE', 300539, '02.08.26', '015', ['02.08.26   -20,00 GHS', '0,00 GHS']),

    ...marker('ALPHA', 300540, '02.08.26'),
    ...sale('ALPHA', 300541, '02.08.26', [card('02.08.26', '60,00')]),
  ];
}

const TERMINAL_HEADER = '"SN","Date","PAN","MTI","Terminal","Type","TransactionType","Amount","STAN","MCC","TransactionFee","RRN","MID","Merchant","Currency","Responsecode","Status","AgentId","PhoneNumber","ApprovalCode","IsCNP"';
let sn = 0;
const tap = (at, amount, { pan = '411111******1111', code = '00', status = 'Approved or completed successfully', approval = 'A1B2C3', type = 'Purchase' } = {}) => {
  sn += 1;
  return `"${sn}","${at}","=""${pan}""","0200","=""TERM0001""","000000","${type}","${amount}","=""${100000 + sn}""","7011","D00000000","=""9${String(sn).padStart(11, '0')}""","=""MID""","TEST HOTEL","936","=""${code}""","${status}","=""""","=""""","=""${approval}${sn}""","NO"`;
};

function terminalCsv() {
  sn = 0;
  return [TERMINAL_HEADER,
    tap('2026-08-01 08:10:00', '500.00', { pan: '411111******0001' }),
    tap('2026-08-01 09:00:00', '883.00', { pan: '411111******0002', code: '51', status: 'Insufficient funds' }),
    tap('2026-08-01 10:00:00', '279.00', { pan: '411111******0003' }),
    tap('2026-08-01 15:00:00', '700.00', { pan: '411111******0004' }),
    tap('2026-08-01 16:00:00', '400.00', { pan: '411111******0005' }),
    tap('2026-08-01 23:30:00', '90.00', { pan: '411111******0006' }),
    tap('2026-08-02 01:00:00', '45.00', { pan: '411111******0007' }),
    tap('2026-08-02 01:04:00', '45.00', { pan: '411111******0007' }),
    tap('2026-08-02 07:00:00', '60.00', { pan: '411111******0008' }),
    tap('2026-08-02 09:00:00', '1,999.00', { pan: '411111******0009' }),
  ].join('\n');
}

const serial = (day, time = '00:00:00') => Date.parse(`${day}T${time}Z`) / 86400000 + 25569;
const BANK_HEADER = ['TRAN ID', 'PART TRAN SRL NUM', 'PART TRAN TYPE', 'PSTD FLG', 'TRAN DATE', 'PSTD DATE', 'TRAN AMT', 'TRAN PARTICULAR', 'REF NUM', 'DEL FLG'];
function statement() {
  return [
    ['A CUSTOMER STATEMENT'],
    BANK_HEADER,
    ['T1', '1', 'C', 'Y', serial('2026-08-03'), serial('2026-08-03', '12:00:00'), 500, '411111************0001_01-Aug-2026_A1B2C31_TERM0001', '1', 'N'],
    // The same row again, as the bank keeps its deleted copies.
    ['T1', '1', 'C', 'N', serial('2026-08-03'), null, 500, '411111************0001_01-Aug-2026_A1B2C31_TERM0001', '1', 'Y'],
    ['T2', '2', 'D', 'Y', serial('2026-08-03'), serial('2026-08-03', '12:05:00'), 5, 'comm_411111************0001_01-Aug-2026_A1B2C31_TERM0001', '1', 'N'],
    ['T3', '1', 'C', 'Y', serial('2026-08-01'), serial('2026-08-01', '15:15:00'), 500, 'GTB/TESTHOTEL//REF12345601/08/2026 15:15:00', 'REF1', 'N'],
    ['T4', '1', 'C', 'Y', serial('2026-08-02'), serial('2026-08-02', '02:00:00'), 35, 'GTB/TESTHOTEL//REF99999902/08/2026 02:00:00', 'REF2', 'N'],
    ['T5', '1', 'D', 'Y', serial('2026-08-02'), serial('2026-08-02', '10:00:00'), 5000, 'A SUPPLIER PAYMENT', null, 'N'],
    ['T6', '3', 'D', 'Y', serial('2026-08-05'), serial('2026-08-05', '10:00:00'), 60, '411111************0008_02-Aug-2026_A1B2C39', '1', 'N'],
  ];
}

// ------------------------------------------------------------- the journal --

test('ASSD money, dates and methods', () => {
  assert.equal(assdMoney('1.763,00'), 176300);
  assert.equal(assdMoney('-2.740,50'), -274050);
  assert.equal(assdDate('01.08.26'), '2026-08-01');
  assert.equal(methodOf('CR.   CREDIT CARD'), 'card');
  assert.equal(methodOf('CASH   CASH'), 'cash');
  assert.equal(methodOf('PRE-BANBANK PREPAID'), 'prepaid');
  assert.deepEqual(journalWindow(PAGE), { from: '2026-08-01', to: '2026-08-02' });
});

test('the journal becomes shifts, cut at each hand-over', () => {
  const entries = parseJournal(journal());
  // The page break inside 300502 did not make two entries.
  assert.equal(entries.filter((e) => e.seq === 300502).length, 1);
  const { shifts, before } = segment(entries);
  assert.equal(before.length, 1, 'the reservation before the first hand-over is not the first shift’s');
  assert.deepEqual(shifts.map((s) => s.user), ['ALPHA', 'BRAVO', 'CHARLIE', 'ALPHA']);

  const [alpha] = shifts;
  assert.equal(alpha.cash, 37000, 'cash sales, laundry included; the deficit is not takings');
  assert.equal(alpha.card, 165900);
  assert.equal(alpha.laundry, 7000);
  assert.equal(alpha.laundryCash, 7000);
  assert.equal(alpha.drawerOut, 15000, 'only the front drawer’s side of the movement');
  assert.equal(alpha.expensesMoved, 5000, 'the receipts on the count before the movement');
  assert.equal(alpha.safeMoved, 10000, 'and the notes on it');
  assert.equal(alpha.moves[0].kind, 'split');
  assert.equal(alpha.opening.total, 10000);
  assert.equal(alpha.closing.total, 31800);
  assert.equal(alpha.countVariance, -200, 'the same figure ASSD booked');
  assert.deepEqual(alpha.booked.map((b) => [b.when, b.amount]), [['close', -200]]);
  assert.deepEqual(alpha.backOffice.map((b) => b.user), ['DELTA'], 'register 015 is not the drawer');
  assert.equal(alpha.prepaid + alpha.other, 0);
});

test('a later export replaces lines inside its window and keeps the rest', () => {
  const stored = { payments: [{ date: '2026-07-31', method: 'card', amount: 100 }, { date: '2026-08-01', method: 'card', amount: 200 }], laundry: [] };
  const fresh = { payments: [{ date: '2026-08-01', method: 'card', amount: 250 }], laundry: [{ date: '2026-08-01', amount: 70 }] };
  const merged = mergeEntry(stored, fresh, { from: '2026-08-01', to: '2026-08-07' });
  assert.deepEqual(merged.payments.map((p) => p.amount), [100, 250]);
  assert.deepEqual(merged.laundry.map((l) => l.amount), [70]);
});

test('guests are taken out of the journal before it leaves the browser, and nothing else changes', () => {
  const lines = journal();
  const red = redactJournalLines(lines);
  assert.ok(!red.some((l) => /Test Guest|Example Road|SOMEWHERE|GUEST NAME/.test(l)));
  assert.deepEqual(parseJournal(red), parseJournal(lines));
});

test('pdf text runs become lines, with column gaps kept', () => {
  const item = (str, x, y, width) => ({ str, transform: [1, 0, 0, 1, x, y], width });
  const lines = itemsToLines([
    item('01.08.26', 10, 700, 40), item('CASH', 70, 700.5, 20), item('70,00 GHS', 200, 700, 45),
    item('Money Count', 10, 690, 55), item('ALPHA', 90, 690, 28),
  ]);
  assert.deepEqual(lines, ['01.08.26   CASH   70,00 GHS', 'Money Count   ALPHA']);
});

// ------------------------------------------------------------ other files --

test('the terminal report, with its ="…" wrapping and thousands commas', () => {
  assert.deepEqual(csvRow('"a","=""1,2""",c'), ['a', '="1,2"', 'c']);
  assert.equal(unwrap('="524322******4698"'), '524322******4698');
  const { rows } = parseTerminalCsv(terminalCsv());
  assert.equal(rows.length, 10);
  const big = rows.find((r) => r.amount === 199900);
  assert.equal(big.last4, '0009');
  assert.equal(big.at, '2026-08-02 09:00:00');
  assert.equal(rows.filter((r) => !r.approved).length, 1);
  assert.ok(parseTerminalCsv('"a","b"\n"1","2"').error);
});

test('the bank statement: kinds, deleted copies and dates without a time zone', () => {
  assert.equal(sheetTime(serial('2026-08-03', '12:05:00')), '2026-08-03 12:05:00');
  assert.equal(classify('411111************0001_01-Aug-2026_A1B2C3', 'C').kind, 'card');
  assert.equal(classify('411111************0001_01-Aug-2026_A1B2C3_TERM', 'D').kind, 'card-reversal');
  assert.equal(classify('comm_411111************0001_01-Aug-2026_A1B2C3', 'D').kind, 'commission');
  assert.equal(classify('GTB/X//R01/08/2026 15:15:00', 'C').kind, 'momo');
  assert.equal(classify('A SUPPLIER PAYMENT', 'D').kind, 'other');

  const parsed = parseStatement(statement());
  assert.equal(parsed.counts.flagged, 1);
  assert.equal(parsed.counts.other, 1);
  const credit = parsed.rows.find((r) => r.kind === 'card');
  assert.equal(credit.cardDay, '2026-08-01');
  assert.equal(credit.approval, 'A1B2C31');
  const momo = parsed.rows.find((r) => r.kind === 'momo');
  assert.equal(momo.at, '2026-08-01 15:15:00');
  assert.ok(parseStatement([['nothing']]).error);
});

// --------------------------------------------------------------- matching --

test('slips of the finger', () => {
  assert.ok(isTransposition(97800, 98700));
  assert.ok(!isTransposition(97800, 97800));
  assert.ok(isDecimalSlip(45000, 4500));
  assert.ok(isOneDigitOff(27600, 27900));
  assert.ok(!isOneDigitOff(27600, 37900));
});

test('slots: a moment belongs to the slot it falls in, and a night to the day it starts', () => {
  assert.equal(slotAt(minuteOf('2026-08-02 01:00:00')), slotIndex('2026-08-01', 2));
  assert.equal(slotAt(minuteOf('2026-08-02 06:00:00')), slotIndex('2026-08-02', 0));
  const { start, end } = hoursOf(slotIndex('2026-08-01', 2));
  assert.equal(end - start, 480);
});

const shift = (user, markerDate, cards) => ({
  user, markerDate, cash: 0, card: 0, cards: cards.map(([seq, amount, date = markerDate]) => ({ seq, amount, date, user })),
});
const ev = (id, at, amount, extra = {}) => ({ id, kind: 'card', at, amount, source: 'terminal', ...extra });

test('shifts are placed by the terminal’s clock and the marker, one slot after another', () => {
  const shifts = [shift('A', '2026-08-01', [[1, 5000]]), shift('B', '2026-08-01', []), shift('C', '2026-08-02', [[2, 7000]])];
  const placed = placeShifts(shifts, [ev('x', '2026-08-01 08:00:00', 5000), ev('y', '2026-08-01 23:00:00', 7000)]
    .map((e) => ({ ...e, minute: minuteOf(e.at) })));
  assert.deepEqual(placed.map((p) => p.slot), [0, 1, 2].map((s) => slotIndex('2026-08-01', s)));
});

test('the explained differences: split differently, keyed on another shift, corrected', () => {
  const shifts = [
    shift('A', '2026-08-01', [[1, 45400], [2, 97800], [3, 50300]]),
    shift('B', '2026-08-01', [[4, 10000], [5, -3000], [6, 3000]]),
    shift('C', '2026-08-02', [[7, 124100]]),
  ];
  const events = [
    ev('e1', '2026-08-01 09:00:00', 96700), ev('e2', '2026-08-01 09:05:00', 96800),
    ev('e3', '2026-08-01 15:00:00', 10000), ev('e4', '2026-08-01 16:00:00', 124100),
  ];
  const { exceptions } = reconcile(shifts, events, []);
  const kinds = exceptions.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['corrected', 'other-shift', 'regrouped']);
  const regrouped = exceptions.find((x) => x.kind === 'regrouped');
  assert.equal(regrouped.amount, 193500);
  assert.deepEqual(regrouped.seqs, [1, 2, 3]);
  assert.equal(exceptions.find((x) => x.kind === 'other-shift').otherShift.user, 'B');
  assert.ok(exceptions.every((x) => x.severity === 'info'));
});

test('a card keyed twice but paid once, and a decimal slip', () => {
  const shifts = [shift('A', '2026-08-01', [[1, 20000], [2, 20000], [3, 45000]])];
  const { exceptions } = reconcile(shifts, [ev('e1', '2026-08-01 09:00:00', 20000), ev('e2', '2026-08-01 10:00:00', 4500)], []);
  assert.deepEqual(exceptions.map((x) => x.kind).sort(), ['decimal', 'duplicate']);
});

test('settlement: joined on approval and card, or never settled, or the bank alone', () => {
  const approved = [
    { rrn: 'r1', at: '2026-08-01 07:43:00', amount: 7000, last4: '0001', approval: 'ZZZ' },
    { rrn: 'r2', at: '2026-08-01 12:00:00', amount: 9000, last4: '0002', approval: 'YYY' },
  ];
  const bank = [
    { id: 'b1', kind: 'card', day: '2026-08-03', cardDay: '2026-07-31', amount: 7000, last4: '0001', approval: 'zzz' },
    { id: 'b2', kind: 'card', day: '2026-08-03', cardDay: '2026-08-01', amount: 1, last4: '0003', approval: 'XXX' },
    { id: 'b3', kind: 'card-reversal', day: '2026-08-04', cardDay: '2026-08-01', amount: 500, last4: '0004', approval: 'WWW' },
  ];
  const out = settlement(approved, bank, { terminal: new Set(['2026-08-01']), bankTo: '2026-08-10' });
  assert.equal(out.settled.get('r1').id, 'b1', 'the bank dated it the day before; the approval code still joins it');
  assert.deepEqual(out.exceptions.map((x) => x.kind).sort(), ['bank-only', 'never-settled', 'reversal']);
  const early = settlement(approved, bank, { terminal: new Set(['2026-08-01']), bankTo: '2026-08-04' });
  assert.ok(!early.exceptions.some((x) => x.kind === 'never-settled'), 'not before six days have passed');
});

// ----------------------------------------------------------------- routes --

const OWNER = { name: 'Test Owner', isOwner: true };

async function loaded() {
  const { db } = freshDb();
  const env = { DB: db };
  await routes.uploadJournal(env, { lines: redactJournalLines(journal()), name: 'journal.pdf' }, OWNER);
  await routes.uploadTerminal(env, { text: terminalCsv(), name: 'tams.csv' }, OWNER);
  await routes.uploadBank(env, { rows: statement(), name: 'bank.xlsx' }, OWNER);
  return env;
}

test('the whole screen, from the three files', async () => {
  const env = await loaded();
  const out = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER);
  assert.equal(out.canUpload, true);
  const day1 = out.days.find((d) => d.day === '2026-08-01');
  assert.deepEqual(day1.shifts.map((s) => [s.slot, s.user]), [['morning', 'ALPHA'], ['afternoon', 'BRAVO'], ['night', 'CHARLIE']]);
  const day2 = out.days.find((d) => d.day === '2026-08-02');
  assert.equal(day2.shifts[0].open, true, 'the journal ends inside this shift');
  assert.deepEqual(out.journalEndsInside, { day: '2026-08-02', slot: 'morning' });

  const kinds = out.exceptions.map((x) => `${x.kind}:${x.amount}`).sort();
  assert.deepEqual(kinds, [
    'double-charge:4500',
    'drawer-over:2000',
    'drawer-short:-200',
    'failed:88300',
    'handover-gap:-800',
    'keying:27600',
    'movement-reversal:2000',
    'movement-twice:2000',
    'not-found:64000',
    'not-recorded:3500',
  ], 'the 1,999 taken after the journal ends is not called unrecorded');

  const bravo = day1.shifts[1];
  assert.equal(bravo.cardFound, 3);
  assert.equal(bravo.lines.find((l) => l.amount === 120000).how, 'parts', 'card and MoMo together paid one line');
  assert.equal(bravo.lines.find((l) => l.amount === 15000).how, 'together');

  assert.equal(day1.laundry.assd, 7000);
  assert.equal(day1.totals.commission, 500);
  assert.equal(out.coverage.terminal.from, '2026-08-01');
});

test('the drawer, from ASSD’s own counts, and a recount when one is typed', async () => {
  const env = await loaded();
  let out = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  let [alpha, bravo] = out.days[0].shifts;
  // 100 counted + 370 cash − 150 moved = 320 due; ASSD counted 318.
  assert.equal(alpha.register.opening, 10000);
  assert.equal(alpha.register.openingFrom, 'assd');
  assert.equal(alpha.register.expected, 32000);
  assert.equal(alpha.register.closing, 31800);
  assert.equal(alpha.register.closingFrom, 'assd');
  assert.equal(alpha.register.variance, -200);
  assert.equal(alpha.register.expenses, 5000);
  assert.equal(alpha.register.toSafe, 10000);
  assert.equal(alpha.register.unlabelled, 0);
  assert.deepEqual(bravo.register.handoverGap, { amount: -800, from: 'ALPHA' });
  assert.equal(bravo.register.variance, 2000, 'the same 20.00 moved out twice');
  assert.equal(out.people.find((p) => p.user === 'ALPHA').variance, -200);

  await routes.saveCount(env, { day: '2026-08-01', slot: 'morning', closing: '320' }, OWNER);
  await routes.saveExpense(env, { day: '2026-08-01', slot: 'morning', sheetTotal: '150' }, OWNER);
  out = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  [alpha] = out.days[0].shifts;
  assert.equal(alpha.register.closingFrom, 'typed');
  assert.equal(alpha.register.variance, 0);
  assert.equal(alpha.register.expenses, 5000, 'the counted receipts still decide what was expenses');
  assert.equal(alpha.register.toSafe, 10000);
  assert.equal(alpha.register.sheetGap, 10000, 'and the sheet saying more is shown, not written over');
  assert.ok(!out.exceptions.some((x) => x.kind === 'drawer-short'));
});

test('a person can correct what a movement was, match a duplicate, and pair a reversal across shifts', async () => {
  const env = await loaded();
  const read = async () => {
    const out = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER);
    const all = out.days.flatMap((d) => d.shifts);
    return { out, alpha: all.find((x) => x.user === 'ALPHA' && x.day === '2026-08-01'), bravo: all.find((x) => x.user === 'BRAVO'), charlie: all.find((x) => x.user === 'CHARLIE') };
  };

  // Relabel: the counted split was really all cash to the safe, then a split by hand.
  await routes.saveMovement(env, { seq: 300508, kind: 'safe', note: 'no receipts that day' }, OWNER);
  let { alpha } = await read();
  assert.deepEqual([alpha.register.expenses, alpha.register.toSafe], [0, 15000]);
  assert.equal(alpha.moves[0].auto, 'split');
  assert.equal(alpha.moves[0].manual.by, 'Test Owner');
  await routes.saveMovement(env, { seq: 300508, kind: 'split', expenses: '30' }, OWNER);
  ({ alpha } = await read());
  assert.deepEqual([alpha.register.expenses, alpha.register.toSafe], [3000, 12000]);

  // A duplicate within the shift: left out, and the surplus goes with it.
  let { out, bravo } = await read();
  assert.ok(out.exceptions.some((x) => x.kind === 'movement-twice' && x.action.pair === 300526));
  await routes.saveMovement(env, { seq: 300528, kind: 'duplicate', pair: 300526 }, OWNER);
  ({ out, bravo } = await read());
  assert.equal(bravo.register.variance, 0);
  assert.equal(bravo.register.assdVariance, 0, 'ASSD booked nothing for this invented shift');
  assert.ok(!out.exceptions.some((x) => x.kind === 'movement-twice' || (x.kind === 'drawer-over' && x.user === 'BRAVO')));
  await routes.saveMovement(env, { seq: 300528, kind: 'clear' }, OWNER);

  // The other way: the duplicate was put back on the next shift.
  ({ out } = await read());
  const suggestion = out.exceptions.find((x) => x.kind === 'movement-reversal');
  assert.equal(suggestion.seq, 300538);
  assert.equal(suggestion.pairShift.user, 'BRAVO');
  await routes.saveMovement(env, { seq: suggestion.action.pair, kind: 'reverses', pair: suggestion.action.seq }, OWNER);
  let charlie;
  ({ out, bravo, charlie } = await read());
  assert.equal(bravo.register.variance, 0, 'the earlier shift no longer counts over');
  assert.equal(charlie.drawerOut, 0, 'and the later one no longer takes back money that never came');
  assert.equal(charlie.moves.find((m) => m.seq === 300538).pairShift.user, 'BRAVO');
  assert.ok(!out.exceptions.some((x) => x.kind === 'movement-reversal'));

  // What cannot be said.
  await assert.rejects(routes.saveMovement(env, { seq: 300526, kind: 'duplicate', pair: 300508 }, OWNER), /same amount/);
  await assert.rejects(routes.saveMovement(env, { seq: 300526, kind: 'reverses', pair: 300528 }, OWNER), /same amount the other way/);
  await assert.rejects(routes.saveMovement(env, { seq: 300538, kind: 'expenses' }, OWNER), /put money back/);
  await assert.rejects(routes.saveMovement(env, { seq: 300526, kind: 'duplicate', pair: 300528 }, OWNER), /already matched/);
  await assert.rejects(routes.saveMovement(env, { seq: 300508, kind: 'split', expenses: '150' }, OWNER), /less than the whole/);
  await assert.rejects(routes.saveMovement(env, { seq: 300502, kind: 'safe' }, OWNER), /not a Cash Movement/);

  // Undo from either end of a pair.
  await routes.saveMovement(env, { seq: 300528, kind: 'clear' }, OWNER);
  ({ bravo } = await read());
  assert.equal(bravo.register.variance, 2000);
});

test('what each cash movement was', () => {
  const counts = [
    { seq: 1, notes: 61200, receipts: 176300, total: 237500 },
    { seq: 4, notes: 230000, receipts: 44000, total: 274000 },
  ];
  const moves = labelMovements([
    { seq: 2, user: 'A', amount: 1763000, countsBefore: 1 },
    { seq: 3, user: 'M', amount: -1763000, countsBefore: 1 },
    { seq: 3.5, user: 'A', amount: 176300, countsBefore: 1 },
    { seq: 5, user: 'B', amount: 274000, countsBefore: 2 },
    { seq: 6, user: 'B', amount: 41500, countsBefore: 2 },
  ], counts);
  assert.deepEqual(moves.map((m) => m.kind), ['corrected', 'expenses', 'split', 'unlabelled']);
  assert.equal(moves[0].reversedByUser, 'M');
  assert.deepEqual([moves[2].expenses, moves[2].safe], [44000, 230000]);
  const part = labelMovements([{ seq: 9, user: 'C', amount: 169300, countsBefore: 1 }], [{ seq: 8, notes: 118400, receipts: 154500, total: 272900 }]);
  assert.deepEqual([part[0].kind, part[0].expenses], ['part', 154500]);
  const receiptsOnly = labelMovements([{ seq: 9, user: 'C', amount: 101800, countsBefore: 1 }], [{ seq: 8, notes: 0, receipts: 101800, total: 101800 }]);
  assert.equal(receiptsOnly[0].kind, 'expenses', 'a count of receipts alone, moved whole, is expenses');
  const safe = labelMovements([{ seq: 9, user: 'C', amount: 500000, countsBefore: 1 }], [{ seq: 8, notes: 500000, receipts: 0, total: 500000 }]);
  assert.equal(safe[0].kind, 'safe');
});

test('the internet-banking statement reads the same as the Finacle export', () => {
  const page = [
    ['Account No: 0000000000'],
    ['Opening Balance: 1,000.00'],
    ['Trans Date', 'Reference', 'Value Date', 'Debit', 'Credit', 'Balance', 'Remarks'],
    ['03-Aug-2026', 'T1', '03-Aug-2026', '0.00', '5.00', '1,005.00', '411111************0001_01-Aug-2026_A1B2C31_TERM0001'],
    ['03-Aug-2026', 'T2', '03-Aug-2026', '0.05', '0.00', '1,004.95', 'comm_411111************0001_01-Aug-2026_A1B2C31_TERM0001'],
    ['01-Aug-2026', 'T3', '01-Aug-2026', '0.00', '500.00', '1,504.95', 'GTB/TESTHOTEL//REF12345601/08/2026 15:15:00'],
    ['05-Aug-2026', 'T6', '05-Aug-2026', '1,060.00', '0.00', '444.95', '411111************0008_02-Aug-2026_A1B2C39'],
    ['05-Aug-2026', 'T7', '05-Aug-2026', '50.00', '0.00', '394.95', 'A SUPPLIER PAYMENT'],
  ];
  const parsed = parseStatement(page);
  assert.equal(parsed.layout, 'internet');
  assert.deepEqual(parsed.rows.map((r) => r.kind), ['card', 'commission', 'momo', 'card-reversal']);
  assert.equal(parsed.rows[3].amount, 106000, 'thousands commas read');
  assert.equal(parsed.rows[2].at, '2026-08-01 15:15:00');
  assert.equal(parsed.counts.other, 1);

  // The same rows from the Finacle export get the same ids.
  const finacle = parseStatement([
    BANK_HEADER,
    ['T1', '1', 'C', 'Y', serial('2026-08-03'), serial('2026-08-03', '12:00:00'), 5, '411111************0001_01-Aug-2026_A1B2C31_TERM0001', '1', 'N'],
    ['T3', '1', 'C', 'Y', serial('2026-08-01'), serial('2026-08-01', '15:15:00'), 500, 'GTB/TESTHOTEL//REF12345601/08/2026 15:15:00', 'REF1', 'N'],
  ]);
  const ids = new Set(parsed.rows.map((r) => r.id));
  assert.ok(finacle.rows.every((r) => ids.has(r.id)));
});

test('answers stick to their exception, and the same file twice changes nothing', async () => {
  const env = await loaded();
  const first = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER);
  const failed = first.exceptions.find((x) => x.kind === 'failed');
  await routes.saveAnswer(env, { key: failed.key, answer: 'Guest owes — chasing', note: 'called' }, OWNER);
  await routes.uploadJournal(env, { lines: redactJournalLines(journal()), name: 'journal.pdf' }, OWNER);
  await routes.uploadTerminal(env, { text: terminalCsv(), name: 'tams.csv' }, OWNER);
  const again = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER);
  assert.equal(again.exceptions.length, first.exceptions.length);
  const answered = again.exceptions.find((x) => x.key === failed.key);
  assert.equal(answered.answer.answer, 'Guest owes — chasing');
  assert.equal(answered.answer.by, 'Test Owner');
  assert.equal(again.totals.open, first.totals.open - 1);
});

test('typed input is checked', async () => {
  const env = await loaded();
  await assert.rejects(routes.saveCount(env, { day: 'yesterday', slot: 'morning' }, OWNER), /YYYY-MM-DD/);
  await assert.rejects(routes.saveCount(env, { day: '2026-08-01', slot: 'evening' }, OWNER), /morning, afternoon or night/);
  await assert.rejects(routes.saveCount(env, { day: '2026-08-01', slot: 'morning', closing: 'lots' }, OWNER), /amount in cedis/);
  assert.deepEqual(routes.poList('p00412, P00413 p00412;P00417'), ['P00412', 'P00413', 'P00417']);
  await routes.saveExpense(env, { day: '2026-08-01', slot: 'morning', sheetTotal: '50', poNumbers: 'P1' }, OWNER);
  await assert.rejects(routes.pullOrders(env, { day: '2026-08-01', slot: 'morning' }), /Odoo is not set up/);
  await assert.rejects(routes.uploadJournal(env, { lines: ['nothing here'] }, OWNER), /ASSD detail journal/);
});

test('Odoo purchase orders are read by name, and unknown names are said out loud', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => [{ name: 'P00412', partner_id: [3, 'A Vendor'], amount_total: 525, state: 'purchase', invoice_status: 'invoiced', date_order: '2026-08-01 09:00:00' }],
    };
  };
  const out = await purchaseOrders({ config: { base: 'https://odoo.example', db: 'x' }, token: 'k', names: ['P00412', 'P00499'], fetchImpl });
  assert.equal(seen[0].path, '/json/2/purchase.order/search_read');
  assert.deepEqual(seen[0].body.domain, [['name', 'in', ['P00412', 'P00499']]]);
  assert.deepEqual(out.orders[0], { name: 'P00412', vendor: 'A Vendor', total: 52500, state: 'purchase', billed: 'invoiced', orderedOn: '2026-08-01' });
  assert.deepEqual(out.unknown, ['P00499']);
});
