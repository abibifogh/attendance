import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  copyRoster, day as dayRoute, deviceConfig, getRoster, importShifts, ingest,
  pushEvents, resolveDay, savePattern, shiftSuggestions, staffReport,
} from '../src/routes/attendance.js';
import { cleanDepartments, createStaff, listStaff } from '../src/routes/attendance-setup.js';
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
     VALUES (1, 'Morning', '06:00', '14:00', 30, 5, 5),
            (2, 'Night',   '22:00', '06:00', 30, 5, 5)`,
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

// ---------------------------------------------------------------------------
// The terminal reporting for itself, with nothing running on site
// ---------------------------------------------------------------------------

/** A request shaped the way the terminal's listening host actually sends one. */
function pushed(token, payload, contentType = 'application/json') {
  const url = new URL(`https://staff.example.test/api/att/push/${token}`);
  return {
    db: null,
    env: {},
    url,
    session: null,
    executionContext: null,
    request: new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    }),
  };
}

const notification = (employeeNo, time, status, serial) => ({
  ipAddress: '192.168.1.64',
  dateTime: time,
  eventType: 'AccessControllerEvent',
  deviceID: 'DS-TEST-1',
  AccessControllerEvent: {
    majorEventType: 5,
    subEventType: 75,
    employeeNoString: employeeNo,
    name: 'Henry Aryee',
    attendanceStatus: status,
    serialNo: serial,
  },
});

test('a terminal posting its own events lands a punch', async () => {
  const { raw, db, token } = await setup();

  const context = pushed(token, notification('1001', '2026-06-15T05:58:00+00:00', 'checkIn', 900));
  context.db = db;
  const result = await (await pushEvents(context, token)).json();

  assert.equal(result.ok, true);
  assert.equal(result.stored, 1);

  const punch = raw.prepare('SELECT * FROM att_punches').get();
  assert.equal(punch.employee_no, '1001');
  assert.equal(punch.source, 'push');
  assert.equal(punch.direction, 'in');
  assert.equal(punch.device_serial, 'DS-TEST-1');
});

test('a pushed tap and the same tap polled are stored once', async () => {
  const { raw, db, token } = await setup();

  const context = pushed(token, notification('1001', '2026-06-15T05:58:00+00:00', 'checkIn', 900));
  context.db = db;
  await pushEvents(context, token);

  // The reader then runs a backfill over the same morning.
  const second = await send(db, token, [event('2026-06-15T05:58:00+00:00', 'checkIn', 900)]);

  assert.equal(second.stored, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_punches').get().n, 1);
});

test('a guessed token is refused and stores nothing', async () => {
  const { raw, db } = await setup();

  const context = pushed('not-a-real-token', notification('1001', '2026-06-15T05:58:00+00:00', 'checkIn', 1));
  context.db = db;
  const response = await pushEvents(context, 'not-a-real-token');

  assert.equal(response.status, 403);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_punches').get().n, 0);
});

test('a heartbeat still counts as the terminal being alive', async () => {
  const { raw, db, token } = await setup();

  const context = pushed(token, {
    dateTime: '2026-06-15T05:00:00+00:00',
    eventType: 'videoloss',
    eventState: 'inactive',
  });
  context.db = db;
  const result = await (await pushEvents(context, token)).json();

  assert.equal(result.ok, true);
  assert.equal(result.stored, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_punches').get().n, 0);

  // Which is the whole point: the Terminals screen can now say it is reachable.
  // By serial, not "the first row" — the migrations register the real terminal,
  // so the fixture's device is no longer the only one in the table.
  const device = raw.prepare('SELECT * FROM att_devices WHERE serial = ?').get('DS-TEST-1');
  assert.ok(device.last_seen_at, 'heard from, even though it had nothing to report');
});

test('rubbish gets a 200, because an error can switch the terminal off', async () => {
  const { db, token } = await setup();

  const context = pushed(token, '<html>not an event</html>', 'text/html');
  context.db = db;
  const response = await pushEvents(context, token);

  assert.equal(response.status, 200, 'a device that gets an error may disable its listening host');
});

test('a whole day arrives as separate posts and computes normally', async () => {
  const { raw, db, token } = await setup();

  for (const [time, status, serial] of [
    ['2026-06-15T05:58:00+00:00', 'checkIn', 901],
    ['2026-06-15T14:03:00+00:00', 'checkOut', 902],
  ]) {
    const context = pushed(token, notification('1001', time, status, serial));
    context.db = db;
    await pushEvents(context, token);
  }

  const day = raw.prepare('SELECT * FROM att_days WHERE staff_id = 1 AND day = ?').get('2026-06-15');
  assert.equal(day.status, 'present');
  assert.equal(day.first_in, '05:58');
  assert.equal(day.last_out, '14:03');
  assert.equal(day.worked_minutes, 455);
});

// ---------------------------------------------------------------------------
// The rota, maintained here
// ---------------------------------------------------------------------------

/**
 * Monday 2026-06-08 is the source week; 2026-06-15 the target. The fixture puts
 * staff 1 on Morning, Monday to Friday, by standing pattern.
 */
const SOURCE = '2026-06-08';
const TARGET = '2026-06-15';

test('copying a week brings the overrides and leaves the pattern alone', async () => {
  const { raw, db } = await setup();

  // A night shift covered on the Wednesday of the source week.
  raw.prepare("INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, '2026-06-10', 2)").run();

  const result = await (await copyRoster(ctx(db, {
    body: { from: SOURCE, to: TARGET, weeks: 1 },
  }))).json();

  assert.equal(result.ok, true);

  // The one day that differs from the pattern is written as an override.
  const wednesday = raw.prepare('SELECT * FROM att_roster WHERE staff_id = 1 AND day = ?')
    .get('2026-06-17');
  assert.equal(wednesday.shift_id, 2);
  assert.equal(wednesday.set_by, 'Ama (manager)');

  // Monday and Tuesday match the standing pattern, so they stay pattern-driven
  // rather than being pinned — otherwise one press blackens the whole grid.
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_roster WHERE staff_id = 1 AND day IN (?, ?)')
    .get('2026-06-15', '2026-06-16').n, 0);
});

test('copying does not overwrite approved leave', async () => {
  const { raw, db } = await setup();

  raw.prepare("INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, '2026-06-10', 2)").run();
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
     VALUES (1, 'annual_leave', '2026-06-17', '2026-06-17', 1, 'approved')`,
  ).run();

  const result = await (await copyRoster(ctx(db, {
    body: { from: SOURCE, to: TARGET, weeks: 1 },
  }))).json();

  assert.equal(result.skippedLeave, 1);
  assert.equal(
    raw.prepare('SELECT COUNT(*) n FROM att_roster WHERE staff_id = 1 AND day = ?').get('2026-06-17').n,
    0,
    'the leave day was not given a shift',
  );
});

test('copying does not roster somebody before they started', async () => {
  const { raw, db } = await setup();
  raw.prepare("INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, '2026-06-10', 2)").run();
  raw.prepare("UPDATE att_staff SET hired_on = '2026-06-18' WHERE id = 1").run();

  await copyRoster(ctx(db, { body: { from: SOURCE, to: TARGET, weeks: 1 } }));

  // The target week's days that fall before the start date. The source week's
  // own rows are fixture and are not what this is about.
  assert.equal(
    raw.prepare(
      "SELECT COUNT(*) n FROM att_roster WHERE staff_id = 1 AND day BETWEEN '2026-06-15' AND '2026-06-17'",
    ).get().n,
    0,
    'no shifts written for days before they started',
  );
  // And the days on or after the start date were copied as normal.
  assert.ok(
    raw.prepare(
      "SELECT COUNT(*) n FROM att_days WHERE staff_id = 1 AND day BETWEEN '2026-06-18' AND '2026-06-21'",
    ).get().n > 0,
  );
});

test('copying a week onto itself is refused', async () => {
  const { db } = await setup();
  await assert.rejects(
    () => copyRoster(ctx(db, { body: { from: SOURCE, to: SOURCE } })),
    /same week/i,
  );
});

test('a copied week is reflected in the computed days straight away', async () => {
  const { raw, db } = await setup();
  // Nobody works Saturdays by pattern; the source week has one covered.
  raw.prepare("INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, '2026-06-13', 1)").run();

  await copyRoster(ctx(db, { body: { from: SOURCE, to: TARGET, weeks: 1 } }));

  const saturday = raw.prepare('SELECT * FROM att_days WHERE staff_id = 1 AND day = ?')
    .get('2026-06-20');
  assert.equal(saturday.scheduled, 1, 'the new Saturday shift is already worked out');
  assert.equal(saturday.status, 'absent', 'rostered and nobody clocked in');
});

test('the grid reports how many people each shift has each day', async () => {
  const { raw, db } = await setup();

  // A second person, on nights Monday to Friday.
  raw.prepare("INSERT INTO att_staff (id, employee_no, name) VALUES (2, '1002', 'Vivian Mensah')").run();
  for (const d of [0, 1, 2, 3, 4]) {
    raw.prepare('INSERT INTO att_patterns (staff_id, dow, shift_id) VALUES (2, ?, 2)').run(d);
  }

  const data = await (await getRoster(ctx(db, { query: `?from=${TARGET}&to=2026-06-21` }))).json();

  const monday = data.coverage.find((c) => c.day === '2026-06-15');
  assert.equal(monday.counts['1'], 1, 'one on mornings');
  assert.equal(monday.counts['2'], 1, 'one on nights');
  assert.equal(monday.off, 0);

  // Sunday: nobody on either shift, which is exactly what the totals exist to
  // make visible before somebody does not turn up.
  const sunday = data.coverage.find((c) => c.day === '2026-06-21');
  assert.equal(sunday.counts['1'], 0);
  assert.equal(sunday.counts['2'], 0);
  assert.equal(sunday.off, 2);
});

test('somebody on leave is counted as on leave, not as unrostered', async () => {
  const { raw, db } = await setup();
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status)
     VALUES (1, 'annual_leave', '2026-06-15', '2026-06-15', 1, 'approved')`,
  ).run();

  const data = await (await getRoster(ctx(db, { query: `?from=${TARGET}&to=2026-06-21` }))).json();
  const monday = data.coverage.find((c) => c.day === '2026-06-15');

  assert.equal(monday.onLeave, 1);
  assert.equal(monday.counts['1'], 0, 'not counted as covering the morning');
  assert.equal(monday.off, 0, 'and not counted as simply off either');
});

// ---------------------------------------------------------------------------
// The terminal's own clock
// ---------------------------------------------------------------------------

/**
 * Why this is worth testing at all: a wrong clock is the one fault here that
 * corrupts the record instead of leaving a hole in it. A terminal that stops
 * reporting is obvious by lunchtime. A terminal eleven minutes fast looks
 * perfectly healthy and quietly marks half the staff late, and nobody finds out
 * until somebody disputes a Tuesday that is now unprovable either way.
 */

test('a pushed punch gives away a terminal running fast', async () => {
  const { raw, db, token } = await setup();

  // The device believes it is eleven minutes later than it is.
  const ahead = new Date(Date.now() + 11 * 60 * 1000).toISOString();
  const context = pushed(token, notification('1001', ahead, 'checkIn', 950));
  context.db = db;
  await pushEvents(context, token);

  const device = raw.prepare('SELECT * FROM att_devices WHERE serial = ?').get('DS-TEST-1');
  assert.ok(
    device.clock_offset_seconds >= 655 && device.clock_offset_seconds <= 665,
    `expected about 660 seconds fast, got ${device.clock_offset_seconds}`,
  );
  assert.ok(device.clock_checked_at, 'and when it was measured');
});

test('the morning screen says so, in words and before the numbers', async () => {
  const { db, token } = await setup();

  const ahead = new Date(Date.now() + 11 * 60 * 1000).toISOString();
  const context = pushed(token, notification('1001', ahead, 'checkIn', 951));
  context.db = db;
  await pushEvents(context, token);

  const data = await (await dayRoute(ctx(db, { query: `?day=${TARGET}` }))).json();

  assert.equal(data.clockWarnings.length, 1);
  assert.equal(data.clockWarnings[0].device, 'Staff entrance');
  assert.match(data.clockWarnings[0].note, /11 minutes fast/);
  assert.match(data.clockWarnings[0].note, /everybody looks later than they were/);
});

test('a terminal keeping good time is not mentioned', async () => {
  const { raw, db, token } = await setup();

  const context = pushed(token, notification('1001', new Date().toISOString(), 'checkIn', 952));
  context.db = db;
  await pushEvents(context, token);

  const device = raw.prepare('SELECT * FROM att_devices WHERE serial = ?').get('DS-TEST-1');
  assert.ok(Math.abs(device.clock_offset_seconds) < 5, 'measured, and near enough zero');

  const data = await (await dayRoute(ctx(db, { query: `?day=${TARGET}` }))).json();
  assert.deepEqual(data.clockWarnings, [], 'nothing to interrupt anybody about');
});

test('a polled batch never passes judgement on the clock', async () => {
  const { raw, db, token } = await setup();

  // The whole point: this log is two months old by the time it is fetched, and
  // reading that as drift would put a red warning on the screen every morning
  // until somebody learned to ignore all of them.
  await send(db, token, [event('2026-06-15T05:58:00+00:00', 'checkIn', 900)]);

  const device = raw.prepare('SELECT * FROM att_devices WHERE serial = ?').get('DS-TEST-1');
  assert.equal(device.clock_offset_seconds, null, 'a delayed log says nothing about the clock');
  assert.ok(device.last_seen_at, 'though it does prove the terminal is alive');
});

test('“last punch” is the terminal’s own stamp, not when it reached us', async () => {
  const { raw, db, token } = await setup();

  // A terminal nine weeks behind, posting live. Recording arrival time here is
  // what let a badly wrong clock look perfectly current on the Terminals
  // screen, so the two columns must be able to disagree.
  const context = pushed(token, notification('1001', '2026-06-11T09:14:00+00:00', 'checkIn', 960));
  context.db = db;
  await pushEvents(context, token);

  const device = raw.prepare('SELECT * FROM att_devices WHERE serial = ?').get('DS-TEST-1');
  assert.equal(device.last_event_at, '2026-06-11 09:14:00', 'the device’s own clock');
  assert.notEqual(
    device.last_event_at.slice(0, 10),
    device.last_seen_at.slice(0, 10),
    'heard from today, but punched in June — and the screen has to be able to say both',
  );
});

test('a fetched batch records the newest punch in it, not the last one listed', async () => {
  const { raw, db, token } = await setup();

  await send(db, token, [
    event('2026-06-15T14:03:00+00:00', 'checkOut', 901),
    event('2026-06-15T05:58:00+00:00', 'checkIn', 900),
  ]);

  const device = raw.prepare('SELECT * FROM att_devices WHERE serial = ?').get('DS-TEST-1');
  assert.equal(device.last_event_at, '2026-06-15 14:03:00', 'the afternoon one, listed first');
});

test('a heartbeat does not pretend to be a punch', async () => {
  const { raw, db, token } = await setup();

  await send(db, token, [event('2026-06-15T05:58:00+00:00', 'checkIn', 900)]);
  const after = raw.prepare('SELECT * FROM att_devices WHERE serial = ?').get('DS-TEST-1');

  // A door alarm arrives down the same pipe and carries nobody.
  const context = pushed(token, { dateTime: '2026-08-16T06:00:00+00:00', eventType: 'videoloss' });
  context.db = db;
  await pushEvents(context, token);

  const device = raw.prepare('SELECT * FROM att_devices WHERE serial = ?').get('DS-TEST-1');
  assert.equal(device.last_event_at, after.last_event_at, 'the last real punch still stands');
  assert.ok(device.last_seen_at, 'but it counts as having been heard from');
});

test('a backlog of old events does not accuse a clock that is right', async () => {
  const { raw, db, token } = await setup();

  // A live tap first: the terminal's clock is correct to the second.
  let context = pushed(token, notification('1001', new Date().toISOString(), 'checkIn', 970));
  context.db = db;
  await pushEvents(context, token);

  // Then it starts uploading two months of stored history, one POST at a time,
  // the way these terminals actually drain a backlog. Every one of these is
  // genuinely old, and none of them says anything about the clock.
  for (const [i, old] of ['2026-06-08T06:00:00+00:00', '2026-06-09T06:00:00+00:00',
    '2026-06-10T06:00:00+00:00'].entries()) {
    context = pushed(token, notification('1001', old, 'checkIn', 980 + i));
    context.db = db;
    await pushEvents(context, token);
  }

  const device = raw.prepare('SELECT * FROM att_devices WHERE serial = ?').get('DS-TEST-1');
  assert.ok(
    Math.abs(device.clock_offset_seconds) < 60,
    `the good reading should survive the backlog, got ${device.clock_offset_seconds}`,
  );

  const data = await (await dayRoute(ctx(db, { query: `?day=${TARGET}` }))).json();
  assert.deepEqual(data.clockWarnings, [], 'and nobody is told off for a correct clock');
});

test('a genuinely wrong clock is still caught on the first reading', async () => {
  const { db, token } = await setup();

  const behind = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const context = pushed(token, notification('1001', behind, 'checkIn', 990));
  context.db = db;
  await pushEvents(context, token);

  const data = await (await dayRoute(ctx(db, { query: `?day=${TARGET}` }))).json();
  assert.equal(data.clockWarnings.length, 1, 'nothing better has been seen, so this stands');
  assert.match(data.clockWarnings[0].note, /40 minutes slow/);
});

// ---------------------------------------------------------------------------
// Rotating shifts, saved and read back
// ---------------------------------------------------------------------------

test('a three-week rotation is saved and shows through on the rota', async () => {
  const { raw, db } = await setup();

  await savePattern(ctx(db, {
    body: {
      staffId: 1,
      rotationWeeks: 3,
      pattern: {
        0: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: null, 6: null },
        1: { 0: 2, 1: 2, 2: 2, 3: 2, 4: 2, 5: null, 6: null },
        2: { 0: null, 1: 2, 2: 2, 3: 1, 4: 1, 5: 1, 6: null },
      },
    },
  }));

  assert.equal(raw.prepare('SELECT rotation_weeks FROM att_staff WHERE id = 1').get().rotation_weeks, 3);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_patterns WHERE staff_id = 1').get().n, 21);

  // Three consecutive Mondays, counted from the fixed anchor.
  const roster = await (await getRoster(ctx(db, { query: '?from=2024-01-01&to=2024-01-21' }))).json();
  const row = roster.rows.find((r) => r.staff.id === 1);
  const on = (day) => row.days.find((d) => d.day === day)?.shift_id;

  assert.equal(on('2024-01-01'), 1, 'week one, mornings');
  assert.equal(on('2024-01-08'), 2, 'week two, afternoons');
  assert.equal(on('2024-01-15'), null, 'week three, Monday off');
  assert.equal(row.rotationWeeks, 3, 'and the screen is told the cycle length');
});

test('shortening a rotation forgets the weeks that no longer exist', async () => {
  const { raw, db } = await setup();

  await savePattern(ctx(db, {
    body: { staffId: 1, rotationWeeks: 3, pattern: { 0: { 0: 1 }, 1: { 0: 2 }, 2: { 0: 1 } } },
  }));
  await savePattern(ctx(db, {
    body: { staffId: 1, rotationWeeks: 2, pattern: { 0: { 0: 1 }, 1: { 0: 2 } } },
  }));

  const weeks = raw.prepare('SELECT DISTINCT week FROM att_patterns WHERE staff_id = 1 ORDER BY week')
    .all().map((r) => r.week);
  assert.deepEqual(weeks, [0, 1], 'a third week left behind would silently come back');
});

test('the old flat pattern shape is still accepted', async () => {
  const { raw, db } = await setup();

  // What a screen from before rotations existed would post.
  await savePattern(ctx(db, { body: { staffId: 1, pattern: { 0: 1, 1: 1, 2: null } } }));

  assert.equal(raw.prepare('SELECT rotation_weeks FROM att_staff WHERE id = 1').get().rotation_weeks, 1);
  // Spread to plain objects: node:sqlite hands back null-prototype rows, and
  // strict deep-equality counts that as a difference.
  const rows = raw.prepare('SELECT week, dow, shift_id FROM att_patterns WHERE staff_id = 1 ORDER BY dow')
    .all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { week: 0, dow: 0, shift_id: 1 },
    { week: 0, dow: 1, shift_id: 1 },
    { week: 0, dow: 2, shift_id: null },
  ]);
});

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

/**
 * Reports group by department, so a free-text field quietly turns one kitchen
 * into three over a fortnight of typing — and the person reading the monthly
 * figures cannot tell that from a real split.
 */

test('a department list is tidied and deduplicated without regard to case', () => {
  assert.deepEqual(
    cleanDepartments('Kitchen\n kitchen \nKITCHEN\nFront Office'),
    ['Kitchen', 'Front Office'],
    'the first spelling wins, so whoever typed it decides the capitals',
  );

  assert.deepEqual(cleanDepartments('Kitchen, Housekeeping\nSecurity'),
    ['Kitchen', 'Housekeeping', 'Security'], 'commas count as line breaks');
  assert.deepEqual(cleanDepartments('  Restaurant   &   Bar  '), ['Restaurant & Bar']);
  assert.deepEqual(cleanDepartments('\n\n  \n'), [], 'blank lines are not departments');
  assert.deepEqual(cleanDepartments(null), []);
});

test('the list cannot grow without limit', () => {
  const many = Array.from({ length: 200 }, (_, i) => `Dept ${i}`).join('\n');
  assert.equal(cleanDepartments(many).length, 60);
  assert.equal(cleanDepartments('x'.repeat(500))[0].length, 80);
});

test('the staff screen is offered the configured list plus whatever is in use', async () => {
  const { raw, db } = await setup();

  raw.exec("UPDATE settings SET value = 'Front Office\nHousekeeping' WHERE key = 'att_departments'");
  raw.prepare("UPDATE att_staff SET department = 'Kitchen' WHERE id = 1").run();

  const data = await (await listStaff(ctx(db))).json();

  assert.deepEqual(data.departments, ['Front Office', 'Housekeeping', 'Kitchen']);
});

test('a department still in use survives being taken off the list', async () => {
  const { raw, db } = await setup();

  // Somebody removes Kitchen from the configured list while a cook is in it.
  // Dropping it from the dropdown would move him to "No department" the next
  // time anybody edited his start date.
  raw.exec("UPDATE settings SET value = 'Front Office' WHERE key = 'att_departments'");
  raw.prepare("UPDATE att_staff SET department = 'Kitchen' WHERE id = 1").run();

  const data = await (await listStaff(ctx(db))).json();
  assert.ok(data.departments.includes('Kitchen'));
});
