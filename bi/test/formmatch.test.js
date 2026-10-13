import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchForm, setsAdding } from '../src/routes/formmatch.js';

const g = (po, value, day, submitted, by = 'Ama') => ({ po, value, days: day ? [day] : [], submitted, by: [by] });
const need = (day, slot, user, target, pieces = [target]) => ({ day, slot, user, target, pieces });

test('form match: the only set adding up to a shift’s expenses is clear', () => {
  const out = matchForm(
    [need('2026-10-02', 'morning', 'AMA', 8850, [5500, 3350])],
    [g('P02423', 5500, '2026-10-02', '2026-10-02 07:27'), g('P02428', 3350, '2026-10-02', '2026-10-02 12:23'), g('P02431', 9000, '2026-10-02', '2026-10-02 21:16')],
  );
  assert.equal(out.clear.length, 1);
  assert.deepEqual(out.clear[0].pos.map((p) => p.po), ['P02423', 'P02428']);
  assert.equal(out.clear[0].part, false);
  assert.equal(out.unsure.length, 0);
});

test('form match: two sets that add up: the one sent during the shift, by its person, wins; otherwise nobody guesses', () => {
  const groups = [
    g('P1', 1000, '2026-10-03', '2026-10-03 09:00', 'Kofi'), g('P2', 1000, '2026-10-03', '2026-10-03 20:00', 'Esi'),
  ];
  const clear = matchForm([need('2026-10-03', 'morning', 'KOFI', 1000)], groups);
  assert.deepEqual(clear.clear[0].pos.map((p) => p.po), ['P1']);
  const both = [g('P1', 1000, '2026-10-03', '2026-10-03 09:00', 'Kofi'), g('P2', 1000, '2026-10-03', '2026-10-03 10:00', 'Kofi')];
  const out = matchForm([need('2026-10-03', 'morning', 'KOFI', 1000)], both);
  assert.equal(out.clear.length, 0);
  assert.deepEqual(out.unsure[0].could.map((p) => p.po), ['P1', 'P2']);
});

test('form match: a PO two shifts could each claim goes to neither, until the other is settled', () => {
  const out = matchForm(
    [need('2026-10-04', 'morning', 'AMA', 500), need('2026-10-04', 'afternoon', 'KOFI', 500)],
    [g('P9', 500, '2026-10-04', '2026-10-04 23:00', 'Yaw')],
  );
  assert.equal(out.clear.length, 0);
  assert.equal(out.unsure.length, 2);
  // With the afternoon's own PO there, the morning's is settled first, then the afternoon's.
  const two = matchForm(
    [need('2026-10-04', 'morning', 'AMA', 500), need('2026-10-04', 'afternoon', 'KOFI', 800)],
    [g('P9', 500, '2026-10-04', '2026-10-04 08:00'), g('P10', 800, '2026-10-04', '2026-10-04 15:00')],
  );
  assert.deepEqual(two.clear.map((c) => [c.slot, c.pos.map((p) => p.po).join()]), [['morning', 'P9'], ['afternoon', 'P10']]);
});

test('form match: no set adds up, a PO that is exactly one receipt is linked as a part', () => {
  const out = matchForm(
    [need('2026-10-05', 'afternoon', 'ESI', 1300, [700, 600])],
    [g('P20', 700, '2026-10-05', '2026-10-05 17:44'), g('P21', 250, '2026-10-05', '2026-10-05 18:00')],
  );
  assert.equal(out.clear.length, 1);
  assert.equal(out.clear[0].part, true);
  assert.deepEqual(out.clear[0].pos.map((p) => p.po), ['P20']);
});

test('form match: dates decide; without one, the time it was sent; a night shift takes the next morning too', () => {
  const out = matchForm(
    [need('2026-10-06', 'night', 'YAW', 400), need('2026-10-06', 'morning', 'AMA', 300)],
    [g('P30', 400, '2026-10-07', '2026-10-07 10:00'), g('P31', 300, null, '2026-10-06 13:10'), g('P32', 300, '2026-10-01', '2026-10-06 09:00')],
  );
  assert.deepEqual(out.clear.map((c) => [c.slot, c.pos.map((p) => p.po).join()]), [['night', 'P30'], ['morning', 'P31']]);
});

test('setsAdding finds every set up to the limit', () => {
  const sets = setsAdding([{ value: 1 }, { value: 2 }, { value: 3 }], 3);
  assert.equal(sets.length, 2);
});
