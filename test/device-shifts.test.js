import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  inferShifts, mergeCandidates, parseStatusRules, shiftsFromRules, toShiftRow,
} from '../src/lib/device-shifts.js';

/**
 * Working the shifts out instead of asking somebody to type them again.
 *
 * The parser is deliberately shape-agnostic, so most of what is worth testing
 * here is that it survives shapes it has never seen — which is the situation it
 * will actually be in on somebody's firmware.
 */

// ---------------------------------------------------------------------------
// Reading the terminal
// ---------------------------------------------------------------------------

test('a flat status rule is read', () => {
  const rules = parseStatusRules({
    AttendanceStatusRuleCfg: {
      attendanceStatus: 'checkIn',
      enable: true,
      beginTime: '05:00:00',
      endTime: '10:00:00',
    },
  });
  assert.deepEqual(rules, [{ status: 'in', from: '05:00', to: '10:00' }]);
});

test('a list of rules is read', () => {
  const rules = parseStatusRules({
    AttendanceStatusRuleCfgList: [
      { attendanceStatus: 'checkIn', beginTime: '05:00:00', endTime: '10:00:00' },
      { attendanceStatus: 'checkOut', beginTime: '13:00:00', endTime: '18:00:00' },
    ],
  });
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.map((r) => r.status), ['in', 'out']);
});

test('a shape nobody anticipated is still read', () => {
  // Times nested two levels below the status, which some firmware does.
  const rules = parseStatusRules({
    Wrapper: {
      rule: {
        attendanceStatus: 'checkOut',
        TimeRangeList: [{ startTime: '13:30', stopTime: '18:45' }],
      },
    },
  });
  assert.deepEqual(rules, [{ status: 'out', from: '13:30', to: '18:45' }]);
});

test('the same band reported twice is read once', () => {
  const rules = parseStatusRules({
    AttendanceStatusRuleCfg: {
      attendanceStatus: 'checkIn',
      beginTime: '05:00:00',
      endTime: '10:00:00',
      TimeRange: { beginTime: '05:00:00', endTime: '10:00:00' },
    },
  });
  assert.equal(rules.length, 1);
});

test('the break and overtime statuses are named, not guessed at', () => {
  const rules = parseStatusRules({
    list: [
      { attendanceStatus: 'breakOff', beginTime: '12:00', endTime: '12:30' },
      { attendanceStatus: 'breakIn', beginTime: '12:30', endTime: '13:00' },
      { attendanceStatus: 'overtimeIn', beginTime: '18:00', endTime: '19:00' },
    ],
  });
  assert.deepEqual(rules.map((r) => r.status), ['breakOut', 'breakIn', 'overtimeIn']);
});

test('rubbish is ignored rather than fatal', () => {
  assert.deepEqual(parseStatusRules(null), []);
  assert.deepEqual(parseStatusRules({ _text: '<html>404</html>' }), []);
  assert.deepEqual(parseStatusRules({ attendanceStatus: 'checkIn', beginTime: 'never', endTime: '?' }), []);
  // A time pair with no status says nothing about which shift it belongs to.
  assert.deepEqual(parseStatusRules({ beginTime: '05:00', endTime: '10:00' }), []);
});

test('bands become a candidate shift, flagged as the outer bound it is', () => {
  const shifts = shiftsFromRules([
    { status: 'in', from: '05:00', to: '10:00' },
    { status: 'out', from: '13:00', to: '18:00' },
  ]);

  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].starts_at, '05:00');
  assert.equal(shifts[0].ends_at, '18:00');
  assert.equal(shifts[0].confidence, 'bands');
  assert.match(shifts[0].note, /a little later/);
});

test('no check-in band means no candidate at all', () => {
  assert.deepEqual(shiftsFromRules([{ status: 'out', from: '13:00', to: '18:00' }]), []);
});

// ---------------------------------------------------------------------------
// Reading the punches
// ---------------------------------------------------------------------------

/** A run of days where people arrive around `start` and leave around `end`. */
function days(n, start, end, jitter = 4) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const wobble = (i % (jitter * 2)) - jitter;
    out.push({ in: shift(start, wobble), out: shift(end, -wobble) });
  }
  return out;
}

function shift(time, minutes) {
  const [hh, mm] = time.split(':').map(Number);
  const total = ((hh * 60 + mm + minutes) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

test('a shift is found from where people actually clock in', () => {
  const found = inferShifts(days(40, '06:00', '14:00'), { minSupport: 5 });
  assert.equal(found.length, 1);
  assert.equal(found[0].starts_at, '06:00');
  assert.equal(found[0].ends_at, '14:00');
  assert.equal(found[0].support, 40);
  assert.equal(found[0].name, 'Morning');
});

test('two shifts are told apart', () => {
  const found = inferShifts(
    [...days(30, '06:00', '14:00'), ...days(25, '14:00', '22:00')],
    { minSupport: 5 },
  );
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.starts_at), ['06:00', '14:00']);
  assert.deepEqual(found.map((f) => f.name), ['Morning', 'Afternoon']);
});

test('a night shift crossing midnight is one shift, not two', () => {
  const found = inferShifts(days(30, '22:00', '06:00'), { minSupport: 5 });
  assert.equal(found.length, 1);
  assert.equal(found[0].starts_at, '22:00');
  assert.equal(found[0].ends_at, '06:00');
  assert.equal(found[0].name, 'Night');
  assert.equal(found[0].lengthMinutes, 480);
});

test('a handful of odd days is not a shift', () => {
  const found = inferShifts(
    [...days(40, '06:00', '14:00'), ...days(2, '09:13', '11:47')],
    { minSupport: 5 },
  );
  assert.equal(found.length, 1, 'the two-day oddity is not offered as a shift');
});

test('a pairing that cannot be one shift is discarded', () => {
  const found = inferShifts([
    ...days(20, '06:00', '14:00'),
    // Somebody who tapped twice within a minute, and somebody whose clock-out
    // is three days later.
    ...Array.from({ length: 20 }, () => ({ in: '06:00', out: '06:30' })),
  ], { minSupport: 5 });

  assert.equal(found.length, 1);
  assert.equal(found[0].starts_at, '06:00');
  assert.equal(found[0].ends_at, '14:00');
});

test('the suggestion is the middle of the cluster, not the edge of a bucket', () => {
  // Everybody arrives at 05:52 for a shift that starts at 06:00.
  const found = inferShifts(days(30, '05:52', '14:03', 2), { minSupport: 5 });
  assert.equal(found[0].starts_at, '05:50', 'rounded to five minutes, not to the half hour');
});

// ---------------------------------------------------------------------------
// Putting them together
// ---------------------------------------------------------------------------

test('the observed times win, and the band corroborates them', () => {
  const merged = mergeCandidates({
    fromDevice: shiftsFromRules([
      { status: 'in', from: '05:00', to: '10:00' },
      { status: 'out', from: '13:00', to: '18:00' },
    ]),
    fromPunches: inferShifts(days(30, '06:00', '14:00'), { minSupport: 5 }),
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].starts_at, '06:00', 'not the 05:00 the band would imply');
  assert.equal(merged[0].confirmedByDevice, true);
  assert.equal(merged[0].deviceWindow.in.from, '05:00');
  assert.match(merged[0].note, /between 05:00 and 10:00/);
});

test('a band nobody has worked yet is still offered', () => {
  const merged = mergeCandidates({
    fromDevice: shiftsFromRules([
      { status: 'in', from: '21:00', to: '23:00' },
      { status: 'out', from: '05:00', to: '07:00' },
    ]),
    fromPunches: [],
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].support, 0);
  assert.equal(merged[0].confirmedByDevice, true);
});

test('punches with no band behind them are offered too', () => {
  // The ordinary case: a terminal that was never put into attendance mode.
  const merged = mergeCandidates({
    fromDevice: [],
    fromPunches: inferShifts(days(30, '06:00', '14:00'), { minSupport: 5 }),
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].confirmedByDevice, false);
  assert.equal(merged[0].support, 30);
});

test('one band is not claimed by two observed shifts', () => {
  const merged = mergeCandidates({
    fromDevice: shiftsFromRules([
      { status: 'in', from: '05:00', to: '10:00' },
      { status: 'out', from: '13:00', to: '18:00' },
    ]),
    fromPunches: inferShifts(
      [...days(30, '06:00', '14:00'), ...days(30, '08:00', '16:00')],
      { minSupport: 5 },
    ),
  });

  assert.equal(merged.length, 2);
  assert.equal(merged.filter((m) => m.confirmedByDevice).length, 1);
});

test('a suggestion becomes a shift with policy left as a default', () => {
  const [candidate] = inferShifts(days(30, '06:00', '14:00'), { minSupport: 5 });
  const row = toShiftRow(candidate);

  assert.equal(row.name, 'Morning');
  assert.equal(row.startsAt, '06:00');
  assert.equal(row.endsAt, '14:00');
  // Nothing the terminal or the punches can know is invented.
  assert.equal(row.breakMinutes, 0);
  assert.equal(row.graceIn, 5);
  assert.equal(row.halfDayMinutes, 240);
  assert.equal(row.fullDayMinutes, 420);
});

test('a night shift becomes a shift row without a negative length', () => {
  const [candidate] = inferShifts(days(30, '22:00', '06:00'), { minSupport: 5 });
  const row = toShiftRow(candidate);
  assert.equal(row.startsAt, '22:00');
  assert.equal(row.endsAt, '06:00');
  assert.equal(row.halfDayMinutes, 240);
});
