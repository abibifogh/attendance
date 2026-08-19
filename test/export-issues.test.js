import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { exportIssues, resolveDay } from '../src/routes/attendance.js';

/**
 * The morning list, downloaded.
 *
 * The point of it is what it leaves out. A supervisor about to walk round the
 * building wants the names with something against them; the full export is the
 * payroll extract and answers a different question at a length nobody reads
 * standing up. So the test that matters most is not that the eight are in it
 * but that the ninety are not.
 */

function d1(db) {
  const statement = (sql, binds = []) => ({
    bind(...a) { return statement(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const r = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}

const DESK = {
  user: { id: 2, name: 'Kofi', role: 'supervisor' },
  permissions: ['att_view', 'att_manage'],
};

function ctx(db, { query = '', body = null, session = DESK } = {}) {
  const url = new URL(`https://staff.example.test/api/att/export/issues${query}`);
  return {
    db,
    env: {},
    url,
    session,
    executionContext: null,
    request: new Request(url, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'GET' }),
  };
}

/**
 * A Wednesday with five people on: one clean, one late, one who left early,
 * one absent, and one who clocked in and never out.
 */
async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.exec('DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;');
  raw.exec('DELETE FROM att_shifts; DELETE FROM att_staff');
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes, grace_out_minutes)
     VALUES (1, 'Morning', '09:00', '17:00', 0, 5, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES
       (1, '1001', 'Clean Sheet',  'Kitchen',      '2020-01-01'),
       (2, '1002', 'Late Arrival', 'Housekeeping', '2020-01-01'),
       (3, '1003', 'Early Away',   'Kitchen',      '2020-01-01'),
       (4, '1004', 'Never Came',   'Security',     '2020-01-01'),
       (5, '1005', 'No Clock Out', 'Kitchen',      '2020-01-01')`,
  ).run();

  const DAY = '2026-06-03';
  for (const id of [1, 2, 3, 4, 5]) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (?, ?, 1)').run(id, DAY);
  }
  const punch = (id, no, at) => raw.prepare(
    `INSERT INTO att_punches (staff_id, employee_no, device_serial, at_utc, at_local, day, source, dedupe_key)
     VALUES (?1, ?2, 'TEST', ?3, ?3, ?4, 'test', ?5)`,
  ).run(id, no, at, DAY, `${id}-${at}`);

  punch(1, '1001', `${DAY} 09:00:00`); punch(1, '1001', `${DAY} 17:00:00`);
  punch(2, '1002', `${DAY} 09:47:00`); punch(2, '1002', `${DAY} 17:00:00`);
  punch(3, '1003', `${DAY} 09:00:00`); punch(3, '1003', `${DAY} 15:10:00`);
  // 4 never turned up.
  punch(5, '1005', `${DAY} 09:00:00`);

  return { raw, db: d1(raw), DAY };
}

const rowsOf = async (response) => {
  const text = await response.text();
  return text.replace(/^﻿/, '').split('\n').map((line) => line.split(','));
};

// ---------------------------------------------------------------------------

test('the file holds the ones needing somebody, and nobody else', async () => {
  const { db, DAY } = await setup();
  const rows = await rowsOf(await exportIssues(ctx(db, { query: `?day=${DAY}` })));

  const names = rows.slice(1).map((r) => r[3]);
  assert.deepEqual([...names].sort(),
    ['Early Away', 'Late Arrival', 'Never Came', 'No Clock Out']);
  assert.ok(!names.includes('Clean Sheet'),
    'the whole point is what it leaves out');
});

test('each row says which of the three groups put it there', async () => {
  const { db, DAY } = await setup();
  const rows = await rowsOf(await exportIssues(ctx(db, { query: `?day=${DAY}` })));
  const by = Object.fromEntries(rows.slice(1).map((r) => [r[3], r[1]]));

  assert.equal(by['No Clock Out'], 'Waiting on a decision');
  assert.equal(by['Never Came'], 'Absent');
  assert.equal(by['Late Arrival'], 'Late or left early');
  assert.equal(by['Early Away'], 'Late or left early');
});

test('worst first, so the file opens on what matters', async () => {
  // Sorted here rather than left to the spreadsheet, because most people never
  // sort it.
  const { db, DAY } = await setup();
  const rows = await rowsOf(await exportIssues(ctx(db, { query: `?day=${DAY}` })));

  assert.deepEqual(rows.slice(1).map((r) => r[1]), [
    'Waiting on a decision', 'Absent', 'Late or left early', 'Late or left early',
  ]);
  assert.deepEqual(rows.slice(2, 4).map((r) => r[3]), ['Never Came', 'Early Away'],
    'and alphabetically inside a group');
});

test('it carries what somebody would need to go and ask', async () => {
  const { db, DAY } = await setup();
  const rows = await rowsOf(await exportIssues(ctx(db, { query: `?day=${DAY}` })));

  assert.deepEqual(rows[0].slice(0, 11), [
    'Date', 'Needs', 'Employee no', 'Name', 'Department', 'Shift',
    'Scheduled start', 'Scheduled end', 'Clock in', 'Clock out', 'Hours',
  ]);

  const late = rows.slice(1).find((r) => r[3] === 'Late Arrival');
  assert.equal(late[2], '1002');
  assert.equal(late[4], 'Housekeeping');
  assert.equal(late[5], 'Morning');
  assert.equal(late[8], '09:47');
  assert.equal(late[11], '47', 'late minutes');
});

test('a day somebody has settled drops off it', async () => {
  // The list is what still needs doing, so settling something has to remove it
  // — otherwise the file grows all week and stops being read.
  const { db, DAY } = await setup();

  await resolveDay(ctx(db, {
    body: { staffId: 5, reason: 'present', out: '17:00', note: 'Saw him leave' },
  }), DAY);

  const rows = await rowsOf(await exportIssues(ctx(db, { query: `?day=${DAY}` })));
  assert.ok(!rows.slice(1).some((r) => r[3] === 'No Clock Out'));
});

test('a settled absence stays on it, with who settled it and why', async () => {
  // Still worth chasing: an absence recorded as absence is exactly what a
  // manager wants the list of.
  const { db, DAY } = await setup();

  await resolveDay(ctx(db, {
    body: { staffId: 4, reason: 'absent', note: 'No word from him' },
  }), DAY);

  const rows = await rowsOf(await exportIssues(ctx(db, { query: `?day=${DAY}` })));
  const row = rows.slice(1).find((r) => r[3] === 'Never Came');
  assert.ok(row);
  assert.match(row.join(','), /Kofi \(supervisor\)/);
  assert.match(row.join(','), /No word from him/);
});

test('a week comes back as one file', async () => {
  const { db, DAY } = await setup();
  const response = await exportIssues(ctx(db, { query: '?from=2026-06-01&to=2026-06-07' }));

  assert.match(response.headers.get('Content-Disposition'),
    /attendance-issues-2026-06-01-to-2026-06-07\.csv/);
  const rows = await rowsOf(response);
  assert.ok(rows.slice(1).every((r) => r[0] >= '2026-06-01' && r[0] <= '2026-06-07'));
  assert.ok(rows.slice(1).some((r) => r[0] === DAY));
});

test('one day is named as one day', async () => {
  const { db, DAY } = await setup();
  const response = await exportIssues(ctx(db, { query: `?day=${DAY}` }));
  assert.match(response.headers.get('Content-Disposition'), /attendance-issues-2026-06-03\.csv/);
  assert.match(response.headers.get('Content-Type'), /text\/csv/);
});

test('a quiet day is a file with only its headings', async () => {
  // Not an error and not an empty file: somebody who downloaded it should be
  // able to see that they downloaded the right thing and there was nothing in
  // it.
  const { db } = await setup();
  const rows = await rowsOf(await exportIssues(ctx(db, { query: '?day=2026-06-06' })));
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 'Date');
});
