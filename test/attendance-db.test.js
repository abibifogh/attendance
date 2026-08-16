import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  day as dayRoute, deviceConfig, importShifts, ingest, resolveDay, shiftSuggestions, staffReport,
} from '../src/routes/attendance.js';
import { createStaff } from '../src/routes/attendance-setup.js';
import { hashDeviceToken } from '../src/lib/attendance-ingest.js';
import { getPepper } from '../src/lib/auth.js';

/**
 * The attendance write path, against a real database.
 *
 * The pure rules are covered in attendance.test.js. What is left is the part
 * that only fails in SQL: the idempotent insert, the upsert that must not
 * overturn a supervisor's ruling, and punches that arrive before the person
 * exists. A stub database cannot catch any of those, so this runs the
 * migrations into SQLite and drives the real handlers.
 */

/** Enough of D1's interface for the handlers to run unmodified. */
function d1(db) {
  const statement = (sql, binds = []) => ({
    sql,
    binds,
    bind(...args) { return statement(sql, args); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const result = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(result.changes ?? 0) } };
    },
  });

  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
}

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
  return { raw, db: d1(raw) };
}

const SESSION = {
  user: { id: 1, name: 'Ama', role: 'manager' },
  permissions: ['att_view', 'att_reports', 'att_manage', 'att_setup'],
};

function ctx(db, { body = null, query = '' } = {}) {
  const url = new URL(`https://example.test/api/att/x${query}`);
  return {
    db,
    env: {},
    url,
    session: SESSION,
    executionContext: null,
    request: new Request(url, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'GET' }),
  };
}

/**
 * A property with one terminal, one morning shift and one cook on it Monday to
 * Friday. The smallest arrangement that can still go wrong in every interesting
 * way.
 */
async function setup() {
  const { raw, db } = freshDb();
  const pepper = await getPepper(db);
  const token = 'test-token';

  raw.exec("UPDATE settings SET value = 'Africa/Accra' WHERE key = 'timezone'");
  raw.prepare(
    'INSERT INTO att_devices (serial, name, token_hash) VALUES (?, ?, ?)',
  ).run('DS-TEST-1', 'Staff entrance', await hashDeviceToken(token, pepper));

  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes, grace_out_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 30, 5, 5)`,
  ).run();

  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1001', 'Henry Aryee', '2023-02-01')",
  ).run();
  for (const dow of [0, 1, 2, 3, 4]) {
    raw.prepare('INSERT INTO att_patterns (staff_id, dow, shift_id) VALUES (1, ?, 1)').run(dow);
  }

  return { raw, db, token };
}

const event = (time, status = null, serial = null) => ({
  major: 5,
  minor: 75,
  time,
  employeeNoString: '1001',
  name: 'Henry Aryee',
  ...(status ? { attendanceStatus: status } : {}),
  ...(serial ? { serialNo: serial } : {}),
  doorNo: 1,
});

async function send(db, token, events) {
  const response = await ingest(ctx(db, {
    body: { serial: 'DS-TEST-1', token, events },
  }));
  return response.json();
}

// ---------------------------------------------------------------------------

test('a batch of punches becomes a computed day', async () => {
  const { raw, db, token } = await setup();

  const result = await send(db, token, [
    event('2026-06-15T05:58:00+00:00', 'checkIn', 1),
    event('2026-06-15T14:03:00+00:00', 'checkOut', 2),
  ]);

  assert.equal(result.stored, 2);
  assert.equal(result.unknownEmployees.length, 0);

  const punches = raw.prepare('SELECT * FROM att_punches ORDER BY at_utc').all();
  assert.equal(punches.length, 2);
  assert.equal(punches[0].staff_id, 1);
  assert.equal(punches[0].direction, 'in');
  assert.equal(punches[0].day, '2026-06-15');

  const day = raw.prepare('SELECT * FROM att_days WHERE staff_id = 1 AND day = ?').get('2026-06-15');
  assert.equal(day.status, 'present');
  assert.equal(day.first_in, '05:58');
  assert.equal(day.last_out, '14:03');
  assert.equal(day.worked_minutes, 455);
  assert.ok(day.note.includes('05:58'));
});

test('sending the same events again changes nothing', async () => {
  const { raw, db, token } = await setup();
  const batch = [
    event('2026-06-15T05:58:00+00:00', 'checkIn', 1),
    event('2026-06-15T14:03:00+00:00', 'checkOut', 2),
  ];

  await send(db, token, batch);
  const second = await send(db, token, batch);

  assert.equal(second.stored, 0);
  assert.equal(second.duplicates, 2);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_punches').get().n, 2);
});

test('an overlapping window is the normal case, not an error', async () => {
  const { raw, db, token } = await setup();

  await send(db, token, [event('2026-06-15T05:58:00+00:00', 'checkIn', 1)]);
  // The next poll asks for a window covering the same punch plus a new one.
  const second = await send(db, token, [
    event('2026-06-15T05:58:00+00:00', 'checkIn', 1),
    event('2026-06-15T14:03:00+00:00', 'checkOut', 2),
  ]);

  assert.equal(second.stored, 1);
  assert.equal(second.duplicates, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_punches').get().n, 2);
});

test('a wrong token is refused and stores nothing', async () => {
  const { raw, db } = await setup();
  await assert.rejects(
    () => send(db, 'not-the-token', [event('2026-06-15T05:58:00+00:00')]),
    /token is not right/i,
  );
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_punches').get().n, 0);
});

test('an unregistered terminal is refused', async () => {
  const { db, token } = await setup();
  const response = ingest(ctx(db, {
    body: { serial: 'SOMEBODY-ELSES-DEVICE', token, events: [] },
  }));
  await assert.rejects(() => response, /not registered/i);
});

test('punches for somebody unknown are kept, then claimed', async () => {
  const { raw, db, token } = await setup();

  const result = await send(db, token, [
    { ...event('2026-06-16T06:01:00+00:00', 'checkIn', 10), employeeNoString: '2002' },
    { ...event('2026-06-16T14:00:00+00:00', 'checkOut', 11), employeeNoString: '2002' },
  ]);

  assert.deepEqual(result.unknownEmployees, ['2002']);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_punches WHERE staff_id IS NULL').get().n, 2);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_days').get().n, 0);

  const created = await (await createStaff(ctx(db, {
    body: { employeeNo: '2002', name: 'Vivian Mensah', hiredOn: '2024-06-15' },
  }))).json();

  assert.equal(created.claimedPunches, 2);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_punches WHERE staff_id IS NULL').get().n, 0);

  // No pattern for her yet, so the day is unrostered rather than absent — the
  // punches are still visible rather than silently dropped.
  const day = raw.prepare('SELECT * FROM att_days WHERE staff_id = ? AND day = ?')
    .get(created.id, '2026-06-16');
  assert.equal(day.status, 'unscheduled');
  assert.equal(day.worked_minutes, 479);
});

test('a missing clock-out is held open rather than counted absent', async () => {
  const { raw, db, token } = await setup();
  await send(db, token, [event('2026-06-15T06:00:00+00:00', 'checkIn', 1)]);

  const day = raw.prepare('SELECT * FROM att_days WHERE staff_id = 1 AND day = ?').get('2026-06-15');
  assert.equal(day.status, 'missing_out');
  assert.equal(day.reason_code, 'incomplete');
  assert.equal(day.resolution, 'open');
  assert.equal(day.worked_minutes, 0);
});

test("a supervisor's ruling survives punches arriving afterwards", async () => {
  const { raw, db, token } = await setup();
  await send(db, token, [event('2026-06-15T06:00:00+00:00', 'checkIn', 1)]);

  await resolveDay(ctx(db, {
    body: { staffId: 1, reason: 'present', out: '14:00', note: 'Confirmed with the head chef.' },
  }), '2026-06-15');

  let day = raw.prepare('SELECT * FROM att_days WHERE staff_id = 1 AND day = ?').get('2026-06-15');
  assert.equal(day.resolution, 'resolved');
  assert.equal(day.reason_code, 'present');
  assert.equal(day.corrected_out, '14:00');
  assert.equal(day.worked_minutes, 450);
  assert.equal(day.resolved_by, 'Ama (manager)');

  // The terminal catches up and sends the clock-out it had been sitting on.
  await send(db, token, [event('2026-06-15T13:47:00+00:00', 'checkOut', 2)]);

  day = raw.prepare('SELECT * FROM att_days WHERE staff_id = 1 AND day = ?').get('2026-06-15');
  assert.equal(day.resolution, 'resolved', 'the ruling stands');
  assert.equal(day.reason_code, 'present');
  assert.equal(day.punches, 2, 'but the record shows both punches');
});

test('a resolution is written to the audit trail', async () => {
  const { raw, db, token } = await setup();
  await send(db, token, [event('2026-06-15T06:00:00+00:00', 'checkIn', 1)]);
  await resolveDay(ctx(db, {
    body: { staffId: 1, reason: 'present', out: '14:00' },
  }), '2026-06-15');

  const entry = raw.prepare("SELECT * FROM audit_log WHERE action = 'attendance.resolve'").get();
  assert.ok(entry, 'the decision is recorded');
  assert.equal(entry.actor, 'Ama (manager)');
  assert.equal(entry.entity, '1|2026-06-15');
});

test('a reason the property does not use is refused', async () => {
  const { db } = await setup();
  await assert.rejects(
    () => resolveDay(ctx(db, { body: { staffId: 1, reason: 'made_up' } }), '2026-06-15'),
    /not a reason this property uses/i,
  );
});

test('a reason the system chooses for itself cannot be chosen by hand', async () => {
  const { db } = await setup();
  await assert.rejects(
    () => resolveDay(ctx(db, { body: { staffId: 1, reason: 'incomplete' } }), '2026-06-15'),
    /decided by the system/i,
  );
});

test('the day report puts what needs a decision at the top', async () => {
  const { db, token } = await setup();
  const raw2 = db;

  // A second person, present and on time, so the ordering has something to sort.
  await (await createStaff(ctx(db, {
    body: { employeeNo: '1002', name: 'Vivian Mensah' },
  }))).json();

  await send(db, token, [
    event('2026-06-15T06:00:00+00:00', 'checkIn', 1),
    { ...event('2026-06-15T05:55:00+00:00', 'checkIn', 3), employeeNoString: '1002' },
    { ...event('2026-06-15T14:05:00+00:00', 'checkOut', 4), employeeNoString: '1002' },
  ]);

  const data = await (await dayRoute(ctx(raw2, { query: '?day=2026-06-15' }))).json();

  assert.equal(data.day, '2026-06-15');
  assert.equal(data.rows.length, 2);
  assert.equal(data.rows[0].staff.name, 'Henry Aryee');
  assert.equal(data.rows[0].open, true, 'the unsettled day is first');
  assert.equal(data.rows[0].label, 'No clock-out — to check');
  assert.equal(data.totals.openCount, 1);
});

test('a leave balance survives the round trip', async () => {
  const { raw, db, token } = await setup();
  await send(db, token, [
    event('2026-06-15T05:58:00+00:00', 'checkIn', 1),
    event('2026-06-15T14:03:00+00:00', 'checkOut', 2),
  ]);

  raw.prepare(
    `INSERT INTO att_days (staff_id, day, status, reason_code, resolution)
     VALUES (1, '2026-03-02', 'leave', 'annual_leave', 'resolved'),
            (1, '2026-03-03', 'leave', 'annual_leave', 'resolved')`,
  ).run();

  const report = await (await staffReport(
    ctx(db, { query: '?from=2026-06-15&to=2026-06-15' }), '1',
  )).json();

  assert.equal(report.staff.name, 'Henry Aryee');
  assert.equal(report.days.length, 1);
  assert.equal(report.days[0].status, 'present');
  assert.equal(report.leave.entitlement, 15);
  assert.equal(report.leave.taken, 2);
  assert.equal(report.leave.remaining, 13);
});

test('a public holiday stops the day being an absence', async () => {
  const { raw, db } = await setup();
  raw.prepare("INSERT INTO att_holidays (day, name) VALUES ('2026-03-06', 'Independence Day')").run();

  const report = await (await staffReport(
    ctx(db, { query: '?from=2026-03-06&to=2026-03-06' }), '1',
  )).json();

  assert.equal(report.days[0].status, 'holiday');
  assert.equal(report.days[0].reason_code, 'public_holiday');
});

// ---------------------------------------------------------------------------
// Finding the shifts instead of asking for them again
// ---------------------------------------------------------------------------

test('the terminal’s attendance bands are stored verbatim', async () => {
  const { raw, db, token } = await setup();

  await deviceConfig(ctx(db, {
    body: {
      serial: 'DS-TEST-1',
      token,
      config: [
        {
          kind: 'attendanceRules',
          path: '/ISAPI/AccessControl/attendanceStatusRuleCfg?format=json',
          status: 'ok',
          raw: {
            AttendanceStatusRuleCfgList: [
              { attendanceStatus: 'checkIn', beginTime: '05:00:00', endTime: '10:00:00' },
              { attendanceStatus: 'checkOut', beginTime: '13:00:00', endTime: '18:00:00' },
            ],
          },
        },
        { kind: 'attendanceMode', path: '/x', status: 'unsupported', raw: null },
      ],
    },
  }));

  const rows = raw.prepare('SELECT * FROM att_device_config ORDER BY kind').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'attendanceMode');
  assert.equal(rows[0].status, 'unsupported', 'an endpoint that 404s is recorded, not dropped');
  assert.match(rows[1].raw, /checkIn/);
});

test('a second sync replaces the first rather than piling up', async () => {
  const { raw, db, token } = await setup();
  const send = (endTime) => deviceConfig(ctx(db, {
    body: {
      serial: 'DS-TEST-1',
      token,
      config: [{
        kind: 'attendanceRules',
        status: 'ok',
        raw: { list: [{ attendanceStatus: 'checkOut', beginTime: '13:00', endTime: endTime }] },
      }],
    },
  }));

  await send('18:00');
  await send('19:00');

  const rows = raw.prepare('SELECT * FROM att_device_config').all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].raw, /19:00/);
});

test('a wrong token cannot post configuration either', async () => {
  const { raw, db } = await setup();
  await assert.rejects(
    () => deviceConfig(ctx(db, {
      body: { serial: 'DS-TEST-1', token: 'nope', config: [{ kind: 'x', raw: {} }] },
    })),
    /token is not right/i,
  );
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_device_config').get().n, 0);
});

test('shifts are suggested from the punches, and confirmed by the bands', async () => {
  const { raw, db, token } = await setup();

  // Three weeks of a morning shift, for somebody with no shift set up at all.
  raw.prepare('DELETE FROM att_patterns').run();
  let serial = 100;
  for (let d = 1; d <= 21; d++) {
    const day = `2026-06-${String(d).padStart(2, '0')}`;
    await send(db, token, [
      event(`${day}T05:58:00+00:00`, 'checkIn', serial++),
      event(`${day}T14:02:00+00:00`, 'checkOut', serial++),
    ]);
  }

  await deviceConfig(ctx(db, {
    body: {
      serial: 'DS-TEST-1',
      token,
      config: [{
        kind: 'attendanceRules',
        status: 'ok',
        raw: {
          list: [
            { attendanceStatus: 'checkIn', beginTime: '05:00:00', endTime: '10:00:00' },
            { attendanceStatus: 'checkOut', beginTime: '13:00:00', endTime: '18:00:00' },
          ],
        },
      }],
    },
  }));

  // A wide window, because the fixture's punches are on fixed dates rather than
  // relative to whenever this test happens to run.
  const data = await (await shiftSuggestions(ctx(db, { query: '?days=800' }))).json();

  assert.equal(data.evidence.daysOfPunches, 21);
  assert.equal(data.evidence.deviceBands, 2);
  assert.ok(data.suggestions.length >= 1);

  const morning = data.suggestions[0];
  // Everybody clocks in at 05:58 for a shift that starts at 06:00. Rounding the
  // cluster to five minutes recovers the hour they are actually due, which is
  // the whole reason the punches beat the terminal's own bands.
  assert.equal(morning.starts_at, '06:00');
  assert.equal(morning.ends_at, '14:00');
  assert.equal(morning.confirmedByDevice, true, 'the check-in band brackets it');
  // And because that is the shift already set up, it is marked rather than
  // offered again — running the sync twice must not produce a second copy.
  assert.equal(morning.existing, 'Morning');
});

test('importing a suggestion creates a shift, and re-importing updates it', async () => {
  const { raw, db } = await setup();

  const first = await (await importShifts(ctx(db, {
    body: {
      shifts: [{
        name: 'Evening', startsAt: '14:00', endsAt: '22:00', breakMinutes: 30,
      }],
    },
  }))).json();
  assert.deepEqual(first.applied, [{ name: 'Evening', action: 'added' }]);

  let row = raw.prepare("SELECT * FROM att_shifts WHERE name = 'Evening'").get();
  assert.equal(row.source, 'device');
  assert.equal(row.source_ref, '14:00-22:00');
  assert.equal(row.break_minutes, 30);

  // Somebody then sets the grace period on it by hand.
  raw.prepare('UPDATE att_shifts SET grace_in_minutes = 15 WHERE id = ?').run(row.id);

  const again = await (await importShifts(ctx(db, {
    body: { shifts: [{ name: 'Evening shift', startsAt: '14:00', endsAt: '22:00' }] },
  }))).json();
  assert.deepEqual(again.applied, [{ name: 'Evening shift', action: 'updated' }]);

  row = raw.prepare('SELECT * FROM att_shifts WHERE id = ?').get(row.id);
  assert.equal(row.name, 'Evening shift');
  assert.equal(row.grace_in_minutes, 15, 'a re-sync does not reset policy somebody set here');
});

test('a shift somebody typed in themselves is left alone by the sync', async () => {
  const { raw, db } = await setup();

  // The fixture's Morning shift has no source — it was created by hand.
  const result = await (await importShifts(ctx(db, {
    body: { shifts: [{ name: 'Morning (from terminal)', startsAt: '06:00', endsAt: '14:00' }] },
  }))).json();

  assert.equal(result.applied[0].action, 'left alone');
  assert.equal(result.applied[0].reason, 'set up by hand');

  const row = raw.prepare('SELECT * FROM att_shifts WHERE id = 1').get();
  assert.equal(row.name, 'Morning', 'untouched');
});

test('an import with a nonsense time is refused', async () => {
  const { db } = await setup();
  await assert.rejects(
    () => importShifts(ctx(db, { body: { shifts: [{ name: 'X', startsAt: 'noon', endsAt: '22:00' }] } })),
    /not valid times/i,
  );
  await assert.rejects(
    () => importShifts(ctx(db, { body: { shifts: [{ name: 'X', startsAt: '09:00', endsAt: '09:00' }] } })),
    /start and end at the same time/i,
  );
});
