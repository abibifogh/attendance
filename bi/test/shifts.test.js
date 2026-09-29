import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import {
  assdMoney, assdDate, journalWindow, mergeEntry, parseJournal, segment, methodOf,
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
    ...sale('ALPHA', 300500, '28.07.26', []),
    ...marker('ALPHA', 300501, '01.08.26'),
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
    ...block('End cash deficit/surplus', 'ALPHA', 300510, '01.08.26', '001', [
      '01.08.26   Deficit cash POS   0   0,00   -2,00 GHS   0', '01.08.26   Cash   -2,00 GHS', '-2,00 GHS']),
    // Back office, on another register: never a shift's money.
    ...block('Accounting', 'DELTA', 300511, '01.08.26', '015', [
      '01.08.26   CC Prepayments   -226,00 GHS', '01.08.26   Credit card EURO   226,00 GHS', '0,00 GHS'], 'GUEST NAME'),

    ...marker('BRAVO', 300520, '01.08.26'),
    ...sale('BRAVO', 300521, '01.08.26', [card('01.08.26', '1.200,00')]),
    ...sale('BRAVO', 300522, '01.08.26', [card('01.08.26', '150,00')]),
    ...sale('BRAVO', 300523, '01.08.26', [card('01.08.26', '250,00')]),
    ...sale('BRAVO', 300524, '01.08.26', [card('01.08.26', '640,00')]),

    // The night's marker carries the next morning's date, as ASSD does.
    ...marker('CHARLIE', 300530, '02.08.26'),
    ...sale('CHARLIE', 300531, '02.08.26', [card('02.08.26', '90,00')]),
    ...sale('CHARLIE', 300532, '02.08.26', [card('02.08.26', '45,00')]),

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
  assert.equal(alpha.expensesCounted, 5000);
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
    'failed:88300',
    'keying:27600',
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

test('hand-over counts carry from one shift to the next', async () => {
  const env = await loaded();
  await routes.saveCount(env, { day: '2026-08-01', slot: 'morning', opening: '100', closing: '318' }, OWNER);
  await routes.saveCount(env, { day: '2026-08-01', slot: 'afternoon', closing: '300' }, OWNER);
  const out = await routes.shifts(env, { from: '2026-08-01', to: '2026-08-01' }, OWNER);
  const [alpha, bravo] = out.days[0].shifts;
  // 100 + 370 cash − 150 out = 320 expected; counted 318.
  assert.equal(alpha.register.expected, 32000);
  assert.equal(alpha.register.variance, -200);
  assert.equal(alpha.register.expenses, 5000, 'the receipts ASSD counted, until the sheet is typed');
  assert.equal(bravo.register.opening, 31800);
  assert.equal(bravo.register.openingFrom, '2026-08-01|morning');
  assert.equal(bravo.register.variance, -1800);
  const person = out.people.find((p) => p.user === 'ALPHA');
  assert.equal(person.variance, -200);
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
