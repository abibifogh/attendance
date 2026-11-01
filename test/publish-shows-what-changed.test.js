import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { publishList } from '../src/routes/attendance.js';

/** The Publish dialog lists each day it would send, with what it said before. Made-up people. */

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() { const r = db.prepare(sql).run(...binds); return { meta: { changes: Number(r.changes ?? 0) } }; },
  });
  return { prepare: (sql) => st(sql) };
}

test('new days, changed days with what they said, and handed-over days', async () => {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_shifts; DELETE FROM att_staff;`);
  raw.exec(`INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes) VALUES
              (1, 'Morning', '06:00', '14:00', 0), (2, 'Evening', '14:00', '22:00', 0);
            INSERT INTO att_staff (id, employee_no, name) VALUES (1, 'T1', 'Kwame Asare'), (2, 'T2', 'Akosua Darko');`);
  raw.exec(`INSERT INTO att_roster (staff_id, day, shift_id, published, ever_published, published_as) VALUES
              (1, '2099-03-02', 1, 0, 0, NULL),
              (1, '2099-03-03', 2, 0, 1, '1|1||'),
              (2, '2099-03-03', NULL, 0, 1, '2|2||'),
              (2, '2099-03-04', 1, 0, 1, '1|1||'),
              (1, '2099-03-05', 1, 1, 1, '1|1||'),
              (1, '2099-04-01', 1, 0, 0, NULL)`);
  const ds = {
    shifts: raw.prepare('SELECT * FROM att_shifts').all(),
    staffById: new Map(raw.prepare('SELECT * FROM att_staff').all().map((s) => [s.id, s])),
  };
  const items = await publishList(d1(raw), ds, '2099-03-01', '2099-03-31');
  assert.equal(items.length, 4, 'published and out-of-window days are left out');
  const [fresh, changed, off, handed] = items;
  assert.deepEqual([fresh.changed, fresh.name, fresh.shift.name, fresh.was], [false, 'Kwame Asare', 'Morning', null]);
  assert.deepEqual([changed.changed, changed.was.shift.name, changed.shift.name], [true, 'Morning', 'Evening']);
  assert.deepEqual([off.name, off.shift, off.was.shift.name], ['Akosua Darko', null, 'Evening']);
  assert.deepEqual([handed.name, handed.was.name, handed.was.staffId], ['Akosua Darko', 'Kwame Asare', 1]);
});

test('the dialog draws the list under the two counts', () => {
  const src = readFileSync('public/js/views/att-rota.js', 'utf8');
  assert.match(src, /changeList\(data\.publish\?\.items \?\? \[\], unpublished\)/);
  assert.match(src, /'What changed'/);
});
