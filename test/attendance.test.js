import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  absMinutes, claimPunch, collapsePunches, colourFor, computeDay, computeRange, dayCredit,
  easterSunday, firstFriday, ghanaHolidays, hours, humanDuration, isOpen, labelFor,
  leaveBalance, leaveDaysIn, leaveYearOf, makeDataset, monthsBetween, noteFor,
  dayLedger, overUnder, pairPunches, rotationWeekOf, scheduleFor, shiftWindow, streakOf, summarise, toClock,
  toMinutes, withObservedDays,
} from '../src/lib/attendance.js';
import {
  directionOf, localStamp, normaliseEvent, utcStamp,
} from '../src/lib/attendance-ingest.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// One morning shift, one night shift, and two people: a cook on mornings and a
// porter on nights. Enough to exercise every branch that matters, and small
// enough that a failing assertion points at one thing.
// ---------------------------------------------------------------------------

const MORNING = {
  id: 1,
  name: 'Morning',
  starts_at: '06:00',
  ends_at: '14:00',
  break_minutes: 30,
  grace_in_minutes: 5,
  grace_out_minutes: 5,
  half_day_minutes: 240,
  full_day_minutes: 420,
  overtime_after: 0,
};

const NIGHT = {
  ...MORNING, id: 2, name: 'Night', starts_at: '22:00', ends_at: '06:00',
};

const STAFF = [
  { id: 1, employee_no: '1001', name: 'Henry Aryee', active: 1, hired_on: '2023-02-01', leave_days: null },
  { id: 2, employee_no: '1002', name: 'Vivian Mensah', active: 1, hired_on: '2024-06-15', leave_days: null },
];

const REASONS = [
  { code: 'present', label: 'Present', kind: 'worked', paid: 1, counts_as_worked: 1, deducts_leave: 0, colour: 'green' },
  { code: 'late', label: 'Late', kind: 'worked', paid: 1, counts_as_worked: 1, deducts_leave: 0, colour: 'amber' },
  { code: 'early_leave', label: 'Left early', kind: 'worked', paid: 1, counts_as_worked: 1, deducts_leave: 0, colour: 'amber' },
  { code: 'late_early', label: 'Late and left early', kind: 'worked', paid: 1, counts_as_worked: 1, deducts_leave: 0, colour: 'amber' },
  { code: 'incomplete', label: 'Incomplete — to check', kind: 'incomplete', paid: 0, counts_as_worked: 0, deducts_leave: 0, colour: 'amber' },
  { code: 'absent', label: 'Absent', kind: 'absent', paid: 0, counts_as_worked: 0, deducts_leave: 0, colour: 'red' },
  { code: 'rest_day', label: 'Rest day', kind: 'rest', paid: 0, counts_as_worked: 0, deducts_leave: 0, colour: 'grey' },
  { code: 'public_holiday', label: 'Public holiday', kind: 'holiday', paid: 1, counts_as_worked: 0, deducts_leave: 0, colour: 'grey' },
  { code: 'annual_leave', label: 'Annual leave', kind: 'leave', paid: 1, counts_as_worked: 0, deducts_leave: 1, colour: 'grey' },
  { code: 'sick_leave', label: 'Sick leave', kind: 'leave', paid: 1, counts_as_worked: 0, deducts_leave: 0, colour: 'grey' },
  { code: 'training', label: 'Training', kind: 'worked', paid: 1, counts_as_worked: 1, deducts_leave: 0, colour: 'green' },
];

let punchId = 1;

/** A punch as it comes out of the database, before the dataset indexes it. */
const punch = (staffId, day, time, direction = null) => ({
  id: punchId++,
  device_serial: 'DS-TEST',
  employee_no: String(1000 + staffId),
  staff_id: staffId,
  at_local: `${day} ${time}:00`,
  at_utc: `${day} ${time}:00`,
  day,
  direction,
  device_status: direction ? (direction === 'in' ? 'checkIn' : 'checkOut') : 'undefined',
  source: 'poller',
});

function dataset(overrides = {}) {
  return makeDataset({
    staff: STAFF,
    shifts: [MORNING, NIGHT],
    reasons: REASONS,
    settings: [
      { key: 'timezone', value: 'Africa/Accra' },
      { key: 'att_missing_punch', value: 'incomplete' },
      { key: 'att_leave_days', value: '15' },
      ...(overrides.settings ?? []),
    ],
    patterns: overrides.patterns ?? [],
    roster: overrides.roster ?? [],
    punches: overrides.punches ?? [],
    days: overrides.days ?? [],
    holidays: overrides.holidays ?? [],
    leave: overrides.leave ?? [],
  });
}

/** Punches pre-indexed the way computeDay expects them. */
function scheduled(day, times, shift = MORNING) {
  const ds = dataset({ punches: times.map(([time, dir]) => punch(1, day, time, dir)) });
  return {
    staff: STAFF[0],
    day,
    schedule: { shift, source: 'roster', explicit: true },
    punches: ds.punchesByStaff.get(1) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

test('clock times convert both ways', () => {
  assert.equal(toMinutes('06:00'), 360);
  assert.equal(toMinutes('06:30:45'), 390);
  assert.equal(toMinutes('nonsense'), null);
  assert.equal(toClock(360), '06:00');
  // Past midnight wraps rather than showing 25:00.
  assert.equal(toClock(1500), '01:00');
});

test('durations read the way a person would say them', () => {
  assert.equal(humanDuration(5), '5 min');
  assert.equal(humanDuration(60), '1 hr');
  assert.equal(humanDuration(65), '1 hr 5 min');
  assert.equal(humanDuration(120), '2 hrs');
  assert.equal(hours(90), 1.5);
});

test('an overnight shift belongs to the day it starts', () => {
  const window = shiftWindow(NIGHT, '2026-06-16');
  assert.equal(window.overnight, true);
  // 22:00 to 06:00 is eight hours, less the half-hour break.
  assert.equal(window.expected, 450);
  assert.equal(window.end - window.start, 480);

  const morning = shiftWindow(MORNING, '2026-06-16');
  assert.equal(morning.overnight, false);
  assert.equal(morning.expected, 450);
});

// ---------------------------------------------------------------------------
// Punches
// ---------------------------------------------------------------------------

test('a double tap is one punch', () => {
  const ds = dataset({
    punches: [
      punch(1, '2026-06-16', '06:01'),
      punch(1, '2026-06-16', '06:02'),
      punch(1, '2026-06-16', '14:05'),
    ],
  });
  const kept = collapsePunches(ds.punchesByStaff.get(1), 2);
  assert.equal(kept.length, 2);
  assert.equal(toClock(kept[0].abs), '06:01');
  assert.equal(toClock(kept[1].abs), '14:05');
});

test('a labelled duplicate beats an unlabelled one', () => {
  const ds = dataset({
    punches: [punch(1, '2026-06-16', '06:01'), punch(1, '2026-06-16', '06:02', 'in')],
  });
  const kept = collapsePunches(ds.punchesByStaff.get(1), 2);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].direction, 'in');
});

test('the device label is believed when it exists', () => {
  const ds = dataset({
    punches: [
      punch(1, '2026-06-16', '06:00', 'in'),
      punch(1, '2026-06-16', '10:00', 'out'),
      punch(1, '2026-06-16', '14:00', 'out'),
    ],
  });
  const pair = pairPunches(ds.punchesByStaff.get(1), shiftWindow(MORNING, '2026-06-16'));
  assert.equal(toClock(pair.in.abs), '06:00');
  // The last labelled clock-out wins, not the first.
  assert.equal(toClock(pair.out.abs), '14:00');
});

test('a single unlabelled punch is judged by which end of the shift it is near', () => {
  const window = shiftWindow(MORNING, '2026-06-16');

  const early = dataset({ punches: [punch(1, '2026-06-16', '06:02')] });
  const arrival = pairPunches(early.punchesByStaff.get(1), window);
  assert.ok(arrival.in && !arrival.out, 'a punch at 06:02 on a 06:00 shift is an arrival');
  assert.equal(arrival.ambiguous, true);

  const late = dataset({ punches: [punch(1, '2026-06-16', '13:58')] });
  const departure = pairPunches(late.punchesByStaff.get(1), window);
  assert.ok(departure.out && !departure.in, 'a punch at 13:58 on a shift ending 14:00 is a departure');
});

test('an overlapping window goes to the nearer shift', () => {
  const night = shiftWindow(NIGHT, '2026-06-15');
  const morning = shiftWindow(MORNING, '2026-06-16');
  const windows = [
    { ...night, day: '2026-06-15', from: night.start - 180, to: night.end + 240 },
    { ...morning, day: '2026-06-16', from: morning.start - 180, to: morning.end + 240 },
  ];

  const ds = dataset({ punches: [punch(2, '2026-06-16', '06:05')] });
  const [tap] = ds.punchesByStaff.get(2);
  // 06:05 is five minutes after the night shift ends and five minutes after the
  // morning starts — but it is the night porter's clock-out.
  assert.equal(claimPunch(tap, windows).day, '2026-06-15');
});

// ---------------------------------------------------------------------------
// The status machine — the table from the daily reports
// ---------------------------------------------------------------------------

test('present: in and out, both inside grace', () => {
  const record = computeDay(scheduled('2026-06-16', [['06:03'], ['14:02']]));
  assert.equal(record.status, 'present');
  assert.equal(record.reason_code, 'present');
  assert.equal(record.first_in, '06:03');
  assert.equal(record.last_out, '14:02');
  // Eight hours less the half-hour break, plus the two minutes over.
  assert.equal(record.worked_minutes, 449);
  assert.equal(colourFor(record, new Map(REASONS.map((r) => [r.code, r]))), 'green');
});

test('late: clocked in after the shift started', () => {
  const record = computeDay(scheduled('2026-06-16', [['06:25'], ['14:00']]));
  assert.equal(record.status, 'late');
  assert.equal(record.late_minutes, 25);
  assert.equal(labelFor(record), 'Late');
});

test('early leave: clocked out before the shift ended', () => {
  const record = computeDay(scheduled('2026-06-16', [['06:00'], ['13:30']]));
  assert.equal(record.status, 'early_leave');
  assert.equal(record.early_minutes, 30);
});

test('a minute early is the clock, not the person', () => {
  const record = computeDay(scheduled('2026-06-16', [['06:00'], ['13:59']]));
  // Inside grace, so it is not flagged at all — but the minute is still counted.
  assert.equal(record.status, 'present');
  assert.equal(record.early_minutes, 1);
});

test('late and early on the same day is one status, not two', () => {
  const record = computeDay(scheduled('2026-06-16', [['06:40'], ['13:20']]));
  assert.equal(record.status, 'late_early');
  assert.equal(record.late_minutes, 40);
  assert.equal(record.early_minutes, 40);
  assert.equal(labelFor(record), 'Late and left early');
});

test('absent: nothing at all on a scheduled day', () => {
  const record = computeDay(scheduled('2026-06-16', []));
  assert.equal(record.status, 'absent');
  assert.equal(record.reason_code, 'absent');
  assert.equal(record.worked_minutes, 0);
  assert.equal(record.punches, 0);
});

test('clocked in, never out: held open for a supervisor by default', () => {
  const record = computeDay(scheduled('2026-06-16', [['06:00', 'in']]));
  assert.equal(record.status, 'missing_out');
  assert.equal(record.reason_code, 'incomplete');
  assert.equal(record.resolution, 'open');
  assert.equal(record.worked_minutes, 0, 'no hours are credited until somebody decides');
  assert.equal(isOpen(record), true);
});

test('clocked out, never in: the mirror case', () => {
  const record = computeDay(scheduled('2026-06-16', [['14:00', 'out']]));
  assert.equal(record.status, 'missing_in');
  assert.equal(record.resolution, 'open');
  assert.equal(isOpen(record), true);
});

test("the terminal's own rule can be reinstated", () => {
  const record = computeDay({
    ...scheduled('2026-06-16', [['06:00', 'in']]),
    policy: { missingPunch: 'absent' },
  });
  assert.equal(record.status, 'missing_out');
  assert.equal(record.reason_code, 'absent');
  assert.equal(record.resolution, 'settled');
  assert.equal(labelFor(record), 'Absent (no clock-out)');
});

test('late in and no clock-out is flagged as both', () => {
  const record = computeDay({
    ...scheduled('2026-06-16', [['06:45', 'in']]),
    policy: { missingPunch: 'absent' },
  });
  assert.equal(record.late_minutes, 45);
  assert.equal(labelFor(record), 'Absent (late in, no clock-out)');
});

test('auto-close credits the shift end and never more', () => {
  const record = computeDay({
    ...scheduled('2026-06-16', [['06:00', 'in']]),
    policy: { missingPunch: 'auto_close' },
  });
  assert.equal(record.resolution, 'auto');
  assert.equal(record.last_out, '14:00');
  assert.equal(record.worked_minutes, 450);
  assert.equal(record.overtime_minutes, 0, 'a missing punch is not evidence of overtime');
});

test('approved leave outranks the punches', () => {
  const record = computeDay({
    ...scheduled('2026-06-16', []),
    leave: { id: 7, reason_code: 'annual_leave' },
  });
  assert.equal(record.status, 'leave');
  assert.equal(record.reason_code, 'annual_leave');
  assert.equal(record.leave_id, 7);
  assert.equal(record.expected_minutes, 450, 'a day on leave is still worth its shift');
});

test("a supervisor's ruling outranks everything", () => {
  const record = computeDay({
    ...scheduled('2026-06-16', []),
    override: { reason_code: 'sick_leave', reasonKind: 'leave' },
  });
  assert.equal(record.status, 'leave');
  assert.equal(record.reason_code, 'sick_leave');
  assert.equal(record.resolution, 'resolved');
});

test('a rest day is not an absence', () => {
  const record = computeDay({
    staff: STAFF[0], day: '2026-06-21', schedule: { shift: null, explicit: true }, punches: [],
  });
  assert.equal(record.status, 'rest');
  assert.equal(record.reason_code, 'rest_day');
});

test('working an unrostered day is recorded, not discarded', () => {
  const ds = dataset({
    punches: [punch(1, '2026-06-21', '08:00'), punch(1, '2026-06-21', '12:00')],
  });
  const record = computeDay({
    staff: STAFF[0],
    day: '2026-06-21',
    schedule: { shift: null, explicit: false },
    punches: ds.punchesByStaff.get(1),
  });
  assert.equal(record.status, 'unscheduled');
  assert.equal(record.worked_minutes, 240);
  assert.equal(record.overtime_minutes, 240);
});

test('a public holiday nobody worked is a holiday', () => {
  const record = computeDay({
    ...scheduled('2026-03-06', []),
    holiday: { day: '2026-03-06', name: 'Independence Day' },
  });
  assert.equal(record.status, 'holiday');
  assert.equal(record.reason_code, 'public_holiday');
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

test('the note says what happened and what to do', () => {
  const late = computeDay(scheduled('2026-06-16', [['06:25'], ['14:00']]));
  const text = noteFor(late, { shift: MORNING });
  assert.match(text, /06:25/);
  assert.match(text, /25 min/);
  assert.match(text, /06:00/);
});

test('a missing clock-out explains why it matters', () => {
  const record = computeDay(scheduled('2026-06-16', [['06:00', 'in']]));
  const text = noteFor(record, { shift: MORNING });
  assert.match(text, /no clock-out/i);
  assert.match(text, /supervisor/i);
});

test('the third day in a row changes the tone', () => {
  const first = noteFor(computeDay(scheduled('2026-06-16', [['06:30'], ['14:00']])), {
    shift: MORNING, streak: 1,
  });
  const third = noteFor(computeDay(scheduled('2026-06-18', [['06:30'], ['14:00']])), {
    shift: MORNING, streak: 3,
  });
  assert.doesNotMatch(first, /in a row/);
  assert.match(third, /third day in a row/);
});

test('a run of absences is counted across a rest day', () => {
  const days = [
    { day: '2026-06-19', status: 'absent', reason_code: 'absent' },
    { day: '2026-06-20', status: 'rest', reason_code: 'rest_day' },
    { day: '2026-06-21', status: 'rest', reason_code: 'rest_day' },
    { day: '2026-06-22', status: 'absent', reason_code: 'absent' },
  ];
  const isAbsent = (r) => r.status === 'absent';
  // Friday and Monday, with the weekend off in between, is twice running.
  assert.equal(streakOf(days, 3, isAbsent), 2);
});

// ---------------------------------------------------------------------------
// Adding days up
// ---------------------------------------------------------------------------

test('a short day is half a day', () => {
  assert.equal(dayCredit({ worked_minutes: 450 }, { shift: MORNING }), 1);
  assert.equal(dayCredit({ worked_minutes: 300 }, { shift: MORNING }), 0.5);
  assert.equal(dayCredit({ worked_minutes: 60 }, { shift: MORNING }), 0);
});

test('a day charged to training counts as worked without any punches', () => {
  const reason = REASONS.find((r) => r.code === 'training');
  assert.equal(dayCredit({ worked_minutes: 0, status: 'absent' }, { shift: MORNING, reason }), 1);
});

test('a period adds up the way the days do', () => {
  const reasons = new Map(REASONS.map((r) => [r.code, r]));
  const shifts = new Map([[1, MORNING]]);
  const records = [
    { day: '2026-06-15', shift_id: 1, scheduled: 1, status: 'present', reason_code: 'present', worked_minutes: 450, expected_minutes: 450, late_minutes: 0, early_minutes: 0, overtime_minutes: 0, resolution: 'settled' },
    { day: '2026-06-16', shift_id: 1, scheduled: 1, status: 'late', reason_code: 'late', worked_minutes: 430, expected_minutes: 450, late_minutes: 25, early_minutes: 0, overtime_minutes: 0, resolution: 'settled' },
    { day: '2026-06-17', shift_id: 1, scheduled: 1, status: 'absent', reason_code: 'absent', worked_minutes: 0, expected_minutes: 450, late_minutes: 0, early_minutes: 0, overtime_minutes: 0, resolution: 'settled' },
    { day: '2026-06-18', shift_id: 1, scheduled: 1, status: 'leave', reason_code: 'annual_leave', worked_minutes: 0, expected_minutes: 450, late_minutes: 0, early_minutes: 0, overtime_minutes: 0, resolution: 'settled' },
    { day: '2026-06-19', shift_id: 1, scheduled: 1, status: 'missing_out', reason_code: 'incomplete', worked_minutes: 0, expected_minutes: 450, late_minutes: 0, early_minutes: 0, overtime_minutes: 0, resolution: 'open' },
  ];

  const totals = summarise(records, { shifts, reasons });
  assert.equal(totals.daysWorked, 2);
  assert.equal(totals.daysAbsent, 1);
  assert.equal(totals.daysLeave, 1);
  assert.equal(totals.leaveDeducted, 1);
  assert.equal(totals.lateCount, 1);
  assert.equal(totals.lateMinutes, 25);
  assert.equal(totals.openCount, 1);
  assert.equal(totals.workedMinutes, 880);
  assert.equal(totals.attendanceRate, 80);
});

// ---------------------------------------------------------------------------
// A whole range, punches to days
// ---------------------------------------------------------------------------

test('a week of mornings computes end to end', () => {
  const ds = dataset({
    patterns: [0, 1, 2, 3, 4].map((d) => ({ staff_id: 1, dow: d, shift_id: 1 })),
    punches: [
      // Monday: on time.
      punch(1, '2026-06-15', '05:58'), punch(1, '2026-06-15', '14:03'),
      // Tuesday: late.
      punch(1, '2026-06-16', '06:35'), punch(1, '2026-06-16', '14:00'),
      // Wednesday: forgot to clock out.
      punch(1, '2026-06-17', '06:00'),
      // Thursday: nothing.
      // Friday: left early.
      punch(1, '2026-06-19', '06:00'), punch(1, '2026-06-19', '12:00'),
    ],
  });

  const week = computeRange(ds, 1, '2026-06-15', '2026-06-21');
  assert.equal(week.length, 7);
  assert.deepEqual(week.map((d) => d.status), [
    'present', 'late', 'missing_out', 'absent', 'early_leave', 'rest', 'rest',
  ]);
  assert.equal(week[1].late_minutes, 35);
  assert.equal(week[2].resolution, 'open');
  assert.equal(week[4].early_minutes, 120);
  // Every day carries the line its report will print.
  assert.ok(week.every((d) => typeof d.note === 'string' && d.note.length));
});

test('a night shift keeps its clock-out from the far side of midnight', () => {
  const ds = dataset({
    roster: [
      { staff_id: 2, day: '2026-06-15', shift_id: 2 },
      { staff_id: 2, day: '2026-06-16', shift_id: 2 },
    ],
    punches: [
      punch(2, '2026-06-15', '21:55'),
      punch(2, '2026-06-16', '06:04'),
      punch(2, '2026-06-16', '21:58'),
      punch(2, '2026-06-17', '06:00'),
    ],
  });

  const days = computeRange(ds, 2, '2026-06-15', '2026-06-16');
  assert.equal(days[0].status, 'present');
  assert.equal(days[0].first_in, '21:55');
  assert.equal(days[0].last_out, '06:04', 'the clock-out is on the next calendar day');
  assert.equal(days[0].worked_minutes, 459);
  assert.equal(days[1].status, 'present');
  assert.equal(days[1].first_in, '21:58');
});

test('a resolved day survives a later recomputation', () => {
  const ds = dataset({
    patterns: [{ staff_id: 1, dow: 0, shift_id: 1 }],
    punches: [punch(1, '2026-06-15', '06:00')],
    days: [{
      staff_id: 1,
      day: '2026-06-15',
      status: 'leave',
      reason_code: 'sick_leave',
      resolution: 'resolved',
      resolved_by: 'Ama (manager)',
      resolved_note: 'Rang in unwell at 10.',
    }],
  });

  const [day] = computeRange(ds, 1, '2026-06-15', '2026-06-15');
  assert.equal(day.status, 'leave');
  assert.equal(day.reason_code, 'sick_leave');
  assert.equal(day.resolved_by, 'Ama (manager)');
});

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

test('the leave year can start anywhere', () => {
  assert.deepEqual(leaveYearOf('2026-06-16', '01-01'), {
    start: '2026-01-01', end: '2026-12-31', label: '2026',
  });
  // An April-to-March year: June is in the year that began that April.
  assert.deepEqual(leaveYearOf('2026-06-16', '04-01'), {
    start: '2026-04-01', end: '2027-03-31', label: '2026',
  });
  assert.deepEqual(leaveYearOf('2026-02-16', '04-01'), {
    start: '2025-04-01', end: '2026-03-31', label: '2025',
  });
});

test('service is counted in whole months', () => {
  assert.equal(monthsBetween('2025-01-15', '2026-01-14'), 11);
  assert.equal(monthsBetween('2025-01-15', '2026-01-15'), 12);
  assert.equal(monthsBetween('2026-01-15', '2025-01-15'), 0);
});

test('the Labour Act default is fifteen days after a year', () => {
  const reasons = new Map(REASONS.map((r) => [r.code, r]));
  const balance = leaveBalance({
    staff: STAFF[0],
    settings: { att_leave_days: '15', att_leave_qualify_months: '12' },
    asOf: '2026-06-16',
    reasons,
    records: [
      { day: '2026-03-02', reason_code: 'annual_leave' },
      { day: '2026-03-03', reason_code: 'annual_leave' },
      { day: '2026-04-10', reason_code: 'sick_leave' },
    ],
    requests: [],
  });

  assert.equal(balance.entitlement, 15);
  assert.equal(balance.qualified, true);
  assert.equal(balance.taken, 2, 'sick leave does not come off the annual allowance');
  assert.equal(balance.remaining, 13);
});

test('a mid-year joiner is shown a pro-rata figure, not a zero', () => {
  const reasons = new Map(REASONS.map((r) => [r.code, r]));
  const balance = leaveBalance({
    staff: { ...STAFF[1], hired_on: '2026-07-01' },
    settings: { att_leave_days: '15', att_leave_qualify_months: '12' },
    asOf: '2026-08-16',
    reasons,
    records: [],
    requests: [],
  });

  assert.equal(balance.qualified, false);
  assert.equal(balance.proRated, true);
  // Six months of a fifteen-day year, to the nearest half day.
  assert.equal(balance.entitlement, 7.5);
});

test('approved future leave is committed, not yet spent', () => {
  const reasons = new Map(REASONS.map((r) => [r.code, r]));
  const balance = leaveBalance({
    staff: STAFF[0],
    settings: { att_leave_days: '15' },
    asOf: '2026-06-16',
    reasons,
    records: [],
    requests: [
      { reason_code: 'annual_leave', from_day: '2026-09-01', to_day: '2026-09-05', days: 5, status: 'approved' },
      { reason_code: 'annual_leave', from_day: '2026-11-01', to_day: '2026-11-03', days: 3, status: 'pending' },
    ],
  });

  assert.equal(balance.booked, 5);
  assert.equal(balance.pending, 3);
  assert.equal(balance.remaining, 10, 'pending days are shown but not deducted');
});

test('leave is charged against the rota, not the calendar', () => {
  const ds = dataset({
    patterns: [0, 1, 2, 3, 4].map((d) => ({ staff_id: 1, dow: d, shift_id: 1 })),
    holidays: [{ day: '2026-06-17', name: 'Test holiday', observed_on: null, active: 1 }],
  });

  // Monday to Sunday: five rostered days, less the Wednesday holiday.
  assert.equal(leaveDaysIn({ from: '2026-06-15', to: '2026-06-21', staffId: 1, ds }), 4);
  assert.equal(leaveDaysIn({ from: '2026-06-15', to: '2026-06-16', staffId: 1, ds, halfDay: 'end' }), 1.5);
});

// ---------------------------------------------------------------------------
// Public holidays
// ---------------------------------------------------------------------------

test('Easter is calculated, not typed in', () => {
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2027), '2027-03-28');
  assert.equal(easterSunday(2024), '2024-03-31');
});

test("Farmers' Day is the first Friday in December", () => {
  assert.equal(firstFriday(2026, 12), '2026-12-04');
  assert.equal(firstFriday(2027, 12), '2027-12-03');
});

test("Ghana's calculable holidays come out whole", () => {
  const list = ghanaHolidays(2026);
  const byName = new Map(list.map((h) => [h.name, h]));

  assert.equal(byName.get('Good Friday').day, '2026-04-03');
  assert.equal(byName.get('Easter Monday').day, '2026-04-06');
  assert.equal(byName.get('Independence Day').day, '2026-03-06');
  assert.equal(byName.get("Founders' Day").day, '2026-08-04');
  // The two Eids follow the moon and are left to be entered when announced.
  assert.equal(list.length, 11);
});

test('a weekend holiday is observed on the next free weekday', () => {
  // 2027: Christmas falls on the Saturday, Boxing Day on the Sunday.
  const list = withObservedDays([
    { day: '2027-12-25', name: 'Christmas Day' },
    { day: '2027-12-26', name: 'Boxing Day' },
  ]);
  assert.equal(list[0].observed_on, '2027-12-27');
  assert.equal(list[1].observed_on, '2027-12-28', 'the two cannot share a Monday');
});

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

test('the device attendance status becomes a direction', () => {
  assert.equal(directionOf('checkIn'), 'in');
  assert.equal(directionOf('checkOut'), 'out');
  assert.equal(directionOf('breakOff'), 'out');
  assert.equal(directionOf('overtimeIn'), 'in');
  assert.equal(directionOf('undefined'), null);
  assert.equal(directionOf(null), null);
});

test('an ISAPI event becomes a punch', () => {
  const row = normaliseEvent({
    major: 5,
    minor: 75,
    time: '2026-06-16T06:03:12+00:00',
    employeeNoString: '1001',
    name: 'Henry Aryee',
    attendanceStatus: 'checkIn',
    serialNo: 4821,
    doorNo: 1,
    currentVerifyMode: 'cardOrFaceOrFp',
  }, { deviceSerial: 'DS-TEST', timezone: 'UTC' });

  assert.equal(row.employee_no, '1001');
  assert.equal(row.at_utc, '2026-06-16 06:03:12');
  assert.equal(row.day, '2026-06-16');
  assert.equal(row.direction, 'in');
  assert.equal(row.dedupe_key, 's:4821');
  assert.equal(row.source, 'poller');
});

test('an event with no serial still dedupes', () => {
  const event = {
    time: '2026-06-16T06:03:12+00:00', employeeNoString: '1001', minor: 75, doorNo: 1,
  };
  const first = normaliseEvent(event, { deviceSerial: 'DS-TEST', timezone: 'UTC' });
  const again = normaliseEvent({ ...event }, { deviceSerial: 'DS-TEST', timezone: 'UTC' });
  assert.equal(first.dedupe_key, again.dedupe_key);
  assert.match(first.dedupe_key, /^t:1001:/);
});

test('an event with no employee number is not a punch', () => {
  assert.equal(normaliseEvent({ time: '2026-06-16T06:03:12Z' }, { deviceSerial: 'X' }), null);
  assert.equal(normaliseEvent({ employeeNoString: '1001' }, { deviceSerial: 'X' }), null);
  assert.equal(normaliseEvent({ employeeNoString: '1001', time: 'not a time' }, { deviceSerial: 'X' }), null);
});

test('the device offset is respected and the local day derived from it', () => {
  // 23:30 UTC on the 15th is 23:30 on the 15th in Accra, which is UTC+0.
  const accra = normaliseEvent(
    { time: '2026-06-15T23:30:00+00:00', employeeNoString: '1001' },
    { deviceSerial: 'X', timezone: 'Africa/Accra' },
  );
  assert.equal(accra.day, '2026-06-15');

  // The same instant in Lagos is half past midnight on the 16th.
  const lagos = normaliseEvent(
    { time: '2026-06-15T23:30:00+00:00', employeeNoString: '1001' },
    { deviceSerial: 'X', timezone: 'Africa/Lagos' },
  );
  assert.equal(lagos.day, '2026-06-16');
  assert.equal(lagos.at_utc, '2026-06-15 23:30:00', 'UTC is stored regardless');
});

test('stamps are formatted the way the database expects', () => {
  const when = new Date('2026-06-16T06:03:12Z');
  assert.equal(utcStamp(when), '2026-06-16 06:03:12');
  assert.equal(localStamp(when, 'UTC'), '2026-06-16 06:03:12');
});

test('a supervisor-supplied clock-out is what the day is worth', () => {
  const ds = dataset({
    patterns: [{ staff_id: 1, dow: 0, shift_id: 1 }],
    punches: [punch(1, '2026-06-15', '06:00')],
    days: [{
      staff_id: 1,
      day: '2026-06-15',
      status: 'present',
      reason_code: 'present',
      resolution: 'resolved',
      resolved_by: 'Ama (manager)',
      corrected_out: '14:00',
    }],
  });

  const [day] = computeRange(ds, 1, '2026-06-15', '2026-06-15');
  assert.equal(day.resolution, 'resolved');
  assert.equal(day.last_out, '14:00');
  assert.equal(day.worked_minutes, 450);
  assert.equal(day.corrected_out, '14:00');
  // What the terminal actually saw is still on the record.
  assert.equal(day.punches, 1);
  assert.equal(day.first_in, '06:00');
});

test('a night shift correction across midnight is not a negative day', () => {
  const ds = dataset({
    roster: [{ staff_id: 2, day: '2026-06-15', shift_id: 2 }],
    punches: [punch(2, '2026-06-15', '22:00')],
    days: [{
      staff_id: 2,
      day: '2026-06-15',
      status: 'present',
      reason_code: 'present',
      resolution: 'resolved',
      corrected_out: '06:00',
    }],
  });

  const [day] = computeRange(ds, 2, '2026-06-15', '2026-06-15');
  assert.equal(day.worked_minutes, 450);
  assert.equal(day.last_out, '06:00');
});

// ---------------------------------------------------------------------------
// Rotating shifts
// ---------------------------------------------------------------------------

/**
 * A hotel does not run on a fixed week. A porter is on mornings this week,
 * afternoons next, nights the week after, and the day off travels with the
 * cycle. The one-week pattern this app started with forced that person's rota
 * to be typed out by hand every week forever — which is the job it exists to
 * remove.
 */

test('somebody who does not rotate is always in week zero', () => {
  assert.equal(rotationWeekOf('2026-08-16', 1), 0);
  assert.equal(rotationWeekOf('2027-02-01', 1), 0);
  assert.equal(rotationWeekOf('2026-08-16'), 0, 'and one week is the default');
});

test('a three-week cycle advances one step per week and comes back round', () => {
  // Mondays, from the anchor.
  const weeks = ['2024-01-01', '2024-01-08', '2024-01-15', '2024-01-22', '2024-01-29'];
  assert.deepEqual(weeks.map((d) => rotationWeekOf(d, 3)), [0, 1, 2, 0, 1]);
});

test('every day of a week is in the same week of the cycle', () => {
  // Monday 5 January 2026 through the Sunday after it.
  const week = ['2026-01-05', '2026-01-06', '2026-01-08', '2026-01-10', '2026-01-11'];
  const answers = week.map((d) => rotationWeekOf(d, 3));
  assert.equal(new Set(answers).size, 1, 'a cycle turns on Mondays, not mid-week');
});

test('a date before the anchor still lands on a real week', () => {
  // Negative remainders would put somebody in week -1, which is no week at all.
  for (const day of ['2023-12-25', '2020-06-01', '1999-01-01']) {
    const week = rotationWeekOf(day, 3);
    assert.ok(week >= 0 && week < 3, `${day} gave ${week}`);
  }
});

test('the cycle does not shift when the rota is looked at again', () => {
  // The whole point of counting from a fixed Monday: the same date must give
  // the same answer today, next month, and after somebody is added.
  assert.equal(rotationWeekOf('2026-08-16', 4), rotationWeekOf('2026-08-16', 4));
  assert.equal(rotationWeekOf('2026-08-16', 4, '2024-01-01'), rotationWeekOf('2026-08-16', 4));
});

test('moving the anchor moves everybody together', () => {
  const before = rotationWeekOf('2026-08-17', 3, '2024-01-01');
  const after = rotationWeekOf('2026-08-17', 3, '2024-01-08');
  assert.notEqual(before, after, 'the anchor is the lever for a cycle out of step');
});

test('a rotating pattern puts the same person on a different shift each week', () => {
  const ds = makeDataset({
    settings: [{ key: 'timezone', value: 'Africa/Accra' }],
    staff: [{ id: 1, employee_no: '1001', name: 'Kofi', active: 1, rotation_weeks: 3 }],
    shifts: [
      { id: 1, name: 'Morning', starts_at: '06:00', ends_at: '14:00' },
      { id: 2, name: 'Afternoon', starts_at: '14:00', ends_at: '22:00' },
      { id: 3, name: 'Night', starts_at: '22:00', ends_at: '06:00' },
    ],
    patterns: [
      { staff_id: 1, week: 0, dow: 0, shift_id: 1 },
      { staff_id: 1, week: 1, dow: 0, shift_id: 2 },
      { staff_id: 1, week: 2, dow: 0, shift_id: 3 },
    ],
  });

  // Three consecutive Mondays from the anchor.
  assert.equal(scheduleFor(ds, 1, '2024-01-01').shift.name, 'Morning');
  assert.equal(scheduleFor(ds, 1, '2024-01-08').shift.name, 'Afternoon');
  assert.equal(scheduleFor(ds, 1, '2024-01-15').shift.name, 'Night');
  assert.equal(scheduleFor(ds, 1, '2024-01-22').shift.name, 'Morning', 'and round again');
});

test('a rest day can move with the rotation too', () => {
  const ds = makeDataset({
    settings: [],
    staff: [{ id: 1, employee_no: '1001', name: 'Ama', active: 1, rotation_weeks: 2 }],
    shifts: [{ id: 1, name: 'Morning', starts_at: '06:00', ends_at: '14:00' }],
    patterns: [
      // Works Wednesday in week one, off in week two.
      { staff_id: 1, week: 0, dow: 2, shift_id: 1 },
      { staff_id: 1, week: 1, dow: 2, shift_id: null },
    ],
  });

  assert.equal(scheduleFor(ds, 1, '2024-01-03').shift?.name, 'Morning');

  const off = scheduleFor(ds, 1, '2024-01-10');
  assert.equal(off.shift, null);
  assert.equal(off.explicit, true, 'a rostered day off, not a gap in the rota');
});

test('a one-week pattern still works exactly as it did', () => {
  const ds = makeDataset({
    settings: [],
    staff: [{ id: 1, employee_no: '1001', name: 'Yaw', active: 1, rotation_weeks: 1 }],
    shifts: [{ id: 1, name: 'Morning', starts_at: '06:00', ends_at: '14:00' }],
    patterns: [{ staff_id: 1, week: 0, dow: 0, shift_id: 1 }],
  });

  for (const monday of ['2024-01-01', '2024-01-08', '2026-08-17']) {
    assert.equal(scheduleFor(ds, 1, monday).shift.name, 'Morning', monday);
  }
});

test('a day set by hand still beats the rotation', () => {
  const ds = makeDataset({
    settings: [],
    staff: [{ id: 1, employee_no: '1001', name: 'Kofi', active: 1, rotation_weeks: 3 }],
    shifts: [
      { id: 1, name: 'Morning', starts_at: '06:00', ends_at: '14:00' },
      { id: 3, name: 'Night', starts_at: '22:00', ends_at: '06:00' },
    ],
    patterns: [{ staff_id: 1, week: 0, dow: 0, shift_id: 1 }],
    roster: [{ staff_id: 1, day: '2024-01-01', shift_id: 3 }],
  });

  const schedule = scheduleFor(ds, 1, '2024-01-01');
  assert.equal(schedule.shift.name, 'Night');
  assert.equal(schedule.source, 'roster', 'a cover is a decision and outranks the cycle');
});

// ---------------------------------------------------------------------------
// Over and under, counted in days
// ---------------------------------------------------------------------------

const day = (o = {}) => ({
  day: '2026-03-02', scheduled: 1, worked_minutes: 480, status: 'present',
  first_in: '09:00', last_out: '17:00',
  reason_code: null, resolved_by: null, resolved_note: null, ...o,
});

// A week runs Monday 2026-03-02 to Sunday 03-08.
const WEEK = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
  '2026-03-07', '2026-03-08'];
const away = { first_in: null, last_out: null, status: 'rest' };

/** A week where the named days were worked and the rest were not. */
const weekWorking = (worked, extra = {}) => WEEK.map((d) => day(
  worked.includes(d) ? { day: d, ...extra } : { day: d, ...away, ...extra },
));

test('a week expects five days, whichever five they are', () => {
  // Five out of seven rather than Monday to Friday. In a hotel the rota runs
  // across all seven and a Saturday is an ordinary working day for half the
  // staff; counting only weekdays would leave the night porter permanently
  // over for doing exactly what was asked.
  assert.equal(overUnder(weekWorking([])).quota, 5);

  const mondayToFriday = weekWorking(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']);
  assert.equal(overUnder(mondayToFriday).difference, 0);

  const wednesdayToSunday = weekWorking(['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']);
  assert.equal(overUnder(wednesdayToSunday).difference, 0, 'the same week, worked across the weekend');
});

test('a day short is a day down, and a day extra is a day up', () => {
  assert.equal(overUnder(weekWorking(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'])).difference, -1);
  assert.equal(overUnder(weekWorking(WEEK)).difference, 2, 'all seven');
});

test('a day on leave is a day the property agreed to', () => {
  const week = weekWorking(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
  const withLeave = week.map((d) => (d.day === '2026-03-06'
    ? { ...d, status: 'leave', reason_code: 'annual_leave' }
    : d));
  assert.equal(overUnder(withLeave).difference, 0);
});

test('a tap in with no tap out is not a day worked', () => {
  // It is a day somebody still has to look at, and until they do the day was
  // not delivered. Counting it would credit a shift nobody can show was
  // finished.
  const week = weekWorking(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
  const half = week.map((d) => (d.day === '2026-03-06'
    ? { ...d, first_in: '09:00', last_out: null, status: 'missing_out' }
    : d));
  const result = overUnder(half);
  assert.equal(result.difference, -1);
  assert.match(result.unders.find((u) => u.day === '2026-03-06').why, /never out/);
});

test('a short day still counts, because it was clocked in and out of', () => {
  // Deliberately different from the credited-hours figure the reports use.
  // This asks "did they turn up and finish", and half a day's hours is still a
  // day somebody came to work.
  const week = weekWorking(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'])
    .map((d) => (d.day === '2026-03-06' ? { ...d, worked_minutes: 120 } : d));
  assert.equal(overUnder(week).difference, 0);
});

test('a public holiday is a day nobody is expected in, whatever day it falls on', () => {
  const holidays = new Set(['2026-03-04']);
  const four = weekWorking(['2026-03-02', '2026-03-03', '2026-03-05', '2026-03-06']);

  assert.equal(overUnder(four, { holidays }).quota, 4, 'a week with a holiday in it expects four');
  assert.equal(overUnder(four, { holidays }).difference, 0);

  const sunday = new Set(['2026-03-08']);
  assert.equal(overUnder(weekWorking([]), { holidays: sunday }).quota, 4,
    'and it counts wherever in the week it lands');
});

test('an absence counts whether or not anybody has ruled on it', () => {
  // The rule this replaced only counted a missed day once a supervisor had
  // confirmed it, so a property that had never got round to settling anything
  // read "square" every month — the one thing it was not.
  const week = weekWorking(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'])
    .map((d) => (d.day === '2026-03-06' ? { ...d, status: 'absent' } : d));
  assert.equal(overUnder(week).difference, -1, 'nobody has been round to it');

  const ruled = week.map((d) => (d.day === '2026-03-06' ? { ...d, resolved_by: 'Ama' } : d));
  assert.equal(overUnder(ruled).difference, -1, 'and once they have');
});

test('the expectation follows the person, not the calendar', () => {
  // Some people work six shorter days and some four long ones. Measuring both
  // against five leaves one permanently over and the other permanently under
  // for doing exactly what their contract says.
  const six = weekWorking(WEEK.slice(0, 6));
  assert.equal(overUnder(six).difference, 1, 'six days against a five-day week');
  assert.equal(overUnder(six, { perWeek: 6 }).difference, 0, 'and none against a six-day one');

  const four = weekWorking(WEEK.slice(0, 4));
  assert.equal(overUnder(four, { perWeek: 4 }).difference, 0);
  assert.equal(overUnder(four, { perWeek: 4 }).quota, 4);
});

test('the difference can name every day behind it', () => {
  const week = weekWorking(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-07', '2026-03-08']);
  const result = overUnder(week);

  assert.equal(result.difference, 0, 'five days, two of them at the weekend');
  assert.equal(result.delivered, 5);
  assert.equal(result.quota, 5);
  assert.deepEqual(result.unders.map((u) => u.day), ['2026-03-05', '2026-03-06']);
  assert.deepEqual(result.overs.map((o) => o.day), []);
});

test('any subset of the days adds up to the same answer', () => {
  // What makes it safe to sign three days out of a fortnight: each day carries
  // its own side of the ledger, so a part of the period cannot come to
  // something the whole would not. The expectation is fractional per day for
  // exactly this reason — a period figure rounded first and divided afterwards
  // does not add up, and this is arithmetic that ends in somebody's leave.
  const week = weekWorking(['2026-03-02', '2026-03-04', '2026-03-07']);

  const whole = overUnder(week);
  const parts = week.reduce((acc, d) => {
    const led = dayLedger(d);
    return { delivered: acc.delivered + led.owed, quota: acc.quota + led.quota };
  }, { delivered: 0, quota: 0 });

  assert.equal(whole.delivered, parts.delivered);
  assert.ok(Math.abs(whole.quota - parts.quota) < 0.001,
    `${whole.quota} against ${parts.quota}`);
});

test('a month asks nothing of somebody it never rostered', () => {
  // A new starter whose first week is next week, somebody who has left, a
  // casual with nothing booked. The week's days are not a debt they owe: they
  // were never asked. Anything they did work still counts, which is the right
  // way round.
  const nothing = weekWorking([]).map((d) => ({ ...d, scheduled: 0 }));
  assert.equal(overUnder(nothing, { expected: false }).difference, 0);
  assert.equal(overUnder(nothing).difference, -5, 'and it is a debt when they were');

  const helped = nothing.map((d) => (d.day === '2026-03-04'
    ? { ...d, first_in: '09:00', last_out: '17:00', status: 'present' }
    : d));
  assert.equal(overUnder(helped, { expected: false }).difference, 1,
    'a day given when nothing was asked is still a day given');
});

// ---------------------------------------------------------------------------
// Today, while it is still happening
// ---------------------------------------------------------------------------

/** The morning shift on 16 June, with the clock stopped at a given time. */
const atTime = (time, punches = []) => ({
  staff: STAFF[0],
  day: '2026-06-16',
  schedule: { shift: MORNING, source: 'roster', explicit: true },
  punches,
  policy: { nowAbs: absMinutes('2026-06-16', time) },
});

test('a shift that has not started is not an absence', () => {
  // Due at 06:00. It is four in the morning.
  const record = computeDay(atTime('04:00'));
  assert.equal(record.status, 'upcoming');
  assert.equal(record.reason_code, null);
  assert.equal(colourFor(record, new Map()), 'grey');
  assert.equal(labelFor(record, new Map()), 'Not due yet');
  assert.equal(isOpen(record), false, 'and nothing for anybody to decide');
});

test('grace is included before anybody is called late', () => {
  // 06:00 start, five minutes' grace. At 06:03 they are not late yet.
  assert.equal(computeDay(atTime('06:03')).status, 'upcoming');
  // At 06:06 the grace is gone and nobody has clocked in.
  assert.equal(computeDay(atTime('06:06')).status, 'absent');
});

test('somebody halfway through a shift has not forgotten to clock out', () => {
  const ds = dataset({ punches: [punch(1, '2026-06-16', '05:58', 'in')] });
  const record = computeDay(atTime('09:00', ds.punchesByStaff.get(1)));

  assert.equal(record.status, 'working');
  assert.equal(record.first_in, '05:58');
  assert.equal(isOpen(record), false, 'not a decision waiting all afternoon');
  assert.equal(colourFor(record, new Map()), 'green');
  assert.match(labelFor(record, new Map()), /On shift since 05:58/);
});

test('once the shift has ended a missing clock-out is a missing clock-out again', () => {
  const ds = dataset({ punches: [punch(1, '2026-06-16', '05:58', 'in')] });
  const record = computeDay(atTime('14:30', ds.punchesByStaff.get(1)));
  assert.equal(record.status, 'missing_out');
  assert.equal(isOpen(record), true);
});

test('a day with no clock at all behaves exactly as it always did', () => {
  // Every historical day comes through here: no `nowAbs`, no new statuses.
  const record = computeDay({
    staff: STAFF[0],
    day: '2026-06-16',
    schedule: { shift: MORNING, source: 'roster', explicit: true },
    punches: [],
  });
  assert.equal(record.status, 'absent');
});

test('a shift still to come counts as neither worked nor missed', () => {
  const totals = summarise([computeDay(atTime('04:00'))], {
    shifts: new Map([[1, MORNING]]), reasons: new Map(),
  });
  assert.equal(totals.scheduled, 1, 'still rostered');
  assert.equal(totals.daysAbsent, 0);
  assert.equal(totals.daysWorked, 0);
});
