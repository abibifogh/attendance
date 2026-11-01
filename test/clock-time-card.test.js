import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clockCard } from '../src/routes/approvals.js';

/** The Inbox card for a clock-time correction: the shift and its times, and what changes. Made-up people. */

test('a day shift: late in, nothing out, asked for the end of the shift', () => {
  const c = clockCard({
    day: '2026-06-17', shift: { name: 'Maintenance 1', starts_at: '08:00', ends_at: '17:00' }, shift_state: 'shift',
    observed_in: '09:07', observed_out: null, now_in: '09:07', now_out: '17:00', reason: 'Forgot to clock out', actor: 'Desk One',
  });
  assert.deepEqual(c.shift, { name: 'Maintenance 1', from: '08:00', to: '17:00', overnight: false });
  assert.deepEqual(c.rows.map((r) => [r.saw, r.asked, r.note]), [['09:07', '09:07', '1h 07m late'], [null, '17:00', null]]);
  assert.equal(c.noShift, null);
});

test('a night shift: an early clock-out after midnight is read against the next morning', () => {
  const c = clockCard({
    day: '2026-06-20', shift: { name: 'Night shift', starts_at: '22:00', ends_at: '06:15' }, shift_state: 'shift',
    observed_in: '21:58', observed_out: '04:30', now_in: '21:58', now_out: '06:15',
  });
  assert.equal(c.shift.overnight, true);
  assert.deepEqual(c.rows.map((r) => r.note), [null, '1h 45m early']);
});

test('no shift that day says so', () => {
  const c = clockCard({ day: '2026-06-21', shift: null, shift_state: 'none', observed_in: null, observed_out: null, now_in: '08:00', now_out: '16:00' });
  assert.equal(c.shift, null);
  assert.equal(c.noShift, 'No shift on the rota');
  assert.equal(clockCard({ day: '2026-06-21', shift: null, shift_state: 'leave' }).noShift, 'On leave that day');
});
