import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import {
  assdMoney, assdDate, journalWindow, mergeEntry, parseJournal, segment, methodOf, labelMovements, summarise,
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
  const { exceptions, shifts: placed } = reconcile(shifts, events, []);
  const kinds = exceptions.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['corrected', 'other-shift', 'regrouped']);
  const b = placed.find((x) => x.user === 'B');
  assert.equal(b.lines.find((l) => l.seq === 6).how, 'corrected', 'the line put back is marked, so it is not counted as a payment to find');
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
    // The two 20.00 movements nothing labelled, each flagged on its own.
    'movement-unlabelled:2000',
    'movement-unlabelled:2000',
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

test('each PO on a shift says whether it is on the expense form', async () => {
  const env = await loaded();
  const orders = [{ name: 'P00901', total: 3000, state: 'purchase' }, { name: 'P00902', total: 2000, state: 'purchase' }];
  await env.DB.prepare("INSERT INTO shift_expense (day, slot, po_numbers, odoo, by_name, at) VALUES ('2026-08-01', 'morning', 'P00901 P00902', ?1, 'Test', '2026-08-01 12:00')")
    .bind(JSON.stringify({ orders })).run();
  await env.DB.prepare("INSERT INTO expense_report (response_id, po, po_typed, amount, tnt, by_name, submitted_at) VALUES ('r1', 'P00901', 'p00901', 3000, 0, 'Test', '2026-08-01 13:00')").run();
  const out = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  const [alpha] = out.days[0].shifts;
  assert.deepEqual(alpha.expense.odoo.orders.map((o) => [o.name, o.reported]), [['P00901', true], ['P00902', false]]);
});

test('POs are linked to a shift’s expenses, refused when another shift has them, and unlinked', async () => {
  const env = await loaded();
  await routes.saveExpense(env, { day: '2026-08-01', slot: 'morning', sheetTotal: '150' }, OWNER);
  // Odoo is not set up in the test: the POs are saved and Odoo is read later.
  const out = await routes.linkPos(env, { day: '2026-08-01', slot: 'morning', add: '4123, p04124 & PO4123' }, OWNER);
  assert.deepEqual(out.linked, ['P04123', 'P04124']);
  assert.match(out.warning, /Odoo/);
  let row = await env.DB.prepare("SELECT * FROM shift_expense WHERE day = '2026-08-01' AND slot = 'morning'").first();
  assert.equal(row.po_numbers, 'P04123, P04124');
  assert.equal(row.sheet_total, 15000, 'the typed total is left alone');

  await assert.rejects(routes.linkPos(env, { day: '2026-08-01', slot: 'afternoon', add: 'P04124' }, OWNER), /already linked to 2026-08-01 morning/);
  await assert.rejects(routes.linkPos(env, { day: '2026-08-01', slot: 'afternoon', add: 'N/A' }, OWNER), /Type a PO number/);

  await routes.linkPos(env, { day: '2026-08-01', slot: 'morning', remove: 'P04123' }, OWNER);
  row = await env.DB.prepare("SELECT * FROM shift_expense WHERE day = '2026-08-01' AND slot = 'morning'").first();
  assert.equal(row.po_numbers, 'P04124');
  const after = await routes.linkPos(env, { day: '2026-08-01', slot: 'morning', remove: '4124' }, OWNER);
  assert.deepEqual(after.linked, []);
  const shift = (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).days[0].shifts[0];
  assert.equal(shift.expense.poNumbers, null);
});

test('a person can correct what a movement was, match a duplicate, and pair a reversal across shifts', async () => {
  const env = await loaded();
  const read = async () => {
    const out = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER);
    const all = out.days.flatMap((d) => d.shifts);
    return { out, alpha: all.find((x) => x.user === 'ALPHA' && x.day === '2026-08-01'), bravo: all.find((x) => x.user === 'BRAVO'), charlie: all.find((x) => x.user === 'CHARLIE') };
  };

  // Relabel what the cash part was. The GH₵50 of receipts in the count
  // before it are expenses whatever is said; a hand label says what the other
  // GH₵100 was: all to the safe, then GH₵30 of it spent straight out.
  await routes.saveMovement(env, { seq: 300508, kind: 'safe', note: 'notes to the safe' }, OWNER);
  let { alpha } = await read();
  assert.deepEqual([alpha.register.expenses, alpha.register.toSafe], [5000, 10000]);
  assert.equal(alpha.moves[0].auto, 'split');
  assert.equal(alpha.moves[0].receipts, 5000);
  assert.equal(alpha.moves[0].manual.by, 'Test Owner');
  await routes.saveMovement(env, { seq: 300508, kind: 'split', expenses: '30' }, OWNER);
  ({ alpha } = await read());
  assert.deepEqual([alpha.register.expenses, alpha.register.toSafe], [8000, 7000]);

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

  // A supervisor's correction of a small movement counts straight away; a bigger one waits for an admin.
  const SUP = { id: 9, name: 'Sam Sup', access: [{ systemId: 'insight', role: 'supervisor' }] };
  await routes.saveMovement(env, { seq: 300508, kind: 'clear' }, OWNER);
  const big = await routes.saveMovement(env, { seq: 300508, kind: 'safe' }, SUP, { pending: true, smallUpTo: 10000 });
  assert.deepEqual([big.pending, big.small], [true, false], 'GH₵150 is over a GH₵100 limit');
  await routes.saveMovement(env, { seq: 300508, kind: 'clear' }, OWNER);
  const small = await routes.saveMovement(env, { seq: 300508, kind: 'safe' }, SUP, { pending: true, smallUpTo: 20000 });
  assert.deepEqual([small.pending, small.small], [false, true]);
  const row = await env.DB.prepare('SELECT status, decided_by FROM shift_movement WHERE seq = 300508').first();
  assert.deepEqual({ ...row }, { status: 'applied', decided_by: routes.SMALL_BY });
  await routes.saveMovement(env, { seq: 300508, kind: 'split', expenses: '30' }, OWNER);

  // Undo from either end of a pair.
  await routes.saveMovement(env, { seq: 300528, kind: 'clear' }, OWNER);
  ({ bravo } = await read());
  assert.equal(bravo.register.variance, 2000);
});

test('a supervisor labelling cash no count labelled counts straight away; changing a count’s label waits', async () => {
  const env = await loaded();
  const SUP = { id: 9, name: 'Sam Sup', access: [{ systemId: 'insight', role: 'supervisor' }] };
  const filled = await routes.saveMovement(env, { seq: 300526, kind: 'expenses' }, SUP, { pending: true, smallUpTo: 0 });
  assert.deepEqual([filled.pending, filled.filled], [false, true], 'ASSD 300526 had no label');
  const row = await env.DB.prepare('SELECT status, decided_by FROM shift_movement WHERE seq = 300526').first();
  assert.deepEqual({ ...row }, { status: 'applied', decided_by: routes.UNLABELLED_BY });
  const safe = await routes.saveMovement(env, { seq: 300528, kind: 'safe' }, SUP, { pending: true, smallUpTo: 0 });
  assert.equal(safe.pending, false);
  const relabel = await routes.saveMovement(env, { seq: 300508, kind: 'safe' }, SUP, { pending: true, smallUpTo: 0 });
  assert.deepEqual([relabel.pending, relabel.filled], [true, false], 'the count before ASSD 300508 labelled it; changing that is an admin’s call');
  const out = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  assert.ok(!out.exceptions.some((x) => x.kind === 'movement-unlabelled'), 'both unlabelled movements are labelled now');
});

test('expenses with no PO are flagged from the first closing report on, and linking a PO clears them', async () => {
  const env = await loaded();
  const hive = freshDb('../migrations');
  env.ATT_DB = hive.db;
  const report = (day) => hive.raw.prepare(`INSERT INTO till_report (day, slot, user_id, name, float_ok, cash, to_safe, envelopes, expenses, rentals, checks, signed_at, device)
    VALUES (?, 'night', 1, 'Test', 1, 0, 0, '[]', '[]', '{}', '[]', ?, 'pc')`).run(day, `${day} 23:00:00`);
  const flagged = async () => (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).exceptions.filter((x) => x.kind === 'expense-no-po');

  report('2026-08-02');
  assert.deepEqual(await flagged(), [], 'before the first closing report: history, not flagged');

  hive.raw.exec('DELETE FROM till_report');
  report('2026-08-01');
  const [x] = await flagged();
  assert.deepEqual([x.slot, x.amount, x.group, x.severity], ['morning', 5000, 'nopo', 'warning']);
  assert.ok(x.seqs.includes(300508));

  await routes.linkPos(env, { day: '2026-08-01', slot: 'morning', add: '4123' }, OWNER);
  assert.deepEqual(await flagged(), [], 'a linked PO takes it off');

  // Read from Odoo: the PO's total against the GH₵50 of expenses.
  const gaps = async () => (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER)).exceptions.filter((x) => x.kind === 'expense-po-gap');
  const odoo = (total) => env.DB.prepare("UPDATE shift_expense SET odoo = ?1 WHERE day = '2026-08-01' AND slot = 'morning'")
    .bind(JSON.stringify({ orders: [{ name: 'P04123', total, state: 'purchase' }], unknown: [] })).run();
  await odoo(4000);
  const [gap] = await gaps();
  assert.deepEqual([gap.amount, gap.expenses, gap.poTotal, gap.pos], [1000, 5000, 4000, ['P04123']]);
  await odoo(5000);
  assert.deepEqual(await gaps(), [], 'the PO matches the expenses');
});

test('the drawer in notes and coins: receipts that appear are expenses, carried out they are not cash, swapped they are a surplus', () => {
  let seq = 0;
  const base = { register: '001', user: 'A', payments: [], laundry: [], items: [] };
  const count = (notes, receipts = 0) => ({ ...base, seq: seq += 1, kind: 'Money Count', counted: notes * 100, expensesCounted: receipts * 100 });
  const move = (amount) => ({ ...base, seq: seq += 1, kind: 'Cash Movement', movement: -amount * 100 });
  const sale = (amount) => ({ ...base, seq: seq += 1, kind: 'Cash Register', payments: [{ method: 'cash', label: 'Cash', amount: amount * 100, date: '2026-08-01' }] });

  // The morning: GH₵70 spent (a receipt appears), notes and receipts moved
  // out together, and GH₵30 more spent at the end, left in the drawer.
  const morning = summarise({ user: 'A', startSeq: 0, entries: [
    count(800), sale(500), count(1230, 70), move(1300), count(0), sale(100), count(70, 30),
  ] });
  assert.equal(morning.expenses, 10000, 'GH₵70 and GH₵30 of new receipts');
  assert.deepEqual([morning.receiptsIn, morning.receiptsMoved, morning.receiptsSwapped], [10000, 7000, 0]);
  assert.equal(morning.safeMoved, 123000, 'the notes of the GH₵1,300 went to the safe');
  assert.equal(morning.countVariance, 0, '800 + 600 − 100 spent − 1,230 to the safe = 70');
  assert.deepEqual(morning.receiptsNew.map((x) => x.amount), [7000, 3000]);

  // The afternoon: the GH₵30 of receipts left in the drawer are taken out
  // with no movement, and cash put in for them: GH₵30 over in notes, which
  // is what reconciling them explains.
  const afternoon = summarise({ user: 'B', startSeq: 100, entries: [count(70, 30), sale(50), count(150)] });
  assert.equal(afternoon.expenses, 0, 'nothing new was spent');
  assert.deepEqual([afternoon.receiptsOut, afternoon.receiptsMoved, afternoon.receiptsSwapped], [3000, 0, 3000]);
  assert.equal(afternoon.countVariance, 3000);
  // Both sides of it: where the receipts appeared, and the count they left at.
  assert.deepEqual({ ...morning.receiptsNew[0].leg, prev: null }, { prev: null, receiptsBefore: 0, receiptsAfter: 7000, notesBefore: 80000, notesAfter: 123000 });
  assert.deepEqual({ ...afternoon.receiptsSwaps[0].leg, prev: null }, { prev: null, receiptsBefore: 3000, receiptsAfter: 0, notesBefore: 7000, notesAfter: 15000 });

  // Receipts taken out and counted before the movement is keyed: paired, not counted twice.
  const later = summarise({ user: 'C', startSeq: 200, entries: [count(100), count(60, 40), count(60), move(40), count(60)] });
  assert.deepEqual([later.expenses, later.receiptsSwapped, later.countVariance], [4000, 0, 0]);

  // A movement that seems to carry GH₵50 of receipts while the next count
  // still shows GH₵20: either GH₵20 of them stayed and the movement had GH₵20
  // of cash in it, or all went and GH₵20 of new ones came. Unanswered, they
  // are counted once (stayed) and asked about; the drawer agrees either way.
  const from = seq;
  const again = summarise({ user: 'D', startSeq: 300, entries: [count(100), count(50, 50), move(50), count(30, 20)] });
  assert.deepEqual([again.expenses, again.receiptsSwapped, again.countVariance], [5000, 0, 0]);
  assert.deepEqual(again.carriedAsk.map((a) => [a.amount, a.reading]), [[2000, null]]);
  const moveSeq = again.carriedAsk[0].seq;
  assert.deepEqual([again.moves[0].receipts, again.moves[0].cash, again.moves[0].stayed], [3000, 2000, 2000]);
  seq = from;
  const told = summarise({ user: 'D', startSeq: 300, entries: [count(100), count(50, 50), move(50), count(30, 20)] },
    new Map([[`count:${moveSeq}`, { reading: 'new', by: 'Test' }]]));
  assert.deepEqual([told.expenses, told.countVariance, told.moves[0].receipts], [7000, 0, 5000], 'new ones came: both expenses');
});

test('receipts a movement seems to carry that the counts still show: counted once, settled by its POs, or asked', async () => {
  let seq = 400;
  const base = { register: '001', user: 'E', payments: [], laundry: [], items: [] };
  const count = (notes, receipts = 0) => ({ ...base, seq: seq += 1, kind: 'Money Count', counted: notes * 100, expensesCounted: receipts * 100 });
  const move = (amount) => ({ ...base, seq: seq += 1, kind: 'Cash Movement', movement: -amount * 100 });
  // GH₵138 of receipts in the count; GH₵936 paid out for two POs; the counts
  // after still show the GH₵138 (counted twice by the person).
  const s = summarise({ user: 'E', startSeq: 400, entries: [count(2573), count(1499, 138), move(936), count(1499, 138), count(1499, 138)] },
    new Map([[403, { kind: 'expenses', by: 'Test' }]]));
  assert.equal(s.receiptsIn, 13800, 'the GH₵138 once, not twice');
  assert.deepEqual([s.moves[0].receipts, s.moves[0].direct], [0, 93600], 'the movement was all cash, labelled expenses by hand');
  assert.equal(s.expenses, 107400);
  assert.equal(s.countVariance, 0);
  // The POs on the shift add up to the movement: it was cash for them.
  assert.deepEqual(routes.readCarried(s, s.carriedAsk[0], [84000, 9600]), { reading: 'stayed', why: 'pos' });
  assert.equal(routes.readCarried(s, s.carriedAsk[0], [84000]), null, 'nothing settles it: asked');
});

test('receipts swapped for cash are reconciled on the shift, and undone', async () => {
  const env = await loaded();
  const alpha = async () => {
    const out = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
    return { s: out.days[0].shifts[0], out };
  };
  const before = (await alpha()).s.register;
  await routes.saveReceiptsSwap(env, { day: '2026-08-01', slot: 'morning', amount: '2', note: 'swapped at hand-over' }, OWNER);
  let { s, out } = await alpha();
  assert.equal(s.register.expected, before.expected + 200);
  assert.equal(s.register.variance, before.variance - 200);
  assert.equal(s.register.receipts.reconciled.by, 'Test Owner');
  assert.ok(out.exceptions.some((x) => x.kind === 'receipts-swapped' && x.amount === 200 && x.severity === 'info'));
  await routes.saveReceiptsSwap(env, { day: '2026-08-01', slot: 'morning', amount: '' }, OWNER);
  ({ s } = await alpha());
  assert.equal(s.register.expected, before.expected);
  assert.equal(s.register.receipts.reconciled, null);
});

test('receipts that went down with some still there are read by the evidence, or asked about', () => {
  let seq = 1000;
  const base = { register: '001', user: 'B', payments: [], laundry: [], items: [] };
  const count = (notes, receipts = 0) => ({ ...base, seq: seq += 1, kind: 'Money Count', counted: notes * 100, expensesCounted: receipts * 100 });
  const shift = (entries, corrections) => summarise({ user: 'B', startSeq: 1000, entries }, corrections);

  // The morning left a GH₵70 receipt. The afternoon's count shows GH₵50.
  // 1. Swapped for GH₵70 cash and GH₵50 spent: notes 930 + 70 − 50 = 950.
  const swapped = shift([count(930, 70), count(950, 50)]);
  assert.deepEqual(swapped.receiptsAsk.map((a) => [a.prev, a.now, a.left, a.reading]), [[7000, 5000, 2000, null]]);
  assert.deepEqual([swapped.expenses, swapped.receiptsSwapped, swapped.countVariance], [0, 2000, 2000], 'unanswered: only what is sure');
  assert.equal(routes.readReceipts(swapped, swapped.receiptsAsk[0], null), null, 'the drawer cannot settle this one');
  assert.deepEqual(routes.readReceipts(swapped, swapped.receiptsAsk[0], 5000), { reading: 'all', why: 'report' }, 'the closing report lists GH₵50 spent');
  const askSeq = swapped.receiptsAsk[0].seq;
  const answered = shift([count(930, 70), { ...count(950, 50), seq: askSeq }], new Map([[`count:${askSeq}`, { reading: 'all', by: 'Test' }]]));
  assert.deepEqual([answered.expenses, answered.receiptsSwapped, answered.countVariance], [5000, 7000, 7000], 'GH₵50 is new; GH₵70 over, which Reconcile clears');

  // 2. Taken out with no cash put in, and GH₵50 spent: notes 880. Only "all" makes the drawer agree.
  const takenOut = shift([count(930, 70), count(880, 50)]);
  assert.equal(takenOut.countVariance, -5000);
  assert.deepEqual(routes.readReceipts(takenOut, takenOut.receiptsAsk[0], null), { reading: 'all', why: 'drawer' });

  // 3. Only GH₵20 of the receipts handed in, nothing spent: notes unchanged. Only "some" agrees.
  const partly = shift([count(930, 70), count(930, 50)]);
  assert.deepEqual(routes.readReceipts(partly, partly.receiptsAsk[0], null), { reading: 'some', why: 'drawer' });
  assert.deepEqual(routes.readReceipts(partly, partly.receiptsAsk[0], 0), { reading: 'some', why: 'report' });

  // Not asked: all handed in and nothing left, or the receipts kept and more added.
  assert.equal(shift([count(930, 70), count(1000)]).receiptsAsk.length, 0);
  assert.equal(shift([count(930, 70), count(880, 120)]).receiptsAsk.length, 0);
});

test('a person’s reading of a count is saved, checked and taken back', async () => {
  const env = await loaded();
  await assert.rejects(routes.saveReceiptsRead(env, { seq: 300508, reading: 'all' }, OWNER), /not a Money Count/);
  await assert.rejects(routes.saveReceiptsRead(env, { seq: 300507, reading: 'maybe' }, OWNER), /all the receipts/);
  await routes.saveReceiptsRead(env, { seq: 300507, reading: 'some' }, OWNER);
  assert.equal((await env.DB.prepare('SELECT reading, by_name FROM shift_receipts_read WHERE count_seq = 300507').first()).by_name, 'Test Owner');
  await routes.saveReceiptsRead(env, { seq: 300507, reading: '' }, OWNER);
  assert.equal(await env.DB.prepare('SELECT * FROM shift_receipts_read').first(), null);
  // A movement's receipts: stayed, or new ones came.
  await assert.rejects(routes.saveReceiptsRead(env, { seq: 300507, reading: 'stayed' }, OWNER), /not a Cash Movement/);
  await routes.saveReceiptsRead(env, { seq: 300508, reading: 'stayed' }, OWNER);
  assert.equal((await env.DB.prepare('SELECT reading FROM shift_receipts_read WHERE count_seq = 300508').first()).reading, 'stayed');
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
  const shiftOf = (out) => out.days.flatMap((d) => d.shifts).find((x) => x.day === failed.day && x.slot === failed.slot);
  assert.equal(shiftOf(again).cardAnswered, shiftOf(first).cardAnswered + 1, 'the answered line counts as accounted for');
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

test('a duplicate matched away leaves an answered record that can be undone', async () => {
  const env = await loaded();
  const read = async () => (await routes.shifts(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER)).exceptions;
  const twice = (await read()).find((x) => x.kind === 'movement-twice');
  assert.ok(twice, 'the fixture has a movement keyed twice');

  await routes.saveMovement(env, { ...twice.action, note: 'Only one envelope went' }, OWNER);
  let all = await read();
  assert.equal(all.some((x) => x.kind === 'movement-twice'), false, 'the suggestion is gone');
  const record = all.find((x) => x.kind === 'movement-matched');
  assert.ok(record, 'and a record stands in its place');
  assert.deepEqual([record.key, record.seq, record.pair, record.amount, record.reason], [`matched:${twice.seq}`, twice.seq, twice.pair, twice.amount, 'duplicate']);
  assert.equal(record.answer.answer, 'Matched as a duplicate');
  assert.equal(record.answer.note, 'Only one envelope went');
  assert.equal(record.answer.by, 'Test Owner');
  assert.equal(typeof record.drawerNow, 'number', 'says where the drawer stands now');
  assert.deepEqual(record.undo, { seq: twice.seq });

  // Undo: the record goes and the suggestion is back.
  await routes.saveMovement(env, { seq: twice.seq, kind: 'clear' }, OWNER);
  all = await read();
  assert.equal(all.some((x) => x.kind === 'movement-matched'), false);
  assert.ok(all.some((x) => x.kind === 'movement-twice'));
});

test('receipts trail: a movement says whose receipts it carried, and earlier shifts say who took theirs out', () => {
  const shift = (index, day, slotName, user, open, extra) => ({
    index, day, slotName, user, opening: open == null ? null : { seq: index * 100, receipts: open },
    receiptsNew: [], receiptsSwaps: [], moves: [], ...extra,
  });
  const ordered = [
    shift(0, '2026-01-05', 'morning', 'ALPHA', 0, { receiptsNew: [{ seq: 10, amount: 12000 }] }),
    shift(1, '2026-01-05', 'afternoon', 'BRAVO', 12000, { receiptsNew: [{ seq: 110, amount: 16800 }] }),
    shift(2, '2026-01-06', 'morning', 'CHARLIE', 28800, {
      receiptsNew: [{ seq: 210, amount: 96200 }],
      moves: [{ seq: 211, receipts: 125000 }],
    }),
    shift(3, '2026-01-06', 'afternoon', 'DELTA', 0, { receiptsNew: [{ seq: 310, amount: 5000 }] }),
  ];
  const { origins, trail } = routes.receiptTrail(ordered);
  assert.deepEqual(origins.get(211), [
    { day: '2026-01-05', slot: 'morning', user: 'ALPHA', seqs: [10], amount: 12000, earlier: undefined, leg: undefined, here: false },
    { day: '2026-01-05', slot: 'afternoon', user: 'BRAVO', seqs: [110], amount: 16800, earlier: undefined, leg: undefined, here: false },
    { day: '2026-01-06', slot: 'morning', user: 'CHARLIE', seqs: [210], amount: 96200, earlier: undefined, leg: undefined, here: true },
  ]);
  // Alpha's 120 was handed over twice and taken out by Charlie.
  assert.equal(trail.get(0).left, 12000);
  assert.deepEqual(trail.get(0).cleared, [{ amount: 12000, how: 'moved', seq: 211, day: '2026-01-06', slot: 'morning', user: 'CHARLIE' }]);
  assert.equal(trail.get(0).still, 0);
  assert.equal(trail.get(1).cleared[0].amount, 16800);
  // Charlie's own were carried out on the shift: nothing handed over.
  assert.equal(trail.get(2).left, 0);
  assert.deepEqual(trail.get(2).cleared, []);
  // Delta's are still in the drawer.
  assert.equal(trail.get(3).left, 5000);
  assert.equal(trail.get(3).still, 5000);
});

test('receipts trail: swapped, gone at a hand-over, from before, and carried before they were counted', () => {
  const ordered = [
    { index: 0, day: '2026-01-05', slotName: 'morning', user: 'ALPHA', opening: { seq: 1, receipts: 3000 },
      receiptsNew: [{ seq: 5, amount: 2000 }], receiptsSwaps: [], moves: [] },
    // 1,000 fewer at Bravo's first count than Alpha left.
    { index: 1, day: '2026-01-05', slotName: 'afternoon', user: 'BRAVO', opening: { seq: 100, receipts: 4000 },
      receiptsNew: [], receiptsSwaps: [{ seq: 105, amount: 2500 }], moves: [] },
    // Charlie moves 1,500 of receipts before the count shows 1,000 new ones.
    { index: 2, day: '2026-01-06', slotName: 'morning', user: 'CHARLIE', opening: { seq: 200, receipts: 1500 },
      receiptsNew: [{ seq: 210, amount: 1000 }], receiptsSwaps: [], moves: [{ seq: 205, receipts: 2500 }] },
  ];
  const { origins, trail } = routes.receiptTrail(ordered);
  // Bravo's opening took 1,000 of the oldest (from before) off at the hand-over;
  // the swap took the other 2,000 from before and 500 of Alpha's.
  assert.deepEqual(trail.get(0).cleared, [
    { amount: 500, how: 'swapped', seq: 105, day: '2026-01-05', slot: 'afternoon', user: 'BRAVO' },
    { amount: 1500, how: 'moved', seq: 205, day: '2026-01-06', slot: 'morning', user: 'CHARLIE' },
  ]);
  assert.deepEqual(origins.get(205).map((o) => [o.user || 'earlier', o.amount, o.here]), [['ALPHA', 1500, false], ['CHARLIE', 1000, true]]);
  // Whose receipts left with no movement, at which count.
  assert.deepEqual(trail.get(1).swaps.map((w) => [w.seq, w.amount, w.origins.map((o) => [o.user || 'earlier', o.amount, o.here])]),
    [[105, 2500, [['earlier', 2000, false], ['ALPHA', 500, false]]]]);
  assert.equal(trail.get(2).left, 0);
  assert.equal(trail.get(1).left, 0);
});

test('the expense form against a month of shifts: clear POs are proposed, those paid from the safe or already used are not, and applying links them', async () => {
  const env = await loaded();
  const { ingestForm } = await import('../src/routes/advances.js');
  const fm = await import('../src/routes/formmatch.js');
  await ingestForm(env, { responses: [
    // The morning's GH₵50 of receipts, dated that day.
    { responseId: 'f1', po: 'P00950', amount: '45', tnt: '5', by: 'Test', submittedAt: '2026-08-01 16:00', expenseDate: '2026-08-01', paidFrom: 'Cash Register' },
    // The same amount, paid from the safe: not a shift's.
    { responseId: 'f2', po: 'P00951', amount: '50', by: 'Test', submittedAt: '2026-08-01 10:00', expenseDate: '2026-08-01', paidFrom: 'Big Safe' },
    // Another day.
    { responseId: 'f3', po: 'P00952', amount: '50', by: 'Test', submittedAt: '2026-08-03 10:00', expenseDate: '2026-08-03', paidFrom: 'Cash Register' },
  ] });
  const row = await env.DB.prepare("SELECT expense_day, paid_from FROM expense_report WHERE response_id = 'f2'").first();
  assert.deepEqual({ ...row }, { expense_day: '2026-08-01', paid_from: 'safe' });

  const out = await fm.formMatches(env, { month: '2026-08' }, OWNER);
  const morning = out.clear.find((c) => c.day === '2026-08-01' && c.slot === 'morning');
  assert.deepEqual(morning.pos.map((p) => p.po), ['P00950']);
  assert.equal(morning.target, 5000);
  assert.ok(!JSON.stringify(out).includes('P00951'), 'paid from the safe');
  assert.equal(out.form.safe, 1);

  const done = await fm.applyMatches(env, { items: [{ day: '2026-08-01', slot: 'morning', pos: ['P00950'] }] }, OWNER);
  assert.equal(done.done[0].ok, true);
  const linked = await env.DB.prepare("SELECT po_numbers FROM shift_expense WHERE day = '2026-08-01' AND slot = 'morning'").first();
  assert.equal(linked.po_numbers, 'P00950');
  // Linked now: not offered again.
  const again = await fm.formMatches(env, { month: '2026-08' }, OWNER);
  assert.ok(!again.clear.some((c) => c.pos.some((p) => p.po === 'P00950')));
});

test('a movement that is exactly some of the shift’s POs was cash for them; the receipts the counts lost left with no movement', () => {
  let seq = 600;
  const base = { register: '001', user: 'F', payments: [], laundry: [], items: [] };
  const count = (notes, receipts = 0) => ({ ...base, seq: seq += 1, kind: 'Money Count', counted: notes * 100, expensesCounted: receipts * 100 });
  const move = (amount) => ({ ...base, seq: seq += 1, kind: 'Cash Movement', movement: -amount * 100 });
  const sale = (amount) => ({ ...base, seq: seq += 1, kind: 'Cash Register', payments: [{ method: 'cash', label: 'Cash', amount: amount * 100, date: '2026-08-01' }] });
  // GH₵175 of an earlier shift's receipts at hand-over; GH₵427 and GH₵50
  // moved out, both labelled expenses by hand; the counts lose GH₵50 of
  // receipts around the first. Notes: 579 + 30 − 427 − 50 = 132, counted 203.
  const entries = [count(579, 175), sale(30), count(609, 175), move(427), count(182, 125), move(50), count(203, 125)];
  const big = 604; const small = 606;
  const labels = new Map([[big, { kind: 'expenses', by: 'Test' }], [small, { kind: 'expenses', by: 'Test' }]]);
  const s = summarise({ user: 'F', startSeq: 600, entries }, labels);
  // As the counts read it: GH₵50 of the old receipts went with the GH₵427.
  assert.deepEqual([s.moves.find((m) => m.seq === big).receipts, s.expenses, s.countVariance], [5000, 42700, 2100]);
  assert.deepEqual(s.moves.find((m) => m.seq === big).drops.map((d) => [d.seq, d.amount]), [[605, 5000]]);

  // The POs: GH₵30 + GH₵147 + GH₵250 is the GH₵427, GH₵50 the other.
  const pos = [{ name: 'P1', paid: 3000 }, { name: 'P2', paid: 5000 }, { name: 'P3', paid: 14700 }, { name: 'P4', paid: 25000 }];
  const changed = routes.cashForPos(s, pos);
  assert.deepEqual(changed.map((m) => [m.seq, m.byPos, m.wasReceipts]), [[big, ['P1', 'P3', 'P4'], 5000]]);
  const m = s.moves.find((x) => x.seq === big);
  assert.deepEqual([m.receipts, m.direct, m.cash], [0, 42700, 42700]);
  assert.equal(s.expenses, 47700, 'all GH₵477 the POs say');
  assert.equal(s.receiptsSwapped, 5000, 'the GH₵50 of receipts left with no movement');
  assert.deepEqual(s.receiptsSwaps.map((w) => [w.seq, w.amount]), [[605, 5000]]);
  assert.equal(s.countVariance, 7100, 'over by GH₵71: GH₵50 of it reconciled as receipts swapped for cash, GH₵21 left');

  // No POs that add up: nothing changes.
  const t = summarise({ user: 'F', startSeq: 600, entries: (seq = 600, [count(579, 175), sale(30), count(609, 175), move(427), count(182, 125), move(50), count(203, 125)]) }, labels);
  assert.deepEqual(routes.cashForPos(t, [{ name: 'P9', paid: 40000 }]), []);
  assert.equal(t.expenses, 42700);
});

test('the drawer’s own exceptions are told apart from the bank’s by their keys', async () => {
  // A supervisor with "Correct cash movements" answers the first kind; only the bank answers the second.
  const env = await loaded();
  const out = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-02' }, OWNER);
  const cash = new Set(['drawer', 'unlabelled', 'nopo', 'laundry', 'explained']);
  assert.ok(out.exceptions.some((x) => cash.has(x.group)) && out.exceptions.some((x) => !cash.has(x.group)), 'both kinds in the scenario');
  for (const x of out.exceptions) assert.equal(routes.isCashKey(x.key), cash.has(x.group), x.key);
  assert.equal(routes.isCashKey('laundry-card:12'), true);
  assert.equal(routes.isCashKey('notpair:laundry:2026-08-01:morning|drawer:2026-08-01:morning'), true);
  assert.equal(routes.isCashKey('notpair:laundry:2026-08-01:morning|bank-only:4'), false);
  assert.equal(routes.isCashKey('reversal:4'), false, 'a bank reversal, not a movement reversal');
  assert.equal(routes.isCashKey(''), false);
});
