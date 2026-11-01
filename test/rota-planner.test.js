import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coverGaps, hoursTone, restGaps, weekdayOf } from '../public/js/rota-plan.js';

/** The rota planner's sums: hours against a week, cover gaps, short rest. Made-up shifts. */

test('hours against a week: on target within two hours, under, over, far over', () => {
  assert.equal(hoursTone(40, 40).k, 'ok');
  assert.equal(hoursTone(38.5, 40).k, 'ok');
  assert.deepEqual([hoursTone(32, 40).k, hoursTone(32, 40).label], ['under', '8h under']);
  assert.deepEqual([hoursTone(46, 40).k, hoursTone(46, 40).label], ['over', '6h over']);
  assert.deepEqual([hoursTone(54, 40).k, hoursTone(54, 40).label], ['far', '14h over']);
  assert.equal(hoursTone(10, 0).k, 'none');
});

const S = (id, extra = {}) => ({ id, name: `Shift ${id}`, active: 1, starts_at: '06:00', ends_at: '14:00', ...extra });

test('cover gaps: must-cover shifts with nobody on them, alternatives answering for each other', () => {
  const days = ['2026-11-02', '2026-11-03', '2026-11-08'];
  assert.equal(weekdayOf('2026-11-02'), 0);
  const shifts = [
    S(1, { cover: 'must' }),
    S(2, { cover: 'must', alt_group: 'breakfast' }), S(3, { cover: 'wanted', alt_group: 'breakfast' }),
    S(4, { cover: 'must', runs_on: '[5,6]' }), // weekends only
    S(5, { cover: 'wanted' }),
    S(6, { cover: 'must', needed: 2 }),
    S(7, { cover: 'must', only_staff: '[9]' }),
  ];
  const held = { '2026-11-02': [1, 3, 6, 6, 7], '2026-11-03': [2, 6], '2026-11-08': [1, 2, 4, 6, 6] };
  const gaps = coverGaps({ shifts, days, onDay: (d) => held[d], away: (id, d) => id === 9 && d === '2026-11-03' });
  assert.deepEqual(gaps.map((g) => `${g.day}:${g.shift.id}:${g.short}`), [
    '2026-11-03:1:1', '2026-11-03:6:1', '2026-11-08:7:1',
  ]);
});

test('short rest: a day that starts under the limit after the day before ended', () => {
  const evening = { starts_at: '14:00', ends_at: '22:00' };
  const morning = { starts_at: '06:00', ends_at: '14:00' };
  const night = { starts_at: '22:00', ends_at: '06:00' };
  assert.deepEqual(restGaps([evening, morning, null, night, morning], 12), [null, 8, null, null, 0]);
});
